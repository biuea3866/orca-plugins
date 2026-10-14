import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore } from '../server/lib/store.mjs'

function makeStore() {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-store-ai-'))
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 9, 13, 0, 0, tick++)).toISOString()
  return new SessionStore({ homeDir, now })
}

const localInput = { kind: 'local', repoPath: '/repo/a', baseRef: 'origin/main', repoDisplayName: 'a', branch: 'feat/x', worktreeId: 'wt1' }

function sessionWithThread(store) {
  const created = store.createSession(localInput)
  const session = store.addThread(created.id, { revision: created.revision, path: 'a.js', side: 'new', startLine: 1, endLine: 1, selectedText: 'x', body: '질문' })
  return { sessionId: session.id, threadId: session.threads[0].id }
}

test('appendAiComments adds the answer as an AI comment without needing the caller to know the revision', () => {
  const store = makeStore()
  const { sessionId, threadId } = sessionWithThread(store)
  const before = store.getSession(sessionId)
  const result = store.appendAiComments(sessionId, [{ threadId, body: '답변입니다', agent: 'claude', runId: 'run_000000000001' }])
  assert.deepEqual(result.added, [threadId])
  assert.deepEqual(result.skipped, [])
  const after = store.getSession(sessionId)
  assert.equal(after.revision, before.revision + 1)
  const [question, answer] = after.threads[0].comments
  assert.equal(question.body, '질문')
  assert.equal(question.author, undefined, 'reviewer comments keep their shape')
  assert.match(answer.id, /^cmt_[0-9a-f]{12}$/)
  assert.equal(answer.author, 'ai')
  assert.equal(answer.agent, 'claude')
  assert.equal(answer.runId, 'run_000000000001')
  assert.equal(answer.body, '답변입니다')
  assert.ok(answer.createdAt)
  assert.equal(after.threads[0].status, 'open', 'answering never resolves a thread')
})

test('appendAiComments skips threads that no longer exist and still answers the others', () => {
  const store = makeStore()
  const { sessionId, threadId } = sessionWithThread(store)
  const result = store.appendAiComments(sessionId, [{ threadId: 'thr_000000000000', body: '사라진 스레드', agent: 'codex', runId: 'run_000000000001' }, { threadId, body: '남은 스레드', agent: 'codex', runId: 'run_000000000001' }])
  assert.deepEqual(result.added, [threadId])
  assert.deepEqual(result.skipped, ['thr_000000000000'])
  assert.equal(store.getSession(sessionId).threads[0].comments.length, 2)
})

test('appendAiComments ignores empty answers and caps very long ones', () => {
  const store = makeStore()
  const { sessionId, threadId } = sessionWithThread(store)
  const empty = store.appendAiComments(sessionId, [{ threadId, body: '   ', agent: 'claude', runId: 'run_000000000001' }])
  assert.deepEqual(empty.added, [])
  assert.equal(store.getSession(sessionId).threads[0].comments.length, 1)
  store.appendAiComments(sessionId, [{ threadId, body: 'x'.repeat(200_000), agent: 'claude', runId: 'run_000000000001' }])
  const body = store.getSession(sessionId).threads[0].comments[1].body
  assert.ok(body.length < 200_000)
  assert.match(body, /…/, 'the cut is visible')
})
