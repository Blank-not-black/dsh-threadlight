export { layoutColumns } from './layout-columns.mjs'

export const MAX_GRAPH_BYTES = 8 * 1024 * 1024

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const sourceKinds = ['source', 'test', 'documentation', 'workflow']
const nodeStates = ['planned', 'implemented', 'verified']
const verificationResults = ['passed', 'failed']
const edgeKinds = ['sequence', 'branch', 'merge']
const linkKinds = ['uses', 'continues']
export const MAX_GLOSSARY_ENTRIES = 200

export class GraphError extends Error {
  constructor(code, path, message, hint) {
    super('Invalid graph: ' + message)
    this.name = 'GraphError'
    this.code = code
    this.path = path
    if (hint !== undefined) this.hint = hint
  }
}

function check(value, code, path, message, hint) {
  if (!value) throw new GraphError(code, path, message, hint)
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function text(value, code, path, max, { oneLine = false, field = path } = {}) {
  check(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'),
    code, path, field + ' must be non-empty text of at most ' + max + ' characters')
  if (oneLine) check(!/[\r\n]/.test(value), code, path, field + ' must be on one line')
}

function array(value, code, path, max, min = 0, field = path) {
  check(Array.isArray(value) && value.length >= min && value.length <= max,
    code, path, field + ' must have between ' + min + ' and ' + max + ' items')
}

export function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 &&
    /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

export function parseGlossary(entries) {
  array(entries, 'graph/glossary-list', 'glossary', MAX_GLOSSARY_ENTRIES)
  const terms = new Map()
  for (const [index, entry] of entries.entries()) {
    const field = 'glossary[' + index + ']'
    check(object(entry), 'graph/glossary-entry', field, field + ' must be an object')
    text(entry.term, 'graph/glossary-term', field + '.term', 64, { oneLine: true })
    text(entry.definition, 'graph/glossary-definition', field + '.definition', 360, { oneLine: true })
    check(entry.term === entry.term.trim(), 'graph/glossary-term-whitespace', field + '.term',
      field + '.term must not have surrounding whitespace')
    const key = entry.term.toLowerCase()
    check(!terms.has(key), 'graph/glossary-term-duplicate', field + '.term', field + '.term is duplicated')
    terms.set(key, entry)
  }
  return terms
}

export function parseAreas(entries, field = 'project.areas') {
  array(entries, 'graph/area-list', field, 32)
  const areas = new Map()
  for (const [index, area] of entries.entries()) {
    const location = field + '[' + index + ']'
    check(object(area), 'graph/area-record', location, location + ' must be an object')
    check(typeof area.id === 'string' && area.id.length <= 64 && idPattern.test(area.id),
      'graph/area-id-format', location + '.id', location + '.id must be a lowercase slug of at most 64 characters')
    check(!areas.has(area.id), 'graph/area-id', location + '.id', location + '.id is duplicated')
    text(area.title, 'graph/area-title', location + '.title', 160, { oneLine: true })
    if (area.summary !== undefined) {
      check(typeof area.summary === 'string' && area.summary.length <= 6000 && !area.summary.includes('\0'),
        'graph/area-summary', location + '.summary', location + '.summary must be text of at most 6000 characters')
    }
    areas.set(area.id, area)
  }
  return areas
}

export function groupSections({ project, groups }) {
  if (!project.areas?.length) return [{ groups }]
  return project.areas.map(area => ({ area, groups: groups.filter(group => group.area === area.id) }))
}

function entry(value, field, ids, kind) {
  const code = 'graph/' + kind
  check(object(value), code + '-record', field, field + ' must be an object')
  check(typeof value.id === 'string' && value.id.length <= 64 && idPattern.test(value.id) && !windowsDevice.test(value.id),
    code + '-id-format', field + '.id', field + '.id must be a filesystem-safe lowercase slug')
  check(!ids.has(value.id), code + '-id', field + '.id', field + '.id is duplicated')
  ids.add(value.id)
  text(value.title, code + '-title', field + '.title', 160, { oneLine: true })
}

function validateSource(source, nodeLocation, index) {
  const location = nodeLocation + '.sources[]'
  const sourcePath = nodeLocation + '.sources[' + index + ']'
  check(object(source), 'graph/source-record', sourcePath, location + ' must be an object')
  const path = source.path
  check(typeof path === 'string' && path.length <= 1024 && !/[\x00-\x1f\\:]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), 'graph/source-path', sourcePath + '.path',
    location + '.path must be repository-relative', 'Use a repository-relative path with forward slashes.')
  check(sourceKinds.includes(source.kind), 'graph/source-kind', sourcePath + '.kind', location + '.kind is unsupported')
  check(source.line === undefined || Number.isSafeInteger(source.line) && source.line > 0,
    'graph/source-line', sourcePath + '.line', location + '.line must be a positive integer')
  if (source.status !== undefined) {
    check(source.status === 'needs-review' && source.line === undefined && source.anchor === undefined,
      'graph/source-status', sourcePath + '.status', location + '.status must be needs-review with a file-level reference')
  }
  if (source.anchor !== undefined) {
    const digest = /^[a-f0-9]{64}$/
    check(source.line && object(source.anchor) && typeof source.anchor.lineHash === 'string' && digest.test(source.anchor.lineHash)
      && typeof source.anchor.contextHash === 'string' && digest.test(source.anchor.contextHash)
      && typeof source.anchor.unique === 'boolean' && typeof source.anchor.contextUnique === 'boolean',
      'graph/source-anchor', sourcePath + '.anchor', location + '.anchor must contain line and context fingerprints for a numbered reference')
  }
  if (source.preview !== undefined) {
    check(!source.status && object(source.preview) && Number.isSafeInteger(source.preview.startLine) &&
      source.preview.startLine > 0 && (source.line ? source.preview.startLine <= source.line : source.kind === 'documentation'),
      'graph/source-preview', sourcePath + '.preview', location + '.preview has an invalid start line')
    text(source.preview.text, 'graph/source-preview-text', sourcePath + '.preview.text', 1200,
      { field: location + '.preview.text' })
    check(!source.line || source.preview.startLine + source.preview.text.split('\n').length > source.line,
      'graph/source-preview-coverage', sourcePath + '.preview', location + '.preview must include the referenced line')
  }
  if (source.symbol !== undefined) {
    const symbol = source.symbol
    check(source.line && object(symbol) && ['function', 'class', 'method', 'import', 'call'].includes(symbol.kind) &&
      Number.isSafeInteger(symbol.startLine) && symbol.startLine > 0 && symbol.startLine <= source.line &&
      Number.isSafeInteger(symbol.endLine) && symbol.endLine >= source.line,
      'graph/source-symbol', sourcePath + '.symbol', location + '.symbol has an invalid range')
    text(symbol.name, 'graph/source-symbol-name', sourcePath + '.symbol.name', 160,
      { oneLine: true, field: location + '.symbol.name' })
  }
}

