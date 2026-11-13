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

const unauthorized = () => ({ok:false,status:401,json:async()=>({error:{code:'unauthorized',message:'missing or invalid X-SR-Token header'}})})
test('stale token refreshes from same-origin HTML and retries the rejected mutation once', async () => {
  const token='a'.repeat(64), calls=[]
  const api=createApi({token:'old',fetchImpl:async(url,init)=>{
    calls.push({url,init})
    if(url==='/')return {ok:true,text:async()=>`<head><meta name="sr-token" content="${token}"></head>`}
    if(init.headers['X-SR-Token']!==token)return unauthorized()
    return {ok:true,json:async()=>({saved:true})}
  }})
  assert.deepEqual(await api.post('/api/sessions/x/comments',{body:'keep draft'}),{saved:true})
  assert.deepEqual(calls.map(c=>c.url),['/api/sessions/x/comments','/','/api/sessions/x/comments'])
  assert.equal(calls[1].init.cache,'no-store')
  assert.equal(calls[0].init.body,calls[2].init.body)
  await api.get('/api/overview')
  assert.equal(calls.length,4)
})
test('token refresh failure preserves the original typed authentication error', async () => {
  let count=0
  const api=createApi({token:'old',fetchImpl:async(url)=>{count++;if(url==='/')throw new Error('offline');return unauthorized()}})
  await assert.rejects(api.get('/api/overview'),e=>e instanceof ApiRequestError&&e.status===401&&e.code==='unauthorized')
  assert.equal(count,2)
})
test('a second authentication rejection is not retried indefinitely', async () => {
  let count=0
  const api=createApi({token:'old',fetchImpl:async(url)=>{count++;return url==='/'?{ok:true,text:async()=>`<meta name="sr-token" content="${'b'.repeat(64)}">`}:unauthorized()}})
  await assert.rejects(api.get('/api/overview'),e=>e.status===401)
  assert.equal(count,3)
})
