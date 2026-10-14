// History of the AI runs of a worktree: what the reviewer asked, what the AI changed, and what became of it.
// A run's live diff is read from the working tree and disappears once the change is committed, so the diff and the
// triggering threads are snapshotted into the run record when the run starts/finishes. These helpers only shape data.

export const HISTORY_LIMIT = 30
/** Largest diff snapshot kept on disk per run. */
export const SNAPSHOT_MAX_BYTES = 1.5 * 1024 * 1024
/** Largest diff carried in the panel for the one run that is open. */
export const DETAIL_PANEL_MAX_BYTES = 150 * 1024

const MAX_THREADS = 50
const MAX_COMMENTS = 4
const MAX_BODY = 500
const MAX_ROW_FILES = 50

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** The questions a run was started from, kept small: thread position plus the latest few comments. */
export function snapshotThreads(threads) {
  return (threads ?? []).slice(0, MAX_THREADS).map((thread) => ({
    id: thread.id,
    path: thread.path,
    side: thread.side,
    startLine: thread.startLine,
    endLine: thread.endLine,
    comments: (thread.comments ?? []).slice(-MAX_COMMENTS).map((comment) => ({ author: comment.author ?? 'user', body: clip(comment.body, MAX_BODY) }))
  }))
}

/** One light row of the history list: no log, no diff, nothing secret. */
export function summarizeRun(run) {
  const changedFiles = run.changedFiles ?? []
  return {
    id: run.id,
    sessionId: run.sessionId ?? null,
    mode: run.mode ?? 'fix',
    agent: run.agent ?? null,
    status: run.status,
    exitCode: run.exitCode ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    branch: run.branch ?? null,
    threadCount: (run.threadIds ?? []).length,
    changedFiles: changedFiles.slice(0, MAX_ROW_FILES),
    changedCount: changedFiles.length,
    hasChanges: run.hasChanges === true,
    answeredCount: (run.answered ?? []).length,
    unansweredCount: (run.unanswered ?? []).length,
    published: run.published ? { commit: run.published.commit, branch: run.published.branch } : null,
    publishFailed: Boolean(run.publishError)
  }
}

/** A run belongs to a session's history when it ran for that session or in the same worktree. */
export function runBelongsToSession(run, session) {
  return run.sessionId === session.id || Boolean(session.repoPath && run.cwd === session.repoPath)
}

export function historyForSession({ runs, session, limit = HISTORY_LIMIT }) {
  return runs
    .filter((run) => runBelongsToSession(run, session))
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    .slice(0, limit)
    .map(summarizeRun)
}

/** Drops the hunks of the biggest files first until the diff fits `maxBytes`. Never mutates the input. */
export function capChanges(files, { maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const result = files.map((file) => ({ ...file }))
  const sizes = result.map((file) => JSON.stringify(file.hunks ?? []).length)
  let total = JSON.stringify(result).length
  const biggestFirst = sizes.map((size, index) => index).sort((left, right) => sizes[right] - sizes[left])
  for (const index of biggestFirst) {
    if (total <= maxBytes) break
    if (!result[index].hunks?.length) continue
    total -= sizes[index] - 2
    result[index] = { ...result[index], hunks: [], panelTruncated: true }
  }
  return result
}
