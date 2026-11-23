window.__ModuleLoader__.load({
  id: 'dsh-threadlight',
  factory(require) {
    const { createElement, useEffect, useState } = require('react')
    const panel = 'dsh-threadlight'
    const storageKey = 'threadlight.session'

    // The conversation header reports the on-screen session here, so the panel
    // can open that project without the iframe knowing any host state.
    function stored() {
      try { return window.localStorage.getItem(storageKey) || undefined } catch { return undefined }
    }

    let sessionId = stored()
    let showNotes = false
    const listeners = new Set()

    function snapshot() {
      return (sessionId ?? '') + '|' + (showNotes ? '1' : '0')
    }

    function emit() {
      for (const listener of listeners) listener()
    }

    function setSession(next) {
      if (typeof next !== 'string' || !next || next === sessionId) return
      sessionId = next
      try { window.localStorage.setItem(storageKey, next) } catch {}
      emit()
    }

    function openPanel(notes) {
      if (showNotes !== notes) {
        showNotes = notes
        emit()
      }
    }

    function useTarget() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => {
        const listener = () => setValue(snapshot())
        listeners.add(listener)
        setValue(snapshot())
        return () => listeners.delete(listener)
      }, [])
      return value
    }

    function threadlightUrl() {
      const query = new URLSearchParams()
      if (sessionId) query.set('session', sessionId)
      if (showNotes) query.set('view', 'notes')
      const suffix = query.toString()
      return new URL('threadlight/' + (suffix ? '?' + suffix : ''), document.baseURI).href
    }

    function ReviewPanel() {
      // A changed target remounts the iframe, which is how it reloads the page.
      const key = useTarget()
      return createElement('iframe', {
        title: 'Threadlight 项目图谱',
        key,
        src: threadlightUrl(),
        style: { display: 'block', width: '100%', height: '100%', border: 'none' },
      })
    }

    function ThreadlightIcon({ size = 18 }) {
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.65, 'aria-hidden': true,
      }, createElement('path', { d: 'M12 8v4m0 0H6v4m6-4h6v4' }),
      createElement('rect', { x: 8.5, y: 3, width: 7, height: 5, rx: 1.2 }),
      createElement('rect', { x: 2.5, y: 16, width: 7, height: 5, rx: 1.2 }),
      createElement('rect', { x: 14.5, y: 16, width: 7, height: 5, rx: 1.2 }))
    }

    // ---------------------------------------------------------------------
    // Chat integration
    //
    // Tool calls carry a durable card: the threadlight_* tools log their
    // receipt in the session, and this bundle renders it in the transcript
    // instead of the generic JSON row. Long results expand in place.
    // ---------------------------------------------------------------------

    const cardStyles = [
      '.tl-chat{--tl-ok:var(--dsw-alias-state-success-primary,#2f8f5b);--tl-bad:var(--dsw-alias-state-error-primary,#c4432b);',
      '--tl-warn:var(--dsw-alias-state-warn-label,#9a6b12);display:flex;flex-direction:column;min-width:0;',
      'color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.tl-chat-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:24px;min-width:0;',
      'line-height:calc(24px + var(--dsh-content-font-delta,0px));padding:0 2px;border-radius:var(--dsw-radius-sm);text-align:left}',
      '.tl-chat-row[data-expandable]{cursor:pointer}',
      '.tl-chat-row[data-expandable]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.tl-chat-row:focus-visible{outline:1px solid var(--dsw-alias-label-secondary,currentColor);outline-offset:1px}',
      '.tl-chat-glyph{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center}',
      '.tl-chat-glyph svg{width:14px;height:14px}',
      '.tl-chat[data-state=running] .tl-chat-glyph{animation:tl-chat-pulse 1.6s ease-in-out infinite}',
      '.tl-chat-title{flex:none;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.tl-chat-sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption,currentColor);opacity:.6}',
      '.tl-chat-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tl-chat[data-state=error] .tl-chat-summary{color:var(--tl-bad)}',
      '.tl-chat[data-state=stopped] .tl-chat-summary{color:var(--tl-warn)}',
      '.tl-chat-state{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,currentColor)}',
      '.tl-chat[data-state=error] .tl-chat-state{color:var(--tl-bad)}',
      '.tl-chat[data-state=stopped] .tl-chat-state{color:var(--tl-warn)}',
      '.tl-chat-body{display:flex;flex-direction:column;gap:6px;margin:2px 0 4px 22px}',
      '.tl-chat-output{box-sizing:border-box;max-height:280px;overflow:auto;margin:0;padding:8px 10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);',
      'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:1.55;',
      'white-space:pre-wrap;overflow-wrap:anywhere}',
      '.tl-chat[data-state=error] .tl-chat-output{border-color:var(--tl-bad)}',
      '.tl-chat-actions{display:flex;flex-wrap:wrap;gap:6px}',
      '.tl-chat-action{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));',
      'border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.tl-chat-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '@keyframes tl-chat-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.tl-chat[data-state=running] .tl-chat-glyph{animation:none}}',
    ].join('')

    const dockStyles = [
      '.tl-dock{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.tl-dock-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;',
      'border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);',
      'font:inherit;cursor:pointer;white-space:nowrap}',
      '.tl-dock-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary)}',
      '.tl-dock-pill:focus-visible{outline:1px solid var(--dsw-alias-label-secondary,currentColor);outline-offset:1px}',
      '.tl-dock-pill svg{width:14px;height:14px;flex:none}',
      '.tl-dock-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.tl-dock-pending{flex:none;color:var(--dsw-alias-state-warn-label,#9a6b12)}',
    ].join('')

    function toolArgs(block) {
      const raw = block?.phase === 'start' ? block.argsRaw : block?.phase === 'result' ? block.call?.argsRaw : ''
      if (typeof raw !== 'string' || raw === '') return {}
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      } catch { return {} }
    }

    function resultText(block) {
      if (block?.phase !== 'result') return null
      const parts = []
      for (const item of Array.isArray(block.content) ? block.content : []) {
        if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
        else parts.push(JSON.stringify(item, null, 2))
      }
      if (!parts.length && block.error) {
        parts.push([block.error.name, block.error.code, block.error.reason].filter(Boolean).join(': '))
      }
      const text = parts.join('\n').trim()
      return text === '' ? null : text
    }

    function firstLine(text) {
      const newline = text.indexOf('\n')
      return (newline === -1 ? text : text.slice(0, newline)).trim()
    }

    function clip(text, limit) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim()
      return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
    }

    function cardState(block) {
      if (block?.phase !== 'result') return 'running'
      if (block.error?.code === 'interrupted') return 'stopped'
      return block.isError ? 'error' : 'ok'
    }

    // One display model per threadlight_* tool. The receipt comes from the
    // durable call arguments and result text, so replay keeps the same card.
    function cardModel(name, block) {
      const args = toolArgs(block)
      const output = resultText(block)
      const state = cardState(block)
      const failed = state === 'error' && output ? firstLine(output) : null
      if (name === 'threadlight_annotate') {
        const text = typeof args.text === 'string' ? clip(args.text, 52) : undefined
        const summary = failed ?? (state === 'stopped' ? '已停止'
          : state === 'running' ? (text ?? '记录批注')
            : text ? '已记入批注箱 · ' + text : '已记入批注箱')
        return {
          title: 'Threadlight 批注', summary, output, state,
          action: '打开批注箱', notes: true,
        }
      }
      if (name === 'threadlight_graph') {
        const view = typeof args.view === 'string' ? args.view : 'overview'
        const target = view === 'flow' ? args.flow : view === 'step' ? args.step : view === 'search' ? args.term : ''
        const scope = typeof args.group === 'string' && target ? args.group + ' / ' + target : target
        const summary = failed ?? (state === 'stopped' ? '已停止'
          : view === 'search' ? '搜索 · ' + clip(target || '全部', 40)
            : view === 'flow' ? '线路 · ' + clip(scope || '—', 44)
              : view === 'step' ? '步骤 · ' + clip(scope || '—', 44)
                : view === 'overview' && state === 'running' && args.view === undefined ? '读取图谱' : '图谱概览')
        return { title: 'Threadlight 图谱', summary, output, state, action: '打开图谱', notes: false, detail: '' }
      }
      const summary = failed ?? (state === 'stopped' ? '已停止'
        : state === 'running' ? '导出到 Obsidian'
          : '已导出到 Obsidian')
      return { title: 'Threadlight 导出', summary, output, state, action: '打开图谱', notes: false, detail: '' }
    }

    function chatTarget(ctx, injected) {
      // Slot `inject` supplies the session for this row; the fallback keeps the
      // header action's stored target when a profile does not inject it.
      const active = typeof injected?.sessionId === 'string' && injected.sessionId ? injected.sessionId : sessionId
      return {
        open(notes) {
          if (active) setSession(active)
          openPanel(notes)
          try { ctx.layout.selectPanel(panel) } catch {}
        },
      }
    }

    function ToolCard(ctx, name) {
      return function ThreadlightToolCard(props) {
        // `notes` opens the annotation inbox; the card always has the panel target.
        const [open, setOpen] = useState(false)
        const model = cardModel(name, props.block)
        const expandable = model.output !== null
        const context = chatTarget(ctx, props)
        const toggle = () => { if (expandable) setOpen(value => !value) }
        const onKeyDown = event => {
          if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          toggle()
        }
        return createElement('div', {
          className: 'tl-chat', 'data-tool': name, 'data-state': model.state,
        },
        createElement('style', { key: 'styles', dangerouslySetInnerHTML: { __html: cardStyles } }),
        createElement('div', {
          key: 'row',
          className: 'tl-chat-row',
          'data-expandable': expandable ? '' : undefined,
          role: expandable ? 'button' : undefined,
          tabIndex: expandable ? 0 : undefined,
          'aria-expanded': expandable ? open : undefined,
          onClick: toggle,
          onKeyDown,
        },
        createElement('span', { key: 'glyph', className: 'tl-chat-glyph', 'aria-hidden': true },
          createElement(ThreadlightIcon, { size: 14 })),
        createElement('span', { key: 'title', className: 'tl-chat-title' }, model.title),
        createElement('span', { key: 'sep', className: 'tl-chat-sep', 'aria-hidden': true }),
        createElement('span', { key: 'summary', className: 'tl-chat-summary' }, model.summary),
        model.state === 'running' || model.state === 'ok' ? null
          : createElement('span', { key: 'state', className: 'tl-chat-state' }, model.state === 'stopped' ? '已停止' : '失败'),
        expandable ? createElement('span', { key: 'chevron', className: 'tl-chat-state', 'aria-hidden': true }, open ? '收起' : '详情') : null),
        open && expandable ? createElement('div', { key: 'body', className: 'tl-chat-body' },
          createElement('pre', { className: 'tl-chat-output' }, model.output),
          createElement('div', { className: 'tl-chat-actions' },
            createElement('button', {
              key: 'open', type: 'button', className: 'tl-chat-action',
              onClick: event => { event.stopPropagation(); context.open(model.notes) },
            }, model.action))) : null)
      }
    }

    // ---------------------------------------------------------------------
    // Composer dock pill
    //
    // One reading under the composer: the current project's graph size and how
    // many annotations are waiting for an agent. Clicking opens the matching
    // view; a session without a workspace graph shows nothing.
    // ---------------------------------------------------------------------

    const summaryCache = new Map()

    async function fetchSummary(id) {
      if (!id) return null
      const cached = summaryCache.get(id)
      if (cached && Date.now() - cached.at < 5000) return cached.value
      try {
        const url = new URL('threadlight/api/summary', document.baseURI)
        url.searchParams.set('session', id)
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) return null
        const value = await response.json()
        const summary = value && typeof value === 'object' ? value : null
        summaryCache.set(id, { at: Date.now(), value: summary })
        return summary
      } catch {
        return null
      }
    }

    function useSummary(id) {
      const [value, setValue] = useState(null)
      useEffect(() => {
        if (!id) return undefined
        let live = true
        const load = () => {
          fetchSummary(id).then(summary => { if (live) setValue(summary) }).catch(() => {})
        }
        load()
        const timer = setInterval(load, 20000)
        window.addEventListener('focus', load)
        return () => {
          live = false
          clearInterval(timer)
          window.removeEventListener('focus', load)
        }
      }, [id])
      return value
    }

    function ThreadlightDock(ctx) {
      return function ThreadlightComposerDock(props) {
        const summary = useSummary(props.sessionId)
        const context = chatTarget(ctx, props)
        const graph = summary?.graph
        if (!graph) return null
        const pending = summary.notes?.pending ?? 0
        const groups = Number.isFinite(graph.groups) ? graph.groups : 0
        const project = typeof graph.project === 'string' && graph.project ? graph.project : '项目'
        const label = pending > 0 ? pending + ' 条批注待处理' : project + ' · ' + groups + ' 模块'
        return createElement('span', { className: 'tl-dock' },
          createElement('style', { key: 'styles', dangerouslySetInnerHTML: { __html: dockStyles } }),
          createElement('button', {
            key: 'pill', type: 'button', className: 'tl-dock-pill',
            title: 'Threadlight · ' + (summary.workspace?.title ?? project) + (pending > 0 ? ' · 点击提交批注' : ' · 点击打开图谱'),
            'aria-label': 'Threadlight 项目图谱：' + label,
            onClick: () => context.open(pending > 0),
          },
          createElement(ThreadlightIcon, { size: 14 }),
          createElement('span', { className: 'tl-dock-label' }, 'Threadlight · ' + label),
          pending > 0 ? createElement('span', { key: 'pending', className: 'tl-dock-pending', 'aria-hidden': true }, '●') : null))
      }
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel }, ReviewPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panel, order: 1, label: () => 'Threadlight',
      }, ThreadlightIcon))

      // Session header action: records the session on screen and opens the
      // annotation inbox for that project. Own controls only; no host primitives.
      function HeaderAction(props) {
        const next = props?.sessionId
        useEffect(() => { setSession(next) }, [next])
        return createElement('button', {
          type: 'button',
          title: 'Threadlight 批注箱',
          'aria-label': 'Threadlight 批注箱',
          onClick: () => {
            setSession(next)
            openPanel(true)
            try { ctx.layout.selectPanel(panel) } catch {}
          },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0, border: '1px solid transparent',
            borderRadius: 6, background: 'transparent', color: 'inherit',
            cursor: 'pointer',
          },
        }, createElement(ThreadlightIcon, { size: 16 }))
      }

      try {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: panel,
          order: 10,
          registrant: panel,
          inject: id => ({ sessionId: id }),
        }, HeaderAction))
      } catch {}

      // Durable chat cards for the three model-facing tools. The slot is keyed
      // by wire tool name; unregistered tools keep the generic row, so a failed
      // registration here degrades to plain tool output only.
      for (const name of ['threadlight_graph', 'threadlight_annotate', 'threadlight_export']) {
        try {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: name,
            inject: id => ({ sessionId: id }),
          }, ToolCard(ctx, name)))
        } catch {}
      }

      // Ambient reading under the composer; the pill hides itself when the
      // session has no workspace graph, so other profiles see no empty row.
      try {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'threadlight',
          order: 2,
          inject: id => ({ sessionId: id }),
        }, ThreadlightDock(ctx)))
      } catch {}
    }

    return { inject: ['slots', 'layout'], apply }
  },
})
