"""Read model/effort evidence and router state without guessing other sessions."""
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time
from work_log import add_event, tool_result_state
from inquiries import finish_request, summarize_requests

LIMIT = 40
MAX_BYTES = 4 * 1024 * 1024


def millis(value):
    try:
        return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def text_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(block.get('text', '') for block in content
                     if isinstance(block, dict) and block.get('type') in ('text', 'input_text', 'output_text'))


def normalize(value):
    return ' '.join((value or '').split())


def real_question(text):
    text = re.sub(r'<environment_context>.*?</environment_context>', '', text, flags=re.S).strip()
    if not text or text.startswith(('<task-notification>', '<system-reminder>', '[Request interrupted',
                                    'This session is being continued', '<turn_aborted>')):
        return None
    return text


def evidence(model, effort, source):
    return {'model': model, 'effort': effort, 'source': source,
            'effortSource': 'recorded' if effort else 'unknown'}


def parse_codex(records):
    items, contexts, turn_id = [], {}, None
    metadata = {}
    last_reply = None
    calls = {}
    for record in records:
        kind, payload = record.get('type'), record.get('payload') or {}
        at = millis(record.get('timestamp'))
        if kind == 'session_meta':
            metadata = payload
        elif kind == 'event_msg' and payload.get('type') == 'task_started':
            turn_id = payload.get('turn_id')
        elif kind == 'turn_context':
            turn_id = payload.get('turn_id') or turn_id
            value = evidence(payload.get('model'), payload.get('effort') or payload.get('reasoning_effort'), 'codex-turn-context')
            contexts[turn_id] = value
            for item in items:
                if item['turnId'] == turn_id and value not in item['usage']:
                    item['usage'].append(value)
        else:
            question = None
            if kind == 'event_msg' and payload.get('type') == 'user_message':
                question = payload.get('message')
            elif kind == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
                question = text_content(payload.get('content'))
            question = real_question(question or '')
            if question:
                if (items and items[-1]['turnId'] == turn_id and items[-1]['question'] == question[:1600]
                        and items[-1].get('questionSource') != kind):
                    continue
                items.append({'id': f"{turn_id}:{len(items)}", 'turnId': turn_id,
                              'question': question[:1600], 'startedAt': at, 'state': 'running',
                              'questionSource': kind,
                              'workLog': [],
                              'usage': [contexts[turn_id]] if turn_id in contexts else []})
            elif kind == 'event_msg' and payload.get('type') in ('task_complete', 'turn_aborted'):
                target = payload.get('turn_id') or turn_id
                for item in items:
                    if item['turnId'] == target:
                        item['state'] = 'completed' if payload['type'] == 'task_complete' else 'cancelled'
                        item['endedAt'] = at
                if items and payload.get('last_agent_message'):
                    items[-1]['answer'] = payload['last_agent_message'][:2400]
            elif kind == 'response_item' and payload.get('role') == 'assistant':
                last_reply = text_content(payload.get('content')) or last_reply
                if items and payload.get('phase') in ('final_answer', 'final'):
                    items[-1].update(state='completed', endedAt=at, answer=(last_reply or '')[:2400])
                if items:
                    add_event(items[-1]['workLog'], 'answer' if payload.get('phase') in ('final_answer', 'final') else 'narration', text_content(payload.get('content')), at)
            elif items and kind == 'response_item' and payload.get('type') in ('function_call', 'custom_tool_call'):
                calls[payload.get('call_id')] = (items[-1], payload.get('name') or '도구')
            elif kind == 'response_item' and payload.get('type') in ('function_call_output', 'custom_tool_call_output'):
                match = calls.pop(payload.get('call_id'), None)
                if match:
                    owner, name = match
                    state = tool_result_state(payload.get('output'))
                    label = {'success': '실행 성공', 'failed': '실행 실패', 'returned': '응답 수신'}[state]
                    add_event(owner['workLog'], 'tool', name + ' · ' + label, at, state)
    return {'items': items[-LIMIT:], 'sessionId': metadata.get('id'), 'cwd': metadata.get('cwd'), 'lastReply': last_reply}


