import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPanelHost } from '../ui/lib/host.mjs'
import { registerPanelRequests } from '../worker/panel-requests.mjs'

test('panel uses the public Orca host and worker request API', async () => {
  const calls = []
  const host = createPanelHost({ host: { call: async (method, params) => {
    calls.push({ method, params })
    return method === 'plugin.request' ? { output: { schemaVersion: 1 } } : { branch: 'main' }
  } } })
  assert.deepEqual(await host.snapshot(), { schemaVersion: 1 })
  await host.send({ op: 'overview.refresh' })
  assert.deepEqual(await host.call('workspace.readContext', {}), { branch: 'main' })
  assert.deepEqual(calls.slice(0, 2), [
    { method: 'plugin.request', params: { name: 'review.snapshot' } },
    { method: 'plugin.request', params: { name: 'review.op', input: { op: 'overview.refresh' } } }
  ])
})

test('worker starts server on first snapshot, authenticates and returns only panel data', async () => {
  const handlers = new Map()
  const calls = []
  registerPanelRequests({ panels: { handle: (name, fn) => handlers.set(name, fn) } }, {
    ensureRuntime: async () => { calls.push('start'); return { port: 1234, token: 'private' } },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:1234/panel-preview')
      assert.equal(options.headers['X-SR-Token'], 'private')
      return { ok: true, text: async () => '<meta name="sr-token" content="private"><script type="application/json" id="orca-panel-data">{"schemaVersion":1,"worktrees":[{"path":"/repo"}]}</script>' }
    },
    sendOp: async (runtime, op) => { calls.push(op); return { ok: true } }
  })
  assert.deepEqual(await handlers.get('review.snapshot')(), { schemaVersion: 1, worktrees: [{ path: '/repo' }] })
  assert.deepEqual(await handlers.get('review.op')({ op: 'overview.refresh' }), { ok: true })
  assert.deepEqual(calls, ['start', 'start', { op: 'overview.refresh' }])
})

test('worker reports failed and malformed snapshots instead of showing empty results', async () => {
  const handlers = new Map()
  let response = { ok: false, status: 503 }
  registerPanelRequests({ panels: { handle: (name, fn) => handlers.set(name, fn) } }, {
    ensureRuntime: async () => ({ port: 1234, token: 'private' }),
    fetchImpl: async () => response,
    sendOp: async () => {}
  })
  await assert.rejects(handlers.get('review.snapshot')(), /503/)
  response = { ok: true, text: async () => '<html></html>' }
  await assert.rejects(handlers.get('review.snapshot')(), /panel data/)
})

test('panel aliases all used theme colors to public Orca tokens with standalone fallbacks', () => {
  const template = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')
  const css = template.match(/<style>([\s\S]*?)<\/style>/)[1]
  const tokens = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]).filter(t => !t.startsWith('--sr-') && !t.startsWith('--orca-')))
  for (const token of tokens) assert.match(css, new RegExp(`${token}:\\s*var\\(--orca-${token.slice(2)},\\s*[^)]+\\)`))
  assert.match(template, /await PANEL_HOST.snapshot\(\)/)
  assert.match(template, /서버에 연결/)
})

test('modern panels allow comments without a terminal bridge and hide its setup notice', () => {
  const template = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')
  assert.match(template, /const canComment = Boolean\(PREVIEW \|\| PANEL_HOST \|\| bridgeTerminalId\(\)\)/)
  assert.match(template, /function bridgeStatusHtml\(\) \{\s*if \(PREVIEW \|\| PANEL_HOST\) return ''/)
})

test('an isolated Orca guest is not mistaken for the standalone preview', () => {
  const template = readFileSync(new URL('../panel/template.html', import.meta.url), 'utf8')
  assert.match(template, /const PREVIEW = !window\.orca && window\.parent === window/)
})
