import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// GitGraph's branch review: the remote-only branch is materialised in a detached worktree that names the branch.
const branch = 'feat/GRT-11472-popup-audit'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-detint-')))
const remote = join(root, 'remote.git'), work = join(root, 'work'), review = join(root, 'review')
git(root, 'init', '-q', '--bare', '-b', 'main', remote)
git(root, 'clone', '-q', remote, work)
git(work, 'config', 'user.name', 't'); git(work, 'config', 'user.email', 't@t')
writeFileSync(join(work, 'a.js'), 'const a = 1\n')
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base')
git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
writeFileSync(join(work, 'a.js'), 'const a = 1\nconst b = 2\n')
git(work, 'commit', '-q', '-am', 'feature')
git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
git(work, 'fetch', '-q', 'origin')
git(work, 'worktree', 'add', '-q', '--detach', review, `origin/${branch}`)
writeFileSync(resolve(review, git(review, 'rev-parse', '--git-path', 'self-review-publish-target')), `refs/remotes/origin/${branch}\n`)

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-detplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
    if (command.endsWith('orca')) return { stdout: JSON.stringify({ ok: true, result: { repos: [], worktrees: [], terminals: [] } }), stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command}`, code: 1 }
  }
}
const server = createServer({ homeDir: mkdtempSync(join(tmpdir(), 'sr-dethome-')), pluginRoot, runners, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
after(async () => { await server.close() })
const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

test('the uncommitted changes of a detached branch review are published to the reviewed branch from the web UI flow', async () => {
  const created = await api('POST', '/api/sessions', { kind: 'local', repoPath: review, baseRef: 'origin/main' })
  assert.equal(created.body.branch, 'HEAD')
  writeFileSync(join(review, 'a.js'), 'const a = 1\nconst renamed = 2\n')
  const preview = await api('GET', `/api/sessions/${created.body.id}/publish-preview`)
  assert.equal(preview.status, 200)
  assert.equal(preview.body.publishBranch, branch)
  assert.match(preview.body.message, /^\[GRT-11472\] - /, 'the suggested message carries the reviewed branch ticket')
  const published = await api('POST', `/api/sessions/${created.body.id}/publish`, { snapshot: preview.body.snapshot, paths: ['a.js'], message: preview.body.message })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(review, 'rev-parse', 'HEAD'))
  assert.equal(git(review, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
})
