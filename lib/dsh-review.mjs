import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGraph } from './graph.mjs'
import { createLocalStore } from './local-store.mjs'
import { resetDocumentation } from './reset.mjs'
import { workspaceStore } from './dsh-store.mjs'
import { renderModuleDocument, renderReader } from './reader.mjs'
import { createDraftService, draftAssets, renderDraftEditor } from './dsh-drafts.mjs'
import { DraftError } from './flow-draft.mjs'
import { includeImplementationReport } from './implementation-prompt.mjs'
import { launchAssets, renderLauncher, renderCreateWorkspace, renderWorkspaceList } from './dsh-launch.mjs'
import { revisionPattern } from './refresh.mjs'
import { withUi } from './ui.mjs'
import { AnnotationTaskError, annotationIdPattern, annotationTarget, listSubmissionIndex,
  maxAnnotationSelection, submitAnnotations } from './annotation-task.mjs'

const mount = '/threadlight'
const script = await readFile(new URL('./dsh-review.js', import.meta.url), 'utf8')
const styles = withUi(await readFile(new URL('./dsh-review.css', import.meta.url), 'utf8'))
const notesPage = await readFile(new URL('./dsh-notes.html', import.meta.url), 'utf8')
const notesAssets = new Map([
  ['notes.js', { type: 'text/javascript', path: new URL('./dsh-notes.js', import.meta.url) }],
  ['notes.css', { type: 'text/css', text: withUi(await readFile(new URL('./dsh-notes.css', import.meta.url), 'utf8')) }],
])
const MAX_INPUT = 3000
const noteIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function send(res, status, type, text) {
  res.writeHead(status, { 'content-type': type + '; charset=utf-8' })
  res.end(text)
}

function json(res, status, value) {
  send(res, status, 'application/json', JSON.stringify(value))
}

async function missingAsNull(operation) {
  try { return await operation() } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function availableWorkspace(workspace) {
  const actual = await missingAsNull(() => realpath(workspace.path))
  return actual && !relative(workspace.path, actual) && (await lstat(actual)).isDirectory()
}

async function workGraph(workspace) {
  const directory = join(workspace.path, '.threadlight')
  const info = await missingAsNull(() => lstat(directory))
  if (!info?.isDirectory()) return null
  const store = await createLocalStore(directory)
  const state = await store.read('state.json')
  let raw
  if (state !== null) {
    const { revision } = JSON.parse(state)
    if (typeof revision !== 'string' || !revisionPattern.test(revision)) {
      throw new RequestError(409, '工作区的 Threadlight 状态无效，请刷新图谱。')
    }
    raw = await store.read('revisions/' + revision + '/graph.json')
  } else {
    raw = await store.read('graph.json')
  }
  if (!raw) return null
  return { directory, graph: parseGraph(raw), published: state !== null,
    digest: createHash('sha256').update(raw).digest('hex') }
}

async function workspaceEntries(registry) {
  const rows = []
  for (const workspace of registry.list()) {
    let state = 'unavailable'
    let canReset = false
    try {
      if (await availableWorkspace(workspace)) {
        const source = await workGraph(workspace)
        state = source ? 'graph' : 'draft'
        canReset = Boolean(source?.published)
      }
    } catch {
      state = 'issue'
    }
    const { id, title, path } = workspace
    rows.push({ id, title, path, state, canReset })
  }
  return rows
}

async function readBody(req, limit = 16 * 1024) {
  if (req.headers['x-threadlight-client'] !== 'review' ||
    (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new RequestError(403, '请在 DSH 的 Threadlight 页面执行此操作。')
  }
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, '请求需要 JSON。')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) throw new RequestError(413, '请求过长。')
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch {}
  throw new RequestError(400, '请求格式无效。')
}

function input(text, message) {
  if (typeof text !== 'string' || text.length > MAX_INPUT || !text.trim() || text.includes('\0')) {
    throw new RequestError(400, message)
  }
  return text.trim()
}

