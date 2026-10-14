"""Bounded evidence from agent narration and tool responses, per request."""
import re

LIMIT = 24


def add_event(events, kind, text, at=None, state=None):
    text = (text or '').strip()[:600]
    if not text:
        return
    event = {'kind': kind, 'text': text, 'at': at}
    if state:
        event['state'] = state
    if events and events[-1].get('kind') == kind and events[-1].get('text') == text:
        return
    events.append(event)
    if len(events) > LIMIT:
        # Retain the beginning and recent evidence; make the omission visible.
        events[1:-LIMIT + 2] = [{'kind': 'omitted', 'text': '중간 작업 기록 생략', 'at': None}]


def tool_result_state(output):
    if isinstance(output, str):
        match = re.search(r'(?:Process exited with code|exit_code["\s]*:|Exit code:)\s*(-?\d+)', output, re.I)
        if match:
            return 'success' if int(match[1]) == 0 else 'failed'
        if '"isError":true' in output or '"isError": true' in output:
            return 'failed'
    return 'returned'
