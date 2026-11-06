/**
 * dsh-auto-handoff host-half integration check.
 *
 * Loads `lib/index.js` through a REAL Cordis root and real schemastery, with
 * the DSH services stubbed by faithful fakes. This is the check that catches
 * what a syntax check cannot: a schema that does not build, a missing export, an
 * `effect` contract violation, a route path typo, or a promise the plugin never
 * handled.
 *
 * It also drives real handoffs (automatic, manual, queued, degraded) against
 * fake sessions, so the trigger rules, the summarization replay, the fresh
 * session creation, the checkpoint delivery and the pending record are all
 * exercised against the shapes the harness actually uses.
 *
 * `@deepseek-ai/*` is resolved through a resolve hook instead of junctions, so
 * the suite runs without elevated filesystem privileges (see resolve-install).
 *
 * Run: powershell -ExecutionPolicy Bypass -File test\run-tests.ps1
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerResolver } from './resolve-install.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// The widget writes its threshold overrides under DSH_HOME; keep the test's
// writes out of the real home directory.
process.env.DSH_HOME = join(tmpdir(), `dsh-auto-handoff-test-${process.pid}`)
mkdirSync(process.env.DSH_HOME, { recursive: true })

// Resolve the harness peers, then import them (static imports are linked before
// any hook could be installed, so these two must be dynamic).
registerResolver()
const { Context } = await import('@deepseek-ai/cordis')
const z = (await import('@deepseek-ai/schemastery')).default

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Minimal faithful Session stand-in: event log, surface and derived messages. */
function makeSession(id, { cwd = 'E:\\work', turns = 3, preset = 'default', todos, files = [], lastUser } = {}) {
  const events = []
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } })
    const userText = lastUser !== undefined && turn === turns ? lastUser : `用户第 ${turn} 轮`
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: userText }] } })
    events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: `助手第 ${turn} 轮` }] } })
    if (turn === turns) {
      if (todos !== undefined) events.push({ type: 'todo/write', data: { todos } })
      for (const path of files) {
        events.push({
          type: 'tool/call',
          data: { turn, step: 1, callId: `call-${path}`, name: 'ops_edit_file', arguments: JSON.stringify({ path }) },
        })
      }
    }
    events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  const nodes = events.map((_, index) => index).filter(index => events[index].type.endsWith('message'))
  return {
    id,
    header: { id, cwd, agentPreset: preset },
    // Faithful to the real Session: the log is read through snapshotEvents(),
    // not an `events` property — reading that used to crash every live session.
    snapshotEvents: () => events,
    surface: { nodes, replaceGeneration: 0, contentGeneration: 0 },
    /** Faithful roles: the summarization replay anchors on a user message. */
    deriveEventMessage: (event) => {
      const payload = event.data.message ?? event.data
      return {
        role: event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : 'user',
        content: payload.content ?? [],
        ...(event.type === 'tool/result' ? { toolCallId: payload.toolCallId } : {}),
      }
    },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    append: (type, data) => { events.push({ type, data }); return events.length },
  }
}

console.log('=== dsh-auto-handoff host-half check ===')

// ---------------------------------------------------------------- services
const routes = []
const settingsScopes = []
const created = []
const streamed = []
const prompts = []
/** Mutable settings values, read live by the fake settings scope. */
const settingsState = { autoHandoff: false }
/** Goal projection state per session (the real one is keyed by session). */
const goalBySession = new Map()
/** Providers whose context window was resolved (memoized by the plugin). */
let resolveModelCalls = 0
/** `tokenMeter.measure()` calls, per session (the expensive fallback). */
const measureCalls = []
/** Warnings the host half logged; expected ones are asserted, not failed. */
const warns = []
/** Terminal background-job publications still reachable from the test. */
let jobSubscription

