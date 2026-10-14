"""Conservative rules; the profiles are configurable, not model benchmarks."""
import copy
import json
import re
from pathlib import Path

DEFAULT_PROFILES = {
    'codex': {'quick': {'model': 'gpt-6-luna', 'effort': 'low'},
              'standard': {'model': 'gpt-6.1-sol', 'effort': 'medium'},
              'deep': {'model': 'gpt-6-astra', 'effort': 'high'}},
    'claude': {'quick': {'model': 'sonnet', 'effort': 'low'},
               'standard': {'model': 'sonnet', 'effort': 'medium'},
               'deep': {'model': 'opus', 'effort': 'high'}},
}
EFFORTS = {'low', 'medium', 'high', 'xhigh', 'max'}
DEEP = re.compile(r'동시성|데드락|교착|경쟁\s*상태|보안|인증|권한|데이터\s*유실|마이그레이션|아키텍처|설계|여러\s*(?:파일|서비스)|근본\s*원인|race\s*condition|deadlock|security|auth(?:entication|orization)|migration|architecture|root\s*cause', re.I)
EDIT = re.compile(r'수정|구현|만들|고쳐|리팩[터토]|테스트|디버[깅그]|fix|implement|build|refactor|debug|test', re.I)
QUICK = re.compile(r'요약|번역|분류|추출|뜻|무슨\s*의미|summari[sz]e|translate|classify|extract|what\s+does.+mean', re.I)
FOLLOWUP = re.compile(r'^(?:계속|진행|그대로|좋아|응|해줘|continue|go ahead|yes)[.!\s]*$', re.I)


def load_profiles(path=None):
    profiles = copy.deepcopy(DEFAULT_PROFILES)
    if path:
        value = json.loads(Path(path).read_text())
        for agent, tiers in value.items():
            if agent not in profiles or not isinstance(tiers, dict):
                raise ValueError('지원하는 agent는 codex, claude입니다')
            for tier, profile in tiers.items():
                if tier not in profiles[agent] or not isinstance(profile, dict):
                    raise ValueError('tier는 quick, standard, deep 중 하나여야 합니다')
                if not isinstance(profile.get('model'), str) or not profile['model'].strip():
                    raise ValueError('model 이름이 필요합니다')
                if profile.get('effort') not in EFFORTS | {None}:
                    raise ValueError('지원하지 않는 effort입니다')
                profiles[agent][tier] = {k: profile[k] for k in ('model', 'effort')}
    return profiles


def route(question, agent, *, profiles=None, previous=None, tier=None):
    if not question.strip():
        raise ValueError('질문을 입력해주세요')
    if agent not in DEFAULT_PROFILES:
        raise ValueError('지원하는 agent는 codex, claude입니다')
    if tier:
        reason = '사용자가 지정한 작업 등급'
    elif DEEP.search(question) or len(question) > 6000:
        tier, reason = 'deep', '복잡한 추론·설계 또는 긴 입력'
    elif FOLLOWUP.fullmatch(question.strip()) and previous:
        tier, reason = previous.get('tier', 'standard'), '이전 작업을 이어가는 요청'
    elif len(question) < 1600 and QUICK.search(question) and not EDIT.search(question):
        tier, reason = 'quick', '범위가 명확한 요약·번역·분류·추출'
    else:
        tier, reason = 'standard', '일반 작업 또는 난이도가 불명확한 요청'
    profile = (profiles or DEFAULT_PROFILES)[agent][tier]
    return {'agent': agent, 'tier': tier, **profile, 'reason': reason, 'policy': 'rules-v1'}
