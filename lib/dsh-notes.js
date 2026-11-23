const { workspace, digest, project, maxSelection } = JSON.parse(document.getElementById('notes-context').textContent)
const by = id => document.getElementById(id)
const reader = '?' + new URLSearchParams({ workspace })
by('return').href = by('empty-return').href = reader
by('project').textContent = project
const submit = by('submit')
const failureBox = by('failures')
const selected = new Set()
const groups = new Map()
const chosenPresets = new Map()
const headers = { 'x-threadlight-client': 'review' }
const presetStorageKey = 'threadlight:notes:agent-preset:' + workspace
const savedPresets = readSavedPresets()
// null until GET api/agent-presets says otherwise; a missing service keeps the
// page usable and simply hides every agent picker.
let presetState = null
let busy = false

function make(tag, text = '', className = '') {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

function status(message, error = false) {
  const output = by('status')
  output.textContent = message
  output.classList.toggle('error', error)
}

async function request(route, options) {
  const response = await fetch(route, options)
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(result?.error || '请求失败，请重新打开 Threadlight 后重试。')
  if (!result) throw new Error('无法读取 Threadlight 响应。')
  return result
}

function readSavedPresets() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(presetStorageKey) ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function savePresets() {
  try {
    globalThis.localStorage?.setItem(presetStorageKey, JSON.stringify(Object.fromEntries(chosenPresets)))
  } catch {
    // Storage can be unavailable or full; the in-memory map is authoritative.
  }
}

function presetLabel(preset) {
  return preset.name || preset.id
}

function usablePreset(id) {
  return Boolean(id) && Boolean(presetState?.usable.some(preset => preset.id === id))
}

function groupPreset(groupId) {
  const saved = savedPresets[groupId]
  if (typeof saved === 'string' && usablePreset(saved)) return saved
  return presetState?.defaultId ?? null
}

function addPresetPicker(group) {
  if (!presetState || group.preset) return
  const picker = make('label', '', 'preset-picker')
  const caption = make('span', 'Agent', 'preset-caption')
  const select = make('select')
  select.setAttribute('aria-label', group.title + ' 使用的 agent')
  for (const preset of presetState.presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = presetLabel(preset) + (preset.broken ? '（不可用）' : '')
    option.disabled = Boolean(preset.broken)
    if (preset.description) option.title = preset.description
    select.append(option)
  }
  const presetId = groupPreset(group.id)
  if (presetId) {
    select.value = presetId
    chosenPresets.set(group.id, presetId)
  }
  select.addEventListener('change', () => {
    chosenPresets.set(group.id, select.value)
    savePresets()
  })
  picker.append(caption, select)
  group.tools.prepend(picker)
  group.preset = select
}

function coveredModules() {
  const modules = new Set()
  for (const [groupId, group] of groups) {
    if (group.entries.some(entry => selected.has(entry.note.id))) modules.add(groupId)
  }
  return modules
}

function submitLabel() {
  if (busy) return '正在提交…'
  const count = coveredModules().size
  return count >= 2 ? '并行提交到 ' + count + ' 个模块' : '提交给 DSH'
}

// Only modules holding selected annotations are planned, so the host never
// validates presets for annotations the user did not ask to submit.
function presetPlan() {
  if (!presetState) return undefined
  const modules = {}
  for (const groupId of coveredModules()) {
    const presetId = chosenPresets.get(groupId)
    if (presetId) modules[groupId] = presetId
  }
  return Object.keys(modules).length ? modules : undefined
}

function updateSelection() {
  for (const { checkbox, entries, preset } of groups.values()) {
    let count = 0
    for (const entry of entries) {
      entry.checkbox.checked = selected.has(entry.note.id)
      entry.checkbox.disabled = busy
      if (entry.checkbox.checked) count++
    }
    checkbox.checked = count === entries.length
    checkbox.indeterminate = count > 0 && count < entries.length
    checkbox.disabled = busy
    if (preset) preset.disabled = busy
  }
  const exceedsLimit = selected.size > maxSelection
  by('selected').textContent = '已选 ' + selected.size + ' 条' + (exceedsLimit ? '（每次最多 ' + maxSelection + ' 条）' : '')
  submit.disabled = busy || !selected.size || exceedsLimit
  submit.textContent = submitLabel()
}

function select(id, checked) {
  if (checked) selected.add(id)
  else selected.delete(id)
}

function groupSection(note) {
  const section = make('section')
  const header = make('div', '', 'group-heading')
  const tools = make('div', '', 'group-tools')
  const label = make('label')
  const checkbox = make('input')
  checkbox.type = 'checkbox'
  checkbox.setAttribute('aria-label', '全选' + note.groupTitle + '的批注')
  label.append(checkbox, '全选')
  tools.append(label)
  header.append(make('h2', note.groupTitle), tools)
  const list = make('ul')
  section.append(header, list)
  by('groups').append(section)
  const entries = []
  checkbox.addEventListener('change', () => {
    for (const { note } of entries) select(note.id, checkbox.checked)
    updateSelection()
  })
  const group = { id: note.group, title: note.groupTitle, list, checkbox, entries, tools, preset: null }
  groups.set(note.group, group)
  addPresetPicker(group)
  return group
}

function mark(entry, submitted) {
  entry.note.submitted = submitted
  entry.badge.textContent = submitted ? '已提交 · 会话 ' + submitted.sessionId.slice(0, 8) : ''
  entry.badge.hidden = !submitted
  entry.badge.title = submitted?.sessionId ?? ''
}

function showNote(note) {
  const group = groups.get(note.group) ?? groupSection(note)
  const row = make('li')
  const label = make('label', '', 'note-target')
  const checkbox = make('input')
  checkbox.type = 'checkbox'
  const path = [note.flowTitle, note.stepTitle].filter(Boolean).join(' / ')
  const kind = { group: '模块', flow: '线路', step: '步骤' }[note.target?.kind] ?? '模块'
  label.append(checkbox, kind + ' · ' + (path || note.groupTitle))
  row.append(label, make('p', note.text, 'note-text'))
  if (note.quote) row.append(make('blockquote', note.quote))
  const timestamp = note.updatedAt ?? note.createdAt
  const time = make('time', (note.updatedAt ? '修改于 ' : '') + new Date(timestamp).toLocaleString())
  time.dateTime = timestamp
  const badge = make('span', '', 'submitted')
  const entry = { checkbox, note, badge }
  mark(entry, note.submitted)
  const meta = make('div', '', 'note-meta')
  meta.append(time, badge)
  row.append(meta)
  group.entries.push(entry)
  group.list.append(row)
  checkbox.addEventListener('change', () => {
    select(note.id, checkbox.checked)
    updateSelection()
  })
}

function clearFailures() {
  if (!failureBox) return
  failureBox.replaceChildren()
  failureBox.hidden = true
}

function showFailures(failures) {
  if (!failureBox) return
  failureBox.replaceChildren()
  if (!failures.length) {
    failureBox.hidden = true
    return
  }
  const hint = make('p', '以下模块的批注没有提交成功，可以保留所选后重试：')
  const list = make('ul')
  for (const failure of failures) {
    const name = failure.groupTitle || groups.get(failure.module)?.title || failure.module || '未知模块'
    list.append(make('li', name + '：' + (failure.message || '提交失败，请重试。')))
  }
  failureBox.append(hint, list)
  failureBox.hidden = false
}

function applySubmissions(submissions) {
  const submittedIds = new Set()
  for (const submission of submissions) {
    const ids = new Set(submission.noteIds ?? [])
    for (const id of ids) submittedIds.add(id)
    for (const { entries } of groups.values()) {
      for (const entry of entries) {
        if (ids.has(entry.note.id) && Date.parse(submission.submittedAt) >= (Date.parse(entry.note.submitted?.submittedAt) || 0)) {
          mark(entry, { sessionId: submission.sessionId, submittedAt: submission.submittedAt })
        }
      }
    }
  }
  return submittedIds
}

submit.addEventListener('click', async () => {
  busy = true
  clearFailures()
  updateSelection()
  status('正在向 DSH 提交批注…')
  try {
    const modules = presetPlan()
    const result = await request('api/annotations-submit', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, digest, ids: [...selected], ...(modules ? { modules } : {}) }),
    })
    const legacy = !Array.isArray(result.submissions)
    const submissions = legacy ? (result.submission ? [result.submission] : []) : result.submissions
    const failures = legacy ? [] : (Array.isArray(result.failures) ? result.failures : [])
    const submittedIds = applySubmissions(submissions)
    if (failures.length) {
      // Keep the failed modules' annotations selected so the button can retry
      // just those modules without re-selecting them.
      for (const id of submittedIds) selected.delete(id)
      showFailures(failures)
      status('有 ' + failures.length + ' 个模块提交失败' +
        (submissions.length ? '，已提交 ' + submissions.length + ' 个模块会话' : ''), true)
    } else {
      selected.clear()
      if (submissions.length >= 2) status('已并行提交到 ' + submissions.length + ' 个模块会话')
      else if (submissions.length === 1) status('已提交到 DSH · 会话 ' + submissions[0].sessionId)
      else status('已提交到 DSH')
    }
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = false
    updateSelection()
  }
})

