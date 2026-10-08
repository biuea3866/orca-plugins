import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLineBuffer, buildRegistration } from '../worker/bridge-reader.mjs'

test('createLineBuffer splits raw terminal input on CR or LF and ignores empty lines', () => {
  const lines = []
  const buffer = createLineBuffer((line) => lines.push(line))
  buffer.push('SR abc')
  assert.deepEqual(lines, [])
  buffer.push('\r')
  buffer.push('\n\nSR d')
  buffer.push('ef\r\nSR ghi\r')
  assert.deepEqual(lines, ['SR abc', 'SR def', 'SR ghi'])
})

test('createLineBuffer reports Ctrl+C and Ctrl+D as control events', () => {
  const events = []
  const buffer = createLineBuffer(() => {}, (control) => events.push(control))
  buffer.push('')
  buffer.push('')
  assert.deepEqual(events, ['interrupt', 'eof'])
})

test('buildRegistration collects worktree path and terminal identifiers from env and args', () => {
  const registration = buildRegistration({ env: { ORCA_TERMINAL_HANDLE: 'term_1', ORCA_PANE_KEY: 'tab:pane' }, args: ['--bridge', '--panel-terminal', 'pty_9'], worktreePath: '/w', ptyId: 'pty_1' })
  assert.deepEqual(registration, { worktreePath: '/w', terminalHandle: 'term_1', panelTerminalId: 'pty_9', ptyId: 'pty_1' })
})
