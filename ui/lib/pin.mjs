// The worktree the user picked by hand has to survive the panel iframe being remounted (switching to another
// plugin panel and back): the iframe is sandboxed without storage, so the server remembers the pick and
// publishes it in the panel data. This decides whether that remembered pick is still usable.

/**
 * @param {unknown} pinnedPath remembered worktree path from the panel data
 * @param {Array<{path: string}> | undefined} worktrees worktrees currently known to the panel
 * @returns {string | null} the path to pin again, or null when there is nothing valid to restore
 */
export function restorePinned(pinnedPath, worktrees) {
  if (typeof pinnedPath !== 'string' || !pinnedPath) return null
  return (worktrees ?? []).some((worktree) => worktree.path === pinnedPath) ? pinnedPath : null
}