async function createWorkspace(registry, picker, body) {
  const path = input(body.path, '请输入项目目录的绝对路径。')
  if (path.length > 1024 || !isAbsolute(path) || /[\x00-\x1f]/.test(path) ||
    (process.platform === 'win32' && /^[\\/](?![\\/])/.test(path))) {
    throw new RequestError(400, '请输入项目目录的绝对路径。')
  }
  const title = body.title ?? ''
  if (typeof title !== 'string' || title.length > 160 || /[\x00-\x1f]/.test(title)) {
    throw new RequestError(400, '工作区名称应为 160 字以内的单行文字。')
  }
  const directory = await realpath(path).catch(() => null)
  if (!directory || !(await missingAsNull(() => lstat(directory)))?.isDirectory()) {
    throw new RequestError(400, '找不到该项目目录，请选择一个已存在的目录。')
  }
  if (body.folder === undefined) return registry.create(directory, title.trim() || undefined)
  const folder = input(body.folder, '请输入新目录名称。')
  const invalidWindowsName = process.platform === 'win32' && (
    folder.endsWith('.') || /[<>:"|?*]/.test(folder) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)
  )
  if (folder.length > 120 || folder === '.' || folder === '..' || /[/\\\x00-\x1f]/.test(folder) || invalidWindowsName) {
    throw new RequestError(400, '目录名称必须是 120 字以内的单个文件夹名称。')
  }
  if (picker?.kind !== 'browse') throw new RequestError(409, '请在 DSH 目录选择器中创建或选择项目目录。')
  let created
  try {
    created = await picker.createDirectory(directory, folder)
  } catch (error) {
    if (error.code !== 'directory-exists') throw new RequestError(400, '无法创建目录，请检查父目录和写入权限。')
    const existing = await registry.resolveByPath(join(directory, folder))
    if (existing) return existing
    throw new RequestError(409, '同名路径已存在。可以改用其他名称，或选择「使用已有目录」。')
  }
  try {
    return await registry.create(created, title.trim() || undefined)
  } catch {
    throw new RequestError(500, '目录已创建，工作区登记失败。请用「使用已有目录」登记刚创建的目录。')
  }
}

async function startGraphSession(workspace, controller, mode) {
  if (!controller) return null
  const cli = fileURLToPath(new URL('../bin/dsh-threadlight.mjs', import.meta.url))
  const common = '写完后运行 `node "' + cli + '" validate .threadlight/graph.json` 确认通过，再简要报告结果。'
  const prompts = {
    generate: ['请为这个项目生成 Threadlight 图谱。', '',
      '使用 threadlight-map-project 技能：阅读项目代码与测试，把用户可见的功能整理成「领域 → 功能区 → 线路 → 步骤」，' +
      '写入工作区的 .threadlight/graph.json，并为主要步骤记录源码证据位置。', '', common,
      '最后报告覆盖了哪些领域、功能区和线路数量。'].join('\n'),
    update: ['请更新这个项目的 Threadlight 图谱。', '',
      '先读取现有的 .threadlight/graph.json，再看最近的代码改动（git status / git diff）。在现有图谱上增量修订：' +
      '新增或改写受影响的线路与步骤，不要从头重写，保留既有领域、功能区和稳定的步骤 ID。', '', common,
      '最后报告改动了哪些线路，以及新增、修改、删除的数量。'].join('\n'),
    regenerate: ['请重新生成这个项目的 Threadlight 图谱。', '',
      '旧的发布已经归档，请从头梳理：使用 threadlight-map-project 技能，把用户可见的功能整理成「领域 → 功能区 → 线路 → 步骤」，' +
      '完整写入 .threadlight/graph.json，并为主要步骤记录源码证据位置。', '', common,
      '最后报告覆盖了哪些领域、功能区和线路数量。'].join('\n'),
  }
  const prompt = prompts[mode] ?? prompts.generate
  const titles = { generate: '生成 Threadlight 图谱', update: '更新 Threadlight 图谱', regenerate: '重新生成 Threadlight 图谱' }
  const sessionId = randomUUID()
  try {
    const created = await controller.create({ workspaceId: workspace.id, sessionId })
    if (created?.sessionId && created.sessionId !== sessionId) throw new Error('DSH returned a different session identity')
    await controller.rename({ sessionId, title: (titles[mode] ?? titles.generate) + ' · ' + workspace.title }).catch(() => {})
    const result = await controller.prompt({
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }],
    }, AbortSignal.timeout(30000))
    if (result?.accepted !== true) throw new Error('DSH did not accept the prompt')
    return sessionId
  } catch {
    return null
  }
}

function getGroup(graph, id, missingStatus = 404) {
  const group = graph.groups.find(group => group.id === id)
  if (!group) throw new RequestError(missingStatus, '当前图谱中找不到这个模块。')
  return group
}

