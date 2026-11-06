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
    /**
     * Colour tokens per prompt level. Priority is compactions > rounds >
     * occupancy, so the levels map to red > amber > blue.
     */
    const LEVEL_COLORS = { ok: '', warn: '#f5a524', alert: '#e5484d', info: '#4d9fff' }

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

    /** Raise one toast in the top-right corner so it never covers the composer. */
    function showToast(text) {
      try {
        const toast = document.createElement('div')
        toast.textContent = text
        toast.style.cssText = [
          'position:fixed', `right:${composerRightOffset()}px`, 'top:72px', 'z-index:9999',
          'max-width:380px', 'padding:10px 14px', 'border-radius:10px',
          'background:rgba(28,32,38,.96)', 'color:#fff', 'font-size:13px',
          'line-height:1.5', 'box-shadow:0 6px 24px rgba(0,0,0,.3)', 'cursor:pointer',
        ].join(';')
        toast.title = '点击关闭'
        toast.addEventListener('click', () => toast.remove())
        document.body.appendChild(toast)
        setTimeout(() => toast.remove(), 8000)
      } catch { /* notification is best-effort */ }
    }

    /** Mounting hook: the widget is plain DOM so one implementation serves both mounts. */
    function createWidget() {
      const root = document.createElement('div')
      root.setAttribute('data-dsh-auto-handoff', '')
      // Base surface; the mount decides the positioning (dock row vs floating).
      root.style.cssText = [
        'display:inline-flex', 'align-items:center', 'gap:6px', 'z-index:40',
        'padding:4px 6px', 'border-radius:12px',
        'border:1px solid rgba(127,127,127,.28)',
        'background:rgba(24,28,34,.82)', 'backdrop-filter:blur(8px)',
        'color:#e8eaed', 'font-size:12px', 'line-height:1',
        'box-shadow:0 6px 20px rgba(0,0,0,.22)',
      ].join(';')

      const pill = document.createElement('span')
      pill.textContent = '交接 · 等待状态…'
      pill.style.cssText = 'padding:3px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.35);white-space:nowrap;font-variant-numeric:tabular-nums'

      const handoff = document.createElement('button')
      handoff.type = 'button'
      handoff.textContent = '交接'
      handoff.title = '把当前会话压缩成交接文档，在新会话里继续（当前轮到一半时会排队到轮次结束）'
      handoff.style.cssText = 'padding:3px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;font:inherit'

      const gear = document.createElement('button')
      gear.type = 'button'
      gear.textContent = '⚙'
      gear.title = '交接提示阈值'
      gear.style.cssText = 'padding:2px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;font:inherit'

      root.append(pill, handoff, gear)
      return {
        root,
        pill,
        handoff,
        gear,
        panel: null,
        mode: 'float',
        sessionId: undefined,
        config: undefined,
        lastStatus: undefined,
        placed: '',
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

    /** Render one status payload (or a placeholder) into the widget. */
    function renderWidget(widget, status) {
      if (widget === null) return
      if (status === undefined) {
        widget.pill.textContent = '交接 · 未就绪'
        return
      }
      const percent = status.occupancy?.known === true
        ? `${Math.round(status.occupancy.ratio * 100)}%`
        : '占用未知'
      // Priority order: compactions > rounds > occupancy.
      let text = `压缩 ${status.compactions} · ${status.turns} 轮 · ${percent}`
      if (status.queued === true) text += ' · 已排队'
      widget.pill.textContent = text
      const color = LEVEL_COLORS[status.prompts?.level ?? 'ok'] ?? ''
      widget.pill.style.borderColor = color === '' ? 'rgba(127,127,127,.35)' : color
      widget.pill.style.color = color === '' ? 'inherit' : color
      // An autonomous goal keeps driving this session: say so BEFORE the click,
      // instead of only refusing it in the response.
      widget.handoff.title = status.goal === 'active'
        ? '该会话正在执行 goal：先暂停或完成 goal 再交接（否则旧会话会继续跑）'
        : '把当前会话压缩成交接文档，在新会话里继续（当前轮到一半时会排队到轮次结束）'
      widget.lastStatus = status
    }

    /** Toggle the inline threshold editor, creating it on first use. */
    function toggleThresholdEditor(widget, onSave) {
      if (widget.panel !== null) {
        widget.panel.remove()
        widget.panel = null
        return
      }
      // Thresholds live on the top-level `prompts` of the status payload; the
      // per-session `prompts` object only carries this session's hits/level.
      const config = widget.config ?? {}
      const panel = document.createElement('div')
      panel.style.cssText = [
        'position:absolute', 'right:0', 'bottom:calc(100% + 8px)', 'z-index:9998',
        'display:grid', 'gap:8px', 'padding:12px', 'min-width:240px',
        'border-radius:12px', 'border:1px solid rgba(127,127,127,.35)',
        'background:rgba(28,32,38,.98)', 'color:#fff', 'font-size:12px',
        'box-shadow:0 10px 32px rgba(0,0,0,.35)',
      ].join(';')

      const row = (label, input) => {
        const line = document.createElement('label')
        line.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px'
        const span = document.createElement('span')
        span.textContent = label
        input.style.cssText = 'width:72px;padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.25);background:transparent;color:inherit;font:inherit'
        line.append(span, input)
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
      autoLine.style.cssText = 'display:flex;align-items:center;gap:8px;opacity:.9'
      const auto = document.createElement('input')
      auto.type = 'checkbox'
      auto.checked = config.autoHandoff === true
      const autoText = document.createElement('span')
      autoText.textContent = '自动交接（不推荐）'
      autoLine.append(auto, autoText)

      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = '保存'
      save.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:inherit;cursor:pointer;font:inherit;justify-self:end'
      const hint = document.createElement('div')
      hint.textContent = '到阈值时只提示，不会自动切换会话。'
      hint.style.cssText = 'opacity:.65;line-height:1.4'

      save.addEventListener('click', async () => {
        save.disabled = true
        const result = await onSave({
          promptRounds: Number(rounds.value) || 0,
          promptPercent: Math.max(0, Math.min(100, Number(percent.value) || 0)) / 100,
          promptCompactions: Number(compactions.value) || 0,
          autoHandoff: auto.checked,
        })
        save.disabled = false
        hint.textContent = result.ok ? '已保存。' : `保存失败：${result.error ?? '未知错误'}`
      })

      panel.append(
        row('轮数提示', rounds),
        row('占用提示（%）', percent),
        row('压缩次数提示', compactions),
        autoLine,
        save,
        hint,
      )
      widget.root.appendChild(panel)
      widget.panel = panel
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
          showToast(`交接提示：${label}。点输入框上方的「交接」，在新会话里接上。`)
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
              widget.pill.textContent = '交接：会话未就绪，稍后再试'
              return
            }
            widget.handoff.disabled = true
            // Immediate feedback: producing the document can take seconds, and a
            // silent button reads as "nothing happened".
            const previous = widget.pill.textContent
            widget.pill.textContent = '交接中…'
            try {
              const { ok, payload } = await postJson(QUEUE_ENDPOINT, { sessionId })
              if (ok && payload?.ok === true && typeof payload?.newSessionId === 'string') {
                widget.pill.textContent = '已交接 · 正在切换…'
                // Navigate directly — do not wait for the poller (it may not know
                // which session the user is looking at yet).
                openFresh(payload.newSessionId)
                void takePending(sessionId).catch(() => {})
                showToast(handoffCostText(payload))
              } else if (payload?.queued === true) {
                widget.pill.textContent = '已排队 · 等当前轮结束'
              } else {
                widget.pill.textContent = `交接失败：${payload?.error?.message ?? '未知原因'}`
                showToast(`交接失败：${payload?.error?.message ?? '未知原因'}`)
                setTimeout(() => { if (widget !== null) widget.pill.textContent = previous }, 6000)
              }
            } catch (error) {
              widget.pill.textContent = `交接失败：${String(error)}`
              setTimeout(() => { if (widget !== null) widget.pill.textContent = previous }, 6000)
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