def parse_claude(records):
    items, identifier = [], None
    for record in records:
        if record.get('isSidechain') or record.get('isMeta'):
            continue
        identifier = record.get('sessionId') or identifier
        message = record.get('message') or {}
        at = millis(record.get('timestamp'))
        if record.get('type') == 'user':
            question = real_question(text_content(message.get('content')))
            if question:
                items.append({'id': record.get('uuid') or f'claude-{len(items)}',
                              'question': question[:1600], 'startedAt': at, 'state': 'running', 'usage': []})
        elif items and record.get('type') == 'assistant':
            model = message.get('model')
            effort = record.get('effort') or message.get('effort')
            if model:
                value = evidence(model, effort, 'claude-assistant')
                if value not in items[-1]['usage']:
                    items[-1]['usage'].append(value)
            if message.get('stop_reason') == 'end_turn':
                items[-1].update(state='completed', endedAt=at, answer=text_content(message.get('content'))[:2400])
    return {'items': items[-LIMIT:], 'sessionId': identifier}


def read_records(path):
    """Bound input size; keep Codex metadata when reading a tail."""
    records = []
    with Path(path).open('rb') as file:
        header = file.readline()
        size = os.fstat(file.fileno()).st_size
        if size > MAX_BYTES:
            try:
                records.append(json.loads(header))
            except ValueError:
                pass
            file.seek(size - MAX_BYTES)
            file.readline()
        else:
            file.seek(0)
        for line in file:
            try:
                value = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(value, dict):
                records.append(value)
    return records


