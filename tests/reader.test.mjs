import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseGraph } from '../lib/graph.mjs'
import { renderReader } from '../lib/reader.mjs'

const [raw, reviewScript] = await Promise.all([
  readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8'),
  readFile(new URL('../lib/dsh-review.js', import.meta.url), 'utf8'),
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

// Run the shipped scripts with the DOM operations needed by the overview and review menu.
function loadOverview(graph, { review = false, clientHeight = 320 } = {}) {
  const page = renderReader(graph, review ? { review: { workspace: 'test', digest: 'test', nonce: 'test' } } : {})
  let reviewCurrent, selection
  class Element {
    attributes = new Map()
    children = []
    dataset = {}
    style = {}
    listeners = new Map()
    textContent = ''
    value = ''
    nodeType = 1

    constructor(tagName) { this.tagName = tagName }
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
      for (const child of children) this.insertBefore(child, null)
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
      this.focus()
      this.dispatch('click', { detail: 1 })
    }
    press(key) {
      const event = this.dispatch('keydown', { key })
      if (!event.defaultPrevented && this.tagName === 'button' && (key === 'Enter' || key === ' ')) this.dispatch('click')
    }
    showModal() { this.open = true }
  }

  const document = new Element('#document')
  document.body = new Element('body')
  document.append(document.body)
  document.activeElement = document.body
  document.createElement = tag => new Element(tag)
  document.createElementNS = (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI })
  const ids = new Map()
  function by(id) {
    if (!ids.has(id)) {
      const element = new Element('div')
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
  by('data').textContent = page.match(/id="data">(.*?)<\/script>/s)[1]

  const location = { hash: '#overview' }
  const windowEvents = new Map()
  const window = { addEventListener(type, listener) { windowEvents.set(type, listener) }, getSelection: () => selection }
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
    navigation = () => {}
    renderProcess = () => processRoutes.push([current.key, selectedByFlow.get(current.key)])
  `, {
    document, window, Element, Node: { ELEMENT_NODE: 1 }, location, processRoutes, captureReview,
    history: { pushState(_state, _title, hash) { location.hash = hash } },
    fetch(url, options) {
      reviewRequests.push([url, JSON.parse(options.body)])
      return Promise.resolve({ ok: true, json: async () => ({ answer: 'test' }) })
    },
    innerWidth: 800, innerHeight: 600, clearTimeout, AbortController, URLSearchParams,
    ResizeObserver: class { observe() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
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
  return { by, visible, cards, kinds, wires, filter, focused: () => document.activeElement, location, processRoutes,
    reviewCurrent, reviewRequests, reviewMenu: () => document.querySelector('.review-menu'),
    goToOverview() { location.hash = '#overview'; windowEvents.get('hashchange')() },
    select(element) { selection = { isCollapsed: false, anchorNode: element, focusNode: element, toString: () => element.textContent } },
  }
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

test('DSH review finds the module and resolves a selected step to its own flow', () => {
  const { cards, filter, location, reviewCurrent, reviewMenu, reviewRequests, select } =
    loadOverview(graphWithAreas(), { review: true })
  filter('示例筛选词')
  const [, , group, flow, step] = cards()
  const title = step.querySelector('[data-review-text]')
  assert.equal(group.dataset.reviewGroup, 'export')
  assert.equal(flow.dataset.overviewFlow, 'export/sample')
  assert.equal(title.dataset.reviewText, 'validate')
  assert.equal(reviewCurrent().flow.id, 'obsidian')
  assert.equal(reviewCurrent(flow).flow.id, 'sample')
  assert.equal(reviewCurrent(title).flow.id, 'sample')

  group.querySelector('strong').dispatch('contextmenu')
  assert.equal(reviewMenu().firstElementChild.textContent, '模块批注')
  select(title)
  title.dispatch('contextmenu')
  assert.equal(reviewMenu().firstElementChild.textContent, '询问含义')
  reviewMenu().firstElementChild.click()
  assert.deepEqual(reviewRequests, [['api/explain', { workspace: 'test', digest: 'test',
    group: 'export', flow: 'sample', step: 'validate', text: '示例 validate', mode: 'meaning' }]])
  step.click()
  assert.equal(location.hash, '#overview')
  step.press('Enter')
  assert.equal(location.hash, '#step/export/sample/validate')
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
