// HTTP application: routes per docs/02-design.md "서버 API 계약".

import { createServer as createHttpServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { checkRequest } from './lib/auth.mjs'
import { ApiError, SessionStore, summarizeSession, writeJsonAtomic } from './lib/store.mjs'
import { GitReader, readRepoFileLines } from './lib/git.mjs'
import { OrcaReader } from './lib/orca.mjs'
import { GitHubReader, parseGitHubRemote } from './lib/github.mjs'
import { RunManager, defaultAgentCommands } from './lib/runs.mjs'
import { annotateThreads } from './lib/anchor.mjs'
import { buildPrompt, selectRunnableThreads } from './lib/prompt.mjs'
import { parseUnifiedDiff } from './lib/diff-parser.mjs'
import { execCommand } from './lib/exec.mjs'
import { enrichPath, resolveBin } from './lib/bins.mjs'
import { PanelPublisher, trimFilesForPanel, fitSessionsToBudget, PANEL_LOG_TAIL_BYTES, PANEL_DATA_MAX_BYTES } from './lib/panel-publisher.mjs'
import { validateOp } from './lib/bridge-ops.mjs'
import { BridgeKeeper } from './lib/bridge-keeper.mjs'
import { installLauncher } from '../worker/launcher-lib.mjs'

export const PROTOCOL_VERSION = 1
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' }
const PLACEHOLDER_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Local Self Review</title></head><body><p>UI files are missing (ui/index.html).</p></body></html>'

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

function sendError(response, error) {
  if (error instanceof ApiError) return sendJson(response, error.status, { error: { code: error.code, message: error.message, ...(error.extra ?? {}) } })
  sendJson(response, 500, { error: { code: 'internal', message: error?.message ?? String(error) } })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) { reject(new ApiError(413, 'payload_too_large', 'request body exceeds 2MB')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new ApiError(400, 'invalid_json', 'request body must be JSON')) }
    })
    request.on('error', reject)
  })
}