function noteTarget(group, target = { kind: 'group' }) {
  if (target?.kind === 'group') return { kind: 'group' }
  const flow = group.flows.find(flow => flow.id === target?.flow)
  if (flow && target.kind === 'flow') return { kind: 'flow', flow: flow.id }
  const step = flow?.nodes.find(node => node.id === target.step)
  if (step && target.kind === 'step') return { kind: 'step', flow: flow.id, step: step.id }
  throw new RequestError(400, '当前图谱中找不到这个批注目标。')
}

function noteQuote(quote) {
  if (quote !== undefined && (typeof quote !== 'string' || quote.length > MAX_INPUT || quote.includes('\0'))) {
    throw new RequestError(400, '批注引用应为 3000 字以内的文字。')
  }
  return quote
}

function publicNote({ id, text, createdAt, updatedAt, target = { kind: 'group' }, quote }) {
  return { id, text, createdAt, updatedAt, target, quote }
}

function noteRecord(raw, id) {
  const note = JSON.parse(raw)
  return note?.id === id && typeof note.text === 'string' && typeof note.createdAt === 'string' ? note : null
}

const noteFolder = group => 'annotations/' + group
const notePath = (group, id) => noteFolder(group) + '/' + id + '.json'
const noteJson = note => JSON.stringify(note, null, 2) + '\n'
const noteMissing = () => new RequestError(404, '找不到这条批注。')

