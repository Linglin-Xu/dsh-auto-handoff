/**
 * dsh-auto-handoff, node half.
 *
 * Watches every live session, and when a conversation has finished at least
 * `minRounds` turns AND its context occupancy has crossed `threshold`, it
 * automatically:
 *
 *   1. compresses the whole conversation into a short checkpoint (replaying the
 *      conversation's own system prompt, tools and message prefix so the
 *      provider's warm prefix cache is reused — the same discipline as
 *      dsh-compaction-basic);
 *   2. creates a NEW session in the same workspace/cwd, inheriting the session
 *      preset, and queues the checkpoint as its first user message through the
 *      agent inbox (materialized inside turn 1, right after the system message —
 *      a bare surface write before the first turn makes the stored log
 *      unreadable, which breaks every later resume);
 *   3. publishes a durable in-memory "pending navigation" record.
 *
 * The source is never written to, never cancelled and never migrated: a handoff
 * is a COPY-FORWARD of a quiescent source. Quiescent means no open turn, no
 * active compaction, no queued inbox input, and a log that did not move while
 * the summary was written or the fresh session was created. That is what keeps
 * in-flight work from being cut in half, from finishing in the old session after
 * the user has already been moved on, or from being re-run blind in the new one.
 * Whatever the source already produced stays in its own history.
 *
 * The browser half (`lib/client.js`) picks the record up and opens the fresh
 * session, so the user keeps chatting without doing anything. The source
 * session is only read; its full history stays in the sidebar.
 *
 * HTTP surface:
 *   GET  /api/dsh-auto-handoff/status   -> configuration, counters, decisions
 *   POST /api/dsh-auto-handoff/handoff  -> force one handoff { sessionId }
 *   GET  /api/dsh-auto-handoff/pending  -> read+clear a pending navigation
 *
 * The API key never leaves the harness: the summarization call goes through
 * `ctx.llm`, which resolves the routed provider/model and credentials itself.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, contentHasImage } from '@deepseek-ai/dsh-llm'
import { buildTaskBlock, foldLastUserText, foldTodos, foldTouchedFiles, hasUnfinishedWork } from './handover.js'

export const name = 'dsh-auto-handoff'
export const inject = ['webServer', 'settings', 'sessions', 'llm', 'tokenMeter']

/** Settings namespace holding the auto-handoff configuration. */
const NS = 'dsh-auto-handoff'

/** Prompt admitted to the fresh session when this plugin continues the task itself. */
const DEFAULT_CONTINUE_PROMPT = '继续。按上一条交接内容从中断处接着做，先把待办清单用 todo_write 写回，已完成的项不要重做。'

const SCHEMA = z.object({
  /** Master switch for the whole plugin. */
  enabled: z.boolean().default(true),
  /**
   * Open a fresh session automatically once `threshold`/`minRounds` are met.
   * Off (the default) keeps the plugin in MANUAL mode: the composer widget and
   * `/handoff` are the only ways to start a handoff.
   */
  autoHandoff: z.boolean().default(false),
  /** Context occupancy (0..1) at or above which a fresh session is opened. */
  threshold: z.number().default(0.8),
  /** Completed turns required before an automatic handoff may fire. */
  minRounds: z.number().default(3),
  /** Prompt once the conversation reaches this many completed turns (0 disables). */
  promptRounds: z.number().default(10),
  /** Prompt once context occupancy reaches this ratio (0 disables). */
  promptPercent: z.number().default(0.6),
  /** Prompt once this many compactions happened in the session (0 disables). */
  promptCompactions: z.number().default(2),
  /** Character budget of the replayed conversation (oldest messages drop first). */
  maxInputChars: z.number().default(20000),
  /** Output token cap for the summarization call. */
  maxTokens: z.number().default(2048),
  /** Summarization provider override (empty = follow the source conversation's route). */
  provider: z.string().default(''),
  /** Summarization model override (empty = follow the source conversation's route). */
  model: z.string().default(''),
  /** Minimum milliseconds between two handoffs of the same session. */
  cooldownMs: z.number().default(60000),
  /** Keep per-session decision detail for the status route. */
  debug: z.boolean().default(true),
  /** Show the composer status widget (pill + handoff button + threshold editor). */
  uiEnabled: z.boolean().default(true),
  /** Carry the task state (todo list, changed files, literal request) into the fresh session. */
  carryTasks: z.boolean().default(true),
  /** Make the fresh session continue on its own: auto (only with unfinished todos) | always | never. */
  autoContinue: z.string().default('auto'),
  /** Prompt admitted to the fresh session when it continues on its own. */
  continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT),
})

const DEFAULTS = {
  enabled: true,
  autoHandoff: false,
  threshold: 0.8,
  minRounds: 3,
  promptRounds: 10,
  promptPercent: 0.6,
  promptCompactions: 2,
  maxInputChars: 20000,
  maxTokens: 2048,
  provider: '',
  model: '',
  cooldownMs: 60000,
  debug: true,
  uiEnabled: true,
  carryTasks: true,
  autoContinue: 'auto',
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
}

/** Reject bodies over 256 KiB before buffering. */
const MAX_BODY_BYTES = 256 * 1024

/** File the composer widget writes its threshold overrides to (survives restarts). */
function uiConfigPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'auto-handoff-ui.json')
}

