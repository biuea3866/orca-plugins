#!/usr/bin/env python3
"""Publish read-only dashboard snapshots through Orca's dev-panel file watcher."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import runpy
import signal
import time
from progress import ProgressTracker

def script_json(value):
    # Transcript text must never be interpreted as an HTML script boundary.
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


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
    data = {"snapshot": snapshot, "details": details or {}}
    page = replace_once(page, '<script>\n\"use strict\";', '<script type=\"application/json\" id=\"orca-panel-data\">' + script_json(data) + '</script>\n<script>\n\"use strict\";')
    page = replace_once(page, 'let latest = null;',
        'let embedded = JSON.parse(document.getElementById(\"orca-panel-data\").textContent);\nlet latest = embedded.snapshot;\nlet selectedSessionId = null;')
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
    page = replace_once(page, 'onRoute();\npoll();', '''
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || !event.data || event.data.type !== "orca-panel-data") return;
  const data = event.data.data;
  if (!data || !data.snapshot || !Array.isArray(data.snapshot.sessions) || !data.snapshot.kpi || !data.details) return;
  const scroll = window.scrollY;
  embedded = data; latest = data.snapshot;
  const id = routeId();
  if (id) loadDetail(id); else renderList();
  renderBanner(); tick();
  window.scrollTo(0, scroll);
});
renderList(); onRoute(); tick();''')
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

    def due(self, snapshot, details, now):
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
    agents = {}
    original_run_orca = module['run_orca']
    def capture_agents(command, args, **kwargs):
        result = original_run_orca(command, args, **kwargs)
        if args == ['worktree', 'ps']:
            agents.clear()
            agents.update({agent['paneKey']: agent for worktree in result.get('worktrees', [])
                           for agent in worktree.get('agents', []) if agent.get('paneKey')})
        return result
    original_run_orca.__globals__['run_orca'] = capture_agents
    store = module['SnapshotStore'](interval)
    command = module['orca_command'](os.environ)
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
        if persistent_frame or policy.due(snapshot, details, time.monotonic()):
            publish(plugin_dir / 'panel.html', render(snapshot, interval, template=module['PAGE_HTML'], details=details))
        deadline = start + interval
        while not stopped and time.monotonic() < deadline:
            time.sleep(min(0.2, deadline - time.monotonic()))


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
