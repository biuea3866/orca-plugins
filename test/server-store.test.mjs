import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore, ApiError } from '../server/lib/store.mjs'

function makeStore() {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-store-'))
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)).toISOString()
  return { store: new SessionStore({ homeDir, now }), homeDir }
}

const localInput = { kind: 'local', repoPath: '/repo/a', baseRef: 'origin/main', repoDisplayName: 'a', branch: 'feat/x', worktreeId: 'wt1' }

test('creates a local session with defaults and persists it atomically', () => {
  const { store, homeDir } = makeStore()
  const session = store.createSession(localInput)
  assert.match(session.id, /^ses_[0-9a-f]{12}$/)
  assert.equal(session.schemaVersion, 1)
  assert.equal(session.revision, 1)
  assert.equal(session.includeUntracked, true)
  assert.equal(session.agent, 'claude')
  assert.equal(session.status, 'reviewing')
  assert.deepEqual(session.threads, [])
  const onDisk = JSON.parse(readFileSync(join(homeDir, 'sessions', `${session.id}.json`), 'utf8'))
  assert.equal(onDisk.id, session.id)
  assert.equal(existsSync(join(homeDir, 'sessions', `${session.id}.json.tmp`)), false)
})

test('local session creation is idempotent for the same repoPath + baseRef while not completed', () => {
  const { store } = makeStore()
  const first = store.createSession(localInput)
  const second = store.createSession(localInput)
  assert.equal(second.id, first.id)
  store.updateSession(first.id, { revision: first.revision, status: 'completed' })
  const third = store.createSession(localInput)
  assert.notEqual(third.id, first.id)
})

test('pr session creation reuses the same owner/repo/number', () => {
  const { store } = makeStore()
  const prInput = { kind: 'pr', pr: { owner: 'o', repo: 'r', number: 7, headSha: 'abc', url: 'u' }, repoPath: null, baseRef: 'main', repoDisplayName: 'o/r', branch: 'feat', worktreeId: null }
  const first = store.createSession(prInput)
  const second = store.createSession(prInput)
  assert.equal(second.id, first.id)
})

test('updateSession bumps revision and rejects stale revisions with 409', () => {
  const { store } = makeStore()
  const session = store.createSession(localInput)
  const updated = store.updateSession(session.id, { revision: 1, baseRef: 'origin/dev', agent: 'codex' })
  assert.equal(updated.revision, 2)
  assert.equal(updated.baseRef, 'origin/dev')
  assert.equal(updated.agent, 'codex')
  assert.throws(() => store.updateSession(session.id, { revision: 1, agent: 'claude' }), (error) => error instanceof ApiError && error.status === 409)
})

test('addThread validates range, side and body and stores selectedText', () => {
  const { store } = makeStore()
  const session = store.createSession(localInput)
  const thread = { path: 'src/a.js', oldPath: null, side: 'new', startLine: 3, endLine: 5, selectedText: 'a\nb\nc', body: 'rename this' }
  const next = store.addThread(session.id, { revision: 1, ...thread })
  assert.equal(next.threads.length, 1)
  assert.match(next.threads[0].id, /^thr_[0-9a-f]{12}$/)
  assert.equal(next.threads[0].status, 'open')
  assert.equal(next.threads[0].comments.length, 1)
  assert.equal(next.threads[0].comments[0].body, 'rename this')
  assert.equal(next.revision, 2)

  const expect400 = (patch) => assert.throws(() => store.addThread(session.id, { revision: next.revision, ...thread, ...patch }), (error) => error instanceof ApiError && error.status === 400)
  expect400({ startLine: 6 })
  expect400({ startLine: 0, endLine: 0 })
  expect400({ endLine: 3 + 200 })
  expect400({ side: 'left' })
  expect400({ body: '' })
  expect400({ body: 'x'.repeat(10001) })
})

test('thread status, replies, comment edits and deletions; deleting last comment deletes thread', () => {
  const { store } = makeStore()
  let session = store.createSession(localInput)
  session = store.addThread(session.id, { revision: session.revision, path: 'f', oldPath: null, side: 'old', startLine: 1, endLine: 1, selectedText: 'x', body: 'first' })
  const threadId = session.threads[0].id
  session = store.updateThread(session.id, threadId, { revision: session.revision, status: 'resolved' })
  assert.equal(session.threads[0].status, 'resolved')
  assert.ok(session.threads[0].resolvedAt)
  session = store.updateThread(session.id, threadId, { revision: session.revision, status: 'open' })
  assert.equal(session.threads[0].resolvedAt, null)
  session = store.addComment(session.id, threadId, { revision: session.revision, body: 'reply' })
  assert.equal(session.threads[0].comments.length, 2)
  const replyId = session.threads[0].comments[1].id
  session = store.updateComment(session.id, threadId, replyId, { revision: session.revision, body: 'edited' })
  assert.equal(session.threads[0].comments[1].body, 'edited')
  session = store.deleteComment(session.id, threadId, replyId, { revision: session.revision })
  assert.equal(session.threads[0].comments.length, 1)
  session = store.deleteComment(session.id, threadId, session.threads[0].comments[0].id, { revision: session.revision })
  assert.equal(session.threads.length, 0)
})

test('listSessions returns summaries with thread counts and deleteSession removes the file', () => {
  const { store, homeDir } = makeStore()
  let session = store.createSession(localInput)
  session = store.addThread(session.id, { revision: session.revision, path: 'f', oldPath: null, side: 'new', startLine: 1, endLine: 2, selectedText: 'a\nb', body: 'c' })
  const summaries = store.listSessions()
  assert.equal(summaries.length, 1)
  assert.deepEqual(summaries[0].threads, { open: 1, resolved: 0 })
  assert.equal(summaries[0].id, session.id)
  store.deleteSession(session.id)
  assert.equal(existsSync(join(homeDir, 'sessions', `${session.id}.json`)), false)
  assert.throws(() => store.getSession(session.id), (error) => error instanceof ApiError && error.status === 404)
})
