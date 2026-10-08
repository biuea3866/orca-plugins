# Local Self Review — Orca 플러그인

PR을 올리기 **전에** 사람이 직접 하는 셀프 리뷰 도구. GitHub PR 화면처럼 diff를 읽고, 라인 번호를 **드래그해 멀티라인 코멘트**를 남기고, "리뷰 완료 및 AI 수정" 버튼으로 **Claude 또는 Codex** 가 코멘트대로 코드를 고치게 한 뒤 다시 검토한다. 등록된 모든 레포의 **draft/open PR 목록과 상세**도 한 화면에서 본다.

- GitHub 쓰기 = **0건**. 코멘트·세션·AI 실행 기록은 전부 로컬(`~/Library/Application Support/OrcaLocalSelfReview/`)에만 저장. GitHub 접근은 `gh` 읽기 전용 조회(PR 목록·상세·diff)뿐.
- 런타임 의존성 = 0 (Node 내장 모듈만). 빌드 단계 없음.

## 구성

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| **우측 사이드바 패널** | `panel/template.html` → 생성물 `panel/index.html` | 리뷰 화면 본체. 오버뷰(worktree·세션·PR)와 세션 리뷰(diff·드래그 멀티라인 코멘트·스레드·AI 실행)를 **패널 탭 안에서** 표시 |
| 로컬 서버 | `server/main.mjs` | `127.0.0.1` 전용. git diff, 세션/코멘트 저장, AI 실행, `gh` 읽기. **데이터가 바뀔 때마다 `panel/index.html` 을 다시 생성** → Orca 개발 플러그인 파일 감시기가 패널을 다시 읽음 |
| 브리지 터미널 | `worker/launcher-cli.mjs --bridge` | 패널 → 서버 입력 통로. 패널은 `terminal.sendText` 로 이 터미널에 명령 1줄(`SR <base64url JSON>`)을 입력하고, 브리지가 서버 API 로 전달 |
| 워커 (커맨드) | `worker/main.mjs` | 커맨드 팔레트 `Self Review: …`. 서버 보장, 세션 준비, 브리지 터미널 자동 생성, 런처 설치 |
| 넓은 화면 | `ui/` | 같은 데이터를 내장 브라우저 탭에서 넓게 보는 보조 화면 (PR 상세·큰 diff·실행 로그) |

패널이 데이터를 받고 보내는 방식 (Orca plugin API v0 제약 — 패널은 `sandbox="allow-scripts"` iframe + CSP `connect-src 'none'`, 호스트 액션은 `workspace.readContext`·`terminal.sendText`·`notifications.show` 3개뿐):

- **서버 → 패널**: 서버가 `panel/index.html` 에 `<script type="application/json" id="orca-panel-data">` 로 데이터를 넣어 재생성. Orca 는 개발 플러그인 폴더를 감시해(300ms 디바운스) 플러그인을 새로고침하고 패널을 다시 읽는다. 패치된 호스트(`orca-panel-data` 메시지 지원)에서는 iframe 을 유지한 채 데이터만 갱신된다.
- **패널 → 서버**: `terminal.sendText` 로 브리지 터미널에 한 줄 입력. 4,096자 초과는 `SRC` 청크로 분할. 브리지는 입력 에코 없이(raw 모드) 서버에 전달하고 처리 상태만 표시한다.
- 키바인딩은 선언하지 않는다. 키바인딩이 있으면 Orca 가 플러그인 폴더 내용 해시를 승인 지문에 포함해, 패널 재생성 때마다 승인이 풀린다.

상세는 [docs/02-design.md](./docs/02-design.md).

## 설치 (개발 모드)

