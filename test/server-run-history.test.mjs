import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotThreads, summarizeRun, historyForSession, capChanges, buildExchanges, HISTORY_LIMIT } from '../server/lib/run-history.mjs'
import { validateOp } from '../server/lib/bridge-ops.mjs'
import { RunManager } from '../server/lib/runs.mjs'

const thread = (id, extra = {}) => ({ id, path: 'a.js', side: 'new', startLine: 2, endLine: 3, selectedText: 'const b', status: 'open', comments: [{ id: 'c1', author: 'user', body: '이름을 바꿔 주세요' }], ...extra })
const run = (id, extra = {}) => ({ id, sessionId: 'ses_1', cwd: '/repo', mode: 'fix', agent: 'claude', status: 'succeeded', exitCode: 0, startedAt: '2026-10-14T01:00:00.000Z', endedAt: '2026-10-14T01:01:00.000Z', threadIds: ['thr_1'], changedFiles: ['a.js'], pid: 123, nonce: 'secret-nonce', fingerprintsBefore: { 'a.js': 'x' }, ...extra })

test('snapshotThreads keeps what the reviewer asked, bounded in size', () => {
  const long = 'x'.repeat(2000)
  const many = Array.from({ length: 80 }, (_, index) => thread(`thr_${index}`))
  const snapshot = snapshotThreads([thread('thr_a', { comments: [{ author: 'user', body: long }, { author: 'ai', body: '답변' }, { body: '셋' }, { body: '넷' }, { body: '다섯' }, { body: '여섯' }] }), ...many])
  assert.equal(snapshot.length, 50, 'at most 50 threads are kept')
  const first = snapshot[0]
  assert.deepEqual(Object.keys(first).sort(), ['comments', 'endLine', 'id', 'path', 'side', 'startLine'])
  assert.equal(first.id, 'thr_a')
  assert.ok(first.comments.length <= 4, 'only the latest few comments are kept')
  assert.ok(first.comments.every((comment) => comment.body.length <= 501), 'long comments are cut')
  assert.equal(first.comments.at(-1).body, '여섯')
  assert.equal(first.comments.at(-1).author, 'user', 'a missing author counts as the reviewer')
})

test('summarizeRun is a light row without logs, diffs or secrets', () => {
  const row = summarizeRun(run('run_000000000001', { summary: '정리했어요', branch: 'feat/x', hasChanges: true, published: { commit: 'abcdef0123456789', branch: 'feat/x', remote: 'origin', at: 'x' }, logTail: 'big', aiChanges: [{}], threadSnapshots: [{}] }))
  assert.equal(row.id, 'run_000000000001')
  assert.equal(row.mode, 'fix')
  assert.equal(row.threadCount, 1)
  assert.deepEqual(row.changedFiles, ['a.js'])
  assert.equal(row.changedCount, 1)
  assert.equal(row.hasChanges, true)
  assert.equal(row.summary, '정리했어요', 'what the AI reported back')
  assert.equal(row.branch, 'feat/x')
  assert.deepEqual(row.published, { commit: 'abcdef0123456789', branch: 'feat/x' })
  for (const key of ['nonce', 'fingerprintsBefore', 'pid', 'cwd', 'logTail', 'aiChanges', 'threadSnapshots']) assert.ok(!(key in row), `${key} must not be in the row`)
})

test('summarizeRun counts answers for an answer run and tolerates old run records', () => {
  const answer = summarizeRun(run('run_000000000002', { mode: 'answer', changedFiles: [], answered: ['thr_1'], unanswered: ['thr_2'], threadIds: ['thr_1', 'thr_2'] }))
  assert.equal(answer.answeredCount, 1)
  assert.equal(answer.unansweredCount, 1)
  const old = summarizeRun({ id: 'run_000000000003', sessionId: 'ses_1', status: 'failed', startedAt: 'x' })
  assert.equal(old.mode, 'fix')
  assert.equal(old.threadCount, 0)
  assert.deepEqual(old.changedFiles, [])
  assert.equal(old.hasChanges, false)
  assert.equal(old.published, null)
})

test('historyForSession lists this worktree\'s runs newest first, from this session or the same worktree', () => {
  const session = { id: 'ses_1', repoPath: '/repo' }
  const runs = [
    run('run_000000000001', { startedAt: '2026-10-14T01:00:00.000Z' }),
    run('run_000000000002', { startedAt: '2026-10-14T03:00:00.000Z', sessionId: 'ses_old' }), // an earlier session on the same worktree
    run('run_000000000003', { startedAt: '2026-10-14T02:00:00.000Z' }),
    run('run_000000000004', { sessionId: 'ses_other', cwd: '/elsewhere' })
  ]
  const history = historyForSession({ runs, session })
  assert.deepEqual(history.map((row) => row.id), ['run_000000000002', 'run_000000000003', 'run_000000000001'])
  assert.equal(historyForSession({ runs, session, limit: 2 }).length, 2)
  assert.equal(historyForSession({ runs, session: { id: 'ses_2', repoPath: null } }).length, 0)
  assert.ok(HISTORY_LIMIT >= 20)
})

