import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(join(root, 'panel', 'template.html'), 'utf8'))[1]

// The side panel is narrow and read for long stretches: text below these sizes was reported as too small.
const MIN_TEXT_PX = 12
const MIN_BASE_PX = 14
const MIN_CODE_PX = 13

test('no text in the panel is smaller than 12px', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]))
  assert.ok(sizes.length > 5)
  assert.deepEqual(sizes.filter((size) => size < MIN_TEXT_PX), [])
})

// Bigger text makes long repository paths wider than the narrow side panel: they must wrap instead of forcing a
// horizontal scrollbar (path buttons in the AI run card), and list rows must wrap instead of cutting text off.
test('long path buttons and list rows wrap instead of overflowing the panel', () => {
  const pathButton = /\.btn\.mono\s*\{([^}]*)\}/.exec(css)
  assert.ok(pathButton, 'a .btn.mono rule exists')
  assert.match(pathButton[1], /white-space:\s*normal/)
  assert.match(pathButton[1], /overflow-wrap:\s*anywhere/)
  assert.match(pathButton[1], /max-width:\s*100%/)
  const grow = /\.list-item \.grow\s*\{([^}]*)\}/.exec(css)
  assert.ok(grow, 'a .list-item .grow rule exists')
  assert.match(grow[1], /white-space:\s*normal/)
  assert.doesNotMatch(grow[1], /text-overflow:\s*ellipsis/, 'text is wrapped, not cut with an ellipsis')
})

test('body text is at least 14px and code in the diff at least 13px, with a line height that fits it', () => {
  const body = /body\s*\{\s*font:\s*([\d.]+)px\/([\d.]+)/.exec(css)
  assert.ok(Number(body[1]) >= MIN_BASE_PX, `body font ${body[1]}px`)
  const diff = /\.diff\s*\{[^}]*font-size:\s*([\d.]+)px;\s*line-height:\s*([\d.]+)px/.exec(css)
  assert.ok(Number(diff[1]) >= MIN_CODE_PX, `diff font ${diff[1]}px`)
  assert.ok(Number(diff[2]) >= Number(diff[1]) * 1.5, `diff line-height ${diff[2]}px is too tight for ${diff[1]}px`)
})
