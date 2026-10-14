#!/usr/bin/env python3
"""Publish read-only dashboard snapshots through Orca's dev-panel file watcher."""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import time
from progress import ProgressTracker
from inquiries import InquiryTracker
from llm_usage import UsageTracker, attach_router_sessions

PANEL_DATA_BUDGET = 900 * 1024
DOCUMENT_UPDATE_INTERVAL = 30


class HostSupportProbe:
    """Re-check the running app, including switches back to the official app."""
    def __init__(self, read_status, interval=15):
        self.read_status = read_status
        self.interval = interval
        self.next_check = float('-inf')
        self.supported = False

    def check(self, now):
        if now < self.next_check:
            return self.supported
        self.next_check = now + self.interval
        self.supported = False
        try:
            status = self.read_status()
            pid = status['app']['pid']
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                return False
            executable = Path(subprocess.check_output(
                ['ps', '-p', str(pid), '-o', 'comm='], text=True, timeout=3).strip())
            marker = executable.parent.parent / 'Resources/native-plugin-panel-data-support.json'
            self.supported = json.loads(marker.read_text()).get('version') == 1
        except Exception:
            # An optional host capability must not interrupt session collection.
            self.supported = False
        return self.supported

def script_json(value):
    # Transcript text must never be interpreted as an HTML script boundary.
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def panel_data(snapshot, details, budget=PANEL_DATA_BUDGET):
    """Send session histories once and bound the exact escaped wire payload."""
    sessions = {session.get('id'): session for session in snapshot.get('sessions', [])}
    compact_details = {}
    for identifier, detail in details.items():
        entry = dict(detail)
        session = sessions.get(identifier)
        if session is not None:
            original = entry.pop('session', {})
            overrides = {key: value for key, value in original.items() if key not in session or value != session[key]}
            if overrides:
                entry['sessionOverrides'] = overrides
            for key in ('requests', 'llmUsage'):
                if entry.get(key) == session.get(key):
                    entry.pop(key, None)
        else:
            entry['session'] = detail.get('session', {})
        compact_details[identifier] = entry
    data = copy.deepcopy({'compact': 1, 'snapshot': snapshot, 'details': compact_details})
    fits = lambda: len(script_json(data).encode('utf-8')) <= budget
    if fits():
        return data
    data['snapshot'].setdefault('warnings', []).append('패널 크기 제한으로 오래된 이력과 긴 내용을 생략했습니다. 원본 기록은 보존됩니다.')

    def shrink(value):
        changed = False
        if isinstance(value, dict):
            items = value.get('items')
            if isinstance(items, list) and len(items) > 1:
                value.setdefault('historyTotal', len(items))
                value['items'] = items[len(items) // 2:]
                if 'answered' in value:
                    value['answered'] = sum(item.get('answerState') == 'completed' for item in value['items'])
                    value['workCompleted'] = sum(item.get('workState') == 'completed' for item in value['items'])
                    value['workKnown'] = sum((item.get('progress') or {}).get('percent') is not None for item in value['items'])
                changed = True
            timeline = value.get('timeline')
            if isinstance(timeline, list) and timeline:
                value['timeline'] = timeline[len(timeline) // 2 + 1:]
                changed = True
            for key, child in list(value.items()):
                if isinstance(child, str) and key in ('answer', 'question', 'lastReply', 'text', 'reason', 'toolInput', 'summary') and len(child) > 512:
                    value[key] = child[:max(512, len(child) // 2)] + '…'
                    changed = True
                else:
                    changed = shrink(child) or changed
        elif isinstance(value, list):
            for child in value:
                changed = shrink(child) or changed
        return changed

    for _ in range(24):
        if not shrink(data) or fits():
            break
    if not fits():
        # Never publish a document the host cannot parse, even for pathological input.
        data = {'compact': 1, 'snapshot': {'generatedAt': snapshot.get('generatedAt'),
                'sessions': [], 'kpi': {'total': 0, 'running': 0, 'waitingUser': 0, 'blockedOrStale': 0},
                'error': '세션 데이터가 패널 크기 제한을 초과했습니다. 원본 기록은 보존되어 있습니다.'}, 'details': {}}
    return data


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("Dashboard template changed: " + old[:60])
    return text.replace(old, new, 1)


def render(snapshot, interval=3, *, template, details=None):
    """Keep the upstream dashboard's CSS and rendering functions intact."""
    page = template
    page = replace_once(page, 'else if (session.progress && session.progress.basis && session.progress.percent !== null)',
        'if (session.progress && session.progress.basis)')
    page = replace_once(page, 'label.textContent = percent === null ? "–" : percent + "%";',
        'label.textContent = percent === null ? "–" : (progress.estimated ? "~" : "") + percent + "%";')
    navigation = (Path(__file__).parent / 'navigation.js').read_text()
    page = replace_once(page, 'function card(session) {', navigation + '\nfunction card(session) {')
    page = replace_once(page, 'node.appendChild(top);', 'node.appendChild(top);\n  node.appendChild(terminalNavigation(session));')
    page = replace_once(page, 'section.appendChild(info);\n  return section;',
        'info.appendChild(terminalNavigation(session));\n  section.appendChild(info);\n  return section;')
    data = panel_data(snapshot, details or {})
    page = replace_once(page, '<script>\n\"use strict\";', '<script type=\"application/json\" id=\"orca-panel-data\">' + script_json(data) + '</script>\n<script>\n\"use strict\";')
    page = replace_once(page, 'let latest = null;',
        'let embedded = hydratePanelData(JSON.parse(document.getElementById(\"orca-panel-data\").textContent));\nlet latest = embedded.snapshot;\nlet selectedSessionId = null;')
    page = replace_once(page, 'location.hash = "#session=" + encodeURIComponent(id);',
        'selectedSessionId = id; onRoute();')
    begin = page.index('function routeId() {')
    end = page.index('\nfunction onRoute()', begin)
    page = page[:begin] + 'function routeId() { return selectedSessionId; }\n' + page[end:]
    begin = page.index('function goBack() {')
    end = page.index('\nasync function loadDetail', begin)
    page = page[:begin] + 'function goBack() { selectedSessionId = null; onRoute(); }\n' + page[end:]
    begin = page.index('async function loadDetail(')
    end = page.index('\nfunction tick()', begin)
    page = page[:begin] + """function loadDetail(id) {
  detail = embedded.details[id] || null;
  detailMissing = detail ? null : "세션 상세를 찾을 수 없습니다";
  renderDetail(); tick();
}
""" + page[end:]
    page = replace_once(page, 'window.addEventListener("hashchange", onRoute);', '')
    page = replace_once(page, 'const messages = [];',
                        'const messages = [];\n  if (latest && latest.panelUpdateNote) messages.push(latest.panelUpdateNote);')
    page = replace_once(page, 'onRoute();\npoll();', '''
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || !event.data || event.data.type !== "orca-panel-data") return;
  const data = hydratePanelData(event.data.data);
  if (!data || !data.snapshot || !Array.isArray(data.snapshot.sessions) || !data.snapshot.kpi || !data.details) return;
  const scroll = window.scrollY;
  embedded = data; latest = data.snapshot;
  const id = routeId();
  if (id) loadDetail(id); else renderList();
  renderBanner(); tick();
  window.scrollTo(0, scroll);
});
renderList(); onRoute(); tick();''')
    ui = (Path(__file__).parent / 'dashboard-ui.js').read_text()
    ui += '\n' + (Path(__file__).parent / 'topic-ui.js').read_text()
    ui += '\n' + (Path(__file__).parent / 'llm-ui.js').read_text()
    ui += '\n' + (Path(__file__).parent / 'live-ui.js').read_text()
    page = replace_once(page, 'cards.replaceChildren(...latest.sessions.map(card));', 'reconcileChildren(cards, latest.sessions.map(card));')
    page = replace_once(page, 'window.addEventListener("message", (event) => {\n  if (event.source !== window.parent',
                        ui + '\nwindow.addEventListener("message", (event) => {\n  if (event.source !== window.parent')
    # Narrow panel sizing only; upstream rings, cards, colors and detail UI stay intact.
    page = replace_once(page, '</style>', """
@media (max-width: 480px) {
  body { padding: 12px 10px 24px; }
  h1 { font-size: 17px; }
  .kpis { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
  .kpi { padding: 10px 12px; }
  .cards { gap: 10px; }
  .card { padding: 12px; }
  .card-top { gap: 8px; }
  .badge { padding: 3px 7px; font-size: 11px; }
}
.terminal-navigation { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.terminal-navigation button { cursor: pointer; font: inherit; font-size: 12px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
.terminal-navigation button:hover { background: var(--bg); }
.terminal-navigation button:disabled { cursor: default; opacity: .55; }
.terminal-navigation .navigation-status { font-size: 12px; color: var(--muted); }
</style>""")
    page = replace_once(page, '</style>', (Path(__file__).parent / 'dashboard-ui.css').read_text() + '\n</style>')
    page = replace_once(page, '</style>', (Path(__file__).parent / 'llm-ui.css').read_text() + '\n</style>')
    # Rendering is synchronous, so the first paint already contains the cards.
    return page


VOLATILE_KEYS = {"generatedAt", "lastSuccessAt", "lastOutputAt", "idleSeconds", "toolName"}


def meaningful(value):
    if isinstance(value, dict):
        return {k: meaningful(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [meaningful(v) for v in value]
    return value


class PublishPolicy:
    def __init__(self, heartbeat=60):
        self.heartbeat = heartbeat
        self.last_key = None
        self.last_at = float('-inf')

    def due(self, snapshot, details, now, *, minimum_interval=0):
        if now - self.last_at < minimum_interval:
            return False
        key = json.dumps(meaningful({"snapshot": snapshot, "details": details}), sort_keys=True, ensure_ascii=False)
        if key == self.last_key and now - self.last_at < self.heartbeat:
            return False
        self.last_key, self.last_at = key, now
        return True


def publish(path, text):
    """Atomic replacement prevents the host from loading a partial document."""
    temporary = path.with_suffix('.tmp')
    temporary.write_text(text, encoding='utf-8')
    os.replace(temporary, path)


def run(collector, plugin_dir, interval, persistent_frame=False):
    plugin_dir.mkdir(parents=True, exist_ok=True)
    # Keep transient files outside the watched plugin tree.
    lock = (plugin_dir.parent / 'bridge.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('session-dashboard bridge already running')
    module = runpy.run_path(str(collector))
    tracker = ProgressTracker()
    inquiries = InquiryTracker(plugin_dir.parent / 'request-history.json')
    usage_tracker = UsageTracker()
    agents = {}
    live_terminal_handles = set()
    original_run_orca = module['run_orca']
    def capture_agents(command, args, **kwargs):
        result = original_run_orca(command, args, **kwargs)
        if args == ['worktree', 'ps']:
            agents.clear()
            agents.update({agent['paneKey']: agent for worktree in result.get('worktrees', [])
                           for agent in worktree.get('agents', []) if agent.get('paneKey')})
        if args == ['terminal', 'list']:
            live_terminal_handles.clear()
            live_terminal_handles.update(terminal['handle'] for terminal in result.get('terminals', []))
        return result
    original_run_orca.__globals__['run_orca'] = capture_agents
    store = module['SnapshotStore'](interval)
    command = module['orca_command'](os.environ)
    host_support = HostSupportProbe(lambda: original_run_orca(command, ['status']))
    policy = PublishPolicy()
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopped:
        start = time.monotonic()
        store.refresh(command)
        snapshot = store.payload()
        details = {}
        projects = module['claude_projects_root'](os.environ)
        for session in snapshot.get('sessions', []):
            match = store.session(session['id'])
            if match:
                current, keys, sole = match
                plan = None
                path = None
                phase_hint = 0
                if current.get('agentType') == 'claude' and current.get('path'):
                    try:
                        directory = module['transcript_dir'](projects, current['path'])
                        path = module['find_transcript'](directory, *keys, sole_session=sole)
                        if path:
                            plan, phase_hint = tracker.read_evidence(path)
                    except (OSError, UnicodeDecodeError):
                        pass
                tracker.apply(current, agents.get(current['id']), plan, phase_hint)
                details[session['id']] = module['session_detail'](current, keys, projects, module['now_millis'](), sole_session=sole)
                usage = usage_tracker.native(current, agents.get(current['id']), path)
                try:
                    requests = inquiries.collect(current, agents.get(current['id']), path, snapshot.get('generatedAt'), usage=usage)
                except (OSError, UnicodeDecodeError):
                    requests = inquiries.collect(current, agents.get(current['id']), now_ms=snapshot.get('generatedAt'))
                current['requests'] = requests
                details[session['id']]['requests'] = requests
                current['llmUsage'] = usage
                details[session['id']]['llmUsage'] = usage
        attach_router_sessions(snapshot, details, usage_tracker.router_sessions(),
                               live_terminal_handles=live_terminal_handles)
        for session in snapshot['sessions']:
            if session.get('kind') == 'router':
                details[session['id']] = {**module['build_detail'](session, None, now_ms=module['now_millis']()),
                                           'requests': session['requests'], 'llmUsage': session['llmUsage']}
        snapshot['kpi'] = module['_kpi'](snapshot['sessions'])
        inquiries.save()
        live_frame = persistent_frame and host_support.check(time.monotonic())
        snapshot['panelUpdateMode'] = 'persistent-frame' if live_frame else 'document'
        if not live_frame:
            snapshot['panelUpdateNote'] = '현재 앱은 화면 유지 갱신을 지원하지 않아 패널 갱신 간격을 최소 30초로 제한합니다. Orca Dashboard 수정 앱으로 실행하면 실시간 갱신 중에도 화면이 유지됩니다.'
        if live_frame or policy.due(snapshot, details, time.monotonic(), minimum_interval=DOCUMENT_UPDATE_INTERVAL):
            publish(plugin_dir / 'panel.html', render(snapshot, interval, template=module['PAGE_HTML'], details=details))
        deadline = start + interval
        while not stopped and time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.2, remaining))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--collector', type=Path, default=Path(__file__).resolve().with_name('collector.py'))
    parser.add_argument('--plugin-dir', type=Path, default=Path.home() / '.orca/session-dashboard/plugin')
    parser.add_argument('--interval', type=float, default=3)
    parser.add_argument('--persistent-frame', action='store_true', help='Publish every poll; requires the patched Orca host')
    args = parser.parse_args()
    if not 0 < args.interval < 3600:
        parser.error('--interval must be between 0 and 3600')
    run(args.collector, args.plugin_dir, args.interval, args.persistent_frame)
