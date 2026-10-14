// One Local Self Review server per home directory. A server started while
// another healthy one owns runtime/server.json steps aside, and a server that
// got displaced (its server.json was overwritten) retires instead of running
// its own bridge maintenance loop next to the owner.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROTOCOL_VERSION = 1

function readRecordedServer(homeDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(homeDir, 'runtime', 'server.json'), 'utf8'))
    return typeof parsed?.port === 'number' && Number.isInteger(parsed?.pid) ? parsed : null
  } catch {
    return null
  }
}

async function answersHealth(runtime, fetchImpl) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true && body?.protocolVersion === PROTOCOL_VERSION
  } catch {
    return false
  }
}

/** The server recorded in server.json when it is a different, healthy process; otherwise null. */
export async function findOtherHealthyServer({ homeDir, selfPid = process.pid, fetchImpl = globalThis.fetch }) {
  const recorded = readRecordedServer(homeDir)
  if (!recorded || recorded.pid === selfPid) return null
  return (await answersHealth(recorded, fetchImpl)) ? recorded : null
}

/** Calls onRetire once another healthy server owns server.json and canRetire() allows it. Returns a stop function. */
export function startRetireWatch({ homeDir, selfPid = process.pid, fetchImpl = globalThis.fetch, intervalMs = 30_000, canRetire = () => true, onRetire }) {
  let checking = false
  let stopped = false
  const timer = setInterval(async () => {
    if (checking || stopped) return
    checking = true
    try {
      if (!canRetire()) return
      const other = await findOtherHealthyServer({ homeDir, selfPid, fetchImpl })
      if (other && !stopped) { stop(); onRetire(other) }
    } finally {
      checking = false
    }
  }, intervalMs)
  timer.unref?.()
  function stop() { stopped = true; clearInterval(timer) }
  return stop
}
