import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_router.gateway import Gateway, question_from, rewrite
from llm_router.learning import LearningStore, choose
from llm_router.native import launch_spec, codex_settings
from llm_router.policy import load_profiles, route


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'LLM_ROUTER_HOME': self.temp.name})
        self.env.start()
        self.calls = []
        self.reply_kind = 'end_turn'
        self.fail_response = False
        owner = self
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append({'body': body, 'headers': dict(self.headers), 'path': self.path})
                if owner.fail_response:
                    self.send_response(429)
                    self.end_headers()
                    self.wfile.write(b'{"error":{"message":"limited"}}')
                    return
                if self.path.startswith('/v1/messages'):
                    events = [
                        {'type': 'message_start', 'message': {'model': body['model'], 'usage': {'input_tokens': 10}}},
                        {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'ok'}},
                        {'type': 'message_delta', 'delta': {'stop_reason': owner.reply_kind}, 'usage': {'output_tokens': 4}},
                        {'type': 'message_stop'},
                    ]
                else:
                    events = [
                        {'type': 'response.created', 'response': {'model': body['model']}},
                        {'type': 'response.output_text.delta', 'delta': 'ok'},
                        {'type': 'response.completed', 'response': {'model': body['model'],
                         'output': [{'type': 'function_call'}] if owner.reply_kind == 'tool_use' else [],
                         'usage': {'input_tokens': 10, 'output_tokens': 4}}},
                    ]
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for event in events:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
            def log_message(self, *_):
                pass
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.upthread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upthread.start()
        self.gateways = []

    def gateway(self, agent):
        instance = Gateway(agent, f'http://127.0.0.1:{self.upstream.server_port}', home=self.root).start()
        self.gateways.append(instance)
        return instance

    def send(self, gateway, payload, session='s'):
        req = Request(gateway.url + ('/v1/messages' if gateway.agent == 'claude' else '/responses'),
                      json.dumps(payload).encode(), headers={'Authorization': 'Bearer test-secret',
                      'Content-Type': 'application/json', 'anthropic-beta': 'oauth-capability', 'session_id': session})
        with urlopen(req, timeout=10) as response:
            data = response.read()
        return data

    def tearDown(self):
        for gateway in self.gateways:
            gateway.close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.env.stop()
        self.temp.cleanup()

    def test_codex_native_requests_are_routed_and_streams_and_auth_are_preserved(self):
        gateway = self.gateway('codex')
        messages = [{'role': 'user', 'content': 'hello 번역해줘'}]
        result = self.send(gateway, {'model': 'original', 'input': messages, 'reasoning': {'effort': 'high', 'summary': 'auto'}, 'tools': [{'name': 't'}]})
        self.assertIn(b'response.completed', result)
        first = self.calls[0]
        self.assertEqual(first['body']['model'], 'gpt-6-luna')
        self.assertEqual(first['body']['reasoning'], {'effort': 'low', 'summary': 'auto'})
        self.assertEqual(first['headers']['Authorization'], 'Bearer test-secret')
        messages.extend([{'role': 'assistant', 'content': 'ok'}, {'role': 'user', 'content': '동시성 설계해줘'}])
        self.send(gateway, {'model': 'original', 'input': messages})
        state = next(iter(gateway.channels.values()))[1]
        self.assertEqual([r['decision']['tier'] for r in state['requests']], ['quick', 'deep'])
        self.assertEqual(state['requests'][-1]['actualModel'], 'gpt-6-astra')
        self.assertNotIn('test-secret', next((self.root / 'sessions').glob('*.json')).read_text())
        self.assertEqual(len(LearningStore(self.root).stats()), 2)
        self.assertTrue(all(row['evaluated'] == 0 for row in LearningStore(self.root).stats()))

    def test_claude_tool_loop_keeps_choice_and_new_questions_switch(self):
        gateway = self.gateway('claude')
        messages = [{'role': 'user', 'content': [{'type': 'text', 'text': '내용 요약해줘'}]}]
        self.reply_kind = 'tool_use'
        self.send(gateway, {'model': 'original', 'messages': messages, 'metadata': {'user_id': json.dumps({'session_id': 'claude-1'})}})
        messages.extend([{'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 't'}]},
                         {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'output'}]}])
        self.reply_kind = 'end_turn'
        self.send(gateway, {'model': 'original', 'messages': messages, 'metadata': {'user_id': json.dumps({'session_id': 'claude-1'})}})
        state = gateway.channels['claude-1'][1]
        self.assertEqual(len(state['requests']), 1)
        self.assertEqual(state['requests'][0]['calls'], 2)
        self.assertEqual(state['requests'][0]['state'], 'completed')
        self.assertEqual(state['requests'][0]['usage']['input_tokens'], 20)
        self.assertEqual(state['requests'][0]['usage']['output_tokens'], 8)
        self.assertEqual(self.calls[-1]['body']['model'], 'claude-sonnet-5-5')
        self.assertEqual(self.calls[-1]['body']['output_config']['effort'], 'low')
        self.assertEqual(self.calls[-1]['headers']['Anthropic-Beta'], 'oauth-capability')
        messages.append({'role': 'user', 'content': '보안 설계해줘'})
        self.send(gateway, {'model': 'original', 'messages': messages})
        self.assertEqual(self.calls[-1]['body']['model'], 'claude-opus-5-5')

    def test_concurrent_sessions_and_repeated_questions_remain_distinct(self):
        gateway = self.gateway('codex')
        q = {'model': 'original', 'input': [{'role': 'user', 'content': '요약해줘'}]}
        self.send(gateway, q, session='one')
        self.send(gateway, q, session='two')
        q['input'].extend([{'role': 'assistant', 'content': 'ok'}, {'role': 'user', 'content': '요약해줘'}])
        self.send(gateway, q, session='one')
        self.assertEqual(len(gateway.channels), 2)
        self.assertEqual(len(gateway.channels['one'][1]['requests']), 2)
        self.assertEqual(len(gateway.channels['two'][1]['requests']), 1)

    def test_upstream_failure_is_recorded_without_retrying_an_edit(self):
        from urllib.error import HTTPError
        gateway = self.gateway('codex')
        self.fail_response = True
        with self.assertRaises(HTTPError) as error:
            self.send(gateway, {'model': 'original', 'input': '코드 수정해줘'})
        self.assertEqual(error.exception.code, 429)
        error.exception.read()
        error.exception.close()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(gateway.channels['s'][1]['requests'][0]['state'], 'failed')

    def test_native_quota_and_title_helpers_do_not_replace_the_user_question(self):
        gateway = self.gateway('claude')
        self.send(gateway, {'model': 'original', 'messages': [{'role': 'user', 'content': 'quota'}]})
        self.assertEqual(self.calls[-1]['body']['model'], 'original')
        self.send(gateway, {'model': 'original', 'messages': [{'role': 'user', 'content': '<session>hello</session> Write the title in the predominant language'}]})
        self.assertEqual(self.calls[-1]['body']['model'], 'claude-sonnet-5-5')
        self.assertEqual(gateway.channels, {})

    def test_launch_preserves_native_ui_permissions_and_saved_auth(self):
        command, env = launch_spec('claude', '/vendor/claude', ['--permission-mode', 'plan'], 'http://local/token', {'AUTH': 'keep'})
        self.assertEqual(command, ['/vendor/claude', '--permission-mode', 'plan'])
        self.assertEqual(env['ANTHROPIC_BASE_URL'], 'http://local/token')
        self.assertNotIn('ANTHROPIC_AUTH_TOKEN', env)
        command, env = launch_spec('codex', '/vendor/codex', ['--sandbox', 'read-only'], 'http://local/token', {'AUTH': 'keep'})
        self.assertEqual(command[:3], ['/vendor/codex', '--sandbox', 'read-only'])
        self.assertIn('"requires_openai_auth"=true', command[-3])
        self.assertIn('"supports_websockets"=false', command[-3])
        self.assertEqual(env['AUTH'], 'keep')
        command, _ = launch_spec('codex', '/vendor/codex', [], 'http://local/token', {},
             {'_provider_id': 'custom', 'name': 'Custom', 'experimental_bearer_token': 'private-token'})
        self.assertNotIn('private-token', ' '.join(command))
        self.assertIn('model_providers.custom.supports_websockets=false', command)

    def test_profile_and_cli_provider_auth_stay_in_original_config(self):
        (self.root / 'config.toml').write_text('''model_provider="openai"
[profiles.local]
model_provider="company"
[model_providers.company]
name="Company"
base_url="https://gateway.example/v1"
env_key="COMPANY_KEY"
experimental_bearer_token="private-token"
''')
        upstream, info = codex_settings({'CODEX_HOME': str(self.root)}, ['--profile', 'local'])
        self.assertEqual(upstream, 'https://gateway.example/v1')
        command, _ = launch_spec('codex', '/vendor/codex', ['--profile', 'local'], 'http://local/token', {}, info)
        self.assertNotIn('private-token', ' '.join(command))
        self.assertIn('model_providers.company.base_url="http://local/token"', command)

    def test_direct_user_feedback_is_linked_to_previous_request(self):
        gateway = self.gateway('codex')
        messages = [{'role': 'user', 'content': '코드 수정해줘'}]
        self.send(gateway, {'model': 'original', 'input': messages})
        messages.append({'role': 'user', 'content': '틀렸어. 다시 확인해줘'})
        self.send(gateway, {'model': 'original', 'input': messages})
        request = gateway.channels['s'][1]['requests'][0]
        self.assertEqual(request['feedback']['quality'], 0)
        self.assertEqual(sum(row['evaluated'] for row in LearningStore(self.root).stats()), 1)
        messages.append({'role': 'user', 'content': '좋아. 계속'})
        self.send(gateway, {'model': 'original', 'input': messages})
        self.assertEqual(sum(row['evaluated'] for row in LearningStore(self.root).stats()), 1)

    def test_quality_feedback_updates_next_choice_but_not_from_transport_success(self):
        store = LearningStore(self.root)
        question = '코드 수정해줘'
        baseline = route(question, 'codex')
        for index in range(10):
            request = {'id': str(index), 'question': question, 'decision': baseline,
                       'startedAt': 1, 'endedAt': 1001, 'state': 'completed'}
            store.observe(request)
        self.assertEqual(choose(question, 'codex')['tier'], 'standard')
        for index in range(3):
            store.feedback(str(index), quality=0, evidence='tests')
        choice = choose(question, 'codex')
        self.assertEqual(choice['tier'], 'deep')
        self.assertEqual(choice['policy'], 'feedback-v1')
        self.assertEqual(choice['learningSamples'], 3)
        # Repeated reports update one observation, rather than counting duplicate votes.
        store.feedback('0', quality=1, evidence='user')
        self.assertEqual(store.stats()[0]['evaluated'], 3)
        self.assertEqual(choose('보안 설계해줘', 'codex')['tier'], 'deep')


if __name__ == '__main__':
    unittest.main()
