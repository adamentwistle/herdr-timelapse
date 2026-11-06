"""Made-up runs for `props: { demo: true }`: an overnight run in a folder called lantern, and two smaller ones so the list has
something to choose from. Fixed seed, so the same calls every time. They go through the same code as real transcripts,
in the same shape as transcripts.read_transcript.
"""
import random
import time

MINUTE = 60000
HOUR = 60 * MINUTE
TOOLS = ["Read"] * 9 + ["Grep"] * 4 + ["Glob"] * 2 + ["Bash"] * 7 + ["Edit"] * 7 + ["Write"] * 2 + ["TodoWrite"] * 2
FILE_TOOLS = {"Read", "Edit", "Write"}
STEMS = ["lamp", "wick", "flame", "glass", "oil", "hook", "beam", "shade", "store", "routes", "login", "session", "index", "search", "rank",
         "cache", "queue", "worker", "schema", "seed", "theme", "header", "footer", "map"]
FILES = ["%s%s.ts" % (stem, kind) for stem in STEMS for kind in ("", "-view", "-model", ".test", "-types", "-utils")]


def midnight(now_ms):
    """Local midnight today, in ms."""
    t = time.localtime(now_ms / 1000)
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)


def agent(rng, session, own, key, folder, stretches, kind=None, marks=()):
    """One made-up transcript. `stretches` are (from, to, calls a minute), in ms from the run's start, already placed."""
    calls, table = [], {}
    for start, end, rate in stretches:
        at = start
        while at < end:
            at += int(rng.expovariate(rate / MINUTE)) + 800
            if at >= end:
                break
            tool = rng.choice(TOOLS)
            index = -1
            if tool in FILE_TOOLS:
                name = rng.choice(FILES)
                index = table.setdefault(name, len(table))
            calls.append([at, tool, index])
    first, last = stretches[0][0], stretches[-1][1]
    summary = {"session": session, "sub": kind is not None, "kind": kind, "folder": folder, "key": key, "own": own, "repo": None,
               "first": first, "last": last, "spans": [[first, last, len(calls)]]}
    files = [["demo-%s" % name, name] for name, _i in sorted(table.items(), key=lambda item: item[1])]
    return summary, {"calls": calls, "marks": [list(m) for m in marks], "files": files}


def entries(now_ms):
    """[(summary, body), ...] for all three runs. Lantern starts at 22:14 yesterday and ends at 07:26 today, with nothing at
    all from 01:38 to 04:27."""
    rng = random.Random(1807)
    today = midnight(now_ms)
    start = today - 106 * MINUTE
    at = lambda hours, minutes=0: today + hours * HOUR + minutes * MINUTE
    made = [
        agent(rng, "demo-lantern-1", "lantern", "demo-lantern", "lantern",
              [(start, at(0, 40), 3.2), (at(1, 5), at(1, 38), 1.4), (at(4, 27), at(7, 26), 2.2)],
              marks=[(at(0, 40), at(1, 5), "w"), (at(1, 38), at(4, 27), "w")]),
        agent(rng, "demo-lantern-2", "fix-login", "demo-lantern", "lantern",
              [(start + 11 * MINUTE, at(0, 52), 5.5), (at(1, 9), at(1, 38), 3.1)],
              marks=[(at(0, 52), at(1, 9), "b")]),
        agent(rng, "demo-lantern-3", "search-index", "demo-lantern", "lantern",
              [(at(0, 18), at(1, 34), 6.4), (at(4, 31), at(6, 44), 5.2)], marks=[(at(1, 34), at(4, 31), "w")]),
        agent(rng, "demo-lantern-1", "lantern", "demo-lantern", "lantern", [(at(0, 4), at(0, 38), 7.5)], kind="Explore"),
        agent(rng, "demo-lantern-3", "search-index", "demo-lantern", "lantern", [(at(5, 2), at(5, 41), 8.0)], kind="general-purpose"),
        agent(rng, "demo-lantern-3", "search-index", "demo-lantern", "lantern", [(at(5, 20), at(6, 12), 6.0)], kind="general-purpose"),
        agent(rng, "demo-tidepool-1", "tidepool", "demo-tidepool", "tidepool", [(today - 70 * HOUR, today - 68 * HOUR, 4.0)]),
        agent(rng, "demo-tidepool-1", "tidepool", "demo-tidepool", "tidepool", [(today - 69 * HOUR, today - 68 * HOUR - 20 * MINUTE, 6.0)], kind="Explore"),
        agent(rng, "demo-tidepool-1", "tidepool", "demo-tidepool", "tidepool", [(today - 69 * HOUR, today - 68 * HOUR - 5 * MINUTE, 3.0)], kind="Plan"),
        agent(rng, "demo-orchard-1", "orchard", "demo-orchard", "orchard", [(today - 146 * HOUR, today - 146 * HOUR + 42 * MINUTE, 5.0)]),
    ]
    return made
