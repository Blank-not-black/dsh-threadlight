import { createDraftDiagram } from './draft-diagram.js'

const by = id => document.getElementById(id)
const config = JSON.parse(by('draft-context').textContent)
const inspector = by('inspector')
const picker = by('draft-picker')
const diagram = createDraftDiagram(by('canvas'), {
  select: target => select(target, false), connect: (from, to) => connect(from, to, false), edit: editDiagram,
  message: text => status(text, true),
})
const flowFields = [['flow-title', 'title'], ['flow-summary', 'summary'], ['acceptance', 'acceptance']]
const sidebars = new Map([...document.querySelectorAll('[data-sidebar]')].map(button => [
  button.dataset.sidebar, { button, panel: by(button.getAttribute('aria-controls')) },
]))
let draft, selection, pendingNote = '', dirty = false, busy = false

function setSidebar(name, expanded) {
  const { button, panel } = sidebars.get(name)
  panel.hidden = !expanded
  button.setAttribute('aria-expanded', String(expanded))
}

function focusInspector(query) {
  setSidebar('details', true)
  inspector.querySelector(query)?.focus()
}

function make(tag, text = '', css = '') {
  const element = document.createElement(tag)
  element.textContent = text
  if (css) element.className = css
  return element
}

function action(text, click, css) {
  const button = make('button', text, css)
  button.type = 'button'
  button.addEventListener('click', click)
  return button
}

function field(label, control) {
  const element = make('label', label)
  element.append(control)
  return element
}

function editor(label, value, max, change, multiline = false) {
  const input = make(multiline ? 'textarea' : 'input')
  input.value = value
  input.maxLength = max
  if (multiline) input.rows = 3
  input.addEventListener('input', () => change(input.value))
  return field(label, input)
}

function status(text, error = false) {
  by('status').textContent = text
  by('status').classList.toggle('error', error)
}

function updateActions() {
  by('editor').inert = busy
  picker.disabled = busy
  by('new-draft').disabled = busy
  by('save').disabled = busy || !dirty && (draft.version > 0 || !draft.base)
  by('submit').disabled = busy || !config.canSubmit || !dirty && Boolean(draft.submission)
}

function changed() {
  dirty = true
  status('有未保存的改动')
  updateActions()
}

function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function newDraft(seed = null) {
  return { id: uuid(), version: 0, base: seed?.base ?? null,
    plan: seed?.plan ?? { title: '', summary: '', acceptance: '', nodes: [], edges: [], notes: [] } }
}

function syncUrl() {
  const url = new URL(location.href)
  url.searchParams.delete('group')
  url.searchParams.delete('flow')
  url.searchParams.set('drafts', '1')
  if (draft.version) url.searchParams.set('id', draft.id)
  else url.searchParams.delete('id')
  history.replaceState(null, '', url)
}

function showDraft(next) {
  draft = next
  dirty = false
  pendingNote = ''
  selection = draft.plan.nodes[0] ? { step: draft.plan.nodes[0].id } : {}
  for (const [id, key] of flowFields) by(id).value = draft.plan[key]
  const base = by('base')
  base.hidden = !draft.base
  base.textContent = draft.base ? '来自「' + draft.base.groupTitle + '」的已有线路' : ''
  if (config.hasGraph) {
    const target = '?' + new URLSearchParams({ workspace: config.workspace })
    by('back').href = draft.base ? target + '#' + draft.base.group + '/' + draft.base.flow : target
  }
  picker.value = draft.version ? draft.id : ''
  render({ reset: true })
  updateActions()
  reportDraft()
}

function reportDraft() {
  if (draft.submission) {
    const version = draft.submission.version
    const title = 'Threadlight · ' + draft.plan.title.slice(0, 120) + ' · v' + version
    status('已提交第 ' + version + ' 版。在 DSH 工作区查看「' + title + '」。')
  } else if (!config.canSubmit) status('当前 DSH profile 支持保存草稿，会话提交暂不可用。')
  else status(draft.version ? '已保存第 ' + draft.version + ' 版' : '新草稿')
}

async function request(route, fields = {}, method = 'GET') {
  const body = { ...fields, workspace: config.workspace }
  const response = await fetch('api/' + route + (method === 'GET' ? '?' + new URLSearchParams(body) : ''), method === 'GET'
    ? undefined : {
      method, headers: { 'content-type': 'application/json', 'x-threadlight-client': 'review' },
      body: JSON.stringify(body),
    })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error || '请求失败，请重试。')
  return result
}

