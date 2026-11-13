import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultAgentCommands } from '../server/lib/runs.mjs'
test('Codex edit and answer commands use supported explicit sandbox modes', () => {
 const spec=defaultAgentCommands(name=>'/bin/'+name).codex
 const edit=spec.args('/repo with spaces'),answer=spec.answerArgs('/repo with spaces')
 assert.equal(edit.includes('--full-auto'),false)
 assert.equal(edit[edit.indexOf('--sandbox')+1],'workspace-write')
 assert.equal(answer[answer.indexOf('--sandbox')+1],'read-only')
 for(const args of [edit,answer]) {
  assert.equal(args[args.indexOf('-C')+1],'/repo with spaces')
  assert.equal(args.at(-1),'-')
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'),false)
 }
})
