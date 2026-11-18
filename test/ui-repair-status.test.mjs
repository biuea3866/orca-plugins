import test from 'node:test'
import assert from 'node:assert/strict'
import { repairSummary, repairActive, publishedNotice } from '../ui/lib/repair-status.mjs'

test('no repair state shows nothing', () => {
  assert.equal(repairSummary(null), null)
  assert.equal(repairSummary({ status: 'failed', steps: [] }), null)
  assert.equal(repairActive(null), false)
})

test('a running repair shows its round, the failed step and the agent, and keeps the screen polling', () => {
  const checks = { status: 'failed', repair: { active: true, round: 1, max: 2, agent: 'claude', rounds: [{ round: 1, status: 'fixing', failedStep: { kind: 'detekt', tasks: [':m:detekt'] } }] } }
  assert.equal(repairActive(checks), true)
  assert.deepEqual(repairSummary(checks), { headline: '자동 수정 중 1/2회 · detekt 실패를 claude가 수정하는 중', rounds: [{ round: 1, text: '1회차 · detekt · 수정 중' }] })
})

test('finished rounds list what changed or why they stopped', () => {
  const checks = { repair: { active: false, max: 2, rounds: [
    { round: 1, status: 'fixed', failedStep: { kind: 'test', tasks: [':m:test'] }, changedFiles: ['m/A.kt', 'm/B.kt'] },
    { round: 2, status: 'failed', failedStep: { kind: 'test', tasks: [':m:test'] }, reason: 'repair_out_of_scope' }
  ] } }
  const summary = repairSummary(checks)
  assert.equal(summary.headline, '자동 수정 2회 시도')
  assert.deepEqual(summary.rounds.map((row) => row.text), ['1회차 · 테스트 · 수정됨 (2개 파일)', '2회차 · 테스트 · 중단 (수정 허용 범위를 벗어남)'])
})

test('the published notice mentions how many repairs preceded the push', () => {
  assert.equal(publishedNotice({ commit: 'abcdef1234567', remote: 'origin', branch: 'feat/x', repairs: [] }), '원격 반영 확인: abcdef1234 → origin/feat/x')
  assert.equal(publishedNotice({ commit: 'abcdef1234567', remote: 'origin', branch: 'feat/x', repairs: [{}, {}] }), '원격 반영 확인: abcdef1234 → origin/feat/x (AI 자동 수정 2회 후)')
  assert.equal(publishedNotice({ commit: 'abcdef1234567', remote: 'origin', branch: 'feat/x' }), '원격 반영 확인: abcdef1234 → origin/feat/x')
})

test('every stop reason a repair can report has a readable label, and unknown ones are shown as they are', () => {
  const reasons = { repair_out_of_scope: '수정 허용 범위를 벗어남', repair_no_change: '파일을 수정하지 않음', repair_failed: 'AI 실행 실패', repair_cancelled: '취소됨', repair_timeout: '시간 초과', repair_head_changed: 'AI가 직접 커밋함', repair_suppressed_check: '검증 우회 추가', repair_retry_commit: '남은 로컬 커밋 있음', interrupted: '서버 재시작으로 중단', agent_unavailable: 'AI CLI 사용 불가' }
  for (const [code, label] of Object.entries(reasons)) {
    const summary = repairSummary({ repair: { active: false, max: 2, rounds: [{ round: 1, status: 'failed', failedStep: { kind: 'test' }, reason: code }] } })
    assert.equal(summary.rounds[0].text, `1회차 · 테스트 · 중단 (${label})`, code)
  }
  assert.equal(repairSummary({ repair: { active: false, max: 2, rounds: [{ round: 1, status: 'failed', failedStep: { kind: 'test' }, reason: 'something_new' }] } }).rounds[0].text, '1회차 · 테스트 · 중단 (something_new)')
})
