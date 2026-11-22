import { createHash } from 'node:crypto'
import { groupSections, layoutColumns } from './graph.mjs'
import { stepState, stepStateLabels } from './step-state.mjs'

const exportFormatVersion = 5
const manifestName = 'threadlight-export.json'
const overviewNote = '项目总览.md'
const workflowLabels = { uses: '使用', continues: '接着看' }
const sourceLabels = { source: '实现', test: '测试', documentation: '文档', workflow: '构建' }
const reservedName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i

function json(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

function plain(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\\x60*_[\]#|~]/g, '\\$&').replace(/\r?\n|\r/g, ' ')
}

function brief(value, limit) {
  const compact = value.trim().replace(/\s+/g, ' ')
  const characters = [...compact]
  return characters.length <= limit ? compact : characters.slice(0, limit - 1).join('').trimEnd() + '…'
}

function noteNames(entries) {
  const names = new Map()
  const used = new Set()
  for (const item of entries) {
    const clean = item.title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f#^%[\]]/g, ' ')
      .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '')
    let base = [...clean].slice(0, 40).join('').replace(/[. ]+$/g, '') || item.id
    if (reservedName.test(base)) base = '_' + base
    let name = base
    for (let attempt = 1; used.has(name.toLowerCase()); attempt++) {
      name = base + ' · ' + item.id + (attempt > 1 ? ' ' + attempt : '')
    }
    used.add(name.toLowerCase())
    names.set(item.id, name)
  }
  return names
}

function wiki(path, title) {
  const alias = title.replaceAll('|', '｜').replaceAll('[', '［').replaceAll(']', '］')
  return '[[' + path + '|' + plain(alias) + ']]'
}

function noteStart(id, kind, title) {
  return [
    '---',
    'threadlight_id: ' + JSON.stringify(id),
    'threadlight_kind: ' + JSON.stringify(kind),
    '---', '', '# ' + plain(title),
  ]
}

function reference(source) {
  const location = source.path + (source.line === undefined ? '' : ':' + source.line)
  const runs = location.match(/\x60+/g) || []
  const fence = String.fromCharCode(96).repeat(1 + Math.max(0, ...runs.map(run => run.length)))
  return '- ' + sourceLabels[source.kind] + ' · ' + fence + ' ' + location + ' ' + fence
    + (source.status === 'needs-review' ? ' · 证据待复核' : '')
}

function card(id, column, row, count, content) {
  return { id, x: 450 * column, y: 242 * row - 121 * (count - 1), width: 330, height: 188, ...content }
}

function canvasEdge(index, from, to, label) {
  let sides = ['right', 'left']
  if (from.x > to.x) sides = ['left', 'right']
  if (from.x === to.x) sides = from.y < to.y ? ['bottom', 'top'] : ['top', 'bottom']
  return {
    id: 'edge-' + (index + 1), fromNode: from.id, toNode: to.id,
    fromSide: sides[0], toSide: sides[1], toEnd: 'arrow',
    ...(label ? { label } : {}),
  }
}

function evidence(node) {
  const references = [...new Set(node.sources.map(reference))]
  const details = node.details.map(detail => '- ' + plain(detail))
  if (references.length) details.push(...(details.length ? ['', '**依据**'] : []), ...references)
  return details.length ? ['', '> [!info]- 实现与证据', ...details.map(line => line ? '> ' + line : '>')] : []
}

function flowFiles(id, flow, flowPaths) {
  const { stem } = flowPaths.get(id)
  const columns = layoutColumns(flow)
  const byId = new Map(flow.nodes.map(node => [node.id, node]))
  const incoming = new Set(flow.edges.map(edge => edge.to))
  const entries = flow.nodes.filter(node => !incoming.has(node.id))
  const lines = [
    ...noteStart('flow/' + id, 'flow', flow.title), '', plain(flow.summary), '',
    wiki(stem + '.canvas', '查看流程图'),
  ]
  if (entries.length && flow.nodes.length > 1) {
    lines.push('', '**从这里开始** ' + entries.map(({ title }) => plain(title)).join('、'))
  }
  lines.push('', '## 操作与分支')
  for (const nodeId of columns.flat()) {
    const node = byId.get(nodeId)
    lines.push('', '### ' + plain(node.title), '', plain(node.summary) + ' ^step-' + node.id, '',
      '状态：' + stepStateLabels[stepState(node)])
    const outgoing = flow.edges.filter(edge => edge.from === node.id)
    if (outgoing.length === 1 && !outgoing[0].label) {
      lines.push('', '**接着** ' + plain(byId.get(outgoing[0].to).title))
    } else if (outgoing.length) {
      lines.push('', ...outgoing.map(edge => {
        const title = plain(byId.get(edge.to).title)
        return edge.label ? '- **' + plain(edge.label) + '** → ' + title : '- → ' + title
      }))
    }
    lines.push(...evidence(node))
  }
  if (flow.links?.length) {
    lines.push('', '## 延伸线路', '')
    for (const link of flow.links) {
      const target = flowPaths.get(link.group + '/' + link.flow)
      lines.push('- ' + workflowLabels[link.kind] + ' · ' + wiki(target.stem, target.title))
    }
  }
  const nodes = columns.flatMap((column, col) => column.map((nodeId, row) => {
    const node = byId.get(nodeId)
    return card(nodeId, col, row, column.length, {
      type: 'text',
      text: ['### ' + plain(node.title), '', plain(brief(node.summary, 125)), '',
        wiki(stem + '#^step-' + nodeId, '查看实现')].join('\n'),
    })
  }))
  const placements = new Map(nodes.map(node => [node.id, node]))
  const edges = flow.edges.map((edge, index) => canvasEdge(index, placements.get(edge.from), placements.get(edge.to), edge.label))
  return [[stem + '.md', lines.join('\n') + '\n'], [stem + '.canvas', json({ nodes, edges })]]
}

