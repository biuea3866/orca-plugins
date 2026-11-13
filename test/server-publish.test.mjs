import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { publishRun } from '../server/lib/publish.mjs'
import { execCommand } from '../server/lib/exec.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// A local bare repository stands in for GitHub: nothing here talks to the network.
function makeRepos({ branch = 'feat/pub', upstream = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sr-pub-')))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, work)
  git(work, 'config', 'user.name', 't')
  git(work, 'config', 'user.email', 't@t')
  writeFileSync(join(work, 'a.js'), 'const a = 1\n')
  writeFileSync(join(work, 'other.txt'), 'mine\n')
  writeFileSync(join(work, 'staged.txt'), 'base\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  git(work, 'checkout', '-q', '-b', branch)
  if (upstream) git(work, 'push', '-q', '-u', 'origin', branch)
  return { root, remote, work, branch }
}

const baseRun = (work, extra = {}) => ({ id: 'run_000000000001', mode: 'fix', status: 'succeeded', agent: 'claude', cwd: work, threadIds: ['thr_a', 'thr_b'], changedFiles: ['a.js', 'new.txt'], ...extra })

function recording() {
  const calls = []
  return { calls, exec: async (command, args, options) => { calls.push(args); return execCommand(command, args, options) } }
}

function dirty(work) {
  writeFileSync(join(work, 'a.js'), 'const a = 2\n') // the AI edit
  writeFileSync(join(work, 'new.txt'), 'created by the AI\n') // an untracked file the AI created
  writeFileSync(join(work, 'other.txt'), 'my own uncommitted work\n') // not part of the run
  writeFileSync(join(work, 'staged.txt'), 'staged by me\n')
  git(work, 'add', 'staged.txt') // already staged, not part of the run
}

test('commits only the files the run changed and pushes to the branch upstream', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  const { calls, exec } = recording()
  const result = await publishRun({ exec, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } })
  assert.equal(result.branch, branch)
  assert.equal(result.commit, git(work, 'rev-parse', 'HEAD'))
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit, 'the commit reached the remote')
  assert.deepEqual(git(work, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['a.js', 'new.txt'], 'only the run files are in the commit')
  const message = git(work, 'log', '-1', '--format=%B')
  assert.match(message, /run_000000000001/)
  assert.match(message, /2/, 'the thread count is in the message')
  assert.equal(git(work, 'diff', '--name-only'), 'other.txt', 'my own uncommitted file is still modified and not staged')
  assert.equal(git(work, 'diff', '--cached', '--name-only'), 'staged.txt', 'my own staged file stays staged and uncommitted')
  assert.equal(result.upstreamSet, false)
  const pushes = calls.filter((args) => args.includes('push'))
  assert.equal(pushes.length, 1)
  assert.ok(!pushes[0].some((arg) => /^(-f|--force.*|\+.*)$/.test(arg)), 'never a forced push')
})

test('a branch without an upstream is pushed to origin with tracking set up', async () => {
  const { remote, work, branch } = makeRepos({ branch: 'feat/fresh', upstream: false })
  dirty(work)
  const result = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } })
  assert.equal(result.upstreamSet, true)
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), result.commit)
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), `origin/${branch}`)
})

test('shared branches are refused before anything is committed', async () => {
  const { work } = makeRepos()
  git(work, 'checkout', '-q', 'main')
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch: 'main' } }), (error) => error.code === 'protected_branch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head)
})

test('refuses when the worktree is no longer on the session branch', async () => {
  const { work } = makeRepos()
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch: 'feat/something-else' } }), (error) => error.code === 'branch_mismatch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head)
})

test('only a finished fix run with changed files that was not published yet can be published', async () => {
  const { work, branch } = makeRepos()
  dirty(work)
  const session = { repoPath: work, branch }
  const refused = async (run) => assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run, session }), (error) => error.code === 'not_publishable')
  await refused(baseRun(work, { mode: 'answer' }))
  await refused(baseRun(work, { status: 'failed' }))
  await refused(baseRun(work, { status: 'running' }))
  await refused(baseRun(work, { changedFiles: [] }))
  await refused(baseRun(work, { published: { commit: 'abc', branch, at: 'x' } }))
})

test('a failed push keeps the local commit and reports it', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  rmSync(remote, { recursive: true, force: true })
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } }), (error) => {
    assert.equal(error.code, 'push_failed')
    assert.equal(error.extra?.commit, git(work, 'rev-parse', 'HEAD'), 'the commit stays and is reported so it can be pushed by hand')
    return true
  })
})

test('a push that failed can be retried without making a second commit', async () => {
  const { remote, work, branch } = makeRepos()
  dirty(work)
  git(work, 'remote', 'set-url', 'origin', join(work, 'no-such-remote.git'))
  const session = { repoPath: work, branch }
  const failure = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session }).catch((error) => error)
  assert.equal(failure.code, 'push_failed')
  const commit = failure.extra.commit
  git(work, 'remote', 'set-url', 'origin', remote)
  const retried = await publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work, { publishError: { commit } }), session })
  assert.equal(retried.commit, commit)
  assert.equal(git(work, 'rev-parse', 'HEAD'), commit, 'no extra commit was made')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), commit)
})