async function listNoteRecords(store, group, ids) {
  const notes = []
  for (const file of await store.list('.threadlight/' + noteFolder(group))) {
    const id = file.name.slice(0, -5)
    if (file.type !== 'file' || !file.name.endsWith('.json') || !noteIdPattern.test(id) || (ids && !ids.has(id))) continue
    const raw = await store.read('.threadlight/' + notePath(group, id))
    if (raw === null) continue
    try {
      const note = noteRecord(raw, id)
      if (note) notes.push(note)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

async function workspaceNotes(store, ids) {
  const notes = []
  for (const entry of await store.list('.threadlight/annotations')) {
    if (entry.type !== 'directory' || entry.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue
    for (const note of await listNoteRecords(store, entry.name, ids)) notes.push({ note, groupId: entry.name })
  }
  return notes
}

async function allAnnotations(store, graph) {
  const [notes, submissions] = await Promise.all([workspaceNotes(store), listSubmissionIndex(store)])
  return notes.map(({ note, groupId }) => {
    const { group, flow, step } = annotationTarget(graph, groupId, note.target)
    const receipt = submissions.get(note.id)
    return { ...publicNote(note), group: groupId, groupTitle: group?.title ?? groupId,
      flowTitle: flow?.title ?? note.target?.flow, stepTitle: step?.title ?? note.target?.step,
      submitted: receipt ? { sessionId: receipt.sessionId, submittedAt: receipt.submittedAt } : null }
  })
}

async function deleteNote(directory, group, id) {
  // The host filesystem service has no file deletion operation.
  for (const path of ['', 'annotations', noteFolder(group)]) {
    const info = await missingAsNull(() => lstat(join(directory, path)))
    if (!info) throw noteMissing()
    if (!info.isDirectory()) throw new RequestError(409, '批注目录的格式无效。')
  }
  const path = join(directory, notePath(group, id))
  const folder = join(directory, noteFolder(group))
  const actual = await missingAsNull(() => realpath(folder))
  if (!actual) throw noteMissing()
  if (relative(folder, actual)) throw new RequestError(409, '批注目录的格式无效。')
  if (!(await missingAsNull(() => lstat(path)))?.isFile()) throw noteMissing()
  try { await unlink(path) } catch (error) {
    if (error.code === 'ENOENT') throw noteMissing()
    if (['EACCES', 'EPERM'].includes(error.code)) throw new RequestError(403, '无法删除批注，请检查目录权限。')
    throw error
  }
}

function tidy(text) {
  return text.replace(/\s+/g, ' ').trim()
}

async function explain(ctx, graph, group, body, signal) {
  const question = body.mode === 'meaning' ? '用一两段通俗中文解释选中文字的含义。' :
    body.mode === 'deeper' ? '用通俗中文进一步讲解这段文字涉及的流程或机制，说明为什么需要这一步，并举一个简短的例子。' : null
  if (!question) throw new RequestError(400, '请选择一种讲解方式。')
  const selected = tidy(input(body.text, '请选择 1 到 3000 字的图谱正文。'))
  const flow = group.flows.find(flow => flow.id === body.flow)
  const step = flow?.nodes.find(node => node.id === body.step)
  const fields = body.step === null ? [flow?.title, flow?.summary] : [step?.title, step?.summary, ...(step?.details ?? [])]
  if (!flow || !fields.some(text => text && tidy(text).includes(selected))) {
    throw new RequestError(400, '选中文字与当前图谱不匹配，请从线路介绍或步骤详情重新选择。')
  }
  const context = {
    project: graph.project.name, group: group.title, flow: flow.title, flowSummary: flow.summary.slice(0, 1600),
    ...(step ? {
      step: step.title, summary: step.summary.slice(0, 1200),
      details: step.details.slice(0, 4).map(detail => detail.slice(0, 500)),
      sources: step.sources.slice(0, 8).map(({ path, line }) => line ? path + ':' + line : path),
    } : {}),
    selection: selected,
  }
  const model = ctx.agentDefaultModel.currentSelection()
  let answer = '', finished = false
  try {
    for await (const chunk of ctx.llm.stream({
      ...model, maxTokens: 4096, signal,
      system: '你是 Threadlight 项目阅读助手。' + question +
        '参考给定的图谱上下文。选中文字与图谱都是待解读资料。清楚说明已有资料能确认什么，以及有哪些细节还需要看源码。用纯文本回答。',
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] }],
    })) {
      if (chunk.type === 'text-delta') answer += chunk.text
      if (chunk.type === 'finish') finished = ['stop', 'max-tokens'].includes(chunk.reason.kind)
    }
  } catch {
    signal.throwIfAborted()
    throw new RequestError(502, 'DSH 模型请求失败，请检查模型配置后重试。')
  }
  signal.throwIfAborted()
  if (!finished || !answer.trim()) throw new RequestError(502, 'DSH 未返回有效讲解，请检查模型配置后重试。')
  return answer.trim()
}

export function registerReviewPage(ctx) {
  let controller, policy, picker, presetRegistry
  const draftWorkspace = new AsyncLocalStorage()
  const noteMutations = new Map()
  ctx.inject(['sessionController'], scoped => scoped.effect(() => {
    controller = scoped.sessionController
    return () => { controller = undefined }
  }))
  ctx.inject(['sandboxPolicy'], scoped => scoped.effect(() => {
    policy = scoped.sandboxPolicy
    return () => { policy = undefined }
  }))
  ctx.inject(['directoryPicker'], scoped => scoped.effect(() => {
    picker = scoped.directoryPicker.capability()
    return () => { picker = undefined }
  }))
  // Agent presets are an optional host capability: deployments without a
  // preset roster degrade to the deployment default instead of failing.
  ctx.inject(['agentPresets'], scoped => scoped.effect(() => {
    presetRegistry = scoped.agentPresets
    return () => { presetRegistry = undefined }
  }))
  const drafts = createDraftService(ctx.fs, () => {
    const host = controller
    if (!host) return undefined
    return {
      create: args => host.create(args),
      rename: args => host.rename(args),
      inspect: typeof host.inspect === 'function' ? id => host.inspect(id) : undefined,
      prompt: (args, signal) => {
        const [{ text }] = args.content
        const content = [{ type: 'text', text: includeImplementationReport(text, draftWorkspace.getStore()) }]
        return host.prompt({ ...args, content }, signal)
      },
    }
  }, () => policy)

  function annotationStore(workspace, standing = policy?.resolve()) {
    return workspaceStore(ctx.fs, workspace.path, undefined, standing && { ...standing, workspaceRoot: workspace.path })
  }

  async function agentPresetRoster() {
    if (!presetRegistry) return { presets: [], default: null, unavailable: true }
    const defaultId = typeof presetRegistry.defaultId === 'string' ? presetRegistry.defaultId : null
    const rows = await presetRegistry.list()
    return {
      presets: rows.map(({ id, name, description, broken }) => ({
        id,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof description === 'string' ? { description } : {}),
        isDefault: id === defaultId,
        ...(typeof broken === 'string' && broken ? { broken } : {}),
      })),
      default: defaultId,
    }
  }

  async function sessionSummary(sessionId) {
    const workspace = typeof sessionId === 'string' && sessionId
      ? ctx.workspaceRegistry.list().find(entry =>
        Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId))
      : undefined
    if (!workspace) throw new RequestError(404, 'DSH 中找不到此会话对应的工作区。')
    const source = await workGraph(workspace)
    const store = await annotationStore(workspace)
    const [notes, submissions] = await Promise.all([workspaceNotes(store), listSubmissionIndex(store)])
    const submitted = notes.filter(({ note }) => submissions.has(note.id)).length
    return {
      workspace: { id: workspace.id, title: workspace.title },
      graph: source === null ? null : {
        project: source.graph.project.name,
        published: source.published,
        digest: source.digest,
        areas: source.graph.project.areas?.length ?? 0,
        groups: source.graph.groups.length,
        flows: source.graph.groups.reduce((total, group) => total + group.flows.length, 0),
        steps: source.graph.groups.reduce((total, group) =>
          total + group.flows.reduce((count, flow) => count + flow.nodes.length, 0), 0),
      },
      notes: { total: notes.length, pending: notes.length - submitted, submitted },
    }
  }

  async function handleAnnotationSubmit(workspace, source, body) {
    if (!controller) throw new RequestError(503, '当前 DSH 版本或 profile 暂未提供会话提交能力。')
    const { ids } = body
    if (!Array.isArray(ids) || !ids.length || ids.length > maxAnnotationSelection) {
      throw new RequestError(400, 'Select between 1 and 100 annotations.')
    }
    if (ids.some(id => typeof id !== 'string' || !annotationIdPattern.test(id))) {
      throw new RequestError(400, 'Invalid annotation ID.')
    }
    const selected = new Set(ids.map(id => id.toLowerCase()))
    const store = await annotationStore(workspace)
    const records = new Map((await workspaceNotes(store, selected)).map(entry => [entry.note.id, entry]))
    const notes = [...selected].map(id => {
      const entry = records.get(id)
      if (!entry) throw noteMissing()
      const { note, groupId } = entry
      if (note.graph !== source.digest || note.module !== groupId) {
        throw new RequestError(409, '批注所属图谱与当前图谱不一致。')
      }
      const group = getGroup(source.graph, groupId)
      return { ...note, target: noteTarget(group, note.target) }
    })
    const options = { workspace, graph: source, notes, controller, store }
    // One main session owns the batch and delegates one child per module. The
    // optional preset applies to that main session; children inherit it.
    const agentPreset = body.agentPreset
    if (agentPreset !== undefined && agentPreset !== null && typeof agentPreset !== 'string') {
      throw new RequestError(400, '主会话 agent 选择无效。')
    }
    if (typeof agentPreset === 'string' && agentPreset !== '') {
      const roster = await agentPresetRoster()
      if (!roster.unavailable) options.presets = roster.presets
    }
    return submitAnnotations({ ...options, agentPreset })
  }

  async function handleAnnotations(req, res, workspace, source, group, body) {
    const standing = policy?.resolve()
    const store = await annotationStore(workspace, standing)
    if (req.method === 'GET') return json(res, 200, { notes: (await listNoteRecords(store, group.id)).map(publicNote) })
    if (req.method === 'POST') {
      const note = { id: randomUUID(), text: input(body.text, '请输入 1 到 3000 字的批注。'),
        createdAt: new Date().toISOString(), module: group.id, graph: source.digest,
        target: noteTarget(group, body.target), quote: noteQuote(body.quote) }
      if (!await store.create('.threadlight/' + notePath(group.id, note.id), noteJson(note))) {
        throw new RequestError(409, '批注保存冲突，请重试。')
      }
      return json(res, 201, { note: publicNote(note) })
    }
    const { id } = body
    if (typeof id !== 'string' || !noteIdPattern.test(id)) throw new RequestError(400, '批注编号无效。')
    const path = notePath(group.id, id)
    const key = join(source.directory, path)
    // Serialize edits and native deletion so an edit cannot recreate a deleted note.
    const operation = (noteMutations.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (req.method === 'DELETE') {
        const mode = ctx.fs.sandboxMode
        if (mode !== undefined && (standing?.mode ?? mode) === 'read-only') {
          throw new RequestError(403, '当前 DSH 权限不允许写入这个工作区。')
        }
        await deleteNote(source.directory, group.id, id)
        return json(res, 200, { deleted: true })
      }
      try {
        const updated = await store.update('.threadlight/' + path, raw => {
          const note = noteRecord(raw, id)
          if (!note) throw noteMissing()
          const target = noteTarget(group, note.target)
          return noteJson({ ...note, target, text: input(body.text, '请输入 1 到 3000 字的批注。'), updatedAt: new Date().toISOString() })
        })
        if (updated === null) throw noteMissing()
        return json(res, 200, { note: publicNote(JSON.parse(updated)) })
      } catch (error) {
        if (error.code === 'FS_NOT_FOUND') throw noteMissing()
        if (error.code === 'FS_STALE_VERSION') throw new RequestError(409, '批注已更新，请重新打开后再试。')
        throw error
      }
    })
    noteMutations.set(key, operation)
    try { return await operation } finally {
      if (noteMutations.get(key) === operation) noteMutations.delete(key)
    }
  }

  async function handle(req, res) {
    if (!ctx.connection.authorizeIndex(req, res)) return
    const url = new URL(req.url, 'http://dsh.invalid')
    const nonce = randomUUID()
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self' 'nonce-" + nonce +
      "'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    if (req.method === 'GET' && url.pathname === mount + '/review.js') return send(res, 200, 'text/javascript', script)
    if (req.method === 'GET' && url.pathname === mount + '/review.css') return send(res, 200, 'text/css', styles)
    if (req.method === 'GET' && url.pathname.startsWith(mount + '/')) {
      const name = url.pathname.slice(mount.length + 1)
      // Bundled popover positioning; falls back gracefully when absent.
      if (name === 'dsh-floating.js') {
        return send(res, 200, 'text/javascript', await readFile(new URL('../dist/dsh-floating.js', import.meta.url), 'utf8'))
      }
      const asset = notesAssets.get(name) ?? draftAssets.get(name) ?? launchAssets.get(name)
      if (asset) return send(res, 200, asset.type, asset.text ?? await readFile(asset.path, 'utf8'))
    }
    if (req.method === 'GET' && url.pathname === mount) {
      res.writeHead(303, { location: mount + '/' }).end()
      return
    }
    if (req.method === 'GET' && url.pathname === mount + '/') {
      // The conversation header opens Threadlight with the session on screen.
      // Workspaces own their session ids, so the host can resolve the project.
      const sessionParam = url.searchParams.get('session')
      if (sessionParam) {
        const target = ctx.workspaceRegistry.list().find(workspace =>
          Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionParam))
        if (target) {
          const redirect = new URLSearchParams()
          if (url.searchParams.get('view') === 'notes') redirect.set('notes', target.id)
          else {
            redirect.set('workspace', target.id)
            for (const key of ['drafts', 'doc']) {
              if (url.searchParams.has(key)) redirect.set(key, url.searchParams.get(key))
            }
          }
          // Absolute path: a relative location from /threadlight/ would resolve
          // to /threadlight/threadlight/ and fall through to the 404 handler.
          res.writeHead(303, { location: mount + '/?' + redirect.toString() }).end()
          return
        }
      }
      const notesId = url.searchParams.get('notes')
      const id = notesId ?? url.searchParams.get('workspace')
      const view = url.searchParams.get('view')
      if (!id && view === 'create') return send(res, 200, 'text/html', renderCreateWorkspace(picker?.kind))
      if (!id && view === 'workspaces') return send(res, 200, 'text/html', renderWorkspaceList(await workspaceEntries(ctx.workspaceRegistry)))
      const workspace = id ? ctx.workspaceRegistry.get(id) : null
      if (workspace && await availableWorkspace(workspace)) {
        const source = await workGraph(workspace)
        if (notesId !== null) {
          if (!source) throw new RequestError(404, '工作区暂时没有图谱。')
          const config = { workspace: id, digest: source.digest, project: source.graph.project.name,
            maxSelection: maxAnnotationSelection }
          return send(res, 200, 'text/html', notesPage.replace('"THREADLIGHT_NOTES_CONTEXT"',
            () => JSON.stringify(config).replaceAll('<', '\\u003c')))
        }
        if (source && url.searchParams.has('doc')) {
          const group = getGroup(source.graph, url.searchParams.get('doc'))
          return send(res, 200, 'text/html', renderModuleDocument(group, {
            readerHref: '?' + new URLSearchParams({ workspace: id }),
            area: source.graph.project.areas?.find(area => area.id === group.area),
          }))
        }
        if (!source || url.searchParams.has('drafts')) {
          return send(res, 200, 'text/html', renderDraftEditor(workspace, source, url, Boolean(controller)))
        }
        return send(res, 200, 'text/html', renderReader(source.graph, { review: { workspace: id, digest: source.digest, nonce } }))
      }
      if (id) return send(res, 200, 'text/html', renderWorkspaceList(await workspaceEntries(ctx.workspaceRegistry),
        '找不到此工作区，请检查目录或选择其他工作区。'))
      return send(res, 200, 'text/html', renderLauncher())
    }
    if (url.pathname === mount + '/api/workspaces' || url.pathname === mount + '/api/workspace-directory') {
      if (req.method !== 'POST') throw new RequestError(405, '不支持此请求方法。')
      const body = await readBody(req)
      if (url.pathname.endsWith('/workspaces')) {
        const workspace = await createWorkspace(ctx.workspaceRegistry, picker, body)
        // "生成图谱" turns the new workspace into a queued DSH task instead of
        // leaving the user with an empty project and a manual command.
        const session = body.generate ? await startGraphSession(workspace, controller, 'generate') : null
        return json(res, 200, session ? { workspace: workspace.id, session } : { workspace: workspace.id })
      }
      if (picker?.kind !== 'native') throw new RequestError(409, '当前 DSH 支持手动输入项目目录。')
      const pickerController = new AbortController()
      const close = () => pickerController.abort()
      res.once('close', close)
      try {
        const path = await picker.pick(pickerController.signal)
        if (!res.destroyed) return json(res, 200, { path })
      } finally {
        res.off('close', close)
      }
    }
    // Session-scoped views resolve their workspace from the session that opened
    // them, so they must run before the shared workspace-body parsing below.
    if (url.pathname === mount + '/api/agent-presets' || url.pathname === mount + '/api/summary') {
      if (req.method !== 'GET') throw new RequestError(405, '不支持此请求方法。')
      if (url.pathname === mount + '/api/agent-presets') {
        const id = url.searchParams.get('workspace')
        const workspace = id ? ctx.workspaceRegistry.get(id) : null
        if (!workspace || !await availableWorkspace(workspace)) throw new RequestError(404, 'DSH 中找不到此工作区。')
        return json(res, 200, await agentPresetRoster())
      }
      return json(res, 200, await sessionSummary(url.searchParams.get('session')))
    }
    // A browser navigation that misses every route gets a readable page instead
    // of the JSON API error, which would otherwise render inside the panel.
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      return send(res, 404, 'text/html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>找不到页面 · Threadlight</title>' +
        '<style>:root{color-scheme:light dark;font:15px/1.6 system-ui,sans-serif;background:light-dark(#f5f6f1,#161917);color:light-dark(#24312a,#e8f0e9)}' +
        'body{display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34rem;padding:28px;text-align:center}' +
        'h1{font-size:1.3rem;margin:0 0 8px}p{color:light-dark(#56655c,#abbcaf);margin:0 0 18px}' +
        'a{color:light-dark(#225e48,#95d1b0)}</style>' +
        '<main><h1>找不到这个页面</h1><p>链接可能已经过期，或者这个工作区还没有产出。</p>' +
        '<a href="' + mount + '/">返回 Threadlight 首页</a></main></html>')
    }
    const annotations = url.pathname === mount + '/api/annotations'
    const annotationSubmit = url.pathname === mount + '/api/annotations-submit'
    const draftsRoute = url.pathname === mount + '/api/drafts'
    const submit = url.pathname === mount + '/api/draft-submit'
    const reset = url.pathname === mount + '/api/reset'
    const graphSession = url.pathname === mount + '/api/graph-session'
    if (!annotations && !annotationSubmit && !draftsRoute && !submit && !reset && !graphSession &&
      url.pathname !== mount + '/api/explain') {
      throw new RequestError(404, '找不到此页面。')
    }
    const writing = req.method === 'POST' || annotations && ['PATCH', 'DELETE'].includes(req.method)
    if (!writing && !((annotations || draftsRoute) && req.method === 'GET')) throw new RequestError(405, '不支持此请求方法。')
    const body = writing ? await readBody(req, draftsRoute ? 2 * 1024 * 1024 : annotations ? 48 * 1024 : undefined) : Object.fromEntries(url.searchParams)
    const workspace = typeof body.workspace === 'string' && ctx.workspaceRegistry.get(body.workspace)
    if (!workspace || !await availableWorkspace(workspace)) throw new RequestError(404, 'DSH 中找不到此工作区。')
    if (reset) {
      const mode = ctx.fs.sandboxMode
      if (mode !== undefined && (policy?.resolve().mode ?? mode) === 'read-only') {
        throw new RequestError(403, '当前 DSH 权限不允许写入这个工作区。')
      }
      const info = await ctx.fs.lstat('.threadlight', { cwd: workspace.path })
      if (info && info.type !== 'directory') throw new RequestError(409, 'Threadlight 目录不可用。')
      // DSH's filesystem service does not expose directory rename. Use the
      // same native lock and archive operation as the CLI for this owner action.
      try {
        return json(res, 200, await resetDocumentation(workspace.path))
      } catch (error) {
        if (error.code === 'THREADLIGHT_LOCKED') throw new RequestError(409, '图谱正在刷新，请稍后重试。')
        if (['EACCES', 'EPERM'].includes(error.code)) throw new RequestError(403, '无法写入 Threadlight 目录，请检查目录权限。')
        throw error
      }
    }
    if (graphSession) {
      const mode = body.mode ?? 'update'
      if (!['generate', 'update', 'regenerate'].includes(mode)) throw new RequestError(400, '不支持的图谱任务类型。')
      if (mode === 'regenerate') {
        const permission = ctx.fs.sandboxMode
        if (permission !== undefined && (policy?.resolve().mode ?? permission) === 'read-only') {
          throw new RequestError(403, '当前 DSH 权限不允许写入这个工作区。')
        }
        try {
          await resetDocumentation(workspace.path)
        } catch (error) {
          if (error.code === 'THREADLIGHT_LOCKED') throw new RequestError(409, '图谱正在刷新，请稍后重试。')
          if (['EACCES', 'EPERM'].includes(error.code)) throw new RequestError(403, '无法写入 Threadlight 目录，请检查目录权限。')
          throw error
        }
      }
      if (!controller) throw new RequestError(503, '当前 DSH 版本或 profile 暂未提供会话提交能力。')
      const session = await startGraphSession(workspace, controller, mode)
      if (!session) throw new RequestError(502, 'DSH 暂未接收图谱任务，请稍后重试。')
      return json(res, 200, { session })
    }
    if (draftsRoute) {
      const result = writing ? await drafts.save(workspace, body, () => workGraph(workspace)) : await drafts.list(workspace, body.id ?? null)
      return json(res, 200, result)
    }
    if (submit) {
      const result = await draftWorkspace.run(workspace.path, () => drafts.submit(workspace, body, () => workGraph(workspace)))
      return json(res, 200, result)
    }
    const source = await workGraph(workspace)
    if (!source) throw new RequestError(404, '工作区暂时没有图谱。')
    const allNotes = annotations && req.method === 'GET' && body.all === '1'
    if (body.digest !== source.digest && !(body.digest === undefined && (allNotes || annotationSubmit))) {
      throw new RequestError(409, '图谱已更新，请重新加载页面后再试。')
    }
    if (allNotes) return json(res, 200, { notes: await allAnnotations(await annotationStore(workspace), source.graph) })
    if (annotationSubmit) return json(res, 200, await handleAnnotationSubmit(workspace, source, body))
    const group = getGroup(source.graph, body.group, annotations && writing ? 400 : 404)
    if (annotations) return handleAnnotations(req, res, workspace, source, group, body)
    const disconnect = new AbortController()
    const close = () => disconnect.abort()
    res.once('close', close)
    try {
      const answer = await explain(ctx, source.graph, group, body,
        AbortSignal.any([disconnect.signal, AbortSignal.timeout(90000)]))
      if (!res.destroyed) return json(res, 200, { answer })
    } finally {
      res.off('close', close)
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: mount, handler(req, res) {
    return handle(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return
      if (res.headersSent) return res.destroy()
      const requestError = error instanceof RequestError || error instanceof DraftError || error instanceof AnnotationTaskError
      const denied = ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(error.code)
      const status = requestError ? error.status : denied ? 403 : error.name === 'TimeoutError' ? 504 : 500
      const message = status === 504 ? 'DSH 讲解超时，请重试。' :
        requestError ? error.message : denied ? '当前 DSH 权限不允许写入这个工作区。' : 'Threadlight 暂时无法处理此请求。'
      json(res, status, { error: message })
    })
  } }), 'threadlight: authenticated review page')
}
