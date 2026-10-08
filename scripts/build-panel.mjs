#!/usr/bin/env node
// Writes the baseline panel/index.html (no server data) so the plugin validates
// before the server has ever run. The server overwrites it at runtime.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPanelDocument } from '../server/lib/panel-document.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modules = {
  selection: readFileSync(join(root, 'ui', 'lib', 'selection.mjs'), 'utf8'),
  threads: readFileSync(join(root, 'ui', 'lib', 'threads.mjs'), 'utf8')
}
const data = { schemaVersion: 1, generatedAt: null, reason: 'baseline', server: null, launcher: null, agents: {}, worktrees: [], sessions: {}, sessionList: [], runs: {}, overview: { repos: [], github: { enabled: false, lastFetchedAt: null, errors: [] } }, viewState: {} }
writeFileSync(join(root, 'panel.html'), buildPanelDocument({ template: readFileSync(join(root, 'panel', 'template.html'), 'utf8'), data, modules }))
console.log('panel.html written (baseline)')
