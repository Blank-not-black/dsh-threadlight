import { createHash, randomUUID } from 'node:crypto'

const root = '.threadlight/submissions'
const digestPattern = /^[a-f0-9]{64}$/
const submitting = new Map()
export const annotationIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export const maxAnnotationSelection = 100

export class AnnotationTaskError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function selectedIds(ids) {
  return [...new Set(ids)].sort()
}

export function selectionDigest(noteIds) {
  return createHash('sha256').update(JSON.stringify(selectedIds(noteIds))).digest('hex')
}

export function annotationTarget(graph, groupId, target = { kind: 'group' }) {
  const group = graph.groups.find(group => group.id === groupId)
  const flow = target?.kind === 'flow' || target?.kind === 'step'
    ? group?.flows.find(flow => flow.id === target.flow) : undefined
  const step = target?.kind === 'step' ? flow?.nodes.find(node => node.id === target.step) : undefined
  return { group, flow, step }
}

function sourceLocations(nodes, limit) {
  const locations = new Map()
  for (const node of nodes) {
    for (const { path, kind, line } of node.sources) {
      const key = JSON.stringify([path, kind, line])
      if (!locations.has(key)) locations.set(key, { path, kind, line })
      if (locations.size === limit) return [...locations.values()]
    }
  }
  return [...locations.values()]
}

function taskNotes(graph, notes) {
  if (!Array.isArray(notes) || !notes.length || notes.length > maxAnnotationSelection) {
    throw new AnnotationTaskError(400, 'Select between 1 and 100 annotations.')
  }
  return notes.map(({ module: groupId, target = { kind: 'group' }, text, quote, createdAt }, i) => {
    const { group, flow, step } = annotationTarget(graph, groupId, target)
    const { kind: targetKind, flow: flowId, step: stepId } = target ?? {}
    if (!group || !['group', 'flow', 'step'].includes(targetKind) ||
      (targetKind === 'flow' && !flow) || (targetKind === 'step' && !step)) {
      throw new AnnotationTaskError(400, 'Annotation target is missing from the current graph.')
    }
    const sources = targetKind === 'step' ? step.sources.map(({ path, kind, line }) => ({ path, kind, line })) :
      targetKind === 'flow' ? sourceLocations(flow.nodes, 20) :
        sourceLocations(group.flows.flatMap(flow => flow.nodes), 5)
    return { index: i + 1, groupId, groupTitle: group.title, flowId, flowTitle: flow?.title,
      stepId, stepTitle: step?.title, targetKind, text, quote, createdAt, sources }
  })
}

export function collectionPrompt({ graph, digest }, notes, { workspaceTitle }) {
  const context = { project: graph.project.name, digest, workspace: workspaceTitle, notes: taskNotes(graph, notes) }
  return [
    '用户只提交了批注，没有修改流程图。请按以下批注修改当前项目。',
    '先阅读相关源码确认现状，再逐条处理批注。引用原文和源码位置可用于定位。',
    '完成后按批注编号报告改动位置、实际运行的验证及结果，以及未能处理或需要确认的部分。',
    '', JSON.stringify(context),
  ].join('\n')
}

const jsonText = record => JSON.stringify(record, null, 2) + '\n'

async function readRecord(store, path) {
  const raw = await store.read(path)
  if (raw === null) return null
  try { return JSON.parse(raw) ?? {} } catch { return {} }
}

function isSubmission(record, digest) {
  return record?.schemaVersion === 1 && record.digest === digest &&
    Array.isArray(record.noteIds) && record.noteIds.length > 0 && record.noteIds.length <= maxAnnotationSelection &&
    record.noteIds.every(id => typeof id === 'string' && annotationIdPattern.test(id)) &&
    selectionDigest(record.noteIds) === digest && typeof record.workspace === 'string' &&
    typeof record.sessionId === 'string' && annotationIdPattern.test(record.sessionId) &&
    typeof record.requestId === 'string' && annotationIdPattern.test(record.requestId) &&
    typeof record.prompt === 'string' && record.prompt.length > 0
}

function hasSubmittedAt(record) {
  return typeof record.submittedAt === 'string' && Number.isFinite(Date.parse(record.submittedAt))
}

