import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { publishRun } from '../server/lib/publish.mjs'
import { previewWorkingTree, publishWorkingTree } from '../server/lib/working-tree-publish.mjs'
import { publicationState } from '../server/lib/publication-state.mjs'
import { detachedPublishTarget } from '../server/lib/publish-target.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const exec = (command, args, options) => execCommand(command, args, options)

// GitGraph reviews a branch without checking it out: the tip lives in a detached linked worktree whose private
// git dir names the reviewed branch. Only the remote has the branch; no local branch exists.
function detachedReview({ branch = 'feat/GRT-11472-popup-audit', target } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-detached-')))
  const remote = join(root, 'remote.git'), work = join(root, 'work'), review = join(root, 'review')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, work)
  git(work, 'config', 'user.name', 't'); git(work, 'config', 'user.email', 't@t')
  writeFileSync(join(work, 'a.js'), 'const a = 1\n')
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main', `HEAD:refs/heads/${branch}`)
  git(work, 'fetch', '-q', 'origin')
  git(work, 'worktree', 'add', '-q', '--detach', review, `origin/${branch}`)
  if (target !== null) writeFileSync(resolve(review, git(review, 'rev-parse', '--git-path', 'self-review-publish-target')), `${target ?? `refs/remotes/origin/${branch}`}\n`)
  writeFileSync(join(review, 'a.js'), 'const a = 2\n')
  return { remote, work, review, branch }
}
const fixRun = (cwd) => ({ id: 'run_00000000000d', mode: 'fix', status: 'succeeded', agent: 'claude', cwd, threadIds: ['thr_a'], changedFiles: ['a.js'] })

test('a detached review publishes to the reviewed remote branch and leaves local branches alone', async () => {
  const { remote, work, review, branch } = detachedReview()
  const result = await publishRun({ exec, run: fixRun(review), session: { repoPath: review, branch: 'HEAD' } })
  assert.equal(result.branch, branch)
  assert.equal(result.remote, 'origin')
  assert.equal(result.upstreamSet, false, 'a detached HEAD has no branch to track the remote')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit, 'the commit reached the reviewed branch')
  assert.equal(git(review, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'the review worktree stays detached')
  assert.equal(git(work, 'rev-parse', `refs/remotes/origin/${branch}`), result.commit, 'the remote-tracking ref follows the push')
  assert.equal(execFileSync('git', ['branch', '--list', branch], { cwd: work, encoding: 'utf8' }).trim(), '', 'no local branch was created')
  assert.match(git(review, 'log', '-1', '--format=%s'), /^\[GRT-11472\] - /, 'the ticket comes from the reviewed branch')
})

test('a detached review without a declared branch is refused before committing', async () => {
  const { review } = detachedReview({ target: null })
  const head = git(review, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec, run: fixRun(review), session: { repoPath: review, branch: 'HEAD' } }), (error) => error.code === 'detached_head')
  assert.equal(git(review, 'rev-parse', 'HEAD'), head)
})

test('a detached review of a shared branch is refused', async () => {
  const { review } = detachedReview({ target: 'refs/remotes/origin/main' })
  await assert.rejects(publishRun({ exec, run: fixRun(review), session: { repoPath: review, branch: 'HEAD' } }), (error) => error.code === 'protected_branch')
})

test('a detached review is refused when the remote branch moved past the reviewed tip', async () => {
  const { work, review, branch } = detachedReview()
  writeFileSync(join(work, 'b.js'), 'other\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'someone else')
  git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  const head = git(review, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec, run: fixRun(review), session: { repoPath: review, branch: 'HEAD' } }), (error) => error.code === 'non_fast_forward')
  assert.equal(git(review, 'rev-parse', 'HEAD'), head, 'nothing was committed')
})

test('the uncommitted-changes publish of a detached review uses the reviewed branch for the message and the push', async () => {
  const { remote, review, branch } = detachedReview()
  const session = { repoPath: review, branch: 'HEAD' }
  const preview = await previewWorkingTree({ exec, session })
  assert.equal(preview.publishBranch, branch)
  assert.match(preview.message, /^\[GRT-11472\] - /)
  const result = await publishWorkingTree({ exec, session, selection: { snapshot: preview.snapshot, paths: ['a.js'], message: preview.message } })
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit)
})

test('the publication state of a detached review compares HEAD with the reviewed remote branch', async () => {
  const { review, branch } = detachedReview()
  git(review, 'checkout', '-q', '--', 'a.js')
  const state = await publicationState({ exec, cwd: review, branch: 'HEAD' })
  assert.equal(state.remoteRef, `refs/heads/${branch}`)
  assert.equal(state.state, 'remote-verified')
})

test('a detached review whose remote branch was deleted is refused instead of recreating it', async () => {
  const { remote, review, branch } = detachedReview()
  git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
  const head = git(review, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec, run: fixRun(review), session: { repoPath: review, branch: 'HEAD' } }), (error) => error.code === 'remote_branch_missing')
  assert.equal(git(review, 'rev-parse', 'HEAD'), head, 'nothing was committed')
  assert.equal(execFileSync('git', ['ls-remote', '--heads', remote, branch], { encoding: 'utf8' }).trim(), '', 'the branch was not recreated')
})

test('the uncommitted-changes preview of a detached worktree without a declared branch still opens', async () => {
  const { review } = detachedReview({ target: null })
  const preview = await previewWorkingTree({ exec, session: { repoPath: review, branch: 'HEAD' } })
  assert.equal(preview.publishBranch, null)
  assert.deepEqual(preview.paths, ['a.js'])
})

test('the declared publish target is resolved for local, tracked and malformed refs', async () => {
  const { work, review, branch } = detachedReview()
  const marker = resolve(review, git(review, 'rev-parse', '--git-path', 'self-review-publish-target'))
  const target = (ref) => { writeFileSync(marker, `${ref}\n`); return detachedPublishTarget({ exec, cwd: review }) }
  git(work, 'branch', '--track', 'local-same', `origin/${branch}`)
  git(work, 'config', 'branch.local-same.merge', 'refs/heads/local-same')
  assert.deepEqual(await target('refs/heads/local-same'), { remote: 'origin', branch: 'local-same' }, 'a tracked local branch pushes to its upstream')
  git(work, 'branch', '--track', 'local-other', `origin/${branch}`)
  await assert.rejects(target('refs/heads/local-other'), (error) => error.code === 'invalid_publish_target', 'a local branch tracking another name is refused')
  git(work, 'branch', '--no-track', 'local-untracked', `origin/${branch}`)
  assert.deepEqual(await target('refs/heads/local-untracked'), { remote: 'origin', branch: 'local-untracked' }, 'an untracked local branch goes to origin')
  for (const bad of ['refs/remotes/origin/HEAD', 'refs/remotes/nowhere/x', 'refs/remotes/origin/a..b', 'refs/tags/v1', 'HEAD'])
    await assert.rejects(target(bad), (error) => error.code === 'invalid_publish_target', bad)
})
