// Turns "my pushed branches without a PR" into panel cards: hides branches that
// already have an open PR (the branch list is cached separately from the PR list,
// so a PR opened a minute ago would otherwise linger) and links a local Orca
// worktree when one is registered for the branch.

export function branchCards({ repoId, branches, prs, worktrees }) {
  const openHeads = new Set(prs.map((pr) => pr.headRefName))
  return branches
    .filter((branch) => !openHeads.has(branch.name))
    .map((branch) => {
      const worktree = worktrees.find((candidate) => candidate.repoId === repoId && candidate.branch === branch.name)
      return { ...branch, worktreePath: worktree?.path ?? null, worktreeId: worktree?.id ?? null }
    })
}
