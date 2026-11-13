import test from 'node:test'
import assert from 'node:assert/strict'
import { countAwaitingAnswers, isCommentAnswered, isAiQuestionAnswered } from '../ui/lib/threads.mjs'
const question = { id: 'q', body: 'why?' }
const answer = { id: 'a', author: 'ai', body: 'because' }
const thread = { status: 'open', applicability: 'current', comments: [question] }
test('answers stop pending counts and follow-up questions enable them again', () => {
 assert.equal(countAwaitingAnswers([thread]), 1)
 const answered = { ...thread, comments: [question, answer] }
 assert.equal(countAwaitingAnswers([answered]), 0)
 assert.equal(isCommentAnswered(answered.comments, 0), true)
 assert.equal(isCommentAnswered(answered.comments, 1), false)
 const followup = {...answered, comments: [...answered.comments, {id:'q2',body:'more?'}]}
 assert.equal(countAwaitingAnswers([followup]), 1)
 assert.equal(isCommentAnswered(followup.comments, 2), false)
 assert.equal(countAwaitingAnswers([{...thread,status:'resolved'},{...thread,applicability:'outdated'}]),1)
})

test('an AI clarification question is not an answer and later user replies answer the question',()=>{const comments=[{id:'request',body:'fix'},{id:'question',author:'ai',kind:'question',body:'which?'}];assert.equal(isCommentAnswered(comments,0),false);assert.equal(isAiQuestionAnswered(comments,1),false);comments.push({id:'reply',body:'UTC'});assert.equal(isAiQuestionAnswered(comments,1),true)})

test('a result for an older request cannot consume a newer question',()=>{
 const comments=[{id:'old',body:'old request',fixCompletedAt:'done'},{id:'new',body:'new question'},{id:'report',author:'ai',kind:'fix-result',replyToCommentId:'old'}]
 assert.equal(countAwaitingAnswers([{status:'open',applicability:'current',comments}]),1)
 assert.equal(isCommentAnswered(comments,1),false)
})
