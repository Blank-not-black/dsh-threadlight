const { workspace, digest, project, maxSelection } = JSON.parse(document.getElementById('notes-context').textContent)
const by = id => document.getElementById(id)
const reader = '?' + new URLSearchParams({ workspace })
by('return').href = by('empty-return').href = reader
by('project').textContent = project
const submit = by('submit')
const agentPicker = by('agent-picker')
const agentPreset = by('agent-preset')
const selected = new Set()
const groups = new Map()
const headers = { 'x-threadlight-client': 'review' }
const presetStorageKey = 'threadlight:notes:agent-preset:' + workspace
// null until GET api/agent-presets says otherwise; a missing service keeps the
// page usable and simply hides the main-session agent picker.
let presetState = null
let savedPreset = readSavedPreset()
let presetId = null
let busy = false
let editing = null
let mutations = 0

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

function action(label, onClick) {
  const control = make('button', label)
  control.type = 'button'
  control.addEventListener('click', onClick)
  return control
}

async function request(route, options) {
  const response = await fetch(route, options)
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(result?.error || '请求失败，请重新打开 Threadlight 后重试。')
  if (!result) throw new Error('无法读取 Threadlight 响应。')
  return result
}

function readSavedPreset() {
  try {
    const value = globalThis.localStorage?.getItem(presetStorageKey)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

function savePreset(value) {
  try {
    globalThis.localStorage?.setItem(presetStorageKey, value)
  } catch {
    // Storage can be unavailable or full; the in-memory choice is authoritative.
  }
}

function presetLabel(preset) {
  return preset.name || preset.id
}

function renderPresetPicker() {
  if (!presetState || !agentPicker || !agentPreset) return
  agentPreset.replaceChildren()
  for (const preset of presetState.presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = presetLabel(preset) + (preset.broken ? '（不可用）' : '')
    option.disabled = Boolean(preset.broken)
    if (preset.description) option.title = preset.description
    agentPreset.append(option)
  }
  presetId = presetState.usable.some(preset => preset.id === savedPreset) ? savedPreset : presetState.defaultId
  if (presetId) agentPreset.value = presetId
  agentPreset.addEventListener('change', () => {
    presetId = agentPreset.value
    savedPreset = presetId
    savePreset(presetId)
  })
  agentPicker.hidden = false
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
  return count >= 2 ? '提交给主会话（' + count + ' 个模块）' : '提交给 DSH'
}

function updateSelection() {
  const locked = busy || mutations > 0 || editing !== null
  for (const { checkbox, entries } of groups.values()) {
    let count = 0
    for (const entry of entries) {
      entry.checkbox.checked = selected.has(entry.note.id)
      entry.checkbox.disabled = locked
      entry.edit.disabled = locked
      entry.remove.disabled = locked
      if (entry.checkbox.checked) count++
    }
    checkbox.checked = count === entries.length
    checkbox.indeterminate = count > 0 && count < entries.length
    checkbox.disabled = locked
  }
  if (agentPreset) agentPreset.disabled = locked
  const exceedsLimit = selected.size > maxSelection
  by('selected').textContent = '已选 ' + selected.size + ' 条' + (exceedsLimit ? '（每次最多 ' + maxSelection + ' 条）' : '')
  submit.disabled = locked || !selected.size || exceedsLimit
  submit.textContent = submitLabel()
}

async function change(method, body, message, apply, ...controls) {
  mutations++
  updateSelection()
  controls.forEach(control => { control.disabled = true })
  try {
    const result = await request('api/annotations', {
      method, headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, digest, ...body }),
    })
    editing = null
    apply(result)
    status(message)
  } catch (error) {
    status(error.message, true)
  } finally {
    controls.forEach(control => { control.disabled = false })
    mutations--
    updateSelection()
  }
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
  const group = { id: note.group, title: note.groupTitle, section, list, checkbox, entries }
  groups.set(note.group, group)
  return group
}

function mark(entry, submitted) {
  entry.note.submitted = submitted
  entry.badge.textContent = submitted ? '已提交 · 会话 ' + submitted.sessionId.slice(0, 8) : ''
  entry.badge.hidden = !submitted
  entry.badge.title = submitted?.sessionId ?? ''
}

function totalNotes() {
  let total = 0
  for (const { entries } of groups.values()) total += entries.length
  return total
}

function syncSummary() {
  const total = totalNotes()
  by('total').textContent = total + ' 条批注'
  by('empty').hidden = total > 0
  document.body.classList.toggle('is-empty', total === 0)
}

