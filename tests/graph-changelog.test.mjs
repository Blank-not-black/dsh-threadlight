import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffGraphs, renderChangelog } from '../lib/graph-changelog.mjs'
import { parseGraph } from '../lib/graph.mjs'
import { publishReader } from '../lib/reader.mjs'
import { appendHistory } from '../lib/refresh.mjs'

const cli = fileURLToPath(new URL('../bin/dsh-threadlight.mjs', import.meta.url))
const at = '2026-11-22T09:30:00.000Z'
const revisionId = n => 'threadlight-' + n.toString(16).padStart(16, '0')
const step = (id, title) => ({ id, title, summary: title, details: [], sources: [] })
const flow = (id, title, ...nodes) => ({ id, title, summary: title, nodes, edges: [] })
const group = (id, title, area, ...flows) => ({ id, title, area, flows })
const check = (id, result = 'passed') => ({ id, at, result, summary: '验证保存' })

function graphs() {
  const save = { ...step('save', '确认保存'), sources: [
    { path: 'src/save.js', kind: 'source', line: 10 },
    { path: 'src/save.js', kind: 'source', line: 20 },
    { path: 'old.md', kind: 'documentation' },
  ] }
  const validated = { ...step('check', '检查结果'), state: 'verified', verification: [check('suite'), check('smoke')] }
  const previous = {
    schemaVersion: 1,
    project: { name: '文件服务', areas: [{ id: 'storage', title: '存储' }, { id: 'legacy', title: '旧领域' }] },
    groups: [
      group('files', '文件上传', 'storage', flow('upload', '上传文件', save, validated, step('old', '旧步骤')),
        flow('legacy', '旧线路', step('legacy', '旧线路步骤'))),
      group('legacy', '旧功能区', 'legacy', flow('legacy', '旧功能区线路', step('legacy', '旧功能区步骤'))),
    ],
  }
  const current = structuredClone(previous)
  current.project.name = '文件平台'
  current.project.areas = [{ id: 'storage', title: '文件存储', summary: '存放历史版本。' }, { id: 'delivery', title: '交付' }]
  const files = current.groups[0]
  Object.assign(files, { title: '文件交付', summary: '交付新文件。', area: 'delivery' })
  const upload = files.flows[0]
  Object.assign(upload, { title: '上传新文件', summary: '可以重试上传。' })
  Object.assign(upload.nodes[0], {
    title: '确认文件保存', summary: '确认保存和重试。', details: ['保存写入回执。'],
    state: 'verified', divergence: '仅在断网后重试。',
    sources: [{ ...save.sources[1] }, { ...save.sources[0], line: 12 }, { path: 'save.test.js', kind: 'test' }],
    verification: [check('result')],
  })
  upload.nodes[1].verification[0].result = 'failed'
  upload.nodes[2] = step('retry', '重试上传')
  files.flows[1] = flow('new', '新线路', step('open', '进入线路'))
  current.groups[1] = group('new', '新功能区', 'delivery', flow('new', '新功能区线路', step('open', '进入线路')))
  return [previous, current].map(graph => parseGraph(JSON.stringify(graph)))
}

test('graph diffs use stable IDs at every level and compare evidence and effective step status', () => {
  const [previous, current] = graphs()
  const changes = diffGraphs(previous, current)
  assert.deepEqual(diffGraphs(previous, structuredClone(previous)), [])
  assert.deepEqual(changes[0], { kind: 'project', action: 'modified', path: [],
    fields: { name: { before: '文件服务', after: '文件平台' } } })
  for (const kind of ['area', 'group', 'flow', 'step']) {
    const found = changes.filter(change => change.kind === kind)
    assert.deepEqual([...new Set(found.map(change => change.action))].sort(), ['added', 'modified', 'removed'], kind)
    assert.ok(found.some(change => change.fields?.title), kind + ' title')
    assert.ok(found.some(change => change.fields?.summary), kind + ' summary')
  }
  const area = changes.find(change => change.kind === 'group' && change.action === 'modified').fields.area
  assert.deepEqual(area, { before: 'storage', after: 'delivery', beforeTitle: '存储', afterTitle: '交付' })
  const saved = changes.find(change => change.path.at(-1)?.id === 'save')
  assert.deepEqual(saved.path.map(({ id }) => id), ['files', 'upload', 'save'])
  assert.deepEqual(saved.fields.state, { before: 'implemented', after: 'verified' })
  assert.deepEqual(saved.fields.details.after, ['保存写入回执。'])
  assert.equal(saved.fields.divergence.before, null)
  assert.equal(saved.fields.divergence.after, '仅在断网后重试。')
  assert.deepEqual(saved.evidence, [
    { action: 'removed', path: 'old.md', kind: 'documentation', line: null },
    { action: 'relocated', path: 'src/save.js', kind: 'source', before: 10, after: 12 },
    { action: 'added', path: 'save.test.js', kind: 'test', line: null },
  ])
  assert.deepEqual(saved.verification, [{ action: 'added', record: check('result') }])
  const verification = changes.find(change => change.path.at(-1)?.id === 'check').verification[0]
  assert.deepEqual(verification.fields.result, { before: 'passed', after: 'failed' })

  const explicit = structuredClone(previous)
  const node = explicit.groups[0].flows[0].nodes[0]
  node.state = 'implemented'
  assert.deepEqual(diffGraphs(previous, explicit), [])
  delete node.state
  node.sources = []
  assert.deepEqual(diffGraphs(previous, explicit)[0].fields.state, { before: 'implemented', after: 'planned' })
})

