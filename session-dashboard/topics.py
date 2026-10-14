"""Local, explainable topic grouping and completion records. No model calls."""
from collections import Counter
import hashlib
import re

WORDS = re.compile(r'[a-zA-Z][a-zA-Z0-9_.-]*|[가-힣]{2,}')
PARTICLES = re.compile(r'(?:에서는|에서도|으로는|으로도|에서|에게|처럼|까지|부터|으로|관련|에는|은|는|이|가|을|를|에|도|와|과)$')
REQUEST_END = re.compile(r'(?:해줘요|해주세요|해줄래|해줘)$')
STOP = set('작업 질문 요청 확인 수정 추가 구현 적용 완료 검증 테스트 처리 변경 기능 문제 방법 설명 이것 그것 여기 저기 이번 다음 다시 그리고 해줘 해주세요 해줄래 해주세요 해줘요 주세요 부탁 합니다 하겠습니다 있습니다 할거잖아 맞게 가지고 어떤 여러 연속적으로 첫번째 두번째 세번째 좀 더 the a an is of to and for please fix add implement test check'.split())
FOLLOWUP = re.compile(r'^(?:응|네|좋아|계속|진행해|그럼|그러면|이것|그것|이거|그거|여기|거기|이어서|방금|아까|추가로|그리고|also\b|continue\b|yes\b)', re.I)
SWITCH = re.compile(r'^(?:다른\s*(?:주제|작업|질문)|새로운\s*(?:주제|작업)|별개로|별도로|주제\s*전환|new topic\b)', re.I)
EXPLICIT = re.compile(r'^\s*(?:주제|topic)\s*[:：]\s*([^\n]{1,80})', re.I)


def keywords(text):
    result = set()
    for word in WORDS.findall((text or '').lower()):
        if re.search('[가-힣]', word):
            word = PARTICLES.sub('', REQUEST_END.sub('', word))
        if len(word) >= 2 and word not in STOP and not word.endswith(('해줘', '해주세요')):
            result.add(word)
    return result


def topic_title(question):
    explicit = EXPLICIT.search(question)
    if explicit:
        return explicit[1].strip()
    text = re.sub(r'<[^>]+>', '', question).strip().split('\n')[0]
    text = re.sub(r'^(?:다른\s*(?:주제|작업|질문)|새로운\s*(?:주제|작업)|별개로|별도로)\s*[:：,]?\s*', '', text)
    return (text[:61] + '…') if len(text) > 64 else text or '주제 확인 필요'


def completion_record(request):
    if request.get('workState') != 'completed':
        return None
    progress = request.get('progress') or {}
    return {'at': request.get('answeredAt'),
            'basis': progress.get('basis') or '완료 근거 확인 필요',
            'method': 'plan' if request.get('completed') and '완료 보고' not in progress.get('basis', '') else 'agent-report',
            'summary': (request.get('answer') or ' · '.join(request.get('completed') or []))[:2400],
            'items': list(request.get('completed') or [])}


def group_requests(requests, previous=()):
    """Keep topic identity across polls/restarts; matching uses questions only.

    A short referential follow-up belongs to the previous topic. Explicit topic
    switches and unrelated substantial requests start a new group. Ambiguity is
    kept separate rather than silently assigning it to an arbitrary topic.
    """
    saved = {r['id']: r for r in previous if r.get('topicId')}
    groups, by_id = [], {}
    signatures = {}
    prior_topic = None
    for request in requests:
        question = request.get('question') or ''
        words = keywords(question)
        old = saved.get(request['id'])
        if old and old.get('question') == question:
            identifier = old['topicId']
            title = old.get('topicTitle') or topic_title(question)
            basis = old.get('topicBasis', '이전에 분류한 주제 유지')
        else:
            explicit = EXPLICIT.search(question)
            matches = []
            for group in groups:
                shared = words & signatures[group['id']]
                # Generic verbs cannot join topics. One distinctive noun can,
                # while longer requests require two or a substantial overlap.
                if shared and (len(shared) >= 2 or len(words) <= 5 or len(shared) / max(1, len(words)) >= .25):
                    matches.append((len(shared) / max(1, len(words)), group))
            matches.sort(key=lambda match: match[0], reverse=True)
            target = None
            if explicit:
                target = next((g for g in groups if g['title'] == explicit[1].strip()), None)
                basis = '요청에 명시된 주제'
            elif SWITCH.search(question):
                basis = '새 주제로 전환하는 요청'
            elif matches and (len(matches) == 1 or matches[0][0] > matches[1][0]):
                target = matches[0][1]
                basis = '기존 주제와 요청의 핵심어 일치'
            elif prior_topic and (FOLLOWUP.search(question) or question.strip() in ('왜?', '어떻게?', '왜', '어떻게')) and len(words) <= 5:
                target = by_id[prior_topic]
                basis = '직전 주제를 잇는 후속 질문 표현'
            else:
                basis = '별도 요청으로 분류 · 핵심어 기준 추정'
            identifier = target['id'] if target else 'topic-' + hashlib.sha256(str(request['id']).encode()).hexdigest()[:16]
            title = target['title'] if target else topic_title(question)
        if identifier not in by_id:
            group = {'id': identifier, 'title': title, 'requestIds': [], 'startedAt': request.get('startedAt')}
            groups.append(group)
            by_id[identifier] = group
            signatures[identifier] = set()
        group = by_id[identifier]
        group['requestIds'].append(request['id'])
        signatures[identifier].update(words)
        request.update(topicId=identifier, topicTitle=group['title'], topicBasis=basis,
                       completion=completion_record(request))
        prior_topic = identifier
    index = {r['id']: r for r in requests}
    for group in groups:
        items = [index[identifier] for identifier in group['requestIds']]
        counts = Counter(r.get('workState', 'unknown') for r in items)
        group['completed'] = counts['completed']
        group['status'] = ('running' if any(r.get('answerState') in ('working', 'pending') or r.get('workState') == 'running' for r in items)
                           else 'completed' if counts['completed'] == len(items) else 'unknown')
    return groups
