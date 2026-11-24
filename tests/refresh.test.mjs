import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs, { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureWorkspace } from '../lib/git-workspace.mjs'
import { refreshDocumentation } from '../lib/refresh.mjs'
import { resetDocumentation } from '../lib/reset.mjs'

const threadlightCli = fileURLToPath(new URL('../bin/dsh-threadlight.mjs', import.meta.url))

const fakeDsh = `
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
let task = ''
for await (const chunk of process.stdin) task += chunk
assert.match(task, /Document a Threadlight snapshot/)
assert.deepEqual(process.argv.slice(2, 4), ['--profile', 'headless'])
assert.equal(process.env.USERPROFILE, process.env.HOME)
assert.ok(process.env.DSH_HOME.startsWith(process.env.HOME))
await assert.rejects(readFile('.env'), { code: 'ENOENT' })
const input = JSON.parse(await readFile('.threadlight/input.json', 'utf8'))
const uploading = await readFile('src/upload.js', 'utf8')
const title = uploading.includes('resume') ? 'Resume upload' : 'Upload file'
const flow = (id, title) => ({ id, title, summary: title, nodes: [{
  id: 'run', title, summary: title, details: ['Follow the source.'],
  sources: [{ path: 'src/' + id + '.js', line: 1, kind: 'source' }],
}], edges: [] })
const base = {
  snapshotId: input.snapshotId,
  reviewedPaths: input.changes.map(change => change.path),
  reviewedFlows: input.affectedFlows.map(({ group, flow }) => ({ group, flow, reason: 'The upload now resumes.' })),
}
const update = input.mode === 'full' ? {
  ...base, project: { name: 'Files' }, groups: [
    { id: 'files', title: 'Files', flows: [flow('upload', title), flow('download', 'Download file')] },
  ],
  glossary: [
    { term: 'HTTP', definition: 'The protocol for file requests.' },
    { term: 'Chunk', definition: 'A piece of a larger file.' },
  ],
} : {
  ...base, groups: [{ id: 'files', flows: [flow('upload', title)] }],
  glossary: [{ term: 'http', definition: 'The upload now sends resumable requests.' }],
}
if (input.mode === 'incremental') {
  const old = JSON.parse(await readFile('.threadlight/previous.json', 'utf8'))
  assert.equal(old.groups[0].flows[0].title, 'Upload file')
  assert.equal(old.groups[0].flows[0].nodes[0].sources[0].anchor, undefined)
  assert.deepEqual(input.affectedFlows, [{ group: 'files', flow: 'upload', paths: ['src/upload.js'] }])
}
await writeFile('.threadlight/update.json', JSON.stringify(update))
console.log(JSON.stringify({ type: 'session', sessionId: 'fixture-' + input.mode }))
console.log(JSON.stringify({ type: 'status', reason: { kind: 'completed' } }))
`

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'threadlight-refresh-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'repo')
  const cli = join(directory, 'fake-dsh.mjs')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(cli, fakeDsh)
  await writeFile(join(root, '.env'), 'SECRET=never copied')
  await writeFile(join(root, 'src/upload.js'), 'export const action = "upload"\n')
  await writeFile(join(root, 'src/download.js'), 'export const action = "download"\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  git('init')
  git('add', 'src')
  git('-c', 'user.name=Threadlight Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial')
  return { root, cli, git }
}

async function readGraph(root, revision) {
  return JSON.parse(await readFile(join(root, '.threadlight/revisions', revision, 'graph.json'), 'utf8'))
}

function acknowledge(input) {
  return {
    snapshotId: input.snapshotId,
    reviewedPaths: input.changes.map(change => change.path),
    reviewedFlows: input.affectedFlows.map(({ group, flow }) => ({ group, flow, reason: 'Reviewed implementation and evidence.' })),
    groups: [],
  }
}

async function reviewUnchanged({ input }) {
  return { update: acknowledge(input), sessionId: 'review-only' }
}

