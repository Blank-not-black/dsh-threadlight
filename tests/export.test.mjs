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
  assert.equal(manifest.exportFormatVersion, 3)
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
