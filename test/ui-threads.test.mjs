import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeThreads, threadKey, countRunnable } from '../ui/lib/threads.mjs'

const threads = [
  { id: 't1', path: 'a.js', side: 'new', startLine: 2, endLine: 4, status: 'open', applicability: 'current', comments:[{body:'request'}] },
  { id: 't2', path: 'a.js', side: 'new', startLine: 4, endLine: 4, status: 'resolved', applicability: 'current', comments:[{body:'request'}] },
  { id: 't3', path: 'b.js', side: 'old', startLine: 1, endLine: 1, status: 'open', applicability: 'outdated', comments:[{body:'request'}] }
]

test('placeThreads groups threads by file, side and end line', () => {
  const placement = placeThreads(threads)
  assert.deepEqual(Object.keys(placement).sort(), ['a.js|new|4', 'b.js|old|1'])
  assert.deepEqual(placement['a.js|new|4'].map((thread) => thread.id), ['t1', 't2'])
  assert.equal(threadKey('a.js', 'new', 4), 'a.js|new|4')
})

test('countRunnable counts open + current threads only', () => {
  assert.equal(countRunnable(threads), 1)
})

 test('a fresh follow-up on an outdated fixed thread stays runnable without redoing completed requests',()=>{
  const thread={...threads[2],comments:[{body:'old request',fixCompletedAt:'2026-11-12T00:00:00Z'},{author:'ai',body:'context'},{body:'fix this again'}]}
  assert.equal(countRunnable([thread]),1)
  assert.equal(countRunnable([{...thread,status:'resolved'}]),0)
  assert.equal(countRunnable([{...thread,comments:thread.comments.slice(0,2)}]),0)
  assert.equal(countRunnable([{...thread,comments:[{body:'old unprocessed request'}]}]),0)
 })

test('fix results display immediately after their own request and retain chronological order within each request',async()=>{
 const {commentsForDisplay}=await import('../ui/lib/threads.mjs')
 const comments=[{id:'a'},{id:'b'},{id:'r1',author:'ai',kind:'fix-result',replyToCommentId:'a'},{id:'r2',author:'ai',kind:'fix-result',replyToCommentId:'b'},{id:'r3',author:'ai',kind:'fix-result',replyToCommentId:'a'}]
 assert.deepEqual(commentsForDisplay(comments).map(c=>c.id),['a','r1','r3','b','r2'])
 assert.deepEqual(commentsForDisplay(comments.filter(c=>c.id!=='a')).map(c=>c.id),['b','r2','r1','r3'])
})
