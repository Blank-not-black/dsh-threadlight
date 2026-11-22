import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyDocumentUpdate } from '../lib/document-update.mjs'
import { implementationPrompt } from '../lib/flow-draft.mjs'
import { parseGraph } from '../lib/graph.mjs'
import { enrichEvidence } from '../lib/implementation-evidence.mjs'
import { includeImplementationReport } from '../lib/implementation-prompt.mjs'
import { ingestImplementationReports, reportPath } from '../lib/implementation-report.mjs'
import { stepState } from '../lib/reader.mjs'
import { refreshDocumentation } from '../lib/refresh.mjs'

const at = '2026-11-22T04:30:00.000Z'
const checked = { id: 'check', at, result: 'passed', summary: '重试通过。', command: 'npm run check' }
const fields = { state: 'verified', verification: [checked], divergence: '按钮只在网络错误时显示。' }
const source = { path: 'src/upload.mjs', kind: 'source', line: 1 }
const cli = fileURLToPath(new URL('../bin/dsh-threadlight.mjs', import.meta.url))

function projectGraph(nodeFields = {}) {
  return { schemaVersion: 1, project: { name: 'Files' }, groups: [
    { id: 'files', title: 'Files', flows: [
      { id: 'upload', title: 'Upload', summary: 'Upload a file.', nodes: [
        { id: 'retry', title: 'Retry', summary: 'Retry the upload.', details: [], sources: [source], ...nodeFields },
        { id: 'confirm', title: 'Confirm', summary: 'Confirm the upload.', details: [], sources: [] },
      ], edges: [] },
    ] },
  ] }
}

const firstNode = graph => graph.groups[0].flows[0].nodes[0]
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJson = (path, record) => writeFile(path, JSON.stringify(record))
const parse = graph => parseGraph(JSON.stringify(graph))

function updateFor(input, graph) {
  return { project: graph.project, groups: graph.groups, snapshotId: input.snapshotId,
    reviewedPaths: input.changes.map(change => change.path),
    reviewedFlows: input.affectedFlows.map(({ group, flow }) => ({ group, flow, reason: 'Reviewed the source.' })),
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadlight-report-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, source.path), 'export function run() { return "old" }\n')
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true })
  const first = await refreshDocumentation(root, { runSession: async ({ input }) => ({
    sessionId: 'initial-session', update: updateFor(input, projectGraph()),
  }) })
  const control = join(root, '.threadlight')
  return {
    root, first, statePath: join(control, 'state.json'),
    readGraph: revision => readJson(join(control, 'revisions', revision, 'graph.json')),
    async writeReport({ steps = [{ step: 'retry', sources: [source], ...fields }],
      receipt = 3, draftVersion = 3, reportVersion = 3, base = { group: 'files', flow: 'upload', digest: 'original' } } = {}) {
      const id = randomUUID(), version = 3
      const draftDir = join(control, 'drafts', id)
      const reportFile = reportPath(root, id, version)
      const draft = { schemaVersion: 1, id, version: draftVersion, base,
        plan: { nodes: [{ id: 'retry' }, { id: 'new-step' }] } }
      await mkdir(draftDir, { recursive: true })
      await mkdir(dirname(reportFile), { recursive: true })
      await writeJson(join(draftDir, version + '.json'), draft)
      if (receipt !== null) {
        await writeJson(join(draftDir, 'submitted-' + version + '.json'), {
          version: receipt, sessionId: randomUUID(), submittedAt: at,
        })
      }
      const report = { schemaVersion: 1, draft: { id, version: reportVersion }, generatedAt: at, steps }
      await writeJson(reportFile, report)
      return { id, version, reportFile, report, marker: join(dirname(reportFile), version + '.applied.json') }
    },
  }
}

