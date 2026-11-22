import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseGraph } from '../lib/graph.mjs'
import { renderReader } from '../lib/reader.mjs'

const raw = await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8')

// Run the offline reader script with the DOM operations used by the overview.
function loadOverview(page) {
  let focused, reviewCurrent
  class Element {
    attributes = new Map()
    children = []
    dataset = {}
    listeners = new Map()
    textContent = ''
    value = ''

    get firstElementChild() { return this.children[0] }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    addEventListener(type, fn) { this.listeners.set(type, fn) }
    append(...children) {
      for (const child of children) child.parentElement = this
      this.children.push(...children)
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null
      this.children = []
      this.append(...children)
    }
    matches(selector) {
      if (selector === '[role="treeitem"]') return this.getAttribute('role') === 'treeitem'
      if (selector === '.tree-open') return this.className === 'tree-open'
      if (selector === '[data-overview-flow]') return 'overviewFlow' in this.dataset
      throw new Error('Unexpected selector ' + selector)
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parentElement?.closest(selector)
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] }
    dispatch(type, fields = {}) {
      const event = { target: this, preventDefault() {}, ...fields }
      for (let element = this; element; element = element.parentElement) element.listeners.get(type)?.(event)
    }
    focus() { focused = this; this.dispatch('focusin') }
  }

  const ids = new Map()
  function by(id) {
    if (!ids.has(id)) ids.set(id, new Element())
    return ids.get(id)
  }
  by('data').textContent = page.match(/id="data">(.*?)<\/script>/s)[1]
  const location = { hash: '#overview' }
  const processRoutes = []
  const script = page.match(/<script(?: nonce="[^"]+")?>\s*(const data = .*?)<\/script>/s)[1]
  // Inspect the route passed from the tree into the existing process renderer.
  runInNewContext(script + '\n' + `
    navigation = () => {}
    renderProcess = () => processRoutes.push([current.key, selectedByFlow.get(current.key)])
  `, {
    document: { getElementById: by, createElement: () => new Element(), querySelectorAll: () => [],
      body: new Element(), addEventListener() {} },
    window: { addEventListener() {}, getSelection: () => null, ThreadlightReview: {
      mount(_data, getCurrent) { reviewCurrent = getCurrent },
    } },
    location, processRoutes,
    history: { pushState(_state, _title, hash) { location.hash = hash } },
    clearTimeout,
    ResizeObserver: class { observe() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  })
  const visible = () => by('overview-tree').querySelectorAll('[role="treeitem"]')
  const kinds = () => visible().map(item => item.firstElementChild.dataset.kind)
  return { by, visible, kinds, focused: () => focused, reviewCurrent, location, processRoutes }
}

test('reviewer renders a five-level tree, expands one level at a time and filters to matching steps', () => {
  const graph = JSON.parse(raw)
  graph.project.areas = [{ id: 'delivery', title: '交付' }, { id: 'empty', title: '扩展' }]
  graph.groups[0].area = 'delivery'
  const flow = graph.groups[0].flows[0]
  graph.groups[0].flows.push({ ...structuredClone(flow), id: 'sample', title: '另一条线路',
    nodes: flow.nodes.map(node => ({ ...node, title: '示例', summary: '示例筛选词' })) })
  const page = renderReader(parseGraph(JSON.stringify(graph)), {
    review: { workspace: 'test', digest: 'test', nonce: 'test' },
  })
  assert.match(page, /id="overview-tree" role="tree"/)
  const { by, visible, kinds, focused, reviewCurrent, location, processRoutes } = loadOverview(page)
  assert.deepEqual(kinds(), ['project', 'area', 'area'])
  const [project, area, empty] = visible()
  assert.equal(project.getAttribute('aria-expanded'), 'true')
  assert.equal(area.getAttribute('aria-expanded'), 'false')
  assert.equal(empty.getAttribute('aria-expanded'), null)
  area.firstElementChild.dispatch('click')
  assert.equal(focused(), area)
  assert.equal(area.getAttribute('aria-expanded'), 'true')
  assert.equal(area.children[1].getAttribute('role'), 'group')
  const group = visible()[2]
  assert.equal(group.firstElementChild.dataset.reviewGroup, 'export')
  assert.equal(group.getAttribute('aria-expanded'), 'false')
  group.dispatch('keydown', { key: 'Enter' })
  const [, , , path] = visible()
  assert.equal(path.getAttribute('aria-expanded'), 'false')
  path.dispatch('keydown', { key: ' ' })
  assert.equal(path.getAttribute('aria-expanded'), 'true')
  assert.equal(kinds().filter(kind => kind === 'step').length, flow.nodes.length)

  const search = by('overview-search')
  search.value = '示例筛选词'
  search.dispatch('input')
  assert.deepEqual(kinds(), ['project', 'area', 'group', 'flow', 'step', 'step', 'step'])
  const step = visible().at(-1).firstElementChild.children[2].firstElementChild
  assert.equal(step.dataset.reviewText, 'reject')
  assert.equal(reviewCurrent(step).flow.id, 'sample')
  assert.equal(location.hash, '#overview')
  step.dispatch('click')
  assert.equal(location.hash, '#step/export/sample/reject')
  assert.deepEqual([...processRoutes[0]], ['export/sample', 'reject'])
  assert.equal(focused(), by('title'))
  search.value = 'no matching results'
  search.dispatch('input')
  assert.equal(by('overview-tree').hidden, true)
  assert.equal(by('overview-empty').hidden, false)
})

test('offline reader keeps the four-level tree for a graph without areas', () => {
  const { by, visible, kinds, location, processRoutes } = loadOverview(renderReader(parseGraph(raw)))
  assert.deepEqual(kinds(), ['project', 'group'])
  const search = by('overview-search')
  search.value = '读取并验证图谱'
  search.dispatch('input')
  assert.deepEqual(kinds(), ['project', 'group', 'flow', 'step'])
  assert.equal(visible()[2].getAttribute('aria-expanded'), 'true')
  assert.equal(visible()[3].firstElementChild.children[2].firstElementChild.dataset.reviewText, undefined)
  visible()[2].querySelector('.tree-open').dispatch('click')
  assert.equal(location.hash, '#export/obsidian')
  assert.deepEqual([...processRoutes[0]], ['export/obsidian', undefined])
})
