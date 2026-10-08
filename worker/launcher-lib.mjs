// Shared by the plugin worker (worker/main.mjs) and the terminal launcher
// (worker/launcher-cli.mjs). Zero dependencies. Everything that touches the
// outside world (fetch, spawn, exec, sleep, clock) is injectable for tests.

import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PREFERRED_PORT = 47811
export const PROTOCOL_VERSION = 1

const ORCA_BINARY_CANDIDATES = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  'orca'
]

export function defaultHomeDir(env = process.env) {
  if (env.ORCA_SELF_REVIEW_HOME) return env.ORCA_SELF_REVIEW_HOME
  return join(env.HOME ?? homedir(), 'Library', 'Application Support', 'OrcaLocalSelfReview')
}

export function pluginRootFromModuleUrl(moduleUrl) {
  // worker/<file>.mjs → plugin root is one directory up
  return dirname(dirname(fileURLToPath(moduleUrl)))
}

export function runtimeFilePath(homeDir) {
  return join(homeDir, 'runtime', 'server.json')
}

export function readRuntime(homeDir) {
  const filePath = runtimeFilePath(homeDir)
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

async function isHealthy(runtime, fetchImpl) {
  if (!runtime) return false
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true && body?.protocolVersion === PROTOCOL_VERSION
  } catch {
    return false
  }
}

function defaultExecPath(env = process.env) {
  // Inside the Orca worker process.execPath is Electron; ELECTRON_RUN_AS_NODE
  // makes it behave like node. Outside (launcher via system node) it is node.
  return process.execPath
}

export function resolveOrcaBinary(env = process.env) {
  for (const candidate of ORCA_BINARY_CANDIDATES) {
    if (candidate.includes('/') ? existsSync(candidate) : true) return candidate
  }
  return 'orca'
}

/**
 * Make sure a healthy server is running. Reuses the recorded one when its
 * /health answers; otherwise spawns `serverEntry` detached and waits until the
 * server rewrites runtime/server.json and answers /health.
 */
export async function ensureServer({
  homeDir,
  serverEntry,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = () => Date.now(),
  timeoutMs = 8000,
  env = process.env,
  nodeBinary = defaultExecPath(env)
}) {
  const existing = readRuntime(homeDir)
  if (await isHealthy(existing, fetchImpl)) return existing

  mkdirSync(join(homeDir, 'runtime'), { recursive: true, mode: 0o700 })
  const child = spawnImpl(nodeBinary, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    cwd: homeDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', ORCA_SELF_REVIEW_HOME: homeDir }
  })
  child.unref?.()

  const startedAt = nowImpl()
  const stalePid = existing?.pid ?? null
  while (nowImpl() - startedAt < timeoutMs) {
    const runtime = readRuntime(homeDir)
    const isFresh = runtime && runtime.pid !== stalePid
    if (isFresh && (await isHealthy(runtime, fetchImpl))) return runtime
    await sleepImpl(150)
  }
  throw new Error(`Local Self Review server did not become healthy within ${timeoutMs}ms (home: ${homeDir})`)
}

export function parseWorktreeCurrent(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    const worktree = parsed?.ok ? parsed.result?.worktree : null
    if (!worktree?.path) return null
    const branch = String(worktree.branch ?? '').replace(/^refs\/heads\//, '')
    return { path: worktree.path, branch, displayName: worktree.displayName ?? branch }
  } catch {
    return null
  }
}

export function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return reject(error)
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error ? (error.code ?? 1) : 0 })
    })
  })
}

export async function currentWorktreePath({ execImpl = execCommand, orcaBinary = resolveOrcaBinary(), cwd } = {}) {
  try {
    const result = await execImpl(orcaBinary, ['worktree', 'current', '--json'], cwd ? { cwd } : {})
    return parseWorktreeCurrent(result.stdout)?.path ?? null
  } catch {
    return null
  }
}

export function buildOpenUrl({ port, target, overview = false }) {
  const base = `http://127.0.0.1:${port}/`
  if (overview) return `${base}#/`
  if (target) return `${base}?target=${encodeURIComponent(target)}`
  return base
}

