const terminalNavigationRequests = new Map();
const terminalNavigationState = new Map();
let terminalNavigationSequence = 0;

function updateTerminalNavigation(id, state) {
  terminalNavigationState.set(id, state);
  for (const box of document.querySelectorAll('.terminal-navigation')) {
    if (box.dataset.sessionId !== id) continue;
    const button = box.querySelector('button');
    button.disabled = !box.dataset.terminal || state.pending;
    button.textContent = state.pending ? '이동 중…' : '터미널로 이동';
    box.querySelector('.navigation-status').textContent = state.error || '';
  }
}

function terminalNavigation(session) {
  const box = el('div', 'terminal-navigation');
  box.dataset.sessionId = session.id;
  box.dataset.terminal = session.terminalHandle || '';
  const state = terminalNavigationState.get(session.id) || {};
  const button = el('button', null, state.pending ? '이동 중…' : '터미널로 이동');
  button.type = 'button';
  button.disabled = !session.terminalHandle || !!state.pending;
  button.title = session.terminalHandle ? '이 세션의 프로젝트와 터미널로 이동' : '연결된 터미널 없음';
  button.addEventListener('keydown', event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (!session.terminalHandle || terminalNavigationState.get(session.id)?.pending) return;
    const requestId = Date.now() + '-' + (++terminalNavigationSequence);
    updateTerminalNavigation(session.id, { pending: true });
    const timeout = setTimeout(() => {
      terminalNavigationRequests.delete(requestId);
      updateTerminalNavigation(session.id, { error: '이동 기능을 불러오지 못했습니다. Orca를 다시 열어주세요.' });
    }, 8000);
    terminalNavigationRequests.set(requestId, { id: session.id, timeout });
    window.parent.postMessage({ type: 'orca-dashboard-focus-terminal', requestId, terminal: session.terminalHandle }, '*');
  });
  box.appendChild(button);
  const status = el('span', 'navigation-status', state.error || '');
  status.setAttribute('role', 'status');
  box.appendChild(status);
  return box;
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'orca-dashboard-focus-terminal-result') return;
  const request = terminalNavigationRequests.get(event.data.requestId);
  if (!request) return;
  clearTimeout(request.timeout);
  terminalNavigationRequests.delete(event.data.requestId);
  updateTerminalNavigation(request.id, { error: event.data.ok ? '' : (event.data.error || '터미널 이동에 실패했습니다.') });
});
