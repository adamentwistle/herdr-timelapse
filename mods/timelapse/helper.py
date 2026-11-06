#!/usr/bin/env python3
"""Reads Claude Code's transcripts for the Time-lapse overlay. It opens them for reading only and uses no network.

  helper.py scan --cache DIR [--demo] [--projects DIR ...] [--budget SECONDS]
  helper.py replay --cache DIR --ids A,B --from MS --to MS [--demo] [--projects DIR ...] [--budget SECONDS]
  helper.py export --cache DIR --ids A,B --from MS --to MS --out DIR [--colours JSON] [--demo] [--projects DIR ...]

`scan` prints every recent session as one line of JSON, for the overlay to group into runs. `replay` prints one run's
events, and `export` writes the same events to --out as a page that plays by itself. Transcripts can total gigabytes, so
each file is read once and kept in --cache against its size and modified time. A pass stops reading once --budget seconds
have gone and prints "partial": true, and the overlay asks again until nothing is left.

--demo uses the made-up runs in sample.py and no cache. Run under python3 -I -S -B: -I leaves this folder off sys.path, so
it's added below, and -B keeps __pycache__ out of the mod folder, where a new file would make Herdr reload the mod.

A reply holds tool names, times, file base names and folder names, and nothing else from a transcript.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.append(HERE)
import sample  # noqa: E402
import transcripts  # noqa: E402

CACHE_VERSION = 1
READ_BUDGET = 15.0
MAX_FILE = 512 * 1024 * 1024
MAX_SESSIONS = 2000
MAX_EVENTS = 6000
MAX_MARKS = 2000
MAX_REPLY = 4 * 1024 * 1024   # exec stops at 8 MiB
COLOUR = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
COLOUR_NAMES = ("background", "canvas", "popover", "raised", "border", "input", "foreground", "muted", "dim", "accent",
                "working", "blocked", "done", "idle", "ansi3", "ansi6")


def claude_folders():
    """$CLAUDE_CONFIG_DIR and each ~/.claude* folder, once each, if there's anything in its projects folder."""
    home = os.path.expanduser("~")
    found = [os.environ["CLAUDE_CONFIG_DIR"]] if os.environ.get("CLAUDE_CONFIG_DIR") else []
    try:
        found += sorted(os.path.join(home, name) for name in os.listdir(home) if name.startswith(".claude"))
    except OSError:
        pass
    roots = []
    for folder in dict.fromkeys(os.path.realpath(f) for f in found):
        projects = os.path.join(folder, "projects")
        try:
            if os.path.isdir(projects) and os.listdir(projects):
                roots.append(projects)
        except OSError:
            continue
    return roots


def walk(roots):
    """Every .jsonl under these folders, as (path, size, mtime). The same path inside two Claude folders is one transcript,
    as a copied folder holds, and the larger is kept: counting both would make every session overlap its own copy."""
    found = {}
    for root in roots:
        for folder, _dirs, names in os.walk(root):
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(folder, name)
                try:
                    info = os.stat(path)
                except OSError:
                    continue
                key = os.path.relpath(path, root)
                if key not in found or info.st_size > found[key][1]:
                    found[key] = (path, info.st_size, info.st_mtime_ns)
    return sorted(found.values())


def parser_id():
    """Changes when the reading does, so new rules aren't mixed with old results."""
    digest = hashlib.sha1()
    with open(os.path.join(HERE, "transcripts.py"), "rb") as f:
        digest.update(f.read())
    return digest.hexdigest()


