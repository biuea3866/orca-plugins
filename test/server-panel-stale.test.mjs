import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PanelPublisher } from '../server/lib/panel-publisher.mjs'

test('isStale reports when the file on disk no longer matches the last published document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sr-stale-'))
  mkdirSync(join(root, 'panel'))
  writeFileSync(join(root, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
  let value = 1
  const publisher = new PanelPublisher({ pluginRoot: root, debounceMs: 0, collect: async () => ({ schemaVersion: 1, generatedAt: 'now', reason: 'test', value }) })
  await publisher.flush('test')
  assert.equal(publisher.isStale(), false)
  writeFileSync(join(root, 'panel.html'), '<!doctype html><html><body>baseline from git checkout</body></html>')
  assert.equal(publisher.isStale(), true, 'external overwrite detected')
  await publisher.flush('heal')
  assert.ok(readFileSync(join(root, 'panel.html'), 'utf8').includes('"value":1'))
  assert.equal(publisher.isStale(), false)
})
