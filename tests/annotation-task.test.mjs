import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { coordinationPrompt, listSubmissionIndex, selectionDigest, submitAnnotations } from '../lib/annotation-task.mjs'

const graph = JSON.parse(await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8'))
const multiGraph = JSON.parse(await readFile(new URL('../examples/architecture.graph.json', import.meta.url), 'utf8'))
const source = { graph, digest: 'fixture-graph-digest' }
const { id: module, title: groupTitle, flows: [flow] } = graph.groups[0]
const [step] = flow.nodes
const base = { module, createdAt: '2026-11-22T01:00:00.000Z' }
const notes = [
  { ...base, id: randomUUID(), text: '核对模块行为。' },
  { ...base, id: randomUUID(), text: '检查  线路。', target: { kind: 'flow', flow: flow.id } },
  { ...base, id: randomUUID(), text: '修正这一步。\n保留第二行。', quote: ' 引用\r\n\t原文 ',
    target: { kind: 'step', flow: flow.id, step: step.id } },
]
const contextOf = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))

// Normalized note fixtures mirror what taskNotes hands to the prompt builder.
function promptNotes(graphValue, selected) {
  const groups = new Map(graphValue.groups.map(group => [group.id, group]))
  return selected.map((note, i) => {
    const group = groups.get(note.module)
    const target = note.target ?? { kind: 'group' }
    const flowRecord = target.kind === 'group' ? undefined : group.flows.find(entry => entry.id === target.flow)
    const stepRecord = target.kind === 'step' ? flowRecord?.nodes.find(node => node.id === target.step) : undefined
    return { id: note.id, index: i + 1, groupId: group.id, groupTitle: group.title,
      flowId: flowRecord?.id, flowTitle: flowRecord?.title, stepId: stepRecord?.id, stepTitle: stepRecord?.title,
      targetKind: target.kind, text: note.text, quote: note.quote, createdAt: note.createdAt,
      sources: stepRecord?.sources.map(({ path, kind, line }) => ({ path, kind, line })) ??
        (flowRecord ? [{ path: 'lib/graph.mjs', kind: 'source', line: 1 }] : [{ path: 'README.md', kind: 'documentation' }]) }
  })
}

test('coordination prompts ask one main session to delegate per module and keep the original feedback', () => {
  const graph = structuredClone(source.graph)
  const [first, second] = graph.groups[0].flows[0].nodes
  first.sources[0].line = 3
  second.sources.unshift({ ...first.sources[0] })
  const selection = notes.map(note => ({ ...note }))
  const prompt = coordinationPrompt({ ...source, graph }, promptNotes(graph, selection), { workspaceTitle: '审阅工作区' })
  assert.match(prompt, /你担任主会话/)
  assert.match(prompt, /subagent 工具为每个模块启动一个子代理/)
  assert.match(prompt, /同时最多 3 个/)
  assert.match(prompt, /按批注编号报告改动位置与验证结果/)
  assert.match(prompt, /不要只转述子代理的话/)
  const context = contextOf(prompt)
  assert.deepEqual({ ...context, modules: undefined }, {
    project: graph.project.name, digest: source.digest, workspace: '审阅工作区',
    moduleCount: 1, noteCount: 3, modules: undefined,
  })
  assert.equal(context.modules.length, 1)
  assert.equal(context.modules[0].id, module)
  assert.equal(context.modules[0].title, groupTitle)
  assert.deepEqual(context.modules[0].notes.map(({ sources, ...entry }) => entry), [
    { id: selection[0].id, index: 1, groupId: module, groupTitle, targetKind: 'group', text: notes[0].text,
      createdAt: base.createdAt },
    { id: selection[1].id, index: 2, groupId: module, groupTitle, flowId: flow.id, flowTitle: flow.title,
      targetKind: 'flow', text: notes[1].text, createdAt: base.createdAt },
    { id: selection[2].id, index: 3, groupId: module, groupTitle, flowId: flow.id, flowTitle: flow.title,
      stepId: step.id, stepTitle: step.title, targetKind: 'step', text: notes[2].text, quote: notes[2].quote,
      createdAt: base.createdAt },
  ])
  assert.deepEqual(context.modules[0].notes[2].sources, [{ path: 'lib/graph.mjs', kind: 'source', line: 3 }])
  assert.doesNotMatch(prompt, /details|omit source preview/)
})

test('annotation selection digests identify ID sets independent of order', () => {
  const [one, two, three] = notes.map(note => note.id)
  const digest = selectionDigest([one, two])
  assert.match(digest, /^[a-f\d]{64}$/)
  assert.equal(digest, selectionDigest([two, one, one]))
  assert.notEqual(digest, selectionDigest([two, three]))
})

function fixture({ graph = source.graph, digest = source.digest } = {}) {
  const files = new Map()
  const workspace = { id: randomUUID(), path: 'workspace/' + randomUUID(), title: 'Fixture', sessionIds: [] }
  const prompts = [], titles = [], creates = []
  let accepted = true
  const store = {
    async read(path) {
      const value = files.get(path)
      if (value instanceof Error) throw value
      return value ?? null
    },
    async list(path) {
      return [...files.keys()].filter(key => key.startsWith(path + '/'))
        .map(key => ({ name: key.slice(path.length + 1), type: 'file' }))
    },
    async create(path, text) {
      if (files.has(path)) return false
      files.set(path, text)
      return true
    },
  }
  const controller = {
    async create(args) {
      assert.equal(args.workspaceId, workspace.id)
      creates.push(args)
      workspace.sessionIds.push(args.sessionId)
      return { sessionId: args.sessionId, ...(args.agentPreset ? { agentPreset: args.agentPreset } : {}) }
    },
    async rename(args) { titles.push(args) },
    async prompt(args, signal) {
      assert.equal(args.mode, 'queue')
      assert.ok(signal instanceof AbortSignal)
      prompts.push(args)
      return { accepted }
    },
  }
  return { files, store, workspace, controller, prompts, titles, creates, graph,
    accept(value) { accepted = value },
    submit: (selected, options = {}) => submitAnnotations({ workspace, graph: { graph, digest }, notes: selected,
      store, controller, ...options }) }
}