const webServer = {
  register(route) {
    if (routes.some(existing => existing.kind === route.kind && existing.path === route.path)) {
      throw new Error(`duplicate ${route.kind} route "${route.path}"`)
    }
    routes.push(route)
    return () => { routes.splice(routes.indexOf(route), 1) }
  },
}
const settings = {
  register(namespace, schema) {
    const scope = {
      namespace,
      get: () => schema(settingsState),
      schema,
    }
    settingsScopes.push(scope)
    return scope
  },
}
const sessions = {
  store: new Map(),
  get(id) { return this.store.get(id) },
  create(id, options) {
    const created0 = makeSession(id ?? `session-${this.store.size + 1}`, {})
    created0.header = { ...created0.header, ...(options?.meta ?? {}) }
    created0.appended = []
    created0.append = (type, data) => { created0.appended.push({ type, data }) }
    this.store.set(created0.id, created0)
    created.push(created0)
    return created0
  },
  flush: async () => true,
}
/** Optional one-shot hook run inside the summarization stream, to stage a source that keeps working. */
let duringSummarize
/** When set, the next summarization stream reports a token-capped finish. */
let truncateSummarize = false
/** When set (an Error), the next summarization stream fails and clears it. */
let failSummarize = null
const llm = {
  async resolveModelInfo(provider, model) {
    resolveModelCalls += 1
    return { context: { contextWindow: 100_000 } }
  },
  async *stream(options) {
    streamed.push(options)
    if (duringSummarize !== undefined) {
      const hook = duringSummarize
      duringSummarize = undefined
      hook()
    }
    if (failSummarize !== null) {
      const error = failSummarize
      failSummarize = null
      throw error
    }
    const text = '【摘要】目标：验证自动交接；进度：宿主半边已跑通。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 12 } }
    if (truncateSummarize) {
      truncateSummarize = false
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const tokenMeter = {
  // DSH 0.2 shape: the meter reports current pressure as totalTokens; the legacy
  // projectedTokens/pressureTokens/contextWindow live on the contextPressure projection.
  measure: (session) => {
    measureCalls.push(session?.id ?? 'unknown')
    return { totalTokens: 82_000 }
  },
}
/** Records the prompt admitted to a fresh session (the continue path). */
const createRequests = []
const sessionController = {
  prompt(request) {
    prompts.push(request)
    return Promise.resolve({ accepted: true })
  },
  create(request) {
    createRequests.push(request)
    const fresh = sessions.create(undefined, {
      meta: {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      },
    })
    return Promise.resolve({ sessionId: fresh.id })
  },
}
/**
 * Records inbox delivery. The checkpoint must arrive as a QUEUED message
 * (`send(message, 'next-turn', false)`), never as a surface append: a
 * pre-turn `user/message` before turn 1's `system/message` makes the stored
 * log unresumable ("system/message requires a protected first surface head").
 */
const sent = []
/** Follow-up messages the plugin pushed into a fresh session's agent. */
const followedUp = []
/** Per-session live-agent stand-ins: idle with an empty inbox unless a case stages work. */
const agentRecords = new Map()
function agentFor(id) {
  let record = agentRecords.get(id)
  if (record === undefined) {
    record = {
      id,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      send(message, target, wakeup) {
        sent.push({ sessionId: id, message, target, wakeup })
      },
      followup(message) {
        followedUp.push({ sessionId: id, message })
      },
    }
    agentRecords.set(id, record)
  }
  return record
}
const agents = { get: (id) => (sessions.store.has(id) ? agentFor(id) : undefined) }
/** One running background job, owned by `session-source`. */
const jobs = {
  list(sessionId) {
    if (sessionId !== 'session-source') return []
    return [{ id: 'job-1', kind: 'bash', status: 'running', spec: { command: 'pnpm build' } }]
  },
  readAt() {
    return { chunks: [{ text: 'building the bundle…' }] }
  },
  events: {
    subscribe(filter, handler) {
      jobSubscription = { filter, handler }
      return () => { jobSubscription = undefined }
    },
  },
}
/** What the host projects for a session: the goal phase and the pressure state. */
const sessionProjections = {
  stateOf(session, key) {
    if (key === 'goal') return goalBySession.get(session.id) ?? { current: null }
    // No contextPressure projection in this fake, so the plugin must fall back
    // to `tokenMeter.measure()` — exactly what a cold session looks like.
    return undefined
  },
}
const workspaceRegistry = {
  list: () => [{ id: 'ws-1', path: 'E:\\work' }],
}

// ------------------------------------------------------------------ mount
const ctx = new Context()
ctx.logger = {
  info: () => {},
  warn: (message) => { warns.push(message) },
  error: console.error,
  debug: () => {},
}
/** `provide`'s third argument is an availability PREDICATE, not a flag. */
const available = () => true
ctx.provide('webServer', webServer, available)
ctx.provide('settings', settings, available)
ctx.provide('sessions', sessions, available)
ctx.provide('llm', llm, available)
ctx.provide('tokenMeter', tokenMeter, available)
ctx.provide('sessionController', sessionController, available)
ctx.provide('agents', agents, available)
ctx.provide('jobs', jobs, available)
ctx.provide('sessionProjections', sessionProjections, available)
ctx.provide('workspaceRegistry', workspaceRegistry, available)

const module = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
check('host half exports name', typeof module.name === 'string' && module.name.length > 0)
check('host half exports apply()', typeof module.apply === 'function')
check('host half injects the five services', Array.isArray(module.inject)
  && ['webServer', 'settings', 'sessions', 'llm', 'tokenMeter'].every(name => module.inject.includes(name)),
`got ${JSON.stringify(module.inject)}`)

// Mount exactly the way the loader does: a plugin entry under its own fiber,
// so `ctx.inject(...)` / `ctx.effect(...)` are attributed and disposable.
const owner = ctx.plugin(module)
check('plugin mounted without error', owner !== undefined && routes.length === 0, 'apply must wait for injected services')
await new Promise(resolvePromise => { setTimeout(resolvePromise, 50) })
check('settings namespace registered', settingsScopes.length === 1 && settingsScopes[0].namespace === 'dsh-auto-handoff')
check('five routes registered', routes.length === 5, `got ${routes.map(route => route.path).join(', ')}`)
for (const path of ['/api/dsh-auto-handoff/status', '/api/dsh-auto-handoff/pending', '/api/dsh-auto-handoff/handoff', '/api/dsh-auto-handoff/queue', '/api/dsh-auto-handoff/ui-config']) {
  check(`route ${path}`, routes.some(route => route.path === path && route.kind === 'exact'))
}

/** Drive one route with a fake request/response pair. */
async function hit(path, { method = 'GET', url = path, body } = {}) {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status
  let payload
  const response = {
    writeHead(code) { status = code },
    end(text) { payload = JSON.parse(text) },
  }
  await route.handler(request, response)
  return { status, payload }
}

/** Deliver `turn/end` on the real Cordis bus the way the agent loop does. */
function emitTurnEnd(target) {
  return new Promise((resolvePromise) => {
    // The plugin debounces by 750ms, so wait past that before asserting.
    ctx.emit('session/event', target, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    setTimeout(resolvePromise, 1200)
  })
}

// ------------------------------------------------------------------ trigger
const session = makeSession('session-source', {
  todos: [
    { content: '读代码', status: 'completed' },
    { content: '改实现', status: 'in_progress' },
  ],
  files: ['src/a.ts'],
  lastUser: '把登录页做完',
})
sessions.store.set(session.id, session)
settingsState.autoHandoff = true

await emitTurnEnd(session)

check('summarization call went through ctx.llm.stream', streamed.length === 1, `got ${streamed.length}`)
if (streamed.length === 1) {
  const call = streamed[0]
  check('summarization reuses the source route', call.provider === 'deepseek' && call.model === 'deepseek-chat')
  check('summarization replays the conversation prefix', Array.isArray(call.messages) && call.messages.length >= 6)
  check('summarization keeps the tool envelope', call.tools === undefined || Array.isArray(call.tools))
  check('summarization caps output tokens', call.maxTokens === 4096)
}
check('one fresh session created', created.length === 1, `got ${created.length}`)
check('fresh session was created through the session controller', createRequests.length === 1, `got ${createRequests.length}`)
if (createRequests.length === 1) {
  check('controller creation names the source workspace', createRequests[0].workspaceId === 'ws-1',
    JSON.stringify(createRequests[0]))
}
if (created.length === 1) {
  const fresh = created[0]
  check('fresh session inherits the preset', fresh.header.agentPreset === 'default')
  // A pre-turn surface user/message lands before turn 1's system/message and
  // makes the stored log unresumable, so the checkpoint must never be appended.
  check('checkpoint never touches the bare surface', fresh.appended.length === 0,
    JSON.stringify(fresh.appended.map(entry => entry.type)))
}
// The document IS the first prompt when the task continues: one user message
// that both carries the handoff and opens turn 1, instead of a silent queued
// document followed by a second "continue" prompt.
check('the checkpoint is admitted as the first prompt', prompts.length === 1 && prompts[0]?.mode === 'queue',
  JSON.stringify(prompts.map(prompt => prompt.sessionId)))
check('no inbox copy when the prompt carries the checkpoint', sent.length === 0,
  JSON.stringify(sent.map(entry => entry.sessionId)))
const promptText = prompts[0]?.content?.[0]?.text ?? ''
check('the prompt is plain text this plugin owns', prompts[0]?.content?.[0]?.type === 'text')
check('the checkpoint is wrapped as established context', promptText.includes('<auto-handoff-checkpoint>')
  && promptText.trimEnd().endsWith('</auto-handoff-checkpoint>'))
check('the checkpoint carries the summary', promptText.includes('【摘要】'))
check('the checkpoint carries the task state (todos + files + literal request)', promptText.includes('待办清单')
  && promptText.includes('- [~] 改实现') && promptText.includes('src/a.ts') && promptText.includes('把登录页做完'))
check('the checkpoint carries the background jobs', promptText.includes('job-1') && promptText.includes('pnpm build'),
  promptText.slice(-400))
check('the checkpoint ends with the configured continue instruction', promptText.includes('继续。按上面的交接内容'))

// A settled background job is relayed into the fresh session: the new session
// cannot read the old owner's job output, so the plugin pushes the result.
if (jobSubscription !== undefined) {
  jobSubscription.handler({ type: 'settled', job: { id: 'job-1', status: 'completed', detail: 'exit 0' } })
}
check('a settled job result is forwarded into the fresh session', followedUp.length === 1
  && followedUp[0]?.sessionId === created[0]?.id
  && JSON.stringify(followedUp[0]?.message?.content ?? []).includes('job-1'), JSON.stringify(followedUp))

// ------------------------------------ a busy source must never be handed off
// Queued inbox input would open a turn in the OLD session right after the
// handoff: that work would run where the user is not looking, and the new
// session would never see its result.
const queued = makeSession('session-queued', { todos: [{ content: '继续改', status: 'in_progress' }] })
sessions.store.set(queued.id, queued)
agentFor(queued.id).inbox.nextTurn.push({ id: 'queued-1', role: 'user', content: [{ type: 'text', text: '排队中的消息' }] })
const createdBeforeQueued = created.length
const streamedBeforeQueued = streamed.length
await emitTurnEnd(queued)
check('a source with queued input is not handed off', created.length === createdBeforeQueued, `got ${created.length}`)
check('a source with queued input is not even summarized', streamed.length === streamedBeforeQueued, `got ${streamed.length}`)

// A source that keeps working during the (multi-second) summary must abort: its
// checkpoint would describe a state the user no longer has, and its own turn
// would finish in the old session.
const moving = makeSession('session-moving', { todos: [{ content: '继续改', status: 'in_progress' }] })
sessions.store.set(moving.id, moving)
const createdBeforeMoving = created.length
const sentBeforeMoving = sent.length
const promptsBeforeMoving = prompts.length
duringSummarize = () => {
  // The user said something while the summary was being written: the log grows,
  // the surface gains a node and its generation bumps.
  const log = moving.snapshotEvents()
  log.push({ type: 'turn/start', data: { turn: 4 } })
  log.push({ type: 'user/message', data: { content: [{ type: 'text', text: '等等，再补一条' }] } })
  moving.surface.nodes.push(log.length - 1)
  moving.surface.contentGeneration += 1
}
await emitTurnEnd(moving)
check('a source that moved during summarization is not handed off', created.length === createdBeforeMoving, `got ${created.length}`)
check('a moved source delivers no checkpoint', sent.length === sentBeforeMoving, `got ${sent.length}`)
check('a moved source admits no prompt', prompts.length === promptsBeforeMoving, `got ${prompts.length}`)
const afterMoving = await hit('/api/dsh-auto-handoff/status')
check('the moved-source refusal is recorded', (afterMoving.payload?.decisions ?? [])
  .some(decision => decision.sessionId === 'session-moving' && decision.reason === 'source-moved'),
JSON.stringify(afterMoving.payload?.decisions))

// ------------------------------------------------------------------- routes
const status = await hit('/api/dsh-auto-handoff/status')
check('status route answers 200', status.status === 200)
check('status reports one handoff', status.payload?.handoffs?.length === 1, JSON.stringify(status.payload?.handoffs))
check('status reports the trigger as auto', status.payload?.handoffs?.[0]?.trigger === 'auto')
check('status exposes the fresh session id', status.payload?.handoffs?.[0]?.newSessionId === created[0]?.id)
check('status handoff record keeps the source session id', status.payload?.handoffs?.[0]?.sourceSessionId === 'session-source')
check('status reports how the document was delivered', status.payload?.handoffs?.[0]?.delivery === 'prompt'
  && status.payload?.handoffs?.[0]?.continued === true, JSON.stringify(status.payload?.handoffs?.[0]))
check('status reports the summary source', status.payload?.handoffs?.[0]?.summarySource === 'llm')
check('the handoff record carries the summarization usage',
  status.payload?.handoffs?.[0]?.usage?.inputTokens === 10,
  JSON.stringify(status.payload?.handoffs?.[0]?.usage))
check('status reports the occupancy checks that ran', (status.payload?.stats?.checks ?? 0) >= 1,
  JSON.stringify(status.payload?.stats))
check('status exposes the UI switch', status.payload?.ui?.enabled === true, JSON.stringify(status.payload?.ui))

// The status poll must not consume the navigation: a dropped frame or a reload
// would otherwise lose the switch.
const scopedStatus = await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
check('session status carries the navigation record', scopedStatus.payload?.navigation?.newSessionId === created[0]?.id,
  JSON.stringify(scopedStatus.payload?.navigation))
const scopedAgain = await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
check('status does not consume the navigation record', scopedAgain.payload?.navigation?.newSessionId === created[0]?.id)

const pendingFirst = await hit('/api/dsh-auto-handoff/pending', {
  url: `/api/dsh-auto-handoff/pending?sessionId=${session.id}`,
})
check('pending route returns the handoff', pendingFirst.payload?.pending?.newSessionId === created[0]?.id)
check('the pending record carries the summarization usage',
  pendingFirst.payload?.pending?.usage?.inputTokens === 10,
  JSON.stringify(pendingFirst.payload?.pending?.usage))
const pendingSecond = await hit('/api/dsh-auto-handoff/pending', {
  url: `/api/dsh-auto-handoff/pending?sessionId=${session.id}`,
})
check('pending route clears after the first read', pendingSecond.payload?.pending === null)

const forced = await hit('/api/dsh-auto-handoff/handoff', {
  method: 'POST',
  body: { sessionId: session.id },
})
check('manual route performs one handoff', forced.status === 200 && forced.payload?.ok === true, JSON.stringify(forced.payload))
check('manual route creates a second fresh session', created.length === 2, `got ${created.length}`)

const missing = await hit('/api/dsh-auto-handoff/handoff', { method: 'POST', body: {} })
check('manual route rejects a missing sessionId', missing.status === 400)
const wrongMethod = await hit('/api/dsh-auto-handoff/handoff', { method: 'GET' })
check('manual route rejects a GET', wrongMethod.status === 405)

// -------------------------- a source that moves while the child is created
// The fresh session may already exist at that point; the checkpoint still must
// not be delivered, and the user must not be navigated into a stale handoff.
const windowSession = makeSession('session-create-window', { todos: [{ content: '继续改', status: 'in_progress' }] })
sessions.store.set(windowSession.id, windowSession)
const createdBeforeWindow = created.length
const sentBeforeWindow = sent.length
const promptsBeforeWindow = prompts.length
const originalCreate = sessionController.create
sessionController.create = (request) => {
  const result = originalCreate(request)
  // The user typed again while the child session was being created: only the
  // surface fingerprint can tell, so this case proves the fingerprint is used.
  const log = windowSession.snapshotEvents()
  log.push({ type: 'user/message', data: { content: [{ type: 'text', text: '建会话期间又说了一句' }] } })
  windowSession.surface.nodes.push(log.length - 1)
  windowSession.surface.contentGeneration += 1
  return result
}
try {
  await emitTurnEnd(windowSession)
} finally {
  sessionController.create = originalCreate
}
check('a source that moved during child creation gets no checkpoint', sent.length === sentBeforeWindow
  && prompts.length === promptsBeforeWindow, `sent ${sent.length}, prompts ${prompts.length}`)
check('the abandoned child session is left empty', created.length === createdBeforeWindow + 1
  && created.at(-1)?.appended.length === 0, JSON.stringify(created.at(-1)?.appended))

// ------------------------------------------------------ threshold skip path
const small = makeSession('session-small', { turns: 1 })
sessions.store.set(small.id, small)
streamed.length = 0
const before = created.length
await emitTurnEnd(small)
check('below-min-rounds does not create a session', created.length === before)
check('below-min-rounds does not call the model', streamed.length === 0)

// ------------------------------------------------- auto-continue opt-out
// A finished checklist must hand off but stay quiet: no new model call on the
// user's behalf when there is nothing left to do.
const finished = makeSession('session-finished', { todos: [{ content: '全部完成', status: 'completed' }] })
sessions.store.set(finished.id, finished)
const createdBeforeFinished = created.length
const promptsBeforeFinished = prompts.length
await emitTurnEnd(finished)
check('a finished checklist still hands off', created.length === createdBeforeFinished + 1, `got ${created.length}`)
check('a finished checklist does not auto-continue', prompts.length === promptsBeforeFinished, `got ${prompts.length}`)
check('a quiet handoff still queues the checkpoint in the inbox', sent.length === 1
  && sent[0]?.target === 'next-turn' && sent[0]?.wakeup === false, JSON.stringify(sent))
const queuedText = JSON.stringify(sent[0]?.message?.content ?? [])
check('the queued checkpoint is a user message owned by this plugin', sent[0]?.message?.role === 'user'
  && sent[0]?.message?.source?.kind === 'dsh-auto-handoff', JSON.stringify(sent[0]?.message?.source))
check('the queued checkpoint carries the summary and the document frame',
  queuedText.includes('【摘要】') && queuedText.includes('<auto-handoff-checkpoint>'), queuedText.slice(0, 160))

// ------------------------------------------------- per-session widget status
const widgetStatus = await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
check('status describes the requested live session', widgetStatus.payload?.session?.id === 'session-source')
check('status carries turns, compactions and occupancy', widgetStatus.payload?.session?.turns === 3
  && typeof widgetStatus.payload?.session?.compactions === 'number'
  && Math.abs((widgetStatus.payload?.session?.occupancy?.ratio ?? 0) - 0.82) < 0.001,
JSON.stringify(widgetStatus.payload?.session))
check('prompt thresholds are evaluated for the widget', ['ok', 'warn', 'alert', 'info'].includes(widgetStatus.payload?.session?.prompts?.level)
  && Array.isArray(widgetStatus.payload?.session?.prompts?.hits), JSON.stringify(widgetStatus.payload?.session?.prompts))
check('prompt hits are ordered compactions > rounds > occupancy', (() => {
  const hits = widgetStatus.payload?.session?.prompts?.hits ?? []
  const rank = { compactions: 0, rounds: 1, percent: 2 }
  return hits.every((hit, index) => index === 0 || rank[hits[index - 1].kind] <= rank[hit.kind])
})())

// ---------------------------------------------------- queued manual handoff
const busySource = makeSession('session-busy', { todos: [{ content: '继续改', status: 'in_progress' }] })
busySource.snapshotEvents().push({ type: 'turn/start', data: { turn: 4 } })
sessions.store.set(busySource.id, busySource)
const createdBeforeBusy = created.length
const queuedWhileBusy = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: 'session-busy' } })
check('queue accepts a busy source without handing off', queuedWhileBusy.status === 202 && created.length === createdBeforeBusy,
  JSON.stringify(queuedWhileBusy.payload))
check('queue reports the refusal reason', queuedWhileBusy.payload?.queued === true && queuedWhileBusy.payload?.reason === 'source-open-turn',
  JSON.stringify(queuedWhileBusy.payload))
const busyStatus = await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-busy' })
check('status reports the queued handoff', busyStatus.payload?.session?.queued === true, JSON.stringify(busyStatus.payload?.queue))

// ------------------------------------------------------ widget configuration
const configSaved = await hit('/api/dsh-auto-handoff/ui-config', {
  method: 'POST',
  body: { promptRounds: 4, promptPercent: 0.5, promptCompactions: 1 },
})
check('ui-config persists the widget thresholds', configSaved.status === 200 && configSaved.payload?.config?.promptRounds === 4,
  JSON.stringify(configSaved.payload))
const configured = await hit('/api/dsh-auto-handoff/status')
check('status shows the widget thresholds', configured.payload?.prompts?.rounds === 4
  && configured.payload?.prompts?.percent === 0.5 && configured.payload?.prompts?.compactions === 1,
JSON.stringify(configured.payload?.prompts))

// --------------------------------------------------------- manual mode only
settingsState.autoHandoff = false
const manualSource = makeSession('session-manual', { todos: [{ content: '继续改', status: 'in_progress' }] })
sessions.store.set(manualSource.id, manualSource)
const createdBeforeManual = created.length
await emitTurnEnd(manualSource)
check('manual mode never hands off on its own', created.length === createdBeforeManual, `got ${created.length}`)
const queueRun = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: 'session-manual' } })
check('queue runs the manual handoff on a quiescent source', queueRun.status === 200 && created.length === createdBeforeManual + 1,
  JSON.stringify(queueRun.payload))

