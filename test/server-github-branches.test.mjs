import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitHubReader } from '../server/lib/github.mjs'
import { branchCards } from '../server/lib/branches.mjs'

const NOW = Date.parse('2026-10-13T03:00:00Z')

function makeReader(exec) {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-gh-branches-'))
  let clock = NOW
  const reader = new GitHubReader({ homeDir, exec, now: () => clock, ghBinary: 'gh' })
  return { reader, advance: (ms) => { clock += ms } }
}

function refNode(name, { date = '2026-10-12T07:00:00Z', author = 'biuea3866', committer = author, prs = 0, headline = 'msg' } = {}) {
  return {
    name,
    associatedPullRequests: { totalCount: prs },
    target: {
      oid: `oid-${name}`,
      committedDate: date,
      messageHeadline: headline,
      author: { email: 'a@b.c', user: author ? { login: author } : null },
      committer: { email: 'a@b.c', user: committer ? { login: committer } : null }
    }
  }
}

function branchExec({ pages, viewer = 'biuea3866', calls = [] }) {
  return async (command, args) => {
    calls.push([command, ...args])
    const query = String(args.find((arg) => arg.startsWith('query=')) ?? '')
    if (query.includes('viewer')) return { stdout: JSON.stringify({ data: { viewer: { login: viewer } } }), stderr: '', code: 0 }
    const after = (args.find((arg) => arg.startsWith('after=')) ?? '').slice('after='.length)
    const index = after ? Number(after.replace('C', '')) : 0
    const nodes = pages[index]
    return { stdout: JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'main' }, refs: { pageInfo: { hasNextPage: index < pages.length - 1, endCursor: `C${index + 1}` }, nodes } } } }), stderr: '', code: 0 }
  }
}

const pages = [
  [
    refNode('feat/new'),
    refNode('feat/has-pr', { prs: 1 }),
    refNode('feat/others', { author: 'junney-jang' }),
    refNode('feat/old', { date: '2026-08-01T00:00:00Z' }),
    refNode('main'),
    refNode('release/20261012-x'),
    refNode('hotfix/urgent')
  ],
  [refNode('feat/second', { date: '2026-10-10T00:00:00Z', author: null, committer: 'BIUEA3866' })]
]

test('listMyBranchesWithoutPr keeps my recent branches without a PR across pages using read-only graphql only', async () => {
  const calls = []
  const { reader } = makeReader(branchExec({ pages, calls }))
  const result = await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  assert.equal(result.error, null)
  assert.deepEqual(result.branches.map((branch) => branch.name), ['feat/new', 'feat/second'], 'mine, no PR, within 30 days, newest first; base/release/hotfix and others excluded')
  assert.equal(result.branches[0].url, 'https://github.com/o/r/pull/new/feat/new')
  assert.equal(result.branches[0].headline, 'msg')
  assert.equal(result.branches[0].committedDate, '2026-10-12T07:00:00Z')
  assert.ok(calls.every(([command, first, second]) => command === 'gh' && first === 'api' && second === 'graphql'), 'only gh api graphql')
  assert.ok(calls.every((call) => !call.some((arg) => /mutation|subscription/i.test(arg))), 'no write operations')
  assert.equal(calls.filter((call) => call.some((arg) => arg.includes('viewer'))).length, 1)
  assert.ok(calls.some((call) => call.includes('after=C1')), 'second page requested with the cursor')
})

test('listMyBranchesWithoutPr caches for 5 minutes and force bypasses the cache', async () => {
  const calls = []
  const { reader, advance } = makeReader(branchExec({ pages, calls }))
  await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  const afterFirst = calls.length
  await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  assert.equal(calls.length, afterFirst, 'served from cache')
  await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' }, { force: true })
  assert.ok(calls.length > afterFirst, 'force refetches')
  const afterForce = calls.length
  advance(5 * 60_000 + 1)
  await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  assert.ok(calls.length > afterForce, 'refetched after TTL')
})

test('listMyBranchesWithoutPr reports gh failures and keeps the previous cache', async () => {
  let fail = false
  const inner = branchExec({ pages })
  const exec = async (command, args) => (fail ? { stdout: '', stderr: 'gh auth login required', code: 4 } : inner(command, args))
  const { reader, advance } = makeReader(exec)
  await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  fail = true
  advance(10 * 60_000)
  const result = await reader.listMyBranchesWithoutPr({ owner: 'o', repo: 'r' })
  assert.equal(result.branches.length, 2, 'stale cache kept')
  assert.match(result.error, /gh auth login required/)
})

test('graphql refuses anything that is not a plain read query', async () => {
  const { reader } = makeReader(async () => ({ stdout: '{}', stderr: '', code: 0 }))
  await assert.rejects(() => reader.graphql('mutation { addStar(input:{}) { clientMutationId } }', {}), /read-only/)
  await assert.rejects(() => reader.graphql('query { viewer { login } } mutation { x }', {}), /read-only/)
})

test('branchCards hides branches that already have an open PR and links a local worktree when there is one', () => {
  const branches = [
    { name: 'feat/new', committedDate: '2026-10-12T07:00:00Z', headline: 'h', url: 'u1' },
    { name: 'feat/just-opened', committedDate: '2026-10-12T06:00:00Z', headline: 'h', url: 'u2' }
  ]
  const prs = [{ number: 9, headRefName: 'feat/just-opened' }]
  const worktrees = [{ id: 'r1::/wt/new', repoId: 'r1', path: '/wt/new', branch: 'feat/new' }, { id: 'r2::/wt/other', repoId: 'r2', path: '/wt/other', branch: 'feat/just-opened' }]
  const cards = branchCards({ repoId: 'r1', branches, prs, worktrees })
  assert.deepEqual(cards.map((card) => card.name), ['feat/new'], 'a PR opened after the branch list was cached hides the branch')
  assert.equal(cards[0].worktreePath, '/wt/new')
  assert.equal(branchCards({ repoId: 'r1', branches: [branches[0]], prs: [], worktrees: [] })[0].worktreePath, null, 'no local worktree registered in Orca')
})