export async function openInOrcaTab({ url, execImpl = execCommand, orcaBinary = resolveOrcaBinary(), cwd }) {
  const result = await execImpl(orcaBinary, ['tab', 'create', '--url', url, '--json'], cwd ? { cwd } : {})
  if (result.code !== 0) throw new Error(`orca tab create failed: ${result.stderr || result.stdout}`)
  return result
}

export async function stopServer({ homeDir, fetchImpl = globalThis.fetch }) {
  const runtime = readRuntime(homeDir)
  if (!runtime) return { stopped: false, reason: 'not running' }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-SR-Token': runtime.token, Host: `127.0.0.1:${runtime.port}` },
      signal: AbortSignal.timeout(3000)
    })
    if (response.status === 409) return { stopped: false, reason: 'an AI run is still in progress' }
    return { stopped: response.ok, reason: response.ok ? null : `HTTP ${response.status}` }
  } catch (error) {
    return { stopped: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Writes `<homeDir>/bin/open-review`, a tiny POSIX shell launcher that the
 * sandboxed panel can type into a terminal. It runs worker/launcher-cli.mjs
 * with a known node binary. Idempotent.
 */
export function installLauncher({ homeDir, pluginRoot, nodeBinary = process.execPath }) {
  const binDir = join(homeDir, 'bin')
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const launcherPath = join(binDir, 'open-review')
  const cliPath = join(pluginRoot, 'worker', 'launcher-cli.mjs')
  const body = [
    '#!/bin/sh',
    '# Local Self Review launcher — generated by the Orca plugin worker. Safe to re-run.',
    `export ORCA_SELF_REVIEW_HOME=${shellQuote(homeDir)}`,
    'export ELECTRON_RUN_AS_NODE=1',
    `NODE_BIN=${shellQuote(nodeBinary)}`,
    'if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node || true)"; fi',
    'if [ -z "$NODE_BIN" ]; then echo "node not found" >&2; exit 127; fi',
    `exec "$NODE_BIN" ${shellQuote(cliPath)} "$@"`,
    ''
  ].join('\n')
  const tmpPath = `${launcherPath}.tmp`
  writeFileSync(tmpPath, body, { mode: 0o700 })
  renameSync(tmpPath, launcherPath)
  chmodSync(launcherPath, 0o700)
  return launcherPath
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function shellQuoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

async function listTerminals({ execImpl, orcaBinary, cwd }) {
  try {
    const result = await execImpl(orcaBinary, ['terminal', 'list', '--json'], cwd ? { cwd } : {})
    const parsed = JSON.parse(result.stdout)
    return parsed.ok ? parsed.result?.terminals ?? [] : []
  } catch {
    return []
  }
}

/**
 * Makes sure a live bridge terminal exists for the worktree: asks the server
 * which terminal ids are registered, checks they are still alive, otherwise
 * creates a new Orca terminal running `<launcher> --bridge`.
 */
export async function ensureBridgeTerminal({ runtime, worktreePath, launcherPath, fetchImpl = globalThis.fetch, execImpl = execCommand, orcaBinary = resolveOrcaBinary() }) {
  let registered = []
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/api/bridge/status?worktree=${encodeURIComponent(worktreePath)}`, {
      headers: { 'X-SR-Token': runtime.token }, signal: AbortSignal.timeout(3000)
    })
    const payload = await response.json()
    registered = payload?.bridges?.[worktreePath]?.terminalIds ?? []
  } catch { registered = [] }
  const terminals = await listTerminals({ execImpl, orcaBinary, cwd: worktreePath })
  const alive = terminals.find((terminal) => registered.includes(terminal.handle) || registered.includes(terminal.ptyId))
  if (alive) return { created: false, terminalHandle: alive.handle }
  const command = `${shellQuoteArg(launcherPath)} --bridge`
  const result = await execImpl(orcaBinary, ['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', 'Self Review bridge', '--command', command, '--json'], { cwd: worktreePath })
  if (result.code !== 0) throw new Error(`orca terminal create failed: ${(result.stderr || result.stdout).trim()}`)
  let handle = null
  try { handle = JSON.parse(result.stdout).result?.terminal?.handle ?? null } catch { /* ignore */ }
  return { created: true, terminalHandle: handle }
}
