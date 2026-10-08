#!/usr/bin/env python3
"""orca-dashboard — Orca 세션 실시간 대시보드 (읽기 전용)

  orca-dashboard snapshot                          현재 세션 스냅샷 JSON 1회 출력 (exit 1 = Orca 수집 실패)
  orca-dashboard serve [--port 7788] [--interval 3]
                                                   127.0.0.1 에 대시보드 페이지 + /api/snapshot 제공

  상세 페이지 = /#session=<id> (데이터 /api/session?id=<id>)

환경 변수
  ORCA_CLI_COMMAND     Orca CLI 실행 명령 (shlex 분리, 기본 "orca")
  CLAUDE_PROJECTS_DIR  Claude Code transcript 루트 (기본 ~/.claude/projects, 읽기 전용)

호출하는 Orca 명령은 읽기 전용뿐이다: worktree ps · terminal list · terminal read.
"""
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit


SKILLS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "skills")

STATUS_ORDER = ("blocked", "waiting_user", "stale", "running", "background", "idle")
STALE_AFTER_MS = 900_000
ERROR_WINDOW_LINES = 15
WORKING_WINDOW_LINES = 8
SUMMARY_MAX_CHARS = 240
REASON_MAX_CHARS = 160
TAIL_LIMIT = 80
AGENT_TITLE_GLYPHS = frozenset("✳◐◑◒◓✻✢✶")
PIPELINE_KEYWORDS = {"로드맵": "private-roadmap"}

TITLE_GLYPH_PREFIX_RE = re.compile(r"^[^\w.\/\[(]+")
RECAP_PREFIX = "※ recap:"
RECAP_TAIL = "(disable recaps in /config)"
BLOCK_BREAK_PREFIXES = ("⏺", "✻", "❯", "※", "─")
REPLY_END_PREFIXES = ("✻", "❯", "※", "─")
SPINNER_RE = re.compile(r"^[✢✳✶✻✽·*]\s+\S+…")
STEP_HEADING_RE = re.compile(r"^## Step (\d+)", re.M)
STEP_TITLE_RE = re.compile(r"^## Step (\d+)(.*)$", re.M)
STEP_TITLE_SEPARATORS = " \t—–-:"
STEP_MENTION_RE = re.compile(r"Step\s*(\d+)")
STEP_FORECAST_RE = re.compile(r"다음|이후|next", re.I)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。])\s+|\n")
PIPELINE_NAME_RE = re.compile(r"private-[a-z][a-z-]*")
COMMENT_PROGRESS_RE = re.compile(r"진행\s*(\d{1,3})\s*%")
COMPLETION_RE = re.compile(r"머지했|merged=true|완료했습니다|모두 끝났습니다")
ERROR_LINE_RE = re.compile(
    r"BUILD FAILED|(?<![A-Za-z0-9_])FAILED(?![A-Za-z0-9_])|Traceback|Error:|exit code [1-9]"
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。])\s+|\n")
REQUEST_RE = re.compile(
    r"지시하시면|알려\s?주세요|할까요|하시겠어요|정해\s?주세요|선택해\s?주세요"
    r"|승인해\s?주세요|확인해\s?주세요|\?\s*$"
)
SHELLS_RUNNING_RE = re.compile(r"(\d+) shells? still running")
MARKDOWN_LEAD_CHARS = "#-*> \t"
KNOWN_AGENT_STATES = ("working", "done", "idle", None)
ATTENTION_STATUSES = ("blocked", "waiting_user", "stale")

TRANSCRIPT_DIR_UNSAFE_RE = re.compile(r"[^A-Za-z0-9]")
ORCA_PROMPT_LIMIT = 200  # Orca 가 agents[].prompt 를 자르는 길이 (실측)
TRANSCRIPT_TITLE_CHARS = 80
PROMPT_TEXT_CHARS = 160
TIMELINE_LIMIT = 60
AGENT_TOOL_NAMES = ("Agent", "Task")
TASK_NOTIFICATION_PREFIX = "<task-notification>"
CONTINUATION_PREFIX = "This session is being continued from a previous conversation"
TASK_NOTIFICATION_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
NOTIFICATION_FIELD_RE = {
    field: re.compile(rf"<{field}>(.*?)</{field}>", re.S) for field in ("tool-use-id", "status", "summary")
}
NOTIFICATION_EXIT_CODE_RE = re.compile(r"exit code (\d+)")
NOTIFICATION_FAILED_STATUSES = ("failed", "killed", "error")
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class OrcaError(Exception):
    """Orca CLI 가 사용 가능한 결과를 주지 못했을 때."""


# ── 순수 판정 함수 (I/O·현재 시각 조회 없음) ─────────────────────────────


def clean_title(title: str | None) -> str | None:
    """터미널 제목 앞의 TUI 글리프·공백 제거. 남는 것이 없으면 None."""
    if not title:
        return None
    cleaned = TITLE_GLYPH_PREFIX_RE.sub("", title).strip()
    return cleaned or None


def _non_empty(lines: list[str]) -> list[str]:
    return [line for line in lines if line.strip()]


def _last_index(lines: list[str], predicate) -> int | None:
    for index in range(len(lines) - 1, -1, -1):
        if predicate(lines[index]):
            return index
    return None


def _starts_with_any(line: str, prefixes: tuple[str, ...]) -> bool:
    return line.strip().startswith(prefixes)


def _recap_index(tail_lines: list[str]) -> int | None:
    return _last_index(tail_lines, lambda line: line.lstrip().startswith(RECAP_PREFIX))


def is_recap_fresh(tail_lines: list[str]) -> bool:
    """마지막 recap 이후 `⏺` 응답 줄이 없으면 신선 (recap 이 가장 최근 상태)."""
    recap_at = _recap_index(tail_lines)
    if recap_at is None:
        return False
    return not any(line.strip().startswith("⏺") for line in tail_lines[recap_at + 1:])


def extract_recap(tail_lines: list[str]) -> str | None:
    """마지막 `※ recap:` 블록(들여쓰기 연속 줄 포함)을 한 줄로 반환."""
    start = _recap_index(tail_lines)
    if start is None:
        return None
    pieces = [tail_lines[start].lstrip()[len(RECAP_PREFIX):].strip()]
    for line in tail_lines[start + 1:]:
        is_continuation = (
            line[:1].isspace()
            and line.strip()
            and not _starts_with_any(line, BLOCK_BREAK_PREFIXES)
        )
        if not is_continuation:
            break
        pieces.append(line.strip())
    text = " ".join(piece for piece in pieces if piece).strip()
    if text.endswith(RECAP_TAIL):
        text = text[: -len(RECAP_TAIL)].strip()
    return text or None


def last_reply_from_tail(tail_lines: list[str]) -> str | None:
    """마지막 `⏺` 응답 블록 텍스트. agents 미등록 터미널의 마지막 응답 대용."""
    start = _last_index(tail_lines, lambda line: line.strip().startswith("⏺"))
    if start is None:
        return None
    block = [tail_lines[start].strip()[1:].strip()]
    for line in tail_lines[start + 1:]:
        if _starts_with_any(line, REPLY_END_PREFIXES):
            break
        block.append(line.strip())
    text = "\n".join(block).strip()
    return text or None


def is_tail_working(tail_lines: list[str]) -> bool:
    """최근 8줄에 Claude 스피너(진행 중) 줄이 있는지."""
    for line in _non_empty(tail_lines)[-WORKING_WINDOW_LINES:]:
        stripped = line.strip()
        if SPINNER_RE.match(stripped) and "(" in stripped and "done" not in stripped:
            return True
    return False


def _is_markup_only(line: str) -> bool:
    """코드 펜스·마크다운 표 행/구분선·가로줄처럼 내용 없는 줄."""
    return line.startswith(("```", "|")) or set(line) <= {"─"}


def _first_meaningful_line(text: str | None) -> str | None:
    """마크다운 장식을 걷어낸 첫 의미 있는 줄 (표시용 요약)."""
    if not text:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or _is_markup_only(stripped):
            continue
        cleaned = stripped.lstrip(MARKDOWN_LEAD_CHARS).replace("**", "").strip()
        if cleaned:
            return cleaned[:SUMMARY_MAX_CHARS]
    return None


def summarize(tail_lines: list[str], last_message: str | None) -> dict:
    """신선한 recap → 마지막 메시지 첫 의미 있는 줄 → 낡은 recap 순으로 요약 선택."""
    recap = extract_recap(tail_lines)
    if recap is not None and is_recap_fresh(tail_lines):
        return {"text": recap, "source": "recap"}
    message = _first_meaningful_line(last_message)
    if message is not None:
        return {"text": message, "source": "lastMessage"}
    if recap is not None:
        return {"text": recap, "source": "recap"}
    return {"text": None, "source": None}


def parse_step_headings(markdown: str) -> list[int]:
    """`## Step N` 헤딩 번호를 문서 순서대로 중복 없이."""
    steps: list[int] = []
    for match in STEP_HEADING_RE.finditer(markdown):
        number = int(match.group(1))
        if number not in steps:
            steps.append(number)
    return steps


def parse_step_titles(markdown: str) -> dict[int, str]:
    """`## Step N <제목>` 헤딩 → {N: 제목}. 구분자(—·–·-·:) 제거, 같은 번호는 첫 헤딩 우선."""
    titles: dict[int, str] = {}
    for match in STEP_TITLE_RE.finditer(markdown):
        number = int(match.group(1))
        if number not in titles:
            titles[number] = match.group(2).lstrip(STEP_TITLE_SEPARATORS).strip()
    return titles


def _texts_newest_first(texts: list[str]) -> list[str]:
    return [text for text in reversed(texts) if text]


def detect_pipeline(texts: list[str], pipelines: dict[str, list[int]]) -> str | None:
    """최신 텍스트부터 언급된 등록 파이프라인 이름(없으면 키워드 매핑)."""
    newest_first = _texts_newest_first(texts)
    for text in newest_first:
        for name in reversed(PIPELINE_NAME_RE.findall(text)):
            if name in pipelines:
                return name
    for text in newest_first:
        for keyword, name in PIPELINE_KEYWORDS.items():
            if keyword in text and name in pipelines:
                return name
    return None


def _round_half_up_percent(index: int, total: int) -> int:
    return (2 * index * 100 + total) // (2 * total)


def _current_steps(text: str) -> list[int]:
    """예고 문장(`다음`·`이후`·`next` 포함)을 뺀 문장들의 `Step N` 번호 (등장 순)."""
    return [
        int(match.group(1))
        for sentence in SENTENCE_SPLIT_RE.split(text)
        if not STEP_FORECAST_RE.search(sentence)
        for match in STEP_MENTION_RE.finditer(sentence)
    ]


def _latest_step(texts: list[str]) -> int | None:
    for text in _texts_newest_first(texts):
        current = _current_steps(text)
        if current:
            return current[-1]
    return None