test('graph validates step states and verification while deriving labels for old graphs', () => {
  const legacy = parse(projectGraph())
  assert.equal(firstNode(legacy).state, undefined)
  assert.equal(stepState(firstNode(legacy)), 'implemented')
  assert.equal(stepState(legacy.groups[0].flows[0].nodes[1]), 'planned')
  const verified = parse(projectGraph({ ...fields, verification: [checked, { ...checked, id: 'first', result: 'failed' }] }))
  assert.equal(stepState(firstNode(verified)), 'verified')
  assert.equal(firstNode(parse(projectGraph({ state: 'planned' }))).state, 'planned')
  assert.equal(firstNode(parse(projectGraph({ state: 'implemented' }))).state, 'implemented')
  for (const [bad, expected] of [
    [{ state: 'done' }, /state is unsupported/],
    [{ state: 'verified' }, /requires a passed verification/],
    [{ state: 'verified', verification: [] }, /requires a passed verification/],
    [{ state: 'verified', verification: [{ ...checked, result: 'failed' }] }, /requires a passed verification/],
    [{ state: 'implemented', verification: [checked] }, /verification requires verified/],
    [{ verification: [checked] }, /verification requires verified/],
    [{ ...fields, verification: [checked, checked] }, /id is duplicated/],
    [{ ...fields, verification: [checked, ...Array.from({ length: 20 }, (_, i) => ({ ...checked, id: 'check-' + i }))] }, /20 items/],
    [{ ...fields, verification: [{ ...checked, summary: 'x'.repeat(361) }] }, /summary.*360/],
    [{ ...fields, verification: [{ ...checked, command: 'first\nsecond' }] }, /command must be on one line/],
    [{ ...fields, verification: [{ ...checked, at: 'November 22, 2026' }] }, /ISO-8601/],
    [{ ...fields, verification: [{ ...checked, at: at + '\n' }] }, /ISO-8601/],
    [{ ...fields, divergence: 'x'.repeat(2001) }, /divergence.*2000/],
  ]) assert.throws(() => parse(projectGraph(bad)), expected)
})

test('document session rewrites preserve host fields only on a matching group, flow and node', () => {
  const previous = projectGraph({ ...fields, sources: [] })
  const input = { snapshotId: 'snapshot', head: null, changes: [], affectedFlows: [] }
  const model = projectGraph({ sources: [] })
  model.groups[0].flows[0].nodes[1].state = 'implemented'
  model.groups.push({ ...model.groups[0], id: 'other' })
  const { graph } = applyDocumentUpdate(previous, updateFor(input, model), input, { files: new Map(), metadata: {} })
  assert.deepEqual(firstNode(graph), firstNode(previous))
  assert.equal(graph.groups[0].flows[0].nodes[1].state, undefined)
  assert.equal(graph.groups[1].flows[0].nodes[0].state, undefined)
  assert.equal(graph.groups[1].flows[0].nodes[0].verification, undefined)
})

test('implementation session receives the absolute report path and the submitted step IDs', () => {
  const id = randomUUID(), version = 3
  const plan = { title: 'Upload', summary: 'Retry uploads.', acceptance: 'Retry succeeds.',
    nodes: [{ id: 'retry', title: 'Retry', summary: 'Keep the selected file.' }], edges: [], notes: [] }
  const prompt = implementationPrompt('Files', { id, version, plan }, null)
  const directory = join(tmpdir(), 'Workspace With Spaces')
  const withReport = includeImplementationReport(prompt, directory)
  assert.ok(withReport.includes(reportPath(directory, id, version)))
  assert.match(withReport, /只记录真正执行过的验证/)
  const example = JSON.parse(withReport.split('\n').find(line => line.startsWith('{"schemaVersion"')))
  assert.deepEqual(example.draft, { id, version })
  assert.equal(example.steps[0].step, 'retry')
  assert.deepEqual(JSON.parse(withReport.split('\n\n')[1]), JSON.parse(prompt.split('\n\n')[1]))
})