test('independent DSH sessions generate synchronized Markdown and viewer and preserve unrelated flows', async t => {
  const { root, cli, git } = await fixture(t)
  const first = await refreshDocumentation(root, { dshCli: cli })
  assert.equal(first.sessionId, 'fixture-full')
  assert.deepEqual(first.flowChanges, { added: 2, modified: 0, removed: 0 })
  const html = await readFile(first.viewer, 'utf8')
  assert.match(html, /Upload file/)
  assert.ok(html.includes('href="revisions/' + first.snapshot + '/project.md"'))
  assert.match(await readFile(join(first.document, '../index.html'), 'utf8'), /href="project\.md"/)
  assert.match(await readFile(first.document, 'utf8'), /docs\/files\.md/)
  assert.equal((await refreshDocumentation(root, { dshCli: 'unneeded' })).status, 'unchanged')
  const statePath = join(root, '.threadlight/state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  delete state.readerVersion
  await writeFile(statePath, JSON.stringify(state))
  await writeFile(first.viewer, 'old reader')
  assert.equal((await refreshDocumentation(root, { dshCli: 'unneeded' })).status, 'rendered')
  const history = join(root, '.threadlight/history.json')
  const firstHistory = JSON.parse(await readFile(history, 'utf8'))
  assert.equal(firstHistory.schemaVersion, 1)
  assert.equal(firstHistory.entries.length, 1)
  assert.equal(firstHistory.entries[0].revision, first.snapshot)
  assert.equal(firstHistory.entries[0].status, 'updated')
  assert.equal(firstHistory.entries[0].snapshotId, state.source.id)
  assert.equal(firstHistory.entries[0].sessionId, first.sessionId)
  assert.ok(Number.isFinite(Date.parse(firstHistory.entries[0].at)))
  await writeFile(history, '{ broken history')
  assert.match(await readFile(first.viewer, 'utf8'), /The protocol for file requests\./)
  await writeFile(join(root, 'src/upload.js'), 'export const action = "resume upload"\n')
  await writeFile(join(root, 'src/retry.js'), 'export const retries = 3\n')
  const next = await refreshDocumentation(root, { dshCli: cli })
  assert.deepEqual(JSON.parse(await readFile(history, 'utf8')).entries.map(entry => entry.revision), [next.snapshot])
  assert.equal(next.status, 'updated')
  assert.equal(next.sessionId, 'fixture-incremental')
  assert.equal(next.affectedFlows, 1)
  assert.deepEqual(next.flowChanges, { added: 0, modified: 1, removed: 0 })
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).reviewedFlows, [
    { group: 'files', flow: 'upload', reason: 'The upload now resumes.' },
  ])
  assert.deepEqual(next.changes, [{ path: 'src/retry.js', kind: 'added' }, { path: 'src/upload.js', kind: 'modified' }])
  assert.equal(next.viewer, first.viewer)
  assert.match(await readFile(next.viewer, 'utf8'), /Resume upload/)
  assert.match(await readFile(join(next.document, '../docs/files.md'), 'utf8'), /Resume upload/)
  const oldGraph = await readGraph(root, first.snapshot)
  const newGraph = await readGraph(root, next.snapshot)
  assert.deepEqual(newGraph.groups[0].flows[1], oldGraph.groups[0].flows[1])
  assert.deepEqual(newGraph.glossary, [
    { term: 'http', definition: 'The upload now sends resumable requests.' },
    oldGraph.glossary[1],
  ])
  git('add', 'src')
  git('-c', 'user.name=Threadlight Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'update')
  assert.equal((await refreshDocumentation(root, { dshCli: 'unneeded' })).status, 'unchanged')
})

