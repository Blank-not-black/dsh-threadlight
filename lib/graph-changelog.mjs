import { isDeepStrictEqual } from 'node:util'
import { stepState, stepStateLabels, verificationLabels } from './step-state.mjs'

function compareById(previous, current, compare, key = item => item.id) {
  const before = new Map(previous.map(item => [key(item), item]))
  for (const item of current) {
    const id = key(item)
    compare(before.get(id), item)
    before.delete(id)
  }
  for (const item of before.values()) compare(item, undefined)
}

function fieldChanges(before, after, fields) {
  return Object.fromEntries(fields.flatMap(field => {
    const oldValue = before[field] ?? null
    const newValue = after[field] ?? null
    return isDeepStrictEqual(oldValue, newValue) ? [] : [[field, { before: oldValue, after: newValue }]]
  }))
}

function evidenceChanges(before, after) {
  const remaining = after.map(({ path, kind, line }) => ({ path, kind, line: line ?? null }))
  const unmatched = []
  for (const { path, kind, line = null } of before) {
    const exact = remaining.findIndex(item => item.path === path && item.kind === kind && item.line === line)
    if (exact < 0) unmatched.push({ path, kind, line })
    else remaining.splice(exact, 1)
  }
  // Match remaining references for the same file and kind in line order.
  const byLine = (a, b) => (a.line ?? 0) - (b.line ?? 0)
  remaining.sort(byLine)
  const changes = unmatched.sort(byLine).map(({ path, kind, line }) => {
    const match = remaining.findIndex(item => item.path === path && item.kind === kind)
    if (match < 0) return { action: 'removed', path, kind, line }
    return { action: 'relocated', path, kind, before: line, after: remaining.splice(match, 1)[0].line }
  })
  return changes.concat(remaining.map(source => ({ action: 'added', ...source })))
}

function verificationChanges(before, after) {
  const changes = []
  compareById(before, after, (oldRecord, newRecord) => {
    if (!oldRecord) changes.push({ action: 'added', record: newRecord })
    else if (!newRecord) changes.push({ action: 'removed', record: oldRecord })
    else {
      const fields = fieldChanges(oldRecord, newRecord, ['result', 'summary', 'command', 'at'])
      if (Object.keys(fields).length) changes.push({ action: 'modified', record: newRecord, fields })
    }
  })
  return changes
}

const levels = [
  { kind: 'group', children: 'flows', fields: ['title', 'summary', 'area'] },
  { kind: 'flow', children: 'nodes', fields: ['title', 'summary', 'edges', 'links'] },
  { kind: 'step', fields: ['title', 'summary', 'details', 'state', 'divergence'] },
]

export function diffGraphs(previous, current) {
  const changes = []
  const name = fieldChanges(previous.project, current.project, ['name'])
  if (name.name) changes.push({ kind: 'project', action: 'modified', path: [], fields: name })

  const beforeAreas = previous.project.areas ?? []
  const afterAreas = current.project.areas ?? []
  const areaTitles = areas => new Map(areas.map(area => [area.id, area.title]))
  const priorTitles = areaTitles(beforeAreas)
  const nextTitles = areaTitles(afterAreas)

  function compareLevel(before, after, { kind, children, fields }, parents = [], depth = 0) {
    compareById(before, after, (oldItem, newItem) => {
      const { id, title } = newItem ?? oldItem
      const path = [...parents, { kind, id, title }]
      if (!oldItem || !newItem) {
        changes.push({ kind, action: oldItem ? 'removed' : 'added', path })
        return
      }
      const change = { kind, action: 'modified', path }
      const values = fieldChanges(
        kind === 'step' ? { ...oldItem, state: stepState(oldItem) } : oldItem,
        kind === 'step' ? { ...newItem, state: stepState(newItem) } : newItem,
        fields,
      )
      if (values.area) {
        values.area.beforeTitle = priorTitles.get(values.area.before) ?? null
        values.area.afterTitle = nextTitles.get(values.area.after) ?? null
      }
      if (Object.keys(values).length) change.fields = values
      if (kind === 'step') {
        const evidence = evidenceChanges(oldItem.sources, newItem.sources)
        const verification = verificationChanges(oldItem.verification ?? [], newItem.verification ?? [])
        if (evidence.length) change.evidence = evidence
        if (verification.length) change.verification = verification
      }
      if (change.fields || change.evidence || change.verification) changes.push(change)
      if (children) compareLevel(oldItem[children], newItem[children], levels[depth + 1], path, depth + 1)
    })
  }

  compareLevel(beforeAreas, afterAreas, { kind: 'area', fields: ['title', 'summary'] })
  compareLevel(previous.groups, current.groups, levels[0])
  return changes
}

