import unittest

from collector import build_snapshot


class LiveSessionTests(unittest.TestCase):
    def test_closed_agent_is_excluded_but_open_idle_agent_remains(self):
        worktrees = [{'worktreeId': 'w', 'liveTerminalCount': 1, 'agents': [
            {'paneKey': 'tab:closed', 'state': 'working'},
            {'paneKey': 'tab:open', 'state': 'done'},
        ]}, {'worktreeId': 'closed', 'agents': [{'paneKey': 'old:pane'}]}]
        snapshot = build_snapshot(worktrees, [
            {'handle': 'term', 'tabId': 'tab', 'leafId': 'open', 'worktreeId': 'w'},
        ], {}, now_ms=1000, pipelines={})
        self.assertEqual([s['id'] for s in snapshot['sessions']], ['tab:open'])
        self.assertEqual(snapshot['kpi']['total'], 1)
        self.assertEqual(snapshot['kpi']['running'], 0)
        self.assertEqual([w['worktreeId'] for w in snapshot['noTerminal']], ['closed'])


if __name__ == '__main__':
    unittest.main()
