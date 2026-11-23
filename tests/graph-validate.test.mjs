import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GraphError, inspectGraph, MAX_GRAPH_BYTES, parseGraph } from '../lib/graph.mjs'

const example = fileURLToPath(new URL('../examples/basic.graph.json', import.meta.url))
const cli = fileURLToPath(new URL('../bin/dsh-threadlight.mjs', import.meta.url))
const raw = await readFile(example, 'utf8')
const flowPath = 'groups[0].flows[0]'
const nodePath = flowPath + '.nodes[0]'
const summary = { groups: 1, flows: 1, nodes: 3, areas: 0 }

function invalidGraph(input, code, path) {
  assert.throws(() => parseGraph(input), error => {
    assert.ok(error instanceof GraphError)
    assert.equal(error.code, code)
    assert.equal(error.path, path)
    assert.match(error.message, /^Invalid graph: /)
    return true
  })
}

for (const [code, path, change] of [
  ['graph/schema-version', 'schemaVersion', graph => { graph.schemaVersion = 2 }],
  ['graph/project-name', 'project.name', graph => { graph.project.name = '' }],
  ['graph/group-id', 'groups[1].id', graph => { graph.groups.push(graph.groups[0]) }],
  ['graph/area-reference', 'groups[0].area', graph => {
    graph.project.areas = [{ id: 'delivery', title: 'Delivery' }]
    graph.groups[0].area = 'unknown'
  }],
  ['graph/node-state', nodePath + '.state', (graph, flow, node) => { node.state = 'done' }],
  ['graph/verification', nodePath + '.verification', (graph, flow, node) => { node.state = 'verified' }],
  ['graph/verification-result', nodePath + '.verification[0].result', (graph, flow, node) => {
    node.state = 'verified'
    node.verification = [{ id: 'check', at: '2026-01-01T00:00:00Z', result: 'unknown', summary: 'Checked' }]
  }],
  ['graph/source-path', nodePath + '.sources[1].path', (graph, flow, node) => {
    node.sources.push({ path: '../outside.mjs', kind: 'source' })
  }],
  ['graph/edge-endpoints', flowPath + '.edges[1]', (graph, flow) => { flow.edges[1].to = 'unknown' }],
  ['graph/layout-node', flowPath + '.layout.rows[1][1]', (graph, flow) => {
    const [first, second] = flow.nodes.map(node => node.id)
    flow.layout = { rows: [[first], [second, first]] }
  }],
  ['graph/link-target', flowPath + '.links[0]', (graph, flow) => {
    flow.links = [{ group: graph.groups[0].id, flow: 'unknown', kind: 'uses' }]
  }],
]) {
  test('parseGraph reports ' + code, () => {
    const graph = JSON.parse(raw)
    const flow = graph.groups[0].flows[0]
    change(graph, flow, flow.nodes[0])
    invalidGraph(JSON.stringify(graph), code, path)
  })
}

test('parseGraph reports invalid JSON and checks the UTF-8 byte limit first', () => {
  invalidGraph('{', 'graph/json', '$')
  invalidGraph('界'.repeat(Math.floor(MAX_GRAPH_BYTES / 3) + 1), 'graph/input-size', '$')
  invalidGraph(null, 'graph/input-size', '$')
})

test('inspectGraph returns counts or the first structured validation failure', () => {
  assert.deepEqual(inspectGraph(raw), { ok: true, summary })
  const graph = JSON.parse(raw)
  graph.project.areas = [{ id: 'delivery', title: 'Delivery' }]
  const [group] = graph.groups
  group.area = 'delivery'
  graph.groups.push({ ...group, id: 'second' })
  assert.deepEqual(inspectGraph(JSON.stringify(graph)), { ok: true, summary: { groups: 2, flows: 2, nodes: 6, areas: 1 } })

  group.flows[0].nodes[0].sources[0].path = '../outside.mjs'
  group.flows[0].edges[0].to = 'unknown'
  assert.deepEqual(inspectGraph(JSON.stringify(graph)), { ok: false, error: {
    code: 'graph/source-path',
    path: nodePath + '.sources[0].path',
    message: 'Invalid graph: ' + nodePath + '.sources[].path must be repository-relative',
    hint: 'Use a repository-relative path with forward slashes.',
  } })
  assert.deepEqual(inspectGraph('{'), { ok: false, error: {
    code: 'graph/json', path: '$', message: 'Invalid graph: expected UTF-8 JSON',
  } })
})

test('inspectGraph rethrows unexpected errors', t => {
  const unexpected = new Error('unexpected failure')
  const byteLength = t.mock.method(Buffer, 'byteLength', () => { throw unexpected })
  try {
    assert.throws(() => inspectGraph(raw), error => error === unexpected)
  } finally {
    byteLength.mock.restore()
  }
})

function validate(...args) {
  const result = spawnSync(process.execPath, [cli, 'validate', ...args], { encoding: 'utf8', windowsHide: true })
  assert.ifError(result.error)
  return result
}

test('validate keeps the default counts and --json emits one success or failure object', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'threadlight-validate-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = join(folder, 'invalid.json')
  await writeFile(file, '{"schemaVersion":2}')

  const plain = validate(example)
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout.trim(), JSON.stringify(summary))

  const success = validate(example, '--json')
  assert.equal(success.status, 0, success.stderr)
  assert.deepEqual(JSON.parse(success.stdout), { ok: true, summary })

  const failure = validate('--json', file)
  assert.equal(failure.status, 1, failure.stderr)
  assert.deepEqual(JSON.parse(failure.stdout), { ok: false, error: {
    code: 'graph/schema-version', path: 'schemaVersion', message: 'Invalid graph: schemaVersion must be 1',
  } })

  const plainFailure = validate(file)
  assert.equal(plainFailure.status, 1)
  assert.equal(plainFailure.stdout, '')
  assert.equal(plainFailure.stderr.trim(), 'Invalid graph: schemaVersion must be 1')
})

test('validate --json reports oversized, invalid UTF-8 and unreadable files and missing arguments', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'threadlight-validate-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = join(folder, 'input.json')
  await writeFile(file, Buffer.from([0xff]))
  const invalidEncoding = validate(file, '--json')
  await truncate(file, MAX_GRAPH_BYTES + 1)
  const oversized = validate(file, '--json')
  for (const [result, code] of [
    [invalidEncoding, 'graph/json'],
    [oversized, 'graph/input-size'],
    [validate(join(folder, 'missing.json'), '--json'), 'graph/input-read'],
    [validate('--json'), 'graph/arguments'],
  ]) {
    assert.equal(result.status, 1, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.match(receipt.error.message, /^Invalid graph: /)
    assert.deepEqual(receipt, { ok: false, error: { code, path: '$', message: receipt.error.message } })
  }
})
