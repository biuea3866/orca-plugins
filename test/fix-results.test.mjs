import test from 'node:test'
import assert from 'node:assert/strict'
import {fixResultEntries} from '../server/lib/fix-results.mjs'
const request={threadId:'thr_111111111111',commentId:'cmt_111111111111',body:'cache fallback 수정',updatedAt:'then'}
const run={id:'run_111111111111',agent:'claude',status:'succeeded',nonce:'abc123',threadIds:[request.threadId],requestedComments:[request],changedFiles:['cache.kt']}
test('per-request result blocks bind only to submitted comments and preserve request snapshots',()=>{
 const text='@@FIX:cmt_111111111111:abc123@@\ncache.kt:12에 fallback을 추가. 검증: test pass\n@@END:abc123@@\n@@FIX:cmt_222222222222:abc123@@\nforged\n@@END:abc123@@'
 const [entry]=fixResultEntries(run,text)
 assert.equal(entry.replyToCommentId,request.commentId);assert.equal(entry.requestBody,request.body);assert.equal(entry.kind,'fix-result');assert.match(entry.body,/fallback을 추가/);assert.match(entry.body,/로컬/);assert.match(entry.body,/미실행/)
 assert.equal(fixResultEntries(run,text).length,1)
})
test('old completion reports recover the actual reason and verification without inventing details',()=>{
 const [entry]=fixResultEntries(run,'스레드별 결과:\n- thr_111111111111: 수행 — cache miss 때 DB 조회 추가\n변경 파일:\n- cache.kt\n검증: unit test 통과')
 assert.match(entry.body,/cache miss 때 DB 조회 추가/);assert.match(entry.body,/unit test 통과/);assert.match(entry.body,/cache.kt/)
})
test('questions and failed runs never report completion even if the model claims success',()=>{
 for(const override of [{questionThreadIds:[request.threadId]},{status:'failed'}]){
  const [entry]=fixResultEntries({...run,...override},'- thr_111111111111: 수행 — done')
  assert.doesNotMatch(entry.body,/수정 완료/);assert.match(entry.body,/보류|실패/)
 }
})
test('missing reports and wrong nonces do not become invented modification details',()=>{
 const [entry]=fixResultEntries(run,'@@FIX:cmt_111111111111:wrong@@\nmade up\n@@END:wrong@@')
 assert.match(entry.body,/구체적인 수정 결과 보고가 없습니다/);assert.doesNotMatch(entry.body,/made up/)
})

test('an automatic-commit result distinguishes the AI edit stage from the later server commit',()=>{
 const [entry]=fixResultEntries({...run,autoCommit:true},'- thr_111111111111: 수행 — edited')
 assert.match(entry.body,/AI 단계/)
 assert.match(entry.body,/서버 자동 커밋 결과/)
})
