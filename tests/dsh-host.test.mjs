import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseGraph } from '../lib/graph.mjs'
import { publishReader } from '../lib/reader.mjs'

const cli = process.env.THREADLIGHT_DSH_CLI_ROOT

test('installed DSH serves the reviewer, exports notes and accepts annotations and drafts as workspace tasks', { skip: !cli, timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'threadlight-dsh-'))
  const workspace = join(home, 'workspace')
  const emptyWorkspace = join(home, 'empty-workspace')
  const newWorkspace = join(home, 'launcher-workspace')
  const unavailableWorkspace = join(home, 'unavailable-workspace')
  const unreadableGraph = join(home, 'unreadable-graph')
  const receiptPath = join(home, 'receipt.json')
  const patchPath = join(home, 'patch.json')
  const probePath = join(home, 'probe.mjs')
  const packageEntry = fileURLToPath(new URL('../index.mjs', import.meta.url))
  let child, closed
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await closed
    }
    await rm(home, { recursive: true, force: true })
  })
  await mkdir(join(workspace, '.threadlight'), { recursive: true })
  await mkdir(emptyWorkspace)
  await mkdir(newWorkspace)
  await mkdir(unavailableWorkspace)
  await mkdir(join(unreadableGraph, '.threadlight'), { recursive: true })
  await writeFile(join(unreadableGraph, '.threadlight/graph.json'), '{', 'utf8')
  const exampleGraph = JSON.parse(await readFile(new URL('../examples/basic.graph.json', import.meta.url), 'utf8'))
  exampleGraph.project.areas = [{ id: 'delivery', title: '交付' }]
  exampleGraph.groups[0].area = 'delivery'
  const example = JSON.stringify(exampleGraph)
  const control = join(workspace, '.threadlight')
  await writeFile(join(control, 'graph.json'), example, 'utf8')
  const published = await publishReader(parseGraph(example), join(control, 'revisions'))
  await writeFile(join(control, 'state.json'), JSON.stringify({ revision: published.revision }))
  await writeFile(join(control, 'viewer.html'), await readFile(published.viewer))
  await writeFile(probePath, [
    "import { rename, writeFile } from 'node:fs/promises'",
    "import { setTimeout as delay } from 'node:timers/promises'",
    "export const inject = ['tools', 'sessions', 'fs', 'skills', 'workspaceRegistry', 'connection', 'webServer', 'llm', 'sessionController']",
    'export function apply(ctx) {',
    "  ctx.on('llm/stream', async function* (options) {",
    "    let answer = 'Fixture model response'",
    "    if (options.system?.startsWith('你是 Threadlight 项目阅读助手')) {",
    "      const context = JSON.parse(options.messages[0].content[0].text)",
    "      if (options.tools?.length || context.selection !== '节点编号') throw Error('Unexpected model context')",
    "      answer = options.system.includes('举一个') ? 'Further explanation' : 'Plain explanation'",
    "    }",
    "    yield { type: 'text-delta', index: 0, text: answer }",
    "    yield { type: 'finish', reason: { kind: 'stop' } }",
    "  })",
    '  const run = async () => {',
    "    for (let i = 0; i < 100 && !ctx.tools.get('threadlight_export'); i++) await delay(50)",
    "    const tool = ctx.tools.get('threadlight_export')",
    "    if (!tool) throw Error('Threadlight tool was not registered')",
    "    const session = ctx.sessions.create('threadlight-smoke', { meta: { cwd: " + JSON.stringify(workspace) + ' } })',
    "    const exec = { agent: { session, ctx }, callId: 'threadlight-smoke', signal: new AbortController().signal }",
    "    const first = await tool.execute({}, exec)",
    "    const repeated = await tool.execute({}, exec)",
    "    const skill = await ctx.skills.get('threadlight-map-project')",
    "    const documentSkill = await ctx.skills.get('threadlight-document-project')",
    "    const ws = await ctx.workspaceRegistry.create(" + JSON.stringify(workspace) + ", 'Review fixture')",
    "    const empty = await ctx.workspaceRegistry.create(" + JSON.stringify(emptyWorkspace) + ", 'Empty fixture')",
    "    const unavailable = await ctx.workspaceRegistry.create(" + JSON.stringify(unavailableWorkspace) + ", 'Unavailable fixture')",
    "    await rename(unavailable.path, unavailable.path + '-moved')",
    "    await ctx.workspaceRegistry.create(" + JSON.stringify(unreadableGraph) + ", 'Unreadable graph fixture')",
    "    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/threadlight-fixture-session', async handler(req, res) {",
    "      if (!ctx.connection.authorizeIndex(req, res)) return",
    "      const id = new URL(req.url, 'http://dsh.invalid').searchParams.get('id')",
    "      const session = await ctx.sessionController.inspect(id)",
    "      const prompts = session.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted).filter(message => message.source.kind === 'user')",
    "      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cwd: session.meta.cwd, prompts, ids: empty.sessionIds, graphIds: ws.sessionIds }))",
    "    } }))",
    "    const base = 'http://127.0.0.1:' + ctx.webServer.port + '/'",
    "    const launch = ctx.connection.authenticatedUrl(base)",
    "    return { first, repeated, skill: Boolean(skill?.content?.includes('threadlight_export')), documentSkill: Boolean(documentSkill?.content?.includes('.threadlight/update.json')), mode: ctx.fs.sandboxMode ?? null, ws: ws.id, empty: empty.id, base, launch }",
    '  }',
    '  const write = async value => writeFile(' + JSON.stringify(receiptPath) + ', JSON.stringify(value))',
    "  void run().then(write, error => write({ error: error.message, stack: error.stack }))",
    '}',
  ].join('\n'), 'utf8')
  await writeFile(patchPath, JSON.stringify([{ insert: [
    { id: 'dsh-threadlight', name: packageEntry.replaceAll('\\', '/') },
    { id: 'threadlight-probe', name: probePath.replaceAll('\\', '/') },
  ] }]), 'utf8')
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh') }
  for (const key of Object.keys(env)) {
    if (/proxy|api[_-]?key|secret|token|^dsh_(?!home$)|^node_options$/i.test(key)) delete env[key]
  }
  // The Web profile uses its host browse picker when launched over SSH.
  env.SSH_CONNECTION = '127.0.0.1 60000 127.0.0.1 22'
  child = spawn(process.execPath, [
    join(cli, 'lib/bin.js'), '--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  closed = new Promise(resolve => child.once('close', resolve))
  let log = '', spawnError
  child.on('error', error => { spawnError = error })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { log = (log + chunk).slice(-5000) })
  }
  const limit = Date.now() + 30000
  let result
  while (Date.now() < limit && child.exitCode === null && !spawnError) {
    try { result = JSON.parse(await readFile(receiptPath, 'utf8')); break } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(100)
  }
  if (spawnError) throw spawnError
  assert.ok(result, log.replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]'))
  assert.equal(result.error, undefined, result.stack)
  assert.ok(result.skill, 'bundled skill can be loaded')
  assert.ok(result.documentSkill, 'dedicated documentation skill can be loaded')
  assert.equal(result.first.reused, false)
  assert.deepEqual(result.repeated, { ...result.first, reused: true })
  const canvas = JSON.parse(await readFile(join(workspace, result.first.overview), 'utf8'))
  assert.equal(canvas.nodes[0].file, '项目总览.md')
  assert.equal(canvas.edges[0].toEnd, 'arrow')
  assert.deepEqual(canvas.edges.map(({ fromNode, toNode }) => [fromNode, toNode]), [
    ['project', 'area-delivery'], ['area-delivery', 'module-export'],
  ])

  const page = new URL('threadlight/?workspace=' + result.ws, result.base)
  assert.equal((await fetch(page)).status, 401)
  const login = await fetch(result.launch, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const shell = await fetch(result.base, { headers: { cookie } })
  assert.ok((await shell.text()).includes('dsh-threadlight'), 'DSH boot graph includes the Threadlight client')
  const response = await fetch(page, { headers: { cookie } })
  assert.equal(response.status, 200)
  const html = await response.text()
  const data = JSON.parse(html.match(/id="data">(.*?)<\/script>/s)[1])
  assert.equal(data.review.workspace, result.ws)
  assert.deepEqual(data.project.areas, exampleGraph.project.areas)
  assert.match(html, /id="overview-tree" role="tree"/)
  const nonce = html.match(/<script nonce="([^"]+)">/)[1]
  assert.ok(response.headers.get('content-security-policy').includes("'nonce-" + nonce + "'"))
  const group = data.groups[0]
  const flow = group.flows[0]
  const documentPage = new URL(page)
  documentPage.searchParams.set('doc', group.id)
  assert.equal((await fetch(documentPage)).status, 401)
  const projectDoc = await fetch(documentPage, { headers: { cookie } })
  assert.equal(projectDoc.status, 200)
  const renderedDoc = await projectDoc.text()
  assert.match(renderedDoc, /交付 → 导出项目图谱/)
  assert.ok(renderedDoc.includes('id="' + flow.id + '--' + flow.nodes[0].id + '"'))
  assert.ok(renderedDoc.includes('#step/' + group.id + '/' + flow.id + '/' + flow.nodes[0].id))
  const selection = { ...data.review, group: group.id, flow: flow.id, step: null, text: '节点编号' }
  const post = (route, body, headers = {}, method = 'POST') => fetch(new URL('threadlight/api/' + route, result.base), {
    method,
    headers: { cookie, 'content-type': 'application/json', 'x-threadlight-client': 'review', ...headers },
    body: JSON.stringify(body),
  })
  const launcher = new URL('threadlight/', result.base)
  const launcherResponse = await fetch(launcher, { headers: { cookie } })
  assert.equal(launcherResponse.status, 200)
  const launcherHtml = await launcherResponse.text()
  assert.match(launcherHtml, /class="choice see"[\s\S]*id="open-create" href="\?view=create">创建新工作区/)
  assert.match(launcherHtml, /class="choice shape"[\s\S]*id="open-existing" href="\?view=workspaces">进入已有工作区/)
  const createPage = new URL('?view=create', launcher)
  const workspaceList = new URL('?view=workspaces', launcher)
  const getPage = async url => {
    const result = await fetch(url, { headers: { cookie } })
    assert.equal(result.status, 200)
    return result.text()
  }
  assert.equal((await fetch(workspaceList)).status, 401)
  const createHtml = await getPage(createPage)
  assert.match(createHtml, /<h1>创建新工作区<\/h1>/)
  assert.match(createHtml, /name="folder"/)
  assert.match(createHtml, /使用已有目录/)
  const workspacesHtml = await getPage(workspaceList)
  assert.match(workspacesHtml, /data-state="graph">\s*<div class="workspace-meta">\s*<strong>Review fixture<\/strong>/)
  assert.match(workspacesHtml, /data-state="draft">\s*<div class="workspace-meta">\s*<strong>Empty fixture<\/strong>/)
  assert.match(workspacesHtml, /data-state="unavailable">\s*<div class="workspace-meta">\s*<strong>Unavailable fixture<\/strong>/)
  assert.match(workspacesHtml, /data-state="issue">\s*<div class="workspace-meta">\s*<strong>Unreadable graph fixture<\/strong>/)
  assert.match(workspacesHtml, /id="workspace-search"/)
  assert.match(workspacesHtml, /id="workspace-filter"/)
  const graphActionIds = [...workspacesHtml.matchAll(/data-workspace="([^"]+)"/g)].map(match => match[1])
  assert.ok(graphActionIds.includes(result.ws))
  assert.match(workspacesHtml, /data-graph-mode="update"/)
  assert.match(workspacesHtml, /data-graph-mode="regenerate"/)
  assert.match(await getPage(new URL('?workspace=missing', launcher)), /role="alert">找不到此工作区/)
  assert.match(html, /href="\?view=workspaces">切换工作区/)
  for (const asset of ['launch.js', 'launch.css']) {
    assert.equal((await fetch(new URL(asset, launcher), { headers: { cookie } })).status, 200)
  }
  assert.equal((await post('workspaces', { path: newWorkspace }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await post('workspaces', { path: 'relative-directory' })).status, 400)
  assert.equal((await post('workspaces', { path: join(home, 'missing') })).status, 400)
  assert.equal((await post('workspaces', { path: home, folder: '../parent' })).status, 400)
  assert.equal((await post('workspaces', { path: home, folder: 'launcher-workspace' })).status, 409)
  const newDirectory = { path: home, folder: '新建目录' }
  const created = await post('workspaces', newDirectory)
  assert.equal(created.status, 200, await created.clone().text())
  const creation = await created.json()
  assert.ok((await stat(join(home, newDirectory.folder))).isDirectory())
  assert.deepEqual(await (await post('workspaces', newDirectory)).json(), creation)
  // "生成图谱" queues a real graph task instead of leaving an empty project.
  const generateDirectory = { path: home, folder: '生成图谱目录', generate: '1' }
  const generatedCreation = await post('workspaces', generateDirectory)
  assert.equal(generatedCreation.status, 200, log.slice(-1500) + '\n' + await generatedCreation.clone().text())
  const generatedWorkspace = await generatedCreation.json()
  assert.ok(generatedWorkspace.session)
  const generatedSession = await (await fetch(new URL('threadlight-fixture-session?id=' + generatedWorkspace.session, result.base), { headers: { cookie } })).json()
  assert.match(JSON.stringify(generatedSession.prompts[0]), /生成 Threadlight 图谱/)
  // Manual update and regenerate create their own queued tasks.
  const updateTask = await post('graph-session', { workspace: generatedWorkspace.workspace, mode: 'update' })
  assert.equal(updateTask.status, 200, await updateTask.clone().text())
  const updateTaskBody = await updateTask.json()
  assert.ok(updateTaskBody.session)
  const updateSession = await (await fetch(new URL('threadlight-fixture-session?id=' + updateTaskBody.session, result.base), { headers: { cookie } })).json()
  assert.match(JSON.stringify(updateSession.prompts[0]), /更新这个项目的 Threadlight 图谱/)
  assert.equal((await post('graph-session', { workspace: generatedWorkspace.workspace, mode: 'nope' })).status, 400)
  const regenerated = await post('graph-session', { workspace: generatedWorkspace.workspace, mode: 'regenerate' })
  assert.equal(regenerated.status, 200, await regenerated.clone().text())
  assert.ok((await regenerated.json()).session)
  const createdDraftHtml = await getPage(new URL('?' + new URLSearchParams(creation), launcher))
  assert.match(createdDraftHtml, /"hasGraph":false/)
  assert.match(createdDraftHtml, /新建目录/)
  const registered = await post('workspaces', { path: newWorkspace, title: 'Launcher <new>' })
  assert.equal(registered.status, 200, await registered.clone().text())
  const registration = await registered.json()
  assert.deepEqual(await (await post('workspaces', { path: newWorkspace, title: 'Retry' })).json(), registration)
  const newDraftPage = await fetch(new URL('?' + new URLSearchParams(registration), launcher), { headers: { cookie } })
  assert.equal(newDraftPage.status, 200)
  const newDraftHtml = await newDraftPage.text()
  assert.match(newDraftHtml, /"hasGraph":false/)
  assert.match(newDraftHtml, /Launcher \\u003cnew>/)
  assert.match(newDraftHtml, /href="\?view=workspaces">切换工作区/)
  assert.match(await getPage(workspaceList), /Launcher &lt;new&gt;/)
  assert.equal((await post('annotations', { ...selection, text: 'safe note' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  const saved = await post('annotations', { ...selection, text: 'safe note' })
  assert.equal(saved.status, 201)
  const savedNote = (await saved.json()).note
  assert.equal(savedNote.text, 'safe note')
  assert.deepEqual(savedNote.target, { kind: 'group' })
  const annotationFolder = join(control, 'annotations', group.id)
  const noteFile = id => join(annotationFolder, id + '.json')
  const { target: _target, ...legacy } = JSON.parse(await readFile(noteFile(savedNote.id), 'utf8'))
  await writeFile(noteFile(savedNote.id), JSON.stringify(legacy), 'utf8')
  const { workspace: reviewWorkspace, digest } = data.review
  const noteScope = { workspace: reviewWorkspace, digest, group: group.id }
  const getNotes = async () => {
    const url = new URL('threadlight/api/annotations?' + new URLSearchParams(noteScope), result.base)
    const response = await fetch(url, { headers: { cookie } })
    assert.equal(response.status, 200)
    return (await response.json()).notes
  }
  assert.deepEqual(await getNotes(), [savedNote])
  const target = { kind: 'step', flow: flow.id, step: flow.nodes[0].id }
  const quote = '  节点编号\r\n\t保留   空白  '
  const noteBody = { ...noteScope, text: '核对这里', target, quote }
  for (const target of [null, { kind: 'unknown' }, { kind: 'flow', flow: 'missing' }, { kind: 'step', flow: flow.id, step: 'missing' }]) {
    assert.equal((await post('annotations', { ...noteBody, target })).status, 400)
  }
  assert.equal((await post('annotations', { ...noteBody, quote: '字'.repeat(3001) })).status, 400)
  assert.equal((await post('annotations', { ...noteBody, group: '../annotations' })).status, 400)
  assert.equal((await post('annotations', { ...noteBody, digest: 'stale' })).status, 409)
  const flowTarget = { kind: 'flow', flow: flow.id }
  const maxQuote = '\t'.repeat(3000)
  const flowReply = await post('annotations', { ...noteBody, target: flowTarget, text: '字'.repeat(3000), quote: maxQuote })
  assert.equal(flowReply.status, 201, await flowReply.clone().text())
  const { note: flowNote } = await flowReply.json()
  assert.deepEqual(flowNote.target, flowTarget)
  assert.equal(flowNote.quote, maxQuote)
  const stepReply = await post('annotations', noteBody)
  assert.equal(stepReply.status, 201, await stepReply.clone().text())
  const { note: stepNote } = await stepReply.json()
  assert.deepEqual(stepNote.target, target)
  assert.equal(stepNote.quote, quote)
  assert.deepEqual(JSON.parse(await readFile(noteFile(stepNote.id), 'utf8')), { ...stepNote, module: group.id, graph: digest })
  const mutate = (method, fields, headers = {}) => post('annotations', { ...noteScope, id: stepNote.id, ...fields }, headers, method)
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await mutate(method, {}, { 'x-threadlight-client': 'other' })).status, 403)
    assert.equal((await mutate(method, { digest: 'stale' })).status, 409)
    assert.equal((await mutate(method, { id: '../outside' })).status, 400)
    assert.equal((await mutate(method, { id: randomUUID(), text: '不存在' })).status, 404)
  }
  const edited = await mutate('PATCH', { text: '修改后的批注', target: { kind: 'group' }, quote: '不得覆盖' })
  assert.equal(edited.status, 200, await edited.clone().text())
  const { note: updated } = await edited.json()
  assert.ok(Number.isFinite(Date.parse(updated.updatedAt)))
  assert.deepEqual(updated, { ...stepNote, text: '修改后的批注', updatedAt: updated.updatedAt })
  assert.deepEqual(JSON.parse(await readFile(noteFile(stepNote.id), 'utf8')), { ...updated, module: group.id, graph: digest })
  assert.deepEqual(new Map((await getNotes()).map(note => [note.id, note])), new Map([savedNote, updated, flowNote].map(note => [note.id, note])))

  const notesPage = new URL('?notes=' + reviewWorkspace, launcher)
  assert.equal((await fetch(notesPage)).status, 401)
  const notesHtml = await getPage(notesPage)
  assert.match(notesHtml, /批注箱/)
  assert.deepEqual(JSON.parse(notesHtml.match(/id="notes-context" type="application\/json">(.*?)<\/script>/s)[1]),
    { workspace: reviewWorkspace, digest, project: data.project.name, maxSelection: 100 })
  for (const asset of ['notes.js', 'notes.css']) {
    assert.equal((await fetch(new URL(asset, notesPage), { headers: { cookie } })).status, 200)
  }
  const getAllNotes = async () => {
    const url = new URL('api/annotations?' + new URLSearchParams({ workspace: reviewWorkspace, all: '1' }), notesPage)
    const response = await fetch(url, { headers: { cookie, 'x-threadlight-client': 'review' } })
    assert.equal(response.status, 200, await response.clone().text())
    return new Map((await response.json()).notes.map(note => [note.id, note]))
  }
  const removedGroup = 'removed-module'
  const orphanDirectory = join(control, 'annotations', removedGroup)
  const orphan = { ...updated, id: randomUUID(), module: removedGroup, graph: 'previous-graph' }
  await mkdir(orphanDirectory)
  await writeFile(join(orphanDirectory, orphan.id + '.json'), JSON.stringify(orphan))
  const allNotes = await getAllNotes()
  assert.deepEqual(allNotes.get(savedNote.id), {
    ...savedNote, group: group.id, groupTitle: group.title, submitted: null,
  })
  assert.deepEqual(allNotes.get(flowNote.id), {
    ...flowNote, group: group.id, groupTitle: group.title, flowTitle: flow.title, submitted: null,
  })
  assert.deepEqual(allNotes.get(stepNote.id), {
    ...updated, group: group.id, groupTitle: group.title, flowTitle: flow.title, stepTitle: flow.nodes[0].title, submitted: null,
  })
  assert.equal(allNotes.get(orphan.id).groupTitle, removedGroup)
  assert.equal(allNotes.get(orphan.id).flowTitle, flow.id)
  assert.equal(allNotes.get(orphan.id).stepTitle, flow.nodes[0].id)
  const noteSubmission = { workspace: reviewWorkspace, ids: [savedNote.id, updated.id] }
  const submitNotes = (fields = {}, headers = {}) => post('annotations-submit', { ...noteSubmission, ...fields }, headers)
  assert.equal((await submitNotes({}, { 'sec-fetch-site': 'cross-site' })).status, 403)
  for (const ids of [[], ['../outside'], Array(101).fill(savedNote.id)]) {
    assert.equal((await submitNotes({ ids })).status, 400)
  }
  assert.equal((await submitNotes({ ids: [savedNote.id, randomUUID()] })).status, 404)
  assert.equal((await submitNotes({ digest: 'stale' })).status, 409)
  assert.equal((await submitNotes({ ids: [orphan.id] })).status, 409)
  const submittedNotes = await submitNotes()
  assert.equal(submittedNotes.status, 200, await submittedNotes.clone().text())
  const { submission: noteReceipt } = await submittedNotes.json()
  const noteRetry = await submitNotes({ ids: [...noteSubmission.ids].reverse(), digest })
  assert.deepEqual(await noteRetry.json(), { submission: noteReceipt })
  const noteSessionUrl = new URL('threadlight-fixture-session?id=' + noteReceipt.sessionId, result.base)
  const noteSession = await fetch(noteSessionUrl, { headers: { cookie } })
  assert.equal(noteSession.status, 200)
  const noteEvents = await noteSession.json()
  assert.equal(relative(workspace, noteEvents.cwd), '')
  assert.deepEqual(noteEvents.graphIds, [noteReceipt.sessionId])
  // The conversation header opens Threadlight with the session on screen; the
  // host resolves it to the owning workspace and redirects into that project.
  const sessionEntry = new URL('threadlight/?session=' + noteReceipt.sessionId, result.base)
  const sessionRedirect = await fetch(sessionEntry, { headers: { cookie }, redirect: 'manual' })
  assert.equal(sessionRedirect.status, 303)
  const sessionLocation = new URL(sessionRedirect.headers.get('location'), result.base)
  // Path matters: a relative location would resolve under /threadlight/ again.
  assert.equal(sessionLocation.pathname, '/threadlight/')
  assert.equal(sessionLocation.search, '?workspace=' + encodeURIComponent(reviewWorkspace))
  const sessionNotes = await fetch(new URL('threadlight/?session=' + noteReceipt.sessionId + '&view=notes', result.base),
    { headers: { cookie }, redirect: 'manual' })
  assert.equal(sessionNotes.status, 303)
  const sessionNotesLocation = new URL(sessionNotes.headers.get('location'), result.base)
  assert.equal(sessionNotesLocation.pathname, '/threadlight/')
  assert.equal(sessionNotesLocation.search, '?notes=' + encodeURIComponent(reviewWorkspace))
  const unknownSession = await fetch(new URL('threadlight/?session=' + randomUUID(), result.base),
    { headers: { cookie } })
  assert.equal(unknownSession.status, 200)
  // A missed page navigation renders a readable page, not the JSON API error.
  const missingPage = await fetch(new URL('threadlight/threadlight/', result.base),
    { headers: { cookie, accept: 'text/html' } })
  assert.equal(missingPage.status, 404)
  assert.match(missingPage.headers.get('content-type'), /text\/html/)
  assert.equal(noteEvents.prompts.length, 1)
  const queuedNotes = JSON.stringify(noteEvents.prompts[0])
  assert.match(queuedNotes, /用户只提交了批注，没有修改流程图/)
  assert.ok(queuedNotes.includes(savedNote.text))
  assert.ok(queuedNotes.includes(updated.text))
  assert.equal(noteEvents.prompts[0].source.rpcId, noteReceipt.requestId)
  const refreshedNotes = await getAllNotes()
  for (const id of noteSubmission.ids) assert.deepEqual(refreshedNotes.get(id).submitted,
    { sessionId: noteReceipt.sessionId, submittedAt: noteReceipt.submittedAt })
  assert.equal(refreshedNotes.get(flowNote.id).submitted, null)
  assert.deepEqual(JSON.parse(await readFile(noteFile(updated.id), 'utf8')), { ...updated, module: group.id, graph: digest })

  assert.deepEqual(await (await mutate('DELETE')).json(), { deleted: true })
  await assert.rejects(readFile(noteFile(stepNote.id)), { code: 'ENOENT' })
  assert.equal((await mutate('PATCH', { text: '不得重建' })).status, 404)
  assert.equal((await mutate('DELETE')).status, 404)
  assert.equal((await getNotes()).length, 2)
  assert.equal((await post('explain', { ...selection, digest: 'stale', mode: 'meaning' })).status, 409)
  assert.equal((await post('explain', { ...selection, text: 'invalid selection', mode: 'meaning' })).status, 400)
  for (const [mode, answer] of [['meaning', 'Plain explanation'], ['deeper', 'Further explanation']]) {
    const explanation = await post('explain', { ...selection, mode, step: flow.nodes[0].id })
    assert.equal(explanation.status, 200)
    assert.deepEqual(await explanation.json(), { answer })
  }

  const emptyPage = new URL('threadlight/?workspace=' + result.empty, result.base)
  const emptyHtml = await (await fetch(emptyPage, { headers: { cookie } })).text()
  const draftConfig = JSON.parse(emptyHtml.match(/id="draft-context">(.*?)<\/script>/s)[1])
  assert.deepEqual(draftConfig, { workspace: result.empty, project: 'Empty fixture', hasGraph: false, canSubmit: true, seed: null })
  for (const asset of ['drafts.js', 'drafts.css', 'draft-diagram.js', 'maxgraph-LICENSE.txt']) {
    assert.equal((await fetch(new URL(asset, emptyPage), { headers: { cookie } })).status, 200)
  }
  const diagramAsset = new URL('draft-diagram.js', emptyPage)
  assert.equal((await fetch(diagramAsset)).status, 401)
  assert.match(await (await fetch(diagramAsset, { headers: { cookie } })).text(), /Includes maxGraph under Apache-2\.0/)
  const getDrafts = async fields => {
    const url = new URL('threadlight/api/drafts?' + new URLSearchParams(fields), result.base)
    const reply = await fetch(url, { headers: { cookie } })
    assert.equal(reply.status, 200)
    return reply.json()
  }
  assert.deepEqual(await getDrafts({ workspace: result.empty }), { drafts: [] })
  const id = randomUUID()
  const plan = {
    title: '上传文件', summary: '', acceptance: '',
    nodes: [
      { id: 'upload', title: '', summary: '' },
      { id: 'retry', title: '显示重试', summary: '' },
    ],
    edges: [{ id: 'offline', from: 'upload', to: 'retry', kind: 'branch', label: '上传期间断网',
      waypoints: [{ x: 240, y: 105 }] }],
    layout: [{ step: 'upload', x: 0, y: 0 }, { step: 'retry', x: 150, y: 180 }],
    notes: [
      { id: 'retain-file', step: null, edge: 'offline', selected: true, text: '保留已选文件和预览内容。' },
      { id: 'private-draft', step: 'retry', edge: null, selected: false, text: '未选中的备忘不进入任务。' },
    ],
  }
  const packet = { workspace: result.empty, id, version: 0, plan }
  assert.equal((await post('drafts', packet, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await post('drafts', { ...packet, id: '../workspace' })).status, 400)
  const firstDraft = await post('drafts', packet)
  assert.equal(firstDraft.status, 200, await firstDraft.clone().text())
  assert.equal((await firstDraft.json()).draft.version, 1)
  await assert.rejects(readFile(join(emptyWorkspace, '.threadlight/graph.json')), { code: 'ENOENT' })
  const incomplete = { ...plan, title: '' }
  assert.equal((await post('drafts', { ...packet, version: 1, plan: incomplete })).status, 200)
  const invalid = await post('draft-submit', { workspace: result.empty, id, version: 2 })
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).error, /名称必填/)
  assert.equal((await post('drafts', { ...packet, version: 1 })).status, 409)
  assert.equal((await post('drafts', { ...packet, version: 2 })).status, 200)
  assert.equal((await getDrafts({ workspace: result.empty })).drafts[0].version, 3)
  const submitPacket = { workspace: result.empty, id, version: 3 }
  const replies = await Promise.all([post('draft-submit', submitPacket), post('draft-submit', submitPacket)])
  for (const reply of replies) assert.equal(reply.status, 200, await reply.clone().text())
  const [{ submission }, retry] = await Promise.all(replies.map(reply => reply.json()))
  assert.deepEqual(retry, { submission })
  const reopened = (await getDrafts({ workspace: result.empty, id })).draft
  assert.deepEqual(reopened.plan, plan)
  assert.deepEqual(reopened.submission, submission)
  await rm(join(emptyWorkspace, '.threadlight/drafts', id, 'submitted-3.json'))
  const recovered = await post('draft-submit', submitPacket)
  assert.equal(recovered.status, 200, await recovered.clone().text())
  assert.equal((await recovered.json()).submission.sessionId, submission.sessionId)
  const sessionUrl = new URL('threadlight-fixture-session?id=' + submission.sessionId, result.base)
  const observedReply = await fetch(sessionUrl, { headers: { cookie } })
  assert.equal(observedReply.status, 200)
  const observed = await observedReply.json()
  assert.equal(relative(emptyWorkspace, observed.cwd), '')
  assert.deepEqual(observed.ids, [submission.sessionId])
  assert.equal(observed.prompts.length, 1)
  const details = JSON.stringify(observed.prompts[0])
  assert.ok(details.includes(JSON.stringify(join(emptyWorkspace, '.threadlight', 'implementation', id, '3.json')).slice(1, -1)))
  assert.match(details, /只记录真正执行过的验证/)
  assert.match(details, /上传期间断网/)
  assert.match(details, /用户未填写/)
  assert.match(details, /未命名步骤/)
  assert.match(details, /保留已选文件和预览内容。/)
  assert.doesNotMatch(details, /未选中的备忘/)
  assert.doesNotMatch(details, /waypoints|layout/)

  const feedbackId = randomUUID()
  const feedbackPlan = { title: '上传体验反馈', summary: '', acceptance: '', nodes: [], edges: [], notes: [
    { id: 'feedback', step: null, edge: null, selected: true, text: '断网后请保留原文件和预览。' },
  ] }
  assert.equal((await post('drafts', { workspace: result.empty, id: feedbackId, version: 0, plan: feedbackPlan })).status, 200)
  const feedbackReply = await post('draft-submit', { workspace: result.empty, id: feedbackId, version: 1 })
  assert.equal(feedbackReply.status, 200, await feedbackReply.clone().text())
  const { submission: feedbackSubmission } = await feedbackReply.json()
  const feedbackSession = await fetch(new URL('threadlight-fixture-session?id=' + feedbackSubmission.sessionId, result.base), { headers: { cookie } })
  const feedbackDetails = JSON.stringify((await feedbackSession.json()).prompts)
  assert.match(feedbackDetails, /用户仅提交了批注，未提供完整流程/)
  assert.match(feedbackDetails, /断网后请保留原文件和预览。/)
  assert.doesNotMatch(feedbackDetails, /实现报告/)
  assert.deepEqual((await getDrafts({ workspace: result.empty, id: feedbackId })).draft.plan, feedbackPlan)

  const copyUrl = new URL('threadlight/?' + new URLSearchParams({ workspace: result.ws, drafts: '1', group: group.id, flow: flow.id }), result.base)
  const copyHtml = await (await fetch(copyUrl, { headers: { cookie } })).text()
  const copy = JSON.parse(copyHtml.match(/id="draft-context">(.*?)<\/script>/s)[1]).seed
  assert.equal(copy.plan.nodes[0].id, flow.nodes[0].id)
  assert.equal(copy.base.digest, data.review.digest)
  const copied = await post('drafts', { workspace: result.ws, id: randomUUID(), version: 0, ...copy })
  assert.equal(copied.status, 200, await copied.clone().text())
  assert.equal((await copied.json()).draft.base.flow, flow.id)
  assert.equal((await post('reset', { workspace: result.ws }, { 'x-threadlight-client': 'other' })).status, 403)
  assert.equal((await post('reset', {})).status, 404)
  await writeFile(join(control, 'refresh.lock'), String(process.pid))
  assert.equal((await post('reset', { workspace: result.ws })).status, 409)
  assert.equal(await readFile(join(control, 'refresh.lock'), 'utf8'), String(process.pid))
  await rm(join(control, 'refresh.lock'))
  const reset = await post('reset', { workspace: result.ws })
  assert.equal(reset.status, 200, await reset.clone().text())
  const { archived, moved, next } = await reset.json()
  assert.match(archived, /^\.threadlight\/archive\/\d{8}T\d{6}Z$/)
  assert.deepEqual(moved, ['state.json', 'viewer.html', 'revisions'])
  assert.equal(next, 'refresh')
  assert.equal(JSON.parse(await readFile(join(workspace, archived, 'state.json'), 'utf8')).revision, published.revision)
  assert.equal((await stat(join(workspace, archived, 'revisions', published.revision))).isDirectory(), true)
  assert.equal(await readFile(join(control, 'graph.json'), 'utf8'), example)
  assert.match(await readFile(join(control, 'annotations', group.id, savedNote.id + '.json'), 'utf8'), /safe note/)
  // After archiving, that workspace opens as a draft again; the graph-task
  // entry points stay available because a draft can still be regenerated.
  const afterReset = await getPage(workspaceList)
  assert.ok(afterReset.includes('data-workspace="' + result.ws + '"'), 'graph actions missing after reset')
  assert.match(afterReset, /打开草稿/)
  const version = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8')).version
  t.diagnostic('DSH ' + version + ', web profile, filesystem sandbox mode ' + (result.mode ?? '(none)'))
})
