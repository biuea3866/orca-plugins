import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSiblingClones } from '../server/lib/clones.mjs'

// Layout under one parent dir (the parent of the registered repo):
//   main-repo (registered)  reg-wt (registered worktree)  clone-a (same remote, unregistered)
//   clone-b (other remote)  clone-detached  clone-broken  plain (no .git)  stray.txt  main-repo.worktrees/
function layout() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sr-clones-')))
  const dirs = {}
  for (const name of ['main-repo', 'reg-wt', 'clone-a', 'clone-b', 'clone-detached', 'clone-broken']) {
    mkdirSync(join(parent, name, '.git'), { recursive: true })
    dirs[name] = join(parent, name)
  }
  mkdirSync(join(parent, 'plain'))
  mkdirSync(join(parent, 'main-repo.worktrees'))
  writeFileSync(join(parent, 'stray.txt'), 'x')
  return { parent, dirs }
}

function fakeGit({ dirs }) {
  const remotes = {
    [dirs['clone-a']]: 'git@github.com:o/demo.git',
    [dirs['clone-b']]: 'https://github.com/o/other.git',
    [dirs['clone-detached']]: 'https://github.com/O/Demo',
    [dirs['clone-broken']]: 'https://github.com/o/demo.git'
  }
  const branches = { [dirs['clone-a']]: 'feat/GRT-10568-x', [dirs['clone-b']]: 'feat/b', [dirs['clone-detached']]: 'HEAD', [dirs['clone-broken']]: 'feat/broken' }
  const calls = []
  return {
    calls,
    remoteUrl: async (dir) => { calls.push(['remoteUrl', dir]); if (dir === dirs['clone-broken']) throw new Error('boom'); return remotes[dir] ?? '' },
    currentBranch: async (dir) => { calls.push(['currentBranch', dir]); return branches[dir] ?? '' }
  }
}

test('finds unregistered clones of the same GitHub repo next to a registered repo', async () => {
  const lay = layout()
  const git = fakeGit(lay)
  const repos = [{ id: 'r1', path: lay.dirs['main-repo'], displayName: 'demo', remoteUrl: 'https://github.com/o/demo.git' }]
  const worktrees = [{ id: 'w1', repoId: 'r1', path: lay.dirs['reg-wt'], branch: 'feat/reg' }]
  const found = await discoverSiblingClones({ repos, worktrees, git })
  assert.deepEqual(found, [{ id: null, repoId: 'r1', path: lay.dirs['clone-a'], branch: 'feat/GRT-10568-x', displayName: 'clone-a', isMainWorktree: false, unregistered: true }])
})

test('skips registered paths, other remotes, detached HEAD, failing dirs, and never probes non-git dirs', async () => {
  const lay = layout()
  const git = fakeGit(lay)
  const repos = [{ id: 'r1', path: lay.dirs['main-repo'], displayName: 'demo', remoteUrl: 'https://github.com/o/demo.git' }]
  const worktrees = [{ id: 'w1', repoId: 'r1', path: lay.dirs['reg-wt'], branch: 'feat/reg' }]
  const found = await discoverSiblingClones({ repos, worktrees, git })
  assert.deepEqual(found.map((entry) => entry.displayName), ['clone-a'], 'other remote, detached HEAD and a throwing dir are all dropped')
  const probed = new Set(git.calls.map(([, dir]) => dir))
  assert.ok(!probed.has(lay.dirs['main-repo']), 'registered repo path is not probed')
  assert.ok(!probed.has(lay.dirs['reg-wt']), 'registered worktree path is not probed')
  assert.ok(!probed.has(join(lay.parent, 'plain')), 'a dir without .git is not probed')
  assert.ok(!probed.has(join(lay.parent, 'main-repo.worktrees')), 'a .worktrees container is not probed')
})

test('a repo without a GitHub remote yields nothing, and the per-repo cap is applied', async () => {
  const lay = layout()
  const git = fakeGit(lay)
  const noRemote = [{ id: 'r1', path: lay.dirs['main-repo'], displayName: 'demo', remoteUrl: null }]
  assert.deepEqual(await discoverSiblingClones({ repos: noRemote, worktrees: [], git }), [])
  const repos = [{ id: 'r1', path: lay.dirs['main-repo'], displayName: 'demo', remoteUrl: 'https://github.com/o/demo.git' }]
  git.remoteUrl = async () => 'https://github.com/o/demo.git'
  git.currentBranch = async (dir) => `b-${dir.split('/').pop()}`
  const capped = await discoverSiblingClones({ repos, worktrees: [], git, limitPerRepo: 2 })
  assert.equal(capped.length, 2)
})

test('a registered repo living next to another one is not reported as a clone of it', async () => {
  const lay = layout()
  const git = fakeGit(lay)
  const repos = [
    { id: 'r1', path: lay.dirs['main-repo'], displayName: 'demo', remoteUrl: 'https://github.com/o/demo.git' },
    { id: 'r2', path: lay.dirs['clone-b'], displayName: 'other', remoteUrl: 'https://github.com/o/other.git' }
  ]
  const found = await discoverSiblingClones({ repos, worktrees: [], git })
  assert.deepEqual(found.map((entry) => [entry.repoId, entry.displayName]), [['r1', 'clone-a']])
})
