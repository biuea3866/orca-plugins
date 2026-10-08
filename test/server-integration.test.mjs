import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const fakeAgent = join(here, 'helpers', 'fake-agent.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

function makeRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\nexport { a }\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'checkout', '-q', '-b', 'feat/x')
  writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 3\nconst c = 4\nexport { a }\n')
  git(repo, 'commit', '-q', '-am', 'change')
  writeFileSync(join(repo, 'notes.md'), 'todo\n')
  return repo
}

const repo = makeRepo()
const homeDir = mkdtempSync(join(tmpdir(), 'sr-home-'))
const promptOut = join(homeDir, 'prompt-received.md')
const execCalls = []

const runners = {
  exec: async (command, args, options) => {
    execCalls.push([command, ...args])
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: { remoteUrl: 'https://github.com/o/demo.git' } }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/x', displayName: 'feat/x' }] } }), stderr: '', code: 0 }
    if (command.endsWith('gh') && args[1] === 'list') return { stdout: JSON.stringify([{ number: 1, title: 'PR one', isDraft: true, headRefName: 'feat/x', baseRefName: 'main', author: { login: 'me' }, updatedAt: 'x', url: 'u', additions: 1, deletions: 0, changedFiles: 1 }]), stderr: '', code: 0 }
    if (command.endsWith('gh') && args[1] === 'view') return { stdout: JSON.stringify({ number: 1, title: 'PR one', body: 'hi', isDraft: true, author: { login: 'me' }, baseRefName: 'main', headRefName: 'feat/x', headRefOid: 'sha', url: 'u', additions: 1, deletions: 0, changedFiles: 1, updatedAt: 'x', state: 'OPEN' }), stderr: '', code: 0 }
    if (command.endsWith('gh') && args[1] === 'diff') return { stdout: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n', stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
  }
}

const agentCommands = {
  claude: { command: process.execPath, args: [fakeAgent], env: { FAKE_AGENT_PROMPT_OUT: promptOut, FAKE_AGENT_EDIT: `${join(repo, 'a.js')},${join(repo, 'notes.md')}` } },
  codex: { command: process.execPath, args: [fakeAgent], env: { FAKE_AGENT_SLEEP_MS: '5000' } }
}

const panelRoot = mkdtempSync(join(tmpdir(), 'sr-panel-'))
const server = createServer({ homeDir, pluginRoot, panelRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
const base = `http://127.0.0.1:${server.port}`
const headers = { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }
const api = async (method, path, body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

after(async () => { await server.close() })

test('health needs no token; api needs token; runtime file written', async () => {
  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.protocolVersion, 1)
  const unauthorized = await fetch(`${base}/api/sessions`)
  assert.equal(unauthorized.status, 401)
  const runtime = JSON.parse(readFileSync(join(homeDir, 'runtime', 'server.json'), 'utf8'))
  assert.equal(runtime.port, server.port)
  assert.equal(runtime.token, server.token)
})

test('GET / serves the UI document with the token meta injected', async () => {
  const html = await (await fetch(`${base}/`)).text()
  assert.match(html, new RegExp(`<meta name="sr-token" content="${server.token}">`))
})

test('context + session + diff + threads + applicability', async () => {
  const context = await api('GET', `/api/context?path=${encodeURIComponent(repo)}`)
  assert.equal(context.status, 200)
  assert.equal(context.body.repoPath, repo)
  assert.equal(context.body.branch, 'feat/x')
  assert.ok(context.body.baseCandidates.includes('main'))
  assert.equal(context.body.defaultBase, 'main')
  assert.equal(context.body.worktreeId, `r1::${repo}`)

  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main', includeWorkingTree: true, includeUntracked: true })
  assert.equal(created.status, 201)
  const sessionId = created.body.id
  const again = await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })
  assert.equal(again.body.id, sessionId, 'idempotent')
  assert.equal(again.body.includeWorkingTree, true, 'reuse keeps the existing session settings')

  const detail = await api('GET', `/api/sessions/${sessionId}`)
  assert.equal(detail.status, 200)
  const paths = detail.body.diff.files.map((file) => [file.path, file.changeType])
  assert.deepEqual(paths, [['a.js', 'modified'], ['notes.md', 'untracked']])
  assert.ok(detail.body.diff.mergeBaseSha)
  const aFile = detail.body.diff.files[0]
  const addLines = aFile.hunks[0].lines.filter((line) => line.type === 'add')
  assert.deepEqual(addLines.map((line) => [line.newNo, line.text]), [[2, 'const b = 3'], [3, 'const c = 4']])

  const bad = await api('POST', `/api/sessions/${sessionId}/threads`, { revision: detail.body.session.revision, path: 'a.js', side: 'new', startLine: 3, endLine: 2, selectedText: '', body: 'x' })
  assert.equal(bad.status, 400)

  const withThread = await api('POST', `/api/sessions/${sessionId}/threads`, { revision: detail.body.session.revision, path: 'a.js', side: 'new', startLine: 2, endLine: 3, selectedText: 'const b = 3\nconst c = 4', body: 'use let' })
  assert.equal(withThread.status, 200)
  assert.equal(withThread.body.threads.length, 1)
  const stale = await api('POST', `/api/sessions/${sessionId}/threads`, { revision: detail.body.session.revision, path: 'a.js', side: 'new', startLine: 1, endLine: 1, selectedText: 'const a = 1', body: 'y' })
  assert.equal(stale.status, 409)

  const detail2 = await api('GET', `/api/sessions/${sessionId}`)
  assert.equal(detail2.body.session.threads[0].applicability, 'current')

  const summaries = await api('GET', '/api/sessions')
  assert.deepEqual(summaries.body[0].threads, { open: 1, resolved: 0 })
})

