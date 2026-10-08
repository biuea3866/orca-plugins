// Local Self Review UI — vanilla ES modules, no build step.
import { createApi, ApiRequestError } from '/ui/lib/api.mjs'
import { beginSelection, extendSelection, clampRange, isLineSelected } from '/ui/lib/selection.mjs'
import { placeThreads, threadKey, countRunnable, countByFile } from '/ui/lib/threads.mjs'

const token = document.querySelector('meta[name="sr-token"]')?.content ?? ''
const api = createApi({ token })
const app = document.getElementById('app')
const noticeEl = document.getElementById('notice')

// ---------- utilities ----------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
function h(strings, ...values) {
  return strings.reduce((out, part, index) => out + part + (index < values.length ? (values[index] instanceof Raw ? values[index].html : escapeHtml(values[index])) : ''), '')
}
class Raw { constructor(html) { this.html = html } }
const raw = (html) => new Raw(html)
function formatDate(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString()
}
function showNotice(message, { error = false, timeout = 6000 } = {}) {
  noticeEl.textContent = message
  noticeEl.className = `notice${error ? ' error' : ''}`
  noticeEl.hidden = false
  clearTimeout(showNotice.timer)
  if (timeout) showNotice.timer = setTimeout(() => { noticeEl.hidden = true }, timeout)
}
function describeError(error) {
  if (error instanceof ApiRequestError) return `${error.message} (${error.code})`
  return error?.message ?? String(error)
}

// ---------- theme ----------
function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme)
  else document.documentElement.removeAttribute('data-theme')
}
function currentTheme() {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit) return explicit
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
try { applyTheme(localStorage.getItem('sr-theme')) } catch { /* ignore */ }
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try { localStorage.setItem('sr-theme', next) } catch { /* ignore */ }
})

// ---------- routing ----------
function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/'
  const parts = hash.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'overview' }
  if (parts[0] === 'sessions' && parts[1]) return { name: 'session', id: parts[1] }
  if (parts[0] === 'prs' && parts.length === 4) return { name: 'pr', owner: decodeURIComponent(parts[1]), repo: decodeURIComponent(parts[2]), number: Number(parts[3]) }
  return { name: 'overview' }
}
let activeView = null
async function render() {
  if (activeView?.dispose) activeView.dispose()
  activeView = null
  const route = parseRoute()
  app.innerHTML = '<p class="muted">로딩 중…</p>'
  try {
    if (route.name === 'overview') activeView = await renderOverview()
    else if (route.name === 'session') activeView = await renderSession(route.id)
    else if (route.name === 'pr') activeView = await renderPr(route)
  } catch (error) {
    app.innerHTML = h`<div class="card"><div class="card-body"><strong>오류</strong> ${describeError(error)}<p><a href="#/">오버뷰로</a></p></div></div>`
  }
}
window.addEventListener('hashchange', render)

async function bootstrap() {
  const params = new URLSearchParams(location.search)
  const target = params.get('target')
  if (target) {
    history.replaceState(null, '', location.pathname + location.hash)
    try {
      const context = await api.get(`/api/context?path=${encodeURIComponent(target)}`)
      const session = await api.post('/api/sessions', { kind: 'local', repoPath: context.repoPath, baseRef: context.defaultBase })
      location.hash = `#/sessions/${session.id}`
      if (location.hash === `#/sessions/${session.id}`) await render()
      return
    } catch (error) {
      showNotice(`세션을 열지 못했습니다: ${describeError(error)}`, { error: true, timeout: 0 })
    }
  }
  await render()
}

