import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelDocument, inlineModules, panelIdentity, PANEL_DATA_ID } from '../server/lib/panel-document.mjs'

const modules = { selection: 'const SELECTION_MODULE = true' }
const template = '<!doctype html><html><head><style>body{}</style></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script><script>/*__INLINE:selection__*/\nstart()</script></body></html>'

test('buildPanelDocument embeds exactly one data block and escapes script-breaking characters', () => {
  const html = buildPanelDocument({ template, data: { text: '</script><b>', line: '\u2028x' }, modules })
  const blocks = html.match(new RegExp(`<script type="application/json" id="${PANEL_DATA_ID}">`, 'g'))
  assert.equal(blocks.length, 1)
  assert.doesNotMatch(html, /<\/script><b>/)
  assert.match(html, /\\u003c\/script\\u003e|\\u003c\/script>/)
  assert.doesNotMatch(html, /\u2028/)
  const payload = /<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/.exec(html)[1]
  assert.deepEqual(JSON.parse(payload), { text: '</script><b>', line: '\u2028x' })
})

test('panelIdentity is stable across different data so the patched host can keep the iframe', () => {
  const first = buildPanelDocument({ template, data: { a: 1 }, modules })
  const second = buildPanelDocument({ template, data: { a: 2, big: 'x'.repeat(1000) }, modules })
  assert.notEqual(first, second)
  assert.equal(panelIdentity(first), panelIdentity(second))
})

test('inlineModules strips export keywords and inlines module sources into placeholders', () => {
  const source = "export const MAX = 3\nexport function f() { return MAX }\nexport default f\n"
  const html = inlineModules('<script>/*__INLINE:sel__*/\nf()</script>', { sel: source })
  assert.match(html, /const MAX = 3/)
  assert.match(html, /function f\(\)/)
  assert.doesNotMatch(html, /export /)
  assert.doesNotMatch(html, /__INLINE:sel__/)
})

test('buildPanelDocument throws when the template has no data placeholder', () => {
  assert.throws(() => buildPanelDocument({ template: '<html></html>', data: {}, modules: {} }), /placeholder/)
})

test('buildPanelDocument does not expand replacement patterns like $& or $\' found in the data', () => {
  const data = { text: "a $& b $' c $` d $1 ${x}" }
  const html = buildPanelDocument({ template, data, modules })
  const payload = /<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/.exec(html)[1]
  assert.deepEqual(JSON.parse(payload), data)
  assert.equal((html.match(/<\/script>/g) || []).length, 2)
})
