// The replay itself: how a run's time maps onto the clip, what is drawn at any moment of it, and where things sit on the
// orbit. No imports, because this file is also pasted whole into the exported page, so the overlay and the page can't
// disagree. Nothing here reads a clock. A run's times are ms from its start, and a place in the clip is a share from 0 to 1.

export const DURATIONS = [{ key: "30", ms: 30000, label: "30 s" }, { key: "60", ms: 60000, label: "60 s" }, { key: "120", ms: 120000, label: "2 min" }];
export const GAP_MS = 10 * 60000;
export const GAP_SHARE = 0.03;
export const GAP_TOTAL = 0.24;
export const SPARK_RATE = 8;
export const SPARKS_PER_SLOT = 2;
export const FLIGHT_MS = 700;
export const MAX_SPARKS = 8;
export const LABELLED = 12;
export const BAR_COUNT = 160;
export const FADE_IN_MS = 300;

// The last index in a sorted list whose value is at or before `value`, or -1.
function lastAtOrBefore(list, value) {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (list[middle] <= value) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

// Stretches of the run with the clip's share of each. `times` are sorted. Silence of `gapMs` or longer takes a small fixed
// share, and the rest of the clip is shared out by real time. So a 3 hour gap takes as long as a 20 minute one, and it's
// marked wherever it's drawn, so a jump in the clock is never passed off as nothing.
export function compress(times, span, { gapMs = GAP_MS, gapShare = GAP_SHARE, gapTotal = GAP_TOTAL } = {}) {
  if (!(span > 0)) return { span: 0, segments: [{ from: 0, to: 0, x0: 0, x1: 1, gap: false }], gaps: [] };
  const stops = [];
  let last = 0;
  for (let i = 0; i <= times.length; i++) {
    const at = i < times.length ? Math.max(0, Math.min(span, times[i])) : span;
    if (at - last >= gapMs) stops.push([last, at]);
    if (at > last) last = at;
  }
  const quiet = stops.reduce((sum, [from, to]) => sum + to - from, 0), busy = span - quiet;
  // With nothing busy at all, the whole clip is the gaps.
  const each = stops.length ? (busy > 0 ? Math.min(gapShare, gapTotal / stops.length) : 1 / stops.length) : 0;
  const perMs = busy > 0 ? (1 - each * stops.length) / busy : 0;
  const segments = [];
  let cursor = 0, x = 0;
  const add = (from, to, gap) => {
    const width = gap ? each : (to - from) * perMs;
    segments.push({ from, to, x0: x, x1: x + width, gap });
    x += width;
  };
  for (const [from, to] of stops) {
    if (from > cursor) add(cursor, from, false);
    add(from, to, true);
    cursor = to;
  }
  if (span > cursor) add(cursor, span, false);
  segments[segments.length - 1].x1 = 1;
  return { span, segments, gaps: segments.filter((s) => s.gap) };
}

function segmentOf(timeline, test) {
  const { segments } = timeline;
  let low = 0, high = segments.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(segments[middle])) high = middle; else low = middle + 1;
  }
  return segments[low];
}

// Where a moment of the run falls in the clip.
export function fractionAt(timeline, t) {
  if (!(timeline.span > 0)) return 0;
  const at = Math.max(0, Math.min(timeline.span, t));
  const s = segmentOf(timeline, (segment) => at <= segment.to);
  return s.to > s.from ? s.x0 + ((at - s.from) / (s.to - s.from)) * (s.x1 - s.x0) : s.x0;
}

// The moment of the run shown at a place in the clip.
export function timeAt(timeline, fraction) {
  if (!(timeline.span > 0)) return 0;
  const at = Math.max(0, Math.min(1, fraction));
  const s = segmentOf(timeline, (segment) => at <= segment.x1);
  return s.x1 > s.x0 ? s.from + ((at - s.x0) / (s.x1 - s.x0)) * (s.to - s.from) : s.from;
}

// The gap the clip is inside at this place, or null.
export const gapAt = (timeline, fraction) => timeline.gaps.find((g) => fraction >= g.x0 && fraction < g.x1) ?? null;

// Real running totals, whatever gets thinned. Each event is [agent, t, tool, file, calls, new files]: `calls` is how many
// real calls it stands for, so these end on the run's true totals.
export function indexCounts(events) {
  const times = new Array(events.length), calls = new Array(events.length), files = new Array(events.length);
  let c = 0, f = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    c += event[4]; f += event[5];
    times[i] = event[1]; calls[i] = c; files[i] = f;
  }
  return { times, calls, files };
}

// The same for each agent, in one pass over the events, so a run with many agents costs no more to prepare.
export function indexByAgent(events, count) {
  const lists = Array.from({ length: count }, () => []);
  for (const event of events) lists[event[0]].push(event);
  return lists.map(indexCounts);
}

