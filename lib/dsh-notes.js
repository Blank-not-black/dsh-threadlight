const { workspace, digest, project, maxSelection } = JSON.parse(document.getElementById('notes-context').textContent)
const by = id => document.getElementById(id)
const reader = '?' + new URLSearchParams({ workspace })
by('return').href = by('empty-return').href = reader
by('project').textContent = project
const submit = by('submit')
const agentPicker = by('agent-picker')
const agentPreset = by('agent-preset')
const archivedToggle = by('archived-toggle')
const acceptSubmitted = by('accept-submitted')
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
let showArchived = false

function make(tag, text = '', className = '') {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

// Acceptance marks the note as archived; the timestamp is the durable flag.
function isResolved(note) {
  return typeof note?.resolvedAt === 'string' && note.resolvedAt !== ''
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
    let selectable = 0
    for (const entry of entries) {
      const resolved = isResolved(entry.note)
      entry.checkbox.checked = !resolved && selected.has(entry.note.id)
      entry.checkbox.disabled = locked || resolved
      entry.edit.disabled = locked
      entry.remove.disabled = locked
      entry.accept.disabled = locked
      entry.restore.disabled = locked
      if (!resolved) selectable++
      if (entry.checkbox.checked) count++
    }
    checkbox.checked = selectable > 0 && count === selectable
    checkbox.indeterminate = count > 0 && count < selectable
    checkbox.disabled = locked || selectable === 0
  }
  if (agentPreset) agentPreset.disabled = locked
  archivedToggle.disabled = locked
  acceptSubmitted.disabled = locked
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
    // Archived notes cannot be submitted again, so select-all only covers pending ones.
    for (const entry of entries) {
      if (isResolved(entry.note)) continue
      select(entry.note.id, checkbox.checked)
    }
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
  refreshActions(entry)
}

function renderActions(entry) {
  entry.actions.replaceChildren(entry.edit, entry.remove, entry.accept, entry.restore)
}

// Keep per-note controls in sync with the note's submitted / archived state.
function refreshActions(entry) {
  const resolved = isResolved(entry.note)
  entry.accept.hidden = !(entry.note.submitted && !resolved)
  entry.restore.hidden = !resolved
  entry.checkbox.hidden = resolved
  entry.row.classList.toggle('resolved', resolved)
  entry.archived.hidden = !resolved
  entry.archived.textContent = resolved ? '已验收归档' : ''
  entry.archived.title = resolved ? entry.note.resolvedAt : ''
}

function noteCounts() {
  let total = 0, pending = 0, resolved = 0, submitted = 0
  for (const { entries } of groups.values()) {
    for (const entry of entries) {
      total++
      if (isResolved(entry.note)) {
        resolved++
        continue
      }
      pending++
      if (entry.note.submitted) submitted++
    }
  }
  return { total, pending, resolved, submitted }
}

// Only modules with a visible (pending, or archived while the toggle is on) row
// stay on the page, so a module holding only archived notes disappears.
function applyArchivedVisibility() {
  for (const group of groups.values()) {
    let visible = 0
    for (const entry of group.entries) {
      entry.row.hidden = isResolved(entry.note) && !showArchived
      if (!entry.row.hidden) visible++
    }
    group.section.hidden = visible === 0
  }
}

function syncSummary() {
  const { total, pending, resolved, submitted } = noteCounts()
  by('total').textContent = pending + ' 条待处理' + (resolved ? ' · ' + resolved + ' 条已归档' : '')
  const empty = pending === 0
  by('empty').hidden = !empty
  document.body.classList.toggle('is-empty', empty)
  if (empty) {
    // An inbox whose notes are all accepted is not "a project without notes".
    by('empty-title').textContent = total ? '没有待处理批注' : '这个项目还没有批注'
    by('empty-hint').textContent = total
      ? '所有批注都已验收归档。可以用「显示已归档」查看或恢复。'
      : '在查看器里右键模块或步骤，或选中一段文字后批注。批注可以直接提交给 DSH，不需要先改流程图。'
  }
  if (resolved === 0) showArchived = false
  archivedToggle.hidden = resolved === 0
  archivedToggle.textContent = (showArchived ? '隐藏已归档（' : '显示已归档（') + resolved + '）'
  archivedToggle.setAttribute('aria-pressed', showArchived ? 'true' : 'false')
  acceptSubmitted.hidden = submitted === 0
  acceptSubmitted.textContent = '验收已提交的 ' + submitted + ' 条'
  applyArchivedVisibility()
}

// Archive or restore one note, then reflect it in the summary and the selection.
function setResolved(entry, resolvedAt) {
  if (resolvedAt) entry.note.resolvedAt = resolvedAt
  else delete entry.note.resolvedAt
  if (isResolved(entry.note)) selected.delete(entry.note.id)
  refreshActions(entry)
  syncSummary()
  updateSelection()
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
    renderActions(entry)
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
  const archived = make('span', '', 'archived')
  const actions = make('div', '', 'note-actions')
  const entry = { checkbox, note, badge, time, body, actions, row, archived,
    edit: null, remove: null, accept: null, restore: null }
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
    }, edit, remove, accept, restore)
  })
  const accept = action('验收', () => {
    if (busy || mutations || editing || isResolved(note) || !confirm('验收并归档这条批注？')) return
    void change('PATCH', { group: note.group, id: note.id, resolved: true }, '已验收并归档。',
      ({ note: updated }) => setResolved(entry, updated?.resolvedAt ?? new Date().toISOString()),
      edit, remove, accept, restore)
  })
  const restore = action('恢复', () => {
    if (busy || mutations || editing || !isResolved(note)) return
    void change('PATCH', { group: note.group, id: note.id, resolved: false }, '批注已恢复为待处理。',
      ({ note: updated }) => setResolved(entry, isResolved(updated) ? updated.resolvedAt : null),
      edit, remove, accept, restore)
  })
  entry.edit = edit
  entry.remove = remove
  entry.accept = accept
  entry.restore = restore
  renderActions(entry)
  const meta = make('div', '', 'note-meta')
  meta.append(time, badge, archived)
  row.append(label, body, meta, actions)
  group.entries.push(entry)
  group.list.append(row)
  renderNoteBody(entry)
  mark(entry, note.submitted)
  checkbox.addEventListener('change', () => {
    if (isResolved(note)) return
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

archivedToggle.addEventListener('click', () => {
  if (busy || mutations || editing) return
  showArchived = !showArchived
  syncSummary()
  updateSelection()
})

// Accept every submitted, still-pending note in one go. Each PATCH is independent,
// so one failure keeps that note pending instead of blocking the others.
acceptSubmitted.addEventListener('click', async () => {
  if (busy || mutations || editing) return
  const targets = []
  for (const { entries } of groups.values()) {
    for (const entry of entries) {
      if (!isResolved(entry.note) && entry.note.submitted) targets.push(entry)
    }
  }
  if (!targets.length || !confirm('验收并归档已提交的 ' + targets.length + ' 条批注？')) return
  busy = true
  updateSelection()
  status('正在验收批注…')
  let failed = 0
  try {
    const results = await Promise.allSettled(targets.map(entry => request('api/annotations', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, digest, group: entry.note.group, id: entry.note.id, resolved: true }),
    })))
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        failed++
        return
      }
      setResolved(targets[index], result.value?.note?.resolvedAt ?? new Date().toISOString())
    })
    status(failed
      ? '有 ' + failed + ' 条批注归档失败，请刷新后重试。'
      : '已验收并归档 ' + targets.length + ' 条批注。', failed > 0)
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
