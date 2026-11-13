import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../server/app.mjs'
import { execCommand } from '../server/lib/exec.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(mkdtempSync(join(tmpdir(), 'sr-fix-agent-')), 'agent.mjs')
writeFileSync(fakeAgent, `import {readFileSync} from 'node:fs';const p=readFileSync(0,'utf8');setTimeout(()=>{for(const m of p.matchAll(/### 스레드 \\d+ — (thr_[0-9a-f]+)/g))console.log('- '+m[1]+': 수행 — done');},300);`)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sr-histrepo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.js'), 'const a = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'base')
git(repo, 'checkout', '-q', '-b', 'feat/hist')
writeFileSync(join(repo, 'a.js'), 'const a = 1\nconst b = 2\n')
git(repo, 'commit', '-q', '-am', 'add b')

const pluginRoot = mkdtempSync(join(tmpdir(), 'sr-histplugin-'))
mkdirSync(join(pluginRoot, 'panel'), { recursive: true })
mkdirSync(join(pluginRoot, 'ui', 'lib'), { recursive: true })
writeFileSync(join(pluginRoot, 'panel', 'template.html'), '<!doctype html><html><head></head><body><script>/*__ORCA_SELF_REVIEW_DATA__*/</script></body></html>')
const homeDir = mkdtempSync(join(tmpdir(), 'sr-histhome-'))
let publicationGate = null, publicationReached = null
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) {
      if (args[0] === 'ls-remote' && publicationGate) { publicationReached(); await publicationGate }
      return execCommand(command, args, options)
    }
    if (command.endsWith('orca') && args[0] === 'repo') return { stdout: JSON.stringify({ ok: true, result: { repos: [{ id: 'r1', path: repo, displayName: 'demo', gitRemoteIdentity: null }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'worktree') return { stdout: JSON.stringify({ ok: true, result: { worktrees: [{ id: `r1::${repo}`, repoId: 'r1', path: repo, branch: 'refs/heads/feat/hist', displayName: 'feat/hist' }] } }), stderr: '', code: 0 }
    if (command.endsWith('orca') && args[0] === 'terminal') return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', code: 0 }
    return { stdout: '', stderr: `unexpected ${command} ${args.join(' ')}`, code: 1 }
  }
}
const agentCommands = {
  claude: { command: process.execPath, args: [fakeAgent], answerArgs: [fakeAgent], env: { FAKE_AGENT_ANSWER: '1', FAKE_AGENT_EDIT: join(repo, 'a.js') } },
  codex: { command: process.execPath, args: [fakeAgent], env: {} }
}
const server = createServer({ homeDir, pluginRoot, runners, agentCommands, preferredPort: 0, idleMs: 0, exitImpl: () => {}, bridgeMaintenanceMs: 0, panelDebounceMs: 0 })
await server.listen()
const base = `http://127.0.0.1:${server.port}`
const headers = { 'X-SR-Token': server.token, 'Content-Type': 'application/json' }
const api = async (method, path, body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function finished(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = (await api('GET', `/api/runs/${runId}`)).body.run
    if (run.status !== 'running' && run.status !== 'queued') return run
    await wait(100)
  }
  return null
}

after(async()=>{await server.close()})
test('successful explicit fix reports mark submitted comments, and later replies remain pending',async()=>{
 let current=(await api('POST','/api/sessions',{kind:'local',repoPath:repo,baseRef:'main'})).body
 current=(await api('POST',`/api/sessions/${current.id}/threads`,{revision:current.revision,path:'a.js',side:'new',startLine:2,endLine:2,selectedText:'const b = 2',body:'fix first'})).body
 const id=current.id,thread=current.threads[0]
 const started=await api('POST',`/api/sessions/${id}/runs`,{revision:current.revision,agent:'claude',mode:'fix'})
 assert.equal(started.status,202)
 current=(await api('GET',`/api/sessions/${id}`)).body.session
 await api('POST',`/api/sessions/${id}/threads/${thread.id}/comments`,{revision:current.revision,body:'new followup'})
 await finished(started.body.id)
 current=(await api('GET',`/api/sessions/${id}`)).body.session
 assert.ok(current.threads[0].comments[0].fixCompletedAt)
 const firstResult=current.threads[0].comments.find(c=>c.kind==='fix-result')
 assert.ok(firstResult,'the first fix must save an actual result comment')
 assert.equal(firstResult.replyToCommentId,thread.comments[0].id)
 assert.match(firstResult.body,/done/)

 assert.equal(current.threads[0].comments[1].fixCompletedAt,undefined)
 // The previous fix may rename or delete the original file; the fresh follow-up must still run.
 git(repo,'mv','a.js','replacement.js')
 writeFileSync(join(repo,'replacement.js'),'export const replacement = true\n')
 git(repo,'add','replacement.js')
 git(repo,'commit','-q','-m','replace old implementation')
 current=(await api('GET',`/api/sessions/${id}`)).body.session
 assert.equal(current.threads[0].applicability,'outdated')
 const next=await api('POST',`/api/sessions/${id}/runs`,{revision:current.revision,agent:'claude',mode:'fix'})
 assert.equal(next.status,202)
 const record=(await api('GET',`/api/runs/${next.body.id}`)).body.run
 assert.equal(record.requestedComments.length,1)
 assert.equal(record.requestedComments[0].body,'new followup')
 await finished(next.body.id)
 current=(await api('GET',`/api/sessions/${id}`)).body.session
 const results=current.threads[0].comments.filter(c=>c.kind==='fix-result')
 assert.equal(results.length,2)
 assert.notEqual(results[0].replyToCommentId,results[1].replyToCommentId)
})

test('comments added while a run prepares its prompt survive the start and stay pending',async()=>{
 let s=server.store.getSession(server.store.listSessions().find(s=>s.repoPath===repo).id)
 const t=s.threads[0]
 s=(await api('POST',`/api/sessions/${s.id}/threads/${t.id}/comments`,{revision:s.revision,body:'third request'})).body
 let release, reached
 publicationGate=new Promise(resolve=>{release=resolve})
 const entered=new Promise(resolve=>{reached=resolve});publicationReached=reached
 const preparing=api('POST',`/api/sessions/${s.id}/runs`,{revision:s.revision,agent:'claude',mode:'fix'})
 await entered
 s=(await api('GET',`/api/sessions/${s.id}`)).body.session
 await api('POST',`/api/sessions/${s.id}/threads/${t.id}/comments`,{revision:s.revision,body:'later request while preparing'})
 release();publicationGate=null
 const started=await preparing;assert.equal(started.status,202)
 await finished(started.body.id)
 s=(await api('GET',`/api/sessions/${s.id}`)).body.session
 const later=s.threads[0].comments.find(c=>c.body==='later request while preparing')
 assert.ok(later,'preparing the run must not overwrite a newer comment')
 assert.equal(later.fixCompletedAt,undefined)
})

test('historical results backfill on restart once, without rerunning the agent',async()=>{
 await server.close()
 const session=server.store.listSessions().find(s=>s.repoPath===repo)
 const stored=server.store.getSession(session.id)
 stored.threads[0].comments=stored.threads[0].comments.filter(c=>c.kind!=='fix-result')
 server.store.save(stored)
 for(const run of server.runs.list()){delete run.fixResultsApplied;server.runs.save(run)}
 const restored=createServer({homeDir,pluginRoot,runners,agentCommands,preferredPort:0,idleMs:0,bridgeMaintenanceMs:0,panelDebounceMs:0})
 try{
  await restored.listen()
  const comments=restored.store.getSession(session.id).threads[0].comments
  assert.equal(comments.filter(c=>c.kind==='fix-result').length,3)
  assert.ok(comments.filter(c=>c.kind==='fix-result').every(c=>/done/.test(c.body)))
  assert.ok(restored.runs.list().every(run=>run.fixResultsApplied))
 }finally{await restored.close()}
})