def _comment_progress(comment: str | None) -> dict | None:
    match = COMMENT_PROGRESS_RE.search(comment or "")
    if match is None or not 0 <= int(match.group(1)) <= 100:
        return None
    percent = int(match.group(1))
    return {"percent": percent, "basis": f"worktree 코멘트: 진행 {percent}%"}


def _completion_progress(agent_state: str | None, texts: list[str]) -> dict | None:
    if agent_state != "done":
        return None
    latest = next((text for text in _texts_newest_first(texts) if text.strip()), None)
    if latest is None or not COMPLETION_RE.search(latest):
        return None
    return {"percent": 100, "basis": "완료 보고"}


def _pipeline_position(texts: list[str], pipelines: dict[str, list[int]]) -> tuple[str, int] | None:
    """(파이프라인 이름, 현재 Step 의 단계 인덱스). 진행률 ③과 체크리스트가 같은 판정을 쓴다."""
    pipeline = detect_pipeline(texts, pipelines)
    step = _latest_step(texts)
    if pipeline is None or step is None or step not in pipelines[pipeline]:
        return None
    return pipeline, pipelines[pipeline].index(step)


def _pipeline_progress(texts: list[str], pipelines: dict[str, list[int]]) -> dict | None:
    position = _pipeline_position(texts, pipelines)
    if position is None:
        return None
    pipeline, index = position
    steps = pipelines[pipeline]
    step = steps[index]
    return {
        "percent": _round_half_up_percent(index, len(steps)),
        "basis": f"/{pipeline} Step {step} ({index + 1}/{len(steps)}단계 진행 중)",
    }


def estimate_progress(
    *,
    comment: str | None,
    agent_state: str | None,
    texts: list[str],
    pipelines: dict[str, list[int]],
) -> dict:
    """근거가 있을 때만 진행률. 근거가 없으면 percent None ('산정 불가')."""
    return (
        _comment_progress(comment)
        or _completion_progress(agent_state, texts)
        or _pipeline_progress(texts, pipelines)
        or {"percent": None, "basis": "산정 불가"}
    )


def _step_state(index: int, current_index: int, finished: bool) -> str:
    if finished or index < current_index:
        return "done"
    return "current" if index == current_index else "pending"


def pipeline_checklist(
    *,
    agent_state: str | None,
    texts: list[str],
    pipelines: dict[str, list[int]],
    step_titles: dict[str, dict[int, str]] | None = None,
) -> dict | None:
    """파이프라인 Step 체크리스트 (done/current/pending). 근거가 없으면 None."""
    position = _pipeline_position(texts, pipelines)
    if position is None:
        return None
    pipeline, current_index = position
    finished = _completion_progress(agent_state, texts) is not None
    titles = (step_titles or {}).get(pipeline) or {}
    return {
        "pipeline": pipeline,
        "steps": [
            {"number": number, "title": titles.get(number, ""), "state": _step_state(index, current_index, finished)}
            for index, number in enumerate(pipelines[pipeline])
        ],
    }


def _request_sentence(last_message: str | None) -> str | None:
    if not last_message:
        return None
    sentences = [part.strip() for part in SENTENCE_SPLIT_RE.split(last_message)]
    matches = [sentence for sentence in sentences if sentence and REQUEST_RE.search(sentence)]
    return matches[-1] if matches else None


def _error_line(tail_lines: list[str]) -> str | None:
    window = _non_empty(tail_lines)[-ERROR_WINDOW_LINES:]
    index = _last_index(window, lambda line: ERROR_LINE_RE.search(line) is not None)
    return None if index is None else window[index].strip()[:REASON_MAX_CHARS]


def _silent_ms(last_output_at: int | None, now_ms: int) -> int | None:
    return None if last_output_at is None else now_ms - last_output_at


def _background_shells(tail_lines: list[str]) -> int | None:
    index = _last_index(tail_lines, lambda line: line.strip().startswith("✻"))
    if index is None:
        return None
    match = SHELLS_RUNNING_RE.search(tail_lines[index])
    return int(match.group(1)) if match else None


def _status(status: str, reason: str) -> dict:
    return {"status": status, "reason": reason}


def classify_status(
    *,
    agent_state: str | None,
    main_state: str | None,
    last_message: str | None,
    tail_lines: list[str],
    last_output_at: int | None,
    now_ms: int,
    tail_error: str | None = None,
) -> dict:
    """세션 상태 판정 — blocked > waiting_user > stale > running > background > idle 근거 순.

    tail_error 가 있으면 화면 근거가 없으므로 waiting 계열 state 외에는 stale 로 둔다.
    """
    request = _request_sentence(last_message)
    if agent_state not in KNOWN_AGENT_STATES:
        return _status("waiting_user", request or f"에이전트 상태: {agent_state}")
    if tail_error is not None:
        return _status("stale", f"화면 읽기 실패 — 상태 판정 불가: {tail_error}")

    silent_ms = _silent_ms(last_output_at, now_ms)
    is_silent = silent_ms is not None and silent_ms >= STALE_AFTER_MS
    error_line = _error_line(tail_lines)
    if error_line and (agent_state != "working" or is_silent):
        return _status("blocked", error_line)

    if agent_state == "working":
        if is_silent:
            return _status("stale", f"작업 중인데 {silent_ms // 60_000}분째 출력 없음")
        if main_state == "done":
            return _status("background", "메인 응답 종료 — 서브에이전트·백그라운드 작업 진행 중")
        return _status("running", f"최근 실패 출력: {error_line}" if error_line else "작업 중")

    if request:
        return _status("waiting_user", request)
    shells = _background_shells(tail_lines)
    if shells is not None:
        return _status("background", f"백그라운드 셸 {shells}개 실행 중")
    return _status("idle", "응답 완료 — 다음 지시 대기")


# ── 스냅샷 조립 ─────────────────────────────────────────────────────────


def _normalize_branch(branch: str | None) -> str:
    name = (branch or "").removeprefix("refs/heads/")
    return name or "(detached)"


def _pull_request(linked: dict | None) -> dict | None:
    if not linked:
        return None
    return {"number": linked.get("number"), "state": linked.get("state")}


def _pane_key(terminal: dict) -> str:
    return f"{terminal.get('tabId')}:{terminal.get('leafId')}"


def _is_agent_title(title: str | None) -> bool:
    return bool(title) and title[0] in AGENT_TITLE_GLYPHS


def _texts_by_freshness(
    prompt_text: str | None, last_message: str | None, tail: list[str]
) -> list[str | None]:
    """판정 texts 를 오래된 것 → 최신 순으로. 신선한 recap 은 마지막 메시지보다 최신."""
    recap = extract_recap(tail)
    if recap is None:
        return [prompt_text, last_message]
    if is_recap_fresh(tail):
        return [prompt_text, last_message, recap]
    return [prompt_text, recap, last_message]


def _session(
    *,
    session_id: str,
    kind: str,
    name: str | None,
    worktree: dict,
    terminal: dict | None,
    tail: list[str],
    tail_error: str | None,
    agent_type: str | None,
    agent_state: str | None,
    main_state: str | None,
    tool_name: str | None,
    last_message: str | None,
    prompt_text: str | None,
    last_output_at: int | None,
    now_ms: int,
    pipelines: dict[str, list[int]],
    step_titles: dict[str, dict[int, str]] | None,
) -> dict:
    summary = summarize(tail, last_message)
    texts = _texts_by_freshness(prompt_text, last_message, tail)
    progress = estimate_progress(
        comment=worktree.get("comment"),
        agent_state=agent_state,
        texts=texts,
        pipelines=pipelines,
    )
    status = classify_status(
        agent_state=agent_state,
        main_state=main_state,
        last_message=last_message,
        tail_lines=tail,
        last_output_at=last_output_at,
        now_ms=now_ms,
        tail_error=tail_error,
    )
    return {
        "id": session_id,
        "kind": kind,
        "name": name,
        "worktreeId": worktree.get("worktreeId"),
        "repo": worktree.get("repo"),
        "branch": _normalize_branch(worktree.get("branch")),
        "path": worktree.get("path"),
        "terminalHandle": terminal.get("handle") if terminal else None,
        "agentType": agent_type,
        "agentState": agent_state,
        "mainState": main_state,
        "toolName": tool_name,
        "summary": summary,
        "progress": progress,
        "checklist": pipeline_checklist(
            agent_state=agent_state, texts=texts, pipelines=pipelines, step_titles=step_titles
        ),
        "status": status["status"],
        "reason": status["reason"],
        "lastOutputAt": last_output_at,
        "idleSeconds": None if last_output_at is None else (now_ms - last_output_at) // 1000,
        "pr": _pull_request(worktree.get("linkedPR")),
        "comment": worktree.get("comment"),
        "workspaceStatus": worktree.get("workspaceStatus"),
    }


def _agent_session(agent, worktree, terminal, tails, tail_errors, now_ms, pipelines, step_titles) -> dict:
    handle = terminal["handle"] if terminal else None
    tail = tails.get(handle, [])
    terminal_output_at = terminal.get("lastOutputAt") if terminal else None
    return _session(
        session_id=agent.get("paneKey"),
        kind="agent",
        name=clean_title(terminal.get("title") if terminal else None) or worktree.get("displayName"),
        worktree=worktree,
        terminal=terminal,
        tail=tail,
        tail_error=tail_errors.get(handle),
        agent_type=agent.get("agentType"),
        agent_state=agent.get("state"),
        main_state=(agent.get("mainAgent") or {}).get("state"),
        tool_name=agent.get("toolName"),
        last_message=agent.get("lastAssistantMessage"),
        prompt_text=agent.get("prompt"),
        last_output_at=terminal_output_at if terminal_output_at is not None else agent.get("updatedAt"),
        now_ms=now_ms,
        pipelines=pipelines,
        step_titles=step_titles,
    )


def _terminal_session(terminal, worktree, tails, tail_errors, now_ms, pipelines, step_titles) -> dict:
    tail = tails.get(terminal["handle"], [])
    return _session(
        session_id=terminal["handle"],
        kind="terminal",
        name=clean_title(terminal.get("title")),
        worktree=worktree,
        terminal=terminal,
        tail=tail,
        tail_error=tail_errors.get(terminal["handle"]),
        agent_type=None,
        agent_state="working" if is_tail_working(tail) else "done",
        main_state=None,
        tool_name=None,
        last_message=last_reply_from_tail(tail),
        prompt_text=terminal.get("title"),
        last_output_at=terminal.get("lastOutputAt"),
        now_ms=now_ms,
        pipelines=pipelines,
        step_titles=step_titles,
    )


def _sort_key(session: dict):
    last = session["lastOutputAt"]
    return (STATUS_ORDER.index(session["status"]), last is None, -(last or 0))


