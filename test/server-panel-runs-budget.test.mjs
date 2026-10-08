import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRunsToBudget } from '../server/lib/panel-publisher.mjs'

function fakeFile(path, lines, width = 80) {
  return { path, oldPath: null, changeType: 'modified', binary: false, additions: lines, deletions: 0, hunks: [{ header: '@@', oldStart: 1, oldLines: 0, newStart: 1, newLines: lines, lines: Array.from({ length: lines }, (_, index) => ({ type: 'add', oldNo: null, newNo: index + 1, text: 'x'.repeat(width) })) }] }
}

test('fitRunsToBudget keeps small AI change sets and trims large ones to the byte budget', () => {
  const runs = {
    ses_1: { id: 'r1', status: 'succeeded', changedFiles: ['small.js', 'huge.html'], aiChanges: [fakeFile('small.js', 5), fakeFile('huge.html', 200, 4000)] },
    ses_2: { id: 'r2', status: 'succeeded', changedFiles: [], aiChanges: null }
  }
  const fitted = fitRunsToBudget(runs, { budgetBytes: 60 * 1024 })
  const files = Object.fromEntries(fitted.ses_1.aiChanges.map((file) => [file.path, file]))
  assert.equal(files['small.js'].hunks.length, 1)
  assert.equal(files['huge.html'].hunks.length, 0)
  assert.equal(files['huge.html'].panelTruncated, true)
  assert.equal(fitted.ses_2.aiChanges, null)
  assert.ok(JSON.stringify(fitted).length < 70 * 1024)
  assert.equal(runs.ses_1.aiChanges[1].hunks.length, 1, 'input is not mutated')
})