test('Markdown names the parent level, action, evidence and verification outcome in Chinese', () => {
  const changes = diffGraphs(...graphs())
  const entries = [{ to: revisionId(1), at, changes }, { to: revisionId(2), at, changes: [] }]
  const rendered = renderChangelog(entries)
  for (const line of [
    '新增领域「交付」', '从「存储」移到「交付」', '线路「上传新文件」中，新增步骤「重试上传」',
    '状态由「有实现依据」变为「已实际验证」', '由第 10 行改为第 12 行', '新增 1 条验证记录',
    '结果由「通过」变为「失败」', '本次发布没有可见变化',
  ]) assert.ok(rendered.includes(line), line)
  assert.match(rendered, /^# 图谱变动日志\n\n## threadlight-0000000000000001 · 2026-11-22T09:30:00.000Z/)
  assert.doesNotMatch(renderChangelog(entries, { limit: 1 }), /新增领域/)
})

test('changelog CLI compares publication history, explicit revisions and legacy directory order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'threadlight-changelog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true })
  const control = join(root, '.threadlight')
  const revisions = join(control, 'revisions')
  const [before, after] = graphs()
  const first = await publishReader(before, revisions)
  const second = await publishReader(after, revisions)
  const third = await publishReader({ ...after, project: { ...after.project, name: '交付平台' } }, revisions)
  const history = join(control, 'history.json')
  for (const { revision } of [first, second, third]) await appendHistory(control, { revision, status: 'updated' })
  const run = (...args) => spawnSync(process.execPath, [cli, 'changelog', ...args], { cwd: root, encoding: 'utf8', windowsHide: true })
  const json = run('--limit', '1', '--format', 'json')
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).map(({ from, to, orderSource }) => [from, to, orderSource]),
    [[second.revision, third.revision, 'history']])
  const changesPath = join(control, 'changes.md')
  await assert.rejects(readFile(changesPath), { code: 'ENOENT' })
  const explicit = run(root, '--from', first.revision, '--to', third.revision, '--format', 'json')
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.deepEqual(JSON.parse(explicit.stdout)[0].changes[0].fields.name, { before: '文件服务', after: '交付平台' })

  for (const [args, reason] of [
    [['--from', first.revision], /provided together/],
    [['--from', '../archive', '--to', first.revision], /Invalid Threadlight revision/],
    [['--from', first.revision, '--to', revisionId(0)], /revision does not exist/],
    [['--limit', '0'], /positive integer/],
  ]) {
    const result = run(...args)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, reason)
  }
  await rm(history)
  const time = Date.parse(at) / 1000
  await utimes(third.directory, time - 200, time - 200)
  await utimes(first.directory, time - 100, time - 100)
  await utimes(second.directory, time, time)
  const fallback = run()
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.match(fallback.stdout, /版本顺序来自修订目录的文件修改时间/)
  assert.deepEqual(fallback.stdout, await readFile(changesPath, 'utf8'))
  const fallbackJson = run('--format', 'json')
  assert.equal(fallbackJson.status, 0, fallbackJson.stderr)
  assert.deepEqual(JSON.parse(fallbackJson.stdout).map(({ from, to, orderSource }) => [from, to, orderSource]), [
    [third.revision, first.revision, 'mtime'], [first.revision, second.revision, 'mtime'],
  ])
})

test('publication history retains only the latest 200 entries', async t => {
  const control = await mkdtemp(join(tmpdir(), 'threadlight-history-'))
  t.after(() => rm(control, { recursive: true, force: true }))
  const entries = Array.from({ length: 200 }, (_, n) => ({ revision: revisionId(n), at, status: 'updated' }))
  const path = join(control, 'history.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, entries }))
  await appendHistory(control, { revision: revisionId(200), status: 'reported' })
  const result = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(result.entries.length, 200)
  assert.deepEqual(result.entries.slice(0, -1), entries.slice(1))
  assert.equal(result.entries.at(-1).revision, revisionId(200))
})
