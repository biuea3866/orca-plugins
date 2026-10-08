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
