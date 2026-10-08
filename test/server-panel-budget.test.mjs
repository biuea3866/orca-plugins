import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSessionsToBudget, PANEL_DATA_MAX_BYTES } from '../server/lib/panel-publisher.mjs'

function fakeFile(path, lines) {
  return { path, oldPath: null, changeType: 'modified', binary: false, additions: lines, deletions: 0, hunks: [{ header: '@@', oldStart: 1, oldLines: 0, newStart: 1, newLines: lines, lines: Array.from({ length: lines }, (_, index) => ({ type: 'add', oldNo: null, newNo: index + 1, text: 'x'.repeat(80) })) }] }
}

test('fitSessionsToBudget keeps the viewed file in full and trims the rest to the byte budget', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js'].map((path) => fakeFile(path, 400))   // ~40KB each
  const sessions = { ses_1: { session: { id: 'ses_1', threads: [] }, diff: { files } } }
  const viewState = { ses_1: { file: 'd.js', scroll: 0, route: 'review' } }
  const fitted = fitSessionsToBudget(sessions, viewState, { budgetBytes: 100 * 1024 })
  const byPath = Object.fromEntries(fitted.ses_1.diff.files.map((file) => [file.path, file]))
  assert.equal(byPath['d.js'].hunks.length, 1, 'viewed file keeps its hunks')
  assert.equal(byPath['d.js'].panelTruncated, undefined)
  const kept = fitted.ses_1.diff.files.filter((file) => file.hunks.length > 0).map((file) => file.path)
  assert.ok(kept.includes('d.js'))
  assert.ok(kept.length < 4, 'some files were trimmed')
  for (const file of fitted.ses_1.diff.files) if (file.hunks.length === 0) assert.equal(file.panelTruncated, true)
  assert.ok(JSON.stringify(fitted).length <= 100 * 1024 + 10 * 1024)
})

test('fitSessionsToBudget leaves small sessions untouched and never mutates the input', () => {
  const files = [fakeFile('a.js', 5)]
  const sessions = { ses_1: { session: { id: 'ses_1', threads: [] }, diff: { files } } }
  const fitted = fitSessionsToBudget(sessions, {}, { budgetBytes: PANEL_DATA_MAX_BYTES })
  assert.equal(fitted.ses_1.diff.files[0].hunks.length, 1)
  assert.notEqual(fitted, sessions)
  assert.equal(files[0].hunks.length, 1)
})

test('fitSessionsToBudget keeps files that have threads before files that do not', () => {
  const files = ['a.js', 'b.js', 'c.js'].map((path) => fakeFile(path, 400))
  const sessions = { ses_1: { session: { id: 'ses_1', threads: [{ path: 'c.js' }] }, diff: { files } } }
  const fitted = fitSessionsToBudget(sessions, {}, { budgetBytes: 60 * 1024 })
  const byPath = Object.fromEntries(fitted.ses_1.diff.files.map((file) => [file.path, file]))
  assert.equal(byPath['c.js'].hunks.length, 1, 'file with a thread is kept')
})
