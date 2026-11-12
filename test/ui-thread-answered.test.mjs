import test from 'node:test'
import assert from 'node:assert/strict'
import { answeredCommentIds } from '../ui/lib/threads.mjs'
const q = id => ({id,body:'question'})
const a = id => ({id,author:'ai',body:'answer'})
test('unanswered questions have no check',()=>assert.deepEqual([...answeredCommentIds([q('q1')])],[]))
test('a reply checks its preceding question; follow-ups stay unchecked until answered',()=>{
 assert.deepEqual([...answeredCommentIds([q('q1'),a('a1'),q('q2')])],['q1'])
 assert.deepEqual([...answeredCommentIds([q('q1'),a('a1'),q('q2'),a('a2')])],['q1','q2'])
})
test('deleting the AI reply removes its answered check',()=>assert.deepEqual([...answeredCommentIds([q('q1'),q('q2'),a('a2')])],['q2']))
test('empty and pending replies do not mark a question as answered',()=>assert.deepEqual([...answeredCommentIds([q('q1'),{...a('a1'),body:' '},{...a('a2'),pending:true}])],[]))
test('AI replies do not receive checks themselves and duplicate replies do not duplicate checks',()=>assert.deepEqual([...answeredCommentIds([q('q1'),a('a1'),a('a2')])],['q1']))
