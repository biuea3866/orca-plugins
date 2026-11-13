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

export function isFixRunnable(thread) {
  if (thread.status !== 'open') return false
  const pending = comment => comment.author !== 'ai' && !comment.fixCompletedAt
  if (thread.applicability === 'current') return thread.comments.some(pending)
  // A fresh follow-up after a completed request applies to the current implementation,
  // even when the previous fix moved or removed the original anchor.
  return thread.applicability === 'outdated' && thread.comments.some((comment, index) =>
    pending(comment) && thread.comments.slice(0, index).some(previous => previous.author !== 'ai' && previous.fixCompletedAt))
}

export function countRunnable(threads) {
  return threads.filter(isFixRunnable).length
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
    else if (question && comment.kind!=='fix-result' && comment.kind!=='question' && String(comment.body ?? '').trim()) answered.add(question)
  }
  return answered
}

export function countAnswerable(threads) { return threads.filter(isAnswerableThread).length }

export function isAnswerableThread(thread) {
 const last=thread.comments.filter(comment=>comment.kind!=='fix-result').at(-1)
 return thread.status==='open' && last && last.author!=='ai' && !last.fixCompletedAt && Boolean(last.body?.trim())
}
export function countAwaitingAnswers(threads) { return threads.filter(isAnswerableThread).length }
export function isCommentAnswered(comments,index) {return comments[index]?.author!=='ai' && answeredCommentIds(comments).has(comments[index]?.id)}

export function isAiQuestionAnswered(comments,index) {
 return comments[index]?.kind === 'question' && comments.slice(index+1).some(comment=>comment.author !== 'ai')
}

// Keep data chronological for prompts; only the visual order groups result replies under requests.
export function commentsForDisplay(comments) {
  const parents = new Set(comments.filter(comment => comment.author !== 'ai').map(comment => comment.id))
  const replies = comments.filter(comment => comment.kind === 'fix-result' && parents.has(comment.replyToCommentId))
  const attached = new Set(replies)
  return comments.filter(comment => !attached.has(comment)).flatMap(comment => [comment, ...replies.filter(reply => reply.replyToCommentId === comment.id)])
}
