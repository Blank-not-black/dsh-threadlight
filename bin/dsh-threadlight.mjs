#!/usr/bin/env node
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { inspectGraph, MAX_GRAPH_BYTES, parseGraph } from '../lib/graph.mjs'
import { diffGraphs, renderChangelog } from '../lib/graph-changelog.mjs'
import { createLocalStore, readTextFile } from '../lib/local-store.mjs'
import { exportObsidian } from '../lib/obsidian.mjs'
import { publishReader } from '../lib/reader.mjs'
import { lock, readHistory, refreshDocumentation, replace, revisionPattern, safeDirectory } from '../lib/refresh.mjs'
import { resetDocumentation } from '../lib/reset.mjs'
import { captureWorkspace, repositoryRoot } from '../lib/git-workspace.mjs'
import { enrichEvidence, openCodeIndexer } from '../lib/implementation-evidence.mjs'
import { ingestImplementationReports } from '../lib/implementation-report.mjs'
import { anchorSources } from '../lib/source-anchors.mjs'

const help = [
  'Usage:',
  '  dsh-threadlight validate <graph.json> [--json]',
  '  dsh-threadlight view <graph.json> <output-parent> [--source repository [--code-index executable]]',
  '  dsh-threadlight refresh [repository] [--patch path] [--dsh-cli path] [--code-index executable]',
  '  dsh-threadlight report [repository] [--code-index executable]',
  '  dsh-threadlight reset [repository]',
  '  dsh-threadlight changelog [repository] [--limit N] [--from revision --to revision] [--format md|json]',
  '  dsh-threadlight watch [repository] [--patch path] [--dsh-cli path] [--code-index executable] [--interval seconds]',
  '  dsh-threadlight export <graph.json> <output-parent>  (Obsidian)',
].join('\n')
const [command, ...args] = process.argv.slice(2)

async function updateCommand() {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    patch: { type: 'string' }, 'dsh-cli': { type: 'string' }, interval: { type: 'string' }, 'code-index': { type: 'string' },
  } })
  if (positionals.length > 1 || command === 'refresh' && values.interval !== undefined) throw new Error(help)
  const interval = Number(values.interval ?? 15)
  if (command === 'watch' && (!Number.isFinite(interval) || interval < 3 || interval > 3600)) {
    throw new Error('--interval must be between 3 and 3600 seconds')
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let failedSnapshot
  try {
    do {
      try {
        const result = await refreshDocumentation(positionals[0] ?? '.', {
          patch: values.patch, dshCli: values['dsh-cli'], codeIndex: values['code-index'], signal: controller.signal, failedSnapshot,
        })
        if (command === 'refresh' || ['updated', 'reviewed', 'rendered'].includes(result.status)) console.log(JSON.stringify(result))
        if (result.status === 'updated' || result.status === 'reviewed') failedSnapshot = undefined
      } catch (error) {
        if (controller.signal.aborted) break
        if (command === 'refresh') throw error
        console.error(error.message)
        failedSnapshot = error.snapshotId
      }
      if (command === 'watch') await delay(interval * 1000, undefined, { signal: controller.signal })
    } while (command === 'watch' && !controller.signal.aborted)
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

async function localEntry(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function changelogEntries(control, { from, to, limit }) {
  const revisions = join(control, 'revisions')
  for (const folder of [control, revisions]) {
    const info = await localEntry(folder)
    if (info && !info.isDirectory()) throw new Error('Threadlight output must be a real directory')
  }
  async function revisionInfo(revision) {
    const directory = join(revisions, revision)
    const info = await localEntry(directory)
    if (!info?.isDirectory() || !(await localEntry(join(directory, 'graph.json')))?.isFile()) return null
    return { revision, at: info.mtime.toISOString() }
  }
  const history = await readHistory(control)
  let orderSource = 'history'
  let versions = history
  if (from !== undefined) {
    orderSource = 'explicit'
    versions = []
    for (const revision of [from, to]) {
      const info = await revisionInfo(revision)
      if (!info) throw new Error('Threadlight revision does not exist: ' + revision)
      versions.push(history.find(entry => entry.revision === revision) ?? info)
    }
  } else if (!history.length) {
    orderSource = 'mtime'
    const names = (await readdir(revisions).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })).filter(name => revisionPattern.test(name))
    versions = (await Promise.all(names.map(revisionInfo))).filter(Boolean)
      .sort((a, b) => a.at.localeCompare(b.at) || a.revision.localeCompare(b.revision))
  }

  const entries = []
  const graph = async revision => {
    if (!await revisionInfo(revision)) throw new Error('Threadlight revision does not exist: ' + revision)
    return parseGraph(await readTextFile(join(revisions, revision, 'graph.json'), MAX_GRAPH_BYTES))
  }
  let previous, last
  for (const { revision, at } of versions.slice(-(limit + 1))) {
    const current = await graph(revision)
    if (last) entries.push({ from: last, to: revision, at, orderSource, changes: diffGraphs(previous, current) })
    previous = current
    last = revision
  }
  return { entries, orderSource }
}

async function changelogCommand() {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    limit: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, format: { type: 'string' },
  } })
  if (positionals.length > 1) throw new Error(help)
  const { from, to, format = 'md' } = values
  const limit = Number(values.limit ?? 5)
  if (!/^\d+$/.test(values.limit ?? '5') || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer')
  }
  if ((from === undefined) !== (to === undefined)) throw new Error('--from and --to must be provided together')
  if (from !== undefined && ![from, to].every(revision => revisionPattern.test(revision))) {
    throw new Error('Invalid Threadlight revision')
  }
  if (format !== 'md' && format !== 'json') throw new Error('--format must be md or json')
  const control = join(await repositoryRoot(positionals[0] ?? '.'), '.threadlight')
  if (format === 'json') {
    const { entries, orderSource } = await changelogEntries(control, { from, to, limit })
    if (orderSource === 'mtime' && !entries.length) console.error('历史记录不可用，版本顺序来自修订目录的文件修改时间。')
    console.log(JSON.stringify(entries, null, 2))
    return
  }
  await safeDirectory(control)
  const release = await lock(control)
  try {
    const { entries, orderSource } = await changelogEntries(control, { from, to, limit })
    const markdown = renderChangelog(entries, { limit, orderSource })
    await replace(join(control, 'changes.md'), markdown)
    process.stdout.write(markdown)
  } finally {
    await release()
  }
}