export function countsAt(index, t) {
  const i = lastAtOrBefore(index.times, t);
  return i < 0 ? { calls: 0, files: 0, last: -1 } : { calls: index.calls[i], files: index.files[i], last: i };
}

// One spark at most for each agent in a short slot of the clip, up to SPARKS_PER_SLOT a slot. So however busy the run, the
// sparks on screen stay about SPARK_RATE * SPARKS_PER_SLOT a second, and the same at any clip length. What's dropped is
// added to the one kept, as [place in the clip, agent, tool, calls].
export function thinForDrawing(events, timeline, durationMs, { rate = SPARK_RATE, perSlot = SPARKS_PER_SLOT } = {}) {
  const slots = Math.max(1, Math.ceil((durationMs / 1000) * rate)), kept = [];
  let slot = -1, here = [];
  for (const event of events) {
    const at = fractionAt(timeline, event[1]), mine = Math.min(slots - 1, Math.floor(at * slots));
    if (mine !== slot) { slot = mine; here = []; }
    const same = here.find((k) => k[1] === event[0]);
    if (same) same[3] += event[4];
    else if (here.length < perSlot) { const spark = [at, event[0], event[2], event[4]]; here.push(spark); kept.push(spark); } else here[here.length - 1][3] += event[4];
  }
  return kept;
}

// Bars for the timeline, each a share of the tallest. Square root, so one busy minute doesn't flatten the rest. Gaps stay
// empty, because nothing happened in them.
export function activityBars(events, timeline, count = BAR_COUNT) {
  const bars = new Array(count).fill(0);
  for (const event of events) bars[Math.min(count - 1, Math.floor(fractionAt(timeline, event[1]) * count))] += event[4];
  const top = Math.max(1, ...bars);
  return bars.map((v) => (v ? Math.max(0.08, Math.sqrt(v / top)) : 0));
}

// `working`, `blocked`, `waiting` or `done`, or null before it starts. `marks` are [from, to, "b" or "w"], sorted.
export function stateAt(agent, t) {
  if (t < agent.start) return null;
  if (t >= agent.end) return "done";
  const marks = agent.marks ?? [];
  let low = 0, high = marks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, mark = marks[middle];
    if (t < mark[0]) high = middle - 1;
    else if (t >= mark[1]) low = middle + 1;
    else return mark[2] === "b" ? "blocked" : "waiting";
  }
  return "working";
}

// What sits where. One session with subagents is the middle, and they go on the orbit. Otherwise the sessions go on the
// orbit, with their subagents as arcs round them. Everyone gets a place: the map shrinks its nodes to fit, see `geometry`.
export function placeAgents(agents) {
  const sessions = [], kidsOf = new Map();
  agents.forEach((agent, i) => {
    if (agent.parent < 0) sessions.push(i);
    else { if (!kidsOf.has(agent.parent)) kidsOf.set(agent.parent, []); kidsOf.get(agent.parent).push(i); }
  });
  const lead = sessions.length === 1 && kidsOf.has(sessions[0]) ? sessions[0] : -1;
  const orbit = lead >= 0 ? kidsOf.get(lead) : sessions;
  const slots = orbit.map((agent) => ({ agent, kids: lead >= 0 ? [] : (kidsOf.get(agent) ?? []) }));
  const slotOf = new Array(agents.length).fill(-1);
  slots.forEach((slot, i) => {
    slotOf[slot.agent] = i;
    if (lead < 0) for (const kid of slot.kids) slotOf[kid] = i;
  });
  return { lead, slots, slotOf };
}

// The whole of the preparing, as small steps that can each run again, because Herdr stops a task that runs too long.
export function prepareSteps(data) {
  const made = { data, drawn: {} };
  const steps = [
    () => { made.index = indexCounts(data.events); },
    () => { made.perAgent = indexByAgent(data.events, data.agents.length); },
    () => { made.timeline = compress(made.index.times, data.span); },
    () => { made.place = placeAgents(data.agents); },
    () => { made.bars = activityBars(data.events, made.timeline); },
    ...DURATIONS.map((d) => () => { made.drawn[d.key] = thinForDrawing(data.events, made.timeline, d.ms); }),
  ];
  return { made, steps };
}

export function prepare(data) {
  const { made, steps } = prepareSteps(data);
  for (const step of steps) step();
  return made;
}

const LABEL = 118;
const HUB_SHARE = 0.25;
const EDGE = 58;
const DENSE_EDGE = 20;
const TOP = -Math.PI / 2;

