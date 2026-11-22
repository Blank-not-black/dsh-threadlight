import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { copyFlow, implementationPrompt, normalizePlan } from '../lib/flow-draft.mjs'
import { parseGraph } from '../lib/graph.mjs'

test('draft prompt compares a copied flow and retains only the selected feedback', async () => {
  const raw = await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8')
  const graph = parseGraph(raw)
  const base = copyFlow({ graph, digest: 'original' }, 'export', 'obsidian')
  const plan = structuredClone(base.plan)
  const branch = plan.edges.find(edge => edge.kind === 'branch')
  branch.bend = { x: .25, y: .5 }
  branch.waypoints = [{ x: 140, y: -20 }, { x: 210, y: 120 }]
  plan.layout = [{ step: plan.nodes[0].id, x: 40, y: 200 }]
  plan.nodes[0].summary = '先验证图谱，再允许写入快照。'
  plan.acceptance = '图谱无效时显示字段错误。'
  plan.notes.push(
    { id: 'reason', step: null, edge: branch.id, selected: true, text: '条件满足时继续。' },
    { id: 'other', step: plan.nodes[0].id, edge: null, selected: false, text: '稍后再处理。' },
  )
  const saved = normalizePlan(plan)
  assert.deepEqual(saved.edges.find(edge => edge.id === branch.id).bend, branch.bend)
  assert.deepEqual(saved.edges.find(edge => edge.id === branch.id).waypoints, branch.waypoints)
  assert.deepEqual(saved.layout, plan.layout)
  const prompt = implementationPrompt('Threadlight', { id: 'fixture', version: 2, base, plan: saved }, 'current')
  const context = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))
  assert.deepEqual(context.base.steps, { added: [], modified: [plan.nodes[0].id], removed: [] })
  assert.equal(context.base.digest, 'original')
  assert.equal(context.base.currentDigest, 'current')
  assert.equal(context.base.evidence[0].sources[0].path, 'lib/graph.mjs')
  assert.deepEqual(context.base.connections, { added: [], modified: [], removed: [] })
  assert.equal(context.desired.edges.find(edge => edge.id === branch.id).bend, undefined)
  assert.equal(context.desired.edges.find(edge => edge.id === branch.id).waypoints, undefined)
  assert.equal(context.desired.layout, undefined)
  assert.equal(context.desired.acceptance, plan.acceptance)
  assert.deepEqual(context.feedback, [{ step: null, edge: branch.id, text: '条件满足时继续。' }])
  assert.equal(graph.groups[0].flows[0].nodes[0].summary, base.plan.nodes[0].summary)
})

test('flow drafts reject broken references and require branch conditions before submission', () => {
  const plan = {
    title: '上传文件', summary: '上传失败后允许重试。', acceptance: '重试时保留已选文件。',
    nodes: [
      { id: 'start', title: '上传', summary: '开始上传文件。' },
      { id: 'retry', title: '重试', summary: '重新上传原文件。' },
    ],
    edges: [{ id: 'offline', from: 'start', to: 'retry', kind: 'branch', label: '' }], notes: [],
  }
  const saved = normalizePlan(plan)
  assert.throws(() => implementationPrompt('Fixture', { plan: saved }, null), /触发条件/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], to: 'unknown' }] }), /连线/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], bend: { x: -1, y: .5 } }] }), /折点/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], waypoints: [{ x: Infinity, y: 0 }] }] }), /画布坐标/)
  assert.throws(() => normalizePlan({ ...plan, layout: [{ step: 'unknown', x: 0, y: 0 }] }), /画布步骤/)
  assert.throws(() => normalizePlan({ ...plan, notes: [
    { id: 'comment', step: 'start', edge: 'offline', text: '只能有一个目标。', selected: true },
  ] }), /批注/)
})

