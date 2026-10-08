// Git read access for local review sessions. Only read-only commands.

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ApiError } from './store.mjs'
import { parseUnifiedDiff } from './diff-parser.mjs'

const BASE_CANDIDATES = ['origin/main', 'origin/dev', 'origin/master', 'main', 'dev', 'master']

export class GitReader {
  constructor({ exec, gitBinary = 'git' }) {
    this.exec = exec
    this.gitBinary = gitBinary
  }

  async run(cwd, args, { allowFailure = false } = {}) {
    let result
    try {
      result = await this.exec(this.gitBinary, args, { cwd })
    } catch (error) {
      throw new ApiError(500, 'git_unavailable', `git could not be executed: ${error.message}`)
    }
    if (result.code !== 0 && !allowFailure) throw new ApiError(400, 'git_failed', (result.stderr || result.stdout || `git ${args[0]} failed`).trim())
    return result
  }

  async repoRoot(path) {
    const result = await this.run(path, ['rev-parse', '--show-toplevel'])
    return result.stdout.trim()
  }

  async currentBranch(cwd) {
    const result = await this.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return result.stdout.trim()
  }

  async refExists(cwd, ref) {
    const result = await this.run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })
    return result.code === 0
  }

  async baseCandidates(cwd) {
    const candidates = []
    const originHead = await this.run(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true })
    if (originHead.code === 0 && originHead.stdout.trim()) candidates.push(originHead.stdout.trim())
    for (const candidate of BASE_CANDIDATES) {
      if (!candidates.includes(candidate) && (await this.refExists(cwd, candidate))) candidates.push(candidate)
    }
    return candidates
  }

  async headSha(cwd) {
    return (await this.run(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  }

  async mergeBase(cwd, baseRef) {
    const result = await this.run(cwd, ['merge-base', baseRef, 'HEAD'], { allowFailure: true })
    if (result.code !== 0) throw new ApiError(400, 'git_failed', `cannot compute merge-base for ${baseRef}: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout.trim()
  }

  async untrackedFiles(cwd) {
    const result = await this.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    return result.stdout.split('\0').filter(Boolean)
  }

  async workingTreeDiff(cwd, { baseRef, includeUntracked }) {
    const mergeBaseSha = await this.mergeBase(cwd, baseRef)
    const headSha = await this.headSha(cwd)
    const baseSha = (await this.run(cwd, ['rev-parse', baseRef])).stdout.trim()
    const diff = await this.run(cwd, ['diff', '--no-color', '--no-ext-diff', '--find-renames', mergeBaseSha, '--'])
    const files = parseUnifiedDiff(diff.stdout)
    if (includeUntracked) {
      for (const file of await this.untrackedFiles(cwd)) {
        const untracked = await this.run(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file], { allowFailure: true })
        if (untracked.code > 1) continue
        files.push(...parseUnifiedDiff(untracked.stdout, { changeType: 'untracked' }).map((entry) => ({ ...entry, path: file })))
      }
    }
    return { files, baseSha, headSha, mergeBaseSha, computedAt: new Date().toISOString() }
  }

  async porcelainStatus(cwd) {
    const result = await this.run(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
    const entries = result.stdout.split('\0').filter(Boolean)
    return entries.map((entry) => entry.slice(3))
  }
}

/** Reads a file inside the repo as lines, refusing paths that escape the repo. */
export function readRepoFileLines(repoPath, relativePath) {
  const absolute = resolve(repoPath, relativePath)
  const root = resolve(repoPath)
  if (absolute !== root && !absolute.startsWith(root + sep)) return []
  if (!existsSync(absolute)) return []
  try {
    const text = readFileSync(absolute, 'utf8')
    if (text.length > 5 * 1024 * 1024) return []
    return text.split('\n')
  } catch {
    return []
  }
}

export function isInsideRepo(repoPath, candidate) {
  const root = resolve(repoPath)
  const absolute = resolve(candidate)
  return absolute === root || absolute.startsWith(root + sep)
}

export { join }
