"""Progress from explicit task plans, with a labelled coarse phase fallback."""
import json
from pathlib import Path
import re

STAGES = ['확인·분석', '구현·처리', '검증']
IMPLEMENT = re.compile(r'\b(?:edit|write|apply_patch|patch|upsert|create|update|send|post|delete|publish)\b', re.I)
VERIFY = re.compile(r'\b(?:pytest|vitest|unittest|tsc|test|verify|check|build)\b', re.I)


def request_text(record):
    if record.get('type') != 'user':
        return ''
    content = (record.get('message') or {}).get('content') or []
    if not isinstance(content, list):
        return ''
    request = '\n'.join(block.get('text', '') for block in content
                        if isinstance(block, dict) and block.get('type') == 'text').strip()
    return '' if request.startswith(('<', 'Base directory for this skill:', 'This session is being continued')) else request


def phase_from_records(records):
    phase = 0
    for record in records:
        if request_text(record):
            phase = 0
        content = (record.get('message') or {}).get('content') or []
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get('type') != 'tool_use':
                continue
            name = (block.get('name') or '').replace('_', ' ')
            args = block.get('input') or {}
            if IMPLEMENT.search(name):
                phase = max(phase, 1)
            if phase >= 1 and name == 'Bash' and VERIFY.search(str(args.get('command', ''))):
                phase = 2
    return phase


def plan_from_records(records):
    """Only successful plan tool calls count; failed tools cannot advance progress."""
    calls, tasks, todos = {}, {}, None
    for record in records:
        message = record.get('message') or {}
        content = message.get('content') or []
        if not isinstance(content, list):
            continue
        if request_text(record):
            calls, tasks, todos = {}, {}, None
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'tool_use':
                calls[block.get('id')] = block
            elif block.get('type') == 'tool_result' and not block.get('is_error'):
                call = calls.pop(block.get('tool_use_id'), {})
                args = call.get('input') or {}
                if call.get('name') == 'TodoWrite' and isinstance(args.get('todos'), list):
                    todos = args['todos']
                elif call.get('name') == 'TaskCreate':
                    match = re.search(r'Task #?(\d+)', str(block.get('content', '')), re.I)
                    if match:
                        tasks[match.group(1)] = {'content': args.get('subject', ''), 'status': 'pending'}
                elif call.get('name') == 'TaskUpdate':
                    key = str(args.get('taskId'))
                    if key in tasks:
                        if args.get('status') == 'deleted':
                            del tasks[key]
                        elif args.get('status') in ('pending', 'in_progress', 'completed'):
                            tasks[key]['status'] = args['status']
    steps = todos if todos is not None else list(tasks.values())
    steps = [step for step in steps if isinstance(step, dict) and step.get('status') in ('pending', 'in_progress', 'completed')]
    if not steps:
        return None
    done = sum(step['status'] == 'completed' for step in steps)
    return {
        'progress': {'percent': (done * 100 + len(steps) // 2) // len(steps), 'basis': f'등록된 작업 {done}/{len(steps)}개 완료', 'estimated': False},
        'checklist': {'pipeline': '작업 계획', 'steps': [
            {'number': i + 1, 'title': step.get('content') or step.get('subject') or '',
             'state': {'completed': 'done', 'in_progress': 'current', 'pending': 'pending'}[step['status']]}
            for i, step in enumerate(steps)
        ]},
    }


class ProgressTracker:
    def __init__(self):
        self.phases = {}
        self.plans = {}

    def read_evidence(self, path):
        path = Path(path)
        stat = path.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
        cached = self.plans.get(str(path))
        if cached and cached[0] == signature:
            return cached[1]
        records = []
        with path.open() as file:
            for line in file:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
        plan = plan_from_records(records), phase_from_records(records)
        if len(self.plans) > 64:
            self.plans.clear()
        self.plans[str(path)] = signature, plan
        return plan

    def apply(self, session, agent=None, plan=None, phase_hint=0):
        if session.get('progress', {}).get('percent') is not None:
            return
        agent = agent or {}
        if plan:
            session.update(plan)
            return
        key = session['id']
        prompt = agent.get('prompt')
        previous_prompt, phase = self.phases.get(key, (prompt, 0))
        if prompt != previous_prompt or (phase == 3 and session.get('agentState') != 'done'):
            phase = 0
        phase = max(phase, phase_hint)
        name = (agent.get('toolName') or session.get('toolName') or '').replace('_', ' ')
        tool_input = agent.get('toolInput') or ''
        if not isinstance(tool_input, str):
            tool_input = json.dumps(tool_input)
        if IMPLEMENT.search(name) or re.search(r'\bapply_patch\b', tool_input):
            phase = max(phase, 1)
        # TDD can run tests before implementation, so tests alone do not
        # imply that the implementation phase is complete.
        if phase >= 1 and VERIFY.search(tool_input):
            phase = 2
        if session.get('agentState') == 'done' and session.get('status') == 'idle':
            phase = 3
        self.phases[key] = prompt, phase
        if phase == 3:
            session['progress'] = {'percent': 100, 'basis': '현재 응답 완료 · 다음 지시 대기', 'estimated': False}
        else:
            session['progress'] = {'percent': [0, 33, 67][phase], 'basis': f'단계 추정 · {STAGES[phase]} ({phase + 1}/3단계) · 전체 작업량 기준 아님', 'estimated': True}