// The map for `count` places. Up to LABELLED places each node has a label. Past that the map is dense: no labels, the
// orbit moves out to the edge, and nodes shrink so every agent fits on the circle without touching the next.
export function geometry(size, count = 1) {
  const centre = size / 2, dense = count > LABELLED, hub = Math.max(56, Math.round(size * HUB_SHARE));
  const orbit = centre - (dense ? DENSE_EDGE : EDGE), room = (2 * Math.PI * orbit) / Math.max(1, count);
  return { size, centre, orbit, hub, dense, nodeMax: Math.max(4, Math.min(30, Math.floor(room * 0.7))) };
}

// Where place `i` of `count` sits. The first is at twelve o'clock, then clockwise.
export function slotPoint(i, count, geo) {
  const angle = (i / Math.max(1, count)) * 2 * Math.PI + TOP;
  return { x: geo.centre + geo.orbit * Math.cos(angle), y: geo.centre + geo.orbit * Math.sin(angle), angle };
}

// A node's width in px. It grows with the calls it has made so far, up to `max`, which a crowded orbit makes smaller.
export const nodeSize = (calls, max = 30) => {
  const top = Math.min(30, max), low = Math.min(18, top);
  return Math.round(Math.max(low, Math.min(top, 18 + Math.sqrt(Math.max(0, calls)) * 0.7)));
};

// A label sits outside its node: above one in the top half, below one in the bottom half, never off the map.
export function labelSpot(point, node, geo) {
  const above = point.y < geo.centre - geo.orbit * 0.25;
  const left = Math.max(2, Math.min(geo.size - LABEL - 2, point.x - LABEL / 2));
  return { left, top: above ? point.y - node / 2 - 33 : point.y + node / 2 + 5, width: LABEL };
}

const SAG_PX = 0.25;

// Points along a circle, close enough together to read as round.
export function arcPoints(cx, cy, radius, from, to) {
  const span = Math.abs(to - from), step = radius > 0 ? 2 * Math.acos(Math.max(-1, 1 - SAG_PX / radius)) : span;
  const steps = Math.max(1, Math.ceil(span / (step || span || 1))), points = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return points;
}

// `count` equal arcs round a circle, as [from, to] in radians, each centred on the place of the same number.
export function segments(count, gap) {
  const step = (2 * Math.PI) / Math.max(1, count), half = (step * (1 - gap)) / 2;
  return Array.from({ length: count }, (_, i) => [TOP + i * step - half, TOP + i * step + half]);
}

// A faint field of stars. The same seed always gives the same sky.
export function starField(size, count) {
  const stars = [];
  let v = 7;
  const next = () => { v = (v * 16807) % 2147483647; return v / 2147483647; };
  for (let i = 0; i < count; i++) stars.push({ x: next() * size, y: next() * size, bright: next() > 0.72 });
  return stars;
}

// The two ends of a spoke, stopping short of the middle and the node.
export function spokeEnds(point, geo, node) {
  const dx = point.x - geo.centre, dy = point.y - geo.centre, length = Math.hypot(dx, dy) || 1;
  const at = (distance) => [geo.centre + (dx / length) * distance, geo.centre + (dy / length) * distance];
  return [at(geo.hub / 2 + 11), at(length - node / 2 - 2)];
}

const TOOL_TONE = {
  Read: "read", Grep: "read", Glob: "read", LS: "read", NotebookRead: "read", WebFetch: "read", WebSearch: "read",
  Bash: "shell", BashOutput: "shell", Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Agent: "agent", Task: "agent", SendMessage: "agent", Skill: "agent",
};
export const toneOf = (tool) => TOOL_TONE[tool] ?? "tool";

// The sparks in flight at this place in the clip, newest last. A spark's place comes from the clip alone, so a paused or
// dragged replay shows the same sparks a playing one does. `id` stays the same for its whole flight.
export function sparksAt(drawn, fraction, durationMs, limit = MAX_SPARKS) {
  const reach = FLIGHT_MS / durationMs, out = [];
  let low = 0, high = drawn.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (drawn[middle][0] <= fraction) low = middle + 1; else high = middle;
  }
  for (let i = low - 1; i >= 0 && out.length < limit; i--) {
    const spark = drawn[i], flown = (fraction - spark[0]) / reach;
    if (flown >= 1) break;
    out.push({ id: i, agent: spark[1], tool: spark[2], calls: spark[3], flown });
  }
  return out.reverse();
}

// Which way a spark goes. A node's calls go in along its spoke. The lead's go out to the place that started last.
export function sparkRoute(agent, place, shown) {
  const slot = place.slotOf[agent];
  if (slot >= 0) return { slot, inward: true };
  return shown.length ? { slot: shown[shown.length - 1], inward: false } : null;
}

