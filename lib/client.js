/**
 * dsh-auto-handoff, browser half (client bundle).
 *
 * Two jobs:
 *
 * 1. MANUAL HANDOFF UI — a status pill ("12 轮 · 34% · 压缩 2") plus a 交接
 *    button docked next to the composer. The pill colours itself when a
 *    user-configured prompt threshold fires (turns / occupancy / compaction
 *    count) and raises one toast per threshold, and the gear opens the inline
 *    editor for those thresholds. The button asks the host to perform a handoff
 *    now, or to queue it until the current turn settles.
 *
 * 2. PENDING NAVIGATION — the host publishes a pending record once a fresh
 *    session exists; this half notices it on the next status poll for the
 *    session the user is looking at and switches the GUI to the fresh session.
 *    It also remembers that session in `localStorage` so a reload lands there
 *    instead of on the source.
 *
 * ONE poll loop drives both: the status response of the visible session already
 * carries the navigation record, so a second request per tick would only double
 * the chatter. The response is not what clears the record — `/pending` still is
 * — so a dropped frame or a reload cannot lose a navigation.
 *
 * Mounted into `conversation.composer.dock` when that slot exists, and as a
 * floating bar otherwise. It is never inserted into the composer's React tree:
 * an earlier slot-based mount could take the whole input box down with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-handoff',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /** Host route carrying the pending-navigation record (and clearing it). */
    const PENDING_ENDPOINT = '/api/dsh-auto-handoff/pending'
    /** Host route describing one live session (turns / occupancy / prompts / queue). */
    const STATUS_ENDPOINT = '/api/dsh-auto-handoff/status'
    /** Host route queueing a user-pressed handoff. */
    const QUEUE_ENDPOINT = '/api/dsh-auto-handoff/queue'
    /** Host route persisting the widget-owned thresholds. */
    const UI_CONFIG_ENDPOINT = '/api/dsh-auto-handoff/ui-config'
    /** Poll cadence while the tab is visible. */
    const POLL_INTERVAL_MS = 2000
    /** Where the last auto-opened session id is remembered across reloads. */
    const STORAGE_KEY = 'dsh-auto-handoff:last-opened'
    /** Id of the injected stylesheet, so a re-mount never adds a second copy. */
    const STYLE_ID = 'dsh-auto-handoff-style'
    /**
     * How long a transient pill message ("交接中…", "交接失败：…") stays up. The
     * poll repaints every 2s, so without a hold the feedback would be wiped before
     * the user could read it.
     */
    const FLASH_MS = 8000

    /** Read a storage key without ever throwing (private mode, disabled storage). */
    function readStored(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    /** Write a storage key without ever throwing. */
    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch { /* storage unavailable is not a handoff failure */ }
    }

    /** Read and CLEAR the host's pending record for one source session. */
    async function takePending(sessionId, signal) {
      const response = await fetch(`${PENDING_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, { signal })
      if (!response.ok) return null
      const payload = await response.json().catch(() => null)
      if (payload === null || payload.ok !== true) return null
      const pending = payload.pending
      if (pending === null || pending === undefined) return null
      return typeof pending.newSessionId === 'string' && pending.newSessionId.length > 0 ? pending : null
    }

    /**
     * Human summary of one handoff: how the document was produced and what the
     * summarization call cost. The host records the provider usage of that single
     * call, so the toast answers "what did this handoff cost" without /status.
     * @param record - handoff or pending record carrying `usage`.
     * @returns one-line toast text.
     */
    function handoffCostText(record) {
      const source = record?.summarySource
      const suffix = record?.degraded !== null && record?.degraded !== undefined
        ? '（摘要降级为本地摘录）'
        : source === 'digest'
          ? '（本地摘录，无模型调用）'
          : record?.truncated === true
            ? '（摘要被截断）'
            : ''
      const usage = record?.usage
      if (usage === null || usage === undefined) return `已交接 · 新会话已打开${suffix}`
      const fmt = (value) => {
        const number = Number(value ?? 0)
        return number >= 1000 ? `${(number / 1000).toFixed(1)}k` : String(number)
      }
      const cached = Number(usage.cacheReadTokens ?? 0)
      return `已交接 · 摘要 token：输入 ${fmt(usage.inputTokens)}${cached > 0 ? `（缓存 ${fmt(cached)}）` : ''} · 输出 ${fmt(usage.outputTokens)}${suffix}`
    }

    /** One POST helper shared by the button and the threshold editor. */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      return { ok: response.ok, payload }
    }

    /**
     * Inject the widget stylesheet once.
     *
     * Every colour comes from the host's `--dsw-alias-*` theme tokens with a
     * fallback, so the badge follows the app's light/dark theme instead of
     * painting a dark island inside a light composer. All rules are scoped to
     * `[data-dsh-auto-handoff]` (or the `.ah-` prefix) so nothing leaks into
     * the surrounding app.
     */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || document === null) return
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = [
          '[data-dsh-auto-handoff] {',
          '  --ah-brand: var(--dsw-alias-brand-primary, #4d9fff);',
          '  --ah-bg: var(--dsw-alias-bg-layer-1, rgba(24, 28, 34, .82));',
          '  --ah-overlay: var(--dsw-alias-bg-overlay, rgba(28, 32, 38, .98));',
          '  --ah-border: var(--dsw-alias-border-l1, rgba(127, 127, 127, .28));',
          '  --ah-border-strong: var(--dsw-alias-border-l2, rgba(127, 127, 127, .45));',
          '  --ah-text: var(--dsw-alias-label-primary, #e8eaed);',
          '  --ah-muted: var(--dsw-alias-label-secondary, #9aa0a6);',
          '  --ah-warn: var(--dsw-alias-state-warn-primary, #f5a524);',
          '  --ah-error: var(--dsw-alias-state-error-primary, #e5484d);',
          '  --ah-ok: var(--dsw-alias-state-success-primary, #30a46c);',
          '  --ah-track: rgba(127, 127, 127, .25);',
          '  --ah-hover: rgba(127, 127, 127, .16);',
          '}',
          '[data-dsh-auto-handoff] {',
          '  display: inline-flex;',
          '  align-items: center;',
          '  gap: 2px;',
          '  padding: 1px;',
          '  border: 1px solid var(--ah-border);',
          '  border-radius: 999px;',
          '  color: var(--ah-muted);',
          '  font-family: inherit;',
          '  font-size: 12px;',
          '  line-height: 1.2;',
          '  font-variant-numeric: tabular-nums;',
          '  white-space: nowrap;',
          '  transition: border-color .15s ease, background-color .15s ease;',
          '}',
          '[data-dsh-auto-handoff]:hover { border-color: var(--ah-border-strong); }',
          '[data-dsh-auto-handoff][data-mode="float"] {',
          '  padding: 3px;',
          '  background: var(--ah-bg);',
          '  box-shadow: 0 6px 20px rgba(0, 0, 0, .18);',
          '  backdrop-filter: blur(8px);',
          '}',
          '[data-dsh-auto-handoff] .ah-pill {',
          '  display: inline-flex;',
          '  align-items: center;',
          '  gap: 6px;',
          '  padding: 2px 9px 2px 8px;',
          '  border-radius: 999px;',
          '  color: var(--ah-text);',
          '  cursor: default;',
          '}',
          '[data-dsh-auto-handoff] .ah-text { display: inline-flex; align-items: center; gap: 2px; }',
          '[data-dsh-auto-handoff] .ah-ring {',
          '  width: 11px;',
          '  height: 11px;',
          '  flex: 0 0 auto;',
          '  border-radius: 50%;',
          '  background: conic-gradient(var(--ah-ring-color, var(--ah-brand)) calc(var(--ah-pct, 0) * 1%), var(--ah-track) 0);',
          '  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));',
          '  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));',
          '}',
          '[data-dsh-auto-handoff] .ah-ring[data-unknown="true"] {',
          '  background: var(--ah-track);',
          '  -webkit-mask: none;',
          '  mask: none;',
          '  opacity: .75;',
          '}',
          '[data-dsh-auto-handoff] .ah-num { color: var(--ah-text); font-weight: 600; }',
          '[data-dsh-auto-handoff] .ah-unit { color: var(--ah-muted); }',
          '[data-dsh-auto-handoff] .ah-sep { color: var(--ah-muted); opacity: .5; padding: 0 1px; }',
          '[data-dsh-auto-handoff] .ah-msg { color: var(--ah-text); }',
          '[data-dsh-auto-handoff][data-tone="warn"] .ah-num { color: var(--ah-warn); }',
          '[data-dsh-auto-handoff][data-tone="alert"] .ah-num { color: var(--ah-error); }',
          '[data-dsh-auto-handoff] .ah-chip {',
          '  display: inline-flex;',
          '  align-items: center;',
          '  margin-left: 6px;',
          '  padding: 1px 6px;',
          '  border: 1px solid var(--ah-border);',
          '  border-radius: 999px;',
          '  color: var(--ah-muted);',
          '  font-size: 11px;',
          '  line-height: 1.4;',
          '}',
          '[data-dsh-auto-handoff] .ah-chip[data-tone="warn"] { border-color: var(--ah-warn); color: var(--ah-warn); }',
          '[data-dsh-auto-handoff] .ah-btn {',
          '  display: inline-flex;',
          '  align-items: center;',
          '  justify-content: center;',
          '  gap: 4px;',
          '  height: 20px;',
          '  padding: 0 9px;',
          '  border: 1px solid transparent;',
          '  border-radius: 999px;',
          '  background: transparent;',
          '  color: var(--ah-brand);',
          '  font: inherit;',
          '  font-weight: 600;',
          '  cursor: pointer;',
          '  transition: background-color .12s ease, color .12s ease, opacity .12s ease;',
          '}',
          '[data-dsh-auto-handoff] .ah-btn:hover { background: var(--ah-hover); }',
          '[data-dsh-auto-handoff] .ah-btn:active { transform: translateY(.5px); }',
          '[data-dsh-auto-handoff] .ah-btn:focus-visible { outline: 2px solid var(--ah-brand); outline-offset: 1px; }',
          '[data-dsh-auto-handoff] .ah-btn:disabled { opacity: .55; cursor: default; transform: none; }',
          '[data-dsh-auto-handoff] .ah-icon { padding: 0 7px; color: var(--ah-muted); font-weight: 400; }',
          '[data-dsh-auto-handoff] .ah-icon:hover { color: var(--ah-text); }',
          '[data-dsh-auto-handoff] .ah-icon[aria-expanded="true"] { background: var(--ah-hover); color: var(--ah-text); }',
          '[data-dsh-auto-handoff] .ah-spinner {',
          '  width: 9px;',
          '  height: 9px;',
          '  flex: 0 0 auto;',
          '  border: 2px solid var(--ah-border-strong);',
          '  border-top-color: var(--ah-brand);',
          '  border-radius: 50%;',
          '  animation: ah-spin .8s linear infinite;',
          '}',
          '@keyframes ah-spin { to { transform: rotate(360deg); } }',
          '[data-dsh-auto-handoff] .ah-panel {',
          '  position: absolute;',
          '  right: 0;',
          '  bottom: calc(100% + 8px);',
          '  z-index: 9998;',
          '  display: grid;',
          '  gap: 10px;',
          '  min-width: 252px;',
          '  padding: 12px;',
          '  border: 1px solid var(--ah-border-strong);',
          '  border-radius: 14px;',
          '  background: var(--ah-overlay);',
          '  color: var(--ah-text);',
          '  box-shadow: 0 12px 32px rgba(0, 0, 0, .28);',
          '  font-size: 12px;',
          '  line-height: 1.45;',
          '}',
          '[data-dsh-auto-handoff] .ah-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; }',
          '[data-dsh-auto-handoff] .ah-close {',
          '  padding: 2px 5px;',
          '  border: 0;',
          '  border-radius: 6px;',
          '  background: transparent;',
          '  color: var(--ah-muted);',
          '  font: inherit;',
          '  font-size: 14px;',
          '  line-height: 1;',
          '  cursor: pointer;',
          '}',
          '[data-dsh-auto-handoff] .ah-close:hover { color: var(--ah-text); background: var(--ah-hover); }',
          '[data-dsh-auto-handoff] .ah-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--ah-muted); }',
          '[data-dsh-auto-handoff] .ah-field { display: inline-flex; align-items: center; gap: 4px; }',
          '[data-dsh-auto-handoff] .ah-input {',
          '  width: 54px;',
          '  padding: 4px 6px;',
          '  border: 1px solid var(--ah-border-strong);',
          '  border-radius: 8px;',
          '  background: transparent;',
          '  color: var(--ah-text);',
          '  font: inherit;',
          '  text-align: right;',
          '}',
          '[data-dsh-auto-handoff] .ah-input:focus-visible { outline: 2px solid var(--ah-brand); outline-offset: 1px; }',
          '[data-dsh-auto-handoff] .ah-input::-webkit-outer-spin-button,',
          '[data-dsh-auto-handoff] .ah-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
          '[data-dsh-auto-handoff] .ah-input { -moz-appearance: textfield; appearance: textfield; }',
          '[data-dsh-auto-handoff] input[type="checkbox"] { accent-color: var(--ah-brand); margin: 2px 0 0; }',
          '[data-dsh-auto-handoff] .ah-suffix { min-width: 12px; opacity: .7; }',
          '[data-dsh-auto-handoff] .ah-switch { display: flex; align-items: flex-start; gap: 8px; color: var(--ah-muted); }',
          '[data-dsh-auto-handoff] .ah-foot { display: flex; justify-content: flex-end; gap: 8px; }',
          '[data-dsh-auto-handoff] .ah-primary {',
          '  padding: 5px 12px;',
          '  border: 1px solid transparent;',
          '  border-radius: 9px;',
          '  background: var(--ah-brand);',
          '  color: #fff;',
          '  font: inherit;',
          '  font-weight: 600;',
          '  cursor: pointer;',
          '}',
          '[data-dsh-auto-handoff] .ah-primary:disabled { opacity: .6; cursor: default; }',
          '[data-dsh-auto-handoff] .ah-ghost {',
          '  padding: 5px 10px;',
          '  border: 1px solid var(--ah-border-strong);',
          '  border-radius: 9px;',
          '  background: transparent;',
          '  color: var(--ah-text);',
          '  font: inherit;',
          '  cursor: pointer;',
          '}',
          '[data-dsh-auto-handoff] .ah-ghost:hover { background: var(--ah-hover); }',
          '[data-dsh-auto-handoff] .ah-hint { color: var(--ah-muted); font-size: 11px; line-height: 1.5; opacity: .9; }',
          '.ah-toast {',
          '  position: fixed;',
          '  top: 72px;',
          '  z-index: 9999;',
          '  max-width: min(380px, calc(100vw - 36px));',
          '  padding: 11px 14px;',
          '  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .45));',
          '  border-left: 3px solid var(--dsw-alias-brand-primary, #4d9fff);',
          '  border-radius: 12px;',
          '  background: var(--dsw-alias-bg-overlay, rgba(28, 32, 38, .97));',
          '  color: var(--dsw-alias-label-primary, #e8eaed);',
          '  font-size: 13px;',
          '  line-height: 1.5;',
          '  box-shadow: 0 10px 30px rgba(0, 0, 0, .28);',
          '  cursor: pointer;',
          '  animation: ah-in .16s ease-out;',
          '}',
          '.ah-toast[data-tone="warn"] { border-left-color: var(--dsw-alias-state-warn-primary, #f5a524); }',
          '.ah-toast[data-tone="error"] { border-left-color: var(--dsw-alias-state-error-primary, #e5484d); }',
          '@keyframes ah-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }',
          '@media (prefers-reduced-motion: reduce) {',
          '  [data-dsh-auto-handoff] .ah-spinner { animation: none; }',
          '  .ah-toast { animation: none; }',
          '}',
        ].join('\n')
        document.head.appendChild(style)
      } catch { /* styling is cosmetic; the widget still works unstyled */ }
    }

    /** Raise one toast in the top-right corner so it never covers the composer. */
    function showToast(text, tone) {
      try {
        ensureStyles()
        const toast = document.createElement('div')
        toast.className = 'ah-toast'
        toast.dataset.tone = tone ?? 'info'
        toast.textContent = text
        toast.style.right = `${composerRightOffset()}px`
        toast.title = '点击关闭'
        toast.addEventListener('click', () => toast.remove())
        document.body.appendChild(toast)
        setTimeout(() => toast.remove(), FLASH_MS)
      } catch { /* notification is best-effort */ }
    }

    /**
     * Build the widget's DOM once.
     *
     * The pill carries a ring (context occupancy), the round count and the exact
     * percentage; chips appear only when they mean something (compressions,
     * queued, an active goal), so an idle conversation stays quiet in the row
     * that already holds the composer's own stats pills.
     */
    function createWidget() {
      ensureStyles()
      const root = document.createElement('div')
      root.setAttribute('data-dsh-auto-handoff', '')
      root.className = 'ah-root'
      root.dataset.mode = 'float'
      root.dataset.tone = 'idle'
      root.style.zIndex = '40'

      const pill = document.createElement('span')
      pill.className = 'ah-pill'
      pill.setAttribute('role', 'status')
      pill.setAttribute('aria-live', 'polite')

      const ring = document.createElement('span')
      ring.className = 'ah-ring'
      ring.setAttribute('aria-hidden', 'true')

      const text = document.createElement('span')
      text.className = 'ah-text'

      pill.append(ring, text)

      const handoff = document.createElement('button')
      handoff.type = 'button'
      handoff.className = 'ah-btn'
      handoff.textContent = '交接'
      handoff.title = '把当前会话压缩成交接文档，在新会话里继续（当前轮到一半时会排队到轮次结束）'

      const gear = document.createElement('button')
      gear.type = 'button'
      gear.className = 'ah-btn ah-icon'
      gear.textContent = '⚙'
      gear.title = '交接提示阈值'
      gear.setAttribute('aria-label', '交接提示阈值')
      gear.setAttribute('aria-haspopup', 'dialog')
      gear.setAttribute('aria-expanded', 'false')

      root.append(pill, handoff, gear)
      return {
        root,
        pill,
        ring,
        text,
        handoff,
        gear,
        panel: null,
        mode: 'float',
        sessionId: undefined,
        config: undefined,
        lastStatus: undefined,
        placed: '',
        holdUntil: 0,
      }
    }

    /**
     * The element that actually paints the input box. `[data-composer-seat]` is
     * the chain wrapper (it can be wider than the visible card), so alignment
     * must measure the card itself.
     */
    function composerCard() {
      try {
        return document.querySelector('[data-composer-card]') ?? document.querySelector('[data-composer-seat]')
      } catch {
        return null
      }
    }

    /** CSS `right` offset that lines an element up with the input box's right edge. */
    function composerRightOffset() {
      const card = composerCard()
      if (card === null) return 18
      try {
        const rect = card.getBoundingClientRect()
        return Math.max(12, Math.round(window.innerWidth - rect.right))
      } catch {
        return 18
      }
    }

    /**
     * Position the floating fallback (dock slot unavailable).
     *
     * LEFT-aligned with the input card: the right end of a message row is where
     * its edit/delete actions appear on hover, so the bar must never sit there.
     * The applied offsets are remembered, so a poll that changes nothing does not
     * touch the layout (a style write per tick forced a reflow on every poll).
     */
    function positionWidget(widget) {
      if (widget === null || widget.mode !== 'float') return
      try {
        const root = widget.root
        const card = composerCard()
        let left = '18px'
        let bottom = '84px'
        if (card !== null) {
          const rect = card.getBoundingClientRect()
          left = `${Math.max(12, Math.round(rect.left))}px`
          bottom = `${Math.max(12, Math.round(window.innerHeight - rect.top + 8))}px`
        }
        const placed = `${left}|${bottom}`
        if (widget.placed === placed) return
        widget.placed = placed
        root.style.position = 'fixed'
        root.style.zIndex = '40'
        root.style.right = 'auto'
        root.style.left = left
        root.style.bottom = bottom
      } catch { /* positioning is cosmetic */ }
    }

    /** Shortened count so a long-lived session cannot widen the pill. */
    function compactCount(value) {
      const count = Number.isFinite(value) ? value : 0
      return count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count)
    }

    /** The ring: share of the context window that is already used. */
    function setRing(widget, percent, tone, known) {
      const ring = widget.ring
      ring.dataset.unknown = known ? 'false' : 'true'
      ring.style.setProperty('--ah-pct', String(known ? Math.max(0, Math.min(100, percent)) : 0))
      ring.style.setProperty(
        '--ah-ring-color',
        tone === 'alert' ? 'var(--ah-error)' : tone === 'warn' ? 'var(--ah-warn)' : 'var(--ah-brand)',
      )
    }

    /**
     * Paint the pill contents.
     *
     * `parts.message` replaces the counters with a transient state (busy, error);
     * otherwise the pill reads "12 轮 · 63%" with optional chips.
     */
    function paint(widget, parts) {
      const text = widget.text
      text.replaceChildren()
      const span = (className, value) => {
        const node = document.createElement('span')
        node.className = className
        node.textContent = value
        return node
      }
      if (typeof parts.message === 'string' && parts.message.length > 0) {
        if (parts.busy === true) {
          const spinner = span('ah-spinner', '')
          spinner.setAttribute('aria-hidden', 'true')
          text.appendChild(spinner)
        }
        text.appendChild(span('ah-msg', parts.message))
        widget.root.dataset.tone = parts.tone ?? 'idle'
        return
      }
      text.appendChild(span('ah-num', compactCount(parts.turns)))
      text.appendChild(span('ah-unit', ' 轮'))
      text.appendChild(span('ah-sep', '·'))
      text.appendChild(span('ah-num', parts.percent === null ? '—' : `${parts.percent}%`))
      if (parts.compactions > 0) text.appendChild(span('ah-chip', `压缩 ${parts.compactions}`))
      if (parts.queued === true) {
        const chip = span('ah-chip', '已排队')
        chip.dataset.tone = 'warn'
        text.appendChild(chip)
      }
      if (parts.goal === true) {
        const chip = span('ah-chip', 'goal')
        chip.dataset.tone = 'warn'
        chip.title = '该会话正在执行 goal：交接前请先暂停或完成它。'
        text.appendChild(chip)
      }
      widget.root.dataset.tone = parts.tone ?? 'idle'
    }

    /** Show a transient message in the pill and hold it against the next poll. */
    function flash(widget, message, tone, busy, ms) {
      if (widget === null) return
      widget.holdUntil = Date.now() + (ms ?? FLASH_MS)
      paint(widget, { message, tone: tone ?? 'idle', busy: busy === true })
    }

    /** Render one status payload (or a placeholder) into the widget. */
    function renderWidget(widget, status) {
      if (widget === null) return
      if (status === undefined) {
        setRing(widget, 0, 'ok', false)
        paint(widget, { message: '读取中…', tone: 'idle' })
        widget.pill.title = '正在读取当前会话的轮次与上下文占用'
        return
      }
      if (widget.holdUntil !== undefined && Date.now() < widget.holdUntil) return
      widget.lastStatus = status
      const known = status.occupancy?.known === true
      const percent = known ? Math.round(Math.max(0, Math.min(1, status.occupancy.ratio ?? 0)) * 100) : 0
      const level = status.prompts?.level ?? 'ok'
      const tone = level === 'alert' ? 'alert' : level === 'warn' ? 'warn' : 'ok'
      const goalActive = status.goal === 'active'
      setRing(widget, percent, tone, known)
      paint(widget, {
        turns: status.turns ?? 0,
        percent: known ? percent : null,
        compactions: status.compactions ?? 0,
        queued: status.queued === true,
        goal: goalActive,
        tone,
      })
      widget.pill.title = `${status.turns ?? 0} 轮 · 已压缩 ${status.compactions ?? 0} 次 · 上下文占用 ${known ? `${percent}%` : '未知'}`
      // An autonomous goal keeps driving this session: say so BEFORE the click,
      // instead of only refusing it in the response.
      widget.handoff.title = goalActive
        ? '该会话正在执行 goal：先暂停或完成 goal 再交接（否则旧会话会继续跑）'
        : '把当前会话压缩成交接文档，在新会话里继续（当前轮到一半时会排队到轮次结束）'
    }

    /** Close the threshold editor and detach its dismissal listeners. */
    function closePanel(widget) {
      if (widget === null || widget.panel === null) return
      try {
        const listeners = widget.panelListeners
        if (listeners !== undefined) {
          document.removeEventListener('mousedown', listeners.onClick, true)
          document.removeEventListener('keydown', listeners.onKey)
        }
        widget.panelListeners = undefined
        widget.panel.remove()
      } catch { /* closing is best-effort */ }
      widget.panel = null
      widget.gear.setAttribute('aria-expanded', 'false')
    }

    /**
     * Toggle the threshold editor.
     *
     * A popover anchored above the badge: one header, three numeric fields with
     * their units, the auto switch (off by default — prompting is the promise),
     * and a footer. Escape and an outside click both dismiss it.
     */
    function toggleThresholdEditor(widget, onSave) {
      if (widget.panel !== null) {
        closePanel(widget)
        return
      }
      // Thresholds live on the top-level `prompts` of the status payload; the
      // per-session `prompts` object only carries this session's hits/level.
      const config = widget.config ?? {}
      const panel = document.createElement('div')
      panel.className = 'ah-panel'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '交接提示阈值')

      const head = document.createElement('div')
      head.className = 'ah-panel-head'
      const title = document.createElement('span')
      title.textContent = '交接提示'
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'ah-close'
      close.textContent = '✕'
      close.title = '关闭（Esc）'
      close.setAttribute('aria-label', '关闭')
      head.append(title, close)

      const field = (label, input, suffix) => {
        const line = document.createElement('label')
        line.className = 'ah-row'
        const name = document.createElement('span')
        name.textContent = label
        const wrap = document.createElement('span')
        wrap.className = 'ah-field'
        input.className = 'ah-input'
        input.inputMode = 'numeric'
        const unit = document.createElement('span')
        unit.className = 'ah-suffix'
        unit.textContent = suffix
        wrap.append(input, unit)
        line.append(name, wrap)
        return line
      }

      const rounds = document.createElement('input')
      rounds.type = 'number'
      rounds.min = '0'
      rounds.value = String(config.rounds ?? 10)
      const percent = document.createElement('input')
      percent.type = 'number'
      percent.min = '0'
      percent.max = '100'
      percent.value = String(Math.round((config.percent ?? 0.6) * 100))
      const compactions = document.createElement('input')
      compactions.type = 'number'
      compactions.min = '0'
      compactions.value = String(config.compactions ?? 2)

      const autoLine = document.createElement('label')
      autoLine.className = 'ah-switch'
      const auto = document.createElement('input')
      auto.type = 'checkbox'
      auto.checked = config.autoHandoff === true
      const autoText = document.createElement('span')
      autoText.textContent = '自动交接（不推荐）：到阈值直接换会话；关闭时只提示。'
      autoLine.append(auto, autoText)

      const foot = document.createElement('div')
      foot.className = 'ah-foot'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'ah-ghost'
      cancel.textContent = '取消'
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'ah-primary'
      save.textContent = '保存'
      foot.append(cancel, save)

      const hint = document.createElement('div')
      hint.className = 'ah-hint'
      hint.textContent = '阈值只用来提示，不会自动切换会话。'

      save.addEventListener('click', async () => {
        save.disabled = true
        save.textContent = '保存中…'
        const result = await onSave({
          promptRounds: Number(rounds.value) || 0,
          promptPercent: Math.max(0, Math.min(100, Number(percent.value) || 0)) / 100,
          promptCompactions: Number(compactions.value) || 0,
          autoHandoff: auto.checked,
        })
        save.disabled = false
        save.textContent = '保存'
        if (result.ok === true) {
          hint.textContent = '已保存。'
          setTimeout(() => closePanel(widget), 700)
        } else {
          hint.textContent = `保存失败：${result.error ?? '未知错误'}`
        }
      })
      cancel.addEventListener('click', () => closePanel(widget))
      close.addEventListener('click', () => closePanel(widget))

      panel.append(
        head,
        field('轮数提示', rounds, '轮'),
        field('占用提示', percent, '%'),
        field('压缩次数提示', compactions, '次'),
        autoLine,
        foot,
        hint,
      )
      widget.root.appendChild(panel)
      widget.panel = panel
      widget.gear.setAttribute('aria-expanded', 'true')

      const onKey = event => {
        if (event.key === 'Escape') closePanel(widget)
      }
      // Deferred so the click that opened the panel does not immediately close it.
      const onClick = event => {
        if (widget.root.contains(event.target)) return
        closePanel(widget)
      }
      widget.panelListeners = { onKey, onClick }
      document.addEventListener('keydown', onKey)
      setTimeout(() => document.addEventListener('mousedown', onClick, true), 0)
      try {
        rounds.focus()
        rounds.select()
      } catch { /* focus is a nicety */ }
    }

    /**
     * Register the composer dock and the single poll loop.
     * @param ctx - Client root Context carrying the sessions and workspace UI services.
     */
    function apply(ctx) {
      const sessions = ctx.get('sessions')
      const uiWorkspace = ctx.get('uiWorkspace')
      if (sessions === undefined || uiWorkspace === undefined) {
        console.warn('dsh-auto-handoff: sessions/uiWorkspace service missing — auto switch disabled')
        return
      }

      const stored = readStored(STORAGE_KEY)
      let lastOpened = typeof stored === 'string' && stored.length > 0 ? stored : undefined

      // Reload restoration: if the stored session is the one we handed off into
      // and it still exists, come back to it instead of the previous session.
      if (lastOpened !== undefined) {
        const snapshot = sessions.list.getSnapshot()
        if (snapshot.byId[lastOpened] !== undefined && snapshot.current !== lastOpened) {
          try {
            uiWorkspace.openSession(lastOpened)
          } catch { /* an archived stored session is not an error */ }
        }
      }

      /** @returns true when the fresh session is now the current selection. */
      function openFresh(newSessionId) {
        const snapshot = sessions.list.getSnapshot()
        if (snapshot.current === newSessionId) {
          lastOpened = newSessionId
          writeStored(STORAGE_KEY, newSessionId)
          return true
        }
        // The host publishes the new session through the normal list feed; when
        // that frame has not landed yet, the next poll tries again.
        if (snapshot.byId[newSessionId] === undefined) return false
        uiWorkspace.openSession(newSessionId)
        lastOpened = newSessionId
        writeStored(STORAGE_KEY, newSessionId)
        console.info(`dsh-auto-handoff: switched to fresh session ${newSessionId}`)
        return true
      }

      /**
       * Session the conversation view currently shows. The host list snapshot
       * has no "current" field in this DSH version; the conversation root
       * stamps it as `data-conversation-session`.
       */
      function domSessionId() {
        try {
          const nodes = document.querySelectorAll('[data-conversation-session]')
          let fallback
          for (const node of nodes) {
            const value = node.getAttribute('data-conversation-session')
            if (typeof value !== 'string' || value.length === 0) continue
            // Prefer the conversation that is actually on screen (several views
            // may stay mounted while one is hidden).
            if (node.getClientRects().length > 0) return value
            fallback ??= value
          }
          return fallback
        } catch {
          return undefined
        }
      }

      // ------------------------------------------------------------ widget
      let widget = null
      /** Threshold notices already raised for this page, keyed by session + kind. */
      const toasted = new Set()

      function raiseNotices(status) {
        if (status === undefined) return
        for (const hit of status.prompts?.hits ?? []) {
          const key = `${status.id}:${hit.kind}:${hit.threshold}`
          if (toasted.has(key)) continue
          toasted.add(key)
          const label = hit.kind === 'rounds'
            ? `已经 ${hit.value} 轮（提示阈值 ${hit.threshold} 轮）`
            : hit.kind === 'percent'
              ? `上下文已用 ${Math.round(hit.value * 100)}%（提示阈值 ${Math.round(hit.threshold * 100)}%）`
              : `已压缩 ${hit.value} 次（提示阈值 ${hit.threshold} 次）`
          showToast(`交接提示：${label}。点输入框上方的「交接」，在新会话里接上。`, 'warn')
        }
      }

      /**
       * Mount the widget inside `conversation.composer.dock` — the composer's own
       * footer row (where the stats pills live). A slot entry rendered there is
       * part of the input's layout, so it cannot cover a message row or its
       * hover actions.
       *
       * The entry is deliberately HOOK-FREE: a hook-using entry crashed the
       * composer once (the bundle can resolve a second React copy, which leaves
       * hooks without a dispatcher), while a plain ref callback needs none.
       * @returns whether the slot accepted the registration.
       */
      function mountInDock() {
        const slots = ctx.get('slots')
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
        let React
        try {
          React = require('react')
        } catch {
          return false
        }
        if (typeof React?.createElement !== 'function') return false
        const Dock = () => React.createElement('span', {
          style: { display: 'inline-flex', alignItems: 'center' },
          ref: (node) => {
            try {
              if (node === null) {
                widget.root.remove()
                return
              }
              widget.mode = 'dock'
              const root = widget.root
              root.dataset.mode = 'dock'
              root.style.position = 'relative'
              root.style.left = ''
              root.style.right = ''
              root.style.bottom = ''
              node.appendChild(root)
            } catch (error) {
              console.warn('dsh-auto-handoff: composer dock attach failed', error)
            }
          },
        })
        try {
          slots.inject('conversation.composer.dock', () =>
            slots.register({ name: 'conversation.composer.dock', id: 'auto-handoff', order: 20 }, Dock))
          return true
        } catch (error) {
          console.warn('dsh-auto-handoff: composer dock registration failed', error)
          return false
        }
      }

      function mountWidget() {
        try {
          widget = createWidget()
          widget.handoff.addEventListener('click', async () => {
            const sessionId = widget.sessionId ?? domSessionId()
            if (sessionId === undefined) {
              flash(widget, '会话未就绪，稍后再试', 'warn')
              return
            }
            widget.handoff.disabled = true
            // Immediate feedback: producing the document can take seconds, and a
            // silent button reads as "nothing happened".
            flash(widget, '交接中…', 'idle', true, 30000)
            try {
              const { ok, payload } = await postJson(QUEUE_ENDPOINT, { sessionId })
              if (ok && payload?.ok === true && typeof payload?.newSessionId === 'string') {
                flash(widget, '已交接 · 正在切换…', 'idle', false, 4000)
                // Navigate directly — do not wait for the poller (it may not know
                // which session the user is looking at yet).
                openFresh(payload.newSessionId)
                void takePending(sessionId).catch(() => {})
                showToast(handoffCostText(payload))
              } else if (payload?.queued === true) {
                flash(widget, '已排队 · 等当前轮结束', 'warn', false, 12000)
              } else {
                const reason = payload?.error?.message ?? '未知原因'
                const tone = payload?.error?.code === 'goal-active' ? 'warn' : 'error'
                flash(widget, `交接失败：${reason}`, tone)
                showToast(`交接失败：${reason}`, tone === 'warn' ? 'warn' : 'error')
              }
            } catch (error) {
              flash(widget, `交接失败：${String(error)}`, 'error')
            } finally {
              widget.handoff.disabled = false
            }
          })
          widget.gear.addEventListener('click', () => {
            toggleThresholdEditor(widget, async config => {
              try {
                const { ok, payload } = await postJson(UI_CONFIG_ENDPOINT, config)
                if (!ok) return { ok: false, error: payload?.error?.message ?? 'HTTP 错误' }
                void refresh()
                return { ok: true }
              } catch (error) {
                return { ok: false, error: String(error) }
              }
            })
          })

          // Preferred: the composer's own dock row (same row as the stats pills).
          if (mountInDock()) {
            // Safety net: if the composer (or our node) is not on screen shortly
            // after registering, treat the dock mount as misbehaved and fall
            // back to the floating bar instead of leaving a broken footer.
            setTimeout(() => {
              try {
                if (widget === null) return
                if (widget.mode === 'dock' && widget.root.isConnected && composerCard() !== null) return
                widget.root.remove()
                widget.mode = 'float'
                widget.placed = ''
                document.body.appendChild(widget.root)
                positionWidget(widget)
                if (typeof widget.onResize !== 'function') {
                  widget.onResize = () => { widget.placed = ''; positionWidget(widget) }
                  window.addEventListener('resize', widget.onResize)
                }
              } catch { /* best-effort recovery */ }
            }, 1500)
            return true
          }

          // Fallback: floating bar, LEFT-aligned above the input card so the
          // edit/delete actions at a message row's right end stay reachable.
          widget.mode = 'float'
          document.body.appendChild(widget.root)
          positionWidget(widget)
          widget.onResize = () => { widget.placed = ''; positionWidget(widget) }
          window.addEventListener('resize', widget.onResize)
          return true
        } catch (error) {
          console.warn('dsh-auto-handoff: composer widget unavailable', error)
          return false
        }
      }

      /**
       * One poll: read the host's view of the visible session, paint the widget,
       * and follow a navigation record when there is one.
       *
       * Navigation is only followed for a session this tab did not already hand
       * off into; `navigationAttempts` bounds the wait for the fresh session to
       * appear in the list feed.
       */
      let navigationAttempts = 0
      let navigationTarget

      async function refresh() {
        const current = domSessionId()
        if (current === undefined) {
          renderWidget(widget, undefined)
          return
        }
        if (widget !== null) {
          widget.sessionId = current
          positionWidget(widget)
        }
        let payload = null
        try {
          const response = await fetch(`${STATUS_ENDPOINT}?sessionId=${encodeURIComponent(current)}`)
          if (response.ok) payload = await response.json()
        } catch { /* transient transport failures retry on the next tick */ }

        if (widget !== null && payload !== null) {
          // Deployments may switch the widget off (`uiEnabled: false`) and keep
          // only the HTTP surface / `/handoff`.
          const uiEnabled = payload?.ui?.enabled !== false
          widget.root.style.display = uiEnabled ? '' : 'none'
          if (uiEnabled) {
            // The widget-owned thresholds and the auto switch are top-level fields.
            widget.config = {
              rounds: payload?.prompts?.rounds,
              percent: payload?.prompts?.percent,
              compactions: payload?.prompts?.compactions,
              autoHandoff: payload?.autoHandoff === true,
            }
            renderWidget(widget, payload.session)
            raiseNotices(payload.session)
          }
        }

        // Never re-trigger for a session this tab already handed off into.
        if (current === lastOpened) return
        if (navigationTarget !== current) {
          navigationTarget = current
          navigationAttempts = 0
        }
        let navigation = payload?.navigation
        if (navigation === undefined) {
          // Older host half: the status payload has no navigation field, so ask
          // the dedicated (consuming) route instead — at most a couple of times.
          if (payload === null || navigationAttempts >= 6) return
          navigationAttempts += 1
          try {
            navigation = await takePending(current)
          } catch {
            navigation = null
          }
          if (navigation !== null && navigation !== undefined && openFresh(navigation.newSessionId)) {
            showToast(handoffCostText(navigation))
          }
          return
        }
        if (navigation === null || typeof navigation.newSessionId !== 'string') return
        if (openFresh(navigation.newSessionId)) {
          showToast(handoffCostText(navigation))
          // The record is delivered, never consumed by /status: clear it here so
          // it cannot replay after a later reload.
          void takePending(current).catch(() => {})
        }
      }

      ctx.effect(() => {
        let disposed = false
        let timer
        mountWidget()
        void refresh()
        const start = () => {
          if (timer !== undefined) return
          timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            void refresh()
            start()
          } else {
            stop()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        if (document.visibilityState === 'visible') start()
        return () => {
          disposed = true
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
          if (widget !== null) {
            if (typeof widget.onResize === 'function') window.removeEventListener('resize', widget.onResize)
            widget.root.remove()
            widget = null
          }
        }
      }, 'dsh-auto-handoff: composer status widget')
    }

    exports.apply = apply
    exports.inject = ['sessions', 'uiWorkspace']
    return module.exports
  },
})
