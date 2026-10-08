// Keeps a live bridge terminal per worktree. The panel cannot talk to the
// server directly, so the server itself (re)creates the terminal that runs
// `open-review --bridge` whenever none of the registered ids is alive.

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export class BridgeKeeper {
  constructor({ exec, orcaBinary, launcherPath, now = () => Date.now(), cooldownMs = 60_000, log = () => {} }) {
    this.exec = exec
    this.orcaBinary = orcaBinary
    this.launcherPath = launcherPath
    this.now = now
    this.cooldownMs = cooldownMs
    this.log = log
    this.lastAttempt = new Map()
  }

  async listTerminals() {
    try {
      const result = await this.exec(this.orcaBinary, ['terminal', 'list', '--json'], { timeout: 15_000 })
      if (result.code !== 0) return []
      const parsed = JSON.parse(result.stdout)
      return parsed.ok ? parsed.result?.terminals ?? [] : []
    } catch {
      return []
    }
  }

  /** Registered ids that still belong to a live terminal (handle or pty id). */
  async aliveIds(registeredIds) {
    const terminals = await this.listTerminals()
    const live = new Set(terminals.flatMap((terminal) => [terminal.handle, terminal.ptyId].filter(Boolean)))
    return registeredIds.filter((id) => live.has(id))
  }

  async ensure(worktreePath, registeredIds = []) {
    const alive = await this.aliveIds(registeredIds)
    if (alive.length > 0) return { created: false, alive }
    const last = this.lastAttempt.get(worktreePath) ?? -Infinity
    if (this.now() - last < this.cooldownMs) return { created: false, alive, throttled: true }
    this.lastAttempt.set(worktreePath, this.now())
    const command = `${shellQuote(this.launcherPath)} --bridge`
    try {
      const result = await this.exec(this.orcaBinary, ['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', 'Self Review bridge', '--command', command, '--json'], { timeout: 20_000 })
      if (result.code !== 0) { this.log(`bridge terminal create failed for ${worktreePath}: ${(result.stderr || result.stdout).trim()}`); return { created: false, alive, error: result.stderr } }
      let handle = null
      try { handle = JSON.parse(result.stdout).result?.terminal?.handle ?? null } catch { /* ignore */ }
      return { created: true, alive, handle }
    } catch (error) {
      this.log(`bridge terminal create failed for ${worktreePath}: ${error.message}`)
      return { created: false, alive, error: error.message }
    }
  }
}
