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
writeFileSync(fakeAgent, "import {readFileSync} from 'node:fs';\nconst prompt=readFileSync(0,'utf8'),nonce=/응답 코드: (\\S+)/.exec(prompt)[1],id=/### 스레드 \\d+ — (thr_[0-9a-f]+)/.exec(prompt)[1];\nconst block=body=>`@@QUESTION:${id}:${nonce}@@\\n${body}\\n@@END:${nonce}@@\\n`;\nif(process.env.FAKE_AGENT_COMPLETE){console.log('- '+id+': 수행 — user reply applied');process.exit(0)}\nconst one=Buffer.from(block('삭제 시각은 어느 기준으로 저장할까요?'));\nconst split=one.indexOf(Buffer.from('삭제'))+1;\nprocess.stdout.write(one.subarray(0,split));setTimeout(()=>process.stdout.write(one.subarray(split)),80);\nsetTimeout(()=>process.stdout.write(block('삭제 시각은 어느 기준으로 저장할까요?')+block('기존 데이터도 함께 정리할까요?')),300);\nsetTimeout(()=>console.log('- '+id+': 수행 — should not mark fixed while questions remain'),2200);\n")
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
const runners = {
  exec: async (command, args, options) => {
    if (command.endsWith('git')) return execCommand(command, args, options)
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
test('AI fix questions become live comments, preserve multiple questions and are not mistaken for completed fixes',async()=>{
 let current=(await api('POST','/api/sessions',{kind:'local',repoPath:repo,baseRef:'main'})).body
 current=(await api('POST',`/api/sessions/${current.id}/threads`,{revision:current.revision,path:'a.js',side:'new',startLine:2,endLine:2,selectedText:'const b = 2',body:'삭제 로직 수정해줘'})).body
 const sessionId=current.id,threadId=current.threads[0].id
 const started=await api('POST',`/api/sessions/${sessionId}/runs`,{revision:current.revision,agent:'claude',mode:'fix'})
 assert.equal(started.status,202)
 let questions=[]
 for(let i=0;i<15;i++){current=(await api('GET',`/api/sessions/${sessionId}`)).body.session;questions=current.threads[0].comments.filter(c=>c.kind==='question');if(questions.length===2)break;await wait(100)}
 assert.equal(questions.length,2)
 assert.equal((await api('GET',`/api/runs/${started.body.id}`)).body.run.status,'running','questions are visible before the CLI exits')
 assert.equal(questions[0].body,'삭제 시각은 어느 기준으로 저장할까요?','split UTF-8 remains intact')
 await finished(started.body.id)
 current=(await api('GET',`/api/sessions/${sessionId}`)).body.session
 assert.equal(current.threads[0].comments.filter(c=>c.kind==='question').length,2,'stream replay and final parse do not duplicate questions')
 assert.equal(current.threads[0].comments[0].fixCompletedAt,undefined,'asking a user question is not completed work')
 const run=(await api('GET',`/api/runs/${started.body.id}`)).body.run;assert.equal(run.questionCount,2)
 const reply=await api('POST',`/api/sessions/${sessionId}/threads/${threadId}/comments`,{revision:current.revision,body:'UTC 기준으로 하고 기존 데이터는 유지해'})
 assert.equal(reply.status,200);assert.equal(reply.body.threads[0].comments.at(-1).body,'UTC 기준으로 하고 기존 데이터는 유지해')
 agentCommands.claude.env.FAKE_AGENT_COMPLETE='1'
 const resumed=await api('POST',`/api/sessions/${sessionId}/runs`,{revision:reply.body.revision,agent:'claude',mode:'fix'});assert.equal(resumed.status,202)
 const prompt=readFileSync(join(server.runs.runDir(resumed.body.id),'prompt.md'),'utf8');assert.match(prompt,/UTC 기준으로 하고 기존 데이터는 유지해/);assert.match(prompt,/AI 확인 질문 · 문맥/)
 await finished(resumed.body.id)
 current=(await api('GET',`/api/sessions/${sessionId}`)).body.session;assert.ok(current.threads[0].comments[0].fixCompletedAt);assert.ok(current.threads[0].comments.find(c=>c.body==='UTC 기준으로 하고 기존 데이터는 유지해').fixCompletedAt);assert.equal(current.threads[0].comments.filter(c=>c.kind==='question').length,2)

})
