import { isDeepStrictEqual } from 'node:util'
import { parseGraph } from './graph.mjs'

export const draftIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const itemId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class DraftError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function check(condition, message) {
  if (!condition) throw new DraftError(400, message)
}

function text(value, label, max, oneLine = false) {
  check(typeof value === 'string' && value.length <= max && !value.includes('\0') &&
    (!oneLine || !/[\r\n]/.test(value)), label + '格式无效或过长。')
  return value
}

function entries(value, label, max) {
  check(Array.isArray(value) && value.length <= max, label + '数量无效。')
  return value.map(entry => {
    check(entry && typeof entry === 'object' && !Array.isArray(entry), label + '格式无效。')
    return entry
  })
}

function uniqueId(id, seen, label) {
  check(typeof id === 'string' && id.length <= 64 && itemId.test(id) && !seen.has(id), label + '编号无效或重复。')
  seen.add(id)
  return id
}

function diagramPoint(point) {
  const { x, y } = point ?? {}
  check([x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 100000), '画布坐标无效。')
  return { x, y }
}

export function normalizePlan(raw) {
  check(raw && typeof raw === 'object', '草稿格式无效。')
  const nodeIds = new Set(), edgeIds = new Set(), links = new Set(), noteIds = new Set()
  const title = text(raw.title, '线路名称', 160, true)
  const summary = text(raw.summary, '目标与范围', 6000)
  const acceptance = text(raw.acceptance, '验收条件', 6000)
  const nodes = entries(raw.nodes, '步骤', 200).map(node => ({
    id: uniqueId(node.id, nodeIds, '步骤'),
    title: text(node.title, '步骤名称', 160, true),
    summary: text(node.summary, '步骤说明', 6000),
  }))
  const edges = entries(raw.edges, '连线', 2000).map(edge => {
    const { from, to, kind } = edge
    const key = from + '/' + to + '/' + kind
    check(nodeIds.has(from) && nodeIds.has(to) && from !== to &&
      ['sequence', 'branch', 'merge'].includes(kind) && !links.has(key), '连线的步骤、类型或重复项无效。')
    links.add(key)
    const connection = { id: uniqueId(edge.id, edgeIds, '连线'), from, to, kind, label: text(edge.label, '连线条件', 120, true) }
    if (edge.bend !== undefined) {
      const { x, y } = edge.bend ?? {}
      check([x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1), '连线折点坐标无效。')
      connection.bend = { x, y }
    }
    if (edge.waypoints !== undefined) {
      connection.waypoints = entries(edge.waypoints, '连线折点', 64).map(diagramPoint)
    }
    return connection
  })
  const notes = entries(raw.notes, '批注', 200).map(note => {
    const { step, edge, selected } = note
    check((step === null || nodeIds.has(step)) && (edge === null || edgeIds.has(edge)) &&
      !(step && edge) && typeof selected === 'boolean', '批注对应的位置无效。')
    const wording = text(note.text, '批注', 3000)
    check(wording.trim(), '批注需要有内容。')
    return { id: uniqueId(note.id, noteIds, '批注'), step, edge, selected, text: wording }
  })
  const plan = { title, summary, acceptance, nodes, edges, notes }
  if (raw.layout !== undefined) {
    const positioned = new Set()
    plan.layout = entries(raw.layout, '画布步骤', 200).map(position => {
      const { step } = position
      check(nodeIds.has(step) && !positioned.has(step), '画布步骤无效或重复。')
      positioned.add(step)
      return { step, ...diagramPoint(position) }
    })
  }
  return plan
}

export function copyFlow(source, groupId, flowId) {
  const group = source?.graph.groups.find(group => group.id === groupId)
  const flow = group?.flows.find(flow => flow.id === flowId)
  if (!flow) throw new DraftError(404, '当前图谱中找不到这条线路。')
  const plan = {
    title: flow.title, summary: flow.summary, acceptance: '', notes: [],
    nodes: flow.nodes.map(({ id, title, summary }) => ({ id, title, summary })),
    edges: flow.edges.map(({ from, to, kind, label }, index) => ({ id: 'link-' + (index + 1), from, to, kind, label: label ?? '' })),
  }
  const evidence = flow.nodes.filter(node => node.sources.length).map(node => ({
    step: node.id,
    sources: node.sources.slice(0, 8).map(({ path, line, kind, status }) => ({ path, line, kind, status })),
  }))
  return { digest: source.digest, group: group.id, flow: flow.id, groupTitle: group.title, plan, evidence }
}

function changes(before, after) {
  const old = new Map(before.map(entry => [entry.id, entry]))
  const next = new Map(after.map(entry => [entry.id, entry]))
  return {
    added: after.filter(entry => !old.has(entry.id)).map(entry => entry.id),
    modified: after.filter(entry => old.has(entry.id) && !isDeepStrictEqual(old.get(entry.id), entry)).map(entry => entry.id),
    removed: before.filter(entry => !next.has(entry.id)),
  }
}

export function implementationPrompt(project, draft, currentDigest) {
  const { plan: { title, summary, acceptance, nodes, edges, notes }, base } = draft
  const behavior = ({ id, from, to, kind, label }) => ({ id, from, to, kind, label })
  const desired = { title, summary, acceptance, nodes, edges: edges.map(behavior) }
  check(title.trim() && summary.trim() && acceptance.trim(), '提交前请填写线路名称、目标与范围以及验收条件。')
  check(nodes.length && nodes.every(node => node.title.trim() && node.summary.trim()), '提交前请至少添加一个步骤，并填写每一步的名称和说明。')
  check(edges.every(edge => edge.kind !== 'branch' || edge.label.trim()), '请为每条条件分支填写触发条件。')
  try {
    parseGraph(JSON.stringify({ schemaVersion: 1, project: { name: 'Threadlight' }, groups: [{
      id: 'plan', title: '计划', flows: [{ ...desired, id: 'draft',
        nodes: nodes.map(node => ({ ...node, details: [], sources: [] })),
        edges: desired.edges.map(edge => ({ ...edge, label: edge.label.trim() || undefined })),
      }],
    }] }))
  } catch (error) {
    throw new DraftError(400, '流程结构无效。' + error.message)
  }
  const context = {
    project, draft: draft.id, version: draft.version,
    ...(base ? { base: {
      group: base.group, groupTitle: base.groupTitle, flow: base.flow, digest: base.digest, currentDigest,
      previousTitle: base.plan.title, previousSummary: base.plan.summary, evidence: base.evidence,
      steps: changes(base.plan.nodes, nodes), connections: changes(base.plan.edges.map(behavior), desired.edges),
    } } : {}),
    desired, feedback: notes.filter(note => note.selected).map(({ step, edge, text }) => ({ step, edge, text })),
  }
  return [
    '请在当前 DSH 工作区实现这份已提交的 Threadlight 流程草稿。',
    '先检查项目现状和关联源码。草稿中的步骤和分支描述目标行为。逐条处理用户批注与验收条件，核对基线证据是否仍适用。',
    '完成后按步骤或分支编号报告实现位置、实际运行的验证及其结果，以及尚待验证或与预期有出入的部分。',
    '', JSON.stringify(context, null, 2),
  ].join('\n')
}
