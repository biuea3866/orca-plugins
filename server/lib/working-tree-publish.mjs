import {createHash} from 'node:crypto'
import {ApiError} from './store.mjs'
import {publishRun} from './publish.mjs'
import {defaultCommitMessage,validateCommitMessage} from './commit-message.mjs'

export async function previewWorkingTree({exec,gitBinary='git',session}) {
 if(!session.repoPath)throw new ApiError(400,'worktree_missing','로컬 작업 트리가 없습니다.')
 const git=async args=>{const r=await exec(gitBinary,args,{cwd:session.repoPath,timeout:60000});if(r.code!==0)throw new ApiError(400,'git_failed',(r.stderr||r.stdout).trim());return r.stdout}
 const [head,branch,tracked,untracked,diff,index]=await Promise.all([
  git(['rev-parse','HEAD']),git(['rev-parse','--abbrev-ref','HEAD']),git(['diff','--name-only','--no-renames','-z','HEAD','--']),
  git(['ls-files','--others','--exclude-standard','-z']),git(['diff','--binary','--no-ext-diff','--no-textconv','HEAD','--']),git(['diff','--cached','--binary','--no-ext-diff','--no-textconv','--'])
 ])
 if(branch.trim()!==session.branch)throw new ApiError(409,'branch_mismatch','리뷰 브랜치와 현재 체크아웃 브랜치가 다릅니다.')
 const newPaths=untracked.split('\0').filter(Boolean),paths=[...new Set([...tracked.split('\0'),...newPaths].filter(Boolean))].sort()
 const hashes=newPaths.length?await git(['hash-object','--no-filters','--',...newPaths]):''
 const snapshot=createHash('sha256').update(JSON.stringify({head,branch,tracked,untracked,diff,index,hashes})).digest('hex')
 const retryCommit=session.lastPublishError?.commit===head.trim()?head.trim():null
 return {branch:branch.trim(),head:head.trim(),paths:retryCommit?[]:paths,remainingPaths:retryCommit?paths:[],snapshot,retryCommit,message:defaultCommitMessage(branch.trim(),paths,retryCommit?session.lastPublishError.commitMessage:undefined)}
}

export async function publishWorkingTree({exec,gitBinary='git',session,selection,checksOptions}) {
 const preview=await previewWorkingTree({exec,gitBinary,session})
 if(!selection?.snapshot||preview.snapshot!==selection.snapshot)throw new ApiError(409,'publication_changed','미커밋 변경이 달라졌습니다. 파일 목록과 메시지를 다시 확인하세요.')
 const message=validateCommitMessage(selection.message,session.branch)
 const paths=Array.isArray(selection.paths)?[...new Set(selection.paths)]:[]
 if(paths.some(path=>!preview.paths.includes(path)))throw new ApiError(400,'invalid_paths','현재 미커밋 파일만 선택할 수 있습니다.')
 if(!paths.length&&!preview.retryCommit)throw new ApiError(400,'nothing_to_commit','커밋할 파일을 선택하세요.')
 const run={id:'working-tree',mode:'fix',status:'succeeded',cwd:session.repoPath,branch:session.branch,threadIds:[],changedFiles:preview.retryCommit?session.lastPublishError.paths:paths,...(preview.retryCommit?{publishError:{commit:preview.retryCommit}}:{})}
 return publishRun({exec,gitBinary,session,run,message,checksOptions,expectedHead:preview.head,validateBeforeCommit:async()=>{
  const current=await previewWorkingTree({exec,gitBinary,session})
  if(current.snapshot!==selection.snapshot)throw new ApiError(409,'publication_changed','커밋 준비 중 파일이 변경됐습니다. 다시 확인하세요.')
 }})
}
