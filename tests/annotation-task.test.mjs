import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { collectionPrompt, listSubmissionIndex, selectionDigest, submitAnnotations } from '../lib/annotation-task.mjs'

const graph = JSON.parse(await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8'))
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

function fixture() {
  const files = new Map()
  const workspace = { id: randomUUID(), path: 'workspace/' + randomUUID(), title: 'Fixture', sessionIds: [] }
  const prompts = [], titles = []
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
    async create({ workspaceId, sessionId }) {
      assert.equal(workspaceId, workspace.id)
      workspace.sessionIds.push(sessionId)
      return { sessionId }
    },
    async rename(args) { titles.push(args) },
    async prompt(args, signal) {
      assert.equal(args.mode, 'queue')
      assert.ok(signal instanceof AbortSignal)
      prompts.push(args)
      return { accepted }
    },
  }
  return { files, store, workspace, controller, prompts, titles, accept(value) { accepted = value },
    submit: selected => submitAnnotations({ workspace, graph: source, notes: selected, store, controller }) }
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
