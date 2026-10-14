"""Evidence-backed request/answer history; answering is not completing a task."""
from datetime import datetime
import copy
import json
from pathlib import Path
import re
from progress import plan_from_records, request_text
from topics import group_requests
from work_log import add_event

LIMIT = 40
ETA_RE = re.compile(r'예상\s*(?:(?:완료|종료|소요)\s*)?(?:시간\s*)?(?:[:：은는약]|약\s*)*\s*(\d{1,3})\s*분')
COMPLETED_REPORT_RE = re.compile(r'(?:완료|적용|수정|추가|구현|처리|해결|검증)(?:했|됐|되었|하였)습니다')
UNFINISHED_REPORT_RE = re.compile(r'아직|미완료|미적용|하지 않았|적용하지|확인.*필요|승인|대기|예정|하겠습니다')


def timestamp(record):
    value = record.get('timestamp')
    try:
        return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def text_blocks(record):
    content = (record.get('message') or {}).get('content') or []
    if isinstance(content, str):
        return content
    return '\n'.join(block.get('text', '') for block in content
                     if isinstance(block, dict) and block.get('type') == 'text')


def new_request(identifier, question, at):
    return {'id': identifier, 'question': question[:1600], 'startedAt': at,
            'answerState': 'pending', 'answer': None, 'answeredAt': None,
            'workState': 'unknown', 'progress': {'percent': None, 'basis': '등록된 작업 계획 없음'},
            'completed': [], 'remaining': [], 'eta': {'at': None, 'basis': '예상 시간 산정 중'}}


def finish_request(request, records):
    events, calls = [], {}
    for record in records:
        at = timestamp(record)
        content = (record.get('message') or {}).get('content') or []
        if record.get('type') == 'assistant' and text_blocks(record).strip():
            add_event(events, 'answer' if (record.get('message') or {}).get('stop_reason') == 'end_turn' else 'narration', text_blocks(record), at)
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'tool_use':
                calls[block.get('id')] = block.get('name') or '도구'
            elif block.get('type') == 'tool_result' and block.get('tool_use_id') in calls:
                name = calls.pop(block['tool_use_id'])
                add_event(events, 'tool', name + (' · 오류 응답' if block.get('is_error') else ' · 응답 수신'), at,
                          'failed' if block.get('is_error') else 'returned')
    if events:
        request['workLog'] = events
    plan = plan_from_records(records)
    if plan:
        request['progress'] = plan['progress']
        steps = plan['checklist']['steps']
        request['completed'] = [s['title'] or f"작업 {s['number']}" for s in steps if s['state'] == 'done']
        request['remaining'] = [s['title'] or f"작업 {s['number']}" for s in steps if s['state'] != 'done']
        request['workState'] = 'completed' if not request['remaining'] else 'running'
        if request['workState'] == 'completed':
            request['eta'] = {'at': None, 'basis': '등록된 작업 완료'}
    elif request['answerState'] == 'completed':
        report = request.get('answer') or ''
        if COMPLETED_REPORT_RE.search(report) and not UNFINISHED_REPORT_RE.search(report):
            request['workState'] = 'completed'
            request['progress'] = {'percent': 100, 'basis': '에이전트의 명시적 완료 보고 기준', 'estimated': False}
            request['completed'] = [line.strip().lstrip('-* ')[:220] for line in report.splitlines()
                                    if COMPLETED_REPORT_RE.search(line)][:5]
            request['eta'] = {'at': None, 'basis': '에이전트가 완료를 보고함'}


def requests_from_records(records):
    requests, turn = [], []
    for record in records:
        if record.get('isSidechain') or record.get('isMeta'):
            continue
        question = request_text(record)
        if question and not question.startswith(('[Image:', '[Request interrupted')):
            if requests:
                finish_request(requests[-1], turn)
            at = timestamp(record)
            requests.append(new_request(str(record.get('uuid') or f'request-{len(requests)}-{at}'), question, at))
            turn = [record]
            continue
        if not requests:
            continue
        turn.append(record)
        if record.get('type') != 'assistant':
            continue
        reply = text_blocks(record).strip()
        message = record.get('message') or {}
        if reply:
            requests[-1]['answerState'] = 'working'
            at = timestamp(record)
            estimate = ETA_RE.search(reply)
            if estimate and at and 0 < int(estimate.group(1)) <= 240:
                requests[-1]['eta'] = {'at': at + int(estimate.group(1)) * 60_000,
                                      'basis': f'에이전트가 제시한 예상 소요 {estimate.group(1)}분'}
        if reply and message.get('stop_reason') == 'end_turn':
            requests[-1].update(answerState='completed', answer=reply[:2400], answeredAt=timestamp(record))
    if requests:
        finish_request(requests[-1], turn)
    return requests[-LIMIT:]


