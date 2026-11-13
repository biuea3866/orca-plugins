import test from 'node:test';import assert from 'node:assert/strict';
import {parseFixQuestions} from '../server/lib/fix-questions.mjs';
import {SessionStore} from '../server/lib/store.mjs';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const id='thr_111111111111',nonce='aabb1234',block=body=>`@@QUESTION:${id}:${nonce}@@\n${body}\n@@END:${nonce}@@`;
test('only complete questions for the submitted thread and nonce are emitted',()=>{
 const text=block('이 설정을 유지할까요?')+'\n'+block('기존 데이터는 어떻게 처리할까요?');
 assert.equal(parseFixQuestions({text:text.slice(0,20),threadIds:[id],nonce}).length,0);
 assert.deepEqual(parseFixQuestions({text,threadIds:[id],nonce}).map(q=>q.body),['이 설정을 유지할까요?','기존 데이터는 어떻게 처리할까요?']);
 assert.equal(parseFixQuestions({text,threadIds:[],nonce}).length,0);assert.equal(parseFixQuestions({text,threadIds:[id],nonce:'different'}).length,0);
});
test('multiple AI questions in one thread persist once each despite repeated streaming windows',()=>{
 const store=new SessionStore({homeDir:mkdtempSync(join(tmpdir(),'fix-questions-'))});let s=store.createSession({kind:'local',repoPath:'/repo',branch:'feat/a',baseRef:'main'});s=store.addThread(s.id,{revision:s.revision,path:'file',side:'new',startLine:1,endLine:1,selectedText:'x',body:'수정해줘'});const threadId=s.threads[0].id;
 const entries=['질문 하나?','질문 둘?'].map(body=>({threadId,body,agent:'claude',runId:'run_111111111111',kind:'question'}));store.appendAiComments(s.id,entries);store.appendAiComments(s.id,entries);
 const comments=store.getSession(s.id).threads[0].comments;assert.equal(comments.length,3);assert.equal(comments[1].kind,'question');assert.equal(comments[2].kind,'question');
});
