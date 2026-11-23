import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseGraph } from '../lib/graph.mjs'
import { GraphQueryError, normalizeQuery, queryGraph } from '../lib/graph-query.mjs'
import { createLocalStore } from '../lib/local-store.mjs'
import { AnnotationError, annotationJson, annotationPath, buildAnnotation, resolveAnnotationTarget,
  writeAnnotation } from '../lib/tool-annotations.mjs'

const fixture = {
  schemaVersion: 1,
  project: {
    name: '查询测试项目',
    areas: [{ id: 'delivery', title: '交付' }, { id: 'reading', title: '阅读' }],
  },
  groups: [
    {
      id: 'export', title: '导出项目图谱', area: 'delivery', summary: '检查图谱结构并生成快照。',
      flows: [
        {
          id: 'obsidian', title: '在 Obsidian 打开图谱', summary: '从读取图谱到打开项目总览。',
          nodes: [
            {
              id: 'validate', title: '读取并验证图谱', summary: '检查版本、节点编号和连线目标。',
              details: ['图谱无效时返回明确的字段或引用错误。', '验证在创建导出文件之前完成。'],
              sources: [
                {
                  path: 'lib/graph.mjs', kind: 'source', line: 3,
                  symbol: { name: 'parseGraph', kind: 'function', startLine: 1, endLine: 9 },
                  preview: { startLine: 1, text: '第一行\n第二行\n第三行' },
                },
                { path: 'tests/export.test.mjs', kind: 'test' },
              ],
            },
            { id: 'write', title: '写入快照', summary: '生成笔记和 Canvas，最后写导出清单。', details: [], sources: [] },
            {
              id: 'verify', title: '验证发布结果', summary: '确认快照可以打开。', details: [], sources: [],
              state: 'verified',
              verification: [
                { id: 'check', at: '2026-11-22T04:29:00.000Z', result: 'failed', summary: '首次检查失败。' },
                { id: 'retry', at: '2026-11-22T04:30:00.000Z', result: 'passed', summary: '重试后通过。', command: 'npm run check' },
              ],
            },
          ],
          edges: [
            { from: 'validate', to: 'write', kind: 'sequence' },
            { from: 'write', to: 'verify', kind: 'branch', label: '快照写入成功' },
          ],
        },
        {
          id: 'markdown', title: '导出 Markdown', summary: '生成项目文档。',
          nodes: [{ id: 'render', title: '渲染文档', summary: '把图谱渲染为 Markdown。', details: [], sources: [] }],
          edges: [],
        },
      ],
    },
    {
      id: 'reader', title: '在线阅读', area: 'reading',
      flows: [{
        id: 'zoom', title: '缩放视图', summary: '调整画布缩放比例。',
        nodes: [{ id: 'scale', title: '调整比例', summary: '设置新的缩放值。', details: [], sources: [] }],
        edges: [],
      }],
    },
  ],
}

const graph = parseGraph(JSON.stringify(fixture))
const digest = 'a'.repeat(64)

test('graph query overview lists areas, feature areas and flows with counts', () => {
  const result = queryGraph(graph)
  assert.equal(result.view, 'overview')
  assert.equal(result.project, '查询测试项目')
  assert.deepEqual(result.counts, { areas: 2, groups: 2, flows: 3, steps: 5 })
  assert.deepEqual(result.areas, [
    { id: 'delivery', title: '交付', groups: 1 },
    { id: 'reading', title: '阅读', groups: 1 },
  ])
  assert.deepEqual(result.groups, [
    { id: 'export', title: '导出项目图谱', area: 'delivery', flows: 2 },
    { id: 'reader', title: '在线阅读', area: 'reading', flows: 1 },
  ])
  assert.deepEqual(result.flows, [
    { group: 'export', flow: 'obsidian', title: '在 Obsidian 打开图谱', steps: 3 },
    { group: 'export', flow: 'markdown', title: '导出 Markdown', steps: 1 },
    { group: 'reader', flow: 'zoom', title: '缩放视图', steps: 1 },
  ])
  assert.equal(result.truncated, false)
})

test('graph query flow returns steps with derived state and edges', () => {
  const result = queryGraph(graph, { view: 'flow', group: 'export', flow: 'obsidian' })
  assert.equal(result.view, 'flow')
  assert.deepEqual(result.group, { id: 'export', title: '导出项目图谱' })
  assert.deepEqual(result.flow, { id: 'obsidian', title: '在 Obsidian 打开图谱', summary: '从读取图谱到打开项目总览。' })
  assert.deepEqual(result.steps, [
    { id: 'validate', title: '读取并验证图谱', summary: '检查版本、节点编号和连线目标。', state: 'implemented', sources: 2 },
    { id: 'write', title: '写入快照', summary: '生成笔记和 Canvas，最后写导出清单。', state: 'planned', sources: 0 },
    { id: 'verify', title: '验证发布结果', summary: '确认快照可以打开。', state: 'verified', sources: 0 },
  ])
  assert.deepEqual(result.edges, [
    { from: 'validate', to: 'write', kind: 'sequence' },
    { from: 'write', to: 'verify', kind: 'branch', label: '快照写入成功' },
  ])
  assert.equal(result.truncated, false)
})

