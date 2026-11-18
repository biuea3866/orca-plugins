import {isAbsolute,relative,resolve,sep} from 'node:path'
import {ApiError} from './store.mjs'
import {moduleDirsOfStep} from './pre-publish-checks.mjs'

// "Fix and retry": when detekt or the tests reject a publication, an AI run repairs the failure and the same
// publication (checks → commit → push) is attempted again. Nothing is committed before the checks pass, so a repair
// is only ever a working-tree edit; it is bounded by a round limit and by the failed modules.

export const MAX_REPAIR_ROUNDS=2

export function failedStepOf(checks){
 return checks?.steps?.find(step=>step.status==='failed')??null
}

/** Directories (relative to the repository) and exact files a repair is allowed to change. */
export function repairScope({repoPath,step,selectedPaths=[]}){
 const root=resolve(repoPath)
 return{
  dirs:moduleDirsOfStep(step).map(dir=>relative(root,resolve(dir)).split(sep).join('/')),
  files:new Set(selectedPaths)
 }
}

export function assertRepairScope(scope,changedFiles){
 const outside=changedFiles.filter(path=>{
  if(typeof path!=='string'||!path||isAbsolute(path)||path.split('/').includes('..'))return true
  if(scope.files.has(path))return false
  return!scope.dirs.some(dir=>dir===''||path===dir||path.startsWith(dir+'/'))
 })
 if(outside.length)throw new ApiError(409,'repair_out_of_scope',`AI가 실패한 모듈 밖의 파일을 수정해 자동 수정을 중단했습니다: ${outside.join(', ')}. 변경은 작업 트리에 남아 있으니 확인하세요. 커밋·푸시하지 않았습니다.`,{files:outside})
}

/**
 * @param first   () => result          the publication the user asked for
 * @param retry   (paths) => result     the same publication again, over these paths
 * @param repair  ({round,failure,paths}) => {runId,changedFiles}   throws an ApiError to abort
 */
export async function publishWithRepair({first,retry,paths,repair,maxRounds=MAX_REPAIR_ROUNDS}){
 const known=new Set(paths),repairs=[]
 let attempt=first
 for(;;){
  try{
   return{...await attempt(),repairs}
  }catch(error){
   const failure=error?.code==='pre_publish_checks_failed'?failedStepOf(error.extra?.checks):null
   if(!failure||repairs.length>=maxRounds){
    if(repairs.length&&error&&typeof error==='object')error.extra={...error.extra,repairs}
    throw error
   }
   const outcome=await repair({round:repairs.length+1,failure,paths:[...known]})
   repairs.push({round:repairs.length+1,runId:outcome.runId,changedFiles:outcome.changedFiles,failedStep:{kind:failure.kind,tasks:failure.tasks}})
   for(const file of outcome.changedFiles)known.add(file)
   attempt=()=>retry([...known])
  }
 }
}
