window.ThreadlightReview = {
  mount(data, getCurrent) {
    const menu = document.createElement('div')
    const dialog = document.createElement('dialog')
    menu.className = 'review-menu'
    menu.hidden = true
    dialog.className = 'review-dialog'
    dialog.setAttribute('aria-labelledby', 'review-title')
    document.body.append(menu, dialog)
    let request, menuOwner

    function make(tag, text, className) {
      const element = document.createElement(tag)
      if (text) element.textContent = text
      if (className) element.className = className
      return element
    }

    function action(label, onClick, css) {
      const control = make('button', label, css)
      control.type = 'button'
      control.addEventListener('click', onClick)
      return control
    }

    function dismissMenu(restore = false) {
      menu.hidden = true
      if (restore) menuOwner?.focus({ preventScroll: true })
    }

    function openMenu(event, actions, owner) {
      event.preventDefault()
      menuOwner = owner
      menu.replaceChildren(...actions.map(([label, run]) => action(label, () => { dismissMenu(); run() })))
      menu.hidden = false
      const ownerRect = owner.getBoundingClientRect()
      const x = event.clientX || ownerRect.left
      const y = event.clientY || ownerRect.bottom
      menu.style.left = Math.max(4, Math.min(innerWidth - menu.offsetWidth - 4, x)) + 'px'
      menu.style.top = Math.max(4, Math.min(innerHeight - menu.offsetHeight - 4, y)) + 'px'
      menu.firstElementChild.focus({ preventScroll: true })
    }

    function openDialog(title) {
      const heading = make('h2', title)
      heading.id = 'review-title'
      const content = make('div', '', 'review-content')
      dialog.replaceChildren(action('关闭', () => dialog.close(), 'review-close'), heading, content)
      dialog.showModal()
      request = new AbortController()
      return { content, signal: request.signal }
    }

    async function api(route, fields, signal, method = 'POST') {
      const values = { ...data.review, ...fields }
      const url = method === 'GET' ? route + '?' + new URLSearchParams(values) : route
      const response = await fetch(url, { method, signal, ...(method === 'POST' ? {
        headers: { 'content-type': 'application/json', 'x-threadlight-client': 'review' },
        body: JSON.stringify(values),
      } : {}) })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || '请求失败，请重新打开 Threadlight 后重试。')
      if (!result) throw new Error('无法读取 Threadlight 响应。')
      return result
    }

    async function showNotes(group) {
      const { content, signal } = openDialog(group.title + ' · 批注')
      const editor = make('textarea')
      editor.id = 'review-note'
      editor.maxLength = 3000
      const label = make('label', '写批注')
      label.htmlFor = editor.id
      const status = make('p', '正在读取批注…', 'review-status')
      status.setAttribute('role', 'status')
      const notes = make('ul', '', 'review-notes')
      function showNote(note) {
        const row = make('li')
        const date = make('time', new Date(note.createdAt).toLocaleString())
        date.dateTime = note.createdAt
        row.append(make('p', note.text), date)
        return row
      }
      const save = action('保存批注', async () => {
        if (!editor.value.trim()) {
          status.textContent = '请输入批注。'
          editor.focus()
          return
        }
        save.disabled = true
        try {
          const { note } = await api('api/annotations', { group: group.id, text: editor.value }, signal)
          notes.prepend(showNote(note))
          editor.value = ''
          status.textContent = '批注已保存。'
        } catch (error) {
          if (!signal.aborted) status.textContent = error.message
        } finally { save.disabled = false }
      })
      save.disabled = true
      content.append(label, editor, save, status, notes)
      editor.focus()
      try {
        const result = await api('api/annotations', { group: group.id }, signal, 'GET')
        notes.append(...result.notes.map(showNote))
        status.textContent = result.notes.length ? '' : '这个模块还没有批注。'
        save.disabled = false
      } catch (error) {
        if (!signal.aborted) status.textContent = error.message
      }
    }

    async function ask(selection, mode) {
      const { content, signal } = openDialog(mode === 'meaning' ? '这段话是什么意思' : '进一步讲解')
      const status = make('p', 'DSH 正在讲解…', 'review-status')
      status.setAttribute('role', 'status')
      const answer = make('div', '', 'review-answer')
      content.append(make('blockquote', selection.text), status, answer)
      try {
        const result = await api('api/explain', { ...selection, mode }, signal)
        answer.textContent = result.answer
        status.textContent = '讲解已完成。'
      } catch (error) {
        if (!signal.aborted) status.textContent = error.message
      }
    }

    function selectedText(target) {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return null
      const scopeOf = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('[data-review-text]')
      const scope = scopeOf(selection.anchorNode)
      if (!scope || scope !== scopeOf(selection.focusNode) || !scope.contains(target)) return null
      const text = selection.toString().trim()
      if (!text) return null
      const { group, flow } = getCurrent()
      return { group: group.id, flow: flow.id, step: scope.dataset.reviewText || null, text }
    }

    const noteButton = action('模块批注', () => { void showNotes(getCurrent().group) }, 'review-button')
    function draftUrl(fields = {}) {
      return '?' + new URLSearchParams({ workspace: data.review.workspace, drafts: '1', ...fields })
    }
    const draftsLink = make('a', '流程草稿')
    draftsLink.href = draftUrl()
    const copyButton = action('从此线路建草稿', () => {
      const { group, flow } = getCurrent()
      location.href = draftUrl({ group: group.id, flow: flow.id })
    }, 'review-button')
    document.querySelector('.header-actions').prepend(draftsLink, copyButton, noteButton)
    function showContext(event) {
      if (!(event.target instanceof Element)) return
      const selection = selectedText(event.target)
      if (selection) {
        openMenu(event, [
          ['询问含义', () => ask(selection, 'meaning')],
          ['进一步讲解', () => ask(selection, 'deeper')],
        ], event.target)
        return
      }
      const heading = event.target.closest('[data-review-group]')
      const group = heading && data.groups.find(group => group.id === heading.dataset.reviewGroup)
      if (group) openMenu(event, [['模块批注', () => showNotes(group)]], heading)
    }
    document.addEventListener('contextmenu', showContext)
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) dismissMenu() })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) dismissMenu(true)
      if (!dialog.open && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        showContext(event)
      }
    })
    dialog.addEventListener('close', () => request?.abort())
  },
}