test('graph query step returns details, verification summary and source references without previews', () => {
  const result = queryGraph(graph, { view: 'step', group: 'export', flow: 'obsidian', step: 'validate' })
  assert.equal(result.view, 'step')
  assert.deepEqual(result.group, { id: 'export', title: '导出项目图谱' })
  assert.deepEqual(result.flow, { id: 'obsidian', title: '在 Obsidian 打开图谱' })
  assert.equal(result.step.id, 'validate')
  assert.equal(result.step.title, '读取并验证图谱')
  assert.equal(result.step.summary, '检查版本、节点编号和连线目标。')
  assert.deepEqual(result.step.details, ['图谱无效时返回明确的字段或引用错误。', '验证在创建导出文件之前完成。'])
  assert.equal(result.step.state, 'implemented')
  assert.equal(result.step.stateLabel, '有实现依据')
  assert.deepEqual(result.step.verification, { total: 0, passed: 0, failed: 0 })
  assert.deepEqual(result.step.sources, [
    { path: 'lib/graph.mjs', kind: 'source', line: 3, symbol: 'parseGraph' },
    { path: 'tests/export.test.mjs', kind: 'test' },
  ])
  assert.equal('preview' in result.step.sources[0], false)

  const verified = queryGraph(graph, { view: 'step', group: 'export', flow: 'obsidian', step: 'verify' })
  assert.equal(verified.step.state, 'verified')
  assert.equal(verified.step.stateLabel, '已实际验证')
  assert.deepEqual(verified.step.verification, {
    total: 2, passed: 1, failed: 1,
    latest: { at: '2026-11-22T04:30:00.000Z', result: 'passed', summary: '重试后通过。', command: 'npm run check' },
  })
})

test('graph query search filters flow and step titles and summaries case-insensitively', () => {
  assert.deepEqual(queryGraph(graph, { view: 'search', term: '图谱' }), {
    view: 'search', term: '图谱',
    flows: [{ group: 'export', flow: 'obsidian', title: '在 Obsidian 打开图谱' }],
    steps: [
      { group: 'export', flow: 'obsidian', step: 'validate', title: '读取并验证图谱' },
      { group: 'export', flow: 'markdown', step: 'render', title: '渲染文档' },
    ],
    truncated: false,
  })
  assert.deepEqual(queryGraph(graph, { view: 'search', term: 'MARKDOWN' }).flows,
    [{ group: 'export', flow: 'markdown', title: '导出 Markdown' }])
  assert.deepEqual(queryGraph(graph, { view: 'search', term: '缩放' }).flows,
    [{ group: 'reader', flow: 'zoom', title: '缩放视图' }])
  assert.deepEqual(queryGraph(graph, { view: 'search', term: '不存在的词' }).flows, [])
})

test('graph query rejects invalid parameters with field-specific messages', () => {
  const reject = (params, pattern) => assert.throws(() => queryGraph(graph, params),
    error => error instanceof GraphQueryError && pattern.test(error.message))
  reject(null, /查询参数必须是一个对象/)
  reject({ view: 42 }, /view 必须是/)
  reject({ view: 'nope' }, /view 必须是/)
  reject({ view: 'overview', group: 'export' }, /不能使用 group/)
  reject({ view: 'overview', term: '图谱' }, /不能使用 term/)
  reject({ view: 'flow', group: 'export' }, /必须提供 flow/)
  reject({ view: 'flow', flow: 'obsidian' }, /必须提供 group/)
  reject({ view: 'flow', group: 'missing', flow: 'obsidian' }, /可选功能区/)
  reject({ view: 'flow', group: 'export', flow: 'missing' }, /可选线路/)
  reject({ view: 'step', group: 'export', flow: 'obsidian', step: 'missing' }, /可选步骤/)
  reject({ view: 'step', group: 'export', flow: 'obsidian' }, /必须提供 step/)
  reject({ view: 'search' }, /必须提供 term/)
  reject({ view: 'search', term: '   ' }, /term 必须是/)
  reject({ view: 'search', term: '图谱', group: 'export' }, /不能使用 group/)
  reject({ view: 'overview', unknown: true }, /未知参数/)
  reject({ view: 'flow', group: '', flow: 'obsidian' }, /group 必须是/)
  assert.deepEqual(normalizeQuery({}), { view: 'overview', group: undefined, flow: undefined,
    step: undefined, term: undefined })
})