// ---------- overview ----------
async function renderOverview() {
  let overview = await api.get('/api/overview')
  const state = { repo: '', author: '', draftOnly: false }

  function draw() {
    const authors = [...new Set(overview.repos.flatMap((repo) => repo.prs.map((pr) => pr.author)))].sort()
    const prRows = overview.repos.flatMap((repo) => repo.prs.map((pr) => ({ repo, pr })))
      .filter(({ repo, pr }) => (!state.repo || repo.id === state.repo) && (!state.author || pr.author === state.author) && (!state.draftOnly || pr.isDraft))
      .sort((left, right) => String(right.pr.updatedAt).localeCompare(String(left.pr.updatedAt)))
    app.innerHTML = h`
      <div class="grid">
        <section>
          <div class="card">
            <div class="card-head">레포 · worktree <span class="muted small">(Orca 등록 기준)</span></div>
            <div class="card-body">
              ${raw(overview.repos.length === 0 ? '<p class="muted">Orca에 등록된 레포가 없습니다.</p>' : overview.repos.map((repo) => h`
                <div class="row" style="flex-direction:column;align-items:stretch">
                  <div><strong>${repo.displayName}</strong> <span class="muted small mono">${repo.path}</span></div>
                  ${raw(repo.worktrees.map((worktree) => h`
                    <div class="row" style="border-top:0;padding-left:8px">
                      <span class="mono">${worktree.branch || worktree.displayName}</span>
                      <span class="muted small mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${worktree.path}</span>
                      <button type="button" class="btn small" data-start-review="${worktree.path}">리뷰 시작</button>
                    </div>`).join(''))}
                </div>`).join(''))}
            </div>
          </div>
          <div class="card">
            <div class="card-head">로컬 리뷰 세션</div>
            <div class="card-body">
              ${raw(overview.sessions.length === 0 ? '<p class="muted">아직 세션이 없습니다.</p>' : overview.sessions.map((session) => h`
                <div class="row">
                  <a href="#/sessions/${session.id}"><strong>${session.repoDisplayName}</strong> <span class="mono">${session.branch}</span></a>
                  <span class="badge">${session.kind === 'pr' ? `PR #${session.pr?.number}` : `base ${session.baseRef}`}</span>
                  <span class="badge">${session.status}</span>
                  <span class="small muted">open ${session.threads.open} · resolved ${session.threads.resolved}</span>
                  <span class="small muted">${formatDate(session.updatedAt)}</span>
                  <button type="button" class="btn small danger" data-delete-session="${session.id}">삭제</button>
                </div>`).join(''))}
            </div>
          </div>
        </section>
        <section>
          <div class="card">
            <div class="card-head">Open PR — 전체 레포
              <span class="muted small">${overview.github.enabled ? `마지막 조회 ${formatDate(overview.github.lastFetchedAt)}` : 'gh CLI 없음 — PR 조회 비활성'}</span>
              <span style="flex:1"></span>
              <button type="button" class="btn small" id="refreshPrs">새로고침</button>
            </div>
            <div class="card-body">
              ${raw(overview.github.errors.length ? `<div class="notice" style="margin:0 0 8px">${overview.github.errors.map((entry) => h`<div><strong>${entry.repo}</strong>: ${entry.message}</div>`).join('')}</div>` : '')}
              <div class="filters">
                <label>레포 <select id="filterRepo"><option value="">전체</option>${raw(overview.repos.map((repo) => h`<option value="${repo.id}" ${raw(state.repo === repo.id ? 'selected' : '')}>${repo.displayName}</option>`).join(''))}</select></label>
                <label>작성자 <select id="filterAuthor"><option value="">전체</option>${raw(authors.map((author) => h`<option value="${author}" ${raw(state.author === author ? 'selected' : '')}>${author}</option>`).join(''))}</select></label>
                <label><input type="checkbox" id="filterDraft" ${raw(state.draftOnly ? 'checked' : '')}> Draft만</label>
                <span class="muted small">${prRows.length}건</span>
              </div>
              <table>
                <thead><tr><th>레포</th><th>#</th><th>제목</th><th>작성자</th><th>브랜치</th><th>변경</th><th>갱신</th></tr></thead>
                <tbody>
                  ${raw(prRows.length === 0 ? '<tr><td colspan="7" class="muted">표시할 PR이 없습니다.</td></tr>' : prRows.map(({ repo, pr }) => h`
                    <tr>
                      <td>${repo.displayName}</td>
                      <td><a href="#/prs/${encodeURIComponent(repo.github.owner)}/${encodeURIComponent(repo.github.repo)}/${pr.number}">#${pr.number}</a></td>
                      <td>${pr.isDraft ? raw('<span class="badge draft">Draft</span> ') : ''}<a href="#/prs/${encodeURIComponent(repo.github.owner)}/${encodeURIComponent(repo.github.repo)}/${pr.number}">${pr.title}</a></td>
                      <td>${pr.author}</td>
                      <td class="mono small">${pr.headRefName} → ${pr.baseRefName}</td>
                      <td class="small"><span class="add-count">+${pr.additions}</span> <span class="del-count">−${pr.deletions}</span> · ${pr.changedFiles}f</td>
                      <td class="small muted">${formatDate(pr.updatedAt)}</td>
                    </tr>`).join(''))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>`
    app.querySelector('#filterRepo').addEventListener('change', (event) => { state.repo = event.target.value; draw() })
    app.querySelector('#filterAuthor').addEventListener('change', (event) => { state.author = event.target.value; draw() })
    app.querySelector('#filterDraft').addEventListener('change', (event) => { state.draftOnly = event.target.checked; draw() })
    app.querySelector('#refreshPrs').addEventListener('click', async (event) => {
      event.target.disabled = true
      try { overview = await api.post('/api/overview/refresh'); draw() } catch (error) { showNotice(describeError(error), { error: true }) }
    })
    for (const button of app.querySelectorAll('[data-start-review]')) {
      button.addEventListener('click', async () => {
        button.disabled = true
        try {
          const context = await api.get(`/api/context?path=${encodeURIComponent(button.dataset.startReview)}`)
          const session = await api.post('/api/sessions', { kind: 'local', repoPath: context.repoPath, baseRef: context.defaultBase })
          location.hash = `#/sessions/${session.id}`
        } catch (error) { showNotice(describeError(error), { error: true }); button.disabled = false }
      })
    }
    for (const button of app.querySelectorAll('[data-delete-session]')) {
      button.addEventListener('click', async () => {
        if (!confirm('이 세션과 코멘트를 삭제할까요? (로컬에서만 삭제됩니다)')) return
        try { await api.delete(`/api/sessions/${button.dataset.deleteSession}`); overview = await api.get('/api/overview'); draw() } catch (error) { showNotice(describeError(error), { error: true }) }
      })
    }
  }
  draw()
  return {}
}

