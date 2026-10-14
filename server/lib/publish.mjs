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

import { ApiError } from './store.mjs'
import { BASE_BRANCH } from './github.mjs'

const GIT_TIMEOUT_MS = 60_000
const PUSH_TIMEOUT_MS = 120_000

/**
 * @param {{ exec: Function, gitBinary?: string, run: object, session: { repoPath: string, branch: string } }} input
 * @returns {Promise<{ commit: string, branch: string, remote: string, upstreamSet: boolean }>}
 */
export async function publishRun({ exec, gitBinary = 'git', run, session }) {
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
  const remote = hasUpstream ? configuredRemote : 'origin'

  // A previous attempt that committed but failed to push left its commit at HEAD: only the push is repeated.
  const headBefore = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  let commit = headBefore
  if (!(run.publishError?.commit && run.publishError.commit === headBefore)) {
    await git(['--literal-pathspecs', 'add', '--', ...paths])
    const threads = (run.threadIds ?? []).length
    const committed = await git(['--literal-pathspecs', 'commit', '-q', '-m', `fix: 리뷰 코멘트 반영 (스레드 ${threads}개)`, '-m', `Local Self Review AI 수정 실행 ${run.id}${run.agent ? ` (${run.agent})` : ''}`, '--', ...paths], { allowFailure: true })
    if (committed.code !== 0) {
      const text = `${committed.stdout ?? ''}${committed.stderr ?? ''}`.trim()
      throw new ApiError(400, /nothing (added )?to commit|no changes added/i.test(text) ? 'nothing_to_commit' : 'commit_failed', text || 'git commit failed')
    }
    commit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  }

  const refspec = `HEAD:refs/heads/${branch}`
  // No terminal here: a credential or host-key prompt would hang the push, so make git and ssh fail instead.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) }
  const pushed = await git(hasUpstream ? ['push', remote, refspec] : ['push', '-u', remote, refspec], { allowFailure: true, timeout: PUSH_TIMEOUT_MS, env })
  if (pushed.code !== 0) throw new ApiError(502, 'push_failed', (pushed.stderr || pushed.stdout || 'git push failed').trim(), { commit })
  return { commit, branch, remote, upstreamSet: !hasUpstream }
}
