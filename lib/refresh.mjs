import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_GRAPH_BYTES, isIsoTimestamp } from './graph.mjs'
import { affectedFlows, applyDocumentUpdate } from './document-update.mjs'
import { captureWorkspace, fileChanges, repositoryRoot } from './git-workspace.mjs'
import { graphDigest, graphFile, graphText, readCurrentGraph, revisionPattern, withAbsorbedGraph } from './graph-source.mjs'
import { enrichEvidence, openCodeIndexer } from './implementation-evidence.mjs'
import { createLocalStore, readTextFile } from './local-store.mjs'
import { publishReader, readerVersion, renderReader } from './reader.mjs'
import { runDocumentSession } from './document-session.mjs'

export { revisionPattern } from './graph-source.mjs'

export async function safeDirectory(path) {
  await mkdir(path, { recursive: true })
  if (!(await lstat(path)).isDirectory()) throw new Error('Threadlight output must be a real directory')
}

export async function replace(path, data, beforeRename) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, data, { flag: 'wx' })
    await beforeRename?.()
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

export async function readHistory(control) {
  try {
    const path = join(control, 'history.json')
    if (!(await lstat(path)).isFile()) return []
    const history = JSON.parse(await readTextFile(path, MAX_GRAPH_BYTES))
    if (history?.schemaVersion === 1 && Array.isArray(history.entries) && history.entries.every(entry =>
      typeof entry?.revision === 'string' && revisionPattern.test(entry.revision) &&
      isIsoTimestamp(entry.at) && typeof entry.status === 'string' &&
      (entry.snapshotId === undefined || typeof entry.snapshotId === 'string') &&
      (entry.sessionId === undefined || typeof entry.sessionId === 'string'))) return history.entries
  } catch {
    // History can be rebuilt from the current revision directories.
  }
  return []
}

export async function appendHistory(control, entry) {
  const entries = await readHistory(control)
  if (entries.some(({ revision }) => revision === entry.revision)) return
  entries.push({ ...entry, at: new Date().toISOString() })
  await replace(join(control, 'history.json'), JSON.stringify({ schemaVersion: 1, entries: entries.slice(-200) }, null, 2) + '\n')
}

// Keep the working graph.json in step with the published revision after it has
// been absorbed, so a later DSH update starts from the evidence-bearing graph.
// Workspaces published only through the CLI never gain a graph.json.
export async function absorbWorkingGraph(readControl, control, graph, expectedDigest) {
  const ensureUnchanged = async () => {
    const current = await readControl(graphFile)
    const digest = current === null ? undefined : graphDigest(current)
    if (digest !== expectedDigest) {
      throw new Error('Threadlight working graph changed during analysis; review the new graph')
    }
  }
  if (expectedDigest === undefined) {
    await ensureUnchanged()
    return undefined
  }
  const text = graphText(graph)
  await replace(join(control, graphFile), text, ensureUnchanged)
  return graphDigest(text)
}

function processIsAlive(value) {
  const pid = Number(value)
  if (!/^[1-9][0-9]*$/.test(value) || pid > 0x7fffffff) throw new Error('Invalid Threadlight lock PID')
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code !== 'EPERM') throw error
  }
  return true
}

