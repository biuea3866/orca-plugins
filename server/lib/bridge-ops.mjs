// Panel → server command protocol carried over a terminal (terminal.sendText).
// Wire format per line: `SR <base64url(JSON op)>`. Long messages are split into
// `SRC <chunkId> <index> <total> <data>` lines and reassembled.

const SESSION_ID = /^ses_[0-9a-f]{12}$/
const AGENTS = new Set(['claude', 'codex'])
const SIDES = new Set(['old', 'new'])

export const BRIDGE_OPS = [
  'session.open', 'session.patch', 'session.delete', 'session.complete',
  'thread.add', 'thread.patch', 'thread.delete',
  'comment.add', 'comment.patch', 'comment.delete',
  'run.start', 'run.cancel',
  'overview.refresh', 'view', 'wide', 'ping'
]

export function encodeBridgeLine(op) {
  return `SR ${Buffer.from(JSON.stringify(op), 'utf8').toString('base64url')}`
}

export function parseBridgeLine(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed.startsWith('SRC ')) {
    const [, chunkId, index, total, data] = trimmed.split(' ', 5)
    if (!chunkId || !data || !Number.isInteger(Number(index)) || !Number.isInteger(Number(total))) return { kind: 'error', error: 'malformed chunk line' }
    return { kind: 'chunk', chunk: { chunkId, index: Number(index), total: Number(total), data } }
  }
  if (!trimmed.startsWith('SR ')) return { kind: 'ignore' }
  try {
    const json = Buffer.from(trimmed.slice(3), 'base64url').toString('utf8')
    const op = JSON.parse(json)
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') return { kind: 'error', error: 'op must be a JSON object with an "op" field' }
    return { kind: 'op', op }
  } catch (error) {
    return { kind: 'error', error: `cannot decode bridge line: ${error.message}` }
  }
}

export class ChunkAssembler {
  constructor({ ttlMs = 30_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.now = now
    this.partials = new Map()
  }

  push({ chunkId, index, total, data }) {
    const current = this.now()
    for (const [id, entry] of this.partials) if (current - entry.startedAt > this.ttlMs) this.partials.delete(id)
    let entry = this.partials.get(chunkId)
    if (!entry) {
      entry = { startedAt: current, total, parts: new Array(total).fill(null) }
      this.partials.set(chunkId, entry)
    }
    if (index < 0 || index >= entry.total) return null
    entry.parts[index] = data
    if (entry.parts.some((part) => part === null)) return null
    this.partials.delete(chunkId)
    return entry.parts.join('')
  }
}

function fail(message) { return { ok: false, error: message } }
function requireSession(op) { return typeof op.sessionId === 'string' && SESSION_ID.test(op.sessionId) }
function requireRevision(op) { return Number.isInteger(op.revision) }
function requireString(value, max = 10_000) { return typeof value === 'string' && value.length >= 1 && value.length <= max }

export function validateOp(op) {
  if (!op || typeof op !== 'object' || !BRIDGE_OPS.includes(op.op)) return fail(`unknown op: ${op?.op}`)
  switch (op.op) {
    case 'session.open':
      return requireString(op.worktreePath, 4096) ? { ok: true } : fail('worktreePath required')
    case 'session.patch':
      return requireSession(op) && requireRevision(op) ? { ok: true } : fail('sessionId and revision required')
    case 'session.delete':
    case 'session.complete':
    case 'wide':
      return requireSession(op) ? { ok: true } : fail('sessionId required')
    case 'thread.add':
      return requireSession(op) && requireRevision(op) && requireString(op.path, 4096) && SIDES.has(op.side) && Number.isInteger(op.startLine) && Number.isInteger(op.endLine) && requireString(op.body)
        ? { ok: true } : fail('thread.add needs sessionId, revision, path, side, startLine, endLine, body')
    case 'thread.patch':
    case 'thread.delete':
      return requireSession(op) && requireRevision(op) && requireString(op.threadId, 64) ? { ok: true } : fail('sessionId, revision, threadId required')
    case 'comment.add':
      return requireSession(op) && requireRevision(op) && requireString(op.threadId, 64) && requireString(op.body) ? { ok: true } : fail('sessionId, revision, threadId, body required')
    case 'comment.patch':
      return requireSession(op) && requireRevision(op) && requireString(op.threadId, 64) && requireString(op.commentId, 64) && requireString(op.body) ? { ok: true } : fail('sessionId, revision, threadId, commentId, body required')
    case 'comment.delete':
      return requireSession(op) && requireRevision(op) && requireString(op.threadId, 64) && requireString(op.commentId, 64) ? { ok: true } : fail('sessionId, revision, threadId, commentId required')
    case 'run.start':
      return requireSession(op) && requireRevision(op) && AGENTS.has(op.agent) ? { ok: true } : fail('sessionId, revision and agent (claude|codex) required')
    case 'run.cancel':
      return requireString(op.runId, 64) ? { ok: true } : fail('runId required')
    case 'view':
      return requireSession(op) ? { ok: true } : fail('sessionId required')
    case 'overview.refresh':
    case 'ping':
      return { ok: true }
    default:
      return fail(`unhandled op ${op.op}`)
  }
}
