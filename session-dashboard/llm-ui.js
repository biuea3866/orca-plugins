// Extend the existing dashboard after its request-history UI is installed.
function llmValue(value) {
  if (!value) return '모델·effort 확인 불가';
  const entries = value.usage || [];
  if (!entries.length) return '모델·effort 확인 불가';
  return entries.map(entry => (entry.model || '모델 확인 불가') + (entry.source === 'router-config' ? ' (선택)' : '') + ' · effort ' +
    (entry.effort || '확인 불가') + (entry.effortSource === 'configured' ? ' (설정)' : '')).join(' → ');
}
function llmGlance(session) {
  const usage = session.llmUsage || {items: []};
  const row = el('div', 'llm-glance');
  const value = usage.current || usage.items?.at(-1);
  row.appendChild(el('span', 'llm-state' + (usage.current ? ' active' : ''), usage.current ? '현재 실행' : '최근 사용'));
  row.appendChild(el('span', null, llmValue(value)));
  return row;
}
function llmPanel(session) {
  const usage = session.llmUsage || {items: []};
  const section = panel('모델 · 추론 강도', el('span', 'meta', usage.source === 'router' ? '자동 라우팅' : '실행 기록'));
  section.appendChild(llmGlance(session));
  if (!usage.current) section.appendChild(el('p', 'note', session.agentState === 'working'
    ? '현재 실행 설정을 확인할 수 없습니다.' : '현재 실행 중인 모델 호출이 없습니다.'));
  if (usage.error) section.appendChild(el('p', 'note', usage.error));
  if (!usage.items?.length) {
    section.appendChild(el('p', 'note', '이 세션과 일치하는 모델 사용 기록을 찾지 못했습니다.'));
    return section;
  }
  const history = el('div', 'llm-history');
  const historyKey = session.id + ':llm-history';
  history.id = 'llm-history-' + session.id;
  history.hidden = requestDisclosureState.get(historyKey) === false;
  const collapse = el('button', 'llm-collapse-all', '히스토리 전체 접기');
  collapse.type = 'button';
  collapse.setAttribute('aria-controls', history.id);
  const updateHistoryToggle = () => {
    collapse.textContent = history.hidden ? '히스토리 펼치기 (' + (history.childElementCount || usage.items.length) + '건)' : '히스토리 전체 접기';
    collapse.setAttribute('aria-expanded', String(!history.hidden));
  };
  updateHistoryToggle();
  collapse.addEventListener('click', () => {
    history.hidden = !history.hidden;
    requestDisclosureState.set(historyKey, !history.hidden);
    if (history.hidden) {
      for (const row of history.querySelectorAll('details')) {
        requestDisclosureState.set(row.dataset.disclosureKey, false);
        row.open = false;
      }
    }
    updateHistoryToggle();
  });
  section.appendChild(collapse);
  const stateLabels = {running: '실행 중', completed: '응답 완료', failed: '실패', cancelled: '중단', interrupted: '종료됨'};
  for (const item of [...usage.items].reverse()) {
    const row = el('details', 'llm-history-item');
    const summary = el('summary');
    const text = el('span', 'llm-summary-text');
    text.appendChild(el('span', 'llm-question', item.question));
    text.appendChild(el('span', 'llm-choice', llmValue(item)));
    summary.appendChild(text);
    summary.appendChild(el('span', 'llm-history-state', stateLabels[item.state] || '확인 불가'));
    row.appendChild(summary);
    rememberDisclosure(row, session.id + ':llm:' + item.id);
    row.appendChild(el('div', 'llm-model', llmValue(item)));
    if (item.selectedModel) row.appendChild(el('div', 'meta', '선택 모델 · ' + item.selectedModel));
    if (item.reason) row.appendChild(el('div', 'meta', '선택 이유 · ' + item.reason));
    if (item.policy) row.appendChild(el('div', 'meta', '정책 · ' + item.policy +
      (item.learningSamples ? ' · 품질 평가 ' + item.learningSamples + '건 반영' : ' · 초기 규칙 사용')));
    if (item.feedback) row.appendChild(el('div', 'meta', '품질 평가 · ' + (item.feedback.quality ? '좋음' : '개선 필요')));
    if (item.routerSessionId) row.appendChild(el('div', 'meta', '평가 요청 ID · ' + item.id));
    if (item.startedAt) row.appendChild(el('div', 'meta', '시작 · ' + stamp(item.startedAt)));
    if (item.error) row.appendChild(el('div', 'reason blocked', item.error));
    if (item.answer) row.appendChild(el('p', 'llm-answer', item.answer));
    history.appendChild(row);
  }
  section.appendChild(history);
  return section;
}
const cardWithoutLlm = card;
card = function(session) {
  const node = cardWithoutLlm(session);
  node.insertBefore(llmGlance(session), node.children[2] || null);
  return node;
};
