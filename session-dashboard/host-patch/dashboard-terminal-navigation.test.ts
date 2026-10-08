import { describe, it, expect, vi } from 'vitest'
import { createDashboardTerminalNavigation, DASHBOARD_FOCUS_REQUEST } from './dashboard-terminal-navigation'

function setup(pluginKey = 'biuea3866.orca-session-dashboard') {
  const target = { postMessage: vi.fn() }
  const focus = vi.fn(async () => ({ ok: true }))
  const handler = createDashboardTerminalNavigation({
    pluginKey, panelId: 'sessions', getWindow: () => target,
    getData: () => ({ snapshot: { sessions: [{ terminalHandle: 'term_test' }] } }),
    isActive: () => true, focus
  })
  const event = { source: target, data: { type: DASHBOARD_FOCUS_REQUEST, requestId: 'r-1', terminal: 'term_test' } }
  return { target, focus, handler, event }
}

describe('dashboard terminal navigation boundary', () => {
  it('focuses the explicit listed handle and acknowledges the click', async () => {
    const { target, focus, handler, event } = setup()
    handler(event)
    await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalled())
    expect(focus).toHaveBeenCalledWith('term_test')
    expect(target.postMessage.mock.calls[0][0]).toMatchObject({ requestId: 'r-1', ok: true })
  })
  it('ignores other windows and plugins', () => {
    const first = setup()
    first.handler({ ...first.event, source: {} })
    expect(first.focus).not.toHaveBeenCalled()
    const second = setup('other.plugin')
    second.handler(second.event)
    expect(second.focus).not.toHaveBeenCalled()
  })
  it('rejects unlisted terminals and shell-like input', () => {
    const { target, focus, handler, event } = setup()
    handler({ ...event, data: { ...event.data, terminal: 'term_other' } })
    handler({ ...event, data: { ...event.data, terminal: 'term_test; echo bad' } })
    expect(focus).not.toHaveBeenCalled()
    expect(target.postMessage).toHaveBeenCalledTimes(2)
  })
  it('reports stale terminal failures', async () => {
    const { target, focus, handler, event } = setup()
    focus.mockRejectedValueOnce(new Error('stale'))
    handler(event)
    await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalled())
    expect(target.postMessage.mock.calls[0][0]).toMatchObject({ ok: false })
  })
})
