/**
 * Session counters, folded incrementally.
 *
 * The widget polls `/status` every two seconds for as long as the page is
 * open, so re-scanning the whole event log per poll is a real cost on a long
 * conversation (the log keeps every event: turns, steps, tool traffic). This
 * module folds the log once and then only consumes the events that appeared
 * since the previous read, which makes a poll O(new events) instead of O(log).
 *
 * It also answers the two readiness questions the handoff gate needs — "is a
 * turn open?" and "is compaction running?" — from the same fold.
 *
 * @module dsh-auto-handoff/metrics
 */

/** Prompt levels, most severe first. */
export const PROMPT_LEVELS = ['alert', 'warn', 'info', 'ok']

/** A fold with nothing seen yet. */
export function emptyMetrics() {
  return { turns: 0, compactions: 0, openTurn: false, compacting: false, counted: 0 }
}

/**
 * Fold one event into the counters.
 *
 * A `compaction/start` without a matching end is treated as stale as soon as
 * the next turn boundary shows up: DSH brackets compaction inside a turn, so a
 * surviving bracket across `turn/start`/`turn/end` can only mean the process
 * that opened it is gone. Without that rule a crashed compaction would block
 * every future handoff of the session forever.
 *
 * @param {{turns:number, compactions:number, openTurn:boolean, compacting:boolean, counted:number}} state - current counters.
 * @param {{type?: string}} event - session event.
 * @returns {object} the same shape, advanced by one event.
 */
export function foldEvent(state, event) {
  const type = event?.type
  if (type === 'turn/start') {
    return { ...state, openTurn: true, compacting: false }
  }
  if (type === 'turn/end') {
    return { ...state, openTurn: false, compacting: false, turns: state.turns + 1 }
  }
  if (type === 'compaction/start') {
    return { ...state, compacting: true, compactions: state.compactions + 1 }
  }
  if (type === 'compaction/end' || type === 'compaction/aborted') {
    return { ...state, compacting: false }
  }
  return state
}

/**
 * Fold a complete log from scratch.
 *
 * @param {readonly object[] | undefined} events - full event log.
 * @returns {object} counters describing the whole log.
 */
export function foldMetrics(events) {
  let state = emptyMetrics()
  if (!Array.isArray(events)) return state
  for (const event of events) state = foldEvent(state, event)
  return { ...state, counted: events.length }
}

/**
 * Advance counters over the events appended since the previous fold.
 *
 * A snapshot shorter than what was already folded means the log was replaced
 * (a restored or forked session object), so the fold restarts from zero
 * instead of silently drifting.
 *
 * @param {object} state - counters from a previous read.
 * @param {readonly object[] | undefined} events - current full snapshot.
 * @returns {object} counters describing the whole current log.
 */
export function advanceMetrics(state, events) {
  if (!Array.isArray(events)) return { ...state, counted: 0 }
  if (!Number.isSafeInteger(state?.counted) || events.length < state.counted) {
    return foldMetrics(events)
  }
  let next = state
  for (let index = state.counted; index < events.length; index += 1) {
    next = foldEvent(next, events[index])
  }
  return next.counted === events.length ? next : { ...next, counted: events.length }
}

/**
 * Evaluate the user's prompt thresholds against one session.
 *
 * Purely advisory: the plugin never switches sessions on its own, it only
 * tells the user that the conversation is getting expensive. Hits are ordered
 * by how strongly they argue for a handoff (compactions, then rounds, then
 * occupancy) so the widget can name the most compelling one.
 *
 * @param {{turns:number, compactions:number}} metrics - folded counters.
 * @param {{ratio?: number}} occupancy - occupancy ratio in [0,1], if known.
 * @param {{promptRounds:number, promptPercent:number, promptCompactions:number}} config - thresholds.
 * @returns {{level: string, hits: object[]}} ordered hits and the worst level.
 */
export function evaluatePrompts(metrics, occupancy, config) {
  const hits = []
  if (config.promptCompactions > 0 && metrics.compactions >= config.promptCompactions) {
    hits.push({ kind: 'compactions', value: metrics.compactions, threshold: config.promptCompactions })
  }
  if (config.promptRounds > 0 && metrics.turns >= config.promptRounds) {
    hits.push({ kind: 'rounds', value: metrics.turns, threshold: config.promptRounds })
  }
  const ratio = occupancy?.ratio
  if (config.promptPercent > 0 && typeof ratio === 'number' && ratio >= config.promptPercent) {
    hits.push({ kind: 'percent', value: ratio, threshold: config.promptPercent })
  }
  if (hits.length === 0) return { level: 'ok', hits }
  const urgent = hits.some(hit => hit.kind !== 'percent' || hits.length > 1)
  const level = hits.some(hit => hit.kind === 'compactions')
    ? 'alert'
    : urgent
      ? 'warn'
      : 'info'
  return { level, hits }
}

/**
 * Bounded, LRU-ish store of per-session counters.
 *
 * Status polling touches a handful of sessions; keeping the last
 * {@link MetricsBook#capacity} folds is plenty and bounds memory even after
 * months of browsing.
 */
export class MetricsBook {
  #byId = new Map()
  #capacity

  /**
   * @param {number} [capacity] - maximum retained sessions (default 64).
   */
  constructor(capacity = 64) {
    this.#capacity = capacity
  }

  /**
   * Read (and advance) the counters for one session.
   *
   * @param {string} id - session id.
   * @param {readonly object[] | undefined} events - current full snapshot.
   * @returns {object} counters describing the whole current log.
   */
  read(id, events) {
    const previous = this.#byId.get(id)
    const next = previous === undefined ? foldMetrics(events) : advanceMetrics(previous, events)
    // Re-insert so the Map's iteration order doubles as recency order.
    this.#byId.delete(id)
    this.#byId.set(id, next)
    if (this.#byId.size > this.#capacity) {
      const oldest = this.#byId.keys().next().value
      this.#byId.delete(oldest)
    }
    return next
  }

  /**
   * Drop one session's counters (called when its log was replaced).
   *
   * @param {string} id - session id.
   * @returns {void}
   */
  forget(id) {
    this.#byId.delete(id)
  }
}
