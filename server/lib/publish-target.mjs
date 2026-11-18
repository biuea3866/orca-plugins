import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {ApiError} from './store.mjs'

// A review of a branch that is not checked out (GitGraph "Self Review" on a branch chip) runs in a detached linked
// worktree. The host names the reviewed branch in that worktree's private git dir; publishing then pushes HEAD to
// the branch on its remote and never creates or moves a local branch.
export const PUBLISH_TARGET_FILE='self-review-publish-target'

export async function detachedPublishTarget({exec,gitBinary='git',cwd}){
 const git=async args=>{try{return await exec(gitBinary,args,{cwd,timeout:12000})}catch{return{code:1,stdout:'',stderr:''}}}
 const located=await git(['rev-parse','--git-path',PUBLISH_TARGET_FILE])
 let ref=''
 if(located.code===0&&located.stdout.trim()){try{ref=(await readFile(resolve(cwd,located.stdout.trim()),'utf8')).trim()}catch{ref=''}}
 if(!ref)throw new ApiError(400,'detached_head','HEAD가 detached 상태이고 게시할 브랜치가 지정되지 않았습니다. 브랜치를 체크아웃한 뒤 커밋하세요.')
 const remotes=(await git(['remote'])).stdout.split('\n').map(name=>name.trim()).filter(Boolean)
 let target=null
 if(ref.startsWith('refs/remotes/')){
  const rest=ref.slice('refs/remotes/'.length),remote=remotes.filter(name=>rest.startsWith(name+'/')).sort((a,b)=>b.length-a.length)[0]
  if(remote)target={remote,branch:rest.slice(remote.length+1)}
 }else if(ref.startsWith('refs/heads/')){
  const branch=ref.slice('refs/heads/'.length),remote=(await git(['config','--get',`branch.${branch}.remote`])).stdout.trim(),merge=(await git(['config','--get',`branch.${branch}.merge`])).stdout.trim()
  if(remote&&remote!=='.'&&merge)target=merge===`refs/heads/${branch}`?{remote,branch}:null
  else if(remotes.includes('origin'))target={remote:'origin',branch}
 }
 if(!target||!target.branch||target.branch==='HEAD'||(await git(['check-ref-format',`refs/heads/${target.branch}`])).code!==0)throw new ApiError(400,'invalid_publish_target',`게시 대상(${ref})을 원격 브랜치로 확인하지 못했습니다. 브랜치를 체크아웃한 뒤 커밋하세요.`)
 return target
}
