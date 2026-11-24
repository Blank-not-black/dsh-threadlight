import { randomUUID } from 'node:crypto'
import { isIsoTimestamp } from './graph.mjs'
import { annotationIdPattern, annotationTarget } from './annotation-task.mjs'

export const ANNOTATION_TEXT_MAX = 3000
export const ANNOTATION_QUOTE_MAX = 3000

const annotationRoot = '.threadlight/annotations'
const groupIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const digestPattern = /^[a-f0-9]{64}$/

export class AnnotationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AnnotationError'
  }
}

function fail(message) {
  throw new AnnotationError(message)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function slugList(entries, field = 'id') {
  const ids = entries.map(entry => entry[field])
  if (!ids.length) return '（没有可选项）'
  const shown = ids.slice(0, 20).join('、')
  return ids.length > 20 ? shown + ' 等 ' + ids.length + ' 个' : shown
}

function textOf(value, message) {
  if (typeof value !== 'string' || value.length > ANNOTATION_TEXT_MAX || !value.trim() || value.includes('\0')) {
    fail(message)
  }
  return value.trim()
}

function quoteOf(value) {
  if (value !== undefined && (typeof value !== 'string' || value.length > ANNOTATION_QUOTE_MAX || value.includes('\0'))) {
    fail('quote 应为 ' + ANNOTATION_QUOTE_MAX + ' 字以内的文字')
  }
  return value
}

function targetId(target, name) {
  const value = target[name]
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || /[\x00-\x1f]/.test(value)) {
    fail('target 为 ' + target.kind + ' 时必须提供 ' + name + '（id 文本）')
  }
  return value.trim()
}

// Normalize and verify an annotation target against the parsed graph. The
// returned target keeps only the fields the annotation record needs.
export function resolveAnnotationTarget(graph, groupId, target = { kind: 'group' }) {
  if (!plainObject(graph) || !Array.isArray(graph.groups)) fail('当前图谱的结构无效，缺少 groups')
  const group = graph.groups.find(entry => entry.id === groupId)
  if (!group) fail('当前图谱中找不到功能区 "' + groupId + '"。可选功能区：' + slugList(graph.groups))
  if (!plainObject(target)) fail('target 必须是包含 kind 的对象')
  const kind = target.kind
  if (!['group', 'flow', 'step'].includes(kind)) {
    fail('target.kind 必须是 group、flow 或 step 之一')
  }
  if (kind === 'group') return { group, flow: undefined, step: undefined, target: { kind: 'group' } }
  const flowId = targetId(target, 'flow')
  const flow = group.flows.find(entry => entry.id === flowId)
  if (!flow) {
    fail('功能区 "' + group.id + '" 中找不到线路 "' + flowId + '"。可选线路：' + slugList(group.flows))
  }
  if (kind === 'flow') return { group, flow, step: undefined, target: { kind: 'flow', flow: flow.id } }
  const stepId = targetId(target, 'step')
  const step = flow.nodes.find(entry => entry.id === stepId)
  if (!step) {
    fail('线路 "' + group.id + '/' + flow.id + '" 中找不到步骤 "' + stepId + '"。可选步骤：' + slugList(flow.nodes))
  }
  return { group, flow, step, target: { kind: 'step', flow: flow.id, step: step.id } }
}

// Move a note onto the current graph after the published/working graph changed.
// Stable module, flow and step ids keep the note meaningful; a missing target
// returns null so the caller can report it as stale instead of dropping it.
export function reanchorAnnotation(graph, note, digest, at = new Date().toISOString()) {
  if (typeof digest !== 'string' || !digestPattern.test(digest)) return null
  const { group, flow, step } = annotationTarget(graph, note.module, note.target)
  const kind = note.target?.kind ?? 'group'
  const valid = Boolean(group) && (
    kind === 'group' ||
    (kind === 'flow' && Boolean(flow)) ||
    (kind === 'step' && Boolean(flow) && Boolean(step)))
  if (!valid) return null
  if (note.graph === digest) return note
  return { ...note, graph: digest, reboundAt: at }
}

export function annotationPath(groupId, id) {
  if (typeof groupId !== 'string' || groupId.length > 64 || !groupIdPattern.test(groupId)) {
    fail('批注路径中的功能区 id 无效')
  }
  if (typeof id !== 'string' || !annotationIdPattern.test(id)) fail('批注路径中的批注 ID 无效')
  return annotationRoot + '/' + groupId + '/' + id + '.json'
}

export function annotationJson(record) {
  return JSON.stringify(record, null, 2) + '\n'
}

// Build one annotation record with the same fields the Threadlight review page
// writes, so the two entry points stay interchangeable.
export function buildAnnotation(graph, input = {}) {
  const { group: groupId } = input
  if (typeof groupId !== 'string' || !groupId.trim() || groupId.length > 64 || /[\x00-\x1f]/.test(groupId)) {
    fail('group 必须是当前图谱中的功能区 id')
  }
  const { target } = resolveAnnotationTarget(graph, groupId.trim(), input.target)
  const text = textOf(input.text, 'text 应为 1 到 ' + ANNOTATION_TEXT_MAX + ' 字的反馈正文')
  const quote = quoteOf(input.quote)
  const digest = input.digest
  if (typeof digest !== 'string' || !digestPattern.test(digest)) fail('图谱摘要无效，请刷新图谱后重试')
  const id = input.id ?? randomUUID()
  if (typeof id !== 'string' || !annotationIdPattern.test(id)) fail('批注 ID 无效')
  const createdAt = input.createdAt ?? new Date().toISOString()
  if (!isIsoTimestamp(createdAt)) fail('批注创建时间无效')
  return {
    id,
    text,
    createdAt,
    module: groupId.trim(),
    graph: digest,
    target,
    ...(quote === undefined ? {} : { quote }),
  }
}

// Atomically create the annotation file. A create conflict means another writer
// already owns the id; regenerate the id once before failing.
export async function writeAnnotation(store, record, { signal, createId = randomUUID } = {}) {
  let candidate = record
  annotationPath(candidate.module, candidate.id)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const id = createId()
      if (typeof id !== 'string' || !annotationIdPattern.test(id)) fail('批注 ID 无效')
      candidate = { ...candidate, id }
    }
    if (await store.create(annotationPath(candidate.module, candidate.id), annotationJson(candidate), signal)) {
      return candidate
    }
  }
  fail('批注保存冲突，请重试')
}
