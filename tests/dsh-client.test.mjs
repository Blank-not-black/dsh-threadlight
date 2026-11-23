import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const source = await readFile(new URL('../lib/dsh-client.js', import.meta.url), 'utf8')

// The Client bundle is served as written, with no build step, so its wiring is
// checked against a minimal React runtime: function components render once
// (and again after a state setter) with real hook order, while effects stay
// inert because the browser owns their scheduling.
function mountRuntime() {
  const instances = new Map()
  let current = null
  let dirty = false

  function createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  }

  function hookSlot(initial) {
    const instance = current
    const index = instance.index++
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    return { instance, index }
  }

  function useState(initial) {
    const { instance, index } = hookSlot(initial)
    return [instance.hooks[index], next => {
      const value = typeof next === 'function' ? next(instance.hooks[index]) : next
      if (value === instance.hooks[index]) return
      instance.hooks[index] = value
      dirty = true
    }]
  }

  // Hooks are positional: a stub that never runs still keeps the index aligned.
  function useEffect() { current.index++ }

  function renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, path + '/' + index))
    const { type, props, children } = node
    if (typeof type === 'function') {
      const key = path + ':' + (type.name || 'component')
      let instance = instances.get(key)
      if (!instance) {
        instance = { hooks: [], index: 0 }
        instances.set(key, instance)
      }
      instance.index = 0
      const previous = current
      current = instance
      let output
      try {
        output = type(props)
      } finally {
        current = previous
      }
      return renderNode(output, key)
    }
    return { type, props, children: children.map((child, index) => renderNode(child, path + '/' + index)) }
  }

  function mount(element) {
    let tree
    const flush = () => {
      do {
        dirty = false
        tree = renderNode(element, 'root')
      } while (dirty)
    }
    flush()
    return {
      get tree() { return tree },
      rerender: flush,
    }
  }

  return { createElement, mount, React: { createElement, useState, useEffect } }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function find(node, predicate) {
  let found
  walk(node, candidate => {
    if (found === undefined && predicate(candidate)) found = candidate
  })
  return found
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

function loadPlugin() {
  const registrations = []
  const calls = []
  const storage = new Map()
  const runtime = mountRuntime()
  let factory

  const window = {
    __ModuleLoader__: { load(spec) { factory = spec.factory } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const document = { baseURI: 'http://dsh.test/' }
  vm.runInNewContext(source, {
    window, document, URL, URLSearchParams, console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: false }),
  }, { filename: 'lib/dsh-client.js' })

  assert.equal(typeof factory, 'function', 'the module loader receives a factory')
  const plugin = factory(id => {
    if (id === 'react') return runtime.React
    throw new Error('unexpected client module: ' + id)
  })
  assert.deepEqual([...plugin.inject], ['slots', 'layout'])

  const ctx = {
    slots: {
      inject(name, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    layout: {
      selectPanel(name) { calls.push({ type: 'selectPanel', name }) },
    },
  }
  plugin.apply(ctx)

  const registered = name => registrations.filter(entry => entry.options.name === name)
  return {
    storage, calls, runtime, registrations, registered,
    mount(Component, props) {
      return runtime.mount(runtime.createElement(Component, props))
    },
  }
}

const resultBlock = (extra, argsRaw) => ({
  phase: 'result', kind: 'tool-result', callId: 'call-1', name: 'threadlight_annotate',
  time: 0, turn: 1, step: 1, call: { name: 'threadlight_annotate', argsRaw: argsRaw ?? '{}' },
  callTime: 0, content: [], isError: false, subCalls: [], ...extra,
})

test('client bundle registers the panel, session header, chat cards and composer dock', () => {
  const plugin = loadPlugin()
  assert.equal(plugin.registered('main').length, 1)
  assert.equal(plugin.registered('main')[0].options.key, 'dsh-threadlight')
  assert.equal(plugin.registered('sidebar.panellist').length, 1)
  assert.equal(plugin.registered('sidebar.panellist')[0].options.id, 'dsh-threadlight')
  assert.equal(plugin.registered('conversation.session.header.actions').length, 1)
  assert.deepEqual(plugin.registered('tool.call.toolview').map(entry => entry.options.key).sort(),
    ['threadlight_annotate', 'threadlight_export', 'threadlight_graph'])
  const dock = plugin.registered('conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].options.id, 'threadlight')
  assert.equal(dock[0].options.order, 2)
  assert.equal(typeof dock[0].options.inject, 'function')
  assert.deepEqual({ ...dock[0].options.inject('session-1') }, { sessionId: 'session-1' })
})

test('the header action remembers the session and opens the annotation inbox', () => {
  const plugin = loadPlugin()
  const HeaderAction = plugin.registered('conversation.session.header.actions')[0].Component
  const app = plugin.mount(HeaderAction, { sessionId: 'session-1' })
  const button = find(app.tree, node => node.type === 'button')
  assert.equal(button.props['aria-label'], 'Threadlight 批注箱')
  button.props.onClick()
  assert.deepEqual(plugin.calls.at(-1), { type: 'selectPanel', name: 'dsh-threadlight' })
  assert.equal(plugin.storage.get('threadlight.session'), 'session-1')

  const Panel = plugin.registered('main')[0].Component
  const panel = plugin.mount(Panel, {})
  const iframe = find(panel.tree, node => node.type === 'iframe')
  assert.match(iframe.props.src, /session=session-1/)
  assert.match(iframe.props.src, /view=notes/)
})

test('annotate cards show the receipt, expand the durable output and open the inbox', () => {
  const plugin = loadPlugin()
  const ToolCard = plugin.registered('tool.call.toolview')
    .find(entry => entry.options.key === 'threadlight_annotate').Component
  plugin.storage.set('threadlight.session', 'other-session')
  const app = plugin.mount(ToolCard, {
    sessionId: 'card-session',
    block: resultBlock({
      content: [{ type: 'text', text: '已记录 1 条批注到 .threadlight/annotations/checkout/。' }],
    }, JSON.stringify({ group: 'checkout', target: { kind: 'group' }, text: '结算按钮应该显示预估运费。' })),
  })
  assert.equal(find(app.tree, node => node.props?.['data-state'] === 'ok') !== undefined, true)
  const initial = textOf(app.tree)
  assert.match(initial, /Threadlight 批注/)
  assert.match(initial, /已记入批注箱/)
  assert.match(initial, /结算按钮应该显示预估运费/)
  assert.doesNotMatch(initial, /annotations\/checkout/) // collapsed until asked for details

  const row = find(app.tree, node => node.props?.['data-expandable'] !== undefined)
  row.props.onClick()
  app.rerender()
  const expanded = textOf(app.tree)
  assert.match(expanded, /annotations\/checkout/)
  const action = find(app.tree, node => node.type === 'button' && node.props.className === 'tl-chat-action')
  action.props.onClick({ stopPropagation() {} })
  assert.deepEqual(plugin.calls.at(-1), { type: 'selectPanel', name: 'dsh-threadlight' })
  assert.equal(plugin.storage.get('threadlight.session'), 'card-session')

  const Panel = plugin.registered('main')[0].Component
  const panel = plugin.mount(Panel, {})
  const iframe = find(panel.tree, node => node.type === 'iframe')
  assert.match(iframe.props.src, /session=card-session/)
  assert.match(iframe.props.src, /view=notes/)
})

test('graph cards follow the requested view and surface failures in the error tone', () => {
  const plugin = loadPlugin()
  const ToolCard = plugin.registered('tool.call.toolview')
    .find(entry => entry.options.key === 'threadlight_graph').Component

  const running = plugin.mount(ToolCard, {
    sessionId: 's', block: { phase: 'start', callId: 'c', name: 'threadlight_graph', time: 0, turn: 1, step: 1,
      argsRaw: JSON.stringify({ view: 'flow', group: 'orders', flow: 'checkout' }), subCalls: [] },
  })
  assert.match(textOf(running.tree), /线路 · orders \/ checkout/)

  const failed = plugin.mount(ToolCard, {
    sessionId: 's',
    block: resultBlock({
      name: 'threadlight_graph',
      call: { name: 'threadlight_graph', argsRaw: JSON.stringify({ view: 'step', group: 'orders', step: 'submit' }) },
      content: [{ type: 'text', text: '当前图谱中找不到这个模块。' }],
      isError: true, error: { name: 'Error', code: 'NOT_FOUND' },
    }),
  })
  const text = textOf(failed.tree)
  assert.match(text, /当前图谱中找不到这个模块。/)
  assert.match(text, /失败/)
  assert.equal(find(failed.tree, node => node.props?.['data-state'] === 'error') !== undefined, true)
})

test('export cards keep a compact running receipt and no expandable output', () => {
  const plugin = loadPlugin()
  const ToolCard = plugin.registered('tool.call.toolview')
    .find(entry => entry.options.key === 'threadlight_export').Component
  const running = plugin.mount(ToolCard, {
    sessionId: 's', block: { phase: 'preparing', callId: 'c', name: 'threadlight_export', time: 0, turn: 1, step: 1, subCalls: [] },
  })
  assert.match(textOf(running.tree), /导出到 Obsidian/)
  assert.equal(find(running.tree, node => node.props?.['data-expandable'] !== undefined), undefined)
  const done = plugin.mount(ToolCard, {
    sessionId: 's',
    block: resultBlock({ name: 'threadlight_export', call: { name: 'threadlight_export', argsRaw: '' },
      content: [{ type: 'text', text: '导出完成：.threadlight/obsidian/' }] }),
  })
  assert.match(textOf(done.tree), /已导出到 Obsidian/)
})

test('the composer dock stays hidden until a workspace summary arrives', () => {
  const plugin = loadPlugin()
  const dock = plugin.registered('conversation.composer.dock')[0]
  const app = plugin.mount(dock.Component, { sessionId: 'session-1' })
  // Effects are inert here, so the pill has no summary and renders nothing.
  assert.equal(app.tree, null)
})