// ---------------------------------------- surface without replayable user text
// A fully compacted / tool-only surface still carries task state: the button
// must hand off the task block instead of failing with "no replayable messages".
const noReplay = makeSession('session-no-replay', {
  todos: [{ content: '继续改', status: 'in_progress' }],
  lastUser: '把登录页做完',
})
const noReplayLog = noReplay.snapshotEvents()
for (let index = noReplayLog.length - 1; index >= 0; index -= 1) {
  if (noReplayLog[index].type === 'user/message') noReplayLog.splice(index, 1)
}
noReplay.surface.nodes = noReplayLog
  .map((event, index) => (event.type.endsWith('message') ? index : -1))
  .filter(index => index >= 0)
sessions.store.set(noReplay.id, noReplay)
const streamedBeforeNoReplay = streamed.length
const createdBeforeNoReplay = created.length
const noReplayResult = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: noReplay.id } })
check('a session without replayable user messages still hands off', noReplayResult.status === 200
  && created.length === createdBeforeNoReplay + 1, JSON.stringify(noReplayResult.payload))
check('the fallback handoff skips the summarization call', streamed.length === streamedBeforeNoReplay, `got ${streamed.length}`)
const noReplayText = noReplayResult.payload?.delivery === 'prompt'
  ? prompts.at(-1)?.content?.[0]?.text ?? ''
  : JSON.stringify(sent.at(-1)?.message?.content ?? [])
