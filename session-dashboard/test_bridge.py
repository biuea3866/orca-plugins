import copy
import runpy
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from bridge import HostSupportProbe, PublishPolicy, publish, render

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

    def test_unpatched_host_throttles_changing_data_without_losing_latest_update(self):
        policy = PublishPolicy()
        self.assertTrue(policy.due({'sessions': [{'status': 'running'}]}, {}, 0, minimum_interval=30))
        for now in (3, 6, 15, 29):
            self.assertFalse(policy.due({'sessions': [{'status': 'idle', 'summary': str(now)}]}, {}, now, minimum_interval=30))
        self.assertTrue(policy.due({'sessions': [{'status': 'idle', 'summary': 'latest'}]}, {}, 30, minimum_interval=30))

    def test_host_support_tracks_app_switches_and_caches_between_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            patched = Path(directory) / 'Orca Dashboard.app/Contents'
            (patched / 'Resources').mkdir(parents=True)
            (patched / 'Resources/native-plugin-panel-data-support.json').write_text('{"version":1}')
            official = Path(directory) / 'Orca.app/Contents/MacOS/Orca'
            status = Mock(return_value={'app': {'pid': 123}})
            probe = HostSupportProbe(status)
            with patch('bridge.subprocess.check_output', side_effect=[str(patched / 'MacOS/Orca'), str(official), str(patched / 'MacOS/Orca')]):
                self.assertTrue(probe.check(0))
                self.assertTrue(probe.check(14))
                self.assertEqual(status.call_count, 1)
                self.assertFalse(probe.check(15))
                self.assertTrue(probe.check(30))

    def test_host_probe_failure_does_not_keep_previous_supported_state(self):
        status = Mock(side_effect=RuntimeError('Orca unavailable'))
        probe = HostSupportProbe(status)
        probe.supported = True
        self.assertFalse(probe.check(0))

    def test_data_updates_and_host_mode_change_do_not_change_document_identity(self):
        first = {'sessions': [], 'panelUpdateMode': 'document', 'panelUpdateNote': '기본 앱'}
        second = {'sessions': [], 'panelUpdateMode': 'persistent-frame'}
        pages = [render(snapshot, template=TEMPLATE) for snapshot in (first, second)]
        import re
        identity = lambda page: re.sub(r'(<script type="application/json" id="orca-panel-data">).*?(</script>)', r'\1\2', page)
        self.assertEqual(identity(pages[0]), identity(pages[1]))

    def test_atomic_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'panel.html'
            publish(path, 'old')
            publish(path, 'new')
            self.assertEqual(path.read_text(), 'new')
            self.assertFalse(path.with_suffix('.tmp').exists())

    def test_model_history_is_embedded_and_ui_loads_before_first_render(self):
        usage = {'source': 'router', 'current': None, 'items': [{'question': '</script><script>alert(1)</script>',
                 'usage': [{'model': 'gpt-6-luna', 'effort': 'low'}]}]}
        page = render({'sessions': [{'id': 'router-test', 'llmUsage': usage}]}, template=TEMPLATE)
        self.assertIn('function llmPanel(', page)
        self.assertIn('gpt-6-luna', page)
        self.assertNotIn('</script><script>alert(1)', page)
        self.assertLess(page.index('const cardWithoutLlm = card;'), page.index('renderList(); onRoute(); tick();'))
        self.assertIn('현재 실행 중인 모델 호출이 없습니다.', page)

if __name__ == '__main__':
    unittest.main()
