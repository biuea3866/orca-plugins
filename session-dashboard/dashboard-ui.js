const requestDisclosureState = new Map();

function rememberDisclosure(node, key, defaultOpen = false) {
  node.dataset.disclosureKey = key;
  node.open = requestDisclosureState.has(key) ? requestDisclosureState.get(key) : defaultOpen;
  // Save during the click itself: native toggle events run later and can lose
  // a race with the next live snapshot replacing the detail DOM.
  node.querySelector(':scope > summary').addEventListener('click', event => {
    event.preventDefault();
    node.open = !node.open;
    requestDisclosureState.set(key, node.open);
  });
  node.addEventListener('toggle', () => {
    if (node.isConnected) requestDisclosureState.set(key, node.open);
  });
  return node;
}

function requestData(session) { return session.requests || {items: [], answered: 0, workCompleted: 0, workKnown: 0, source: 'observed'}; }
function answerLabel(state) { return {completed: '답변 완료', working: '답변 진행 중', pending: '요청 접수', interrupted: '답변 중단'}[state] || '확인 불가'; }
function workLabel(state) { return {completed: '작업 완료', running: '작업 진행 중', unknown: '완료 여부 확인 불가'}[state] || '확인 불가'; }
function etaLabel(request) {
  if (!request) return '예상 시간 산정 중';
  if (request.workState === 'completed') return '요청 작업 완료';
  const eta = request.eta || {};
  if (!eta.at) return eta.basis || '예상 시간 산정 중';
  return eta.at < Date.now() ? '예상 시각 경과 · 재산정 필요' : stamp(eta.at) + ' (예상)';
}
function progressBar(progress) {
  const p = progress || {};
  const row = el('div', 'work-progress');
  const track = el('div', 'work-track');
  const known = Number.isFinite(p.percent);
  const value = known ? Math.min(100, Math.max(0, p.percent)) : 0;
  const fill = el('div', 'work-fill' + (p.estimated ? ' estimated' : ''));
  fill.style.width = value + '%';
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', p.estimated ? '작업 단계 추정' : '작업 진행률');
  track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
  if (known) track.setAttribute('aria-valuenow', String(value));
  track.setAttribute('aria-valuetext', known ? (p.estimated ? '추정 ' : '') + value + '%' : '진행률 산정 불가');
  track.appendChild(fill); row.appendChild(track);
  row.appendChild(el('span', 'work-percent', known ? (p.estimated ? '~' : '') + value + '%' : '산정 불가'));
  return row;
}
function dataLine(label, value) {
  const line = el('div', 'request-data-line');
  line.dataset.field = label;
  line.appendChild(el('span', null, label)); line.appendChild(el('strong', null, value)); return line;
}

function card(session) {
  const node = el('article', 'card work-card ' + session.status);
  node.dataset.sessionId = session.id;
  node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', (session.name || '세션') + ' 상세 보기');
  node.addEventListener('click', () => openSession(session.id));
  node.addEventListener('keydown', event => { if (event.target === node && ['Enter', ' '].includes(event.key)) {event.preventDefault(); openSession(session.id);} });
  const heading = el('div', 'card-top');
  heading.appendChild(el('div', 'name', session.name || '이름 없음'));
  heading.appendChild(el('span', 'badge ' + session.status, STATUS_LABEL[session.status] || session.status)); node.appendChild(heading);
  node.appendChild(el('div', 'meta', [session.repo, session.agentType, session.branch].filter(Boolean).join(' · ')));
  const requests = requestData(session), current = requests.items.at(-1);
  node.appendChild(el('div', 'summary', current ? current.question : session.summary?.text || '현재 요청 기록 없음'));
  const glance = el('div', 'request-glance');
  glance.appendChild(el('span', null, current ? answerLabel(current.answerState) : '답변 상태 확인 불가'));
  glance.appendChild(el('span', null, '종료 예상 · ' + etaLabel(current))); node.appendChild(glance);
  node.appendChild(progressBar(current?.progress || session.progress));
  const foot = el('div', 'card-foot');
  foot.appendChild(el('span', null, '주제 ' + topicsFor(requests).length + '개 · 질문 ' + requests.items.length + '건 · 작업 완료 ' + requests.workCompleted + '건'));
  foot.appendChild(agoNode('span', null, '', session.lastOutputAt)); node.appendChild(foot);
  const actions = el('div', 'card-actions');
  const detailButton = el('button', 'detail-link', '상세 보기 →'); detailButton.type = 'button';
  detailButton.addEventListener('click', event => {event.stopPropagation(); openSession(session.id);});
  actions.appendChild(detailButton); actions.appendChild(terminalNavigation(session)); node.appendChild(actions);
  return node;
}

function detailHeader(session) {
  const section = el('section', 'panel detail-head request-detail-head');
  section.appendChild(el('div', 'meta', [session.repo, session.agentType].filter(Boolean).join(' / ')));
  section.appendChild(el('h2', null, session.name || '세션'));
  section.appendChild(el('span', 'badge ' + session.status, STATUS_LABEL[session.status] || session.status));
  return section;
}

