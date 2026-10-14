import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_router.cli import main
from llm_router.execution import command_for, execute, observe, validate_capabilities
from llm_router.policy import route, load_profiles
from llm_router.storage import SessionStore


class RouterTests(unittest.TestCase):
    def test_routing_is_conservative_and_continuations_keep_task_tier(self):
        self.assertEqual(route('이 내용을 요약해줘', 'codex')['tier'], 'quick')
        self.assertEqual(route('요약 기능을 구현해줘', 'codex')['tier'], 'standard')
        self.assertEqual(route('동시성 버그 수정해줘', 'codex')['tier'], 'deep')
        self.assertEqual(route('계속', 'codex', previous={'tier': 'deep'})['tier'], 'deep')
        self.assertEqual(route('어떻게 할까?', 'claude')['tier'], 'standard')
        with self.assertRaises(ValueError):
            route(' ', 'codex')

    def test_profiles_and_unsupported_effort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'profiles.json'
            config.write_text(json.dumps({'claude': {'quick': {'model': 'custom-model', 'effort': None}}}))
            result = route('요약해줘', 'claude', profiles=load_profiles(config))
            self.assertIsNone(result['effort'])
            (root / 'models_cache.json').write_text(json.dumps({'models': [{'slug': 'm', 'supported_reasoning_levels': [{'effort': 'low'}]}]}))
            with patch.dict(os.environ, {'CODEX_HOME': directory}), self.assertRaises(ValueError):
                validate_capabilities({'agent': 'codex', 'model': 'm', 'effort': 'xhigh'})

    def test_resume_command_uses_exact_conversation_and_no_shell(self):
        choice = route('구현해줘', 'codex')
        cmd = command_for(choice, 'session-uuid')
        self.assertEqual(cmd[:3], ['codex', 'exec', 'resume'])
        self.assertEqual(cmd[-2:], ['session-uuid', '-'])
        self.assertIn('sandbox_mode="read-only"', cmd)
        self.assertIn('model_reasoning_effort="medium"', cmd)
        cmd = command_for(route('요약해줘', 'claude'), 'claude-id', writable=True)
        self.assertEqual(cmd[-2:], ['--resume', 'claude-id'])
        self.assertIn('acceptEdits', cmd)

    def test_atomic_storage_and_simultaneous_session_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            with SessionStore(home=directory) as first:
                first.save({'id': first.identifier, 'requests': []})
                self.assertEqual(first.path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(first.read()['id'], first.identifier)
                with self.assertRaises(ValueError):
                    with SessionStore(first.identifier, home=directory):
                        pass
            self.assertFalse(list((Path(directory) / 'sessions').glob('.state-*')))

    def test_cli_executes_and_resumes_without_losing_question_or_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'codex'
            fake.write_text('#!' + sys.executable + '\n' + '''import sys,json,os
question=sys.stdin.read()
with open(os.environ['CAPTURE'], 'a') as f: f.write(json.dumps({'argv':sys.argv,'question':question})+'\\n')
print(json.dumps({'type':'thread.started','thread_id':'provider-session'}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'ok'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':10}}))
''')
            fake.chmod(0o755)
            env = {'LLM_ROUTER_HOME': str(root / 'state'), 'PATH': directory + os.pathsep + os.environ['PATH'], 'CAPTURE': str(root / 'calls')}
            with patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(['--cwd', directory, '--prompt', '요약해줘']), 0)
                path = next((root / 'state/sessions').glob('*.json'))
                identifier = json.loads(path.read_text())['id']
                self.assertEqual(main(['--cwd', directory, '--resume', identifier, '--prompt', '동시성 문제 찾아줘']), 0)
            state = json.loads(path.read_text())
            self.assertEqual([r['decision']['tier'] for r in state['requests']], ['quick', 'deep'])
            self.assertEqual(state['providerSessionId'], 'provider-session')
            self.assertEqual(state['status'], 'closed')
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            self.assertEqual(calls[1]['argv'][-2:], ['provider-session', '-'])
            self.assertEqual(calls[1]['question'], '동시성 문제 찾아줘')

    def test_zero_exit_without_completion_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'codex'
            executable.write_text('#!/bin/sh\ncat >/dev/null\nprintf \'{"type":"thread.started","thread_id":"s"}\\n\'\n')
            executable.chmod(0o755)
            with patch.dict(os.environ, {'PATH': directory + os.pathsep + os.environ['PATH']}):
                result = execute('question', route('question', 'codex'), directory)
            self.assertFalse(result['completed'])
            self.assertEqual(result['exitCode'], 0)

    def test_claude_response_model_is_separate_from_selected_alias(self):
        result = {'sessionId': None, 'actualModel': None, 'models': [], 'answer': '', 'completed': False}
        observe({'type': 'system', 'subtype': 'init', 'model': 'sonnet', 'session_id': 'c'}, result)
        observe({'type': 'assistant', 'message': {'model': 'claude-sonnet-version', 'content': [{'type': 'text', 'text': '답변'}]}}, result)
        observe({'type': 'result', 'subtype': 'success', 'is_error': False}, result)
        self.assertEqual(result['actualModel'], 'claude-sonnet-version')
        self.assertEqual(result['reportedModel'], 'sonnet')
        self.assertTrue(result['completed'])


if __name__ == '__main__':
    unittest.main()
