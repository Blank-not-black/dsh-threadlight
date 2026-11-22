import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MAX_GRAPH_BYTES } from './graph.mjs'
import { readTextFile } from './local-store.mjs'

const skillPath = new URL('../skills/threadlight-document-project/SKILL.md', import.meta.url)
const pluginPath = fileURLToPath(new URL('../index.mjs', import.meta.url)).replaceAll('\\', '/')
const restrictedTools = ['tool-bash', 'tool-pwsh', 'tool-web', 'tool-subagent', 'tool-subagent-fork']

async function locateDsh(explicit) {
  if (explicit) {
    await access(explicit)
    return resolve(explicit)
  }
  const candidates = []
  if (process.env.THREADLIGHT_DSH_CLI_ROOT) candidates.push(join(process.env.THREADLIGHT_DSH_CLI_ROOT, 'lib/bin.js'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    candidates.push(join(directory, '../lib/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  }
  for (const candidate of candidates) {
    try { await access(candidate); return resolve(candidate) } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  throw new Error('DSH CLI not found. Supply --dsh-cli pointing to its lib/bin.js')
}

async function executeDsh(cli, workspace, home, overlays, task, signal) {
  const env = { ...process.env, DSH_HOME: join(home, '.dsh'), HOME: home, USERPROFILE: home,
    DSH_PERMISSION_MODE: 'workspace-write' }
  delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, [cli, '--profile', 'headless',
    ...overlays.flatMap(path => ['--patch', path]), '--json', '-'], {
    cwd: workspace, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  let failure
  const exited = new Promise(completed => {
    child.on('error', error => { failure = error })
    child.once('close', completed)
  })
  child.stdin.end(task, 'utf8')
  let sessionId, reason
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'status' && event.reason) reason = event.reason
  }
  const code = await exited
  if (failure) throw failure
  if (code !== 0 || !sessionId || reason?.kind !== 'completed') {
    const diagnostic = reason?.error?.code
    throw new Error('Independent DSH session did not complete' +
      (typeof diagnostic === 'string' && /^[A-Z0-9_-]{1,80}$/.test(diagnostic) ? ' (' + diagnostic + ')' : ''))
  }
  return sessionId
}

export async function runDocumentSession({ control, snapshot, input, previous, patch, dshCli, signal }) {
  signal?.throwIfAborted()
  const cli = await locateDsh(dshCli)
  const job = await mkdtemp(join(control, 'job-'))
  try {
    const workspace = join(job, 'workspace')
    const home = join(job, 'home')
    const taskFiles = join(workspace, '.threadlight')
    await mkdir(home)
    await mkdir(taskFiles, { recursive: true })
    for (const [path, bytes] of snapshot.files) {
      signal?.throwIfAborted()
      const target = join(workspace, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    const overlay = join(job, 'threadlight.patch.json')
    await writeFile(overlay, JSON.stringify([
      ...restrictedTools.map(id => ({ id, disabled: true })),
      { insert: [{ id: 'dsh-threadlight', name: pluginPath }] },
    ]))
    await writeFile(join(taskFiles, 'input.json'), JSON.stringify(input, null, 2))
    if (previous) {
      const modelGraph = JSON.stringify(previous, (key, value) => ['anchor', 'preview', 'symbol'].includes(key) ? undefined : value, 2)
      await writeFile(join(taskFiles, 'previous.json'), modelGraph)
    }
    const skill = (await readFile(skillPath, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    const task = '请执行以下 Threadlight 项目文档任务。输入和输出路径见技能。任务目录是独立源码副本。\n\n' + skill
    const sessionId = await executeDsh(cli, workspace, home, [...(patch ? [resolve(patch)] : []), overlay], task, signal)
    let update
    try {
      const output = join(taskFiles, 'update.json')
      if (!(await lstat(taskFiles)).isDirectory() || !(await lstat(output)).isFile()) {
        throw new Error('Expected an output file inside the job')
      }
      update = JSON.parse(await readTextFile(output, MAX_GRAPH_BYTES, signal))
    } catch {
      signal?.throwIfAborted()
      throw new Error('DSH completed without a readable .threadlight/update.json')
    }
    return { update, sessionId }
  } finally {
    await rm(job, { recursive: true, force: true })
  }
}
