import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'helpers', 'fake-agent.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-answerrepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'checkout', '-q', '-b', 'feat/ask')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\n')
git(repo, 'commit', '-q', '-am', 'add b')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-answerplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-answerhome-'))
const promptOut = join(homeDir, 'prompt-received.md')
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/ask', displayName: 'feat/ask' }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'terminal') return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
  }
}
// claude can answer (answerArgs); codex deliberately has no read-only answer command configured.
const agentCommands = {
  claude: { command: process.execPath, args: [fakeAgent], answerArgs: [fakeAgent], env: { FAKE_AGENT_PROMPT_OUT: promptOut, FAKE_AGENT_ANSWER: '1' } },
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
async function waitFor(check, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check()
    if (value) return value
    await wait(100)
  }
  return null
}

after(async () => { await server.close() })

let sessionId
let threadId
const session = async () => (await api('GET', `/api/sessions/${sessionId}`)).body.session

test('asking for an answer: the AI replies in the thread, the thread stays open, and no code is touched', async () => {
  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: repo, baseRef: 'main' })
  assert.equal(created.status, 201)
  sessionId = created.body.id
  const added = await api('POST', `/api/sessions/${sessionId}/threads`, { revision: (await session()).revision, path: 'a.js', side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: '이 b 는 왜 필요한가요?' })
  assert.equal(added.status, 200)
  threadId = added.body.threads[0].id

  const started = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'answer' })
  assert.equal(started.status, 202)
  assert.equal(started.body.mode, 'answer')
  const answered = await waitFor(async () => { const current = await session(); return current.threads[0].comments.length === 2 ? current : null })
  assert.ok(answered, 'the answer was appended to the thread')
  const [question, answer] = answered.threads[0].comments
  assert.equal(question.author, undefined, 'the reviewer comment is unchanged')
  assert.equal(answer.author, 'ai')
  assert.equal(answer.agent, 'claude')
  assert.match(answer.body, new RegExp(`답변: ${threadId} 에 대한 설명입니다\\.\\n둘째 줄`))
  assert.equal(answered.threads[0].status, 'open', 'the reviewer decides when a thread is resolved')
  assert.notEqual(answered.status, 'fixing')
  assert.notEqual(answered.status, 'rechecking', 'an answer run does not change the review status')

  const run = (await api('GET', `/api/runs/${started.body.id}`)).body.run
  assert.equal(run.status, 'succeeded')
  assert.equal(run.mode, 'answer')
  assert.deepEqual(run.answered, [threadId])
  assert.deepEqual(run.unanswered, [])
  const prompt = readFileSync(promptOut, 'utf8')
  assert.match(prompt, /이 b 는 왜 필요한가요\?/)
  assert.match(prompt, /수정하지/)
})

test('a thread the AI already answered is not asked again until the reviewer replies', async () => {
  const again = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'answer' })
  assert.equal(again.status, 400)
  assert.equal(again.body.error.code, 'no_runnable_threads')

  const reply = await api('POST', `/api/sessions/${sessionId}/threads/${threadId}/comments`, { revision: (await session()).revision, body: '그럼 c 로 바꿔도 되나요?' })
  assert.equal(reply.status, 200)
  const started = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'answer' })
  assert.equal(started.status, 202)
  const followed = await waitFor(async () => { const current = await session(); return current.threads[0].comments.length === 4 ? current : null })
  assert.ok(followed, 'a second answer was appended after the follow-up question')
  assert.equal(followed.threads[0].comments[3].author, 'ai')
  const prompt = readFileSync(promptOut, 'utf8')
  assert.match(prompt, /그럼 c 로 바꿔도 되나요\?/)
  assert.match(prompt, /에 대한 설명입니다/, 'the earlier AI answer is part of the history the agent sees')
})

test('an agent that has no read-only answer command configured is refused instead of being run with edit rights', async () => {
  await api('POST', `/api/sessions/${sessionId}/threads/${threadId}/comments`, { revision: (await session()).revision, body: '한 번 더요' })
  const refused = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'codex', mode: 'answer' })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'answer_unsupported')
})

test('an unknown run mode is rejected', async () => {
  const bad = await api('POST', `/api/sessions/${sessionId}/runs`, { revision: (await session()).revision, agent: 'claude', mode: 'bogus' })
  assert.equal(bad.status, 400)
})
