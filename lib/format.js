/**
 * Checkpoint format: the exact markers, framing text and detection helpers.
 *
 * Kept dependency-free and side-effect-free so both halves of the plugin (and
 * the unit tests) can share one definition of "this message is a handoff
 * checkpoint". The client half cannot import it — it runs inside the browser
 * module loader — so the client mirrors the tag string instead.
 *
 * @module dsh-auto-handoff/format
 */

/** Opening marker of the handoff document inside the first user message. */
export const CHECKPOINT_OPEN_TAG = '<auto-handoff-checkpoint>'

/** Closing marker of the handoff document. */
export const CHECKPOINT_CLOSE_TAG = '</auto-handoff-checkpoint>'

/**
 * Framing sentence placed before the document.
 *
 * The document is injected as a normal user message, so the model has to be
 * told that it is established context rather than a fresh request.
 */
export const CHECKPOINT_PREAMBLE = [
  '以下是一条自动生成的上文交接摘要，来自同一个工作区的上一个会话。',
  '请把它当作已经建立的上下文：不要复述它，也不要为了确认它而提问，直接从它结束的地方继续。',
].join('')

/** Instruction appended to the replay when asking the model for the summary. */
export const SUMMARY_INSTRUCTION = [
  '你要为「换一个会话继续干」做一次交接。请阅读上面的对话，写一份给接下来的自己看的交接文档。',
  '',
  '要求：',
  '1. 只写事实，不写客套话、不写「好的」、不要 Markdown 代码块包裹整篇。',
  '2. 用下面 4 个小标题组织，每节控制在 5 条以内，每条一行：',
  '   ## 目标 —— 用户到底要什么（如果过程中有转向，写出最终目标）。',
  '   ## 已完成 —— 已经做成的事、关键结论、以及为什么这么做（带上决定性的数字/路径）。',
  '   ## 未完成 —— 还没做完的事、卡点、下一步该做什么（按优先级排序）。',
  '   ## 关键约束 —— 不能违反的规则、已确认的 API/事实、失败过的尝试（避免重复踩坑）。',
  '3. 保留精确的文件路径、函数名、命令、错误原文；省略无关的寒暄与重复内容。',
  '4. 不要虚构对话里没有的信息；不确定的地方写「未验证」。',
  '5. 全文控制在 1200 字以内。',
].join('\n')

/**
 * Whether one message text is a checkpoint this plugin produced.
 *
 * Used to keep a previous handoff document from being mistaken for the user's
 * last request, and to keep the digest from quoting it in full.
 *
 * @param {unknown} text - candidate message text.
 * @returns {boolean} true when the text carries the checkpoint marker.
 */
export function looksLikeCheckpoint(text) {
  return typeof text === 'string' && text.includes(CHECKPOINT_OPEN_TAG)
}
