import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'helpers', 'fake-agent.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-histrepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'checkout', '-q', '-b', 'feat/hist')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\n')
git(repo, 'commit', '-q', '-am', 'add b')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-histplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-histhome-'))
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/hist', displayName: 'feat/hist' }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'terminal') return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
  }
}
const agentCommands = {
  claude: { command: process.execPath, args: [fakeAgent], answerArgs: [fakeAgent], env: { FAKE_AGENT_ANSWER: '1', FAKE_AGENT_EDIT: join(repo, 'a.js') } },
  codex: { command: process.execPath, args: [fakeAgent], env: {} }
}
const server = createServer({ homeDir, pluginRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
const base = `http://127.0.0.1:${server.port}`
const headers = { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }
const api = async (method, path, body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function finished(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = (await api('GET', `/api/runs/${runId}`)).body.run
    if (run.status !== 'running' && run.status !== 'queued') return run
    await wait(100)
  }
  return null
}
// The panel document is regenerated asynchronously: poll until the data block satisfies the check.
async function panelData(check) {
  let data = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const path = join(pluginRoot, 'panel.html')
    if (existsSync(path)) {
      const match = /<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/.exec(readFileSync(path, 'utf8'))
      if (match) { data = JSON.parse(match[1]); if (check(data)) return data }
    }
    await wait(100)
  }
  return data
}

after(async () => { await server.close() })

let sessionId
let answerRunId
let fixRunId
const session = async () => (await api('GET', `/api/sessions/${sessionId}`)).body.session

test('every AI run is kept in the session history, newest first, with what it was asked and what it changed', async () => {
  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })
  sessionId = created.body.id
  await api('POST', `/api/sessions/${sessionId}/threads`, { revision: (await session()).revision, path: 'a.js', side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: '이름을 바꿔 주세요' })

  const answerStart = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'answer' })
  answerRunId = answerStart.body.id
  assert.equal((await finished(answerRunId)).status, 'succeeded')

  const thread = (await session()).threads[0]
  await api('POST', `/api/sessions/${sessionId}/threads/${thread.id}/comments`, { revision: (await session()).revision, body: '네, 고쳐 주세요' })
  const fixStart = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude' })
  fixRunId = fixStart.body.id
  const fix = await finished(fixRunId)
  assert.equal(fix.status, 'succeeded')
  assert.deepEqual(fix.changedFiles, ['a.js'])
  assert.equal(fix.branch, 'feat/hist', 'the branch it ran on is recorded')
  assert.equal(fix.threadSnapshots[0].path, 'a.js')

  const data = await panelData((value) => (value.runHistory?.[sessionId] ?? []).length === 2 && value.runHistory[sessionId][0].hasChanges)
  const history = data.runHistory[sessionId]
  assert.deepEqual(history.map((row) => row.id), [fixRunId, answerRunId], 'newest first')
  assert.equal(history[0].mode, 'fix')
  assert.deepEqual(history[0].changedFiles, ['a.js'])
  assert.equal(history[0].hasChanges, true)
  assert.equal(history[0].threadCount, 1)
  assert.equal(history[1].mode, 'answer')
  assert.equal(history[1].answeredCount, 1)
  assert.equal(history[1].hasChanges, false)
  for (const row of history) for (const key of ['logTail', 'nonce', 'fingerprintsBefore', 'threadSnapshots']) assert.ok(!(key in row), `${key} stays out of the list`)

  // one request = its questions and the answers they got, all in the list row, so opening it needs no round trip
  const asked = history[1].threads[0]
  assert.equal(asked.path, 'a.js')
  assert.ok(asked.comments.some((comment) => comment.body.includes('이름을 바꿔 주세요')), 'the question the answer belongs to')
  assert.ok(asked.answer.includes('에 대한 설명입니다'), 'the answer sits on the question it answers')
  const requested = history[0].threads[0]
  assert.ok(requested.comments.some((comment) => comment.body.includes('네, 고쳐 주세요')), 'the request that started the fix')
  assert.ok(history[0].summary.includes('fake agent received'), 'what the AI reported back after the fix')
  const embedded = history[0].aiChanges.find((entry) => entry.path === 'a.js')
  assert.ok(embedded.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text.includes('edited by fake agent')), 'the newest diff is already in the list')
  assert.ok(!('aiChanges' in history[1]), 'an answer run has no diff')
  const stored = (await api('GET', `/api/runs/${answerRunId}`)).body.run
  assert.equal(stored.answers[0].threadId, asked.id, 'the answers are kept in the run record')
  assert.equal(data.runDetail?.[sessionId], undefined, 'no run is open until one is picked')
  assert.ok(existsSync(join(homeDir, 'runs', fixRunId, 'changes.json')), 'the AI diff is saved with the run')
  assert.ok(!existsSync(join(homeDir, 'runs', answerRunId, 'changes.json')), 'an answer run changes nothing, so nothing is saved')
})

test('opening a past run shows its diff and its threads even after the change was committed', async () => {
  git(repo, 'commit', '-q', '-am', 'accept the AI fix')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the working tree is clean again, so the live diff is gone')

  const opened = await api('POST', '/api/bridge', { op: 'run.view', sessionId, runId: fixRunId })
  assert.equal(opened.status, 200)
  const data = await panelData((value) => value.runDetail?.[sessionId]?.runId === fixRunId)
  const detail = data.runDetail[sessionId]
  assert.equal(detail.runId, fixRunId)
  assert.equal(detail.mode, 'fix')
  assert.ok(!('threads' in detail), 'the questions travel with the list rows; the opened run only adds the heavy parts')
  const file = detail.aiChanges.find((entry) => entry.path === 'a.js')
  assert.ok(file, 'the saved diff is still there')
  assert.ok(file.hunks.flatMap((hunk) => hunk.lines).some((line) => line.type === 'add' && line.text.includes('edited by fake agent')))
  assert.ok(detail.logTail.includes('fake agent received'), 'the agent output is available')
  assert.ok(!('nonce' in detail) && !('fingerprintsBefore' in detail))
})

test('only one past run is open at a time, and it can be closed', async () => {
  await api('POST', '/api/bridge', { op: 'run.view', sessionId, runId: answerRunId })
  const switched = await panelData((value) => value.runDetail?.[sessionId]?.runId === answerRunId)
  assert.equal(switched.runDetail[sessionId].runId, answerRunId)
  assert.deepEqual(switched.runDetail[sessionId].aiChanges ?? [], [], 'an answer run has no diff')

  const closed = await api('POST', '/api/bridge', { op: 'run.view', sessionId, runId: null })
  assert.equal(closed.status, 200)
  const data = await panelData((value) => value.runDetail?.[sessionId] === undefined)
  assert.equal(data.runDetail?.[sessionId], undefined)
})

test('a run that is not in this session\'s history cannot be opened', async () => {
  assert.equal((await api('POST', '/api/bridge', { op: 'run.view', sessionId, runId: 'run_ffffffffffff' })).status, 404)
  assert.equal((await api('POST', '/api/bridge', { op: 'run.view', sessionId, runId: '../../etc/passwd' })).status, 404)
  assert.equal((await api('POST', '/api/bridge', { op: 'run.view', sessionId: 'ses_ffffffffffff', runId: fixRunId })).status, 404)
})
