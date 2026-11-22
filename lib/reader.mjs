import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createLocalStore } from './local-store.mjs'
import { layoutColumns } from './graph.mjs'
import { stepState, stepStateLabels, verificationLabels } from './step-state.mjs'

export { stepState } from './step-state.mjs'

const template = await readFile(new URL('./reader.html', import.meta.url), 'utf8')
const builtInGlossary = await readFile(new URL('./reader-glossary.json', import.meta.url), 'utf8')
const heading = '<!-- threadlight-heading -->'
const format = 5
export const readerVersion = createHash('sha256').update(JSON.stringify([format, template, builtInGlossary])).digest('hex')

function line(value) {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\\x60*_[\]<>#]/g, '\\$&')
}

function evidenceLocation(source) {
  return source.path + (source.line ? ':' + source.line : '') + ' · ' + source.kind +
    (source.symbol ? ' · ' + source.symbol.name : '') + (source.status === 'needs-review' ? ' · 证据待复核' : '')
}

function stepFragment(group, flow, node) {
  return '#step/' + group.id + '/' + flow.id + '/' + node.id
}

function verificationText({ result, summary, command, at }) {
  return [verificationLabels[result], summary, command, at].filter(Boolean).join(' · ')
}

function moduleNote(group) {
  const out = ['# ' + line(group.title)]
  if (group.summary) out.push('', line(group.summary))
  for (const flow of group.flows) {
    out.push('', '## ' + line(flow.title), '', line(flow.summary))
    const title = new Map(flow.nodes.map(node => [node.id, node.title]))
    for (const node of flow.nodes) {
      out.push('', '<a id="' + flow.id + '--' + node.id + '"></a>', '### ' + line(node.title), '',
        line(node.summary), '', '状态：' + stepStateLabels[stepState(node)], '',
        '[在图谱中打开这一步](../index.html' + stepFragment(group, flow, node) + ')')
      for (const edge of flow.edges.filter(item => item.from === node.id)) {
        out.push('- ' + line(edge.label || '接着') + ' → ' + line(title.get(edge.to)))
      }
      if (node.details.length || node.sources.length) {
        out.push('', '#### 实现与证据', '')
        for (const detail of node.details) out.push('- ' + line(detail))
        for (const source of node.sources) out.push('- ' + line(evidenceLocation(source)))
      }
      if (node.verification?.length) {
        out.push('', '#### 验证记录', '')
        for (const record of node.verification) out.push('- ' + line(verificationText(record)))
      }
      if (node.divergence) out.push('', '#### 与预期的差异', '', line(node.divergence))
    }
  }
  return out.join('\n') + '\n'
}

