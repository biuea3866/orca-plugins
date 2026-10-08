# Local Self Review — 설계 문서 (TDD, Technical Design Document)

> 근거: [01-requirements-analysis-codex.md](./01-requirements-analysis-codex.md) (Codex 분석). 이 문서는 그 분석의 "1차 릴리스(FR-01~FR-18)" 범위를 Orca 1.4.222 plugin API v0 제약 아래 구현하기 위한 확정 설계다. 구현자(Claude)는 이 문서의 계약을 그대로 따른다.

## v2 변경 (패널 네이티브)

사용자 요구("리뷰 화면이 우측 패널 탭 안에 보여야 한다")에 따라 v1 의 "내장 브라우저 탭" 구조를 **패널 네이티브** 구조로 바꿨다. 근거 사실 2가지를 앱 번들에서 추가 확인했다.

| 사실 | 위치 | 활용 |
|---|---|---|
| 개발 플러그인 경로는 `DMo` 하우스키핑의 `devWatcher` 가 감시하며, 변경 시 300ms 디바운스 후 `refresh()` → `notifyChanged` → 렌더러가 `readPanelEntry` 로 패널 HTML 을 다시 읽는다 | `main/index.js` `DMo.sync`, `EMo.scheduleRefresh` | 서버가 `panel.html` 을 재생성하면 패널이 갱신된다 (서버 → 패널 채널) |
| 매니페스트에 keybindings/vmRecipes/agents 가 있으면(`YI`) 개발 플러그인 폴더의 내용 해시가 승인 지문에 포함된다 | `pgr`/`mgr` | 키바인딩을 제거해 파일 재생성이 승인을 풀지 않게 한다 |

패널 → 서버 채널은 여전히 `terminal.sendText` 뿐이므로 **브리지 터미널**(`open-review --bridge`, raw 모드로 입력을 받아 `/api/bridge` 로 전달)을 둔다. 데이터 흐름·프로토콜은 아래 "패널 네이티브 설계" 절, 코드는 `server/lib/panel-publisher.mjs`·`server/lib/bridge-ops.mjs`·`panel/template.html`·`worker/launcher-cli.mjs`.

## Overview

- 목표 = PR 생성 전 로컬 셀프 리뷰. GitHub PR 화면과 같은 diff 리뷰·드래그 멀티라인 코멘트·스레드 → "리뷰 완료 및 AI 수정" 버튼으로 Claude/Codex 헤드리스 실행 → 재검토.
- GitHub 쓰기 = 0건. GitHub 접근은 `gh` 읽기 전용 조회(PR 목록·상세·diff)뿐.
- 구성 = Orca 플러그인 1개 = **우측 패널(컴패니언)** + **워커(커맨드)** + **로컬 서버(UI·API)**. 리뷰 본체는 같은 워크스페이스의 **Orca 내장 브라우저 탭**에 열린다.

## 플랫폼 제약 → 구조 결정 (사실 근거: Orca 앱 번들 `out/shared/plugins/*.js`)

| 제약 (사실) | 결정 |
|---|---|
| 패널 iframe CSP `connect-src 'none'`, `sandbox="allow-scripts"` — fetch·WS·링크·iframe 전부 불가, 호스트 액션 3개(`workspace.readContext`·`terminal.sendText`·`notifications.show`)뿐, 패널↔워커 채널 없음 | 패널 = 컴패니언(현재 worktree 표시, 리뷰 열기 버튼, 안내). diff·코멘트 UI는 패널에 두지 않음 |
| 워커는 in-flight 작업 없이 5분이면 idle reap | 서버는 워커가 `spawn(detached)` 한 **별도 프로세스**. 워커가 죽어도 UI·AI 실행 유지 |
| 커맨드 `invokeCommand` 인자 없음, 30초 타임아웃 | 커맨드는 "서버 보장 + 탭 열기"만. 대상 worktree는 `orca worktree current --json` → 실패 시 `workspace.readContext`(branch·displayName) + `orca worktree list` 매칭 |
| 워커 env = PATH·HOME·LANG·TZ·TMPDIR만 (GUI PATH일 수 있음) | 서버 기동 시 `$SHELL -lc 'echo $PATH'`로 로그인 PATH 확보 후 `git`·`gh`·`claude`·`codex`·`orca` 해석. 실패 시 고정 후보 경로(`/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm/versions/node/*/bin`, `/Applications/Orca.app/Contents/Resources/bin`) |
| `orca tab create --url` 은 현재 포커스 worktree 스코프 | 커맨드 실행 시점의 현재 worktree 탭에 연다. UI 상단에 대상 worktree 경로를 항상 표시 |
| 패널은 정적 HTML (plugin 상태 변경 때만 재로드) | 패널 버튼은 `terminal.sendText`로 **런처 스크립트** 1줄을 사용자가 고른 터미널에 입력. 런처 경로는 고정(`~/Library/Application Support/OrcaLocalSelfReview/bin/open-review`) — 워커가 첫 활성화 때 생성 |

