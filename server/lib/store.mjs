// Session / thread / comment persistence: one JSON file per session under
// <homeDir>/sessions, atomic replace (tmp + rename), revision check on writes.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_THREAD_LINES = 200
export const MAX_COMMENT_LENGTH = 10_000
const SIDES = new Set(['old', 'new'])
const AGENTS = new Set(['claude', 'codex'])
const STATUSES = new Set(['reviewing', 'fixing', 'rechecking', 'completed'])

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function makeId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode })
  renameSync(tmpPath, filePath)
}

export function summarizeSession(session) {
  const { threads, ...rest } = session
  return {
    ...rest,
    threads: {
      open: threads.filter((thread) => thread.status === 'open').length,
      resolved: threads.filter((thread) => thread.status === 'resolved').length
    }
  }
}

function requireString(value, name, { max = 4096, min = 1 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ApiError(400, 'invalid_field', `${name} must be a string of ${min}-${max} characters`)
  }
  return value
}

export class SessionStore {
  constructor({ homeDir, now = () => new Date().toISOString() }) {
    this.sessionsDir = join(homeDir, 'sessions')
    this.now = now
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 })
  }

  filePath(sessionId) {
    if (!/^ses_[0-9a-f]{12}$/.test(sessionId)) throw new ApiError(404, 'session_not_found', `session ${sessionId} not found`)
    return join(this.sessionsDir, `${sessionId}.json`)
  }

  listSessions() {
    const summaries = []
    for (const entry of readdirSync(this.sessionsDir)) {
      if (!entry.endsWith('.json')) continue
      try {
        summaries.push(summarizeSession(JSON.parse(readFileSync(join(this.sessionsDir, entry), 'utf8'))))
      } catch {
        // skip corrupt file; never crash listing
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  listSessionsFull() {
    return this.listSessions().map((summary) => this.getSession(summary.id))
  }

  getSession(sessionId) {
    const filePath = this.filePath(sessionId)
    if (!existsSync(filePath)) throw new ApiError(404, 'session_not_found', `session ${sessionId} not found`)
    return JSON.parse(readFileSync(filePath, 'utf8'))
  }

  save(session) {
    session.revision += 1
    session.updatedAt = this.now()
    writeJsonAtomic(this.filePath(session.id), session)
    return session
  }

  deleteSession(sessionId) {
    const filePath = this.filePath(sessionId)
    if (!existsSync(filePath)) throw new ApiError(404, 'session_not_found', `session ${sessionId} not found`)
    unlinkSync(filePath)
  }

  findReusable(input) {
    for (const session of this.listSessionsFull()) {
      if (session.status === 'completed') continue
      if (input.kind === 'local' && session.kind === 'local' && session.repoPath === input.repoPath && session.baseRef === input.baseRef) return session
      if (input.kind === 'pr' && session.kind === 'pr' && session.pr && session.pr.owner === input.pr.owner && session.pr.repo === input.pr.repo && session.pr.number === input.pr.number) return session
    }
    return null
  }

  createSession(input) {
    if (input.kind !== 'local' && input.kind !== 'pr') throw new ApiError(400, 'invalid_field', 'kind must be local or pr')
    const existing = this.findReusable(input)
    if (existing) return existing
    const timestamp = this.now()
    const session = {
      schemaVersion: 1,
      id: makeId('ses'),
      kind: input.kind,
      revision: 0,
      repoPath: input.repoPath ?? null,
      worktreeId: input.worktreeId ?? null,
      repoDisplayName: input.repoDisplayName ?? '',
      branch: input.branch ?? '',
      baseRef: input.baseRef,
      includeUntracked: input.includeUntracked ?? false,
      includeWorkingTree: input.includeWorkingTree ?? false,
      pr: input.kind === 'pr' ? input.pr : null,
      agent: AGENTS.has(input.agent) ? input.agent : 'claude',
      status: 'reviewing',
      threads: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }
    return this.save(session)
  }

  withRevision(sessionId, revision) {
    const session = this.getSession(sessionId)
    if (typeof revision !== 'number' || revision !== session.revision) {
      throw new ApiError(409, 'revision_conflict', `session revision is ${session.revision}, request carried ${revision}`, { revision: session.revision })
    }
    return session
  }

  updateSession(sessionId, patch) {
    const session = this.withRevision(sessionId, patch.revision)
    if (patch.baseRef !== undefined) session.baseRef = requireString(patch.baseRef, 'baseRef', { max: 512 })
    if (patch.includeUntracked !== undefined) session.includeUntracked = Boolean(patch.includeUntracked)
    if (patch.includeWorkingTree !== undefined) session.includeWorkingTree = Boolean(patch.includeWorkingTree)
    if (patch.agent !== undefined) {
      if (!AGENTS.has(patch.agent)) throw new ApiError(400, 'invalid_field', 'agent must be claude or codex')
      session.agent = patch.agent
    }
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status)) throw new ApiError(400, 'invalid_field', 'invalid status')
      session.status = patch.status
    }
    return this.save(session)
  }

  setStatus(sessionId, status) {
    const session = this.getSession(sessionId)
    session.status = status
    return this.save(session)
  }

  findThread(session, threadId) {
    const thread = session.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new ApiError(404, 'thread_not_found', `thread ${threadId} not found`)
    return thread
  }

  addThread(sessionId, input) {
    const session = this.withRevision(sessionId, input.revision)
    const path = requireString(input.path, 'path', { max: 4096 })
    if (!SIDES.has(input.side)) throw new ApiError(400, 'invalid_field', 'side must be old or new')
    const { startLine, endLine } = input
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new ApiError(400, 'invalid_range', 'startLine/endLine must be integers with 1 <= startLine <= endLine')
    }
    if (endLine - startLine + 1 > MAX_THREAD_LINES) throw new ApiError(400, 'invalid_range', `a thread may span at most ${MAX_THREAD_LINES} lines`)
    const body = requireString(input.body, 'body', { max: MAX_COMMENT_LENGTH })
    const timestamp = this.now()
    session.threads.push({
      id: makeId('thr'),
      path,
      oldPath: typeof input.oldPath === 'string' ? input.oldPath : null,
      side: input.side,
      startLine,
      endLine,
      selectedText: typeof input.selectedText === 'string' ? input.selectedText : '',
      status: 'open',
      applicability: 'current',
      comments: [{ id: makeId('cmt'), body, createdAt: timestamp, updatedAt: timestamp }],
      createdAt: timestamp,
      resolvedAt: null
    })
    return this.save(session)
  }

  updateThread(sessionId, threadId, input) {
    const session = this.withRevision(sessionId, input.revision)
    const thread = this.findThread(session, threadId)
    if (input.status !== undefined) {
      if (input.status !== 'open' && input.status !== 'resolved') throw new ApiError(400, 'invalid_field', 'status must be open or resolved')
      thread.status = input.status
      thread.resolvedAt = input.status === 'resolved' ? this.now() : null
    }
    return this.save(session)
  }

  deleteThread(sessionId, threadId, input) {
    const session = this.withRevision(sessionId, input.revision)
    this.findThread(session, threadId)
    session.threads = session.threads.filter((thread) => thread.id !== threadId)
    return this.save(session)
  }

  addComment(sessionId, threadId, input) {
    const session = this.withRevision(sessionId, input.revision)
    const thread = this.findThread(session, threadId)
    const body = requireString(input.body, 'body', { max: MAX_COMMENT_LENGTH })
    const timestamp = this.now()
    thread.comments.push({ id: makeId('cmt'), body, createdAt: timestamp, updatedAt: timestamp })
    return this.save(session)
  }

  findComment(thread, commentId) {
    const comment = thread.comments.find((candidate) => candidate.id === commentId)
    if (!comment) throw new ApiError(404, 'comment_not_found', `comment ${commentId} not found`)
    return comment
  }

  updateComment(sessionId, threadId, commentId, input) {
    const session = this.withRevision(sessionId, input.revision)
    const comment = this.findComment(this.findThread(session, threadId), commentId)
    comment.body = requireString(input.body, 'body', { max: MAX_COMMENT_LENGTH })
    comment.updatedAt = this.now()
    return this.save(session)
  }

  deleteComment(sessionId, threadId, commentId, input) {
    const session = this.withRevision(sessionId, input.revision)
    const thread = this.findThread(session, threadId)
    this.findComment(thread, commentId)
    thread.comments = thread.comments.filter((comment) => comment.id !== commentId)
    if (thread.comments.length === 0) session.threads = session.threads.filter((candidate) => candidate.id !== threadId)
    return this.save(session)
  }
}
