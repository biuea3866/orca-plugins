import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SessionStore} from '../server/lib/store.mjs'
import {selectRunnableThreads,buildPrompt,completedFixThreads} from '../server/lib/prompt.mjs'

test('completed requests become context, while follow-up comments remain actionable',()=>{
 const old={id:'old',body:'old request',fixCompletedAt:'now'},fresh={id:'new',body:'new request'}
 const thread={id:'thr_111111111111',status:'open',applicability:'current',path:'a.js',side:'new',startLine:1,endLine:1,selectedText:'x',comments:[old]}
 assert.equal(selectRunnableThreads([thread]).length,0)
 thread.comments.push(fresh)
 assert.equal(selectRunnableThreads([thread]).length,1)
 const prompt=buildPrompt({session:{},threads:[thread],readFileLines:()=>[]})
 assert.match(prompt,/수정 완료.*문맥/)
 assert.match(prompt,/이번 수정 요청.*new request/)
 assert.deepEqual(completedFixThreads('- thr_111111111111: 수행 — done\n- thr_222222222222: 미수행 — blocked',['thr_111111111111','thr_222222222222']),['thr_111111111111'])
})

test('only the exact comment version submitted to a successful run receives a completion marker',()=>{
 const store=new SessionStore({homeDir:mkdtempSync(join(tmpdir(),'sr-fix-state-'))})
 let s=store.createSession({kind:'local',repoPath:'/repo',branch:'feat/x',baseRef:'main'})
 s=store.addThread(s.id,{revision:s.revision,path:'a.js',side:'new',startLine:1,endLine:1,selectedText:'x',body:'fix it'})
 const thread=s.threads[0],comment=thread.comments[0],request={threadId:thread.id,commentId:comment.id,body:comment.body,updatedAt:comment.updatedAt}
 s=store.addComment(s.id,thread.id,{revision:s.revision,body:'follow up'})
 store.markFixCompleted(s.id,[request],'run_111111111111')
 s=store.getSession(s.id)
 assert.ok(s.threads[0].comments[0].fixCompletedAt)
 assert.equal(s.threads[0].comments[1].fixCompletedAt,undefined)
 s=store.updateComment(s.id,thread.id,comment.id,{revision:s.revision,body:'edited while running'})
 assert.equal(s.threads[0].comments[0].fixCompletedAt,undefined)
 store.markFixCompleted(s.id,[request],'run_222222222222')
 assert.equal(store.getSession(s.id).threads[0].comments[0].fixCompletedAt,undefined)
})

test('fix result comments preserve the target request and deduplicate per run and request',()=>{
 const store=new SessionStore({homeDir:mkdtempSync(join(tmpdir(),'sr-fix-result-store-'))})
 let s=store.createSession({kind:'local',repoPath:'/repo',branch:'feat/x',baseRef:'main'})
 s=store.addThread(s.id,{revision:s.revision,path:'a.js',side:'new',startLine:1,endLine:1,selectedText:'x',body:'fix it'})
 const t=s.threads[0],c=t.comments[0],entry={threadId:t.id,body:'how it was changed',agent:'claude',runId:'run_111111111111',kind:'fix-result',replyToCommentId:c.id,requestBody:c.body,requestUpdatedAt:c.updatedAt}
 store.appendAiComments(s.id,[entry,entry]);s=store.getSession(s.id)
 assert.equal(s.threads[0].comments.length,2);assert.equal(s.threads[0].comments[1].replyToCommentId,c.id);assert.equal(s.threads[0].comments[1].kind,'fix-result');assert.equal(s.threads[0].comments[1].requestBody,'fix it')
 store.appendAiComments(s.id,[{...entry,replyToCommentId:'deleted-comment'}]);assert.equal(store.getSession(s.id).threads[0].comments.length,2)
})
