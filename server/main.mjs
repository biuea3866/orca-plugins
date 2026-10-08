#!/usr/bin/env node
// Local Self Review server entry. Spawned detached by the plugin worker or the
// terminal launcher; can also be run by hand: `node server/main.mjs --foreground`.

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from './app.mjs'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const homeDir = process.env.ORCA_SELF_REVIEW_HOME || join(homedir(), 'Library', 'Application Support', 'OrcaLocalSelfReview')
const foreground = process.argv.includes('--foreground')

const server = createServer({ homeDir, pluginRoot })
const port = await server.listen()
if (foreground) process.stdout.write(`Local Self Review server listening on http://127.0.0.1:${port}/ (home: ${homeDir})\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close().finally(() => process.exit(0)) })
}
