"""Loopback streaming gateway shared by native CLIs and plugin callers.

Credentials are forwarded in memory to the configured upstream, never persisted.
Each native launch has an unguessable endpoint; concurrent API sessions are isolated.
"""
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import secrets
import threading
from urllib.parse import urlsplit
import uuid
from .learning import LearningStore, choose
from .storage import SessionStore, now_ms

HOP = {'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
       'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'accept-encoding'}
MODEL_ALIASES = {'sonnet': 'claude-sonnet-5-5', 'opus': 'claude-opus-5-5', 'haiku': 'claude-haiku-5-5'}


def auxiliary_question(question):
    return question.startswith(('Generate a concise, single-line task title',
                                'Generate a short title for', 'Create a short title for')) or (
                                    question.startswith('<session>') and 'Write the title' in question)


def content_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return '\n'.join(block.get('text', '') for block in content if isinstance(block, dict)
                     and block.get('type') in ('text', 'input_text'))


def question_from(payload, agent):
    messages = payload.get('messages' if agent == 'claude' else 'input', [])
    if isinstance(messages, str):
        return messages.strip(), hashlib.sha256(messages.encode()).hexdigest()
    users = []
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        text = content_text(message.get('content'))
        text = re.sub(r'<(?:environment_context|system-reminder)>.*?</(?:environment_context|system-reminder)>', '', text, flags=re.S).strip()
        if not text or text.startswith(('<task-notification>', '<turn_aborted>', '[Request interrupted')):
            continue
        users.append(text)
    if not users:
        return None, None
    # Full user-only history distinguishes repeated questions without tool-loop duplicates.
    signature = hashlib.sha256(json.dumps(users, ensure_ascii=False).encode()).hexdigest()
    return users[-1], signature


def rewrite(payload, choice):
    value = dict(payload)
    model = choice['model']
    if choice['agent'] == 'claude':
        model = os.environ.get('ANTHROPIC_DEFAULT_' + model.upper() + '_MODEL', MODEL_ALIASES.get(model, model))
        output = dict(value.get('output_config') or {})
        if choice.get('effort'):
            output['effort'] = choice['effort']
        else:
            output.pop('effort', None)
        value['output_config'] = output
    else:
        reasoning = dict(value.get('reasoning') or {})
        if choice.get('effort'):
            reasoning['effort'] = choice['effort']
        else:
            reasoning.pop('effort', None)
        value['reasoning'] = reasoning
    value['model'] = model
    return value


class StreamObserver:
    def __init__(self, agent, request, save):
        self.agent, self.request, self.save = agent, request, save
        self.buffer = b''
        self.completed = False
        self.stop_reason = None
        self.usage = {}

    def feed(self, chunk):
        self.buffer += chunk
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            if not line.startswith(b'data:'):
                continue
            try:
                event = json.loads(line[5:].strip())
            except (ValueError, UnicodeDecodeError):
                continue
            self.event(event)
        if len(self.buffer) > 8 * 1024 * 1024:
            self.buffer = b''

    def event(self, event):
        if not isinstance(event, dict):
            return
        kind = event.get('type')
        body = event.get('response') or event.get('message') or event
        if isinstance(body, dict) and body.get('model'):
            model = body['model']
            self.request['actualModel'] = model
            if model not in self.request['models']:
                self.request['models'].append(model)
            self.save()
        delta = event.get('delta')
        if kind == 'response.output_text.delta' and isinstance(delta, str):
            self.request['answer'] = ((self.request.get('answer') or '') + delta)[-8000:]
        elif kind == 'content_block_delta' and isinstance(delta, dict) and delta.get('type') == 'text_delta':
            self.request['answer'] = ((self.request.get('answer') or '') + delta.get('text', ''))[-8000:]
        if isinstance(body, dict) and body.get('usage'):
            self.usage.update(body['usage'])
        if kind == 'message_delta':
            self.stop_reason = (event.get('delta') or {}).get('stop_reason')
        if kind == 'message_stop':
            self.completed = True
        if kind == 'response.completed':
            self.completed = True
            self.stop_reason = 'tool_use' if any(item.get('type') in ('function_call', 'custom_tool_call')
                                                for item in body.get('output', [])) else 'end_turn'
        if kind in ('response.failed', 'response.incomplete', 'error'):
            self.request['error'] = ((body.get('error') or {}).get('message') or
                                     (event.get('error') or {}).get('message') or kind)[:2000]


class Gateway:
    def __init__(self, agent, upstream, *, mode='native', home=None, cwd=None):
        if agent not in ('claude', 'codex'):
            raise ValueError('지원하지 않는 agent입니다')
        self.agent, self.upstream = agent, urlsplit(upstream.rstrip('/'))
        if self.upstream.scheme not in ('http', 'https') or not self.upstream.hostname or self.upstream.username:
            raise ValueError('유효한 upstream URL이 필요합니다')
        self.mode, self.home = mode, home
        self.cwd = cwd or os.getcwd()
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.channels = {}
        self.learning = LearningStore(home)
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass  # Headers, credentials and prompt bodies never enter server logs.

            def do_GET(self):
                gateway.handle(self)

            def do_POST(self):
                gateway.handle(self)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return f'http://127.0.0.1:{self.server.server_port}/{self.token}'

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        with self.lock:
            for store, state, *_ in self.channels.values():
                state.update(status='closed', pid=None)
                for request in state['requests']:
                    if request['state'] == 'running':
                        request.update(state='interrupted', endedAt=now_ms())
                        self.learning.observe(request)
                store.save(state)

    def begin(self, payload, headers):
        question, signature = question_from(payload, self.agent)
        if not question or question == 'quota' or auxiliary_question(question):
            return None, None, None
        channel = (headers.get('session_id') or headers.get('session-id') or
                   headers.get('x-codex-session-id') or payload.get('prompt_cache_key'))
        if self.agent == 'claude':
            user_id = (payload.get('metadata') or {}).get('user_id', '')
            try:
                channel = json.loads(user_id).get('session_id')
            except (ValueError, AttributeError, TypeError):
                match = re.search(r'session_([a-zA-Z0-9-]+)$', str(user_id))
                channel = match[1] if match else None
        channel = channel or 'main'
        with self.lock:
            if channel not in self.channels:
                store = SessionStore(home=self.home)
                state = {'schemaVersion': 1, 'id': store.identifier, 'agent': self.agent,
                         'mode': 'auxiliary' if auxiliary_question(question) else self.mode,
                         'cwd': self.cwd, 'createdAt': now_ms(), 'pid': os.getpid(),
                         'paneKey': os.environ.get('ORCA_PANE_KEY'),
                         'terminalHandle': os.environ.get('ORCA_TERMINAL_HANDLE'),
                         'worktreeId': os.environ.get('ORCA_WORKTREE_ID'),
                         'providerSessionId': channel if channel != 'main' else None, 'requests': [], 'status': 'idle'}
                self.channels[channel] = [store, state, None, None]
            entry = self.channels[channel]
            store, state, previous_signature, request = entry
            if signature != previous_signature:
                if request and request['state'] == 'completed':
                    feedback = None
                    if re.match(r'^(?:틀렸|잘못(?:됐|된|했)|아니[,.! ]|다시\s*해|that(?:\x27s| is) wrong|incorrect|it (?:failed|doesn\x27t work))', question, re.I):
                        feedback = 0
                    elif re.match(r'^(?:테스트(?:가|는)?\s*(?:모두\s*)?통과|정답이야|답이 맞아|the tests (?:all )?passed|that(?:\x27s| is) correct)', question, re.I):
                        feedback = 1
                    if feedback is not None:
                        try:
                            self.learning.feedback(request['id'], quality=feedback, evidence='user')
                            request['feedback'] = {'quality': feedback, 'evidence': 'user'}
                        except ValueError:
                            pass
                previous = request['decision'] if request else None
                decision = choose(question, self.agent, previous=previous, home=self.home)
                if request and request['state'] == 'running':
                    request.update(state='interrupted', endedAt=now_ms())
                request = {'id': str(uuid.uuid4()), 'question': question, 'startedAt': now_ms(),
                           'decision': decision, 'state': 'running', 'effort': decision['effort'],
                           'effortSource': 'configured', 'actualModel': None, 'models': [], 'answer': '',
                           'calls': 0}
                state['requests'] = (state['requests'] + [request])[-100:]
                entry[2:] = [signature, request]
            request.update(state='running', calls=request['calls'] + 1)
            request.pop('error', None)
            state['status'] = 'running'
            store.save(state)
            return store, state, request

    def error(self, handler, code, message):
        data = json.dumps({'error': {'type': 'router_error', 'message': message}}).encode()
        handler.send_response(code)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def handle(self, handler):
        prefix = '/' + self.token
        if not handler.path.startswith(prefix + '/'):
            return self.error(handler, 404, 'Unknown endpoint')
        path = handler.path[len(prefix):]
        request = store = state = None
        connection = None
        sent = False
        try:
            length = int(handler.headers.get('Content-Length', '0'))
            if length < 0 or length > 64 * 1024 * 1024:
                return self.error(handler, 413, 'Request too large')
            body = handler.rfile.read(length) if length else None
            is_inference = handler.command == 'POST' and path.split('?')[0] in ('/responses', '/v1/responses', '/v1/messages')
            payload = json.loads(body) if is_inference and body else None
            if payload:
                store, state, request = self.begin(payload, handler.headers)
                if request:
                    payload = rewrite(payload, request['decision'])
                    request['forwardedModel'] = payload['model']
                    body = json.dumps(payload, ensure_ascii=False).encode()
                else:
                    question, _ = question_from(payload, self.agent)
                    if question and auxiliary_question(question):
                        payload = rewrite(payload, choose('제목을 요약해줘', self.agent, home=self.home))
                        body = json.dumps(payload, ensure_ascii=False).encode()
            headers = {key: value for key, value in handler.headers.items() if key.lower() not in HOP}
            headers['Accept-Encoding'] = 'identity'
            headers['Content-Length'] = str(len(body or b''))
            cls = http.client.HTTPSConnection if self.upstream.scheme == 'https' else http.client.HTTPConnection
            connection = cls(self.upstream.hostname, self.upstream.port, timeout=300)
            connection.request(handler.command, self.upstream.path.rstrip('/') + path, body=body, headers=headers)
            response = connection.getresponse()
            handler.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP and key.lower() != 'content-encoding':
                    handler.send_header(key, value)
            handler.send_header('Connection', 'close')
            handler.end_headers()
            handler.close_connection = True
            sent = True
            def save():
                if store:
                    with self.lock:
                        store.save(state)
            observer = StreamObserver(self.agent, request, save) if request else None
            captured = bytearray()
            while chunk := response.read1(65536):
                handler.wfile.write(chunk)
                handler.wfile.flush()
                if observer and response.status < 400:
                    observer.feed(chunk)
                if len(captured) < 1024 * 1024:
                    captured.extend(chunk[:1024 * 1024 - len(captured)])
            if request:
                # Non-streaming plugin requests share exactly the same routing path.
                if not observer.completed and response.status < 400 and not captured.lstrip().startswith((b'data:', b'event:', b':')):
                    value = json.loads(captured)
                    if self.agent == 'claude':
                        observer.event({'type': 'message_start', 'message': value})
                        request['answer'] = content_text(value.get('content'))[-8000:]
                        observer.stop_reason = value.get('stop_reason')
                        observer.completed = bool(observer.stop_reason)
                    else:
                        observer.event({'type': 'response.completed', 'response': value})
                request['endedAt'] = now_ms()
                totals = request.setdefault('usage', {})
                for key, value in observer.usage.items():
                    if isinstance(value, (int, float)):
                        totals[key] = totals.get(key, 0) + value
                if response.status >= 400:
                    request.update(state='failed', error=f'공급자 HTTP {response.status}')
                elif observer.completed and not request.get('error'):
                    request['state'] = 'running' if observer.stop_reason == 'tool_use' else 'completed'
                else:
                    request.update(state='failed', error=request.get('error') or '완료 이벤트 없이 응답이 종료되었습니다')
                state['status'] = 'running' if request['state'] == 'running' else 'idle'
                save()
                if request['state'] != 'running':
                    self.learning.observe(request)
        except (OSError, ValueError, http.client.HTTPException) as error:
            if request:
                request.update(state='cancelled' if isinstance(error, BrokenPipeError) else 'failed',
                               error=type(error).__name__, endedAt=now_ms())
                with self.lock:
                    state['status'] = 'idle'
                    store.save(state)
                self.learning.observe(request)
            if not sent:
                self.error(handler, 502, 'Upstream request failed: ' + type(error).__name__)
        finally:
            if connection:
                connection.close()
