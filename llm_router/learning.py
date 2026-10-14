"""Local feedback, separated from transport success, with conservative adaptation."""
import json
from contextlib import contextmanager
import os
import re
import sqlite3
from pathlib import Path
from .storage import router_home, now_ms


def task_kind(question):
    for kind, pattern in (
        ('security', r'보안|인증|권한|security|authentication|authorization'),
        ('architecture', r'설계|아키텍처|마이그레이션|architecture|migration|deadlock|동시성'),
        ('debug', r'버그|디버|오류|bug|debug|root cause'),
        ('coding', r'구현|수정|리팩|만들|implement|fix|refactor|build|test|테스트'),
        ('translation', r'번역|translate'),
        ('summary', r'요약|summari[sz]e|분류|classify|extract|추출'),
    ):
        if re.search(pattern, question, re.I):
            return kind
    return 'general'


class LearningStore:
    def __init__(self, home=None):
        self.home = Path(home or router_home())

    @contextmanager
    def connect(self):
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.home / 'learning.sqlite3'
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        db = sqlite3.connect(path, timeout=10)
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS outcomes (
                id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL,
                model TEXT NOT NULL, effort TEXT, tier TEXT NOT NULL,
                latency REAL, tokens INTEGER, transport TEXT, quality REAL,
                evidence TEXT, at INTEGER NOT NULL);
        ''')
        try:
            with db:
                yield db
        finally:
            db.close()

    def observe(self, request):
        choice = request['decision']
        usage = request.get('usage') or {}
        tokens = sum(usage.get(k, 0) or 0 for k in ('input_tokens', 'output_tokens'))
        with self.connect() as db:
            db.execute('''INSERT INTO outcomes
                (id,agent,kind,model,effort,tier,latency,tokens,transport,at)
                VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                latency=excluded.latency,tokens=excluded.tokens,transport=excluded.transport''',
                (request['id'], choice['agent'], choice.get('taskKind', task_kind(request['question'])),
                 choice['model'], choice.get('effort'), choice['tier'],
                 max(0, (request.get('endedAt', now_ms()) - request['startedAt']) / 1000),
                 tokens, request['state'], now_ms()))

    def feedback(self, identifier, *, quality, evidence):
        if quality not in (0, 1) or evidence not in ('user', 'tests', 'review'):
            raise ValueError('quality는 0/1, evidence는 user/tests/review여야 합니다')
        with self.connect() as db:
            result = db.execute('UPDATE outcomes SET quality=?,evidence=?,at=? WHERE id=?',
                                (quality, evidence, now_ms(), identifier))
            if result.rowcount != 1:
                raise ValueError('평가할 요청 기록을 찾을 수 없습니다')

    def stats(self, agent=None, kind=None):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute('''SELECT agent,kind,model,effort,tier,
                COUNT(*) AS calls,COUNT(quality) AS evaluated,AVG(quality) AS quality,
                AVG(latency) AS latency,AVG(tokens) AS tokens,
                SUM(CASE WHEN quality=0 THEN 1 ELSE 0 END) AS negatives
                FROM outcomes WHERE (? IS NULL OR agent=?) AND (? IS NULL OR kind=?)
                GROUP BY agent,kind,model,effort,tier''', (agent, agent, kind, kind))]

    def select(self, question, baseline, profiles):
        result = dict(baseline, taskKind=task_kind(question), learningSamples=0)
        rows = self.stats(baseline['agent'], result['taskKind'])
        tiers = ['quick', 'standard', 'deep']
        floor = tiers.index(baseline['tier'])
        current = next((row for row in rows if row['model'] == baseline['model'] and
                        row['effort'] == baseline['effort']), None)
        # Quality failures raise the next request's budget. Never rerun an editing task.
        if current and current['evaluated'] >= 3 and current['negatives'] >= 2 and current['quality'] < .7:
            selected = tiers[min(2, floor + 1)]
            if selected != baseline['tier']:
                result.update(profiles[baseline['agent']][selected], tier=selected,
                              policy='feedback-v1', learningSamples=current['evaluated'],
                              reason='동일 질문 유형의 품질 평가가 낮아 추론 예산을 높임')
                return result
        # Use faster candidates only with enough quality evidence and no lower complexity tier.
        candidates = [row for row in rows if row['evaluated'] >= 8 and row['quality'] >= .9 and
                      row['tier'] in tiers and tiers.index(row['tier']) >= floor and
                      profiles[baseline['agent']][row['tier']] == {'model': row['model'], 'effort': row['effort']}]
        if current and current['evaluated'] >= 8 and candidates:
            best = min(candidates, key=lambda row: (row['latency'] or float('inf'), row['tokens'] or 0))
            result.update(model=best['model'], effort=best['effort'], tier=best['tier'],
                          policy='feedback-v1', learningSamples=best['evaluated'],
                          reason='품질 평가를 통과한 후보 중 관측 응답 시간이 짧은 설정')
        return result


def choose(question, agent, *, profiles=None, previous=None, home=None):
    from .policy import load_profiles, route
    if profiles is None:
        path = Path(home or router_home()) / 'profiles.json'
        profiles = load_profiles(path if path.exists() else None)
    baseline = route(question, agent, profiles=profiles, previous=previous)
    return LearningStore(home).select(question, baseline, profiles)


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description='라우터 품질 평가 및 학습 통계')
    p.add_argument('action', choices=['feedback', 'stats'])
    p.add_argument('--request')
    p.add_argument('--rating', choices=['good', 'bad'])
    p.add_argument('--evidence', choices=['user', 'tests', 'review'], default='user')
    args = p.parse_args(argv)
    store = LearningStore()
    if args.action == 'feedback':
        if not args.request or not args.rating:
            p.error('feedback에는 --request와 --rating이 필요합니다')
        store.feedback(args.request, quality=int(args.rating == 'good'), evidence=args.evidence)
        print('평가를 저장했습니다. 다음 요청부터 정책에 반영됩니다.')
    else:
        print(json.dumps(store.stats(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
