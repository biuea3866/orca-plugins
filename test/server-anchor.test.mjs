import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeApplicability, extractSideLines } from '../server/lib/anchor.mjs'

const files = [{
  path: 'src/a.js', oldPath: null, changeType: 'modified', binary: false, additions: 2, deletions: 1,
  hunks: [{
    header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5,
    lines: [
      { type: 'context', oldNo: 1, newNo: 1, text: 'const a = 1' },
      { type: 'del', oldNo: 2, newNo: null, text: 'const b = 2' },
      { type: 'add', oldNo: null, newNo: 2, text: 'const b = 3  ' },
      { type: 'add', oldNo: null, newNo: 3, text: 'const c = 4' },
      { type: 'context', oldNo: 3, newNo: 4, text: 'export { a }' }
    ]
  }]
}]

test('extractSideLines returns the text for a line range on one side', () => {
  assert.deepEqual(extractSideLines(files, 'src/a.js', 'new', 2, 3), ['const b = 3  ', 'const c = 4'])
  assert.deepEqual(extractSideLines(files, 'src/a.js', 'old', 2, 2), ['const b = 2'])
  assert.equal(extractSideLines(files, 'src/a.js', 'new', 9, 9), null)
  assert.equal(extractSideLines(files, 'missing.js', 'new', 1, 1), null)
})

test('computeApplicability marks matching threads current (trailing whitespace ignored) and others outdated', () => {
  const current = { path: 'src/a.js', side: 'new', startLine: 2, endLine: 3, selectedText: 'const b = 3\nconst c = 4' }
  const outdated = { path: 'src/a.js', side: 'new', startLine: 2, endLine: 3, selectedText: 'const b = 9\nconst c = 4' }
  const missing = { path: 'src/zzz.js', side: 'new', startLine: 1, endLine: 1, selectedText: 'x' }
  assert.equal(computeApplicability(files, current), 'current')
  assert.equal(computeApplicability(files, outdated), 'outdated')
  assert.equal(computeApplicability(files, missing), 'outdated')
})
