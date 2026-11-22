import { createHash } from 'node:crypto'

function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function contextHash(lines, index) {
  return hash(JSON.stringify([lines[index - 1] ?? null, lines[index], lines[index + 1] ?? null]))
}

function recordMatch(matches, key, index) {
  matches.set(key, matches.has(key) ? -1 : index)
}

function previousSources(graph) {
  const index = new Map()
  for (const group of graph?.groups ?? []) {
    for (const flow of group.flows) {
      for (const node of flow.nodes) index.set(group.id + '/' + flow.id + '/' + node.id, node.sources)
    }
  }
  return index
}

export function anchorSources(graph, previous, snapshot, previousFiles) {
  const byNode = previousSources(previous)
  const byPath = new Map()
  const evidence = { relocated: 0, needsReview: 0 }
  for (const group of graph.groups) {
    for (const flow of group.flows) {
      for (const node of flow.nodes) {
        const oldSources = byNode.get(group.id + '/' + flow.id + '/' + node.id) ?? []
        for (const source of node.sources) {
          const entry = snapshot.metadata[source.path]
          const prior = oldSources.find(old => old.path === source.path && old.kind === source.kind && old.line === source.line)
          const excerpt = source.lineText
          delete source.lineText
          delete source.anchor
          delete source.status
          delete source.preview
          delete source.symbol
          const fileChanged = previousFiles?.[source.path]?.sha256 !== entry?.sha256
          const canRelocate = prior && excerpt === undefined && fileChanged
          if (!snapshot.files.has(source.path) || (source.line > entry.lines && !canRelocate)) {
            throw new Error('Source reference is missing or out of bounds: ' + source.path)
          }
          if (source.line === undefined) {
            if (excerpt !== undefined) throw new Error('Source lineText requires a line number: ' + source.path)
            if (prior?.status === 'needs-review') {
              source.status = 'needs-review'
              evidence.needsReview++
            }
            continue
          }
          if (!fileChanged && prior?.anchor && excerpt === undefined) {
            source.anchor = prior.anchor
            continue
          }
          if (!byPath.has(source.path)) byPath.set(source.path, [])
          byPath.get(source.path).push({ source, prior, excerpt })
        }
      }
    }
  }

  for (const [path, records] of byPath) {
    const fileChanged = previousFiles?.[path]?.sha256 !== snapshot.metadata[path].sha256
    const lines = snapshot.files.get(path).toString('utf8').split(/\r\n|\r|\n/)
    const wanted = new Set()
    const wantedContexts = new Set()
    const counts = new Map()
    for (const { source, prior, excerpt } of records) {
      if (source.line <= lines.length) {
        const index = source.line - 1
        counts.set(lines[index], 0)
        wantedContexts.add(contextHash(lines, index))
      }
      if (fileChanged && prior?.anchor && excerpt === undefined) {
        wanted.add(prior.anchor.lineHash)
        wantedContexts.add(prior.anchor.contextHash)
      }
    }

    const lineMatches = new Map()
    const contextMatches = new Map()
    const hashCache = new Map()
    for (const [index, line] of lines.entries()) {
      const currentLine = counts.has(line)
      if (currentLine) counts.set(line, counts.get(line) + 1)
      let oldLine = false
      if (wanted.size) {
        let digest = hashCache.get(line)
        if (digest === undefined) {
          digest = hash(line)
          if (hashCache.size < 1024) hashCache.set(line, digest)
        }
        oldLine = wanted.has(digest)
        if (oldLine) recordMatch(lineMatches, digest, index)
      }
      if (currentLine || oldLine) {
        const context = contextHash(lines, index)
        if (wantedContexts.has(context)) recordMatch(contextMatches, context, index)
      }
    }

    for (const { source, prior, excerpt } of records) {
      if (excerpt !== undefined && excerpt !== lines[source.line - 1]) {
        throw new Error('Source lineText does not match the snapshot: ' + path + ':' + source.line)
      }
      if (prior?.line && fileChanged && excerpt === undefined) {
        const anchor = prior.anchor
        const sameContext = anchor?.contextUnique ? contextMatches.get(anchor.contextHash) : undefined
        const sameLine = anchor?.unique ? lineMatches.get(anchor.lineHash) : undefined
        const position = sameContext >= 0 ? sameContext : sameLine
        if (position >= 0) {
          if (position + 1 !== source.line) evidence.relocated++
          source.line = position + 1
        } else {
          delete source.line
          source.status = 'needs-review'
          evidence.needsReview++
          continue
        }
      }
      const index = source.line - 1
      const line = lines[index]
      const lineHash = hash(line)
      const context = contextHash(lines, index)
      const unique = counts.has(line) ? counts.get(line) === 1 : lineMatches.get(lineHash) === index
      source.anchor = {
        lineHash, contextHash: context, unique,
        contextUnique: unique || contextMatches.get(context) === index,
      }
    }
  }
  return evidence
}