async function run(operation) {
  if (busy) return
  busy = true
  updateActions()
  try {
    await operation()
  } catch (error) {
    picker.value = draft.version ? draft.id : ''
    status(error.message, true)
  } finally {
    busy = false
    updateActions()
  }
}

async function listDrafts() {
  const { drafts } = await request('drafts')
  picker.replaceChildren(new Option('新草稿', ''), ...drafts.map(item =>
    new Option((item.title || '未命名线路') + ' · 第 ' + item.version + ' 版', item.id)))
  picker.value = draft.version ? draft.id : ''
}

async function saveDraft() {
  commitNote()
  const { id, version, plan, base } = draft
  const result = await request('drafts', { id, version, plan, ...(version === 0 && base ? { base } : {}) }, 'POST')
  draft = result.draft
  dirty = false
  syncUrl()
  const existing = [...picker.options].find(option => option.value === draft.id)
  const title = (draft.plan.title || '未命名线路') + ' · 第 ' + draft.version + ' 版'
  if (existing) existing.textContent = title
  else picker.add(new Option(title, draft.id))
  picker.value = draft.id
  render()
  reportDraft()
}

function changeDraft(id) {
  return run(async () => {
    if (dirty) await saveDraft()
    if (id) showDraft((await request('drafts', { id })).draft)
    else showDraft(newDraft())
    syncUrl()
  })
}

function nodeTitle(id) {
  return draft.plan.nodes.find(node => node.id === id)?.title || '未命名步骤'
}

function select(target, focus = true) {
  commitNote()
  selection = target
  render()
  if (focus) focusInspector('input,select,textarea')
}

function addStep(from, kind) {
  commitNote()
  const node = { id: 'step-' + uuid(), title: '', summary: '' }
  draft.plan.nodes.push(node)
  if (from) {
    const edge = { id: 'edge-' + uuid(), from, to: node.id, kind, label: '' }
    draft.plan.edges.push(edge)
    selection = kind === 'branch' ? { edge: edge.id } : { step: node.id }
  } else selection = { step: node.id }
  changed()
  render()
  focusInspector('input,select')
}

function removeEdge(id) {
  commitNote()
  const edge = draft.plan.edges.find(edge => edge.id === id)
  draft.plan.edges = draft.plan.edges.filter(edge => edge.id !== id)
  draft.plan.notes = draft.plan.notes.filter(note => note.edge !== id)
  selection = { step: edge.from }
  changed()
  render()
}

function removeNode(id) {
  commitNote()
  const removed = new Set(draft.plan.edges.filter(edge => edge.from === id || edge.to === id).map(edge => edge.id))
  draft.plan.nodes = draft.plan.nodes.filter(node => node.id !== id)
  if (draft.plan.layout) draft.plan.layout = draft.plan.layout.filter(position => position.step !== id)
  draft.plan.edges = draft.plan.edges.filter(edge => !removed.has(edge.id))
  draft.plan.notes = draft.plan.notes.filter(note => note.step !== id && !removed.has(note.edge))
  selection = draft.plan.nodes.length ? { step: draft.plan.nodes[0].id } : {}
  changed()
  render()
}

function edgeTitle(edge) {
  return (edge.label || ({ sequence: '接着', branch: '条件待填写', merge: '汇合' })[edge.kind]) + ' → ' + nodeTitle(edge.to)
}

function findConnection(from, to, kind, id) {
  return draft.plan.edges.find(edge => edge.id !== id && edge.from === from && edge.to === to && edge.kind === kind)
}

function connect(from, to, focus = true) {
  const existing = findConnection(from, to, 'sequence')
  const edge = existing ?? { id: 'edge-' + uuid(), from, to, kind: 'sequence', label: '' }
  if (!existing) {
    draft.plan.edges.push(edge)
    changed()
  }
  select({ edge: edge.id }, focus)
}

function updateConnection(edge, from, to) {
  if (!from || !to || from === to || findConnection(from, to, edge.kind, edge.id)) return false
  Object.assign(edge, { from, to })
  return true
}

function editDiagram(positions, connections) {
  if (positions) draft.plan.layout = positions
  for (const [id, edit] of connections) {
    const edge = draft.plan.edges.find(item => item.id === id)
    if (!edge) continue
    if (edit.waypoints) {
      delete edge.bend
      if (edit.waypoints.length) edge.waypoints = edit.waypoints
      else delete edge.waypoints
    } else {
      updateConnection(edge, edit.from, edit.to)
    }
  }
  changed()
  render()
}