function printValidation(result) {
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}

function printValidationFailure(code, message) {
  printValidation({ ok: false, error: { code, path: '$', message: 'Invalid graph: ' + message } })
}

async function validateCommand() {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } })
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) throw new Error('expected one graph file')
  } catch (error) {
    const separator = args.indexOf('--')
    if (!args.slice(0, separator === -1 ? args.length : separator).includes('--json')) throw new Error(help)
    return printValidationFailure('graph/arguments', error.message)
  }
  const { values, positionals: [input] } = parsed
  let raw
  try { raw = await readTextFile(input, MAX_GRAPH_BYTES) } catch (error) {
    if (!values.json) throw error
    if (error.code === 'ERR_FILE_SIZE_LIMIT') return printValidationFailure('graph/input-size', error.message)
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return printValidationFailure('graph/json', 'expected UTF-8 JSON')
    return printValidationFailure('graph/input-read', error.message)
  }
  const result = inspectGraph(raw)
  if (values.json) return printValidation(result)
  if (!result.ok) throw new Error(result.error.message)
  console.log(JSON.stringify(result.summary))
}

async function run() {
  if (!command || command === '--help' || command === '-h') {
    console.log(help)
    return
  }
  if (command === 'refresh' || command === 'watch') return updateCommand()
  if (command === 'changelog') return changelogCommand()
  if (command === 'validate') return validateCommand()
  if (command === 'reset') {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    if (positionals.length > 1) throw new Error(help)
    const result = await resetDocumentation(await repositoryRoot(positionals[0] ?? '.'))
    if (!result.archived) console.error('无需重置。')
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'report') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'code-index': { type: 'string' } } })
    if (positionals.length > 1) throw new Error(help)
    const result = await ingestImplementationReports(positionals[0] ?? '.', { codeIndex: values['code-index'] })
    console.log(JSON.stringify(result, null, 2))
    if (result.rejected.length) process.exitCode = 1
    return
  }
  if (command === 'view') {
    const { values, positionals: [input, output, ...rest] } = parseArgs({ args, allowPositionals: true, options: {
      source: { type: 'string' }, 'code-index': { type: 'string' },
    } })
    if (!input || !output || rest.length || (values['code-index'] && !values.source)) throw new Error(help)
    let graph = parseGraph(await readTextFile(input, MAX_GRAPH_BYTES))
    if (values.source) {
      const snapshot = await captureWorkspace(await repositoryRoot(values.source))
      if (graph.snapshot?.id && graph.snapshot.id !== snapshot.id) throw new Error('The source directory does not match the graph snapshot')
      if (!graph.snapshot?.id) {
        anchorSources(graph, null, snapshot)
        graph.snapshot = { scope: 'working-tree', baseCommit: snapshot.head, id: snapshot.id }
      }
      graph = await enrichEvidence(graph, snapshot, { indexer: await openCodeIndexer(values['code-index']) })
    }
    console.log(JSON.stringify(await publishReader(graph, output), null, 2))
    return
  }
  const [input, output, ...rest] = args
  if (command !== 'export' || !input || !output || rest.length) throw new Error(help)
  const graph = parseGraph(await readTextFile(input, MAX_GRAPH_BYTES))
  const store = await createLocalStore(output)
  const result = await exportObsidian(graph, store, { output: '' })
  console.log(JSON.stringify({ ...result, directory: resolve(output, result.directory), overview: resolve(output, result.overview) }, null, 2))
}

run().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