/** Keep only the fields the widget owns, so a hand-edited file cannot inject junk. */
function pickUiConfig(raw) {
  const out = {}
  if (typeof raw?.autoHandoff === 'boolean') out.autoHandoff = raw.autoHandoff
  for (const key of ['promptRounds', 'promptPercent', 'promptCompactions']) {
    if (typeof raw?.[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key]
  }
  return out
}

/** Read the widget-managed overrides; a missing or corrupt file means "no overrides". */
function loadUiConfig() {
  try {
    return pickUiConfig(JSON.parse(readFileSync(uiConfigPath(), 'utf8')))
  } catch {
    return {}
  }
}

/** Persist the widget-managed overrides; reports whether the write landed. */
function saveUiConfig(config) {
  try {
    const path = uiConfigPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(pickUiConfig(config), null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
/** How long a pending navigation record is retained for a late browser poll. */
const PENDING_TTL_MS = 10 * 60 * 1000
/** How long a session's decision record is retained for /status. */
const DECISION_TTL_MS = 30 * 60 * 1000

/**
 * The condensation directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct system prompt: keeping the
 * conversation's own system prompt, tools and message prefix in front of it
 * makes the auxiliary call a genuine prefix of the last routed request.
 */
const SUMMARY_INSTRUCTION = [
  '你正在压缩一段即将被截断的对话，摘要会被注入到一个全新的会话里继续使用。请输出一段精简的中文上下文摘要，要求：',
  '- 用紧凑的要点列表输出（建议 3~10 条，每条一句话），整体尽量简短；',
  '- 必须覆盖：用户的目标与最新需求、已完成的工作与结论、当前进度、下一步要做的事；',
  '- 关键信息必须原样保留：文件路径、命令、函数/工具名、错误信息、数字、已做出的决定、用户的偏好与纠正；',
  '- 如果对话中已经存在 <auto-handoff-checkpoint> 块，说明此前交接过一次：把它当作旧 checkpoint，保留仍成立的事实、丢弃过期的、合并新信息成一份摘要；',
  '- 不要提"压缩"或"摘要"本身，不要输出任何解释、前后缀或代码块标记，只输出摘要。',
].join('\n')

/** Framing that makes the injected checkpoint established background, not a new prompt. */
const CHECKPOINT_PREAMBLE = '以下是一条自动生成的上下文交接摘要（上一段对话已被压缩，新会话从这里继续）。请把它当作已经建立的上下文，直接继续后续任务，不要复述它，也不要向用户提及交接这件事。'
const CHECKPOINT_OPEN_TAG = '<auto-handoff-checkpoint>'
const CHECKPOINT_CLOSE_TAG = '</auto-handoff-checkpoint>'

/** Buffer the request body as UTF-8 text. */
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write a JSON response the handler fully owns. */
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a live session's event log through the public Session API.
 *
 * `session.events` does NOT exist on a real Session — it exposes the method
 * `snapshotEvents()` instead. Reading a missing property yields `undefined`,
 * which used to blow up in `hasOpenTurn(undefined)` on every live session: the
 * automatic path swallowed the throw in its promise catch (so `stats.checks`
 * stayed 0 and no decision was ever recorded) and the manual route surfaced it
 * as a bare 400 from the web server's last-resort guard.
 * @param session - live session to read.
 * @returns its frozen event snapshot, or an empty log for a stub.
 */
function eventsOf(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session?.events)) return session.events
  return []
}

/** Number of turns that have both started and ended; the trailing open turn is not counted. */
function completedTurns(events) {
  let started = 0
  let ended = 0
  for (const event of events) {
    if (event.type === 'turn/start') started += 1
    else if (event.type === 'turn/end') ended += 1
  }
  return Math.min(started, ended)
}

/** Completed compaction cycles in one session log. */
function countCompactions(events) {
  let count = 0
  for (const event of events) if (event.type === 'compaction/start') count += 1
  return count
}

/** Concatenate one job output read's retained chunks. */
function chunkText(chunks) {
  if (!Array.isArray(chunks)) return ''
  let text = ''
  for (const chunk of chunks) if (typeof chunk?.text === 'string') text += chunk.text
  return text
}

/** Terminal job states never count as background work to inherit. */
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])

/** Whether one job view still represents running background work. */
function isLiveJob(job) {
  return job !== undefined && job !== null && !TERMINAL_JOB_STATUSES.has(job.status)
}

/** Short human label of a background job (its command or kind). */
function jobLabel(job) {
  const spec = job?.spec
  const candidate = spec?.label ?? spec?.command ?? spec?.name ?? job?.kind
  return typeof candidate === 'string' && candidate.length > 0 ? candidate.slice(0, 120) : 'background job'
}

/**
 * Evaluate the three user-facing prompt thresholds for one session.
 *
 * Priority is explicit and drives both the pill colour and the toast order:
 * **compactions > rounds > occupancy** (red > amber > blue). Compaction pressure
 * means the context is being rewritten under the model, which hurts most; the
 * turn count is the next signal; plain occupancy is the softest one.
 * @param metrics - completed turns, compaction count, occupancy result.
 * @param config - resolved plugin configuration holding the thresholds.
 * @returns which thresholds fired (in priority order) and the notice level.
 */
function evaluatePrompts(metrics, config) {
  const compactionHit = config.promptCompactions > 0 && metrics.compactions >= config.promptCompactions
  const roundsHit = config.promptRounds > 0 && metrics.turns >= config.promptRounds
  const percentHit = config.promptPercent > 0 && metrics.occupancy?.known === true && metrics.occupancy.ratio >= config.promptPercent
  const hits = []
  if (compactionHit) hits.push({ kind: 'compactions', value: metrics.compactions, threshold: config.promptCompactions })
  if (roundsHit) hits.push({ kind: 'rounds', value: metrics.turns, threshold: config.promptRounds })
  if (percentHit) hits.push({ kind: 'percent', value: metrics.occupancy.ratio, threshold: config.promptPercent })
  const level = compactionHit ? 'alert' : roundsHit ? 'warn' : percentHit ? 'info' : 'ok'
  return { hits, level }
}

