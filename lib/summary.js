/**
 * The model-written handoff summary.
 *
 * The call replays the conversation's own system prompt, tool envelope and
 * message suffix, then appends one instruction. Keeping the conversation's own
 * prefix in front of the instruction makes the auxiliary call a genuine prefix
 * of the last routed request, so the provider's warm prefix cache is reused
 * (the same discipline as `dsh-compaction-basic`) — the tool envelope alone is
 * usually the largest part of the request, and it is billed at cache prices.
 *
 * @module dsh-auto-handoff/summary
 */

import { BlockAssembler, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SUMMARY_INSTRUCTION } from './format.js'
import { buildReplay } from './replay.js'

/**
 * Map a terminal stream finish onto the error it implies.
 *
 * `max-tokens` is not treated as a hard failure by the caller: a truncated
 * summary is still usable, and refusing the handoff over it would strand the
 * user in a conversation they explicitly asked to leave.
 * @param finish - assembler finish reason.
 * @returns the error to throw, or undefined for a clean finish.
 */
export function finishError(finish) {
  switch (finish?.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'summarization stream failed')
      error.code = finish.failure?.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete handoff summary)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default: return undefined
  }
}

/**
 * Resolve which provider/model writes the summary.
 * @param header - source session's folded request header.
 * @param config - resolved plugin configuration.
 * @returns `{ provider, model }`, or undefined when neither source names one.
 */
export function resolveRoute(header, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  const routed = header?.config
  if (typeof routed?.provider === 'string' && routed.provider !== ''
    && typeof routed.model === 'string' && routed.model !== '') {
    return { provider: routed.provider, model: routed.model }
  }
  return undefined
}

/**
 * Ask the routed model for a handoff document.
 *
 * @param {object} input - call inputs.
 * @param {object} input.llm - the harness `ctx.llm` service.
 * @param {object} input.session - live source session.
 * @param {object} [input.header] - its folded request header.
 * @param {object} input.config - resolved plugin configuration.
 * @returns {Promise<{summary: object[], provider: string, model: string, truncated: boolean, usage: unknown, inputChars: number} | null>}
 *   the summary text blocks, or null when the surface has nothing to replay.
 * @throws when no route is known or the stream fails (never on truncation).
 */
export async function summarizeReplay({ llm, session, header, config }) {
  const replay = buildReplay(session, header, config)
  if (replay.messages.length === 0) return null
  const route = resolveRoute(header, config)
  if (route === undefined) {
    throw new Error('no provider/model for summarization: set dsh-auto-handoff.provider/model in settings, or send one message through this conversation first')
  }
  const assembler = new BlockAssembler()
  const messages = [
    ...replay.messages,
    createUserMessage({
      content: [{ type: 'text', text: SUMMARY_INSTRUCTION }],
      source: { kind: 'dsh-auto-handoff' },
    }),
  ]
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    ...(replay.system === undefined ? {} : { system: replay.system }),
    ...(replay.tools === undefined ? {} : { tools: replay.tools }),
    maxTokens: config.maxTokens,
    sessionId: session.id,
    purpose: 'compaction',
  })) assembler.push(chunk)

  const error = finishError(assembler.finish)
  const truncated = error?.code === 'MAX_TOKENS'
  if (error !== undefined && !truncated) throw error
  const blocks = assembler.blocks()
  if (contentHasImage(blocks)) throw new Error('handoff summary cannot contain image output')
  const summary = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
  if (!summary.some(block => block.text.trim().length > 0)) {
    if (truncated) return null
    throw new Error('summarization produced no text summary content')
  }
  const inputChars = replay.messages.reduce((total, message) => {
    const content = message?.content
    if (!Array.isArray(content)) return total
    return total + content.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0)
  }, 0)
  return {
    summary,
    provider: route.provider,
    model: route.model,
    truncated,
    usage: assembler.usage ?? null,
    inputChars,
  }
}
