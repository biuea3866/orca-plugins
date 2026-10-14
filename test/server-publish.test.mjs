import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { publishRun } from '../server/lib/publish.mjs'
import { execCommand } from '../server/lib/exec.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// A local bare repository stands in for GitHub: nothing here talks to the network.
function makeRepos({ branch = 'feat/pub', upstream = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-pub-')))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, work)
  git(work, 'config', 'user.name', 't')
  git(work, 'config', 'user.email', 't@t')
  writeFileSync(join(work, 'a.js'), 'const a = 1\n')
  writeFileSync(join(work, 'other.txt'), 'mine\n')
  writeFileSync(join(work, 'staged.txt'), 'base\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  git(work, 'checkout', '-q', '-b', branch)
  if (upstream) git(work, 'push', '-q', '-u', 'origin', branch)
  return { root, remote, work, branch }
}

const baseRun = (work, extra = {}) => ({ id: 'run_000000000001', mode: 'fix', status: 'succeeded', agent: 'claude', cwd: work, threadIds: ['thr_a', 'thr_b'], changedFiles: ['a.js', 'new.txt'], ...extra })

function recording() {
  const calls = []
  return { calls, exec: async (command, args, options) => { calls.push(args); return execCommand(command, args, options) } }
}

function dirty(work) {
  writeFileSync(join(work, 'a.js'), 'const a = 2\n') // the AI edit
  writeFileSync(join(work, 'new.txt'), 'created by the AI\n') // an untracked file the AI created
  writeFileSync(join(work, 'other.txt'), 'my own uncommitted work\n') // not part of the run
  writeFileSync(join(work, 'staged.txt'), 'staged by me\n')
  git(work, 'add', 'staged.txt') // already staged, not part of the run
}

test('commits only the files the run changed and pushes to the branch upstream', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  const { calls, exec } = recording()
  const result = await publishRun({ exec, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } })
  assert.equal(result.branch, branch)
  assert.equal(result.commit, git(work, 'rev-parse', 'HEAD'))
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit, 'the commit reached the remote')
  assert.deepEqual(git(work, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['a.js', 'new.txt'], 'only the run files are in the commit')
  const message = git(work, 'log', '-1', '--format=%B')
  assert.match(message, /run_000000000001/)
  assert.match(message, /2/, 'the thread count is in the message')
  assert.equal(git(work, 'diff', '--name-only'), 'other.txt', 'my own uncommitted file is still modified and not staged')
  assert.equal(git(work, 'diff', '--cached', '--name-only'), 'staged.txt', 'my own staged file stays staged and uncommitted')
  assert.equal(result.upstreamSet, false)
  const pushes = calls.filter((args) => args.includes('push'))
  assert.equal(pushes.length, 1)
  assert.ok(!pushes[0].some((arg) => /^(-f|--force.*|\+.*)$/.test(arg)), 'never a forced push')
})

test('a branch without an upstream is pushed to origin with tracking set up', async () => {
  const { remote, work, branch } = makeRepos({ branch: 'feat/fresh', upstream: false })
  dirty(work)
  const result = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } })
  assert.equal(result.upstreamSet, true)
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit)
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), `origin/${branch}`)
})

test('shared branches are refused before anything is committed', async () => {
  const { work } = makeRepos()
  git(work, 'checkout', '-q', 'main')
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch: 'main' } }), (error) => error.code === 'protected_branch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head)
})

test('refuses when the worktree is no longer on the session branch', async () => {
  const { work } = makeRepos()
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch: 'feat/something-else' } }), (error) => error.code === 'branch_mismatch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head)
})

test('only a finished fix run with changed files that was not published yet can be published', async () => {
  const { work, branch } = makeRepos()
  dirty(work)
  const session = { repoPath: work, branch }
  const refused = async (run) => assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run, session }), (error) => error.code === 'not_publishable')
  await refused(baseRun(work, { mode: 'answer' }))
  await refused(baseRun(work, { status: 'failed' }))
  await refused(baseRun(work, { status: 'running' }))
  await refused(baseRun(work, { changedFiles: [] }))
  await refused(baseRun(work, { published: { commit: 'abc', branch, at: 'x' } }))
})

test('a failed push keeps the local commit and reports it', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  rmSync(remote, { recursive: true, force: true })
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } }), (error) => {
    assert.equal(error.code, 'push_failed')
    assert.equal(error.extra?.commit, git(work, 'rev-parse', 'HEAD'), 'the commit stays and is reported so it can be pushed by hand')
    return true
  })
})

test('a push that failed can be retried without making a second commit', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  git(work, 'remote', 'set-url', 'origin', join(work, 'no-such-remote.git'))
  const session = { repoPath: work, branch }
  const failure = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session }).catch((error) => error)
  assert.equal(failure.code, 'push_failed')
  const commit = failure.extra.commit
  git(work, 'remote', 'set-url', 'origin', remote)
  const retried = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work, { publishError: { commit } }), session })
  assert.equal(retried.commit, commit)
  assert.equal(git(work, 'rev-parse', 'HEAD'), commit, 'no extra commit was made')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), commit)
})

test('a branch that tracks a differently named upstream (for example main) is refused before committing', async () => {
  const { work, branch } = makeRepos()
  git(work, 'branch', '--set-upstream-to=origin/main', branch)
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } }), (error) => error.code === 'upstream_mismatch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'nothing was committed')
})

test('paths are taken literally, so a changed file named like a glob cannot pull in other files', async () => {
  const { work, branch } = makeRepos()
  writeFileSync(join(work, 'a.js'), 'const a = 3\n')
  writeFileSync(join(work, 'b.js'), 'not part of the run\n')
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work, { changedFiles: ['*.js'] }), session: { repoPath: work, branch } }), 'a pathspec that matches no real file is an error, not a glob')
  assert.equal(git(work, 'ls-files', 'b.js'), '', 'b.js was never added')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'nothing was committed')
})
