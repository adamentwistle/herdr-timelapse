// Turns the helper's sessions into runs, and says which to show. No Herdr imports, so `node --test` can load this file.
import { spanText } from "./timeline.js";

// A /clear starts a new transcript in the same terminal, so two within a minute of each other count as overlapping.
export const JOIN_MS = 60000;
export const MAX_RUNS = 40;
const BIG_CALLS = 100;
const BIG_MS = 3600000;

// `sessions` are { id, key, folder, spans: [[from, to, calls, agents], ...] }. A session that stopped for hours has several
// spans, and each joins its own run. Spans in the same folder that overlap are one run. Newest first.
export function groupRuns(sessions) {
  const byFolder = new Map();
  for (const session of sessions) {
    for (const [from, to, calls, agents] of session.spans) {
      if (!byFolder.has(session.key)) byFolder.set(session.key, []);
      byFolder.get(session.key).push({ id: session.id, folder: session.folder, from, to, calls, agents });
    }
  }
  const runs = [];
  for (const [key, spans] of byFolder) {
    spans.sort((a, b) => a.from - b.from);
    let run = null;
    for (const span of spans) {
      if (!run || span.from > run.to + JOIN_MS) {
        run = { key, folder: span.folder, from: span.from, to: span.to, calls: 0, subagents: 0, ids: new Set() };
        runs.push(run);
      }
      run.to = Math.max(run.to, span.to);
      run.calls += span.calls;
      run.subagents += span.agents - 1;
      run.ids.add(span.id);
    }
  }
  return runs.filter((r) => r.calls > 0)
    .map(({ subagents, ids, ...run }) => ({ ...run, ids: [...ids], agents: ids.size + subagents }))
    .sort((a, b) => b.to - a.to);
}

// The newest run worth watching: plenty of calls, and more than one agent or at least an hour. Failing that, the newest.
export function latestBig(runs) {
  return runs.find((r) => r.calls >= BIG_CALLS && (r.agents > 1 || r.to - r.from >= BIG_MS)) ?? runs[0] ?? null;
}

const DAY_MS = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "tonight", "today", "last night", "yesterday", a weekday this past week, else "3 Nov". Local days, from `offsetMin`.
export function whenText(from, now, offsetMin) {
  const local = (ms) => ms + offsetMin * 60000, dayOf = (ms) => Math.floor(local(ms) / DAY_MS), hourOf = (ms) => new Date(local(ms)).getUTCHours();
  const today = dayOf(now), started = dayOf(from), back = today - started;
  if (back === 0) return hourOf(from) < 6 ? "last night" : hourOf(from) >= 18 ? "tonight" : "today";
  if (back === 1) return hourOf(from) >= 18 ? "last night" : "yesterday";
  const date = new Date(local(from));
  if (back > 0 && back < 7) return WEEKDAYS[date.getUTCDay()];
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

// "lantern, last night, 9h, 6 agents"
export function runLabel(run, now, offsetMin) {
  return `${run.folder}, ${whenText(run.from, now, offsetMin)}, ${spanText(run.to - run.from)}, ${run.agents} ${run.agents === 1 ? "agent" : "agents"}`;
}
