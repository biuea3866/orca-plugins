// Text for the "fix and retry" part of a publication: the screen shows it next to the pre-publish checks.
const KIND = { detekt: 'detekt', test: '테스트' }

export function repairActive(checks) {
  return checks?.repair?.active === true
}

const REASONS = {
  repair_out_of_scope: '수정 허용 범위를 벗어남',
  repair_no_change: '파일을 수정하지 않음',
  repair_failed: 'AI 실행 실패',
  repair_cancelled: '취소됨',
  repair_timeout: '시간 초과',
  repair_head_changed: 'AI가 직접 커밋함',
  repair_suppressed_check: '검증 우회 추가',
  repair_retry_commit: '남은 로컬 커밋 있음',
  interrupted: '서버 재시작으로 중단',
  agent_unavailable: 'AI CLI 사용 불가'
}

function rowText(round) {
  const kind = KIND[round.failedStep?.kind] ?? round.failedStep?.kind ?? ''
  const state = round.status === 'fixing' ? '수정 중'
    : round.status === 'fixed' ? `수정됨 (${(round.changedFiles ?? []).length}개 파일)`
    : `중단 (${REASONS[round.reason] ?? round.reason ?? '오류'})`
  return `${round.round}회차 · ${kind} · ${state}`
}

export function repairSummary(checks) {
  const repair = checks?.repair
  if (!repair || !(repair.rounds ?? []).length) return null
  const rounds = repair.rounds.map((round) => ({ round: round.round, text: rowText(round) }))
  if (repair.active) {
    const current = repair.rounds.find((round) => round.round === repair.round) ?? repair.rounds.at(-1)
    const kind = KIND[current.failedStep?.kind] ?? current.failedStep?.kind ?? ''
    return { headline: `자동 수정 중 ${repair.round}/${repair.max}회 · ${kind} 실패를 ${repair.agent ?? 'AI'}가 수정하는 중`, rounds }
  }
  return { headline: `자동 수정 ${repair.rounds.length}회 시도`, rounds }
}

export function publishedNotice(result) {
  const base = `원격 반영 확인: ${result.commit.slice(0, 10)} → ${result.remote}/${result.branch}`
  return result.repairs?.length ? `${base} (AI 자동 수정 ${result.repairs.length}회 후)` : base
}
