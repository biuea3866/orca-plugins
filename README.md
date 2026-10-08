# Local Self Review — Orca 플러그인

PR을 올리기 **전에** 사람이 직접 하는 셀프 리뷰 도구. GitHub PR 화면처럼 diff를 읽고, 라인 번호를 **드래그해 멀티라인 코멘트**를 남기고, "리뷰 완료 및 AI 수정" 버튼으로 **Claude 또는 Codex** 가 코멘트대로 코드를 고치게 한 뒤 다시 검토한다. 등록된 모든 레포의 **draft/open PR 목록과 상세**도 한 화면에서 본다.

- GitHub 쓰기 = **0건**. 코멘트·세션·AI 실행 기록은 전부 로컬(`~/Library/Application Support/OrcaLocalSelfReview/`)에만 저장. GitHub 접근은 `gh` 읽기 전용 조회(PR 목록·상세·diff)뿐.
- 런타임 의존성 = 0 (Node 내장 모듈만). 빌드 단계 없음.

## 구성

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| 우측 사이드바 패널 | `panel/index.html` | 현재 worktree·브랜치 표시, 터미널 선택 후 "리뷰 열기". Orca 패널 샌드박스(네트워크 불가) 때문에 **컴패니언** 역할만 |
| 워커 (커맨드) | `worker/main.mjs` | 커맨드 팔레트 `Self Review: …` 3개. 로컬 서버 보장 → Orca 내장 브라우저 탭 열기 |
| 로컬 서버 | `server/main.mjs` | `127.0.0.1` 전용 HTTP. 리뷰 UI·API, git diff, 세션/코멘트 저장, AI 실행, `gh` 읽기 |
| 리뷰 UI | `ui/` | 오버뷰(레포·PR·세션) / 세션 리뷰(diff·코멘트·AI 실행) / PR 상세 |

왜 리뷰 화면이 패널이 아니라 브라우저 탭인가: Orca plugin API v0 의 패널은 `sandbox="allow-scripts"` iframe 에 CSP `connect-src 'none'` 이 걸려 있어 파일·네트워크 접근과 워커 통신이 전부 불가하고, 호출 가능한 호스트 액션은 `workspace.readContext`·`terminal.sendText`·`notifications.show` 3개뿐이다. 상세는 [docs/02-design.md](./docs/02-design.md).

## 설치 (개발 모드)

1. Orca → Settings → Plugins → 플러그인 시스템 ON.
2. **Development** 섹션 → "Development plugin folder path" 에 이 레포 경로(`orca-plugin.json` 이 있는 폴더) 추가.
3. 권한(워크스페이스 읽기·터미널 입력·알림·스토리지·설정) 검토 후 활성화.
4. 커맨드 팔레트에서 `Self Review: 현재 worktree 리뷰 열기` (⌘⌥R) 1회 실행 → 로컬 서버가 뜨고 내장 브라우저 탭이 열리며, 패널용 런처가 `~/Library/Application Support/OrcaLocalSelfReview/bin/open-review` 에 설치된다.

요구 사항: macOS, `git`. PR 목록은 `gh`(로그인 상태), AI 수정은 `claude` 또는 `codex` CLI.

## 사용 흐름

1. worktree 에서 ⌘⌥R → 세션 생성(기본 base = `origin/HEAD`, 미커밋·untracked 포함).
2. 파일을 고르고, 라인 번호 거터를 드래그(또는 Shift+클릭) → 코멘트 작성. 같은 파일·같은 side 안에서 최대 200줄.
3. 에이전트(claude/codex) 선택 → **리뷰 완료 및 AI 수정** → 열린 코멘트가 프롬프트로 변환돼 헤드리스 실행. 로그를 보고, 필요하면 취소.
4. 완료 후 diff 새로고침 → 스레드별로 직접 resolve. (AI 성공만으로 자동 resolve 되지 않는다.)
5. 만족하면 평소대로 PR 생성. 플러그인은 commit/push/PR 을 하지 않는다.

오버뷰(`Self Review: 전체 PR·세션 목록 열기`)에서는 Orca 에 등록된 모든 레포의 open PR(Draft 배지)과 로컬 세션을 본다. PR 상세에서 "로컬 리뷰 세션 열기" 로 그 PR 의 diff 에도 로컬 코멘트를 남길 수 있다.

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
```

문서: [docs/01-requirements-analysis-codex.md](./docs/01-requirements-analysis-codex.md) (Codex 요구사항 분석) · [docs/02-design.md](./docs/02-design.md) (설계·API 계약).
