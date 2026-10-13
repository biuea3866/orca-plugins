// "Show the whole file": swaps the changed-lines-only diff of the files the user expanded for a version that
// carries every line of the file. Files that cannot be expanded keep their normal diff and say why.

/** The panel receives the file as data, so a full file has to stay small enough for the panel budget. */
export const FULL_FILE_MAX_LINES = 5000

const lineCount = (file) => file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)

/**
 * @param {{ files: Array<{path: string, hunks: Array<{lines: unknown[]}>}>, fullPaths?: string[], load: (file: object) => Promise<object|null>, maxLines?: number }} input
 * @returns {Promise<object[]>} the same files in the same order; requested ones carry `fullContext: true` or a `fullContextError`
 */
export async function applyFullFiles({ files, fullPaths, load, maxLines = FULL_FILE_MAX_LINES }) {
  const wanted = new Set(fullPaths ?? [])
  if (wanted.size === 0) return files
  return Promise.all(files.map(async (file) => {
    if (!wanted.has(file.path)) return file
    try {
      const full = await load(file)
      if (!full) return { ...file, fullContextError: '파일 전체 내용을 만들지 못했습니다.' }
      if (lineCount(full) > maxLines) return { ...file, fullContextError: `파일이 ${maxLines.toLocaleString('en-US')}줄을 넘어 패널에서는 전체 보기를 지원하지 않습니다. "넓게" 로 보세요.` }
      return { ...full, fullContext: true }
    } catch (error) {
      return { ...file, fullContextError: error.message }
    }
  }))
}