check('the fallback checkpoint carries the task state', noReplayText.includes('待办清单') && noReplayText.includes('[~] 继续改'),
  noReplayText.slice(0, 160))

// ------------------------------------- image-bearing tool result keeps pairing
// Dropping an image message used to leave its tool call unanswered, which the
// provider rejects with "Messages tool calls need immediate results".
const imageReplay = makeSession('session-image-replay', {
  turns: 1,
  todos: [{ content: '继续改', status: 'in_progress' }],
})
const imageLog = imageReplay.snapshotEvents()
imageLog.push({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 2,
    message: {
      content: [
        { type: 'text', text: '截图看一下' },
        { type: 'tool-call', id: 'call_image_1', name: 'browser_screenshot', arguments: '{}' },
      ],
    },
  },
})
imageLog.push({
  type: 'tool/result',
  data: {
    turn: 1,
    step: 2,
    message: { toolCallId: 'call_image_1', content: [{ type: 'image', attachment: 'shot' }] },
  },
})
imageReplay.surface.nodes = imageLog
  .map((event, index) => ((event.type.endsWith('message') || event.type === 'tool/result') ? index : -1))
  .filter(index => index >= 0)
sessions.store.set(imageReplay.id, imageReplay)
const imageResult = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: imageReplay.id } })
check('a source with an image tool result still hands off', imageResult.status === 200, JSON.stringify(imageResult.payload))
const imageReplayMessages = streamed.at(-1)?.messages ?? []
check('the replay never carries image blocks',
  !imageReplayMessages.some(message => (message.content ?? []).some(block => block?.type === 'image')),
  JSON.stringify(imageReplayMessages).slice(0, 200))
