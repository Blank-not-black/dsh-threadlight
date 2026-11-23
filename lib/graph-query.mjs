import { stepState, stepStateLabels } from './step-state.mjs'

// The model gets a compact reading surface instead of the whole graph JSON.
export const QUERY_VIEWS = ['overview', 'flow', 'step', 'search']
export const QUERY_LIST_LIMIT = 200
export const QUERY_TERM_MAX = 3000

const queryFields = ['view', 'group', 'flow', 'step', 'term']

export class GraphQueryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GraphQueryError'
  }
}

function fail(message) {
  throw new GraphQueryError(message)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function idList(entries, field = 'id') {
  const ids = entries.map(entry => entry[field])
  if (!ids.length) return '（没有可选项）'
  const shown = ids.slice(0, 20).join('、')
  return ids.length > 20 ? shown + ' 等 ' + ids.length + ' 个' : shown
}

function readId(params, name) {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || /[\x00-\x1f]/.test(value)) {
    fail(name + ' 必须是 1 到 64 个字符的 id 文本')
  }
  return value.trim()
}

function readTerm(params) {
  const value = params.term
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > QUERY_TERM_MAX) {
    fail('term 必须是 1 到 ' + QUERY_TERM_MAX + ' 个字符的关键词')
  }
  return value.trim()
}

export function normalizeQuery(params = {}) {
  if (!plainObject(params)) fail('查询参数必须是一个对象')
  for (const key of Object.keys(params)) {
    if (!queryFields.includes(key)) fail('未知参数 "' + key + '"，可用的参数为 view、group、flow、step、term')
  }
  const view = params.view ?? 'overview'
  if (typeof view !== 'string' || !QUERY_VIEWS.includes(view)) {
    fail('view 必须是 overview、flow、step 或 search 之一')
  }
  const query = { view, group: readId(params, 'group'), flow: readId(params, 'flow'),
    step: readId(params, 'step'), term: readTerm(params) }
  const reject = names => {
    for (const name of names) {
      if (query[name] !== undefined) fail('view 为 ' + view + ' 时不能使用 ' + name + ' 参数')
    }
  }
  if (view === 'overview') {
    reject(['group', 'flow', 'step', 'term'])
  } else if (view === 'flow') {
    if (query.group === undefined) fail('view 为 flow 时必须提供 group（功能区 id）')
    if (query.flow === undefined) fail('view 为 flow 时必须提供 flow（线路 id）')
    reject(['step', 'term'])
  } else if (view === 'step') {
    if (query.group === undefined) fail('view 为 step 时必须提供 group（功能区 id）')
    if (query.flow === undefined) fail('view 为 step 时必须提供 flow（线路 id）')
    if (query.step === undefined) fail('view 为 step 时必须提供 step（步骤 id）')
    reject(['term'])
  } else {
    if (query.term === undefined) fail('view 为 search 时必须提供 term（关键词）')
    reject(['group', 'flow', 'step'])
  }
  return query
}

function findGroup(graph, id) {
  const group = graph.groups.find(entry => entry.id === id)
  if (!group) fail('当前图谱中找不到功能区 "' + id + '"。可选功能区：' + idList(graph.groups))
  return group
}

function findFlow(group, id) {
  const flow = group.flows.find(entry => entry.id === id)
  if (!flow) {
    fail('功能区 "' + group.id + '" 中找不到线路 "' + id + '"。可选线路：' + idList(group.flows))
  }
  return flow
}

function findStep(flow, id, group) {
  const step = flow.nodes.find(entry => entry.id === id)
  if (!step) {
    fail('线路 "' + group.id + '/' + flow.id + '" 中找不到步骤 "' + id + '"。可选步骤：' + idList(flow.nodes))
  }
  return step
}

function sourceView(source) {
  return {
    path: source.path,
    kind: source.kind,
    ...(source.line === undefined ? {} : { line: source.line }),
    ...(source.symbol === undefined ? {} : { symbol: source.symbol.name }),
  }
}

function verificationSummary(node) {
  const records = node.verification ?? []
  const summary = {
    total: records.length,
    passed: records.filter(record => record.result === 'passed').length,
    failed: records.filter(record => record.result === 'failed').length,
  }
  if (records.length) {
    const latest = records[records.length - 1]
    summary.latest = {
      at: latest.at,
      result: latest.result,
      summary: latest.summary,
      ...(latest.command === undefined ? {} : { command: latest.command }),
    }
  }
  return summary
}

