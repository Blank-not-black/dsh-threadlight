import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { draftIdPattern } from './flow-draft.mjs'
import { MAX_GRAPH_BYTES, isIsoTimestamp, parseGraph } from './graph.mjs'
import { captureWorkspace, repositoryRoot } from './git-workspace.mjs'
import { enrichEvidence, openCodeIndexer } from './implementation-evidence.mjs'
import { reportDirectory, reportPath } from './implementation-prompt.mjs'
import { createLocalStore, readBytesFile } from './local-store.mjs'
import { publishReader } from './reader.mjs'
import { lock, readState, replace, safeDirectory, updateViewer } from './refresh.mjs'
import { anchorSources } from './source-anchors.mjs'

export { reportPath } from './implementation-prompt.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true })

async function list(path) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Implementation report directory must be a real directory: ' + path)
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function* readPendingReports(repository, { store, signal } = {}) {
  const control = join(repository, '.threadlight')
  const directory = join(control, reportDirectory)
  const drafts = (await list(directory)).filter(entry => entry.isDirectory() && draftIdPattern.test(entry.name))
  if (!drafts.length) return
  store ??= await createLocalStore(control)
  for (const { name: draftId } of drafts.sort((a, b) => a.name.localeCompare(b.name))) {
    const versions = (await list(join(directory, draftId)))
      .filter(entry => entry.isFile() && /^[1-9]\d*\.json$/.test(entry.name))
      .map(entry => Number(entry.name.slice(0, -5))).filter(Number.isSafeInteger).sort((a, b) => a - b)
    for (const version of versions) {
      const identity = { draftId, version }
      const marker = reportDirectory + '/' + draftId + '/' + version + '.applied.json'
      let entry
      try {
        const bytes = await readBytesFile(reportPath(repository, draftId, version), MAX_GRAPH_BYTES, signal)
        const reportHash = createHash('sha256').update(bytes).digest('hex')
        const applied = JSON.parse(await store.read(marker, signal))
        entry = applied?.reportHash === reportHash
          ? { ...identity, reason: 'Report already applied' }
          : { ...identity, marker, reportHash, report: JSON.parse(decoder.decode(bytes)) }
      } catch (error) {
        signal?.throwIfAborted()
        entry = { ...identity, error: error.message }
      }
      yield entry
    }
  }
}

function check(condition, message) {
  if (!condition) throw new Error('Invalid implementation report: ' + message)
}

function validateReport(report, draftId, version) {
  check(report?.schemaVersion === 1, 'schemaVersion must be 1')
  check(report.draft?.id === draftId && report.draft.version === version, 'draft identity does not match the report path')
  check(isIsoTimestamp(report.generatedAt), 'generatedAt must be an ISO-8601 timestamp')
  check(report.summary === undefined || typeof report.summary === 'string' && report.summary.length <= 2000 &&
    !report.summary.includes('\0'), 'summary must be text of at most 2000 characters')
  check(Array.isArray(report.steps) && report.steps.length >= 1 && report.steps.length <= 200,
    'steps must have between 1 and 200 items')
}

export function applyImplementationReport(previous, draft, report, snapshot, previousFiles) {
  validateReport(report, draft.id, draft.version)
  const { base } = draft
  if (!base || !['group', 'flow', 'digest'].every(key => typeof base[key] === 'string' && base[key])) {
    return { reason: 'Draft has no base flow' }
  }
  const group = previous.groups.find(group => group.id === base.group)
  const flow = group?.flows.find(flow => flow.id === base.flow)
  if (!flow) return { reason: 'Base flow is missing from the current graph' }

  check(Array.isArray(draft.plan?.nodes), 'draft plan has no steps')
  const draftSteps = new Set(draft.plan.nodes.map(node => node?.id))
  const current = new Map(flow.nodes.map(node => [node.id, node]))
  const updates = report.steps.map(record => {
    const { step, state, sources, verification, divergence } = record ?? {}
    check(typeof step === 'string' && draftSteps.has(step), 'step is missing from the draft: ' + String(step))
    const node = current.get(step)
    return { id: step, title: step, summary: step, details: [], sources,
      state: state === undefined ? node?.state : state,
      verification: verification === undefined ? node?.verification : verification,
      divergence: divergence === undefined ? node?.divergence : divergence }
  })
  // Validate even the steps absent from the current graph. The graph validator
  // also checks step ID uniqueness and all evidence and verification fields.
  const validated = parseGraph(JSON.stringify({
    schemaVersion: 1, project: { name: 'Implementation report' },
    groups: [{ id: 'report', title: 'Report', flows: [{ id: 'steps', title: 'Steps', summary: 'Steps', nodes: updates, edges: [] }] }],
  }))
  const skippedSteps = []
  const byId = new Map()
  for (const { id, sources, state, verification, divergence } of validated.groups[0].flows[0].nodes) {
    if (!current.has(id)) skippedSteps.push(id)
    else byId.set(id, {
      sources: sources.map(({ path, kind, line }) => ({ path, kind, line })), state, verification, divergence,
    })
  }
  if (!byId.size) return { reason: 'No reported steps exist in the current graph', skippedSteps }

  const graph = structuredClone(previous)
  const target = graph.groups.find(group => group.id === base.group).flows.find(flow => flow.id === base.flow)
  for (const node of target.nodes) {
    if (byId.has(node.id)) Object.assign(node, byId.get(node.id))
  }
  // Report references already describe current positions, including references
  // whose coordinates happen to match an older citation on this step.
  const prior = { groups: previous.groups.map(entry => entry !== group ? entry : {
    ...group, flows: group.flows.map(entry => entry !== flow ? entry : {
      ...flow, nodes: flow.nodes.filter(node => !byId.has(node.id)),
    }),
  }) }
  const evidence = anchorSources(graph, prior, snapshot, previousFiles)
  return { graph, skippedSteps, evidence }
}

