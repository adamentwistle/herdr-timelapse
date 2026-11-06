"""Reads one Claude Code transcript into what a replay needs, for reading only. Used by helper.py.

What comes out is tool names, times, file base names, a folder's name, and when an agent was waiting or blocked. Prompts,
replies, tool results and commands aren't kept. Most lines aren't even parsed: a line's kind and time are found in its
bytes, and only lines holding a tool call go through json, so a tool's input is read for its file path and nothing else.

Quoted keys found in the bytes can be trusted: a tool result's text is a JSON string, so a quote inside it is escaped, and
"tool_use" with bare quotes can't come from what a tool printed.

Everything in these files is data. Nothing here acts on it.
"""
import calendar
import hashlib
import json
import os
import re
import time

SPLIT_MS = 6 * 3600000   # silence this long in a session starts a new span, so a session resumed days later isn't one long run
WAIT_MS = 30000          # a person's next prompt after this long means the agent was waiting for them
QUIET_MS = 10 * 60000    # this long with nothing open and nothing written reads as waiting too
BLOCK_MS = 30000         # a quick tool held open this long means someone was being asked
NAME_LIMIT = 64
ASK_TOOLS = {"AskUserQuestion", "ExitPlanMode"}
QUICK_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"}
FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"}

TIMESTAMP = b'"timestamp":"'
FRACTION = re.compile(rb"\.(\d{1,3})")
RESULT_ID = re.compile(rb'"tool_use_id"\s*:\s*"([^"]+)"')
CWD = re.compile(rb'"cwd"\s*:\s*("(?:[^"\\]|\\.)*")')
SESSION = re.compile(rb'"sessionId"\s*:\s*"([0-9A-Za-z-]+)"')
SEPARATORS = re.compile(r"[\\/]+")
PLAIN_NAME = re.compile(r"^[\w .:+-]{1,40}$")
CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f]+")

_seconds = {}


def to_ms(raw):
    """Epoch ms from b"2026-11-06T02:14:00.123Z", or None. Whole seconds repeat a lot in a transcript, so they're kept."""
    head = raw[:19]
    base = _seconds.get(head)
    if base is None:
        try:
            base = calendar.timegm(time.strptime(head.decode("ascii"), "%Y-%m-%dT%H:%M:%S"))
        except (ValueError, UnicodeDecodeError):
            return None
        _seconds[head] = base
    fraction = FRACTION.match(raw, 19)
    return base * 1000 + (int(fraction.group(1).ljust(3, b"0")) if fraction else 0)


def time_of(line):
    at = line.find(TIMESTAMP)
    if at < 0:
        return None
    start = at + len(TIMESTAMP)
    return to_ms(line[start:line.find(b'"', start, start + 40)])


def parts_of(path):
    return [p for p in SEPARATORS.split(path.rstrip("\\/")) if p]


def base_name(path):
    """The last part of a path, on either kind of separator, with control characters gone and cut to size."""
    parts = parts_of(path)
    return CONTROL.sub("", parts[-1])[:NAME_LIMIT] if parts else ""


def short_hash(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:12]


def folder_of(cwd):
    """(the folder it counts as, a key for that folder, its own name, a repo name if it's a worktree to match up later).

    A checkout at <repo>/.claude/worktrees/<name> counts as <repo>. One at ~/.herdr/worktrees/<repo>/<name> doesn't say
    where the repo is, so helper.py joins it to a folder of that name if there's exactly one."""
    parts = parts_of(cwd)
    if not parts:
        return "unknown", short_hash(""), "unknown", None
    own = base_name(cwd)
    for i, part in enumerate(parts):
        if part != "worktrees" or i == 0:
            continue
        if parts[i - 1] == ".claude" and i >= 2:
            return parts[i - 2][:NAME_LIMIT], short_hash("/".join(parts[:i - 1])), own, None
        if parts[i - 1] == ".herdr" and len(parts) > i + 1:
            return parts[i + 1][:NAME_LIMIT], short_hash("worktrees/" + parts[i + 1]), own, parts[i + 1]
    return own, short_hash("/".join(parts)), own, None


def clean_tool(name):
    if not isinstance(name, str):
        return "Tool"
    short = name.split("__")[-1]
    return short if PLAIN_NAME.match(short) else "Tool"


def file_of(name, given):
    """The full path a call worked on, or None. Only a file tool's own path key counts: nothing else in its input is read."""
    if name not in FILE_TOOLS or not isinstance(given, dict):
        return None
    for key in ("file_path", "notebook_path"):
        if isinstance(given.get(key), str) and given[key]:
            return given[key]
    return None


