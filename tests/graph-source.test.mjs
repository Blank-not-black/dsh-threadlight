import assert from 'node:assert/strict'
import { test } from 'node:test'
import { graphDigest, readCurrentGraph } from '../lib/graph-source.mjs'

const revision = 'threadlight-0123456789abcdef'
const graph = {
  schemaVersion: 1,
  project: { name: 'Files' },
  groups: [{ id: 'files', title: 'Files', flows: [{
    id: 'upload', title: 'Upload', summary: 'Upload a file.',
    nodes: [{ id: 'run', title: 'Run', summary: 'Run it.', details: [], sources: [] }], edges: [],
  }] }],
}
const text = JSON.stringify(graph, null, 2) + '\n'
const other = text.replace('"Upload"', '"Upload now"')
const state = {
  schemaVersion: 1,
  source: { id: 'a'.repeat(64), head: 'b'.repeat(40), files: {} },
  revision,
}

function reader(files) {
  return async path => (path in files ? files[path] : null)
}

test('a workspace without a state file reads its working graph', async () => {
  const current = await readCurrentGraph(reader({ 'graph.json': text }))
  assert.equal(current.published, false)
  assert.equal(current.digest, graphDigest(text))
  assert.equal(current.working.digest, graphDigest(text))
  assert.equal(current.unabsorbed, true)
})

test('a published revision wins while the working graph is an absorbed mirror', async () => {
  const files = {
    'state.json': JSON.stringify({ ...state, absorbedGraphDigest: graphDigest(text) }),
    ['revisions/' + revision + '/graph.json']: text,
    'graph.json': text,
  }
  const current = await readCurrentGraph(reader(files))
  assert.equal(current.published, true)
  assert.equal(current.unabsorbed, false)
  assert.equal(current.graph.project.name, 'Files')
})

test('a working graph with a new digest overrides the published revision', async () => {
  const files = {
    'state.json': JSON.stringify({ ...state, absorbedGraphDigest: graphDigest(text) }),
    ['revisions/' + revision + '/graph.json']: text,
    'graph.json': other,
  }
  const current = await readCurrentGraph(reader(files))
  assert.equal(current.published, false)
  assert.equal(current.unabsorbed, true)
  assert.equal(current.digest, graphDigest(other))
  assert.equal(current.graph.groups[0].flows[0].title, 'Upload now')
})

test('an invalid state or missing revision fails loudly instead of falling back', async () => {
  await assert.rejects(readCurrentGraph(reader({
    'state.json': JSON.stringify({ ...state, revision: 'threadlight-zzzz' }),
    'graph.json': text,
  })), /Invalid Threadlight state/)
  await assert.rejects(readCurrentGraph(reader({
    'state.json': JSON.stringify(state),
    'graph.json': text,
  })), /找不到 Threadlight 状态文件指向的图谱/)
})

test('a workspace with no graph resolves to null', async () => {
  assert.equal(await readCurrentGraph(reader({})), null)
})
