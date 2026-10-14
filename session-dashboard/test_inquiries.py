import tempfile
import unittest
from pathlib import Path
from inquiries import InquiryTracker, requests_from_records
from progress import plan_from_records


def user(text, identifier='q1'):
    return {'type': 'user', 'uuid': identifier, 'timestamp': '2026-10-09T00:00:00Z',
            'message': {'content': [{'type': 'text', 'text': text}]}}


def answer(text, stop='end_turn'):
    return {'type': 'assistant', 'timestamp': '2026-10-09T00:01:00Z',
            'message': {'stop_reason': stop, 'content': [{'type': 'text', 'text': text}]}}


class InquiryTests(unittest.TestCase):
    def test_answer_completion_is_not_work_completion(self):
        result = requests_from_records([user('기능 구현해줘'), answer('구현 방법을 설명합니다.')])[0]
        self.assertEqual(result['answerState'], 'completed')
        self.assertEqual(result['workState'], 'unknown')
        self.assertIsNone(result['progress']['percent'])
        self.assertIsNone(result['eta']['at'])

    def test_completion_reports_are_labelled_and_pending_preview_is_not_completed(self):
        result = requests_from_records([user('수정해줘'), answer('수정해서 적용했습니다.')])[0]
        self.assertEqual(result['workState'], 'completed')
        self.assertIn('완료 보고', result['progress']['basis'])
        preview = requests_from_records([user('수정해줘'), answer('미리보기를 추가했습니다. 실제 대시보드에는 아직 적용하지 않았습니다.')])[0]
        self.assertEqual(preview['workState'], 'unknown')

    def test_progress_is_scoped_to_its_question(self):
        records = [user('첫 작업')]
        records += [
            {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 't', 'name': 'TodoWrite', 'input': {'todos': [
                {'content': '서버 구현', 'status': 'completed'}, {'content': '검증', 'status': 'pending'}]}}]}},
            {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'ok'}]}},
            answer('검증을 진행하겠습니다.'), user('두 번째 작업', 'q2')]
        first, second = requests_from_records(records)
        self.assertEqual(first['progress']['percent'], 50)
        self.assertEqual(first['completed'], ['서버 구현'])
        self.assertEqual(first['remaining'], ['검증'])
        self.assertEqual(second['answerState'], 'pending')
        self.assertIsNone(second['progress']['percent'])

    def test_intermediate_answer_and_followup_do_not_prove_finished_answer(self):
        first, second = requests_from_records([user('조사해줘'), answer('조사 중입니다', 'tool_use'), user('이것도 확인해줘', 'q2')])
        self.assertEqual(first['answerState'], 'working')
        self.assertEqual(second['answerState'], 'pending')

    def test_system_messages_and_tool_outputs_are_not_requests(self):
        records = [user('실제 질문'), user('<task-notification>완료</task-notification>'), user('Base directory for this skill: /tmp'), answer('최종 답변')]
        self.assertEqual(len(requests_from_records(records)), 1)

    def test_string_history_and_pasted_question_preserve_real_requests(self):
        question = user('unused')
        question['message']['content'] = '<environment_context>cwd: /tmp</environment_context>\n<pasted_content id="1">검증 항목</pasted_content>\n이것도 수정해줘'
        reply = answer('unused')
        reply['message']['content'] = '답변입니다.'
        records = [question, user('<command-name>/mcp</command-name>'),
                   user('<local-command-stdout>Authenticated</local-command-stdout>'), reply]
        result = requests_from_records(records)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['question'], '검증 항목\n이것도 수정해줘')
        self.assertEqual(result[0]['answerState'], 'completed')

    def test_string_followup_resets_previous_plan(self):
        records = [user('첫 작업'),
                   {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 't', 'name': 'TodoWrite', 'input': {'todos': [{'content': '구현', 'status': 'completed'}]}}]}},
                   {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 't', 'content': 'ok'}]}},
                   {'type': 'user', 'message': {'content': '다음 작업'}}]
        self.assertIsNone(plan_from_records(records))

    def test_eta_requires_explicit_agent_estimate(self):
        result = requests_from_records([user('구현해줘'), answer('예상 소요 시간: 10분입니다.', 'tool_use')])[0]
        self.assertEqual(result['eta']['at'] - result['startedAt'], 11 * 60_000)

    def test_observed_history_survives_restart_and_does_not_claim_full_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.json'
            tracker = InquiryTracker(path)
            session = {'id': 's', 'agentState': 'working', 'progress': {'percent': 33, 'estimated': True}}
            tracker.collect(session, {'prompt': '첫 요청'}, now_ms=1000)
            tracker.save()
            next_tracker = InquiryTracker(path)
            result = next_tracker.collect(session, {'prompt': '두 번째 요청'}, now_ms=2000)
            self.assertEqual(result['source'], 'observed')
            self.assertEqual(len(result['items']), 2)

    def test_done_agent_does_not_fabricate_one_hundred_percent_work(self):
        session = {'id': 's', 'agentState': 'done', 'progress': {'percent': 100, 'estimated': False}}
        result = InquiryTracker().collect(session, {'prompt': '질문', 'lastAssistantMessage': '답변'}, now_ms=1000)
        self.assertEqual(result['answered'], 1)
        self.assertEqual(result['workCompleted'], 0)
        self.assertIsNone(result['items'][0]['progress']['percent'])

    def test_background_work_does_not_hide_completed_main_answer(self):
        session = {'id': 's', 'agentState': 'working', 'mainState': 'done'}
        result = InquiryTracker().collect(session, {'prompt': '질문', 'lastAssistantMessage': '답변'}, now_ms=1000)
        self.assertEqual(result['answered'], 1)

    def test_matched_codex_history_restores_questions_without_marking_interruption_complete(self):
        session = {'id': 's', 'agentType': 'codex', 'agentState': 'working'}
        usage = {'source': 'transcript', 'items': [
            {'id': 'q1', 'question': '첫 질문', 'state': 'completed', 'answer': '설명입니다.', 'startedAt': 1000, 'endedAt': 2000},
            {'id': 'q2', 'question': '중단된 요청', 'state': 'cancelled', 'startedAt': 3000},
            {'id': 'q3', 'question': '현재 요청', 'state': 'running', 'startedAt': 4000}]}
        result = InquiryTracker().collect(session, {'prompt': '현재 요청'}, now_ms=5000, usage=usage)
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(result['answered'], 1)
        self.assertEqual(result['items'][1]['answerState'], 'interrupted')


if __name__ == '__main__':
    unittest.main()