function htmlText(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return value.replace(/[&<>"]/g, character => entities[character])
}

export function renderModuleDocument(group, { readerHref, markdownHref }) {
  const content = group.flows.map(flow => {
    const steps = flow.nodes.map(node => {
      const items = [...node.details, ...node.sources.map(evidenceLocation)]
      const evidence = items.length ? '<ul>' + items.map(value => '<li>' + htmlText(value) + '</li>').join('') + '</ul>' : ''
      const verification = node.verification?.length
        ? '<h4>验证记录</h4><ul>' + node.verification.map(record => '<li>' + htmlText(verificationText(record)) + '</li>').join('') + '</ul>' : ''
      const divergence = node.divergence ? '<h4>与预期的差异</h4><p class="divergence">' + htmlText(node.divergence) + '</p>' : ''
      return '<section id="' + flow.id + '--' + node.id + '"><h3>' + htmlText(node.title) + '</h3><p>' + htmlText(node.summary) +
        '</p><p>状态：' + stepStateLabels[stepState(node)] + '</p>' + evidence + verification + divergence +
        '<a href="' + htmlText(readerHref + stepFragment(group, flow, node)) + '">在图谱中打开这一步 →</a></section>'
    }).join('')
    return '<article><h2>' + htmlText(flow.title) + '</h2><p>' + htmlText(flow.summary) + '</p>' + steps + '</article>'
  }).join('')
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + htmlText(group.title) + ' · Threadlight</title><style>' +
    ':root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:800px;margin:24px auto;padding:0 18px;overflow-wrap:anywhere}' +
    'nav a+a{margin-left:16px}section{margin:18px 0;padding:12px;border:1px solid light-dark(#ccd8d0,#48574e);border-radius:8px}' +
    'section:target{outline:2px solid light-dark(#225e48,#95d1b0)}section h3,section p{margin:0 0 8px}.divergence{white-space:pre-wrap}</style>' +
    '<nav><a href="' + htmlText(readerHref) + '">返回图谱</a>' +
    (markdownHref ? '<a href="' + htmlText(markdownHref) + '">打开 Markdown</a>' : '') +
    '</nav><main><h1>' + htmlText(group.title) + '</h1>' +
    (group.summary ? '<p>' + htmlText(group.summary) + '</p>' : '') + content + '</main></html>'
}

export function renderReader(graph, { review, documentHref = 'project.md' } = {}) {
  const glossary = new Map(Object.entries(JSON.parse(builtInGlossary)).map(([term, definition]) =>
    [term.toLowerCase(), { term, definition }]))
  for (const entry of graph.glossary ?? []) glossary.set(entry.term.toLowerCase(), entry)
  const view = { project: graph.project, snapshot: graph.snapshot, glossary: [...glossary.values()],
    stepStateLabels, verificationLabels,
    documentRoot: review ? undefined : documentHref.replace(/[^/]+$/, '') + 'docs/',
    groups: graph.groups.map(group => ({
    ...group, flows: group.flows.map(flow => ({ ...flow, layout: { rows: layoutColumns(flow) } })),
  })) }
  if (template.split(heading).length !== 2) throw new Error('Reader template must have one heading link placeholder')
  const link = review ? '<a href="?view=workspaces">切换工作区</a>' : '<a href="' + documentHref + '">项目文档</a>'
  let page = template.replace(heading, () => link)
  if (review) {
    view.review = { workspace: review.workspace, digest: review.digest }
    page = page.replace('<!-- threadlight-review -->', '<link rel="stylesheet" href="review.css"><script src="review.js"></script>')
      .replace('<script>', '<script nonce="' + review.nonce + '">')
  }
  const payload = JSON.stringify(view, (key, value) => key === 'anchor' ? undefined : value).replaceAll('<', '\\u003c')
  return page.replace('"THREADLIGHT_GRAPH_DATA"', () => payload)
}

export async function publishReader(graph, output) {
  const hash = createHash('sha256').update(readerVersion).update(JSON.stringify(graph)).digest('hex')
  const revision = 'threadlight-' + hash.slice(0, 16)
  const store = await createLocalStore(output)
  const overview = ['# ' + line(graph.project.name), '', '[打开图谱](index.html)', '', '## 功能区', '']
  const files = new Map()
  for (const group of graph.groups) {
    overview.push('- [' + line(group.title) + '](docs/' + group.id + '.md)')
    files.set('docs/' + group.id + '.md', moduleNote(group))
    files.set('docs/' + group.id + '.html', renderModuleDocument(group, {
      readerHref: '../index.html', markdownHref: group.id + '.md',
    }))
  }
  files.set('project.md', overview.join('\n') + '\n')
  files.set('graph.json', JSON.stringify(graph, null, 2) + '\n')
  files.set('index.html', renderReader(graph))
  const manifest = JSON.stringify({ format, hash, files: [...files.keys()] }, null, 2) + '\n'
  const manifestPath = revision + '/threadlight-reader.json'
  const prior = await store.read(manifestPath)
  if (prior !== null && prior !== manifest) throw new Error('Reader snapshot already exists with different content')
  for (const [path, content] of files) {
    const target = revision + '/' + path
    if (!await store.create(target, content) && await store.read(target) !== content) {
      throw new Error('Reader snapshot file conflicts: ' + path)
    }
  }
  if (!await store.create(manifestPath, manifest) && await store.read(manifestPath) !== manifest) {
    throw new Error('Reader snapshot manifest conflicts')
  }
  return { revision, hash, directory: resolve(output, revision), viewer: resolve(output, revision, 'index.html'),
    document: resolve(output, revision, 'project.md'), graph: join(revision, 'graph.json') }
}