def _worktree_entry(worktree: dict) -> dict:
    return {
        "worktreeId": worktree.get("worktreeId"),
        "repo": worktree.get("repo"),
        "branch": _normalize_branch(worktree.get("branch")),
        "displayName": worktree.get("displayName"),
        "path": worktree.get("path"),
        "liveTerminalCount": worktree.get("liveTerminalCount") or 0,
        "pr": _pull_request(worktree.get("linkedPR")),
    }


def _kpi(sessions: list[dict]) -> dict:
    count = {status: 0 for status in STATUS_ORDER}
    for session in sessions:
        count[session["status"]] += 1
    return {
        "total": len(sessions),
        "running": count["running"] + count["background"],
        "waitingUser": count["waiting_user"],
        "blockedOrStale": count["blocked"] + count["stale"],
    }


def agent_terminal_handles(worktrees: list[dict], terminals: list[dict]) -> list[str]:
    """tail 이 필요한 터미널 — agent 와 조인되거나 제목이 에이전트 글리프인 것."""
    pane_keys = {
        agent.get("paneKey")
        for worktree in worktrees
        if not worktree.get("isArchived")
        for agent in worktree.get("agents") or []
    }
    return [
        terminal["handle"]
        for terminal in terminals
        if _pane_key(terminal) in pane_keys or _is_agent_title(terminal.get("title"))
    ]


def build_snapshot(
    worktrees: list[dict],
    terminals: list[dict],
    tails: dict[str, list[str]],
    *,
    now_ms: int,
    pipelines: dict[str, list[int]],
    tail_errors: dict[str, str] | None = None,
    step_titles: dict[str, dict[int, str]] | None = None,
) -> dict:
    """Orca worktree·terminal 원본을 세션 단위 스냅샷으로 조립.

    tail_errors = terminal read 에 실패한 handle → 오류 메시지 (세션 stale + warnings).
    step_titles = 파이프라인별 Step 제목 (체크리스트 제목, 없으면 빈 제목).
    """
    tail_errors = tail_errors or {}
    active = [worktree for worktree in worktrees if not worktree.get("isArchived")]
    terminals_by_pane = {_pane_key(terminal): terminal for terminal in terminals}
    joined_handles: set[str] = set()
    sessions_by_worktree: dict[str, list[dict]] = {worktree.get("worktreeId"): [] for worktree in active}

    for worktree in active:
        for agent in worktree.get("agents") or []:
            terminal = terminals_by_pane.get(agent.get("paneKey"))
            if terminal:
                joined_handles.add(terminal["handle"])
            sessions_by_worktree[worktree.get("worktreeId")].append(
                _agent_session(agent, worktree, terminal, tails, tail_errors, now_ms, pipelines, step_titles)
            )

    worktrees_by_id = {worktree.get("worktreeId"): worktree for worktree in active}
    for terminal in terminals:
        worktree = worktrees_by_id.get(terminal.get("worktreeId"))
        if worktree is None or terminal["handle"] in joined_handles:
            continue
        if _is_agent_title(terminal.get("title")):
            sessions_by_worktree[worktree.get("worktreeId")].append(
                _terminal_session(terminal, worktree, tails, tail_errors, now_ms, pipelines, step_titles)
            )

    sessions = sorted(
        (session for group in sessions_by_worktree.values() for session in group), key=_sort_key
    )
    sessionless = [worktree for worktree in active if not sessions_by_worktree[worktree.get("worktreeId")]]
    has_terminal = [(worktree.get("liveTerminalCount") or 0) > 0 for worktree in sessionless]
    return {
        "generatedAt": now_ms,
        "error": None,
        "warnings": [f"terminal read 실패 {handle}: {message}" for handle, message in tail_errors.items()],
        "kpi": _kpi(sessions),
        "sessions": sessions,
        "shellOnly": [_worktree_entry(w) for w, live in zip(sessionless, has_terminal) if live],
        "noTerminal": [_worktree_entry(w) for w, live in zip(sessionless, has_terminal) if not live],
    }


def error_snapshot(message: str, now_ms: int, warnings: list[str] | None = None) -> dict:
    return {
        "generatedAt": now_ms,
        "error": message,
        "warnings": list(warnings or []),
        "kpi": {"total": 0, "running": 0, "waitingUser": 0, "blockedOrStale": 0},
        "sessions": [],
        "shellOnly": [],
        "noTerminal": [],
    }


# ── Claude Code transcript · 세션 상세 (순수) ───────────────────────────


def transcript_dir(projects_root: str, cwd: str) -> str:
    """Claude Code 가 cwd 별 transcript 를 두는 디렉토리 (영숫자 외 문자 → `-`)."""
    return os.path.join(projects_root, TRANSCRIPT_DIR_UNSAFE_RE.sub("-", cwd))


def _iso_millis(timestamp) -> int | None:
    if not isinstance(timestamp, str):
        return None
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (moment - EPOCH) // timedelta(milliseconds=1)


def _content_texts(content) -> list[str]:
    """message.content(str 또는 블록 list) 의 텍스트 조각."""
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ]


def _content_blocks(content, block_type: str) -> list[dict]:
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict) and block.get("type") == block_type]


def _record_content(record: dict):
    message = record.get("message")
    return message.get("content") if isinstance(message, dict) else None


def _user_request_text(record: dict) -> str | None:
    """사용자 요청 텍스트 — task-notification·tool_result 전용 user 줄은 요청이 아니다."""
    if record.get("type") != "user":
        return None
    text = "\n".join(_content_texts(_record_content(record))).strip()
    if not text or text.startswith((TASK_NOTIFICATION_PREFIX, CONTINUATION_PREFIX)):
        return None
    return text


def _normalized(text: str | None) -> str:
    return " ".join((text or "").split())


def _texts_match(expected: str, actual: str | None, *, truncated: bool = False) -> bool:
    """정규화 후 전체 일치. expected 가 잘린 원문(truncated)일 때만 actual 이 그것으로 시작하면 일치."""
    actual = _normalized(actual)
    if not expected or not actual:
        return False
    return actual == expected or (truncated and actual.startswith(expected))


class TranscriptReadError(OSError):
    """일치하는 transcript 가 없고, 그 원인이 파일·디렉토리 읽기 실패일 수 있을 때."""


def _first_line(text, limit: int) -> str | None:
    for line in str(text or "").splitlines():
        if line.strip():
            return line.strip()[:limit]
    return None


def _task_from_tool_use(block: dict, started_at: int | None) -> dict | None:
    """Agent/Task 는 항상, Bash 는 run_in_background 일 때만 추적 대상."""
    name = block.get("name")
    tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
    background = bool(tool_input.get("run_in_background"))
    if name in AGENT_TOOL_NAMES:
        kind, fallback = "agent", tool_input.get("prompt")
    elif name == "Bash" and background:
        kind, fallback = "shell", tool_input.get("command")
    else:
        return None
    return {
        "id": block.get("id"),
        "kind": kind,
        "title": _first_line(tool_input.get("description"), TRANSCRIPT_TITLE_CHARS)
        or _first_line(fallback, TRANSCRIPT_TITLE_CHARS)
        or name,
        "agentType": tool_input.get("subagent_type") if kind == "agent" else None,
        "model": tool_input.get("model") if kind == "agent" else None,
        "background": background,
        "state": "running",
        "startedAt": started_at,
        "endedAt": None,
        "summary": None,
    }


def _notification_state(status: str, summary: str | None) -> str | None:
    if status in NOTIFICATION_FAILED_STATUSES:
        return "failed"
    if status != "completed":
        return None
    exit_code = NOTIFICATION_EXIT_CODE_RE.search(summary or "")
    return "failed" if exit_code and int(exit_code.group(1)) != 0 else "completed"


def _notifications(record: dict) -> list[dict]:
    """user 줄의 `<task-notification>` 블록 → [{id, state, summary}]."""
    found = []
    for text in _content_texts(_record_content(record)):
        for body in TASK_NOTIFICATION_RE.findall(text):
            fields = {
                field: (match.group(1).strip() if (match := pattern.search(body)) else None)
                for field, pattern in NOTIFICATION_FIELD_RE.items()
            }
            state = _notification_state((fields["status"] or "").lower(), fields["summary"])
            if fields["tool-use-id"] and state:
                found.append({"id": fields["tool-use-id"], "state": state, "summary": fields["summary"]})
    return found


def _finish_task(task: dict | None, state: str, ended_at: int | None, summary: str | None) -> None:
    if task is None or task["state"] != "running":
        return
    task.update(state=state, endedAt=ended_at, summary=summary)


def _apply_user_record(record: dict, at: int | None, tasks: dict[str, dict], prompts: list[dict]) -> None:
    content = _record_content(record)
    for result in _content_blocks(content, "tool_result"):
        task = tasks.get(result.get("tool_use_id"))
        is_error = result.get("is_error") is True
        # 백그라운드 작업의 즉시 tool_result 는 "시작됨" 신호 — 종료는 task-notification 으로만 (실행 오류 제외)
        if task is not None and (not task["background"] or is_error):
            summary = _first_line("\n".join(_content_texts(result.get("content"))), PROMPT_TEXT_CHARS)
            _finish_task(task, "failed" if is_error else "completed", at, summary)
    for notice in _notifications(record):
        _finish_task(tasks.get(notice["id"]), notice["state"], at, notice["summary"])
    request = _user_request_text(record)
    if request is not None:
        text = _first_meaningful_line(request) or _first_line(request, PROMPT_TEXT_CHARS) or ""
        prompts.append({"at": at, "text": text[:PROMPT_TEXT_CHARS]})


def _apply_assistant_record(
    record: dict, at: int | None, tasks: dict[str, dict], steps: list[dict]
) -> None:
    content = _record_content(record)
    for block in _content_blocks(content, "tool_use"):
        task = _task_from_tool_use(block, at)
        if task is not None and task["id"] and task["id"] not in tasks:
            tasks[task["id"]] = task
    text = "\n".join(_content_texts(content))
    current = _current_steps(text)
    if current and (not steps or steps[-1]["step"] != current[-1]):
        steps.append({"at": at, "step": current[-1]})


def parse_transcript(lines: Iterable[str]) -> dict:
    """transcript JSONL 줄 → prompts·tasks·steps·lastActivityAt. 깨진 줄은 건너뛴다 (줄 단위 스트리밍)."""
    prompts: list[dict] = []
    tasks: dict[str, dict] = {}
    steps: list[dict] = []
    last_activity_at = None
    for line in lines:
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(record, dict):
            continue
        at = _iso_millis(record.get("timestamp"))
        if at is not None:
            last_activity_at = at
        if record.get("type") == "user":
            _apply_user_record(record, at, tasks, prompts)
        elif record.get("type") == "assistant":
            _apply_assistant_record(record, at, tasks, steps)
    return {
        "prompts": prompts,
        "tasks": list(tasks.values()),
        "steps": steps,
        "lastActivityAt": last_activity_at,
    }