function moduleNotes(...groups) {
  const createdAt = '2026-11-22T05:00:00.000Z'
  return groups.map((group, index) => ({ module: group.id, id: randomUUID(),
    text: '模块 ' + group.title + ' 的批注 ' + (index + 1) + '。', createdAt }))
}

test('one main session receives every module and delegates; receipts keep the module plan', async () => {
  const graph = structuredClone(multiGraph)
  const [first, second] = graph.groups
  const [firstNote, secondNote, followUp] = moduleNotes(first, second, first)
  const { submit, files, workspace, prompts, creates, titles } = fixture({ graph, digest: 'multi-module-digest' })
  const selection = [firstNote, secondNote, followUp]
  const { submission } = await submit(selection, { presets: [{ id: 'focused', name: 'Focused' }], agentPreset: 'focused' })
  assert.equal(creates.length, 1, 'one main session owns the batch')
  assert.equal(creates[0].agentPreset, 'focused')
  assert.equal(workspace.sessionIds.length, 1)
  assert.deepEqual(submission.noteIds, selection.map(note => note.id).sort())
  assert.equal(submission.sessionId, creates[0].sessionId)
  assert.deepEqual([...submission.modules].map(({ id }) => id).sort(), [first.id, second.id].sort())
  assert.equal(submission.agentPreset, 'focused')
  const prompt = prompts[0].content[0].text
  assert.match(prompt, /你担任主会话/)
  assert.match(prompt, /subagent 工具为每个模块启动一个子代理/)
  const context = contextOf(prompt)
  assert.equal(context.moduleCount, 2)
  assert.equal(context.noteCount, 3)
  assert.deepEqual(context.modules.map(module => module.notes.length), [2, 1])
  assert.equal(titles[0].title, 'Threadlight 批注 · 2 个模块 · 3 条')
  const receipt = JSON.parse(files.get('.threadlight/submissions/' + submission.digest + '.json'))
  assert.deepEqual(receipt, submission)
  assert.deepEqual(receipt.modules.map(module => module.id).sort(), [first.id, second.id].sort())
  // Repeating the same selection (any order) reuses the receipt and the session.
  const repeated = await submit([followUp, secondNote, firstNote],
    { presets: [{ id: 'focused', name: 'Focused' }], agentPreset: 'focused' })
  assert.deepEqual(repeated, { submission })
  assert.equal(creates.length, 1)
  assert.equal(prompts.length, 1)
})

test('a rejected annotation task leaves no receipt and a retry uses the original request', async () => {
  const { submit, files, store, workspace, prompts, accept } = fixture()
  const digest = selectionDigest([notes[0].id])
  accept(false)
  await assert.rejects(submit([notes[0]]), { status: 502 })
  assert.equal(files.has('.threadlight/submissions/' + digest + '.json'), false)
  assert.equal((await listSubmissionIndex(store)).size, 0)
  accept(true)
  const { submission } = await submit([notes[0]])
  assert.equal(submission.requestId, prompts[0].requestId)
  assert.deepEqual(prompts, [prompts[0], prompts[0]])
  assert.deepEqual(workspace.sessionIds, [submission.sessionId])
})

test('annotation receipt indexing skips invalid records and pending files', async () => {
  const { submit, files, store } = fixture()
  const { submission } = await submit(notes)
  const root = '.threadlight/submissions/'
  files.set(root + '1'.repeat(64) + '.json', '{broken')
  files.set(root + '2'.repeat(64) + '.json', JSON.stringify({ ...submission, sessionId: null }))
  files.set(root + '3'.repeat(64) + '.json', new TypeError('Invalid UTF-8'))
  assert.deepEqual(await listSubmissionIndex(store), new Map(submission.noteIds.map(id => [id, {
    digest: submission.digest, sessionId: submission.sessionId, submittedAt: submission.submittedAt,
  }])))
})

test('preset and target validation happens before a session is created', async () => {
  const { submit, creates } = fixture()
  const presets = [{ id: 'standard', isDefault: true }, { id: 'broken-preset', broken: '插件加载失败' }]
  await assert.rejects(submit([notes[0]], { presets, agentPreset: 'missing-preset' }), { status: 400 })
  await assert.rejects(submit([notes[0]], { presets, agentPreset: 'broken-preset' }), { status: 503 })
  await assert.rejects(submit([notes[0]], { agentPreset: 'standard' }), { status: 503 })
  await assert.rejects(submit([notes[0]], { presets, agentPreset: 42 }), { status: 400 })
  await assert.rejects(submit([{ module: 'missing-group', id: randomUUID(), text: '无目标。',
    createdAt: '2026-11-22T05:00:00.000Z' }]), { status: 400 })
  assert.equal(creates.length, 0)
})
