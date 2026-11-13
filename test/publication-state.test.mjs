import test from 'node:test';import assert from 'node:assert/strict';
import {publicationState,publicationEvidence} from '../server/lib/publication-state.mjs';
const head='a'.repeat(40),other='b'.repeat(40);
function runner({dirty='',remote=head,failRemote=false}={}){return async(_command,args)=>{let stdout='';if(args[0]==='status')stdout=dirty;if(args[0]==='rev-parse')stdout=args.includes('--abbrev-ref')?'feat/x':head;if(args[0]==='config')stdout='origin';if(args[0]==='ls-remote')return {code:failRemote?1:0,stdout:remote?`${remote}\trefs/heads/feat/x\n`:'',stderr:''};if(args[0]==='merge-base')return {code:1,stdout:'',stderr:''};return {code:0,stdout,stderr:''}}}
test('matching remote HEAD never makes dirty working-tree changes published',async()=>{
 const state=await publicationState({exec:runner({dirty:' M Entity.kt\n'}),cwd:'/repo',branch:'feat/x'});
 assert.equal(state.hasLocalChanges,true);assert.equal(state.headOnRemote,true);assert.equal(state.state,'local-changes');assert.match(publicationEvidence(state).join('\n'),/미커밋/);
});
test('remote publication requires a fresh remote comparison, not a tracking ref',async()=>{
 const verified=await publicationState({exec:runner(),cwd:'/repo',branch:'feat/x'});assert.equal(verified.state,'remote-verified');assert.equal(verified.remoteHead,head);
 const ahead=await publicationState({exec:runner({remote:other}),cwd:'/repo',branch:'feat/x'});assert.equal(ahead.headOnRemote,false);assert.notEqual(ahead.state,'remote-verified');
 const failed=await publicationState({exec:runner({failRemote:true}),cwd:'/repo',branch:'feat/x'});assert.equal(failed.remoteChecked,false);assert.equal(failed.headOnRemote,false);
});
