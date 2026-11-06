/**
 * dsh-auto-handoff, node half.
 *
 * Keeps a long conversation from turning into an expensive one: when the user
 * asks for it (or, opt-in, when the thresholds say so), copy the conversation
 * forward into a NEW session of the same workspace and preset, with a handoff
 * document as its first user message, and move the browser there.
 *
 * A handoff is a COPY-FORWARD of a quiescent source:
 *
 *   1. the source must be idle — no open turn, no running compaction, no queued
 *      inbox input — and must not move while the document is produced or the
 *      fresh session is created (a turn finishing in the old session after the
 *      user was moved on would split the work in half);
 *   2. the document is either a model summary (replaying the conversation's own
 *      system prompt, tools and message suffix so the provider's warm prefix
 *      cache is reused) or a deterministic digest of the same messages; `auto`
 *      falls back to the digest when the model call fails, so the button always
 *      produces something;
 *   3. the fresh session receives the document as its first user message. When
 *      the task continues, that document IS the prompt that starts turn 1; when
 *      it does not, it is queued in the agent inbox, which is durable and shows
 *      up as a queued row in the composer.
 *
 * The source is never written to, never cancelled and never migrated: its full
 * history stays in the sidebar.
 *
 * HTTP surface (read by the browser half, usable by anything else):
 *   GET  /api/dsh-auto-handoff/status?sessionId=  config, counters, live session
 *   POST /api/dsh-auto-handoff/handoff            force one handoff { sessionId, force? }
 *   POST /api/dsh-auto-handoff/queue              queue one for the next idle moment
 *   GET  /api/dsh-auto-handoff/pending?sessionId= read+clear a pending navigation
 *   POST /api/dsh-auto-handoff/ui-config          widget-owned thresholds
 *
 * The API key never leaves the harness: the summarization call goes through
 * `ctx.llm`, which resolves the routed provider/model and credentials itself.
 *
 * @module dsh-auto-handoff
 */

import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { blocksText, buildCheckpointBlocks, buildDigest } from './checkpoint.js'
import { NS, SCHEMA, UiConfigStore, normalizeConfig } from './config.js'
import { buildTaskBlock, foldLastUserText, foldTodos, foldTouchedFiles, hasUnfinishedWork } from './handover.js'
import { MetricsBook, evaluatePrompts } from './metrics.js'
import { deriveMessages, eventsOf } from './replay.js'
import { summarizeReplay } from './summary.js'

export const name = 'dsh-auto-handoff'
export const inject = ['webServer', 'settings', 'sessions', 'llm', 'tokenMeter']

/** Reject bodies over 256 KiB before buffering. */
const MAX_BODY_BYTES = 256 * 1024
/** How long a pending navigation record is retained for a late browser poll. */
const PENDING_TTL_MS = 10 * 60 * 1000
/** How long a session's decision record is retained for /status. */
const DECISION_TTL_MS = 30 * 60 * 1000
/** Minimum spacing between two TTL sweeps (there is one per session event). */
const PRUNE_INTERVAL_MS = 30 * 1000
/** How long a token-meter measurement is reused before it is taken again. */
const MEASURE_TTL_MS = 5000
/** How long one provider/model's context window is reused. */
const WINDOW_TTL_MS = 10 * 60 * 1000
/** How long one provider/model's FAILED window lookup is remembered. */
const WINDOW_FAILURE_TTL_MS = 60 * 1000
/** How long a background-job bridge stays open. */
const JOB_BRIDGE_TTL_MS = 15 * 60 * 1000
/** Upper bound of simultaneously open job bridges. */
const MAX_JOB_BRIDGES = 20
/** Delay before a turn/end or idle boundary is evaluated (bookkeeping settles first). */
const EVALUATE_DELAY_MS = 750

/** Terminal job states never count as background work to inherit. */
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])

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

