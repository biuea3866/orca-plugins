// The worker owns local HTTP access; the sandboxed panel receives data, never the server token.
export function registerPanelRequests(context, { ensureRuntime, sendOp, fetchImpl = globalThis.fetch }) {
  if (!context.panels?.handle) return
  context.panels.handle('review.snapshot', async () => {
    const runtime = await ensureRuntime()
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/panel-preview`, {
      headers: { 'X-SR-Token': runtime.token },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`Self Review HTTP ${response.status}`)
    const html = await response.text()
    const payload = /<script type="application\/json" id="orca-panel-data">([\s\S]*?)<\/script>/.exec(html)
    if (!payload) throw new Error('Self Review: missing panel data')
    const data = JSON.parse(payload[1])
    if (data.schemaVersion !== 1) throw new Error('Self Review: unsupported panel data')
    return data
  })
  context.panels.handle('review.op', async (op) => sendOp(await ensureRuntime(), op))
}
