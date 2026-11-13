// A fix outcome is a reply to the exact reviewer comment submitted to that run.
export function fixResultEntries(run, text) {
  const requests = run.requestedComments || []
  const known = new Set(requests.map(request => request.commentId))
  const reports = new Map()
  const nonce = String(run.nonce || '').replace(/[^a-zA-Z0-9]/g, '')
  if (nonce) {
    const pattern = new RegExp(`@@FIX:(cmt_[0-9a-f]+):${nonce}@@[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*@@END:${nonce}@@`, 'g')
    for (const match of String(text || '').matchAll(pattern)) {
      if (known.has(match[1]) && match[2].trim()) reports.set(match[1], match[2].trim())
    }
  }
  const summaries = new Map()
  for (const line of String(text || '').split('\n')) {
    const match = /^-\s+(thr_[0-9a-f]{12}):\s*(수행|미수행)(?:\s*[—–-]\s*(.*))?$/.exec(line.trim())
    if (match) summaries.set(match[1], { status: match[2], reason: match[3] || '세부 설명 없음' })
  }
  const verification = String(text || '').split('\n').filter(line => /^검증:\s*/.test(line.trim())).at(-1)?.trim()
  const publication = run.published?.remoteHead === run.published?.commit && run.published?.commit
    ? `별도 게시 기록: ${run.published.commit} → ${run.published.remote}/${run.published.branch} (게시 당시 원격 SHA 확인)`
    : run.publishError?.commit ? `별도 게시 로컬 커밋: ${run.publishError.commit}\n원격 푸시: 미확인` : run.committed?.commit ? `검증 후 서버 로컬 커밋: ${run.committed.commit}\n원격 푸시: 미실행 — 게시 버튼에서 별도 실행` : run.autoCommit ? 'AI 단계의 커밋: 미실행. 검증 후 서버 자동 커밋 결과는 실행 카드에서 확인하세요.\n원격 푸시: 미실행 — 게시 버튼에서 별도 실행' : '이번 실행의 커밋: 미실행\n이번 실행의 원격 푸시: 미실행 — 커밋 & 푸시로 별도 실행'
  return requests.map(request => {
    let detail
    if (run.status !== 'succeeded') detail = `${run.status === 'cancelled' ? '수정 취소' : '실행 실패'}: 실행 상태 ${run.status}. 완료된 수정으로 확인하지 않았습니다.`
    else if ((run.questionThreadIds || []).includes(request.threadId)) detail = '수정 보류: 이 실행에서 확인 질문을 남겼습니다. 같은 스레드의 AI 질문에 답변한 뒤 다시 요청해 주세요.'
    else if (reports.has(request.commentId)) detail = reports.get(request.commentId)
    else if (summaries.has(request.threadId)) {
      const summary = summaries.get(request.threadId)
      detail = `${summary.status === '수행' ? '로컬 수정 보고' : '수정 미수행'}: ${summary.reason}`
      if (requests.filter(item => item.threadId === request.threadId).length > 1) detail += '\n이전 실행의 스레드 공통 보고입니다. 요청별 상세 보고는 로그에 없습니다.'
      detail += `\n${verification || '검증: 실행 로그에 검증 결과 보고가 없습니다.'}`
    } else detail = '구체적인 수정 결과 보고가 없습니다. 실행 종료만으로 수정 완료를 판단하지 마세요.'
    return {
      threadId: request.threadId, replyToCommentId: request.commentId,
      requestBody: request.body, requestUpdatedAt: request.updatedAt,
      kind: 'fix-result', agent: run.agent, runId: run.id,
      body: `${detail}\n\n실행에서 감지한 변경 파일: ${(run.changedFiles || []).join(', ') || '없음'}\n반영 범위: 로컬 작업 트리 · AI 보고\n${publication}`
    }
  })
}
