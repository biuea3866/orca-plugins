import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureBridgeTerminal } from '../worker/launcher-lib.mjs'

const runtime = { port: 1, token: 't' }

test('ensureBridgeTerminal reuses a registered bridge whose terminal is still alive', async () => {
  const execCalls = []
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => ({ bridges: { '/w': { terminalIds: ['term_1', 'pty_1'] } } }) })
  const execImpl = async (command, args) => { execCalls.push(args); return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_1', ptyId: 'pty_1', worktreePath: '/w' }] } }), stderr: '' } }
  const result = await ensureBridgeTerminal({ runtime, worktreePath: '/w', launcherPath: '/home/bin/open-review', fetchImpl, execImpl })
  assert.equal(result.created, false)
  assert.equal(result.terminalHandle, 'term_1')
  assert.ok(execCalls.every((args) => args[0] === 'terminal' && args[1] === 'list'), 'no terminal create')
})

test('ensureBridgeTerminal creates a bridge terminal when none is registered or the registered one is gone', async () => {
  const execCalls = []
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ bridges: { '/w': { terminalIds: ['term_dead'] } } }) })
  const execImpl = async (command, args) => {
    execCalls.push(args)
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '' }
    if (args[1] === 'create') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term_new' } } }), stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  const result = await ensureBridgeTerminal({ runtime, worktreePath: '/w', launcherPath: '/home/bin/open review', fetchImpl, execImpl })
  assert.equal(result.created, true)
  assert.equal(result.terminalHandle, 'term_new')
  const create = execCalls.find((args) => args[1] === 'create')
  assert.ok(create.includes('--worktree') && create.includes('path:/w'))
  const command = create[create.indexOf('--command') + 1]
  assert.match(command, /'\/home\/bin\/open review' --bridge/)
})
