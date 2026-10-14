import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeKeeper } from '../server/lib/bridge-keeper.mjs'

function makeKeeper({ terminals = [], createResult = { handle: 'term_new' } } = {}) {
  const calls = []
  const exec = async (command, args) => {
    calls.push(args)
    if (args[0] === 'terminal' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals } }), stderr: '' }
    if (args[0] === 'terminal' && args[1] === 'create') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: createResult } }), stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  let clock = 0
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/home/bin/open-review', now: () => clock, cooldownMs: 60_000 })
  return { keeper, calls, advance: (ms) => { clock += ms } }
}

test('ensure creates a bridge terminal when no registered id is alive', async () => {
  const { keeper, calls } = makeKeeper({ terminals: [{ handle: 'term_other', ptyId: 'pty_other', worktreePath: '/w' }] })
  const result = await keeper.ensure('/w', ['term_dead'])
  assert.equal(result.created, true)
  const create = calls.find((args) => args[1] === 'create')
  assert.ok(create.includes('path:/w'))
  assert.match(create[create.indexOf('--command') + 1], /open-review' --bridge$/)
})

test('ensure does nothing when a registered bridge is still alive', async () => {
  const { keeper, calls } = makeKeeper({ terminals: [{ handle: 'term_live', ptyId: 'pty_live', worktreePath: '/w' }] })
  const result = await keeper.ensure('/w', ['term_live'])
  assert.equal(result.created, false)
  assert.ok(!calls.some((args) => args[1] === 'create'))
})

test('ensure is rate limited per worktree so a failing create does not spam terminals', async () => {
  const { keeper, calls, advance } = makeKeeper()
  await keeper.ensure('/w', [])
  await keeper.ensure('/w', [])
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1)
  advance(61_000)
  await keeper.ensure('/w', [])
  assert.equal(calls.filter((args) => args[1] === 'create').length, 2)
})

test('ensure does not create terminals while Orca cannot list terminals (app down or runtime unavailable)', async () => {
  const calls = []
  const exec = async (command, args) => {
    calls.push(args)
    if (args[1] === 'list') return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable' } }), stderr: '' }
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term_new' } } }), stderr: '' }
  }
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/home/bin/open-review', now: () => 0 })
  const result = await keeper.ensure('/w', ['term_maybe_alive'])
  assert.equal(result.created, false)
  assert.equal(result.unavailable, true)
  assert.equal(result.alive, null, 'unknown liveness must not wipe registered ids')
  assert.ok(!calls.some((args) => args[1] === 'create'))
})

test('ensure treats an ok:false terminal list payload as unavailable', async () => {
  const exec = async (command, args) => (args[1] === 'list'
    ? { code: 0, stdout: JSON.stringify({ ok: false }), stderr: '' }
    : { code: 0, stdout: '{}', stderr: '' })
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/home/bin/open-review', now: () => 0 })
  const result = await keeper.ensure('/w', [])
  assert.equal(result.created, false)
  assert.equal(result.unavailable, true)
})

test('listTerminals still returns an empty list when Orca is unavailable', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'down' })
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/home/bin/open-review' })
  assert.deepEqual(await keeper.listTerminals(), [])
})

test('aliveIds filters registered ids down to live terminal handles or pty ids', async () => {
  const { keeper } = makeKeeper({ terminals: [{ handle: 'term_a', ptyId: 'pty_a', worktreePath: '/w' }] })
  assert.deepEqual(await keeper.aliveIds(['term_a', 'pty_zzz', 'term_gone']), ['term_a'])
})

function makeCappedKeeper(options = {}) {
  const calls = []
  const logs = []
  const exec = async (command, args) => {
    calls.push(args)
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '' }
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term_new' } } }), stderr: '' }
  }
  let clock = 0
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/home/bin/open-review', now: () => clock, cooldownMs: 60_000, log: (message) => logs.push(message), ...options })
  const creates = () => calls.filter((args) => args[1] === 'create').length
  return { keeper, creates, logs, advance: (ms) => { clock += ms } }
}

test('a worktree gets at most 2 bridge terminals per 10 minutes, however many ticks come', async () => {
  const { keeper, creates, advance } = makeCappedKeeper()
  const outcomes = []
  for (let tick = 0; tick < 8; tick += 1) { outcomes.push(await keeper.ensure('/w', [])); advance(61_000) } // ~8 minutes, each tick past the cooldown
  assert.equal(creates(), 2)
  assert.equal(outcomes.filter((outcome) => outcome.capped).length, 6)
  assert.equal(outcomes.find((outcome) => outcome.capped).created, false)
})

test('the cap lifts once the window has passed', async () => {
  const { keeper, creates, advance } = makeCappedKeeper()
  for (let tick = 0; tick < 4; tick += 1) { await keeper.ensure('/w', []); advance(61_000) }
  assert.equal(creates(), 2)
  advance(10 * 60_000)
  await keeper.ensure('/w', [])
  assert.equal(creates(), 3)
})

test('all worktrees together get at most 6 bridge terminals per 10 minutes', async () => {
  const { keeper, creates } = makeCappedKeeper()
  const outcomes = []
  for (let index = 0; index < 20; index += 1) outcomes.push(await keeper.ensure(`/w${index}`, []))
  assert.equal(creates(), 6)
  assert.equal(outcomes.filter((outcome) => outcome.capped).length, 14)
})

test('hitting the cap is logged once per window instead of on every tick', async () => {
  const { keeper, logs, advance } = makeCappedKeeper()
  for (let tick = 0; tick < 8; tick += 1) { await keeper.ensure('/w', []); advance(61_000) }
  assert.equal(logs.filter((message) => /cap/i.test(message)).length, 1)
})

test('a live bridge is never counted against the cap', async () => {
  const exec = async (command, args) => (args[1] === 'list'
    ? { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_live' }] } }), stderr: '' }
    : { code: 0, stdout: '{}', stderr: '' })
  const keeper = new BridgeKeeper({ exec, orcaBinary: 'orca', launcherPath: '/x', now: () => 0 })
  for (let tick = 0; tick < 10; tick += 1) {
    const result = await keeper.ensure('/w', ['term_live'])
    assert.equal(result.created, false)
    assert.equal(result.capped, undefined)
  }
})