test('capChanges drops the biggest diffs first when over budget and never mutates its input', () => {
  const file = (path, lines, width) => ({ path, changeType: 'modified', additions: lines, deletions: 0, hunks: [{ header: '@@', lines: Array.from({ length: lines }, (_, index) => ({ type: 'add', oldNo: null, newNo: index + 1, text: 'y'.repeat(width) })) }] })
  const input = [file('small.js', 3, 20), file('huge.js', 400, 200)]
  const capped = capChanges(input, { maxBytes: 20 * 1024 })
  assert.equal(capped.find((entry) => entry.path === 'small.js').hunks.length, 1)
  const huge = capped.find((entry) => entry.path === 'huge.js')
  assert.equal(huge.hunks.length, 0)
  assert.equal(huge.panelTruncated, true)
  assert.equal(input[1].hunks.length, 1, 'input is not mutated')
  assert.equal(capChanges(input, { maxBytes: 10 * 1024 * 1024 })[1].hunks.length, 1, 'within budget nothing is dropped')
})

test('buildExchanges pairs every question thread of a request with the answer this run gave it', () => {
  const exchanges = buildExchanges({
    run: run('run_000000000010', {
      mode: 'answer',
      threadIds: ['thr_1', 'thr_2'],
      threadSnapshots: [
        { id: 'thr_1', path: 'a.js', side: 'new', startLine: 2, endLine: 2, comments: [{ author: 'user', body: '이게 왜 필요해요?' }] },
        { id: 'thr_2', path: 'b.js', side: 'new', startLine: 5, endLine: 6, comments: [{ author: 'user', body: '두 번째 질문' }] }
      ],
      answers: [{ threadId: 'thr_1', body: '필요한 이유는 이렇습니다' }]
    }),
    session: { threads: [] }
  })
  assert.deepEqual(exchanges.map((entry) => entry.id), ['thr_1', 'thr_2'])
  assert.equal(exchanges[0].comments[0].body, '이게 왜 필요해요?')
  assert.equal(exchanges[0].answer, '필요한 이유는 이렇습니다', 'the answer sits on the question it answers')
  assert.equal(exchanges[1].answer, null, 'a thread the AI did not answer has no answer')
})

test('buildExchanges rebuilds a run without a saved snapshot from the session threads, keeping its AI reply as the answer', () => {
  const session = { threads: [{ id: 'thr_1', path: 'a.js', side: 'new', startLine: 2, endLine: 2, comments: [{ author: 'user', body: '질문' }, { author: 'ai', runId: 'run_000000000011', body: 'AI 답' }, { author: 'ai', runId: 'run_other', body: '다른 실행의 답' }] }] }
  const exchanges = buildExchanges({ run: run('run_000000000011', { mode: 'answer', threadIds: ['thr_1', 'thr_gone'] }), session })
  assert.equal(exchanges.length, 1, 'a thread that no longer exists is skipped')
  assert.equal(exchanges[0].answer, 'AI 답')
  assert.deepEqual(exchanges[0].comments.map((comment) => comment.body), ['질문', '다른 실행의 답'], 'this run\'s reply is the answer, not part of the question')
})

test('buildExchanges cuts a very long answer', () => {
  const exchanges = buildExchanges({ run: run('run_000000000012', { threadSnapshots: [{ id: 'thr_1', path: 'a.js', side: 'new', startLine: 1, endLine: 1, comments: [] }], answers: [{ threadId: 'thr_1', body: 'y'.repeat(20_000) }] }), session: { threads: [] } })
  assert.ok(exchanges[0].answer.length <= 4001)
})

test('run.view selects a run to inspect, or null to close it', () => {
  const sessionId = 'ses_0123456789ab'
  assert.deepEqual(validateOp({ op: 'run.view', sessionId, runId: 'run_000000000001' }), { ok: true })
  assert.deepEqual(validateOp({ op: 'run.view', sessionId, runId: null }), { ok: true })
  assert.equal(validateOp({ op: 'run.view', runId: 'run_000000000001' }).ok, false, 'needs the session')
  assert.equal(validateOp({ op: 'run.view', sessionId }).ok, false, 'runId must be given (a run id or null)')
  assert.equal(validateOp({ op: 'run.view', sessionId, runId: 12 }).ok, false)
  assert.equal(validateOp({ op: 'run.view', sessionId, runId: '' }).ok, false)
})

test('a run record keeps its change snapshot on disk, owner-only, and reads it back', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-hist-'))
  const manager = new RunManager({ homeDir, agentCommands: {}, git: {} })
  const files = [{ path: 'a.js', changeType: 'modified', additions: 1, deletions: 0, hunks: [{ header: '@@', lines: [{ type: 'add', oldNo: null, newNo: 1, text: 'x' }] }] }]
  assert.equal(manager.readChanges('run_000000000001'), null, 'nothing saved yet')
  mkdirSync(join(homeDir, 'runs', 'run_000000000001'), { recursive: true }) // start() creates the run directory
  manager.save({ id: 'run_000000000001', sessionId: 's', status: 'succeeded', startedAt: 'x' })
  manager.saveChanges('run_000000000001', files)
  const path = join(homeDir, 'runs', 'run_000000000001', 'changes.json')
  assert.ok(existsSync(path))
  assert.equal(statSync(path).mode & 0o077, 0, 'not readable by others')
  assert.deepEqual(manager.readChanges('run_000000000001'), files)
  assert.equal(manager.readChanges('run_ffffffffffff'), null, 'an unknown run has no snapshot')
})
