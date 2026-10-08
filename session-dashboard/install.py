#!/usr/bin/env python3
"""Install the local dashboard bridge and its macOS login service."""
import os
import argparse
import json
from pathlib import Path
import plistlib
import runpy
import shutil
import subprocess
import sys

from bridge import publish, render

LABEL = 'com.biuea3866.orca-session-dashboard'
parser = argparse.ArgumentParser()
parser.add_argument('--persistent-frame', action='store_true')
args = parser.parse_args()
if args.persistent_frame:
    status = json.loads(subprocess.check_output(['orca', 'status', '--json'], text=True))
    pid = status['result']['app']['pid']
    executable = Path(subprocess.check_output(['ps', '-p', str(pid), '-o', 'comm='], text=True).strip())
    marker = executable.parent.parent / 'Resources/native-plugin-panel-data-support.json'
    if not marker.is_file():
        raise SystemExit('Start Orca Dashboard.app before enabling persistent-frame updates')
source = Path(__file__).resolve().parent
runtime = Path.home() / '.orca/session-dashboard'
plugin = runtime / 'plugin'
plugin.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / 'orca-plugin.json', plugin / 'orca-plugin.json')
shutil.copy2(source / 'bridge.py', runtime / 'bridge.py')
shutil.copy2(source / 'progress.py', runtime / 'progress.py')
shutil.copy2(source / 'navigation.js', runtime / 'navigation.js')
collector = runtime / 'collector.py'
shutil.copy2(source / 'collector.py', collector)
module = runpy.run_path(str(collector))
initial = module['error_snapshot']('첫 데이터 수집 중', module['now_millis']())
publish(plugin / 'panel.html', render(initial, template=module['PAGE_HTML']))
agents = Path.home() / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
plist_path = agents / f'{LABEL}.plist'
spec = {
    'Label': LABEL,
    'ProgramArguments': [sys.executable, str(runtime / 'bridge.py'), '--plugin-dir', str(plugin), '--collector', str(collector)],
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'EnvironmentVariables': {'PATH': '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', 'ORCA_CLI_COMMAND': shutil.which('orca') or '/usr/local/bin/orca'},
    'StandardOutPath': str(runtime / 'bridge.log'),
    'StandardErrorPath': str(runtime / 'bridge.log'),
}
if args.persistent_frame:
    spec['ProgramArguments'].append('--persistent-frame')
with plist_path.open('wb') as file:
    plistlib.dump(spec, file)
domain = f'gui/{os.getuid()}'
subprocess.run(['launchctl', 'bootout', f'{domain}/{LABEL}'], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist_path)], check=True)
print(f'Plugin development folder: {plugin}')
print(f'Login service: {LABEL}')
