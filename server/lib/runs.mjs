// AI run management: spawn claude/codex headless in the session worktree,
// persist AIRun metadata, cap logs, cancel via process group.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ApiError, makeId, writeJsonAtomic } from './store.mjs'

export const LOG_CAP_BYTES = 10 * 1024 * 1024
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])

export function defaultAgentCommands(resolveBin) {
  return {
    claude: {
      command: resolveBin('claude'),
      args: ['-p', '--output-format', 'text', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'LS'],
      env: {}
    },
    codex: {
      command: resolveBin('codex'),
      args: (cwd) => ['exec', '--full-auto', '--skip-git-repo-check', '-C', cwd, '-'],
      env: {}
    }
  }
}

/** Fingerprints every dirty/untracked path so edits to already-dirty files are detected after a run. */
function fingerprintPaths(cwd, paths) {
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

export class RunManager {
  constructor({ homeDir, agentCommands, git, now = () => new Date().toISOString(), onFinished = () => {} }) {
    this.runsDir = join(homeDir, 'runs')
    this.agentCommands = agentCommands
    this.git = git
    this.now = now
    this.onFinished = onFinished
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

  list() {
    const runs = []
    for (const entry of readdirSync(this.runsDir)) {
      try { runs.push(this.get(entry)) } catch { /* skip */ }
    }
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  recover() {
    for (const run of this.list()) {
      if ((run.status === 'running' || run.status === 'queued') && !pidAlive(run.pid)) {
        run.status = 'interrupted'
        run.endedAt = this.now()
        this.save(run)
      }
    }
  }

  runningFor(cwd) {
    return this.list().find((run) => run.cwd === cwd && (run.status === 'running' || run.status === 'queued') && (this.children.has(run.id) || pidAlive(run.pid))) ?? null
  }

  availability() {
    const report = {}
    for (const [name, spec] of Object.entries(this.agentCommands)) {
      report[name] = { available: Boolean(spec?.command) && existsSync(spec.command), path: spec?.command ?? null }
    }
    return report
  }

  async start({ session, threadIds, agent, prompt }) {
    const spec = this.agentCommands[agent]
    if (!spec?.command || !existsSync(spec.command)) throw new ApiError(400, 'agent_unavailable', `${agent} CLI is not installed or not found on PATH`)
    const existing = this.runningFor(session.repoPath)
    if (existing) throw new ApiError(409, 'run_in_progress', `a run is already in progress for this worktree`, { runId: existing.id })

    const run = {
      schemaVersion: 1,
      id: makeId('run'),
      sessionId: session.id,
      agent,
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
    this.save(run)

    const args = typeof spec.args === 'function' ? spec.args(session.repoPath) : spec.args
    const logPath = join(this.runDir(run.id), 'output.log')
    const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    let written = 0
    const append = (chunk) => {
      if (written >= LOG_CAP_BYTES) return
      const slice = chunk.length + written > LOG_CAP_BYTES ? chunk.subarray(0, LOG_CAP_BYTES - written) : chunk
      written += slice.length
      logStream.write(slice)
    }

    let child
    try {
      child = spawn(spec.command, args, {
        cwd: session.repoPath,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env ?? {}) }
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
      logStream.end()
      this.children.delete(run.id)
      const latest = this.get(run.id)
      if (latest.status !== 'cancelled') {
        latest.status = code === 0 ? 'succeeded' : 'failed'
        if (signal && latest.status === 'failed') latest.status = 'cancelled'
      }
      latest.exitCode = code
      latest.endedAt = this.now()
      latest.changedFiles = await this.collectChangedFiles(latest)
      this.save(latest)
      try { await this.onFinished(latest) } catch { /* ignore */ }
    })
    return run
  }

  async collectChangedFiles(run) {
    try {
      const before = run.fingerprintsBefore ?? {}
      const dirtyAfter = await this.git.porcelainStatus(run.cwd)
      const after = fingerprintPaths(run.cwd, [...new Set([...dirtyAfter, ...Object.keys(before)])])
      const changed = Object.keys(after).filter((path) => before[path] !== after[path])
      return changed.sort()
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
    return this.list().some((run) => run.status === 'running' || run.status === 'queued')
  }
}
