// Read-only GitHub access through the `gh` CLI. Only `gh pr list`, `gh pr view`,
// `gh pr diff` and read-only `gh api graphql` QUERIES are ever invoked — this
// module is the single place that talks to GitHub (NFR-15/16). `graphql()`
// refuses mutations and subscriptions.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './store.mjs'

export const PR_CACHE_TTL_MS = 5 * 60_000
export const MY_BRANCH_WINDOW_DAYS = 30
const MAX_REF_PAGES = 10
const MAX_BRANCHES_PER_REPO = 30
const LIST_FIELDS = 'number,title,isDraft,headRefName,baseRefName,author,updatedAt,url,additions,deletions,changedFiles'
const VIEW_FIELDS = 'number,title,body,isDraft,author,baseRefName,headRefName,headRefOid,url,additions,deletions,changedFiles,updatedAt,state'

const VIEWER_QUERY = 'query { viewer { login } }'
// Branch refs come back ordered by name, not by date, so every page is read and filtered here.
const REFS_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    defaultBranchRef{ name }
    refs(refPrefix:"refs/heads/", first:100, after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{
        name
        associatedPullRequests(first:1){ totalCount }
        target{ ... on Commit { oid committedDate messageHeadline author{ email user{ login } } committer{ email user{ login } } } }
      }
    }
  }
}`
// Shared integration/base branches are never "my work in progress", even when my commit is their tip.
const BASE_BRANCH = /^(?:main|master|dev|develop|development|stage|staging|production)$|^(?:release|hotfix)\//

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
    this.viewerPromise = null
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
  }

  cachePath({ owner, repo }, kind = '') {
    return join(this.cacheDir, `${owner}__${repo}${kind ? `.${kind}` : ''}.json`.replace(/[^A-Za-z0-9_.-]/g, '_'))
  }

  readCache(target, kind = '') {
    const filePath = this.cachePath(target, kind)
    if (!existsSync(filePath)) return null
    try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return null }
  }

  async run(args) {
    const result = await this.exec(this.ghBinary, args, { timeout: 30_000 })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `gh exited with ${result.code}`).trim())
    return result.stdout
  }

  /** Runs a GraphQL *query* (never a mutation/subscription) and returns its `data`. */
  async graphql(query, variables = {}) {
    if (!/^\s*query\b/.test(query) || /\b(?:mutation|subscription)\b/i.test(query)) throw new Error('graphql is read-only: only query operations are allowed')
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) if (value !== undefined && value !== null) args.push('-f', `${key}=${value}`)
    const parsed = JSON.parse(await this.run(args))
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) throw new Error(parsed.errors.map((error) => error.message).join('; '))
    return parsed.data
  }

  async viewerLogin() {
    if (!this.viewerPromise) {
      this.viewerPromise = this.graphql(VIEWER_QUERY).then((data) => String(data.viewer.login))
      this.viewerPromise.catch(() => { this.viewerPromise = null })
    }
    return this.viewerPromise
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

  /**
   * Branches I pushed (head commit authored/committed by my GitHub login) in the
   * last `sinceDays` days that have no PR in any state. Needs no local clone, so
   * it also finds branches pushed from checkouts Orca does not know about.
   */
  async listMyBranchesWithoutPr(target, { force = false, sinceDays = MY_BRANCH_WINDOW_DAYS } = {}) {
    const cached = this.readCache(target, 'branches')
    if (!force && cached && this.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return { branches: cached.branches, fetchedAt: cached.fetchedAt, error: null }
    try {
      const viewer = (await this.viewerLogin()).toLowerCase()
      const cutoff = this.now() - sinceDays * 24 * 60 * 60_000
      const branches = []
      let after = null
      for (let page = 0; page < MAX_REF_PAGES; page += 1) {
        const { repository } = await this.graphql(REFS_QUERY, { owner: target.owner, name: target.repo, after })
        const defaultBranch = repository.defaultBranchRef?.name ?? null
        for (const node of repository.refs.nodes) {
          const commit = node.target ?? {}
          const mine = [commit.author?.user?.login, commit.committer?.user?.login].some((login) => typeof login === 'string' && login.toLowerCase() === viewer)
          if (!mine || node.name === defaultBranch || BASE_BRANCH.test(node.name)) continue
          if ((node.associatedPullRequests?.totalCount ?? 0) > 0) continue
          if (!(Date.parse(commit.committedDate) >= cutoff)) continue
          branches.push({
            name: node.name,
            committedDate: commit.committedDate,
            headline: commit.messageHeadline ?? '',
            oid: commit.oid ?? null,
            url: `https://github.com/${target.owner}/${target.repo}/pull/new/${node.name.split('/').map(encodeURIComponent).join('/')}`
          })
        }
        if (!repository.refs.pageInfo.hasNextPage) break
        after = repository.refs.pageInfo.endCursor
      }
      branches.sort((left, right) => String(right.committedDate).localeCompare(String(left.committedDate)))
      const result = branches.slice(0, MAX_BRANCHES_PER_REPO)
      const fetchedAt = this.now()
      writeJsonAtomic(this.cachePath(target, 'branches'), { branches: result, fetchedAt })
      return { branches: result, fetchedAt, error: null }
    } catch (error) {
      return { branches: cached?.branches ?? [], fetchedAt: cached?.fetchedAt ?? null, error: error.message }
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