const callIndex = imageReplayMessages.findIndex(message => (message.content ?? []).some(block => block?.type === 'tool-call'))
check('an image-bearing tool result stays immediately after its call',
  callIndex >= 0 && imageReplayMessages[callIndex + 1]?.role === 'tool'
  && imageReplayMessages[callIndex + 1]?.toolCallId === 'call_image_1',
  JSON.stringify(imageReplayMessages.slice(callIndex, callIndex + 2)).slice(0, 240))

// ------------------------------------------- truncated summary still hands off
// A summary that hits the output cap keeps its partial text and the handoff
// proceeds with a note instead of failing the button.
const truncatedSource = makeSession('session-truncated', {
  turns: 2,
  todos: [{ content: '继续改', status: 'in_progress' }],
})
sessions.store.set(truncatedSource.id, truncatedSource)
truncateSummarize = true
const createdBeforeTruncated = created.length
const truncatedResult = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: truncatedSource.id } })
check('a token-capped summary still hands off',
  truncatedResult.status === 200 && created.length === createdBeforeTruncated + 1,
  JSON.stringify(truncatedResult.payload))
const truncatedText = prompts.at(-1)?.content?.[0]?.text ?? JSON.stringify(sent.at(-1)?.message?.content ?? [])
check('the checkpoint marks the summary as truncated', truncatedText.includes('截断'), truncatedText.slice(0, 160))
const truncatedStatus = await hit('/api/dsh-auto-handoff/status')
check('the handoff record reports truncation',
  truncatedStatus.payload?.handoffs?.some(record => record.sourceSessionId === 'session-truncated' && record.truncated === true),
  JSON.stringify(truncatedStatus.payload?.handoffs?.at(-1)))