/** Whether the session currently has an open (in-flight) turn. */
function hasOpenTurn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index].type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/** Whether the session has an unmatched `compaction/start` marker. */
function hasActiveCompaction(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index].type
    if (type === 'compaction/start') return true
    if (type === 'compaction/end') return false
  }
  return false
}

/**
 * Count the source's queued input: prompts, steering and injected context that
 * still owe the source a turn or a step. Anything here would open a turn in the
 * OLD session right after the handoff — the work would run where the user is not
 * looking, and the new session would never see its result.
 * @param agent - the live source agent whose inbox to read, when available.
 * @returns number of pending inbox entries.
 */
function pendingInputOf(agent) {
  try {
    const inbox = agent?.inbox
    if (inbox === undefined) return 0
    return (inbox.nextTurn?.length ?? 0) + (inbox.nextStep?.length ?? 0)
  } catch {
    // An inbox projection that is not mounted (older host) counts as empty
    // rather than blocking every handoff forever.
    return 0
  }
}

/**
 * Conversation fingerprint of a live session.
 *
 * The surface generation distinguishes "the user kept talking" from "the log
 * recorded housekeeping while we were summarizing": appending a message grows
 * `nodes`, replacements bump `replaceGeneration`/`contentGeneration`, while title
 * regeneration and delivery receipts touch none of them. Stubs without a real
 * surface fall back to the event count.
 * @param session - live session to fingerprint.
 * @returns a comparable fingerprint string.
 */
function contentFingerprint(session) {
  const surface = session?.surface
  if (surface !== undefined && typeof surface.contentGeneration === 'number') {
    return `${surface.nodes?.length ?? 0}:${surface.replaceGeneration ?? 0}:${surface.contentGeneration}`
  }
  return `events:${eventsOf(session).length}`
}

/**
 * Say why a live source is no longer the state a handoff summary describes, or
 * `undefined` when it is still quiescent.
 *
 * A handoff copies a snapshot forward, so the source must neither be busy nor
 * have moved between taking that snapshot and delivering it. A turn started in
 * that window would finish in the old session (cut in half from the new
 * session's point of view), and the checkpoint would describe an older state
 * than the one the user actually has.
 * @param session - live source session to re-read.
 * @param agent - its live agent, when the deployment has one.
 * @param fingerprint - content fingerprint the summary was taken at.
 * @returns a stable reason code, or undefined when the source is unchanged.
 */
function staleness(session, agent, fingerprint) {
  const events = eventsOf(session)
  if (contentFingerprint(session) !== fingerprint) return 'source-moved'
  if (hasOpenTurn(events)) return 'source-open-turn'
  if (hasActiveCompaction(events)) return 'source-compacting'
  if (agent !== undefined && agent.status !== 'idle') return 'source-busy'
  if (pendingInputOf(agent) > 0) return 'pending-input'
  return undefined
}

/** Crude character budget of one derived message (text parts only). */
function messageCharLength(message) {
  const content = message?.content
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (part !== null && typeof part === 'object' && typeof part.text === 'string') total += part.text.length
    }
    return total
  }
  return 0
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete handoff summary)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default: return undefined
  }
}

