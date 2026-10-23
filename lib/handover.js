/**
 * Task carry-over helpers for dsh-auto-handoff.
 *
 * A context summary answers "what was said". It does NOT reliably answer "what
 * is left to do" — the agent's todo list, the files it already changed, and the
 * literal request it was serving. Losing those is what makes a handoff waste
 * the previous run: the fresh session re-reads the summary, cannot tell which
 * items are already done, and starts over.
 *
 * Everything here is a PURE function over a session event log (no host imports),
 * so the folds can be unit-tested with plain Node, where the plugin's own
 * `@deepseek-ai/*` imports cannot be resolved.
 */

/** Tools whose call arguments name a workspace file they changed. */
const FILE_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebook_edit',
  'ops_edit_file',
  'ops_write_file',
  'ops_replace',
  'ops_remove',
  'ops_copy',
  'ops_move',
])

/** Argument fields that carry a path for one of {@link FILE_TOOLS}. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'to', 'target']

/** Longest literal user request carried into the checkpoint. */
const MAX_REQUEST_CHARS = 600

/** Text parts of one message-ish payload joined, or '' when it carries none. */
function payloadText(payload) {
  const content = payload?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text
  }
  return text
}

/** Whether a user message was injected by this plugin rather than typed by a human. */
function isPluginMessage(payload) {
  return payload?.source?.kind === 'dsh-auto-handoff'
}

/**
 * Fold the standing todo list exactly the way the `todos` session projection
 * does: the latest whole `todo/write` wins, and the next `turn/start` clears it.
 * At handoff time the log ends on `turn/end`, so this is the checklist the agent
 * was working from.
 * @param events - the source session's event log.
 * @returns the last written list, or null when the turn wrote none.
 */
export function foldTodos(events) {
  let list = null
  for (const event of events ?? []) {
    if (event?.type === 'todo/write') {
      list = Array.isArray(event.data?.todos) ? event.data.todos : null
    } else if (event?.type === 'turn/start') {
      list = null
    }
  }
  return list
}

/** Whether a todo list still has work the next session should pick up. */
export function hasUnfinishedWork(todos) {
  if (!Array.isArray(todos)) return false
  return todos.some(todo => todo?.status === 'pending' || todo?.status === 'in_progress')
}

/** Paths named by one tool call's JSON arguments, in argument order. */
function pathsOfCall(event) {
  const name = event?.data?.name
  if (typeof name !== 'string' || !FILE_TOOLS.has(name)) return []
  const raw = event.data.arguments
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { return [] }
  }
  if (args === null || typeof args !== 'object') return []
  const paths = []
  for (const field of PATH_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value.length > 0) paths.push(value)
  }
  return paths
}

/**
 * Collect the workspace paths this conversation already wrote, newest last and
 * de-duplicated. These are files the fresh session must not redo from scratch.
 * @param events - the source session's event log.
 * @param limit - maximum paths kept (the most recent ones survive).
 * @returns de-duplicated paths, oldest first.
 */
export function foldTouchedFiles(events, limit = 12) {
  const seen = new Set()
  const order = []
  for (const event of events ?? []) {
    if (event?.type !== 'tool/call') continue
    for (const path of pathsOfCall(event)) {
      if (seen.has(path)) continue
      seen.add(path)
      order.push(path)
    }
  }
  return order.slice(Math.max(0, order.length - limit))
}

/**
 * The literal request the user last made, so the fresh session continues the
 * real task instead of the summary's paraphrase of it.
 * @param events - the source session's event log.
 * @returns the request text, or null when the conversation has none.
 */
export function foldLastUserText(events) {
  const list = events ?? []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (event?.type !== 'user/message') continue
    if (isPluginMessage(event.data)) continue
    const text = payloadText(event.data).trim()
    if (text.length > 0) {
      return text.length > MAX_REQUEST_CHARS ? `${text.slice(0, MAX_REQUEST_CHARS)}…` : text
    }
  }
  return null
}

/** Markdown checkbox for one todo status. */
function todoLine(todo) {
  const mark = todo?.status === 'completed' ? 'x' : todo?.status === 'in_progress' ? '~' : ' '
  const content = typeof todo?.content === 'string' ? todo.content.trim() : ''
  return `- [${mark}] ${content}`
}

/**
 * Render the task-state block appended to the checkpoint message. Empty string
 * when the conversation left nothing worth carrying, so a plain chat handoff
 * stays a plain summary.
 * @param input - folded task state of the source session.
 * @returns the block text, or '' when there is nothing to carry.
 */
export function buildTaskBlock(input) {
  const todos = Array.isArray(input?.todos) ? input.todos : []
  const files = Array.isArray(input?.files) ? input.files : []
  const lastUser = typeof input?.lastUser === 'string' ? input.lastUser.trim() : ''
  if (todos.length === 0 && files.length === 0 && lastUser === '') return ''

  const sections = ['（任务交接：以下是上一段对话的实际进度，从中断处继续，不要重做已完成的部分。）']

  if (todos.length > 0) {
    sections.push([
      '',
      '待办清单（原样恢复：开始工作前先用 todo_write 把这份清单写回，保留每项状态）',
      ...todos.map(todoLine),
    ].join('\n'))
  }

  if (files.length > 0) {
    sections.push([
      '',
      '本段对话已经改动过的文件（内容已落盘，不要重新从零实现）',
      ...files.map(path => `- ${path}`),
    ].join('\n'))
  }

  if (lastUser !== '') {
    sections.push(['', '上一个用户请求（原文）', lastUser].join('\n'))
  }

  const unfinished = hasUnfinishedWork(todos)
  sections.push(
    '',
    unfinished
      ? '继续要求：先核对上面的清单，把 pending / in_progress 的项做完，已完成的项不要重复执行。'
      : '继续要求：上面的清单已全部完成；如果还有遗留工作，按上一个请求继续，否则直接向用户汇报结果。',
  )
  return sections.join('\n')
}