function renderNoteBody(entry) {
  const { note } = entry
  entry.body.replaceChildren(make('p', note.text, 'note-text'))
  if (note.quote) entry.body.append(make('blockquote', note.quote))
  const timestamp = note.updatedAt ?? note.createdAt
  entry.time.textContent = (note.updatedAt ? '修改于 ' : '') + new Date(timestamp).toLocaleString()
  entry.time.dateTime = timestamp
}

function startEdit(entry, note) {
  if (busy || mutations || editing) return
  editing = entry
  updateSelection()
  const editor = make('textarea')
  editor.maxLength = 3000
  editor.value = note.text
  editor.setAttribute('aria-label', '修改批注正文')
  const finish = () => {
    editing = null
    renderNoteBody(entry)
    entry.actions.replaceChildren(entry.edit, entry.remove)
    updateSelection()
  }
  const save = action('保存修改', () => {
    if (!editor.value.trim()) {
      status('请输入批注。')
      editor.focus()
      return
    }
    void change('PATCH', { group: note.group, id: note.id, text: editor.value }, '批注已修改。', ({ note: updated }) => {
      note.text = updated.text
      note.updatedAt = updated.updatedAt
      finish()
      entry.edit.focus()
    }, editor, save, cancel)
  })
  const cancel = action('取消', () => {
    finish()
    entry.edit.focus()
  })
  entry.body.replaceChildren(editor)
  entry.actions.replaceChildren(save, cancel)
  editor.focus()
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
  const body = make('div', '', 'note-body')
  const time = make('time')
  const badge = make('span', '', 'submitted')
  const actions = make('div', '', 'note-actions')
  const entry = { checkbox, note, badge, time, body, actions, row, edit: null, remove: null }
  const edit = action('修改', () => startEdit(entry, note))
  const remove = action('删除', () => {
    if (busy || mutations || editing || !confirm('删除这条批注？')) return
    void change('DELETE', { group: note.group, id: note.id }, '批注已删除。', () => {
      selected.delete(note.id)
      const index = group.entries.indexOf(entry)
      if (index >= 0) group.entries.splice(index, 1)
      row.remove()
      if (!group.entries.length) {
        group.section.remove()
        groups.delete(note.group)
      }
      syncSummary()
      updateSelection()
    }, edit, remove)
  })
  entry.edit = edit
  entry.remove = remove
  actions.append(edit, remove)
  const meta = make('div', '', 'note-meta')
  meta.append(time, badge)
  row.append(label, body, meta, actions)
  group.entries.push(entry)
  group.list.append(row)
  renderNoteBody(entry)
  mark(entry, note.submitted)
  checkbox.addEventListener('change', () => {
    select(note.id, checkbox.checked)
    updateSelection()
  })
}

function applySubmission(submission) {
  const ids = new Set(submission.noteIds ?? [])
  for (const { entries } of groups.values()) {
    for (const entry of entries) {
      if (ids.has(entry.note.id) && Date.parse(submission.submittedAt) >= (Date.parse(entry.note.submitted?.submittedAt) || 0)) {
        mark(entry, { sessionId: submission.sessionId, submittedAt: submission.submittedAt })
      }
    }
  }
}

submit.addEventListener('click', async () => {
  busy = true
  updateSelection()
  status('正在向 DSH 提交批注…')
  const modules = coveredModules().size
  try {
    const result = await request('api/annotations-submit', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, digest, ids: [...selected], ...(presetId ? { agentPreset: presetId } : {}) }),
    })
    // The host may answer with one receipt, or with a list from an older build.
    const submission = result.submission ?? (Array.isArray(result.submissions) ? result.submissions[0] : null)
    if (!submission?.sessionId) throw new Error('DSH 未返回提交回执，请稍后重试。')
    applySubmission(submission)
    selected.clear()
    const prefix = modules >= 2
      ? '已提交到 DSH 主会话（' + modules + ' 个模块，子代理分工处理）'
      : '已提交到 DSH'
    status(prefix + ' · 会话 ' + submission.sessionId)
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
    renderPresetPicker()
    updateSelection()
  } catch {
    // A missing or broken agent roster must never block reading annotations.
    presetState = null
  }
}

async function load() {
  try {
    const { notes } = await request('api/annotations?' + new URLSearchParams({ workspace, digest, all: '1' }), { headers })
    for (const note of notes) showNote(note)
    syncSummary()
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