/** Register the auto-handoff engine, its settings namespace and its HTTP routes. */
export function apply(ctx) {
  /** Sessions created by this plugin (never hand a handoff child off again on creation). */
  const generated = new Set()
  /** Session ids that already handed off, with the information /status reports. */
  const handoffs = new Map()
  /** Source session id -> pending navigation record awaiting the browser half. */
  const pending = new Map()
  /** Session id -> most recent decision (why it did or did not hand off). */
  const decisions = new Map()
  /** Session ids whose summarization is currently running. */
  const running = new Set()
  /** Session id -> debounce timer for the next automatic evaluation. */
  const scheduled = new Map()
  /** Bumped whenever a handoff lands; invalidates evaluations armed before it. */
  let engineGeneration = 0

  const stats = { checks: 0, handoffs: 0, failures: 0, lastError: null }

  let source = () => ({ ...DEFAULTS, ...loadUiConfig() })
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NS, SCHEMA)
    source = () => ({ ...DEFAULTS, ...scope.get(), ...loadUiConfig() })
  })

  /** Sessions whose manual handoff is waiting for a quiescent moment. */
  const manualQueue = new Map()
  /** Disposers of job-completion bridges (source session -> fresh session). */
  const jobBridges = new Set()

  /**
   * Session controller, when this deployment has one. Two things depend on it:
   * a fresh session created through `create()` gets a real agent, a persistence
   * writer and a workspace attachment (so it appears in the sidebar at all),
   * and `prompt()` is what lets it continue on its own.
   */
  let controller
  ctx.inject(['sessionController'], (controllerCtx) => {
    controller = controllerCtx.sessionController
  })

  /** Workspace registry, when present: resolves the source `cwd` to its workspace. */
  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
    workspaceRegistry = workspaceCtx.workspaceRegistry
  })

  /**
   * Live agent registry, when present. The checkpoint reaches the fresh session
   * through its agent inbox rather than its surface — see `queueCheckpoint`.
   */
  let agents
  ctx.inject(['agents'], (agentsCtx) => {
    agents = agentsCtx.agents
  })

  /** Admit one prompt to a fresh session. */
  function admitPrompt(request) {
    return controller.prompt(request, new AbortController().signal)
  }

  /**
   * Hand the checkpoint to a fresh session as its first user message WITHOUT
   * waking it: `autoContinue` stays the only thing that may start a turn.
   *
   * The obvious write — `fresh.append('user/message', checkpoint, { surfaceOp:
   * 'append' })` — lands BEFORE turn 1's `system/message`, because a fresh
   * session has no surface yet and the system prompt only exists once the first
   * turn opens. The format reserves the first surface node for that system
   * message ("system/message requires a protected first surface head"), so such
   * a log is born corrupt: it runs fine live, then every later cold read
   * (resume, reload, another window) dies with `stored log is corrupt:
   * SessionFormatError`. Queueing into the inbox is the supported path: the
   * message is materialized inside turn 1, right after the system message, so
   * the model and the GUI still see it first while the log stays readable.
   * @param sessionId - the fresh session receiving the checkpoint.
   * @param message - the checkpoint user message.
   * @returns whether a live agent accepted the delivery.
   */
  function queueCheckpoint(sessionId, message) {
    const agent = agents?.get(sessionId)
    if (agent === undefined) return false
    try {
      if (typeof agent.send === 'function') {
        agent.send(message, 'next-turn', false)
        return true
      }
      // Older hosts expose the inbox without the `send` convenience wrapper.
      if (typeof agent.inbox?.append === 'function') {
        agent.inbox.append('next-turn', message)
        return true
      }
    } catch (error) {
      ctx.logger.warn(`dsh-auto-handoff: could not queue the checkpoint: ${errorMessage(error)}`)
    }
    return false
  }

  /**
   * Create the handoff target.
   *
   * Going through the session controller is what makes it a REAL session:
   * `sessions.create()` alone mints `session-<n>`, binds no agent, never gets a
   * persistence writer and never joins a workspace — the sidebar cannot list
   * it, so the browser half can never open it. The store path stays as a
   * degraded fallback for deployments without a controller.
   * @param headerRecord - source session header (cwd + agent preset).
   * @param sourceId - source session id, kept as lineage on the fallback path.
   * @returns the created session.
   */
  async function createFreshSession(headerRecord, sourceId) {
    const cwd = headerRecord.cwd
    const preset = headerRecord.agentPreset
    if (controller !== undefined) {
      let workspaceId
      try {
        workspaceId = workspaceRegistry?.list?.().find(workspace => workspace.path === cwd)?.id
      } catch {
        workspaceId = undefined
      }
      try {
        const created = await controller.create({
          ...(workspaceId === undefined
            ? (cwd === undefined ? {} : { cwd })
            : { workspaceId }),
          ...(preset === undefined ? {} : { agentPreset: preset }),
        })
        const session = ctx.sessions.get(created.sessionId)
        if (session !== undefined) return session
      } catch (error) {
        ctx.logger.warn(`dsh-auto-handoff: controller could not create the handoff session: ${errorMessage(error)}`)
      }
    }
    return ctx.sessions.create(undefined, {
      meta: {
        ...(cwd === undefined ? {} : { cwd }),
        ...(preset === undefined ? {} : { agentPreset: preset }),
        parentSession: sourceId,
      },
    })
  }

  function noteDecision(sessionId, record) {
    decisions.set(sessionId, { sessionId, time: Date.now(), ...record })
  }

  function noteSkip(sessionId, reason, extra) {
    if (source().debug === false) return
    noteDecision(sessionId, { kind: 'skip', reason, ...extra })
  }

  /**
   * Decline a handoff because the source is not provably quiescent.
   * Records a decision for /status and leaves every scheduling guard armed, so
   * the next turn/end or idle transition retries on its own.
   * @param sessionId - the source session that was refused.
   * @param reason - stable machine reason code.
   * @param message - human-readable sentence carried to the manual route.
   * @param extra - additional decision fields.
   * @returns the declined handoff result.
   */
  function refused(sessionId, reason, message, extra) {
    noteSkip(sessionId, reason, extra)
    return {
      ok: false,
      error: { code: 'not-quiescent', reason, message: `source session "${sessionId}": ${message}` },
    }
  }

  function prune() {
    const now = Date.now()
    for (const [id, record] of pending) {
      if (now - record.time > PENDING_TTL_MS) pending.delete(id)
    }
    for (const [id, record] of decisions) {
      if (now - record.time > DECISION_TTL_MS) decisions.delete(id)
    }
  }

  /**
   * Latest context-pressure projection of one session, when it is registered.
   * This is the same projection the GUI renders its occupancy from.
   * @param session - live session to read.
   * @returns the projection state, or undefined when unavailable.
   */
  function contextPressureOf(session) {
    try {
      return ctx.get('sessionProjections')?.stateOf?.(session, 'contextPressure')
    } catch {
      return undefined
    }
  }

  /**
   * Background-job registry, when this deployment has one.
   * `ctx.get` (unlike `ctx.jobs`) does not require the service in `inject`, so
   * the plugin still loads where jobs are not mounted.
   */
  function jobRegistry() {
    try {
      return ctx.get('jobs')
    } catch {
      return undefined
    }
  }

  /**
   * Context occupancy of one session as a 0..1 ratio, or a reason it is unknown.
   *
   * The projection carries `projectedTokens`/`pressureTokens`/`contextWindow`.
   * DSH 0.2 also moved the meter result away from those legacy fields: `measure()`
   * now returns `totalTokens`, so a build without the projection registry still
   * gets a usable numerator instead of bailing out forever with
   * "no-provider-usage-yet".
   * @param session - live session to measure.
   * @param header - its folded request header.
   * @param route - resolved provider/model route of that header.
   */
  async function occupancyOf(session, header, route) {
    if (header === undefined) return { known: false, reason: 'no-request-header' }
    const pressure = contextPressureOf(session)
    let usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
    let contextWindow = pressure?.contextWindow
    if (usedTokens === undefined) {
      try {
        const measurement = ctx.tokenMeter.measure(session, header)
        usedTokens = typeof measurement?.totalTokens === 'number'
          ? measurement.totalTokens
          : measurement?.projectedTokens ?? measurement?.pressureTokens
      } catch (error) {
        return { known: false, reason: `measure-failed: ${errorMessage(error)}` }
      }
    }
    if (usedTokens === undefined) return { known: false, reason: 'no-provider-usage-yet' }
    if ((contextWindow === undefined || contextWindow <= 0) && route !== undefined) {
      try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
        contextWindow = info?.context?.contextWindow
      } catch (error) {
        return { known: false, reason: `context-window-unresolved: ${errorMessage(error)}` }
      }
    }
    if (contextWindow === undefined || contextWindow <= 0) {
      return { known: false, reason: 'context-window-unresolved' }
    }
    return {
      known: true,
      ratio: usedTokens / contextWindow,
      usedTokens,
      contextWindow,
    }
  }

  /** Live background jobs owned by one session, as the widget and the checkpoint see them. */
  function runningJobs(sessionId) {
    try {
      const jobs = jobRegistry()?.list?.(sessionId) ?? []
      const live = jobs.filter(isLiveJob)
      return {
        running: live.length,
        list: live.map(job => ({ id: String(job.id), kind: job.kind, status: job.status, label: jobLabel(job) })),
      }
    } catch {
      return { running: 0, list: [] }
    }
  }

  /** Everything the composer widget needs for one live session. */
  async function describeSession(session, config) {
    const events = eventsOf(session)
    const turns = completedTurns(events)
    const compactions = countCompactions(events)
    const header = session.requestHeader?.() ?? undefined
    const route = header?.config !== undefined
      ? { provider: header.config.provider, model: header.config.model }
      : undefined
    let occupancy
    try {
      occupancy = await occupancyOf(session, header, route)
    } catch (error) {
      occupancy = { known: false, reason: `occupancy-error: ${errorMessage(error)}` }
    }
    const jobs = runningJobs(session.id)
    return {
      id: session.id,
      turns,
      compactions,
      occupancy,
      jobs,
      prompts: evaluatePrompts({ turns, compactions, occupancy }, config),
      queued: manualQueue.has(session.id),
    }
  }

  /**
   * Background work the fresh session must know about, as checkpoint text.
   * Jobs stay owned by the source session (the registry fences them by owner),
   * so this records what is running plus a tail of its output.
   */
  function buildBackgroundBlock(sourceId) {
    const lines = []
    const { list } = runningJobs(sourceId)
    if (list.length > 0) {
      lines.push('后台任务（仍归旧会话所有，新会话无法直接读它的输出；本插件会在它结束时把结果转发过来）：')
      for (const job of list) {
        let tail = ''
        try {
          tail = chunkText(jobRegistry()?.readAt?.(job.id, 0, sourceId)?.chunks).slice(-400)
        } catch { /* a finished or unreadable job just contributes no tail */ }
        lines.push(`- ${job.id} [${job.status}] ${job.label}${tail === '' ? '' : `\n  最近输出：${tail.replace(/\n/g, '\n  ')}`}`)
      }
    }
    const children = []
    try {
      for (const child of ctx.sessions.list()) {
        if (child.id !== sourceId && child.header?.parentSession === sourceId) children.push(child.id)
      }
    } catch { /* no live-session listing in this deployment */ }
    if (children.length > 0) lines.push(`仍然存活的子会话：${children.join('、')}`)
    return lines.join('\n')
  }

  /**
   * Forward a source session's background-job settlements into the fresh session.
   * The new session cannot read the old owner's job output, so the plugin — which
   * may read it as the host — relays the terminal state and a tail of the output.
   */
  function forwardJobResults(sourceId, childId) {
    const events = jobRegistry()?.events
    if (events === undefined || typeof events.subscribe !== 'function') return
    let dispose
    try {
      dispose = events.subscribe({ owner: sourceId }, (event) => {
        if (event?.type !== 'settled') return
        const agent = agents?.get(childId)
        if (agent === undefined) return
        const job = event.job
        let tail = ''
        try {
          tail = chunkText(jobRegistry()?.readAt?.(job.id, 0, sourceId)?.chunks).slice(-800)
        } catch { /* no retained output is still a useful notice */ }
        const text = [
          `旧会话的后台任务 ${job.id} 已结束：${job.status}${typeof job.detail === 'string' && job.detail !== '' ? `（${job.detail}）` : ''}。`,
          tail === '' ? '' : `最近输出：\n${tail}`,
          '需要完整结果时，请回到旧会话查看（任务归属旧会话，新会话无法直接读取）。',
        ].filter(line => line !== '').join('\n')
        try {
          agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-auto-handoff' } }))
        } catch (error) {
          ctx.logger.warn(`dsh-auto-handoff: could not forward job ${job.id} to "${childId}": ${errorMessage(error)}`)
        }
      })
    } catch (error) {
      ctx.logger.warn(`dsh-auto-handoff: job forwarding unavailable: ${errorMessage(error)}`)
      return
    }
    jobBridges.add(dispose)
    const timer = setTimeout(() => {
      jobBridges.delete(dispose)
      try { dispose() } catch { /* already disposed */ }
    }, 30 * 60 * 1000)
    timer.unref?.()
  }

  /** Run one queued manual handoff as soon as the source is quiescent. */
  async function runQueued(session) {
    const sessionId = session.id
    if (!manualQueue.has(sessionId) || running.has(sessionId)) return
    const result = await handoff(sessionId, 'manual-queued')
    if (result.ok || result.error?.code === 'session-not-found' || result.error?.code !== 'not-quiescent') {
      manualQueue.delete(sessionId)
    }
  }

  /** Replay the session surface as summarization input, newest-first within the char cap. */
  function buildSummarizationInput(session, header, config) {
    const events = eventsOf(session)
    const surface = session.surface?.nodes ?? []
    const messages = []
    let budget = config.maxInputChars
    for (let index = surface.length - 1; index >= 0 && budget > 0; index -= 1) {
      const message = session.deriveEventMessage(events[surface[index]])
      if (message === null || message === undefined) continue
      if (contentHasImage(message.content)) continue
      messages.unshift(message)
      budget -= messageCharLength(message)
    }
    // A character budget can cut the replay inside one tool exchange, and a
    // provider rejects a tool result whose call is missing. The source surface is
    // balanced, so starting the replay at a user message keeps every later
    // call/result pair intact.
    while (messages.length > 0 && messages[0]?.role !== 'user') messages.shift()
    return {
      ...(header?.system === undefined ? {} : { system: header.system }),
      ...(header?.tools === undefined ? {} : { tools: header.tools }),
      messages,
    }
  }

  /** Run the one-shot summarization call through the harness LLM service. */
  async function summarize(session, header, config) {
    const input = buildSummarizationInput(session, header, config)
    if (input.messages.length === 0) return null
    const route = config.provider !== '' && config.model !== ''
      ? { provider: config.provider, model: config.model }
      : header?.config !== undefined && header.config.provider !== '' && header.config.model !== ''
        ? { provider: header.config.provider, model: header.config.model }
        : undefined
    if (route === undefined) {
      throw new Error('no provider/model for summarization: set dsh-auto-handoff.provider/model in settings, or route one request in the conversation first')
    }
    const assembler = new BlockAssembler()
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: SUMMARY_INSTRUCTION }],
        source: { kind: 'dsh-auto-handoff' },
      }),
    ]
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      maxTokens: config.maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
    })) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const blocks = assembler.blocks()
    if (contentHasImage(blocks)) throw new Error('handoff summary cannot contain image output')
    const summary = blocks.filter((block) => block.type === 'text')
    if (!summary.some((block) => block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }
    return { summary, provider: route.provider, model: route.model }
  }

  /**
   * Make the fresh session pick the task up on its own, so a handoff does not
   * park unfinished work until the user types again. `auto` continues only when
   * the carried checklist still has work: a finished task must not restart.
   * @param sessionId - the fresh session to nudge.
   * @param config - resolved plugin configuration.
   * @param todos - fold of the source session's standing todo list.
   * @returns whether a prompt was admitted, and why not when it was skipped.
   */
  async function continueTask(sessionId, config, todos) {
    if (controller === undefined) return { attempted: false, reason: 'no-session-controller' }
    const mode = typeof config.autoContinue === 'string' ? config.autoContinue : 'auto'
    if (mode === 'never') return { attempted: false, reason: 'disabled' }
    if (mode !== 'always' && !hasUnfinishedWork(todos)) return { attempted: false, reason: 'task-complete' }
    try {
      await admitPrompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: config.continuePrompt }],
      })
      return { attempted: true }
    } catch (error) {
      ctx.logger.warn(`dsh-auto-handoff: could not continue "${sessionId}": ${errorMessage(error)}`)
      return { attempted: false, reason: 'prompt-failed', error: errorMessage(error) }
    }
  }

  /**
   * Perform one handoff. Idempotent per source session; callers must have
   * already cleared the scheduling guards for forced handoffs.
   */
  async function handoff(sessionId, trigger) {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: { code: 'session-not-found', message: `session "${sessionId}" is not live` } }
    const config = source()
    const events = eventsOf(session)

    const agent = agents?.get(sessionId)

    // Quiescence gates: a handoff copies a snapshot forward, so the source must
    // not be — and must not become — busy. A mid-turn handoff would cut the
    // source's tool work in half; a handoff with queued input would let that
    // work finish in the old session after the user was moved on.
    if (hasOpenTurn(events)) return refused(sessionId, 'source-open-turn', 'the session has an open turn')
    if (hasActiveCompaction(events)) return refused(sessionId, 'source-compacting', 'a compaction is already in progress')
    if (pendingInputOf(agent) > 0) return refused(sessionId, 'pending-input', 'the session has queued input that will open its own turn')
    if ((session.surface?.nodes ?? []).length === 0) {
      return { ok: false, error: { code: 'empty', message: 'the conversation has no content to hand off' } }
    }

    running.add(sessionId)
    try {
      // The summary describes exactly this content state. Re-read the source
      // after the (multi-second) summarization call: if it kept working
      // meanwhile, the new session would get a stale checkpoint and the
      // source's turn would finish where nobody is looking — so refuse instead
      // of handing off a snapshot that no longer matches.
      const snapshot = contentFingerprint(session)
      const header = session.requestHeader?.() ?? undefined
      const result = await summarize(session, header, config)
      if (result === null) {
        return { ok: false, error: { code: 'empty', message: 'no replayable messages in the conversation' } }
      }
      const moved = staleness(session, agent, snapshot)
      if (moved !== undefined) return refused(sessionId, moved, 'the source session changed while it was being summarized')
      const todos = foldTodos(events)
      const taskBlock = config.carryTasks === false
        ? ''
        : buildTaskBlock({
          todos,
          files: foldTouchedFiles(events),
          lastUser: foldLastUserText(events),
        })
      const backgroundBlock = config.carryTasks === false ? '' : buildBackgroundBlock(sessionId)
      const checkpoint = createUserMessage({
        content: [
          { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
          ...result.summary,
          ...(taskBlock === '' ? [] : [{ type: 'text', text: `\n\n${taskBlock}` }]),
          ...(backgroundBlock === '' ? [] : [{ type: 'text', text: `\n\n${backgroundBlock}` }]),
          { type: 'text', text: `\n${CHECKPOINT_CLOSE_TAG}` },
        ],
        source: { kind: 'dsh-auto-handoff' },
      })
      const headerRecord = session.header ?? {}
      const fresh = await createFreshSession(headerRecord, sessionId)
      generated.add(fresh.id)
      // Last gate before delivery. Creating the fresh session is itself async,
      // so re-read the source once more: if it moved, publish nothing at all —
      // no checkpoint, no navigation — and leave that empty session behind
      // instead of a stale handoff the user cannot roll back.
      const late = staleness(session, agent, snapshot)
      if (late !== undefined) {
        return refused(sessionId, late, 'the source session changed while the fresh session was created', {
          createdSessionId: fresh.id,
        })
      }
      // Queue, never write the bare surface: the format reserves the first
      // surface node for turn 1's system message (see `queueCheckpoint`).
      const checkpointQueued = queueCheckpoint(fresh.id, checkpoint)
      if (!checkpointQueued) {
        ctx.logger.warn(`dsh-auto-handoff: fresh session "${fresh.id}" has no live agent, so the checkpoint was not delivered`)
      }
      await ctx.sessions.flush(fresh)

      // Start the carried task right away. Failure here never fails the handoff:
      // the session is already created and the checkpoint is already injected.
      const continuation = await continueTask(fresh.id, config, todos)

      const turns = completedTurns(events)
      const record = {
        time: Date.now(),
        sourceSessionId: sessionId,
        newSessionId: fresh.id,
        trigger,
        turns,
        checkpointQueued,
        provider: result.provider,
        model: result.model,
        summaryChars: result.summary.reduce((total, block) => total + block.text.length, 0),
        carriedTasks: taskBlock !== '',
        continued: continuation.attempted === true,
        ...(continuation.attempted === true ? {} : { continueSkipReason: continuation.reason }),
      }
      handoffs.set(sessionId, record)
      pending.set(sessionId, record)
      stats.handoffs += 1
      engineGeneration += 1
      cancelScheduled()
      // Background jobs stay owned by the source session, so relay their
      // settlements into the fresh one instead of leaving them orphaned.
      forwardJobResults(sessionId, fresh.id)
      noteDecision(sessionId, { kind: 'handoff', ...record })
      ctx.logger.info(`dsh-auto-handoff: ${sessionId} -> ${fresh.id} (${trigger}, ${turns} turns)`)
      return { ok: true, ...record }
    } catch (error) {
      stats.failures += 1
      stats.lastError = errorMessage(error)
      noteDecision(sessionId, { kind: 'error', reason: errorMessage(error) })
      ctx.logger.warn(`dsh-auto-handoff: handoff of "${sessionId}" failed: ${errorMessage(error)}`)
      return { ok: false, error: { code: 'handoff-failed', message: errorMessage(error) } }
    } finally {
      running.delete(sessionId)
    }
  }

  /** Automatic evaluation for one session that just became idle. */
  async function evaluate(session) {
    const config = source()
    if (config.enabled !== true) return
    // Manual mode (the default): only the composer button / `/handoff` start a
    // handoff. The automatic threshold path stays off unless explicitly enabled.
    if (config.autoHandoff !== true) return
    const sessionId = session.id
    if (generated.has(sessionId)) return
    if (handoffs.has(sessionId)) {
      // The source handed off, then produced work anyway (the user went back to
      // the old tab, a goal round fired, ...). It cannot hand off a second time,
      // but the fact is worth reporting: that work belongs to the OLD session and
      // the new one will never see it.
      noteDecision(sessionId, {
        kind: 'source-active-after-handoff',
        newSessionId: handoffs.get(sessionId)?.newSessionId,
      })
      return
    }
    if (running.has(sessionId)) return

    const events = eventsOf(session)
    if (hasOpenTurn(events)) return
    if (hasActiveCompaction(events)) return

    const turns = completedTurns(events)
    if (turns < config.minRounds) {
      noteSkip(sessionId, 'below-min-rounds', { turns, minRounds: config.minRounds })
      return
    }

    const header = session.requestHeader?.() ?? undefined
    const route = header?.config !== undefined
      ? { provider: header.config.provider, model: header.config.model }
      : undefined
    let occupancy
    try {
      occupancy = await occupancyOf(session, header, route)
    } catch (error) {
      // Never let a measurement failure vanish into the unhandled-rejection log:
      // record why the automatic path could not decide.
      noteSkip(sessionId, 'occupancy-error', { turns, error: errorMessage(error) })
      return
    }
    if (!occupancy.known) {
      noteSkip(sessionId, occupancy.reason, { turns })
      return
    }
    stats.checks += 1
    if (occupancy.ratio < config.threshold) {
      noteSkip(sessionId, 'below-threshold', {
        turns,
        ratio: occupancy.ratio,
        usedTokens: occupancy.usedTokens,
        contextWindow: occupancy.contextWindow,
        threshold: config.threshold,
      })
      return
    }
    await handoff(sessionId, 'auto')
  }

  /**
   * Deferred evaluation so `turn/end` bookkeeping settles first. The generation
   * guard keeps a timer armed before a handoff from re-evaluating a session that
   * has already handed off (and keeps a public manual handoff from racing one).
   */
  function scheduleEvaluate(session) {
    const id = session.id
    if (scheduled.has(id)) return
    const generation = engineGeneration
    const timer = setTimeout(() => {
      scheduled.delete(id)
      if (generation !== engineGeneration) return
      // A user-pressed (queued) handoff wins over threshold evaluation.
      const run = manualQueue.has(id) ? runQueued(session) : evaluate(session)
      void run.catch((error) => {
        ctx.logger.warn(`dsh-auto-handoff: evaluation of "${id}" failed: ${errorMessage(error)}`)
      })
    }, 750)
    if (typeof timer.unref === 'function') timer.unref()
    scheduled.set(id, timer)
  }

  /** Cancel every armed evaluation (a handoff changes what is worth evaluating). */
  function cancelScheduled() {
    for (const timer of scheduled.values()) clearTimeout(timer)
    scheduled.clear()
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    prune()
    if (event.type !== 'turn/end') return
    scheduleEvaluate(session)
  }), 'dsh-auto-handoff: turn/end trigger')

  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const session = ctx.sessions.get(agent.id)
    if (session !== undefined) scheduleEvaluate(session)
  }), 'dsh-auto-handoff: idle trigger')

  ctx.effect(() => () => {
    cancelScheduled()
    for (const dispose of jobBridges) {
      try { dispose() } catch { /* already disposed */ }
    }
    jobBridges.clear()
    manualQueue.clear()
  }, 'dsh-auto-handoff: pending evaluations')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/status',
    handler: async (req, res) => {
      const config = source()
      let sessionId = ''
      try {
        sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? ''
      } catch { /* an unparsable URL is just an empty query */ }
      // The composer widget polls this with its current session, so the payload
      // carries the live numbers the user is looking at.
      let session
      const live = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
      if (live !== undefined) {
        try {
          session = await describeSession(live, config)
        } catch (error) {
          session = { id: sessionId, error: errorMessage(error) }
        }
      }
      send(res, 200, {
        ok: true,
        enabled: config.enabled,
        autoHandoff: config.autoHandoff === true,
        ui: { enabled: config.uiEnabled === true },
        threshold: config.threshold,
        minRounds: config.minRounds,
        prompts: {
          rounds: config.promptRounds,
          percent: config.promptPercent,
          compactions: config.promptCompactions,
        },
        stats,
        handoffs: [...handoffs.values()],
        pending: [...pending.values()].map((record) => ({ sourceSessionId: record.sourceSessionId, newSessionId: record.newSessionId, time: record.time })),
        queue: [...manualQueue.keys()],
        decisions: config.debug === true ? [...decisions.values()] : undefined,
        ...(session === undefined ? {} : { session }),
      })
    },
  }), 'dsh-auto-handoff: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/pending',
    handler: (req, res) => {
      let sessionId = ''
      try {
        sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? ''
      } catch { /* an unparsable URL is just an empty query */ }
      prune()
      const record = pending.get(sessionId)
      if (record === undefined) {
        send(res, 200, { ok: true, pending: null })
        return
      }
      pending.delete(sessionId)
      send(res, 200, { ok: true, pending: record })
    },
  }), 'dsh-auto-handoff: pending route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/queue',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body is not valid JSON' } })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId === '') {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
        return
      }
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        send(res, 404, { ok: false, error: { code: 'session-not-found', message: `session "${sessionId}" is not live` } })
        return
      }
      // The user pressed the button. Park the request so the next idle boundary
      // performs it when the source is quiescent, and try right now as well.
      manualQueue.set(sessionId, { time: Date.now() })
      if (running.has(sessionId)) {
        send(res, 202, { ok: true, queued: true, reason: 'a handoff is already running for this session' })
        return
      }
      const result = await handoff(sessionId, 'manual-queued')
      if (result.ok) {
        manualQueue.delete(sessionId)
        send(res, 200, result)
        return
      }
      if (result.error?.code === 'not-quiescent') {
        // Busy: keep it queued; `turn/end` / idle retries on its own.
        noteSkip(sessionId, 'manual-queued', { reason: result.error.reason })
        send(res, 202, { ok: true, queued: true, reason: result.error.reason })
        return
      }
      manualQueue.delete(sessionId)
      send(res, 502, result)
    },
  }), 'dsh-auto-handoff: queue route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/ui-config',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body is not valid JSON' } })
        return
      }
      // Only the fields the composer widget owns; the settings namespace keeps
      // everything else under the deployment's control.
      const next = pickUiConfig({ ...loadUiConfig(), ...(body ?? {}) })
      const saved = saveUiConfig(next)
      send(res, saved ? 200 : 500, saved
        ? { ok: true, config: next }
        : { ok: false, config: next, error: { code: 'persist-failed', message: `could not write ${uiConfigPath()}` } })
    },
  }), 'dsh-auto-handoff: ui config route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/handoff',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'request body is not valid JSON' } })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId === '') {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
        return
      }
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        send(res, 404, { ok: false, error: { code: 'session-not-found', message: `session "${sessionId}" is not live` } })
        return
      }
      if (running.has(sessionId)) {
        send(res, 409, { ok: false, error: { code: 'busy', message: 'a handoff is already running for this session' } })
        return
      }
      const result = await handoff(sessionId, 'manual')
      // 409 means "the source is not quiescent right now" (retryable); 502 is a
      // real failure (provider error, truncation, ...).
      const status = result.ok
        ? 200
        : result.error?.code === 'not-quiescent' || result.error?.code === 'busy' ? 409 : 502
      send(res, status, result)
    },
  }), 'dsh-auto-handoff: handoff route')
}