1. Orca → Settings → Plugins → 플러그인 시스템 ON.
2. **Development** 섹션 → "Development plugin folder path" 에 이 레포 경로(`orca-plugin.json` 이 있는 폴더) 추가.
3. 권한(워크스페이스 읽기·터미널 입력·알림·스토리지·설정) 검토 후 활성화.
4. 커맨드 팔레트에서 `Self Review: 현재 worktree 리뷰 (우측 패널)` 1회 실행 → 로컬 서버가 뜨고, 현재 worktree 세션과 **브리지 터미널**("Self Review bridge")이 만들어지며, 런처가 `~/Library/Application Support/OrcaLocalSelfReview/bin/open-review` 에 설치된다.
5. 우측 사이드바에서 **Self Review** 탭을 연다. 브리지가 없으면 패널의 "브리지 시작"에서 셸 터미널을 골라 만들 수 있다.

요구 사항: macOS, `git`. PR 목록은 `gh`(로그인 상태), AI 수정은 `claude` 또는 `codex` CLI.

## 사용 흐름

1. 패널 "리뷰" 탭: 현재 worktree 세션(기본 base = `origin/HEAD`, 미커밋·untracked 포함). 없으면 "리뷰 세션 시작".
2. 파일을 고르고, 라인 번호 거터를 드래그(또는 Shift+클릭, 키보드 Enter/Shift+↑↓) → 코멘트 작성. 같은 파일·같은 side 안에서 최대 200줄. 코멘트는 브리지 터미널을 거쳐 저장되고 패널이 곧 갱신된다.
3. 에이전트(claude/codex) 선택 → **리뷰 완료 및 AI 수정** → 열린 코멘트가 프롬프트로 변환돼 헤드리스 실행. 상태·변경 파일·로그는 패널의 "AI 수정" 카드에, 전체 로그는 "넓게"에서.
4. 완료 후 스레드별로 직접 resolve. (AI 성공만으로 자동 resolve 되지 않는다.)
5. 만족하면 평소대로 PR 생성. 플러그인은 commit/push/PR 을 하지 않는다.

패널 "전체 PR·세션" 탭에서는 Orca 에 등록된 모든 레포의 open PR(Draft 배지·레포 필터)과 로컬 세션을 본다. PR 상세·diff 와 PR 에 대한 로컬 코멘트는 "넓게"(내장 브라우저)에서 본다.

## AI 실행의 쓰기 금지 경계

| 에이전트 | 실행 명령 | 차단 수단 |
|---|---|---|
| claude | `claude -p --permission-mode acceptEdits --allowedTools Read Edit Write MultiEdit Grep Glob LS` | 플러그인은 Bash 를 허용하지 않음. 단 사용자 전역 `~/.claude/settings.json` 의 permissions allow 규칙에 해당하는 Bash 는 실행될 수 있음(실측: `npm test` 가 실행됨) — `git push`·`gh` 를 allow 에 넣지 않을 것 |
| codex | `codex exec --full-auto --skip-git-repo-check -C <worktree> -` | workspace-write 샌드박스, 네트워크 차단 기본값 |

프롬프트에도 commit/push/gh 금지를 명시한다. 이 경계는 CLI 의 권한 정책에 의존하므로(OS 수준 격리 아님) CLI 업데이트·전역 permissions 변경 시 재검증이 필요하다. 플러그인 자체의 GitHub 접근은 `server/lib/github.mjs` 한 곳에서 `gh pr list/view/diff` 만 호출한다.

## 개발

```sh
node --test test/*.test.mjs   # 전 테스트 (git 외 외부 CLI 불필요 — gh/claude/codex/orca 는 모킹)
node server/main.mjs --foreground   # 서버 단독 실행 (ORCA_SELF_REVIEW_HOME 으로 데이터 경로 변경 가능)
node scripts/build-panel.mjs        # 데이터 없는 기준 panel/index.html 재생성 (서버가 런타임에 덮어씀)
# 패널 UI 를 브라우저에서 직접 보려면: http://127.0.0.1:47811/panel-preview (프리뷰 모드 — 브리지 대신 HTTP 로 동작)
```

문서: [docs/01-requirements-analysis-codex.md](./docs/01-requirements-analysis-codex.md) (Codex 요구사항 분석) · [docs/02-design.md](./docs/02-design.md) (설계·API 계약).
