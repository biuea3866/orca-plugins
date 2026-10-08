// Unified diff parser (git diff / gh pr diff output) → DiffFile[] per docs/02-design.md.

export const MAX_DIFF_LINES_PER_FILE = 20_000

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function stripPrefix(path) {
  if (path === '/dev/null') return null
  return path.replace(/^[ab]\//, '')
}

function parseDiffGitLine(line) {
  // diff --git a/<old> b/<new>  (paths may contain spaces; split on " b/")
  const rest = line.slice('diff --git '.length)
  const separator = rest.indexOf(' b/')
  if (separator === -1) return { oldPath: null, newPath: rest }
  return { oldPath: rest.slice(2, separator), newPath: rest.slice(separator + 3) }
}

function newFile(oldPath, newPath, changeTypeOverride) {
  return {
    path: newPath,
    oldPath: null,
    _gitOldPath: oldPath,
    changeType: changeTypeOverride ?? 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    _lineCount: 0,
    _forcedType: Boolean(changeTypeOverride)
  }
}

function finalizeFile(file) {
  if (file._lineCount > MAX_DIFF_LINES_PER_FILE) {
    file.hunks = []
    file.truncated = true
  }
  delete file._lineCount
  delete file._gitOldPath
  delete file._forcedType
  return file
}

/**
 * @param {string} text unified diff text
 * @param {{ changeType?: 'untracked' }} [options] force a change type (untracked files from `git diff --no-index`)
 */
export function parseUnifiedDiff(text, options = {}) {
  const files = []
  if (!text || !text.trim()) return files
  const lines = text.split('\n')
  let file = null
  let hunk = null
  let oldNo = 0
  let newNo = 0
  let remainingOld = 0
  let remainingNew = 0

  for (const rawLine of lines) {
    if (rawLine.startsWith('diff --git ')) {
      if (file) files.push(finalizeFile(file))
      const { oldPath, newPath } = parseDiffGitLine(rawLine)
      file = newFile(oldPath, newPath, options.changeType)
      hunk = null
      continue
    }
    if (!file) continue

    if (hunk) {
      const marker = rawLine[0]
      if (marker === '\\') continue // "\ No newline at end of file"
      if (marker === ' ' || marker === '+' || marker === '-' || (rawLine === '' && remainingOld > 0 && remainingNew > 0)) {
        const textContent = rawLine.slice(1)
        file._lineCount += 1
        if (marker === '+') {
          file.additions += 1
          if (file._lineCount <= MAX_DIFF_LINES_PER_FILE) hunk.lines.push({ type: 'add', oldNo: null, newNo, text: textContent })
          newNo += 1
          remainingNew -= 1
        } else if (marker === '-') {
          file.deletions += 1
          if (file._lineCount <= MAX_DIFF_LINES_PER_FILE) hunk.lines.push({ type: 'del', oldNo, newNo: null, text: textContent })
          oldNo += 1
          remainingOld -= 1
        } else {
          if (file._lineCount <= MAX_DIFF_LINES_PER_FILE) hunk.lines.push({ type: 'context', oldNo, newNo, text: textContent })
          oldNo += 1
          newNo += 1
          remainingOld -= 1
          remainingNew -= 1
        }
        continue
      }
      hunk = null
    }

    const hunkMatch = HUNK_HEADER.exec(rawLine)
    if (hunkMatch) {
      hunk = {
        header: rawLine,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: []
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      remainingOld = hunk.oldLines
      remainingNew = hunk.newLines
      file.hunks.push(hunk)
      continue
    }
    if (rawLine.startsWith('new file mode')) { if (!file._forcedType) file.changeType = 'added'; continue }
    if (rawLine.startsWith('deleted file mode')) { if (!file._forcedType) file.changeType = 'deleted'; continue }
    if (rawLine.startsWith('rename from ')) { file.oldPath = rawLine.slice('rename from '.length); if (!file._forcedType) file.changeType = 'renamed'; continue }
    if (rawLine.startsWith('rename to ')) { file.path = rawLine.slice('rename to '.length); continue }
    if (rawLine.startsWith('Binary files ') || rawLine.startsWith('GIT binary patch')) { file.binary = true; continue }
    if (rawLine.startsWith('--- ')) { const path = stripPrefix(rawLine.slice(4)); if (path === null && !file._forcedType && file.changeType === 'modified') file.changeType = 'added'; continue }
    if (rawLine.startsWith('+++ ')) { const path = stripPrefix(rawLine.slice(4)); if (path === null && !file._forcedType) file.changeType = 'deleted'; else if (path) file.path = path; continue }
  }
  if (file) files.push(finalizeFile(file))
  return files
}
