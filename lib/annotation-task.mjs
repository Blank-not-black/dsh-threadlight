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
  return notes.map(({ id, module: groupId, target = { kind: 'group' }, text, quote, createdAt }, i) => {
    const { group, flow, step } = annotationTarget(graph, groupId, target)
    const { kind: targetKind, flow: flowId, step: stepId } = target ?? {}
    if (!group || !['group', 'flow', 'step'].includes(targetKind) ||
      (targetKind === 'flow' && !flow) || (targetKind === 'step' && !step)) {
      throw new AnnotationTaskError(400, 'Annotation target is missing from the current graph.')
    }
    const sources = targetKind === 'step' ? step.sources.map(({ path, kind, line }) => ({ path, kind, line })) :
      targetKind === 'flow' ? sourceLocations(flow.nodes, 20) :
        sourceLocations(group.flows.flatMap(flow => flow.nodes), 5)
    return { id, index: i + 1, groupId, groupTitle: group.title, flowId, flowTitle: flow?.title,
      stepId, stepTitle: step?.title, targetKind, text, quote, createdAt, sources }
  })
}

// Modules keep the order their first annotation appears in, so the context reads
// like the user's selection while notes stay numbered across the whole batch.
function groupNotes(normalized) {
  const modules = new Map()
  for (const note of normalized) {
    const module = modules.get(note.groupId)
    if (module) module.notes.push(note)
    else modules.set(note.groupId, { id: note.groupId, title: note.groupTitle, notes: [note] })
  }
  return [...modules.values()]
}

/**
 * One main session owns the task and delegates one child per module: the
 * prompt asks it to split the work with the subagent tool, keep edits inside
 * each module's annotations, verify the result, and report per module.
 * @param {object} source - parsed graph plus its published digest.
 * @param {object[]} notes - annotations normalized by taskNotes.
 * @param {{ workspaceTitle: string }} options - workspace display name.
 * @returns {string} the prompt queued into the main session.
 */
export function coordinationPrompt({ graph, digest }, notes, { workspaceTitle }) {
  const modules = groupNotes(notes)
  const context = { project: graph.project.name, digest, workspace: workspaceTitle,
    moduleCount: modules.length, noteCount: notes.length, modules }
  return [
    '用户只提交了批注，没有修改流程图。这次由你担任主会话，请组织子代理协作完成。',
    '',
    '分工与执行：',
    '1. 按下面的「模块」分组任务。模块数 ≥ 2 时，用 subagent 工具为每个模块启动一个子代理；如果当前会话没有 subagent 工具，就按模块顺序自己处理。并行启动时同时最多 3 个。只有一个模块时你可以自己完成，也可以派 1 个子代理。',
    '2. 每个子代理的指令必须包含该模块的全部批注原文、编号、目标与源码位置，并要求：先读源码确认现状、只修改本模块批注涉及的行为、完成后运行相关验证、按批注编号报告改动位置与验证结果。',
    '3. 如果两个模块可能改到同一处代码，先由你确认边界或改为串行，避免子代理互相覆盖。',
    '4. 子代理返回后逐模块复核：改动是否只覆盖对应批注、验证是否真的执行过、是否有未处理项；需要时让子代理继续或自己补做。',
    '5. 最后汇总：每个模块列出改动的文件与位置、实际运行的验证及结果、未能处理或需要用户确认的部分。给出你自己的复核结论，不要只转述子代理的话。',
    '',
    '批注带编号、原文、目标位置和源码位置，可直接用于定位；引用与位置仅供参考，以当前代码为准。',
    '', JSON.stringify(context),
  ].join('\n')
}

const jsonText = record => JSON.stringify(record, null, 2) + '\n'

function validPreset(presets, presetId) {
  if (presetId === undefined || presetId === null || presetId === '') return undefined
  if (typeof presetId !== 'string') throw new AnnotationTaskError(400, '所选 agent preset 无效。')
  if (!Array.isArray(presets)) {
    throw new AnnotationTaskError(503, '当前 DSH 版本或 profile 暂未提供 agent preset 能力。')
  }
  const preset = presets.find(entry => entry?.id === presetId)
  if (!preset) throw new AnnotationTaskError(400, '所选 agent preset 不存在，请刷新后重试。')
  if (preset.broken) throw new AnnotationTaskError(503, '所选 agent preset 当前不可用，请换一个。')
  return presetId
}

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

async function dispatch({ workspace, graph, notes, controller, store }, noteIds, digest, meta = {}) {
  const path = root + '/' + digest
  const receiptPath = path + '.json'
  const prior = await readRecord(store, receiptPath)
  if (prior !== null) return { submission: checkRecord(prior, digest, workspace, true) }
  const pendingPath = path + '.pending.json'
  const modules = groupNotes(notes).map(({ id, title }) => ({ id, title }))
  let pending = await readRecord(store, pendingPath)
  if (pending === null) {
    const prompt = coordinationPrompt(graph, notes, { workspaceTitle: workspace.title })
    pending = { schemaVersion: 1, digest, noteIds, workspace: workspace.id,
      sessionId: randomUUID(), requestId: randomUUID(), prompt,
      title: submissionTitle(modules, noteIds.length),
      modules,
      ...(typeof meta.agentPreset === 'string' && meta.agentPreset ? { agentPreset: meta.agentPreset } : {}) }
    if (!await store.create(pendingPath, jsonText(pending))) pending = await readRecord(store, pendingPath)
  }
  const { title, ...record } = checkRecord(pending, digest, workspace, false)
  const { sessionId, requestId, prompt } = record
  try {
    let queued = false
    if (!workspace.sessionIds.includes(sessionId)) {
      const created = await controller.create({ workspaceId: workspace.id, sessionId,
        ...(typeof record.agentPreset === 'string' && record.agentPreset ? { agentPreset: record.agentPreset } : {}) })
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

function submissionTitle(modules, noteCount) {
  const title = modules.length === 1
    ? 'Threadlight 批注 · ' + modules[0].title + ' · ' + noteCount + ' 条'
    : 'Threadlight 批注 · ' + modules.length + ' 个模块 · ' + noteCount + ' 条'
  return title.slice(0, 120)
}

function submitSelection(options, noteIds, digest, meta) {
  const key = options.workspace.path + '\0' + digest
  if (submitting.has(key)) return submitting.get(key)
  const operation = dispatch(options, noteIds, digest, meta).finally(() => submitting.delete(key))
  submitting.set(key, operation)
  return operation
}

// Every selected annotation belongs to one main session. That session receives
// the whole module-grouped context and the coordination prompt, then delegates
// one child per module itself; the host only owns the receipt and the dedupe.
export async function submitAnnotations(options) {
  const { graph, notes, controller, presets, agentPreset } = options
  if (!controller) throw new AnnotationTaskError(503, '当前 DSH 版本或 profile 暂未提供会话提交能力。')
  if (!Array.isArray(notes) || !notes.length || notes.length > maxAnnotationSelection) {
    throw new AnnotationTaskError(400, 'Select between 1 and 100 annotations.')
  }
  // Normalize and validate every target before a session is created.
  const normalized = taskNotes(graph.graph, notes)
  const preset = validPreset(presets, agentPreset)
  const noteIds = selectedIds(normalized.map(note => note.id))
  return submitSelection({ ...options, notes: normalized }, noteIds, selectionDigest(noteIds),
    { agentPreset: preset })
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