function renderMap(options) {
  diagram.render(draft.plan, selection, options)
  const steps = by('diagram-step')
  steps.replaceChildren(new Option('线路批注', ''), ...draft.plan.nodes.map(step => new Option(nodeTitle(step.id), step.id)))
  steps.value = selection.step ?? ''
  by('empty-diagram').hidden = draft.plan.nodes.length > 0
  by('diagram-controls').hidden = !draft.plan.nodes.length
}

function nodeEditor(node) {
  const update = key => value => { node[key] = value; changed(); renderMap() }
  const buttons = make('div', '', 'links')
  buttons.append(action('接一个新步骤', () => addStep(node.id, 'sequence')),
    action('添加条件分支', () => addStep(node.id, 'branch')), action('移除步骤', () => removeNode(node.id), 'remove'))
  inspector.append(make('h2', '编辑步骤'), editor('步骤名称', node.title, 160, update('title')),
    editor('发生什么', node.summary, 6000, update('summary'), true), buttons)
  const edges = draft.plan.edges.filter(edge => edge.from === node.id)
  if (edges.length) {
    const links = make('ul', '', 'edge-list')
    for (const edge of edges) {
      const row = make('li')
      row.append(action(edgeTitle(edge), () => select({ edge: edge.id })))
      links.append(row)
    }
    inspector.append(links)
  }
  const targets = draft.plan.nodes.filter(target => target.id !== node.id)
  if (targets.length) {
    const target = make('select')
    target.append(new Option('选择一个步骤', ''), ...targets.map(step => new Option(nodeTitle(step.id), step.id)))
    inspector.append(field('连接到已有步骤', target), action('添加连线', () => {
      if (!target.value) { target.focus(); return }
      connect(node.id, target.value)
    }))
  }
}

function endpointEditor(edge, end, label) {
  const input = make('select')
  const opposite = end === 'from' ? edge.to : edge.from
  for (const node of draft.plan.nodes) {
    const from = end === 'from' ? node.id : edge.from
    const to = end === 'to' ? node.id : edge.to
    if (node.id !== opposite && !findConnection(from, to, edge.kind, edge.id)) {
      input.add(new Option(nodeTitle(node.id), node.id))
    }
  }
  input.value = edge[end]
  input.dataset.end = end
  input.addEventListener('change', () => {
    const from = end === 'from' ? input.value : edge.from
    const to = end === 'to' ? input.value : edge.to
    if (!updateConnection(edge, from, to)) return
    changed()
    render()
    inspector.querySelector('select[data-end="' + end + '"]')?.focus()
  })
  return field(label, input)
}

function edgeEditor(edge) {
  const kind = make('select')
  kind.dataset.edgeKind = ''
  kind.append(new Option('依序执行', 'sequence'), new Option('条件分支', 'branch'), new Option('汇合', 'merge'))
  kind.value = edge.kind
  kind.addEventListener('change', () => {
    if (draft.plan.edges.some(link => link !== edge && link.from === edge.from && link.to === edge.to && link.kind === kind.value)) {
      kind.value = edge.kind
      status('这两个步骤间已有这种连线。', true)
      return
    }
    edge.kind = kind.value
    changed()
    render()
    inspector.querySelector('[data-edge-kind]')?.focus()
  })
  const buttons = make('div', '', 'links')
  buttons.append(action('回到前一步', () => select({ step: edge.from })),
    action('编辑目标步骤', () => select({ step: edge.to })), action('移除连线', () => removeEdge(edge.id), 'remove'))
  if (edge.bend || edge.waypoints?.length) buttons.append(action('恢复自动走线', () => {
    delete edge.bend
    delete edge.waypoints
    changed()
    render()
  }))
  inspector.append(make('h2', '编辑连线'), make('p', nodeTitle(edge.from) + ' → ' + nodeTitle(edge.to), 'muted'),
    endpointEditor(edge, 'from', '起点'), endpointEditor(edge, 'to', '终点'),
    field('连线类型', kind), editor('触发条件', edge.label, 120, value => { edge.label = value; changed(); renderMap() }), buttons)
}

function commitNote() {
  if (pendingNote.trim()) {
    draft.plan.notes.push({ id: 'note-' + uuid(), step: selection.step ?? null, edge: selection.edge ?? null,
      text: pendingNote, selected: true })
  }
  pendingNote = ''
}