function validateStepState(node, field) {
  if (node.state !== undefined) {
    check(nodeStates.includes(node.state), 'graph/node-state', field + '.state', field + '.state is unsupported')
  }
  if (node.divergence !== undefined) {
    check(typeof node.divergence === 'string' && node.divergence.length <= 2000 && !node.divergence.includes('\0'),
      'graph/node-divergence', field + '.divergence', field + '.divergence must be text of at most 2000 characters')
  }
  if (node.verification !== undefined) {
    check(node.state === 'verified', 'graph/verification-state', field + '.verification',
      field + '.verification requires verified state')
    array(node.verification, 'graph/verification-list', field + '.verification', 20)
    const ids = new Set()
    for (const [index, record] of node.verification.entries()) {
      const location = field + '.verification[' + index + ']'
      check(object(record), 'graph/verification-record', location, location + ' must be an object')
      check(typeof record.id === 'string' && record.id.length <= 64 && idPattern.test(record.id),
        'graph/verification-id-format', location + '.id', location + '.id must be a lowercase slug')
      check(!ids.has(record.id), 'graph/verification-id', location + '.id', location + '.id is duplicated')
      ids.add(record.id)
      check(isIsoTimestamp(record.at), 'graph/verification-at', location + '.at', location + '.at must be an ISO-8601 timestamp')
      check(verificationResults.includes(record.result), 'graph/verification-result', location + '.result',
        location + '.result is unsupported')
      text(record.summary, 'graph/verification-summary', location + '.summary', 360, { oneLine: true })
      if (record.command !== undefined) {
        text(record.command, 'graph/verification-command', location + '.command', 512, { oneLine: true })
      }
    }
  }
  if (node.state === 'verified') {
    check(node.verification?.some(record => record.result === 'passed'), 'graph/verification', field + '.verification',
      field + '.verified state requires a passed verification', 'Record a passed verification or correct the node state.')
  }
}

