const topicSelections = new Map();

function topicsFor(data) {
  // Derive membership from transmitted questions: old histories can be pruned
  // for the panel budget without leaving orphan nodes or misleading counts.
  const groups = new Map();
  for (const item of data.items) {
    const id = item.topicId || 'unclassified';
    if (!groups.has(id)) groups.set(id, {id, title: item.topicTitle || '주제 미분류', requestIds: [], completed: 0});
    const topic = groups.get(id); topic.requestIds.push(item.id);
    if (item.workState === 'completed') topic.completed++;
  }
  return [...groups.values()];
}
function visibleTopics(data, selected) {return topicsFor(data).filter(topic => !selected || topic.id === selected);}
function selectedTopic(payload) {
  const id = topicSelections.get(payload.session.id);
  return topicsFor(payload.requests || requestData(payload.session)).some(topic => topic.id === id) ? id : null;
}
function chooseTopic(sessionId, topicId) {
  topicSelections.set(sessionId, topicId || null);
  renderDetail();
}
function revealRequest(sessionId, requestId, topicId) {
  topicSelections.set(sessionId, topicId);
  requestDisclosureState.set(sessionId + ':' + requestId, true);
  renderDetail();
  const root = document.getElementById('detail-body');
  const node = [...root.querySelectorAll('.request-item')].find(item => item.dataset.requestId === requestId);
  if (node) {node.scrollIntoView({behavior: 'smooth', block: 'start'}); node.querySelector('summary').focus({preventScroll: true});}
}
function workRecord(request) {
  const box = el('div', 'work-record');
  box.appendChild(el('div', 'request-subtitle', '어떻게 작업했나요'));
  const events = request.workLog || [];
  if (events.length) {
    const list = el('ol', 'work-evidence');
    for (const event of events) {
      const row = el('li', 'evidence-' + (event.state || event.kind));
      if (event.at) row.appendChild(el('time', 'meta', stamp(event.at)));
      row.appendChild(el('span', null, event.text)); list.appendChild(row);
    }
    box.appendChild(list);
  } else box.appendChild(el('p', 'meta', '수집된 중간 작업 기록이 없습니다. 완료 결과와 답변에서 확인할 수 있습니다.'));
  const completion = request.completion;
  if (completion && request.workState === 'completed') {
    const result = el('div', 'completion-record');
    result.appendChild(el('strong', null, '완료 기록'));
    if (completion.at) result.appendChild(el('div', 'meta', stamp(completion.at)));
    result.appendChild(el('p', null, completion.summary || '완료 결과 요약 없음'));
    result.appendChild(el('div', 'basis', '완료 근거 · ' + completion.basis));
    box.appendChild(result);
  } else box.appendChild(el('p', 'basis', '작업 완료 근거가 아직 확인되지 않았습니다.'));
  return box;
}
function topicDiagram(payload) {
  const data = payload.requests || requestData(payload.session);
  const topics = topicsFor(data), selected = selectedTopic(payload);
  const section = panel('주제별 작업 다이어그램');
  section.appendChild(el('p', 'note', '주제를 선택하면 이어지는 질문과 작업 결과를 볼 수 있습니다. 질문 노드를 누르면 상세 기록으로 이동합니다.'));
  section.appendChild(el('p', 'meta', '자동 분류 · 핵심어와 후속 질문 표현 기준 · 최근 질문 최대 40건' +
    (data.historyTotal > data.items.length ? ' · 저장된 기록 ' + data.historyTotal + '건' : '')));
  if (!topics.length) {section.appendChild(el('p', 'note', '질문이 수집되면 주제별 흐름을 표시합니다.')); return section;}
  const graph = el('div', 'topic-graph'); graph.setAttribute('aria-label', '세션에서 주제와 질문, 작업 결과로 이어지는 흐름');
  const origin = el('button', 'graph-session', '◉ ' + (payload.session.name || '세션') + ' · 전체 주제');
  origin.type = 'button'; origin.setAttribute('aria-pressed', String(!selected));
  origin.addEventListener('click', () => chooseTopic(payload.session.id, null)); graph.appendChild(origin);
  const branches = el('div', 'topic-branches');
  for (const topic of topics) {
    const branch = el('div', 'topic-branch'); branch.dataset.liveKey = 'branch:' + topic.id;
    const button = el('button', 'graph-topic' + (selected === topic.id ? ' selected' : ''));
    button.type = 'button'; button.setAttribute('aria-pressed', String(selected === topic.id));
    button.appendChild(el('strong', null, topic.title));
    button.appendChild(el('span', 'meta', '질문 ' + topic.requestIds.length + ' · 작업 완료 ' + topic.completed));
    button.addEventListener('click', () => chooseTopic(payload.session.id, selectedTopic(detail) === topic.id ? null : topic.id));
    branch.appendChild(button); branches.appendChild(branch);
  }
  graph.appendChild(branches); section.appendChild(graph);
  for (const topic of visibleTopics(data, selected)) {
    const flow = el('div', 'topic-flow'); flow.dataset.liveKey = 'flow:' + topic.id;
    flow.appendChild(el('h4', 'topic-heading', topic.title));
    const items = data.items.filter(item => topic.requestIds.includes(item.id));
    for (const [index, request] of items.entries()) {
      const step = el('div', 'graph-step'); step.dataset.liveKey = 'step:' + request.id;
      const question = el('button', 'graph-question'); question.type = 'button';
      question.appendChild(el('span', 'graph-number', String(index + 1)));
      question.appendChild(el('span', null, request.question));
      question.setAttribute('aria-label', '질문 ' + (index + 1) + ' 상세 기록: ' + request.question);
      question.addEventListener('click', () => revealRequest(payload.session.id, request.id, topic.id));
      step.appendChild(question);
      const process = el('div', 'graph-process');
      const events = request.workLog || [];
      const narration = [...events].reverse().find(event => event.kind === 'narration');
      const tasks = request.completed || [];
      process.appendChild(el('span', 'meta', '작업 과정'));
      process.appendChild(el('p', null, tasks.length ? tasks.join(' → ') : narration?.text || (events.length ? '수집된 작업 기록 ' + events.length + '건' : '중간 작업 기록 없음')));
      step.appendChild(process);
      const result = el('div', 'graph-result ' + request.workState);
      result.appendChild(el('strong', null, workLabel(request.workState)));
      result.appendChild(el('span', 'meta', answerLabel(request.answerState)));
      if (request.completion) result.appendChild(el('p', null, request.completion.summary));
      else if (request.remaining?.length) result.appendChild(el('p', null, '남은 작업 · ' + request.remaining.join(' · ')));
      result.appendChild(el('div', 'basis', request.completion?.basis || request.progress?.basis || '완료 근거 없음'));
      step.appendChild(result); flow.appendChild(step);
    }
    section.appendChild(flow);
  }
  return section;
}
