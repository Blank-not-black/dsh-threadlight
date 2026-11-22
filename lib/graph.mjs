export { layoutColumns } from './layout-columns.mjs'

export const MAX_GRAPH_BYTES = 8 * 1024 * 1024

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const sourceKinds = ['source', 'test', 'documentation', 'workflow']
const edgeKinds = ['sequence', 'branch', 'merge']
const linkKinds = ['uses', 'continues']
export const MAX_GLOSSARY_ENTRIES = 200

function check(value, message) {
  if (!value) throw new Error('Invalid graph: ' + message)
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function text(value, field, max, { oneLine = false } = {}) {
  check(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'),
    field + ' must be non-empty text of at most ' + max + ' characters')
  if (oneLine) check(!/[\r\n]/.test(value), field + ' must be on one line')
}

function array(value, field, max, min = 0) {
  check(Array.isArray(value) && value.length >= min && value.length <= max,
    field + ' must have between ' + min + ' and ' + max + ' items')
}

export function parseGlossary(entries) {
  array(entries, 'glossary', MAX_GLOSSARY_ENTRIES)
  const terms = new Map()
  for (const [index, entry] of entries.entries()) {
    const field = 'glossary[' + index + ']'
    check(object(entry), field + ' must be an object')
    text(entry.term, field + '.term', 64, { oneLine: true })
    text(entry.definition, field + '.definition', 360, { oneLine: true })
    check(entry.term === entry.term.trim(), field + '.term must not have surrounding whitespace')
    const key = entry.term.toLowerCase()
    check(!terms.has(key), field + '.term is duplicated')
    terms.set(key, entry)
  }
  return terms
}

function entry(value, field, ids) {
  check(object(value), field + ' must be an object')
  check(typeof value.id === 'string' && value.id.length <= 64 && idPattern.test(value.id) && !windowsDevice.test(value.id),
    field + '.id must be a filesystem-safe lowercase slug')
  check(!ids.has(value.id), field + '.id is duplicated')
  ids.add(value.id)
  text(value.title, field + '.title', 160, { oneLine: true })
}

function validateSource(source, location) {
  check(object(source), location + ' must be an object')
  const path = source.path
  check(typeof path === 'string' && path.length <= 1024 && !/[\x00-\x1f\\:]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), location + '.path must be repository-relative')
  check(sourceKinds.includes(source.kind), location + '.kind is unsupported')
  check(source.line === undefined || Number.isSafeInteger(source.line) && source.line > 0,
    location + '.line must be a positive integer')
  if (source.status !== undefined) {
    check(source.status === 'needs-review' && source.line === undefined && source.anchor === undefined,
      location + '.status must be needs-review with a file-level reference')
  }
  if (source.anchor !== undefined) {
    const digest = /^[a-f0-9]{64}$/
    check(source.line && object(source.anchor) && typeof source.anchor.lineHash === 'string' && digest.test(source.anchor.lineHash)
      && typeof source.anchor.contextHash === 'string' && digest.test(source.anchor.contextHash)
      && typeof source.anchor.unique === 'boolean' && typeof source.anchor.contextUnique === 'boolean',
      location + '.anchor must contain line and context fingerprints for a numbered reference')
  }
  if (source.preview !== undefined) {
    check(!source.status && object(source.preview) && Number.isSafeInteger(source.preview.startLine) &&
      source.preview.startLine > 0 && (source.line ? source.preview.startLine <= source.line : source.kind === 'documentation'),
    location + '.preview has an invalid start line')
    text(source.preview.text, location + '.preview.text', 1200)
    check(!source.line || source.preview.startLine + source.preview.text.split('\n').length > source.line,
      location + '.preview must include the referenced line')
  }
  if (source.symbol !== undefined) {
    const symbol = source.symbol
    check(source.line && object(symbol) && ['function', 'class', 'method', 'import', 'call'].includes(symbol.kind) &&
      Number.isSafeInteger(symbol.startLine) && symbol.startLine > 0 && symbol.startLine <= source.line &&
      Number.isSafeInteger(symbol.endLine) && symbol.endLine >= source.line, location + '.symbol has an invalid range')
    text(symbol.name, location + '.symbol.name', 160, { oneLine: true })
  }
}

function validateFlow(flow, location) {
  text(flow.summary, location + '.summary', 6000)
  array(flow.nodes, location + '.nodes', 200, 1)
  const nodeIds = new Set()
  for (const [index, node] of flow.nodes.entries()) {
    const field = location + '.nodes[' + index + ']'
    entry(node, field, nodeIds)
    text(node.summary, field + '.summary', 6000)
    array(node.details, field + '.details', 50)
    for (const detail of node.details) text(detail, field + '.details[]', 6000)
    array(node.sources, field + '.sources', 50)
    for (const source of node.sources) validateSource(source, field + '.sources[]')
  }
  array(flow.edges, location + '.edges', 2000)
  const edges = new Set()
  for (const edge of flow.edges) {
    check(object(edge) && nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to,
      location + ' has an edge with invalid endpoints')
    check(edgeKinds.includes(edge.kind), location + ' has an unsupported edge kind')
    if (edge.label !== undefined) text(edge.label, location + '.edges[].label', 120, { oneLine: true })
    const signature = edge.from + '/' + edge.to + '/' + edge.kind
    check(!edges.has(signature), location + ' has a duplicate edge')
    edges.add(signature)
  }
  if (flow.layout === undefined) return
  const rows = flow.layout?.rows
  array(rows, location + '.layout.rows', 200, 1)
  const placed = new Set()
  for (const row of rows) {
    array(row, location + '.layout.rows[]', 20, 1)
    for (const id of row) {
      check(nodeIds.has(id) && !placed.has(id), location + ' has an invalid or repeated layout node')
      placed.add(id)
    }
  }
  check(placed.size === nodeIds.size, location + ' must place every node in the layout')
}

export function parseGraph(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_GRAPH_BYTES) throw new Error('Graph exceeds the 8 MiB input limit')
  let graph
  try { graph = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch {
    throw new Error('Invalid graph: expected UTF-8 JSON')
  }
  check(object(graph) && graph.schemaVersion === 1, 'schemaVersion must be 1')
  text(graph.project?.name, 'project.name', 160, { oneLine: true })
  if (graph.glossary !== undefined) parseGlossary(graph.glossary)
  array(graph.groups, 'groups', 64, 1)
  const groupIds = new Set()
  const flows = new Map()
  for (const [index, group] of graph.groups.entries()) {
    const location = 'groups[' + index + ']'
    entry(group, location, groupIds)
    if (group.summary !== undefined) text(group.summary, location + '.summary', 6000)
    array(group.flows, location + '.flows', 100, 1)
    const flowIds = new Set()
    for (const [flowIndex, flow] of group.flows.entries()) {
      const field = location + '.flows[' + flowIndex + ']'
      entry(flow, field, flowIds)
      validateFlow(flow, field)
      flows.set(group.id + '/' + flow.id, flow)
    }
  }
  for (const [id, flow] of flows) {
    if (flow.links === undefined) continue
    array(flow.links, id + '.links', 50)
    const seen = new Set()
    for (const link of flow.links) {
      check(object(link) && typeof link.group === 'string' && typeof link.flow === 'string',
        id + ' has an invalid linked flow')
      const target = link.group + '/' + link.flow
      check(flows.has(target) && target !== id, id + ' has a missing or self-linked flow')
      check(linkKinds.includes(link.kind), id + ' has an unsupported cross-flow link')
      const key = target + '/' + link.kind
      check(!seen.has(key), id + ' has a duplicate cross-flow link')
      seen.add(key)
    }
  }
  return graph
}