def load_index(cache, parser):
    try:
        with open(os.path.join(cache, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(index, dict) or index.get("v") != CACHE_VERSION or index.get("parser") != parser:
        return {}
    files = index.get("files")
    return files if isinstance(files, dict) else {}


def write_json(path, value):
    temp = "%s.tmp.%d" % (path, os.getpid())
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(value, f, separators=(",", ":"))
    os.replace(temp, path)


def body_path(cache, path):
    return os.path.join(cache, "bodies", hashlib.sha1(path.encode("utf-8", "replace")).hexdigest()[:20] + ".json")


def read_one(path, size, mtime, cache):
    """One index entry. `summary` is None for a file with no timed records, and `bad` marks one that couldn't be read."""
    entry = {"size": size, "mtime": mtime, "summary": None}
    if size > MAX_FILE:
        entry["bad"] = True
        return entry
    try:
        read = transcripts.read_transcript(path)
        if read:
            entry["summary"] = read[0]
            if cache:
                write_json(body_path(cache, path), read[1])
    except Exception:
        entry["bad"] = True
    return entry


def collect(roots, cache, budget):
    """({path: summary}, progress). Reads new and changed files until the budget has gone, at least one a pass, so a pass
    always gets further than the last."""
    began = time.monotonic()
    parser = parser_id()
    known = load_index(cache, parser) if cache else {}
    if cache:
        os.makedirs(os.path.join(cache, "bodies"), exist_ok=True)
    found = walk(roots)
    files, summaries, read, waiting, left_out = {}, {}, 0, 0, 0
    for path, size, mtime in found:
        entry = known.get(path)
        if not entry or entry.get("size") != size or entry.get("mtime") != mtime:
            if read and time.monotonic() - began >= budget:
                waiting += 1
                continue
            entry = read_one(path, size, mtime, cache)
            read += 1
        files[path] = entry
        if entry.get("bad"):
            left_out += 1
        elif entry.get("summary"):
            summaries[path] = entry["summary"]
    if cache and (read or len(files) != len(known)):
        write_json(os.path.join(cache, "index.json"), {"v": CACHE_VERSION, "parser": parser, "files": files})
    return summaries, {"read": len(found) - waiting, "total": len(found), "leftOut": left_out}


def body_of(path, cache):
    """A file's calls and marks: the kept copy, or a fresh read if that has gone."""
    if cache:
        try:
            with open(body_path(cache, path), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    read = transcripts.read_transcript(path)
    return read[1] if read else {"calls": [], "marks": [], "files": []}


def join_worktrees(summaries):
    """A worktree under ~/.herdr joins the folder its repo is named after, when there's exactly one of that name."""
    named = {}
    for s in summaries:
        if not s["repo"]:
            named.setdefault(s["folder"], set()).add(s["key"])
    return {s["key"]: next(iter(named[s["repo"]])) for s in summaries if s["repo"] and len(named.get(s["repo"], ())) == 1}


def session_rows(summaries):
    """One row per session, with its subagents folded in, newest first: {id, key, folder, spans: [[from, to, calls, agents]]}.
    A span is a stretch with no silence of SPLIT_MS, so a session resumed days later has two."""
    swap = join_worktrees(summaries)
    grouped = {}
    for s in summaries:
        grouped.setdefault(s["session"], []).append(s)
    rows = []
    for session, parts in grouped.items():
        main = next((p for p in parts if not p["sub"]), parts[0])
        pieces = []
        for part in parts:
            for i, (start, end, calls) in enumerate(part["spans"]):
                pieces.append((start, end, calls, 1 if part["sub"] and i == 0 else 0))
        spans = []
        for start, end, calls, subs in sorted(pieces):
            if spans and start - spans[-1][1] < transcripts.SPLIT_MS:
                spans[-1][1] = max(spans[-1][1], end)
                spans[-1][2] += calls
                spans[-1][3] += subs
            else:
                spans.append([start, end, calls, 1 + subs])
        if sum(s[2] for s in spans):
            rows.append({"id": session, "key": swap.get(main["key"], main["key"]), "folder": main["folder"], "spans": spans})
    rows.sort(key=lambda r: r["spans"][-1][1], reverse=True)
    return rows


def clipped(spans, start, end):
    """Where these spans meet the run, as (from, to), or None."""
    inside = [(max(a, start), min(b, end)) for a, b, _calls in spans if a <= end and b >= start]
    return (min(i[0] for i in inside), max(i[1] for i in inside)) if inside else None


def numbered(name, used):
    used[name] = used.get(name, 0) + 1
    return name if used[name] == 1 else "%s %d" % (name, used[name])


def tidy_marks(marks, start, end):
    """Marks inside the run, from its start, sorted and not overlapping. Past MAX_MARKS the longest stay."""
    out = []
    for a, b, kind in sorted(marks):
        a, b = max(a, start, out[-1][1] + start if out else start), min(b, end)
        if b > a:
            out.append([a - start, b - start, kind])
    return out


def thin_events(events, limit, span):
    """At most `limit` events. An agent's events in one short stretch become its first, which keeps count of the rest, so
    the running totals still end true. Each is [agent, t, tool, file, calls, new files]."""
    if len(events) <= limit:
        return events
    width = max(1.0, span / limit)
    while True:
        kept, last = [], {}
        for event in events:
            bucket = int(event[1] // width)
            hit = last.get(event[0])
            if hit and hit[0] == bucket:
                hit[1][4] += event[4]
                hit[1][5] += event[5]
            else:
                copy = list(event)
                kept.append(copy)
                last[event[0]] = (bucket, copy)
        if len(kept) <= limit:
            return kept
        width *= 1.5


def build_run(parts, start, end, folder, offset_min, limit=MAX_EVENTS):
    """One run from [(summary, body), ...], ready to print. Every time is ms from the run's start."""
    placed = []
    for summary, body in parts:
        window = clipped(summary["spans"], start, end)
        if window:
            placed.append((window, summary, body))
    placed.sort(key=lambda p: (p[1]["sub"], p[0][0]))
    used, leads, agents = {}, {}, []
    for window, summary, body in placed:
        lead = leads.get(summary["session"], -1) if summary["sub"] else -1
        name = numbered(summary["kind"] or "Subagent", used) if summary["sub"] and lead >= 0 else numbered(summary["own"], used)
        if not summary["sub"]:
            leads[summary["session"]] = len(agents)
        agents.append({"name": name, "parent": lead, "start": window[0] - start, "end": window[1] - start, "calls": 0,
                       "marks": tidy_marks(body["marks"], start, end)})
    seen, raw = {}, []
    for i, (_window, _summary, body) in enumerate(placed):
        table = body["files"]
        for at, tool, index in body["calls"]:
            if not start <= at <= end:
                continue
            digest, name = table[index] if index >= 0 else (None, None)
            # A resumed session can copy calls from the transcript it carries on from. Same moment, same call, other file.
            owner = seen.setdefault((at, tool, digest), i)
            if owner == i:
                raw.append((at, i, tool, digest, name))
    raw.sort(key=lambda r: (r[0], r[1]))
    tools, touched = {}, set()
    events = []
    for at, i, tool, digest, name in raw:
        fresh = 1 if digest and digest not in touched else 0
        if digest:
            touched.add(digest)
        agents[i]["calls"] += 1
        events.append([i, at - start, tools.setdefault(tool, len(tools)), (digest, name), 1, fresh])
    span = max(0, end - start)
    while True:
        thinned = thin_events(events, limit, span)
        marks = sorted(((m[1] - m[0], i, m) for i, a in enumerate(agents) for m in a["marks"]), key=lambda m: m[0], reverse=True)[:MAX_MARKS]
        keep = {id(m[2]) for m in marks}
        files, rows = {}, []
        for agent, at, tool, target, calls, fresh in thinned:
            digest, name = target
            rows.append([agent, at, tool, files.setdefault(digest, (len(files), name))[0] if digest else -1, calls, fresh])
        reply = {
            "folder": folder, "start": start, "span": span, "offsetMin": offset_min,
            "agents": [dict(a, marks=[m for m in a["marks"] if id(m) in keep]) for a in agents],
            "tools": [t for t, _i in sorted(tools.items(), key=lambda item: item[1])],
            "files": [v[1] for v in sorted(files.values())],
            "events": rows,
            "totals": {"calls": len(raw), "files": len(touched), "agents": len(agents)},
        }
        if len(json.dumps(reply, separators=(",", ":"))) <= MAX_REPLY or limit <= 100:
            return reply
        limit //= 2


def offset_at(ms):
    """This machine's offset from UTC at that moment, in minutes."""
    return time.localtime(ms / 1000).tm_gmtoff // 60


def roots_for(args):
    return args.projects or claude_folders()


def scan(args):
    if args.demo:
        summaries, progress = [s for s, _b in sample.entries(time.time() * 1000)], {"read": 3, "total": 3, "leftOut": 0}
    else:
        found, progress = collect(roots_for(args), args.cache, args.budget)
        summaries = list(found.values())
    if progress["read"] < progress["total"]:
        return {"partial": True, **progress}
    if not progress["total"]:
        return {"error": "No transcripts found. Looked in $CLAUDE_CONFIG_DIR and in projects under each ~/.claude* folder."}
    rows = session_rows(summaries)
    left_off = max(0, len(rows) - MAX_SESSIONS)
    now = int(time.time() * 1000)
    return {"partial": False, **progress, "now": now, "offsetMin": offset_at(now), "leftOff": left_off, "sessions": rows[:MAX_SESSIONS]}


def run_parts(args):
    """([(summary, body), ...], progress) for the sessions asked for."""
    wanted = set(args.ids.split(","))
    if args.demo:
        return [e for e in sample.entries(time.time() * 1000) if e[0]["session"] in wanted], {"read": 1, "total": 1, "leftOut": 0}
    found, progress = collect(roots_for(args), args.cache, args.budget)
    parts = [(s, body_of(path, args.cache)) for path, s in sorted(found.items()) if s["session"] in wanted]
    return parts, progress


def replay_of(args):
    parts, progress = run_parts(args)
    if progress["read"] < progress["total"]:
        return {"partial": True, **progress}, None
    if not parts:
        return {"error": "This run's transcripts have gone."}, None
    folder = next((s["folder"] for s, _b in parts if not s["sub"]), parts[0][0]["folder"])
    start, end = getattr(args, "from"), args.to
    return {"partial": False, **progress}, build_run(parts, start, end, folder, offset_at(start))


def replay(args):
    head, run = replay_of(args)
    return dict(head, run=run) if run else head


def colours_of(text):
    """The theme's colours for the page, keeping only known names with plain hex values."""
    try:
        given = json.loads(text) if text else {}
    except ValueError:
        return {}
    if not isinstance(given, dict):
        return {}
    return {k: v for k, v in given.items() if k in COLOUR_NAMES and isinstance(v, str) and COLOUR.match(v)}


def embedded(value):
    """JSON that's safe inside a <script>: nothing in it can end the tag."""
    return json.dumps(value, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def page_of(run, colours):
    """The page, built from replay.html with timeline.js pasted in, so it plays exactly as the overlay does."""
    with open(os.path.join(HERE, "replay.html"), encoding="utf-8") as f:
        page = f.read()
    with open(os.path.join(HERE, "timeline.js"), encoding="utf-8") as f:
        logic = re.sub(r"^export ", "", f.read(), flags=re.M)
    title = re.sub(r"[<>&\"']", "", run["folder"])
    return page.replace("/*TIMELINE*/", logic).replace("/*RUN*/null", embedded(run)).replace("/*COLOURS*/null", embedded(colours)).replace("{{TITLE}}", title)


def free_name(folder, stem):
    path = os.path.join(folder, stem + ".html")
    count = 1
    while os.path.exists(path):
        count += 1
        path = os.path.join(folder, "%s-%d.html" % (stem, count))
    return path


def export(args):
    head, run = replay_of(args)
    if not run:
        return head
    run["demo"] = args.demo
    os.makedirs(args.out, exist_ok=True)
    day = time.strftime("%Y-%m-%d", time.gmtime((run["start"] / 1000) + run["offsetMin"] * 60))
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", run["folder"]).strip("-.") or "run"
    path = free_name(args.out, "time-lapse-%s-%s" % (name, "demo" if args.demo else day))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(page_of(run, colours_of(args.colours)))
    return {"partial": False, "saved": path, "bytes": os.path.getsize(path)}


def main(argv):
    parser = argparse.ArgumentParser(prog="helper.py")
    parser.add_argument("action", choices=["scan", "replay", "export"])
    parser.add_argument("--cache")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--projects", action="append")
    parser.add_argument("--budget", type=float, default=READ_BUDGET)
    parser.add_argument("--ids", default="")
    parser.add_argument("--from", type=int, default=0)
    parser.add_argument("--to", type=int, default=0)
    parser.add_argument("--out")
    parser.add_argument("--colours")
    args = parser.parse_args(argv)
    try:
        reply = {"scan": scan, "replay": replay, "export": export}[args.action](args)
    except Exception as e:  # named for the overlay, not left as a traceback
        reply = {"error": "%s: %s" % (type(e).__name__, e)}
    # ASCII only, whatever the output encoding is.
    sys.stdout.write(json.dumps(reply, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
