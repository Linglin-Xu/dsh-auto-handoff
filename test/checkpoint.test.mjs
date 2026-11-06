/**
 * Unit checks for replay construction and checkpoint assembly
 * (lib/replay.js + lib/checkpoint.js).
 *
 * The replay rules are the ones that used to break a handoff in production:
 * an image message dropped the tool pairing, and a character budget that cut
 * inside a tool batch left "no replayable messages". The digest is the
 * deterministic fallback, so it must quote the newest material first.
 *
 *   node test/checkpoint.test.mjs
 */
import assert from 'node:assert/strict'
import { buildCheckpointBlocks, buildDigest, blocksText } from '../lib/checkpoint.js'
import { CHECKPOINT_OPEN_TAG, looksLikeCheckpoint } from '../lib/format.js'
import {
  buildReplay,
  deriveMessages,
  eventsOf,
  sanitizeToolPairing,
  trimReplayText,
} from '../lib/replay.js'

let passed = 0
function check(label, run) {
  run()
  passed += 1
  console.log(`  ok   ${label}`)
}

/** A session stub whose surface nodes are the event indexes. */
function makeSession(events) {
  return {
    id: 'session-source',
    events,
    surface: { nodes: events.map((_, index) => index), replaceGeneration: 0, contentGeneration: 0 },
    snapshotEvents: () => events,
    deriveEventMessage: (event) => {
      if (event.message === undefined) return null
      return { role: event.role ?? 'user', ...event.message }
    },
  }
}

const user = (text) => ({ type: 'user/message', role: 'user', message: { content: [{ type: 'text', text }] } })
const assistant = (text) => ({ type: 'assistant/message', role: 'assistant', message: { content: [{ type: 'text', text }] } })

console.log('=== dsh-auto-handoff replay + checkpoint ===')

check('eventsOf prefers snapshotEvents and tolerates a stub without one', () => {
  const events = [user('hi')]
  assert.deepEqual(eventsOf({ snapshotEvents: () => events }), events)
  assert.deepEqual(eventsOf({ events }), events)
  assert.deepEqual(eventsOf({}), [])
})

check('deriveMessages stubs images out instead of dropping the message', () => {
  const events = [{
    type: 'tool/result',
    role: 'tool',
    message: { toolCallId: 'call-1', content: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }] },
  }]
  const messages = deriveMessages(makeSession(events))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].type, 'text')
  assert.ok(messages[0].content[0].text.includes('image omitted'))
})

check('sanitizeToolPairing drops an unanswered call and keeps a valid pair', () => {
  const unpaired = sanitizeToolPairing([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'x', arguments: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ])
  assert.equal(unpaired[0].content[0].type, 'text')

  const paired = sanitizeToolPairing([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'x', arguments: {} }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] },
  ])
  assert.equal(paired.length, 2)
  assert.equal(paired[0].content[0].type, 'tool-call')
})

check('sanitizeToolPairing drops an orphan tool result', () => {
  assert.deepEqual(sanitizeToolPairing([{ role: 'tool', toolCallId: 'ghost', content: [] }]), [])
})

check('trimReplayText caps only oversized blocks', () => {
  const trimmed = trimReplayText([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(50) }] }], 10)
  assert.equal(trimmed[0].content[0].text.length, 10 + '\n…[truncated 40 chars]'.length)
})

check('buildReplay anchors on the earliest user message that fits', () => {
  const events = [user('one'), assistant('a1'), user('two'), assistant('a2')]
  const replay = buildReplay(makeSession(events), { system: 'sys', tools: [] }, { maxInputChars: 1000 })
  assert.equal(replay.messages.length, 4, 'everything fits, so the first user message anchors')
  assert.equal(replay.system, 'sys')
  const tight = buildReplay(makeSession(events), {}, { maxInputChars: 8 })
  assert.equal(tight.messages[0].role, 'user')
  assert.ok(tight.messages[0].content[0].text.includes('two'), 'the newest user message anchors when nothing fits')
})

check('buildReplay returns no messages when a surface has no user message', () => {
  const replay = buildReplay(makeSession([assistant('only a reply')]), {}, { maxInputChars: 1000 })
  assert.deepEqual(replay.messages, [])
})

check('buildDigest quotes the newest messages and marks what was omitted', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '最早的请求' }] },
    { role: 'assistant', content: [{ type: 'text', text: '较早的回答' }] },
    { role: 'user', content: [{ type: 'text', text: '最新的请求' }] },
  ]
  const tight = buildDigest(messages, { budget: 12 })
  assert.ok(tight.includes('最新的请求'))
  assert.ok(!tight.includes('较早的回答'), 'the newest material wins the budget')
  assert.ok(tight.includes('更早的 2 条消息已省略'))
  const full = buildDigest(messages, { budget: 1000 })
  assert.ok(full.includes('最早的请求'))
  assert.ok(full.indexOf('较早的回答') < full.indexOf('最新的请求'), 'chronological order')
})

check('buildDigest caps a previous checkpoint instead of quoting it whole', () => {
  const digest = buildDigest([
    { role: 'user', content: [{ type: 'text', text: `${CHECKPOINT_OPEN_TAG}\n${'x'.repeat(4000)}` }] },
  ], { budget: 10000 })
  assert.ok(digest.includes('上一份交接文档'))
  assert.ok(digest.length < 1700)
})

check('buildDigest returns an empty string for a surface without text', () => {
  assert.equal(buildDigest([]), '')
  assert.equal(buildDigest([{ role: 'assistant', content: [] }]), '')
})

check('buildCheckpointBlocks frames the document and appends the continue line', () => {
  const blocks = buildCheckpointBlocks({
    summaryBlocks: [{ type: 'text', text: '## 目标\n做点事' }],
    taskBlock: '## 待办清单\n- [ ] 跑测试',
    backgroundBlock: '后台任务：1 个',
    note: '摘要被截断',
    continueText: '继续。',
  })
  const text = blocksText(blocks)
  assert.ok(text.startsWith('以下是一条自动生成的上文交接摘要'))
  assert.ok(text.includes(CHECKPOINT_OPEN_TAG))
  assert.ok(text.trimEnd().endsWith('</auto-handoff-checkpoint>'))
  assert.ok(text.includes('## 目标'))
  assert.ok(text.includes('待办清单'))
  assert.ok(text.includes('后台任务'))
  assert.ok(text.includes('摘要被截断'))
  assert.ok(text.trimEnd().includes('继续。'))
  assert.equal(looksLikeCheckpoint(text), true)
})

check('buildCheckpointBlocks falls back to the digest and skips an empty continue line', () => {
  const blocks = buildCheckpointBlocks({ digest: '- 用户：你好', taskBlock: '', continueText: '   ' })
  const text = blocksText(blocks)
  assert.ok(text.includes('对话摘录（自动生成，非模型摘要）'))
  assert.ok(text.includes('- 用户：你好'))
  assert.ok(!text.includes('按上面的交接内容接着做'))
})

console.log(`\nPASS: ${passed} checks green`)