function renderFiles(graph) {
  const files = new Map()
  const groupNames = noteNames(graph.groups)
  const flowPaths = new Map()
  for (const group of graph.groups) {
    const names = noteNames(group.flows)
    for (const { id, title } of group.flows) {
      flowPaths.set(group.id + '/' + id, { title, stem: '线路/' + groupNames.get(group.id) + '/' + names.get(id) })
    }
  }
  const index = [...noteStart('project', 'project', graph.project.name), '',
    wiki('overview.canvas', '查看项目总图')]
  const root = card('project', 0, 0, 1, { type: 'file', file: overviewNote })
  const nodes = [root]
  const edges = []
  let groupRow = 0
  const sections = groupSections(graph)
  for (const [row, { area, groups }] of sections.entries()) {
    index.push('', '## ' + (area ? plain(area.title) : '功能区'), '')
    let parent = root
    if (area) {
      if (area.summary) index.push(plain(area.summary), '')
      const title = '### ' + plain(area.title)
      const text = area.summary ? title + '\n\n' + plain(brief(area.summary, 125)) : title
      parent = card('area-' + area.id, 1, row, sections.length, { type: 'text', text })
      nodes.push(parent)
      edges.push(canvasEdge(edges.length, root, parent))
    }
    for (const group of groups) {
      const stem = '功能区/' + groupNames.get(group.id)
      index.push('- ' + wiki(stem, group.title) + (group.summary ? ' · ' + plain(brief(group.summary, 105)) : ''))
      const moduleCard = card('module-' + group.id, area ? 2 : 1, groupRow++, graph.groups.length,
        { type: 'file', file: stem + '.md' })
      nodes.push(moduleCard)
      edges.push(canvasEdge(edges.length, parent, moduleCard))
      const moduleNote = noteStart('group/' + group.id, 'group', group.title)
      if (group.summary) moduleNote.push('', plain(group.summary))
      moduleNote.push('', '## 功能线路', '')
      for (const flow of group.flows) {
        const id = group.id + '/' + flow.id
        moduleNote.push('- ' + wiki(flowPaths.get(id).stem, flow.title) + '  ', '  ' + plain(brief(flow.summary, 115)))
        for (const [path, content] of flowFiles(id, flow, flowPaths)) files.set(path, content)
      }
      files.set(stem + '.md', moduleNote.join('\n') + '\n')
    }
  }
  files.set(overviewNote, index.join('\n') + '\n')
  files.set('overview.canvas', json({ nodes, edges }))
  return files
}

// The manifest is the last file published. An interrupted export can resume
// over identical files, while a completed snapshot can contain user edits.
export async function exportObsidian(graph, store, { output, signal }) {
  signal?.throwIfAborted()
  const digest = createHash('sha256').update(JSON.stringify([exportFormatVersion, graph])).digest('hex')
  const directory = (output ? output + '/' : '') + 'threadlight-' + digest.slice(0, 16)
  const files = renderFiles(graph)
  const manifest = json({
    exportFormatVersion,
    schemaVersion: graph.schemaVersion,
    digest,
    project: graph.project.name,
    ...(typeof graph.snapshot?.baseCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(graph.snapshot.baseCommit)
      ? { baseCommit: graph.snapshot.baseCommit } : {}),
    ...(typeof graph.snapshot?.dirty === 'boolean' ? { dirty: graph.snapshot.dirty } : {}),
    files: [...files.keys()].sort(),
  })
  const manifestPath = directory + '/' + manifestName
  const result = { directory, overview: directory + '/overview.canvas', digest, reused: false }
  const prior = await store.read(manifestPath, signal)
  if (prior !== null) {
    if (prior !== manifest) throw new Error('Existing export manifest conflicts with the graph snapshot')
    if (await store.read(result.overview, signal) === null) throw new Error('Existing export is missing overview.canvas')
    return { ...result, reused: true }
  }
  for (const [path, content] of [...files, [manifestName, manifest]]) {
    signal?.throwIfAborted()
    const target = directory + '/' + path
    if (!await store.create(target, content, signal) && await store.read(target, signal) !== content) {
      throw new Error('Export conflicts with existing file ' + path)
    }
  }
  return result
}