export function createServer({
  homeDir,
  pluginRoot,
  runners = { exec: execCommand },
  agentCommands,
  preferredPort = 47811,
  idleMs = 6 * 60 * 60_000,
  now = () => new Date().toISOString(),
  enrichEnvironment = true,
  exitImpl = (code) => process.exit(code),
  panelDebounceMs = 150,
  panelRoot = pluginRoot,
  bridgeMaintenanceMs = 60_000
}) {
  if (enrichEnvironment) enrichPath(process.env)
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  const exec = runners.exec
  const store = new SessionStore({ homeDir, now })
  const git = new GitReader({ exec, gitBinary: resolveBin('git') ?? 'git' })
  const orca = new OrcaReader({ exec, orcaBinary: resolveBin('orca') ?? '/Applications/Orca.app/Contents/Resources/bin/orca' })
  const github = new GitHubReader({ homeDir, exec, ghBinary: resolveBin('gh') ?? 'gh' })
  const runs = new RunManager({
    homeDir,
    agentCommands: agentCommands ?? defaultAgentCommands((name) => resolveBin(name)),
    git,
    now,
    onFinished: (run) => { try { store.setStatus(run.sessionId, 'rechecking') } catch { /* session gone */ } publishPanel('run-finished') }
  })
  const startedAt = now()
  const bridgesPath = join(homeDir, 'runtime', 'bridges.json')
  const bridges = readBridges(bridgesPath)            // worktreePath → { terminalIds: string[], registeredAt }
  const viewState = {}                                 // sessionId → { route, file, scroll }
  let lastOverview = null
  let runPollTimer = null
  const launcherPath = join(homeDir, 'bin', 'open-review')
  try { installLauncher({ homeDir, pluginRoot }) } catch { /* the worker installs it too */ }
  const bridgeKeeper = new BridgeKeeper({ exec, orcaBinary: orca.orcaBinary, launcherPath, log: (message) => process.stderr.write(`${message}\n`) })
  let bridgeTimer = null
  const publisher = new PanelPublisher({ pluginRoot, outputRoot: panelRoot, debounceMs: panelDebounceMs, collect: collectPanelData, log: (message) => process.stderr.write(`${message}\n`) })
  let lastActivity = Date.now()
  let idleTimer = null
  let httpServer = null
  let port = null

  function touch() { lastActivity = Date.now() }

  async function inventory() {
    return orca.inventory()
  }

  async function findWorktree(path) {
    const { worktrees, repos } = await inventory()
    const normalized = resolve(path)
    const worktree = worktrees.find((entry) => resolve(entry.path) === normalized) ?? null
    const repo = worktree ? repos.find((entry) => entry.id === worktree.repoId) ?? null : repos.find((entry) => resolve(entry.path) === normalized) ?? null
    return { worktree, repo }
  }

  async function contextFor(path) {
    if (!path) throw new ApiError(400, 'invalid_field', 'path query parameter is required')
    if (!existsSync(path)) throw new ApiError(404, 'path_not_found', `${path} does not exist`)
    const repoPath = await git.repoRoot(path)
    const branch = await git.currentBranch(repoPath)
    const baseCandidates = await git.baseCandidates(repoPath)
    const { worktree, repo } = await findWorktree(repoPath)
    return {
      repoPath,
      branch,
      baseCandidates,
      defaultBase: baseCandidates[0] ?? null,
      worktreeId: worktree?.id ?? null,
      repoDisplayName: repo?.displayName ?? worktree?.displayName ?? repoPath.split(sep).pop()
    }
  }

  async function sessionDiff(session) {
    if (session.kind === 'pr') {
      const text = await github.getPullRequestDiff({ owner: session.pr.owner, repo: session.pr.repo, number: session.pr.number })
      return { files: parseUnifiedDiff(text), baseSha: null, headSha: session.pr.headSha, mergeBaseSha: null, computedAt: now() }
    }
    if (!session.repoPath || !existsSync(session.repoPath)) throw new ApiError(404, 'worktree_missing', `worktree ${session.repoPath} no longer exists`)
    return git.workingTreeDiff(session.repoPath, { baseRef: session.baseRef, includeUntracked: session.includeUntracked })
  }

  async function sessionDetail(sessionId) {
    const session = store.getSession(sessionId)
    const diff = await sessionDiff(session)
    annotateThreads(diff.files, session.threads)
    return { session, diff }
  }

  async function overview({ force = false } = {}) {
    const { repos, worktrees, error } = await inventory()
    const errors = []
    if (error) errors.push({ repo: '(orca)', message: error })
    let lastFetchedAt = null
    const ghAvailable = Boolean(resolveBin('gh')) || runners.exec !== execCommand
    const repoCards = []
    for (const repo of repos) {
      const target = parseGitHubRemote(repo.remoteUrl)
      let prs = []
      if (target && ghAvailable) {
        const result = await github.listOpenPullRequests(target, { force })
        prs = result.prs
        if (result.error) errors.push({ repo: repo.displayName, message: result.error })
        if (result.fetchedAt && (!lastFetchedAt || result.fetchedAt > lastFetchedAt)) lastFetchedAt = result.fetchedAt
      }
      repoCards.push({
        id: repo.id,
        path: repo.path,
        displayName: repo.displayName,
        github: target,
        worktrees: worktrees.filter((entry) => entry.repoId === repo.id).map((entry) => ({ worktreeId: entry.id, path: entry.path, branch: entry.branch, displayName: entry.displayName })),
        prs
      })
    }
    return { repos: repoCards, sessions: store.listSessions(), github: { enabled: ghAvailable, lastFetchedAt: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null, errors } }
  }

  async function createSession(body) {
    if (body.kind === 'local') {
      if (typeof body.repoPath !== 'string') throw new ApiError(400, 'invalid_field', 'repoPath is required')
      const context = await contextFor(body.repoPath)
      const baseRef = typeof body.baseRef === 'string' && body.baseRef ? body.baseRef : context.defaultBase
      if (!baseRef) throw new ApiError(400, 'no_base', 'no base branch candidate found; pass baseRef explicitly')
      if (!(await git.refExists(context.repoPath, baseRef))) throw new ApiError(400, 'git_failed', `base ref ${baseRef} does not exist`)
      return store.createSession({ kind: 'local', repoPath: context.repoPath, baseRef, includeUntracked: body.includeUntracked, agent: body.agent, worktreeId: context.worktreeId, repoDisplayName: context.repoDisplayName, branch: context.branch })
    }
    if (body.kind === 'pr') {
      const { owner, repo, number } = body
      if (typeof owner !== 'string' || typeof repo !== 'string' || !Number.isInteger(number)) throw new ApiError(400, 'invalid_field', 'owner, repo and integer number are required')
      const pr = await github.getPullRequest({ owner, repo, number })
      const local = await localWorktreeForPr({ owner, repo, headRefName: pr.headRefName })
      return store.createSession({ kind: 'pr', pr: { owner, repo, number, headSha: pr.headSha, url: pr.url }, repoPath: local?.path ?? null, worktreeId: local?.worktreeId ?? null, baseRef: pr.baseRefName, repoDisplayName: `${owner}/${repo}`, branch: pr.headRefName, agent: body.agent })
    }
    throw new ApiError(400, 'invalid_field', 'kind must be local or pr')
  }

  async function localWorktreeForPr({ owner, repo, headRefName }) {
    const { repos, worktrees } = await inventory()
    const matchingRepos = repos.filter((entry) => { const target = parseGitHubRemote(entry.remoteUrl); return target && target.owner.toLowerCase() === owner.toLowerCase() && target.repo.toLowerCase() === repo.toLowerCase() })
    for (const entry of matchingRepos) {
      const worktree = worktrees.find((candidate) => candidate.repoId === entry.id && candidate.branch === headRefName)
      if (worktree) return { path: worktree.path, branch: worktree.branch, worktreeId: worktree.id }
    }
    return null
  }

  async function startRun(sessionId, body) {
    const session = store.withRevision(sessionId, body.revision)
    const agent = body.agent ?? session.agent
    if (agent !== 'claude' && agent !== 'codex') throw new ApiError(400, 'invalid_field', 'agent must be claude or codex')
    if (!session.repoPath || !existsSync(session.repoPath)) throw new ApiError(400, 'worktree_missing', 'this session has no local worktree to run an agent in')
    const diff = await sessionDiff(session)
    annotateThreads(diff.files, session.threads)
    const threads = selectRunnableThreads(session.threads)
    if (threads.length === 0) throw new ApiError(400, 'no_runnable_threads', 'no open, up-to-date threads to send to the agent')
    let prompt
    try {
      prompt = buildPrompt({ session, threads, readFileLines: (relativePath) => readRepoFileLines(session.repoPath, relativePath) })
    } catch (error) {
      throw new ApiError(400, 'prompt_too_large', error.message)
    }
    const run = await runs.start({ session, threadIds: threads.map((thread) => thread.id), agent, prompt })
    session.agent = agent
    session.status = 'fixing'
    store.save(session)
    return run
  }

  function readBridges(path) {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {} } catch { return {} }
  }

  function saveBridges() {
    try { mkdirSync(join(homeDir, 'runtime'), { recursive: true, mode: 0o700 }); writeJsonAtomic(bridgesPath, bridges) } catch { /* best effort */ }
  }

  function publishPanel(reason) {
    return publisher.schedule(reason)
  }

  let lastRunSignature = ''
  function runSignature() {
    return runs.list().map((run) => `${run.id}:${run.status}`).join(',')
  }
  function ensureRunPolling() {
    if (runPollTimer) return
    lastRunSignature = runSignature()
    runPollTimer = setInterval(() => {
      const signature = runSignature()
      if (signature !== lastRunSignature) { lastRunSignature = signature; publishPanel('run-progress') }
      if (!runs.hasRunning()) { clearInterval(runPollTimer); runPollTimer = null }
    }, 2000)
    runPollTimer.unref?.()
  }

  /** Makes sure every worktree with an active local session has a live bridge terminal. */
  async function maintainBridges({ worktreePath = null } = {}) {
    const targets = worktreePath ? [worktreePath] : [...new Set(store.listSessions().filter((session) => session.kind === 'local' && session.status !== 'completed' && session.repoPath && existsSync(session.repoPath)).map((session) => session.repoPath))]
    let changed = false
    for (const path of targets) {
      const registered = bridges[path]?.terminalIds ?? []
      const result = await bridgeKeeper.ensure(path, registered)
      if (result.alive && registered.length && result.alive.length !== registered.length) {
        bridges[path] = { terminalIds: result.alive, registeredAt: now() }
        if (result.alive.length === 0) delete bridges[path]
        saveBridges()
        changed = true
      }
    }
    if (changed) publishPanel('bridge')
  }

  function scheduleBridgeMaintenance() {
    if (!bridgeMaintenanceMs || bridgeTimer) return
    bridgeTimer = setInterval(() => { maintainBridges().catch(() => {}) }, bridgeMaintenanceMs)
    bridgeTimer.unref?.()
  }

  async function collectPanelData(reason) {
    const sessions = {}
    const sessionList = store.listSessions()
    for (const summary of sessionList) {
      if (summary.status === 'completed') continue
      try {
        const detail = await sessionDetail(summary.id)
        sessions[summary.id] = { session: detail.session, diff: { ...detail.diff, files: trimFilesForPanel(detail.diff.files) } }
      } catch (error) {
        sessions[summary.id] = { session: store.getSession(summary.id), diff: { files: [], error: error.message } }
      }
    }
    const runList = runs.list()
    const runsBySession = {}
    for (const run of runList) {
      if (runsBySession[run.sessionId]) continue
      const { log } = runs.readLog(run.id, 0)
      runsBySession[run.sessionId] = { ...run, fingerprintsBefore: undefined, logTail: log.slice(-PANEL_LOG_TAIL_BYTES) }
    }
    if (reason !== 'run-progress' || !lastOverview) {
      try { lastOverview = await overview() } catch (error) { lastOverview = { repos: [], sessions: sessionList, github: { enabled: false, lastFetchedAt: null, errors: [{ repo: '(orca)', message: error.message }] } } }
    }
    const liveTerminals = await bridgeKeeper.listTerminals()
    const worktrees = lastOverview.repos.flatMap((repo) => repo.worktrees.map((worktree) => ({
      terminalIds: liveTerminals.filter((terminal) => terminal.worktreePath === worktree.path).flatMap((terminal) => [terminal.handle, terminal.ptyId].filter(Boolean)),
      worktreeId: worktree.worktreeId,
      path: worktree.path,
      branch: worktree.branch,
      displayName: worktree.displayName,
      repoDisplayName: repo.displayName,
      sessionId: sessionList.find((session) => session.kind === 'local' && session.status !== 'completed' && session.repoPath === worktree.path)?.id ?? null,
      bridgeTerminalIds: bridges[worktree.path]?.terminalIds ?? []
    })))
    return {
      schemaVersion: 1,
      generatedAt: now(),
      reason,
      server: { port, pid: process.pid },
      launcher: join(homeDir, 'bin', 'open-review'),
      agents: runs.availability(),
      worktrees,
      sessions: fitSessionsToBudget(sessions, viewState, { budgetBytes: Math.floor(PANEL_DATA_MAX_BYTES * 0.6) }),
      sessionList,
      runs: runsBySession,
      overview: { repos: lastOverview.repos, github: lastOverview.github },
      viewState
    }
  }

  async function dispatchBridgeOp(op) {
    const valid = validateOp(op)
    if (!valid.ok) throw new ApiError(400, 'invalid_op', valid.error)
    switch (op.op) {
      case 'ping': return { ok: true }
      case 'view': {
        const previous = viewState[op.sessionId]
        viewState[op.sessionId] = { route: op.route ?? 'review', file: op.file ?? null, scroll: Number.isFinite(op.scroll) ? op.scroll : 0 }
        if (op.file && op.file !== previous?.file && op.loadFile) publishPanel('view-file')
        return { ok: true }
      }
      case 'session.open': {
        const session = await createSession({ kind: 'local', repoPath: op.worktreePath, baseRef: op.baseRef, agent: op.agent })
        viewState[session.id] = viewState[session.id] ?? { route: 'review', file: null, scroll: 0 }
        publishPanel('session')
        if (bridgeMaintenanceMs) maintainBridges({ worktreePath: session.repoPath }).catch(() => {})
        return session
      }
      case 'session.patch': { const result = store.updateSession(op.sessionId, op); publishPanel('session'); return result }
      case 'session.complete': { const session = store.getSession(op.sessionId); const result = store.updateSession(op.sessionId, { revision: session.revision, status: 'completed' }); publishPanel('session'); return result }
      case 'session.delete': { store.deleteSession(op.sessionId); delete viewState[op.sessionId]; publishPanel('session'); return { ok: true } }
      case 'thread.add': { const result = store.addThread(op.sessionId, op); publishPanel('thread'); return result }
      case 'thread.patch': { const result = store.updateThread(op.sessionId, op.threadId, op); publishPanel('thread'); return result }
      case 'thread.delete': { const result = store.deleteThread(op.sessionId, op.threadId, op); publishPanel('thread'); return result }
      case 'comment.add': { const result = store.addComment(op.sessionId, op.threadId, op); publishPanel('thread'); return result }
      case 'comment.patch': { const result = store.updateComment(op.sessionId, op.threadId, op.commentId, op); publishPanel('thread'); return result }
      case 'comment.delete': { const result = store.deleteComment(op.sessionId, op.threadId, op.commentId, op); publishPanel('thread'); return result }
      case 'run.start': { const run = await startRun(op.sessionId, op); ensureRunPolling(); publishPanel('run'); return run }
      case 'run.cancel': { const run = runs.cancel(op.runId); publishPanel('run'); return run }
      case 'overview.refresh': { lastOverview = await overview({ force: true }); publishPanel('overview'); return { ok: true } }
      case 'wide': {
        const session = store.getSession(op.sessionId)
        const url = `http://127.0.0.1:${port}/#/sessions/${session.id}`
        const result = await orca.exec(orca.orcaBinary, ['tab', 'create', '--url', url, '--json'], { timeout: 15_000 }).catch((error) => ({ code: 1, stderr: error.message, stdout: '' }))
        if (result.code !== 0) throw new ApiError(502, 'orca_failed', `orca tab create failed: ${(result.stderr || result.stdout).trim()}`)
        return { ok: true, url }
      }
      default: throw new ApiError(400, 'invalid_op', `unhandled op ${op.op}`)
    }
  }

  function serveStatic(request, response, urlPath) {
    const uiDir = resolve(join(pluginRoot, 'ui'))
    if (urlPath === '/') {
      const indexPath = join(uiDir, 'index.html')
      let html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : PLACEHOLDER_HTML
      html = html.replace(/<head>/i, `<head>\n<meta name="sr-token" content="${token}">`)
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return response.end(html)
    }
    const relative = normalize(decodeURIComponent(urlPath.slice('/ui/'.length))).replace(/^(\.\.(\/|\\|$))+/, '')
    const filePath = resolve(join(uiDir, relative))
    if (!filePath.startsWith(uiDir + sep) || !existsSync(filePath)) { response.writeHead(404); return response.end('not found') }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(readFileSync(filePath))
  }

  async function route(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    const path = url.pathname
    const method = request.method
    const admission = checkRequest({ headers: request.headers, url: request.url, token, port })
    if (admission) return sendJson(response, admission.status, { error: { code: admission.code, message: admission.message } })

    if (path === '/health') return sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION, pid: process.pid, startedAt })
    if (path === '/' || path.startsWith('/ui/')) { touch(); return serveStatic(request, response, path) }
    if (path === '/panel-preview') {
      touch()
      await publisher.settle()
      const panelPath = join(panelRoot, 'panel.html')
      const html = (existsSync(panelPath) ? readFileSync(panelPath, 'utf8') : PLACEHOLDER_HTML).replace(/<head>/i, `<head>\n<meta name="sr-token" content="${token}">`)
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' })
      return response.end(html)
    }
    if (!path.startsWith('/api/')) return sendJson(response, 404, { error: { code: 'not_found', message: 'no such route' } })
    touch()

    const segments = path.split('/').filter(Boolean).slice(1) // after 'api'
    const body = method === 'GET' ? {} : await readBody(request)

    if (segments[0] === 'shutdown' && method === 'POST') {
      if (runs.hasRunning()) throw new ApiError(409, 'run_in_progress', 'an AI run is still in progress')
      sendJson(response, 200, { ok: true })
      setTimeout(() => close().then(() => exitImpl(0)), 50)
      return
    }
    if (segments[0] === 'overview') {
      if (segments[1] === 'refresh' && method === 'POST') return sendJson(response, 200, await overview({ force: true }))
      if (method === 'GET') return sendJson(response, 200, await overview())
    }
    if (segments[0] === 'context' && method === 'GET') return sendJson(response, 200, await contextFor(url.searchParams.get('path')))
    if (segments[0] === 'agents' && method === 'GET') return sendJson(response, 200, runs.availability())
    if (segments[0] === 'prs' && method === 'GET' && segments.length === 4) {
      const [, owner, repo, numberText] = segments
      const number = Number(numberText)
      const pr = await github.getPullRequest({ owner, repo, number })
      const files = parseUnifiedDiff(await github.getPullRequestDiff({ owner, repo, number }))
      const localWorktree = await localWorktreeForPr({ owner, repo, headRefName: pr.headRefName })
      const session = store.listSessions().find((entry) => entry.kind === 'pr' && entry.pr?.owner === owner && entry.pr?.repo === repo && entry.pr?.number === number) ?? null
      return sendJson(response, 200, { pr, diff: { files }, localWorktree: localWorktree ? { path: localWorktree.path, branch: localWorktree.branch } : null, session })
    }
    if (segments[0] === 'runs' && segments[1]) {
      const runId = segments[1]
      if (method === 'GET' && segments.length === 2) {
        const run = runs.get(runId)
        const { log, next } = runs.readLog(runId, Number(url.searchParams.get('logFrom') ?? 0))
        return sendJson(response, 200, { run, log, logNext: next })
      }
      if (method === 'POST' && segments[2] === 'cancel') { const run = runs.cancel(runId); publishPanel('run'); return sendJson(response, 200, run) }
    }
    if (segments[0] === 'bridge') {
      if (segments[1] === 'register' && method === 'POST') {
        if (typeof body.worktreePath !== 'string') throw new ApiError(400, 'invalid_field', 'worktreePath required')
        const ids = new Set(bridges[body.worktreePath]?.terminalIds ?? [])
        for (const id of [body.terminalHandle, body.panelTerminalId, body.ptyId]) if (typeof id === 'string' && id) ids.add(id)
        bridges[body.worktreePath] = { terminalIds: [...ids], registeredAt: now() }
        saveBridges()
        publishPanel('bridge')
        return sendJson(response, 200, { ok: true, worktreePath: body.worktreePath, terminalIds: bridges[body.worktreePath].terminalIds })
      }
      if (segments[1] === 'unregister' && method === 'POST') {
        if (typeof body.worktreePath === 'string' && bridges[body.worktreePath]) {
          const removing = new Set([body.terminalHandle, body.panelTerminalId, body.ptyId].filter((id) => typeof id === 'string' && id))
          const remaining = bridges[body.worktreePath].terminalIds.filter((id) => !removing.has(id))   // no ids → nothing removed
          if (remaining.length === 0) delete bridges[body.worktreePath]
          else bridges[body.worktreePath] = { ...bridges[body.worktreePath], terminalIds: remaining }
          saveBridges()
          publishPanel('bridge')
        }
        return sendJson(response, 200, { ok: true })
      }
      if (segments.length === 1 && method === 'POST') return sendJson(response, 200, { ok: true, result: await dispatchBridgeOp(body) })
      if (segments[1] === 'status' && method === 'GET') {
        const worktreePath = url.searchParams.get('worktree')
        return sendJson(response, 200, { bridges: worktreePath ? { [worktreePath]: bridges[worktreePath] ?? null } : bridges })
      }
    }
    if (segments[0] === 'panel' && segments[1] === 'publish' && method === 'POST') { await publisher.flush('manual'); return sendJson(response, 200, { ok: true }) }
    if (segments[0] === 'sessions') {
      if (segments.length === 1) {
        if (method === 'GET') return sendJson(response, 200, store.listSessions())
        if (method === 'POST') {
          const before = store.listSessions().map((entry) => entry.id)
          const session = await createSession(body)
          publishPanel('session')
          return sendJson(response, before.includes(session.id) ? 200 : 201, session)
        }
      }
      const sessionId = segments[1]
      if (segments.length === 2) {
        if (method === 'GET') return sendJson(response, 200, await sessionDetail(sessionId))
        if (method === 'PATCH') { const result = store.updateSession(sessionId, body); publishPanel('session'); return sendJson(response, 200, result) }
        if (method === 'DELETE') { store.deleteSession(sessionId); publishPanel('session'); return sendJson(response, 200, { ok: true }) }
      }
      if (segments[2] === 'threads') {
        if (segments.length === 3 && method === 'POST') { const result = store.addThread(sessionId, body); publishPanel('thread'); return sendJson(response, 200, result) }
        const threadId = segments[3]
        if (segments.length === 4 && method === 'PATCH') { const result = store.updateThread(sessionId, threadId, body); publishPanel('thread'); return sendJson(response, 200, result) }
        if (segments.length === 4 && method === 'DELETE') { const result = store.deleteThread(sessionId, threadId, body); publishPanel('thread'); return sendJson(response, 200, result) }
        if (segments[4] === 'comments') {
          if (segments.length === 5 && method === 'POST') { const result = store.addComment(sessionId, threadId, body); publishPanel('thread'); return sendJson(response, 200, result) }
          const commentId = segments[5]
          if (segments.length === 6 && method === 'PATCH') { const result = store.updateComment(sessionId, threadId, commentId, body); publishPanel('thread'); return sendJson(response, 200, result) }
          if (segments.length === 6 && method === 'DELETE') { const result = store.deleteComment(sessionId, threadId, commentId, body); publishPanel('thread'); return sendJson(response, 200, result) }
        }
      }
      if (segments[2] === 'runs' && segments.length === 3 && method === 'POST') { const run = await startRun(sessionId, body); ensureRunPolling(); publishPanel('run'); return sendJson(response, 202, run) }
    }
    sendJson(response, 404, { error: { code: 'not_found', message: `no route for ${method} ${path}` } })
  }

  function writeRuntimeFile() {
    mkdirSync(join(homeDir, 'runtime'), { recursive: true, mode: 0o700 })
    writeJsonAtomic(join(homeDir, 'runtime', 'server.json'), { port, pid: process.pid, token, startedAt, protocolVersion: PROTOCOL_VERSION, serverEntry: join(pluginRoot, 'server', 'main.mjs') })
  }

  function removeRuntimeFile() {
    const path = join(homeDir, 'runtime', 'server.json')
    try {
      if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path)
    } catch { /* ignore */ }
  }

  function scheduleIdleCheck() {
    if (!idleMs) return
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity >= idleMs && !runs.hasRunning()) close().then(() => exitImpl(0))
    }, Math.min(idleMs, 60_000))
    idleTimer.unref()
  }

  async function listen() {
    httpServer = createHttpServer((request, response) => {
      route(request, response).catch((error) => sendError(response, error))
    })
    httpServer.keepAliveTimeout = 5000
    await new Promise((resolveListen, rejectListen) => {
      const tryListen = (candidatePort, fallback) => {
        httpServer.once('error', (error) => {
          if (fallback && error.code === 'EADDRINUSE') { httpServer.removeAllListeners('error'); tryListen(0, false); return }
          rejectListen(error)
        })
        httpServer.listen(candidatePort, '127.0.0.1', () => { httpServer.removeAllListeners('error'); resolveListen() })
      }
      tryListen(preferredPort, preferredPort !== 0)
    })
    port = httpServer.address().port
    writeRuntimeFile()
    scheduleIdleCheck()
    await publisher.flush('start')
    if (runs.hasRunning()) ensureRunPolling()
    scheduleBridgeMaintenance()
    if (bridgeMaintenanceMs) maintainBridges().catch(() => {})
    return port
  }

  async function close() {
    if (idleTimer) clearInterval(idleTimer)
    if (runPollTimer) clearInterval(runPollTimer)
    if (bridgeTimer) clearInterval(bridgeTimer)
    removeRuntimeFile()
    if (!httpServer) return
    await new Promise((resolveClose) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolveClose()) })
    httpServer = null
  }

  return {
    listen,
    close,
    get port() { return port },
    get token() { return token },
    settlePanel: () => publisher.settle(),
    store,
    runs
  }
}

export { summarizeSession }
