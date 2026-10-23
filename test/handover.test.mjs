/**
 * Unit checks for the pure task-carry-over folds (lib/handover.js).
 *
 * These run with plain Node — no @deepseek-ai/* resolution needed, unlike the
 * host-half suite in host-check.mjs:
 *   node test/handover.test.mjs
 */
import assert from 'node:assert/strict'
import {
  buildTaskBlock,
  foldLastUserText,
  foldTodos,
  foldTouchedFiles,
  hasUnfinishedWork,
} from '../lib/handover.js'

let passed = 0
function check(label, run) {
  run()
  passed += 1
  console.log(`  ok   ${label}`)
}

const todoEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'todo/write', data: { todos: [{ content: '读代码', status: 'completed' }] } },
  { type: 'turn/end', data: { turn: 1 } },
  { type: 'turn/start', data: { turn: 2 } },
  {
    type: 'todo/write',
    data: {
      todos: [
        { content: '读代码', status: 'completed' },
        { content: '改实现', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ],
    },
  },
  { type: 'turn/end', data: { turn: 2 } },
]

console.log('=== dsh-auto-handoff task carry-over ===')

check('foldTodos keeps the last list of the finished turn', () => {
  const todos = foldTodos(todoEvents)
  assert.equal(todos.length, 3)
  assert.equal(todos[1].status, 'in_progress')
})

check('foldTodos is cleared by a following turn/start (projection parity)', () => {
  const todos = foldTodos([...todoEvents, { type: 'turn/start', data: { turn: 3 } }])
  assert.equal(todos, null)
})

check('foldTodos tolerates an empty or missing log', () => {
  assert.equal(foldTodos([]), null)
  assert.equal(foldTodos(undefined), null)
})

check('hasUnfinishedWork sees pending and in_progress only', () => {
  assert.equal(hasUnfinishedWork([{ content: 'a', status: 'completed' }]), false)
  assert.equal(hasUnfinishedWork([{ content: 'a', status: 'pending' }]), true)
  assert.equal(hasUnfinishedWork([{ content: 'a', status: 'in_progress' }]), true)
  assert.equal(hasUnfinishedWork(null), false)
})

check('foldTouchedFiles parses JSON-string tool arguments', () => {
  const files = foldTouchedFiles([
    { type: 'tool/call', data: { name: 'ops_edit_file', arguments: '{"path":"src/a.ts"}' } },
    { type: 'tool/call', data: { name: 'edit', arguments: { file_path: 'src/b.ts' } } },
    { type: 'tool/call', data: { name: 'ops_bash', arguments: '{"command":"ls"}' } },
  ])
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts'])
})

check('foldTouchedFiles de-duplicates and keeps the newest paths', () => {
  const events = [
    { type: 'tool/call', data: { name: 'write', arguments: { path: 'first.ts' } } },
    { type: 'tool/call', data: { name: 'write', arguments: { path: 'first.ts' } } },
    { type: 'tool/call', data: { name: 'write', arguments: { path: 'second.ts' } } },
  ]
  assert.deepEqual(foldTouchedFiles(events), ['first.ts', 'second.ts'])
  assert.deepEqual(foldTouchedFiles(events, 1), ['second.ts'])
})

check('foldTouchedFiles ignores malformed arguments', () => {
  assert.deepEqual(foldTouchedFiles([
    { type: 'tool/call', data: { name: 'edit', arguments: 'not json' } },
    { type: 'tool/call', data: { name: 'edit', arguments: null } },
    { type: 'tool/call', data: {} },
  ]), [])
})

check('foldLastUserText skips messages this plugin injected', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '把登录页做完' }] } },
    {
      type: 'user/message',
      data: { source: { kind: 'dsh-auto-handoff' }, content: [{ type: 'text', text: '<auto-handoff-checkpoint>' }] },
    },
  ]
  assert.equal(foldLastUserText(events), '把登录页做完')
})

check('foldLastUserText truncates an oversized request', () => {
  const long = 'x'.repeat(2000)
  const text = foldLastUserText([{ type: 'user/message', data: { content: [{ type: 'text', text: long }] } }])
  assert.equal(text.length, 601)
  assert.ok(text.endsWith('…'))
})

check('buildTaskBlock carries todos, files and the literal request', () => {
  const block = buildTaskBlock({
    todos: foldTodos(todoEvents),
    files: ['src/a.ts'],
    lastUser: '把登录页做完',
  })
  assert.ok(block.includes('待办清单'))
  assert.ok(block.includes('- [x] 读代码'))
  assert.ok(block.includes('- [~] 改实现'))
  assert.ok(block.includes('- [ ] 跑测试'))
  assert.ok(block.includes('- src/a.ts'))
  assert.ok(block.includes('把登录页做完'))
  assert.ok(block.includes('todo_write'))
  assert.ok(block.includes('pending / in_progress'))
})

check('buildTaskBlock stays empty when there is nothing to carry', () => {
  assert.equal(buildTaskBlock({ todos: null, files: [], lastUser: null }), '')
  assert.equal(buildTaskBlock({}), '')
})

check('buildTaskBlock switches the closing hint when everything is done', () => {
  const block = buildTaskBlock({ todos: [{ content: 'done', status: 'completed' }], files: [], lastUser: '' })
  assert.ok(block.includes('已全部完成'))
  assert.ok(!block.includes('pending / in_progress'))
})

console.log(`\nPASS: ${passed} checks green`)