def _child_sort_key(task: dict):
    return (task["state"] != "running", -(task.get("startedAt") or 0))


def _timeline(transcript: dict) -> list[dict]:
    events = [{"at": prompt["at"], "kind": "prompt", "text": prompt["text"]} for prompt in transcript["prompts"]]
    events += [{"at": step["at"], "kind": "step", "text": f"Step {step['step']} 진입"} for step in transcript["steps"]]
    for task in transcript["tasks"]:
        events.append({"at": task["startedAt"], "kind": "task_start", "text": f"{task['title']} 시작"})
        if task["state"] != "running" and task["endedAt"] is not None:
            outcome = "완료" if task["state"] == "completed" else "실패"
            events.append({"at": task["endedAt"], "kind": "task_end", "text": f"{task['title']} {outcome}"})
    dated = sorted((event for event in events if event["at"] is not None), key=lambda event: event["at"])
    return dated[-TIMELINE_LIMIT:]


def _blockers(session: dict, tasks: list[dict]) -> list[dict]:
    blockers = []
    if session.get("status") in ATTENTION_STATUSES:
        blockers.append({"source": "session", "text": session.get("reason")})
    for task in tasks:
        if task["state"] == "failed":
            detail = f": {task['summary']}" if task.get("summary") else ""
            blockers.append({"source": "task", "text": f"{task['title']} 실패{detail}"})
    return blockers


def build_detail(session: dict, transcript: dict | None, *, now_ms: int) -> dict:
    """세션 상세 = 메인/자식 에이전트 트리 · 타임라인 · 블로킹 사유.

    now_ms 는 다른 순수 함수와 같은 주입 규약 — 경과 시간은 화면이 at 값으로 계산한다.
    """
    tasks = transcript["tasks"] if transcript is not None else []
    return {
        "session": session,
        "agents": {
            "main": {
                "name": session.get("name"),
                "agentType": session.get("agentType"),
                "state": session.get("mainState") or session.get("agentState"),
                "toolName": session.get("toolName"),
            },
            "children": sorted(tasks, key=_child_sort_key),
        },
        "timeline": _timeline(transcript) if transcript is not None else [],
        "blockers": _blockers(session, tasks),
        "transcript": transcript is not None,
    }


# ── 수집 (I/O) ──────────────────────────────────────────────────────────


def orca_command(env: Mapping[str, str]) -> list[str]:
    configured = (env.get("ORCA_CLI_COMMAND") or "").strip()
    return shlex.split(configured) if configured else ["orca"]


def run_orca(command: list[str], args: list[str], timeout: float = 15) -> dict:
    """Orca CLI 를 argv 로 실행(셸 미사용)하고 result 객체 반환."""
    argv = [*command, *args, "--json"]
    label = " ".join(args)
    try:
        process = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise OrcaError(f"Orca CLI 실행 파일 없음: {command[0] if command else '(빈 명령)'}") from None
    except subprocess.TimeoutExpired:
        raise OrcaError(f"orca {label} 타임아웃 ({timeout}초)") from None
    except (OSError, ValueError) as error:
        raise OrcaError(f"orca {label} 실행 실패 ({type(error).__name__}): {error}") from None
    if process.returncode != 0:
        detail = (process.stderr or process.stdout or "").strip()[-300:]
        raise OrcaError(f"orca {label} 실패 (exit {process.returncode}): {detail}")
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise OrcaError(f"orca {label} JSON 파싱 실패: {error}") from None
    if not isinstance(payload, dict) or not payload.get("ok"):
        detail = payload.get("error") if isinstance(payload, dict) else payload
        raise OrcaError(f"orca {label} ok=false: {detail}")
    result = payload.get("result") or {}
    if not isinstance(result, dict):
        raise OrcaError(f"orca {label} result 형식 오류: {type(result).__name__}")
    return result


def _skill_markdowns(skills_dir: str, warnings: list[str] | None) -> dict[str, str]:
    """skills/*/SKILL.md 원문. 읽기 실패한 파일은 건너뛰고 warnings 에 남긴다."""
    markdowns: dict[str, str] = {}
    if not os.path.isdir(skills_dir):
        return markdowns
    for name in sorted(os.listdir(skills_dir)):
        path = os.path.join(skills_dir, name, "SKILL.md")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                markdowns[name] = handle.read()
        except (OSError, UnicodeDecodeError) as error:
            if warnings is not None:
                warnings.append(f"SKILL.md 읽기 실패 {path}: {error}")
    return markdowns


def _pipelines_from(markdowns: dict[str, str]) -> dict[str, list[int]]:
    parsed = {name: parse_step_headings(markdown) for name, markdown in markdowns.items()}
    return {name: steps for name, steps in parsed.items() if steps}


def _step_titles_from(markdowns: dict[str, str]) -> dict[str, dict[int, str]]:
    parsed = {name: parse_step_titles(markdown) for name, markdown in markdowns.items()}
    return {name: titles for name, titles in parsed.items() if titles}


def load_pipelines(skills_dir: str, warnings: list[str] | None = None) -> dict[str, list[int]]:
    """skills/*/SKILL.md 중 `## Step` 헤딩이 있는 스킬 → 단계 번호 목록.

    읽기 실패한 SKILL.md 는 건너뛰고 warnings 에 남긴다 (정의 1개 실패가 전체를 막지 않음).
    """
    return _pipelines_from(_skill_markdowns(skills_dir, warnings))


def load_step_titles(skills_dir: str, warnings: list[str] | None = None) -> dict[str, dict[int, str]]:
    """skills/*/SKILL.md 중 `## Step` 헤딩이 있는 스킬 → {Step 번호: 제목}. 실패 내성은 load_pipelines 와 같다."""
    return _step_titles_from(_skill_markdowns(skills_dir, warnings))


def collect(
    command: list[str],
    skills_dir: str,
    now_ms: int,
    warnings: list[str] | None = None,
    prompts: dict[str, str] | None = None,
) -> dict:
    """스킬 정의 → worktree ps → terminal list → 에이전트 터미널 tail 읽기 → build_snapshot.

    warnings = 수집 중 경고를 누적할 list (실패 시 호출자가 실패 JSON 에 싣는다).
    prompts = 세션 id(paneKey) → (agent prompt, lastAssistantMessage) 를 채울 dict (상세 페이지 transcript 탐색용).
    """
    warnings = [] if warnings is None else warnings
    markdowns = _skill_markdowns(skills_dir, warnings)
    pipelines = _pipelines_from(markdowns)
    worktrees = run_orca(command, ["worktree", "ps"]).get("worktrees") or []
    terminals = run_orca(command, ["terminal", "list"]).get("terminals") or []
    tails: dict[str, list[str]] = {}
    tail_errors: dict[str, str] = {}
    for handle in agent_terminal_handles(worktrees, terminals):
        try:
            result = run_orca(command, ["terminal", "read", "--terminal", handle, "--limit", str(TAIL_LIMIT)])
        except OrcaError as error:
            tail_errors[handle] = str(error)
            continue
        tail = (result.get("terminal") or {}).get("tail") or []
        tails[handle] = [str(line) for line in tail] if isinstance(tail, list) else str(tail).splitlines()
    snapshot = build_snapshot(
        worktrees,
        terminals,
        tails,
        now_ms=now_ms,
        pipelines=pipelines,
        tail_errors=tail_errors,
        step_titles=_step_titles_from(markdowns),
    )
    if prompts is not None:
        prompts.update(agent_prompts(worktrees))
    return {**snapshot, "warnings": [*warnings, *snapshot["warnings"]]}


def agent_prompts(worktrees: list[dict]) -> dict[str, tuple[str | None, str | None]]:
    """아카이브 아닌 worktree 의 agent paneKey → (prompt, lastAssistantMessage) — transcript 매칭 키."""
    return {
        agent.get("paneKey"): (agent.get("prompt"), agent.get("lastAssistantMessage"))
        for worktree in worktrees
        if not worktree.get("isArchived")
        for agent in worktree.get("agents") or []
        if agent.get("paneKey") and (agent.get("prompt") or agent.get("lastAssistantMessage"))
    }


class _FileMemo:
    """(경로, mtime, size) 가 같으면 직전 계산 결과를 재사용 — 대용량 transcript 반복 파싱 회피."""

    def __init__(self, compute, max_entries: int = 4096):
        self._compute = compute
        self._max_entries = max_entries
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[tuple[int, int], object]] = {}

    def get(self, path: str, stat: os.stat_result):
        signature = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._entries.get(path)
        if cached is not None and cached[0] == signature:
            return cached[1]
        value = self._compute(path)
        with self._lock:
            if len(self._entries) >= self._max_entries:
                self._entries.clear()
            self._entries[path] = (signature, value)
        return value


def _read_match_texts(path: str) -> tuple[str | None, str | None]:
    """파일 안 (마지막 사용자 요청, 마지막 assistant 텍스트 블록) — user·assistant 줄만 JSON 파싱."""
    last_request = None
    last_reply = None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"user"' not in line and '"assistant"' not in line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            if record.get("type") == "user":
                last_request = _user_request_text(record) or last_request
            elif record.get("type") == "assistant":
                texts = [text for text in _content_texts(_record_content(record)) if text.strip()]
                last_reply = texts[-1] if texts else last_reply
    return last_request, last_reply


def _read_transcript(path: str) -> dict:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return parse_transcript(handle)


_MATCH_TEXTS = _FileMemo(_read_match_texts)
_TRANSCRIPTS = _FileMemo(_read_transcript, max_entries=64)


def find_transcript(
    directory: str, prompt: str | None, last_message: str | None = None, *, sole_session: bool = False
) -> str | None:
    """공백 정규화 후 전체 일치로 transcript 선택 (mtime 최신 우선).

    ① 마지막 사용자 요청 == prompt 인 파일 (Orca 가 prompt 를 ORCA_PROMPT_LIMIT 자에서 자르므로,
    원문이 그 길이 이상이면 요청이 prompt 로 시작해도 일치). 없으면 ② 마지막 assistant 텍스트 == last_message.
    Orca prompt 는 같은 pane 의 하위 codex 입력으로 덮일 수 있어 ② 를 대체 키로 쓴다.
    ①② 가 모두 없고 sole_session(그 경로의 세션이 하나뿐)이면 ③ 읽기 가능한 최신 파일.
    디렉토리 없음 → None. 일치가 없는데 읽기 실패가 있었으면 TranscriptReadError (기록 없음과 구분).
    """
    prompt_key = _normalized(prompt)
    prompt_truncated = len(prompt or "") >= ORCA_PROMPT_LIMIT
    reply_key = _normalized(last_message)
    if not prompt_key and not reply_key and not sole_session:
        return None
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise TranscriptReadError(f"transcript 디렉토리 읽기 실패 {directory}: {error}") from error
    failures: list[str] = []
    candidates = []
    for name in names:
        path = os.path.join(directory, name)
        try:
            stat = os.stat(path)
        except OSError as error:
            if name.endswith(".jsonl"):
                failures.append(f"{path}: {error}")
            continue
        if name.endswith(".jsonl"):
            candidates.append((stat.st_mtime_ns, path, stat))
    reply_match = None
    newest_readable = None
    for _, path, stat in sorted(candidates, key=lambda candidate: candidate[0], reverse=True):
        try:
            request, reply = _MATCH_TEXTS.get(path, stat)
        except (OSError, UnicodeDecodeError) as error:
            failures.append(f"{path}: {error}")
            continue
        if _texts_match(prompt_key, request, truncated=prompt_truncated):
            return path
        if reply_match is None and _texts_match(reply_key, reply):
            reply_match = path
        if newest_readable is None:
            newest_readable = path
    found = reply_match or (newest_readable if sole_session else None)
    if found is None and failures:
        raise TranscriptReadError(f"transcript 읽기 실패 {len(failures)}건 — " + "; ".join(failures[:3]))
    return found


