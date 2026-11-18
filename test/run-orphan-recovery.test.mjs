import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { RunManager } from '../server/lib/runs.mjs'
import { GitReader } from '../server/lib/git.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const REPORT = '@@FIX:cmt_000000000001:abc123@@\n반영했습니다\n@@END:abc123@@\n- thr_000000000001: 수행 — ok\n'

// A run the previous server process left behind: the agent was started by it, so this process holds no handle to it.
function orphan({ pid, log = REPORT, status = 'running', edit = true, meta = {} } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-orphan-repo-')))
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.js'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base')
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-orphan-home-'))
  const id = 'run_0123456789ab', dir = join(homeDir, 'runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, id, sessionId: 'ses_000000000001', agent: 'claude', mode: 'fix', nonce: 'abc123', threadIds: ['thr_000000000001'], cwd: repo, pid, status, exitCode: null, startedAt: '2026-11-18T00:00:00.000Z', endedAt: null, changedFiles: [], fingerprintsBefore: {}, autoCommit: true, ...meta }))
  writeFileSync(join(dir, 'output.log'), log)
  if (edit) writeFileSync(join(repo, 'a.js'), 'a\nedited by the agent\n')
  return { repo, homeDir, id }
}
const manager = (homeDir, finished, orphanPollMs = 40, extra = {}) => new RunManager({ homeDir, agentCommands: {}, git: new GitReader({ exec: execCommand, gitBinary: 'git' }), onFinished: async (run) => { finished.push(run) }, orphanPollMs, ...extra })

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

test('runs that already ended or were cancelled by an older version are left alone', async () => {
  for (const status of ['cancelled', 'succeeded', 'failed', 'interrupted']) {
    const done = orphan({ pid: 2_000_000_000, status })
    const finished = []
    const runs = manager(done.homeDir, finished)
    await runs.adoptOrphans()
    assert.equal(finished.length, 0, status)
    assert.equal(runs.get(done.id).status, status)
  }
})

const sleeper = (ms) => { const child = spawn(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { detached: true, stdio: 'ignore' }); child.unref(); return child }
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a run another live server process owns is not taken over', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, meta: { serverPid: process.ppid } }) // the owner is alive and is not this process
  const finished = []
  const runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 0)
  assert.equal(runs.get(id).status, 'running')
  assert.equal(runs.get(id).serverPid, process.ppid, 'ownership is left as it was')
})

test('a run whose owner process is gone is taken over and now belongs to this process', async () => {
  const agent = sleeper(500)
  const { homeDir, id } = orphan({ pid: agent.pid, meta: { serverPid: 2_000_000_000 } })
  const runs = manager(homeDir, [])
  await runs.adoptOrphans()
  assert.equal(runs.get(id).serverPid, process.pid)
  runs.stopWatching()
})

test('a queued run with no process yet is only finished when its owner is gone', async () => {
  const alive = orphan({ pid: null, status: 'queued', meta: { serverPid: process.ppid } })
  const aliveFinished = []
  await manager(alive.homeDir, aliveFinished).adoptOrphans()
  assert.equal(aliveFinished.length, 0, 'another server is still starting it')
  const dead = orphan({ pid: null, status: 'queued', log: '', meta: { serverPid: 2_000_000_000 } }) // it never started, so its log is empty
  const deadFinished = [], runs = manager(dead.homeDir, deadFinished)
  await runs.adoptOrphans()
  assert.equal(deadFinished.length, 1)
  assert.equal(runs.get(dead.id).status, 'interrupted')
})

test('cancelling a run that was taken over still finishes it so the reply and session state follow', async () => {
  const agent = sleeper(30_000)
  const { homeDir, id, repo } = orphan({ pid: agent.pid, meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  runs.cancel(id)
  for (let attempt = 0; attempt < 100 && !finished.length; attempt += 1) await later(50)
  assert.equal(finished.length, 1)
  assert.equal(runs.get(id).status, 'cancelled', 'a cancelled run is not turned into a success by the old report in its log')
  assert.deepEqual(runs.get(id).changedFiles, ['a.js'])
  assert.ok(repo)
})

test('a run cancelled just before its old server died is finished by the next one', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, status: 'cancelled', meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 1)
  assert.equal(runs.get(id).status, 'cancelled')
  assert.equal(runs.get(id).finalized, true)
  await runs.adoptOrphans()
  assert.equal(finished.length, 1, 'finalized once')
})

