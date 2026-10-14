"""One atomic private state file per session; no shared-file lost updates."""
import fcntl
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


def router_home():
    return Path(os.environ.get('LLM_ROUTER_HOME', str(Path.home() / '.orca/llm-router')))


def now_ms():
    return int(time.time() * 1000)


class SessionStore:
    def __init__(self, identifier=None, home=None):
        self.home = Path(home or router_home())
        self.identifier = str(uuid.UUID(identifier)) if identifier else str(uuid.uuid4())
        self.directory = self.home / 'sessions'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / (self.identifier + '.json')
        self.lock = None

    def __enter__(self):
        descriptor = os.open(self.directory / (self.identifier + '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
        self.lock = os.fdopen(descriptor, 'w')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise ValueError('이 라우터 세션은 다른 프로세스에서 사용 중입니다') from None
        return self

    def __exit__(self, *_):
        self.lock.close()

    def read(self):
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text())

    def save(self, state):
        state['updatedAt'] = now_ms()
        descriptor, name = tempfile.mkstemp(dir=self.directory, prefix='.state-')
        try:
            with os.fdopen(descriptor, 'w') as file:
                json.dump(state, file, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
