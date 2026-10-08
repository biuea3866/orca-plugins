import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, selectRunnableThreads, MAX_PROMPT_BYTES } from '../server/lib/prompt.mjs'

const session = {
  id: 'ses_000000000001', repoPath: '/repo/a', repoDisplayName: 'a', branch: 'feat/x', baseRef: 'origin/main', agent: 'claude',
  threads: [
    { id: 'thr_1', path: 'src/a.js', oldPath: null, side: 'new', startLine: 2, endLine: 3, selectedText: 'const b = 3\nconst c = 4', status: 'open', applicability: 'current', comments: [{ id: 'c1', body: 'use let here' }, { id: 'c2', body: 'and rename c → total' }] },
    { id: 'thr_2', path: 'src/a.js', oldPath: null, side: 'old', startLine: 2, endLine: 2, selectedText: 'const b = 2', status: 'open', applicability: 'current', comments: [{ id: 'c3', body: 'why was this removed?' }] },
    { id: 'thr_3', path: 'src/a.js', oldPath: null, side: 'new', startLine: 1, endLine: 1, selectedText: 'x', status: 'resolved', applicability: 'current', comments: [{ id: 'c4', body: 'done' }] },
    { id: 'thr_4', path: 'src/a.js', oldPath: null, side: 'new', startLine: 1, endLine: 1, selectedText: 'x', status: 'open', applicability: 'outdated', comments: [{ id: 'c5', body: 'stale' }] }
  ]
}

test('selectRunnableThreads keeps only open + current threads', () => {
  assert.deepEqual(selectRunnableThreads(session.threads).map((thread) => thread.id), ['thr_1', 'thr_2'])
})

test('buildPrompt includes header, prohibitions, every thread block with context and all comments verbatim', () => {
  const readContext = () => ['const a = 1', 'const b = 3', 'const c = 4', 'export { a }']
  const prompt = buildPrompt({ session, threads: selectRunnableThreads(session.threads), readFileLines: readContext })
  assert.match(prompt, /\/repo\/a/)
  assert.match(prompt, /feat\/x/)
  assert.match(prompt, /git commit/)
  assert.match(prompt, /git push/)
  assert.match(prompt, /`gh`/)
  assert.match(prompt, /src\/a\.js/)
  assert.match(prompt, /new.*2.*3|L2-L3|lines 2-3/i)
  assert.match(prompt, /const b = 3\nconst c = 4/)
  assert.match(prompt, /use let here/)
  assert.match(prompt, /and rename c → total/)
  assert.match(prompt, /why was this removed\?/)
  assert.match(prompt, /thr_1/)
  assert.match(prompt, /export \{ a \}/, 'context lines around a new-side selection are included')
  assert.match(prompt, /변경 파일|changed files/i)
})

test('buildPrompt throws when the prompt exceeds the size cap', () => {
  const huge = { ...session, threads: [{ ...session.threads[0], comments: [{ id: 'c', body: 'x'.repeat(MAX_PROMPT_BYTES + 1) }] }] }
  assert.throws(() => buildPrompt({ session: huge, threads: huge.threads, readFileLines: () => [] }), /exceeds/)
})
