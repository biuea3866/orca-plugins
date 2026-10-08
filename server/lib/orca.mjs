// Orca CLI adapter (read-only): registered repos and worktrees.

export class OrcaReader {
  constructor({ exec, orcaBinary }) {
    this.exec = exec
    this.orcaBinary = orcaBinary
  }

  async runJson(args) {
    if (!this.orcaBinary) throw new Error('orca CLI not found')
    const result = await this.exec(this.orcaBinary, [...args, '--json'], { timeout: 15_000 })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || 'orca failed').trim())
    const parsed = JSON.parse(result.stdout)
    if (!parsed.ok) throw new Error(parsed.error?.message ?? 'orca returned ok=false')
    return parsed.result
  }

  async repos() {
    const result = await this.runJson(['repo', 'list'])
    return (result.repos ?? []).map((repo) => ({
      id: repo.id,
      path: repo.path,
      displayName: repo.displayName ?? repo.path,
      remoteUrl: repo.gitRemoteIdentity?.remoteUrl ?? null
    }))
  }

  async worktrees() {
    const result = await this.runJson(['worktree', 'list'])
    return (result.worktrees ?? []).map((worktree) => ({
      id: worktree.id,
      repoId: worktree.repoId,
      path: worktree.path,
      branch: String(worktree.branch ?? '').replace(/^refs\/heads\//, ''),
      displayName: worktree.displayName ?? '',
      isMainWorktree: Boolean(worktree.isMainWorktree)
    }))
  }

  /** Both lists, tolerant of a missing/failed CLI (returns empty lists + error). */
  async inventory() {
    try {
      const [repos, worktrees] = await Promise.all([this.repos(), this.worktrees()])
      return { repos, worktrees, error: null }
    } catch (error) {
      return { repos: [], worktrees: [], error: error.message }
    }
  }
}
