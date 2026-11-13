// Local Self Review UI — vanilla ES modules, no build step.
import {syntaxLanguage,tokenizeSourceLine} from '/ui/lib/syntax.mjs'
import { createApi, ApiRequestError } from '/ui/lib/api.mjs'
import { beginSelection, extendSelection, clampRange, isLineSelected } from '/ui/lib/selection.mjs'
import { placeThreads, threadKey, countRunnable, countByFile, countAwaitingAnswers, isCommentAnswered, isAiQuestionAnswered, commentsForDisplay, answeredCommentIds, countAnswerable } from '/ui/lib/threads.mjs'


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
  const toggle=document.getElementById('themeToggle');if(toggle){toggle.textContent=theme==='light'?'VS Code Light+':'VS Code Dark+';toggle.title='VS Code Dark+ / Light+ 전환'}
}
let savedTheme = 'dark'
try { savedTheme = localStorage.getItem('sr-theme') === 'light' ? 'light' : 'dark' } catch { /* storage unavailable */ }
applyTheme(savedTheme)
const themeSelect = document.getElementById('themeSelect')
themeSelect.value = savedTheme
themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value)
  try { localStorage.setItem('sr-theme', themeSelect.value) } catch { /* storage unavailable */ }
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
      let session = await api.post('/api/sessions', { kind: 'local', repoPath: context.repoPath, baseRef: context.defaultBase, agent:'claude', includeWorkingTree:false, includeUntracked:false })
      // Opening from a repository starts with its committed branch diff, even
      // when a prior review temporarily included AI edits or untracked files.
      if(session.includeWorkingTree || session.includeUntracked || session.agent!=='claude')session=await api.patch(`/api/sessions/${session.id}`,{revision:session.revision,agent:'claude',includeWorkingTree:false,includeUntracked:false})
      history.replaceState(null, '', `#/sessions/${session.id}`)
      await render()
      return
    } catch (error) {
      showNotice(`세션을 열지 못했습니다: ${describeError(error)}`, { error: true, timeout: 0 })
    }
  }
  await render()
}