def parent_of(path):
    """The session a file under <session>/subagents/ belongs to, or None."""
    head, tail = os.path.split(path)
    while tail:
        head, tail = os.path.split(head)
        if tail == "subagents":
            return os.path.basename(head)
    return None


def agent_type(path):
    """A subagent's kind from the meta file beside it, such as Explore. Never its description, which was written for it."""
    try:
        with open(path[:-len(".jsonl")] + ".meta.json", encoding="utf-8", errors="replace") as f:
            kind = json.load(f).get("agentType")
    except (OSError, ValueError, AttributeError):
        return None
    return kind if isinstance(kind, str) and PLAIN_NAME.match(kind) else None


class Reader:
    """One pass over a transcript's lines."""

    def __init__(self):
        self.calls, self.marks, self.files = [], [], {}
        self.open = {}
        self.last = self.first = None
        self.spans = []
        self.cwd = self.session = None

    def note_time(self, at):
        """Called for every record. Keeps the spans, and says how long the silence before this one was."""
        silence = 0
        if self.last is None:
            self.first = at
            self.spans.append([at, at, 0])
        else:
            silence = at - self.last
            if silence >= SPLIT_MS:
                self.spans.append([at, at, 0])
            self.spans[-1][1] = max(self.spans[-1][1], at)
        self.last = at if self.last is None else max(self.last, at)
        return silence

    def tool_line(self, line, at):
        try:
            row = json.loads(line)
            content = row["message"]["content"]
        except (ValueError, KeyError, TypeError):
            return
        if not isinstance(content, list):
            return
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "tool_use":
                continue
            raw = part.get("name")
            tool = clean_tool(raw)
            path = file_of(raw, part.get("input"))
            index = -1
            if path is not None:
                digest = short_hash(path)
                index = self.files.setdefault(digest, [len(self.files), base_name(path)])[0]
            self.calls.append([at, tool, index])
            self.spans[-1][2] += 1
            self.open[part.get("id")] = (at, raw)

    def result_line(self, line, at):
        for found in RESULT_ID.findall(line):
            opened = self.open.pop(found.decode("ascii", "replace"), None)
            if not opened:
                continue
            start, tool = opened
            if tool in ASK_TOOLS or (tool in QUICK_TOOLS and at - start >= BLOCK_MS):
                self.marks.append([start, at, "b"])

    def read(self, f):
        for line in f:
            is_assistant = b'"type":"assistant"' in line
            is_result = not is_assistant and b'"tool_result"' in line
            is_user = not is_assistant and not is_result and b'"type":"user"' in line
            if not (is_assistant or is_result or is_user):
                continue
            at = time_of(line)
            if at is None:
                continue
            if self.cwd is None:
                found = CWD.search(line)
                if found:
                    try:
                        self.cwd = json.loads(found.group(1))
                    except ValueError:
                        pass
            if self.session is None:
                found = SESSION.search(line)
                if found:
                    self.session = found.group(1).decode("ascii")
            before = self.last
            silence = self.note_time(at)
            if is_user and b'"isMeta":true' in line:
                continue
            if is_user:
                if not self.open and before is not None and silence >= WAIT_MS:
                    self.marks.append([before, at, "w"])
                self.open.clear()
                continue
            if not self.open and before is not None and silence >= QUIET_MS:
                self.marks.append([before, at, "w"])
            if is_result:
                self.result_line(line, at)
            elif b'"tool_use"' in line:
                self.tool_line(line, at)


def read_transcript(path):
    """A summary and a body for one file, or None if it holds no timed records.

    The summary is small and says what a run list needs. The body is the calls and marks a replay needs."""
    reader = Reader()
    with open(path, "rb") as f:
        reader.read(f)
    if reader.first is None:
        return None
    stem = os.path.basename(path)[:-len(".jsonl")]
    parent = parent_of(path)
    if parent is None and stem.startswith("agent-"):
        parent = reader.session
    folder, key, own, repo = folder_of(reader.cwd or "")
    summary = {
        "session": parent or stem, "sub": bool(parent), "kind": agent_type(path) if parent else None,
        "folder": folder, "key": key, "own": own, "repo": repo,
        "first": reader.first, "last": reader.last, "spans": reader.spans,
    }
    files = sorted(reader.files.items(), key=lambda item: item[1][0])
    body = {"calls": reader.calls, "marks": sorted(reader.marks), "files": [[digest, value[1]] for digest, value in files]}
    return summary, body
