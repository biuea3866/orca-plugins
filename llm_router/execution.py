"""Execute one turn, resume the exact conversation, and observe structured events."""
import json
import os
import signal
import subprocess
from pathlib import Path
import uuid


def validate_capabilities(decision):
    """A local catalog establishes options, not account entitlement."""
    if decision['agent'] != 'codex':
        return
    root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    path = root / 'models_cache.json'
    if not path.exists():
        return
    try:
        catalog = json.loads(path.read_text()).get('models', [])
    except (OSError, ValueError):
        return
    model = next((m for m in catalog if m.get('slug') == decision['model']), None)
    if model:
        supported = {entry.get('effort') for entry in model.get('supported_reasoning_levels', [])}
        if supported and decision['effort'] and decision['effort'] not in supported:
            raise ValueError(f"{decision['model']}은 effort {decision['effort']}를 지원하지 않습니다")


def codex_recorded_settings(session_id):
    """Read settings from the exact provider conversation, never the latest session."""
    try:
        identifier = str(uuid.UUID(session_id))
    except (ValueError, TypeError, AttributeError):
        return {}
    root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'sessions'
    try:
        paths = list(root.glob('*/*/*/*' + identifier + '.jsonl'))
        if len(paths) != 1:
            return {}
        settings = {}
        with paths[0].open('rb') as file:
            size = os.fstat(file.fileno()).st_size
            if size > 2 * 1024 * 1024:
                file.seek(size - 2 * 1024 * 1024)
                file.readline()
            for line in file:
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if record.get('type') == 'turn_context':
                    payload = record.get('payload') or {}
                    settings = {'recordedModel': payload.get('model'),
                                'recordedEffort': payload.get('effort') or payload.get('reasoning_effort')}
        return settings
    except OSError:
        return {}


def command_for(decision, session_id=None, *, writable=False):
    model, effort = decision['model'], decision['effort']
    if decision['agent'] == 'codex':
        args = ['codex', 'exec']
        if session_id:
            args += ['resume']
        args += ['--json', '--skip-git-repo-check', '--model', model,
                 '-c', 'approval_policy="never"',
                 '-c', 'sandbox_mode=' + json.dumps('workspace-write' if writable else 'read-only')]
        if effort:
            args += ['-c', 'model_reasoning_effort=' + json.dumps(effort)]
        if session_id:
            args.append(session_id)
        return args + ['-']
    args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--model', model,
            '--permission-mode', 'acceptEdits' if writable else 'plan']
    if effort:
        args += ['--effort', effort]
    if session_id:
        args += ['--resume', session_id]
    return args


def observe(event, result):
    """Only a provider completion event proves a successful answer."""
    kind = event.get('type')
    text = None
    if kind == 'thread.started':
        result['sessionId'] = event.get('thread_id')
    elif kind == 'system' and event.get('subtype') == 'init':
        result['sessionId'] = event.get('session_id')
        result['reportedModel'] = event.get('model')
    elif kind == 'assistant':
        message = event.get('message') or {}
        model = message.get('model')
        if model:
            result['actualModel'] = model
            if model not in result['models']:
                result['models'].append(model)
        text = '\n'.join(block.get('text', '') for block in message.get('content', [])
                         if isinstance(block, dict) and block.get('type') == 'text')
    elif kind == 'item.completed':
        item = event.get('item') or {}
        if item.get('type') == 'agent_message':
            text = item.get('text')
    elif kind == 'turn.completed':
        result.update(completed=True, usage=event.get('usage'))
    elif kind == 'result':
        result['completed'] = not event.get('is_error') and event.get('subtype') == 'success'
        result['usage'] = event.get('usage')
        if event.get('is_error'):
            result['error'] = event.get('result') or '; '.join(event.get('errors') or []) or 'Claude 실행 실패'
        result['sessionId'] = event.get('session_id') or result['sessionId']
        if not result['answer']:
            text = event.get('result') if isinstance(event.get('result'), str) else None
    elif kind in ('turn.failed', 'error'):
        result['completed'] = False
        result['error'] = event.get('message') or (event.get('error') or {}).get('message') or '에이전트 실행 실패'
    if text:
        result['answer'] = text[-8000:]
    return text


def execute(question, decision, cwd, session_id=None, *, writable=False, on_event=None, output=print):
    validate_capabilities(decision)
    result = {'sessionId': session_id, 'actualModel': None, 'reportedModel': None,
              'models': [], 'answer': '', 'completed': False, 'error': None, 'usage': None}
    process = subprocess.Popen(command_for(decision, session_id, writable=writable), cwd=cwd,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                               start_new_session=True, env={**os.environ, 'LLM_ROUTER_BYPASS': '1'})
    try:
        process.stdin.write(question)
        process.stdin.close()
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            text = observe(event, result)
            if text:
                output(text)
            if on_event:
                on_event(result)
        result['exitCode'] = process.wait()
        if decision['agent'] == 'codex':
            result.update(codex_recorded_settings(result['sessionId']))
        result['completed'] = result['completed'] and result['exitCode'] == 0 and not result['error']
        if not result['completed']:
            result['error'] = result['error'] or f"완료 이벤트를 확인하지 못했습니다 (exit {result['exitCode']})"
        return result
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        raise
    finally:
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()