## 시스템 역할 경계

| 단위 | 경로 | 역할 | 소유 데이터 | 의존 |
|---|---|---|---|---|
| 매니페스트 | `orca-plugin.json` | 패널·커맨드·키바인딩·capability 선언 | — | — |
| 워커 | `worker/main.mjs` | 커맨드 핸들러 3개(`open-review`·`open-overview`·`stop-server`). 서버 보장(`ensureServer`), 런처 설치, `orca tab create` | Orca storage(마지막 에이전트 선택 등 소형 KV) | `worker/launcher-lib.mjs` |
| 서버 | `server/main.mjs` + `server/lib/*.mjs` | 127.0.0.1 HTTP. UI 정적 제공, REST API, git diff, 세션/코멘트 저장, AI 실행 관리, gh 읽기 | `~/Library/Application Support/OrcaLocalSelfReview/` 전체 | `git`·`gh`·`claude`·`codex`·`orca` CLI |
| UI | `ui/index.html`·`ui/app.js`·`ui/styles.css` | SPA(프레임워크 없음, 빌드 없음). 오버뷰·세션·PR 상세 화면 | 브라우저 메모리(상태) | 서버 API |
| 패널 | `panel.html` | 단일 HTML. 현재 worktree 표시, 터미널 선택 + 리뷰 열기, 안내 | — | 호스트 액션 3개 |
| 런처 | 데이터 디렉토리 `bin/open-review` (워커가 생성) | 서버 보장 + `orca tab create` 1회 | — | node, orca |

의존 방향: 패널 → (터미널) → 런처 → 서버. 워커 → 서버. UI → 서버. 서버 → 외부 CLI. 역방향 없음.

## 데이터 디렉토리 (NFR-19: 레포 내부에 파일 생성 0건)

```
~/Library/Application Support/OrcaLocalSelfReview/   (0700)
  runtime/server.json        { port, pid, token, startedAt, protocolVersion:1, serverEntry }  (0600)
  bin/open-review            런처 (0700)
  sessions/<sessionId>.json  ReviewSession (threads·comments 포함, 원자적 교체 .tmp→rename)
  runs/<runId>/meta.json     AIRun
  runs/<runId>/prompt.md     생성한 프롬프트
  runs/<runId>/output.log    stdout+stderr (10MB 상한, 초과분 절단)
  cache/github/<owner>__<repo>.json   PR 목록 캐시 (fetchedAt 포함, TTL 5분)
```

데이터 루트는 env `ORCA_SELF_REVIEW_HOME` 으로 오버라이드 가능(테스트용).

## 데이터 모델 (JSON, `schemaVersion: 1`)

