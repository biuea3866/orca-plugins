import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import activate, { deactivate } from '../worker/main.mjs'

function fakeContext() {
  const registered = new Map()
  const hostCalls = []
  const logs = []
  return {
    context: {
      commands: { register: (id, handler) => registered.set(id, handler) },
      events: { on() {} },
      host: { call: async (method, params) => { hostCalls.push({ method, params }); return { delivered: true } } },
      grantedCapabilities: ['workspace:read', 'terminal:send', 'notifications:show', 'storage', 'settings:own'],
      log: (message) => logs.push(message)
    },
    registered,
    hostCalls,
    logs
  }
}

test('activate registers the three manifest commands and installs the launcher', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-worker-'))
  const previous = process.env.ORCA_SELF_REVIEW_HOME
  process.env.ORCA_SELF_REVIEW_HOME = homeDir
  try {
    const { context, registered, logs } = fakeContext()
    await activate(context)
    assert.deepEqual([...registered.keys()].sort(), ['open-overview', 'open-review', 'open-wide', 'stop-server'])
    assert.ok(existsSync(join(homeDir, 'bin', 'open-review')), 'launcher installed into the data directory')
    assert.ok(logs.some((line) => line.includes('launcher installed')))
  } finally {
    if (previous === undefined) delete process.env.ORCA_SELF_REVIEW_HOME
    else process.env.ORCA_SELF_REVIEW_HOME = previous
  }
})

test('stop-server reports "not running" when no runtime file exists and notifies the user', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'sr-worker-'))
  const previous = process.env.ORCA_SELF_REVIEW_HOME
  process.env.ORCA_SELF_REVIEW_HOME = homeDir
  try {
    const { context, registered, hostCalls } = fakeContext()
    await activate(context)
    const result = await registered.get('stop-server')()
    assert.equal(result.stopped, false)
    assert.equal(result.reason, 'not running')
    assert.equal(hostCalls.at(-1).method, 'notifications.show')
  } finally {
    if (previous === undefined) delete process.env.ORCA_SELF_REVIEW_HOME
    else process.env.ORCA_SELF_REVIEW_HOME = previous
  }
})

test('deactivate resolves without touching the server', async () => {
  await deactivate()
})
