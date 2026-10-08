import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRequest } from '../server/lib/auth.mjs'

const token = 'a'.repeat(64)
const port = 47811

function result(headers, url = '/api/sessions') {
  return checkRequest({ headers, url, token, port })
}

test('passes with matching token and host, with or without a loopback origin', () => {
  assert.equal(result({ host: `127.0.0.1:${port}`, 'x-sr-token': token }), null)
  assert.equal(result({ host: `localhost:${port}`, 'x-sr-token': token, origin: `http://localhost:${port}` }), null)
})

test('rejects a wrong host with 400 before anything else', () => {
  assert.equal(result({ host: 'evil.example:80', 'x-sr-token': token })?.status, 400)
})

test('rejects a foreign origin with 403', () => {
  assert.equal(result({ host: `127.0.0.1:${port}`, 'x-sr-token': token, origin: 'http://evil.example' })?.status, 403)
})

test('rejects a missing or wrong token with 401', () => {
  assert.equal(result({ host: `127.0.0.1:${port}` })?.status, 401)
  assert.equal(result({ host: `127.0.0.1:${port}`, 'x-sr-token': 'b'.repeat(64) })?.status, 401)
})

test('health endpoint and the UI document need no token but still need a valid host', () => {
  assert.equal(result({ host: `127.0.0.1:${port}` }, '/health'), null)
  assert.equal(result({ host: `127.0.0.1:${port}` }, '/'), null)
  assert.equal(result({ host: `127.0.0.1:${port}` }, '/ui/app.js'), null)
  assert.equal(result({ host: 'evil:1' }, '/health')?.status, 400)
})
