import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restorePinned } from '../ui/lib/pin.mjs'

const worktrees = [{ path: '/a', branch: 'feat/a' }, { path: '/b', branch: 'feat/b' }]

test('a remembered worktree that still exists is restored', () => {
  assert.equal(restorePinned('/b', worktrees), '/b')
})

test('a remembered worktree that is gone, or nothing remembered, restores nothing', () => {
  assert.equal(restorePinned('/gone', worktrees), null)
  assert.equal(restorePinned(null, worktrees), null)
  assert.equal(restorePinned(undefined, worktrees), null)
  assert.equal(restorePinned('/a', undefined), null)
})

test('only a string path can be restored', () => {
  assert.equal(restorePinned({ path: '/a' }, worktrees), null)
  assert.equal(restorePinned(7, worktrees), null)
})
