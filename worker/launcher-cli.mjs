#!/usr/bin/env node
// Terminal launcher: `open-review [--overview] [--target <worktreePath>]`.
// Ensures the local server is running, then opens the review UI in the
// Orca embedded browser tab of the current worktree. Invoked by the shell
// launcher the worker installs at <home>/bin/open-review.

import { join } from 'node:path'
import {
  buildOpenUrl,
  currentWorktreePath,
  defaultHomeDir,
  ensureServer,
  installLauncher,
  openInOrcaTab,
  pluginRootFromModuleUrl
} from './launcher-lib.mjs'

function parseArgs(argv) {
  const options = { overview: false, target: null, printOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--overview') options.overview = true
    else if (argument === '--target') options.target = argv[++index] ?? null
    else if (argument === '--print-url') options.printOnly = true
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const homeDir = defaultHomeDir()
  const pluginRoot = pluginRootFromModuleUrl(import.meta.url)
  try { installLauncher({ homeDir, pluginRoot }) } catch { /* best effort: the worker installs it too */ }
  const runtime = await ensureServer({ homeDir, serverEntry: join(pluginRoot, 'server', 'main.mjs') })
  const target = options.overview ? null : (options.target ?? (await currentWorktreePath({ cwd: process.cwd() })) ?? process.cwd())
  const url = buildOpenUrl({ port: runtime.port, target, overview: options.overview })
  if (options.printOnly) {
    process.stdout.write(`${url}\n`)
    return
  }
  try {
    await openInOrcaTab({ url, cwd: process.cwd() })
    process.stdout.write(`Local Self Review opened in the Orca browser tab: ${url}\n`)
  } catch (error) {
    process.stdout.write(`Could not open an Orca browser tab (${error.message}). Open this URL manually: ${url}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
