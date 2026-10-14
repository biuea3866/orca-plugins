import argparse
import json
import os
from pathlib import Path
import sys
import uuid
from .execution import execute
from .learning import choose, LearningStore
from .policy import EFFORTS, load_profiles, route
from .storage import SessionStore, now_ms, router_home


def parser():
    p = argparse.ArgumentParser(description='질문마다 모델·effort를 선택하고 세션 대시보드에 기록합니다')
    p.add_argument('--agent', choices=['codex', 'claude'])
    p.add_argument('--cwd', type=Path, default=Path.cwd())
    p.add_argument('--resume', help='이어갈 라우터 세션 UUID')
    p.add_argument('--config', type=Path, help='모델·effort 프로필 JSON')
    p.add_argument('--tier', choices=['quick', 'standard', 'deep'])
    p.add_argument('--model', help='자동 선택 대신 지정할 모델')
    p.add_argument('--effort', choices=sorted(EFFORTS))
    p.add_argument('--allow-edits', action='store_true', help='작업 디렉터리의 코드 수정 허용')
    p.add_argument('--prompt', help='질문 하나 실행 후 종료; -는 표준 입력')
    p.add_argument('--dry-run', action='store_true', help='실행·기록 없이 선택 결과만 출력')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        profiles = load_profiles(args.config or ((router_home() / 'profiles.json') if (router_home() / 'profiles.json').exists() else None))
        if args.dry_run:
            question = sys.stdin.read() if args.prompt == '-' else args.prompt
            if not question:
                raise ValueError('--dry-run에는 --prompt가 필요합니다')
            choice = (route(question, args.agent or 'codex', profiles=profiles, tier=args.tier) if args.tier
                      else choose(question, args.agent or 'codex', profiles=profiles))
            choice.update({k: getattr(args, k) for k in ['model', 'effort'] if getattr(args, k)})
            print(json.dumps(choice, ensure_ascii=False, indent=2))
            return 0
        cwd = str(args.cwd.resolve())
        if not Path(cwd).is_dir():
            raise ValueError('작업 디렉터리가 없습니다')
        with SessionStore(args.resume) as store:
            state = store.read()
            if args.resume and state is None:
                raise ValueError('이어갈 라우터 세션을 찾을 수 없습니다')
            if state and (state['cwd'] != cwd or args.agent and state['agent'] != args.agent):
                raise ValueError('기존 세션과 같은 --cwd 및 --agent를 사용해주세요')
            state = state or {'schemaVersion': 1, 'id': store.identifier, 'agent': args.agent or 'codex',
                              'cwd': cwd, 'providerSessionId': None, 'requests': [], 'createdAt': now_ms()}
            state.update(pid=os.getpid(), paneKey=os.environ.get('ORCA_PANE_KEY'),
                         terminalHandle=os.environ.get('ORCA_TERMINAL_HANDLE'),
                         worktreeId=os.environ.get('ORCA_WORKTREE_ID'), status='idle')
            print(f"라우터 세션: {state['id']} · {state['agent']} · {'수정 허용' if args.allow_edits else '읽기 전용'}", file=sys.stderr)
            store.save(state)
            def run_question(question):
                previous = (state['requests'][-1].get('decision') if state['requests'] else None)
                choice = (route(question, state['agent'], profiles=profiles, previous=previous, tier=args.tier) if args.tier
                          else choose(question, state['agent'], profiles=profiles, previous=previous))
                for key in ['model', 'effort']:
                    if getattr(args, key):
                        choice[key] = getattr(args, key)
                        choice['reason'] = '사용자 지정 설정'
                request = {'id': str(uuid.uuid4()), 'question': question, 'startedAt': now_ms(),
                           'decision': choice, 'state': 'running', 'actualModel': None, 'models': [],
                           'effort': choice['effort'], 'effortSource': 'configured', 'answer': None}
                state['requests'] = (state['requests'] + [request])[-50:]
                state['status'] = 'running'
                store.save(state)
                print(f"→ {choice['model']} · effort {choice['effort'] or '기본값'} · {choice['reason']}", file=sys.stderr)
                def update(result):
                    changed = False
                    for key in ['actualModel', 'reportedModel', 'recordedModel', 'recordedEffort', 'models']:
                        if request.get(key) != result.get(key):
                            request[key] = result.get(key)
                            changed = True
                    if result.get('sessionId') and state['providerSessionId'] != result['sessionId']:
                        state['providerSessionId'] = result['sessionId']
                        changed = True
                    if changed:
                        store.save(state)
                try:
                    result = execute(question, choice, cwd, state['providerSessionId'],
                                     writable=args.allow_edits, on_event=update)
                    update(result)
                    request.update(state='completed' if result['completed'] else 'failed',
                                   answer=result['answer'], error=result['error'], usage=result['usage'],
                                   exitCode=result['exitCode'])
                except KeyboardInterrupt:
                    request.update(state='cancelled', error='사용자가 실행을 중단했습니다')
                    raise
                except (OSError, ValueError) as error:
                    request.update(state='failed', error=str(error))
                finally:
                    request['endedAt'] = now_ms()
                    state['status'] = 'idle'
                    store.save(state)
                    LearningStore().observe(request)
                if request['state'] != 'completed':
                    print(request.get('error') or '실행 실패', file=sys.stderr)
                    return 1
                return 0
            try:
                if args.prompt is not None:
                    return run_question(sys.stdin.read() if args.prompt == '-' else args.prompt)
                if not sys.stdin.isatty():
                    return run_question(sys.stdin.read())
                print('질문을 입력하세요. /quit 종료 · /status 최근 선택 · /paste 여러 줄 입력 후 /send', file=sys.stderr)
                while True:
                    try:
                        question = input('질문> ').strip()
                    except EOFError:
                        break
                    if question in ('/quit', '/exit'):
                        break
                    if question == '/status':
                        print(json.dumps(state['requests'][-1].get('decision') if state['requests'] else {}, ensure_ascii=False))
                        continue
                    if question == '/paste':
                        lines = []
                        while (line := input()) != '/send':
                            lines.append(line)
                        question = '\n'.join(lines)
                    if question:
                        run_question(question)
            finally:
                state.update(status='closed', pid=None)
                store.save(state)
        return 0
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
