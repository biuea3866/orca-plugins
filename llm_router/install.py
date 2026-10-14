"""Install ordinary CLI launch shims, leaving vendor executables untouched."""
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
from .storage import router_home


START = '# >>> Orca LLM router >>>'
END = '# <<< Orca LLM router <<<'


def native_binary(name, bindir):
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        if not directory or Path(directory).resolve() == bindir.resolve():
            continue
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.absolute())
    return None


def configure_shell(path, bindir):
    original = path.read_text() if path.exists() else ''
    if START not in original:
        backup = path.with_name(path.name + '.before-llm-router')
        if path.exists() and not backup.exists():
            shutil.copy2(path, backup)
        original = original.rstrip() + '\n'
    else:
        before, after = original.split(START, 1)
        if END not in after:
            raise ValueError(f'{path}: incomplete router PATH block')
        original = before + after.split(END, 1)[1].lstrip('\n')
    path.write_text(original.rstrip() + '\n\n' + START + '\nexport PATH=' +
                    shlex.quote(str(bindir)) + ':"$PATH"\n' + END + '\n')


def main():
    source = Path(__file__).resolve().parent
    runtime = router_home() / 'runtime'
    package = runtime / 'llm_router'
    package.mkdir(parents=True, exist_ok=True)
    for path in source.glob('*.py'):
        shutil.copy2(path, package / path.name)
    executable = Path.home() / '.orca/bin/llm-router'
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_text('#!/bin/sh\nexport PYTHONPATH=' + shlex.quote(str(runtime)) + '\nexec ' +
                          shlex.quote(sys.executable) + ' -m llm_router "$@"\n')
    executable.chmod(0o755)
    binaries = {name: native_binary(name, executable.parent) for name in ('codex', 'claude')}
    existing = router_home() / 'native.json'
    if existing.exists():
        previous = json.loads(existing.read_text())
        binaries = {name: value or previous.get(name) for name, value in binaries.items()}
    if not all(binaries.values()):
        raise ValueError('원본 codex 및 claude 실행 파일을 PATH에서 찾을 수 없습니다')
    existing.write_text(json.dumps(binaries, indent=2) + '\n')
    existing.chmod(0o600)
    for name in binaries:
        launcher = executable.parent / name
        if launcher.exists() and 'llm_router.native' not in launcher.read_text():
            raise ValueError(f'기존 실행 파일을 덮어쓰지 않습니다: {launcher}')
        launcher.write_text('#!/bin/sh\nexport PYTHONPATH=' + shlex.quote(str(runtime)) +
                            '\nexec ' + shlex.quote(sys.executable) + ' -m llm_router.native ' + name + ' "$@"\n')
        launcher.chmod(0o755)
    for shell_file in ('.zprofile', '.zshrc'):
        configure_shell(Path.home() / shell_file, executable.parent)
    print('일반 claude/codex 자동 라우팅 설치 완료: ' + str(executable.parent))
    print('새 터미널에서 claude 또는 codex를 실행하세요. 기존 CLI 바이너리·로그인은 유지됩니다.')


if __name__ == '__main__':
    main()