```ts
type Side = 'old' | 'new'
type SessionKind = 'local' | 'pr'

interface ReviewSession {
  schemaVersion: 1
  id: string                      // 'ses_' + 12 hex
  kind: SessionKind
  revision: number                // 저장마다 +1, 쓰기 요청은 revision 일치 필요 (409 충돌)
  repoPath: string                // git 루트 (local) / 로컬 worktree 경로 (pr, 있을 때만) 
  worktreeId: string | null       // Orca worktree id
  repoDisplayName: string
  branch: string
  baseRef: string                 // local: 'origin/main' 등 / pr: baseRefName
  includeUntracked: boolean
  pr: null | { owner: string, repo: string, number: number, headSha: string, url: string }
  agent: 'claude' | 'codex'
  status: 'reviewing' | 'fixing' | 'rechecking' | 'completed'
  threads: Thread[]
  createdAt: string               // ISO UTC
  updatedAt: string
}

interface Thread {
  id: string                      // 'thr_' + 12 hex
  path: string                    // 현재 경로
  oldPath: string | null
  side: Side
  startLine: number               // 양 끝 포함, startLine <= endLine, 범위 1~200줄
  endLine: number
  selectedText: string            // 선택 라인 원문 (앵커 검증·프롬프트 문맥)
  status: 'open' | 'resolved'
  applicability: 'current' | 'outdated'   // 서버가 현재 diff와 대조해 매 조회마다 계산
  comments: Comment[]             // 첫 코멘트가 스레드 생성
  createdAt: string
  resolvedAt: string | null
}

interface Comment { id: string, body: string /* <=10000자 */, createdAt: string, updatedAt: string }

interface AIRun {
  schemaVersion: 1
  id: string                      // 'run_' + 12 hex
  sessionId: string
  agent: 'claude' | 'codex'
  threadIds: string[]
  cwd: string
  pid: number | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  exitCode: number | null
  startedAt: string
  endedAt: string | null
  changedFiles: string[]          // 실행 전후 `git status --porcelain` 차집합 + 변경 파일
}
```

## Diff 모델 (서버 → UI)

```ts
interface DiffFile {
  path: string, oldPath: string | null,
  changeType: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked',
  binary: boolean, additions: number, deletions: number,
  hunks: Hunk[]                   // binary 또는 20,000줄 초과 파일은 hunks=[] + truncated:true
  truncated?: boolean
}
interface Hunk { header: string, oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffLine[] }
interface DiffLine { type: 'context' | 'add' | 'del', oldNo: number | null, newNo: number | null, text: string }
```

로컬 diff 산출: `git merge-base <baseRef> HEAD` → 기본(PR 기준) `git diff <mergeBase> HEAD` (커밋된 변경만). `includeWorkingTree` 가 켜지면 `git diff <mergeBase>` (작업 트리 기준 → staged+unstaged 포함), 거기에 `includeUntracked` 가 켜지면 untracked(`git ls-files --others --exclude-standard`, ignore 대상 제외) 각 파일을 `git diff --no-index /dev/null <file>` 로 추가. merge-base 가 없으면(고아 브랜치) base 자체와 비교하고 `noMergeBase` 를 표시. PR diff 산출: `gh pr diff <n> --repo owner/repo` 결과 파싱(동일 파서).

## 서버 API 계약 (모든 응답 JSON, 오류 `{ error: { code, message } }`)

인증: UI는 `GET /` 로 HTML을 받는다. HTML에 `<meta name="sr-token" content="...">` 로 토큰이 주입된다. 모든 `/api/*` 요청은 헤더 `X-SR-Token: <token>` 필수(없으면 401). 추가로 `Host` 가 `127.0.0.1:<port>` 또는 `localhost:<port>` 가 아니면 400, `Origin` 헤더가 있고 `http://127.0.0.1:<port>`/`http://localhost:<port>` 가 아니면 403. 다른 오리진의 CSRF는 커스텀 헤더 preflight 로 차단된다.

