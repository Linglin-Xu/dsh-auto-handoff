/**
 * Checkpoint assembly: the document a fresh session starts from.
 *
 * Two shapes feed it. A model-written summary (short, condensed, preferred) or
 * a deterministic digest built here from the replay messages (free, instant,
 * never fails) — the fallback that keeps the handoff button working when the
 * provider is unreachable or the user asked for no model call at all.
 *
 * @module dsh-auto-handoff/checkpoint
 */

import { CHECKPOINT_CLOSE_TAG, CHECKPOINT_OPEN_TAG, CHECKPOINT_PREAMBLE, looksLikeCheckpoint } from './format.js'
import { messageText } from './replay.js'

/** How each message role is labelled inside the digest. */
const ROLE_LABELS = {
  user: '用户',
  assistant: '助手',
  tool: '工具结果',
  system: '系统',
}

/** A previous handoff document quoted by the digest is capped more generously. */
const CHECKPOINT_QUOTE_CHARS = 1500

/**
 * Build a deterministic transcript digest — no model call.
 *
 * Walks the derived messages backwards so the newest material is always kept,
 * caps each message, and stops at the budget. The result is chronological.
 * @param {readonly object[]} messages - derived surface messages.
 * @param {{budget?: number, maxMessageChars?: number, maxToolChars?: number}} [options] - caps.
 * @returns the digest text, or an empty string when there is nothing to quote.
 */
export function buildDigest(messages, options = {}) {
  const budget = options.budget ?? 8000
  const maxMessageChars = options.maxMessageChars ?? 700
  const maxToolChars = options.maxToolChars ?? 240
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const lines = []
  let used = 0
  let included = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const text = messageText(message).trim()
    if (text === '') continue
    const isTool = message?.role === 'tool'
    const quoted = looksLikeCheckpoint(text)
    const cap = quoted ? CHECKPOINT_QUOTE_CHARS : isTool ? maxToolChars : maxMessageChars
    const body = text.length > cap ? `${text.slice(0, cap)}…` : text
    const label = quoted ? '上一份交接文档' : ROLE_LABELS[message?.role] ?? '消息'
    const line = `- ${label}：${body.replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ')}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
    included += 1
  }
  if (included === 0) return ''
  const omitted = messages.length - included
  const header = omitted > 0
    ? `（以下是对话摘录，按时间正序；更早的 ${omitted} 条消息已省略）`
    : '（以下是对话摘录，按时间正序）'
  return [header, ...lines.reverse()].join('\n')
}

/**
 * Wrap the pieces into the user-message content blocks of a checkpoint.
 *
 * @param {object} input - document parts.
 * @param {readonly object[]} [input.summaryBlocks] - model summary text blocks.
 * @param {string} [input.digest] - deterministic digest used instead of a summary.
 * @param {string} [input.taskBlock] - todo list, touched files, last request.
 * @param {string} [input.backgroundBlock] - background jobs and child sessions.
 * @param {string} [input.note] - extra note (truncation, degraded summary, ...).
 * @param {string} [input.continueText] - closing instruction when the task continues.
 * @returns {object[]} content blocks for the checkpoint message.
 */
export function buildCheckpointBlocks(input) {
  const summaryBlocks = Array.isArray(input.summaryBlocks) ? input.summaryBlocks : []
  const parts = []
  const digest = typeof input.digest === 'string' ? input.digest.trim() : ''
  if (summaryBlocks.length > 0) {
    parts.push(...summaryBlocks)
  } else if (digest !== '') {
    parts.push({ type: 'text', text: `## 对话摘录（自动生成，非模型摘要）\n${digest}` })
  }
  const blocks = [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
    ...parts,
  ]
  if (typeof input.note === 'string' && input.note !== '') {
    blocks.push({ type: 'text', text: `\n（注：${input.note}）` })
  }
  if (typeof input.taskBlock === 'string' && input.taskBlock !== '') {
    blocks.push({ type: 'text', text: `\n\n${input.taskBlock}` })
  }
  if (typeof input.backgroundBlock === 'string' && input.backgroundBlock !== '') {
    blocks.push({ type: 'text', text: `\n\n${input.backgroundBlock}` })
  }
  if (typeof input.continueText === 'string' && input.continueText.trim() !== '') {
    blocks.push({ type: 'text', text: `\n\n${input.continueText.trim()}` })
  }
  blocks.push({ type: 'text', text: `\n${CHECKPOINT_CLOSE_TAG}` })
  return blocks
}

/**
 * Flatten checkpoint blocks back into the text a prompt part carries.
 * @param {readonly object[]} blocks - content blocks.
 * @returns their concatenated text.
 */
export function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map(block => (typeof block?.text === 'string' ? block.text : '')).join('')
}
