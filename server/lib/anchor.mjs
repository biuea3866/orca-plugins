// Thread anchor validation against the current diff (FR-09).

function findFile(files, path) {
  return files.find((file) => file.path === path) ?? null
}

/** Returns the text of lines [startLine, endLine] on one side, or null when any line is absent from the diff. */
export function extractSideLines(files, path, side, startLine, endLine) {
  const file = findFile(files, path)
  if (!file) return null
  const byNumber = new Map()
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const number = side === 'old' ? line.oldNo : line.newNo
      if (number !== null) byNumber.set(number, line.text)
    }
  }
  const result = []
  for (let number = startLine; number <= endLine; number += 1) {
    if (!byNumber.has(number)) return null
    result.push(byNumber.get(number))
  }
  return result
}

function normalize(lines) {
  return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
}

export function computeApplicability(files, thread) {
  const lines = extractSideLines(files, thread.path, thread.side, thread.startLine, thread.endLine)
  if (lines === null) return 'outdated'
  return normalize(lines) === normalize(String(thread.selectedText ?? '').split('\n')) ? 'current' : 'outdated'
}

export function annotateThreads(files, threads) {
  for (const thread of threads) thread.applicability = computeApplicability(files, thread)
  return threads
}