function validateFlow(flow, location) {
  text(flow.summary, 'graph/flow-summary', location + '.summary', 6000)
  array(flow.nodes, 'graph/node-list', location + '.nodes', 200, 1)
  const nodeIds = new Set()
  for (const [index, node] of flow.nodes.entries()) {
    const field = location + '.nodes[' + index + ']'
    entry(node, field, nodeIds, 'node')
    text(node.summary, 'graph/node-summary', field + '.summary', 6000)
    array(node.details, 'graph/node-details', field + '.details', 50)
    for (const [detailIndex, detail] of node.details.entries()) {
      text(detail, 'graph/node-detail', field + '.details[' + detailIndex + ']', 6000, { field: field + '.details[]' })
    }
    array(node.sources, 'graph/source-list', field + '.sources', 50)
    for (const [sourceIndex, source] of node.sources.entries()) validateSource(source, field, sourceIndex)
    validateStepState(node, field)
  }
  array(flow.edges, 'graph/edge-list', location + '.edges', 2000)
  const edges = new Set()
  for (const [index, edge] of flow.edges.entries()) {
    const field = location + '.edges[' + index + ']'
    check(object(edge) && nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to,
      'graph/edge-endpoints', field, location + ' has an edge with invalid endpoints')
    check(edgeKinds.includes(edge.kind), 'graph/edge-kind', field + '.kind', location + ' has an unsupported edge kind')
    if (edge.label !== undefined) {
      text(edge.label, 'graph/edge-label', field + '.label', 120, { oneLine: true, field: location + '.edges[].label' })
    }
    const signature = edge.from + '/' + edge.to + '/' + edge.kind
    check(!edges.has(signature), 'graph/edge-duplicate', field, location + ' has a duplicate edge')
    edges.add(signature)
  }
  if (flow.layout === undefined) return
  const rows = flow.layout?.rows
  const rowsPath = location + '.layout.rows'
  array(rows, 'graph/layout-rows', rowsPath, 200, 1)
  const placed = new Set()
  for (const [index, row] of rows.entries()) {
    const field = rowsPath + '[' + index + ']'
    array(row, 'graph/layout-row', field, 20, 1, rowsPath + '[]')
    for (const [nodeIndex, id] of row.entries()) {
      check(nodeIds.has(id) && !placed.has(id), 'graph/layout-node', field + '[' + nodeIndex + ']',
        location + ' has an invalid or repeated layout node')
      placed.add(id)
    }
  }
  check(placed.size === nodeIds.size, 'graph/layout-incomplete', rowsPath, location + ' must place every node in the layout')
}

export function parseGraph(raw) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_GRAPH_BYTES, 'graph/input-size', '$',
    'Graph exceeds the 8 MiB input limit')
  let graph
  try { graph = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch {
    throw new GraphError('graph/json', '$', 'expected UTF-8 JSON')
  }
  check(object(graph) && graph.schemaVersion === 1, 'graph/schema-version', 'schemaVersion', 'schemaVersion must be 1')
  text(graph.project?.name, 'graph/project-name', 'project.name', 160, { oneLine: true })
  const areas = graph.project.areas === undefined ? new Map() : parseAreas(graph.project.areas)
  if (graph.glossary !== undefined) parseGlossary(graph.glossary)
  array(graph.groups, 'graph/group-list', 'groups', 64, 1)
  const groupIds = new Set()
  const flows = new Map()
  for (const [index, group] of graph.groups.entries()) {
    const location = 'groups[' + index + ']'
    entry(group, location, groupIds, 'group')
    if (areas.size) {
      check(typeof group.area === 'string', 'graph/area-reference-type', location + '.area',
        location + '.area must be a string referencing a declared area')
      check(areas.has(group.area), 'graph/area-reference', location + '.area', location + '.area references an unknown area')
    } else {
      check(group.area === undefined, 'graph/area-reference-undeclared', location + '.area',
        location + '.area is not allowed without declared project areas')
    }
    if (group.summary !== undefined) text(group.summary, 'graph/group-summary', location + '.summary', 6000)
    array(group.flows, 'graph/flow-list', location + '.flows', 100, 1)
    const flowIds = new Set()
    for (const [flowIndex, flow] of group.flows.entries()) {
      const field = location + '.flows[' + flowIndex + ']'
      entry(flow, field, flowIds, 'flow')
      validateFlow(flow, field)
      flows.set(group.id + '/' + flow.id, { flow, field })
    }
  }
  for (const [id, { flow, field }] of flows) {
    if (flow.links === undefined) continue
    const linksPath = field + '.links'
    array(flow.links, 'graph/link-list', linksPath, 50, 0, id + '.links')
    const seen = new Set()
    for (const [index, link] of flow.links.entries()) {
      const location = linksPath + '[' + index + ']'
      check(object(link) && typeof link.group === 'string' && typeof link.flow === 'string',
        'graph/link-reference', location, id + ' has an invalid linked flow')
      const target = link.group + '/' + link.flow
      check(flows.has(target) && target !== id, 'graph/link-target', location, id + ' has a missing or self-linked flow')
      check(linkKinds.includes(link.kind), 'graph/link-kind', location + '.kind', id + ' has an unsupported cross-flow link')
      const key = target + '/' + link.kind
      check(!seen.has(key), 'graph/link-duplicate', location, id + ' has a duplicate cross-flow link')
      seen.add(key)
    }
  }
  return graph
}

export function inspectGraph(raw) {
  let graph
  try { graph = parseGraph(raw) } catch (error) {
    if (!(error instanceof GraphError)) throw error
    const { code, path, message, hint } = error
    return { ok: false, error: { code, path, message, ...(hint === undefined ? {} : { hint }) } }
  }
  const flows = graph.groups.flatMap(group => group.flows)
  return { ok: true, summary: {
    groups: graph.groups.length,
    flows: flows.length,
    nodes: flows.reduce((count, flow) => count + flow.nodes.length, 0),
    areas: graph.project.areas?.length ?? 0,
  } }
}