const labels = { area: '领域', group: '功能区', flow: '线路', step: '步骤' }
const fieldLabels = { summary: '摘要', details: '详情', divergence: '与预期的差异', edges: '步骤连线', links: '跨线路链接' }
const sourceLabels = { source: '源码', test: '测试', documentation: '文档', workflow: '工作流' }

function quote(value) {
  return '「' + value.replace(/\s+/g, ' ').replace(/[\\\x60*_[\]<>#&~]/g, '\\$&') + '」'
}

function describe({ kind, action, path, fields = {}, evidence = [], verification = [] }) {
  if (kind === 'project') return '项目名称由' + quote(fields.name.before) + '改为' + quote(fields.name.after)
  const name = ({ kind, title }) => labels[kind] + quote(title)
  const parent = path.slice(0, -1).map(name).join(' → ')
  const prefix = parent ? parent + '中，' : ''
  const item = name(path.at(-1))
  if (action === 'added' || action === 'removed') return prefix + (action === 'added' ? '新增' : '删除') + item

  const descriptions = []
  for (const [field, { before, after, beforeTitle, afterTitle }] of Object.entries(fields)) {
    if (field === 'title') descriptions.push('标题由' + quote(before) + '改为' + quote(after))
    else if (field === 'state') descriptions.push('状态由' + quote(stepStateLabels[before]) + '变为' + quote(stepStateLabels[after]))
    else if (field === 'area') {
      const area = (id, title) => id ? quote(title ?? id) : '未归属领域'
      descriptions.push('从' + area(before, beforeTitle) + '移到' + area(after, afterTitle))
    } else descriptions.push('更新了' + fieldLabels[field])
  }
  for (const change of evidence) {
    const location = quote(change.path) + '（' + sourceLabels[change.kind] + '）'
    const line = number => number === null ? '文件级' : '第 ' + number + ' 行'
    descriptions.push(change.action === 'relocated' ? '证据' + location + '由' + line(change.before) + '改为' + line(change.after) :
      (change.action === 'added' ? '新增' : '移除了') + '证据' + location + ' · ' + line(change.line))
  }
  for (const [action, label] of [['added', '新增'], ['removed', '移除了']]) {
    const count = verification.filter(change => change.action === action).length
    if (count) descriptions.push(label + ' ' + count + ' 条验证记录')
  }
  for (const change of verification.filter(change => change.action === 'modified')) {
    const result = change.fields.result
    const record = '验证记录' + quote(change.record.summary)
    descriptions.push(result ? record + '结果由' + quote(verificationLabels[result.before]) + '变为' + quote(verificationLabels[result.after]) :
      '更新了' + record)
  }
  return prefix + item + descriptions.join('，')
}

export function renderChangelog(entries, { limit = 5, orderSource = entries[0]?.orderSource } = {}) {
  const lines = ['# 图谱变动日志', '']
  if (orderSource === 'mtime') lines.push('历史记录不可用，版本顺序来自修订目录的文件修改时间。', '')
  if (!entries.length) lines.push('没有可比较的图谱版本。')
  for (const { to, at, changes } of entries.slice(-limit)) {
    lines.push('## ' + to + ' · ' + at, '')
    lines.push(...(changes.length ? changes.map(change => '- ' + describe(change)) : ['- 本次发布没有可见变化']), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}
