// Pure helpers for the bridge terminal: raw-mode line buffering and the
// registration payload. Kept DOM/IO free so they are unit-testable.

export function createLineBuffer(onLine, onControl = () => {}) {
  let pending = ''
  return {
    push(chunk) {
      for (const char of String(chunk)) {
        if (char === '') { onControl('interrupt'); continue }
        if (char === '') { onControl('eof'); continue }
        if (char === '\r' || char === '\n') {
          const line = pending
          pending = ''
          if (line.trim().length > 0) onLine(line)
          continue
        }
        if (char === '' || char === '\b') { pending = pending.slice(0, -1); continue }
        pending += char
      }
    },
    flush() {
      const line = pending
      pending = ''
      if (line.trim().length > 0) onLine(line)
    }
  }
}

export function buildRegistration({ env, args, worktreePath, ptyId = null }) {
  const panelIndex = args.indexOf('--panel-terminal')
  const panelTerminalId = panelIndex !== -1 ? args[panelIndex + 1] ?? null : null
  return {
    worktreePath,
    terminalHandle: env.ORCA_TERMINAL_HANDLE ?? null,
    panelTerminalId,
    ptyId
  }
}
