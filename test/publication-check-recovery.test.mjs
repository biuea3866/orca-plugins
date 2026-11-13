import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from '../server/app.mjs'
test('a server restart marks an unfinished pre-publish check interrupted instead of leaving a permanent running state',async()=>{
 const homeDir=mkdtempSync(join(tmpdir(),'publication-recover-'))
 const server=createServer({homeDir,pluginRoot:fileURLToPath(new URL('../',import.meta.url)),panelRoot:join(homeDir,'panel'),preferredPort:0,idleMs:0,enrichEnvironment:false,bridgeMaintenanceMs:0,panelStaleCheckMs:0,runners:{exec:async()=>({code:1,stdout:'',stderr:'fixture unavailable'})}})
 const s=server.store.createSession({kind:'local',repoPath:homeDir,branch:'feat/checks',baseRef:'main'})
 s.publishChecks={status:'running',startedAt:'2026-11-13T00:00:00Z',steps:[{kind:'test',tasks:['test'],status:'running',log:'interrupted output'}]};server.store.save(s)
 try{await server.listen();const checks=server.store.getSession(s.id).publishChecks;assert.equal(checks.status,'interrupted');assert.equal(checks.steps[0].status,'interrupted');assert.ok(checks.endedAt)}finally{await server.close()}
})