// ------------------------------------ a failing provider must not cost a handoff
// `summaryMode: auto` (the default) degrades to the deterministic digest: the
// button the user pressed still produces a usable document.
settingsState.summaryMode = 'auto'
const digestSource = makeSession('session-digest', {
  turns: 3,
  todos: [{ content: '继续改', status: 'in_progress' }],
  lastUser: '把导出功能补上',
})
sessions.store.set(digestSource.id, digestSource)
failSummarize = new Error('provider 502: upstream connect error')
const createdBeforeDigest = created.length
const digestResult = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: 'session-digest' } })
check('a failed summary degrades to a digest instead of failing', digestResult.status === 200
  && created.length === createdBeforeDigest + 1, JSON.stringify(digestResult.payload))
check('the degraded handoff reports its summary source', digestResult.payload?.summarySource === 'digest'
  && typeof digestResult.payload?.degraded === 'string', JSON.stringify(digestResult.payload?.summarySource))
check('the degraded handoff counts as degraded', (digestResult.payload?.summarySource === 'digest'))
const digestText = digestResult.payload?.delivery === 'prompt'
  ? prompts.at(-1)?.content?.[0]?.text ?? ''
  : JSON.stringify(sent.at(-1)?.message?.content ?? [])
check('the digest document says it was generated locally', digestText.includes('对话摘录（自动生成，非模型摘要）'),
  digestText.slice(0, 200))