def load_transcript(path: str) -> dict:
    """transcript 파싱 결과 ((경로, mtime, size) 캐시). 읽기 실패는 OSError 로 올린다."""
    return _TRANSCRIPTS.get(path, os.stat(path))


def claude_projects_root(env: Mapping[str, str]) -> str:
    configured = (env.get("CLAUDE_PROJECTS_DIR") or "").strip()
    return configured or os.path.join(os.path.expanduser("~"), ".claude", "projects")


def now_millis() -> int:
    return int(time.time() * 1000)


# ── serve ───────────────────────────────────────────────────────────────


class SnapshotStore:
    """직전 성공 스냅샷을 유지하고, 실패 시 error 만 덧씌운다."""

    def __init__(self, interval: float):
        self._interval = interval
        self._lock = threading.Lock()
        self._snapshot = error_snapshot("아직 수집 전", now_millis())
        self._prompts: dict[str, tuple[str | None, str | None]] = {}
        self._last_success_at: int | None = None

    def refresh(self, command: list[str]) -> None:
        """수집 1회. 어떤 예외든 error 로 노출하고 직전 성공 스냅샷을 유지한다."""
        now_ms = now_millis()
        prompts: dict[str, tuple[str | None, str | None]] = {}
        try:
            snapshot = collect(command, SKILLS_DIR, now_ms, prompts=prompts)
        except Exception as error:  # noqa: BLE001 — 수집 스레드는 어떤 실패로도 죽지 않는다
            with self._lock:
                self._snapshot = {**self._snapshot, "error": f"{type(error).__name__}: {error}"}
            return
        with self._lock:
            self._snapshot = snapshot
            self._prompts = prompts
            self._last_success_at = now_ms

    def payload(self) -> dict:
        with self._lock:
            return {**self._snapshot, "interval": self._interval, "lastSuccessAt": self._last_success_at}

    def session(self, session_id: str) -> tuple[dict, tuple[str | None, str | None], bool] | None:
        """최신 스냅샷의 세션, transcript 매칭 키 (prompt, lastAssistantMessage), 같은 path 의 유일 세션 여부.

        모르는 id 면 None.
        """
        with self._lock:
            sessions = self._snapshot["sessions"]
            for session in sessions:
                if session["id"] == session_id:
                    same_path = sum(1 for other in sessions if other.get("path") == session.get("path"))
                    return session, self._prompts.get(session_id, (None, None)), same_path == 1
        return None


def session_detail(
    session: dict,
    match_keys: tuple[str | None, str | None],
    projects_root: str,
    now_ms: int,
    *,
    sole_session: bool = False,
) -> dict:
    """세션 상세 응답. transcript 를 찾지 못하면 transcript false, 읽기 실패는 transcriptError 로 노출."""
    prompt, last_message = match_keys
    if not session.get("path") or not (prompt or last_message or sole_session):
        return build_detail(session, None, now_ms=now_ms)
    try:
        directory = transcript_dir(projects_root, session["path"])
        path = find_transcript(directory, prompt, last_message, sole_session=sole_session)
        transcript = load_transcript(path) if path is not None else None
    except (OSError, UnicodeDecodeError) as error:
        message = str(error) if isinstance(error, TranscriptReadError) else f"transcript 읽기 실패: {error}"
        return {**build_detail(session, None, now_ms=now_ms), "transcriptError": message}
    return build_detail(session, transcript, now_ms=now_ms)


def _poll_forever(store: SnapshotStore, command: list[str], interval: float) -> None:
    while True:
        time.sleep(interval)
        store.refresh(command)


def _handler_for(store: SnapshotStore, projects_root: str):
    class DashboardHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server 규약
            url = urlsplit(self.path)
            if url.path == "/":
                self._send(200, "text/html; charset=utf-8", PAGE_HTML.encode("utf-8"))
            elif url.path == "/api/snapshot":
                self._send_json(200, store.payload())
            elif url.path == "/api/session":
                self._session_detail(parse_qs(url.query).get("id", [""])[0])
            else:
                self._send(404, "text/plain; charset=utf-8", b"not found")

        def _session_detail(self, session_id: str) -> None:
            found = store.session(session_id)
            if found is None:
                self._send_json(404, {"error": f"세션 없음: {session_id or '(id 미지정)'}"})
                return
            session, match_keys, sole_session = found
            self._send_json(200, session_detail(session, match_keys, projects_root, now_millis(), sole_session=sole_session))

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send(status, "application/json; charset=utf-8", body)

        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002 — 접근 로그 생략
            return

    return DashboardHandler


# ── CLI ─────────────────────────────────────────────────────────────────


def usage() -> int:
    print("usage: " + (__doc__ or "").strip(), file=sys.stderr)
    return 2


def cmd_snapshot(args: list[str]) -> int:
    if args:
        return usage()
    now_ms = now_millis()
    warnings: list[str] = []
    try:
        snapshot = collect(orca_command(os.environ), SKILLS_DIR, now_ms, warnings)
    except OrcaError as error:
        print(json.dumps(error_snapshot(str(error), now_ms, warnings), ensure_ascii=False))
        return 1
    except Exception as error:  # noqa: BLE001 — snapshot 은 어떤 실패도 실패 JSON 으로 응답한다
        message = f"{type(error).__name__}: {error}"
        print(json.dumps(error_snapshot(message, now_ms, warnings), ensure_ascii=False))
        return 1
    print(json.dumps(snapshot, ensure_ascii=False))
    return 0


def _parse_serve_args(args: list[str]) -> tuple[int, float] | None:
    options = {"--port": "7788", "--interval": "3"}
    remaining = list(args)
    while remaining:
        flag = remaining.pop(0)
        if flag not in options or not remaining:
            return None
        options[flag] = remaining.pop(0)
    try:
        port, interval = int(options["--port"]), float(options["--interval"])
    except ValueError:
        return None
    if not 0 < port < 65536 or interval <= 0:
        return None
    return port, interval


def cmd_serve(args: list[str]) -> int:
    parsed = _parse_serve_args(args)
    if parsed is None:
        return usage()
    port, interval = parsed
    command = orca_command(os.environ)
    store = SnapshotStore(interval)
    store.refresh(command)
    threading.Thread(target=_poll_forever, args=(store, command, interval), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), _handler_for(store, claude_projects_root(os.environ)))
    server.daemon_threads = True
    print(f"orca-dashboard: http://127.0.0.1:{port}/ (interval {interval}s)", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


COMMANDS = {"snapshot": cmd_snapshot, "serve": cmd_serve}


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if not arguments or arguments[0] not in COMMANDS:
        return usage()
    return COMMANDS[arguments[0]](arguments[1:])


# ── 페이지 (인라인 HTML/CSS/JS, 외부 리소스 없음) ───────────────────────

PAGE_HTML = r"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orca 세션 대시보드</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f3f4f7; --surface: #ffffff; --surface-2: #f8f9fb; --border: #e2e5ea; --border-strong: #c9ced6;
  --text: #15181d; --muted: #5b6471; --faint: #8b94a1; --track: #e7eaee;
  --accent: #3366e0; --accent-soft: #e7eefd; --focus: #3366e0;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05), 0 1px 3px rgba(16, 24, 40, .07);
  --shadow-hover: 0 4px 12px rgba(16, 24, 40, .10), 0 2px 4px rgba(16, 24, 40, .06);
  --blocked-bg: #fde8e6; --blocked-fg: #b42318;
  --waiting-bg: #fff1df; --waiting-fg: #b54708;
  --stale-bg: #fcf4d6; --stale-fg: #8a6a00;
  --running-bg: #e2f5e9; --running-fg: #18794e;
  --background-bg: #e5edff; --background-fg: #1d4ed8;
  --idle-bg: #eceef1; --idle-fg: #4b5563;
  --banner-bg: #fde8e6; --banner-fg: #8f1d14; --banner-border: #f5b8b0;
  --step-done: #18794e; --step-done-bg: #e2f5e9;
  --step-current: #3366e0; --step-current-bg: #e7eefd;
  --step-pending: #a3abb6; --step-pending-bg: #f0f2f5;
  --task-running: #3366e0; --task-running-bg: #e7eefd;
  --task-completed: #18794e; --task-completed-bg: #e2f5e9;
  --task-failed: #c4321f; --task-failed-bg: #fde8e6;
  --tl-prompt: #7a4fd0; --tl-step: #3366e0; --tl-start: #0e7c86;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1014; --surface: #161a20; --surface-2: #1b2027; --border: #262c35; --border-strong: #3a424e;
    --text: #e7eaee; --muted: #9ba5b2; --faint: #6f7987; --track: #262c35;
    --accent: #7aa5ff; --accent-soft: #1a2846; --focus: #7aa5ff;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4);
    --shadow-hover: 0 6px 16px rgba(0, 0, 0, .5);
    --blocked-bg: #3a1715; --blocked-fg: #ff8a80;
    --waiting-bg: #3a2610; --waiting-fg: #ffb366;
    --stale-bg: #352d0c; --stale-fg: #f2d35b;
    --running-bg: #0f2f1e; --running-fg: #5fd394;
    --background-bg: #13254a; --background-fg: #8db4ff;
    --idle-bg: #252a32; --idle-fg: #b0b8c4;
    --banner-bg: #34161a; --banner-fg: #ffb4ab; --banner-border: #6b2a26;
    --step-done: #5fd394; --step-done-bg: #0f2f1e;
    --step-current: #7aa5ff; --step-current-bg: #1a2846;
    --step-pending: #5d6672; --step-pending-bg: #20252d;
    --task-running: #7aa5ff; --task-running-bg: #1a2846;
    --task-completed: #5fd394; --task-completed-bg: #0f2f1e;
    --task-failed: #ff8a80; --task-failed-bg: #3a1715;
    --tl-prompt: #b69cff; --tl-step: #7aa5ff; --tl-start: #5cc8d0;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif;
  padding: 24px 16px 48px; max-width: 1280px; margin: 0 auto; overflow-x: hidden; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
[hidden] { display: none !important; }
.muted { color: var(--muted); }
.page-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
h2 { font-size: 20px; margin: 0; letter-spacing: -.01em; overflow-wrap: anywhere; }
h3 { font-size: 13px; margin: 0; text-transform: none; color: var(--muted); font-weight: 600; letter-spacing: .02em; }
.banner { display: none; margin: 0 0 16px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--banner-border);
  background: var(--banner-bg); color: var(--banner-fg); overflow-wrap: anywhere; white-space: pre-wrap; }