// Everything drawn at one place in the clip, with no colours and no pixels but `geo`'s.
export function sceneAt(made, fraction, durationMs, geo) {
  const { data, timeline, place, index } = made, t = timeAt(timeline, fraction), tally = { working: 0, blocked: 0, waiting: 0, done: 0 };
  const states = data.agents.map((agent) => {
    const state = stateAt(agent, t);
    if (state) tally[state] += 1;
    return state;
  });
  const count = place.slots.length, shown = [];
  const nodes = place.slots.map((slot, i) => {
    const agent = data.agents[slot.agent], state = states[slot.agent];
    if (!state) return null;
    shown.push(i);
    const point = slotPoint(i, count, geo), sinceStart = (fraction - fractionAt(timeline, agent.start)) * durationMs;
    return {
      i, ...point, state, name: agent.name, size: nodeSize(countsAt(made.perAgent[slot.agent], t).calls, geo.nodeMax ?? 30), opacity: Math.max(0.2, Math.min(1, sinceStart / FADE_IN_MS)),
      kids: slot.kids.map((kid) => states[kid]).filter(Boolean),
    };
  }).filter(Boolean);
  const counts = countsAt(index, t), latest = counts.last >= 0 ? data.events[counts.last] : null;
  const sparks = [];
  // At the end of the clip nothing is left in the air.
  for (const spark of fraction >= 1 ? [] : sparksAt(made.drawn[durationKey(durationMs)], fraction, durationMs)) {
    const route = sparkRoute(spark.agent, place, shown), node = route && nodes.find((n) => n.i === route.slot);
    if (!node) continue;
    const [near, far] = spokeEnds(node, geo, node.size), [from, to] = route.inward ? [far, near] : [near, far];
    sparks.push({ id: spark.id, x: from[0] + (to[0] - from[0]) * spark.flown, y: from[1] + (to[1] - from[1]) * spark.flown, tone: toneOf(data.tools[spark.tool]), opacity: 1 - spark.flown * 0.7, big: spark.calls > 1 });
  }
  return {
    t, nodes, sparks, tally, running: tally.working + tally.blocked + tally.waiting, gap: gapAt(timeline, fraction),
    calls: counts.calls, files: counts.files, leadState: place.lead >= 0 ? states[place.lead] : null,
    latest: latest && { tool: data.tools[latest[2]], file: latest[3] >= 0 ? data.files[latest[3]] : null, agent: data.agents[latest[0]].name },
  };
}

export const durationKey = (ms) => (DURATIONS.find((d) => d.ms === ms) ?? DURATIONS[0]).key;

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shifted = (ms, offsetMin) => new Date(ms + offsetMin * 60000);

// Clock times use the offset the run was read with, so the overlay and a page opened elsewhere read the same.
export function clockText(ms, offsetMin) {
  const d = shifted(ms, offsetMin);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function dayText(ms, offsetMin) {
  const d = shifted(ms, offsetMin);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// "9h", "9h 20m", "42m", or "30s".
export function spanText(ms) {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) return `${Math.round(Math.max(0, ms) / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export const countText = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// "0:12", for the time in the clip.
export function clipText(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

export const idleText = (gap) => `${spanText(gap.to - gap.from)} with no tool calls`;

// What a spark is worth, so a thinned replay says so.
export function thinText(total, drawn) {
  if (!drawn || total <= drawn) return "One spark for each tool call.";
  if (Math.round(total / drawn) < 2) return "One spark for one or two tool calls. The counters are the real totals.";
  return `One spark for about ${countText(total / drawn)} tool calls. The counters are the real totals.`;
}

const STATE_WORDS = { working: "Working", blocked: "Blocked", waiting: "Waiting", done: "Done" };
export const stateWord = (state) => STATE_WORDS[state] ?? "";

export function tallyText(tally) {
  return ["working", "blocked", "waiting", "done"].filter((s) => tally[s]).map((s) => `${tally[s]} ${s}`).join(", ");
}

// The gaps long enough to name on the timeline, longest first, with neighbours that would collide left out.
export function gapLabels(timeline, width, room = 84, max = 6) {
  const picked = [];
  for (const gap of [...timeline.gaps].sort((a, b) => b.to - b.from - (a.to - a.from))) {
    const x = ((gap.x0 + gap.x1) / 2) * width;
    if (picked.length < max && picked.every((p) => Math.abs(p.x - x) >= room)) picked.push({ x, text: spanText(gap.to - gap.from) });
  }
  return picked.sort((a, b) => a.x - b.x);
}

// How far along a strip a press landed, as a share. A press's position and bounds are both window pixels, so the share
// holds at any zoom.
export function pressShare(x, left, width) {
  if (!Number.isFinite(x) || !(width > 0)) return null;
  return Math.max(0, Math.min(1, (x - left) / width));
}
