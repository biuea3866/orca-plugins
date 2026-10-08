import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeThreads, threadKey, countRunnable } from '../ui/lib/threads.mjs'

const threads = [
  { id: 't1', path: 'a.js', side: 'new', startLine: 2, endLine: 4, status: 'open', applicability: 'current' },
  { id: 't2', path: 'a.js', side: 'new', startLine: 4, endLine: 4, status: 'resolved', applicability: 'current' },
  { id: 't3', path: 'b.js', side: 'old', startLine: 1, endLine: 1, status: 'open', applicability: 'outdated' }
]

test('placeThreads groups threads by file, side and end line', () => {
  const placement = placeThreads(threads)
  assert.deepEqual(Object.keys(placement).sort(), ['a.js|new|4', 'b.js|old|1'])
  assert.deepEqual(placement['a.js|new|4'].map((thread) => thread.id), ['t1', 't2'])
  assert.equal(threadKey('a.js', 'new', 4), 'a.js|new|4')
})

test('countRunnable counts open + current threads only', () => {
  assert.equal(countRunnable(threads), 1)
})