def summarize_requests(requests, source, previous=()):
    topics = group_requests(requests, previous)
    return {'items': requests, 'source': source, 'topics': topics,
            'answered': sum(r['answerState'] == 'completed' for r in requests),
            'workCompleted': sum(r['workState'] == 'completed' for r in requests),
            'workKnown': sum(r['progress']['percent'] is not None for r in requests)}


class InquiryTracker:
    def __init__(self, history_path=None):
        self.cache = {}
        self.history_path = history_path
        self.history = {}
        if history_path:
            try:
                self.history = json.loads(history_path.read_text())
                if not isinstance(self.history, dict):
                    self.history = {}
            except (OSError, ValueError):
                pass

    def collect(self, session, agent, path=None, now_ms=None, usage=None):
        agent = agent or {}
        requests = []
        source = 'observed'
        if path:
            path = Path(path)
            stat = path.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
            cached = self.cache.get(str(path))
            if cached and cached[0] == signature:
                requests = copy.deepcopy(cached[1])
            else:
                records = []
                with path.open() as file:
                    for line in file:
                        try:
                            record = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(record, dict):
                            records.append(record)
                requests = requests_from_records(records)
                if len(self.cache) > 64:
                    self.cache.clear()
                self.cache[str(path)] = signature, copy.deepcopy(requests)
            source = 'transcript'
        if session.get('agentType') == 'codex' and usage and usage.get('source') == 'transcript' and usage.get('items'):
            requests = []
            for item in usage['items'][-LIMIT:]:
                request = new_request(item['id'], item['question'], item.get('startedAt'))
                request['answerState'] = {'completed': 'completed', 'running': 'working',
                                          'cancelled': 'interrupted', 'interrupted': 'interrupted', 'failed': 'interrupted'}.get(item.get('state'), 'pending')
                request['answer'] = (item.get('answer') or '')[:2400] or None
                request['answeredAt'] = item.get('endedAt') if request['answerState'] == 'completed' else None
                request['workLog'] = copy.deepcopy(item.get('workLog') or [])
                finish_request(request, [])
                requests.append(request)
            source = 'transcript'
        if not requests:
            requests = copy.deepcopy(self.history.get(session['id'], [])[-LIMIT:])
            question = agent.get('prompt')
            if question and (not requests or requests[-1]['question'] != question[:1600]):
                requests.append(new_request(f"observed-{now_ms}", question, now_ms))
            if requests:
                latest = requests[-1]
                reply = agent.get('lastAssistantMessage')
                answer_finished = session.get('agentState') == 'done' or session.get('mainState') == 'done' or (agent.get('mainAgent') or {}).get('state') == 'done'
                if answer_finished and reply:
                    latest.update(answerState='completed', answer=reply[:2400])
                    latest['answeredAt'] = latest['answeredAt'] or now_ms
                    finish_request(latest, [])
                elif session.get('agentState') == 'working' and latest['answerState'] != 'completed':
                    latest['answerState'] = 'working'
        elif agent.get('prompt') and not ' '.join(requests[-1]['question'].split()).startswith(' '.join(agent['prompt'].split())):
            # A new live prompt can precede its transcript write. Keep it separate
            # rather than assigning the previous answer's plan to the new request.
            requests.append(new_request(f'observed-{now_ms}', agent['prompt'], now_ms))
        previous = self.history.get(session['id'], [])
        if requests:
            latest = requests[-1]
            # Only the current request may use the current session's plan/phase.
            if session.get('agentState') == 'working' and latest['answerState'] == 'pending':
                latest['answerState'] = 'working'
            progress = session.get('progress') or {}
            if latest['progress']['percent'] is None and session.get('checklist'):
                latest['progress'] = copy.deepcopy(progress)
                steps = session['checklist']['steps']
                latest['completed'] = [s.get('title') or f"Step {s['number']}" for s in steps if s['state'] == 'done']
                latest['remaining'] = [s.get('title') or f"Step {s['number']}" for s in steps if s['state'] != 'done']
                latest['workState'] = 'completed' if not latest['remaining'] else 'running'
            elif latest['progress']['percent'] is None and progress.get('estimated'):
                latest['progress'] = copy.deepcopy(progress)
                latest['workState'] = 'running'
        result = summarize_requests(requests[-LIMIT:], source, previous)
        # The panel is bounded; the saved completion/topic records are not
        # discarded when newer questions move them outside the display window.
        archive = {request['id']: copy.deepcopy(request) for request in previous}
        archive.update({request['id']: copy.deepcopy(request) for request in result['items']})
        self.history[session['id']] = list(archive.values())
        result['historyTotal'] = len(archive)
        return result

    def save(self):
        if not self.history_path:
            return
        value = json.dumps(self.history, ensure_ascii=False)
        if self.history_path.exists() and self.history_path.read_text() == value:
            return
        temporary = self.history_path.with_suffix('.tmp')
        temporary.write_text(value)
        temporary.replace(self.history_path)
