import { readFile } from 'node:fs/promises'
import { withUi } from './ui.mjs'

const template = await readFile(new URL('./dsh-launch.html', import.meta.url), 'utf8')
const workspaceTemplate = await readFile(new URL('./dsh-workspace-page.html', import.meta.url), 'utf8')
export const launchAssets = new Map(await Promise.all([
  ['launch.js', './dsh-launch.js', 'text/javascript'],
  ['launch.css', './dsh-launch.css', 'text/css'],
].map(async ([name, path, type]) => {
  const text = await readFile(new URL(path, import.meta.url), 'utf8')
  return [name, { type, text: type === 'text/css' ? withUi(text) : text }]
})))

function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return text.replace(/[&<>"]/g, character => entities[character])
}

export function renderLauncher() {
  return template
}

function renderWorkspacePage(view, title, content) {
  const replacements = {
    view, title, content,
    'create-current': view === 'create' ? ' aria-current="page"' : '',
    'workspaces-current': view === 'workspaces' ? ' aria-current="page"' : '',
  }
  return workspaceTemplate.replace(/\{\{([a-z-]+)\}\}/g, (_, key) => replacements[key])
}

export function renderCreateWorkspace(picker) {
  const browse = picker === 'browse'
  const native = picker === 'native'
  const modes = browse ? `
      <fieldset class="workspace-modes" id="workspace-modes">
        <legend>项目目录</legend>
        <label><input type="radio" name="mode" value="new" checked> 新建目录</label>
        <label><input type="radio" name="mode" value="existing"> 使用已有目录</label>
      </fieldset>` : ''
  const hint = native ? '可在系统目录选择器中新建文件夹，再选中它。' : '填写 DSH 所在电脑上的绝对路径。'
  const folder = browse ? `
      <div id="workspace-folder-field" class="workspace-field">
        <label for="workspace-folder">新目录名称</label>
        <input id="workspace-folder" name="folder" maxlength="120" placeholder="例如 my-project" required>
      </div>` : ''
  return renderWorkspacePage('create', '创建新工作区', `
    <form id="create-form" class="workspace-form" autocomplete="off">
      ${modes}
      <div class="workspace-field">
        <label id="workspace-path-label" for="workspace-path">${browse ? '父目录' : '项目目录'}</label>
        <div class="path-field">
          <input id="workspace-path" name="path" maxlength="1024" placeholder="输入绝对路径" aria-describedby="workspace-path-hint" required>
          ${native ? '<button type="button" class="workspace-button" id="pick-directory">选择目录</button>' : ''}
        </div>
        <p class="field-hint" id="workspace-path-hint">${hint}</p>
      </div>${folder}
      <div class="workspace-field">
        <label for="workspace-title">工作区名称 <span>（可选）</span></label>
        <input id="workspace-title" name="title" maxlength="160" placeholder="默认使用项目目录名称">
      </div>
      <label class="workspace-generate"><input type="checkbox" id="workspace-generate" name="generate" value="1" checked>
        创建后生成图谱 <span>会新建一个对话，按项目代码梳理功能线路</span></label>
      <p class="workspace-status" id="create-status" role="status" aria-live="polite"></p>
      <div class="workspace-actions">
        <a class="workspace-button" href="./">取消</a>
        <button type="submit" class="workspace-button primary">创建并进入 <span aria-hidden="true">→</span></button>
      </div>
    </form>`)
}

const stateLabels = {
  graph: '已有图谱',
  draft: '可编辑草稿',
  unavailable: '目录不可用',
  issue: '读取失败',
}

export function renderWorkspaceList(workspaces, message = '') {
  const alert = message ? '<p class="workspace-alert" role="alert">' + escapeHtml(message) + '</p>' : ''
  if (!workspaces.length) return renderWorkspacePage('workspaces', '进入已有工作区', alert + `
    <div class="workspace-empty">
      <p>还没有工作区。</p>
      <a class="workspace-button primary" href="?view=create">创建新工作区 <span aria-hidden="true">→</span></a>
    </div>`)

  const options = Object.entries(stateLabels).map(([state, label]) => `<option value="${state}">${label}</option>`).join('')
  const rows = workspaces.map(({ id, title, path, state, canReset }) => {
    const action = { graph: '打开图谱', draft: '打开草稿' }[state]
    const link = action ? `<a class="workspace-button" href="?workspace=${encodeURIComponent(id)}" aria-label="${action} · ${escapeHtml(title)}">${action} <span aria-hidden="true">→</span></a>` : ''
    // A published or draft workspace can ask the agent to refresh or rebuild
    // the graph; "重新生成" archives the current publication first on the host.
    const graphActions = (state === 'graph' || state === 'draft')
      ? `<button type="button" class="workspace-button" data-graph-mode="update" data-workspace="${escapeHtml(id)}" aria-label="更新图谱 · ${escapeHtml(title)}">更新图谱</button>` +
        `<button type="button" class="workspace-button" data-graph-mode="regenerate" data-workspace="${escapeHtml(id)}" aria-label="重新生成图谱 · ${escapeHtml(title)}">重新生成</button>`
      : ''
    return `<li data-state="${state}">
      <div class="workspace-meta">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(path)}</span>
      </div>
      <span class="workspace-state" role="status">${stateLabels[state]}</span>
      <div class="workspace-open">${link}${graphActions}</div>
    </li>`
  }).join('')
  return renderWorkspacePage('workspaces', '进入已有工作区', alert + `
    <div class="workspace-toolbar">
      <label class="visually-hidden" for="workspace-search">搜索工作区</label>
      <input id="workspace-search" type="search" placeholder="按名称或目录搜索" autocomplete="off">
      <label class="visually-hidden" for="workspace-filter">工作区状态</label>
      <select id="workspace-filter"><option value="">所有状态</option>${options}</select>
    </div>
    <p class="workspace-count" id="workspace-count" role="status">${workspaces.length} 个工作区</p>
    <ul class="workspace-list" id="workspace-list">${rows}</ul>
    <p class="workspace-empty" id="no-results" hidden>没有符合条件的工作区。</p>`)
}