test('invalid references and concurrent source edits keep the last good viewer and state', async t => {
  const { root, cli } = await fixture(t)
  const first = await refreshDocumentation(root, { dshCli: cli })
  const state = join(root, '.threadlight/state.json')
  const baseline = await readFile(state, 'utf8')
  const viewer = await readFile(first.viewer, 'utf8')
  const removed = join(root, 'src/download.js')
  await rm(removed)
  await assert.rejects(refreshDocumentation(root, { runSession: async ({ input }) => {
    assert.deepEqual(input.changes, [{ path: 'src/download.js', kind: 'removed' }])
    return { update: acknowledge(input), sessionId: 'invalid-references' }
  } }), /Source reference is missing or out of bounds/)
  assert.equal(await readFile(state, 'utf8'), baseline)
  assert.equal(await readFile(first.viewer, 'utf8'), viewer)
  await writeFile(removed, 'export const action = "new download"\n')
  await assert.rejects(refreshDocumentation(root, { runSession: async ({ input }) => {
    await writeFile(removed, 'export const action = "edited during analysis"\n')
    return { update: acknowledge(input), sessionId: 'concurrent-edit' }
  } }), /Workspace changed during analysis/)
  assert.equal(await readFile(state, 'utf8'), baseline)
  assert.equal(await readFile(first.viewer, 'utf8'), viewer)
})

test('incremental reviews distinguish an identical document from relocated or ambiguous evidence', async t => {
  const { root, cli } = await fixture(t)
  const first = await refreshDocumentation(root, { dshCli: cli })
  const sourcePath = join(root, 'src/upload.js')
  const original = await readFile(sourcePath, 'utf8')
  await writeFile(sourcePath, original + '// unrelated comment\n')
  await assert.rejects(refreshDocumentation(root, { runSession: async ({ input }) => ({
    update: { ...acknowledge(input), reviewedFlows: [] },
  }) }), /report a review for every affected flow/)

  const noChange = await refreshDocumentation(root, { runSession: reviewUnchanged })
  assert.equal(noChange.status, 'reviewed')
  assert.equal(noChange.affectedFlows, 1)
  assert.deepEqual(noChange.flowChanges, { added: 0, modified: 0, removed: 0 })
  assert.equal(await readFile(noChange.document, 'utf8'), await readFile(first.document, 'utf8'))

  await writeFile(sourcePath, '// inserted before evidence\n' + original)
  const moved = await refreshDocumentation(root, { runSession: async ({ input, previous }) => ({
    update: { ...acknowledge(input), groups: [{ id: 'files', flows: [previous.groups[0].flows[0]] }] },
    sessionId: 'echoed-flow',
  }) })
  assert.equal(moved.status, 'updated')
  assert.deepEqual(moved.flowChanges, { added: 0, modified: 1, removed: 0 })
  assert.deepEqual(moved.evidence, { relocated: 1, needsReview: 0 })
  const movedGraph = await readGraph(root, moved.snapshot)
  assert.equal(movedGraph.groups[0].flows[0].nodes[0].sources[0].line, 2)

  await writeFile(sourcePath, original.trimEnd())
  const shortened = await refreshDocumentation(root, { runSession: reviewUnchanged })
  assert.deepEqual(shortened.evidence, { relocated: 1, needsReview: 0 })
  assert.equal((await readGraph(root, shortened.snapshot)).groups[0].flows[0].nodes[0].sources[0].line, 1)

  await writeFile(sourcePath, '// inserted before evidence\n' + original)
  await refreshDocumentation(root, { runSession: reviewUnchanged })

  const block = '// inserted before evidence\n' + original
  await writeFile(sourcePath, block + '\n' + block)
  const ambiguous = await refreshDocumentation(root, { runSession: reviewUnchanged })
  assert.deepEqual(ambiguous.evidence, { relocated: 0, needsReview: 1 })
  const graph = await readGraph(root, ambiguous.snapshot)
  assert.deepEqual(graph.groups[0].flows[0].nodes[0].sources[0],
    { path: 'src/upload.js', kind: 'source', status: 'needs-review' })
  const md = await readFile(join(ambiguous.document, '../docs/files.md'), 'utf8')
  assert.match(md, /src\/upload\.js · source · 证据待复核/)
  assert.doesNotMatch(md, /src\/upload\.js:/)

  await writeFile(join(root, 'src/other.js'), '// trigger a new review\n')
  const repaired = await refreshDocumentation(root, { runSession: async ({ input, previous }) => {
    assert.deepEqual(input.affectedFlows, [{ group: 'files', flow: 'upload', paths: ['src/upload.js'] }])
    const flow = structuredClone(previous.groups[0].flows[0])
    flow.nodes[0].sources = [{ path: 'src/upload.js', kind: 'source', line: 2, lineText: original.trimEnd() }]
    return { update: { ...acknowledge(input), groups: [{ id: 'files', flows: [flow] }] }, sessionId: 'repair' }
  } })
  assert.deepEqual(repaired.evidence, { relocated: 0, needsReview: 0 })
  const [reference] = (await readGraph(root, repaired.snapshot)).groups[0].flows[0].nodes[0].sources
  assert.equal(reference.line, 2)
  assert.match(reference.anchor.lineHash, /^[a-f0-9]{64}$/)
  assert.equal(reference.lineText, undefined)
})

