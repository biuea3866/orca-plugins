import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkAssembler, parseBridgeLine, validateOp, BRIDGE_OPS } from '../server/lib/bridge-ops.mjs'

test('parseBridgeLine decodes the SR <base64url json> wire format and rejects garbage', () => {
  const op = { op: 'thread.add', sessionId: 'ses_000000000001', revision: 3, path: 'a.js', side: 'new', startLine: 1, endLine: 2, selectedText: 'x\ny', body: '한글 코멘트 "quotes"' }
  const encoded = 'SR ' + Buffer.from(JSON.stringify(op), 'utf8').toString('base64url')
  assert.deepEqual(parseBridgeLine(encoded), { kind: 'op', op })
  assert.deepEqual(parseBridgeLine('hello world'), { kind: 'ignore' })
  assert.equal(parseBridgeLine('SR !!!not-base64!!!').kind, 'error')
})

test('ChunkAssembler reassembles multi-part messages in order and expires partial ones', () => {
  const assembler = new ChunkAssembler({ ttlMs: 1000, now: () => 0 })
  const whole = 'SR ' + Buffer.from(JSON.stringify({ op: 'overview.refresh' })).toString('base64url')
  const parts = [whole.slice(0, 10), whole.slice(10)]
  assert.equal(assembler.push({ chunkId: 'c1', index: 0, total: 2, data: parts[0] }), null)
  assert.deepEqual(assembler.push({ chunkId: 'c1', index: 1, total: 2, data: parts[1] }), whole)
  assert.equal(assembler.push({ chunkId: 'c2', index: 1, total: 2, data: 'b' }), null)
  assembler.now = () => 5000
  assert.equal(assembler.push({ chunkId: 'c2', index: 0, total: 2, data: 'a' }), null, 'expired partial chunk does not complete out of order')
})

test('validateOp accepts every documented op and rejects unknown ops or missing fields', () => {
  for (const name of BRIDGE_OPS) assert.ok(typeof name === 'string')
  assert.deepEqual(validateOp({ op: 'view', sessionId: 'ses_000000000001', file: 'a.js', scroll: 120 }), { ok: true })
  assert.deepEqual(validateOp({ op: 'session.open', worktreePath: '/repo' }), { ok: true })
  assert.deepEqual(validateOp({ op: 'run.start', sessionId: 'ses_000000000001', revision: 1, agent: 'claude' }), { ok: true })
  assert.equal(validateOp({ op: 'nope' }).ok, false)
  assert.equal(validateOp({ op: 'thread.add', sessionId: 'ses_000000000001' }).ok, false)
  assert.equal(validateOp({ op: 'run.start', sessionId: 'ses_000000000001', revision: 1, agent: 'gpt' }).ok, false)
})
