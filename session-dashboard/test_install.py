import contextlib
import io
import os
import plistlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parent


class InstallTests(unittest.TestCase):
    def test_clean_home_installs_bundled_collector_and_login_service(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(Path, 'home', return_value=home), \
                 patch.object(sys, 'argv', ['install.py']), \
                 patch.object(subprocess, 'run') as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(SOURCE / 'install.py'), run_name='__main__')

            runtime = home / '.orca/session-dashboard'
            for filename in ['collector.py', 'bridge.py', 'progress.py', 'navigation.js']:
                self.assertEqual((runtime / filename).read_bytes(), (SOURCE / filename).read_bytes())
            self.assertFalse((home / '.claude/bin/orca-dashboard').exists())
            self.assertIn('첫 데이터 수집 중', (runtime / 'plugin/panel.html').read_text())
            self.assertTrue((runtime / 'plugin/orca-plugin.json').is_file())
            service = home / 'Library/LaunchAgents/com.biuea3866.orca-session-dashboard.plist'
            with service.open('rb') as file:
                spec = plistlib.load(file)
            self.assertEqual(spec['ProgramArguments'][-2:], ['--collector', str(runtime / 'collector.py')])
            self.assertEqual(run.call_args.args[0], ['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(service)])
            self.assertTrue(run.call_args.kwargs['check'])


if __name__ == '__main__':
    unittest.main()