test('new flow revisions require real branch labels and reject mismatched evidence excerpts', async t => {
  const { root, cli } = await fixture(t)
  await refreshDocumentation(root, { dshCli: cli })
  await writeFile(join(root, 'src/upload.js'), 'export const action = "retry"\n')
  async function branchUpdate({ input, previous }, label, lineText) {
    const flow = structuredClone(previous.groups[0].flows[0])
    flow.nodes.push({ id: 'retry', title: 'Retry', summary: 'The user can retry the upload.', details: [], sources: [] })
    flow.edges.push({ from: 'run', to: 'retry', kind: 'branch', label })
    flow.nodes[0].sources[0].lineText = lineText
    return { update: { ...acknowledge(input), groups: [{ id: 'files', flows: [flow] }] }, sessionId: 'branch' }
  }
  await assert.rejects(refreshDocumentation(root, { runSession: args => branchUpdate(args) }), /branch requires a condition label/)
  await assert.rejects(refreshDocumentation(root, {
    runSession: args => branchUpdate(args, 'The upload fails', 'export const action = "upload"'),
  }), /lineText does not match/)
  const result = await refreshDocumentation(root, {
    runSession: args => branchUpdate(args, 'The upload fails', 'export const action = "retry"'),
  })
  assert.equal(result.status, 'updated')
  const updated = (await readGraph(root, result.snapshot)).groups[0].flows[0]
  assert.equal(updated.edges[0].label, 'The upload fails')
  assert.equal(updated.nodes[0].sources[0].line, 1)
})

test('refresh recovers a dead lock and rejects refreshes while its live owner is running', async t => {
  const { root, cli } = await fixture(t)
  const control = join(root, '.threadlight')
  await mkdir(control)
  const lock = join(control, 'refresh.lock')
  const exitedPid = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  await writeFile(lock, exitedPid)
  assert.equal((await refreshDocumentation(root, { dshCli: cli })).status, 'updated')
  await assert.rejects(readFile(lock), { code: 'ENOENT' })

  await writeFile(join(root, 'src/unrelated.js'), '// trigger a new review\n')
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const owner = refreshDocumentation(root, { runSession: async args => {
    entered.resolve()
    await finish.promise
    return reviewUnchanged(args)
  } })
  try {
    await Promise.race([entered.promise, owner])
    await assert.rejects(refreshDocumentation(root, { dshCli: cli }), /Another Threadlight refresh owns/)
    await assert.rejects(resetDocumentation(root), { code: 'THREADLIGHT_LOCKED' })
    assert.equal((await readFile(lock, 'utf8')).trim(), String(process.pid))
  } finally {
    finish.resolve()
    await owner
  }
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
})

