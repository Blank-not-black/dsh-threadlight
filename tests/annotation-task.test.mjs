import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { collectionPrompt, listSubmissionIndex, selectionDigest, submitAnnotations,
  submitModuleAnnotations } from '../lib/annotation-task.mjs'

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
const contextOf = prompt => JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2))

test('annotation prompts include original feedback, numbered targets and source locations', () => {
  const graph = structuredClone(source.graph)
  const [first, second] = graph.groups[0].flows[0].nodes
  first.sources[0].line = 3
  first.sources[0].preview = { text: 'omit source preview' }
  second.sources.unshift({ ...first.sources[0] })
  second.sources.push(...Array.from({ length: 24 }, (_, i) => ({ path: 'extra.mjs', kind: 'source', line: i + 1 })))
  const prompt = collectionPrompt({ ...source, graph }, notes, { workspaceTitle: '审阅工作区' })
  assert.match(prompt, /^用户只提交了批注，没有修改流程图。/)
  assert.match(prompt, /先阅读相关源码确认现状.*逐条处理批注/)
  assert.match(prompt, /按批注编号报告改动位置、实际运行的验证及结果/)
  const context = contextOf(prompt)
  assert.deepEqual({ ...context, notes: undefined }, {
    project: graph.project.name, digest: source.digest, workspace: '审阅工作区', notes: undefined,
  })
  assert.deepEqual(context.notes.map(({ sources, ...entry }) => entry), [
    { index: 1, groupId: module, groupTitle, targetKind: 'group', text: notes[0].text, createdAt: base.createdAt },
    { index: 2, groupId: module, groupTitle, flowId: flow.id, flowTitle: flow.title,
      targetKind: 'flow', text: notes[1].text, createdAt: base.createdAt },
    { index: 3, groupId: module, groupTitle, flowId: flow.id, flowTitle: flow.title, stepId: step.id, stepTitle: step.title,
      targetKind: 'step', text: notes[2].text, quote: notes[2].quote, createdAt: base.createdAt },
  ])
  const [groupSources, flowSources, stepSources] = context.notes.map(note => note.sources)
  assert.deepEqual(stepSources, [{ path: 'lib/graph.mjs', kind: 'source', line: 3 }])
  assert.equal(flowSources.length, 20)
  assert.equal(new Set(flowSources.map(entry => JSON.stringify(entry))).size, 20)
  assert.deepEqual(flowSources.slice(0, 2), [...stepSources, { path: 'lib/obsidian.mjs', kind: 'source' }])
  assert.deepEqual(groupSources, flowSources.slice(0, 5))
  assert.doesNotMatch(prompt, /details|omit source preview/)
  for (const selection of [[], Array(101).fill(notes[0])]) {
    assert.throws(() => collectionPrompt(source, selection, { workspaceTitle: 'fixture' }), { status: 400 })
  }
})

test('annotation selection digests identify ID sets independent of order', () => {
  const [one, two, three] = notes.map(note => note.id)
  const digest = selectionDigest([one, two])
  assert.match(digest, /^[a-f\d]{64}$/)
  assert.equal(digest, selectionDigest([two, one, one]))
  assert.notEqual(digest, selectionDigest([two, three]))
})

function fixture({ graph = source.graph, digest = source.digest, createDelay = 0 } = {}) {
  const files = new Map()
  const workGraph = { graph, digest }
  const workspace = { id: randomUUID(), path: 'workspace/' + randomUUID(), title: 'Fixture', sessionIds: [] }
  const prompts = [], titles = [], creates = []
  const rejected = new Set()
  let accepted = true, active = 0, highWater = 0
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
      active++
      highWater = Math.max(highWater, active)
      try {
        if (createDelay) await new Promise(resolve => setTimeout(resolve, createDelay))
      } finally {
        active--
      }
      creates.push(args)
      workspace.sessionIds.push(args.sessionId)
      return { sessionId: args.sessionId, ...(args.agentPreset ? { agentPreset: args.agentPreset } : {}) }
    },
    async rename(args) { titles.push(args) },
    async prompt(args, signal) {
      assert.equal(args.mode, 'queue')
      assert.ok(signal instanceof AbortSignal)
      prompts.push(args)
      const text = args.content[0].text
      return { accepted: accepted && ![...rejected].some(fragment => text.includes(fragment)) }
    },
  }
  return { files, store, workspace, controller, prompts, titles, creates, source: workGraph,
    maxActive: () => highWater,
    rejectWhen(fragment) { rejected.add(fragment) },
    acceptAll() { accepted = true; rejected.clear() },
    accept(value) { accepted = value },
    submit: selected => submitAnnotations({ workspace, graph: workGraph, notes: selected, store, controller }),
    submitModules: (selected, plan, presets) => submitModuleAnnotations({ workspace, graph: workGraph,
      notes: selected, controller, store, presets, plan }) }
}

