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
      showStatus()
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
      const { workspace } = await post('workspaces', fields)
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
    const button = event.target.closest('button[data-reset-workspace]')
    if (!button || !confirm('要归档当前图谱及其版本历史吗？之后可运行 dsh-threadlight refresh 重新生成。')) return
    const workspace = button.dataset.resetWorkspace
    const row = button.closest('li')
    const status = row.querySelector('.workspace-state')
    button.disabled = true
    status.classList.remove('error')
    status.textContent = '正在重置图谱…'
    try {
      await post('reset', { workspace })
      row.dataset.state = 'draft'
      status.textContent = '图谱已重置，请运行 dsh-threadlight refresh 重新生成'
      const link = row.querySelector('.workspace-open a')
      link.href = '?' + new URLSearchParams({ workspace, drafts: '1' })
      link.textContent = '打开草稿 →'
      link.setAttribute('aria-label', '打开草稿 · ' + row.querySelector('.workspace-meta strong').textContent)
      if (document.activeElement === button) link.focus()
      button.remove()
      if (filter.value === 'graph') filter.value = ''
      update()
    } catch (error) {
      status.textContent = error.message
      status.classList.add('error')
      button.disabled = false
    }
  })

  search.addEventListener('input', update)
  filter.addEventListener('change', update)
  update()
}
