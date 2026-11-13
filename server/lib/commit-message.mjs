import {basename} from 'node:path'
import {ApiError} from './store.mjs'
export function ticketForBranch(branch) {
 return /(?:^|[/_-])((?:GRT|BE|LIVEISSUE)-\d+)(?=$|[/_-])/i.exec(branch || '')?.[1].toUpperCase() || 'NO-JIRA'
}
export function defaultCommitMessage(branch, paths, suggestion) {
 if (suggestion) { try { return validateCommitMessage(suggestion,branch) } catch { /* fall back to actual files */ } }
 const type=paths.length && paths.every(path=>/\.(md|mdx|rst)$/.test(path))?'docs':paths.length&&paths.every(path=>/(?:\/test\/|\.test\.|Test\.)/.test(path))?'test':'fix'
 return `[${ticketForBranch(branch)}] - ${type}: ${paths.length ? basename(paths[0])+(paths.length>1?` 외 ${paths.length-1}개 파일 변경`:' 변경'):'리뷰 변경 반영'}`
}
export function validateCommitMessage(message, branch) {
 const match=typeof message==='string'&&/^\[([A-Z]+-\d+|NO-JIRA)\] - (fix|test|feat|refactor|docs|chore|build|ci|perf|style|revert): ([^\r\n]+)$/.exec(message.trim())
 if(!match||match[1]!==ticketForBranch(branch)||!match[3].trim()||message.length>300)throw new ApiError(400,'invalid_commit_message',`커밋 메시지는 [${ticketForBranch(branch)}] - fix|test|feat|refactor|docs|chore|build|ci|perf|style|revert: 작업 내용 형식이어야 합니다.`)
 return message.trim()
}