test('a fallback agent started under a new pid keeps the run open', async () => {
  const first = sleeper(250), second = sleeper(1200)
  const { homeDir, id } = orphan({ pid: first.pid, meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  const meta = runs.get(id); meta.pid = second.pid; runs.save(meta) // claude failed, codex took over
  await later(700)
  assert.equal(finished.length, 0, 'the first pid ended but the run is still being worked on')
  for (let attempt = 0; attempt < 120 && !finished.length; attempt += 1) await later(50)
  assert.equal(finished.length, 1)
})

test('two processes taking over the same run finish it exactly once', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  const a = [], b = []
  await Promise.all([manager(homeDir, a).adoptOrphans(), manager(homeDir, b).adoptOrphans()])
  assert.equal(a.length + b.length, 1)
  assert.equal(new RunManager({ homeDir, agentCommands: {}, git: new GitReader({ exec: execCommand, gitBinary: 'git' }) }).get(id).finalized, true)
})

test('adopting twice does not watch or finish a run twice', async () => {
  const agent = sleeper(300)
  const { homeDir } = orphan({ pid: agent.pid, meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans(); await runs.adoptOrphans()
  for (let attempt = 0; attempt < 100 && !finished.length; attempt += 1) await later(50)
  await later(300)
  assert.equal(finished.length, 1)
})

test('stopping the watchers leaves a still-running agent unfinished', async () => {
  const agent = sleeper(400)
  const { homeDir, id } = orphan({ pid: agent.pid, meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  runs.stopWatching()
  await later(900)
  assert.equal(finished.length, 0)
  assert.equal(runs.get(id).status, 'running')
})

test('only a log that reports every requested thread counts as a completed fix', async () => {
  const cases = [
    ['a bare end marker (a question block) is not a completion', '@@QUESTION:thr_000000000001:abc123@@\nwhich one?\n@@END:abc123@@\n', 'interrupted'],
    ['a result block without the thread summary line is not a completion', '@@FIX:cmt_000000000001:abc123@@\ndone\n@@END:abc123@@\n', 'interrupted'],
    ['the summary line of every requested thread is', '- thr_000000000001: 미수행 — needs input\n', 'succeeded'],
    ['a summary for another thread does not count', '- thr_ffffffffffff: 수행 — ok\n', 'interrupted']
  ]
  for (const [name, log, expected] of cases) {
    const { homeDir, id } = orphan({ pid: 2_000_000_000, log })
    const runs = manager(homeDir, [])
    await runs.adoptOrphans()
    assert.equal(runs.get(id).status, expected, name)
  }
  const repair = orphan({ pid: 2_000_000_000, log: REPORT, meta: { threadIds: [], repair: true } })
  const runs = manager(repair.homeDir, [])
  await runs.adoptOrphans()
  assert.equal(runs.get(repair.id).status, 'interrupted', 'a repair run has no thread report to verify')
})

test('an answer run is complete when every asked thread has its own answer block', async () => {
  const answered = '@@ANSWER:thr_000000000001:abc123@@\nbecause\n@@END:abc123@@\n'
  const done = orphan({ pid: 2_000_000_000, log: answered, meta: { mode: 'answer' } })
  const doneRuns = manager(done.homeDir, [])
  await doneRuns.adoptOrphans()
  assert.equal(doneRuns.get(done.id).status, 'succeeded')
  const partial = orphan({ pid: 2_000_000_000, log: answered, meta: { mode: 'answer', threadIds: ['thr_000000000001', 'thr_000000000002'] } })
  const partialRuns = manager(partial.homeDir, [])
  await partialRuns.adoptOrphans()
  assert.equal(partialRuns.get(partial.id).status, 'interrupted')
})

test('a failing finish handler does not stop the server from starting', async () => {
  const { homeDir } = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  const runs = new RunManager({ homeDir, agentCommands: {}, git: new GitReader({ exec: execCommand, gitBinary: 'git' }), onFinished: async () => { throw new Error('boom') }, orphanPollMs: 40 })
  await runs.adoptOrphans()
})

const claimPath = (homeDir, id) => join(homeDir, 'runs', id, 'finish.claim')

test('a finish claim left by a process that died before saving is taken over, not left to block the run forever', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(homeDir, id), JSON.stringify({ pid: 2_000_000_001, at: Date.now() }))
  const finished = [], runs = manager(homeDir, finished)
  await runs.adoptOrphans()
  assert.equal(finished.length, 1)
  assert.equal(runs.get(id).status, 'succeeded')
  assert.equal(runs.get(id).finalized, true)
})

test('a fresh finish claim held by a live process blocks, an old one does not', async () => {
  const live = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(live.homeDir, live.id), JSON.stringify({ pid: process.ppid, at: Date.now() }))
  const blocked = []
  await manager(live.homeDir, blocked).adoptOrphans()
  assert.equal(blocked.length, 0, 'another live process is finishing it right now')
  const old = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(old.homeDir, old.id), JSON.stringify({ pid: process.ppid, at: Date.now() - 3_600_000 }))
  const taken = []
  await manager(old.homeDir, taken).adoptOrphans()
  assert.equal(taken.length, 1, 'a claim that old is abandoned even if its pid was recycled')
})

test('a claim file without readable content is judged by its age', async () => {
  const fresh = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(fresh.homeDir, fresh.id), '')
  const none = []
  await manager(fresh.homeDir, none).adoptOrphans()
  assert.equal(none.length, 0)
  const aged = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(aged.homeDir, aged.id), '')
  const hourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(claimPath(aged.homeDir, aged.id), hourAgo, hourAgo)
  const taken = []
  await manager(aged.homeDir, taken).adoptOrphans()
  assert.equal(taken.length, 1)
})

test('when finishing fails after the claim was taken the claim is released so a later start can retry', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  const finished = [], runs = manager(homeDir, finished)
  runs.readLog = () => { throw new Error('disk trouble') }
  await runs.adoptOrphans()
  assert.equal(existsSync(claimPath(homeDir, id)), false)
  assert.equal(runs.get(id).status, 'running', 'nothing was half-recorded')
  const retry = []
  await manager(homeDir, retry).adoptOrphans()
  assert.equal(retry.length, 1)
})

test('only one of several stealers of a stale claim finishes the run', async () => {
  const { homeDir, id } = orphan({ pid: 2_000_000_000, meta: { serverPid: 2_000_000_000 } })
  writeFileSync(claimPath(homeDir, id), JSON.stringify({ pid: 2_000_000_001, at: Date.now() }))
  const lists = [[], [], []]
  await Promise.all(lists.map((list) => manager(homeDir, list).adoptOrphans()))
  assert.equal(lists.flat().length, 1)
})
