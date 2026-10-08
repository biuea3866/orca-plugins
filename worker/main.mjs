// Orca plugin worker (plugin API v0). Runs out-of-process; may be idle-reaped
// after 5 minutes, so it never hosts long-lived state itself. Its only jobs:
// make sure the detached local server is up, install the terminal launcher,
// and open the review UI in the Orca embedded browser.

import { join } from 'node:path'
import {
  buildOpenUrl,
  currentWorktreePath,
  defaultHomeDir,
  ensureServer,
  installLauncher,
  openInOrcaTab,
  pluginRootFromModuleUrl,
  stopServer
} from './launcher-lib.mjs'

const pluginRoot = pluginRootFromModuleUrl(import.meta.url)
const serverEntry = join(pluginRoot, 'server', 'main.mjs')

export default async function activate(context) {
  const { commands, host, log } = context
  const homeDir = defaultHomeDir()
  const canNotify = context.grantedCapabilities?.includes('notifications:show')

  async function notify(title, body) {
    if (!canNotify) return
    try {
      await host.call('notifications.show', { title, body })
    } catch (error) {
      log(`notification failed: ${error.message}`)
    }
  }

  try {
    const launcherPath = installLauncher({ homeDir, pluginRoot })
    log(`launcher installed at ${launcherPath}`)
  } catch (error) {
    log(`launcher install failed: ${error.message}`)
  }

  async function openUi({ overview }) {
    const runtime = await ensureServer({ homeDir, serverEntry })
    const target = overview ? null : await currentWorktreePath()
    const url = buildOpenUrl({ port: runtime.port, target, overview })
    try {
      await openInOrcaTab({ url })
      return { url, opened: true }
    } catch (error) {
      log(`orca tab create failed: ${error.message}`)
      await notify('Local Self Review', `브라우저 탭을 열지 못했습니다. 직접 여세요: ${url}`)
      return { url, opened: false }
    }
  }

  commands.register('open-review', async () => {
    const result = await openUi({ overview: false })
    if (result.opened) await notify('Local Self Review', '현재 worktree 리뷰를 열었습니다.')
    return result
  })

  commands.register('open-overview', async () => {
    const result = await openUi({ overview: true })
    if (result.opened) await notify('Local Self Review', '전체 PR·세션 목록을 열었습니다.')
    return result
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
