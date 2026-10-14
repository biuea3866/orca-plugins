import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}
const numbered = (count, changed = {}) => Array.from({ length: count }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join('\n') + '\n'
const lineCount = (file) => file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-fullrepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'big.txt'), numbered(40))
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'checkout', '-q', '-b', 'feat/full')
writeFileSync(join(repo, 'big.txt'), numbered(40, { 20: 'line 20 changed' }))
git(repo, 'commit', '-q', '-am', 'change line 20')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-fullplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-fullhome-'))
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/full', displayName: 'feat/full' }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'terminal') return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', code: 0 }
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

after(async () => { await server.close() })

test('file.full puts every line of one file into the panel data, view updates keep it, and turning it off restores the normal diff', async () => {
  const opened = await api('POST', '/api/bridge', { op: 'session.open', worktreePath: repo, baseRef: 'main' })
  assert.equal(opened.status, 200)
  const sessionId = opened.body.result.id
  await server.settlePanel()
  const normal = readPanelData().sessions[sessionId].diff.files[0]
  assert.equal(normal.path, 'big.txt')
  assert.ok(lineCount(normal) < 15)
  assert.equal(normal.fullContext, undefined)

  const on = await api('POST', '/api/bridge', { op: 'file.full', sessionId, path: 'big.txt', full: true })
  assert.equal(on.status, 200)
  await server.settlePanel()
  let data = readPanelData()
  assert.equal(lineCount(data.sessions[sessionId].diff.files[0]), 41)
  assert.equal(data.sessions[sessionId].diff.files[0].fullContext, true)
  assert.deepEqual(data.viewState[sessionId].fullFiles, ['big.txt'])

  await api('POST', '/api/bridge', { op: 'view', sessionId, file: 'big.txt', scroll: 5, route: 'review' })
  await api('POST', '/api/panel/publish')
  await server.settlePanel()
  data = readPanelData()
  assert.deepEqual(data.viewState[sessionId].fullFiles, ['big.txt'], 'scrolling or switching files must not drop the expanded files')
  assert.equal(lineCount(data.sessions[sessionId].diff.files[0]), 41)

  const off = await api('POST', '/api/bridge', { op: 'file.full', sessionId, path: 'big.txt', full: false })
  assert.equal(off.status, 200)
  await server.settlePanel()
  data = readPanelData()
  assert.ok(lineCount(data.sessions[sessionId].diff.files[0]) < 15)
  assert.deepEqual(data.viewState[sessionId].fullFiles, [])
})

test('file.full for a path that is not in the diff is accepted and ignored', async () => {
  const sessions = (await api('GET', '/api/sessions')).body
  const sessionId = sessions[0].id
  const response = await api('POST', '/api/bridge', { op: 'file.full', sessionId, path: 'not-in-diff.txt', full: true })
  assert.equal(response.status, 200)
  await server.settlePanel()
  const file = readPanelData().sessions[sessionId].diff.files[0]
  assert.equal(file.path, 'big.txt')
  assert.ok(lineCount(file) < 15, 'other files are untouched')
  await api('POST', '/api/bridge', { op: 'file.full', sessionId, path: 'not-in-diff.txt', full: false })
})
