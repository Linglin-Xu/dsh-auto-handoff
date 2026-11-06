/**
 * Configuration: the settings namespace, its bounds, and the widget overrides.
 *
 * The composer widget persists its own thresholds to a small JSON file because
 * the settings namespace belongs to the deployment, not to a browser tab. That
 * file used to be re-read with a SYNCHRONOUS `readFileSync` on every single
 * configuration access — several times per turn, inside the agent's event
 * handler. It is now read once and kept in memory; saving replaces the cache.
 *
 * @module dsh-auto-handoff/config
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Settings namespace holding the auto-handoff configuration. */
export const NS = 'dsh-auto-handoff'

/** Closing instruction appended when the fresh session is asked to continue. */
export const DEFAULT_CONTINUE_PROMPT = '继续。按上面的交接内容从中断处接着做，先把待办清单用 todo_write 写回，已完成的项不要重做。'

/** Public settings schema (rendered by the harness settings UI). */
export const SCHEMA = z.object({
  /** Master switch for the whole plugin. */
  enabled: z.boolean().default(true),
  /**
   * Open a fresh session automatically once `threshold`/`minRounds` are met.
   * Off (the default) keeps the plugin in MANUAL mode: the composer widget and
   * `/handoff` are the only ways to start a handoff.
   */
  autoHandoff: z.boolean().default(false),
  /** Context occupancy (0..1) at or above which a fresh session is opened. */
  threshold: z.number().default(0.8),
  /** Completed turns required before an automatic handoff may fire. */
  minRounds: z.number().default(3),
  /** Prompt once the conversation reaches this many completed turns (0 disables). */
  promptRounds: z.number().default(10),
  /** Prompt once context occupancy reaches this ratio (0 disables). */
  promptPercent: z.number().default(0.6),
  /** Prompt once this many compactions happened in the session (0 disables). */
  promptCompactions: z.number().default(2),
  /**
   * How the handoff document is produced:
   * `llm` = model summary only (fails when the provider fails),
   * `digest` = deterministic transcript digest, no model call,
   * `auto` = model summary, falling back to the digest when that call fails.
   */
  summaryMode: z.string().default('auto'),
  /** Character budget of the replayed conversation (oldest messages drop first). */
  maxInputChars: z.number().default(20000),
  /** Output token cap for the summarization call. */
  maxTokens: z.number().default(4096),
  /** Summarization provider override (empty = follow the conversation's own route). */
  provider: z.string().default(''),
  /** Summarization model override (empty = follow the conversation's own route). */
  model: z.string().default(''),
  /** Keep per-session decision detail for the status route. */
  debug: z.boolean().default(true),
  /** Show the composer status widget (pill + handoff button + threshold editor). */
  uiEnabled: z.boolean().default(true),
  /** Carry the task state (todo list, changed files, literal request) into the fresh session. */
  carryTasks: z.boolean().default(true),
  /** Make the fresh session continue on its own: auto (only with unfinished todos) | always | never. */
  autoContinue: z.string().default('auto'),
  /** Closing instruction admitted to the fresh session when it continues on its own. */
  continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT),
  /**
   * Refuse to hand off a session whose autonomous goal is still running: the
   * goal round driver keeps prompting the OLD session after every turn, so the
   * work would be split across two conversations.
   */
  guardGoal: z.boolean().default(true),
})

/** Resolved defaults; also the shape `normalizeConfig` always returns. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  autoHandoff: false,
  threshold: 0.8,
  minRounds: 3,
  promptRounds: 10,
  promptPercent: 0.6,
  promptCompactions: 2,
  summaryMode: 'auto',
  maxInputChars: 20000,
  maxTokens: 4096,
  provider: '',
  model: '',
  debug: true,
  uiEnabled: true,
  carryTasks: true,
  autoContinue: 'auto',
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  guardGoal: true,
})

/** Fields the composer widget owns (the ones the UI file may override). */
const UI_KEYS = ['autoHandoff', 'promptRounds', 'promptPercent', 'promptCompactions']

/** Allowed values of the enum-ish string settings. */
const CHOICES = {
  summaryMode: ['auto', 'llm', 'digest'],
  autoContinue: ['auto', 'always', 'never'],
}

/** Bounds for the numeric settings; `null` means "no clamp". */
const BOUNDS = {
  threshold: [0.05, 1],
  minRounds: [0, 999],
  promptRounds: [0, 999],
  promptPercent: [0, 1],
  promptCompactions: [0, 999],
  maxInputChars: [2000, 200000],
  maxTokens: [256, 32768],
}

/** File the composer widget writes its threshold overrides to (survives restarts). */
export function uiConfigPath(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'auto-handoff-ui.json')
}

/**
 * Keep only the fields the widget owns, so a hand-edited file cannot inject junk.
 * @param raw - parsed file contents (anything).
 * @returns the whitelisted subset.
 */
export function pickUiConfig(raw) {
  const out = {}
  if (typeof raw?.autoHandoff === 'boolean') out.autoHandoff = raw.autoHandoff
  for (const key of UI_KEYS) {
    if (key === 'autoHandoff') continue
    if (typeof raw?.[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key]
  }
  return out
}

/**
 * Coerce whatever the settings scope returned into the resolved config.
 *
 * A settings namespace is user-editable and some deployments hand back strings;
 * every value is therefore bounded here rather than trusted downstream.
 * @param raw - merged settings object.
 * @returns a complete, bounded configuration.
 */
export function normalizeConfig(raw) {
  const input = raw ?? {}
  const out = { ...DEFAULTS }
  for (const key of ['enabled', 'autoHandoff', 'debug', 'uiEnabled', 'carryTasks', 'guardGoal']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = Number(input[key])
    if (Number.isFinite(value)) out[key] = Math.min(max, Math.max(min, value))
  }
  for (const [key, values] of Object.entries(CHOICES)) {
    if (typeof input[key] === 'string' && values.includes(input[key])) out[key] = input[key]
  }
  for (const key of ['provider', 'model']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim()
  }
  if (typeof input.continuePrompt === 'string' && input.continuePrompt.trim() !== '') {
    out.continuePrompt = input.continuePrompt
  }
  return out
}

/**
 * In-memory holder of the widget overrides file.
 *
 * One read at construction, never again unless `save()` writes: the widget's
 * values change only through this process, so the file cannot go stale behind
 * our back in any way that matters.
 */
export class UiConfigStore {
  #path
  #values
  #loaded = false

  /**
   * @param {string} [path] - overrides file path (defaults to the DSH home).
   */
  constructor(path = uiConfigPath()) {
    this.#path = path
    this.#values = {}
  }

  /** Path of the overrides file (also used in error messages). */
  get path() {
    return this.#path
  }

  /**
   * The current overrides, loaded once on first use.
   * @returns the widget-owned subset.
   */
  get() {
    if (!this.#loaded) {
      this.#loaded = true
      try {
        this.#values = pickUiConfig(JSON.parse(readFileSync(this.#path, 'utf8')))
      } catch {
        // A missing or corrupt file simply means "no overrides".
        this.#values = {}
      }
    }
    return this.#values
  }

  /**
   * Merge one patch into the overrides and persist it.
   * @param patch - candidate values from the widget.
   * @returns whether the write landed (the in-memory values update either way).
   */
  save(patch) {
    this.#loaded = true
    this.#values = pickUiConfig({ ...this.get(), ...(patch ?? {}) })
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      writeFileSync(this.#path, `${JSON.stringify(this.#values, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  }
}