def alive(pid):
    try:
        if not isinstance(pid, int) or pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class UsageTracker:
    def __init__(self, *, codex_roots=None, router_root=None):
        home = Path.home()
        self.roots = codex_roots if codex_roots is not None else list(dict.fromkeys([
            Path(os.environ.get('CODEX_HOME', str(home / '.codex'))), home / '.codex',
            *sorted((home / 'Library/Application Support/orca/codex-accounts').glob('*/home'))]))
        self.router_root = Path(router_root or os.environ.get('LLM_ROUTER_HOME', str(home / '.orca/llm-router')))
        self.cache, self.paths = {}, []
        self.index_at = float('-inf')

    def read(self, path, parser):
        path = Path(path)
        stat = path.stat()
        key = (str(path), parser.__name__)
        signature = (stat.st_mtime_ns, stat.st_size)
        if key not in self.cache or self.cache[key][0] != signature:
            self.cache[key] = signature, parser(read_records(path))
        if len(self.cache) > 256:
            value = self.cache[key]
            self.cache.clear()
            self.cache[key] = value
        return copy.deepcopy(self.cache[key][1])

    def codex_paths(self):
        if time.monotonic() - self.index_at > 15:
            paths = []
            for root in self.roots:
                paths.extend((Path(root) / 'sessions').glob('*/*/*/*.jsonl'))
            self.paths = sorted(paths, key=lambda p: p.stat().st_mtime, reverse=True)[:300]
            self.index_at = time.monotonic()
        return self.paths

    def native(self, session, agent=None, claude_path=None):
        agent = agent or {}
        parsed = None
        try:
            if session.get('agentType') == 'claude' and claude_path:
                parsed = self.read(claude_path, parse_claude)
            elif session.get('agentType') == 'codex':
                matches = []
                prompt = normalize(agent.get('prompt'))
                reply = normalize(agent.get('lastAssistantMessage'))
                for path in self.codex_paths():
                    with path.open('rb') as file:
                        header = json.loads(file.readline())
                    metadata = header.get('payload') or {}
                    if metadata.get('cwd') != session.get('path'):
                        continue
                    if metadata.get('source') == 'exec' or isinstance(metadata.get('source'), dict):
                        # Child CLI jobs can overwrite Orca's prompt for their parent's pane.
                        # They have dedicated router records and must not become the TUI's history.
                        continue
                    candidate = self.read(path, parse_codex)
                    latest = candidate['items'][-1] if candidate['items'] else {}
                    question = normalize(latest.get('question'))
                    if (prompt and (question == prompt or len(agent.get('prompt', '')) >= 200 and question.startswith(prompt))) or (reply and reply in (normalize(candidate.get('lastReply')), normalize(latest.get('answer')))):
                        matches.append(candidate)
                # Two matching conversations are ambiguous, even in the same worktree.
                if len(matches) == 1:
                    parsed = matches[0]
        except (OSError, ValueError, UnicodeDecodeError):
            return {'items': [], 'current': None, 'source': 'unknown', 'error': '모델 사용 기록 읽기 실패'}
        if not parsed:
            return {'items': [], 'current': None, 'source': 'unknown'}
        items = parsed['items']
        latest = items[-1] if items else None
        current = None
        if latest and latest['state'] == 'running' and session.get('agentState') == 'working':
            current = latest
        return {**parsed, 'current': current, 'source': 'transcript'}

    def router_sessions(self):
        result = []
        directory = self.router_root / 'sessions'
        try:
            paths = sorted(directory.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:80]
        except OSError:
            return result
        for path in paths:
            try:
                state = json.loads(path.read_text())
                if state.get('schemaVersion') != 1 or not state.get('requests') or state.get('mode') == 'auxiliary':
                    continue
                if all(r.get('question', '').startswith('Generate a concise, single-line task title') for r in state['requests']):
                    continue
                live = alive(state.get('pid'))
                items = []
                for request in state['requests'][-LIMIT:]:
                    question = request.get('question', '')
                    if question == 'quota' or question.startswith('Generate a concise, single-line task title') or (question.startswith('<session>') and 'Write the title' in question):
                        continue
                    choice = request['decision']
                    model = request.get('actualModel') or request.get('recordedModel') or request.get('reportedModel') or request.get('forwardedModel') or choice['model']
                    models = request.get('models') or [model]
                    effort = request.get('recordedEffort') or choice.get('effort')
                    source = 'provider-response' if request.get('actualModel') else 'codex-turn-context' if request.get('recordedModel') else 'router-config'
                    item = {**request, 'usage': [evidence(m, effort, source) for m in models],
                            'selectedModel': choice['model'], 'reason': choice['reason'],
                            'routerSessionId': state['id'], 'policy': choice.get('policy'),
                            'learningSamples': choice.get('learningSamples', 0)}
                    for value in item['usage']:
                        value['effortSource'] = 'recorded' if request.get('recordedEffort') else 'configured'
                    if item['state'] == 'running' and not live:
                        item.update(state='interrupted', error='실행 프로세스가 종료되었습니다')
                    items.append(item)
                if not items:
                    continue
                current = items[-1] if live and items[-1]['state'] == 'running' else None
                result.append({**state, 'llmUsage': {'items': items, 'current': current, 'source': 'router'}})
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return result