async function loadPresets() {
  try {
    const result = await request('api/agent-presets?' + new URLSearchParams({ workspace }), { headers })
    if (!result || result.unavailable || !Array.isArray(result.presets)) return
    const presets = result.presets.filter(preset => preset && typeof preset.id === 'string' && preset.id)
    const usable = presets.filter(preset => !preset.broken)
    if (!usable.length) return
    const defaultId = usable.some(preset => preset.id === result.default) ? result.default
      : (usable.find(preset => preset.isDefault)?.id ?? usable[0].id)
    presetState = { presets, usable, defaultId }
    for (const group of groups.values()) addPresetPicker(group)
    updateSelection()
  } catch {
    // A missing or broken agent roster must never block reading annotations.
    presetState = null
  }
}

async function load() {
  try {
    const { notes } = await request('api/annotations?' + new URLSearchParams({ workspace, digest, all: '1' }), { headers })
    by('total').textContent = notes.length + ' 条批注'
    by('empty').hidden = notes.length > 0
    document.body.classList.toggle('is-empty', notes.length === 0)
    for (const note of notes) showNote(note)
    updateSelection()
    status('')
  } catch (error) {
    // A failed load is not the same as an empty project; say which one it is.
    by('empty').hidden = false
    document.body.classList.add('is-empty')
    by('empty-title').textContent = '暂时读不到批注'
    by('empty-hint').textContent = error.message
    status(error.message, true)
  }
}

void load()
void loadPresets()