export async function lock(control) {
  const name = 'refresh.lock'
  const path = join(control, name)
  const pid = String(process.pid)
  const store = await createLocalStore(control)
  const claim = () => store.create(name, pid + '\n')
  const release = () => unlink(path)
  const busy = () => Object.assign(new Error('Another Threadlight refresh owns ' + path), { code: 'THREADLIGHT_LOCKED' })
  const owner = async () => {
    try { return await store.read(name) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }
  const ownerIsAlive = value => {
    try { return value !== null && processIsAlive(value.trim()) } catch (error) {
      throw new Error('Cannot determine the owner of ' + path + ': ' + error.message, { cause: error })
    }
  }
  if (await claim()) return release
  if (ownerIsAlive(await owner())) throw busy()

  // Serialize stale-lock cleanup. Register before listing contenders so only
  // one live process can pass the scan at a time, even after an interrupted cleanup.
  const recovery = join(control, 'refresh-recovery')
  await safeDirectory(recovery)
  const marker = join(recovery, pid)
  try { await mkdir(marker) } catch (error) {
    if (error.code === 'EEXIST') throw busy()
    throw error
  }
  try {
    const contenders = (await readdir(recovery)).filter(name => name !== pid && /^[1-9][0-9]*$/.test(name))
    if (contenders.some(processIsAlive)) throw busy()
    const current = await owner()
    if (current !== null) {
      if (ownerIsAlive(current)) throw busy()
      await unlink(path)
    }
    if (!await claim()) throw busy()
  } finally {
    await rmdir(marker)
  }
  return release
}

export async function updateViewer(viewer, graph, revision) {
  await replace(viewer, renderReader(graph, { documentHref: 'revisions/' + revision + '/project.md' }))
}

export async function refreshDocumentation(directory, options = {}) {
  const { signal, failedSnapshot, runSession = runDocumentSession } = options
  const indexer = await openCodeIndexer(options.codeIndex)
  const root = await repositoryRoot(directory)
  const control = join(root, '.threadlight')
  const statePath = join(control, 'state.json')
  const revisions = join(control, 'revisions')
  const viewer = join(control, 'viewer.html')
  const readControl = async path => {
    try {
      return await readTextFile(join(control, path), MAX_GRAPH_BYTES, signal)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  await safeDirectory(control)
  const release = await lock(control)
  let snapshot
  try {
    signal?.throwIfAborted()
    await safeDirectory(revisions)
    // The current graph is the working graph.json when a DSH session or the user
    // changed it after the last publication; otherwise it is the published revision.
    const current = await readCurrentGraph(readControl, { signal })
    const state = current?.state ?? null
    const unabsorbed = current?.unabsorbed === true
    const workingDigest = current?.working?.digest
    snapshot = await captureWorkspace(root)
    if (snapshot.id === failedSnapshot) return { status: 'waiting', viewer }
    if (!snapshot.files.size) throw new Error('No inspectable source files in the Git working tree; see the Threadlight README for supported files')
    const codeIndex = indexer?.id ?? null
    const sameIndexer = (state?.codeIndex ?? null) === codeIndex
    const sameReader = state?.readerVersion === readerVersion && sameIndexer
    if (!unabsorbed && snapshot.id === state?.source?.id && sameReader) return { status: 'unchanged', viewer }
    const changes = fileChanges(state?.source?.files, snapshot.metadata)
    const source = { id: snapshot.id, head: snapshot.head, files: snapshot.metadata }
    if (!unabsorbed && state && !changes.length && sameReader) {
      await replace(statePath, JSON.stringify({ ...state, source }, null, 2) + '\n')
      return { status: 'unchanged', viewer }
    }
    const previous = current?.graph ?? null
    const enrich = graph => enrichEvidence(graph, snapshot, {
      indexer, previous: previous && (sameIndexer || !indexer) ? previous : null, previousFiles: state?.source?.files, signal,
    })
    // No source change means the working graph is published as it stands. The
    // absorbed digest then marks the publication and the mirror as in sync.
    if (previous && !changes.length) {
      const graph = await enrich(previous)
      const result = await publishReader(graph, revisions)
      const absorbed = await absorbWorkingGraph(readControl, control, graph, workingDigest)
      await updateViewer(viewer, graph, result.revision)
      const base = state ? { ...state, source } : { schemaVersion: 1, source }
      await replace(statePath, JSON.stringify(withAbsorbedGraph({
        ...base, revision: result.revision, readerVersion, codeIndex,
      }, absorbed), null, 2) + '\n')
      await appendHistory(control, { revision: result.revision, status: 'rendered', snapshotId: snapshot.id })
      return { status: 'rendered', viewer, document: result.document, snapshot: result.revision }
    }
    const input = { mode: previous ? 'incremental' : 'full', snapshotId: snapshot.id, head: snapshot.head,
      changes, affectedFlows: affectedFlows(previous, changes) }
    const { update, sessionId } = await runSession({ control, snapshot, input, previous,
      patch: options.patch, dshCli: options.dshCli, signal })
    const { graph: authored, changed, flowChanges, evidence, reviewedFlows } =
      applyDocumentUpdate(previous, update, input, snapshot, state?.source?.files)
    const graph = await enrich(authored)
    const after = await captureWorkspace(root)
    if (after.id !== snapshot.id) throw new Error('Workspace changed during analysis; review the new snapshot')
    signal?.throwIfAborted()
    const result = await publishReader(graph, revisions)
    const absorbed = await absorbWorkingGraph(readControl, control, graph, workingDigest)
    await updateViewer(viewer, graph, result.revision)
    await replace(statePath, JSON.stringify(withAbsorbedGraph({
      schemaVersion: 1, source, revision: result.revision, sessionId, readerVersion, codeIndex, reviewedFlows,
    }, absorbed), null, 2) + '\n')
    const status = changed ? 'updated' : 'reviewed'
    await appendHistory(control, { revision: result.revision, status, snapshotId: snapshot.id, sessionId })
    return {
      status, sessionId, changes, viewer,
      document: result.document, snapshot: result.revision, affectedFlows: input.affectedFlows.length, flowChanges, evidence,
    }
  } catch (error) {
    if (snapshot) error.snapshotId = snapshot.id
    throw error
  } finally {
    await release()
  }
}
