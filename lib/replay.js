/**
 * Replay construction: turn a live session's surface back into chat messages.
 *
 * Two things consume this module. The LLM summary replays the conversation
 * prefix so the provider's warm prefix cache is reused (the same discipline as
 * `dsh-compaction-basic`), and the deterministic digest walks the same messages
 * when no summary is wanted or the model call failed.
 *
 * Everything here is pure: it only calls methods the caller passes in through
 * the session object, so the unit tests can drive it with plain stubs.
 *
 * @module dsh-auto-handoff/replay
 */

/** Extra text block cap applied when even the newest anchor blows the budget. */
const PATHOLOGICAL_BLOCK_CHARS = 3000

/**
 * Read a live session's event log through the public Session API.
 *
 * `session.events` does NOT exist on a real Session — it exposes the method
 * `snapshotEvents()` instead. Reading a missing property yields `undefined`,
 * which used to blow up the readiness checks on every live session: the
 * automatic path swallowed the throw and the manual route answered a bare 400.
 * @param session - live session to read.
 * @returns its frozen event snapshot, or an empty log for a stub.
 */
export function eventsOf(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session?.events)) return session.events
  return []
}

/**
 * Index an event log so a surface node (a sequence number) resolves to its event.
 *
 * Real logs carry `seq`; stubs usually do not, and there the array index IS the
 * sequence number because the log starts at 0 and only ever appends.
 * @param {readonly object[]} events - event log.
 * @returns {Map<number, object>} seq (or index) to event.
 */
function indexEvents(events) {
  const bySeq = new Map()
  events.forEach((event, index) => {
    const seq = Number.isSafeInteger(event?.seq) ? event.seq : index
    bySeq.set(seq, event)
  })
  return bySeq
}

/**
 * Concatenate a message's text parts.
 * @param message - derived message.
 * @returns its visible text.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Crude character budget of one derived message (text parts only). */
export function messageCharLength(message) {
  const content = message?.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') total += block.text.length
  }
  return total
}

/**
 * Replace attachment blocks with a text placeholder instead of dropping the message.
 *
 * Skipping a message that carries an image used to leave its assistant
 * `tool-call` without an immediate result, which the provider rejects with
 * "Messages tool calls need immediate results". Tool results often carry
 * screenshots, so the safe move is to keep the message and stub out the binary.
 * @param content - message content blocks (or a plain string).
 * @returns content with every image/file block replaced by text.
 */
export function sanitizeReplayContent(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type === 'image') return { type: 'text', text: '[image omitted from the handoff replay]' }
    if (block.type === 'file') return { type: 'text', text: '[file attachment omitted from the handoff replay]' }
    return block
  })
}

/**
 * Keep every tool call answered immediately, and drop orphan tool results.
 *
 * A provider requires an assistant message's `tool-call` blocks to be followed
 * immediately by their tool results. Pruned or compacted surfaces can break that
 * pairing, so this last pass strips unanswered calls (and results without their
 * call) instead of letting the whole handoff fail.
 * @param messages - replay messages in surface order.
 * @returns messages whose tool calls and results pair one-to-one, in order.
 */
export function sanitizeToolPairing(messages) {
  const out = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const calls = content.filter(block => block?.type === 'tool-call')
      if (calls.length === 0) {
        out.push(message)
        continue
      }
      const ids = new Set(calls.map(call => call.id))
      const answers = []
      let next = index + 1
      while (next < messages.length && messages[next]?.role === 'tool' && ids.has(messages[next].toolCallId)) {
        answers.push(messages[next])
        next += 1
      }
      const answered = new Set(answers.map(answer => answer.toolCallId))
      const kept = content.filter(block => block?.type !== 'tool-call' || answered.has(block.id))
      if (kept.length === 0) kept.push({ type: 'text', text: '[tool calls omitted from the handoff replay]' })
      out.push({ ...message, content: kept }, ...answers)
      index = next - 1
      continue
    }
    // A tool result whose call is not right before it would be rejected.
    if (message?.role === 'tool') continue
    out.push(message)
  }
  return out
}

/**
 * Shorten oversized text blocks without removing any message.
 *
 * A replay can be far over the character budget when even the latest user
 * anchor carries huge tool output. Cutting whole messages would break tool
 * pairing, so only the text inside each block is capped — the model still sees
 * every message and the structure stays valid.
 * @param messages - replay messages in surface order.
 * @param maxBlockChars - per text block cap.
 * @returns messages whose text blocks fit the cap.
 */
export function trimReplayText(messages, maxBlockChars) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block === null || typeof block !== 'object' || typeof block.text !== 'string') return block
        if (block.text.length <= maxBlockChars) return block
        return {
          ...block,
          text: `${block.text.slice(0, maxBlockChars)}\n…[truncated ${block.text.length - maxBlockChars} chars]`,
        }
      }),
    }
  })
}

/**
 * Derive the surface's messages, in order, with attachments already stubbed out.
 * @param session - live source session.
 * @param {readonly object[]} [events] - its event log (read when omitted).
 * @returns derived messages, never null entries.
 */
export function deriveMessages(session, events = eventsOf(session)) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return []
  const bySeq = indexEvents(events)
  const derived = []
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    let message
    try {
      message = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : null
    } catch {
      // A projection that refuses to interpret one event must not sink the
      // whole handoff: the remaining messages still describe the conversation.
      message = null
    }
    if (message === null || message === undefined) continue
    derived.push({ ...message, content: sanitizeReplayContent(message.content) })
  }
  return derived
}

/**
 * Build the summarization input from a session's surface.
 *
 * The replay must START on a user message: a provider rejects a tool result
 * whose call is missing, and a character budget that stops inside a tool batch
 * used to strip every retained message, leaving "no replayable messages". So
 * pick the EARLIEST user message whose whole tail still fits the budget (more
 * context), fall back to the latest user message when nothing fits, and return
 * an empty message list when the surface carries no user message at all — the
 * caller then hands off the task block without a model call.
 * @param session - live source session.
 * @param header - its folded request header (provider route, system, tools).
 * @param {{maxInputChars: number}} config - character budget of the replay.
 * @returns `{ system, tools, messages }` ready for the summarization call.
 */
export function buildReplay(session, header, config) {
  const derived = deriveMessages(session)
  const base = {
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
  }
  if (derived.length === 0) return { ...base, messages: [] }
  // Suffix character counts: an earlier anchor is chosen without re-summing.
  const suffix = new Array(derived.length + 1).fill(0)
  for (let index = derived.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1] + messageCharLength(derived[index])
  }
  const users = []
  derived.forEach((message, index) => { if (message?.role === 'user') users.push(index) })
  if (users.length === 0) return { ...base, messages: [] }
  let start = users[users.length - 1]
  for (const candidate of users) {
    if (suffix[candidate] <= config.maxInputChars) {
      start = candidate
      break
    }
  }
  const messages = sanitizeToolPairing(derived.slice(start))
  // Pathological replay (even the newest user anchor carries huge tool output):
  // shorten text blocks instead of sending everything and hitting the output cap.
  const total = messages.reduce((chars, message) => chars + messageCharLength(message), 0)
  return {
    ...base,
    messages: total > config.maxInputChars * 2 ? trimReplayText(messages, PATHOLOGICAL_BLOCK_CHARS) : messages,
  }
}

export { PATHOLOGICAL_BLOCK_CHARS }
