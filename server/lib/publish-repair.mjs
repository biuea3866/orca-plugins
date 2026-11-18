import {existsSync,readFileSync} from 'node:fs'
import {isAbsolute,join,relative,resolve,sep} from 'node:path'
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
  repoPath:root,
  dirs:moduleDirsOfStep(step).map(dir=>relative(root,resolve(dir)).split(sep).join('/')),
  files:new Set(selectedPaths)
 }
}

// Files that decide what "passing" means: a repair that edits them changes the rule, not the code. A file the user
// explicitly selected for publication is theirs to change.
const PROTECTED=[
 /(^|\/)(build|settings)\.gradle(\.kts)?$/,
 /(^|\/)gradle\//,
 /(^|\/)gradlew(\.bat)?$/,
 /(^|\/)libs\.versions\.toml$/,
 /(^|\/)detekt[^/]*\.ya?ml$/i,
 /(^|\/)[^/]*baseline[^/]*\.xml$/i,
 /^\.github\//
]

export function assertRepairScope(scope,changedFiles){
 const problems=[]
 for(const path of changedFiles){
  if(typeof path!=='string'||!path||isAbsolute(path)||path.split('/').includes('..')){problems.push(`${path} (유효하지 않은 경로)`);continue}
  const selected=scope.files.has(path)
  if(!selected&&!scope.dirs.some(dir=>dir===''||path===dir||path.startsWith(dir+'/'))){problems.push(`${path} (실패한 모듈 밖)`);continue}
  if(!selected&&PROTECTED.some(pattern=>pattern.test(path))){problems.push(`${path} (빌드·detekt 설정 파일)`);continue}
  if(!existsSync(join(scope.repoPath,path)))problems.push(`${path} (삭제됨)`)
 }
 if(problems.length)throw new ApiError(409,'repair_out_of_scope',`AI 수정이 허용 범위를 벗어나 자동 수정을 중단했습니다: ${problems.join(', ')}. 변경은 작업 트리에 남아 있으니 확인하세요. 커밋·푸시하지 않았습니다.`,{files:problems})
}

/** Changes to files that were already dirty before the repair and that the user did not select: those are the user's own work. */
export function assertNoForeignChanges({changed,dirtyBefore,selected}){
 const chosen=new Set(selected),dirty=new Set(dirtyBefore)
 const foreign=changed.filter(path=>dirty.has(path)&&!chosen.has(path))
 if(foreign.length)throw new ApiError(409,'repair_out_of_scope',`AI가 선택하지 않은 미커밋 파일을 수정해 자동 수정을 중단했습니다: ${foreign.join(', ')}. 변경은 작업 트리에 남아 있으니 확인하세요. 커밋·푸시하지 않았습니다.`,{files:foreign})
}

const SUPPRESSION=/@Suppress(Warnings)?\b|@Disabled\b|@Ignore\b|detekt:\s*(disable|suppress)|\bx(it|test|describe)\(|enabled\s*=\s*false/

/** Files where a repair added a suppression, a disabled test or a skipped spec (lines added versus HEAD, or a new file). */
export async function findAddedSuppressions({exec,gitBinary='git',cwd,files}){
 if(!files.length)return[]
 const run=async args=>{const result=await exec(gitBinary,args,{cwd,timeout:60000});if(result.code!==0)throw new ApiError(500,'git_failed',(result.stderr||result.stdout||'git failed').trim());return result.stdout}
 const found=new Set()
 let current=null
 for(const line of (await run(['--literal-pathspecs','diff','HEAD','-U0','--no-ext-diff','--no-textconv','--',...files])).split('\n')){
  const header=/^\+\+\+ b\/(.+)$/.exec(line)
  if(header){current=header[1];continue}
  if(current&&line.startsWith('+')&&!line.startsWith('+++')&&SUPPRESSION.test(line))found.add(current)
 }
 const untracked=(await run(['--literal-pathspecs','ls-files','--others','--exclude-standard','-z','--',...files])).split('\0').filter(Boolean)
 for(const path of untracked)try{if(SUPPRESSION.test(readFileSync(join(cwd,path),'utf8')))found.add(path)}catch{/* unreadable: not a suppression */}
 return[...found]
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
   let outcome
   try{outcome=await repair({round:repairs.length+1,failure,paths:[...known]})}
   catch(repairError){
    // The check failure and the earlier repairs explain why this repair was attempted: keep them on the error.
    if(repairError instanceof ApiError)repairError.extra={...repairError.extra,failedStep:{kind:failure.kind,tasks:failure.tasks},repairs}
    throw repairError
   }
   repairs.push({round:repairs.length+1,runId:outcome.runId,changedFiles:outcome.changedFiles,failedStep:{kind:failure.kind,tasks:failure.tasks}})
   for(const file of outcome.changedFiles)known.add(file)
   attempt=()=>retry([...known])
  }
 }
}
