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
