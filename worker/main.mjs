// Orca plugin worker (plugin API v0). Runs out-of-process; may be idle-reaped
// after 5 minutes, so it never hosts long-lived state itself. Its jobs: make
// sure the detached local server is up (it regenerates the right-sidebar panel
// document), make sure a bridge terminal exists for the current worktree, and
// install the terminal launcher.

import { join } from 'node:path'
import {
  buildOpenUrl,
  currentWorktreePath,
  defaultHomeDir,
  ensureBridgeTerminal,
  ensureServer,
  installLauncher,
  openInOrcaTab,
  pluginRootFromModuleUrl,
  stopServer
} from './launcher-lib.mjs'

const pluginRoot = pluginRootFromModuleUrl(import.meta.url)
const serverEntry = join(pluginRoot, 'server', 'main.mjs')

async function bridgeOp(runtime, op) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/bridge`, {
    method: 'POST',
    headers: { 'X-SR-Token': runtime.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(20_000)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
  return payload?.result
}

export default async function activate(context) {
  const { commands, host, log } = context
  const homeDir = defaultHomeDir()
  const canNotify = context.grantedCapabilities?.includes('notifications:show')
  let launcherPath = join(homeDir, 'bin', 'open-review')

  async function notify(title, body) {
    if (!canNotify) return
    try {
      await host.call('notifications.show', { title, body })
    } catch (error) {
      log(`notification failed: ${error.message}`)
    }
  }

  try {
    launcherPath = installLauncher({ homeDir, pluginRoot })
    log(`launcher installed at ${launcherPath}`)
  } catch (error) {
    log(`launcher install failed: ${error.message}`)
  }

  commands.register('open-review', async () => {
    const runtime = await ensureServer({ homeDir, serverEntry })
    const worktreePath = await currentWorktreePath()
    if (!worktreePath) {
      await notify('Local Self Review', '현재 worktree 를 찾지 못했습니다. 패널에서 worktree 를 선택하세요.')
      return { ok: false, reason: 'no current worktree' }
    }
    const session = await bridgeOp(runtime, { op: 'session.open', worktreePath })
    let bridge = { created: false, terminalHandle: null }
    try {
      bridge = await ensureBridgeTerminal({ runtime, worktreePath, launcherPath })
    } catch (error) {
      log(`bridge terminal setup failed: ${error.message}`)
    }
    await notify('Local Self Review', bridge.created ? '우측 사이드바 Self Review 탭을 여세요. 브리지 터미널을 만들었습니다.' : '우측 사이드바 Self Review 탭을 여세요.')
    return { ok: true, sessionId: session?.id ?? null, bridge }
  })

  commands.register('open-overview', async () => {
    const runtime = await ensureServer({ homeDir, serverEntry })
    await bridgeOp(runtime, { op: 'overview.refresh' })
    await notify('Local Self Review', '우측 사이드바 Self Review 탭에서 전체 PR·세션 목록을 보세요.')
    return { ok: true }
  })

  commands.register('open-wide', async () => {
    const runtime = await ensureServer({ homeDir, serverEntry })
    const target = await currentWorktreePath()
    const url = buildOpenUrl({ port: runtime.port, target, overview: !target })
    try {
      await openInOrcaTab({ url })
      return { ok: true, url }
    } catch (error) {
      await notify('Local Self Review', `브라우저 탭을 열지 못했습니다. 직접 여세요: ${url}`)
      return { ok: false, url }
    }
  })

  commands.register('stop-server', async () => {
    const result = await stopServer({ homeDir })
    await notify('Local Self Review', result.stopped ? '로컬 서버를 종료했습니다.' : `서버를 종료하지 못했습니다: ${result.reason}`)
    return result
  })
}

export async function deactivate() {
  // The server is intentionally left running: it is a detached process with
  // its own idle shutdown, and an AI run may still be in progress.
}
