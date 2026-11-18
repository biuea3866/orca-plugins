// Keeps a live bridge terminal per worktree. The panel cannot talk to the
// server directly, so the server itself (re)creates the terminal that runs
// `open-review --bridge` whenever none of the registered ids is alive.

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function filterAlive(terminals, registeredIds) {
  const live = new Set(terminals.flatMap((terminal) => [terminal.handle, terminal.ptyId].filter(Boolean)))
  return registeredIds.filter((id) => live.has(id))
}

// A bridge terminal is titled with its command (the quoted launcher path, cut at the first space); that identifies one
// that has not registered its ids yet, so a slow registration never spawns a second one. Output is not used: any shell
// can print the bridge banner.
function runningBridges(terminals, worktreePath, launcherPath) {
  const command = shellQuote(launcherPath)
  return terminals.filter((terminal) => terminal.worktreePath === worktreePath
    && ((typeof terminal.title === 'string' && terminal.title.length >= 8 && command.startsWith(terminal.title)) || terminal.title === 'Self Review bridge'))
}

export class BridgeKeeper {
  // Last line of defence against a runaway: whatever the cause, bridge terminals are created at most this often.
  constructor({ exec, orcaBinary, launcherPath, now = () => Date.now(), cooldownMs = 60_000, log = () => {}, capWindowMs = 10 * 60_000, perWorktreeCap = 2, globalCap = 6 }) {
    this.capWindowMs = capWindowMs
    this.perWorktreeCap = perWorktreeCap
    this.globalCap = globalCap
    this.createdAt = []                 // { worktreePath, at } of recent creations
    this.capLoggedAt = -Infinity
    this.exec = exec
    this.orcaBinary = orcaBinary
    this.launcherPath = launcherPath
    this.now = now
    this.cooldownMs = cooldownMs
    this.log = log
    this.lastAttempt = new Map()
  }

  /** Live terminals, or null when Orca cannot answer (app down, runtime unavailable). */
  async readTerminals() {
    try {
      const result = await this.exec(this.orcaBinary, ['terminal', 'list', '--json'], { timeout: 15_000 })
      if (result.code !== 0) return null
      const parsed = JSON.parse(result.stdout)
      return parsed.ok ? parsed.result?.terminals ?? [] : null
    } catch {
      return null
    }
  }

  async listTerminals() {
    return (await this.readTerminals()) ?? []
  }

  /** Registered ids that still belong to a live terminal (handle or pty id). */
  async aliveIds(registeredIds) {
    return filterAlive(await this.listTerminals(), registeredIds)
  }

  async ensure(worktreePath, registeredIds = []) {
    const terminals = await this.readTerminals()
    // liveness unknown: creating would stack a new bridge on every tick, and alive: null keeps registrations
    if (terminals === null) return { created: false, alive: null, unavailable: true }
    const alive = filterAlive(terminals, registeredIds)
    if (alive.length > 0) return { created: false, alive }
    if (runningBridges(terminals, worktreePath, this.launcherPath).length > 0) return { created: false, alive, running: true }
    const last = this.lastAttempt.get(worktreePath) ?? -Infinity
    if (this.now() - last < this.cooldownMs) return { created: false, alive, throttled: true }
    const current = this.now()
    this.createdAt = this.createdAt.filter((entry) => current - entry.at < this.capWindowMs)
    const forWorktree = this.createdAt.filter((entry) => entry.worktreePath === worktreePath).length
    if (forWorktree >= this.perWorktreeCap || this.createdAt.length >= this.globalCap) {
      if (current - this.capLoggedAt >= this.capWindowMs) {
        this.capLoggedAt = current
        this.log(`bridge terminal creation capped (${forWorktree}/${this.perWorktreeCap} for ${worktreePath}, ${this.createdAt.length}/${this.globalCap} overall per ${Math.round(this.capWindowMs / 60_000)} min); not creating more`)
      }
      return { created: false, alive, capped: true }
    }
    this.createdAt.push({ worktreePath, at: current })
    this.lastAttempt.set(worktreePath, current)
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