| 메서드·경로 | 요청 | 응답 | 비고 |
|---|---|---|---|
| `GET /health` | — | `{ ok:true, protocolVersion:1, pid, startedAt }` | 토큰 불필요 |
| `POST /api/shutdown` | — | `{ ok:true }` | 실행 중 AIRun 있으면 409 |
| `GET /api/overview` | — | `{ repos: RepoOverview[], sessions: SessionSummary[], github: { enabled, lastFetchedAt, errors: {repo:string, message:string}[] } }` | repos = `orca repo list` 기반, 각 repo에 `worktrees[]`(path, branch, displayName, worktreeId) + `prs[]`(number, title, isDraft, headRefName, baseRefName, author, updatedAt, url, additions, deletions, changedFiles) |
| `POST /api/overview/refresh` | — | overview | 캐시 무시 재조회 |
| `GET /api/context` | `?path=<worktreePath>` | `{ repoPath, branch, baseCandidates: string[], defaultBase: string, worktreeId, repoDisplayName }` | baseCandidates = `origin/HEAD` 해석값, `origin/main`, `origin/dev`, `origin/master`, `main`, `dev`, `master` 중 존재하는 것 |
| `POST /api/sessions` | `{ kind:'local', repoPath, baseRef, includeUntracked?, agent? }` 또는 `{ kind:'pr', owner, repo, number }` | `ReviewSession` | local: 같은 repoPath+baseRef 의 `completed` 아닌 세션이 있으면 그것을 반환(멱등). pr: 같은 owner/repo/number 재사용 |
| `GET /api/sessions` | — | `SessionSummary[]` | |
| `GET /api/sessions/:id` | — | `{ session, diff: { files: DiffFile[], baseSha, headSha, mergeBaseSha, computedAt } }` | 매 조회마다 diff 재계산 + 스레드 applicability 갱신 |
| `PATCH /api/sessions/:id` | `{ revision, baseRef?, includeUntracked?, agent?, status? }` | `ReviewSession` | revision 불일치 409 |
| `DELETE /api/sessions/:id` | — | `{ ok:true }` | |
| `POST /api/sessions/:id/threads` | `{ revision, path, oldPath?, side, startLine, endLine, selectedText, body }` | `ReviewSession` | 범위 검증(1~200줄, start<=end), body 1~10000자 |
| `PATCH /api/sessions/:id/threads/:tid` | `{ revision, status?: 'open'|'resolved' }` | `ReviewSession` | |
| `DELETE /api/sessions/:id/threads/:tid` | `{ revision }` (body) | `ReviewSession` | |
| `POST /api/sessions/:id/threads/:tid/comments` | `{ revision, body }` | `ReviewSession` | |
| `PATCH /api/sessions/:id/threads/:tid/comments/:cid` | `{ revision, body }` | `ReviewSession` | |
| `DELETE /api/sessions/:id/threads/:tid/comments/:cid` | `{ revision }` | `ReviewSession` | 마지막 코멘트 삭제 = 스레드 삭제 |
| `POST /api/sessions/:id/runs` | `{ revision, agent }` | `AIRun` (202) | 대상 = open & current 스레드. 0개면 400. 같은 cwd에 running 있으면 409 + 기존 runId. 세션 status→`fixing` |
| `GET /api/runs/:rid` | `?logFrom=<byteOffset>` | `{ run: AIRun, log: string, logNext: number }` | 2초 폴링용 |
| `POST /api/runs/:rid/cancel` | — | `AIRun` | 프로세스 그룹 SIGTERM → 5초 후 SIGKILL |
| `GET /api/prs/:owner/:repo/:number` | — | `{ pr: PRDetail, diff: { files: DiffFile[] }, localWorktree: { path, branch } | null, session: SessionSummary | null }` | `gh pr view --json ...` + `gh pr diff`. 읽기 전용 |
| `GET /api/agents` | — | `{ claude: { available, path, version }, codex: {...} }` | |

`SessionSummary` = ReviewSession 에서 threads 를 `{ open:number, resolved:number }` 카운트로 치환한 것.

## AI 실행 (FR-10~FR-14)

