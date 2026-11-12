// Pure helpers for placing threads inline in the diff.

export function threadKey(path, side, line) {
  return `${path}|${side}|${line}`
}

export function placeThreads(threads) {
  const placement = {}
  for (const thread of threads) {
    const key = threadKey(thread.path, thread.side, thread.endLine)
    if (!placement[key]) placement[key] = []
    placement[key].push(thread)
  }
  return placement
}

export function countRunnable(threads) {
  return threads.filter((thread) => thread.status === 'open' && thread.applicability === 'current').length
}

export function countByFile(threads) {
  const counts = {}
  for (const thread of threads) counts[thread.path] = (counts[thread.path] ?? 0) + 1
  return counts
}

// An AI reply answers the preceding reviewer question, not a later follow-up.
export function answeredCommentIds(comments = []) {
  const answered = new Set()
  let question = null
  for (const comment of comments) {
    if (comment.pending) continue
    if (comment.author !== 'ai') question = comment.id ?? null
    else if (question && String(comment.body ?? '').trim()) answered.add(question)
  }
  return answered
}

export function countAnswerable(threads) {
  return threads.filter(thread => thread.status === 'open' && thread.comments.at(-1)?.author !== 'ai' && Boolean(thread.comments.at(-1)?.body?.trim())).length
}
