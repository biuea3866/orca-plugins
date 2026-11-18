import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const fakeAgent = join(mkdtempSync(join(tmpdir(), 'sr-out-agent-')), 'agent.mjs')
writeFileSync(fakeAgent, `import {readFileSync} from 'node:fs';const p=readFileSync(0,'utf8');for(const m of p.matchAll(/### 스레드 \\d+ — (thr_[0-9a-f]+)/g))console.log('- '+m[1]+': 수행 — handled');`)

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-outrepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'checkout', '-q', '-b', 'feat/out')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\nconst c = 3\n')
git(repo, 'commit', '-q', '-am', 'add b and c')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-outplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true }); mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-outhome-'))
const runners = { exec: async (command, args, options) => {
  if (command.endsWith('git')) return execCommand(command, args, options)
  return { stdout: JSON.stringify({ ok: true, result: { repos: [], worktrees: [], terminals: [] } }), stderr: '', code: 0 }
} }
const agentCommands = { claude: { command: process.execPath, args: [fakeAgent], answerArgs: [fakeAgent], env: {} }, codex: { command: process.execPath, args: [fakeAgent], env: {} } }
const server = createServer({ homeDir, pluginRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
after(async () => { await server.close() })
const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
async function finished(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = (await api('GET', `/api/runs/${runId}`)).body.run
    if (run.status !== 'running' && run.status !== 'queued') return run
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

test('a comment whose code moved before any fix completed is still sent to the AI and gets a reply', async () => {
  let session = (await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })).body
  session = (await api('POST', `/api/sessions/${session.id}/threads`, { revision: session.revision, path: 'a.js', side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: 'rename b to total' })).body
  const thread = session.threads[0]
  // the code under the comment changes (an earlier AI edit, the user's own edit or a new commit) before the request is ever run
  writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst total = 2\nconst c = 3\n')
  git(repo, 'commit', '-q', '-am', 'rename b by hand')
  session = (await api('GET', `/api/sessions/${session.id}`)).body.session
  assert.equal(session.threads[0].applicability, 'outdated')
  assert.equal(session.threads[0].comments.some((comment) => comment.fixCompletedAt), false, 'no request of this thread was ever completed')

  const started = await api('POST', `/api/sessions/${session.id}/runs`, { revision: session.revision, agent: 'claude', mode: 'fix' })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const record = (await api('GET', `/api/runs/${started.body.id}`)).body.run
  assert.deepEqual(record.threadIds, [thread.id])
  assert.equal(record.requestedComments[0].body, 'rename b to total')
  await finished(started.body.id)
  const after = (await api('GET', `/api/sessions/${session.id}`)).body.session
  const reply = after.threads[0].comments.find((comment) => comment.kind === 'fix-result')
  assert.ok(reply, 'the AI reply is visible under the comment')
  assert.equal(reply.replyToCommentId, thread.comments[0].id)
  const prompt = readFileSync(join(homeDir, 'runs', started.body.id, 'prompt.md'), 'utf8')
  assert.match(prompt, /코드 위치 변경됨/)
  assert.match(prompt, /이미 반영/, 'an already satisfied request is reported, not applied twice')
  assert.match(prompt, /이번 수정 요청.*rename b to total/)
  assert.match(prompt, /수행 — 이미 반영됨/, 'an already satisfied request is reported as handled, so it does not stay pending')
  const again = await api('POST', `/api/sessions/${session.id}/runs`, { revision: after.revision, agent: 'claude', mode: 'fix' })
  assert.equal(again.status, 400, 'once reported as handled the comment is not sent again')
  assert.equal(again.body.error.code, 'no_runnable_threads')
})

test('the answer to an AI question on a thread whose code changed is not dropped either', async () => {
  let session = (await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })).body
  session = (await api('POST', `/api/sessions/${session.id}/threads`, { revision: session.revision, path: 'a.js', side: 'new', startLine: 3, endLine: 3, selectedText: 'const c = 3', body: 'use a constant' })).body
  const thread = session.threads.find((entry) => entry.comments[0].body === 'use a constant')
  server.store.appendAiComments(session.id, [{ threadId: thread.id, body: 'Which constant name do you want?', agent: 'claude', runId: 'run_0000000000aa', kind: 'question' }])
  writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst total = 2\nconst renamed = 3\n')
  git(repo, 'commit', '-q', '-am', 'edit near c')
  session = (await api('GET', `/api/sessions/${session.id}`)).body.session
  const answered = await api('POST', `/api/sessions/${session.id}/threads/${thread.id}/comments`, { revision: session.revision, body: 'call it LIMIT' })
  assert.equal(answered.status, 200)
  const current = (await api('GET', `/api/sessions/${session.id}`)).body.session
  assert.equal(current.threads.find((entry) => entry.id === thread.id).applicability, 'outdated')
  const started = await api('POST', `/api/sessions/${session.id}/runs`, { revision: current.revision, agent: 'claude', mode: 'fix' })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const record = (await api('GET', `/api/runs/${started.body.id}`)).body.run
  assert.ok(record.requestedComments.some((request) => request.body === 'call it LIMIT'))
  await finished(started.body.id)
})

