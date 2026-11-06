/**
 * Unit checks for the incremental session counters (lib/metrics.js).
 *
 * These are the numbers the widget shows every two seconds, so the fold has to
 * agree with a full re-scan after every possible event order — including the
 * stale-compaction case that used to block handoffs forever.
 *
 *   node test/metrics.test.mjs
 */
import assert from 'node:assert/strict'
import {
  MetricsBook,
  advanceMetrics,
  emptyMetrics,
  evaluatePrompts,
  foldMetrics,
} from '../lib/metrics.js'

let passed = 0
function check(label, run) {
  run()
  passed += 1
  console.log(`  ok   ${label}`)
}

const turn = (n) => [{ type: 'turn/start', data: { turn: n } }, { type: 'turn/end', data: { turn: n } }]
const log = [
  ...turn(1),
  { type: 'compaction/start', data: {} },
  { type: 'compaction/end', data: {} },
  ...turn(2),
  { type: 'tool/call', data: { name: 'ops_bash' } },
  ...turn(3),
  { type: 'turn/start', data: { turn: 4 } },
]

console.log('=== dsh-auto-handoff session metrics ===')

check('foldMetrics counts turns and compactions over a whole log', () => {
  const metrics = foldMetrics(log)
  assert.equal(metrics.turns, 3)
  assert.equal(metrics.compactions, 1)
  assert.equal(metrics.openTurn, true)
  assert.equal(metrics.compacting, false)
  assert.equal(metrics.counted, log.length)
})

check('foldMetrics tolerates an empty or missing log', () => {
  assert.deepEqual(foldMetrics([]), emptyMetrics())
  assert.deepEqual(foldMetrics(undefined), emptyMetrics())
})

check('advanceMetrics equals a full fold at every prefix of the log', () => {
  let state = emptyMetrics()
  for (let index = 0; index <= log.length; index += 1) {
    state = advanceMetrics(state, log.slice(0, index))
    const fresh = foldMetrics(log.slice(0, index))
    assert.deepEqual(state, fresh, `prefix ${index}`)
  }
})

check('advanceMetrics only folds the delta (previous counts survive)', () => {
  const first = advanceMetrics(emptyMetrics(), log.slice(0, 4))
  assert.equal(first.turns, 1)
  const second = advanceMetrics(first, log)
  assert.equal(second.turns, 3)
  assert.equal(second.counted, log.length)
})

check('advanceMetrics rebuilds when the log was replaced by a shorter one', () => {
  const grown = advanceMetrics(emptyMetrics(), log)
  const replaced = advanceMetrics(grown, turn(1))
  assert.equal(replaced.turns, 1)
  assert.equal(replaced.openTurn, false)
})

check('a stale compaction bracket is cleared by the next turn boundary', () => {
  // The process that opened this compaction died before closing it: without the
  // rule, `compacting` would stay true and every handoff would be refused.
  const crashed = foldMetrics([...turn(1), { type: 'compaction/start', data: {} }])
  assert.equal(crashed.compacting, true)
  const resumed = advanceMetrics(crashed, [...turn(1), { type: 'compaction/start', data: {} }, ...turn(2)])
  assert.equal(resumed.compacting, false)
  assert.equal(resumed.turns, 2)
})

check('compaction/aborted also clears the bracket', () => {
  const metrics = foldMetrics([
    { type: 'compaction/start', data: {} },
    { type: 'compaction/aborted', data: {} },
  ])
  assert.equal(metrics.compacting, false)
  assert.equal(metrics.compactions, 1)
})

check('evaluatePrompts reports nothing below every threshold', () => {
  const result = evaluatePrompts({ turns: 2, compactions: 0 }, { ratio: 0.1 }, {
    promptRounds: 10, promptPercent: 0.6, promptCompactions: 2,
  })
  assert.equal(result.level, 'ok')
  assert.deepEqual(result.hits, [])
})

check('evaluatePrompts ranks compactions above rounds and occupancy', () => {
  const result = evaluatePrompts({ turns: 12, compactions: 3 }, { ratio: 0.9 }, {
    promptRounds: 10, promptPercent: 0.6, promptCompactions: 2,
  })
  assert.equal(result.level, 'alert')
  assert.deepEqual(result.hits.map(hit => hit.kind), ['compactions', 'rounds', 'percent'])
})

check('evaluatePrompts ignores occupancy when it is unknown', () => {
  const result = evaluatePrompts({ turns: 0, compactions: 0 }, { known: false, reason: 'no-provider-usage-yet' }, {
    promptRounds: 10, promptPercent: 0.01, promptCompactions: 2,
  })
  assert.equal(result.level, 'ok')
})

check('evaluatePrompts treats a disabled threshold (0) as off', () => {
  const result = evaluatePrompts({ turns: 99, compactions: 9 }, { ratio: 1 }, {
    promptRounds: 0, promptPercent: 0, promptCompactions: 0,
  })
  assert.equal(result.level, 'ok')
})

check('MetricsBook keeps per-session counters apart and bounded', () => {
  const book = new MetricsBook(2)
  assert.equal(book.read('a', turn(1)).turns, 1)
  assert.equal(book.read('b', turn(1)).turns, 1)
  const advanced = book.read('a', [...turn(1), ...turn(2)])
  assert.equal(advanced.turns, 2, 'reading a again must advance, not restart')
  book.read('c', turn(1))
  assert.equal(book.read('a', [...turn(1), ...turn(2)]).turns, 2, 'a kept its fold')
  assert.equal(book.read('b', turn(1)).turns, 1, 'b was evicted and folds from scratch')
})

console.log(`\nPASS: ${passed} checks green`)
