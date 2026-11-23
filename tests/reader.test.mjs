import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { parseGraph } from '../lib/graph.mjs'
import { renderReader } from '../lib/reader.mjs'

const [raw, reviewScript, notesScript] = await Promise.all([
  readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8'),
  readFile(new URL('../lib/dsh-review.js', import.meta.url), 'utf8'),
  readFile(new URL('../lib/dsh-notes.js', import.meta.url), 'utf8'),
])

function graphWithAreas() {
  const graph = JSON.parse(raw)
  graph.project.areas = [{ id: 'delivery', title: '交付' }, { id: 'empty', title: '扩展' }]
  graph.groups[0].area = 'delivery'
  const flow = graph.groups[0].flows[0]
  flow.nodes[1].sources = []
  flow.nodes[2].state = 'verified'
  flow.nodes[2].verification = [{ id: 'test', result: 'passed', at: '2026-01-01T00:00:00.000Z', summary: '校验通过' }]
  graph.groups[0].flows.push({ ...structuredClone(flow), id: 'sample', title: '另一条线路',
    nodes: flow.nodes.map(node => ({ ...node, title: '示例 ' + node.id, summary: '示例筛选词' })) })
  return parseGraph(JSON.stringify(graph))
}

function graphWithEvidence() {
  const graph = JSON.parse(raw)
  const node = graph.groups[0].flows[0].nodes[0]
  node.sources = [
    { path: 'lib/graph.mjs', kind: 'source', line: 10,
      anchor: { lineHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), unique: true, contextUnique: true },
      symbol: { kind: 'function', name: 'parseGraph', startLine: 10, endLine: 12 },
      preview: { startLine: 9, text: '// 校验\nexport function parseGraph() {}' } },
    { path: 'tests/graph.test.mjs', kind: 'test', status: 'needs-review' },
    { path: 'README.md', kind: 'documentation' },
  ]
  return parseGraph(JSON.stringify(graph))
}

