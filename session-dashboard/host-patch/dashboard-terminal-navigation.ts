export const DASHBOARD_FOCUS_REQUEST = 'orca-dashboard-focus-terminal'
export const DASHBOARD_FOCUS_RESULT = 'orca-dashboard-focus-terminal-result'

type ReplyWindow = { postMessage: (message: unknown, origin: string) => void }

export function createDashboardTerminalNavigation(options: {
  pluginKey: string | null
  panelId: string | null
  getWindow: () => ReplyWindow | null
  getData: () => unknown
  isActive: () => boolean
  focus: (terminal: string) => Promise<{ ok: boolean }>
}): (event: { source: unknown; data: unknown }) => void {
  const pending = new Set<string>()
  return (event) => {
    if (options.pluginKey !== 'biuea3866.orca-session-dashboard' || options.panelId !== 'sessions' || !options.isActive()) return
    const target = options.getWindow()
    if (!target || event.source !== target || !event.data || typeof event.data !== 'object') return
    const request = event.data
    if (!('type' in request) || request.type !== DASHBOARD_FOCUS_REQUEST || !('requestId' in request) ||
        typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId)) return
    const requestId = request.requestId
    const data = options.getData()
    const sessions = data && typeof data === 'object' && 'snapshot' in data && data.snapshot &&
      typeof data.snapshot === 'object' && 'sessions' in data.snapshot && Array.isArray(data.snapshot.sessions)
      ? data.snapshot.sessions : []
    const reply = (ok: boolean, error?: string): void => {
      if (options.isActive() && options.getWindow() === target) {
        target.postMessage({ type: DASHBOARD_FOCUS_RESULT, requestId, ok, error }, '*')
      }
    }
    if (!('terminal' in request) || typeof request.terminal !== 'string' ||
        !/^term_[a-zA-Z0-9_-]{1,128}$/.test(request.terminal) ||
        !sessions.some(session => session && typeof session === 'object' && session.terminalHandle === request.terminal)) {
      reply(false, '이 세션의 터미널을 찾을 수 없습니다.'); return
    }
    if (pending.has(requestId)) return
    if (pending.size >= 1) { reply(false, '다른 터미널로 이동 중입니다.'); return }
    pending.add(requestId)
    void options.focus(request.terminal).then(
      result => reply(result.ok, result.ok ? undefined : '터미널이 닫혔거나 연결되지 않았습니다.'),
      () => reply(false, '터미널 이동에 실패했습니다.')
    ).finally(() => pending.delete(requestId))
  }
}
