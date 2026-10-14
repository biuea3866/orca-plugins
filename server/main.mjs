#!/usr/bin/env node
// Local Self Review server entry. Spawned detached by the plugin worker or the
// terminal launcher; can also be run by hand: `node server/main.mjs --foreground`.

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from './app.mjs'
import { findOtherHealthyServer, startRetireWatch } from './lib/singleton.mjs'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const homeDir = process.env.ORCA_SELF_REVIEW_HOME || join(homedir(), 'Library', 'Application Support', 'OrcaLocalSelfReview')
const foreground = process.argv.includes('--foreground')

const owner = await findOtherHealthyServer({ homeDir })
if (owner) {
  if (foreground) process.stdout.write(`Local Self Review server already running (pid ${owner.pid}, port ${owner.port}); exiting.\n`)
  process.exit(0)
}

const server = createServer({ homeDir, pluginRoot })
const port = await server.listen()
if (foreground) process.stdout.write(`Local Self Review server listening on http://127.0.0.1:${port}/ (home: ${homeDir})\n`)

// displaced by a newer server: stop instead of running a second bridge maintenance loop
startRetireWatch({
  homeDir,
  canRetire: () => !server.runs.hasRunning(),
  onRetire: () => { server.close().finally(() => process.exit(0)) }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close().finally(() => process.exit(0)) })
}