test('a run orphaned by a server restart still replies under the comment and marks it completed', async () => {
  // a fresh server over the same data: the previous process died while the agent was running
  const dirRepo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-orph-repo-')))
  git(dirRepo, 'init', '-q', '-b', 'main'); writeFileSync(join(dirRepo, 'a.js'), 'const a = 1\n'); git(dirRepo, 'add', '.'); git(dirRepo, 'commit', '-q', '-m', 'base')
  git(dirRepo, 'checkout', '-q', '-b', 'feat/orph'); writeFileSync(join(dirRepo, 'a.js'), 'const a = 1\nconst b = 2\n'); git(dirRepo, 'commit', '-q', '-am', 'add b')
  const dirHome = mkdtempSync(join(tmpdir(), 'sr-orph-home-'))
  const boot = async () => { const s = createServer({ homeDir: dirHome, pluginRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 }); await s.listen(); return s }
  const first = await boot()
  const call = (s) => async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { 'X-SR-Token': s.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) } }
  let request = call(first)
  let session = (await request('POST', '/api/sessions', { kind: 'local', repoPath: dirRepo, baseRef: 'main' })).body
  session = (await request('POST', `/api/sessions/${session.id}/threads`, { revision: session.revision, path: 'a.js', side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: 'rename b' })).body
  const thread = session.threads[0], comment = thread.comments[0]
  await first.close()
  // what the dead process left: a run record that still says `running`, the agent's report in its log, and the edit
  const runId = 'run_0a0b0c0d0e0f', dir = join(dirHome, 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, id: runId, sessionId: session.id, agent: 'claude', mode: 'fix', nonce: 'zz11', threadIds: [thread.id], requestedComments: [{ threadId: thread.id, commentId: comment.id, body: comment.body, updatedAt: comment.updatedAt }], cwd: dirRepo, pid: 2_000_000_000, status: 'running', exitCode: null, startedAt: new Date().toISOString(), endedAt: null, changedFiles: [], fingerprintsBefore: {} }))
  writeFileSync(join(dir, 'output.log'), `@@FIX:${comment.id}:zz11@@\n이름을 total 로 바꿨습니다\n@@END:zz11@@\n- ${thread.id}: 수행 — renamed\n`)
  writeFileSync(join(dirRepo, 'a.js'), 'const a = 1\nconst total = 2\n')

  const second = await boot()
  request = call(second)
  try {
    // the takeover runs after the server is up, without holding the start-up back
    for (let attempt = 0; attempt < 100; attempt += 1) { if ((await request('GET', `/api/runs/${runId}`)).body.run.status !== 'running') break; await new Promise((resolve) => setTimeout(resolve, 50)) }
    for (let attempt = 0; attempt < 100; attempt += 1) { if ((await request('GET', `/api/sessions/${session.id}`)).body.session.threads[0].comments.some((entry) => entry.kind === 'fix-result')) break; await new Promise((resolve) => setTimeout(resolve, 50)) }
    const record = (await request('GET', `/api/runs/${runId}`)).body.run
    assert.equal(record.status, 'succeeded')
    assert.deepEqual(record.changedFiles, ['a.js'])
    const after = (await request('GET', `/api/sessions/${session.id}`)).body.session
    const reply = after.threads[0].comments.find((entry) => entry.kind === 'fix-result')
    assert.ok(reply, 'the reply that was lost with the old process is posted')
    assert.match(reply.body, /total/)
    assert.equal(reply.replyToCommentId, comment.id)
    assert.ok(after.threads[0].comments[0].fixCompletedAt, 'the comment is marked completed, so it is not sent again')
  } finally { await second.close() }
})
