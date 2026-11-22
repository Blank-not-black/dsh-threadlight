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
      menu.replaceChildren(...actions.map(([label, run]) => action(label, () => { dismissMenu(true); run() })))
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
      const response = await fetch(url, { method, signal, ...(method !== 'GET' ? {
        headers: { 'content-type': 'application/json', 'x-threadlight-client': 'review' },
        body: JSON.stringify(values),
      } : {}) })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || '请求失败，请重新打开 Threadlight 后重试。')
      if (!result) throw new Error('无法读取 Threadlight 响应。')
      return result
    }

    function noteEditor(label, value = '') {
      const field = make('label', label)
      const editor = make('textarea')
      editor.maxLength = 3000
      editor.value = value
      field.append(editor)
      return { field, editor }
    }

    async function showNotes({ group, flow, step }, quote) {
      const target = step ? { kind: 'step', flow: flow.id, step: step.id } :
        flow ? { kind: 'flow', flow: flow.id } : { kind: 'group' }
      const heading = step ? '步骤批注' : flow ? '线路批注' : '模块批注'
      const { content, signal } = openDialog(heading + ' · ' + (step ?? flow ?? group).title)
      const { field, editor } = noteEditor('写批注')
      const status = make('p', '正在读取批注…', 'review-status')
      status.setAttribute('role', 'status')
      const notes = make('ul', '', 'review-notes')
      const fields = { group: group.id }
      const submitStatus = make('p', '', 'review-status')
      submitStatus.setAttribute('role', 'status')
      const submitLabel = '提交给 DSH（无需修改流程图）'
      let submitting = false, mutations = 0
      const submit = action(submitLabel, async () => {
        const ids = Array.from(notes.children, row => row.dataset.noteId)
        submitting = true
        updateSubmit()
        submitStatus.textContent = '正在向 DSH 提交批注…'
        try {
          const { submission } = await api('api/annotations-submit', { ids }, signal)
          if (!signal.aborted) submitStatus.textContent = '已提交到 DSH · 会话 ' + submission.sessionId
        } catch (error) {
          if (!signal.aborted) submitStatus.textContent = error.message
        } finally {
          submitting = false
          updateSubmit()
        }
      })

      function updateSubmit() {
        submit.disabled = submitting || mutations > 0 || notes.children.length === 0
        submit.textContent = submitting ? '正在提交…' : submitLabel
      }

      async function change(method, body, message, apply, ...controls) {
        mutations++
        updateSubmit()
        controls.forEach(control => { control.disabled = true })
        try {
          const result = await api('api/annotations', { ...fields, ...body }, signal, method)
          if (!signal.aborted) {
            apply(result)
            status.textContent = message
          }
        } catch (error) {
          if (!signal.aborted) status.textContent = error.message
        } finally {
          controls.forEach(control => { control.disabled = false })
          mutations--
          updateSubmit()
        }
      }

      function hasText(input) {
        if (input.value.trim()) return true
        status.textContent = '请输入批注。'
        input.focus()
        return false
      }

      function renderNote(row, note) {
        row.replaceChildren()
        if (note.quote) row.append(make('blockquote', note.quote))
        const body = make('div')
        const timestamp = note.updatedAt ?? note.createdAt
        const date = make('time', (note.updatedAt ? '修改于 ' : '') + new Date(timestamp).toLocaleString())
        date.dateTime = timestamp
        const controls = make('div', '', 'review-note-actions')
        const edit = action('修改', () => {
          const { field, editor } = noteEditor('修改批注', note.text)
          const saveEdit = action('保存修改', () => {
            if (hasText(editor)) void change('PATCH', { id: note.id, text: editor.value }, '批注已修改。',
              ({ note }) => renderNote(row, note).focus(), editor, saveEdit, cancel)
          })
          const cancel = action('取消', () => renderNote(row, note).focus())
          body.replaceChildren(field)
          controls.replaceChildren(saveEdit, cancel)
          editor.focus()
        })
        const remove = action('删除', () => {
          if (!confirm('删除这条批注？')) return
          void change('DELETE', { id: note.id }, '批注已删除。', () => {
            row.remove()
            editor.focus()
          }, edit, remove)
        })
        body.append(make('p', note.text))
        controls.append(edit, remove)
        row.append(body, date, controls)
        return edit
      }

      function noteRow(note) {
        const row = make('li')
        row.dataset.noteId = note.id
        renderNote(row, note)
        return row
      }

      const save = action('保存批注', () => {
        if (hasText(editor)) {
          void change('POST', { target, quote, text: editor.value }, '批注已保存。', ({ note }) => {
            notes.prepend(noteRow(note))
            editor.value = ''
            editor.focus()
          }, editor, save)
        }
      })
      save.disabled = true
      content.append(notes)
      if (quote) content.append(make('blockquote', quote))
      content.append(field, save, status, submit, submitStatus)
      updateSubmit()
      editor.focus()
      try {
        const result = await api('api/annotations', fields, signal, 'GET')
        const matching = result.notes.filter(note => note.target.kind === target.kind &&
          note.target.flow === target.flow && note.target.step === target.step)
        notes.append(...matching.map(noteRow))
        status.textContent = matching.length ? '' : '这里还没有批注。'
        save.disabled = false
        updateSubmit()
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

    function textTarget(scope) {
      const { group, flow } = getCurrent(scope)
      const id = scope.dataset.reviewStep || scope.dataset.reviewText
      return { group, flow, step: id ? flow.nodes.find(node => node.id === id) : undefined }
    }

    function selectedText(target) {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return null
      const scopeOf = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('[data-review-text]')
      const scope = scopeOf(selection.anchorNode)
      const end = scopeOf(selection.focusNode), clicked = scopeOf(target)
      if (!scope || !end || !clicked) return null
      const context = textTarget(scope)
      const sameTarget = other => other.group === context.group && other.flow === context.flow && other.step === context.step
      if (!sameTarget(textTarget(end)) || !sameTarget(textTarget(clicked))) return null
      const quote = selection.toString()
      if (!quote.trim()) return null
      return { context, quote, canExplain: scope === end }
    }

    const noteButton = action('模块批注', () => { void showNotes({ group: getCurrent().group }) }, 'review-button')
    function draftUrl(fields = {}) {
      return '?' + new URLSearchParams({ workspace: data.review.workspace, drafts: '1', ...fields })
    }
    const draftsLink = make('a', '流程草稿')
    draftsLink.href = draftUrl()
    const notesLink = make('a', '批注箱')
    notesLink.href = '?' + new URLSearchParams({ notes: data.review.workspace })
    const copyButton = action('从此线路建草稿', () => {
      const { group, flow } = getCurrent()
      location.href = draftUrl({ group: group.id, flow: flow.id })
    }, 'review-button')
    document.querySelector('.header-actions').prepend(draftsLink, copyButton, notesLink, noteButton)
    function showContext(event) {
      if (!(event.target instanceof Element) || dialog.open || menu.contains(event.target)) return
      const selection = selectedText(event.target)
      if (selection) {
        const { context: { group, flow, step }, quote, canExplain } = selection
        const fields = { group: group.id, flow: flow.id, step: step?.id ?? null, text: quote.trim() }
        const actions = canExplain ? [
          ['询问含义', () => ask(fields, 'meaning')],
          ['进一步讲解', () => ask(fields, 'deeper')],
        ] : []
        actions.push(['批注所选文字', () => showNotes(selection.context, quote)])
        openMenu(event, actions, event.target.closest('button') ?? event.target)
        return
      }
      const text = event.target.closest('[data-review-step]') ?? event.target.closest('[data-review-text]') ??
        event.target.closest('[data-overview-flow]')
      if (text) {
        const context = textTarget(text)
        openMenu(event, [[context.step ? '批注这一步' : '线路批注', () => showNotes(context)]], text)
        return
      }
      const heading = event.target.closest('[data-review-group]') ??
        event.target.querySelector(':scope > .tree-row[data-review-group]')
      const group = heading && data.groups.find(group => group.id === heading.dataset.reviewGroup)
      if (group) openMenu(event, [['模块批注', () => showNotes({ group })]], heading)
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
