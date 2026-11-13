import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from '../server/app.mjs'
test('active run list identifies original branch and hides finished runs, prompts and logs',async()=>{
 const homeDir=mkdtempSync(join(tmpdir(),'sr-active-runs-'))
 const server=createServer({homeDir,pluginRoot:homeDir,preferredPort:0,idleMs:0,enrichEnvironment:false,bridgeMaintenanceMs:0,panelStaleCheckMs:0,runners:{exec:async()=>({code:0,stdout:'{"ok":true,"result":{"repos":[],"worktrees":[],"terminals":[]}}',stderr:''})}})
 await server.listen()
 try{
  const session=server.store.createSession({kind:'local',repoPath:'/repo/app',repoDisplayName:'App',branch:'new-branch',baseRef:'main'})
  for(const [suffix,status]of [['111111111111','running'],['222222222222','queued'],['333333333333','succeeded']]){mkdirSync(server.runs.runDir('run_'+suffix),{recursive:true});server.runs.save({id:'run_'+suffix,sessionId:session.id,status,branch:'feat/original',cwd:'/repo/app',agent:'codex',mode:'fix',startedAt:'2026-11-12T07:00:00Z',prompt:'private',threadSnapshots:['private'],pid:process.pid})}
  const response=await fetch(`http://127.0.0.1:${server.port}/api/runs`,{headers:{'X-SR-Token':server.token}})
  assert.equal(response.status,200)
  const {runs}=await response.json()
  assert.equal(runs.length,2)
  for(const run of runs){assert.equal(run.branch,'feat/original');assert.equal(run.repoDisplayName,'App');assert.equal(run.sessionId,session.id);assert.equal(run.prompt,undefined);assert.equal(run.threadSnapshots,undefined);assert.equal(run.pid,undefined)}
  server.runs.save({...server.runs.get(runs[0].id),status:'failed'})
  const after=await fetch(`http://127.0.0.1:${server.port}/api/runs`,{headers:{'X-SR-Token':server.token}})
  assert.equal((await after.json()).runs.length,1)
 }finally{await server.close()}
})

test('a finished agent remains active while its automatic commit is being validated',async()=>{
 const homeDir=mkdtempSync(join(tmpdir(),'sr-active-commit-')),server=createServer({homeDir,pluginRoot:homeDir,preferredPort:0,idleMs:0,enrichEnvironment:false,bridgeMaintenanceMs:0,panelStaleCheckMs:0,runners:{exec:async()=>({code:1,stdout:'',stderr:'fixture unavailable'})}})
 await server.listen()
 try{
  const session=server.store.createSession({kind:'local',repoPath:'/repo/app',branch:'feat/review',baseRef:'main'}),id='run_111111111111';mkdirSync(server.runs.runDir(id),{recursive:true});server.runs.save({id,sessionId:session.id,status:'succeeded',committing:true,branch:'feat/review',cwd:'/repo/app',agent:'codex',mode:'fix',startedAt:'2026-11-13T00:00:00Z',pid:process.pid})
  const data=await(await fetch(`http://127.0.0.1:${server.port}/api/runs`,{headers:{'X-SR-Token':server.token}})).json();assert.equal(data.runs.length,1);assert.equal(data.runs[0].status,'running')
 }finally{await server.close()}
})
