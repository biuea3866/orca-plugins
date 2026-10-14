import copy
import json
from pathlib import Path
import subprocess
import unittest
from bridge import PANEL_DATA_BUDGET, panel_data, script_json


def fixture(count=3, history=8):
    sessions = []
    for index in range(count):
        requests = {'source': 'transcript', 'answered': history, 'workCompleted': 0, 'workKnown': 0,
                    'items': [{'id': f'{index}-{turn}', 'question': '질문🙂</script>' * 90,
                               'answer': '답변' * 100, 'answerState': 'completed', 'workState': 'unknown',
                               'progress': {'percent': None}} for turn in range(history)]}
        sessions.append({'id': str(index), 'name': f'세션 {index}', 'requests': requests,
                         'llmUsage': {'items': copy.deepcopy(requests['items'])}})
    snapshot = {'generatedAt': 1000, 'sessions': sessions, 'warnings': [], 'kpi': {}}
    details = {session['id']: {'session': session, 'requests': session['requests'],
                              'llmUsage': session['llmUsage'], 'timeline': []} for session in sessions}
    return snapshot, details


class PanelPayloadTests(unittest.TestCase):
    def test_duplicate_histories_are_sent_once_and_hydrate_without_loss(self):
        snapshot, details = fixture()
        original = copy.deepcopy({'snapshot': snapshot, 'details': details})
        data = panel_data(snapshot, details)
        self.assertNotIn('session', data['details']['0'])
        self.assertNotIn('requests', data['details']['0'])
        self.assertNotIn('llmUsage', data['details']['0'])
        self.assertEqual(original, {'snapshot': snapshot, 'details': details})
        source = Path(__file__).with_name('live-ui.js').read_text()
        script = '''const vm=require('node:vm'),assert=require('node:assert/strict');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const context={};vm.createContext(context);vm.runInContext(input.source,context);
const restored=context.hydratePanelData(input.data);
assert.deepEqual(JSON.parse(JSON.stringify(restored.details)),input.original.details);
assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot)),input.original.snapshot);'''
        subprocess.run(['node', '-e', script], input=json.dumps({'source': source, 'data': data, 'original': original}),
                       text=True, check=True, capture_output=True)

    def test_detail_specific_session_values_survive_compaction(self):
        snapshot, details = fixture(1, 1)
        details['0'] = copy.deepcopy(details['0'])
        details['0']['session']['reason'] = '상세 전용 값'
        data = panel_data(snapshot, details)
        self.assertEqual(data['details']['0']['sessionOverrides'], {'reason': '상세 전용 값'})

    def test_large_multilingual_history_is_bounded_and_keeps_current_requests(self):
        snapshot, details = fixture(15, 40)
        original = copy.deepcopy({'snapshot': snapshot, 'details': details})
        self.assertGreater(len(script_json(original).encode()), PANEL_DATA_BUDGET)
        data = panel_data(snapshot, details, budget=80_000)
        self.assertLessEqual(len(script_json(data).encode()), 80_000)
        self.assertEqual(len(data['snapshot']['sessions']), 15)
        for session in data['snapshot']['sessions']:
            self.assertEqual(session['requests']['items'][-1]['id'], session['id'] + '-39')
            self.assertEqual(session['requests']['answered'], len(session['requests']['items']))
        self.assertTrue(data['snapshot']['warnings'])
        self.assertEqual(original, {'snapshot': snapshot, 'details': details})

    def test_unbounded_metadata_never_produces_a_host_rejected_document(self):
        snapshot, details = fixture(1, 1)
        snapshot['unknownLargeField'] = '🙂' * 40_000
        data = panel_data(snapshot, details, budget=8000)
        self.assertLessEqual(len(script_json(data).encode()), 8000)
        self.assertIn('패널 크기 제한', data['snapshot']['error'])


if __name__ == '__main__':
    unittest.main()
