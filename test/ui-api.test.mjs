import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApi, ApiRequestError } from '../ui/lib/api.mjs'

test('createApi sends the token header and parses JSON', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ hello: 1 }) } }
  const api = createApi({ token: 'tok', fetchImpl })
  const body = await api.get('/api/overview')
  assert.deepEqual(body, { hello: 1 })
  assert.equal(calls[0].url, '/api/overview')
  assert.equal(calls[0].init.headers['X-SR-Token'], 'tok')
  await api.post('/api/sessions', { kind: 'local' })
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json')
  assert.equal(JSON.parse(calls[1].init.body).kind, 'local')
})

test('createApi throws ApiRequestError with status and server error code', async () => {
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'revision_conflict', message: 'stale' } }) })
  const api = createApi({ token: 'tok', fetchImpl })
  await assert.rejects(api.patch('/api/sessions/x', {}), (error) => error instanceof ApiRequestError && error.status === 409 && error.code === 'revision_conflict')
})
