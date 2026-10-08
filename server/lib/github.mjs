// Read-only GitHub access through the `gh` CLI. ONLY `gh pr list`, `gh pr view`
// and `gh pr diff` are ever invoked — this module is the single place that
// talks to GitHub (NFR-15/16).

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './store.mjs'

export const PR_CACHE_TTL_MS = 5 * 60_000
const LIST_FIELDS = 'number,title,isDraft,headRefName,baseRefName,author,updatedAt,url,additions,deletions,changedFiles'
const VIEW_FIELDS = 'number,title,body,isDraft,author,baseRefName,headRefName,headRefOid,url,additions,deletions,changedFiles,updatedAt,state'

export function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

function mapListEntry(entry) {
  return {
    number: entry.number,
    title: entry.title,
    isDraft: Boolean(entry.isDraft),
    headRefName: entry.headRefName,
    baseRefName: entry.baseRefName,
    author: entry.author?.login ?? '',
    updatedAt: entry.updatedAt,
    url: entry.url,
    additions: entry.additions ?? 0,
    deletions: entry.deletions ?? 0,
    changedFiles: entry.changedFiles ?? 0
  }
}

export class GitHubReader {
  constructor({ homeDir, exec, now = () => Date.now(), ghBinary = 'gh' }) {
    this.cacheDir = join(homeDir, 'cache', 'github')
    this.exec = exec
    this.now = now
    this.ghBinary = ghBinary
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
  }

  cachePath({ owner, repo }) {
    return join(this.cacheDir, `${owner}__${repo}.json`.replace(/[^A-Za-z0-9_.-]/g, '_'))
  }

  readCache(target) {
    const filePath = this.cachePath(target)
    if (!existsSync(filePath)) return null
    try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return null }
  }

  async run(args) {
    const result = await this.exec(this.ghBinary, args, { timeout: 30_000 })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `gh exited with ${result.code}`).trim())
    return result.stdout
  }

  async listOpenPullRequests(target, { force = false } = {}) {
    const cached = this.readCache(target)
    if (!force && cached && this.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return { prs: cached.prs, fetchedAt: cached.fetchedAt, error: null }
    try {
      const stdout = await this.run(['pr', 'list', '--repo', `${target.owner}/${target.repo}`, '--state', 'open', '--limit', '100', '--json', LIST_FIELDS])
      const prs = JSON.parse(stdout).map(mapListEntry)
      const fetchedAt = this.now()
      writeJsonAtomic(this.cachePath(target), { prs, fetchedAt })
      return { prs, fetchedAt, error: null }
    } catch (error) {
      return { prs: cached?.prs ?? [], fetchedAt: cached?.fetchedAt ?? null, error: error.message }
    }
  }

  async getPullRequest({ owner, repo, number }) {
    const stdout = await this.run(['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', VIEW_FIELDS])
    const entry = JSON.parse(stdout)
    return {
      ...mapListEntry(entry),
      body: entry.body ?? '',
      headSha: entry.headRefOid ?? null,
      state: entry.state ?? 'OPEN',
      owner,
      repo
    }
  }

  async getPullRequestDiff({ owner, repo, number }) {
    return this.run(['pr', 'diff', String(number), '--repo', `${owner}/${repo}`])
  }
}