def attach_router_sessions(snapshot, details, states, *, live_terminal_handles=()):
    """Dedicated router rows prevent stale pane IDs from overwriting native history."""
    snapshot['sessions'] = [session for session in snapshot['sessions'] if session.get('kind') != 'router']
    native_groups = {}
    unbound = []
    for state in states:
        if state.get('mode') != 'native':
            unbound.append(state)
            continue
        # Require an exact provider conversation, or a live pane AND matching prompt.
        # This prevents an old gateway on a reused pane from replacing another history.
        matches = []
        for session in snapshot['sessions']:
            if session.get('agentType') != state['agent'] or session.get('path') != state['cwd']:
                continue
            usage = session.get('llmUsage') or {}
            same_id = state.get('providerSessionId') and usage.get('sessionId') == state['providerSessionId']
            latest = state['llmUsage']['items'][-1]
            questions = usage.get('items', [])[-2:] + (session.get('requests') or {}).get('items', [])[-2:]
            same_question = any(normalize(item.get('question')) == normalize(latest['question'][:1600])
                                for item in questions)
            pane = session['id'] == state.get('paneKey') or (state.get('terminalHandle') and
                     session.get('terminalHandle') == state['terminalHandle'])
            if same_id or (pane and alive(state.get('pid')) and same_question):
                matches.append(session)
        if len(matches) == 1:
            native_groups.setdefault(matches[0]['id'], []).append(state)
        else:
            unbound.append(state)
    for identifier, group in native_groups.items():
        session = next(s for s in snapshot['sessions'] if s['id'] == identifier)
        usage = copy.deepcopy(session.get('llmUsage') or {'items': []})
        for state in sorted(group, key=lambda s: s.get('updatedAt', 0)):
            for item in state['llmUsage']['items']:
                matching = [original for original in usage['items'] if normalize(original.get('question')) == normalize(item['question'][:1600])]
                if matching:
                    target = min(matching, key=lambda original: abs((original.get('startedAt') or 0) - item['startedAt']))
                    target.update(item)
                else:
                    usage['items'].append(copy.deepcopy(item))
        usage['items'] = sorted(usage['items'], key=lambda i: i.get('startedAt') or 0)[-LIMIT:]
        running = [state['llmUsage']['current'] for state in group if state['llmUsage']['current']]
        usage['current'] = max(running, key=lambda i: i['startedAt']) if running else None
        usage['source'] = 'router'
        session['llmUsage'] = usage
        if identifier in details:
            details[identifier]['llmUsage'] = usage
    occupied_handles = {session.get('terminalHandle') for session in snapshot['sessions']
                        if session.get('terminalHandle')}
    live_handles = set(live_terminal_handles)
    # Historical records may enrich an exact conversation above, but are not
    # separate live sessions. A pane can outlive many router conversations.
    for state in sorted(unbound, key=lambda s: s.get('updatedAt', 0), reverse=True):
        if not alive(state.get('pid')):
            continue
        handle = state.get('terminalHandle')
        if state.get('mode') == 'native':
            if handle not in live_handles or handle in occupied_handles:
                continue
            occupied_handles.add(handle)
        elif state['llmUsage']['current'] is None:
            continue
        usage = state['llmUsage']
        latest = usage['items'][-1]
        active = usage['current'] is not None
        session_id = 'router:' + state['id']
        requests = []
        for item in usage['items']:
            requests.append({'id': item['id'], 'question': item['question'][:1600],
                             'startedAt': item['startedAt'], 'answerState': 'completed' if item['state'] == 'completed' else 'working' if item['state'] == 'running' else 'pending',
                             'answer': item.get('answer'), 'answeredAt': item.get('endedAt'), 'workState': 'unknown',
                             'progress': {'percent': None, 'basis': '모델 응답과 작업 완료는 별도로 확인합니다'},
                             'completed': [], 'remaining': [], 'eta': {'at': None, 'basis': '예상 시간 정보 없음'}})
            requests[-1]['workLog'] = copy.deepcopy(item.get('workLog') or [])
            finish_request(requests[-1], [])
        request_data = summarize_requests(requests, 'router')
        session = {'id': session_id, 'kind': 'router', 'name': 'LLM Router · ' + Path(state['cwd']).name,
                   'path': state['cwd'], 'repo': Path(state['cwd']).name, 'worktreeId': state.get('worktreeId'),
                   'terminalHandle': state.get('terminalHandle') if alive(state.get('pid')) else None,
                   'agentType': state['agent'], 'agentState': 'working' if active else 'done',
                   'status': 'running' if active else 'blocked' if latest['state'] in ('failed', 'interrupted') else 'idle',
                   'reason': latest.get('error') or ('답변 생성 중' if active else '다음 질문 대기'),
                   'summary': {'text': latest.get('answer') or latest['question'][:240], 'source': 'router'},
                   'lastOutputAt': state.get('updatedAt'), 'progress': {'percent': None, 'basis': '라우터 실행 기록'},
                   'checklist': None, 'requests': request_data, 'llmUsage': usage}
        snapshot['sessions'].append(session)
        details[session_id] = {'session': session, 'requests': request_data, 'llmUsage': usage,
                               'blockers': [], 'transcript': False, 'agents': {'children': []}, 'timeline': []}