/** Message text of any thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Parse the query string of one request without trusting it. */
function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** Concatenate one job output read's retained chunks. */
function chunkText(chunks) {
  if (!Array.isArray(chunks)) return ''
  let text = ''
  for (const chunk of chunks) if (typeof chunk?.text === 'string') text += chunk.text
  return text
}

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
  /** Session ids whose document is currently being produced. */
  const running = new Set()
  /** Session id -> debounce timer for the next automatic evaluation. */
  const scheduled = new Map()
  /** Sessions whose manual handoff is waiting for a quiescent moment. */
  const manualQueue = new Map()
  /** Disposers of job-completion bridges (source session -> fresh session). */
  const jobBridges = new Set()
  /** Bumped whenever a handoff lands; invalidates evaluations armed before it. */
  let engineGeneration = 0
  /** Last TTL sweep, so hot event streams do not sweep on every event. */
  let lastPrune = 0

  const stats = { checks: 0, handoffs: 0, failures: 0, degraded: 0, lastError: null, lastHandoffAt: null }
  const metricsBook = new MetricsBook()
  const uiConfig = new UiConfigStore()
  /** Session id -> last `tokenMeter.measure()` result (the expensive fallback). */
  const measureMemo = new Map()
  /** `provider/model` -> last context-window lookup. */
  const windowMemo = new Map()

  /** Settings scope handle; `undefined` until the settings service is ready. */
  let settingsScope
  ctx.inject(['settings'], (settingsCtx) => {
    settingsScope = settingsCtx.settings.register(NS, SCHEMA)
  })

  /**
   * Resolve the effective configuration.
   *
   * The widget's file is already in memory (see {@link UiConfigStore}) and the
   * settings scope is a cheap projection read, so this is safe to call per
   * event — which the previous version did NOT do: it re-read the UI file with a
   * synchronous `readFileSync` on every access.
   * @returns the complete, bounded configuration.
   */
  function config() {
    const scoped = settingsScope?.get?.() ?? {}
    return normalizeConfig({ ...scoped, ...uiConfig.get() })
  }

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
   * Live agent registry, when present. The checkpoint reaches a fresh session
   * through its agent inbox rather than its surface — see `queueCheckpoint`.
   */
  let agents
  ctx.inject(['agents'], (agentsCtx) => {
    agents = agentsCtx.agents
  })

  function noteDecision(sessionId, record) {
    decisions.set(sessionId, { sessionId, time: Date.now(), ...record })
  }

  function noteSkip(sessionId, reason, extra) {
    if (config().debug === false) return
    noteDecision(sessionId, { kind: 'skip', reason, ...extra })
  }

  /**
   * Decline a handoff because the source is not provably quiescent.
   *
   * Records a decision for /status. `retryable` tells the queue whether the next
   * idle boundary could still perform it: a busy source can, a session whose
   * goal is driving it cannot (that state does not resolve on its own).
   * @param sessionId - the source session that was refused.
   * @param reason - stable machine reason code.
   * @param message - human-readable sentence carried to the manual route.
   * @param extra - additional decision fields.
   * @param retryable - whether a later idle boundary may retry (default true).
   * @returns the declined handoff result.
   */
  function refused(sessionId, reason, message, extra = {}, retryable = true) {
    noteSkip(sessionId, reason, { ...extra, retryable })
    return {
      ok: false,
      error: {
        code: 'not-quiescent',
        reason,
        retryable,
        message: `source session "${sessionId}": ${message}`,
      },
    }
  }

  /** Drop expired navigation and decision records, at most once per interval. */
  function prune(force = false) {
    const now = Date.now()
    if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return
    lastPrune = now
    for (const [id, record] of pending) {
      if (now - record.time > PENDING_TTL_MS) pending.delete(id)
    }
    for (const [id, record] of decisions) {
      if (now - record.time > DECISION_TTL_MS) decisions.delete(id)
    }
    for (const [id, record] of measureMemo) {
      if (now - record.at > MEASURE_TTL_MS * 12) measureMemo.delete(id)
    }
  }

  /**
   * Latest context-pressure projection of one session, when it is registered.
   * This is the same projection the GUI renders its occupancy from: reading it
   * is O(1), while `tokenMeter.measure()` re-prices the whole surface.
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
   * Phase of the session's autonomous goal, when this deployment tracks one.
   * An `active` goal keeps prompting the OLD session after every turn, so a
   * handoff now would split the work across two conversations.
   * @param session - live session to read.
   * @returns the goal phase, or undefined when there is no goal.
   */
  function goalPhaseOf(session) {
    try {
      const phase = ctx.get('sessionProjections')?.stateOf?.(session, 'goal')?.current?.goal?.phase
      return typeof phase === 'string' ? phase : undefined
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
   * Context window of one provider/model, memoized: `resolveModelInfo` can hit
   * the network, and the widget polls every couple of seconds.
   * @param route - provider/model pair.
   * @returns the window in tokens, or undefined when the route cannot be resolved.
   */
  async function contextWindowOf(route) {
    if (route === undefined) return undefined
    const key = `${route.provider}/${route.model}`
    const now = Date.now()
    const memo = windowMemo.get(key)
    if (memo !== undefined) {
      const ttl = memo.window === undefined ? WINDOW_FAILURE_TTL_MS : WINDOW_TTL_MS
      if (now - memo.at < ttl) return memo.window
    }
    let window
    try {
      window = (await ctx.llm.resolveModelInfo(route.provider, route.model))?.context?.contextWindow
    } catch {
      window = undefined
    }
    if (typeof window !== 'number' || window <= 0) window = undefined
    windowMemo.set(key, { at: now, window })
    return window
  }

  /**
   * Provider/model the source session's last request was routed to.
   * @param header - folded request header.
   * @returns the route, or undefined when the session never ran a request.
   */
  function headerRoute(header) {
    const routed = header?.config
    if (typeof routed?.provider !== 'string' || routed.provider === '') return undefined
    if (typeof routed.model !== 'string' || routed.model === '') return undefined
    return { provider: routed.provider, model: routed.model }
  }

  /**
   * Context occupancy of one session as a 0..1 ratio, or a reason it is unknown.
   *
   * The `contextPressure` projection is read first (it is maintained by the
   * token meter and is O(1)); `measure()` — which re-prices the whole surface —
   * is only the fallback, and its result is reused for a few seconds.
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
      const memo = measureMemo.get(session.id)
      if (memo !== undefined && Date.now() - memo.at < MEASURE_TTL_MS) {
        usedTokens = memo.usedTokens
      } else {
        try {
          const measurement = ctx.tokenMeter.measure(session, header)
          usedTokens = typeof measurement?.totalTokens === 'number'
            ? measurement.totalTokens
            : measurement?.projectedTokens ?? measurement?.pressureTokens
          measureMemo.set(session.id, { at: Date.now(), usedTokens })
        } catch (error) {
          return { known: false, reason: `measure-failed: ${errorMessage(error)}` }
        }
      }
    }
    if (usedTokens === undefined) return { known: false, reason: 'no-provider-usage-yet' }
    if (contextWindow === undefined || contextWindow <= 0) {
      contextWindow = await contextWindowOf(route)
      if (contextWindow === undefined) return { known: false, reason: 'context-window-unresolved' }
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
  async function describeSession(session, resolved) {
    const events = eventsOf(session)
    const metrics = metricsBook.read(session.id, events)
    const header = session.requestHeader?.() ?? undefined
    const route = headerRoute(header)
    let occupancy
    try {
      occupancy = await occupancyOf(session, header, route)
    } catch (error) {
      occupancy = { known: false, reason: `occupancy-error: ${errorMessage(error)}` }
    }
    return {
      id: session.id,
      turns: metrics.turns,
      compactions: metrics.compactions,
      occupancy,
      jobs: runningJobs(session.id),
      prompts: evaluatePrompts(metrics, occupancy, resolved),
      queued: manualQueue.has(session.id),
      goal: goalPhaseOf(session) ?? null,
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
    // Bound the number of live bridges: a long-lived browser tab could otherwise
    // accumulate one subscription per handoff for the life of the process.
    while (jobBridges.size >= MAX_JOB_BRIDGES) {
      const oldest = jobBridges.values().next().value
      jobBridges.delete(oldest)
      try { oldest() } catch { /* already disposed */ }
    }
    jobBridges.add(dispose)
    const timer = setTimeout(() => {
      jobBridges.delete(dispose)
      try { dispose() } catch { /* already disposed */ }
    }, JOB_BRIDGE_TTL_MS)
    timer.unref?.()
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
    const cwd = headerRecord?.cwd
    const preset = headerRecord?.agentPreset
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

  /**
   * Deliver the checkpoint into a fresh session.
   *
   * When the task continues, the checkpoint text IS the prompt that opens turn
   * 1 — one user message instead of a silent queued document followed by a
   * second "continue" prompt, and the model starts working immediately. When it
   * does not, the document is queued in the durable inbox and waits for the user
   * (the composer renders it as a queued row, so the session never looks empty).
   * @param sessionId - the fresh session.
   * @param message - the checkpoint user message.
   * @param continueNow - whether the task should keep going on its own.
   * @returns how the document was delivered, and why not when it was not.
   */
  async function deliverCheckpoint(sessionId, message, continueNow) {
    if (continueNow) {
      if (controller === undefined) return { delivery: 'none', continued: false, reason: 'no-session-controller' }
      try {
        await controller.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: blocksText(message.content) }],
        }, new AbortController().signal)
        return { delivery: 'prompt', continued: true }
      } catch (error) {
        ctx.logger.warn(`dsh-auto-handoff: could not start "${sessionId}": ${errorMessage(error)}`)
        const queued = queueCheckpoint(sessionId, message)
        return { delivery: queued ? 'inbox' : 'none', continued: false, reason: 'prompt-failed', error: errorMessage(error) }
      }
    }
    const queued = queueCheckpoint(sessionId, message)
    if (!queued) return { delivery: 'none', continued: false, reason: 'no-live-agent' }
    return { delivery: 'inbox', continued: false, reason: 'disabled' }
  }

  /**
   * Say why a live source is no longer the state a handoff document describes,
   * or `undefined` when it is still quiescent.
   *
   * A handoff copies a snapshot forward, so the source must neither be busy nor
   * have moved between taking that snapshot and delivering it.
   * @param session - live source session to re-read.
   * @param agent - its live agent, when the deployment has one.
   * @param fingerprint - content fingerprint the document was taken at.
   * @returns a stable reason code, or undefined when the source is unchanged.
   */
  function staleness(session, agent, fingerprint) {
    if (contentFingerprint(session) !== fingerprint) return 'source-moved'
    const metrics = metricsBook.read(session.id, eventsOf(session))
    if (metrics.openTurn) return 'source-open-turn'
    if (metrics.compacting) return 'source-compacting'
    if (agent !== undefined && agent.status !== 'idle') return 'source-busy'
    if (pendingInputOf(agent) > 0) return 'pending-input'
    return undefined
  }

  /**
   * Perform one handoff.
   *
   * @param sessionId - live source session id.
   * @param trigger - who asked: `auto`, `manual`, `manual-queued`.
   * @param options - `force` bypasses the goal guard.
   * @returns the handoff record, or a machine-readable failure.
   */
  async function handoff(sessionId, trigger, options = {}) {
    const resolved = config()
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      return { ok: false, error: { code: 'session-not-found', message: `session "${sessionId}" is not live` } }
    }
    const events = eventsOf(session)
    const metrics = metricsBook.read(sessionId, events)
    const agent = agents?.get(sessionId)

    // Quiescence gates: a handoff copies a snapshot forward, so the source must
    // not be — and must not become — busy. A mid-turn handoff would cut the
    // source's tool work in half; a handoff with queued input would let that
    // work finish in the old session after the user was moved on.
    if (metrics.openTurn) return refused(sessionId, 'source-open-turn', 'the session has an open turn')
    if (metrics.compacting) return refused(sessionId, 'source-compacting', 'a compaction is already in progress')
    if (agent !== undefined && agent.status !== undefined && agent.status !== 'idle') {
      return refused(sessionId, 'source-busy', `the session is ${agent.status}`)
    }
    if (pendingInputOf(agent) > 0) return refused(sessionId, 'pending-input', 'the session has queued input that will open its own turn')
    if ((session.surface?.nodes ?? []).length === 0) {
      return { ok: false, error: { code: 'empty', message: 'the conversation has no content to hand off' } }
    }
    const goalPhase = goalPhaseOf(session)
    if (resolved.guardGoal === true && goalPhase === 'active' && options.force !== true) {
      return refused(
        sessionId,
        'goal-active',
        'this session is still driving an autonomous goal; finish or pause the goal first (the old session keeps working otherwise)',
        { goalPhase },
        false,
      )
    }

    running.add(sessionId)
    try {
      // The document describes exactly this content state. Re-read the source
      // after the (multi-second) model call: if it kept working meanwhile, the
      // new session would get a stale checkpoint and the source's turn would
      // finish where nobody is looking — so refuse instead of handing off a
      // snapshot that no longer matches.
      const snapshot = contentFingerprint(session)
      const header = session.requestHeader?.() ?? undefined
      const derived = deriveMessages(session, events)
      let summary = null
      let degraded = null
      if (resolved.summaryMode !== 'digest') {
        try {
          summary = await summarizeReplay({ llm: ctx.llm, session, header, config: resolved })
        } catch (error) {
          // `llm` is strict on purpose; `auto` never lets a provider hiccup cost
          // the user their handoff — it falls back to the local digest below.
          if (resolved.summaryMode === 'llm') throw error
          degraded = errorMessage(error)
          stats.degraded += 1
        }
      }
      const moved = staleness(session, agent, snapshot)
      if (moved !== undefined) {
        return refused(sessionId, moved, 'the source session changed while it was being summarized')
      }

      const todos = foldTodos(events)
      const taskBlock = resolved.carryTasks === false
        ? ''
        : buildTaskBlock({
          todos,
          files: foldTouchedFiles(events),
          lastUser: foldLastUserText(events),
        })
      const backgroundBlock = resolved.carryTasks === false ? '' : buildBackgroundBlock(sessionId)
      const summaryBlocks = summary?.summary ?? []
      const summaryDigest = summaryBlocks.length === 0
        && (resolved.summaryMode === 'digest' || degraded !== null)
        ? buildDigest(derived, { budget: Math.min(8000, resolved.maxInputChars) })
        : ''
      // A surface with no replayable user message (fully compacted, or only
      // tool/assistant content) still carries task state: hand off the task
      // block alone instead of refusing the button the user just pressed.
      if (summaryBlocks.length === 0 && summaryDigest === '' && taskBlock === '' && backgroundBlock === '') {
        return { ok: false, error: { code: 'empty', message: 'the session has no replayable messages and no task state to hand off' } }
      }
      const notes = []
      if (summary?.truncated === true) notes.push('摘要在模型输出长度上限处被截断；下面的任务状态与后台任务清单是完整的')
      if (degraded !== null) notes.push(`模型摘要不可用（${degraded}），上面的对话摘录由本地规则自动生成`)
      const continueNow = resolved.autoContinue === 'always'
        || (resolved.autoContinue === 'auto' && hasUnfinishedWork(todos))
      const blocks = buildCheckpointBlocks({
        summaryBlocks,
        digest: summaryDigest,
        note: notes.join('；'),
        taskBlock,
        backgroundBlock,
        continueText: continueNow ? resolved.continuePrompt : '',
      })
      const checkpoint = createUserMessage({ content: blocks, source: { kind: 'dsh-auto-handoff' } })
      const fresh = await createFreshSession(session.header ?? {}, sessionId)
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
      const delivery = await deliverCheckpoint(fresh.id, checkpoint, continueNow)
      if (delivery.delivery === 'none') {
        ctx.logger.warn(`dsh-auto-handoff: fresh session "${fresh.id}" accepted no checkpoint (${delivery.reason})`)
      }
      await ctx.sessions.flush(fresh)

      const record = {
        time: Date.now(),
        sourceSessionId: sessionId,
        newSessionId: fresh.id,
        trigger,
        turns: metrics.turns,
        delivery: delivery.delivery,
        checkpointQueued: delivery.delivery === 'inbox',
        provider: summary?.provider ?? null,
        model: summary?.model ?? null,
        summaryChars: summaryBlocks.reduce((total, block) => total + block.text.length, 0)
          + summaryDigest.length,
        summarySource: summaryBlocks.length > 0 ? 'llm' : summaryDigest !== '' ? 'digest' : 'task-only',
        degraded,
        truncated: summary?.truncated === true,
        usage: summary?.usage ?? null,
        inputChars: summary?.inputChars ?? null,
        carriedTasks: taskBlock !== '' || backgroundBlock !== '',
        continued: delivery.continued === true,
        ...(delivery.continued === true ? {} : { continueSkipReason: delivery.reason }),
        goalPhase: goalPhase ?? null,
      }
      handoffs.set(sessionId, record)
      pending.set(sessionId, record)
      stats.handoffs += 1
      stats.lastHandoffAt = record.time
      engineGeneration += 1
      cancelScheduled()
      // Background jobs stay owned by the source session, so relay their
      // settlements into the fresh one instead of leaving them orphaned.
      forwardJobResults(sessionId, fresh.id)
      noteDecision(sessionId, { kind: 'handoff', ...record })
      ctx.logger.info(`dsh-auto-handoff: ${sessionId} -> ${fresh.id} (${trigger}, ${metrics.turns} turns, ${record.summarySource})`)
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
    const resolved = config()
    if (resolved.enabled !== true) return
    // Manual mode (the default): only the composer button / `/handoff` start a
    // handoff. The automatic threshold path stays off unless explicitly enabled.
    if (resolved.autoHandoff !== true) return
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
    const metrics = metricsBook.read(sessionId, events)
    if (metrics.openTurn || metrics.compacting) return
    // An autonomously driven goal moves this session on its own: a handoff now
    // would leave the goal running in the old conversation.
    if (resolved.guardGoal === true && goalPhaseOf(session) === 'active') {
      noteSkip(sessionId, 'goal-active', { turns: metrics.turns })
      return
    }
    if (metrics.turns < resolved.minRounds) {
      noteSkip(sessionId, 'below-min-rounds', { turns: metrics.turns, minRounds: resolved.minRounds })
      return
    }

    const header = session.requestHeader?.() ?? undefined
    let occupancy
    try {
      occupancy = await occupancyOf(session, header, headerRoute(header))
    } catch (error) {
      // Never let a measurement failure vanish into the unhandled-rejection log:
      // record why the automatic path could not decide.
      noteSkip(sessionId, 'occupancy-error', { turns: metrics.turns, error: errorMessage(error) })
      return
    }
    if (!occupancy.known) {
      noteSkip(sessionId, occupancy.reason, { turns: metrics.turns })
      return
    }
    stats.checks += 1
    if (occupancy.ratio < resolved.threshold) {
      noteSkip(sessionId, 'below-threshold', {
        turns: metrics.turns,
        ratio: occupancy.ratio,
        usedTokens: occupancy.usedTokens,
        contextWindow: occupancy.contextWindow,
        threshold: resolved.threshold,
      })
      return
    }
    await handoff(sessionId, 'auto')
  }

  /** Run one queued manual handoff as soon as the source is quiescent. */
  async function runQueued(session) {
    const sessionId = session.id
    if (!manualQueue.has(sessionId) || running.has(sessionId)) return
    const result = await handoff(sessionId, 'manual-queued')
    if (result.ok || result.error?.code !== 'not-quiescent' || result.error?.retryable === false) {
      manualQueue.delete(sessionId)
    }
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
    }, EVALUATE_DELAY_MS)
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
      const resolved = config()
      prune()
      const sessionId = queryOf(req).get('sessionId') ?? ''
      // The composer widget polls this with its current session, so the payload
      // carries the live numbers the user is looking at.
      let session
      const live = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
      if (live !== undefined) {
        try {
          session = await describeSession(live, resolved)
        } catch (error) {
          session = { id: sessionId, error: errorMessage(error) }
        }
      }
      const navigation = sessionId === '' ? undefined : pending.get(sessionId) ?? null
      send(res, 200, {
        ok: true,
        enabled: resolved.enabled,
        autoHandoff: resolved.autoHandoff === true,
        ui: { enabled: resolved.uiEnabled === true },
        threshold: resolved.threshold,
        minRounds: resolved.minRounds,
        summaryMode: resolved.summaryMode,
        autoContinue: resolved.autoContinue,
        prompts: {
          rounds: resolved.promptRounds,
          percent: resolved.promptPercent,
          compactions: resolved.promptCompactions,
        },
        stats,
        handoffs: [...handoffs.values()],
        pending: [...pending.values()].map(record => ({
          sourceSessionId: record.sourceSessionId,
          newSessionId: record.newSessionId,
          time: record.time,
        })),
        queue: [...manualQueue.keys()],
        ...(resolved.debug === true ? { decisions: [...decisions.values()] } : {}),
        ...(session === undefined ? {} : { session }),
        // Delivered, never consumed here: `/pending` is the endpoint that clears
        // it, so a status poll cannot race the browser's navigation.
        ...(navigation === undefined ? {} : { navigation }),
      })
    },
  }), 'dsh-auto-handoff: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-handoff/pending',
    handler: (req, res) => {
      prune()
      const sessionId = queryOf(req).get('sessionId') ?? ''
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
      if (running.has(sessionId)) {
        send(res, 202, { ok: true, queued: true, reason: 'a handoff is already running for this session' })
        return
      }
      const force = body?.force === true
      // The user pressed the button. Park the request so the next idle boundary
      // performs it when the source is quiescent, and try right now as well.
      manualQueue.set(sessionId, { time: Date.now() })
      const result = await handoff(sessionId, 'manual-queued', { force })
      if (result.ok) {
        manualQueue.delete(sessionId)
        send(res, 200, result)
        return
      }
      if (result.error?.code === 'not-quiescent' && result.error.retryable !== false) {
        // Busy: keep it queued; `turn/end` / idle retries on its own.
        noteSkip(sessionId, 'manual-queued', { reason: result.error.reason })
        send(res, 202, { ok: true, queued: true, reason: result.error.reason })
        return
      }
      manualQueue.delete(sessionId)
      send(res, result.error?.code === 'not-quiescent' ? 409 : 502, result)
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
      const saved = uiConfig.save(body ?? {})
      send(res, saved ? 200 : 500, saved
        ? { ok: true, config: uiConfig.get() }
        : { ok: false, config: uiConfig.get(), error: { code: 'persist-failed', message: `could not write ${uiConfig.path}` } })
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
      const result = await handoff(sessionId, 'manual', { force: body?.force === true })
      // 409 means "the source is not in a state a handoff may copy" (retryable,
      // or explicable by the user); 502 is a real failure.
      const status = result.ok
        ? 200
        : result.error?.code === 'not-quiescent' || result.error?.code === 'busy' ? 409 : 502
      send(res, status, result)
    },
  }), 'dsh-auto-handoff: handoff route')
}
