// Local commits are performed by the server, never by the editing agent.
import {runPublishChecks} from './pre-publish-checks.mjs'
import {defaultCommitMessage} from './commit-message.mjs'
import {existsSync} from 'node:fs'
import {isAbsolute,resolve} from 'node:path'
import {ApiError} from './store.mjs'
import {fingerprintPaths} from './runs.mjs'

export async function commitFixRun({exec,gitBinary='git',run,session,checksOptions}){
 const refuse=message=>{throw new ApiError(400,'commit_refused',message)}
 if(run.mode!=='fix'||run.status!=='succeeded')refuse('Only a successful AI fix can be committed.')
 if(!run.cwd||run.cwd!==session.repoPath)refuse('The review worktree changed.')
 const paths=[...new Set(run.changedFiles??[])];if(!paths.length)return {skipped:'no-changes'}
 const scope=new Set(run.reviewPaths??[]);if(run.autoCommit&&!scope.size)refuse('리뷰 대상 파일 정보를 확인할 수 없어 자동 커밋을 중단했습니다.')
 const outside=scope.size?paths.filter(path=>!scope.has(path)):[];if(outside.length)refuse(`코멘트 대상 외 파일이 수정되어 자동 커밋을 중단했습니다: ${outside.join(', ')}`)
 for(const path of paths)if(typeof path!=='string'||!path||isAbsolute(path)||path.split(/[\\/]/).some(p=>p==='..'||p.toLowerCase()==='.git')||!resolve(run.cwd,path).startsWith(resolve(run.cwd)+'/'))refuse('Invalid changed file path.')
 const git=async(args)=>{const result=await exec(gitBinary,args,{cwd:run.cwd,timeout:60000});if(result.code!==0)throw new ApiError(400,'commit_failed',(result.stderr||result.stdout||'Git command failed').trim().slice(0,2000));return result.stdout.trim()}
 const head=await git(['rev-parse','HEAD']),branch=await git(['symbolic-ref','--quiet','--short','HEAD'])
 if(run.committed?.commit===head)return run.committed
 if(!run.headBefore||head!==run.headBefore||branch!==run.branchBefore||branch!==session.branch)refuse('HEAD or the branch changed since this AI fix. Review the changes before committing.')
 if((await git(['ls-files','--unmerged','-z'])))refuse('Resolve the current merge conflicts before committing.')
 for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'])if(existsSync(resolve(run.cwd,await git(['rev-parse','--git-path',name]))))refuse('Finish the current Git operation before committing.')
 const current=fingerprintPaths(run.cwd,paths)
 for(const path of paths){
  if(Object.hasOwn(run.fingerprintsBefore??{},path))refuse(`AI edited a file that already had local changes: ${path}. Commit it separately after review.`)
  if(!Object.hasOwn(run.fingerprintsAfter??{},path)||current[path]!==run.fingerprintsAfter[path])refuse(`The file changed after the AI fix: ${path}. Review it before committing.`)
 }
 const checks=await runPublishChecks({exec,cwd:run.cwd,paths,...checksOptions})
 if(await git(['rev-parse','HEAD'])!==head || await git(['symbolic-ref','--quiet','--short','HEAD'])!==branch)refuse('HEAD or the branch changed during validation.')
 const afterChecks=fingerprintPaths(run.cwd,paths)
 for(const path of paths)if(afterChecks[path]!==current[path])refuse(`The file changed during validation: ${path}. Review it before committing.`)
 // --only keeps unrelated staged entries out of the commit and preserves them.
 await git(['--literal-pathspecs','add','-A','--',...paths])
 await git(['--literal-pathspecs','commit','--only','-m',defaultCommitMessage(branch,paths,run.commitMessage),'-m',`Local Self Review ${run.id} (${run.agent})`,'--',...paths])
 const commit=await git(['rev-parse','HEAD']);return {commit,branch,paths,checks}
}
