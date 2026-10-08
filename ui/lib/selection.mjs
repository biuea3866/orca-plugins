// Pure multi-line selection logic for the diff gutter (no DOM).

export const MAX_SELECTION_LINES = 200

export function beginSelection(cell) {
  return { path: cell.path, side: cell.side, anchor: cell.line, head: cell.line }
}

export function extendSelection(selection, cell) {
  if (!selection) return beginSelection(cell)
  if (cell.path !== selection.path || cell.side !== selection.side) return selection
  return { ...selection, head: cell.line }
}

export function normalizeRange({ anchor, head }) {
  return { startLine: Math.min(anchor, head), endLine: Math.max(anchor, head) }
}

export function clampRange({ anchor, head }) {
  const { startLine, endLine } = normalizeRange({ anchor, head })
  if (endLine - startLine + 1 <= MAX_SELECTION_LINES) return { startLine, endLine }
  if (head >= anchor) return { startLine: anchor, endLine: anchor + MAX_SELECTION_LINES - 1 }
  return { startLine: anchor - MAX_SELECTION_LINES + 1, endLine: anchor }
}

export function isLineSelected(selection, cell) {
  if (!selection || cell.path !== selection.path || cell.side !== selection.side) return false
  const { startLine, endLine } = clampRange(selection)
  return cell.line >= startLine && cell.line <= endLine
}