test('a branch that tracks a differently named upstream (for example main) is refused before committing', async () => {
  const { work, branch } = makeRepos()
  git(work, 'branch', '--set-upstream-to=origin/main', branch)
  dirty(work)
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work), session: { repoPath: work, branch } }), (error) => error.code === 'upstream_mismatch')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'nothing was committed')
})

test('paths are taken literally, so a changed file named like a glob cannot pull in other files', async () => {
  const { work, branch } = makeRepos()
  writeFileSync(join(work, 'a.js'), 'const a = 3\n')
  writeFileSync(join(work, 'b.js'), 'not part of the run\n')
  const head = git(work, 'rev-parse', 'HEAD')
  await assert.rejects(publishRun({ exec: execCommand, gitBinary: 'git', run: baseRun(work, { changedFiles: ['*.js'] }), session: { repoPath: work, branch } }), 'a pathspec that matches no real file is an error, not a glob')
  assert.equal(git(work, 'ls-files', 'b.js'), '', 'b.js was never added')
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'nothing was committed')
})

test('a fix already committed locally is pushed without creating another commit',async()=>{
 const {remote,work,branch}=makeRepos();dirty(work);git(work,'add','a.js','new.txt');git(work,'commit','--only','-qm','local review','--','a.js','new.txt');const commit=git(work,'rev-parse','HEAD');const {calls,exec}=recording();
 const result=await publishRun({exec,run:baseRun(work,{committed:{commit,branch}}),session:{repoPath:work,branch}});assert.equal(result.commit,commit);assert.equal(git(remote,'rev-parse',`refs/heads/${branch}`),commit);assert.equal(calls.filter(args=>args.includes('commit')).length,0);assert.equal(git(work,'diff','--cached','--name-only'),'staged.txt');
});
test('already-staged deletions and replacement files publish without touching unrelated index entries',async()=>{
 const {work,remote,branch}=makeRepos();git(work,'rm','a.js');writeFileSync(join(work,'replacement.js'),'replacement\n');writeFileSync(join(work,'staged.txt'),'user staged\n');git(work,'add','staged.txt');writeFileSync(join(work,'other.txt'),'user dirty\n');const stagedBefore=git(work,'ls-files','--stage','staged.txt');
 const result=await publishRun({exec:execCommand,gitBinary:'git',run:baseRun(work,{changedFiles:['a.js','replacement.js']}),session:{repoPath:work,branch}});
 assert.deepEqual(git(work,'diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n'),['a.js','replacement.js']);assert.equal(git(work,'ls-files','--stage','staged.txt'),stagedBefore);assert.equal(git(work,'diff','--cached','--name-only'),'staged.txt');assert.equal(readFileSync(join(work,'other.txt'),'utf8'),'user dirty\n');assert.equal(git(remote,'rev-parse','refs/heads/'+branch),result.commit);
});
test('a non-fast-forward remote is refused before a local commit or any index change',async()=>{
 const {work,branch}=makeRepos();git(work,'checkout','-q','-b','remote-change');writeFileSync(join(work,'other.txt'),'remote change');git(work,'commit','-q','-am','remote change');git(work,'push','-q','origin',`HEAD:refs/heads/${branch}`);git(work,'checkout','-q',branch);writeFileSync(join(work,'a.js'),'local change');const head=git(work,'rev-parse','HEAD'),index=git(work,'ls-files','--stage');
 await assert.rejects(publishRun({exec:execCommand,gitBinary:'git',run:baseRun(work,{changedFiles:['a.js']}),session:{repoPath:work,branch}}),error=>error.code==='non_fast_forward');assert.equal(git(work,'rev-parse','HEAD'),head);assert.equal(git(work,'ls-files','--stage'),index);
});

test('a fresh working-tree preview publishes existing changes without needing a new AI edit', async()=>{
 const {previewWorkingTree,publishWorkingTree}=await import('../server/lib/working-tree-publish.mjs')
 const {work,remote,branch}=makeRepos({branch:'feat/GRT-11469-popup-cache'});dirty(work)
 const session={repoPath:work,branch},options={exec:execCommand,session}
 const preview=await previewWorkingTree(options)
 assert.deepEqual(preview.paths.sort(),['a.js','new.txt','other.txt','staged.txt'])
 const result=await publishWorkingTree({...options,selection:{snapshot:preview.snapshot,paths:['a.js','new.txt'],message:'[GRT-11469] - refactor: 캐시 상수 위치 정리'}})
 assert.equal(git(work,'log','-1','--format=%s'),'[GRT-11469] - refactor: 캐시 상수 위치 정리')
 assert.equal(git(remote,'rev-parse',`refs/heads/${branch}`),result.commit)
 assert.equal(git(work,'diff','--cached','--name-only'),'staged.txt')
})
test('preview invalidation and invalid ticket/message reject publication before committing',async()=>{
 const {previewWorkingTree,publishWorkingTree}=await import('../server/lib/working-tree-publish.mjs')
 const {work,branch}=makeRepos({branch:'feat/GRT-11469-popup-cache'});dirty(work)
 const options={exec:execCommand,session:{repoPath:work,branch}},preview=await previewWorkingTree(options),head=git(work,'rev-parse','HEAD')
 await assert.rejects(publishWorkingTree({...options,selection:{snapshot:preview.snapshot,paths:['a.js'],message:'[GRT-999] - fix: wrong ticket'}}),e=>e.code==='invalid_commit_message')
 writeFileSync(join(work,'a.js'),'changed after preview\n')
 await assert.rejects(publishWorkingTree({...options,selection:{snapshot:preview.snapshot,paths:['a.js'],message:'[GRT-11469] - fix: cache'}}),e=>e.code==='publication_changed')
 assert.equal(git(work,'rev-parse','HEAD'),head)
})
test('AI run commits use the branch ticket and a descriptive conventional subject',async()=>{
 const {work,branch}=makeRepos({branch:'feat/GRT-11469-popup-cache'});dirty(work)
 await publishRun({exec:execCommand,run:baseRun(work),session:{repoPath:work,branch}})
 assert.match(git(work,'log','-1','--format=%s'),/^\[GRT-11469\] - fix: .*a\.js/)
})

