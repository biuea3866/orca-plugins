// "커밋 & 푸시": commits what an AI fix run changed and pushes it to the session branch.
//
// This is the only place the plugin writes to a repository's history, and it never happens on its own: the server runs
// it when the user presses the button in the run card (twice), and it is the server doing it, never the AI agent
// (whose prompt still forbids commit/push). Guard rails, all checked before anything is committed:
//   - only a succeeded fix run with changed files that was not published yet
//   - the worktree is still on the session's branch, and that branch is not a shared one (main, dev, release/..., the
//     repository's default branch)
//   - an upstream that is configured must have the same name as the local branch, so a feature branch that tracks
//     origin/main can never push into main
//   - only the run's files are committed (--only semantics): the user's other staged or dirty work stays untouched
//   - never a forced push; a failed push keeps the local commit and reports it so the push alone can be retried

import {runPublishChecks} from './pre-publish-checks.mjs'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { ApiError } from './store.mjs'
import {defaultCommitMessage,validateCommitMessage} from './commit-message.mjs'
import { BASE_BRANCH } from './github.mjs'

const GIT_TIMEOUT_MS = 60_000
const PUSH_TIMEOUT_MS = 120_000

/**
 * @param {{ exec: Function, gitBinary?: string, run: object, session: { repoPath: string, branch: string } }} input
 * @returns {Promise<{ commit: string, branch: string, remote: string, upstreamSet: boolean }>}
 */
