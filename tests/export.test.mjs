import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseGraph } from '../lib/graph.mjs'
import { createLocalStore } from '../lib/local-store.mjs'
import { exportObsidian } from '../lib/obsidian.mjs'

const raw = await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8')

test('graph rejects paths that escape the repository and broken edge references', () => {
  const graph = JSON.parse(raw)
  const flow = graph.groups[0].flows[0]
  const source = flow.nodes[0].sources[0]
  source.path = '../outside.js'
  assert.throws(() => parseGraph(JSON.stringify(graph)), /repository-relative/)
  source.path = 'src/handler.js'
  flow.edges[0].to = 'missing-node'
  assert.throws(() => parseGraph(JSON.stringify(graph)), /invalid endpoints/)
})

test('export writes real note and Canvas references and reuses a manually edited snapshot', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'threadlight-export-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const graph = parseGraph(raw)
  const store = await createLocalStore(folder)
  const first = await exportObsidian(graph, store, { output: '' })
  assert.equal(first.reused, false)
  const snapshot = join(folder, first.directory)
  const manifest = JSON.parse(await readFile(join(snapshot, 'threadlight-export.json'), 'utf8'))
  assert.equal(manifest.exportFormatVersion, 5)
  const base = '线路/导出项目图谱/在 Obsidian 打开图谱'
  const canvas = JSON.parse(await readFile(join(snapshot, base + '.canvas'), 'utf8'))
  const markdown = await readFile(join(snapshot, base + '.md'), 'utf8')
  const moduleNote = await readFile(join(snapshot, '功能区/导出项目图谱.md'), 'utf8')
  const projectNote = await readFile(join(snapshot, '项目总览.md'), 'utf8')
  assert.ok(projectNote.includes('[[功能区/导出项目图谱|导出项目图谱]]'))
  assert.ok(moduleNote.includes('[[' + base + '|在 Obsidian 打开图谱]]'))
  assert.ok(!moduleNote.includes('[[项目总览'))
  assert.ok(!markdown.includes('[[功能区/'))
  assert.ok(!markdown.includes('#^step-'))
  assert.match(markdown, /threadlight_id: "flow\/export\/obsidian"/)
  assert.match(markdown, /\*\*从这里开始\*\* 读取并验证图谱/)
  assert.match(markdown, /^状态：有实现依据$/m)
  assert.match(markdown, /\*\*字段或引用无效\*\* → 指出需要修正的位置/)
  assert.match(markdown, /^> \[!info\]- 实现与证据/m)
  assert.equal(canvas.edges[0].fromNode, 'validate')
  assert.equal(canvas.edges[0].toNode, 'write')
  assert.equal(canvas.edges[0].toEnd, 'arrow')
  assert.equal(canvas.edges[1].label, '字段或引用无效')
  const placements = new Map(canvas.nodes.map(card => [card.id, card]))
  assert.equal(placements.get('write').x, placements.get('reject').x)
  assert.notEqual(placements.get('write').y, placements.get('reject').y)
  assert.ok(placements.get('write').x > placements.get('validate').x)
  for (const card of canvas.nodes) {
    assert.equal(card.type, 'text')
    assert.ok(card.text.includes('[[' + base + '#^step-' + card.id + '|查看实现]]'))
    assert.ok(markdown.includes('^step-' + card.id))
  }
  assert.ok(markdown.includes('lib/graph.mjs'))
  await writeFile(join(snapshot, '项目总览.md'), '我的手工批注')
  const repeated = await exportObsidian(graph, store, { output: '' })
  assert.deepEqual(repeated, { ...first, reused: true })
  assert.equal(await readFile(join(snapshot, '项目总览.md'), 'utf8'), '我的手工批注')
  graph.groups[0].title = '新版导出'
  const next = await exportObsidian(parseGraph(JSON.stringify(graph)), store, { output: '' })
  assert.notEqual(next.directory, first.directory)
  assert.equal(await readFile(join(snapshot, '项目总览.md'), 'utf8'), '我的手工批注')
})

test('interrupted exports resume only matching files and leave conflicts untouched', async () => {
  const graph = parseGraph(raw)
  const written = new Map()
  let failNext = true
  const store = {
    async read(path) { return written.get(path) ?? null },
    async create(path, value) {
      if (path.endsWith('.canvas') && failNext) throw new Error('simulated interruption')
      if (written.has(path)) return false
      written.set(path, value)
      return true
    },
  }
  await assert.rejects(exportObsidian(graph, store, { output: '' }), /simulated interruption/)
  assert.equal(written.size, 1)
  const [path, original] = written.entries().next().value
  assert.ok(path.endsWith('在 Obsidian 打开图谱.md'))
  failNext = false
  written.set(path, 'existing edit')
  await assert.rejects(exportObsidian(graph, store, { output: '' }), /conflicts with existing file/)
  assert.equal(written.get(path), 'existing edit')
  written.set(path, original)
  const result = await exportObsidian(graph, store, { output: '' })
  assert.ok(written.has(result.overview))
  assert.ok([...written.keys()].at(-1).endsWith('threadlight-export.json'))
})

