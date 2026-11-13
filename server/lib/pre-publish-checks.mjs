import {existsSync,readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {join,dirname,resolve,relative,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {ApiError} from './store.mjs'

const buildFile=dir=>['build.gradle.kts','build.gradle'].find(name=>existsSync(join(dir,name)))
const inside=(root,path)=>path===root||path.startsWith(root+sep)
function javaVersion(root){
 const build=buildFile(root),text=build?readFileSync(join(root,build),'utf8'):''
 const pin=/jvmToolchain\(\s*(\d+)\s*\)|JavaLanguageVersion\.of\(\s*(\d+)\s*\)|JavaVersion\.VERSION_(\d+)/.exec(text)
 if(pin)return pin.slice(1).find(Boolean)
 const guide=join(root,'AGENTS.md')
 return existsSync(guide)?/\b(?:JVM|JDK)\s*\*{0,2}(\d+)/.exec(readFileSync(guide,'utf8'))?.[1]||null:null
}
export function planPublishChecks(cwd,paths){
 const repo=resolve(cwd),roots=new Map()
 for(const path of paths){
  const absolute=resolve(repo,path)
  if(!inside(repo,absolute))throw new ApiError(400,'invalid_paths','저장소 밖의 파일은 검증할 수 없습니다.')
  let cursor=dirname(absolute),root=null
  while(inside(repo,cursor)){
   if(['settings.gradle.kts','settings.gradle'].some(name=>existsSync(join(cursor,name)))){
    if(!existsSync(join(cursor,'gradlew')))throw new ApiError(400,'pre_publish_checks_unsupported',`${cursor}: Gradle wrapper가 없어 검증할 수 없습니다.`)
    root=cursor;break
   }
   if(cursor===repo)break
   cursor=dirname(cursor)
  }
  if(!root){if(/\.(kt|kts|java)$/.test(path))throw new ApiError(400,'pre_publish_checks_unsupported',`${path}: 검증할 Gradle wrapper를 찾지 못했습니다.`);continue}
  let module=dirname(absolute)
  while(module!==root&&!buildFile(module))module=dirname(module)
  const prefix=module===root?'':':'+relative(root,module).split(sep).join(':')
  const entry=roots.get(root)||{cwd:root,modules:new Set(),javaVersion:javaVersion(root)}
  entry.modules.add(prefix);roots.set(root,entry)
 }
 const steps=[]
 for(const kind of ['detekt','test'])for(const entry of roots.values()){
  const modules=entry.modules.has('')?['']:[...entry.modules].sort()
  steps.push({cwd:entry.cwd,command:join(entry.cwd,'gradlew'),javaVersion:entry.javaVersion,kind,tasks:modules.map(prefix=>prefix?`${prefix}:${kind}`:kind)})
 }
 return steps
}

const INIT_SCRIPT=`gradle.afterProject { p ->
 p.tasks.configureEach { t ->
  if (t.name.startsWith('detekt') && t.hasProperty('autoCorrect')) t.autoCorrect = false
  if (t instanceof org.gradle.api.tasks.testing.Test) {
   t.outputs.upToDateWhen { false }
   t.outputs.cacheIf { false }
  }
 }
}
`
export async function runPublishChecks({exec,cwd,paths,logDir,onUpdate=()=>{},resolveJavaHome,now=()=>new Date().toISOString()}){
 const plan=planPublishChecks(cwd,paths),state={status:plan.length?'running':'not_applicable',startedAt:now(),endedAt:null,reason:plan.length?null:'변경 파일에 Gradle 검증 대상이 없습니다.',steps:plan.map(step=>({...step,status:'queued',exitCode:null,log:''}))}
 await onUpdate(state)
 if(!plan.length){state.endedAt=now();await onUpdate(state);return state}
 if(logDir)mkdirSync(logDir,{recursive:true,mode:0o700})
 const directory=mkdtempSync(join(logDir||tmpdir(),'publish-checks-')),init=join(directory,'checks.gradle')
 writeFileSync(init,INIT_SCRIPT,{mode:0o600})
 const javaHomes=new Map()
 try{
  for(const [index,step] of state.steps.entries()){
   step.status='running';step.startedAt=now();await onUpdate(state)
   let result
   try{
    if(step.javaVersion&&!javaHomes.has(step.javaVersion)){
     if(resolveJavaHome)javaHomes.set(step.javaVersion,await resolveJavaHome(step.javaVersion))
     else if(process.platform==='darwin'){
      const java=await exec('/usr/libexec/java_home',['-v',step.javaVersion],{cwd:step.cwd,timeout:10000})
      if(java.code!==0||!java.stdout.trim())throw Error(`JDK ${step.javaVersion} 경로 확인 실패: ${java.stderr||java.stdout}`)
      javaHomes.set(step.javaVersion,java.stdout.trim())
     }
    }
    const home=javaHomes.get(step.javaVersion)
    result=await exec(step.command,[...step.tasks,'--init-script',init,'--console=plain'],{cwd:step.cwd,timeout:30*60*1000,env:{...process.env,...(home?{JAVA_HOME:home}:{})}})
   }catch(error){result={code:1,stdout:'',stderr:error.message}}
   const output=String(result.stdout||'')+String(result.stderr||'')
   step.log=output.slice(-20000);step.exitCode=result.code;step.endedAt=now();step.status=result.code===0?'passed':'failed'
   const file=join(directory,`${index+1}-${step.kind}.log`);writeFileSync(file,output,{mode:0o600});if(logDir)step.logPath=file
   await onUpdate(state)
   if(result.code!==0){state.status='failed';state.endedAt=now();await onUpdate(state);throw new ApiError(400,'pre_publish_checks_failed',`${step.tasks.join(' ')} 검증 실패 (exit ${result.code}). 커밋·푸시하지 않았습니다.`,{checks:state})}
  }
  state.status='passed';state.endedAt=now();await onUpdate(state);return state
 }finally{if(!logDir)rmSync(directory,{recursive:true,force:true})}
}
