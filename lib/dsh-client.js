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
    }

    return { inject: ['slots', 'layout'], apply }
  },
})