test('overview aggregates orca repos, worktrees and read-only gh PR lists', async () => {
  const overview = await api('GET', '/api/overview')
  assert.equal(overview.status, 200)
  assert.equal(overview.body.repos.length, 1)
  assert.equal(overview.body.repos[0].displayName, 'demo')
  assert.equal(overview.body.repos[0].worktrees[0].branch, 'feat/x')
  assert.equal(overview.body.repos[0].prs[0].isDraft, true)
  assert.equal(overview.body.github.enabled, true)
  assert.ok(execCalls.every(([command, ...args]) => !command.endsWith('gh') || ['list', 'view', 'diff'].includes(args[1])), 'only read-only gh commands')
})

test('pr detail and pr session', async () => {
  const detail = await api('GET', '/api/prs/o/demo/1')
  assert.equal(detail.status, 200)
  assert.equal(detail.body.pr.title, 'PR one')
  assert.equal(detail.body.diff.files[0].path, 'a.js')
  assert.equal(detail.body.localWorktree.path, repo)
  const session = await api('POST', '/api/sessions', { kind: 'pr', owner: 'o', repo: 'demo', number: 1 })
  assert.equal(session.status, 201)
  assert.equal(session.body.kind, 'pr')
  assert.equal(session.body.repoPath, repo)
  const prSessionDetail = await api('GET', `/api/sessions/${session.body.id}`)
  assert.equal(prSessionDetail.body.diff.files[0].hunks[0].lines[1].text, 'const a = 2')
})

test('agents endpoint reports availability from injected commands', async () => {
  const agents = await api('GET', '/api/agents')
  assert.equal(agents.body.claude.available, true)
})

test('AI run: prompt built, agent edits file, status succeeded, changedFiles, log; duplicate run 409; cancel works', async () => {
  const sessions = await api('GET', '/api/sessions')
  const sessionId = sessions.body.find((session) => session.kind === 'local').id
  const detail = await api('GET', `/api/sessions/${sessionId}`)
  const started = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: detail.body.session.revision, agent: 'claude' })
  assert.equal(started.status, 202)
  const runId = started.body.id
  let run
  for (let attempt = 0; attempt < 50; attempt += 1) {
    run = (await api('GET', `/api/runs/${runId}`)).body
    if (run.run.status !== 'running' && run.run.status !== 'queued') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(run.run.status, 'succeeded')
  assert.equal(run.run.exitCode, 0)
  assert.match(run.log, /fake agent received/)
  assert.ok(existsSync(promptOut))
  const prompt = readFileSync(promptOut, 'utf8')
  assert.match(prompt, /use let/)
  assert.match(prompt, /git push/)
  assert.deepEqual(run.run.changedFiles, ['a.js', 'notes.md'], 'includes a file that was already dirty before the run')
  const after1 = await api('GET', `/api/sessions/${sessionId}`)
  assert.equal(after1.body.session.status, 'rechecking')
  assert.equal(after1.body.session.threads[0].applicability, 'outdated', 'agent edit made the thread outdated')

  // reset the thread so a second run has a runnable thread, then cancel a slow run
  const reopened = await api('POST', `/api/sessions/${sessionId}/threads`, { revision: after1.body.session.revision, path: 'a.js', side: 'new', startLine: 1, endLine: 1, selectedText: 'edited by fake agent', body: 'slow' })
  assert.equal(reopened.status, 200)
  const slow = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: reopened.body.revision, agent: 'codex' })
  assert.equal(slow.status, 202)
  const current = await api('GET', `/api/sessions/${sessionId}`)
  const duplicate = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: current.body.session.revision, agent: 'codex' })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.extra?.runId ?? duplicate.body.error.runId, slow.body.id)
  const cancelled = await api('POST', `/api/runs/${slow.body.id}/cancel`)
  assert.equal(cancelled.status, 200)
  let final
  for (let attempt = 0; attempt < 50; attempt += 1) {
    final = (await api('GET', `/api/runs/${slow.body.id}`)).body.run
    if (final.status === 'cancelled') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(final.status, 'cancelled')
  const shutdownDenied = await api('POST', '/api/shutdown')
  assert.equal(shutdownDenied.status, 200, 'no running run anymore, shutdown accepted')
})