test('report publishes live evidence and preserves the refresh baseline for the next document session', async t => {
  const { root, first, statePath, readGraph, writeReport } = await fixture(t)
  const before = { ...await readJson(statePath), extraHostField: { keep: true } }
  await writeJson(statePath, before)
  const originalGraph = await readGraph(first.snapshot)
  const currentLine = 'export function run() { return "retry" }'
  await writeFile(join(root, source.path), currentLine + '\n')
  const { id, version, reportFile, marker } = await writeReport({ steps: [
    { step: 'retry', sources: [source], ...fields },
    { step: 'new-step', state: 'planned', sources: [] },
  ] })
  const codeIndex = process.env.THREADLIGHT_CODE_INDEX
  const args = [cli, 'report', root, ...(codeIndex ? ['--code-index', codeIndex] : [])]
  const ingest = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true })
  assert.equal(ingest.status, 0, ingest.stderr)
  const result = JSON.parse(ingest.stdout)
  assert.deepEqual(result.rejected, [])
  const { revision } = result
  assert.notEqual(revision, first.snapshot)
  assert.deepEqual(result.applied, [{ draftId: id, version, revision, skippedSteps: ['new-step'], evidence: { relocated: 0, needsReview: 0 } }])
  assert.deepEqual(await readJson(statePath), { ...before, revision })
  const historyPath = join(root, '.threadlight', 'history.json')
  const history = await readJson(historyPath)
  assert.deepEqual(history.entries.map(entry => [entry.status, entry.revision]), [
    ['updated', first.snapshot], ['reported', revision],
  ])
  assert.ok(history.entries[1].sessionId)
  assert.ok(history.entries[1].snapshotId)
  const graph = await readGraph(revision)
  const node = firstNode(graph)
  assert.deepEqual(graph.snapshot, originalGraph.snapshot)
  assert.deepEqual({ state: node.state, verification: node.verification, divergence: node.divergence }, fields)
  assert.equal(node.sources[0].line, 1)
  assert.equal(node.sources[0].anchor.lineHash, createHash('sha256').update(currentLine).digest('hex'))
  assert.match(node.sources[0].preview.text, /"retry"/)
  if (codeIndex) assert.deepEqual(node.sources[0].symbol, { name: 'run', kind: 'function', startLine: 1, endLine: 1 })
  const viewer = await readFile(first.viewer, 'utf8')
  assert.ok(viewer.includes('href="revisions/' + revision + '/project.md"'))
  const view = JSON.parse(viewer.match(/id="data">(.*?)<\/script>/s)[1])
  assert.deepEqual(firstNode(view).verification, fields.verification)
  assert.equal(firstNode(view).divergence, fields.divergence)
  assert.equal(firstNode(view).state, 'verified')
  assert.equal(firstNode(view).sources[0].anchor, undefined)
  for (const ext of ['md', 'html']) {
    const document = await readFile(join(root, '.threadlight', 'revisions', revision, 'docs', 'files.' + ext), 'utf8')
    for (const text of ['状态：已实际验证', '状态：计划', '验证记录', '通过', checked.summary, checked.command, checked.at, fields.divergence]) {
      assert.ok(document.includes(text), text + ' missing from ' + ext)
    }
  }
  const applied = await readJson(marker)
  assert.equal(applied.reportHash, createHash('sha256').update(await readFile(reportFile)).digest('hex'))
  assert.equal(applied.revision, revision)
  assert.ok(Number.isFinite(Date.parse(applied.at)))

  const second = await ingestImplementationReports(root)
  assert.deepEqual(second, { revision, applied: [], skipped: [{ draftId: id, version, reason: 'Report already applied' }], rejected: [] })
  assert.deepEqual(await readJson(marker), applied)
  const changedReport = await readJson(reportFile)
  await writeJson(reportFile, { ...changedReport, summary: 'Same graph content.' })
  const repeated = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true })
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.equal(JSON.parse(repeated.stdout).applied[0].revision, revision)
  assert.deepEqual(await readJson(historyPath), history)
  const refreshed = await refreshDocumentation(root, { runSession: async ({ input }) => {
    assert.deepEqual(input.changes, [{ path: source.path, kind: 'modified' }])
    assert.equal(input.affectedFlows[0].flow, 'upload')
    return { sessionId: 'after-report', update: updateFor(input, projectGraph()) }
  } })
  const finalNode = firstNode(await readGraph(refreshed.snapshot))
  assert.equal(finalNode.sources[0].line, 1)
  assert.equal(finalNode.state, 'verified')
  assert.deepEqual(finalNode.verification, fields.verification)
  assert.equal(finalNode.divergence, fields.divergence)
})

