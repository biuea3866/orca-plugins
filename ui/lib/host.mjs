// Public frame API. Older hosts keep using the terminal bridge in the panel.
export function createPanelHost(orca) {
  if (!orca?.host?.has?.('plugin.request') && typeof orca?.host?.has === 'function') return null
  if (typeof orca?.host?.call !== 'function') return null
  const request = async (name, input) => {
    const result = await orca.host.call('plugin.request', { name, ...(input === undefined ? {} : { input }) })
    return result.output
  }
  return {
    call: (method, params) => orca.host.call(method, params),
    snapshot: () => request('review.snapshot'),
    send: (op) => request('review.op', op)
  }
}