function notesEditor() {
  const step = selection.step ?? null, edge = selection.edge ?? null
  const region = make('section', '', 'notes')
  const comment = make('textarea')
  comment.rows = 2
  comment.maxLength = 3000
  comment.value = pendingNote
  comment.placeholder = '写下希望 DSH 调整的行为或原因'
  const list = make('ul', '', 'note-list')
  for (const note of draft.plan.notes.filter(note => note.step === step && note.edge === edge)) {
    const row = make('li'), actions = make('div', '', 'links')
    const selected = make('input')
    selected.type = 'checkbox'
    selected.checked = note.selected
    selected.addEventListener('change', () => { note.selected = selected.checked; changed() })
    actions.append(field('随任务提交', selected), action('移除批注', () => {
      draft.plan.notes = draft.plan.notes.filter(item => item !== note)
      changed()
      renderInspector()
    }, 'remove'))
    row.append(make('p', note.text), actions)
    list.append(row)
  }
  const add = action('添加批注', () => {
    commitNote()
    changed()
    renderInspector()
    inspector.querySelector('.notes textarea').focus()
  })
  add.disabled = !pendingNote.trim()
  comment.addEventListener('input', () => {
    pendingNote = comment.value
    add.disabled = !pendingNote.trim()
    changed()
  })
  const heading = step ? '步骤批注' : edge ? '连线批注' : '线路批注'
  region.append(make('h3', heading), field('给 DSH 的意见', comment), add, list)
  inspector.append(region)
}

function renderInspector() {
  inspector.replaceChildren()
  const node = draft.plan.nodes.find(node => node.id === selection.step)
  const edge = draft.plan.edges.find(edge => edge.id === selection.edge)
  if (node) nodeEditor(node)
  if (edge) edgeEditor(edge)
  if (node || edge) inspector.append(action('查看线路批注', () => select({}), 'links'))
  notesEditor()
}

function render(options) {
  renderMap(options)
  renderInspector()
}

by('project').textContent = config.project + ' · Threadlight'
if (config.hasGraph) {
  by('back').textContent = '查看已有图谱'
}
const initiallyOpen = new URL(location.href).searchParams.get('id')
for (const [name, { button, panel }] of sidebars) {
  button.addEventListener('click', () => setSidebar(name, panel.hidden))
}
showDraft(newDraft(config.seed))
if (config.seed?.step) {
  selection = { step: config.seed.step }
  render()
  focusInspector('.notes textarea')
}
for (const [id, key] of flowFields) by(id).addEventListener('input', event => {
  draft.plan[key] = event.target.value
  changed()
})
by('add-step').addEventListener('click', () => addStep())
by('new-draft').addEventListener('click', () => changeDraft(''))
picker.addEventListener('change', () => changeDraft(picker.value))
by('save').addEventListener('click', () => run(saveDraft))
by('submit').addEventListener('click', () => run(async () => {
  const { title, summary, acceptance, nodes, edges } = draft.plan
  if (![title, summary, acceptance].every(value => value.trim())) {
    setSidebar('plan', true)
    throw new Error('提交前请填写线路名称、目标与范围以及验收条件。')
  }
  if (!nodes.length || nodes.some(node => !node.title.trim() || !node.summary.trim())) {
    throw new Error('提交前请至少添加一个步骤，并填写每一步的名称和说明。')
  }
  if (edges.some(edge => edge.kind === 'branch' && !edge.label.trim())) throw new Error('请为每条条件分支填写触发条件。')
  if (dirty || !draft.version) await saveDraft()
  status('正在提交给 DSH…')
  const { submission } = await request('draft-submit', { id: draft.id, version: draft.version }, 'POST')
  draft.submission = submission
  reportDraft()
}))
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = '' }
})
by('diagram-step').addEventListener('change', event => select(event.target.value ? { step: event.target.value } : {}))
by('zoom-in').addEventListener('click', () => diagram.zoom(1))
by('zoom-out').addEventListener('click', () => diagram.zoom(-1))
by('fit-diagram').addEventListener('click', () => diagram.fit())
by('auto-layout').addEventListener('click', () => {
  if (draft.plan.layout?.length) {
    delete draft.plan.layout
    changed()
  }
  renderMap({ reset: true })
})
void run(async () => {
  await listDrafts()
  if (initiallyOpen) showDraft((await request('drafts', { id: initiallyOpen })).draft)
})
