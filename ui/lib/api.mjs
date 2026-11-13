// Thin fetch wrapper: token header, JSON bodies, typed errors.

export class ApiRequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function createApi({ token, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  let refreshPending = null
  async function refreshToken() {
    if (!refreshPending) refreshPending = (async () => {
      try {
        const response = await fetchImpl('/', { method: 'GET', cache: 'no-store', headers: { Accept: 'text/html' } })
        if (!response.ok) return false
        const html = await response.text()
        const fresh = html.match(/<meta name="sr-token" content="([a-f0-9]{64})">/)?.[1]
        if (!fresh) return false
        token = fresh
        return true
      } catch { return false }
    })().finally(() => { refreshPending = null })
    return refreshPending
  }
  async function request(method, url, body, retried = false) {
    const headers = { 'X-SR-Token': token, Accept: 'application/json' }
    const init = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const response = await fetchImpl(url, init)
    let payload = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok) {
      const error = payload?.error ?? {}
      // Admission rejects this request before any mutation; retrying this 401 is safe.
      if (response.status === 401 && error.code === 'unauthorized' && !retried && await refreshToken()) {
        return request(method, url, body, true)
      }
      throw new ApiRequestError(response.status, error.code ?? 'http_error', error.message ?? `HTTP ${response.status}`, error)
    }
    return payload
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    patch: (url, body) => request('PATCH', url, body ?? {}),
    delete: (url, body) => request('DELETE', url, body ?? {})
  }
}
