import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beginSelection, extendSelection, normalizeRange, clampRange, MAX_SELECTION_LINES } from '../ui/lib/selection.mjs'

const cell = (path, side, line) => ({ path, side, line })

test('beginSelection anchors a single line', () => {
  const selection = beginSelection(cell('a.js', 'new', 5))
  assert.deepEqual(selection, { path: 'a.js', side: 'new', anchor: 5, head: 5 })
})

test('extendSelection moves the head within the same file and side, ignoring other files/sides', () => {
  let selection = beginSelection(cell('a.js', 'new', 5))
  selection = extendSelection(selection, cell('a.js', 'new', 9))
  assert.equal(selection.head, 9)
  selection = extendSelection(selection, cell('a.js', 'old', 12))
  assert.equal(selection.head, 9, 'other side ignored')
  selection = extendSelection(selection, cell('b.js', 'new', 2))
  assert.equal(selection.head, 9, 'other file ignored')
})

test('normalizeRange orders reversed drags and clampRange enforces the 200-line cap from the anchor', () => {
  assert.deepEqual(normalizeRange({ anchor: 9, head: 3 }), { startLine: 3, endLine: 9 })
  assert.deepEqual(normalizeRange({ anchor: 3, head: 3 }), { startLine: 3, endLine: 3 })
  const clamped = clampRange({ anchor: 1, head: 1000 })
  assert.deepEqual(clamped, { startLine: 1, endLine: MAX_SELECTION_LINES })
  const clampedUp = clampRange({ anchor: 1000, head: 1 })
  assert.deepEqual(clampedUp, { startLine: 1000 - MAX_SELECTION_LINES + 1, endLine: 1000 })
})