test('annotation submissions coalesce concurrent and repeated requests for the same IDs', async () => {
  const { submit, files, workspace, prompts, titles } = fixture()
  const selection = [notes[2], notes[0]]
  const [first, concurrent] = await Promise.all([submit(selection), submit([...selection].reverse())])
  assert.deepEqual(concurrent, first)
  const { submission } = first
  assert.deepEqual(await submit([...selection].reverse()), first)
  assert.deepEqual(workspace.sessionIds, [submission.sessionId])
  assert.deepEqual(submission.noteIds, selection.map(note => note.id).sort())
  assert.equal(submission.workspace, workspace.id)
  assert.equal(submission.schemaVersion, 1)
  assert.equal(submission.requestId, prompts[0].requestId)
  assert.equal(submission.prompt, prompts[0].content[0].text)
  assert.deepEqual(titles, [{ sessionId: submission.sessionId, title: 'Threadlight 批注 · ' + flow.title + ' · 2 条' }])
  assert.deepEqual(JSON.parse(files.get('.threadlight/submissions/' + submission.digest + '.json')), submission)
  const different = await submit([notes[1]])
  assert.notEqual(different.submission.sessionId, submission.sessionId)
  assert.equal(prompts.length, 2)
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

function moduleNotes(...groups) {
  const createdAt = '2026-11-22T05:00:00.000Z'
  return groups.map((group, index) => ({ module: group.id, id: randomUUID(),
    text: '模块 ' + group.title + ' 的批注 ' + (index + 1) + '。', createdAt }))
}

test('module submissions group notes, run modules in parallel and record agent presets', async () => {
  const graph = structuredClone(multiGraph)
  const [first, second] = graph.groups
  const [firstNote, secondNote, followUp] = moduleNotes(first, second, first)
  const { submitModules, files, workspace, prompts, creates, maxActive } =
    fixture({ graph, digest: 'multi-module-digest', createDelay: 20 })
  const presets = [{ id: 'standard', isDefault: true }, { id: 'focused', name: 'Focused' }]
  const selection = [firstNote, secondNote, followUp]
  const result = await submitModules(selection, { [first.id]: 'focused', [second.id]: null }, presets)
  assert.deepEqual(result.failures, [])
  assert.equal(result.submissions.length, 2)
  assert.equal(creates.length, 2)
  assert.equal(workspace.sessionIds.length, 2)
  assert.equal(maxActive(), 2)
  const byModule = new Map(result.submissions.map(entry => [entry.module, entry]))
  const firstSubmission = byModule.get(first.id)
  const secondSubmission = byModule.get(second.id)
  assert.equal(firstSubmission.groupTitle, first.title)
  assert.equal(secondSubmission.groupTitle, second.title)
  assert.deepEqual(firstSubmission.noteIds, [firstNote.id, followUp.id].sort())
  assert.deepEqual(secondSubmission.noteIds, [secondNote.id])
  assert.equal(firstSubmission.digest, selectionDigest([firstNote.id, followUp.id]))
  assert.equal(secondSubmission.digest, selectionDigest([secondNote.id]))
  assert.equal(firstSubmission.agentPreset, 'focused')
  assert.equal('agentPreset' in secondSubmission, false)
  assert.notEqual(firstSubmission.sessionId, secondSubmission.sessionId)
  assert.ok(Number.isFinite(Date.parse(firstSubmission.submittedAt)))
  const createsBySession = new Map(creates.map(entry => [entry.sessionId, entry]))
  assert.equal(createsBySession.get(firstSubmission.sessionId).agentPreset, 'focused')
  assert.equal('agentPreset' in createsBySession.get(secondSubmission.sessionId), false)
  const firstReceipt = JSON.parse(files.get('.threadlight/submissions/' + firstSubmission.digest + '.json'))
  assert.equal(firstReceipt.module, first.id)
  assert.equal(firstReceipt.agentPreset, 'focused')
  assert.deepEqual(firstReceipt.noteIds, firstSubmission.noteIds)
  const secondReceipt = JSON.parse(files.get('.threadlight/submissions/' + secondSubmission.digest + '.json'))
  assert.equal(secondReceipt.module, second.id)
  assert.equal('agentPreset' in secondReceipt, false)
  const contexts = prompts.map(args => contextOf(args.content[0].text))
  for (const context of contexts) {
    assert.equal(context.digest, 'multi-module-digest')
    assert.equal(new Set(context.notes.map(note => note.groupId)).size, 1)
  }
  assert.deepEqual(contexts.map(context => context.notes.map(note => note.text)).flat().sort(),
    [firstNote.text, secondNote.text, followUp.text].sort())
  // Repeated submissions reuse both receipts instead of spawning new sessions.
  const repeated = await submitModules([followUp, secondNote, firstNote], { [first.id]: 'focused' }, presets)
  assert.deepEqual(repeated, result)
  assert.equal(creates.length, 2)
  assert.equal(prompts.length, 2)
})

test('module submission failures stay isolated and a retry resumes the pending module', async () => {
  const graph = structuredClone(multiGraph)
  const [first, second] = graph.groups
  const [good, bad] = moduleNotes(first, second)
  const { submitModules, files, prompts, workspace, rejectWhen, acceptAll } =
    fixture({ graph, digest: 'partial-digest' })
  rejectWhen('模块 ' + second.title + ' 的批注')
  const partial = await submitModules([good, bad], {})
  assert.equal(partial.submissions.length, 1)
  assert.equal(partial.submissions[0].module, first.id)
  assert.deepEqual(partial.failures, [{ module: second.id, groupTitle: second.title,
    message: 'DSH 暂未接收任务。批注已保存，可重新提交。' }])
  const badDigest = selectionDigest([bad.id])
  assert.equal(files.has('.threadlight/submissions/' + badDigest + '.json'), false)
  const pending = JSON.parse(files.get('.threadlight/submissions/' + badDigest + '.pending.json'))
  assert.equal(pending.module, second.id)
  assert.ok(workspace.sessionIds.includes(pending.sessionId))
  acceptAll()
  const retried = await submitModules([good, bad], {})
  assert.deepEqual(retried.failures, [])
  assert.equal(retried.submissions.length, 2)
  const resumed = retried.submissions.find(entry => entry.module === second.id)
  assert.equal(resumed.sessionId, pending.sessionId)
  assert.equal(resumed.digest, badDigest)
  const badPrompts = prompts.filter(args => args.content[0].text.includes('模块 ' + second.title + ' 的批注'))
  assert.equal(badPrompts.length, 2)
  assert.equal(badPrompts[1].requestId, pending.requestId)
  assert.equal(JSON.parse(files.get('.threadlight/submissions/' + badDigest + '.json')).module, second.id)
})

test('module submissions report every failed module without throwing', async () => {
  const graph = structuredClone(multiGraph)
  const [first, second] = graph.groups
  const notes = moduleNotes(first, second)
  const { submitModules, rejectWhen } = fixture({ graph, digest: 'all-failed-digest' })
  rejectWhen('的批注')
  const result = await submitModules(notes, {})
  assert.deepEqual(result, { submissions: [], failures: [
    { module: first.id, groupTitle: first.title, message: 'DSH 暂未接收任务。批注已保存，可重新提交。' },
    { module: second.id, groupTitle: second.title, message: 'DSH 暂未接收任务。批注已保存，可重新提交。' },
  ] })
})

test('module submissions validate plan keys, preset availability and the module limit', async () => {
  const graph = structuredClone(multiGraph)
  const groups = graph.groups.slice(0, 9)
  const notes = moduleNotes(...groups)
  const { submitModules, creates } = fixture({ graph, digest: 'validation-digest' })
  const presets = [{ id: 'standard', isDefault: true }, { id: 'broken-preset', broken: '插件加载失败' }]
  await assert.rejects(submitModules([notes[0]], { 'missing-module': 'standard' }, presets), { status: 400 })
  await assert.rejects(submitModules([notes[0]], { [groups[0].id]: 42 }, presets), { status: 400 })
  await assert.rejects(submitModules([notes[0]], { [groups[0].id]: 'missing-preset' }, presets), { status: 400 })
  await assert.rejects(submitModules([notes[0]], { [groups[0].id]: 'broken-preset' }, presets), { status: 503 })
  await assert.rejects(submitModules([notes[0]], { [groups[0].id]: 'standard' }), { status: 503 })
  await assert.rejects(submitModules([notes[0]], { [groups[0].id]: 'standard' }, []), { status: 400 })
  await assert.rejects(submitModules(notes, {}), { status: 400 })
  await assert.rejects(submitModules([{ module: 'missing-group', id: randomUUID(), text: '无目标。',
    createdAt: '2026-11-22T05:00:00.000Z' }], {}), { status: 400 })
  assert.equal(creates.length, 0)
})