function requestOverview(payload) {
  const data = payload.requests || requestData(payload.session);
  const section = panel('요청별 현황', el('span', 'meta', '수집된 요청 ' + data.items.length + '건'));
  const stats = el('div', 'request-metrics');
  for (const [label, value, total] of [['답변 완료', data.answered, data.items.length], ['작업 완료', data.workCompleted, data.workKnown]]) {
    const item = el('div'); item.appendChild(el('span', null, label));
    item.appendChild(el('strong', null, total ? value + ' / ' + total : '—')); stats.appendChild(item);
  }
  section.appendChild(stats);
  section.appendChild(el('p', 'note', ['transcript', 'router'].includes(data.source) ? '답변 완료와 요청한 작업의 완료를 별도로 표시합니다.' : '대화 기록을 찾지 못해 수집 시작 후 확인된 요청만 표시합니다.'));
  return section;
}

function inquiryPanel(payload) {
  const data = payload.requests || requestData(payload.session), section = panel('주제별 질문·작업 기록');
  if (!data.items.length) {section.appendChild(el('p', 'note', '확인된 질문·요청이 없습니다.')); return section;}
  const selected = selectedTopic(payload);
  for (const topic of visibleTopics(data, selected)) {
    const group = el('section', 'topic-records'); group.dataset.liveKey = 'records:' + topic.id;
    group.appendChild(el('h4', 'topic-heading', topic.title));
    group.appendChild(el('p', 'meta', '질문 ' + topic.requestIds.length + '건 · 작업 완료 ' + topic.completed + '건 · 오래된 질문부터 표시'));
    for (const request of data.items.filter(item => topic.requestIds.includes(item.id))) {
    const item = el('details', 'request-item');
    const key = payload.session.id + ':' + request.id;
    item.dataset.requestId = request.id;
    const summary = el('summary'); summary.appendChild(el('span', 'request-question', request.question));
    summary.appendChild(el('span', 'request-answer-state ' + request.answerState, answerLabel(request.answerState))); item.appendChild(summary);
    rememberDisclosure(item, key, request.id === data.items.at(-1).id);
    const body = el('div', 'request-body');
    body.appendChild(dataLine('답변', answerLabel(request.answerState)));
    if (request.startedAt) body.appendChild(dataLine('질문 시각', stamp(request.startedAt)));
    body.appendChild(el('p', 'basis', '주제 분류 · ' + (request.topicBasis || '분류 정보 없음')));
    if (request.answeredAt) body.appendChild(dataLine('답변 완료 시각', stamp(request.answeredAt)));
    body.appendChild(dataLine('작업', workLabel(request.workState)));
    body.appendChild(progressBar(request.progress));
    body.appendChild(el('div', 'basis', request.progress?.basis || '진행률 산정 불가'));
    body.appendChild(dataLine('종료 예상', etaLabel(request)));
    if (request.eta?.at) body.appendChild(el('div', 'meta', request.eta.basis));
    else if (request.workState !== 'completed') body.appendChild(el('div', 'meta', '예상 소요 시간의 근거가 아직 없습니다.'));
    body.appendChild(el('div', 'request-subtitle', '다음 작업'));
    body.appendChild(el('p', 'request-next', request.remaining?.length ? request.remaining.join(' · ') : request.workState === 'completed' ? '요청 작업 완료' : '다음 작업 계획을 확인할 수 없습니다.'));
    body.appendChild(el('div', 'request-subtitle', '마무리된 항목'));
    if (request.completed?.length) {
      const list = el('ul', 'completed-items');
      for (const title of request.completed) list.appendChild(el('li', null, '✓ ' + title)); body.appendChild(list);
    } else body.appendChild(el('p', 'meta', '완료가 확인된 작업 항목이 없습니다.'));
    body.appendChild(workRecord(request));
    if (request.answer) {
      const reply = el('details', 'answer-excerpt'); reply.appendChild(el('summary', null, '답변 보기'));
      rememberDisclosure(reply, key + ':answer');
      reply.appendChild(el('div', 'answer-text', request.answer)); body.appendChild(reply);
    }
    item.appendChild(body); group.appendChild(item);
    }
    section.appendChild(group);
  }
  return section;
}

function currentWorkPanel(session) {
  const section = panel('현재 작업');
  section.appendChild(el('p', 'summary', session.summary?.text || (session.toolName ? '현재 도구 · ' + session.toolName : session.reason || '현재 작업 정보 없음')));
  section.appendChild(terminalNavigation(session)); return section;
}

function renderDetail() {
  const root = document.getElementById('detail-body');
  if (detailMissing || !detail) {root.replaceChildren(el('div', 'note', detailMissing || '세션 상세 불러오는 중…')); return;}
  const parts = [detailHeader(detail.session), llmPanel(detail.session)];
  if (detail.blockers?.length) parts.push(blockerAlert(detail.blockers));
  parts.push(requestOverview(detail), topicDiagram(detail), inquiryPanel(detail), currentWorkPanel(detail.session));
  if (detail.session.checklist) parts.push(stepperPanel(detail.session.checklist));
  parts.push(agentTreePanel(detail), timelinePanel(detail));
  const info = el('details', 'session-information'); info.appendChild(el('summary', null, '세션 정보'));
  rememberDisclosure(info, detail.session.id + ':information');
  for (const [label, value] of [['프로젝트', detail.session.path], ['브랜치', detail.session.branch], ['세션', detail.session.id]]) info.appendChild(dataLine(label, value || '-'));
  parts.push(info);
  for (const part of parts) part.dataset.liveKey = detail.session.id + ':section:' + (part.querySelector('.panel-head h3')?.textContent || part.className);
  reconcileChildren(root, parts);
  document.title = (detail.session.name || '세션') + ' — Orca 세션 대시보드';
}
