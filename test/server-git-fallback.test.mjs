import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { GitReader } from '../server/lib/git.mjs'
import { execCommand } from '../server/lib/exec.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

test('workingTreeDiff falls back to a plain two-dot diff when base and HEAD share no merge-base (orphan branch)', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-orphan-')))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'main\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'main')
  git(repo, 'checkout', '-q', '--orphan', 'snapshot')
  writeFileSync(join(repo, 'a.txt'), 'snapshot\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'orphan snapshot')
  const reader = new GitReader({ exec: execCommand })
  const diff = await reader.workingTreeDiff(repo, { baseRef: 'main', includeUntracked: false })
  assert.equal(diff.mergeBaseSha, null)
  assert.equal(diff.noMergeBase, true)
  assert.equal(diff.files[0].path, 'a.txt')
})

test('workingTreeDiff shows only committed changes by default and working-tree changes when asked', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-mode-')))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'feat')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git(repo, 'commit', '-q', '-am', 'committed change')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree (uncommitted)\n')
  writeFileSync(join(repo, 'scratch.txt'), 'untracked\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(repo, 'ignored.txt'), 'ignored\n')
  const reader = new GitReader({ exec: execCommand })
  const committed = await reader.workingTreeDiff(repo, { baseRef: 'main', includeUntracked: false, includeWorkingTree: false })
  assert.deepEqual(committed.files.map((file) => file.path), ['a.txt'])
  assert.equal(committed.files[0].additions, 1, 'only the committed line')
  const working = await reader.workingTreeDiff(repo, { baseRef: 'main', includeUntracked: true, includeWorkingTree: true })
  assert.deepEqual(working.files.map((file) => file.path).sort(), ['.gitignore', 'a.txt', 'scratch.txt'], 'ignored.txt never appears')
  assert.equal(working.files.find((file) => file.path === 'a.txt').additions, 2)
})

test('workingTreeChangesFor returns HEAD-vs-working-tree hunks for the given paths, including new untracked files', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-ai-')))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'b.txt'), 'keep\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  writeFileSync(join(repo, 'a.txt'), 'one\nfixed by agent\n')
  writeFileSync(join(repo, 'new.txt'), 'created by agent\n')
  writeFileSync(join(repo, 'b.txt'), 'keep\nnot requested\n')
  const reader = new GitReader({ exec: execCommand })
  const files = await reader.workingTreeChangesFor(repo, ['a.txt', 'new.txt'])
  assert.deepEqual(files.map((file) => [file.path, file.changeType]).sort(), [['a.txt', 'modified'], ['new.txt', 'untracked']])
  assert.equal(files.find((file) => file.path === 'a.txt').additions, 1)
  const none = await reader.workingTreeChangesFor(repo, [])
  assert.deepEqual(none, [])
})
