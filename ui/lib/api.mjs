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
  async function request(method, url, body) {
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