test('missing records are skipped and invalid reports leave the published revision intact', async t => {
  const { root, first, statePath, writeReport } = await fixture(t)
  const state = await readJson(statePath)
  const currentMissing = { steps: [{ step: 'new-step', state: 'planned', sources: [] }] }
  const missingStep = await writeReport(currentMissing)
  const skipped = [
    [{ receipt: null }, /receipt is missing/],
    [{ receipt: 2 }, /receipt version does not match/],
    [{ draftVersion: 2 }, /Draft file identity/],
    [{ base: null }, /no base flow/],
    [{ base: { group: 'files', flow: 'download', digest: 'original' } }, /Base flow is missing/],
  ]
  const step = { step: 'retry', sources: [source] }
  const rejected = [
    [{ reportVersion: 2 }, /identity does not match the report path/],
    [{ steps: [{ ...step, state: 'verified' }] }, /requires a passed verification/],
    [{ steps: [{ ...step, step: 'unknown' }] }, /step is missing from the draft/],
    [{ steps: [step, step] }, /id is duplicated/],
    [{ steps: [{ ...step, sources: [{ ...source, path: '../outside.mjs' }] }] }, /repository-relative/],
  ]
  const cases = await Promise.all(Object.entries({ skipped, rejected }).flatMap(([status, entries]) =>
    entries.map(async ([input, reason]) => ({ ...await writeReport(input), status, reason }))))
  const run = spawnSync(process.execPath, [cli, 'report'], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(run.status, 1, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.deepEqual(result.applied, [])
  assert.equal(result.revision, first.snapshot)
  const absent = result.skipped.find(entry => entry.draftId === missingStep.id)
  assert.match(absent.reason, /No reported steps/)
  assert.deepEqual(absent.skippedSteps, ['new-step'])
  await assert.rejects(readFile(missingStep.marker), { code: 'ENOENT' })
  for (const { id, marker, status, reason } of cases) {
    assert.match(result[status].find(entry => entry.draftId === id).reason, reason)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  }
  assert.deepEqual(await readJson(statePath), state)
})

test('a corrected report hash is reapplied and omitted fields survive the merge', async t => {
  const { root, readGraph, writeReport } = await fixture(t)
  const { reportFile, marker, report } = await writeReport()
  const first = await ingestImplementationReports(root)
  const applied = await readJson(marker)
  assert.equal(first.applied.length, 1)
  report.steps[0] = { step: 'retry', sources: [], divergence: '差异已更新。' }
  await writeJson(reportFile, report)
  const history = join(root, '.threadlight', 'history.json')
  await writeJson(history, { schemaVersion: 1, entries: [null] })
  const second = await ingestImplementationReports(root)
  assert.equal(second.applied.length, 1)
  assert.notEqual(second.revision, first.revision)
  assert.deepEqual((await readJson(history)).entries.map(entry => entry.revision), [second.revision])
  assert.notEqual((await readJson(marker)).reportHash, applied.reportHash)
  const merged = firstNode(await readGraph(second.revision))
  assert.deepEqual(merged.sources, [])
  assert.equal(merged.state, 'verified')
  assert.deepEqual(merged.verification, fields.verification)
  assert.equal(merged.divergence, '差异已更新。')
})

test('evidence keeps an existing symbol without an indexer only if the file matches', async () => {
  const symbol = { name: 'run', kind: 'function', startLine: 1, endLine: 2 }
  const previous = projectGraph({ sources: [{ ...source, symbol }] })
  const files = new Map([[source.path, Buffer.from('function run() {\n}\n')]])
  for (const sha256 of ['original', 'updated']) {
    const snapshot = { files, metadata: { [source.path]: { sha256, lines: 3 } } }
    const graph = await enrichEvidence(projectGraph({ sources: [{ ...source }] }), snapshot, {
      previous, previousFiles: { [source.path]: { sha256: 'original' } },
    })
    assert.deepEqual(firstNode(graph).sources[0].symbol, sha256 === 'original' ? symbol : undefined)
  }
})