// Run the shipped scripts with the DOM operations needed by the overview and review menu.
function loadOverview(graph, { review = false, clientHeight = 320, reply = () => ({ answer: 'test' }),
  confirm = () => true, view = '#overview', mobile = false } = {}) {
  const page = renderReader(graph, review ? { review: { workspace: 'test', digest: 'test', nonce: 'test' } } : {})
  let reviewCurrent, selection
  class Element {
    attributes = new Map()
    children = []
    dataset = {}
    style = { setProperty(key, value) { this[key] = value }, removeProperty(key) { delete this[key] } }
    listeners = new Map()
    textContent = ''
    value = ''
    nodeType = 1

    constructor(tagName) { this.tagName = tagName }
    get isConnected() { return document.contains(this) }
    get firstElementChild() { return this.children[0] }
    get nextElementSibling() {
      const siblings = this.parentElement?.children
      return siblings?.[siblings.indexOf(this) + 1] ?? null
    }
    get classList() {
      const classes = new Set((this.className ?? '').split(' ').filter(Boolean))
      const write = () => { this.className = [...classes].join(' ') }
      return {
        add: name => { classes.add(name); write() },
        remove: name => { classes.delete(name); write() },
        contains: name => classes.has(name),
        toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); write() },
      }
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value))
      if (name === 'class') this.className = value
    }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name) }
    toggleAttribute(name, force) {
      if (force) this.setAttribute(name, '')
      else this.removeAttribute(name)
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    }
    insertBefore(child, next) {
      child.remove()
      child.parentElement = this
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child)
    }
    append(...children) {
      for (const child of children) {
        const node = typeof child === 'string' ? Object.assign(new Element('#text'), { textContent: child }) : child
        this.insertBefore(node, null)
      }
    }
    prepend(...children) {
      const first = this.firstElementChild
      for (const child of children) this.insertBefore(child, first)
    }
    remove() {
      if (!this.parentElement) return
      const siblings = this.parentElement.children
      siblings.splice(siblings.indexOf(this), 1)
      this.parentElement = null
    }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove()
      this.append(...children)
    }
    getBoundingClientRect() {
      const [left, top, width, height] = ['left', 'top', 'width', 'height'].map(key => parseFloat(this.style[key]) || 0)
      return { left, top, width, height, right: left + width, bottom: top + height }
    }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some(name => this.matches(name.trim()))
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open
      const data = /^\[data-([a-z-]+)\]$/.exec(selector)
      if (data) return data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset
      if (selector.startsWith('.')) return (this.className ?? '').split(' ').includes(selector.slice(1))
      return this.tagName === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parentElement?.closest(selector)
    }
    contains(element) {
      return this === element || this.children.some(child => child.contains(element))
    }
    querySelectorAll(selector) {
      if (selector === ':scope > .tree-row[data-review-group]') {
        return this.children.filter(child => child.matches('.tree-row') && child.matches('[data-review-group]'))
      }
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] }
    dispatch(type, fields = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...fields }
      for (let element = this; element; element = element.parentElement) {
        event.currentTarget = element
        for (const listener of element.listeners.get(type) ?? []) listener(event)
      }
      return event
    }
    focus() {
      const previous = document.activeElement
      if (previous === this) return
      document.activeElement = this
      previous?.dispatch('focusout', { relatedTarget: this })
      this.dispatch('focusin', { relatedTarget: previous })
    }
    click() {
      if (this.disabled) return
      this.focus()
      this.dispatch('click', { detail: 1 })
    }
    press(key, modifiers) {
      const event = this.dispatch('keydown', { key, ...modifiers })
      if (!event.defaultPrevented) {
        if (key === 'Escape') this.closest('dialog[open]')?.close()
        if (this.tagName === 'button' && (key === 'Enter' || key === ' ')) this.dispatch('click')
      }
      return event
    }
    showModal() { this.open = true }
    close() { this.open = false; this.dispatch('close') }
    scrollIntoView(options) { this.lastScroll = options }
  }

  const document = new Element('#document')
  document.body = new Element('body')
  document.append(document.body)
  document.activeElement = document.body
  document.createElement = tag => new Element(tag)
  document.createElementNS = (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI })
  const ids = new Map()
  const tags = new Map(Array.from(page.matchAll(/<([\w-]+)\b[^>]*\sid="([^"]+)"/g), ([, tag, id]) => [id, tag]))
  function by(id) {
    if (!ids.has(id)) {
      const element = new Element(tags.get(id) ?? 'div')
      ids.set(id, element)
      document.body.append(element)
    }
    return ids.get(id)
  }
  document.getElementById = by
  by('header-actions').className = 'header-actions'
  by('overview-viewport').clientHeight = clientHeight
  by('overview-viewport').append(by('overview-tree'))
  by('overview-tree').append(by('overview-wires'))
  by('reader-dialog').append(by('dialog-title'), by('dialog-content'), by('dialog-close'))
  by('export-options').append(by('export-toggle'), by('export-png'), by('print-view'))
  by('data').textContent = page.match(/id="data">(.*?)<\/script>/s)[1]

  const location = { hash: view }
  const windowEvents = new Map()
  let printCount = 0
  const window = { addEventListener(type, listener) { windowEvents.set(type, listener) }, getSelection: () => selection,
    print() { printCount++; windowEvents.get('beforeprint')() } }
  const downloads = []
  document.addEventListener('click', ({ target }) => {
    if (target.download) downloads.push({ name: target.download, href: target.href })
  })
  const processRoutes = [], reviewRequests = []
  const captureReview = getCurrent => { reviewCurrent = getCurrent }
  const reviewSetup = review ? reviewScript + `
    const mountReview = window.ThreadlightReview.mount
    window.ThreadlightReview.mount = (data, getCurrent) => {
      captureReview(getCurrent)
      mountReview(data, getCurrent)
    }
  ` : ''
  const script = page.match(/<script(?: nonce="[^"]+")?>\s*(const data = .*?)<\/script>/s)[1]
  runInNewContext(reviewSetup + '\n' + script + `
    const renderCurrentProcess = renderProcess
    renderProcess = () => {
      processRoutes.push([current.key, selectedByFlow.get(current.key)])
      renderCurrentProcess()
    }
  `, {
    document, window, Element, Node: { ELEMENT_NODE: 1 }, location, processRoutes, captureReview,
    history: { pushState(_state, _title, hash) { location.hash = hash } },
    fetch(url, options) {
      const call = [url, JSON.parse(options.body ?? 'null'), options.method]
      reviewRequests.push(call)
      return Promise.resolve({ ok: true, json: async () => reply(...call) })
    },
    confirm,
    innerWidth: 800, innerHeight: 600, clearTimeout, AbortController, URLSearchParams,
    ResizeObserver: class { observe() {} },
    matchMedia: query => ({ matches: mobile && query === '(max-width: 650px)', addEventListener() {} }),
    getComputedStyle: element => ({ getPropertyValue: key => element.style[key] ?? '',
      color: element.matches('.overview-wire')
        ? (element.matches('.expanded, .focused') ? 'rgb(141, 209, 173)' : 'rgb(53, 62, 57)') : 'rgb(233, 238, 234)',
      backgroundColor: 'rgb(29, 32, 34)',
      borderTopColor: 'rgb(53, 62, 57)', fontFamily: '"Microsoft YaHei UI", sans-serif', fontSize: '13.5px', fontWeight: '640',
      strokeWidth: '1.25px' }),
  })
  const visible = () => by('overview-tree').querySelectorAll('.overview-position')
  const cards = () => visible().map(position => position.firstElementChild)
  const kinds = () => cards().map(card => card.dataset.kind)
  const wires = () => by('overview-wires').querySelectorAll('path')
  const filter = value => {
    const input = by('overview-search')
    input.value = value
    input.dispatch('input')
  }
  return { by, document, visible, cards, kinds, wires, filter, focused: () => document.activeElement, location, processRoutes,
    downloads, printCount: () => printCount,
    reviewCurrent, reviewRequests, reviewMenu: () => document.querySelector('.review-menu'),
    reviewDialog: () => document.querySelector('.review-dialog'),
    goToOverview() { location.hash = '#overview'; windowEvents.get('hashchange')() },
    select(element, text = element.textContent) {
      selection = { isCollapsed: false, anchorNode: element, focusNode: element, toString: () => text }
    },
  }
}

// Run the shipped annotation inbox script against the fake DOM and record the
// host calls it makes. `handle` can override a response (for example a failure).
async function openNotesInbox(notes, { confirm: confirmAnswer = () => true, handle } = {}) {
  const { by, document } = loadOverview(graphWithAreas())
  by('notes-context').textContent = JSON.stringify({ workspace: 'inbox', digest: 'current', project: '示例', maxSelection: 100 })
  const stamp = '2026-11-23T08:00:00.000Z'
  const calls = []
  const stored = new Map(notes.map(note => [note.id, { ...note }]))
  runInNewContext(notesScript, {
    document, URLSearchParams, confirm: confirmAnswer,
    async fetch(url, options) {
      if (url.startsWith('api/agent-presets')) return { ok: true, json: async () => ({ unavailable: true }) }
      const method = options.method ?? 'GET'
      const body = options.body ? JSON.parse(options.body) : null
      calls.push([url, method, body, options.headers])
      const custom = handle ? await handle({ url, method, body, stored }) : null
      if (custom) return custom
      if (method === 'GET') return { ok: true, json: async () => ({ notes: [...stored.values()] }) }
      if (method === 'PATCH') {
        const note = { ...stored.get(body.id) }
        if (body.resolved === true) note.resolvedAt = stamp
        else if (body.resolved === false) delete note.resolvedAt
        if (typeof body.text === 'string') note.text = body.text
        note.updatedAt = stamp
        stored.set(note.id, note)
        return { ok: true, json: async () => ({ note }) }
      }
      stored.delete(body.id)
      return { ok: true, json: async () => ({ deleted: true }) }
    },
  })
  await setImmediate()
  const control = (row, label) => row.querySelectorAll('button').find(button => button.textContent === label)
  return { by, document, calls, control }
}

const center = rect => rect.top + rect.height / 2
const expanded = element => element.getAttribute('aria-expanded')

test('five-level overview renders only the project and areas by default and keeps the project in view', () => {
  const { by, cards, kinds, wires, visible } = loadOverview(graphWithAreas())
  assert.deepEqual(kinds(), ['project', 'area', 'area'])
  assert.equal(by('overview-count').textContent, '2 个领域 · 1 个功能区 · 2 条线路')
  assert.deepEqual(cards().map(expanded), ['true', 'false', null])
  assert.equal(wires().length, 2)
  assert.ok(cards().every(card => card.tagName === 'button'))

  const tallGraph = graphWithAreas()
  tallGraph.project.areas.push(...Array.from({ length: 8 }, (_, index) => ({ id: 'area-' + index, title: '测试 ' + index })))
  const tall = loadOverview(tallGraph, { clientHeight: 220 })
  const project = tall.visible()[0].getBoundingClientRect()
  const viewport = tall.by('overview-viewport')
  assert.ok(viewport.scrollTop > 0)
  assert.ok(project.top >= viewport.scrollTop && project.bottom <= viewport.scrollTop + viewport.clientHeight)
  const [root, firstArea, lastArea] = visible().map(position => position.getBoundingClientRect())
  assert.equal(center(root), (center(firstArea) + center(lastArea)) / 2)
})

test('expanding and collapsing cards lays out columns, keeps sibling order and redraws SVG connections', () => {
  const { by, cards, visible, kinds, wires, focused } = loadOverview(graphWithAreas())
  const area = cards()[1]
  area.click()
  assert.equal(focused(), area)
  assert.equal(expanded(area), 'true')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'area'])
  assert.equal(wires().length, 3)
  const group = cards()[2]
  group.focus()
  group.press('Enter')
  assert.equal(expanded(group), 'true')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'flow', 'flow', 'area'])
  assert.equal(wires().length, 5)
  const flowToggle = visible()[3].querySelector('.overview-flow-toggle')
  assert.equal(flowToggle.firstElementChild.textContent, '3')
  assert.equal(expanded(flowToggle), 'false')
  flowToggle.focus()
  flowToggle.press(' ')
  assert.equal(expanded(flowToggle), 'true')
  assert.equal(focused(), flowToggle)
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'flow', 'step', 'step', 'step', 'flow', 'area'])
  assert.equal(wires().length, visible().length - 1)
  assert.equal(wires().filter(wire => wire.matches('.focused')).length, 3)

  const [project, delivery, module, flow, first, second, third, otherFlow, otherArea] =
    visible().map(position => position.getBoundingClientRect())
  assert.equal(delivery.left, otherArea.left)
  assert.equal(flow.left, otherFlow.left)
  assert.equal(first.left, second.left)
  assert.equal(first.left, third.left)
  const columns = [project, delivery, module, flow, first]
  assert.ok(columns.slice(1).every((rect, index) => rect.left > columns[index].right))
  assert.ok(first.bottom < second.top && second.bottom < third.top && third.bottom < otherFlow.top)
  assert.equal(center(flow), (center(first) + center(third)) / 2)
  assert.equal(center(module), (center(flow) + center(otherFlow)) / 2)
  assert.ok(by('overview-tree').getBoundingClientRect().right > first.right)
  assert.ok(by('overview-tree').getBoundingClientRect().bottom > otherArea.bottom)

  const flowWire = wires().find(wire => wire.getAttribute('d').endsWith(flow.left + ' ' + center(flow)))
  assert.equal(flowWire.namespaceURI, 'http://www.w3.org/2000/svg')
  const bend = (module.right + flow.left) / 2
  assert.equal(flowWire.getAttribute('d'), `M${module.right} ${center(module)} C${bend} ${center(module)} ${bend} ${center(flow)} ${flow.left} ${center(flow)}`)
  const stepDots = cards().filter(card => card.dataset.kind === 'step').map(card => card.querySelector('.overview-state'))
  assert.deepEqual(stepDots.map(dot => [dot.className, dot.title]), [
    ['overview-state implemented', '有实现依据'], ['overview-state planned', '计划'], ['overview-state verified', '已实际验证'],
  ])

  const oldCurve = flowWire.getAttribute('d')
  flowToggle.click()
  assert.equal(expanded(flowToggle), 'false')
  assert.equal(wires().length, 5)
  assert.notEqual(flowWire.getAttribute('d'), oldCurve)
  area.click()
  assert.deepEqual(kinds(), ['project', 'area', 'area'])
  assert.equal(wires().length, 2)
})

