import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PanelPublisher } from '../server/lib/panel-publisher.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(root, 'panel', 'template.html'), 'utf8')

// The panel runs in a srcdoc iframe with sandbox="allow-scripts" (no allow-modals): confirm/alert/prompt do nothing
// there, and confirm() silently returns false. A delete button gated on confirm() therefore never deletes.
test('the panel never calls modal dialogs the sandbox swallows', () => {
  const calls = [...template.matchAll(/(?<![\w.$])(?:window\.)?(confirm|alert|prompt)\s*\(/g)].map((match) => match[1])
  assert.deepEqual(calls, [], 'use the inline armConfirm helper instead of window dialogs')
})

test('every inline module the template asks for is read by the publisher', () => {
  const wanted = [...template.matchAll(/\/\*__INLINE:([a-zA-Z0-9_-]+)__\*\//g)].map((match) => match[1])
  assert.ok(wanted.includes('confirm'), 'the template inlines the confirm helper')
  const publisher = new PanelPublisher({ pluginRoot: root, outputRoot: mkdtempSync(join(tmpdir(), 'sr-sandbox-')), debounceMs: 0, collect: async () => ({}), log: () => {} })
  const available = Object.keys(publisher.readModules())
  for (const name of wanted) assert.ok(available.includes(name), `publisher must read ui/lib/${name}.mjs`)
})
