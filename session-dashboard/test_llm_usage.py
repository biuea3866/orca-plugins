import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from llm_usage import UsageTracker, attach_router_sessions, parse_claude, parse_codex


def record(kind, payload, second=0):
    return {'type': kind, 'payload': payload, 'timestamp': f'2026-10-09T08:00:{second:02d}Z'}


def conversation(identifier, question, model='gpt-6.1-sol', cwd='/project'):
    return [record('session_meta', {'id': identifier, 'cwd': cwd}),
            record('event_msg', {'type': 'task_started', 'turn_id': 'turn-1'}),
            record('turn_context', {'turn_id': 'turn-1', 'model': model, 'effort': 'high'}),
            record('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': question}]}, 1)]


class UsageTests(unittest.TestCase):
    def test_native_gateway_overrides_transcript_settings_without_duplicate_card(self):
        original = {'id': 'pane', 'agentType': 'codex', 'path': '/project', 'llmUsage': {
            'sessionId': 'conversation', 'items': [{'id': 'old', 'question': '요약해줘', 'startedAt': 10,
                'usage': [{'model': 'startup-model', 'effort': 'high'}]}]}}
        item = {'id': 'new', 'question': '요약해줘', 'startedAt': 12, 'state': 'completed',
                'usage': [{'model': 'routed-model', 'effort': 'low', 'source': 'provider-response'}]}
        state = {'id': 'router', 'agent': 'codex', 'cwd': '/project', 'mode': 'native',
                 'providerSessionId': 'conversation', 'llmUsage': {'items': [item], 'current': None}}
        snapshot, details = {'sessions': [original]}, {'pane': {'session': original}}
        attach_router_sessions(snapshot, details, [state])
        self.assertEqual(len(snapshot['sessions']), 1)
        usage = original['llmUsage']
        self.assertEqual(len(usage['items']), 1)
        self.assertEqual(usage['items'][0]['usage'][0]['model'], 'routed-model')
        self.assertEqual(usage['source'], 'router')
        self.assertIsNone(usage['current'])
        self.assertEqual(details['pane']['llmUsage'], usage)

    def test_codex_context_before_question_and_model_change(self):
        records = conversation('a', '버그 원인 찾아줘')
        records += [record('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '여기도 확인해줘'}]}, 2),
                    record('turn_context', {'turn_id': 'turn-1', 'model': 'gpt-6-astra', 'effort': 'xhigh'}, 3)]
        items = parse_codex(records)['items']
        self.assertEqual(len(items), 2)
        self.assertEqual([v['model'] for v in items[0]['usage']], ['gpt-6.1-sol', 'gpt-6-astra'])
        self.assertEqual(items[1]['usage'][-1]['effort'], 'xhigh')

    def test_next_turn_does_not_inherit_old_effort(self):
        records = conversation('a', '첫 질문')
        records += [record('event_msg', {'type': 'task_complete', 'turn_id': 'turn-1'}, 2),
                    record('event_msg', {'type': 'task_started', 'turn_id': 'turn-2'}, 3),
                    record('event_msg', {'type': 'user_message', 'message': '둘째 질문'}, 4),
                    record('turn_context', {'turn_id': 'turn-2', 'model': 'gpt-6-luna', 'effort': 'low'}, 5)]
        items = parse_codex(records)['items']
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['state'], 'completed')
        self.assertEqual(items[-1]['usage'][0]['effort'], 'low')

    def test_environment_and_tool_outputs_are_not_questions(self):
        records = conversation('a', '<environment_context>secret context</environment_context>')
        records.append(record('response_item', {'type': 'function_call_output', 'output': 'hello'}))
        self.assertEqual(parse_codex(records)['items'], [])

    def test_claude_multiple_models_unknown_effort_and_sidechain(self):
        records = [{'type': 'user', 'uuid': 'q', 'message': {'content': '요약해줘'}},
                   {'type': 'assistant', 'isSidechain': True, 'message': {'model': 'other'}},
                   {'type': 'assistant', 'message': {'model': 'claude-sonnet', 'content': []}},
                   {'type': 'assistant', 'message': {'model': 'claude-opus', 'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': '답변'}]}}]
        item = parse_claude(records)['items'][0]
        self.assertEqual([v['model'] for v in item['usage']], ['claude-sonnet', 'claude-opus'])
        self.assertEqual(item['usage'][0]['effortSource'], 'unknown')
        self.assertEqual(item['state'], 'completed')

    def test_same_directory_sessions_must_match_and_ambiguity_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'sessions/2026/10/09'
            folder.mkdir(parents=True)
            for name, question in [('a', '첫 질문'), ('b', '둘째 질문')]:
                (folder / (name + '.jsonl')).write_text('\n'.join(json.dumps(r) for r in conversation(name, question)))
            tracker = UsageTracker(codex_roots=[root], router_root=root)
            session = {'agentType': 'codex', 'agentState': 'working', 'path': '/project'}
            result = tracker.native(session, {'prompt': '첫 질문'})
            self.assertEqual(result['sessionId'], 'a')
            self.assertEqual(result['current']['usage'][0]['effort'], 'high')
            self.assertEqual(tracker.native(session, {'prompt': '다른 질문'})['source'], 'unknown')
            (folder / 'b.jsonl').write_text('\n'.join(json.dumps(r) for r in conversation('b', '첫 질문')))
            self.assertEqual(tracker.native(session, {'prompt': '첫 질문'})['source'], 'unknown')

    def test_done_native_session_has_no_current_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'c.jsonl'
            path.write_text(json.dumps({'type': 'user', 'message': {'content': '질문'}}) + '\n' +
                            json.dumps({'type': 'assistant', 'message': {'model': 'opus'}}))
            tracker = UsageTracker(codex_roots=[], router_root=directory)
            result = tracker.native({'agentType': 'claude', 'agentState': 'done'}, claude_path=path)
            self.assertIsNone(result['current'])
            self.assertEqual(result['items'][0]['usage'][0]['model'], 'opus')

    def test_child_exec_does_not_replace_parent_native_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'sessions/2026/10/09'
            folder.mkdir(parents=True)
            records = conversation('child', 'child question')
            records[0]['payload']['source'] = 'exec'
            (folder / 'child.jsonl').write_text('\n'.join(json.dumps(r) for r in records))
            tracker = UsageTracker(codex_roots=[root], router_root=root)
            result = tracker.native({'agentType': 'codex', 'agentState': 'working', 'path': '/project'}, {'prompt': 'child question'})
            self.assertEqual(result['source'], 'unknown')

    def test_crashed_router_is_not_current_and_does_not_replace_native(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'sessions').mkdir()
            state = {'schemaVersion': 1, 'id': 'r', 'pid': 123, 'cwd': '/project', 'agent': 'codex', 'paneKey': 'native',
                     'requests': [{'id': 'q', 'question': '질문', 'startedAt': 1, 'state': 'running',
                                   'decision': {'model': 'm', 'effort': 'low', 'reason': 'rule'}}]}
            (root / 'sessions/r.json').write_text(json.dumps(state))
            with patch('llm_usage.alive', return_value=False):
                states = UsageTracker(codex_roots=[], router_root=root).router_sessions()
                self.assertIsNone(states[0]['llmUsage']['current'])
                self.assertEqual(states[0]['llmUsage']['items'][0]['state'], 'interrupted')
                snapshot, details = {'sessions': [{'id': 'native'}]}, {}
                attach_router_sessions(snapshot, details, states)
            self.assertEqual(snapshot['sessions'][0], {'id': 'native'})
            self.assertEqual(len(snapshot['sessions']), 1)
            self.assertEqual(details, {})

    def test_unmatched_native_records_do_not_duplicate_open_pane(self):
        original = {'id': 'pane', 'terminalHandle': 'term', 'agentType': 'codex',
                    'path': '/project', 'llmUsage': {'items': []}}
        state = self.router_state('old', handle='term')
        snapshot, details = {'sessions': [original]}, {}
        with patch('llm_usage.alive', return_value=True):
            attach_router_sessions(snapshot, details, [state], live_terminal_handles=['term'])
        self.assertEqual(snapshot['sessions'], [original])
        self.assertEqual(original['llmUsage'], {'items': []})

    def test_unbound_native_uses_newest_record_per_live_terminal(self):
        states = [self.router_state('old', handle='term', updated=1),
                  self.router_state('new', handle='term', updated=2),
                  self.router_state('closed', handle='closed', updated=3)]
        snapshot, details = {'sessions': []}, {}
        with patch('llm_usage.alive', return_value=True):
            attach_router_sessions(snapshot, details, states, live_terminal_handles=['term'])
        self.assertEqual([s['id'] for s in snapshot['sessions']], ['router:new'])
        self.assertEqual(list(details), ['router:new'])

    def test_standalone_router_only_shows_live_call(self):
        done = self.router_state('done', mode='gateway')
        active = self.router_state('active', mode='gateway')
        active['llmUsage']['items'][0]['state'] = 'running'
        active['llmUsage']['current'] = active['llmUsage']['items'][0]
        snapshot, details = {'sessions': []}, {}
        with patch('llm_usage.alive', return_value=True):
            attach_router_sessions(snapshot, details, [done, active])
        self.assertEqual([s['id'] for s in snapshot['sessions']], ['router:active'])

    @staticmethod
    def router_state(identifier, *, handle=None, updated=1, mode='native'):
        return {'id': identifier, 'pid': 123, 'agent': 'codex', 'cwd': '/project',
                'mode': mode, 'terminalHandle': handle, 'updatedAt': updated,
                'llmUsage': {'items': [{'id': 'q', 'question': '질문', 'startedAt': 1,
                                      'state': 'completed', 'usage': []}], 'current': None}}


if __name__ == '__main__':
    unittest.main()
