#!/usr/bin/env node
// Terminal launcher / bridge for Local Self Review.
//   open-review                 ensure server, make sure a bridge exists, tell the user to open the panel
//   open-review --bridge        run as the panel bridge in THIS terminal (keeps running)
//   open-review --wide          open the wide UI in the Orca embedded browser tab
//   open-review --overview      wide UI, overview route
//   open-review --print-url     print the wide UI url only
// Invoked by the shell launcher the worker installs at <home>/bin/open-review.

import { join } from 'node:path'
import {
  buildOpenUrl,
  currentWorktreePath,
  defaultHomeDir,
  ensureServer,
  execCommand,
  installLauncher,
  openInOrcaTab,
  pluginRootFromModuleUrl,
  readRuntime,
  resolveOrcaBinary
} from './launcher-lib.mjs'
import { createLineBuffer, buildRegistration } from './bridge-reader.mjs'
import { parseBridgeLine, ChunkAssembler } from '../server/lib/bridge-ops.mjs'

function parseArgs(argv) {
  const options = { overview: false, wide: false, bridge: false, target: null, printOnly: false, raw: argv }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--overview') { options.overview = true; options.wide = true }
    else if (argument === '--wide') options.wide = true
    else if (argument === '--bridge') options.bridge = true
    else if (argument === '--target') options.target = argv[++index] ?? null
    else if (argument === '--print-url') options.printOnly = true
    else if (argument === '--panel-terminal' || argument === '--diag') index += 1
  }
  return options
}

