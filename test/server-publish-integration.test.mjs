import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'helpers', 'fake-agent.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-pubint-')))
const remote = join(root, 'remote.git')
const repo = join(root, 'work')
git(root, 'init', '-q', '--bare', '-b', 'main', remote)
git(root, 'clone', '-q', remote, repo)
git(repo, 'config', 'user.name', 't')
git(repo, 'config', 'user.email', 't@t')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
git(repo, 'checkout', '-q', '-b', 'feat/pub')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\n')
git(repo, 'commit', '-q', '-am', 'add b')
git(repo, 'push', '-q', '-u', 'origin', 'feat/pub')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-pubplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-pubhome-'))
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/pub', displayName: 'feat/pub' }] } }), stderr: '', code: 0 }
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

after(async () => { await server.close() })

let sessionId
let fixRunId
const session = async () => (await api('GET', `/api/sessions/${sessionId}`)).body.session

test('after an AI fix the run can be committed and pushed, once, to the session branch only', async () => {
  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })
  sessionId = created.body.id
  await api('POST', `/api/sessions/${sessionId}/threads`, { revision: (await session()).revision, path: 'a.js', side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: '이름을 바꿔 주세요' })

  // an answer run changes nothing and can never be published
  const answerStart = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'answer' })
  assert.equal(answerStart.status, 202)
  const answerRun = await finished(answerStart.body.id)
  const refusedAnswer = await api('POST', '/api/bridge', { op: 'run.publish', runId: answerRun.id })
  assert.equal(refusedAnswer.status, 400)
  assert.equal(refusedAnswer.body.error.code, 'not_publishable')

  // a second reviewer comment so the thread waits for the fix run
  const thread = (await session()).threads[0]
  await api('POST', `/api/sessions/${sessionId}/threads/${thread.id}/comments`, { revision: (await session()).revision, body: '네, 고쳐 주세요' })
  const started = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude' })
  assert.equal(started.status, 202)
  fixRunId = started.body.id
  const run = await finished(fixRunId)
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(run.changedFiles, ['a.js'])
  assert.equal(git(repo, 'status', '--porcelain'), 'M a.js', 'the AI edit is only in the working tree')
  const remoteBefore = git(remote, 'rev-parse', 'refs/heads/feat/pub')

  const published = await api('POST', '/api/bridge', { op: 'run.publish', runId: fixRunId })
  assert.equal(published.status, 200)
  const head = git(repo, 'rev-parse', 'HEAD')
  assert.equal(published.body.result.commit, head)
  assert.equal(git(remote, 'rev-parse', 'refs/heads/feat/pub'), head, 'the remote branch moved to the new commit')
  assert.notEqual(head, remoteBefore)
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(repo, 'rev-parse', 'origin/main'), 'main is untouched')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'nothing is left uncommitted')
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.js'])

  const after = (await api('GET', `/api/runs/${fixRunId}`)).body.run
  assert.equal(after.published.commit, head)
  assert.equal(after.published.branch, 'feat/pub')

  const again = await api('POST', '/api/bridge', { op: 'run.publish', runId: fixRunId })
  assert.equal(again.status, 400)
  assert.equal(again.body.error.code, 'not_publishable')
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'a repeated request does not create another commit')
})

test('publishing an unknown run is a 404', async () => {
  const missing = await api('POST', '/api/bridge', { op: 'run.publish', runId: 'run_ffffffffffff' })
  assert.equal(missing.status, 404)
})