test('annotation records cover group, flow and step targets', () => {
  const base = { group: 'export', text: '  核对这里  ', digest }
  const group = buildAnnotation(graph, base)
  assert.match(group.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.equal(group.text, '核对这里')
  assert.equal(group.module, 'export')
  assert.equal(group.graph, digest)
  assert.deepEqual(group.target, { kind: 'group' })
  assert.ok(Number.isFinite(Date.parse(group.createdAt)))
  assert.equal('quote' in group, false)

  const flow = buildAnnotation(graph, { ...base, target: { kind: 'flow', flow: 'obsidian' }, quote: ' 原文\n保留 ' })
  assert.deepEqual(flow.target, { kind: 'flow', flow: 'obsidian' })
  assert.equal(flow.quote, ' 原文\n保留 ')

  const step = buildAnnotation(graph, { ...base, target: { kind: 'step', flow: 'obsidian', step: 'validate' } })
  assert.deepEqual(step.target, { kind: 'step', flow: 'obsidian', step: 'validate' })

  assert.deepEqual(resolveAnnotationTarget(graph, 'export').target, { kind: 'group' })
  assert.deepEqual(resolveAnnotationTarget(graph, 'reader', { kind: 'flow', flow: 'zoom' }).target,
    { kind: 'flow', flow: 'zoom' })
})

test('annotation construction and paths reject unknown or oversized input', () => {
  const base = { group: 'export', text: '核对这里', digest }
  const reject = (input, pattern) => assert.throws(() => buildAnnotation(graph, input),
    error => error instanceof AnnotationError && pattern.test(error.message))
  reject({ ...base, group: 'missing' }, /可选功能区/)
  reject({ ...base, target: { kind: 'flow', flow: 'missing' } }, /可选线路/)
  reject({ ...base, target: { kind: 'step', flow: 'obsidian', step: 'missing' } }, /可选步骤/)
  reject({ ...base, target: { kind: 'unknown' } }, /target\.kind 必须是/)
  reject({ ...base, target: null }, /target 必须是/)
  reject({ ...base, quote: '字'.repeat(3001) }, /quote/)
  reject({ ...base, text: '   ' }, /text/)
  reject({ ...base, text: '字'.repeat(3001) }, /text/)
  reject({ ...base, digest: 'short' }, /图谱摘要/)

  const id = randomUUID()
  assert.equal(annotationPath('export', id), '.threadlight/annotations/export/' + id + '.json')
  assert.throws(() => annotationPath('../outside', id), AnnotationError)
  assert.throws(() => annotationPath('export', 'not-an-id'), AnnotationError)
})

test('annotation files are created atomically and duplicate ids retry once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'threadlight-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await createLocalStore(root)
  const id = randomUUID()
  const record = buildAnnotation(graph, {
    group: 'export', text: '保留这条反馈', digest, id, createdAt: '2026-11-22T05:00:00.000Z',
    target: { kind: 'step', flow: 'obsidian', step: 'validate' }, quote: ' 原文\r\n保留 ',
  })
  const saved = await writeAnnotation(store, record)
  assert.equal(saved.id, id)
  const folder = join(root, '.threadlight', 'annotations', 'export')
  const file = join(folder, id + '.json')
  const content = await readFile(file, 'utf8')
  const parsed = JSON.parse(content)
  assert.deepEqual(Object.keys(parsed).sort(),
    ['createdAt', 'graph', 'id', 'module', 'quote', 'target', 'text'])
  assert.deepEqual(parsed, {
    id,
    text: '保留这条反馈',
    createdAt: '2026-11-22T05:00:00.000Z',
    module: 'export',
    graph: digest,
    target: { kind: 'step', flow: 'obsidian', step: 'validate' },
    quote: ' 原文\r\n保留 ',
  })
  assert.equal(content, annotationJson(parsed))

  // A repeated ID regenerates the ID once and keeps the annotation.
  const again = await writeAnnotation(store, record)
  assert.notEqual(again.id, id)
  assert.equal(JSON.parse(await readFile(join(folder, again.id + '.json'), 'utf8')).id, again.id)
  assert.deepEqual((await readdir(folder)).sort(), [again.id + '.json', id + '.json'].sort())

  // An annotation without a quote omits the field, matching the review page.
  const plain = await writeAnnotation(store, buildAnnotation(graph, { group: 'reader', text: '整体反馈', digest }))
  const plainRaw = JSON.parse(await readFile(join(root, '.threadlight', 'annotations', 'reader', plain.id + '.json'), 'utf8'))
  assert.equal('quote' in plainRaw, false)

  // Both the original and regenerated IDs are taken: the second conflict fails.
  await assert.rejects(writeAnnotation(store, { ...record, id }, { createId: () => again.id }),
    error => error instanceof AnnotationError && /批注保存冲突/.test(error.message))
})
