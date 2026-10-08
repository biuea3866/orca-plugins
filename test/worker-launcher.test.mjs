import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  readRuntime,
  ensureServer,
  currentWorktreePath,
  buildOpenUrl,
  installLauncher,
  parseWorktreeCurrent
} from '../worker/launcher-lib.mjs'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'sr-launcher-'))
}

function writeRuntime(homeDir, runtime) {
  mkdirSync(join(homeDir, 'runtime'), { recursive: true })
  writeFileSync(join(homeDir, 'runtime', 'server.json'), JSON.stringify(runtime))
}

const healthyFetch = async () => ({ ok: true, json: async () => ({ ok: true, protocolVersion: 1 }) })
const deadFetch = async () => { throw new Error('ECONNREFUSED') }

test('readRuntime returns null when runtime file is missing', () => {
  const homeDir = makeHome()
  assert.equal(readRuntime(homeDir), null)
})

test('readRuntime returns parsed runtime when present', () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 47811, pid: 1, token: 'abc', protocolVersion: 1 })
  assert.deepEqual(readRuntime(homeDir), { port: 47811, pid: 1, token: 'abc', protocolVersion: 1 })
})

test('ensureServer reuses a healthy running server without spawning', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 47811, pid: 1, token: 'tok', protocolVersion: 1 })
  let spawned = 0
  const result = await ensureServer({
    homeDir,
    serverEntry: '/plugin/server/main.mjs',
    fetchImpl: healthyFetch,
    spawnImpl: () => { spawned += 1; return { unref() {} } },
    sleepImpl: async () => {}
  })
  assert.equal(spawned, 0)
  assert.equal(result.port, 47811)
  assert.equal(result.token, 'tok')
})

test('ensureServer spawns the server detached when health check fails, then waits for runtime file', async () => {
  const homeDir = makeHome()
  writeRuntime(homeDir, { port: 47811, pid: 999999, token: 'stale', protocolVersion: 1 })
  let spawnArgs = null
  let polls = 0
  const result = await ensureServer({
    homeDir,
    serverEntry: '/plugin/server/main.mjs',
    fetchImpl: async () => {
      polls += 1
      if (polls === 1) throw new Error('ECONNREFUSED')
      return healthyFetch()
    },
    spawnImpl: (command, args, options) => {
      spawnArgs = { command, args, options }
      // the real server rewrites the runtime file once it is listening
      writeRuntime(homeDir, { port: 50123, pid: 4242, token: 'fresh', protocolVersion: 1 })
      return { unref() {} }
    },
    sleepImpl: async () => {},
    timeoutMs: 1000
  })
  assert.ok(spawnArgs, 'spawn must be called')
  assert.equal(spawnArgs.args.at(-1), '/plugin/server/main.mjs')
  assert.equal(spawnArgs.options.detached, true)
  assert.equal(spawnArgs.options.stdio, 'ignore')
  assert.equal(spawnArgs.options.env.ORCA_SELF_REVIEW_HOME, homeDir)
  assert.equal(spawnArgs.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(result.port, 50123)
  assert.equal(result.token, 'fresh')
})

test('ensureServer throws a clear error when the server never becomes healthy', async () => {
  const homeDir = makeHome()
  await assert.rejects(
    ensureServer({
      homeDir,
      serverEntry: '/plugin/server/main.mjs',
      fetchImpl: deadFetch,
      spawnImpl: () => ({ unref() {} }),
      sleepImpl: async () => {},
      timeoutMs: 50,
      nowImpl: (() => { let t = 0; return () => (t += 20) })()
    }),
    /did not become healthy/
  )
})

test('parseWorktreeCurrent extracts the path from orca worktree current --json', () => {
  const output = JSON.stringify({ ok: true, result: { worktree: { path: '/repo/x', branch: 'refs/heads/feat', displayName: 'feat' } } })
  assert.deepEqual(parseWorktreeCurrent(output), { path: '/repo/x', branch: 'feat', displayName: 'feat' })
})

test('parseWorktreeCurrent returns null on malformed or unsuccessful output', () => {
  assert.equal(parseWorktreeCurrent('not json'), null)
  assert.equal(parseWorktreeCurrent(JSON.stringify({ ok: false })), null)
})

test('currentWorktreePath uses the orca CLI and falls back to null when it fails', async () => {
  const okExec = async () => ({ stdout: JSON.stringify({ ok: true, result: { worktree: { path: '/w', branch: 'refs/heads/b', displayName: 'b' } } }), code: 0 })
  assert.equal(await currentWorktreePath({ execImpl: okExec }), '/w')
  const failExec = async () => { throw new Error('orca not found') }
  assert.equal(await currentWorktreePath({ execImpl: failExec }), null)
})

test('buildOpenUrl encodes the target path and supports the overview route', () => {
  assert.equal(buildOpenUrl({ port: 47811, target: '/Users/me/my repo' }), 'http://127.0.0.1:47811/?target=%2FUsers%2Fme%2Fmy%20repo')
  assert.equal(buildOpenUrl({ port: 47811, overview: true }), 'http://127.0.0.1:47811/#/')
})

test('installLauncher writes an executable launcher that points at the plugin root', () => {
  const homeDir = makeHome()
  const launcherPath = installLauncher({ homeDir, pluginRoot: '/plugins/local-self-review', nodeBinary: '/usr/local/bin/node' })
  assert.equal(launcherPath, join(homeDir, 'bin', 'open-review'))
  assert.ok(existsSync(launcherPath))
  const mode = statSync(launcherPath).mode & 0o777
  assert.equal(mode & 0o100, 0o100, 'owner-executable bit set')
  const body = readFileSync(launcherPath, 'utf8')
  assert.match(body, /^#!\/bin\/sh/)
  assert.match(body, /\/plugins\/local-self-review\/worker\/launcher-cli\.mjs/)
  assert.match(body, /\/usr\/local\/bin\/node/)
})