.banner.show { display: block; }

/* ── 목록 ── */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 20px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
.kpi .label { color: var(--muted); font-size: 12px; }
.kpi .value { font-size: 26px; font-weight: 700; letter-spacing: -.02em; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 16px; }
.card { position: relative; display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px 16px 14px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
  cursor: pointer; overflow: hidden; transition: box-shadow .15s ease, transform .15s ease, border-color .15s ease; }
.card:hover { box-shadow: var(--shadow-hover); transform: translateY(-1px); border-color: var(--border-strong); }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: transparent; }
.card.blocked::before { background: var(--blocked-fg); }
.card.waiting_user::before { background: var(--waiting-fg); }
.card.stale::before { background: var(--stale-fg); }
.card-top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; }
.card-title { min-width: 0; }
.name { font-weight: 650; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.card .meta.repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex: none; display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 10px;
  font-size: 12px; font-weight: 600; white-space: nowrap; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.blocked { background: var(--blocked-bg); color: var(--blocked-fg); }
.badge.waiting_user { background: var(--waiting-bg); color: var(--waiting-fg); }
.badge.stale { background: var(--stale-bg); color: var(--stale-fg); }
.badge.running { background: var(--running-bg); color: var(--running-fg); }
.badge.background { background: var(--background-bg); color: var(--background-fg); }
.badge.idle { background: var(--idle-bg); color: var(--idle-fg); }
.summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  overflow-wrap: anywhere; color: var(--text); }
.summary.empty-summary { color: var(--faint); }
.reason { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; }
.reason.blocked { color: var(--blocked-fg); }
.reason.waiting_user { color: var(--waiting-fg); }
.reason.stale { color: var(--stale-fg); }
.card-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: 12px; color: var(--muted);
  border-top: 1px solid var(--border); padding-top: 10px; margin-top: auto; }

/* 진행률 링 */
.ring { display: block; flex: none; }
.ring .ring-track { stroke: var(--track); }
.ring .ring-value { stroke: var(--accent); transition: stroke-dasharray .4s ease; }
.ring.complete .ring-value { stroke: var(--step-done); }
.ring.unknown .ring-track { stroke-dasharray: 3 4; }
.ring text { fill: var(--text); font-weight: 700; }
.ring text.unknown { fill: var(--faint); }

/* 미니 스테퍼 (카드 checklist) */
.mini { display: flex; flex-direction: column; gap: 6px; }
.mini-track { display: flex; align-items: center; gap: 0; min-width: 0; }
.mini-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--step-pending); background: var(--surface); }
.mini-dot.done { background: var(--step-done); border-color: var(--step-done); }
.mini-dot.current { background: var(--step-current); border-color: var(--step-current); box-shadow: 0 0 0 3px var(--step-current-bg); }
.mini-line { flex: 1 1 auto; min-width: 4px; height: 2px; background: var(--step-pending-bg); }
.mini-line.done { background: var(--step-done); }
.checklist-counts { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--muted); }
.count-done { color: var(--step-done); font-weight: 600; }
.count-current { color: var(--step-current); font-weight: 600; }
.count-pending { color: var(--muted); }

details.group { margin-top: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 16px; }
details.group summary { cursor: pointer; font-weight: 600; }
details.group ul { margin: 8px 0 0; padding-left: 18px; }
details.group li { overflow-wrap: anywhere; }
.empty { grid-column: 1 / -1; padding: 40px 16px; text-align: center; color: var(--muted);
  border: 1px dashed var(--border-strong); border-radius: 14px; }

/* ── 상세 ── */
.back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px; padding: 6px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); cursor: pointer; box-shadow: var(--shadow); }
.back:hover { border-color: var(--border-strong); }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: var(--shadow); min-width: 0; }
.panel + .panel, .detail-grid { margin-top: 16px; }
.panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; margin-bottom: 14px; }
.detail-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px; align-items: center; }
.detail-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.detail-info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.basis { font-weight: 600; overflow-wrap: anywhere; }
.alert { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; margin-top: 16px; padding: 14px 16px;
  border-radius: 14px; border: 1px solid var(--banner-border); background: var(--banner-bg); color: var(--banner-fg); }
.alert-icon { font-size: 18px; line-height: 1.2; }
.alert-title { font-weight: 700; margin-bottom: 6px; }
.alert blockquote { margin: 6px 0 0; padding: 4px 0 4px 12px; border-left: 3px solid currentColor; overflow-wrap: anywhere; white-space: pre-wrap; }
.alert .source { display: block; font-size: 11px; font-weight: 700; opacity: .8; }
.note { padding: 12px 14px; border-radius: 10px; background: var(--surface-2); color: var(--muted); border: 1px dashed var(--border-strong); overflow-wrap: anywhere; }

/* Step 스테퍼 */
.stepper { list-style: none; margin: 0; padding: 0; display: flex; }
.step { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 0 4px; }
.step + .step::before { content: ""; position: absolute; top: 15px; right: 50%; width: 100%; height: 2px; background: var(--step-pending-bg); z-index: 0; }
.step.done::before, .step.current::before { background: var(--step-done) !important; }
.step-marker { position: relative; z-index: 1; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
  font-size: 13px; font-weight: 700; border: 2px solid var(--step-pending); background: var(--surface); color: var(--step-pending); }
.step.done .step-marker { background: var(--step-done); border-color: var(--step-done); color: var(--surface); }
.step.current .step-marker { background: var(--step-current); border-color: var(--step-current); color: var(--surface); animation: pulse-current 1.8s ease-out infinite; }
.step-num { font-size: 12px; font-weight: 700; color: var(--muted); }
.step.current .step-num { color: var(--step-current); }
.step.done .step-num { color: var(--step-done); }
.step-title { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.step.current .step-title { color: var(--text); font-weight: 600; }
@keyframes pulse-current { 0% { box-shadow: 0 0 0 0 var(--step-current-bg); } 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 1000px) { .detail-grid { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); } .detail-grid .panel + .panel { margin-top: 0; } }

/* 에이전트 트리 */
.tree-counts { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; }
.tree-counts .running { color: var(--task-running); font-weight: 600; }
.tree-counts .completed { color: var(--task-completed); font-weight: 600; }
.tree-counts .failed { color: var(--task-failed); font-weight: 600; }
.node { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px;
  border-radius: 12px; border: 1px solid var(--border); border-left: 3px solid var(--border-strong); background: var(--surface-2); min-width: 0; }
.node.running { border-left-color: var(--task-running); }
.node.completed { border-left-color: var(--task-completed); }
.node.failed { border-left-color: var(--task-failed); }
.node.running.live { animation: pulse-node 2.4s ease-in-out infinite; }
@keyframes pulse-node { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 4px var(--task-running-bg); } }
.node-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; font-size: 13px;
  background: var(--task-running-bg); color: var(--task-running); }
