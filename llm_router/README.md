# LLM Router

평소처럼 `claude` 또는 `codex`를 켜고 질문하면, 로컬 공통 라우터가 질문마다 모델과 effort를 선택합니다. CLI 화면·로그인·대화 기록·도구·수정 권한은 기존 CLI가 관리합니다.

```sh
python3 -m llm_router.install
# 새 터미널에서
codex
claude
```

설치기는 `~/.orca/bin/claude`, `~/.orca/bin/codex` 실행 연결을 만들고 zsh의 `.zprofile`과 `.zshrc`에 PATH 블록을 추가합니다. 원본 바이너리는 교체하지 않습니다. 셸 파일은 최초 변경 전에 `.before-llm-router`로 백업합니다. 이미 실행 중인 CLI와 플러그인 서버는 다시 시작해야 적용됩니다. 임시로 자동 선택을 끄려면 `LLM_ROUTER_BYPASS=1 codex` 또는 `LLM_ROUTER_BYPASS=1 claude`를 사용합니다.

## 호출 경로

```text
일반 Claude/Codex CLI ─┐
                       ├─ 공통 로컬 게이트웨이 ─ 질문 분류 + 학습 정책 ─ 공급자
CLI를 호출하는 플러그인 ┘             │
                              세션 기록 + 품질 평가
                                     │
                                세션 대시보드
```

게이트웨이는 실행마다 임의 포트와 비밀 경로를 가진 loopback HTTP 서버입니다. 기존 인증 헤더를 원래 공급자에 전달하고 모델·effort만 선택합니다. 스트리밍 응답과 도구 호출 프로토콜을 유지합니다. Codex는 HTTP Responses 경로를 사용하며 요청 압축과 WebSocket은 이 실행에 한해 끕니다. Claude는 `ANTHROPIC_BASE_URL`만 연결하므로 저장된 구독 로그인을 유지합니다. 별도 API 키를 생성하지 않습니다.

새 질문에서 다시 선택하고, 해당 질문의 도구 호출과 재시도에서는 선택을 유지합니다. 공급자별 API의 호환 모델 범위 안에서 선택합니다. Claude 대화를 OpenAI API로 변환하거나 그 반대로 변환하지 않습니다. 실제 응답의 모델과 라우터가 전달한 effort를 기록합니다. CLI 자체의 모델 표시·모델별 시스템 프롬프트·컨텍스트 제한은 시작 설정을 유지하므로 실제 사용 확인은 대시보드에서 합니다.

## 플러그인 연동

**일반 `claude`/`codex` 명령을 호출하는 플러그인은 코드나 모델 설정을 바꾸지 않아도 적용됩니다.** Local Self Review의 CLI 호출도 같은 실행 연결을 사용합니다. GUI에서 시작한 서버는 로그인 셸 PATH를 가져오는 기존 로직으로 이를 찾습니다. 원본 바이너리의 절대 경로를 직접 실행하는 플러그인은 이 PATH 연결을 우회합니다.

CLI 대신 SDK/API를 직접 쓰는 플러그인은 공통 게이트웨이에 endpoint를 한 번 연결해야 합니다. 게이트웨이의 `Gateway(agent, upstream).start()`와 `url`을 사용해 기존 공급자 요청을 그대로 전달할 수 있습니다. 종료 시 `close()`를 호출합니다. 별도의 플러그인별 모델·effort 선택 로직은 필요하지 않습니다. 현재 지원 프로토콜은 Anthropic Messages와 OpenAI Responses입니다.

실행 없이 선택만 필요한 플러그인에는 JSON 인터페이스도 제공합니다.

```sh
~/.orca/bin/llm-router route --agent codex --prompt '동시성 오류를 분석해줘'
# Python: from llm_router.learning import choose
# decision = choose(question, 'codex')
```

라우터 패키지는 self review나 dashboard에 의존하지 않습니다. 두 플러그인은 호출·기록 소비자입니다. 추가 공급자는 프로토콜 어댑터와 모델 프로필을 등록해야 합니다.

## 사용하면서 정책 개선

각 요청의 질문 유형·모델·effort·응답 시간·토큰·오류를 로컬 SQLite에 누적합니다. 품질 평가는 별도로 기록합니다. **정상 응답·exit 0은 정답으로 간주하지 않습니다.** 이전 응답 직후 “틀렸어”, “답이 맞아”, “테스트 통과” 같은 명확한 사용자 평가를 해당 요청에 연결합니다. 일반적인 “좋아”, “계속”은 품질 평가로 세지 않습니다.

