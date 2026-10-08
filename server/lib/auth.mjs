// Request admission for the loopback server (docs/02-design.md "서버 API 계약").
// Order: Host (400) → Origin (403) → token for /api/* (401).

import { timingSafeEqual } from 'node:crypto'

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

/** Returns null when the request may proceed, else { status, code, message }. */
export function checkRequest({ headers, url, token, port }) {
  const hosts = allowedHosts(port)
  const host = String(headers.host ?? '')
  if (!hosts.has(host)) return { status: 400, code: 'bad_host', message: `unexpected Host header: ${host || '(none)'}` }
  const origin = headers.origin
  if (origin !== undefined && !hosts.has(String(origin).replace(/^https?:\/\//, ''))) {
    return { status: 403, code: 'bad_origin', message: 'cross-origin requests are not allowed' }
  }
  const path = url.split('?')[0]
  if (!path.startsWith('/api/')) return null
  if (!tokenMatches(headers['x-sr-token'], token)) return { status: 401, code: 'unauthorized', message: 'missing or invalid X-SR-Token header' }
  return null
}
