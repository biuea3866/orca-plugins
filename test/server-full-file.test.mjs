import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { GitReader } from '../server/lib/git.mjs'
import { execCommand } from '../server/lib/exec.mjs'
import { applyFullFiles, FULL_FILE_MAX_LINES } from '../server/lib/full-file.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}
const numbered = (count, changed = {}) => Array.from({ length: count }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join('\n') + '\n'
const lineCount = (file) => file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
const reader = new GitReader({ exec: execCommand })

// main: big.txt with 40 lines. feat: line 20 changed and committed.
function makeRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-full-')))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'big.txt'), numbered(40))
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'feat')
  writeFileSync(join(repo, 'big.txt'), numbered(40, { 20: 'line 20 changed' }))
  git(repo, 'commit', '-q', '-am', 'change line 20')
  return repo
}

test('fullContextFile returns every line of the file, not only the changed hunk', async () => {
  const repo = makeRepo()
  const normal = (await reader.workingTreeDiff(repo, { baseRef: 'main' })).files[0]
  assert.ok(lineCount(normal) < 15, 'the normal diff only carries a few context lines')
  const full = await reader.fullContextFile(repo, { baseRef: 'main', path: 'big.txt' })
  assert.equal(full.path, 'big.txt')
  assert.equal(full.hunks.length, 1)
  assert.equal(lineCount(full), 41, '39 unchanged + 1 deleted + 1 added')
  assert.deepEqual(full.hunks[0].lines.filter((line) => line.type !== 'context').map((line) => [line.type, line.oldNo, line.newNo]), [['del', 20, null], ['add', null, 20]])
  assert.equal(full.hunks[0].lines[0].text, 'line 1')
  assert.equal(full.hunks[0].lines.at(-1).text, 'line 40')
  assert.equal(full.additions, normal.additions)
  assert.equal(full.deletions, normal.deletions)
})

test('fullContextFile follows the working tree mode and untracked files', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'big.txt'), numbered(40, { 20: 'line 20 changed', 40: 'last, uncommitted' }))
  writeFileSync(join(repo, 'new.txt'), numbered(5))
  const tracked = await reader.fullContextFile(repo, { baseRef: 'main', includeWorkingTree: true, path: 'big.txt' })
  assert.equal(lineCount(tracked), 42, '38 unchanged + 2 deleted + 2 added')
  const untracked = await reader.fullContextFile(repo, { baseRef: 'main', includeWorkingTree: true, includeUntracked: true, path: 'new.txt' })
  assert.equal(untracked.changeType, 'untracked')
  assert.equal(lineCount(untracked), 5)
  assert.equal(await reader.fullContextFile(repo, { baseRef: 'main', includeWorkingTree: true, includeUntracked: false, path: 'new.txt' }), null, 'untracked files are only shown when the session includes them')
})

test('fullContextFile keeps rename detection when the old path is given, and returns null for unknown paths', async () => {
  const repo = makeRepo()
  git(repo, 'mv', 'big.txt', 'moved.txt')
  git(repo, 'commit', '-q', '-am', 'rename')
  const renamed = await reader.fullContextFile(repo, { baseRef: 'main', path: 'moved.txt', oldPath: 'big.txt' })
  assert.equal(renamed.oldPath, 'big.txt')
  assert.equal(lineCount(renamed), 41)
  assert.equal(await reader.fullContextFile(repo, { baseRef: 'main', path: 'nope.txt' }), null)
})

const fileWith = (path, lines = 1, extra = {}) => ({ path, hunks: [{ header: '@@', lines: Array.from({ length: lines }, (_, index) => ({ type: 'add', oldNo: null, newNo: index + 1, text: 'x' })) }], ...extra })

test('applyFullFiles replaces only the requested files and keeps the order', async () => {
  const files = [fileWith('a'), fileWith('b'), fileWith('c')]
  const seen = []
  const result = await applyFullFiles({ files, fullPaths: ['b'], load: async (file) => { seen.push(file.path); return fileWith(file.path, 3) } })
  assert.deepEqual(result.map((file) => file.path), ['a', 'b', 'c'])
  assert.deepEqual(seen, ['b'])
  assert.equal(result[0], files[0])
  assert.equal(result[2], files[2])
  assert.equal(result[1].fullContext, true)
  assert.equal(lineCount(result[1]), 3)
})

test('applyFullFiles passes the original entry to the loader so renames keep their old path', async () => {
  let received = null
  await applyFullFiles({ files: [fileWith('new.js', 1, { oldPath: 'old.js' })], fullPaths: ['new.js'], load: async (file) => { received = file; return fileWith('new.js', 2) } })
  assert.equal(received.oldPath, 'old.js')
})

test('applyFullFiles leaves files alone when nothing is requested', async () => {
  const files = [fileWith('a')]
  assert.deepEqual(await applyFullFiles({ files, fullPaths: undefined, load: async () => { throw new Error('must not load') } }), files)
  assert.deepEqual(await applyFullFiles({ files, fullPaths: [], load: async () => { throw new Error('must not load') } }), files)
})

test('applyFullFiles keeps the normal diff and says why when the full file cannot be shown', async () => {
  const files = [fileWith('boom'), fileWith('gone'), fileWith('huge')]
  const result = await applyFullFiles({
    files,
    fullPaths: ['boom', 'gone', 'huge'],
    load: async (file) => {
      if (file.path === 'boom') throw new Error('git exploded')
      if (file.path === 'gone') return null
      return fileWith('huge', FULL_FILE_MAX_LINES + 1)
    }
  })
  assert.match(result[0].fullContextError, /git exploded/)
  assert.ok(result[1].fullContextError)
  assert.match(result[2].fullContextError, /5,000/)
  for (const file of result) assert.equal(lineCount(file), 1, 'the original hunks are kept')
  for (const file of result) assert.equal(file.fullContext, undefined)
})