.node.completed .node-icon { background: var(--task-completed-bg); color: var(--task-completed); }
.node.failed .node-icon { background: var(--task-failed-bg); color: var(--task-failed); }
.node.idle .node-icon { background: var(--idle-bg); color: var(--idle-fg); }
.node-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; min-width: 0; }
.node-title { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.node-summary { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.state { flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.state.running { background: var(--task-running-bg); color: var(--task-running); }
.state.completed { background: var(--task-completed-bg); color: var(--task-completed); }
.state.failed { background: var(--task-failed-bg); color: var(--task-failed); }
.state.idle { background: var(--idle-bg); color: var(--idle-fg); }
.children { list-style: none; margin: 0 0 0 16px; padding: 0; }
.children > li { position: relative; padding: 12px 0 0 26px; }
.children > li::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 2px solid var(--border-strong); }
.children > li:last-child::before { bottom: auto; height: 34px; border-bottom-left-radius: 10px; }
.children > li::after { content: ""; position: absolute; left: 0; top: 34px; width: 24px; border-top: 2px solid var(--border-strong); }
.children > li:last-child::after { border-top: 0; height: 0; }
.children > li:last-child::before { border-bottom: 2px solid var(--border-strong); width: 24px; }
.children > li.more { color: var(--muted); font-size: 12px; padding-top: 10px; }

/* 타임라인 */
.timeline { list-style: none; margin: 0; padding: 0; }
.ev { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; padding-bottom: 14px; }
.ev::before { content: ""; position: absolute; left: 11px; top: 24px; bottom: 0; width: 2px; background: var(--border); }
.ev:last-child::before { display: none; }
.ev-dot { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700;
  color: var(--surface); background: var(--faint); }
.ev.ev-prompt .ev-dot { background: var(--tl-prompt); }
.ev.ev-step .ev-dot { background: var(--tl-step); }
.ev.ev-task_start .ev-dot { background: var(--tl-start); }
.ev.ev-task_end .ev-dot { background: var(--task-completed); }
.ev.ev-task_end.failed .ev-dot { background: var(--task-failed); }
.ev-body { min-width: 0; padding-top: 2px; }
.ev-text { overflow-wrap: anywhere; }
.ev.ev-prompt .ev-text { font-weight: 600; }
.ev-time { font-size: 12px; color: var(--faint); }

@media (max-width: 720px) {
  body { padding-top: 16px; }
  .detail-head { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .stepper { flex-direction: column; }
  .step { flex-direction: row; align-items: center; text-align: left; gap: 10px; padding: 0 0 14px; }
  .step + .step::before { display: none; }
  .step:not(:last-child)::after { content: ""; position: absolute; left: 15px; top: 32px; bottom: 0; width: 2px; background: var(--step-pending-bg); }
  .step.done:not(:last-child)::after { background: var(--step-done); }
  .step-text { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<header class="page-head">
  <h1>Orca 세션 대시보드</h1>
  <span id="updated" class="muted">불러오는 중…</span>
</header>
<div id="banner" class="banner" role="alert"></div>

<main id="list-view">
  <section class="kpis" aria-label="요약">
    <div class="kpi"><div class="label">전체</div><div class="value" id="kpi-total">-</div></div>
    <div class="kpi"><div class="label">실행 중</div><div class="value" id="kpi-running">-</div></div>
    <div class="kpi"><div class="label">사용자 대기</div><div class="value" id="kpi-waiting">-</div></div>
    <div class="kpi"><div class="label">막힘/정체</div><div class="value" id="kpi-blocked">-</div></div>
  </section>
  <section id="cards" class="cards" aria-label="세션"></section>
  <details id="shell-only" class="group"><summary id="shell-only-title">셸만 열린 worktree</summary><ul id="shell-only-list"></ul></details>
  <details id="no-terminal" class="group"><summary id="no-terminal-title">터미널 없는 worktree</summary><ul id="no-terminal-list"></ul></details>
</main>

<main id="detail-view" hidden>
  <button id="back" class="back" type="button">← 세션 목록</button>
  <div id="detail-body"></div>
</main>

<script>
"use strict";
const STATUS_LABEL = {blocked: "막힘", waiting_user: "사용자 대기", stale: "정체",
  running: "실행 중", background: "백그라운드", idle: "유휴"};
const ATTENTION = new Set(["blocked", "waiting_user", "stale"]);
const STEP_SYMBOL = {done: "✔", current: "▶", pending: "○"};
const STEP_STATE_LABEL = {done: "완료", current: "진행 중", pending: "남음"};
const TASK_STATE_LABEL = {running: "실행 중", completed: "완료", failed: "실패", idle: "대기"};
const EVENT_SYMBOL = {prompt: "❝", step: "⚑", task_start: "▸", task_end: "✔"};
const ENDED_CHILD_LIMIT = 20;
const SVG_NS = "http://www.w3.org/2000/svg";

let latest = null;
let latestKey = "";
let pollMs = 3000;
let fetchError = null;
let detail = null;
let detailKey = "";
let detailError = null;
let detailMissing = null;
let detailRequest = 0;
let openedFromList = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, String(value));
  return node;
}

function ago(ms) {
  if (ms === null || ms === undefined) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return seconds + "초 전";
  if (seconds < 3600) return Math.floor(seconds / 60) + "분 전";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "시간 " + Math.floor((seconds % 3600) / 60) + "분 전";
  return Math.floor(seconds / 86400) + "일 전";
}

function span(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + "초";
  if (seconds < 3600) return Math.floor(seconds / 60) + "분 " + (seconds % 60) + "초";
  return Math.floor(seconds / 3600) + "시간 " + Math.floor((seconds % 3600) / 60) + "분";
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString("ko-KR", {hour12: false});
}

function stamp(ms) {
  return new Date(ms).toLocaleString("ko-KR", {hour12: false});
}

/* data-ago(상대 시각)·data-since(경과 시간) 요소는 tick() 이 1초마다 갱신한다 */
function agoNode(tag, className, prefix, ms) {
  const node = el(tag, className);
  node.dataset.prefix = prefix || "";
  node.dataset.ago = ms === null || ms === undefined ? "" : String(ms);
  if (ms !== null && ms !== undefined) node.setAttribute("title", stamp(ms));
  node.textContent = node.dataset.prefix + (node.dataset.ago ? ago(ms) : "-");
  return node;
}

function sinceNode(prefix, ms) {
  const node = el("span", "since");
  node.dataset.prefix = prefix;
  node.dataset.since = String(ms);
  node.textContent = prefix + span(Date.now() - ms);
  return node;
}

function prText(pr) {
  return pr ? "PR #" + pr.number + " (" + pr.state + ")" : null;
}

function ring(progress, size, stroke) {
  const percent = progress && progress.percent !== null && progress.percent !== undefined
    ? Math.min(100, Math.max(0, progress.percent)) : null;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const root = svg("svg", {width: size, height: size, viewBox: "0 0 " + size + " " + size, role: "img",
    "aria-label": percent === null ? "진행률 산정 불가" : "진행률 " + percent + "%"});
  root.setAttribute("class", "ring" + (percent === null ? " unknown" : percent >= 100 ? " complete" : ""));
  root.appendChild(svg("circle", {class: "ring-track", cx: center, cy: center, r: radius, fill: "none", "stroke-width": stroke}));
  if (percent !== null) {
    root.appendChild(svg("circle", {class: "ring-value", cx: center, cy: center, r: radius, fill: "none",
      "stroke-width": stroke, "stroke-linecap": "round",
      "stroke-dasharray": (circumference * percent / 100) + " " + circumference,
      transform: "rotate(-90 " + center + " " + center + ")"}));
  }
  const label = svg("text", {x: center, y: center, "text-anchor": "middle", "dominant-baseline": "central",
    "font-size": Math.round(size * (percent === null ? 0.3 : 0.24))});
  if (percent === null) label.setAttribute("class", "unknown");
  label.textContent = percent === null ? "–" : percent + "%";
  root.appendChild(label);
  return root;
}

function checklistCounts(checklist) {
  const count = {done: 0, current: 0, pending: 0};
  for (const step of checklist.steps) count[step.state] += 1;
  const line = el("div", "checklist-counts");
  line.appendChild(el("span", "count-done", STEP_SYMBOL.done + " " + STEP_STATE_LABEL.done + " " + count.done));
  line.appendChild(el("span", "count-current", STEP_SYMBOL.current + " " + STEP_STATE_LABEL.current + " " + count.current));
  line.appendChild(el("span", "count-pending", STEP_SYMBOL.pending + " " + STEP_STATE_LABEL.pending + " " + count.pending));
  return line;
}

function stepLabel(step) {
  return "Step " + step.number + (step.title ? " " + step.title : "") + " — " + STEP_STATE_LABEL[step.state];
}

function miniChecklist(checklist) {
  const box = el("div", "mini checklist");
  const track = el("div", "mini-track");
  track.setAttribute("aria-label", "/" + checklist.pipeline + " 단계");
  checklist.steps.forEach((step, index) => {
    if (index > 0) track.appendChild(el("span", "mini-line" + (step.state !== "pending" ? " done" : "")));
    const dot = el("span", "mini-dot " + step.state);
    dot.setAttribute("title", stepLabel(step));
    track.appendChild(dot);
  });
  box.appendChild(track);
  box.appendChild(checklistCounts(checklist));
  return box;
}

function openSession(id) {
  openedFromList = true;
  location.hash = "#session=" + encodeURIComponent(id);
}

function card(session) {
  const node = el("article", "card " + session.status);
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  node.setAttribute("aria-label", (session.name || "이름 없음") + " — " + (STATUS_LABEL[session.status] || session.status) + ", 상세 보기");
  node.addEventListener("click", () => openSession(session.id));
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSession(session.id); }
  });

  const top = el("div", "card-top");
  top.appendChild(ring(session.progress, 48, 5));
  const title = el("div", "card-title");
  title.appendChild(el("div", "name", session.name || "(이름 없음)"));
  title.appendChild(el("div", "meta repo", [session.repo || "-", session.branch].join(" · ")));
  top.appendChild(title);
  top.appendChild(el("span", "badge " + session.status, STATUS_LABEL[session.status] || session.status));
  node.appendChild(top);

  const summaryText = session.summary && session.summary.text;
  node.appendChild(el("div", "summary" + (summaryText ? "" : " empty-summary"), summaryText || "요약 없음"));
  if (session.checklist) node.appendChild(miniChecklist(session.checklist));
  else if (session.progress && session.progress.basis && session.progress.percent !== null) {
    node.appendChild(el("div", "meta", session.progress.basis));
  }
  if (session.reason && (ATTENTION.has(session.status) || session.reason !== "작업 중")) {
    node.appendChild(el("div", "reason " + session.status, session.reason));
  }

  const foot = el("div", "card-foot");
  foot.appendChild(agoNode("span", null, "마지막 출력 ", session.lastOutputAt));
  const extra = [];
  if (session.agentType) extra.push(session.agentType);
  if (session.toolName) extra.push(session.toolName);
  if (prText(session.pr)) extra.push(prText(session.pr));
  if (session.kind === "terminal") extra.push("터미널 판정");
  if (extra.length) foot.appendChild(el("span", null, extra.join(" · ")));
  node.appendChild(foot);
  return node;
}

function renderWorktrees(listId, titleId, label, items) {
  const list = document.getElementById(listId);
  list.replaceChildren();
  document.getElementById(titleId).textContent = label + " (" + items.length + ")";
  for (const item of items) {
    const parts = [item.repo || "-", item.branch, item.displayName];
    if (item.liveTerminalCount) parts.push("터미널 " + item.liveTerminalCount + "개");
    if (prText(item.pr)) parts.push(prText(item.pr));
    list.appendChild(el("li", null, parts.filter(Boolean).join(" · ")));
  }
}

function renderBanner() {
  const banner = document.getElementById("banner");
  const messages = [];
  if (fetchError) messages.push("대시보드 서버 연결 실패: " + fetchError);
  if (detailError && routeId()) messages.push("세션 상세 조회 실패: " + detailError);
  if (latest && latest.error) {
    const since = latest.lastSuccessAt ? " — 직전 성공 " + clock(latest.lastSuccessAt) +
      " (" + ago(latest.lastSuccessAt) + ") 데이터 표시 중" : " — 성공한 수집 없음";
    messages.push("Orca 수집 실패: " + latest.error + since);
  }
  for (const warning of (latest && latest.warnings) || []) messages.push("경고: " + warning);
  banner.textContent = messages.join("\n");
  banner.classList.toggle("show", messages.length > 0);
}

function renderList() {
  if (!latest) return;
  document.getElementById("kpi-total").textContent = latest.kpi.total;
  document.getElementById("kpi-running").textContent = latest.kpi.running;
  document.getElementById("kpi-waiting").textContent = latest.kpi.waitingUser;
  document.getElementById("kpi-blocked").textContent = latest.kpi.blockedOrStale;
  const cards = document.getElementById("cards");
  cards.replaceChildren(...latest.sessions.map(card));
  if (!latest.sessions.length) cards.appendChild(el("div", "empty", "표시할 에이전트 세션이 없습니다"));
  renderWorktrees("shell-only-list", "shell-only-title", "셸만 열린 worktree", latest.shellOnly || []);
  renderWorktrees("no-terminal-list", "no-terminal-title", "터미널 없는 worktree", latest.noTerminal || []);
}

/* ── 상세 ── */

function panel(title, aside) {
  const section = el("section", "panel");
  const head = el("div", "panel-head");
  head.appendChild(el("h3", null, title));
  if (aside) head.appendChild(aside);
  section.appendChild(head);
  return section;
}