export async function ingestImplementationReports(directory, { codeIndex, signal } = {}) {
  const root = await repositoryRoot(directory)
  const control = join(root, '.threadlight')
  const statePath = join(control, 'state.json')
  const viewer = join(control, 'viewer.html')
  const revisions = join(control, 'revisions')
  const summary = { revision: null, applied: [], skipped: [], rejected: [] }
  await safeDirectory(control)
  const release = await lock(control)
  try {
    const store = await createLocalStore(control)
    const state = await readState(statePath)
    summary.revision = state?.revision ?? null
    let previous, snapshot, indexer
    for await (const entry of readPendingReports(root, { store, signal })) {
      const { draftId, version, report, reportHash, marker, reason, error } = entry
      const identity = { draftId, version }
      if (reason) {
        summary.skipped.push({ ...identity, reason })
        continue
      }
      if (error) {
        summary.rejected.push({ ...identity, reason: error })
        continue
      }
      let draft
      try {
        validateReport(report, draftId, version)
        const folder = 'drafts/' + draftId + '/'
        draft = JSON.parse(await store.read(folder + version + '.json', signal))
        const receipt = JSON.parse(await store.read(folder + 'submitted-' + version + '.json', signal))
        const reason = !draft ? 'Draft version is missing'
          : draft.schemaVersion !== 1 || draft.id !== draftId || draft.version !== version ? 'Draft file identity does not match'
          : !receipt ? 'Draft submission receipt is missing'
          : receipt.version !== version ? 'Draft submission receipt version does not match'
          : !state ? 'No refresh revision is available' : null
        if (reason) {
          summary.skipped.push({ ...identity, reason })
          continue
        }
      } catch (error) {
        signal?.throwIfAborted()
        summary.rejected.push({ ...identity, reason: error.message })
        continue
      }
      previous ??= parseGraph(await store.read('revisions/' + state.revision + '/graph.json', signal))
      snapshot ??= await captureWorkspace(root)
      let update
      try {
        update = applyImplementationReport(previous, draft, report, snapshot, state.source.files)
      } catch (error) {
        summary.rejected.push({ ...identity, reason: error.message })
        continue
      }
      const { graph, skippedSteps, evidence } = update
      if (update.reason) {
        summary.skipped.push({ ...identity, reason: update.reason, skippedSteps })
        continue
      }
      indexer ??= await openCodeIndexer(codeIndex)
      const enriched = await enrichEvidence(graph, snapshot, {
        indexer, previous: !indexer || indexer.id === state.codeIndex ? previous : null,
        previousFiles: state.source.files, signal,
      })
      if ((await captureWorkspace(root)).id !== snapshot.id) throw new Error('Workspace changed during report ingestion; retry with the new snapshot')
      signal?.throwIfAborted()
      const { revision } = await publishReader(enriched, revisions)
      await updateViewer(viewer, enriched, revision)
      await replace(statePath, JSON.stringify({ ...state, revision }, null, 2) + '\n')
      await replace(join(control, marker), JSON.stringify({ reportHash, revision, at: new Date().toISOString() }, null, 2) + '\n')
      previous = enriched
      summary.revision = revision
      summary.applied.push({ ...identity, revision, skippedSteps, evidence })
    }
    return summary
  } finally {
    await release()
  }
}