check('the digest document quotes the last request', digestText.includes('把导出功能补上'))

// `summaryMode: llm` is strict on purpose: the route reports the provider
// failure instead of silently handing off a weaker document.
settingsState.summaryMode = 'llm'
const strictSource = makeSession('session-strict', { turns: 2 })
sessions.store.set(strictSource.id, strictSource)
failSummarize = new Error('provider 502: strict mode')
const createdBeforeStrict = created.length
const strictResult = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: 'session-strict' } })
check('a strict summary failure fails the handoff', strictResult.status === 502 && created.length === createdBeforeStrict,
  JSON.stringify(strictResult.payload))
check('the strict failure is reported', String(strictResult.payload?.error?.message ?? '').includes('502'))
settingsState.summaryMode = 'auto'
settingsState.autoHandoff = true

// ------------------------------------------------------------- goal guard
// An active goal keeps prompting the OLD session after every turn, so a handoff
// now would split the work across two conversations.
goalBySession.set('session-goal', { current: { goal: { phase: 'active' } } })
const goalSession = makeSession('session-goal', { turns: 4 })
sessions.store.set(goalSession.id, goalSession)
const createdBeforeGoal = created.length
await emitTurnEnd(goalSession)
check('an active goal is never handed off automatically', created.length === createdBeforeGoal, `got ${created.length}`)
const goalStatus = await hit('/api/dsh-auto-handoff/status')
check('the goal skip is recorded', (goalStatus.payload?.decisions ?? [])
  .some(decision => decision.sessionId === 'session-goal' && decision.reason === 'goal-active'),
JSON.stringify(goalStatus.payload?.decisions?.filter(decision => decision.sessionId === 'session-goal')))
const goalQueued = await hit('/api/dsh-auto-handoff/queue', { method: 'POST', body: { sessionId: 'session-goal' } })
check('a manual handoff refuses an active goal', goalQueued.status === 409
  && goalQueued.payload?.error?.reason === 'goal-active', JSON.stringify(goalQueued.payload))
