import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebindNote } from '../lib/dsh-review.mjs'
import { parseGraph } from '../lib/graph.mjs'
import { reanchorAnnotation } from '../lib/tool-annotations.mjs'

const digest = 'a'.repeat(64)
const nextDigest = 'b'.repeat(64)
const graph = parseGraph(JSON.stringify({
  schemaVersion: 1,
  project: { name: 'Files' },
  groups: [{
    id: 'files', title: 'Files',
    flows: [{
      id: 'upload', title: 'Upload', summary: 'Upload a file.',
      nodes: [{ id: 'run', title: 'Run', summary: 'Run it.', details: [], sources: [] }],
      edges: [],
    }],
  }],
}))

const note = (target, oldDigest = digest) => ({
  id: 'b6f0f7c0-6b1a-4b6a-9f0e-4d3c2b1a0f9e',
  text: 'The retry should keep the selected file.',
  createdAt: '2026-11-23T04:00:00.000Z',
  module: 'files',
  graph: oldDigest,
  target,
})

test('a note moves to the new graph digest when its target still exists', () => {
  const step = reanchorAnnotation(graph, note({ kind: 'step', flow: 'upload', step: 'run' }), nextDigest)
  assert.equal(step.graph, nextDigest)
  assert.equal(step.target.step, 'run')
  assert.ok(Number.isFinite(Date.parse(step.reboundAt)))
  assert.equal(reanchorAnnotation(graph, note({ kind: 'flow', flow: 'upload' }), nextDigest).graph, nextDigest)
  assert.equal(reanchorAnnotation(graph, note({ kind: 'group' }), nextDigest).graph, nextDigest)
})

test('a note already on the current digest is returned unchanged', () => {
  const current = note({ kind: 'group' }, nextDigest)
  assert.equal(reanchorAnnotation(graph, current, nextDigest), current)
})

test('removed modules, flows and steps are reported as stale', () => {
  assert.equal(reanchorAnnotation(graph, note({ kind: 'step', flow: 'upload', step: 'gone' }), nextDigest), null)
  assert.equal(reanchorAnnotation(graph, note({ kind: 'flow', flow: 'gone' }), nextDigest), null)
  assert.equal(reanchorAnnotation(graph, { ...note({ kind: 'group' }), module: 'gone' }, nextDigest), null)
  assert.equal(reanchorAnnotation(graph, note({ kind: 'flow', flow: 'upload' }), 'not-a-digest'), null)
})

test('rebinding preserves edits and archive status saved after the list read', async () => {
  const listed = note({ kind: 'group' })
  const latest = { ...listed, text: 'Revised feedback.', resolvedAt: listed.createdAt, resolvedBy: 'user' }
  let saved
  const store = {
    async update(_path, edit) {
      saved = edit(JSON.stringify(latest))
      return saved
    },
  }
  const result = await rebindNote(store, listed, 'files', { graph, digest: nextDigest })
  assert.equal(result.stale, false)
  assert.deepEqual(JSON.parse(saved), { ...latest, graph: nextDigest, reboundAt: result.note.reboundAt })
  assert.deepEqual(result.note, JSON.parse(saved))
})

test('rebinding reloads the latest record when a competing write wins', async () => {
  const listed = note({ kind: 'group' })
  const latest = { ...listed, text: 'Saved during the update.', resolvedAt: listed.createdAt }
  const store = {
    async update(_path, edit) {
      edit(JSON.stringify(listed))
      throw Object.assign(new Error('Version changed'), { code: 'FS_STALE_VERSION' })
    },
    async read() {
      return JSON.stringify(latest)
    },
  }
  const result = await rebindNote(store, listed, 'files', { graph, digest: nextDigest })
  assert.deepEqual(result.note, { ...latest, graph: nextDigest, reboundAt: result.note.reboundAt })
})