// Keep the cross-repository list mounted while the selected review changes.
let activeReviewSignature = ''
async function refreshActiveReviews() {
  const status = document.getElementById('activeReviewStatus')
  const list = document.getElementById('activeReviewList')
  try {
    const { runs } = await api.get('/api/runs')
    const signature = JSON.stringify(runs)
    if (signature !== activeReviewSignature) {
      activeReviewSignature = signature
      document.getElementById('activeReviewCount').textContent = String(runs.length)
      list.innerHTML = runs.map(run => h`<li data-run-id="${run.id}"><a href="#/sessions/${run.sessionId}"><strong>${run.repoDisplayName}</strong> <span class="mono">${run.branch || '(브랜치 없음)'}</span></a><span class="badge">${run.agent} · ${run.mode === 'answer' ? 'AI 답변' : 'AI 수정'}</span><span>${run.status === 'queued' ? '대기 중' : '실행 중'}</span><time data-started="${run.startedAt}"></time></li>`).join('')
    }
    for (const link of list.querySelectorAll('a')) link.onclick = event => { if (location.hash === link.hash) { event.preventDefault(); render() } }
    status.textContent = runs.length ? '' : '실행 중인 리뷰가 없습니다.'
    status.hidden = runs.length > 0
    for (const el of list.querySelectorAll('[data-started]')) {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.started)) / 1000))
      el.textContent = seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
    }
  } catch {
    status.hidden = false
    status.textContent = '작업 목록을 불러오지 못했습니다. 다시 확인 중…'
  }
}
if (window.top === window) {
  refreshActiveReviews()
  setInterval(refreshActiveReviews, 3000)
} else {
  document.querySelector('.active-reviews').hidden = true
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
          let session = await api.post('/api/sessions', { kind: 'local', repoPath: context.repoPath, baseRef: context.defaultBase, agent:'claude', includeWorkingTree:false, includeUntracked:false })
      // Opening from a repository starts with its committed branch diff, even
      // when a prior review temporarily included AI edits or untracked files.
      if(session.includeWorkingTree || session.includeUntracked || session.agent!=='claude')session=await api.patch(`/api/sessions/${session.id}`,{revision:session.revision,agent:'claude',includeWorkingTree:false,includeUntracked:false})
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
function createDiffViewer({ files, threads, canComment, onCreateThread, onThreadAction, onComment, onAnswer }) {
  const root = document.createElement('div')
  root.className = 'review-layout'
  const fileList = document.createElement('div')
  fileList.className = 'card file-list'
  const filePanelHost = document.createElement('div')
  root.append(fileList, filePanelHost)
  const state = { activePath: files[0]?.path ?? null, selection: null, dragging: false, pendingForm: null, expandedResolved: new Set(), collapsed: new Set() }
  let currentThreads = threads
  let viewerDisposed = false
  const renderedFiles = new Set(files.length ? [files[0].path] : [])
  const nearFiles = new Set()
  const lazy = new IntersectionObserver(entries => {
    if (viewerDisposed) return
    for (const entry of entries) {
      const path = entry.target.dataset.filePanel
      if (entry.isIntersecting) { nearFiles.add(path); if (!renderedFiles.has(path)) { renderedFiles.add(path); redrawFile(path) } }
      else nearFiles.delete(path)
    }
    for (const path of renderedFiles) {
      if (renderedFiles.size <= 5) break
      const panel = filePanelHost.querySelector(`[data-file-panel="${CSS.escape(path)}"]`)
      if (!nearFiles.has(path) && path !== state.activePath && path !== state.selection?.path && !panel?.contains(document.activeElement)) { renderedFiles.delete(path); redrawFile(path) }
    }
  }, { rootMargin: '800px 0px' })
  let paintFrame = null
  function paintSelection() {
    paintFrame = null
    for (const row of filePanelHost.querySelectorAll('tr.selected')) row.classList.remove('selected')
    if (!state.selection) return
    const {startLine,endLine} = clampRange(state.selection)
    const panel = filePanelHost.querySelector(`[data-file-panel="${CSS.escape(state.selection.path)}"]`)
    for (const cell of panel?.querySelectorAll(`.gutter[data-side="${state.selection.side}"]`) ?? []) {
      const line = Number(cell.dataset.line)
      if (line >= startLine && line <= endLine) cell.parentElement.classList.add('selected')
    }
  }
  function schedulePaint() { if (paintFrame === null) paintFrame = requestAnimationFrame(paintSelection) }


  function drawFileList() {
    const counts = countByFile(currentThreads)
    fileList.innerHTML = `<div class="card-head">파일 ${files.length}개</div><div class="card-body" style="padding:4px"></div>`
    const body = fileList.querySelector('.card-body')
    if (files.length === 0) body.innerHTML = '<p class="muted" style="padding:8px">변경 사항이 없습니다.</p>'
    for (const file of files) {
      const item = document.createElement('div')
      item.className = `file-item${file.path === state.activePath ? ' active' : ''}`
      item.innerHTML = h`<span class="badge small">${{ added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' }[file.changeType] ?? '?'}</span><span class="name" title="${file.path}">${file.path}</span><span class="counts small"><span class="add-count">+${file.additions}</span> <span class="del-count">−${file.deletions}</span>${counts[file.path] ? raw(` <span class="badge">💬${counts[file.path]}</span>`) : ''}</span>`
      item.addEventListener('click', () => { state.activePath = file.path; renderedFiles.add(file.path); state.collapsed.delete(file.path); redrawFile(file.path); drawFileList(); document.getElementById(fileDomId(file.path))?.scrollIntoView({ block: 'start' }) })
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

  const syntaxCache=new WeakMap()
  function syntaxLines(file){
    if(syntaxCache.has(file))return syntaxCache.get(file)
    const result=new Map(),before=syntaxLanguage(file.oldPath||file.path),after=syntaxLanguage(file.path)
    for(const hunk of file.hunks){let oldState='',newState='';for(const line of hunk.lines){let tokens;if(line.type!=='add'){const parsed=tokenizeSourceLine(line.text,before,oldState);oldState=parsed.state;tokens=parsed.tokens}if(line.type!=='del'){const parsed=tokenizeSourceLine(line.text,after,newState);newState=parsed.state;tokens=parsed.tokens}result.set(line,tokens)}}
    syntaxCache.set(file,result);return result
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
    const tokens=syntaxLines(file).get(line)
    if(tokens)for(const token of tokens){if(token.type){const span=document.createElement('span');span.className='syntax-'+(token.type==='keyword'&&/^(if|else|for|while|when|return|throw|try|catch|finally|break|continue|switch|case|yield|await)$/.test(token.text.trim())?'control':token.type);span.textContent=token.text;code.append(span)}else code.append(document.createTextNode(token.text))}
    else code.textContent = line.text
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
    const answered = answeredCommentIds(thread.comments)
    element.dataset.threadId = thread.id
    element.className = `thread${thread.status === 'resolved' ? ' resolved' : ''}${expanded ? ' expanded' : ''}`
    const range = thread.startLine === thread.endLine ? `L${thread.startLine}` : `L${thread.startLine}–L${thread.endLine}`
    element.innerHTML = h`
      <div class="thread-head">
        <span class="badge ${thread.status === 'open' ? 'open' : 'resolved'}">${thread.status === 'open' ? '열림' : '해결됨'}</span>
        ${thread.applicability === 'outdated' ? raw('<span class="badge outdated" title="현재 diff에서 선택 원문을 찾지 못했습니다">outdated</span>') : ''}
        <span class="mono">${thread.side} ${range}</span>
        <span class="spacer"></span>
        ${thread.status === 'resolved' ? raw(`<button type="button" class="btn small ghost" data-toggle>${expanded ? '접기' : '펼치기'}</button>`) : ''}
        ${onAnswer?raw(h`<button type="button" class="btn small" data-ai-answer ${raw(countAnswerable([thread])?'':'disabled')} title="이 스레드의 질문에 로컬 AI가 답글로 답합니다">AI 답변 요청</button>`):''}
        <button type="button" class="btn small" data-thread-status="${thread.status === 'open' ? 'resolved' : 'open'}">${thread.status === 'open' ? '해결' : '다시 열기'}</button>
        <button type="button" class="btn small danger" data-thread-delete>삭제</button>
      </div>
      <div class="thread-body">
        ${raw(commentsForDisplay(thread.comments).map((comment) => h`
          <div class="comment" data-kind="${comment.kind || 'answer'}" data-run="${comment.runId || ''}" data-question-pending="${comment.kind === 'question' && !isAiQuestionAnswered(thread.comments,thread.comments.indexOf(comment))}" data-comment="${comment.id}" data-reply-to="${comment.replyToCommentId || ''}" data-author="${comment.author === 'ai' ? 'ai' : 'reviewer'}">
            <div class="meta"><span>${comment.author === 'ai' ? (comment.kind === 'question' ? 'AI 질문 · ' + (isAiQuestionAnswered(thread.comments,thread.comments.indexOf(comment)) ? '답변 남김' : '답변 필요') : comment.kind === 'fix-result' ? 'AI 수정 결과 · 로컬' : 'AI 답변 · 읽기 전용') + ' · ' + (comment.agent || '로컬 CLI') : '나'}</span>${comment.fixCompletedAt ? raw('<span class="badge" aria-label="로컬 수정 보고" title="AI의 로컬 수정 보고입니다. 커밋·원격 반영은 별도 상태에서 확인하세요.">로컬 수정 보고</span>') : isCommentAnswered(thread.comments, thread.comments.indexOf(comment)) ? raw('<span aria-label="답변 완료" title="답변 완료">✓</span>') : comment.author === 'ai' ? '' : raw('<span class="badge" aria-label="새 요청 대기">새 요청 대기</span>')}<span>${formatDate(comment.createdAt)}</span>${comment.updatedAt !== comment.createdAt ? raw('<span>(수정됨)</span>') : ''}<span class="spacer"></span>${comment.author === 'ai' ? '' : raw('<button type="button" class="btn small ghost" data-comment-edit>수정</button><button type="button" class="btn small ghost" data-comment-delete>삭제</button>')}</div>
            ${comment.kind === 'fix-result' && thread.comments.some(parent => parent.id === comment.replyToCommentId && (parent.body !== comment.requestBody || parent.updatedAt !== comment.requestUpdatedAt)) ? raw(h`<div class="muted small">실행 당시 요청의 결과입니다. 이후 요청이 수정되었습니다.<br>당시 요청: ${comment.requestBody}</div>`) : ''}<div class="body">${comment.body}</div>
          </div>`).join(''))}
        <div class="comment-form"><textarea placeholder="답글…" rows="2"></textarea><div class="actions"><button type="button" class="btn small primary" data-reply>답글</button></div></div>
      </div>`
    element.querySelector('[data-ai-answer]')?.addEventListener('click',()=>onAnswer(thread))
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
      commentEl.querySelector('[data-comment-delete]')?.addEventListener('click', () => { if (confirm('코멘트를 삭제할까요?')) onComment(thread, { delete: commentId }) })
      commentEl.querySelector('[data-comment-edit]')?.addEventListener('click', () => {
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
    row.className = 'thread-row selection-form-row'
    row.dataset.selectionForm = 'true'
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
    if (!renderedFiles.has(file.path)) {
      const placeholder = document.createElement('div')
      placeholder.className = 'diff-lazy-placeholder'
      placeholder.setAttribute('aria-label', '파일 diff 대기')
      placeholder.style.height = Math.max(40, file.hunks.reduce((n,h)=>n+h.lines.length*20+24,0)) + 'px'
      panel.append(placeholder)
      return panel
    }
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
    lazy.disconnect()
    filePanelHost.innerHTML = ''
    if (files.length === 0) filePanelHost.innerHTML = '<div class="card"><div class="notice-box">변경 사항이 없습니다.</div></div>'
    for (const file of files) { const panel = buildFilePanel(file); filePanelHost.append(panel); lazy.observe(panel) }
    const detached=currentThreads.filter(thread=>!files.some(file=>file.path===thread.path))
    if(detached.length){
      const section=document.createElement('section');section.className='card detached-threads';section.setAttribute('aria-label','이전 코드 코멘트');section.innerHTML='<div class="card-head">이전 코드 코멘트</div><div class="notice-box">현재 diff에서 제외된 파일의 코멘트입니다. 질문과 답글은 이어갈 수 있으며 AI 코드 수정 대상에서는 제외됩니다.</div>'
      for(const thread of detached){const entry=document.createElement('div');entry.className='notice-box';const path=document.createElement('strong');path.textContent=thread.path;const original=document.createElement('details');const summary=document.createElement('summary');summary.textContent='코멘트 작성 당시 코드';const code=document.createElement('pre');code.textContent=thread.selectedText;original.append(summary,code);entry.append(path,original,threadElement(thread));section.append(entry)}
      filePanelHost.append(section)
    }
  }

  /** Redraws one file panel only (drag selection, collapse toggles). */
  function redrawFile(path) {
    const file = files.find((entry) => entry.path === path)
    const old = filePanelHost.querySelector(`[data-file-panel="${CSS.escape(path)}"]`)
    if (!file || !old) { drawFile(); return }
    lazy.unobserve(old)
    const next = buildFilePanel(file); old.replaceWith(next); lazy.observe(next)
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
    for (const form of filePanelHost.querySelectorAll('.selection-form-row')) form.remove()
    state.selection = event.shiftKey && state.selection ? extendSelection(state.selection, cell) : beginSelection(cell)
    state.dragging = true
    schedulePaint()
  })
  filePanelHost.addEventListener('mouseover', (event) => {
    if (!state.dragging) return
    const cell = cellFromEvent(event)
    if (!cell) return
    const next = extendSelection(state.selection, cell)
    if (next !== state.selection) { state.selection = next; schedulePaint() }
  })
  const finishDrag = () => { if (!state.dragging) return; state.dragging = false; if (paintFrame !== null) cancelAnimationFrame(paintFrame); paintSelection(); if (state.selection) { state.pendingForm = true; redrawFile(state.selection.path) } }
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
    update(nextThreads, preserveDrafts = false) {
      const drafts = preserveDrafts ? [...filePanelHost.querySelectorAll('textarea')].map(el=>({threadId:el.closest('[data-thread-id]')?.dataset.threadId,commentId:el.closest('[data-comment]')?.dataset.comment,value:el.value,focused:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd})) : []
      const changed = new Set(!preserveDrafts && state.selection ? [state.selection.path] : [])
      for(const path of new Set([...currentThreads,...nextThreads].map(t=>t.path)))if(JSON.stringify(currentThreads.filter(t=>t.path===path))!==JSON.stringify(nextThreads.filter(t=>t.path===path)))changed.add(path)
      currentThreads=nextThreads
      if(!preserveDrafts){state.selection=null;state.pendingForm=null}
      drawFileList()
      if(preserveDrafts && state.dragging)return
      for(const path of changed)redrawFile(path)
      for(const draft of drafts){
        const thread=draft.threadId?filePanelHost.querySelector(`[data-thread-id="${CSS.escape(draft.threadId)}"]`):null
        let textarea
        if(draft.commentId){const comment=thread?.querySelector(`[data-comment="${CSS.escape(draft.commentId)}"]`);textarea=comment?.querySelector('textarea');if(!textarea){comment?.querySelector('[data-comment-edit]')?.click();textarea=comment?.querySelector('textarea')}}
        else textarea=thread?thread.querySelector('.comment-form textarea'):filePanelHost.querySelector('[data-selection-form] textarea')
        if(textarea){textarea.value=draft.value;if(draft.focused){textarea.focus({preventScroll:true});textarea.setSelectionRange(draft.start,draft.end)}}
      }
    },
    dispose() { viewerDisposed = true; lazy.disconnect(); if (paintFrame !== null) cancelAnimationFrame(paintFrame); window.removeEventListener('mouseup', finishDrag) }
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
  let runHistory = []
  try { runHistory = (await api.get(`/api/sessions/${session.id}/runs`)).runs } catch { /* history unavailable */ }
  let publishing = false
  let checksState = session.publishChecks || null, checksTimer = null, publishDialog = null
  let autoCommitEnabled = false
  let questionCursor = 0
  let pollTimer = null
  let polling = false, disposed = false
  let logOffset = 0
  let logText = ''

  const headEl = document.createElement('div')
  headEl.className = 'session-head'
  const actionsEl=document.createElement('div');actionsEl.className='session-actions review-actions-bar';actionsEl.setAttribute('role','group');actionsEl.setAttribute('aria-label','AI 리뷰 작업')
  const control=selector=>headEl.querySelector(selector)||actionsEl.querySelector(selector)
  const resize=new ResizeObserver(()=>{document.documentElement.style.setProperty('--review-actions-height',`${actionsEl.getBoundingClientRect().height}px`);document.documentElement.style.setProperty('--topbar-height',`${document.querySelector('.topbar').getBoundingClientRect().height}px`)});resize.observe(actionsEl);resize.observe(document.querySelector('.topbar'))
  const runEl = document.createElement('div')
  runEl.className = 'run-panel'
  runEl.hidden = true
  const viewerHandlers = {
    canComment: true,
    onAnswer:thread=>startRun('answer',[thread.id]),
    onCreateThread: (selection) => mutate(() => api.post(`/api/sessions/${session.id}/threads`, { revision: session.revision, path: selection.path, oldPath: diff.files.find((file) => file.path === selection.path)?.oldPath ?? null, side: selection.side, startLine: selection.startLine, endLine: selection.endLine, selectedText: selectedText(selection), body: selection.body })),
    onThreadAction: (thread, action) => mutate(() => action.delete ? api.delete(`/api/sessions/${session.id}/threads/${thread.id}`, { revision: session.revision }) : api.patch(`/api/sessions/${session.id}/threads/${thread.id}`, { revision: session.revision, status: action.status })),
    onComment: (thread, action) => mutate(() => {
      if (action.add !== undefined) return api.post(`/api/sessions/${session.id}/threads/${thread.id}/comments`, { revision: session.revision, body: action.add })
      if (action.edit) return api.patch(`/api/sessions/${session.id}/threads/${thread.id}/comments/${action.edit}`, { revision: session.revision, body: action.body })
      return api.delete(`/api/sessions/${session.id}/threads/${thread.id}/comments/${action.delete}`, { revision: session.revision })
    })
  }
  let viewer = createDiffViewer({files:diff.files,threads:session.threads,...viewerHandlers})
  app.innerHTML = ''
  const publicationEl = document.createElement('section')
  publicationEl.className = 'card publication-state'
  publicationEl.setAttribute('aria-label','로컬·원격 반영 상태')
  app.append(headEl, actionsEl, publicationEl, runEl, viewer.element)
  let publication = null, checkingPublication = false
  function drawChecks() {
    const labels={queued:'대기',running:'실행 중',passed:'통과',failed:'실패',interrupted:'중단됨',not_applicable:'검증 대상 없음'}
    const html=checksState ? h`<div class="card-body small" role="status"><strong>최근 커밋 전 검증: ${labels[checksState.status] || checksState.status}</strong><span> · ${formatDate(checksState.startedAt)} 시작</span>${checksState.reason?raw(h`<p>${checksState.reason}</p>`):''}${raw(checksState.steps.map(step=>h`<div><span class="badge">${labels[step.status] || step.status}</span> ${step.kind==='test'?'테스트':'detekt'} <span class="mono">${step.tasks.join(' ')}</span>${step.exitCode!==null?raw(h` · exit ${step.exitCode}`):''}${step.log?raw(h`<details ${raw(step.status==='failed'?'open':'')}><summary>실행 로그</summary><pre style="max-height:260px;overflow:auto">${step.log}</pre></details>`):''}</div>`).join(''))}</div>` : ''
    for(const target of [publicationEl.querySelector('[data-checks-display]'),publishDialog?.querySelector('[data-checks-display]')])if(target)target.innerHTML=html
  }
  async function refreshChecks() {
    try {checksState=(await api.get(`/api/sessions/${session.id}/publish-checks`)).checks;drawChecks();if(checksState?.status==='running')startChecksPolling();else if(!publishing){clearInterval(checksTimer);checksTimer=null}}
    catch { /* the running publication request reports its own error */ }
  }
  function startChecksPolling(){if(!checksTimer)checksTimer=setInterval(refreshChecks,1000)}
  async function finishChecksPolling(){await refreshChecks();if(checksState?.status!=='running'){clearInterval(checksTimer);checksTimer=null}}

  function drawPublication() {
    const labels = {'local-changes':'로컬 미커밋 변경 있음','remote-verified':'현재 HEAD 원격 포함 확인','local-commit':'현재 HEAD 원격 포함 미확인','unknown':'원격 상태 확인 실패'}
    publicationEl.innerHTML = h`<div class="card-head">반영 상태 <strong>${publication ? labels[publication.state] : '미확인'}</strong><button type="button" class="btn small" id="checkPublication" ${raw(checkingPublication ? 'disabled' : '')}>${checkingPublication ? '확인 중…' : '원격 상태 확인'}</button><button type="button" class="btn primary" id="publishWorkingTree" ${raw(publishing || activeRun && ['running','queued'].includes(activeRun.status) ? 'disabled' : '')}>미커밋 변경 커밋 & 푸시</button></div>${publication ? raw(h`<div class="card-body small"><div>로컬 HEAD <span class="mono">${publication.localHead?.slice(0,10) || '미확인'}</span> · 원격 HEAD <span class="mono">${publication.remoteHead?.slice(0,10) || '미확인'}</span> · ${publication.remote}/${publication.remoteRef} · ${formatDate(publication.checkedAt)} 확인</div>${publication.hasLocalChanges ? raw(h`<details><summary>미커밋 변경 ${publication.localChanges.length}개 — 이 변경은 푸시 완료가 아닙니다</summary><pre>${publication.localChanges.join('\n')}</pre></details>`) : ''}</div>`) : ''}`
    publicationEl.insertAdjacentHTML('beforeend','<div data-checks-display></div>')
    drawChecks()
    publicationEl.querySelector('#checkPublication').onclick = refreshPublication
    publicationEl.querySelector('#publishWorkingTree').onclick = openWorkingTreePublish
  }
  async function refreshPublication() {
    if (checkingPublication) return
    checkingPublication = true; drawPublication()
    try { publication = await api.get(`/api/sessions/${session.id}/publication`) }
    catch { publication = {state:'unknown',localChanges:[]} }
    finally { checkingPublication = false; drawPublication() }
  }
  drawPublication()
  refreshPublication()
  refreshChecks()

  async function openWorkingTreePublish() {
    if(publishing)return
    let plan
    try {plan=await api.get(`/api/sessions/${session.id}/publish-preview`)}
    catch(error){showNotice(describeError(error),{error:true,timeout:0});return}
    if(!plan.paths.length&&!plan.retryCommit){showNotice('현재 작업 트리에 커밋할 변경이 없습니다.');return}
    const dialog=document.createElement('dialog')
    publishDialog=dialog
    dialog.className='card'
    dialog.setAttribute('aria-label','미커밋 변경 커밋 & 푸시')
    dialog.style.cssText='width:min(850px,90vw);max-height:85vh;overflow:auto'
    dialog.innerHTML=h`<form><div class="card-head"><strong>미커밋 변경 커밋 & 푸시</strong></div><div class="card-body"><p class="mono">${session.repoPath}<br>${plan.branch}</p><p>현재 미커밋 파일을 선택하세요. 이전 AI 실행이 남긴 변경도 게시할 수 있습니다.</p>${plan.retryCommit?raw(h`<p>로컬 커밋 ${plan.retryCommit.slice(0,10)}의 푸시를 재시도합니다.</p>`):''}<div>${raw(plan.paths.map(path=>h`<label style="display:block"><input type="checkbox" data-publish-path value="${path}" checked> <span class="mono">${path}</span></label>`).join(''))}</div><p><label>커밋 메시지 <input aria-label="커밋 메시지" name="message" value="${plan.message}" required maxlength="300" style="width:100%;box-sizing:border-box" ${raw(plan.retryCommit?'readonly':'')}></label></p><p class="small muted">[GRT-번호] - fix|test|feat|refactor|docs 등 한 가지 유형: 작업 내용</p><p>게시 순서: detekt → 테스트 → 커밋 → 푸시. 검증 실패 시 커밋하지 않습니다.</p><div data-checks-display></div><p data-publish-error role="alert"></p><div class="actions"><button type="button" class="btn" data-cancel>취소</button><button type="submit" class="btn primary">커밋 & 푸시 실행</button></div></div></form>`
    const close=()=>{dialog.close();dialog.remove();publishDialog=null}
    dialog.querySelector('[data-cancel]').onclick=close
    dialog.addEventListener('cancel',event=>{if(publishing)event.preventDefault();else dialog.remove()})
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault()
      if(publishing)return
      const paths=[...dialog.querySelectorAll('[data-publish-path]:checked')].map(input=>input.value)
      const message=dialog.querySelector('[name=message]').value
      if(!paths.length&&!plan.retryCommit){dialog.querySelector('[data-publish-error]').textContent='커밋할 파일을 선택하세요.';return}
      publishing=true
      dialog.querySelector('[data-publish-error]').textContent=''
      checksState={status:'queued',steps:(plan.checks||[]).map(step=>({...step,status:'queued',exitCode:null,log:''}))}
      drawChecks();startChecksPolling()
      dialog.querySelector('[type=submit]').textContent='검증·커밋·푸시 중…'
      for(const button of dialog.querySelectorAll('button'))button.disabled=true
      try {
        const result=await api.post(`/api/sessions/${session.id}/publish`,{snapshot:plan.snapshot,paths,message})
        close()
        showNotice(`원격 반영 확인: ${result.commit.slice(0,10)} → ${result.remote}/${result.branch}`)
        await reloadThreadsOnly()
      } catch(error){dialog.querySelector('[data-publish-error]').textContent=describeError(error)}
      finally{publishing=false;dialog.querySelector('[type=submit]').textContent='커밋 & 푸시 실행';for(const button of dialog.querySelectorAll('button'))button.disabled=false;await finishChecksPolling();await refreshPublication();drawRun()}
    }
    document.body.append(dialog);drawChecks();dialog.showModal()
  }

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
    try { await render() } catch (error) { if (!silent) showNotice(describeError(error), {error:true}) }
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
    const awaiting = countAnswerable(session.threads)
    const agentAvailable=agents[session.agent]?.available||(session.agent==='claude'&&agents.codex?.available)
    const busy=activeRun && (activeRun.committing || ['running','queued'].includes(activeRun.status))
    const agentOptions = ['claude', 'codex'].map((name) => {
      const available = agents[name]?.available||(name==='claude'&&agents.codex?.available)
      return h`<option value="${name}" ${raw(session.agent === name ? 'selected' : '')} ${raw(available ? '' : 'disabled')}>${name==='claude'?'로컬 Claude → Codex':'로컬 Codex'}${available ? '' : ' (설치 안 됨)'}</option>`
    }).join('')
    const canRun = Boolean(session.repoPath) && runnable > 0 && agentAvailable && !(activeRun && (activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued'))
    const canAnswer = Boolean(session.repoPath) && awaiting > 0 && agentAvailable && !(activeRun && (activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued'))
    const reason = !session.repoPath ? '로컬 worktree가 없어 AI 수정을 실행할 수 없습니다' : !agentAvailable ? `${session.agent} CLI를 찾을 수 없습니다` : runnable === 0 ? '실행할 새 수정 요청이 없습니다. 코드 위치가 바뀐 미처리 스레드는 현재 코드에서 다시 선택해 주세요.' : activeRun && (activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued') ? '실행 중' : ''
    headEl.innerHTML = h`
      <div>
        <div class="title">${session.repoDisplayName} <span class="mono">${context?.branch ?? session.branch}</span> ${session.kind === 'pr' ? raw(h`<a class="badge" href="#/prs/${encodeURIComponent(session.pr.owner)}/${encodeURIComponent(session.pr.repo)}/${session.pr.number}">PR #${session.pr.number}</a>`) : ''}</div>
        <div class="path">${session.repoPath ?? '(로컬 worktree 없음 — 읽기 전용 PR diff)'}</div>
      </div>
      <span class="badge">${session.status}</span>
      ${session.kind === 'local' ? raw(h`<label>비교 기준 <select id="baseRef" aria-label="리뷰 비교 기준">${raw(([...new Set([session.baseRef,...(context?.baseCandidates || [])])]).map((candidate) => h`<option value="${candidate}" ${raw(candidate === session.baseRef ? 'selected' : '')}>${candidate}</option>`).join(''))}</select></label>
      <label><input type="checkbox" id="workingTree" ${raw(session.includeWorkingTree ? 'checked' : '')}> 미커밋 변경 포함</label>
      ${session.includeWorkingTree ? raw(h`<label><input type="checkbox" id="untracked" ${raw(session.includeUntracked ? 'checked' : '')}> untracked 포함</label>`) : ''}`) : ''}
      <span class="spacer"></span>
      <div class="session-actions" role="group" aria-label="AI 리뷰 작업"><label><span class="local-agent-label">로컬 CLI</span> <select id="agent">${raw(agentOptions)}</select></label>
      ${runHistory.length ? raw(h`<label>AI 실행 기록 <select id="runHistory" aria-label="AI 실행 기록">${raw(runHistory.map(run => h`<option value="${run.id}" ${raw(activeRun?.id === run.id ? 'selected' : '')}>${run.agent} · ${run.mode === 'answer' ? '답변' : '수정'} · ${run.status} · ${formatDate(run.startedAt)}</option>`).join(''))}</select></label>`) : ''}
      <button type="button" class="btn" id="refreshDiff" title="diff 다시 계산">diff 새로고침</button>
      <button type="button" class="btn" id="runAnswer" ${raw(canAnswer ? '' : 'disabled')}>AI 답변 요청 (${awaiting})</button>
      <label><input type="checkbox" id="autoCommit" ${raw(autoCommitEnabled?'checked':'')}> AI 수정 후 검증·로컬 커밋</label><button type="button" class="btn primary" id="runFix" ${raw(canRun ? '' : 'disabled')} title="${reason}">AI 수정 요청 (${runnable}개 스레드)</button>${activeRun?.questionCount ? raw(h`<button type="button" class="btn" id="showAiQuestions">AI 질문 ${activeRun.questionCount}개 보기</button>`) : ''}</div>
      ${session.status !== 'completed' ? raw('<button type="button" class="btn" id="complete">세션 완료</button>') : ''}
      ${!canRun ? raw(h`<span class="muted small" role="status">${reason}</span>`) : ''}<span class="muted small execution-scope">AI 답변은 읽기 전용, AI 수정은 로컬 코드 변경입니다. GitHub 반영은 커밋 & 푸시로 실행합니다. 처리한 코멘트는 문맥으로만 전달합니다.</span><span class="muted small">거터 드래그/Shift+클릭으로 멀티라인 선택 · <span class="kbd">Enter</span> 1줄 · <span class="kbd">Shift+↑↓</span> 확장</span>`
    const controls=headEl.querySelector('.session-actions');actionsEl.replaceChildren(...controls.childNodes);controls.remove()
    control('#baseRef')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, baseRef: event.target.value })); await reload() })
    control('#untracked')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, includeUntracked: event.target.checked })); await reload() })
    control('#workingTree')?.addEventListener('change', async (event) => { await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, includeWorkingTree: event.target.checked })); await reload() })
    control('#agent').addEventListener('change', (event) => mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, agent: event.target.value })))
    control('#autoCommit').addEventListener('change',event=>{autoCommitEnabled=event.target.checked})
    control('#runHistory')?.addEventListener('change', event => trackRun(event.target.value))
    control('#refreshDiff').addEventListener('click', () => reload())
    control('#complete')?.addEventListener('click', async () => {
      const open = session.threads.filter((thread) => thread.status === 'open').length
      if (open > 0 && !confirm(`열린 스레드가 ${open}개 남아 있습니다. 그래도 완료할까요?`)) return
      await mutate(() => api.patch(`/api/sessions/${session.id}`, { revision: session.revision, status: 'completed' }))
    })
    control('#runFix').addEventListener('click', () => startRun('fix'))
    control('#runAnswer').addEventListener('click', () => startRun('answer'))
    control('#showAiQuestions')?.addEventListener('click', () => {
      const all = [...viewer.element.querySelectorAll('.comment[data-kind="question"]')].filter(el=>el.dataset.run===activeRun.id)
      const pending = all.filter(el=>el.dataset.questionPending==='true'),targets=pending.length?pending:all
      const target=targets[questionCursor++ % targets.length]
      if(target){target.scrollIntoView({block:'center',behavior:'smooth'});target.tabIndex=-1;target.focus({preventScroll:true})}
    })
  }

  async function startRun(mode = 'fix',threadIds) {
    try {
      if(mode==='fix'&&session.kind==='local'&&!session.includeWorkingTree){session=await api.patch(`/api/sessions/${session.id}`,{revision:session.revision,includeWorkingTree:true});drawHead()}
      const run = await api.post(`/api/sessions/${session.id}/runs`, { revision: session.revision, agent: session.agent, mode,...(threadIds?{threadIds}:{}),autoCommit:mode==='fix'&&autoCommitEnabled })
      runHistory = [{id:run.id,mode:run.mode,agent:run.agent,status:run.status,startedAt:run.startedAt},...runHistory]
      await trackRun(run.id)
      await mutate(async () => (await api.get(`/api/sessions/${session.id}`)).session)
    } catch (error) {
      if(error instanceof ApiRequestError && error.code === 'no_runnable_threads'){await reloadThreadsOnly();showNotice(mode === 'answer'?'답변을 기다리는 열린 질문이 없습니다. 기존 답변 아래에 새 코멘트를 남기면 다시 요청할 수 있습니다.':'현재 코드와 일치하는 열린 코멘트가 없습니다. diff를 새로고침하고 코멘트 위치를 확인해 주세요.');return}
      if (error instanceof ApiRequestError && error.status === 409 && error.extra?.runId) { showNotice('이미 실행 중인 작업이 있어 그 작업을 표시합니다.'); await trackRun(error.extra.runId); return }
      if (error instanceof ApiRequestError && error.status === 409) { await reload({ silent: true }); showNotice('세션이 변경되어 다시 불러왔습니다. 다시 시도하세요.', { error: true }); return }
      showNotice(describeError(error), { error: true })
    }
  }

  function drawRun() {
    if (!activeRun) { runEl.hidden = true; return }
    runEl.hidden = false
    const elapsedMs = (activeRun.endedAt ? new Date(activeRun.endedAt) : new Date()) - new Date(activeRun.startedAt)
    const live = activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued'
    runEl.innerHTML = h`
      <div class="card-head">${activeRun.mode === 'answer' ? 'AI 답변 · 읽기 전용' : 'AI 수정 · 로컬 변경'} <span class="badge status-${activeRun.status}">${activeRun.status}</span><span class="muted small">${activeRun.agent}${activeRun.fallbackFrom?' (Claude 대체)':''} · ${Math.round(elapsedMs / 1000)}초 · 스레드 ${activeRun.threadIds.length}개${activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}</span><span style="flex:1"></span>
        ${activeRun.committing ? '' : live ? raw('<button type="button" class="btn small danger" id="cancelRun">취소</button>') : raw('<button type="button" class="btn small" id="closeRun">닫기</button>')}
      </div>
      ${activeRun.committing?raw('<div class="card-body">AI 수정 파일 커밋 중…</div>'):activeRun.committed?.commit?raw(h`<div class="card-body">커밋 완료 <code>${activeRun.committed.commit.slice(0,12)}</code> · ${activeRun.committed.paths.length}개 파일</div>`):activeRun.commitError?raw(h`<div role="alert" class="card-body dialog-error">AI 수정은 완료됐지만 커밋하지 못했습니다: ${activeRun.commitError.message}</div>`):activeRun.committed?.skipped?raw('<div class="card-body">추가 변경이 없어 커밋을 만들지 않았습니다.</div>'):''}
      ${activeRun.changedFiles?.length ? raw(h`<div class="card-body small"><strong>변경 파일</strong> ${activeRun.changedFiles.join(', ')} — <a href="#" id="afterRefresh">diff 새로고침</a> 후 스레드별로 직접 해결 처리하세요.</div>`) : ''}
      ${activeRun.mode !== 'answer' && !live ? raw(h`<div class="card-body small">${activeRun.published ? raw(h`<span class="badge">${activeRun.published.remoteHead === activeRun.published.commit ? '이 실행 커밋 원격 확인' : '이전 푸시 기록 · 원격 재확인 필요'}</span> <span class="mono">${activeRun.published.commit.slice(0,8)} → ${activeRun.published.remote}/${activeRun.published.branch}</span>`) : raw(h`<div>AI 수정은 작업 트리에 반영됩니다. 커밋·푸시는 아래 버튼으로 실행합니다.</div><div class="mono">${(activeRun.changedFiles || []).join(', ') || '변경 파일 없음'}</div>${activeRun.publishError ? raw(h`<div role="alert"><strong>이전 커밋·푸시 실패</strong> (${formatDate(activeRun.publishError.at)})<br>${activeRun.publishError.message}</div>`) : ''}<button type="button" class="btn primary" id="publishRun" ${raw(publishing ? 'disabled' : '')}>${publishing ? '커밋·푸시 중…' : activeRun.publishError?.commit ? '푸시 재시도' : '커밋 & 푸시'}</button>`)}</div>`) : ''}
      <details class="run-log-details"><summary>실행 로그</summary><pre id="runLog"></pre></details>`
    runEl.querySelector('#publishRun')?.addEventListener('click', async () => {
      if(!activeRun.publishError?.commit){await openWorkingTreePublish();return}
      if(!confirm(`로컬 커밋 ${activeRun.publishError.commit}을 ${session.branch}에 푸시할까요?`))return
      publishing=true;drawRun();startChecksPolling()
      try{await api.post(`/api/runs/${activeRun.id}/publish`);showNotice('원격 SHA까지 확인했습니다.')}
      catch(error){showNotice(describeError(error),{error:true,timeout:0})}
      finally{publishing=false;await finishChecksPolling();await trackRun(activeRun.id);await refreshPublication()}
    })
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
      if (polling || disposed) return
      polling = true
      try {
        const payload = await api.get(`/api/runs/${runId}?logFrom=${logOffset}`)
        if (disposed) return
        const previousQuestionCount = activeRun?.questionCount || 0
        activeRun = payload.run
        if ((activeRun.questionCount || 0) > previousQuestionCount) await reloadThreadsOnly()
        runHistory = runHistory.map(run => run.id === activeRun.id ? {...run,status:activeRun.status} : run)
        logText += payload.log
        logOffset = payload.logNext
        drawRun()
        drawHead()
        if (!(activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued')) { clearInterval(pollTimer); pollTimer = null; await refreshAfterRun();refreshPublication() }
      } catch (error) { if (!disposed) {clearInterval(pollTimer); showNotice(describeError(error), { error: true })} }
      finally {polling = false}
    }
    await poll()
    if (!disposed && activeRun && (activeRun.committing || activeRun.status === 'running' || activeRun.status === 'queued')) pollTimer = setInterval(poll, 2000)
  }

  async function refreshAfterRun() {
    if(activeRun?.mode !== 'fix')return reloadThreadsOnly()
    try{
      const detail=await api.get(`/api/sessions/${session.id}`)
      if(disposed)return
      session=detail.session;diff=detail.diff
      const old=viewer;old.dispose()
      viewer=createDiffViewer({files:diff.files,threads:session.threads,...viewerHandlers})
      old.element.replaceWith(viewer.element);drawHead()
      showNotice(activeRun.committed?.commit?`AI 수정 결과를 커밋했습니다: ${activeRun.committed.commit.slice(0,12)}`:activeRun.commitError?'AI 수정 결과를 작업 트리 기준으로 갱신했습니다. 커밋 오류를 확인해 주세요.':'AI 수정 결과를 작업 트리 기준으로 갱신했습니다. 미커밋 변경이 포함됩니다.')
    }catch(error){if(!disposed)showNotice(describeError(error),{error:true})}
  }

  async function reloadThreadsOnly() {
    try { const detail = await api.get(`/api/sessions/${session.id}`); if (disposed) return; session = detail.session; viewer.update(session.threads,true); drawHead() } catch { /* ignore */ }
  }

  drawHead()
  drawRun()
  try {
    const { runs } = await api.get('/api/runs')
    const running = runs.find(run => run.sessionId === session.id)
    if (running || runHistory[0]) await trackRun(running?.id || runHistory[0].id)
  } catch { /* The review remains usable if the activity list is unavailable. */ }
  return { dispose() { disposed=true;resize.disconnect();document.documentElement.style.removeProperty('--review-actions-height');clearInterval(pollTimer);clearInterval(checksTimer);publishDialog?.close();publishDialog?.remove();viewer.dispose() } }
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