test('offline overview renders four levels for old graphs and routes flow and step clicks', () => {
  const { by, cards, visible, kinds, wires, focused, location, processRoutes, goToOverview } = loadOverview(parseGraph(raw))
  assert.deepEqual(kinds(), ['project', 'group'])
  assert.equal(by('overview-count').textContent, '1 个功能区 · 1 条线路')
  cards()[1].click()
  visible()[2].querySelector('.overview-flow-toggle').click()
  assert.deepEqual(kinds(), ['project', 'group', 'flow', 'step', 'step', 'step'])
  assert.equal(new Set(visible().map(node => node.style.left)).size, 4)
  assert.equal(wires().length, 5)
  assert.equal(cards()[3].querySelector('strong').dataset.reviewText, undefined)
  assert.equal(location.hash, '#overview')
  cards()[2].click()
  assert.equal(location.hash, '#export/obsidian')
  assert.deepEqual([...processRoutes[0]], ['export/obsidian', undefined])
  goToOverview()
  assert.equal(by('overview-panel').hidden, false)
  cards()[3].focus()
  cards()[3].press('Enter')
  assert.equal(location.hash, '#step/export/obsidian/validate')
  assert.deepEqual([...processRoutes[1]], ['export/obsidian', 'validate'])
  assert.equal(focused(), by('title'))
})

