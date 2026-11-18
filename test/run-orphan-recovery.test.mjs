import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { RunManager } from '../server/lib/runs.mjs'
import { GitReader } from '../server/lib/git.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const REPORT = '@@FIX:cmt_000000000001:abc123@@\n반영했습니다\n@@END:abc123@@\n- thr_000000000001: 수행 — ok\n'

// A run the previous server process left behind: the agent was started by it, so this process holds no handle to it.
function orphan({ pid, log = REPORT, status = 'running', edit = true } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-orphan-repo-')))
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.js'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-orphan-home-'))
  const id = 'run_0123456789ab', dir = join(homeDir, 'runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, id, sessionId: 'ses_000000000001', agent: 'claude', mode: 'fix', nonce: 'abc123', threadIds: ['thr_000000000001'], cwd: repo, pid, status, exitCode: null, startedAt: '2026-11-18T00:00:00.000Z', endedAt: null, changedFiles: [], fingerprintsBefore: {}, autoCommit: true }))
  writeFileSync(join(dir, 'output.log'), log)
  if (edit) writeFileSync(join(repo, 'a.js'), 'a\nedited by the agent\n')
  return { repo, homeDir, id }
}
const manager = (homeDir, finished, orphanPollMs = 40) => new RunManager({ homeDir, agentCommands: {}, git: new GitReader({ exec: execCommand, gitBinary: 'git' }), onFinished: async (run) => { finished.push(run) }, orphanPollMs })

test('a run whose agent died with the old server process is finished with what it left behind', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000 }) // no such process
  const finished = []
  const runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 1)
  const run = runs.get(id)
  assert.equal(run.status, 'succeeded', 'its log carries a completion report')
  assert.equal(run.recoveredAfterRestart, true)
  assert.deepEqual(run.changedFiles, ['a.js'], 'the edit the agent made is recorded')
  assert.ok(run.endedAt)
  assert.equal(run.autoCommit, false, 'nothing is committed on the strength of an unverified exit')
})

test('a run whose log has no completion report is interrupted, not succeeded', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, log: 'working on it…\n' })
  const finished = []
  const runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(runs.get(id).status, 'interrupted')
  assert.equal(finished.length, 1, 'the reply comments are still produced')
})

test('a run whose agent is still alive is watched and finished when the agent exits', async () => {
  const agent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},700)'], { detached: true, stdio: 'ignore' })
  agent.unref()
  const { homeDir, id } = orphan({ pid: agent.pid })
  const finished = []
  const runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 0, 'still running: nothing is finished early')
  assert.equal(runs.get(id).status, 'running')
  for (let attempt = 0; attempt < 100 && !finished.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(finished.length, 1)
  assert.equal(runs.get(id).status, 'succeeded')
  assert.equal(finished.length, 1, 'finished exactly once')
})

test('runs that already ended, were cancelled or belong to this process are left alone', async () => {
  const done = orphan({ pid: 2_000_000_000, status: 'cancelled' })
  const finished = []
  const runs = manager(done.homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 0)
  assert.equal(runs.get(done.id).status, 'cancelled')
})