test('working-tree publication retries a failed push without committing unrelated leftover files',async()=>{
 const {previewWorkingTree,publishWorkingTree}=await import('../server/lib/working-tree-publish.mjs')
 const {work,remote,branch}=makeRepos({branch:'feat/GRT-11469-popup-cache'});dirty(work)
 const session={repoPath:work,branch},options={exec:execCommand,session},preview=await previewWorkingTree(options)
 git(work,'remote','set-url','origin',join(work,'missing-remote.git'))
 const message='[GRT-11469] - refactor: 캐시 상수 위치 정리',paths=['a.js','new.txt']
 const error=await publishWorkingTree({...options,selection:{snapshot:preview.snapshot,paths,message}}).catch(e=>e)
 assert.equal(error.code,'push_failed')
 session.lastPublishError={commit:error.extra.commit,paths,commitMessage:message}
 git(work,'remote','set-url','origin',remote)
 const retry=await previewWorkingTree(options)
 assert.equal(retry.retryCommit,error.extra.commit)
 assert.deepEqual(retry.paths,[],'unrelated leftover files must not be folded into a push retry')
 const result=await publishWorkingTree({...options,selection:{snapshot:retry.snapshot,paths:[],message}})
 assert.equal(result.commit,error.extra.commit)
 assert.equal(git(work,'diff','--cached','--name-only'),'staged.txt')
 assert.equal(git(work,'diff','--name-only'),'other.txt')
})

test('both AI-run and working-tree publication refuse to commit when detekt or tests fail',async()=>{
 const {previewWorkingTree,publishWorkingTree}=await import('../server/lib/working-tree-publish.mjs')
 for(const phase of ['detekt','test']){
  const {work,branch}=makeRepos({branch:'feat/GRT-11469-checks'})
  writeFileSync(join(work,'gradlew'),`#!/bin/sh\ncase "$*" in *${phase}*) echo '${phase} failed'; exit 7;; esac\necho BUILD_SUCCESSFUL\n`,{mode:0o755})
  writeFileSync(join(work,'settings.gradle.kts'),'');writeFileSync(join(work,'build.gradle.kts'),'')
  dirty(work)
  const head=git(work,'rev-parse','HEAD'),session={repoPath:work,branch},tracked=git(work,'diff','--cached','--binary')
  const {exec,calls}=recording()
  await assert.rejects(publishRun({exec,run:baseRun(work),session}),e=>e.code==='pre_publish_checks_failed')
  const preview=await previewWorkingTree({exec,session})
  await assert.rejects(publishWorkingTree({exec,session,selection:{snapshot:preview.snapshot,paths:['a.js','new.txt'],message:'[GRT-11469] - fix: cache'}}),e=>e.code==='pre_publish_checks_failed')
  assert.equal(git(work,'rev-parse','HEAD'),head);assert.equal(git(work,'diff','--cached','--binary'),tracked)
  assert.ok(!calls.some(args=>args[0]==='commit'||args[0]==='push'))
 }
})

test('a source edit during successful pre-publish checks cannot be committed as verified code',async()=>{
 const {work,branch}=makeRepos({branch:'feat/GRT-11469-checks'})
 writeFileSync(join(work,'gradlew'),'#!/bin/sh\necho BUILD_SUCCESSFUL\n',{mode:0o755});writeFileSync(join(work,'settings.gradle.kts'),'');writeFileSync(join(work,'build.gradle.kts'),'');dirty(work)
 const head=git(work,'rev-parse','HEAD')
 const exec=async(cmd,args,options)=>{const result=await execCommand(cmd,args,options);if(cmd.endsWith('gradlew')&&args[0]==='test')writeFileSync(join(work,'a.js'),'edited while validating\n');return result}
 await assert.rejects(publishRun({exec,run:baseRun(work),session:{repoPath:work,branch}}),e=>e.code==='publication_changed')
 assert.equal(git(work,'rev-parse','HEAD'),head)
})
