const root = document.documentElement
const byId = id => document.getElementById(id)

if (root.dataset.page === 'intro') {
  try {
    if (!sessionStorage.getItem('threadlight-intro-v1')) {
      root.classList.add('intro')
      sessionStorage.setItem('threadlight-intro-v1', 'seen')
    }
  } catch {
    root.classList.add('intro')
  }
  document.addEventListener('focusin', () => root.classList.remove('intro'), { once: true })
}

async function post(route, body) {
  const response = await fetch('api/' + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-threadlight-client': 'review' },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error || '请求失败，请重试。')
  return result
}

if (root.dataset.page === 'create') {
  const form = byId('create-form')
  const path = byId('workspace-path')
  const modes = byId('workspace-modes')
  const status = byId('create-status')
  const picker = byId('pick-directory')
  let busy = false

  function showStatus(message = '', error = false) {
    status.textContent = message
    status.classList.toggle('error', error)
  }

  async function run(message, action) {
    if (busy) return
    busy = true
    const controls = [...form.querySelectorAll('input:enabled, button:enabled')]
    for (const control of controls) control.disabled = true
    showStatus(message)
    try {
      const result = await action()
      if (result?.keepStatus !== true) showStatus()
      return result
    } catch (error) {
      showStatus(error.message, true)
    } finally {
      busy = false
      for (const control of controls) control.disabled = false
    }
  }

  if (modes) {
    const pathLabel = byId('workspace-path-label')
    const folderField = byId('workspace-folder-field')
    const folder = byId('workspace-folder')
    const paths = new Map()
    let mode = form.elements.mode.value

    function applyMode() {
      const createsFolder = mode === 'new'
      pathLabel.textContent = createsFolder ? '父目录' : '项目目录'
      folderField.hidden = folder.disabled = !createsFolder
    }

    applyMode()
    modes.addEventListener('change', () => {
      paths.set(mode, path.value)
      mode = form.elements.mode.value
      path.value = paths.get(mode) ?? ''
      applyMode()
      showStatus()
    })
  }

  picker?.addEventListener('click', async () => {
    const result = await run('请在系统目录选择器中选择项目目录。', () => post('workspace-directory', {}))
    if (result?.path) {
      path.value = result.path
      path.focus()
    } else {
      picker.focus()
    }
  })

  form.addEventListener('submit', event => {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(form))
    delete fields.mode
    void run('正在创建工作区…', async () => {
      const { workspace, session } = await post('workspaces', fields)
      if (session) {
        showStatus('工作区已创建，并已创建生成图谱的对话（会话 ' + String(session).slice(0, 8) +
          '）。图谱生成后会出现在「进入已有工作区」里。')
        return { keepStatus: true }
      }
      location.assign('?' + new URLSearchParams({ workspace }))
    })
  })
}

if (root.dataset.page === 'workspaces' && byId('workspace-list')) {
  const search = byId('workspace-search')
  const filter = byId('workspace-filter')
  const list = byId('workspace-list')
  const count = byId('workspace-count')
  const empty = byId('no-results')
  const rows = [...list.children].map(row => ({
    row,
    text: row.querySelector('.workspace-meta').textContent.toLowerCase(),
  }))

  function update() {
    const query = search.value.trim().toLowerCase()
    let visible = 0
    for (const { row, text } of rows) {
      row.hidden = !text.includes(query) || Boolean(filter.value && row.dataset.state !== filter.value)
      if (!row.hidden) visible++
    }
    count.textContent = visible + ' 个工作区'
    empty.hidden = visible > 0
  }

  list.addEventListener('click', async event => {
    const resetButton = event.target.closest('button[data-reset]')
    if (resetButton) {
      const workspace = resetButton.dataset.workspace
      if (!confirm('要归档当前发布的图谱吗？草稿、批注和实现报告会保留，工作图谱会随发布版本一起归档。')) return
      const row = resetButton.closest('li')
      const status = row.querySelector('.workspace-state')
      resetButton.disabled = true
      status.classList.remove('error')
      status.textContent = '正在归档…'
      try {
        await post('reset', { workspace })
        resetButton.remove()
        if (row.dataset.unpublished === 'true') {
          // The reset kept an unabsorbed working graph, so this workspace still
          // opens as a graph; only the published revision is gone.
          status.textContent = '已归档发布版本，工作图谱仍保留'
        } else {
          row.dataset.state = 'draft'
          status.textContent = '已归档发布版本'
          const open = row.querySelector('.workspace-open a')
          if (open) {
            const title = row.querySelector('.workspace-meta strong')?.textContent ?? ''
            open.textContent = '打开草稿 →'
            open.setAttribute('aria-label', '打开草稿 · ' + title)
          }
          if (filter.value && row.dataset.state !== filter.value) row.hidden = true
        }
        update()
      } catch (error) {
        status.textContent = error.message
        status.classList.add('error')
        resetButton.disabled = false
      }
      return
    }
    const button = event.target.closest('button[data-graph-mode]')
    if (!button) return
    const mode = button.dataset.graphMode
    const workspace = button.dataset.workspace
    if (mode === 'regenerate' && !confirm('要归档当前图谱，并让 AI 从头重新生成吗？旧版本会保留在 .threadlight/archive/ 下。')) return
    const row = button.closest('li')
    const status = row.querySelector('.workspace-state')
    button.disabled = true
    status.classList.remove('error')
    status.textContent = mode === 'regenerate' ? '正在归档并创建任务…' : '正在创建更新任务…'
    try {
      const { session } = await post('graph-session', { workspace, mode })
      status.textContent = (mode === 'regenerate' ? '已开始重新生成' : '已开始更新') +
        ' · 会话 ' + String(session).slice(0, 8)
      if (mode === 'regenerate') row.dataset.state = 'draft'
      if (filter.value && row.dataset.state !== filter.value) row.hidden = true
      update()
    } catch (error) {
      status.textContent = error.message
      status.classList.add('error')
    } finally {
      button.disabled = false
    }
  })

  search.addEventListener('input', update)
  filter.addEventListener('change', update)
  update()
}