export async function publishRun({ exec, gitBinary = 'git', run, session, message, expectedHead, validateBeforeCommit, checksOptions }) {
  const refuse = (message) => { throw new ApiError(400, 'not_publishable', message) }
  if ((run.mode ?? 'fix') !== 'fix') refuse('only an AI fix run can be committed and pushed')
  if (run.status !== 'succeeded') refuse(`the run is ${run.status}; only a succeeded run can be committed and pushed`)
  if (run.published) refuse('this run was already committed and pushed')
  const paths = (run.changedFiles ?? []).filter((path) => typeof path === 'string' && path)
  if (paths.length === 0) refuse('the run changed no files')
  if (!run.cwd || run.cwd !== session.repoPath) refuse('the run belongs to another worktree than the session')

  const cwd = run.cwd
  async function git(args, { allowFailure = false, timeout = GIT_TIMEOUT_MS, env } = {}) {
    let result
    try {
      result = await exec(gitBinary, args, { cwd, timeout, ...(env ? { env } : {}) })
    } catch (error) {
      throw new ApiError(500, 'git_unavailable', `git could not be executed: ${error.message}`)
    }
    if (result.code !== 0 && !allowFailure) throw new ApiError(400, 'git_failed', (result.stderr || result.stdout || `git ${args[0]} failed`).trim())
    return result
  }

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (!branch || branch === 'HEAD') throw new ApiError(400, 'detached_head', 'HEAD is detached; check out the branch before committing')
  const originHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true })
  const defaultBranch = originHead.code === 0 ? originHead.stdout.trim().replace(/^origin\//, '') : null
  if (BASE_BRANCH.test(branch) || branch === defaultBranch) throw new ApiError(400, 'protected_branch', `${branch} is a shared branch; commit and push there by hand`)
  if (branch !== session.branch) throw new ApiError(400, 'branch_mismatch', `the worktree is on ${branch} but the review session is for ${session.branch}`)

  const remoteConfig = await git(['config', '--get', `branch.${branch}.remote`], { allowFailure: true })
  const mergeConfig = await git(['config', '--get', `branch.${branch}.merge`], { allowFailure: true })
  const configuredRemote = remoteConfig.code === 0 ? remoteConfig.stdout.trim() : ''
  const hasUpstream = Boolean(configuredRemote) && configuredRemote !== '.' && mergeConfig.code === 0
  if (hasUpstream && mergeConfig.stdout.trim() !== `refs/heads/${branch}`) {
    throw new ApiError(400, 'upstream_mismatch', `${branch} tracks ${configuredRemote}/${mergeConfig.stdout.trim().replace(/^refs\/heads\//, '')}; push by hand so another branch is not updated by accident`)
  }
  const subject = validateCommitMessage(message ?? defaultCommitMessage(branch,paths,run.commitMessage),branch)
  const remote = hasUpstream ? configuredRemote : 'origin'

  // Refuse a known divergent remote before changing either history or the user's index.
  const remoteState = await git(['ls-remote','--heads','--',remote,`refs/heads/${branch}`], {allowFailure:true,timeout:PUSH_TIMEOUT_MS,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...(process.env.GIT_SSH_COMMAND?{}:{GIT_SSH_COMMAND:'ssh -o BatchMode=yes'})}})
  const remoteTip = remoteState.code===0 ? remoteState.stdout.split('\n').map(line=>line.split(/\s+/)).find(parts=>parts[1]===`refs/heads/${branch}`)?.[0] : null
  if(remoteTip && (await git(['merge-base','--is-ancestor',remoteTip,'HEAD'],{allowFailure:true})).code!==0)throw new ApiError(409,'non_fast_forward','원격 이력이 현재 로컬 HEAD에 포함되어 있지 않습니다. 리베이스·동기화 상태를 확인하세요. 이 도구는 강제 푸시하지 않습니다.')

  // A previous attempt that committed but failed to push left its commit at HEAD: only the push is repeated.
  const headBefore = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if(expectedHead && expectedHead !== headBefore)throw new ApiError(409,'publication_changed','HEAD가 변경됐습니다. 게시 내용을 다시 확인하세요.')
  async function sourceFingerprint(){
    const patch=await git(['--literal-pathspecs','diff','--binary','--no-ext-diff','--no-textconv','HEAD','--',...paths])
    const untracked=(await git(['--literal-pathspecs','ls-files','--others','--exclude-standard','-z','--',...paths])).stdout.split('\0').filter(Boolean)
    const hashes=untracked.length?(await git(['hash-object','--no-filters','--',...untracked])).stdout:''
    return JSON.stringify({patch:patch.stdout,untracked,hashes})
  }
  const checkedInput=await sourceFingerprint()
  const checks=await runPublishChecks({exec,cwd,paths,...checksOptions})
  if(await sourceFingerprint()!==checkedInput)throw new ApiError(409,'publication_changed','검증 중 대상 파일이 변경됐습니다. 다시 검증한 뒤 게시하세요. 커밋·푸시하지 않았습니다.')
  if((await git(['rev-parse','HEAD'])).stdout.trim()!==headBefore || (await git(['rev-parse','--abbrev-ref','HEAD'])).stdout.trim()!==branch)throw new ApiError(409,'publication_changed','검증 중 HEAD 또는 브랜치가 변경됐습니다. 커밋·푸시하지 않았습니다.')
  let commit = headBefore
  if(run.committed?.commit && run.committed.commit!==headBefore)refuse('HEAD moved after this run was committed; review before pushing')
  if (!(run.committed?.commit===headBefore || (run.publishError?.commit && run.publishError.commit === headBefore))) {
    const temporary = mkdtempSync(join(tmpdir(),'self-review-publish-index-'))
    const indexEnv = {...process.env,GIT_INDEX_FILE:join(temporary,'index')}
    try {
      // The temporary index starts from HEAD, so staged deletions still have a tracked path to remove.
      await git(['read-tree','HEAD'],{env:indexEnv})
      const listed = await git(['--literal-pathspecs','ls-files','--cached','--others','--exclude-standard','-z','--',...paths],{env:indexEnv})
      const selected = [...new Set(listed.stdout.split('\0').filter(Boolean))]
      if(!selected.length)throw new ApiError(400,'nothing_to_commit','이 실행의 대상 파일에는 커밋할 변경이 없습니다.')
      await git(['--literal-pathspecs','add','--all','--',...selected],{env:indexEnv})
      if(validateBeforeCommit)await validateBeforeCommit()
      if(await sourceFingerprint()!==checkedInput)throw new ApiError(409,'publication_changed','검증 후 파일이 변경됐습니다. 다시 검증하세요. 커밋·푸시하지 않았습니다.')
      const currentHead=(await git(['rev-parse','HEAD'])).stdout.trim(),currentBranch=(await git(['rev-parse','--abbrev-ref','HEAD'])).stdout.trim()
      if(currentHead!==headBefore||currentBranch!==branch)throw new ApiError(409,'repository_changed','커밋 준비 중 브랜치 또는 HEAD가 바뀌었습니다. 상태를 확인하고 다시 시도하세요.')
      const threads = (run.threadIds ?? []).length
      const committed = await git(['commit','-q','-m',subject,'-m',`Local Self Review ${run.id} · 스레드 ${threads}개${run.agent ? ` (${run.agent})` : ''}`],{allowFailure:true,env:indexEnv})
      if(committed.code!==0){const text=`${committed.stdout ?? ''}${committed.stderr ?? ''}`.trim();throw new ApiError(400,/nothing (added )?to commit|no changes added/i.test(text)?'nothing_to_commit':'commit_failed',text||'git commit failed')}
      commit=(await git(['rev-parse','HEAD'])).stdout.trim()
      // Reset only this run's paths in the real index; unrelated staged and working-tree content stays intact.
      await git(['--literal-pathspecs','reset','-q',commit,'--',...selected])
    } finally { rmSync(temporary,{recursive:true,force:true}) }
  }

  const refspec = `HEAD:refs/heads/${branch}`
  // No terminal here: a credential or host-key prompt would hang the push, so make git and ssh fail instead.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) }
  const pushed = await git(hasUpstream ? ['push', remote, refspec] : ['push', '-u', remote, refspec], { allowFailure: true, timeout: PUSH_TIMEOUT_MS, env })
  if (pushed.code !== 0) throw new ApiError(502, 'push_failed', (pushed.stderr || pushed.stdout || 'git push failed').trim(), { commit })
  const verified=await git(['ls-remote','--heads','--',remote,`refs/heads/${branch}`],{allowFailure:true,timeout:PUSH_TIMEOUT_MS,env})
  const remoteHead=verified.stdout.split('\n').map(line=>line.split(/\s+/)).find(parts=>parts[1]===`refs/heads/${branch}`)?.[0]
  if(verified.code!==0||remoteHead!==commit)throw new ApiError(502,'remote_unverified','커밋·푸시 명령 이후 원격 SHA를 확인하지 못했습니다. 원격 반영은 아직 미확인입니다.',{commit})
  return { commit, branch, remote, remoteHead, upstreamSet: !hasUpstream, checks }
}
