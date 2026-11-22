import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { MAX_GRAPH_BYTES, parseGraph } from './graph.mjs'

const execute = promisify(execFile)
const javascript = /\.(?:[mc]?js|jsx)$/i
const keyOf = ({ path, line }) => path + '\0' + line

function sources(graph) {
  return (graph?.groups ?? []).flatMap(group => group.flows.flatMap(flow => flow.nodes.flatMap(node => node.sources)))
}

export async function openCodeIndexer(path) {
  if (!path) return null
  const executable = resolve(path)
  const id = createHash('sha256').update(await readFile(executable)).digest('hex')
  return { executable, id }
}

async function indexLines(snapshot, requested, indexer, signal) {
  const matches = new Map()
  if (!requested.size) return matches
  const job = await mkdtemp(join(tmpdir(), 'threadlight-index-'))
  try {
    const input = join(job, 'input.json')
    const files = [...requested].map(([path, lines]) => ({
      path, text: snapshot.files.get(path).toString('utf8').replace(/\r\n?/g, '\n'), lines: [...lines],
    }))
    await writeFile(input, JSON.stringify({ schemaVersion: 1, files }), { signal })
    const { stdout } = await execute(indexer.executable, [input], {
      cwd: job, signal, timeout: 30000, windowsHide: true, maxBuffer: MAX_GRAPH_BYTES,
    })
    const report = JSON.parse(stdout)
    const remaining = new Set(requested.keys())
    if (report?.schemaVersion !== 1 || !Array.isArray(report.files)) throw new Error('Invalid indexer report')
    for (const { path, matches: entries } of report.files) {
      if (!remaining.delete(path) || !Array.isArray(entries)) throw new Error('Invalid indexer file')
      for (const { line, name, kind, startLine, endLine } of entries) {
        const key = keyOf({ path, line })
        if (!requested.get(path).has(line) || matches.has(key) || endLine > snapshot.metadata[path].lines) {
          throw new Error('Invalid indexer source range')
        }
        matches.set(key, { name, kind, startLine, endLine })
      }
    }
    if (remaining.size) throw new Error('Incomplete indexer report')
    return matches
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('Rust code index failed: ' + (error.code ?? error.message), { cause: error })
  } finally {
    await rm(job, { recursive: true, force: true })
  }
}

export async function enrichEvidence(graph, snapshot, { indexer, previous, previousFiles, signal } = {}) {
  const references = sources(graph)
  const known = new Map()
  for (const old of sources(previous)) {
    if (old.line && (old.preview || old.symbol) && previousFiles?.[old.path]?.sha256 === snapshot.metadata[old.path]?.sha256) {
      known.set(keyOf(old), old.symbol)
    }
  }
  const requested = new Map()
  for (const source of references) {
    if (indexer && source.line && source.line <= snapshot.metadata[source.path]?.lines &&
      javascript.test(source.path) && !known.has(keyOf(source))) {
      if (!requested.has(source.path)) requested.set(source.path, new Set())
      requested.get(source.path).add(source.line)
    }
  }
  const indexed = requested.size ? await indexLines(snapshot, requested, indexer, signal) : new Map()
  for (const source of references) {
    delete source.preview
    delete source.symbol
  }
  const size = Buffer.byteLength(JSON.stringify(graph, null, 2)) + 1
  let budget = Math.min(512 * 1024, MAX_GRAPH_BYTES - size)
  const linesByPath = new Map()
  for (const source of references) {
    if (budget <= 0 || source.status || (!source.line && source.kind !== 'documentation')) continue
    if (!linesByPath.has(source.path)) {
      linesByPath.set(source.path, snapshot.files.get(source.path)?.toString('utf8').split(/\r\n|\r|\n/))
    }
    const lines = linesByPath.get(source.path)
    if (!lines) continue
    const line = source.line ?? 1
    const startLine = source.kind === 'documentation' ? line : Math.max(1, line - 2)
    const text = lines.slice(startLine - 1, source.kind === 'documentation' ? line + 4 : line + 2)
      .map(value => value.length > 200 ? value.slice(0, 199) + '…' : value).join('\n')
    const preview = text.trim() ? { startLine, text } : undefined
    const symbol = indexer ? known.get(keyOf(source)) ?? indexed.get(keyOf(source)) : undefined
    const addition = Buffer.byteLength(JSON.stringify({ preview, symbol }, null, 2)) + 250
    if (addition > budget) continue
    if (preview) source.preview = preview
    if (symbol) source.symbol = symbol
    budget -= addition
  }
  return parseGraph(JSON.stringify(graph, null, 2) + '\n')
}
