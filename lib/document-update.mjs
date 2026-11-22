import { isDeepStrictEqual } from 'node:util'
import { parseGlossary, parseGraph } from './graph.mjs'
import { anchorSources } from './source-anchors.mjs'

export function affectedFlows(graph, changes) {
  const paths = new Set(changes.map(change => change.path))
  return (graph?.groups ?? []).flatMap(group => group.flows.map(flow => ({
    group: group.id, flow: flow.id,
    paths: [...new Set(flow.nodes.flatMap(node => node.sources)
      .filter(source => paths.has(source.path) || source.status === 'needs-review').map(source => source.path))],
  })).filter(flow => flow.paths.length))
}

function reviewFlows(affected, reviews) {
  const reported = reviews ?? []
  const expected = new Set(affected.map(({ group, flow }) => group + '/' + flow))
  if (!Array.isArray(reported) || reported.length !== expected.size) {
    throw new Error('DSH must report a review for every affected flow')
  }
  return reported.map(review => {
    const { group, flow, reason } = review ?? {}
    if (typeof group !== 'string' || typeof flow !== 'string' || !expected.delete(group + '/' + flow)
      || typeof reason !== 'string' || !reason.trim() || reason.length > 360 || /[\r\n\0]/.test(reason)) {
      throw new Error('DSH returned an invalid or duplicate affected-flow review')
    }
    return { group, flow, reason: reason.trim() }
  })
}

function documentedFlows(graph) {
  return new Map((graph?.groups ?? []).flatMap(group => group.flows.map(flow => [group.id + '/' + flow.id, {
    title: flow.title, summary: flow.summary, layout: flow.layout?.rows,
    links: (flow.links ?? []).map(({ group, flow, kind }) => ({ group, flow, kind })),
    edges: flow.edges.map(({ from, to, kind, label }) => ({ from, to, kind, label })),
    nodes: flow.nodes.map(({ id, title, summary, details, sources }) => ({
      id, title, summary, details,
      sources: sources.map(({ path, kind, line, status }) => ({ path, kind, line, status })),
    })),
  }])))
}

function compareDocuments(previous, graph) {
  const before = documentedFlows(previous)
  const after = documentedFlows(graph)
  const flowChanges = { added: 0, modified: 0, removed: 0 }
  for (const [key, flow] of after) {
    if (!before.has(key)) flowChanges.added++
    else if (!isDeepStrictEqual(before.get(key), flow)) flowChanges.modified++
  }
  for (const key of before.keys()) {
    if (!after.has(key)) flowChanges.removed++
  }
  const headers = doc => doc?.groups.map(({ id, title, summary }) => ({ id, title, summary })) ?? []
  const terms = doc => (doc?.glossary ?? []).map(({ term, definition }) => ({ term, definition }))
  const changed = Object.values(flowChanges).some(Boolean)
    || !isDeepStrictEqual(headers(previous), headers(graph))
    || !isDeepStrictEqual(terms(previous), terms(graph))
  return { changed, flowChanges }
}

export function applyDocumentUpdate(previous, candidate, input, snapshot, previousFiles) {
  if (candidate?.snapshotId !== input.snapshotId || !Array.isArray(candidate.groups)) {
    throw new Error('DSH returned an update for a different input snapshot')
  }
  const expected = input.changes.map(change => change.path).sort()
  if (!Array.isArray(candidate.reviewedPaths) || !isDeepStrictEqual([...candidate.reviewedPaths].sort(), expected)) {
    throw new Error('DSH did not report reviewing the complete path change list')
  }
  const reviewedFlows = reviewFlows(input.affectedFlows, candidate.reviewedFlows)
  const groups = new Map((previous?.groups ?? []).map(group => [group.id, group]))
  const incoming = new Set()
  for (const record of candidate.groups) {
    if (!record || typeof record.id !== 'string' || !Array.isArray(record.flows) || incoming.has(record.id)) {
      throw new Error('DSH returned an invalid or duplicate group update')
    }
    incoming.add(record.id)
    const prior = groups.get(record.id)
    const flows = new Map((prior?.flows ?? []).map(flow => [flow.id, flow]))
    const removals = record.removeFlows ?? []
    if (!Array.isArray(removals)) throw new Error('removeFlows must be an array')
    const seen = new Set()
    for (const id of removals) {
      if (!flows.delete(id)) throw new Error('Removal refers to a missing flow: ' + id)
      seen.add(id)
    }
    for (const flow of record.flows) {
      if (!flow || typeof flow.id !== 'string' || seen.has(flow.id)) throw new Error('Conflicting flow update')
      if (Array.isArray(flow.edges) && flow.edges.some(edge => edge?.kind === 'branch' && edge.label === undefined)) {
        throw new Error('Generated branch requires a condition label: ' + record.id + '/' + flow.id)
      }
      seen.add(flow.id)
      flows.set(flow.id, flow)
    }
    if (flows.size) groups.set(record.id, {
      id: record.id, title: record.title ?? prior?.title,
      summary: record.summary ?? prior?.summary,
      flows: [...flows.values()],
    })
    else if (prior) groups.delete(record.id)
    else throw new Error('New groups require at least one flow')
  }
  // Replace metadata at generation boundaries. User-visible scope describes
  // the captured working tree, so a local edit can be indexed before commit.
  let glossary = previous?.glossary
  if (candidate.glossary !== undefined) {
    const terms = parseGlossary(glossary ?? [])
    for (const [key, entry] of parseGlossary(candidate.glossary)) terms.set(key, entry)
    glossary = [...terms.values()]
  }
  const graph = parseGraph(JSON.stringify({
    schemaVersion: 1,
    project: previous?.project ?? candidate.project,
    snapshot: { scope: 'working-tree', baseCommit: input.head, id: input.snapshotId },
    groups: [...groups.values()],
    glossary,
  }))
  const evidence = anchorSources(graph, previous, snapshot, previousFiles)
  // Host-added fingerprints also count toward the published graph size.
  const published = parseGraph(JSON.stringify(graph, null, 2) + '\n')
  return { graph: published, reviewedFlows, evidence, ...compareDocuments(previous, published) }
}
