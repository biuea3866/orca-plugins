// Finds standalone clones of a registered repo that Orca does not know about (read-only).
//
// Orca only lists the worktrees it manages, so a branch checked out in a separate clone such as
// ~/Desktop/<workspace>/greeting-GRT-10568 never reached the worktree select box. People keep these
// clones next to the registered repo, so we look at the direct children of the registered repo's
// parent dir: a child counts when it is a git checkout, is not already known to Orca, and its
// `origin` points at the same GitHub repo. Nothing is written and nothing is walked recursively.

import { readdirSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseGitHubRemote } from './github.mjs'

const DEFAULT_LIMIT_PER_REPO = 20
const MAX_DIRS_PER_PARENT = 200

function sameGitHubRepo(left, right) {
  return Boolean(left && right) && left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase()
}

function childCheckouts(parent) {
  let entries
  try { entries = readdirSync(parent, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.worktrees') && existsSync(join(parent, entry.name, '.git')))
    .map((entry) => join(parent, entry.name))
    .sort()
    .slice(0, MAX_DIRS_PER_PARENT)
}

/**
 * @param {{ repos: Array<{id: string, path: string, remoteUrl: string|null}>, worktrees: Array<{path: string}>, git: {remoteUrl(dir): Promise<string>, currentBranch(dir): Promise<string>}, limitPerRepo?: number }} input
 * @returns {Promise<Array<{id: null, repoId: string, path: string, branch: string, displayName: string, isMainWorktree: false, unregistered: true}>>}
 */
export async function discoverSiblingClones({ repos, worktrees, git, limitPerRepo = DEFAULT_LIMIT_PER_REPO }) {
  const known = new Set([...repos.map((repo) => resolve(repo.path)), ...worktrees.map((worktree) => resolve(worktree.path))])
  const candidatesByParent = new Map()
  const probes = new Map()

  function candidatesIn(parent) {
    if (!candidatesByParent.has(parent)) candidatesByParent.set(parent, childCheckouts(parent).filter((dir) => !known.has(dir)))
    return candidatesByParent.get(parent)
  }

  // One probe per directory even when several registered repos share a parent. A dir that cannot be read, has no
  // GitHub origin or sits on a detached HEAD is simply not a reviewable clone.
  function probe(dir) {
    if (!probes.has(dir)) {
      probes.set(dir, (async () => {
        try {
          const target = parseGitHubRemote(await git.remoteUrl(dir))
          if (!target) return null
          const branch = await git.currentBranch(dir)
          return branch && branch !== 'HEAD' ? { target, branch } : null
        } catch {
          return null
        }
      })())
    }
    return probes.get(dir)
  }

  const found = []
  const claimed = new Set()
  for (const repo of repos) {
    const repoTarget = parseGitHubRemote(repo.remoteUrl)
    if (!repoTarget) continue
    const dirs = candidatesIn(dirname(resolve(repo.path))).filter((dir) => !claimed.has(dir))
    const probed = await Promise.all(dirs.map(async (dir) => [dir, await probe(dir)]))
    let taken = 0
    for (const [dir, result] of probed) {
      if (taken >= limitPerRepo) break
      if (!result || !sameGitHubRepo(result.target, repoTarget)) continue
      claimed.add(dir)
      taken += 1
      found.push({ id: null, repoId: repo.id, path: dir, branch: result.branch, displayName: basename(dir), isMainWorktree: false, unregistered: true })
    }
  }
  return found
}
