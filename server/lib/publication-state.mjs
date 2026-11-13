// Git evidence is collected by the host, including for read-only AI answer sessions.
export async function publicationState({exec,cwd,branch,gitBinary='git',now=()=>new Date().toISOString()}) {
 const git=async args=>{try{return await exec(gitBinary,args,{cwd,timeout:12000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...(process.env.GIT_SSH_COMMAND?{}:{GIT_SSH_COMMAND:'ssh -o BatchMode=yes'})}})}catch{return{code:1,stdout:'',stderr:''}}};
 const [head,current,status,remote]=await Promise.all([git(['rev-parse','HEAD']),git(['rev-parse','--abbrev-ref','HEAD']),git(['status','--porcelain']),git(['config','--get',`branch.${branch}.remote`])]);
 const localHead=head.code===0&&/^[0-9a-f]{40,64}$/.test(head.stdout.trim())?head.stdout.trim():null,currentBranch=current.code===0?current.stdout.trim():null;
 const changes=status.code===0?status.stdout.trimEnd().split('\n').filter(Boolean):null;
 const remoteName=remote.code===0&&remote.stdout.trim()!=='.'?remote.stdout.trim():'origin',remoteRef=`refs/heads/${branch}`;
 const queried=await git(['ls-remote','--heads','--',remoteName,remoteRef]);
 const remoteHead=queried.code===0?queried.stdout.split('\n').map(line=>line.split(/\s+/)).find(parts=>parts[1]===remoteRef)?.[0]||null:null;
 let headOnRemote=Boolean(localHead&&remoteHead&&localHead===remoteHead);
 if(localHead&&remoteHead&&!headOnRemote)headOnRemote=(await git(['merge-base','--is-ancestor',localHead,remoteHead])).code===0;
 const hasLocalChanges=changes===null?null:changes.length>0;
 const state=hasLocalChanges?'local-changes':hasLocalChanges===false&&headOnRemote?'remote-verified':queried.code===0?'local-commit':'unknown';
 return{state,checkedAt:now(),currentBranch,localHead,hasLocalChanges,localChanges:changes?.slice(0,100)||[],remote:remoteName,remoteRef,remoteHead,remoteChecked:queried.code===0,headOnRemote};
}
export function publicationEvidence(state) {
 if(!state)return ['## 반영 상태 근거','원격 상태를 확인하지 못했다. 로컬 파일 존재만으로 커밋·푸시·GitHub 반영을 주장하지 않는다.',''];
 return ['## 서버가 확인한 반영 상태 (읽기 전용 Git 조회)',`확인 시각: ${state.checkedAt}`,`현재 브랜치: ${state.currentBranch}; 로컬 HEAD: ${state.localHead}`,`미커밋 변경: ${state.hasLocalChanges===null?'확인 실패':state.hasLocalChanges?'있음 — 이 변경은 원격 반영 근거가 없다':'없음'}`,`미커밋 항목: ${JSON.stringify(state.localChanges)}`,`원격: ${state.remote}/${state.remoteRef}; ls-remote 확인: ${state.remoteChecked}; 원격 HEAD: ${state.remoteHead}; 로컬 HEAD 포함 확인: ${state.headOnRemote}`,'위 정보는 조회 시점의 증거다. 로컬 미커밋 파일과 이미 푸시된 커밋을 반드시 구분한다.',''];
}
