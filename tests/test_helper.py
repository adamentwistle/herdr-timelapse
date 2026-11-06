#!/usr/bin/env python3
"""Checks for helper.py, transcripts.py and the exported page, on hand-made transcripts only.

  python tests/test_helper.py
"""
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOD = os.path.join(ROOT, "mods", "timelapse")
sys.path.insert(0, MOD)
import helper  # noqa: E402
import sample  # noqa: E402
import transcripts  # noqa: E402

BASE = 1793916000000  # 2026-11-06, in ms
MIN = 60000
HOUR = 60 * MIN
SECRETS = ["SECRET-PROMPT", "SECRET-REPLY", "SECRET-RESULT", "SECRET-CONTENT", "SECRET-COMMAND", "SECRET-DESCRIPTION", "SECRET-PATTERN",
           "SECRET-SUMMARY", "secretfolder"]


def stamp(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms // 1000)) + ".%03dZ" % (ms % 1000)


def record(kind, at, session, cwd, message, **more):
    return dict({"parentUuid": None, "isSidechain": False, "userType": "external", "cwd": cwd, "sessionId": session, "version": "2.1.0",
                 "gitBranch": "main", "type": kind, "message": message, "uuid": "u", "timestamp": stamp(at)}, **more)


class Log:
    """Writes a transcript the way Claude Code lays one out."""

    def __init__(self, session="s1", cwd="/work/lantern"):
        self.session, self.cwd, self.lines, self.count = session, cwd, [], 0

    def raw(self, text):
        self.lines.append(text)
        return self

    def prompt(self, at, text="SECRET-PROMPT do the thing", **more):
        self.lines.append(json.dumps(record("user", at, self.session, self.cwd, {"role": "user", "content": text}, **more), separators=(",", ":")))
        return self

    def reply(self, at, text="SECRET-REPLY all done"):
        message = {"role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": None}
        self.lines.append(json.dumps(record("assistant", at, self.session, self.cwd, message), separators=(",", ":")))
        return self

    def call(self, at, name, given=None):
        self.count += 1
        call_id = "toolu_%s_%d" % (self.session, self.count)
        message = {"role": "assistant", "content": [{"type": "tool_use", "id": call_id, "name": name, "input": given or {}}], "stop_reason": "tool_use"}
        self.lines.append(json.dumps(record("assistant", at, self.session, self.cwd, message), separators=(",", ":")))
        return call_id

    def result(self, at, call_id, text="SECRET-RESULT output"):
        message = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": text}]}
        self.lines.append(json.dumps(record("user", at, self.session, self.cwd, message, toolUseResult={"stdout": text}), separators=(",", ":")))
        return self

    def tool(self, at, name, given=None, took=1000):
        return self.result(at + took, self.call(at, name, given))

    def write(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(self.lines) + "\n")
        return path


class Folder(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="timelapse-test-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.root = os.path.join(self.home, "projects")
        self.cache = os.path.join(self.home, "cache")

    def path(self, session, project="-work-lantern"):
        return os.path.join(self.root, project, session + ".jsonl")

    def scan(self, **more):
        args = mock.Mock(demo=False, projects=[self.root], cache=more.get("cache", self.cache), budget=more.get("budget", 99))
        return helper.scan(args)

    def run_args(self, ids, start, end, **more):
        args = mock.Mock(demo=False, projects=[self.root], cache=self.cache, budget=99, ids=",".join(ids), to=end, out=more.get("out"), colours=more.get("colours"))
        setattr(args, "from", start)
        return args


class Reading(Folder):
    def read(self, log):
        return transcripts.read_transcript(log.write(self.path("s1")))

    def test_calls_keep_only_tool_time_and_base_name(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Read", {"file_path": "/work/secretfolder/lamp.ts"})
        log.tool(BASE + 3000, "Bash", {"command": "SECRET-COMMAND"})
        log.tool(BASE + 5000, "mcp__tracker__list_tickets", {"query": "SECRET-PROMPT"})
        _summary, body = self.read(log)
        self.assertEqual([c[1] for c in body["calls"]], ["Read", "Bash", "list_tickets"])
        self.assertEqual(body["calls"][0][0], BASE + 1000)
        self.assertEqual([f[1] for f in body["files"]], ["lamp.ts"])
        self.assertNotIn("SECRET", json.dumps(body))
        self.assertNotIn("secretfolder", json.dumps(body))

    def test_only_a_file_tools_own_path_counts(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Grep", {"pattern": "SECRET-PATTERN", "path": "/work/lamp.ts"})
        log.tool(BASE + 3000, "Write", {"file_path": "C:\\work\\notes.md", "content": "SECRET-CONTENT"})
        log.tool(BASE + 5000, "NotebookEdit", {"notebook_path": "/work/plot.ipynb"})
        _summary, body = self.read(log)
        self.assertEqual([f[1] for f in body["files"]], ["notes.md", "plot.ipynb"])
        self.assertEqual(body["calls"][0][2], -1)

    def test_a_late_prompt_means_the_agent_was_waiting(self):
        log = Log().prompt(BASE).reply(BASE + 10000).prompt(BASE + 5 * MIN).reply(BASE + 5 * MIN + 1000)
        _summary, body = self.read(log)
        self.assertEqual(body["marks"], [[BASE + 10000, BASE + 5 * MIN, "w"]])

    def test_a_quick_prompt_is_no_wait(self):
        log = Log().prompt(BASE).reply(BASE + 10000).prompt(BASE + 20000)
        self.assertEqual(self.read(log)[1]["marks"], [])

    def test_a_long_think_is_no_wait(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Bash", {})
        log.reply(BASE + 3 * MIN)
        self.assertEqual(self.read(log)[1]["marks"], [])

    def test_long_silence_with_nothing_open_reads_as_waiting(self):
        log = Log().prompt(BASE).reply(BASE + 1000).reply(BASE + 20 * MIN)
        self.assertEqual(self.read(log)[1]["marks"], [[BASE + 1000, BASE + 20 * MIN, "w"]])

    def test_a_question_to_the_person_is_blocked(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "AskUserQuestion", {"questions": ["SECRET-PROMPT"]}, took=4000)
        self.assertEqual(self.read(log)[1]["marks"], [[BASE + 1000, BASE + 5000, "b"]])

    def test_a_quick_tool_held_open_is_blocked(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Edit", {"file_path": "/a.ts"}, took=2 * MIN)
        self.assertEqual(self.read(log)[1]["marks"], [[BASE + 1000, BASE + 1000 + 2 * MIN, "b"]])

    def test_a_slow_shell_command_is_just_working(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Bash", {}, took=40 * MIN)
        self.assertEqual(self.read(log)[1]["marks"], [])

    def test_a_meta_line_is_not_a_prompt(self):
        log = Log().prompt(BASE).reply(BASE + 1000).prompt(BASE + 5 * MIN, isMeta=True).reply(BASE + 5 * MIN + 500)
        self.assertEqual(self.read(log)[1]["marks"], [])

    def test_text_that_looks_like_a_tool_call_is_not_one(self):
        log = Log().prompt(BASE, '{"type":"tool_use","name":"Bash"} and "tool_result"')
        call = log.call(BASE + 1000, "Read", {"file_path": "/a.ts"})
        log.result(BASE + 2000, call, '{"type":"tool_use","id":"x","name":"Bash"} {"timestamp":"2001-01-01T00:00:00.000Z"}')
        _summary, body = self.read(log)
        self.assertEqual([c[1] for c in body["calls"]], ["Read"])

    def test_broken_lines_and_other_records_are_skipped(self):
        log = Log().prompt(BASE).raw("{not json").raw('{"type":"summary","summary":"SECRET-SUMMARY"}')
        log.raw('{"type":"file-history-snapshot","snapshot":{"timestamp":"2001-01-01T00:00:00.000Z"}}')
        log.tool(BASE + 1000, "Read", {})
        summary, body = self.read(log)
        self.assertEqual(len(body["calls"]), 1)
        self.assertEqual(summary["first"], BASE)

    def test_a_file_with_no_records_is_nothing(self):
        path = self.path("s1")
        os.makedirs(os.path.dirname(path))
        open(path, "w").close()
        self.assertIsNone(transcripts.read_transcript(path))

    def test_a_long_silence_splits_the_span(self):
        log = Log().prompt(BASE)
        log.tool(BASE + 1000, "Read", {})
        log.prompt(BASE + 7 * HOUR)
        log.tool(BASE + 7 * HOUR + 1000, "Read", {})
        log.tool(BASE + 7 * HOUR + 3000, "Read", {})
        spans = self.read(log)[0]["spans"]
        self.assertEqual([s[2] for s in spans], [1, 2])

    def test_time_without_fractions(self):
        self.assertEqual(transcripts.to_ms(b"2026-11-06T00:00:00Z") % 1000, 0)
        self.assertEqual(transcripts.to_ms(b"2026-11-06T00:00:00.5Z") % 1000, 500)
        self.assertIsNone(transcripts.to_ms(b"not a time"))


class Folders(unittest.TestCase):
    def test_a_plain_folder(self):
        self.assertEqual(transcripts.folder_of("/work/lantern")[0], "lantern")
        self.assertEqual(transcripts.folder_of("C:\\work\\lantern\\")[2], "lantern")

    def test_same_name_different_folder_keeps_two_keys(self):
        self.assertNotEqual(transcripts.folder_of("/a/lantern")[1], transcripts.folder_of("/b/lantern")[1])

    def test_a_claude_worktree_counts_as_its_repo(self):
        repo, worktree = transcripts.folder_of("/work/lantern"), transcripts.folder_of("/work/lantern/.claude/worktrees/fix-login")
        self.assertEqual(worktree[:2], repo[:2])
        self.assertEqual(worktree[2], "fix-login")

    def test_a_herdr_worktree_joins_the_one_folder_of_that_name(self):
        def part(cwd):
            folder, key, own, repo = transcripts.folder_of(cwd)
            return {"session": cwd, "sub": False, "kind": None, "folder": folder, "key": key, "own": own, "repo": repo, "first": 0, "last": 1, "spans": [[0, 1, 1]]}
        rows = helper.session_rows([part("/work/lantern"), part("/home/me/.herdr/worktrees/lantern/fix-login")])
        self.assertEqual(len({r["key"] for r in rows}), 1)
        rows = helper.session_rows([part("/a/lantern"), part("/b/lantern"), part("/home/me/.herdr/worktrees/lantern/fix-login")])
        self.assertEqual(len({r["key"] for r in rows}), 3)


class Scanning(Folder):
    def session(self, name, start, calls=2, subagents=0):
        log = Log(name).prompt(start)
        for i in range(calls):
            log.tool(start + 1000 + i * 2000, "Read", {"file_path": "/work/f%d.ts" % i})
        log.write(self.path(name))
        for i in range(subagents):
            sub = Log(name).prompt(start + 2000, "SECRET-DESCRIPTION task")
            sub.tool(start + 3000, "Grep", {"pattern": "SECRET-PATTERN"})
            folder = os.path.join(self.root, "-work-lantern", name, "subagents")
            sub.write(os.path.join(folder, "agent-a%d.jsonl" % i))
            with open(os.path.join(folder, "agent-a%d.meta.json" % i), "w", encoding="utf-8") as f:
                json.dump({"agentType": "Explore", "description": "SECRET-DESCRIPTION"}, f)

    def test_a_session_and_its_subagents_are_one_row(self):
        self.session("s1", BASE, calls=3, subagents=2)
        reply = self.scan()
        self.assertEqual(len(reply["sessions"]), 1)
        row = reply["sessions"][0]
        self.assertEqual(row["id"], "s1")
        self.assertEqual(row["folder"], "lantern")
        self.assertEqual(row["spans"][0][2:], [5, 3])

    def test_an_older_subagent_file_finds_its_parent_by_session_id(self):
        self.session("s1", BASE)
        log = Log("s1").prompt(BASE + 2000)
        log.tool(BASE + 3000, "Read", {})
        log.write(self.path("agent-abc"))
        self.assertEqual([r["id"] for r in self.scan()["sessions"]], ["s1"])

    def test_no_full_paths_or_words_leave(self):
        self.session("s1", BASE, subagents=1)
        text = json.dumps(self.scan())
        self.assertNotIn("/work", text)
        self.assertNotIn("SECRET", text)

    def test_a_copied_folder_counts_once(self):
        self.session("s1", BASE)
        copy = os.path.join(self.home, "copy")
        shutil.copytree(self.root, copy)
        args = mock.Mock(demo=False, projects=[self.root, copy], cache=None, budget=99)
        self.assertEqual(helper.scan(args)["total"], 1)

    def test_nothing_found_says_so(self):
        os.makedirs(self.root)
        self.assertIn("No transcripts found", self.scan()["error"])

    def test_the_second_scan_reads_nothing(self):
        self.session("s1", BASE, subagents=1)
        first = self.scan()
        with mock.patch.object(transcripts, "read_transcript", side_effect=AssertionError("read again")):
            second = self.scan()
        for reply in (first, second):
            reply.pop("now")
        self.assertEqual(first, second)

    def test_a_changed_file_is_read_again(self):
        self.session("s1", BASE, calls=1)
        self.scan()
        self.session("s1", BASE, calls=4)
        self.assertEqual(self.scan()["sessions"][0]["spans"][0][2], 4)

    def test_a_cache_from_other_rules_is_ignored(self):
        self.session("s1", BASE)
        self.scan()
        with mock.patch.object(helper, "parser_id", return_value="other"):
            with mock.patch.object(transcripts, "read_transcript", wraps=transcripts.read_transcript) as read:
                self.scan()
        self.assertEqual(read.call_count, 1)

    def test_a_big_history_goes_in_passes(self):
        for i in range(5):
            self.session("s%d" % i, BASE + i * HOUR)
        seen = []
        for _ in range(6):
            reply = self.scan(budget=0)
            seen.append(reply["read"])
            if not reply["partial"]:
                break
        self.assertEqual(seen, [1, 2, 3, 4, 5])
        self.assertEqual(len(reply["sessions"]), 5)

    def test_an_unreadable_file_is_counted(self):
        self.session("s1", BASE)
        self.session("s2", BASE + HOUR)
        with mock.patch.object(transcripts, "read_transcript", side_effect=[OSError("no"), transcripts.read_transcript(self.path("s2"))]):
            reply = self.scan()
        self.assertEqual(reply["leftOut"], 1)
        self.assertEqual(len(reply["sessions"]), 1)

    def test_a_huge_file_is_left_out_and_counted(self):
        self.session("s1", BASE)
        with mock.patch.object(helper, "MAX_FILE", 10):
            self.assertEqual(self.scan()["leftOut"], 1)

    def test_the_list_is_capped_with_the_newest_kept(self):
        for i in range(4):
            self.session("s%d" % i, BASE + i * HOUR)
        with mock.patch.object(helper, "MAX_SESSIONS", 2):
            reply = self.scan()
        self.assertEqual([r["id"] for r in reply["sessions"]], ["s3", "s2"])
        self.assertEqual(reply["leftOff"], 2)

    def test_folders_with_nothing_in_them_are_skipped(self):
        home = os.path.join(self.home, "me")
        os.makedirs(os.path.join(home, ".claude", "projects", "a"))
        os.makedirs(os.path.join(home, ".claude-empty", "projects"))
        os.makedirs(os.path.join(home, ".claude-other"))
        open(os.path.join(home, ".claude.json"), "w").close()
        extra = os.path.join(self.home, "elsewhere")
        os.makedirs(os.path.join(extra, "projects", "b"))
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home, "CLAUDE_CONFIG_DIR": extra}):
            found = helper.claude_folders()
        self.assertEqual(sorted(os.path.basename(os.path.dirname(f)) for f in found), [".claude", "elsewhere"])


def summary(session, start, end, sub=False, kind=None, own="lantern"):
    return {"session": session, "sub": sub, "kind": kind, "folder": "lantern", "key": "k", "own": own, "repo": None, "first": start, "last": end, "spans": [[start, end, 1]]}


def body(calls, marks=()):
    table = sorted({c[2] for c in calls if c[2]})
    places = {name: i for i, name in enumerate(table)}
    return {"calls": [[c[0], c[1], places[c[2]] if c[2] else -1] for c in calls], "marks": [list(m) for m in marks], "files": [["h" + n, n] for n in table]}


class Building(unittest.TestCase):
    def test_names_parents_and_times(self):
        parts = [
            (summary("a", BASE, BASE + HOUR), body([(BASE, "Read", None)])),
            (summary("b", BASE + 5, BASE + HOUR), body([(BASE + 5, "Read", None)])),
            (summary("a", BASE + 10, BASE + 20, sub=True, kind="Explore"), body([(BASE + 10, "Grep", None)])),
            (summary("a", BASE + 30, BASE + 40, sub=True, kind="Explore"), body([(BASE + 30, "Grep", None)])),
            (summary("b", BASE + 50, BASE + 60, sub=True), body([(BASE + 50, "Grep", None)])),
        ]
        run = helper.build_run(parts, BASE, BASE + HOUR, "lantern", 0)
        self.assertEqual([a["name"] for a in run["agents"]], ["lantern", "lantern 2", "Explore", "Explore 2", "Subagent"])
        self.assertEqual([a["parent"] for a in run["agents"]], [-1, -1, 0, 0, 1])
        self.assertEqual(run["agents"][2]["start"], 10)
        self.assertEqual(run["span"], HOUR)

    def test_a_subagent_whose_session_has_gone_still_shows(self):
        run = helper.build_run([(summary("x", BASE, BASE + 10, sub=True, kind="Explore"), body([(BASE, "Read", None)]))], BASE, BASE + 10, "lantern", 0)
        self.assertEqual(run["agents"][0]["parent"], -1)

    def test_counts_are_real_and_files_are_by_full_path(self):
        parts = [(summary("a", BASE, BASE + 100), body([(BASE, "Read", "one"), (BASE + 1, "Edit", "one"), (BASE + 2, "Edit", "two")]))]
        run = helper.build_run(parts, BASE, BASE + 100, "lantern", 0)
        self.assertEqual(run["totals"], {"calls": 3, "files": 2, "agents": 1})
        self.assertEqual([e[5] for e in run["events"]], [1, 0, 1])
        self.assertEqual(run["files"], ["one", "two"])
        self.assertEqual(run["agents"][0]["calls"], 3)

    def test_two_files_of_one_name_count_twice(self):
        calls = [[BASE, "Read", 0], [BASE + 1, "Read", 1]]
        made = {"calls": calls, "marks": [], "files": [["h1", "index.ts"], ["h2", "index.ts"]]}
        run = helper.build_run([(summary("a", BASE, BASE + 100), made)], BASE, BASE + 100, "lantern", 0)
        self.assertEqual(run["totals"]["files"], 2)

    def test_only_the_runs_own_stretch_is_used(self):
        parts = [(summary("a", BASE, BASE + 100), body([(BASE - 1, "Read", None), (BASE + 1, "Read", None), (BASE + 101, "Read", None)]))]
        run = helper.build_run(parts, BASE, BASE + 100, "lantern", 0)
        self.assertEqual(run["totals"]["calls"], 1)

    def test_a_session_outside_the_run_is_left_out(self):
        parts = [(summary("a", BASE, BASE + 100), body([(BASE, "Read", None)])), (summary("b", BASE + 500, BASE + 900), body([(BASE + 500, "Read", None)]))]
        self.assertEqual(len(helper.build_run(parts, BASE, BASE + 100, "lantern", 0)["agents"]), 1)

    def test_marks_are_clipped_and_never_overlap(self):
        marks = [(BASE - 50, BASE + 10, "w"), (BASE + 5, BASE + 20, "b"), (BASE + 90, BASE + 300, "w")]
        run = helper.build_run([(summary("a", BASE, BASE + 100), body([(BASE, "Read", None)], marks))], BASE, BASE + 100, "lantern", 0)
        self.assertEqual(run["agents"][0]["marks"], [[0, 10, "w"], [10, 20, "b"], [90, 100, "w"]])

    def test_calls_copied_into_a_resumed_transcript_count_once(self):
        calls = [(BASE, "Read", "one"), (BASE + 1, "Edit", "one")]
        parts = [(summary("a", BASE, BASE + 100), body(calls)), (summary("b", BASE, BASE + 100), body(calls + [(BASE + 2, "Bash", None)]))]
        self.assertEqual(helper.build_run(parts, BASE, BASE + 100, "lantern", 0)["totals"]["calls"], 3)

    def test_two_calls_at_one_moment_in_one_agent_both_count(self):
        parts = [(summary("a", BASE, BASE + 100), body([(BASE, "Read", None), (BASE, "Read", None)]))]
        self.assertEqual(helper.build_run(parts, BASE, BASE + 100, "lantern", 0)["totals"]["calls"], 2)


class Thinning(unittest.TestCase):
    def test_a_short_list_is_left_alone(self):
        events = [[0, 1, 0, None, 1, 0]]
        self.assertIs(helper.thin_events(events, 10, 100), events)

    def test_thinning_keeps_every_call_and_every_agent(self):
        events = [[i % 3, i * 10, 0, (None, None), 1, 1 if i % 7 == 0 else 0] for i in range(50000)]
        thin = helper.thin_events(events, 2000, 500000)
        self.assertLessEqual(len(thin), 2000)
        self.assertEqual(sum(e[4] for e in thin), 50000)
        self.assertEqual(sum(e[5] for e in thin), sum(e[5] for e in events))
        self.assertEqual({e[0] for e in thin}, {0, 1, 2})
        self.assertEqual([e[1] for e in thin], sorted(e[1] for e in thin))

    def test_the_input_is_not_changed(self):
        events = [[0, i, 0, (None, None), 1, 0] for i in range(100)]
        helper.thin_events(events, 10, 100)
        self.assertTrue(all(e[4] == 1 for e in events))

    def test_a_long_run_stays_under_execs_limit_with_real_totals(self):
        names = ["%s-%d.ts" % ("n" * 50, i) for i in range(120000)]
        calls = [(BASE + i * 200, "Read", names[i]) for i in range(120000)]
        run = helper.build_run([(summary("a", BASE, BASE + 24000000), body(calls))], BASE, BASE + 24000000, "lantern", 0)
        size = len(json.dumps(run, separators=(",", ":")))
        self.assertLess(size, helper.MAX_REPLY)
        self.assertLessEqual(len(run["events"]), helper.MAX_EVENTS)
        self.assertEqual(run["totals"], {"calls": 120000, "files": 120000, "agents": 1})
        self.assertEqual(sum(e[4] for e in run["events"]), 120000)
        self.assertEqual(sum(e[5] for e in run["events"]), 120000)

    def test_a_reply_too_big_for_the_limit_is_thinned_harder(self):
        calls = [(BASE + i * 1000, "Read", "n%d" % i) for i in range(4000)]
        with mock.patch.object(helper, "MAX_REPLY", 20000):
            run = helper.build_run([(summary("a", BASE, BASE + 4000000), body(calls))], BASE, BASE + 4000000, "lantern", 0)
        self.assertLessEqual(len(json.dumps(run, separators=(",", ":"))), 20000)
        self.assertEqual(sum(e[4] for e in run["events"]), 4000)

    def test_marks_are_capped_with_the_longest_kept(self):
        marks = [(BASE + i * 100, BASE + i * 100 + 1 + i % 50, "w") for i in range(5000)]
        run = helper.build_run([(summary("a", BASE, BASE + 600000), body([(BASE, "Read", None)], marks))], BASE, BASE + 600000, "lantern", 0)
        kept = run["agents"][0]["marks"]
        self.assertEqual(len(kept), helper.MAX_MARKS)
        self.assertEqual(kept, sorted(kept))


NETWORK = re.compile(r"https?:|wss?:|ftp:|//[a-z0-9.-]+\.[a-z]{2,}/|<link\b|<img\b|<iframe\b|<object\b|<embed\b|<audio\b|<video\b|<source\b|\bsrc\s*=|\bhref\s*=|@import|url\(|"
                     r"\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|new Worker|\bimport\s*\(|\bimport\s+[{*\"']", re.I)


class Exporting(Folder):
    def make(self):
        log = Log("s1", "/work/secretfolder/lantern").prompt(BASE)
        log.reply(BASE + 500)
        log.tool(BASE + 1000, "Write", {"file_path": "/work/secretfolder/lamp.ts", "content": "SECRET-CONTENT"})
        log.tool(BASE + 3000, "Bash", {"command": "SECRET-COMMAND", "description": "SECRET-DESCRIPTION"})
        log.tool(BASE + 5000, "Grep", {"pattern": "SECRET-PATTERN"})
        log.tool(BASE + 7000, "Agent", {"description": "SECRET-DESCRIPTION", "prompt": "SECRET-PROMPT"})
        log.raw(json.dumps({"type": "summary", "summary": "SECRET-SUMMARY"}))
        log.write(self.path("s1"))
        sub = Log("s1", "/work/secretfolder/lantern").prompt(BASE + 7100, "SECRET-PROMPT sub")
        sub.tool(BASE + 7200, "Read", {"file_path": "/work/secretfolder/wick.ts"})
        folder = os.path.join(self.root, "-work-lantern", "s1", "subagents")
        sub.write(os.path.join(folder, "agent-a1.jsonl"))
        with open(os.path.join(folder, "agent-a1.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"agentType": "Explore", "description": "SECRET-DESCRIPTION"}, f)
        return BASE, BASE + 8200

    def export(self, start, end, colours=None):
        out = os.path.join(self.home, "Downloads")
        reply = helper.export(self.run_args(["s1"], start, end, out=out, colours=colours))
        with open(reply["saved"], encoding="utf-8") as f:
            return reply, f.read()

    def test_the_page_holds_no_prompt_or_result_text(self):
        _reply, page = self.export(*self.make())
        for secret in SECRETS:
            self.assertNotIn(secret, page)

    def test_the_replay_reply_holds_none_either(self):
        start, end = self.make()
        text = json.dumps(helper.replay(self.run_args(["s1"], start, end)))
        for secret in SECRETS:
            self.assertNotIn(secret, text)

    def test_the_page_holds_only_the_derived_fields(self):
        start, end = self.make()
        _reply, page = self.export(start, end)
        run = json.loads(re.search(r"const RUN = (.*);\n", page).group(1))
        self.assertEqual(sorted(run), ["agents", "demo", "events", "files", "folder", "offsetMin", "span", "start", "tools", "totals"])
        self.assertEqual(sorted(run["agents"][0]), ["calls", "end", "marks", "name", "parent", "start"])
        self.assertEqual(sorted(run["files"]), ["lamp.ts", "wick.ts"])
        self.assertEqual(sorted(run["tools"]), ["Agent", "Bash", "Grep", "Read", "Write"])
        self.assertEqual([a["name"] for a in run["agents"]], ["lantern", "Explore"])

    def test_the_page_has_the_same_events_as_the_overlay(self):
        start, end = self.make()
        shown = helper.replay(self.run_args(["s1"], start, end))["run"]
        _reply, page = self.export(start, end)
        run = json.loads(re.search(r"const RUN = (.*);\n", page).group(1))
        self.assertEqual(run["events"], shown["events"])
        self.assertEqual(run["agents"], shown["agents"])

    def test_the_page_has_no_network_references(self):
        _reply, page = self.export(*self.make())
        found = NETWORK.findall(page)
        self.assertEqual(found, [])

    def test_the_network_check_can_fail(self):
        for bad in ('<img src="x.png">', "fetch('/a')", "https://example.test/", "<link rel=stylesheet>", "url(x.png)"):
            self.assertTrue(NETWORK.search(bad), bad)

    def test_the_page_stands_alone(self):
        _reply, page = self.export(*self.make())
        self.assertNotIn("/*TIMELINE*/", page)
        self.assertNotIn("/*RUN*/", page)
        self.assertNotIn("/*COLOURS*/", page)
        self.assertNotIn("{{TITLE}}", page)
        self.assertEqual(len(re.findall(r"<script", page)), 1)
        self.assertNotIn("<script src", page)
        self.assertNotRegex(page, r"(?m)^export ")

    def test_a_file_name_cant_break_out_of_the_page(self):
        log = Log("s1").prompt(BASE)
        log.tool(BASE + 1000, "Read", {"file_path": "/work/a</script><b onload=x>.ts"})
        log.write(self.path("s1"))
        _reply, page = self.export(BASE, BASE + 3000)
        self.assertNotIn("<b onload", page)
        self.assertEqual(len(re.findall(r"</script", page)), 1)

    def test_a_folder_name_cant_break_out_of_the_title(self):
        log = Log("s1", "/work/<title>&x").prompt(BASE)
        log.tool(BASE + 1000, "Read", {})
        log.write(self.path("s1"))
        _reply, page = self.export(BASE, BASE + 3000)
        self.assertEqual(page.count("<title>"), 1)

    def test_a_saved_file_is_never_overwritten(self):
        start, end = self.make()
        first, _page = self.export(start, end)
        second, _page = self.export(start, end)
        self.assertNotEqual(first["saved"], second["saved"])
        self.assertTrue(second["saved"].endswith("-2.html"))

    def test_only_plain_theme_colours_reach_the_page(self):
        colours = helper.colours_of(json.dumps({"accent": "#112233", "done": "#11223344", "muted": "red;}", "other": "#000000"}))
        self.assertEqual(colours, {"accent": "#112233", "done": "#11223344"})
        self.assertEqual(helper.colours_of("not json"), {})


class Demo(unittest.TestCase):
    def lantern(self):
        made = [e for e in sample.entries(time.time() * 1000) if e[0]["session"].startswith("demo-lantern")]
        start = min(s["first"] for s, _b in made)
        end = max(s["last"] for s, _b in made)
        return made, start, end

    def test_the_demo_is_nine_hours_and_six_agents(self):
        made, start, end = self.lantern()
        run = helper.build_run(made, start, end, "lantern", 0)
        self.assertEqual(run["totals"]["agents"], 6)
        self.assertEqual(run["span"], 9 * HOUR + 12 * MIN)
        self.assertEqual([a["name"] for a in run["agents"]], ["lantern", "fix-login", "search-index", "Explore", "general-purpose", "general-purpose 2"])

    def test_the_demo_is_the_same_every_time(self):
        now = 1793916000000
        self.assertEqual(sample.entries(now), sample.entries(now))

    def test_the_demo_has_a_gap_blocked_and_waiting(self):
        made, start, end = self.lantern()
        run = helper.build_run(made, start, end, "lantern", 0)
        kinds = {m[2] for a in run["agents"] for m in a["marks"]}
        self.assertEqual(kinds, {"b", "w"})
        times = [e[1] for e in run["events"]]
        self.assertGreater(max(b - a for a, b in zip(times, times[1:])), 2 * HOUR)


class Command(Folder):
    def helper(self, *args):
        done = subprocess.run([sys.executable, "-I", "-S", "-B", os.path.join(MOD, "helper.py"), *args], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_it_runs_as_the_mod_runs_it(self):
        log = Log("s1").prompt(BASE)
        log.tool(BASE + 1000, "Read", {"file_path": "/work/lamp.ts"})
        log.write(self.path("s1"))
        scan = self.helper("scan", "--cache", self.cache, "--projects", self.root)
        self.assertEqual(scan["sessions"][0]["id"], "s1")
        replay = self.helper("replay", "--cache", self.cache, "--projects", self.root, "--ids", "s1", "--from", str(BASE), "--to", str(BASE + 2000))
        self.assertEqual(replay["run"]["files"], ["lamp.ts"])

    def test_the_demo_scans_replays_and_exports(self):
        sessions = self.helper("scan", "--demo")["sessions"]
        rows = [s for s in sessions if s["id"].startswith("demo-lantern")]
        start, end = min(r["spans"][0][0] for r in rows), max(r["spans"][-1][1] for r in rows)
        ids = ",".join(r["id"] for r in rows)
        self.assertEqual(self.helper("replay", "--demo", "--ids", ids, "--from", str(start), "--to", str(end))["run"]["totals"]["agents"], 6)
        out = os.path.join(self.home, "out")
        saved = self.helper("export", "--demo", "--ids", ids, "--from", str(start), "--to", str(end), "--out", out)["saved"]
        self.assertTrue(saved.endswith("time-lapse-lantern-demo.html"))

    def test_nothing_is_written_beside_the_helper(self):
        before = sorted(os.listdir(MOD))
        self.helper("scan", "--demo")
        self.assertEqual(sorted(os.listdir(MOD)), before)

    def test_a_failure_is_named_not_a_traceback(self):
        reply = self.helper("replay", "--projects", self.root, "--ids", "nobody")
        self.assertIn("error", reply)


class Source(unittest.TestCase):
    def test_nothing_in_the_mod_reaches_the_network(self):
        for name in sorted(os.listdir(MOD)):
            if name.endswith((".py", ".js")):
                with open(os.path.join(MOD, name), encoding="utf-8") as f:
                    code = f.read()
                self.assertIsNone(re.search(r"^\s*(import|from)\s+(socket|urllib|http|requests|ssl)\b|\bfetch\(", code, re.M), name)


if __name__ == "__main__":
    with contextlib.suppress(SystemExit):
        unittest.main(verbosity=1)