- 프롬프트(`runs/<id>/prompt.md`): 헤더(세션·대상 경로·브랜치·금지 사항) + 스레드별 블록(파일, side, 라인 범위, 선택 원문, 앞뒤 20줄 문맥(현재 파일 기준, side=new 일 때), 코멘트 원문 전부) + 결과 형식 요구(스레드별 수행/미수행 사유·변경 파일 목록). 금지 사항 = `git commit`·`git push`·`gh` 호출·레포 밖 파일 수정 금지.
- 실행 (stdin 으로 프롬프트, `detached: true` 로 프로세스 그룹 분리, cwd = session.repoPath):
  - claude: `claude -p --output-format text --permission-mode acceptEdits --allowedTools Read Edit Write MultiEdit Grep Glob LS` ("Bash" 미허용 → commit/push 불가)
  - codex: `codex exec --full-auto --skip-git-repo-check -C <cwd> -` (workspace-write 샌드박스, 네트워크 차단 기본 → push 불가)
- 상태: queued → running → succeeded(exit 0)/failed/cancelled. 서버 재시작 시 `meta.json` 의 pid 생존 확인 실패 → interrupted.
- 완료 후 세션 status → `rechecking`. 스레드 자동 resolved 없음(FR-08).
- 총 프롬프트 100KB 초과 시 400 + 분할 안내.

## UI 화면 (ui/)

| 화면 | 라우트(hash) | 내용 |
|---|---|---|
| 오버뷰 | `#/` | 좌: 레포 카드(worktree 목록 → "리뷰 시작"), 우: 전체 레포 open PR 테이블(Draft 배지, 레포·작성자·Draft 필터, 새로고침, 마지막 조회 시각, 오류 표시), 하단: 로컬 세션 목록(상태·open 스레드 수·재열기·삭제) |
| 세션 리뷰 | `#/sessions/:id` | 헤더(레포·브랜치·base 선택·untracked 토글·에이전트 선택·"리뷰 완료 및 AI 수정"(open·current 스레드 수 표시, 실행 중이면 비활성)), 좌: 파일 목록(+/- 통계, 스레드 수), 우: 파일별 unified diff. 라인 번호 거터를 드래그(또는 Shift+클릭)하면 같은 side·같은 파일의 연속 범위 선택 → 코멘트 폼. 스레드는 endLine 아래 인라인 렌더(수정·삭제·resolve·답글). outdated 스레드 회색 배지. 실행 패널: 상태·로그 tail(2초 폴링)·취소 |
| PR 상세 | `#/prs/:owner/:repo/:number` | 제목·번호·Draft·작성자·base←head·통계·본문(텍스트 렌더, raw HTML 금지), diff 뷰어(동일 컴포넌트). "로컬 리뷰 세션 열기" → kind:'pr' 세션 생성. 로컬 worktree 가 없으면 AI 수정 버튼 비활성 + 사유 |

- 테마: `prefers-color-scheme` 기본 + 수동 토글(localStorage). CSS 변수 토큰만 사용, 색 하드코딩 금지. 본문 대비 4.5:1 이상.
- 대형 diff: 파일은 클릭 시 렌더(지연), 20,000줄 초과 파일은 서버가 truncated → "크기 초과" 안내.
- 선택 제약: 파일·side 경계 넘는 드래그는 경계에서 멈춤. 최대 200줄.

## 패널 (panel.html)

- 로드 시 `workspace.readContext` → displayName·branch 표시, terminals[] 로 `<select>` 채움(id 끝 8자).
- "리뷰 열기" → 선택 터미널에 `"$HOME/Library/Application Support/OrcaLocalSelfReview/bin/open-review"` + Enter 전송 → `notifications.show`.
- "전체 PR·세션" → 같은 런처에 ` --overview` 인자.
- 런처가 없으면(첫 사용) 안내: 커맨드 팔레트 "Self Review: 현재 worktree 리뷰 열기" 1회 실행.
- 호스트 토큰(`--background`·`--foreground`·`--primary`·`--border` 등)만 사용.

## 워커 (worker/main.mjs)