function overviewResult(graph) {
  const pairs = graph.groups.flatMap(group => group.flows.map(flow => ({ group, flow })))
  const areas = (graph.project.areas ?? []).map(area => ({
    id: area.id,
    title: area.title,
    groups: graph.groups.filter(group => group.area === area.id).length,
  }))
  const groups = graph.groups.map(group => ({
    id: group.id,
    title: group.title,
    ...(group.area === undefined ? {} : { area: group.area }),
    flows: group.flows.length,
  }))
  const flows = pairs.map(({ group, flow }) => ({
    group: group.id, flow: flow.id, title: flow.title, steps: flow.nodes.length,
  }))
  return {
    view: 'overview',
    project: graph.project.name,
    counts: {
      areas: areas.length,
      groups: graph.groups.length,
      flows: pairs.length,
      steps: pairs.reduce((count, { flow }) => count + flow.nodes.length, 0),
    },
    areas: areas.slice(0, QUERY_LIST_LIMIT),
    groups: groups.slice(0, QUERY_LIST_LIMIT),
    flows: flows.slice(0, QUERY_LIST_LIMIT),
    truncated: flows.length > QUERY_LIST_LIMIT,
  }
}

function flowResult(graph, query) {
  const group = findGroup(graph, query.group)
  const flow = findFlow(group, query.flow)
  const steps = flow.nodes.slice(0, QUERY_LIST_LIMIT).map(node => ({
    id: node.id,
    title: node.title,
    summary: node.summary,
    state: stepState(node),
    sources: node.sources.length,
  }))
  const edges = flow.edges.slice(0, QUERY_LIST_LIMIT).map(edge => ({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    ...(edge.label === undefined ? {} : { label: edge.label }),
  }))
  return {
    view: 'flow',
    group: { id: group.id, title: group.title },
    flow: { id: flow.id, title: flow.title, summary: flow.summary },
    steps,
    edges,
    truncated: flow.nodes.length > QUERY_LIST_LIMIT || flow.edges.length > QUERY_LIST_LIMIT,
  }
}

function stepResult(graph, query) {
  const group = findGroup(graph, query.group)
  const flow = findFlow(group, query.flow)
  const node = findStep(flow, query.step, group)
  const state = stepState(node)
  return {
    view: 'step',
    group: { id: group.id, title: group.title },
    flow: { id: flow.id, title: flow.title },
    step: {
      id: node.id,
      title: node.title,
      summary: node.summary,
      details: node.details.slice(0, QUERY_LIST_LIMIT),
      state,
      stateLabel: stepStateLabels[state],
      ...(node.divergence === undefined ? {} : { divergence: node.divergence }),
      verification: verificationSummary(node),
      sources: node.sources.slice(0, QUERY_LIST_LIMIT).map(sourceView),
    },
  }
}

function searchResult(graph, term) {
  const needle = term.toLowerCase()
  const matches = text => typeof text === 'string' && text.toLowerCase().includes(needle)
  const flows = []
  const steps = []
  for (const group of graph.groups) {
    for (const flow of group.flows) {
      if (matches(flow.title) || matches(flow.summary)) {
        flows.push({ group: group.id, flow: flow.id, title: flow.title })
      }
      for (const node of flow.nodes) {
        if (matches(node.title) || matches(node.summary)) {
          steps.push({ group: group.id, flow: flow.id, step: node.id, title: node.title })
        }
      }
    }
  }
  return {
    view: 'search',
    term,
    flows: flows.slice(0, QUERY_LIST_LIMIT),
    steps: steps.slice(0, QUERY_LIST_LIMIT),
    truncated: flows.length > QUERY_LIST_LIMIT || steps.length > QUERY_LIST_LIMIT,
  }
}

export function queryGraph(graph, params = {}) {
  if (!plainObject(graph) || !Array.isArray(graph.groups) || !plainObject(graph.project)) {
    fail('当前图谱的结构无效，缺少 project 或 groups')
  }
  const query = normalizeQuery(params)
  if (query.view === 'overview') return overviewResult(graph)
  if (query.view === 'flow') return flowResult(graph, query)
  if (query.view === 'step') return stepResult(graph, query)
  return searchResult(graph, query.term)
}
