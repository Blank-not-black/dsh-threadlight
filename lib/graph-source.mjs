import { createHash } from 'node:crypto'
import { parseGraph } from './graph.mjs'

export const graphFile = 'graph.json'
export const stateFile = 'state.json'
export const revisionPattern = /^threadlight-[0-9a-f]{16}$/
export const digestPattern = /^[0-9a-f]{64}$/

export function graphDigest(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function graphText(graph) {
  return JSON.stringify(graph, null, 2) + '\n'
}

export function parseStateText(text) {
  const state = JSON.parse(text)
  // source predates older hand-written states; it is required only when present
  // so previously published workspaces keep opening.
  if (!state || typeof state !== 'object' || typeof state.revision !== 'string' || !revisionPattern.test(state.revision)) {
    throw new Error('Invalid Threadlight state')
  }
  if (state.schemaVersion !== undefined && state.schemaVersion !== 1) throw new Error('Invalid Threadlight state')
  if (state.source !== undefined &&
    (typeof state.source?.id !== 'string' || !digestPattern.test(state.source.id) || !state.source?.files)) {
    throw new Error('Invalid Threadlight state')
  }
  if (state.absorbedGraphDigest !== undefined &&
    (typeof state.absorbedGraphDigest !== 'string' || !digestPattern.test(state.absorbedGraphDigest))) {
    throw new Error('Invalid Threadlight state')
  }
  return state
}

// The absorbed digest records which working-copy content the published revision
// already contains. A working graph.json with a different digest is newer.
export function withAbsorbedGraph(state, absorbed) {
  const next = { ...state }
  if (absorbed) next.absorbedGraphDigest = absorbed
  else delete next.absorbedGraphDigest
  return next
}

function graphEntry(text) {
  return { raw: text, digest: graphDigest(text), graph: parseGraph(text) }
}

/**
 * Resolve the graph a workspace currently shows.
 *
 * The published revision wins while graph.json still carries the content it was
 * built from. A graph.json with any other digest is a working copy (written by a
 * DSH graph session or by hand) and wins until refresh or report absorbs it.
 *
 * `read(relativePath)` resolves paths under `.threadlight` and returns text, or
 * null when the file does not exist. Returns null when the workspace has no graph.
 */
export async function readCurrentGraph(read, { signal } = {}) {
  signal?.throwIfAborted()
  const stateText = await read(stateFile)
  const state = stateText === null ? null : parseStateText(stateText)
  let published = null
  if (state) {
    const text = await read('revisions/' + state.revision + '/' + graphFile)
    if (text === null) throw new Error('找不到 Threadlight 状态文件指向的图谱，请刷新图谱。')
    published = graphEntry(text)
  }
  const workingText = await read(graphFile)
  const working = workingText === null ? null : graphEntry(workingText)
  if (!published && !working) return null
  const unabsorbed = working !== null && (state === null || working.digest !== state.absorbedGraphDigest)
  const current = unabsorbed ? working : (published ?? working)
  return {
    graph: current.graph,
    raw: current.raw,
    digest: current.digest,
    published: published !== null && current === published,
    state,
    working,
    unabsorbed,
  }
}
