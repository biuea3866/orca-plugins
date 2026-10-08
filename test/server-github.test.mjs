import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseGitHubRemote, GitHubReader } from '../server/lib/github.mjs'

test('parseGitHubRemote handles https and ssh urls and rejects others', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/doodlincorp/greeting.git'), { owner: 'doodlincorp', repo: 'greeting' })
  assert.deepEqual(parseGitHubRemote('git@github.com:biuea3866/gitkraken-clone-app.git'), { owner: 'biuea3866', repo: 'gitkraken-clone-app' })
  assert.deepEqual(parseGitHubRemote('ssh://git@github.com/o/r'), { owner: 'o', repo: 'r' })
  assert.equal(parseGitHubRemote('https://gitlab.com/o/r.git'), null)
  assert.equal(parseGitHubRemote(null), null)
})

function makeReader(exec) {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-gh-'))
  let clock = 1_000_000
  const now = () => clock
  const reader = new GitHubReader({ homeDir, exec, now, ghBinary: 'gh' })
  return { reader, advance: (ms) => { clock += ms } }
}

const prJson = JSON.stringify([{ number: 5, title: 'T', isDraft: true, headRefName: 'h', baseRefName: 'main', author: { login: 'me' }, updatedAt: '2026-10-08T00:00:00Z', url: 'u', additions: 1, deletions: 2, changedFiles: 3 }])

test('listOpenPullRequests calls only the read-only gh pr list command and caches for 5 minutes', async () => {
  const calls = []
  const exec = async (command, args) => { calls.push([command, ...args]); return { stdout: prJson, stderr: '', code: 0 } }
  const { reader, advance } = makeReader(exec)
  const first = await reader.listOpenPullRequests({ owner: 'o', repo: 'r' })
  assert.equal(first.prs.length, 1)
  assert.equal(first.prs[0].author, 'me')
  assert.equal(first.prs[0].isDraft, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'gh')
  assert.deepEqual(calls[0].slice(1, 4), ['pr', 'list', '--repo'])
  assert.ok(calls[0].includes('--state') && calls[0].includes('open'))
  await reader.listOpenPullRequests({ owner: 'o', repo: 'r' })
  assert.equal(calls.length, 1, 'served from cache')
  advance(5 * 60_000 + 1)
  await reader.listOpenPullRequests({ owner: 'o', repo: 'r' })
  assert.equal(calls.length, 2, 'refetched after TTL')
  await reader.listOpenPullRequests({ owner: 'o', repo: 'r' }, { force: true })
  assert.equal(calls.length, 3, 'force bypasses cache')
})

test('gh failures are returned as errors, keeping any previous cache', async () => {
  let fail = false
  const exec = async () => fail ? { stdout: '', stderr: 'gh auth login required', code: 4 } : { stdout: prJson, stderr: '', code: 0 }
  const { reader, advance } = makeReader(exec)
  await reader.listOpenPullRequests({ owner: 'o', repo: 'r' })
  fail = true
  advance(10 * 60_000)
  const result = await reader.listOpenPullRequests({ owner: 'o', repo: 'r' })
  assert.equal(result.prs.length, 1, 'stale cache kept')
  assert.match(result.error, /gh auth login required/)
})

test('getPullRequest and getPullRequestDiff use gh pr view / gh pr diff only', async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[1] === 'view') return { stdout: JSON.stringify({ number: 5, title: 'T', body: 'b', isDraft: false, author: { login: 'me' }, baseRefName: 'main', headRefName: 'h', headRefOid: 'sha', url: 'u', additions: 1, deletions: 1, changedFiles: 1, updatedAt: 'x', state: 'OPEN' }), stderr: '', code: 0 }
    return { stdout: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n', stderr: '', code: 0 }
  }
  const { reader } = makeReader(exec)
  const pr = await reader.getPullRequest({ owner: 'o', repo: 'r', number: 5 })
  assert.equal(pr.author, 'me')
  assert.equal(pr.headSha, 'sha')
  const diff = await reader.getPullRequestDiff({ owner: 'o', repo: 'r', number: 5 })
  assert.match(diff, /^diff --git/)
  assert.deepEqual(calls, ['pr view', 'pr diff'])
})
