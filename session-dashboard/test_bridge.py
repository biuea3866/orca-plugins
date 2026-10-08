import copy
import runpy
import tempfile
from pathlib import Path
import unittest
from bridge import PublishPolicy, publish, render

MODULE = runpy.run_path(str(Path(__file__).resolve().with_name('collector.py')))
TEMPLATE = MODULE['PAGE_HTML']

class BridgeTests(unittest.TestCase):
    def test_transcript_cannot_break_script_boundary(self):
        page = render({'sessions': [{'name': '</script><script>alert(1)</script>'}]}, template=TEMPLATE)
        self.assertNotIn('</script><script>alert(1)', page)
        self.assertIn('\\u003c/script>', page)
        self.assertEqual(page.count('</script>'), TEMPLATE.count('</script>') + 1)

    def test_original_ui_and_synchronous_first_paint(self):
        page = render({'sessions': []}, template=TEMPLATE)
        for symbol in ['function ring(', 'function miniChecklist(', 'function agentTreePanel(', 'function timelinePanel(', '.card::before', '--blocked-bg: #fde8e6']:
            self.assertIn(symbol, page)
        self.assertIn('renderList(); onRoute(); tick();', page)
        self.assertNotIn('await fetch(', page)
        self.assertNotIn('poll();', page)
        self.assertNotIn('location.hash =', page)

    def test_timestamp_and_tool_churn_do_not_reload(self):
        policy = PublishPolicy()
        first = {'generatedAt': 1, 'lastSuccessAt': 1, 'sessions': [{'name': 'task', 'status': 'running', 'lastOutputAt': 1, 'toolName': 'Read'}]}
        self.assertTrue(policy.due(first, {}, 0))
        other = copy.deepcopy(first)
        other.update(generatedAt=3000, lastSuccessAt=3000)
        other['sessions'][0].update(lastOutputAt=3000, toolName='Bash')
        self.assertFalse(policy.due(other, {}, 3))
        self.assertFalse(policy.due(other, {}, 59))
        self.assertTrue(policy.due(other, {}, 60))

    def test_meaningful_changes_reload(self):
        for key, value in [('status', 'blocked'), ('progress', {'percent': 80}), ('summary', {'text': 'new result'})]:
            policy = PublishPolicy()
            baseline = {'sessions': [{'status': 'running'}]}
            policy.due(baseline, {}, 0)
            changed = copy.deepcopy(baseline)
            changed['sessions'][0][key] = value
            self.assertTrue(policy.due(changed, {}, 3))
        policy = PublishPolicy()
        policy.due({}, {'session': {'agents': {'children': []}}}, 0)
        self.assertTrue(policy.due({}, {'session': {'agents': {'children': [{'state': 'failed'}]}}}, 3))

    def test_collection_error_reload(self):
        policy = PublishPolicy()
        policy.due({'error': None}, {}, 0)
        self.assertTrue(policy.due({'error': 'Orca offline'}, {}, 3))
        self.assertFalse(policy.due({'error': 'Orca offline'}, {}, 6))

    def test_atomic_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'panel.html'
            publish(path, 'old')
            publish(path, 'new')
            self.assertEqual(path.read_text(), 'new')
            self.assertFalse(path.with_suffix('.tmp').exists())

if __name__ == '__main__':
    unittest.main()
