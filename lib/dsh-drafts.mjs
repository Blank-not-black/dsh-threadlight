import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { workspaceStore } from './dsh-store.mjs'
import { copyFlow, DraftError, draftIdPattern, implementationPrompt, normalizePlan } from './flow-draft.mjs'

const root = '.threadlight/drafts'
const editor = await readFile(new URL('./dsh-drafts.html', import.meta.url), 'utf8')
export const draftAssets = new Map(await Promise.all([
  ['drafts.js', './dsh-drafts.js', 'text/javascript'],
  ['drafts.css', './dsh-drafts.css', 'text/css'],
].map(async ([name, path, type]) => [name, { type, text: await readFile(new URL(path, import.meta.url), 'utf8') }])))
draftAssets.set('draft-diagram.js', { type: 'text/javascript', path: new URL('../dist/draft-diagram.js', import.meta.url) })
draftAssets.set('maxgraph-LICENSE.txt', { type: 'text/plain', path: new URL('../dist/maxgraph-LICENSE.txt', import.meta.url) })

function idOf(value) {
  if (typeof value !== 'string' || !draftIdPattern.test(value)) throw new DraftError(400, '草稿编号无效。')
  return value
}

function versionOf(value, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw new DraftError(400, '草稿版本无效。')
  return value
}

const draftPath = id => root + '/' + idOf(id)
const jsonText = record => JSON.stringify(record, null, 2) + '\n'

async function readRecord(store, path) {
  const raw = await store.read(path)
  return raw === null ? null : JSON.parse(raw)
}

function submittedPath(id, version) {
  return draftPath(id) + '/submitted-' + versionOf(version) + '.json'
}

async function wasQueued(controller, { sessionId, requestId }) {
  // Desktop 0.2.2 removed inspect and deduplicates against durable inbox events in prompt.
  if (typeof controller.inspect !== 'function') return false
  const session = await controller.inspect(sessionId)
  return session.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
    message.source.kind === 'user' && message.source.rpcId === requestId))
}

async function latestDraft(store, id) {
  const folder = draftPath(id)
  const entries = await store.list(folder)
  const versions = entries.filter(entry => entry.type === 'file' && /^[1-9]\d*\.json$/.test(entry.name))
    .map(entry => Number.parseInt(entry.name, 10)).filter(Number.isSafeInteger)
  if (!versions.length) return null
  const version = versions.reduce((latest, candidate) => Math.max(latest, candidate), 0)
  const draft = await readRecord(store, folder + '/' + version + '.json')
  if (draft?.schemaVersion !== 1 || draft.id !== id || draft.version !== version) {
    throw new DraftError(409, '草稿文件无效。')
  }
  return draft
}

function publicDraft(draft) {
  if (!draft) return null
  const { base, ...rest } = draft
  return { ...rest, base: base && { digest: base.digest, group: base.group, flow: base.flow, groupTitle: base.groupTitle } }
}

async function withSubmission(store, draft) {
  const submission = await readRecord(store, submittedPath(draft.id, draft.version))
  return { ...publicDraft(draft), submission }
}

export function renderDraftEditor(workspace, source, url, canSubmit) {
  const group = url.searchParams.get('group'), flow = url.searchParams.get('flow')
  const base = group !== null || flow !== null ? copyFlow(source, group, flow) : null
  const seed = base ? { plan: base.plan, base: { digest: base.digest, group, flow, groupTitle: base.groupTitle } } : null
  const step = url.searchParams.get('step')
  if (seed?.plan.nodes.some(node => node.id === step)) seed.step = step
  const config = { workspace: workspace.id, project: workspace.title, hasGraph: Boolean(source), canSubmit, seed }
  return editor.replace('"THREADLIGHT_DRAFT_CONTEXT"', () => JSON.stringify(config).replaceAll('<', '\\u003c'))
}