test('reset archives the publication, keeps workspace data and refreshes a hand-written graph', async t => {
  const { root, cli } = await fixture(t)
  const control = join(root, '.threadlight')
  const first = await refreshDocumentation(root, { dshCli: cli })
  const kept = ['drafts', 'annotations', 'implementation', 'obsidian']
  for (const name of kept) {
    await mkdir(join(control, name))
    await writeFile(join(control, name, 'keep'), name)
  }
  // A valid graph.json that was never absorbed is user input; reset keeps it and
  // the next refresh reviews it incrementally instead of discarding it.
  const authored = {
    schemaVersion: 1,
    project: { name: 'Files' },
    groups: [{
      id: 'files', title: 'Files',
      flows: [{
        id: 'upload', title: 'Upload file', summary: 'Upload file',
        nodes: [{
          id: 'run', title: 'Upload file', summary: 'Upload file', details: ['Follow the source.'],
          sources: [{ path: 'src/upload.js', line: 1, kind: 'source' }],
        }],
        edges: [],
      }],
    }],
  }
  const authoredText = JSON.stringify(authored, null, 2) + '\n'
  await writeFile(join(control, 'graph.json'), authoredText)
  await writeFile(join(control, 'changes.md'), '# 图谱变动日志\n')
  const run = () => spawnSync(process.execPath, [threadlightCli, 'reset'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const reset = run()
  assert.equal(reset.status, 0, reset.stderr)
  const { archived, moved, next } = JSON.parse(reset.stdout)
  assert.match(archived, /^\.threadlight\/archive\/\d{8}T\d{6}Z$/)
  assert.equal(next, 'refresh')
  assert.deepEqual(moved, ['state.json', 'viewer.html', 'revisions', 'history.json', 'changes.md'])
  assert.deepEqual((await readdir(join(root, archived))).sort(), moved.toSorted())
  assert.deepEqual((await readdir(control)).sort(), ['archive', 'graph.json', ...kept].toSorted())
  for (const name of kept) assert.equal(await readFile(join(control, name, 'keep'), 'utf8'), name)
  assert.equal(await readFile(join(control, 'graph.json'), 'utf8'), authoredText)
  const repeated = run()
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.match(repeated.stderr, /无需重置/)
  assert.deepEqual(JSON.parse(repeated.stdout), { archived: null, moved: [], next: 'refresh' })

  const regenerated = await refreshDocumentation(root, { dshCli: cli })
  assert.equal(regenerated.status, 'rendered')
  const authoredPublished = await readGraph(root, regenerated.snapshot)
  assert.equal(authoredPublished.groups[0].flows[0].title, 'Upload file')
  const history = JSON.parse(await readFile(join(control, 'history.json'), 'utf8'))
  assert.deepEqual(history.entries.map(entry => entry.revision), [regenerated.snapshot])
})

test('reset archives a mirrored working graph so the next refresh rebuilds from source', async t => {
  const { root, cli } = await fixture(t)
  const control = join(root, '.threadlight')
  const first = await refreshDocumentation(root, { dshCli: cli })
  // Publishing a graph.json that matches the publication absorbs it as a mirror.
  const published = await readFile(join(control, 'revisions', first.snapshot, 'graph.json'), 'utf8')
  await writeFile(join(control, 'graph.json'), published)
  const rendered = await refreshDocumentation(root, {})
  assert.equal(rendered.status, 'rendered')
  const state = JSON.parse(await readFile(join(control, 'state.json'), 'utf8'))
  assert.equal(typeof state.absorbedGraphDigest, 'string')

  const reset = spawnSync(process.execPath, [threadlightCli, 'reset'], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(reset.status, 0, reset.stderr)
  assert.ok(JSON.parse(reset.stdout).moved.includes('graph.json'))
  await assert.rejects(readFile(join(control, 'graph.json'), 'utf8'), { code: 'ENOENT' })

  const rebuilt = await refreshDocumentation(root, { dshCli: cli })
  assert.equal(rebuilt.sessionId, 'fixture-full')
})

test('refresh preserves an edit made while the new revision is written', async t => {
  const { root, cli } = await fixture(t)
  const first = await refreshDocumentation(root, { dshCli: cli })
  const graph = await readGraph(root, first.snapshot)
  const control = join(root, '.threadlight')
  const working = join(control, 'graph.json')
  const state = join(control, 'state.json')
  const priorState = await readFile(state, 'utf8')
  const priorViewer = await readFile(first.viewer, 'utf8')
  graph.project.name = 'First working edit'
  await writeFile(working, JSON.stringify(graph))
  graph.project.name = 'Concurrent working edit'
  const newest = JSON.stringify(graph)

  const link = fs.link
  t.mock.method(fs, 'link', async (from, to) => {
    if (to.endsWith('threadlight-reader.json')) await writeFile(working, newest)
    return link(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(refreshDocumentation(root), /working graph changed during analysis/)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(await readFile(working, 'utf8'), newest)
  assert.equal(await readFile(state, 'utf8'), priorState)
  assert.equal(await readFile(first.viewer, 'utf8'), priorViewer)
  const retried = await refreshDocumentation(root)
  assert.equal((await readGraph(root, retried.snapshot)).project.name, graph.project.name)
})

test('workspace capture includes authentication code and supported languages while excluding credential files', async t => {
  const { root } = await fixture(t)
  const included = ['src/auth.js', 'src/token-recovery.test.js', 'src/View.vue', 'src/program.cs', 'src/program.cpp',
    'src/program.rb', 'src/program.php', 'src/Program.swift', 'src/program.dart', 'src/View.svelte']
  const excluded = ['src/auth.json', 'src/credentials.yaml', 'src/private.pem', 'src/pnpm-lock.yml']
  for (const path of [...included, ...excluded]) await writeFile(join(root, path), 'test\n')
  await writeFile(join(root, 'src/binary.cs'), Buffer.from([255]))
  const snapshot = await captureWorkspace(root)
  assert.deepEqual([...snapshot.files.keys()].sort(), [...included, 'src/upload.js', 'src/download.js'].sort())

  for (const path of snapshot.files.keys()) await rm(join(root, path))
  await assert.rejects(refreshDocumentation(root, { runSession: async () => assert.fail('No model session needed') }),
    /No inspectable source files/)
})

test('workspace capture resolves a linked root before comparing candidate paths', async t => {
  const { root } = await fixture(t)
  const outer = await mkdtemp(join(tmpdir(), 'threadlight-link-'))
  t.after(() => rm(outer, { recursive: true, force: true }))
  const linked = join(outer, 'linked-repo')
  await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const snapshot = await captureWorkspace(linked)
  assert.deepEqual([...snapshot.files.keys()].sort(), ['src/download.js', 'src/upload.js'])
})

test('refresh ties a step to the current source and documentation and publishes stable links', async t => {
  const { root } = await fixture(t)
  const codeIndex = process.env.THREADLIGHT_CODE_INDEX
  const source = join(root, 'src/upload.js')
  const note = join(root, 'guide.md')
  const sourceText = 'export function retryUpload() {\n  return "retry"\n}\n'
  const noteText = '# Retry from the failed step\nKeep the selected file.\n'
  await writeFile(source, sourceText)
  await writeFile(note, noteText)
  const first = await refreshDocumentation(root, { runSession: async ({ input }) => ({
    sessionId: 'first',
    update: { ...acknowledge(input), project: { name: 'Files' }, groups: [{
      id: 'files', title: 'Files', flows: [{
        id: 'upload', title: 'Upload', summary: 'Upload a file', edges: [], nodes: [{
          id: 'retry', title: 'Retry upload', summary: 'Keep the selected file', details: [],
          sources: [{ path: 'src/upload.js', kind: 'source', line: 1 }, { path: 'guide.md', kind: 'documentation', line: 1 }],
        }],
      }],
    }] },
  }) })
  const readNode = async revision => (await readGraph(root, revision)).groups[0].flows[0].nodes[0]
  const indexed = codeIndex ? await refreshDocumentation(root, {
    codeIndex, runSession: async () => assert.fail('Enabling the indexer needs no new DSH session'),
  }) : first
  if (codeIndex) assert.equal(indexed.status, 'rendered')
  const original = await readNode(indexed.snapshot)
  assert.match(original.sources[1].preview.text, /Keep the selected file/)
  if (codeIndex) assert.deepEqual(original.sources[0].symbol, { name: 'retryUpload', kind: 'function', startLine: 1, endLine: 3 })
  assert.match(await readFile(join(first.document, '../docs/files.md'), 'utf8'), /\.\.\/index\.html#step\/files\/upload\/retry/)
  assert.match(await readFile(join(first.document, '../docs/files.html'), 'utf8'), /id="upload--retry"/)
  await writeFile(source, '// moved without committing\n' + sourceText)
  await writeFile(note, 'Introduction\n\n' + noteText)
  const next = await refreshDocumentation(root, { codeIndex, runSession: reviewUnchanged })
  const moved = await readNode(next.snapshot)
  assert.equal(moved.id, original.id)
  assert.deepEqual(moved.sources.map(item => item.line), [2, 3])
  if (codeIndex) assert.equal(moved.sources[0].symbol.startLine, 2)
  assert.equal(moved.sources[1].preview.startLine, 3)
  assert.match(moved.sources[1].preview.text, /# Retry from the failed step/)
})

test('refresh merges area updates and preserves the last publication on invalid assignments', async t => {
  const { root, cli } = await fixture(t)
  async function update(patch) {
    return refreshDocumentation(root, { runSession: async ({ input }) => ({
      update: { ...acknowledge(input), ...patch },
    }) })
  }
  const first = await refreshDocumentation(root, { dshCli: cli })
  assert.equal((await readGraph(root, first.snapshot)).project.areas, undefined)
  const storage = { id: 'storage', title: '存储', summary: '管理文件。' }
  const sharing = { id: 'sharing', title: '共享' }
  const archive = { id: 'archive', title: '归档' }
  const trigger = join(root, 'src/areas.js')

  await writeFile(trigger, '// introduce areas\n')
  const grouped = await update({ areas: [storage, sharing], groups: [{ id: 'files', area: 'storage', flows: [] }] })
  assert.equal(grouped.status, 'updated')
  assert.deepEqual(grouped.flowChanges, { added: 0, modified: 0, removed: 0 })
  assert.deepEqual((await readGraph(root, grouped.snapshot)).project.areas, [storage, sharing])
  assert.match(await readFile(grouped.document, 'utf8'), /## 领域\n\n- <a id="area-storage"><\/a>存储 · 管理文件。\n  - \[Files\]\(docs\/files\.md\)/)
  assert.match(await readFile(join(grouped.document, '../docs/files.md'), 'utf8'), /\[存储\]\(\.\.\/project\.md#area-storage\) → Files/)
  assert.match(await readFile(join(grouped.document, '../docs/files.html'), 'utf8'), /存储 → Files/)

  await writeFile(trigger, '// revise areas\n')
  const renamed = { id: 'storage', title: '文件存储' }
  const revised = await update({ areas: [archive, renamed], groups: [{ id: 'files', flows: [] }] })
  assert.equal(revised.status, 'updated')
  const revisedGraph = await readGraph(root, revised.snapshot)
  assert.deepEqual(revisedGraph.project.areas, [renamed, sharing, archive])
  assert.equal(revisedGraph.groups[0].area, 'storage')

  await writeFile(trigger, '// move group\n')
  const moved = await update({ groups: [{ id: 'files', area: 'archive', flows: [] }] })
  assert.equal(moved.status, 'updated')
  assert.equal((await readGraph(root, moved.snapshot)).groups[0].area, 'archive')
  assert.match(await readFile(moved.document, 'utf8'), /归档\n  - \[Files\]/)

  const state = join(root, '.threadlight/state.json')
  const published = await readFile(state, 'utf8')
  const view = await readFile(moved.viewer, 'utf8')
  await writeFile(trigger, '// invalid assignment\n')
  await assert.rejects(update({ groups: [{ id: 'files', area: 'unknown', flows: [] }] }), /references an unknown area/)
  await assert.rejects(update({ areas: Array.from({ length: 30 }, (_, i) => ({ id: 'new-' + i, title: '新领域' })) }),
    /project\.areas must have between 0 and 32 items/)
  assert.equal(await readFile(state, 'utf8'), published)
  assert.equal(await readFile(moved.viewer, 'utf8'), view)
})