```
activate(ctx):
  installLauncher()                       // bin/open-review 생성/갱신 (idempotent)
  commands.register('open-review', async () => {
     const { port, token } = await ensureServer()        // health → 없으면 spawn detached, 5초 내 health 대기
     const target = await currentWorktreePath()           // orca worktree current --json
     await orca('tab', 'create', '--url', `http://127.0.0.1:${port}/?target=${enc(target)}`)
     notifications.show(...)
  })
  commands.register('open-overview', ...)  // url = /#/
  commands.register('stop-server', ...)    // POST /api/shutdown
```

`ensureServer()`·`currentWorktreePath()`·`resolveBin()` 는 `worker/launcher-lib.mjs` 에 두고 워커와 런처가 공유한다 (워커는 `import.meta.url` 로 플러그인 루트를 구한다). 서버 spawn = `spawn(process.execPath, [serverEntry], { detached:true, stdio:'ignore', env: { ...env, ELECTRON_RUN_AS_NODE:'1', ORCA_SELF_REVIEW_HOME } }).unref()`. 서버는 기동 시 `runtime/server.json` 을 원자적으로 쓴다. 포트 = 우선 47811, 사용 중이면 OS 할당.

## 실패 경로

| 상황 | 처리 |
|---|---|
| `gh` 미설치·미인증 | overview.github.enabled=false + errors. PR 기능만 비활성, 로컬 리뷰는 동작 |
| `git` 명령 실패(merge-base 없음 등) | 400 `{code:'git_failed', message: stderr}` UI 가 base 변경 유도 |
| 세션 revision 충돌 | 409 → UI 가 최신 세션 재조회 후 안내 |
| 에이전트 CLI 없음 | `/api/agents` available=false → 버튼 비활성 + 사유 |
| 동일 cwd 중복 실행 | 409 + 기존 runId 반환 → UI 가 그 run 표시 |
| 서버 비정상 종료 | 다음 커맨드에서 health 실패 → 재기동, running run 은 interrupted |
| 서버 15분 유휴(UI 요청 0·run 0) | 자동 종료, runtime/server.json 삭제 |

## 테스트 계획 (node:test, `test/*.test.mjs`, git 외 외부 CLI(gh·claude·codex·orca) 없이 실행 가능해야 함 — runner 주입으로 모킹)

| 레벨 | 대상 | 케이스 |
|---|---|---|
| 단위 | `server/lib/diff-parser.mjs` | unified diff → DiffFile(추가·삭제·수정·rename·binary·멀티 hunk·`\ No newline`), 라인 번호 old/new 정확성, 20,000줄 초과 truncated |
| 단위 | `server/lib/store.mjs` | 세션 CRUD 원자 저장·revision 증가·충돌 409·스레드 범위 검증·마지막 코멘트 삭제 시 스레드 삭제·멱등 생성 |
| 단위 | `server/lib/anchor.mjs` | 스레드 applicability: 동일 라인 텍스트 일치 → current, 불일치 → outdated |
| 단위 | `server/lib/prompt.mjs` | 프롬프트에 파일·side·범위·원문·코멘트 전부 포함, 금지 문구 포함, 100KB 초과 오류 |
| 단위 | `server/lib/auth.mjs` | 토큰 없음 401, Host 불일치 400, Origin 불일치 403, 정상 통과 |
| 단위 | `server/lib/github.mjs` | gh JSON → PR 요약 매핑, 캐시 TTL, gh 실패 시 errors 수집 (gh 는 주입 가능한 runner 로 모킹) |
| 통합 | `server/main.mjs` (실제 임시 git 레포 생성) | 세션 생성 → diff 조회 → 스레드 추가 → run 생성(에이전트 runner 를 가짜 스크립트로 주입) → 상태 전이·로그 조회·취소 |
| 단위 | `ui/lib/selection.mjs` | 드래그 범위 정규화(역방향·side 경계·200줄 상한), 스레드 인라인 배치 계산 |
| 단위 | `worker/launcher-lib.mjs` | health 실패 시 spawn 호출, 성공 시 재사용, 포트 폴백 (spawn·fetch 주입) |

## 파일 소유 (Single Writer per File)

| 구현자 | 소유 경로 |
|---|---|
| A (server) | `server/**`, `test/server-*.test.mjs`, `test/helpers/**` |
| B (ui) | `ui/**`, `test/ui-*.test.mjs` |
| 메인 | `orca-plugin.json`, `package.json`, `worker/**`, `panel/**`, `docs/**`, `README.md`, `test/worker-*.test.mjs` |

## Out of Scope (1차)

split diff, 파일별 확인 완료, 세션 내보내기, Orca 에이전트 터미널로 프롬프트 전송(헤드리스 실행이 기본), GitHub Enterprise, 자동 commit/push, PR 생성.


## 패널 네이티브 설계 (v2)

### 데이터 흐름

```
[서버] 변경 발생(세션·스레드·실행 상태) → PanelPublisher.schedule() (150ms 디바운스)
     → panel/template.html + <script id="orca-panel-data"> JSON → panel.html (tmp+rename)
     → Orca devWatcher(300ms) → plugins refresh → 패널 iframe 재로드 (패치 호스트: orca-panel-data 메시지로 데이터만 교체)
[패널] 조작 → op JSON → `SR <base64url>` 1줄 (3,800자 초과 시 `SRC <id> <i> <n> <data>` 청크)
     → terminal.sendText(브리지 터미널) → bridge CLI (raw 모드, 에코 없음) → POST /api/bridge → 서버 처리 → 재생성
```

### 패널 데이터 (`orca-panel-data`)
`{ schemaVersion:1, generatedAt, reason, server:{port,pid}, launcher, agents, worktrees:[{worktreeId,path,branch,displayName,repoDisplayName,sessionId,bridgeTerminalIds}], sessions:{[id]:{session,diff}}, sessionList, runs:{[sessionId]: AIRun+logTail}, overview:{repos,github}, viewState:{[sessionId]:{route,file,scroll}} }`
- 완료되지 않은 세션만 포함. 파일당 diff 3,000줄 초과는 `panelTruncated` (넓게 보기 안내). 전체 6MB 초과 시 sessions 제거 + `oversized`.
- 패널은 `workspace.readContext` 의 displayName·branch 로 `worktrees` 에서 현재 worktree 를 고른다. 오버뷰에서 수동으로 고른 worktree 는 컨텍스트가 바뀌기 전까지 유지.
- 브리지 터미널 id 매칭: `bridgeTerminalIds ∩ readContext.terminals[].id`. 브리지는 `ORCA_TERMINAL_HANDLE`·ptyId·(패널이 고른 id) 를 모두 등록한다.

### 브리지 op (`server/lib/bridge-ops.mjs`)
`session.open|patch|delete|complete`, `thread.add|patch|delete`, `comment.add|patch|delete`, `run.start|cancel`, `overview.refresh`, `view`, `wide`, `ping`. `view` 는 재생성을 일으키지 않고 viewState 만 저장한다(스크롤·파일 복원용). 실행 중에는 2초마다 상태 변화가 있을 때만 재생성한다(로그 증가만으로는 재로드하지 않음).

### 재로드와 입력 보존
스톡 호스트는 재생성 때 iframe 을 통째로 다시 로드한다. 패널은 작성 중인 코멘트 초안을 메모리(UI.draft)에 두고 재렌더 시 복원하지만, 재로드 자체는 초안을 잃는다. 그래서 재생성은 사용자의 조작 결과(코멘트 등록 등)와 실행 상태 전이에서만 일어난다.

### 검증 (2026-10-08)
- `node --test test/*.test.mjs` 69건 통과 (패널 문서·브리지 op·브리지 통합 포함).
- 실측: 브리지 터미널 생성 → `orca terminal send` 로 `SR …` 1줄 입력 → 서버 스레드 추가 → `panel.html` 재생성(reason=thread) 확인.
- 실측: `/panel-preview` 를 내장 브라우저에서 열어 오버뷰 → 세션 열기 → 거터 선택 → 코멘트 등록 → 스레드 렌더 확인.
- 미검증: 실제 Orca 사이드바 패널에서의 표시(스크린샷 권한 없음) — 사용자 확인 필요.
