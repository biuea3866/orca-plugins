import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-brepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
git(repo, 'checkout', '-q', '-b', 'feat/panel')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\n')

// a fake plugin root with a panel template; the server regenerates panel/index.html inside it
const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-plugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-bhome-'))
const tabCalls = []
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/panel', displayName: 'feat/panel' }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'tab') { tabCalls.push(args); return { stdout: '{"ok":true}', stderr: '', code: 0 } }
    if (command.endsWith('orca') && args[0] === 'terminal') return { stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_bridge', ptyId: 'pty_bridge', worktreePath: repo }] } }), stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
  }
}
const server = createServer({ homeDir, pluginRoot, runners, agentCommands: { claude: { command: '/nonexistent', args: [] }, codex: { command: '/nonexistent', args: [] } }, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
const base = `http://127.0.0.1:${server.port}`
const headers = { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }
const api = async (method, path, body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const panelPath = join(pluginRoot, 'panel.html')
const readPanelData = () => JSON.parse(/<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/.exec(readFileSync(panelPath, 'utf8'))[1])
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

after(async () => { await server.close() })

test('server writes the panel document on start with worktree inventory and no sessions', async () => {
  await server.settlePanel()
  assert.ok(existsSync(panelPath))
  const data = readPanelData()
  assert.equal(data.schemaVersion, 1)
  assert.equal(data.worktrees[0].path, repo)
  assert.equal(data.worktrees[0].branch, 'feat/panel')
  assert.equal(data.worktrees[0].sessionId, null)
  assert.deepEqual(data.sessions, {})
})

test('bridge register binds terminal ids to a worktree and shows up in panel data', async () => {
  const registered = await api('POST', '/api/bridge/register', { worktreePath: repo, terminalHandle: 'term_bridge', panelTerminalId: 'pty_bridge' })
  assert.equal(registered.status, 200)
  await server.settlePanel()
  const data = readPanelData()
  assert.deepEqual(data.worktrees[0].bridgeTerminalIds.sort(), ['pty_bridge', 'term_bridge'])
  assert.deepEqual(data.worktrees[0].terminalIds.sort(), ['pty_bridge', 'term_bridge'], 'live terminals of the worktree are listed for panel matching')
})

test('bridge unregister removes only the given terminal ids, keeping other live bridges', async () => {
  await api('POST', '/api/bridge/register', { worktreePath: repo, terminalHandle: 'term_second', panelTerminalId: null, ptyId: 'pty_second' })
  const removed = await api('POST', '/api/bridge/unregister', { worktreePath: repo, terminalHandle: 'term_second', ptyId: 'pty_second' })
  assert.equal(removed.status, 200)
  await server.settlePanel()
  assert.deepEqual(readPanelData().worktrees[0].bridgeTerminalIds.sort(), ['pty_bridge', 'term_bridge'])
})

test('bridge ops create a session, add a thread, keep view state without regenerating, and open the wide view', async () => {
  const opened = await api('POST', '/api/bridge', { op: 'session.open', worktreePath: repo })
  assert.equal(opened.status, 200)
  const sessionId = opened.body.result.id
  await server.settlePanel()
  let data = readPanelData()
  assert.equal(data.worktrees[0].sessionId, sessionId)
  assert.equal(data.sessions[sessionId].diff.files[0].path, 'a.js')
  const revision = data.sessions[sessionId].session.revision

  const added = await api('POST', '/api/bridge', { op: 'thread.add', sessionId, revision, path: 'a.js', oldPath: null, side: 'new', startLine: 2, endLine: 2, selectedText: 'const b = 2', body: 'why b?' })
  assert.equal(added.status, 200)
  await server.settlePanel()
  data = readPanelData()
  assert.equal(data.sessions[sessionId].session.threads.length, 1)
  assert.equal(data.sessions[sessionId].session.threads[0].applicability, 'current')

  const before = readFileSync(panelPath, 'utf8')
  const viewed = await api('POST', '/api/bridge', { op: 'view', sessionId, file: 'a.js', scroll: 42, route: 'review' })
  assert.equal(viewed.status, 200)
  await server.settlePanel()
  assert.equal(readFileSync(panelPath, 'utf8'), before, 'view ops do not regenerate the panel')
  const refreshed = await api('POST', '/api/bridge', { op: 'overview.refresh' })
  assert.equal(refreshed.status, 200)
  await server.settlePanel()
  data = readPanelData()
  assert.deepEqual(data.viewState[sessionId], { file: 'a.js', scroll: 42, route: 'review' })

  const wide = await api('POST', '/api/bridge', { op: 'wide', sessionId })
  assert.equal(wide.status, 200)
  assert.ok(tabCalls.some((args) => args[0] === 'tab' && args[1] === 'create' && args.includes('--url')))

  const bad = await api('POST', '/api/bridge', { op: 'nope' })
  assert.equal(bad.status, 400)
})