test('search expands the path to matches, highlights direct hits and restores manual expansion when cleared', () => {
  const { by, cards, kinds, wires, filter, location } = loadOverview(graphWithAreas())
  cards()[1].click()
  filter('示例筛选词')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'flow', 'step', 'step', 'step'])
  assert.equal(wires().length, 6)
  assert.equal(cards()[3].dataset.overviewFlow, 'export/sample')
  assert.deepEqual(cards().filter(card => card.getAttribute('data-match') !== null), cards().slice(4))
  filter('读取并验证图谱')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'flow', 'step'])
  assert.equal(cards()[3].dataset.overviewFlow, 'export/obsidian')
  assert.equal(location.hash, '#overview')
  filter('no matching results')
  assert.equal(by('overview-viewport').hidden, true)
  assert.equal(by('overview-empty').hidden, false)
  assert.equal(wires().length, 0)
  filter('')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'area'])
  assert.equal(by('overview-viewport').hidden, false)
  assert.equal(by('overview-empty').hidden, true)
})

test('search shortcuts focus the current view, and editing keys stay in the input', () => {
  const { by, cards, focused } = loadOverview(parseGraph(raw), { mobile: true })
  const [project, group] = cards()
  const viewport = by('overview-viewport')
  viewport.scrollLeft = 42
  viewport.scrollTop = 84
  assert.equal(project.press('/').defaultPrevented, true)
  assert.equal(focused(), by('overview-search'))
  for (const key of ['/', '?', 'f']) assert.equal(focused().press(key).defaultPrevented, false)
  assert.ok(!by('reader-dialog').open)
  assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [42, 84])
  project.press('f')
  assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [0, 0])
  project.press('k', { metaKey: true })
  assert.equal(focused(), by('overview-search'))

  group.click()
  cards()[2].click()
  assert.equal(by('navigator').open, false)
  assert.equal(by('title').press('/').defaultPrevented, true)
  assert.equal(by('navigator').open, true)
  assert.equal(focused(), by('search'))
  assert.equal(focused().press('k', { ctrlKey: true }).defaultPrevented, false)
  by('title').press('k', { ctrlKey: true })
  assert.equal(focused(), by('search'))
})

test('process fit scales and scrolls the diagram, and the button restores its original size', () => {
  const { by } = loadOverview(parseGraph(raw), { view: '#export/obsidian' })
  const graph = by('graph'), viewport = by('process-viewport')
  graph.style.height = '1152px'
  graph.getBoundingClientRect = () => ({ top: 0, left: 0, width: 460, height: 1152 })
  by('title').press('f')
  assert.equal(graph.style['--process-scale'], '0.5')
  assert.equal(viewport.style.height, '576px')
  assert.equal(viewport.lastScroll.block, 'start')
  assert.equal(by('fit-process').textContent, '恢复原大小')
  by('fit-process').click()
  assert.equal(graph.style['--process-scale'], undefined)
  assert.equal(viewport.style.height, '')
  assert.equal(by('fit-process').textContent, '适应窗口')
})