// ---------- diff viewer (shared) ----------
function createDiffViewer({ files, threads, canComment, onCreateThread, onThreadAction, onComment }) {
  const root = document.createElement('div')
  root.className = 'review-layout'
  const fileList = document.createElement('div')
  fileList.className = 'card file-list'
  const filePanelHost = document.createElement('div')
  root.append(fileList, filePanelHost)
  const state = { activePath: files[0]?.path ?? null, selection: null, dragging: false, pendingForm: null, expandedResolved: new Set(), collapsed: new Set() }
  let currentThreads = threads

  function drawFileList() {
    const counts = countByFile(currentThreads)
    fileList.innerHTML = `<div class="card-head">파일 ${files.length}개</div><div class="card-body" style="padding:4px"></div>`
    const body = fileList.querySelector('.card-body')
    if (files.length === 0) body.innerHTML = '<p class="muted" style="padding:8px">변경 사항이 없습니다.</p>'
    for (const file of files) {
      const item = document.createElement('div')
      item.className = `file-item${file.path === state.activePath ? ' active' : ''}`
      item.innerHTML = h`<span class="badge small">${{ added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' }[file.changeType] ?? '?'}</span><span class="name" title="${file.path}">${file.path}</span><span class="counts small"><span class="add-count">+${file.additions}</span> <span class="del-count">−${file.deletions}</span>${counts[file.path] ? raw(` <span class="badge">💬${counts[file.path]}</span>`) : ''}</span>`
      item.addEventListener('click', () => { state.activePath = file.path; state.collapsed.delete(file.path); redrawFile(file.path); drawFileList(); document.getElementById(fileDomId(file.path))?.scrollIntoView({ block: 'start' }) })
      body.append(item)
    }
  }

  function gutterCell(file, side, line, number) {
    const enabled = canComment && number !== null && !file.binary
    const cell = document.createElement('td')
    cell.className = `gutter ${side}${enabled ? '' : ' disabled'}`
    cell.textContent = number ?? ''
    if (enabled) {
      cell.tabIndex = 0
      cell.dataset.path = file.path
      cell.dataset.side = side
      cell.dataset.line = String(number)
      cell.title = '드래그 또는 Shift+클릭으로 범위 선택'
    }
    return cell
  }

  function lineRow(file, line) {
    const row = document.createElement('tr')
    row.className = line.type
    row.append(gutterCell(file, 'old', line, line.oldNo), gutterCell(file, 'new', line, line.newNo))
    const marker = document.createElement('td')
    marker.className = 'marker'
    marker.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''
    const code = document.createElement('td')
    code.className = 'code'
    code.textContent = line.text
    row.append(marker, code)
    for (const side of ['old', 'new']) {
      const number = side === 'old' ? line.oldNo : line.newNo
      if (number !== null && isLineSelected(state.selection, { path: file.path, side, line: number })) row.classList.add('selected')
    }
    return row
  }

  function threadRow(threadsHere, colspan) {
    const row = document.createElement('tr')
    row.className = 'thread-row'
    const cell = document.createElement('td')
    cell.colSpan = colspan
    for (const thread of threadsHere) cell.append(threadElement(thread))
    row.append(cell)
    return row
  }

  function threadElement(thread) {
    const element = document.createElement('div')
    const expanded = state.expandedResolved.has(thread.id)
    element.className = `thread${thread.status === 'resolved' ? ' resolved' : ''}${expanded ? ' expanded' : ''}`
    const range = thread.startLine === thread.endLine ? `L${thread.startLine}` : `L${thread.startLine}–L${thread.endLine}`
    element.innerHTML = h`
      <div class="thread-head">
        <span class="badge ${thread.status === 'open' ? 'open' : 'resolved'}">${thread.status === 'open' ? '열림' : '해결됨'}</span>
        ${thread.applicability === 'outdated' ? raw('<span class="badge outdated" title="현재 diff에서 선택 원문을 찾지 못했습니다">outdated</span>') : ''}
        <span class="mono">${thread.side} ${range}</span>
        <span class="spacer"></span>
        ${thread.status === 'resolved' ? raw(`<button type="button" class="btn small ghost" data-toggle>${expanded ? '접기' : '펼치기'}</button>`) : ''}
        <button type="button" class="btn small" data-thread-status="${thread.status === 'open' ? 'resolved' : 'open'}">${thread.status === 'open' ? '해결' : '다시 열기'}</button>
        <button type="button" class="btn small danger" data-thread-delete>삭제</button>
      </div>
      <div class="thread-body">
        ${raw(thread.comments.map((comment) => h`
          <div class="comment" data-comment="${comment.id}">
            <div class="meta"><span>나</span><span>${formatDate(comment.createdAt)}</span>${comment.updatedAt !== comment.createdAt ? raw('<span>(수정됨)</span>') : ''}<span class="spacer"></span><button type="button" class="btn small ghost" data-comment-edit>수정</button><button type="button" class="btn small ghost" data-comment-delete>삭제</button></div>
            <div class="body">${comment.body}</div>
          </div>`).join(''))}
        <div class="comment-form"><textarea placeholder="답글…" rows="2"></textarea><div class="actions"><button type="button" class="btn small primary" data-reply>답글</button></div></div>
      </div>`
    element.querySelector('[data-toggle]')?.addEventListener('click', () => { if (expanded) state.expandedResolved.delete(thread.id); else state.expandedResolved.add(thread.id); drawFile() })
    element.querySelector('[data-thread-status]').addEventListener('click', (event) => onThreadAction(thread, { status: event.currentTarget.dataset.threadStatus }))
    element.querySelector('[data-thread-delete]').addEventListener('click', () => { if (confirm('스레드를 삭제할까요?')) onThreadAction(thread, { delete: true }) })
    element.querySelector('[data-reply]').addEventListener('click', (event) => {
      const textarea = event.currentTarget.closest('.comment-form').querySelector('textarea')
      if (!textarea.value.trim()) return
      onComment(thread, { add: textarea.value })
    })
    for (const commentEl of element.querySelectorAll('[data-comment]')) {
      const commentId = commentEl.dataset.comment
      const comment = thread.comments.find((entry) => entry.id === commentId)
      commentEl.querySelector('[data-comment-delete]').addEventListener('click', () => { if (confirm('코멘트를 삭제할까요?')) onComment(thread, { delete: commentId }) })
      commentEl.querySelector('[data-comment-edit]').addEventListener('click', () => {
        const bodyEl = commentEl.querySelector('.body')
        bodyEl.innerHTML = h`<textarea rows="3">${comment.body}</textarea><div class="actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px"><button type="button" class="btn small" data-cancel>취소</button><button type="button" class="btn small primary" data-save>저장</button></div>`
        bodyEl.querySelector('[data-cancel]').addEventListener('click', () => drawFile())
        bodyEl.querySelector('[data-save]').addEventListener('click', () => onComment(thread, { edit: commentId, body: bodyEl.querySelector('textarea').value }))
      })
    }
    return element
  }

  function commentFormRow(colspan) {
    const row = document.createElement('tr')
    row.className = 'thread-row'
    const cell = document.createElement('td')
    cell.colSpan = colspan
    const { startLine, endLine } = clampRange(state.selection)
    const range = startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine} (${endLine - startLine + 1}줄)`
    cell.innerHTML = h`<div class="thread"><div class="thread-head"><span class="mono">${state.selection.side} ${range}</span><span class="spacer"></span><span class="muted small">같은 파일·같은 side, 최대 200줄</span></div>
      <div class="comment-form"><textarea autofocus placeholder="코멘트를 입력하세요 (⌘/Ctrl+Enter 로 등록)"></textarea><div class="actions"><button type="button" class="btn small" data-cancel>취소</button><button type="button" class="btn small primary" data-submit>코멘트 등록</button></div></div></div>`
    const textarea = cell.querySelector('textarea')
    const submit = () => { if (textarea.value.trim()) onCreateThread({ ...state.selection, startLine, endLine, body: textarea.value }) }
    cell.querySelector('[data-submit]').addEventListener('click', submit)
    cell.querySelector('[data-cancel]').addEventListener('click', () => { state.selection = null; state.pendingForm = null; drawFile() })
    textarea.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(); if (event.key === 'Escape') { state.selection = null; state.pendingForm = null; drawFile() } })
    row.append(cell)
    setTimeout(() => textarea.focus(), 0)
    return row
  }

  function fileDomId(path) { return 'file-' + String(path).replace(/[^a-zA-Z0-9_-]/g, (c) => '_' + c.charCodeAt(0).toString(16)) }

  function buildFilePanel(file) {
    const panel = document.createElement('div')
    panel.className = `file-panel${state.collapsed.has(file.path) ? ' collapsed' : ''}`
    panel.id = fileDomId(file.path)
    panel.dataset.filePanel = file.path
    const head = document.createElement('div')
    head.className = 'file-head'
    const collapsed = state.collapsed.has(file.path)
    const threadCount = currentThreads.filter((thread) => thread.path === file.path).length
    head.innerHTML = h`<button type="button" class="btn ghost small" data-toggle-file title="${collapsed ? '펼치기' : '접기'}">${collapsed ? '▸' : '▾'}</button><strong>${file.path}</strong>${file.oldPath ? raw(h`<span class="muted">← ${file.oldPath}</span>`) : ''}<span class="badge">${file.changeType}</span><span class="small"><span class="add-count">+${file.additions}</span> <span class="del-count">−${file.deletions}</span>${threadCount ? raw(` <span class="badge">💬${threadCount}</span>`) : ''}</span>`
    head.querySelector('[data-toggle-file]').addEventListener('click', () => { if (state.collapsed.has(file.path)) state.collapsed.delete(file.path); else state.collapsed.add(file.path); redrawFile(file.path) })
    panel.append(head)
    if (collapsed) return panel
    if (file.binary || file.truncated || file.hunks.length === 0) {
      const box = document.createElement('div')
      box.className = 'notice-box'
      box.textContent = file.binary ? '바이너리 파일 — 텍스트 라인 코멘트를 지원하지 않습니다.' : file.truncated ? 'diff가 20,000줄을 초과해 표시하지 않습니다.' : '표시할 hunk가 없습니다.'
      panel.append(box)
      return panel
    }
    const table = document.createElement('table')
    table.className = 'diff'
    table.innerHTML = '<colgroup><col class="col-gutter"><col class="col-gutter"><col class="col-marker"><col></colgroup>'
    const placement = placeThreads(currentThreads.filter((thread) => thread.path === file.path))
    const tbody = document.createElement('tbody')
    for (const hunk of file.hunks) {
      const hunkRow = document.createElement('tr')
      hunkRow.className = 'hunk'
      const cell = document.createElement('td')
      cell.colSpan = 4
      cell.textContent = hunk.header
      hunkRow.append(cell)
      tbody.append(hunkRow)
      for (const line of hunk.lines) {
        tbody.append(lineRow(file, line))
        for (const side of ['old', 'new']) {
          const number = side === 'old' ? line.oldNo : line.newNo
          if (number === null) continue
          const here = placement[threadKey(file.path, side, number)]
          if (here) tbody.append(threadRow(here, 4))
          if (state.pendingForm && state.selection && state.selection.path === file.path && state.selection.side === side && clampRange(state.selection).endLine === number) tbody.append(commentFormRow(4))
        }
      }
    }
    table.append(tbody)
    panel.append(table)
    const orphaned = currentThreads.filter((thread) => thread.path === file.path && !hasLine(file, thread.side, thread.endLine))
    if (orphaned.length) {
      const box = document.createElement('div')
      box.className = 'notice-box'
      box.innerHTML = '<strong>현재 diff에 위치를 찾지 못한 스레드</strong>'
      for (const thread of orphaned) box.append(threadElement(thread))
      panel.append(box)
    }
    return panel
  }

  /** GitHub "Files changed" layout: every file in sequence. */
  function drawFile() {
    filePanelHost.innerHTML = ''
    if (files.length === 0) { filePanelHost.innerHTML = '<div class="card"><div class="notice-box">변경 사항이 없습니다.</div></div>'; return }
    for (const file of files) filePanelHost.append(buildFilePanel(file))
  }

  /** Redraws one file panel only (drag selection, collapse toggles). */
  function redrawFile(path) {
    const file = files.find((entry) => entry.path === path)
    const old = filePanelHost.querySelector(`[data-file-panel="${CSS.escape(path)}"]`)
    if (!file || !old) { drawFile(); return }
    old.replaceWith(buildFilePanel(file))
  }

  function hasLine(file, side, number) {
    return file.hunks.some((hunk) => hunk.lines.some((line) => (side === 'old' ? line.oldNo : line.newNo) === number))
  }

  function cellFromEvent(event) {
    const cell = event.target.closest?.('.gutter[data-line]')
    if (!cell) return null
    return { path: cell.dataset.path, side: cell.dataset.side, line: Number(cell.dataset.line) }
  }

  filePanelHost.addEventListener('mousedown', (event) => {
    const cell = cellFromEvent(event)
    if (!cell || event.button !== 0) return
    event.preventDefault()
    state.pendingForm = null
    const previousPath = state.selection?.path
    state.selection = event.shiftKey && state.selection ? extendSelection(state.selection, cell) : beginSelection(cell)
    state.dragging = true
    if (previousPath && previousPath !== state.selection.path) redrawFile(previousPath)
    redrawFile(state.selection.path)
  })
  filePanelHost.addEventListener('mouseover', (event) => {
    if (!state.dragging) return
    const cell = cellFromEvent(event)
    if (!cell) return
    const next = extendSelection(state.selection, cell)
    if (next !== state.selection) { state.selection = next; redrawFile(state.selection.path) }
  })
  const finishDrag = () => { if (!state.dragging) return; state.dragging = false; if (state.selection) { state.pendingForm = true; redrawFile(state.selection.path) } }
  window.addEventListener('mouseup', finishDrag)
  filePanelHost.addEventListener('keydown', (event) => {
    const cell = cellFromEvent(event)
    if (!cell) return
    if (event.key === 'Enter') { event.preventDefault(); state.selection = beginSelection(cell); state.pendingForm = true; redrawFile(state.selection.path) }
    if (event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.selection) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      state.selection = extendSelection(state.selection, { ...cell, line: state.selection.head + delta })
      state.pendingForm = true
      redrawFile(state.selection.path)
      filePanelHost.querySelector(`.gutter[data-side="${state.selection.side}"][data-line="${state.selection.head}"]`)?.focus()
    }
  })

  drawFileList()
  drawFile()
  return {
    element: root,
    update(nextThreads) { currentThreads = nextThreads; state.selection = null; state.pendingForm = null; drawFileList(); drawFile() },
    dispose() { window.removeEventListener('mouseup', finishDrag) }
  }
}

// ---------- session view ----------
async function renderSession(sessionId) {
  let { session, diff } = await api.get(`/api/sessions/${sessionId}`)
  let context = null
  let agents = {}
  try { agents = await api.get('/api/agents') } catch { /* ignore */ }
  if (session.kind === 'local') { try { context = await api.get(`/api/context?path=${encodeURIComponent(session.repoPath)}`) } catch { /* ignore */ } }
  let activeRun = null
  let pollTimer = null
  let logOffset = 0
  let logText = ''

  const headEl = document.createElement('div')
  headEl.className = 'session-head'
  const runEl = document.createElement('div')
  runEl.className = 'run-panel'
  runEl.hidden = true
  const viewer = createDiffViewer({
    files: diff.files,
    threads: session.threads,
    canComment: true,
    onCreateThread: (selection) => mutate(() => api.post(`/api/sessions/${session.id}/threads`, { revision: session.revision, path: selection.path, oldPath: diff.files.find((file) => file.path === selection.path)?.oldPath ?? null, side: selection.side, startLine: selection.startLine, endLine: selection.endLine, selectedText: selectedText(selection), body: selection.body })),
    onThreadAction: (thread, action) => mutate(() => action.delete ? api.delete(`/api/sessions/${session.id}/threads/${thread.id}`, { revision: session.revision }) : api.patch(`/api/sessions/${session.id}/threads/${thread.id}`, { revision: session.revision, status: action.status })),
    onComment: (thread, action) => mutate(() => {
      if (action.add !== undefined) return api.post(`/api/sessions/${session.id}/threads/${thread.id}/comments`, { revision: session.revision, body: action.add })
      if (action.edit) return api.patch(`/api/sessions/${session.id}/threads/${thread.id}/comments/${action.edit}`, { revision: session.revision, body: action.body })
      return api.delete(`/api/sessions/${session.id}/threads/${thread.id}/comments/${action.delete}`, { revision: session.revision })
    })
  })
  app.innerHTML = ''
  app.append(headEl, runEl, viewer.element)

  function selectedText(selection) {
    const file = diff.files.find((entry) => entry.path === selection.path)
    const lines = []
    for (const hunk of file?.hunks ?? []) for (const line of hunk.lines) {
      const number = selection.side === 'old' ? line.oldNo : line.newNo
      if (number !== null && number >= selection.startLine && number <= selection.endLine) lines.push(line.text)
    }
    return lines.join('\n')
  }

  async function reload({ silent = false } = {}) {
    try {
      const detail = await api.get(`/api/sessions/${session.id}`)
      session = detail.session
      diff = detail.diff
      viewer.dispose()
      const fresh = createDiffViewer({ files: diff.files, threads: session.threads, canComment: true, onCreateThread: viewer.onCreateThread, onThreadAction: viewer.onThreadAction, onComment: viewer.onComment })
      // keep handlers: rebuild by re-rendering the whole view is simpler and safe
      fresh.dispose()
      await render()
    } catch (error) {
      if (!silent) showNotice(describeError(error), { error: true })
    }
  }

  async function mutate(operation) {
    try {
      session = await operation()
      viewer.update(session.threads)
      drawHead()
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        showNotice('세션이 다른 곳에서 변경되었습니다. 최신 상태를 다시 불러왔습니다.', { error: true })
        await reload({ silent: true })
        return
      }
      showNotice(describeError(error), { error: true })
    }
  }

  function drawHead() {
    const runnable = countRunnable(session.threads)
    const agentOptions = ['claude', 'codex'].map((name) => {
      const available = agents[name]?.available
      return h`<option value="${name}" ${raw(session.agent === name ? 'selected' : '')} ${raw(available ? '' : 'disabled')}>${name}${available ? '' : ' (설치 안 됨)'}</option>`
    }).join('')
    const canRun = Boolean(session.repoPath) && runnable > 0 && agents[session.agent]?.available && !(activeRun && (activeRun.status === 'running' || activeRun.status === 'queued'))
    const reason = !session.repoPath ? '로컬 worktree가 없어 AI 수정을 실행할 수 없습니다' : !agents[session.agent]?.available ? `${session.agent} CLI를 찾을 수 없습니다` : runnable === 0 ? '열려 있고 최신인 스레드가 없습니다' : activeRun && (activeRun.status === 'running' || activeRun.status === 'queued') ? '실행 중' : ''
    headEl.innerHTML = h`
      <div>
        <div class="title">${session.repoDisplayName} <span class="mono">${session.branch}</span> ${session.kind === 'pr' ? raw(h`<a class="badge" href="#/prs/${encodeURIComponent(session.pr.owner)}/${encodeURIComponent(session.pr.repo)}/${session.pr.number}">PR #${session.pr.number}</a>`) : ''}</div>
        <div class="path">${session.repoPath ?? '(로컬 worktree 없음 — 읽기 전용 PR diff)'}</div>
      </div>
      <span class="badge">${session.status}</span>
      ${session.kind === 'local' ? raw(h`<label>base <select id="baseRef">${raw((context?.baseCandidates ?? [session.baseRef]).map((candidate) => h`<option value="${candidate}" ${raw(candidate === session.baseRef ? 'selected' : '')}>${candidate}</option>`).join(''))}</select></label>
      <label><input type="checkbox" id="workingTree" ${raw(session.includeWorkingTree ? 'checked' : '')}> 미커밋 변경 포함</label>
      ${session.includeWorkingTree ? raw(h`<label><input type="checkbox" id="untracked" ${raw(session.includeUntracked ? 'checked' : '')}> untracked 포함</label>`) : ''}`) : ''}
      <span class="spacer"></span>
      <label>에이전트 <select id="agent">${raw(agentOptions)}</select></label>
      <button type="button" class="btn" id="refreshDiff" title="diff 다시 계산">diff 새로고침</button>
      <button type="button" class="btn primary" id="runFix" ${raw(canRun ? '' : 'disabled')} title="${reason}">리뷰 완료 및 AI 수정 (${runnable})</button>
      ${session.status !== 'completed' ? raw('<button type="button" class="btn" id="complete">세션 완료</button>') : ''}
      <span class="muted small">거터 드래그/Shift+클릭으로 멀티라인 선택 · <span class="kbd">Enter</span> 1줄 · <span class="kbd">Shift+↑↓</span> 확장</span>`
    headEl.querySelector('#baseRef')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, baseRef: event.target.value })); await reload() })
    headEl.querySelector('#untracked')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, includeUntracked: event.target.checked })); await reload() })
    headEl.querySelector('#workingTree')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, includeWorkingTree: event.target.checked })); await reload() })
    headEl.querySelector('#agent').addEventListener('change', (event) => mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, agent: event.target.value })))
    headEl.querySelector('#refreshDiff').addEventListener('click', () => reload())
    headEl.querySelector('#complete')?.addEventListener('click', async () => {
      const open = session.threads.filter((thread) => thread.status === 'open').length
      if (open > 0 && !confirm(`열린 스레드가 ${open}개 남아 있습니다. 그래도 완료할까요?`)) return
      await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, status: 'completed' }))
    })
    headEl.querySelector('#runFix').addEventListener('click', startRun)
  }

  async function startRun() {
    try {
      const run = await api.post(`/api/sessions/${session.id}/runs`, { revision: session.revision, agent: session.agent })
      await trackRun(run.id)
      await mutate(async () => (await api.get(`/api/sessions/${session.id}`)).session)
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.extra?.runId) { showNotice('이미 실행 중인 작업이 있어 그 작업을 표시합니다.'); await trackRun(error.extra.runId); return }
      if (error instanceof ApiRequestError && error.status === 409) { await reload({ silent: true }); showNotice('세션이 변경되어 다시 불러왔습니다. 다시 시도하세요.', { error: true }); return }
      showNotice(describeError(error), { error: true })
    }
  }

  function drawRun() {
    if (!activeRun) { runEl.hidden = true; return }
    runEl.hidden = false
    const elapsedMs = (activeRun.endedAt ? new Date(activeRun.endedAt) : new Date()) - new Date(activeRun.startedAt)
    const live = activeRun.status === 'running' || activeRun.status === 'queued'
    runEl.innerHTML = h`
      <div class="card-head">AI 수정 <span class="badge status-${activeRun.status}">${activeRun.status}</span><span class="muted small">${activeRun.agent} · ${Math.round(elapsedMs / 1000)}초 · 스레드 ${activeRun.threadIds.length}개${activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}</span><span style="flex:1"></span>
        ${live ? raw('<button type="button" class="btn small danger" id="cancelRun">취소</button>') : raw('<button type="button" class="btn small" id="closeRun">닫기</button>')}
      </div>
      ${activeRun.changedFiles?.length ? raw(h`<div class="card-body small"><strong>변경 파일</strong> ${activeRun.changedFiles.join(', ')} — <a href="#" id="afterRefresh">diff 새로고침</a> 후 스레드별로 직접 해결 처리하세요.</div>`) : ''}
      <pre id="runLog"></pre>`
    runEl.querySelector('#runLog').textContent = logText || (live ? '로그 대기 중…' : '(로그 없음)')
    runEl.querySelector('#cancelRun')?.addEventListener('click', async () => { try { activeRun = await api.post(`/api/runs/${activeRun.id}/cancel`); drawRun() } catch (error) { showNotice(describeError(error), { error: true }) } })
    runEl.querySelector('#closeRun')?.addEventListener('click', () => { activeRun = null; drawRun(); drawHead() })
    runEl.querySelector('#afterRefresh')?.addEventListener('click', (event) => { event.preventDefault(); reload() })
  }

  async function trackRun(runId) {
    clearInterval(pollTimer)
    logOffset = 0
    logText = ''
    const poll = async () => {
      try {
        const payload = await api.get(`/api/runs/${runId}?logFrom=${logOffset}`)
        activeRun = payload.run
        logText += payload.log
        logOffset = payload.logNext
        drawRun()
        drawHead()
        if (!(activeRun.status === 'running' || activeRun.status === 'queued')) { clearInterval(pollTimer); pollTimer = null; await reloadThreadsOnly() }
      } catch (error) { clearInterval(pollTimer); showNotice(describeError(error), { error: true }) }
    }
    await poll()
    if (activeRun && (activeRun.status === 'running' || activeRun.status === 'queued')) pollTimer = setInterval(poll, 2000)
  }

  async function reloadThreadsOnly() {
    try { const detail = await api.get(`/api/sessions/${session.id}`); session = detail.session; viewer.update(session.threads); drawHead() } catch { /* ignore */ }
  }

  drawHead()
  drawRun()
  return { dispose() { clearInterval(pollTimer); viewer.dispose() } }
}

// ---------- PR detail ----------
async function renderPr({ owner, repo, number }) {
  const detail = await api.get(`/api/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`)
  const { pr } = detail
  const head = document.createElement('div')
  head.className = 'session-head'
  head.innerHTML = h`
    <div>
      <div class="title">${pr.isDraft ? raw('<span class="badge draft">Draft</span> ') : ''}${pr.title} <span class="muted">#${pr.number}</span></div>
      <div class="path">${owner}/${repo} · ${pr.author} · <span class="mono">${pr.headRefName} → ${pr.baseRefName}</span> · <span class="add-count">+${pr.additions}</span> <span class="del-count">−${pr.deletions}</span> · ${pr.changedFiles} files · ${formatDate(pr.updatedAt)}</div>
    </div>
    <span class="spacer"></span>
    <span class="muted small">${detail.localWorktree ? raw(h`로컬 worktree: <span class="mono">${detail.localWorktree.path}</span>`) : '로컬 worktree 없음 — AI 수정 불가, 코멘트는 가능'}</span>
    <button type="button" class="btn primary" id="openSession">${detail.session ? '로컬 리뷰 세션 열기' : '로컬 리뷰 세션 만들기'}</button>
    <a class="btn" href="${pr.url}" target="_blank" rel="noopener">GitHub에서 보기 (읽기)</a>`
  const body = document.createElement('div')
  body.className = 'card'
  body.innerHTML = '<div class="card-head">본문</div>'
  const bodyText = document.createElement('div')
  bodyText.className = 'pr-body'
  bodyText.textContent = pr.body || '(본문 없음)'
  body.append(bodyText)
  const viewer = createDiffViewer({ files: detail.diff.files, threads: [], canComment: false, onCreateThread() {}, onThreadAction() {}, onComment() {} })
  app.innerHTML = ''
  app.append(head, body, viewer.element)
  head.querySelector('#openSession').addEventListener('click', async (event) => {
    event.target.disabled = true
    try {
      const session = detail.session ?? await api.post('/api/sessions', { kind: 'pr', owner, repo, number })
      location.hash = `#/sessions/${session.id}`
    } catch (error) { showNotice(describeError(error), { error: true }); event.target.disabled = false }
  })
  return { dispose() { viewer.dispose() } }
}

bootstrap()
