#!/usr/bin/env node
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { MAX_GRAPH_BYTES, parseGraph } from '../lib/graph.mjs'
import { createLocalStore, readTextFile } from '../lib/local-store.mjs'
import { exportObsidian } from '../lib/obsidian.mjs'
import { publishReader } from '../lib/reader.mjs'
import { refreshDocumentation } from '../lib/refresh.mjs'
import { captureWorkspace, repositoryRoot } from '../lib/git-workspace.mjs'
import { enrichEvidence, openCodeIndexer } from '../lib/implementation-evidence.mjs'
import { ingestImplementationReports } from '../lib/implementation-report.mjs'
import { anchorSources } from '../lib/source-anchors.mjs'

const help = [
  'Usage:',
  '  dsh-threadlight validate <graph.json>',
  '  dsh-threadlight view <graph.json> <output-parent> [--source repository [--code-index executable]]',
  '  dsh-threadlight refresh [repository] [--patch path] [--dsh-cli path] [--code-index executable]',
  '  dsh-threadlight report [repository] [--code-index executable]',
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

async function run() {
  if (!command || command === '--help' || command === '-h') {
    console.log(help)
    return
  }
  if (command === 'refresh' || command === 'watch') return updateCommand()
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
  const validateOnly = command === 'validate' && input && !output
  const shouldExport = command === 'export' && input && output && !rest.length
  if (!validateOnly && !shouldExport) throw new Error(help)
  const graph = parseGraph(await readTextFile(input, MAX_GRAPH_BYTES))
  if (validateOnly) {
    const flows = graph.groups.flatMap(group => group.flows)
    console.log(JSON.stringify({ groups: graph.groups.length, flows: flows.length,
      nodes: flows.reduce((n, flow) => n + flow.nodes.length, 0), areas: graph.project.areas?.length ?? 0 }))
    return
  }
  const store = await createLocalStore(output)
  const result = await exportObsidian(graph, store, { output: '' })
  console.log(JSON.stringify({ ...result, directory: resolve(output, result.directory), overview: resolve(output, result.overview) }, null, 2))
}

run().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