사용자나 플러그인의 테스트·리뷰 결과도 공통 인터페이스로 전달할 수 있습니다. 요청 ID는 대시보드 상세 기록에서 확인합니다.

```sh
~/.orca/bin/llm-router feedback --request <요청-UUID> --rating good --evidence tests
~/.orca/bin/llm-router feedback --request <요청-UUID> --rating bad
~/.orca/bin/llm-router stats
```

Python 플러그인은 `LearningStore().feedback(request_id, quality=1, evidence='tests')`를 호출합니다. `quality=0`은 실패 평가입니다. 같은 요청에 대한 재평가는 이전 값을 갱신하며 중복 표로 누적하지 않습니다. 외부 API 호출을 직접 관측할 때는 `LearningStore().observe(request)`로 먼저 실행 결과를 등록합니다.

초기 선택은 아래 규칙입니다. 동일 공급자·질문 유형의 평가가 3건 이상이고 실패가 2건 이상이며 품질 비율이 70% 미만이면 **다음 요청**에서 한 단계 올립니다. 품질 평가가 8건 이상이고 성공 비율이 90% 이상인 후보 사이에서는 관측 응답 시간이 짧은 설정을 선택합니다. 입력 난이도의 기본 등급보다 낮추지 않으며 보안·설계 요청의 예산을 낮추지 않습니다. 비교 데이터가 부족하면 초기 규칙을 유지합니다. 이는 관측에 근거한 개선 정책이며 전역 최적 모델을 보장하지 않습니다.

| 초기 작업 등급 | Codex | Claude |
|---|---|---|
| 범위가 명확한 요약·번역·분류·추출 | gpt-6-luna / low | sonnet / low |
| 일반 작업·난이도 불명확 | gpt-6.1-sol / medium | sonnet / medium |
| 설계·인증·동시성·긴 입력 | gpt-6-astra / high | opus / high |

`~/.orca/llm-router/profiles.json`으로 후보를 바꿀 수 있습니다. 변경은 다음 질문에서 읽습니다. 모델 접근 권한은 실제 계정으로 확인해야 합니다. Claude API 모델 alias의 기본 매핑은 Sonnet/Opus 5.5이며 `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` 또는 전체 모델 ID로 바꿀 수 있습니다. 실패한 코드 수정 작업을 다른 모델로 자동 재실행하지 않습니다.

```json
{
  "codex": {"quick": {"model": "gpt-6-luna", "effort": "low"}},
  "claude": {"quick": {"model": "claude-sonnet-5-5", "effort": "low"}}
}
```

## 대시보드와 저장

세션 대시보드는 질문별 실제 응답 모델·전달 effort·선택 이유·정책·반영한 품질 평가 수를 표시합니다. 정확한 공급자 대화 ID나 살아 있는 pane의 일치하는 질문으로 기존 세션에 연결합니다. 연결할 수 없는 플러그인 호출은 별도 기록으로 보여주며 다른 세션을 덮어쓰지 않습니다. 작업 제목 생성처럼 CLI의 내부 보조 요청은 질문 목록에서 제외합니다. 실행 중에는 “현재 실행”, 응답 후에는 “최근 사용”을 표시합니다.

질문·답변은 `~/.orca/llm-router/sessions`의 로컬 0600 파일에 저장합니다. 인증 헤더는 저장하지 않습니다. 학습 기록은 같은 경로의 `learning.sqlite3`입니다. `LLM_ROUTER_HOME`으로 저장 경로를 바꿀 때는 dashboard에도 같은 환경 변수를 전달해야 합니다.

기존 세션의 자동 라우팅 적용 이전 기록도 실제 대화 파일에서 사용 모델·effort를 읽습니다. Claude 대화 기록에 effort가 없으면 “확인 불가”로 표시합니다. `llm-router --agent ...`의 이전 별도 실행 모드는 진단용으로 유지합니다.

```sh
python3 -m unittest discover -s session-dashboard -p 'test_*.py'
npm test
```

연결 근거: [Codex provider 설정](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude gateway와 구독 로그인](https://code.claude.com/docs/en/llm-gateway), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