check('the goal refusal is not queued for retry', goalQueued.payload?.queued !== true)
const goalForced = await hit('/api/dsh-auto-handoff/handoff', {
  method: 'POST',
  body: { sessionId: 'session-goal', force: true },
})
check('force overrides the goal guard', goalForced.status === 200 && goalForced.payload?.ok === true,
  JSON.stringify(goalForced.payload))
goalBySession.delete('session-goal')

// ------------------------------------------------------- polling is cheap
// The widget polls every two seconds; the expensive measurements must be memoized.
const measureBefore = measureCalls.filter(id => id === 'session-source').length
await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
const measureDelta = measureCalls.filter(id => id === 'session-source').length - measureBefore
check('occupancy measurement is reused across polls', measureDelta <= 1, `measured ${measureDelta} more time(s)`)
check('the context window lookup is memoized per route', resolveModelCalls === 1, `resolved ${resolveModelCalls} time(s)`)

// Counters advance over the delta instead of re-folding the whole log: a new
// turn shows up without the plugin being restarted.
{
  const log = session.snapshotEvents()
  log.push({ type: 'turn/start', data: { turn: 99 } })
  log.push({ type: 'user/message', data: { content: [{ type: 'text', text: '又聊了一轮' }] } })
  log.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: '好' }] } })
  log.push({ type: 'turn/end', data: { turn: 99 } })
  session.surface.nodes.push(log.length - 3, log.length - 2)
  const advanced = await hit('/api/dsh-auto-handoff/status', { url: '/api/dsh-auto-handoff/status?sessionId=session-source' })
  check('counters fold only the new events', advanced.payload?.session?.turns === 4,
    JSON.stringify(advanced.payload?.session?.turns))
}

// ------------------------------------------------------------- teardown
owner.dispose()
await new Promise(resolvePromise => { setTimeout(resolvePromise, 50) })
check('status route removed on teardown', !routes.some(route => route.path === '/api/dsh-auto-handoff/status'))
check('all routes removed on teardown', routes.length === 0, `still ${routes.length}`)
// A strict summary failure is the ONE case that must reach the log (it is a real
// provider failure the user asked to see); every other path stays quiet.
check('only the strict failure was logged as a warning',
  warns.length === 1 && warns[0].includes('session-strict'), warns.join(' | '))

console.log('')
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s)`)
  process.exit(1)
}
console.log('PASS: all checks green')
