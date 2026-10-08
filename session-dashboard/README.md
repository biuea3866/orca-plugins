# Orca 세션 대시보드 패널

모든 프로젝트의 세션 상태, 진행률, 작업 요약, 대기 사유를 Orca 우측 패널에서 표시합니다.

요구 사항: macOS, Python 3.10 이상, Orca와 `orca` CLI. 새 컴퓨터에서는 저장소를 복제한 뒤 저장소 루트에서 설치합니다.

```sh
python3 session-dashboard/install.py
```

Orca 설정 → Plugins → Development에서 `~/.orca/session-dashboard/plugin`의 **절대 경로**를 추가하고 `Orca 세션 대시보드`를 활성화합니다. 우측 패널의 `세션 대시보드` 탭을 선택합니다.

macOS 로그인 서비스가 저장소에 포함된 `collector.py`를 사용합니다. 설치 시 수집기와 브리지를 `~/.orca/session-dashboard/`에 복사하므로 별도 수집기를 준비할 필요가 없습니다. 서버나 Chrome 창은 필요하지 않습니다. 생성된 HTML을 Orca의 개발 플러그인 파일 감시기가 다시 읽으므로, 프로젝트를 전환해도 전체 세션을 보여줍니다. 패널 자체는 추가 권한을 요청하지 않습니다.

수집기에 포함된 웹 대시보드의 HTML/CSS와 렌더링 함수를 사용하며, 진행률 링·Step 스테퍼·세션 상세·에이전트 트리·타임라인을 포함합니다. 패널 폭에 맞게 간격과 KPI 배치만 조정합니다. 첫 화면은 데이터를 포함해 동기적으로 렌더링합니다. Claude의 계획과 상세 기록은 해당 컴퓨터의 `~/.claude/projects`, 스킬 단계는 `~/.claude/skills`에서 읽습니다.

기본 Orca pluginApi 1은 패널의 네트워크 요청과 사용자 정의 데이터 브리지를 지원하지 않습니다. 기본 모드는 내용 변경 시 HTML 문서를 갱신하므로 상세 화면과 스크롤이 초기화됩니다.

프레임 교체를 없애는 로컬 호스트 수정은 `host-patch/`에 있습니다. Orca 1.4.222 소스에서 데이터만 바뀐 경우 동일한 iframe을 유지하고 `orca-panel-data` 메시지로 새 데이터를 전달합니다. 스크립트 또는 스타일 자체가 변경된 경우에는 기존 재로드 동작을 유지합니다. CSP, scripts-only sandbox, 권한 검사는 유지합니다.

`build_local_orca.py`는 `/Applications/Orca.app`에서 별도 `~/Applications/Orca Dashboard.app`을 생성하고 renderer asset을 수정합니다. 실행 중인 원본을 수정하지 않습니다. 복사 앱은 로컬 서명이며, 공식 업데이트가 이 수정을 포함하지는 않습니다. `host-patch/orca-v1.4.222-panel-data.patch`는 해당 버전 소스에 적용할 수정입니다.

스크롤 유지와 **터미널로 이동**을 사용하려면 Orca 1.4.222, Node.js, macOS의 `codesign`이 필요합니다. 해당 버전이 설치된 새 컴퓨터에서 다음 명령으로 수정 앱을 만든 뒤 기존 Orca를 종료하고 수정 앱을 실행합니다.

```sh
python3 session-dashboard/build_local_orca.py
open "$HOME/Applications/Orca Dashboard.app"
```

수정 앱으로 재시작한 다음:

```sh
python3 session-dashboard/install.py --persistent-frame
```

이 모드는 3초마다 수집한 전체 데이터(마지막 출력 시각과 사용 도구 포함)를 전달하며, 상세 화면의 선택과 스크롤을 유지합니다. 설치 스크립트는 수정 앱이 실행 중인지 확인한 후 활성화합니다. 기본 앱에서는 `--persistent-frame` 활성화를 거부합니다. 수정 앱을 테스트 환경에서 실행하려면 Electron 스킬과 별도의 테스트 프로필을 사용해야 합니다.

진행률은 명시된 스킬 단계/코멘트를 우선하고, Claude의 `TodoWrite` 또는 `TaskCreate`/`TaskUpdate` 계획이 있으면 완료 항목 수로 계산합니다. 계획이 없으면 확인·분석 → 구현·처리 → 검증의 3단계를 0/33/67%로 표시하며, 링의 `~`와 계산 근거에 `단계 추정`을 명시합니다. 전체 작업량이나 남은 시간을 의미하지 않습니다. 현재 응답이 끝나고 다음 지시를 기다리는 세션은 100%로 표시합니다. 새 요청이 들어오면 추정 단계가 초기화됩니다.

카드와 상세 화면의 **터미널로 이동** 버튼은 해당 프로젝트와 터미널 탭·분할 패널로 이동합니다. 연결된 터미널이 없는 세션은 버튼을 비활성화합니다. 이동 중 또는 실패 시 버튼 옆에 상태를 표시합니다. 로컬 호스트의 이동 처리는 이 대시보드 플러그인과 현재 데이터에 포함된 터미널 핸들만 허용하며, 고정된 `terminal.focus` 호출을 사용합니다. 터미널 입력이나 셸 명령을 실행하지 않습니다.

검증:

```sh
python3 session-dashboard/test_bridge.py
python3 session-dashboard/test_progress.py
python3 session-dashboard/test_install.py
```

중지:

```sh
launchctl bootout gui/$(id -u)/com.biuea3866.orca-session-dashboard
```

삭제 시 Orca Development 경로를 제거하고 `~/Library/LaunchAgents/com.biuea3866.orca-session-dashboard.plist`와 `~/.orca/session-dashboard`를 삭제합니다.

업데이트는 저장소에서 `git pull --ff-only` 후 설치 명령을 다시 실행합니다. 수정 앱을 사용하는 경우에는 `--persistent-frame` 옵션을 다시 지정합니다.
