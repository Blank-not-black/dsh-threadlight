import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { parseGraph } from './graph.mjs'
import { createLocalStore } from './local-store.mjs'
import { renderModuleDocument, renderReader } from './reader.mjs'
import { createDraftService, draftAssets, renderDraftEditor } from './dsh-drafts.mjs'
import { DraftError } from './flow-draft.mjs'
import { launchAssets, renderLauncher, renderCreateWorkspace, renderWorkspaceList } from './dsh-launch.mjs'

const mount = '/threadlight'
const script = await readFile(new URL('./dsh-review.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('./dsh-review.css', import.meta.url), 'utf8')
const MAX_INPUT = 3000

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
    if (typeof revision !== 'string' || !/^threadlight-[0-9a-f]{16}$/.test(revision)) {
      throw new RequestError(409, '工作区的 Threadlight 状态无效，请刷新图谱。')
    }
    raw = await store.read('revisions/' + revision + '/graph.json')
  } else {
    raw = await store.read('graph.json')
  }
  if (!raw) return null
  return { directory, store, graph: parseGraph(raw), digest: createHash('sha256').update(raw).digest('hex') }
}

async function workspaceEntries(registry) {
  const rows = []
  for (const workspace of registry.list()) {
    let state = 'unavailable'
    try {
      if (await availableWorkspace(workspace)) state = await workGraph(workspace) ? 'graph' : 'draft'
    } catch {
      state = 'issue'
    }
    const { id, title, path } = workspace
    rows.push({ id, title, path, state })
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

function getGroup(graph, id) {
  const group = graph.groups.find(group => group.id === id)
  if (!group) throw new RequestError(404, '当前图谱中找不到这个模块。')
  return group
}

async function listNotes({ directory, store }, group) {
  for (const path of ['annotations', 'annotations/' + group]) {
    const info = await missingAsNull(() => lstat(join(directory, path)))
    if (!info) return []
    if (!info.isDirectory()) throw new RequestError(409, '批注目录的格式无效。')
  }
  const folder = 'annotations/' + group + '/'
  const files = await readdir(join(directory, folder), { withFileTypes: true })
  const notes = []
  for (const file of files) {
    if (!file.isFile() || !/^[0-9a-f-]{36}\.json$/.test(file.name)) continue
    const raw = await store.read(folder + file.name)
    if (raw !== null) {
      const { id, text, createdAt } = JSON.parse(raw)
      if (typeof id === 'string' && typeof text === 'string' && typeof createdAt === 'string') notes.push({ id, text, createdAt })
    }
  }
  return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
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
  let controller, policy, picker
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
  const drafts = createDraftService(ctx.fs, () => controller, () => policy)

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
      const asset = draftAssets.get(name) ?? launchAssets.get(name)
      if (asset) return send(res, 200, asset.type, asset.text ?? await readFile(asset.path, 'utf8'))
    }
    if (req.method === 'GET' && url.pathname === mount) {
      res.writeHead(303, { location: 'threadlight/' }).end()
      return
    }
    if (req.method === 'GET' && url.pathname === mount + '/') {
      const id = url.searchParams.get('workspace')
      const view = url.searchParams.get('view')
      if (!id && view === 'create') return send(res, 200, 'text/html', renderCreateWorkspace(picker?.kind))
      if (!id && view === 'workspaces') return send(res, 200, 'text/html', renderWorkspaceList(await workspaceEntries(ctx.workspaceRegistry)))
      const workspace = id ? ctx.workspaceRegistry.get(id) : null
      if (workspace && await availableWorkspace(workspace)) {
        const source = await workGraph(workspace)
        if (source && url.searchParams.has('doc')) {
          const group = getGroup(source.graph, url.searchParams.get('doc'))
          return send(res, 200, 'text/html', renderModuleDocument(group, {
            readerHref: '?' + new URLSearchParams({ workspace: id }),
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
        return json(res, 200, { workspace: workspace.id })
      }
      if (picker?.kind !== 'native') throw new RequestError(409, '当前 DSH 支持手动输入项目目录。')
      const controller = new AbortController()
      const close = () => controller.abort()
      res.once('close', close)
      try {
        const path = await picker.pick(controller.signal)
        if (!res.destroyed) return json(res, 200, { path })
      } finally {
        res.off('close', close)
      }
    }
    const annotations = url.pathname === mount + '/api/annotations'
    const draftsRoute = url.pathname === mount + '/api/drafts'
    const submit = url.pathname === mount + '/api/draft-submit'
    if (!annotations && !draftsRoute && !submit && url.pathname !== mount + '/api/explain') {
      throw new RequestError(404, '找不到此页面。')
    }
    const writing = req.method === 'POST'
    if (!writing && !((annotations || draftsRoute) && req.method === 'GET')) throw new RequestError(405, '不支持此请求方法。')
    const body = writing ? await readBody(req, draftsRoute ? 2 * 1024 * 1024 : undefined) : Object.fromEntries(url.searchParams)
    const workspace = typeof body.workspace === 'string' && ctx.workspaceRegistry.get(body.workspace)
    if (!workspace || !await availableWorkspace(workspace)) throw new RequestError(404, 'DSH 中找不到此工作区。')
    if (draftsRoute) {
      const result = writing ? await drafts.save(workspace, body, () => workGraph(workspace)) : await drafts.list(workspace, body.id ?? null)
      return json(res, 200, result)
    }
    if (submit) return json(res, 200, await drafts.submit(workspace, body, () => workGraph(workspace)))
    const source = await workGraph(workspace)
    if (!source) throw new RequestError(404, '工作区暂时没有图谱。')
    if (body.digest !== source.digest) throw new RequestError(409, '图谱已更新，请重新加载页面后再试。')
    const group = getGroup(source.graph, body.group)
    if (annotations) {
      if (!writing) return json(res, 200, { notes: await listNotes(source, group.id) })
      const note = { id: randomUUID(), text: input(body.text, '请输入 1 到 3000 字的批注。'), createdAt: new Date().toISOString() }
      const path = 'annotations/' + group.id + '/' + note.id + '.json'
      if (!await source.store.create(path, JSON.stringify({ ...note, module: group.id, graph: source.digest }, null, 2) + '\n')) {
        throw new RequestError(409, '批注保存冲突，请重试。')
      }
      return json(res, 201, { note })
    }
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
      const requestError = error instanceof RequestError || error instanceof DraftError
      const denied = ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(error.code)
      const status = requestError ? error.status : denied ? 403 : error.name === 'TimeoutError' ? 504 : 500
      const message = status === 504 ? 'DSH 讲解超时，请重试。' :
        requestError ? error.message : denied ? '当前 DSH 权限不允许写入这个工作区。' : 'Threadlight 暂时无法处理此请求。'
      json(res, status, { error: message })
    })
  } }), 'threadlight: authenticated review page')
}