export function createDraftService(fs, getController, getPolicy) {
  const submitting = new Map()
  async function storeFor(workspace) {
    // Editor writes are owner web actions scoped to this registered workspace.
    const policy = getPolicy()?.resolve()
    return workspaceStore(fs, workspace.path, undefined, policy && { ...policy, workspaceRoot: workspace.path })
  }

  async function list(workspace, id) {
    const store = await storeFor(workspace)
    if (id !== null) {
      const draft = await latestDraft(store, id)
      if (!draft) throw new DraftError(404, '找不到这份草稿。')
      return { draft: await withSubmission(store, draft) }
    }
    const choices = []
    for (const entry of await store.list(root)) {
      if (entry.type !== 'directory' || !draftIdPattern.test(entry.name)) continue
      const draft = await latestDraft(store, entry.name)
      if (draft) choices.push({ id: draft.id, title: draft.plan.title, version: draft.version, updatedAt: draft.updatedAt })
    }
    return { drafts: choices.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) }
  }

  async function save(workspace, body, getSource) {
    const id = idOf(body.id), version = versionOf(body.version, 0)
    const plan = normalizePlan(body.plan)
    const store = await storeFor(workspace)
    const previous = await latestDraft(store, id)
    const latestVersion = previous?.version ?? 0
    // A retry after a lost response returns the revision that already saved.
    if (previous && latestVersion === version + 1 && isDeepStrictEqual(previous.plan, plan)) {
      return { draft: await withSubmission(store, previous) }
    }
    if (latestVersion !== version) throw new DraftError(409, '这份草稿已被更新。请重新打开最新版本后再保存。')
    if (previous && isDeepStrictEqual(previous.plan, plan)) return { draft: await withSubmission(store, previous) }
    let base = previous?.base ?? null
    if (!previous && body.base != null) {
      const source = await getSource()
      if (!source || source.digest !== body.base?.digest) throw new DraftError(409, '原图谱已更新，请重新从线路建草稿。')
      base = copyFlow(source, body.base.group, body.base.flow)
    }
    const now = new Date().toISOString()
    const draft = { schemaVersion: 1, id, version: version + 1, createdAt: previous?.createdAt ?? now, updatedAt: now, plan, base }
    if (!await store.create(draftPath(id) + '/' + draft.version + '.json', jsonText(draft))) {
      throw new DraftError(409, '保存时出现另一个版本。请重新打开最新版本。')
    }
    return { draft: publicDraft(draft) }
  }

  async function dispatch(workspace, id, version, getSource) {
    const controller = getController()
    if (!controller) throw new DraftError(503, '当前 DSH 版本或 profile 暂未提供会话提交能力。')
    const store = await storeFor(workspace)
    const receiptPath = submittedPath(id, version)
    const prior = await readRecord(store, receiptPath)
    if (prior) return { submission: prior }
    const draft = await latestDraft(store, id)
    if (!draft) throw new DraftError(404, '找不到这份草稿。')
    if (draft.version !== version) throw new DraftError(409, '请提交草稿的最新版本。')
    const pendingPath = draftPath(id) + '/submission-' + version + '.json'
    let pending = await readRecord(store, pendingPath)
    if (!pending) {
      const source = draft.base ? await getSource() : null
      const prompt = implementationPrompt(workspace.title, draft, source?.digest ?? null)
      pending = { version, workspace: workspace.id, sessionId: randomUUID(), requestId: randomUUID(), prompt }
      if (!await store.create(pendingPath, jsonText(pending))) pending = await readRecord(store, pendingPath)
    }
    if (pending?.workspace !== workspace.id || pending.version !== version ||
      !draftIdPattern.test(pending.sessionId) || !draftIdPattern.test(pending.requestId) || typeof pending.prompt !== 'string') {
      throw new DraftError(409, '提交记录与当前工作区不匹配。')
    }
    try {
      let queued = false
      if (!workspace.sessionIds.includes(pending.sessionId)) {
        const { sessionId } = await controller.create({ workspaceId: workspace.id, sessionId: pending.sessionId })
        if (sessionId !== pending.sessionId) throw new Error('DSH returned a different session identity')
        // A title helps the user find the task in the workspace's conversation list.
        const title = 'Threadlight · ' + draft.plan.title.slice(0, 120) + ' · v' + version
        await controller.rename({ sessionId, title }).catch(() => {})
      } else {
        queued = await wasQueued(controller, pending)
      }
      if (!queued) {
        const result = await controller.prompt({
          sessionId: pending.sessionId, requestId: pending.requestId, mode: 'queue',
          content: [{ type: 'text', text: pending.prompt }],
        }, AbortSignal.timeout(30000))
        if (result.accepted !== true) throw new Error('DSH did not accept the prompt')
      }
    } catch {
      throw new DraftError(502, 'DSH 暂未接收任务。草稿已保存，可重新提交同一版本。')
    }
    const submission = { version, sessionId: pending.sessionId, submittedAt: new Date().toISOString() }
    if (!await store.create(receiptPath, jsonText(submission))) return { submission: await readRecord(store, receiptPath) }
    return { submission }
  }

  function submit(workspace, body, getSource) {
    const id = idOf(body.id), version = versionOf(body.version)
    const key = workspace.path + '\0' + id + '/' + version
    if (submitting.has(key)) return submitting.get(key)
    const operation = dispatch(workspace, id, version, getSource).finally(() => submitting.delete(key))
    submitting.set(key, operation)
    return operation
  }

  return { list, save, submit }
}
