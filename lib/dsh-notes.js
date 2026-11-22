const { workspace, digest, project, maxSelection } = JSON.parse(document.getElementById('notes-context').textContent)
const by = id => document.getElementById(id)
const reader = '?' + new URLSearchParams({ workspace })
by('return').href = by('empty-return').href = reader
by('project').textContent = project
const submit = by('submit')
const selected = new Set()
const groups = new Map()
const headers = { 'x-threadlight-client': 'review' }
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

function updateSelection() {
  for (const { checkbox, entries } of groups.values()) {
    let count = 0
    for (const entry of entries) {
      entry.checkbox.checked = selected.has(entry.note.id)
      entry.checkbox.disabled = busy
      if (entry.checkbox.checked) count++
    }
    checkbox.checked = count === entries.length
    checkbox.indeterminate = count > 0 && count < entries.length
    checkbox.disabled = busy
  }
  const exceedsLimit = selected.size > maxSelection
  by('selected').textContent = '已选 ' + selected.size + ' 条' + (exceedsLimit ? '（每次最多 ' + maxSelection + ' 条）' : '')
  submit.disabled = busy || !selected.size || exceedsLimit
  submit.textContent = busy ? '正在提交…' : '提交给 DSH'
}

function select(id, checked) {
  if (checked) selected.add(id)
  else selected.delete(id)
}

function groupSection(note) {
  const section = make('section')
  const header = make('div', '', 'group-heading')
  const label = make('label')
  const checkbox = make('input')
  checkbox.type = 'checkbox'
  checkbox.setAttribute('aria-label', '全选' + note.groupTitle + '的批注')
  label.append(checkbox, '全选')
  header.append(make('h2', note.groupTitle), label)
  const list = make('ul')
  section.append(header, list)
  by('groups').append(section)
  const entries = []
  checkbox.addEventListener('change', () => {
    for (const { note } of entries) select(note.id, checkbox.checked)
    updateSelection()
  })
  const group = { list, checkbox, entries }
  groups.set(note.group, group)
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

submit.addEventListener('click', async () => {
  busy = true
  updateSelection()
  status('正在向 DSH 提交批注…')
  try {
    const { submission } = await request('api/annotations-submit', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, digest, ids: [...selected] }),
    })
    const ids = new Set(submission.noteIds)
    for (const { entries } of groups.values()) {
      for (const entry of entries) {
        if (ids.has(entry.note.id) && Date.parse(submission.submittedAt) >= (Date.parse(entry.note.submitted?.submittedAt) || 0)) {
          mark(entry, { sessionId: submission.sessionId, submittedAt: submission.submittedAt })
        }
      }
    }
    selected.clear()
    status('已提交到 DSH · 会话 ' + submission.sessionId)
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = false
    updateSelection()
  }
})

async function load() {
  try {
    const { notes } = await request('api/annotations?' + new URLSearchParams({ workspace, digest, all: '1' }), { headers })
    by('total').textContent = notes.length + ' 条批注'
    by('empty').hidden = notes.length > 0
    for (const note of notes) showNote(note)
    updateSelection()
    status('')
  } catch (error) {
    status(error.message, true)
  }
}

void load()