test('shortcut help is modal, lists all views, and restores focus on Escape or backdrop click', () => {
  const { by, cards, focused } = loadOverview(parseGraph(raw))
  const project = cards()[0], dialog = by('reader-dialog'), close = by('dialog-close')
  const page = renderReader(parseGraph(raw))
  assert.match(page, /<dialog[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="dialog-title"/)
  project.focus()
  project.press('?', { shiftKey: true })
  assert.equal(dialog.open, true)
  assert.equal(by('dialog-title').textContent, '快捷键与说明')
  assert.deepEqual(dialog.querySelectorAll('ul').at(-1).children.map(row => row.textContent.split(' · ')[0]),
    ['功能总览', '操作流程', '功能关系'])
  assert.equal(focused(), close)
  close.press('Escape')
  assert.equal(dialog.open, false)
  assert.equal(focused(), project)

  by('shortcut-help').click()
  by('dialog-content').click()
  assert.equal(dialog.open, true)
  dialog.dispatch('click', { clientX: -1, clientY: 0 })
  assert.equal(dialog.open, false)
  assert.equal(focused(), by('shortcut-help'))
})

test('evidence badges open source cards with location, preview, symbol and anchor status', () => {
  const { by, focused } = loadOverview(graphWithEvidence(), { view: '#export/obsidian' })
  const dialog = by('reader-dialog')
  const [source, stale, doc] = by('detail').querySelectorAll('.source-badge')
  assert.deepEqual([source, stale, doc].map(badge => badge.textContent), ['SRC 1', 'SRC 2', 'SRC 3'])
  assert.equal(source.parentElement.querySelector('code').textContent, 'lib/graph.mjs:10')
  assert.match(stale.parentElement.querySelector('.muted').textContent, /证据待复核/)
  source.click()
  assert.equal(dialog.open, true)
  assert.equal(by('dialog-title').textContent, '源码卡片')
  const fields = () => dialog.querySelectorAll('dd').map(field => field.textContent)
  assert.deepEqual(fields(), ['lib/graph.mjs', '第 10 行', '实现', '源码符号 parseGraph', '行指纹已记录'])
  assert.equal(dialog.querySelector('pre').textContent, ' 9  // 校验\n10  export function parseGraph() {}')
  focused().press('Escape')
  assert.equal(dialog.open, false)
  assert.equal(focused(), source)
  stale.click()
  assert.deepEqual(fields(), ['tests/graph.test.mjs', '文件级', '测试', '未记录行指纹'])
  assert.deepEqual(dialog.querySelectorAll('p').map(node => node.textContent), ['证据待复核，请重新确认源码位置。', '暂无源码片段'])
  by('dialog-close').click()
  doc.click()
  assert.deepEqual(fields(), ['README.md', '文件级', '文档', '未记录行指纹'])
})

test('reader payload records anchor presence without exposing fingerprints or changing the graph', () => {
  const graph = graphWithEvidence()
  const before = JSON.stringify(graph)
  const { groups } = JSON.parse(renderReader(graph).match(/id="data">(.*?)<\/script>/s)[1])
  const { sources } = groups[0].flows[0].nodes[0]
  assert.deepEqual(sources.map(source => source.anchored), [true, false, false])
  assert.ok(sources.every(source => !Object.hasOwn(source, 'anchor')))
  assert.equal(JSON.stringify(graph), before)
})

test('export downloads the visible topology as SVG when PNG is unavailable and prints the active view', () => {
  const graph = parseGraph(raw)
  graph.project.name = '示例 <图> & 项目'
  const { by, cards, filter, downloads, printCount } = loadOverview(graph)
  const page = renderReader(graph)
  assert.match(page, /id="export-png"[^>]*>导出 PNG/)
  assert.match(page, /id="print-view"[^>]*>打印 \/ 另存为 PDF/)
  const png = by('export-png')
  const exported = () => decodeURIComponent(downloads.at(-1).href.split(',')[1])
  png.click()
  assert.equal(downloads[0].name, '示例 _图_ & 项目-topology.svg')
  assert.match(downloads[0].href, /^data:image\/svg\+xml/)
  assert.match(exported(), /示例 &lt;图&gt; &amp; 项目/)
  assert.match(exported(), /导出项目图谱/)
  assert.doesNotMatch(exported(), /在 Obsidian 打开图谱/)
  assert.match(exported(), /stroke="rgb\(53, 62, 57\)"/)

  cards()[1].click()
  png.click()
  assert.match(exported(), /在 Obsidian 打开图谱/)
  assert.doesNotMatch(exported(), /读取并验证图谱/)
  assert.match(exported(), /stroke="rgb\(141, 209, 173\)"/)
  by('print-view').click()
  assert.equal(printCount(), 1)
  assert.equal(by('print-topology').innerHTML, exported())
  filter('no matching results')
  assert.equal(png.disabled, true)
  filter('')
  cards()[2].click()
  assert.equal(png.disabled, true)
  by('print-view').click()
  assert.equal(printCount(), 2)
})

test('DSH review finds the module and resolves a selected step to its own flow', () => {
  const graph = graphWithAreas()
  const { cards, filter, location, reviewCurrent, reviewMenu, reviewRequests, select } = loadOverview(graph, { review: true })
  const page = renderReader(graph, { review: { workspace: 'test', digest: 'test', nonce: 'test' } })
  assert.match(page, /card\.dataset\.reviewStep = title\.dataset\.reviewText = summary\.dataset\.reviewText = id/)
  filter('示例筛选词')
  const [, , group, flow, step] = cards()
  const title = step.querySelector('[data-review-text]')
  assert.equal(group.dataset.reviewGroup, 'export')
  assert.equal(flow.dataset.overviewFlow, 'export/sample')
  assert.equal(flow.querySelector('[data-review-text]').dataset.reviewText, '')
  assert.equal(step.dataset.reviewStep, 'validate')
  assert.equal(title.dataset.reviewText, 'validate')
  assert.equal(reviewCurrent().flow.id, 'obsidian')
  assert.equal(reviewCurrent(flow).flow.id, 'sample')
  assert.equal(reviewCurrent(title).flow.id, 'sample')

  group.querySelector('strong').dispatch('contextmenu')
  assert.equal(reviewMenu().firstElementChild.textContent, '模块批注')
  step.dispatch('contextmenu')
  assert.equal(reviewMenu().firstElementChild.textContent, '批注这一步')
  flow.dispatch('contextmenu')
  assert.equal(reviewMenu().firstElementChild.textContent, '线路批注')
  select(title)
  title.dispatch('contextmenu')
  assert.deepEqual(reviewMenu().children.map(button => button.textContent), ['询问含义', '进一步讲解', '批注所选文字'])
  reviewMenu().firstElementChild.click()
  assert.deepEqual(reviewRequests, [['api/explain', { workspace: 'test', digest: 'test',
    group: 'export', flow: 'sample', step: 'validate', text: '示例 validate', mode: 'meaning' }, 'POST']])
  step.click()
  assert.equal(location.hash, '#overview')
  step.press('Enter')
  assert.equal(location.hash, '#step/export/sample/validate')
})

test('review dialog scopes annotations and saves, edits, and deletes a quoted note', async () => {
  const quote = '  选中文字\n保留空白  '
  const target = { kind: 'step', flow: 'sample', step: 'validate' }
  const stamp = '2026-01-01T00:00:00.000Z'
  const old = { id: 'module-note', target: { kind: 'group' }, text: '旧模块批注', createdAt: stamp }
  const previous = { id: 'step-note', target, text: '原有批注', createdAt: stamp }
  let confirmed = false
  const { by, cards, filter, reviewMenu, reviewDialog, reviewRequests, select } = loadOverview(graphWithAreas(), {
    review: true,
    confirm: () => confirmed,
    reply(url, body, method) {
      if (url === 'api/annotations-submit') return { submission: { sessionId: 'fixture-session' } }
      if (method === 'GET') return { notes: [old, previous] }
      if (method === 'POST') return { note: { ...body, id: 'new-note', createdAt: stamp } }
      if (method === 'PATCH') return { note: { ...body, id: 'new-note', target, quote, createdAt: stamp, updatedAt: stamp } }
      return { deleted: true }
    },
  })
  assert.equal(by('header-actions').querySelectorAll('a').find(link => link.textContent === '批注箱').href, '?notes=test')
  filter('示例筛选词')
  const [, , group, flow, step] = cards()
  const title = step.querySelector('[data-review-text]')
  select(title, quote)
  title.dispatch('contextmenu')
  reviewMenu().children[2].click()
  await setImmediate()
  const dialog = reviewDialog()
  const click = (container, label) => container.querySelectorAll('button').find(button => button.textContent === label).click()
  const { children: rows } = dialog.querySelector('.review-notes')
  const add = dialog.querySelector('textarea')
  assert.equal(dialog.querySelector('h2').textContent, '步骤批注 · 示例 validate')
  assert.equal(dialog.querySelector('blockquote').textContent, quote)
  assert.deepEqual(rows.map(row => row.querySelector('p').textContent), ['原有批注'])

  const common = { workspace: 'test', digest: 'test', group: 'export' }
  add.value = '新增批注'
  click(dialog, '保存批注')
  await setImmediate()
  assert.deepEqual(reviewRequests.at(-1), ['api/annotations', { ...common, target, quote, text: '新增批注' }, 'POST'])
  assert.equal(rows[0].querySelector('blockquote').textContent, quote)
  click(rows[0], '修改')
  const edit = rows[0].querySelector('textarea')
  assert.equal(edit.value, '新增批注')
  edit.value = '修改后的正文'
  click(rows[0], '保存修改')
  await setImmediate()
  assert.deepEqual(reviewRequests.at(-1), ['api/annotations', { ...common, id: 'new-note', text: '修改后的正文' }, 'PATCH'])
  assert.equal(rows[0].querySelector('p').textContent, '修改后的正文')
  assert.match(rows[0].querySelector('time').textContent, /^修改于 /)
  const submitLabel = '提交给 DSH（无需修改流程图）'
  const submitButton = dialog.querySelectorAll('button').find(button => button.textContent === submitLabel)
  assert.equal(submitButton.disabled, false)
  submitButton.click()
  assert.equal(submitButton.disabled, true)
  await setImmediate()
  assert.deepEqual(reviewRequests.at(-1), ['api/annotations-submit', { workspace: 'test', digest: 'test',
    ids: ['new-note', 'step-note'] }, 'POST'])
  assert.equal(dialog.querySelectorAll('.review-status').at(-1).textContent, '已提交到 DSH · 会话 fixture-session')
  click(rows[0], '删除')
  assert.equal(reviewRequests.at(-1)[0], 'api/annotations-submit')
  confirmed = true
  click(rows[0], '删除')
  await setImmediate()
  assert.deepEqual(reviewRequests.at(-1), ['api/annotations', { ...common, id: 'new-note' }, 'DELETE'])
  assert.deepEqual(rows.map(row => row.querySelector('p').textContent), ['原有批注'])

  dialog.close()
  group.dispatch('contextmenu')
  click(reviewMenu(), '模块批注')
  await setImmediate()
  assert.equal(dialog.querySelector('h2').textContent, '模块批注 · 导出项目图谱')
  assert.equal(dialog.querySelector('.review-notes').querySelector('p').textContent, '旧模块批注')

  dialog.close()
  const flowTitle = flow.querySelector('[data-review-text]')
  select(flowTitle)
  flowTitle.dispatch('contextmenu')
  click(reviewMenu(), '批注所选文字')
  await setImmediate()
  assert.equal(dialog.querySelector('h2').textContent, '线路批注 · 另一条线路')
  assert.equal(dialog.querySelector('blockquote').textContent, '另一条线路')
  assert.equal(dialog.querySelector('.review-notes').children.length, 0)
  assert.equal(dialog.querySelectorAll('button').find(button => button.textContent === submitLabel).disabled, true)
})

test('the annotation inbox selects by module and marks the notes identified in a successful receipt', async () => {
  const { by, document } = loadOverview(graphWithAreas())
  const createdAt = '2026-11-22T00:00:00.000Z'
  const submittedAt = '2026-11-22T00:15:00.000Z'
  const notes = [
    { id: 'one', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '第一条', createdAt, submitted: null },
    { id: 'two', group: 'first', groupTitle: '模块一', target: { kind: 'step' }, flowTitle: '线路', stepTitle: '步骤',
      text: '第二条', quote: '  选文\n', createdAt, submitted: null },
    { id: 'three', group: 'second', groupTitle: '模块二', target: { kind: 'group' }, text: '第三条', createdAt,
      submitted: { sessionId: 'older-session', submittedAt } },
  ]
  by('notes-context').textContent = JSON.stringify({ workspace: 'inbox', digest: 'current', project: '示例', maxSelection: 100 })
  let fail = true
  runInNewContext(notesScript, { document, URLSearchParams, async fetch(url, options) {
    assert.equal(options.headers['x-threadlight-client'], 'review')
    if (!options.method) {
      assert.equal(url, 'api/annotations?workspace=inbox&digest=current&all=1')
      return { ok: true, json: async () => ({ notes }) }
    }
    assert.equal(url, 'api/annotations-submit')
    assert.deepEqual(JSON.parse(options.body), { workspace: 'inbox', digest: 'current', ids: ['one', 'two'] })
    return fail ? { ok: false, json: async () => ({ error: '请重试' }) } : { ok: true, json: async () => ({
      submission: { noteIds: ['one', 'two'], sessionId: 'new-session', submittedAt },
    }) }
  } })
  await setImmediate()
  const [first, second] = by('groups').children
  const [toggle, one, two] = first.querySelectorAll('input')
  assert.equal(by('return').href, '?workspace=inbox')
  assert.equal(by('total').textContent, '3 条待处理')
  assert.equal(first.querySelector('blockquote').textContent, notes[1].quote)
  assert.equal(by('submit').disabled, true)
  one.checked = true
  one.dispatch('change')
  assert.equal(toggle.indeterminate, true)
  toggle.checked = true
  toggle.dispatch('change')
  assert.equal(two.checked, true)
  assert.equal(by('selected').textContent, '已选 2 条')
  by('submit').click()
  assert.equal(by('submit').disabled, true)
  await setImmediate()
  assert.equal(by('status').textContent, '请重试')
  assert.equal(by('submit').disabled, false)
  fail = false
  by('submit').click()
  await setImmediate()
  assert.equal(by('status').textContent, '已提交到 DSH · 会话 new-session')
  assert.deepEqual(first.querySelectorAll('.submitted').map(badge => badge.textContent), Array(2).fill('已提交 · 会话 new-sess'))
  assert.equal(second.querySelector('.submitted').textContent, '已提交 · 会话 older-se')
  assert.equal(by('selected').textContent, '已选 0 条')
})

test('the annotation inbox edits, cancels, and deletes notes with the current digest', async () => {
  const { by, document } = loadOverview(graphWithAreas())
  const createdAt = '2026-11-22T00:00:00.000Z'
  const updatedAt = '2026-11-23T00:00:00.000Z'
  const notes = [
    { id: 'one', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '第一条', createdAt, submitted: null },
    { id: 'two', group: 'first', groupTitle: '模块一', target: { kind: 'step' }, flowTitle: '线路', stepTitle: '步骤',
      text: '第二条', quote: '引用', createdAt, submitted: null },
    { id: 'three', group: 'second', groupTitle: '模块二', target: { kind: 'group' }, text: '第三条', createdAt, submitted: null },
  ]
  by('notes-context').textContent = JSON.stringify({ workspace: 'inbox', digest: 'current', project: '示例', maxSelection: 100 })
  const calls = []
  let confirmed = false
  runInNewContext(notesScript, { document, URLSearchParams, confirm: () => confirmed, async fetch(url, options) {
    if (url.startsWith('api/agent-presets')) return { ok: true, json: async () => ({ unavailable: true }) }
    const body = options.body ? JSON.parse(options.body) : null
    calls.push([url, options.method ?? 'GET', body, options.headers])
    if (!options.method) return { ok: true, json: async () => ({ notes }) }
    if (options.method === 'PATCH') return { ok: true, json: async () => ({
      note: { id: body.id, text: body.text, createdAt, updatedAt, target: { kind: 'group' } },
    }) }
    return { ok: true, json: async () => ({ deleted: true }) }
  } })
  await setImmediate()
  const [first, second] = by('groups').children
  const [one, two] = first.querySelectorAll('li')
  const control = (row, label) => row.querySelectorAll('button').find(button => button.textContent === label)
  assert.equal(by('total').textContent, '3 条待处理')
  one.querySelector('input').checked = true
  one.querySelector('input').dispatch('change')
  assert.equal(by('selected').textContent, '已选 1 条')
  assert.equal(by('submit').disabled, false)

  control(one, '修改').click()
  assert.equal(by('submit').disabled, true)
  assert.equal(control(two, '修改').disabled, true)
  const cancelled = one.querySelector('textarea')
  cancelled.value = '不应保存'
  control(one, '取消').click()
  assert.equal(one.querySelector('p').textContent, '第一条')
  assert.equal(by('submit').disabled, false)
  assert.equal(control(two, '修改').disabled, false)
  assert.equal(calls.length, 1)

  control(one, '修改').click()
  const editor = one.querySelector('textarea')
  assert.equal(editor.value, '第一条')
  editor.value = '第一条（改）'
  control(one, '保存修改').click()
  await setImmediate()
  assert.deepEqual(calls.at(-1).slice(0, 3), ['api/annotations', 'PATCH',
    { workspace: 'inbox', digest: 'current', group: 'first', id: 'one', text: '第一条（改）' }])
  assert.equal(calls.at(-1)[3]['x-threadlight-client'], 'review')
  assert.equal(one.querySelector('p').textContent, '第一条（改）')
  assert.match(one.querySelector('time').textContent, /^修改于 /)
  assert.equal(by('submit').disabled, false)

  const beforeCancel = calls.length
  control(one, '删除').click()
  assert.equal(calls.length, beforeCancel)
  assert.ok(one.parentElement)
  confirmed = true
  control(one, '删除').click()
  await setImmediate()
  assert.deepEqual(calls.at(-1).slice(0, 3), ['api/annotations', 'DELETE',
    { workspace: 'inbox', digest: 'current', group: 'first', id: 'one' }])
  assert.equal(first.querySelectorAll('li').length, 1)
  assert.equal(by('selected').textContent, '已选 0 条')
  assert.equal(by('total').textContent, '2 条待处理')

  control(two, '删除').click()
  await setImmediate()
  assert.equal(by('groups').children.length, 1)
  assert.equal(by('total').textContent, '1 条待处理')
  control(second.querySelector('li'), '删除').click()
  await setImmediate()
  assert.equal(by('groups').children.length, 0)
  assert.equal(by('total').textContent, '0 条待处理')
  assert.equal(by('empty').hidden, false)
  assert.equal(by('empty-title').textContent, '这个项目还没有批注')
  assert.equal(document.body.classList.contains('is-empty'), true)
})

test('the annotation inbox accepts submitted notes, hides archived notes behind a toggle, and restores them', async () => {
  const createdAt = '2026-11-22T00:00:00.000Z'
  const receipt = { sessionId: 'session-accept-0001', submittedAt: createdAt }
  const notes = [
    { id: 'one', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '已提交待验收', createdAt, submitted: receipt },
    { id: 'two', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '未提交', createdAt, submitted: null },
    { id: 'three', group: 'second', groupTitle: '模块二', target: { kind: 'group' }, text: '已验收归档', createdAt,
      submitted: { sessionId: 'session-archive-0002', submittedAt: createdAt }, resolvedAt: '2026-11-22T01:00:00.000Z' },
  ]
  const asked = []
  const { by, calls, control } = await openNotesInbox(notes, { confirm: message => { asked.push(message); return true } })
  const [first, second] = by('groups').children
  const [one, two] = first.querySelectorAll('li')
  assert.equal(by('total').textContent, '2 条待处理 · 1 条已归档')
  assert.equal(by('archived-toggle').hidden, false)
  assert.equal(by('archived-toggle').textContent, '显示已归档（1）')
  assert.equal(by('accept-submitted').hidden, false)
  assert.equal(by('accept-submitted').textContent, '验收已提交的 1 条')
  assert.equal(by('empty').hidden, true)
  // A module holding only archived notes stays hidden until the toggle is on.
  assert.equal(second.hidden, true)
  assert.equal(one.hidden, false)
  assert.equal(control(one, '验收').hidden, false)
  assert.equal(control(two, '验收').hidden, true)
  assert.equal(control(one, '恢复').hidden, true)

  control(one, '验收').click()
  await setImmediate()
  assert.deepEqual(asked, ['验收并归档这条批注？'])
  assert.deepEqual(calls.at(-1).slice(0, 3), ['api/annotations', 'PATCH',
    { workspace: 'inbox', digest: 'current', group: 'first', id: 'one', resolved: true }])
  assert.equal(calls.at(-1)[3]['x-threadlight-client'], 'review')
  assert.equal(by('status').textContent, '已验收并归档。')
  assert.equal(one.hidden, true)
  assert.equal(one.classList.contains('resolved'), true)
  assert.equal(one.querySelector('input').hidden, true)
  assert.equal(by('total').textContent, '1 条待处理 · 2 条已归档')
  assert.equal(by('accept-submitted').hidden, true)

  by('archived-toggle').click()
  assert.equal(by('archived-toggle').textContent, '隐藏已归档（2）')
  assert.equal(by('archived-toggle').getAttribute('aria-pressed'), 'true')
  assert.equal(one.hidden, false)
  assert.equal(second.hidden, false)
  const archivedRow = second.querySelector('li')
  assert.equal(control(archivedRow, '恢复').hidden, false)
  assert.equal(control(archivedRow, '验收').hidden, true)
  control(archivedRow, '恢复').click()
  await setImmediate()
  assert.deepEqual(calls.at(-1).slice(0, 3), ['api/annotations', 'PATCH',
    { workspace: 'inbox', digest: 'current', group: 'second', id: 'three', resolved: false }])
  assert.equal(by('status').textContent, '批注已恢复为待处理。')
  assert.equal(by('total').textContent, '2 条待处理 · 1 条已归档')
  assert.equal(control(archivedRow, '恢复').hidden, true)
  assert.equal(archivedRow.classList.contains('resolved'), false)
  assert.equal(by('archived-toggle').textContent, '隐藏已归档（1）')
  by('archived-toggle').click()
  assert.equal(one.hidden, true)
  assert.equal(by('archived-toggle').textContent, '显示已归档（1）')
  assert.equal(by('archived-toggle').getAttribute('aria-pressed'), 'false')
})

test('the annotation inbox accepts every submitted note in one batch and keeps failures pending', async () => {
  const createdAt = '2026-11-22T00:00:00.000Z'
  const receipt = { sessionId: 'session-batch-0001', submittedAt: createdAt }
  const notes = [
    { id: 'one', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '第一条', createdAt, submitted: receipt },
    { id: 'two', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '第二条', createdAt, submitted: receipt },
    { id: 'three', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '未提交', createdAt, submitted: null },
    { id: 'four', group: 'second', groupTitle: '模块二', target: { kind: 'group' }, text: '已归档', createdAt,
      submitted: receipt, resolvedAt: '2026-11-22T01:00:00.000Z' },
  ]
  const asked = []
  let confirmed = false
  const { by, calls, control } = await openNotesInbox(notes, {
    confirm: message => { asked.push(message); return confirmed },
    handle: ({ method, body }) => method === 'PATCH' && body.id === 'two'
      ? { ok: false, json: async () => ({ error: '归档失败' }) } : null,
  })
  assert.equal(by('accept-submitted').hidden, false)
  assert.equal(by('accept-submitted').textContent, '验收已提交的 2 条')
  by('accept-submitted').click()
  await setImmediate()
  assert.deepEqual(asked, ['验收并归档已提交的 2 条批注？'])
  assert.equal(calls.filter(call => call[1] === 'PATCH').length, 0)

  confirmed = true
  by('accept-submitted').click()
  await setImmediate()
  assert.deepEqual(calls.filter(call => call[1] === 'PATCH').map(call => call[2]), [
    { workspace: 'inbox', digest: 'current', group: 'first', id: 'one', resolved: true },
    { workspace: 'inbox', digest: 'current', group: 'first', id: 'two', resolved: true },
  ])
  assert.equal(by('status').textContent, '有 1 条批注归档失败，请刷新后重试。')
  assert.equal(by('status').classList.contains('error'), true)
  assert.equal(by('total').textContent, '2 条待处理 · 2 条已归档')
  assert.equal(by('accept-submitted').textContent, '验收已提交的 1 条')
  const [one, two] = by('groups').children[0].querySelectorAll('li')
  assert.equal(one.hidden, true)
  assert.equal(two.hidden, false)
  assert.equal(control(two, '验收').hidden, false)
})

test('an all-accepted inbox is reported as having no pending notes instead of no notes', async () => {
  const createdAt = '2026-11-22T00:00:00.000Z'
  const resolvedAt = '2026-11-22T01:00:00.000Z'
  const notes = [
    { id: 'one', group: 'first', groupTitle: '模块一', target: { kind: 'group' }, text: '第一条', createdAt, submitted: null, resolvedAt },
    { id: 'two', group: 'second', groupTitle: '模块二', target: { kind: 'group' }, text: '第二条', createdAt, submitted: null, resolvedAt },
  ]
  const { by, document } = await openNotesInbox(notes)
  assert.equal(by('total').textContent, '0 条待处理 · 2 条已归档')
  assert.equal(by('empty').hidden, false)
  assert.equal(by('empty-title').textContent, '没有待处理批注')
  assert.equal(by('empty-hint').textContent, '所有批注都已验收归档。可以用「显示已归档」查看或恢复。')
  assert.equal(document.body.classList.contains('is-empty'), true)
  assert.deepEqual(by('groups').children.map(section => section.hidden), [true, true])
  by('archived-toggle').click()
  assert.deepEqual(by('groups').children.map(section => section.hidden), [false, false])
  assert.ok(by('groups').children.every(section => section.querySelector('li').hidden === false))
  assert.equal(by('archived-toggle').textContent, '隐藏已归档（2）')
})

test('relation wires are an overlay instead of a third grid cell', () => {
  const page = renderReader(parseGraph(raw))
  // Without this rule the canvas becomes a grid item, pushes the three
  // columns out of order and never receives the map's size.
  assert.match(page, /\.map-wires \{[^}]*position: absolute/)
  assert.match(page, /\.map-wires \{[^}]*inset: 0/)
  assert.match(page, /\.map-wires \{[^}]*pointer-events: none/)
  assert.match(page, /\.relations-side, \.relations-current \{[^}]*position: relative/)
})