function checkRecord(record, digest, workspace, complete) {
  if (!isSubmission(record, digest) || record.workspace !== workspace.id ||
    !(complete ? hasSubmittedAt(record) : typeof record.title === 'string')) {
    throw new AnnotationTaskError(409, 'Annotation submission record does not match the current workspace.')
  }
  return record
}

async function wasQueued(controller, { sessionId, requestId }) {
  // Hosts without inspect deduplicate queued messages by requestId in prompt.
  if (typeof controller.inspect !== 'function') return false
  const session = await controller.inspect(sessionId)
  return session.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
    message.source.kind === 'user' && message.source.rpcId === requestId))
}

async function dispatch({ workspace, graph, notes, controller, store }, noteIds, digest) {
  const path = root + '/' + digest
  const receiptPath = path + '.json'
  const prior = await readRecord(store, receiptPath)
  if (prior !== null) return { submission: checkRecord(prior, digest, workspace, true) }
  const pendingPath = path + '.pending.json'
  let pending = await readRecord(store, pendingPath)
  if (pending === null) {
    const prompt = collectionPrompt(graph, notes, { workspaceTitle: workspace.title })
    const { group, flow } = annotationTarget(graph.graph, notes[0].module, notes[0].target)
    const title = (flow?.title ?? group.title).slice(0, 120)
    pending = { schemaVersion: 1, digest, noteIds, workspace: workspace.id,
      sessionId: randomUUID(), requestId: randomUUID(), prompt,
      title: 'Threadlight 批注 · ' + title + ' · ' + noteIds.length + ' 条' }
    if (!await store.create(pendingPath, jsonText(pending))) pending = await readRecord(store, pendingPath)
  }
  const { title, ...record } = checkRecord(pending, digest, workspace, false)
  const { sessionId, requestId, prompt } = record
  try {
    let queued = false
    if (!workspace.sessionIds.includes(sessionId)) {
      const created = await controller.create({ workspaceId: workspace.id, sessionId })
      if (created.sessionId !== sessionId) throw new Error('DSH returned a different session identity')
      await controller.rename({ sessionId, title }).catch(() => {})
    } else {
      queued = await wasQueued(controller, record)
    }
    if (!queued) {
      const result = await controller.prompt({ sessionId, requestId, mode: 'queue',
        content: [{ type: 'text', text: prompt }] }, AbortSignal.timeout(30000))
      if (result.accepted !== true) throw new Error('DSH did not accept the prompt')
    }
  } catch {
    throw new AnnotationTaskError(502, 'DSH 暂未接收任务。批注已保存，可重新提交。')
  }
  const submission = { ...record, submittedAt: new Date().toISOString() }
  if (!await store.create(receiptPath, jsonText(submission))) {
    return { submission: checkRecord(await readRecord(store, receiptPath), digest, workspace, true) }
  }
  return { submission }
}

export async function submitAnnotations(options) {
  const { workspace, notes, controller } = options
  if (!controller) throw new AnnotationTaskError(503, '当前 DSH 版本或 profile 暂未提供会话提交能力。')
  if (!Array.isArray(notes) || !notes.length || notes.length > maxAnnotationSelection) {
    throw new AnnotationTaskError(400, 'Select between 1 and 100 annotations.')
  }
  const noteIds = selectedIds(notes.map(note => note.id))
  const digest = selectionDigest(noteIds)
  const key = workspace.path + '\0' + digest
  if (submitting.has(key)) return submitting.get(key)
  const operation = dispatch(options, noteIds, digest).finally(() => submitting.delete(key))
  submitting.set(key, operation)
  return operation
}

export async function listSubmissionIndex(store) {
  const index = new Map()
  for (const file of await store.list(root)) {
    const digest = file.name.slice(0, -5)
    if (file.type !== 'file' || !file.name.endsWith('.json') || !digestPattern.test(digest)) continue
    const record = await readRecord(store, root + '/' + file.name).catch(() => null)
    if (!isSubmission(record, digest) || !hasSubmittedAt(record)) continue
    const { sessionId, submittedAt } = record
    for (const id of record.noteIds) {
      const previous = index.get(id)
      if (!previous || Date.parse(submittedAt) > Date.parse(previous.submittedAt) ||
        (submittedAt === previous.submittedAt && digest > previous.digest)) {
        index.set(id, { sessionId, submittedAt, digest })
      }
    }
  }
  return index
}
