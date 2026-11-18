// AI run management: spawn claude/codex headless in the session worktree,
// persist AIRun metadata, cap logs, cancel via process group.

import {StringDecoder} from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { ApiError, makeId, writeJsonAtomic } from './store.mjs'

export const LOG_CAP_BYTES = 10 * 1024 * 1024
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])

// Headless CLI runs must use the saved local login, not credentials inherited from the host app.
export function localCliEnvironment(parent, overrides = {}) {
  const env = { ...parent, ...overrides }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name]
  env.LLM_ROUTER_BYPASS = '1'
  return env
}

export function defaultAgentCommands(resolveBin) {
  return {
    claude: {
      command: resolveBin('claude'),localCLI:true,
      args: ['-p', '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'LS'],
      // "AI 답변": read-only. Nothing that edits or runs commands is allowed, and the default permission mode cannot prompt in -p.
      answerArgs: ['-p', '--output-format', 'text', '--permission-mode', 'default', '--allowedTools', 'Read', 'Grep', 'Glob', 'LS', '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      env: {}
    },
    codex: {
      command: resolveBin('codex'),localCLI:true,
      args: (cwd) => ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd, '-'],
      answerArgs: (cwd) => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, '-'],
      env: {}
    }
  }
}

/** Fingerprints every dirty/untracked path so edits to already-dirty files are detected after a run. */
export function fingerprintPaths(cwd, paths) {
  const fingerprints = {}
  for (const relativePath of paths.slice(0, 5000)) {
    const absolute = join(cwd, relativePath)
    try {
      if (!existsSync(absolute) || statSync(absolute).isDirectory()) { fingerprints[relativePath] = 'missing'; continue }
      fingerprints[relativePath] = createHash('sha1').update(readFileSync(absolute)).digest('hex')
    } catch {
      fingerprints[relativePath] = 'unreadable'
    }
  }
  return fingerprints
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Removes changed paths that are files the server writes itself (e.g. the generated panel document). */
export function filterIgnoredChanges(changedFiles, cwd, ignoreAbsolutePaths = []) {
  const ignored = new Set(ignoreAbsolutePaths.map((path) => resolve(path)))
  return changedFiles.filter((relativePath) => !ignored.has(resolve(cwd, relativePath)))
}

/** The run worth showing: a live one, else the newest that changed files, else the newest. */
export function pickRunToShow(runs) {
  if (!runs.length) return null
  const sorted = [...runs].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
  return sorted.find((run) => run.status === 'running' || run.status === 'queued')
    ?? sorted.find((run) => (run.changedFiles || []).length > 0)
    ?? sorted[0]
}

export class RunManager {
  constructor({ homeDir, agentCommands, git, now = () => new Date().toISOString(), onFinished = () => {}, onOutput = () => {}, ignoreChangedPaths = [], orphanPollMs = 1000, claimStaleMs = 10 * 60_000 }) {
    this.orphanPollMs = orphanPollMs
    this.claimStaleMs = claimStaleMs
    this.watchers = new Map()
    this.ignoreChangedPaths = ignoreChangedPaths
    this.runsDir = join(homeDir, 'runs')
    this.agentCommands = agentCommands
    this.git = git
    this.now = now
    this.onFinished = onFinished
    this.onOutput = onOutput
    this.children = new Map()
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 })
    this.recover()
  }

  runDir(runId) {
    if (!/^run_[0-9a-f]{12}$/.test(runId)) throw new ApiError(404, 'run_not_found', `run ${runId} not found`)
    return join(this.runsDir, runId)
  }

  metaPath(runId) { return join(this.runDir(runId), 'meta.json') }

  get(runId) {
    const path = this.metaPath(runId)
    if (!existsSync(path)) throw new ApiError(404, 'run_not_found', `run ${runId} not found`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  save(run) {
    writeJsonAtomic(this.metaPath(run.id), run)
    return run
  }

  changesPath(runId) { return join(this.runDir(runId), 'changes.json') }

  /** Keeps what a run changed (parsed diff) next to its record: the working tree forgets it once the change is committed. */
  saveChanges(runId, files) {
    writeJsonAtomic(this.changesPath(runId), files)
  }

  readChanges(runId) {
    try {
      const path = this.changesPath(runId)
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    } catch {
      return null
    }
  }

  list() {
    const runs = []
    for (const entry of readdirSync(this.runsDir)) {
      try { runs.push(this.get(entry)) } catch { /* skip */ }
    }
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  recover() {
    for (const run of this.list()) {
      if(run.committing){run.committing=false;run.commitError={message:'Server stopped during commit. Inspect Git history before retrying.'};this.save(run)}
    }
  }

  /**
   * Runs the previous server process started: the agent is detached, so it keeps working after the server goes away
   * (update, crash, idle exit), but the handle that records its end is gone. Without this the run stays `running`
   * forever while the agent edits files, no reply is posted and the comment looks ignored.
   * An agent that is gone is finished now; one still alive is watched and finished when it exits.
   * A run another live server process still owns is left to that process.
   */
  async adoptOrphans() {
    for (const run of this.list()) {
      try {
        if (!this.needsFinish(run) || this.children.has(run.id) || this.watchers.has(run.id) || this.ownedByOtherServer(run)) continue
        const cancelledUnfinished = run.status === 'cancelled'
        if (!cancelledUnfinished && pidAlive(run.pid)) { this.watch(run); continue }
        await this.finishOrphan(run.id)
      } catch { /* one broken record must not keep the server from starting */ }
    }
  }

  /** Still `running`/`queued`, or cancelled by a version that records who finished it but never finished. */
  needsFinish(run) {
    if (run.status === 'running' || run.status === 'queued') return true
    return run.status === 'cancelled' && Boolean(run.serverPid) && !run.finalized
  }

  ownedByOtherServer(run) {
    return Boolean(run.serverPid) && run.serverPid !== process.pid && pidAlive(run.serverPid)
  }

  claimPath(runId) { return join(this.runDir(runId), 'finish.claim') }

  /**
   * Whoever creates the claim file finishes the run; any other process that gets here later does nothing.
   * The claim records its owner: one left by a process that died before saving (or that is older than any finish can
   * take) is abandoned and is taken over, otherwise the run would stay `running` forever.
   */
  claimFinish(runId) {
    const path = this.claimPath(runId)
    const create = () => { const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })) } finally { closeSync(fd) } }
    try { create(); return true } catch (error) { if (error.code !== 'EEXIST') return true }
    if (!this.claimIsStale(path)) return false
    // Moving the stale file aside is atomic: of several processes stealing it, one wins and the others find nothing to move.
    const aside = `${path}.stale.${process.pid}.${Date.now()}`
    try { renameSync(path, aside) } catch { return false }
    try { rmSync(aside, { force: true }) } catch { /* leave it */ }
    try { create(); return true } catch (error) { return error.code !== 'EEXIST' }
  }

  claimIsStale(path) {
    let owner = null, writtenAt
    try { owner = JSON.parse(readFileSync(path, 'utf8')) } catch { /* no readable owner: judged by age only */ }
    try { writtenAt = owner?.at ?? statSync(path).mtimeMs } catch { return false }
    if (Date.now() - writtenAt > this.claimStaleMs) return true
    return Boolean(owner?.pid) && !pidAlive(owner.pid)
  }

  releaseClaim(runId) {
    try { rmSync(this.claimPath(runId), { force: true }) } catch { /* nothing to release */ }
  }

  watch(run) {
    const latest = this.get(run.id)
    latest.serverPid = process.pid // this process answers for the run from now on
    this.save(latest)
    const timer = setInterval(() => {
      let current
      try { current = this.get(run.id) } catch { clearInterval(timer); this.watchers.delete(run.id); return }
      if (!this.needsFinish(current)) { clearInterval(timer); this.watchers.delete(run.id); return }
      if (pidAlive(current.pid)) return // a fallback agent may have replaced the one first seen
      clearInterval(timer); this.watchers.delete(run.id)
      this.finishOrphan(run.id).catch(() => {})
    }, this.orphanPollMs)
    timer.unref?.()
    this.watchers.set(run.id, timer)
  }

  stopWatching() {
    for (const timer of this.watchers.values()) clearInterval(timer)
    this.watchers.clear()
  }

  /** The agent is gone; the exit code is not known, so a completion report in the log is what tells a finished run from a cut-off one. */
  isComplete(run, log) {
    const nonce = String(run.nonce || '').replace(/[^a-zA-Z0-9]/g, '')
    const ids = run.threadIds ?? []
    if (!ids.length) return false // a repair run has no thread report to verify
    if (run.mode === 'answer') {
      const ends = log.split(`@@END:${nonce}@@`).length - 1
      return Boolean(nonce) && ids.every((id) => log.includes(`@@ANSWER:${id}:${nonce}@@`)) && ends >= ids.length
    }
    return ids.every((id) => new RegExp(`^-\\s+${id}:\\s*(?:수행|미수행)`, 'mu').test(log))
  }

  async finishOrphan(runId) {
    let latest = this.get(runId)
    if (!this.needsFinish(latest) || this.ownedByOtherServer(latest)) return
    if (latest.status !== 'cancelled' && pidAlive(latest.pid)) return // still being worked on (a fallback agent, or a slow exit)
    if (!this.claimFinish(runId)) return // another process is finishing it
    try {
      latest = this.get(runId)
      const cancelled = latest.status === 'cancelled'
      latest.status = cancelled ? 'cancelled' : this.isComplete(latest, this.readLog(runId, 0).log) ? 'succeeded' : 'interrupted'
      latest.exitCode = null
      latest.endedAt = latest.endedAt ?? this.now()
      latest.recoveredAfterRestart = true
      latest.changedFiles = await this.collectChangedFiles(latest)
      if (this.get(runId).status === 'cancelled') latest.status = 'cancelled' // cancelled while the changes were being collected
      latest.finalized = true
      latest.serverPid = process.pid
      if (latest.autoCommit) { latest.autoCommit = false; latest.autoCommitSkipped = 'the server restarted during the run, so the end of the run was not verified' }
      this.save(latest)
    } catch (error) {
      this.releaseClaim(runId) // nothing was recorded: a later start may try again
      throw error
    }
    try { await this.onFinished(latest) } catch { /* ignore */ }
  }

  runningFor(cwd) {
    return this.list().find((run) => run.cwd === cwd && (run.committing || ((run.status === 'running' || run.status === 'queued') && (this.children.has(run.id) || pidAlive(run.pid))))) ?? null
  }

  availability() {
    const report = {}
    for (const [name, spec] of Object.entries(this.agentCommands)) {
      report[name] = { available: Boolean(spec?.command) && existsSync(spec.command), path: spec?.command ?? null, execution:'local-cli', ...(name==='claude'?{fallback:'codex',fallbackAvailable:Boolean(this.agentCommands.codex?.command)&&existsSync(this.agentCommands.codex.command)}:{}) }
    }
    return report
  }

  async start({ session, threadIds, agent, prompt, mode = 'fix', nonce = null, meta = {} }) {
    const requestedAgent=agent
    let spec = this.agentCommands[agent]
    if(agent==='claude'&&(!spec?.command||!existsSync(spec.command))&&this.agentCommands.codex?.command&&existsSync(this.agentCommands.codex.command)){agent='codex';spec=this.agentCommands.codex}
    if (!spec?.command || !existsSync(spec.command)) throw new ApiError(400, 'agent_unavailable', `${agent} CLI is not installed or not found on PATH`)
    // An answer run must never fall back to the edit command line: without a read-only one it is refused.
    if (mode === 'answer' && !spec.answerArgs) throw new ApiError(400, 'answer_unsupported', `${agent} has no read-only answer command configured`)
    const existing = this.runningFor(session.repoPath)
    if (existing) throw new ApiError(409, 'run_in_progress', `a run is already in progress for this worktree`, { runId: existing.id })

    const run = {
      ...meta,
      schemaVersion: 1,
      id: makeId('run'),
      serverPid: process.pid,
      sessionId: session.id,
      agent,
      requestedAgent,
      ...(requestedAgent!==agent?{fallbackFrom:requestedAgent,fallbackReason:'Claude CLI unavailable'}:{}),
      mode,
      nonce,
      threadIds,
      cwd: session.repoPath,
      pid: null,
      status: 'queued',
      exitCode: null,
      startedAt: this.now(),
      endedAt: null,
      changedFiles: [],
      fingerprintsBefore: {}
    }
    mkdirSync(this.runDir(run.id), { recursive: true, mode: 0o700 })
    writeFileSync(join(this.runDir(run.id), 'prompt.md'), prompt, { mode: 0o600 })
    const dirtyBefore = await this.git.porcelainStatus(session.repoPath).catch(() => [])
    run.fingerprintsBefore = fingerprintPaths(session.repoPath, dirtyBefore)
    if(run.autoCommit){run.headBefore=(await this.git.run(session.repoPath,['rev-parse','HEAD'])).stdout.trim();run.branchBefore=await this.git.currentBranch(session.repoPath);if(run.branchBefore!==session.branch)throw new ApiError(409,'branch_mismatch','The review branch changed before the AI fix. Reopen Self Review.')}
    this.save(run)

    const logPath = join(this.runDir(run.id), 'output.log')
    const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    let written = 0, questionWindow = ''
    const decoder = new StringDecoder('utf8')
    const append = (chunk) => {
      if (written >= LOG_CAP_BYTES) return
      const slice = chunk.length + written > LOG_CAP_BYTES ? chunk.subarray(0, LOG_CAP_BYTES - written) : chunk
      written += slice.length
      logStream.write(slice)
      if (mode === 'fix') {
        questionWindow += decoder.write(slice)
        try { this.onOutput(run, questionWindow) } catch { logStream.write('\nAI 질문 코멘트를 저장하지 못했습니다. 실행 로그를 확인하세요.\n') }
        questionWindow = questionWindow.slice(-20000)
      }
    }


    const launch=async(attempt)=>{
    const spec=this.agentCommands[attempt],argSource=mode==='answer'?spec.answerArgs:spec.args,args=typeof argSource==='function'?argSource(session.repoPath):argSource
    run.agent=attempt;run.status='running';run.endedAt=null;run.exitCode=null
    let child
    try {
      child = spawn(spec.command, args, {
        cwd: session.repoPath,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: localCliEnvironment(process.env, spec.env)
      })
    } catch (error) {
      run.status = 'failed'
      run.endedAt = this.now()
      append(Buffer.from(`spawn failed: ${error.message}\n`))
      logStream.end()
      return this.save(run)
    }
    run.pid = child.pid ?? null
    run.status = 'running'
    this.save(run)
    this.children.set(run.id, child)
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => append(Buffer.from(`process error: ${error.message}\n`)))
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    child.on('close', async (code, signal) => {
      const latest = this.get(run.id)
      if (latest.status !== 'cancelled') {
        latest.status = code === 0 ? 'succeeded' : 'failed'
        if (signal && latest.status === 'failed') latest.status = 'cancelled'
      }
      latest.exitCode = code
      latest.endedAt = this.now()
      latest.changedFiles = await this.collectChangedFiles(latest)
      if(this.get(run.id).status==='cancelled')latest.status='cancelled'
      const fallback=this.agentCommands.codex
      if(latest.status==='failed'&&latest.agent==='claude'&&requestedAgent==='claude'&&latest.changedFiles.length===0&&fallback?.command&&existsSync(fallback.command)&&(mode!=='answer'||fallback.answerArgs)){
        latest.fallbackFrom='claude';latest.fallbackReason=`Claude exited with code ${code} before changing files`;latest.status='running';latest.agent='codex';latest.endedAt=null;this.save(latest);Object.assign(run,latest);append(Buffer.from('\n[Local Self Review] Claude 실행 실패 — 로컬 Codex로 전환합니다.\n'));await launch('codex');return
      }
      logStream.end()
      // A process that took this run over after we seemed to be gone may already have finished it.
      if(!this.claimFinish(run.id)){this.children.delete(run.id);return}
      latest.finalized=true
      if(latest.autoCommit&&latest.status==='succeeded'){latest.fingerprintsAfter=fingerprintPaths(latest.cwd,latest.changedFiles);latest.committing=true}
      this.save(latest)
      try { await this.onFinished(latest) } catch { /* ignore */ }
      finally{this.children.delete(run.id);const done=this.get(run.id);if(done.committing){done.committing=false;this.save(done)}}
    })
    }
    await launch(agent)
    return run
  }

  async collectChangedFiles(run) {
    try {
      const before = run.fingerprintsBefore ?? {}
      const dirtyAfter = await this.git.porcelainStatus(run.cwd)
      const after = fingerprintPaths(run.cwd, [...new Set([...dirtyAfter, ...Object.keys(before)])])
      const changed = Object.keys(after).filter((path) => before[path] !== after[path])
      return filterIgnoredChanges(changed, run.cwd, this.ignoreChangedPaths).sort()
    } catch {
      return []
    }
  }

  readLog(runId, from = 0) {
    const logPath = join(this.runDir(runId), 'output.log')
    if (!existsSync(logPath)) return { log: '', next: 0 }
    const size = statSync(logPath).size
    const start = Math.min(Math.max(0, from), size)
    const length = size - start
    if (length === 0) return { log: '', next: size }
    const descriptor = openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(descriptor, buffer, 0, length, start)
      return { log: buffer.toString('utf8'), next: size }
    } finally {
      closeSync(descriptor)
    }
  }

  cancel(runId) {
    const run = this.get(runId)
    if (TERMINAL_STATES.has(run.status)) return run
    run.status = 'cancelled'
    run.endedAt = this.now()
    this.save(run)
    const pid = run.pid
    if (pid) {
      const signalGroup = (signal) => { try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch { /* gone */ } } }
      signalGroup('SIGTERM')
      setTimeout(() => { if (pidAlive(pid)) signalGroup('SIGKILL') }, 5000).unref()
    }
    return run
  }

  hasRunning() {
    return this.list().some((run) => run.committing || run.status === 'running' || run.status === 'queued')
  }
}
