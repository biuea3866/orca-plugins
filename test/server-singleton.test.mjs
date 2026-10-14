import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findOtherHealthyServer, startRetireWatch } from '../server/lib/singleton.mjs'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'sr-singleton-'))
}

function writeRuntime(homeDir, runtime) {
  mkdirSync(join(homeDir, 'runtime'), { recursive: true })
  writeFileSync(join(homeDir, 'runtime', 'server.json'), JSON.stringify(runtime))
}

const healthyFetch = async () => ({ ok: true, json: async () => ({ ok: true, protocolVersion: 1 }) })
const deadFetch = async () => { throw new Error('ECONNREFUSED') }

test('findOtherHealthyServer returns the recorded server when another healthy process owns server.json', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 50123, pid: 4242, token: 'tok', protocolVersion: 1 })
  const other = await findOtherHealthyServer({ homeDir, selfPid: 1111, fetchImpl: healthyFetch })
  assert.equal(other.pid, 4242)
})

test('findOtherHealthyServer ignores a server.json that belongs to this process', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 50123, pid: 1111, token: 'tok', protocolVersion: 1 })
  assert.equal(await findOtherHealthyServer({ homeDir, selfPid: 1111, fetchImpl: healthyFetch }), null)
})

test('findOtherHealthyServer ignores a recorded server that does not answer /health', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 50123, pid: 4242, token: 'tok', protocolVersion: 1 })
  assert.equal(await findOtherHealthyServer({ homeDir, selfPid: 1111, fetchImpl: deadFetch }), null)
})

test('findOtherHealthyServer returns null when server.json is missing or malformed', async () => {
  const homeDir = makeHome()
  assert.equal(await findOtherHealthyServer({ homeDir, selfPid: 1111, fetchImpl: healthyFetch }), null)
  mkdirSync(join(homeDir, 'runtime'), { recursive: true })
  writeFileSync(join(homeDir, 'runtime', 'server.json'), '{not json')
  assert.equal(await findOtherHealthyServer({ homeDir, selfPid: 1111, fetchImpl: healthyFetch }), null)
})

test('startRetireWatch retires a displaced server once another healthy server owns server.json', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 50123, pid: 1111, token: 'mine', protocolVersion: 1 })
  let retired = 0
  const stop = startRetireWatch({ homeDir, selfPid: 1111, fetchImpl: healthyFetch, intervalMs: 5, onRetire: () => { retired += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(retired, 0, 'must not retire while it still owns server.json')
  writeRuntime(homeDir, { port: 50999, pid: 4242, token: 'theirs', protocolVersion: 1 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  stop()
  assert.equal(retired, 1, 'retires exactly once')
})

test('startRetireWatch postpones retiring while canRetire says work is still running', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 50999, pid: 4242, token: 'theirs', protocolVersion: 1 })
  let busy = true
  let retired = 0
  const stop = startRetireWatch({ homeDir, selfPid: 1111, fetchImpl: healthyFetch, intervalMs: 5, canRetire: () => !busy, onRetire: () => { retired += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(retired, 0)
  busy = false
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop()
  assert.equal(retired, 1)
})
