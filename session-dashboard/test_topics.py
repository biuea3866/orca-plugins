import copy
import tempfile
import unittest
from pathlib import Path

from inquiries import InquiryTracker, new_request, summarize_requests
from topics import group_requests
from llm_usage import parse_codex
from test_inquiries import user, answer
from inquiries import requests_from_records


def request(identifier, question):
    return new_request(identifier, question, 1000)


class TopicTests(unittest.TestCase):
    def test_related_followups_and_return_to_earlier_topic(self):
        items = [request('a', '로그인 버튼 오류를 해결해줘'),
                 request('b', '이것도 모바일에서 확인해줘'),
                 request('c', '별개로 결제 영수증 이메일을 구현해줘'),
                 request('d', '로그인 버튼 색상을 바꿔줘')]
        groups = group_requests(items)
        self.assertEqual(len(groups), 2)
        self.assertEqual(groups[0]['requestIds'], ['a', 'b', 'd'])
        self.assertEqual(groups[1]['requestIds'], ['c'])
        self.assertIn('후속', items[1]['topicBasis'])

    def test_generic_work_verbs_do_not_join_unrelated_topics(self):
        items = [request('a', '로그인 구현 수정 검증해줘'),
                 request('b', '결제 구현 수정 검증해줘')]
        self.assertEqual(len(group_requests(items)), 2)

    def test_korean_particles_and_joined_request_endings_match(self):
        items = [request('a', '대시보드에서 푸시 기록을 표시해줘'),
                 request('b', '대시보드에서도 푸시까지해줘')]
        self.assertEqual(len(group_requests(items)), 1)

    def test_explicit_topic_labels_group_even_without_shared_content(self):
        items = [request('a', '주제: 대시보드\n집계를 수정해줘'),
                 request('b', '주제: 라우터\n모델을 바꿔줘'),
                 request('c', '주제: 대시보드\n다이어그램을 추가해줘')]
        groups = group_requests(items)
        self.assertEqual(groups[0]['title'], '대시보드')
        self.assertEqual(groups[0]['requestIds'], ['a', 'c'])

    def test_group_identity_survives_refresh_restart_and_history_window(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.json'
            tracker = InquiryTracker(path)
            session = {'id': 's', 'agentState': 'working'}
            first = tracker.collect(session, {'prompt': '로그인 버튼 오류를 해결해줘'}, now_ms=1000)
            identifier = first['topics'][0]['id']
            tracker.collect(session, {'prompt': '이것도 확인해줘'}, now_ms=2000)
            tracker.save()
            restored = InquiryTracker(path).collect(session, {'prompt': '이것도 확인해줘'}, now_ms=3000)
            self.assertEqual(restored['topics'][0]['id'], identifier)
            retained = copy.deepcopy(restored['items'][1:])
            groups = group_requests(retained, restored['items'])
            self.assertEqual(groups[0]['id'], identifier)
            self.assertEqual(groups[0]['title'], '로그인 버튼 오류를 해결해줘')

    def test_work_report_has_evidence_and_new_followup_reopens_topic(self):
        items = requests_from_records([user('로그인 버튼 수정해줘'),
                                      answer('로그인 버튼을 수정해서 적용했습니다.'),
                                      user('이것도 확인해줘', 'q2')])
        data = summarize_requests(items, 'transcript')
        self.assertEqual(len(data['topics']), 1)
        self.assertEqual(data['topics'][0]['status'], 'running')
        self.assertEqual(data['topics'][0]['completed'], 1)
        self.assertEqual(items[0]['completion']['method'], 'agent-report')
        self.assertIn('완료 보고', items[0]['completion']['basis'])
        self.assertEqual(items[0]['workLog'][0]['kind'], 'answer')
        self.assertIsNone(items[1]['completion'])

    def test_plain_answer_does_not_create_completion_record(self):
        items = requests_from_records([user('로그인 구조를 설명해줘'), answer('로그인은 토큰을 사용합니다.')])
        summarize_requests(items, 'transcript')
        self.assertIsNone(items[0]['completion'])

    def test_saved_topic_and_completion_records_outlive_display_window(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.json'
            tracker = InquiryTracker(path)
            session = {'id': 's', 'agentState': 'done'}
            for index in range(45):
                result = tracker.collect(session, {'prompt': f'주제: 로그인\n질문 {index}',
                                                  'lastAssistantMessage': '수정해서 적용했습니다.'}, now_ms=1000 + index)
            self.assertEqual(len(result['items']), 40)
            self.assertEqual(result['historyTotal'], 45)
            tracker.save()
            saved = InquiryTracker(path).history['s']
            self.assertEqual(len(saved), 45)
            self.assertEqual(saved[0]['completion']['method'], 'agent-report')
            self.assertEqual(saved[0]['topicId'], saved[-1]['topicId'])

    def test_claude_failed_tool_and_plan_completion_are_recorded(self):
        records = [user('로그인 구현해줘'),
                   {'type': 'assistant', 'message': {'content': [
                       {'type': 'tool_use', 'id': 'bad', 'name': 'Bash', 'input': {}},
                       {'type': 'tool_use', 'id': 'plan', 'name': 'TodoWrite', 'input': {'todos': [{'content': '로그인 구현', 'status': 'completed'}]}}]}},
                   {'type': 'user', 'message': {'content': [
                       {'type': 'tool_result', 'tool_use_id': 'bad', 'is_error': True},
                       {'type': 'tool_result', 'tool_use_id': 'plan', 'content': 'ok'}]}}]
        items = requests_from_records(records)
        summarize_requests(items, 'transcript')
        self.assertEqual(items[0]['workLog'][0]['state'], 'failed')
        self.assertEqual(items[0]['completion']['method'], 'plan')
        self.assertEqual(items[0]['completion']['items'], ['로그인 구현'])

    def test_codex_late_tool_result_remains_with_original_question(self):
        def record(kind, payload):
            return {'type': kind, 'payload': payload, 'timestamp': '2026-10-14T00:00:00Z'}
        records = [record('event_msg', {'type': 'task_started', 'turn_id': 't'}),
                   record('event_msg', {'type': 'user_message', 'message': '로그인 수정해줘'}),
                   record('response_item', {'type': 'message', 'role': 'assistant', 'phase': 'commentary',
                                           'content': [{'type': 'output_text', 'text': '오류 원인을 확인하겠습니다.'}]}),
                   record('response_item', {'type': 'function_call', 'name': 'exec_command', 'call_id': 'call'}),
                   record('event_msg', {'type': 'user_message', 'message': '별개로 결제 구현해줘'}),
                   record('response_item', {'type': 'function_call_output', 'call_id': 'call', 'output': '{"exit_code": 1}'})]
        items = parse_codex(records)['items']
        self.assertEqual(items[0]['workLog'][-1]['state'], 'failed')
        self.assertEqual(items[1]['workLog'], [])


if __name__ == '__main__':
    unittest.main()