async function apiCall(runtime, path, body) {
  // the server may have restarted (new port/token) since the bridge started: always use the latest runtime
  const latest = readRuntime(defaultHomeDir()) ?? runtime
  const response = await fetch(`http://127.0.0.1:${latest.port}${path}`, {
    method: 'POST',
    headers: { 'X-SR-Token': latest.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
  return payload
}

async function findPtyId(worktreePath) {
  try {
    const result = await execCommand(resolveOrcaBinary(), ['terminal', 'list', '--json'], { cwd: worktreePath })
    const parsed = JSON.parse(result.stdout)
    const terminal = (parsed.result?.terminals ?? []).find((entry) => entry.handle === process.env.ORCA_TERMINAL_HANDLE)
    return terminal?.ptyId ?? null
  } catch {
    return null
  }
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write('[2J[H')
}

async function runBridge({ runtime, worktreePath, args }) {
  const registration = buildRegistration({ env: process.env, args, worktreePath, ptyId: await findPtyId(worktreePath) })
  await apiCall(runtime, '/api/bridge/register', registration)
  let registeredPid = runtime.pid
  const assembler = new ChunkAssembler()
  let handled = 0
  let lastStatus = '대기 중'
  const render = () => {
    clearScreen()
    process.stdout.write([
      'Local Self Review — 패널 브리지 (이 터미널을 닫으면 패널에서 코멘트를 보낼 수 없습니다)',
      `worktree: ${worktreePath}`,
      `terminal: ${registration.terminalHandle ?? '?'}${registration.panelTerminalId ? ` / panel id ${registration.panelTerminalId}` : ''}`,
      `처리한 명령: ${handled} · 마지막: ${lastStatus}`,
      '종료: Ctrl+C'
    ].join('\n') + '\n')
  }
  const handle = async (line) => {
    let parsed = parseBridgeLine(line)
    if (parsed.kind === 'chunk') {
      const whole = assembler.push(parsed.chunk)
      if (!whole) return
      parsed = parseBridgeLine(whole)
    }
    if (parsed.kind === 'ignore') return
    if (parsed.kind === 'error') { lastStatus = `오류: ${parsed.error}`; render(); return }
    try {
      const live = await ensureServer({ homeDir: defaultHomeDir(), serverEntry: join(pluginRootFromModuleUrl(import.meta.url), 'server', 'main.mjs') })
      if (live.pid !== registeredPid) { await apiCall(live, '/api/bridge/register', registration); registeredPid = live.pid }
      await apiCall(live, '/api/bridge', parsed.op)
      handled += 1
      lastStatus = `${parsed.op.op} 성공 ${new Date().toLocaleTimeString()}`
    } catch (error) {
      lastStatus = `${parsed.op.op} 실패: ${error.message}`
    }
    render()
  }
  const reregister = async () => {
    const live = await ensureServer({ homeDir: defaultHomeDir(), serverEntry: join(pluginRootFromModuleUrl(import.meta.url), 'server', 'main.mjs') })
    if (live.pid !== registeredPid) { await apiCall(live, '/api/bridge/register', registration); registeredPid = live.pid; lastStatus = `서버 재기동 감지 → 재등록 ${new Date().toLocaleTimeString()}`; render() }
  }
  // Heartbeat: the server may restart (idle shutdown, upgrade) while the panel cannot reach us; re-register on our own.
  const heartbeat = setInterval(() => { reregister().catch((error) => { lastStatus = `서버 확인 실패: ${error.message}`; render() }) }, 30_000)
  heartbeat.unref?.()
  const buffer = createLineBuffer((line) => {
    // The panel's "브리지 시작" may be typed into an already-running bridge: treat it as a re-register request.
    if (line.includes('open-review') && line.includes('--bridge')) {
      const match = /--panel-terminal\s+(\S+)/.exec(line)
      if (match) registration.panelTerminalId = match[1]
      registeredPid = null
      reregister().catch((error) => { lastStatus = `재등록 실패: ${error.message}`; render() })
      return
    }
    handle(line).catch(() => {})
  }, (control) => { if (control === 'interrupt' || control === 'eof') shutdown() })
  const shutdown = () => {
    clearInterval(heartbeat)
    apiCall(runtime, '/api/bridge/unregister', { worktreePath, terminalHandle: registration.terminalHandle, panelTerminalId: registration.panelTerminalId, ptyId: registration.ptyId }).catch(() => {}).finally(() => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdout.write('\n브리지를 종료했습니다.\n')
      process.exit(0)
    })
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => buffer.push(chunk))
  process.stdin.on('end', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  render()
  await new Promise(() => {})
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const homeDir = defaultHomeDir()
  const pluginRoot = pluginRootFromModuleUrl(import.meta.url)
  try { installLauncher({ homeDir, pluginRoot }) } catch { /* best effort: the worker installs it too */ }
  const runtime = await ensureServer({ homeDir, serverEntry: join(pluginRoot, 'server', 'main.mjs') })
  const worktreePath = options.target ?? (await currentWorktreePath({ cwd: process.cwd() })) ?? process.cwd()

  if (options.bridge) return runBridge({ runtime, worktreePath, args: options.raw })

  if (options.wide || options.printOnly) {
    const url = buildOpenUrl({ port: runtime.port, target: options.overview ? null : worktreePath, overview: options.overview })
    if (options.printOnly) { process.stdout.write(`${url}\n`); return }
    try {
      await openInOrcaTab({ url, cwd: process.cwd() })
      process.stdout.write(`넓은 화면을 Orca 브라우저 탭에 열었습니다: ${url}\n`)
    } catch (error) {
      process.stdout.write(`브라우저 탭을 열지 못했습니다 (${error.message}). 직접 여세요: ${url}\n`)
    }
    return
  }

  // default: make sure this worktree has a session and tell the user where to look
  await apiCall(runtime, '/api/bridge', { op: 'session.open', worktreePath })
  process.stdout.write(`세션을 준비했습니다. 우측 사이드바의 "Self Review" 탭을 여세요. (worktree: ${worktreePath})\n`)
  process.stdout.write('패널에서 코멘트를 보내려면 브리지 터미널이 필요합니다: 이 터미널에서 `open-review --bridge` 를 실행하거나 패널의 "브리지 시작" 버튼을 쓰세요.\n')
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
