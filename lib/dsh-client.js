window.__ModuleLoader__.load({
  id: 'dsh-threadlight',
  factory(require) {
    const { createElement } = require('react')
    const panel = 'dsh-threadlight'

    function ReviewPanel() {
      return createElement('iframe', {
        title: 'Threadlight 项目图谱',
        src: new URL('threadlight/', document.baseURI).href,
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
    }

    return { inject: ['slots', 'layout'], apply }
  },
})
