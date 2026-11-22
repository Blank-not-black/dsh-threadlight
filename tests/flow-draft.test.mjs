import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
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

test('flow drafts reject broken references and allow an unspecified branch condition', () => {
  const plan = {
    title: '上传文件', summary: '上传失败后允许重试。', acceptance: '重试时保留已选文件。',
    nodes: [
      { id: 'start', title: '上传', summary: '开始上传文件。' },
      { id: 'retry', title: '重试', summary: '重新上传原文件。' },
    ],
    edges: [{ id: 'offline', from: 'start', to: 'retry', kind: 'branch', label: '' }], notes: [],
  }
  const saved = normalizePlan(plan)
  const prompt = implementationPrompt('Fixture', { plan: saved }, null)
  const context = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))
  assert.equal(context.desired.edges[0].label, '用户未填写')
  assert.throws(() => implementationPrompt('Fixture', { plan: { ...saved, nodes: saved.nodes.slice(0, 1) } }, null), /invalid endpoints/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], to: 'unknown' }] }), /连线/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], bend: { x: -1, y: .5 } }] }), /折点/)
  assert.throws(() => normalizePlan({ ...plan, edges: [{ ...plan.edges[0], waypoints: [{ x: Infinity, y: 0 }] }] }), /画布坐标/)
  assert.throws(() => normalizePlan({ ...plan, layout: [{ step: 'unknown', x: 0, y: 0 }] }), /画布步骤/)
  assert.throws(() => normalizePlan({ ...plan, notes: [
    { id: 'comment', step: 'start', edge: 'offline', text: '只能有一个目标。', selected: true },
  ] }), /批注/)
})


test('draft prompts accept a name with empty fields and describe how to handle them', () => {
  const plan = normalizePlan({
    title: '上传文件', summary: '', acceptance: ' ', nodes: [{ id: 'upload', title: '', summary: '' }], edges: [], notes: [],
  })
  const prompt = implementationPrompt('Fixture', { plan }, null)
  const { desired } = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))
  assert.deepEqual(desired, {
    title: '上传文件', summary: '用户未填写', acceptance: '用户未填写',
    nodes: [{ id: 'upload', title: '未命名步骤', summary: '用户未填写' }], edges: [],
  })
  assert.throws(() => implementationPrompt('Fixture', { plan: { ...plan, title: ' ' } }, null), /名称必填/)
})

test('a draft without steps can submit its selected feedback verbatim', () => {
  const note = { id: 'feedback', step: null, edge: null, selected: true, text: '保留  原文件。\n断网后可重试。' }
  const plan = normalizePlan({ title: '上传反馈', summary: '', acceptance: '', nodes: [], edges: [], notes: [note] })
  const prompt = implementationPrompt('Fixture', { plan }, null)
  const { feedbackOnly, desired, feedback } = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))
  assert.match(prompt, /用户仅提交了批注，未提供完整流程/)
  assert.equal(feedbackOnly, true)
  assert.deepEqual(desired.nodes.map(node => node.id), ['user-feedback'])
  assert.deepEqual(feedback, [{ step: null, edge: null, text: note.text }])
  assert.deepEqual(plan.nodes, [])
  for (const notes of [[], [{ ...note, selected: false }]]) {
    assert.throws(() => implementationPrompt('Fixture', { plan: { ...plan, notes } }, null), /一个步骤.*一条/)
  }
})

test('the draft editor submit handler checks the name before saving and dispatching', async () => {
  const source = await readFile(new URL('../lib/dsh-drafts.js', import.meta.url), 'utf8')
  const start = source.indexOf("by('submit').addEventListener")
  const end = source.indexOf("window.addEventListener('beforeunload'", start)
  assert.ok(start >= 0 && end > start)
  const draft = { id: 'fixture', version: 0, plan: { title: '', summary: '', acceptance: '', nodes: [], edges: [] } }
  let submit
  const requests = []
  runInNewContext(source.slice(start, end), {
    by: () => ({ addEventListener(_type, listener) { submit = listener } }),
    run: operation => operation(), draft, dirty: false, setSidebar() {}, status() {}, reportDraft() {},
    async saveDraft() { draft.version++ },
    async request(route, fields, method) { requests.push([route, fields, method]); return { submission: { version: 1 } } },
  })
  await assert.rejects(submit(), /名称必填/)
  assert.deepEqual(requests, [])
  draft.plan.title = '上传反馈'
  await submit()
  assert.equal(JSON.stringify(requests), JSON.stringify([['draft-submit', { id: 'fixture', version: 1 }, 'POST']]))
})