function detailHeader(session) {
  const section = el("section", "panel detail-head");
  section.appendChild(ring(session.progress, 112, 10));
  const info = el("div", "detail-info");
  const title = el("div", "detail-title");
  title.appendChild(el("h2", null, session.name || "(이름 없음)"));
  title.appendChild(el("span", "badge " + session.status, STATUS_LABEL[session.status] || session.status));
  info.appendChild(title);
  info.appendChild(el("div", "meta", [session.repo || "-", session.branch, session.path].filter(Boolean).join(" · ")));
  const agent = [];
  if (session.agentType) agent.push(session.agentType);
  agent.push("agent " + (session.agentState || "-"));
  if (session.mainState) agent.push("main " + session.mainState);
  if (session.toolName) agent.push("도구 " + session.toolName);
  if (prText(session.pr)) agent.push(prText(session.pr));
  info.appendChild(el("div", "meta", agent.join(" · ")));
  const progress = session.progress || {};
  info.appendChild(el("div", "basis", progress.percent === null || progress.percent === undefined
    ? "진행률 산정 불가" + (progress.basis && progress.basis !== "산정 불가" ? " — " + progress.basis : "")
    : progress.percent + "% — " + progress.basis));
  if (session.summary && session.summary.text) info.appendChild(el("div", "summary", session.summary.text));
  info.appendChild(agoNode("div", "meta", "마지막 출력 ", session.lastOutputAt));
  section.appendChild(info);
  return section;
}

function blockerAlert(blockers) {
  const box = el("section", "alert");
  box.setAttribute("role", "alert");
  box.appendChild(el("div", "alert-icon", "⚠"));
  const body = el("div");
  body.appendChild(el("div", "alert-title", "블로킹 " + blockers.length + "건"));
  for (const blocker of blockers) {
    const quote = el("blockquote");
    quote.appendChild(el("span", "source", blocker.source === "task" ? "작업 실패" : "세션 상태"));
    quote.appendChild(document.createTextNode(blocker.text || "(사유 없음)"));
    body.appendChild(quote);
  }
  box.appendChild(body);
  return box;
}

function stepperPanel(checklist) {
  if (!checklist) {
    const section = panel("진행 단계");
    section.appendChild(el("div", "note", "파이프라인 Step 근거 없음 — 체크리스트를 표시하지 않습니다"));
    return section;
  }
  const section = panel("진행 단계 · /" + checklist.pipeline, checklistCounts(checklist));
  const list = el("ol", "stepper checklist");
  for (const step of checklist.steps) {
    const item = el("li", "step " + step.state);
    item.setAttribute("title", stepLabel(step));
    if (step.state === "current") item.setAttribute("aria-current", "step");
    item.appendChild(el("span", "step-marker", STEP_SYMBOL[step.state]));
    const text = el("div", "step-text");
    text.appendChild(el("div", "step-num", "Step " + step.number));
    if (step.title) text.appendChild(el("div", "step-title", step.title));
    item.appendChild(text);
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function mainState(agentState) {
  if (agentState === "working") return "running";
  if (agentState === "done") return "completed";
  return "idle";
}

function treeNode(options) {
  const node = el("div", "node " + options.state + (options.live ? " live" : ""));
  node.appendChild(el("div", "node-icon", options.icon));
  const body = el("div");
  const head = el("div", "node-head");
  head.appendChild(el("span", "node-title", options.title));
  head.appendChild(el("span", "state " + options.state, TASK_STATE_LABEL[options.state] || options.state));
  body.appendChild(head);
  const meta = el("div", "meta");
  meta.appendChild(document.createTextNode(options.meta.filter(Boolean).join(" · ")));
  if (options.timing) {
    if (options.meta.some(Boolean)) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(options.timing);
  }
  body.appendChild(meta);
  if (options.summary) body.appendChild(el("div", "node-summary", options.summary));
  node.appendChild(body);
  return node;
}

function taskTiming(task) {
  if (task.state === "running" && task.startedAt) return sinceNode("실행 ", task.startedAt);
  if (task.startedAt && task.endedAt) {
    const node = el("span", null, "소요 " + span(task.endedAt - task.startedAt));
    node.setAttribute("title", stamp(task.startedAt) + " → " + stamp(task.endedAt));
    return node;
  }
  return null;
}

function agentTreePanel(payload) {
  const children = payload.agents.children;
  const count = {running: 0, completed: 0, failed: 0};
  for (const child of children) count[child.state] = (count[child.state] || 0) + 1;
  const counts = el("div", "tree-counts");
  counts.appendChild(el("span", "running", "실행 중 " + count.running));
  counts.appendChild(el("span", "completed", "완료 " + count.completed));
  counts.appendChild(el("span", "failed", "실패 " + count.failed));
  const section = panel("에이전트", payload.transcript ? counts : null);

  const main = payload.agents.main;
  const state = mainState(main.state);
  const tree = el("div", "tree");
  tree.appendChild(treeNode({icon: "◉", state: state, live: state === "running", title: main.name || "메인 에이전트",
    meta: ["메인", main.agentType, main.toolName ? "도구 " + main.toolName : null], timing: null, summary: null}));
  if (!payload.transcript) {
    section.appendChild(tree);
    const note = el("div", "note", payload.transcriptError
      ? payload.transcriptError
      : "transcript 없음 (codex 등) — 서브에이전트·백그라운드 작업을 표시할 수 없습니다");
    note.style.marginTop = "12px";
    section.appendChild(note);
    return section;
  }
  const list = el("ul", "children");
  const running = children.filter((child) => child.state === "running");
  const ended = children.filter((child) => child.state !== "running");
  for (const child of [...running, ...ended.slice(0, ENDED_CHILD_LIMIT)]) {
    const item = el("li");
    item.appendChild(treeNode({
      icon: child.kind === "shell" ? "›_" : "✦",
      state: child.state,
      live: child.state === "running",
      title: child.title,
      meta: [child.kind === "shell" ? "셸" : child.agentType || "agent", child.model,
        child.background ? "백그라운드" : "포그라운드"],
      timing: taskTiming(child),
      summary: child.summary,
    }));
    list.appendChild(item);
  }
  if (ended.length > ENDED_CHILD_LIMIT) list.appendChild(el("li", "more", "이전 완료·실패 작업 " + (ended.length - ENDED_CHILD_LIMIT) + "개 생략"));
  if (!children.length) list.appendChild(el("li", "more", "서브에이전트·백그라운드 작업 없음"));
  tree.appendChild(list);
  section.appendChild(tree);
  return section;
}

function timelinePanel(payload) {
  const section = panel("타임라인 · 최신순");
  if (!payload.transcript) {
    section.appendChild(el("div", "note", "transcript 없음 (codex 등) — 작업 타임라인을 표시할 수 없습니다"));
    return section;
  }
  if (!payload.timeline.length) {
    section.appendChild(el("div", "note", "기록된 이벤트 없음"));
    return section;
  }
  const list = el("ol", "timeline");
  for (const event of [...payload.timeline].reverse()) {
    const failed = event.kind === "task_end" && / 실패$/.test(event.text);
    const item = el("li", "ev ev-" + event.kind + (failed ? " failed" : ""));
    item.appendChild(el("span", "ev-dot", failed ? "✕" : EVENT_SYMBOL[event.kind] || "•"));
    const body = el("div", "ev-body");
    body.appendChild(el("div", "ev-text", event.text));
    body.appendChild(agoNode("div", "ev-time", "", event.at));
    item.appendChild(body);
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function renderDetail() {
  const root = document.getElementById("detail-body");
  if (detailMissing) {
    root.replaceChildren(el("div", "note", detailMissing));
    return;
  }
  if (!detail) {
    root.replaceChildren(el("div", "note", "세션 상세 불러오는 중…"));
    return;
  }
  const parts = [detailHeader(detail.session)];
  if (detail.blockers.length) parts.push(blockerAlert(detail.blockers));
  const steps = stepperPanel(detail.session.checklist);
  steps.style.marginTop = "16px";
  parts.push(steps);
  const grid = el("div", "detail-grid");
  grid.appendChild(agentTreePanel(detail));
  grid.appendChild(timelinePanel(detail));
  parts.push(grid);
  root.replaceChildren(...parts);
  document.title = (detail.session.name || "세션") + " — Orca 세션 대시보드";
}

/* ── 라우팅 · 폴링 ── */

function routeId() {
  const match = /^#session=(.+)$/.exec(location.hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (error) { return null; }
}

function onRoute() {
  const id = routeId();
  document.getElementById("list-view").hidden = Boolean(id);
  document.getElementById("detail-view").hidden = !id;
  detail = null; detailKey = ""; detailMissing = null; detailError = null;
  detailRequest += 1;
  if (id) {
    renderDetail();
    window.scrollTo(0, 0);
    loadDetail(id);
  } else {
    document.title = "Orca 세션 대시보드";
    latestKey = "";
    renderList();
    tick();
  }
  renderBanner();
}

function goBack() {
  if (openedFromList && history.length > 1) history.back();
  else location.hash = "";
}

async function loadDetail(id) {
  // 응답 수신·본문 파싱 뒤에도 이 요청이 최신이고 라우트가 그대로일 때만 반영 (늦게 온 이전 응답은 버림)
  const request = ++detailRequest;
  const stale = () => request !== detailRequest || routeId() !== id;
  try {
    const response = await fetch("/api/session?id=" + encodeURIComponent(id), {cache: "no-store"});
    if (stale()) return;
    if (response.status === 404) {
      const payload = await response.json().catch(() => ({}));
      if (stale()) return;
      detail = null; detailKey = ""; detailError = null;
      detailMissing = "세션을 찾을 수 없습니다 — 종료됐거나 목록에서 사라졌을 수 있습니다" + (payload.error ? " (" + payload.error + ")" : "");
      renderDetail();
      return;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    if (stale()) return;
    detailError = null; detailMissing = null;
    if (text !== detailKey) {
      detailKey = text;
      detail = JSON.parse(text);
      renderDetail();
    }
  } catch (error) {
    if (stale()) return;
    detailError = String(error && error.message ? error.message : error);
  }
  tick();
}

async function poll() {
  try {
    const response = await fetch("/api/snapshot", {cache: "no-store"});
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    latest = JSON.parse(text);
    fetchError = null;
    if (latest.interval) pollMs = Math.max(500, latest.interval * 1000);
    const key = JSON.stringify([latest.sessions, latest.shellOnly, latest.noTerminal, latest.kpi]);
    if (!routeId() && key !== latestKey) { latestKey = key; renderList(); }
    const id = routeId();
    if (id) await loadDetail(id);
  } catch (error) {
    fetchError = String(error && error.message ? error.message : error);
  } finally {
    renderBanner();
    tick();
    setTimeout(poll, pollMs);
  }
}

function tick() {
  if (latest) {
    const base = latest.lastSuccessAt || latest.generatedAt;
    document.getElementById("updated").textContent = "갱신 " + ago(base);
  }
  for (const node of document.querySelectorAll("[data-ago]")) {
    node.textContent = node.dataset.prefix + (node.dataset.ago ? ago(Number(node.dataset.ago)) : "-");
  }
  for (const node of document.querySelectorAll("[data-since]")) {
    node.textContent = node.dataset.prefix + span(Date.now() - Number(node.dataset.since));
  }
}

document.getElementById("back").addEventListener("click", goBack);
window.addEventListener("hashchange", onRoute);
setInterval(tick, 1000);
onRoute();
poll();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main())