test('cross-flow links render only in the authored direction and note paths are safe and distinct', async () => {
  const draft = JSON.parse(raw)
  draft.groups[0].title = 'CON.txt'
  const first = draft.groups[0].flows[0]
  first.title = '查看:快照#'
  const second = structuredClone(first)
  const source = first.nodes[0].sources[0]
  delete source.line
  source.status = 'needs-review'
  second.id = 'inspect'
  second.title = '查看/快照'
  draft.groups[0].flows.push(second)
  first.links = [{ kind: 'continues', group: 'export', flow: 'unknown' }]
  assert.throws(() => parseGraph(JSON.stringify(draft)), /missing or self-linked/)
  first.links[0].flow = second.id
  first.edges.push({ from: 'reject', to: 'validate', kind: 'sequence', label: '修正后重试' })
  // An input layout gives the retry its known direction even on a cycle.
  first.layout = { rows: [['validate'], ['write', 'reject']] }
  const written = new Map()
  const result = await exportObsidian(parseGraph(JSON.stringify(draft)), {
    async read() { return null },
    async create(path, value) { written.set(path, value); return true },
  }, { output: '' })
  const base = result.directory + '/线路/_CON.txt/'
  const firstNote = written.get(base + '查看 快照.md')
  const secondNote = written.get(base + '查看 快照 · inspect.md')
  assert.ok(firstNote.includes('接着看 · [[线路/_CON.txt/查看 快照 · inspect|查看/快照]]'))
  assert.ok(firstNote.includes('lib/graph.mjs ` · 证据待复核'))
  assert.ok(!secondNote.includes('延伸线路'))
  const retry = JSON.parse(written.get(base + '查看 快照.canvas')).edges.at(-1)
  assert.equal(retry.fromNode, 'reject')
  assert.equal(retry.toNode, 'validate')
  assert.equal(retry.fromSide, 'left')
  assert.equal(retry.label, '修正后重试')
})

test('graph validates optional areas and global group identity', () => {
  const graph = JSON.parse(raw)
  const parse = () => parseGraph(JSON.stringify(graph))
  assert.deepEqual(parse(), graph)
  graph.groups[0].area = 'delivery'
  assert.throws(parse, /^Error: Invalid graph: .*\.area is not allowed/)
  graph.project.areas = []
  assert.throws(parse, /\.area is not allowed/)
  delete graph.groups[0].area
  assert.deepEqual(parse(), graph)

  graph.project.areas = [{ id: 'delivery', title: '交付' }]
  assert.throws(parse, /\.area must be a string/)
  graph.groups[0].area = 'unknown'
  assert.throws(parse, /references an unknown area/)
  graph.groups[0].area = 'delivery'
  const area = graph.project.areas[0]
  graph.project.areas.push({ ...area })
  assert.throws(parse, /project\.areas\[1\]\.id is duplicated/)
  graph.project.areas.pop()
  for (const [field, value, error] of [
    ['id', 'x'.repeat(65), /lowercase slug/],
    ['id', 'Uppercase', /lowercase slug/],
    ['title', 'x'.repeat(161), /at most 160/],
    ['title', 'first\nsecond', /must be on one line/],
    ['summary', 'x'.repeat(6001), /at most 6000/],
  ]) {
    const old = area[field]
    area[field] = value
    assert.throws(parse, error)
    area[field] = old
  }
  assert.equal(parse().groups[0].area, 'delivery')
  graph.project.areas.push({ id: 'other', title: '其他' })
  graph.groups.push({ ...graph.groups[0], area: 'other' })
  assert.throws(parse, /groups\[1\]\.id is duplicated/)
  graph.project.areas = Array.from({ length: 33 }, (_, i) => ({ id: 'area-' + i, title: '领域 ' + i }))
  assert.throws(parse, /project\.areas must have between 0 and 32 items/)
})

test('Obsidian overview lists areas in order and connects each group to its area', async () => {
  const graph = JSON.parse(raw)
  const group = graph.groups[0]
  graph.project.areas = [
    { id: 'read', title: '阅读' },
    { id: 'delivery', title: '交付', summary: '导出项目资料。' },
    { id: 'future', title: '扩展' },
  ]
  group.area = 'delivery'
  graph.groups.push({ ...group, id: 'intro', title: '项目介绍', area: 'read' },
    { ...group, id: 'share', title: '分享快照' })
  const written = new Map()
  const result = await exportObsidian(parseGraph(JSON.stringify(graph)), {
    async read() { return null },
    async create(path, content) { written.set(path, content); return true },
  }, { output: '' })
  const project = written.get(result.directory + '/项目总览.md')
  assert.match(project, /## 阅读\n\n- \[\[功能区\/项目介绍\|项目介绍\]\].*\n\n## 交付\n\n导出项目资料。\n\n- \[\[功能区\/导出项目图谱\|导出项目图谱\]\].*\n- \[\[功能区\/分享快照\|分享快照\]\]/)
  assert.match(project, /## 扩展/)
  const canvas = JSON.parse(written.get(result.overview))
  assert.deepEqual(canvas.edges.map(({ fromNode, toNode }) => [fromNode, toNode]), [
    ['project', 'area-read'], ['area-read', 'module-intro'],
    ['project', 'area-delivery'], ['area-delivery', 'module-export'], ['area-delivery', 'module-share'],
    ['project', 'area-future'],
  ])
  const ids = new Set(canvas.nodes.map(({ id }) => id))
  for (const { fromNode, toNode } of canvas.edges) assert.ok(ids.has(fromNode) && ids.has(toNode))
  for (const { type, file } of canvas.nodes) {
    if (type === 'file') assert.ok(written.has(result.directory + '/' + file))
  }
  assert.equal(JSON.parse(written.get(result.directory + '/threadlight-export.json')).exportFormatVersion, 5)
})
