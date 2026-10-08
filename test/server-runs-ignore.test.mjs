import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterIgnoredChanges, pickRunToShow } from '../server/lib/runs.mjs'

test('filterIgnoredChanges drops paths the server itself writes (relative to the run cwd)', () => {
  const changed = ['panel.html', 'src/a.js', 'runtime/x.json']
  const kept = filterIgnoredChanges(changed, '/repo', ['/repo/panel.html', '/elsewhere/runtime/x.json'])
  assert.deepEqual(kept, ['src/a.js', 'runtime/x.json'])
})

test('pickRunToShow prefers a live run, then the newest run that actually changed files, then the newest run', () => {
  const runs = [
    { id: 'r3', startedAt: '2026-10-08T06:00:00Z', status: 'succeeded', changedFiles: [] },
    { id: 'r2', startedAt: '2026-10-08T05:53:00Z', status: 'succeeded', changedFiles: ['a.kt'] },
    { id: 'r1', startedAt: '2026-10-08T05:00:00Z', status: 'failed', changedFiles: [] }
  ]
  assert.equal(pickRunToShow(runs).id, 'r2')
  assert.equal(pickRunToShow([{ id: 'live', startedAt: '2026-10-08T06:10:00Z', status: 'running', changedFiles: [] }, ...runs]).id, 'live')
  assert.equal(pickRunToShow([runs[0], runs[2]]).id, 'r3')
  assert.equal(pickRunToShow([]), null)
})
