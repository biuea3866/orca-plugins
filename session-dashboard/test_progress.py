import unittest
from progress import ProgressTracker, plan_from_records, phase_from_records


def tool(name, args, result='ok', error=False, identifier='tool'):
    return [
        {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': identifier, 'name': name, 'input': args}]}},
        {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': identifier, 'content': result, 'is_error': error}]}},
    ]


class ProgressTests(unittest.TestCase):
    def test_completed_tasks_are_the_denominator_not_running_tasks(self):
        records = tool('TodoWrite', {'todos': [
            {'content': 'read', 'status': 'completed'},
            {'content': 'edit', 'status': 'in_progress'},
            {'content': 'test', 'status': 'pending'},
        ]})
        plan = plan_from_records(records)
        self.assertEqual(plan['progress']['percent'], 33)
        self.assertFalse(plan['progress']['estimated'])
        self.assertEqual([s['state'] for s in plan['checklist']['steps']], ['done', 'current', 'pending'])

    def test_failed_update_and_new_request_do_not_reuse_old_completion(self):
        records = tool('TodoWrite', {'todos': [{'status': 'completed'}]}, error=True)
        self.assertIsNone(plan_from_records(records))
        records = tool('TodoWrite', {'todos': [{'status': 'completed'}]})
        records.append({'type': 'user', 'message': {'content': [{'type': 'text', 'text': 'Fix another bug'}]}})
        self.assertIsNone(plan_from_records(records))

    def test_task_create_update_delete(self):
        records = tool('TaskCreate', {'subject': 'implement'}, 'Task #1 created successfully', identifier='a')
        records += tool('TaskCreate', {'subject': 'test'}, 'Task #2 created successfully', identifier='b')
        records += tool('TaskUpdate', {'taskId': '1', 'status': 'completed'}, identifier='c')
        self.assertEqual(plan_from_records(records)['progress']['percent'], 50)
        records += tool('TaskUpdate', {'taskId': '2', 'status': 'deleted'}, identifier='d')
        self.assertEqual(plan_from_records(records)['progress']['percent'], 100)

    def test_phase_estimate_advances_and_resets_for_a_new_prompt(self):
        tracker = ProgressTracker()
        def apply(tool_name, tool_input='', prompt='fix'):
            session = {'id': 's', 'agentState': 'working', 'status': 'running'}
            tracker.apply(session, {'prompt': prompt, 'toolName': tool_name, 'toolInput': tool_input})
            return session['progress']
        self.assertEqual(apply('Bash', 'pytest')['percent'], 0)
        self.assertEqual(apply('Edit')['percent'], 33)
        self.assertEqual(apply('Bash', 'pytest')['percent'], 67)
        self.assertEqual(apply('Read')['percent'], 67)
        self.assertEqual(apply('Read', prompt='new task')['percent'], 0)
        self.assertTrue(apply('Read', prompt='new task')['estimated'])

    def test_waiting_for_user_is_not_completion(self):
        tracker = ProgressTracker()
        for status, percent in [('waiting_user', 0), ('blocked', 0), ('idle', 100)]:
            session = {'id': status, 'agentState': 'done', 'status': status}
            tracker.apply(session)
            self.assertEqual(session['progress']['percent'], percent)
        resumed = {'id': 'idle', 'agentState': 'working', 'status': 'running'}
        tracker.apply(resumed)
        self.assertEqual(resumed['progress']['percent'], 0)

    def test_explicit_upstream_progress_wins(self):
        session = {'id': 's', 'progress': {'percent': 80, 'basis': 'explicit'}}
        ProgressTracker().apply(session)
        self.assertEqual(session['progress'], {'percent': 80, 'basis': 'explicit'})

    def test_transcript_recovers_current_phase_without_previous_turn_leak(self):
        records = tool('Edit', {}) + tool('Bash', {'command': 'pytest'})
        self.assertEqual(phase_from_records(records), 2)
        records.append({'type': 'user', 'message': {'content': [{'type': 'text', 'text': 'Investigate another issue'}]}})
        self.assertEqual(phase_from_records(records), 0)


if __name__ == '__main__':
    unittest.main()
