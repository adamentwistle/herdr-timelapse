// The replay's maths: compressing gaps, mapping time, thinning, states and places on the orbit.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FLIGHT_MS, LABELLED, MAX_SPARKS, SPARKS_PER_SLOT, SPARK_RATE, activityBars, clipText, clockText, compress, countText, countsAt, dayText, fractionAt, gapAt, gapLabels,
  geometry, idleText, indexByAgent, indexCounts, placeAgents, prepare, prepareSteps, pressShare, sceneAt, spanText, sparkRoute, sparksAt, stateAt, tallyText, thinForDrawing, thinText, timeAt, toneOf,
} from "../mods/timelapse/timeline.js";

const MIN = 60000, HOUR = 60 * MIN;
const event = (t, agent = 0, calls = 1, files = 0) => [agent, t, 0, -1, calls, files];
// Calls five minutes apart from one time to another, so the stretch has no gap in it.
const busy = (from, to) => { const out = []; for (let t = from; t <= to; t += 5 * MIN) out.push(t); return out; };
const close = (a, b, slack = 1e-9) => assert.ok(Math.abs(a - b) <= slack, `${a} is near ${b}`);

test("a run with no long silence isn't compressed", () => {
  const timeline = compress([0, 5 * MIN, 9 * MIN, 18 * MIN], 20 * MIN);
  assert.equal(timeline.gaps.length, 0);
  close(fractionAt(timeline, 5 * MIN), 0.25);
});

test("a long silence becomes a marked gap with a small fixed share", () => {
  const timeline = compress([...busy(0, HOUR), ...busy(4 * HOUR, 5 * HOUR)], 5 * HOUR);
  assert.equal(timeline.gaps.length, 1);
  const [gap] = timeline.gaps;
  assert.deepEqual([gap.from, gap.to], [HOUR, 4 * HOUR]);
  close(gap.x1 - gap.x0, 0.03);
  // The two busy hours share the rest evenly.
  close(fractionAt(timeline, HOUR), 0.485);
  close(fractionAt(timeline, 4 * HOUR), 0.515);
  assert.equal(gapAt(timeline, 0.5), gap);
  assert.equal(gapAt(timeline, 0.2), null);
});

test("a gap's length doesn't change its share", () => {
  const short = compress([...busy(0, HOUR), ...busy(HOUR + 20 * MIN, 2 * HOUR)], 2 * HOUR), long = compress([...busy(0, HOUR), ...busy(9 * HOUR, 10 * HOUR)], 10 * HOUR);
  close(short.gaps[0].x1 - short.gaps[0].x0, long.gaps[0].x1 - long.gaps[0].x0);
});

test("silence at the start and the end counts too", () => {
  const timeline = compress([HOUR, HOUR + MIN], 3 * HOUR);
  assert.equal(timeline.gaps.length, 2);
  close(timeline.segments[0].x0, 0);
  close(timeline.segments.at(-1).x1, 1);
});

test("many gaps can't take over the clip", () => {
  const times = Array.from({ length: 41 }, (_, i) => busy(i * HOUR, i * HOUR + 10 * MIN)).flat();
  const timeline = compress(times, 40 * HOUR + 10 * MIN);
  assert.equal(timeline.gaps.length, 40);
  assert.ok(timeline.gaps.reduce((sum, g) => sum + g.x1 - g.x0, 0) <= 0.24 + 1e-9);
});

test("the clip's shares cover 0 to 1 with no holes", () => {
  const timeline = compress([0, 3, HOUR, HOUR + 5, 3 * HOUR, 3 * HOUR + 40 * MIN, 4 * HOUR], 4 * HOUR);
  let x = 0;
  for (const s of timeline.segments) { close(s.x0, x, 1e-9); x = s.x1; }
  assert.equal(x, 1);
});

test("time maps to the clip and back, always forwards", () => {
  const timeline = compress([...busy(0, 20 * MIN), ...busy(3 * HOUR, 3 * HOUR + 15 * MIN), ...busy(7 * HOUR, 9 * HOUR)], 9 * HOUR);
  assert.equal(timeline.gaps.length, 2);
  let before = -1;
  for (let t = 0; t <= 9 * HOUR; t += 7 * MIN) {
    const f = fractionAt(timeline, t);
    assert.ok(f >= before, `${f} after ${before}`);
    before = f;
    close(timeAt(timeline, f), t, 1);
  }
  assert.equal(fractionAt(timeline, -5), 0);
  assert.equal(fractionAt(timeline, 99 * HOUR), 1);
  assert.equal(timeAt(timeline, 0), 0);
  assert.equal(timeAt(timeline, 1), 9 * HOUR);
});

test("a run of one moment doesn't divide by nothing", () => {
  const timeline = compress([0], 0);
  assert.equal(fractionAt(timeline, 0), 0);
  assert.equal(timeAt(timeline, 0.5), 0);
});

test("a run that is all one silence still fills the clip", () => {
  const timeline = compress([], HOUR);
  assert.equal(timeline.gaps.length, 1);
  assert.equal(timeAt(timeline, 1), HOUR);
});

test("counters read real totals, including what a thinned event stands for", () => {
  const index = indexCounts([event(10, 0, 3, 1), event(20, 1, 1, 0), event(30, 0, 5, 2)]);
  assert.deepEqual(countsAt(index, 5), { calls: 0, files: 0, last: -1 });
  assert.deepEqual(countsAt(index, 20), { calls: 4, files: 1, last: 1 });
  assert.deepEqual(countsAt(index, 99), { calls: 9, files: 3, last: 2 });
});

test("each agent's own counts come from one pass", () => {
  const index = indexByAgent([event(10, 0, 3), event(20, 1, 2), event(30, 0, 1)], 3);
  assert.equal(countsAt(index[0], 99).calls, 4);
  assert.equal(countsAt(index[1], 99).calls, 2);
  assert.equal(countsAt(index[2], 99).calls, 0);
});

test("thinning for drawing bounds the sparks and keeps every call", () => {
  const events = Array.from({ length: 50000 }, (_, i) => event(i * 600, i % 5));
  const span = 50000 * 600, timeline = compress(events.map((e) => e[1]), span), duration = 30000;
  const drawn = thinForDrawing(events, timeline, duration);
  assert.ok(drawn.length <= 30 * SPARK_RATE * SPARKS_PER_SLOT, `${drawn.length} sparks`);
  assert.equal(drawn.reduce((sum, s) => sum + s[3], 0), 50000);
  assert.ok(new Set(drawn.map((s) => s[1])).size === 5, "every agent still fires");
  for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i][0] >= drawn[i - 1][0]);
});

test("a quiet run keeps every spark", () => {
  const events = [event(0), event(HOUR / 2), event(HOUR)];
  assert.equal(thinForDrawing(events, compress([0, HOUR / 2, HOUR], HOUR), 30000).length, 3);
});

test("the timeline's bars are empty in a gap", () => {
  const events = [...busy(0, HOUR), ...busy(4 * HOUR, 5 * HOUR)].map((t) => event(t));
  const timeline = compress(events.map((e) => e[1]), 5 * HOUR), bars = activityBars(events, timeline, 100);
  const [gap] = timeline.gaps;
  assert.equal(bars[Math.floor(gap.x0 * 100) + 1], 0);
  assert.ok(bars[0] > 0);
  assert.equal(Math.max(...bars), 1);
});

test("a node's state follows its marks", () => {
  const agent = { start: 100, end: 1000, marks: [[200, 300, "w"], [400, 500, "b"]] };
  assert.equal(stateAt(agent, 50), null);
  assert.equal(stateAt(agent, 150), "working");
  assert.equal(stateAt(agent, 200), "waiting");
  assert.equal(stateAt(agent, 300), "working");
  assert.equal(stateAt(agent, 450), "blocked");
  assert.equal(stateAt(agent, 1000), "done");
});

const agentsOf = (...parents) => parents.map((parent, i) => ({ name: `a${i}`, parent, calls: i, start: 0, end: 10, marks: [] }));

test("one session with subagents is the middle", () => {
  const place = placeAgents(agentsOf(-1, 0, 0));
  assert.equal(place.lead, 0);
  assert.deepEqual(place.slots.map((s) => s.agent), [1, 2]);
  assert.equal(place.slotOf[0], -1);
});

test("several sessions go on the orbit with their subagents as arcs", () => {
  const place = placeAgents(agentsOf(-1, -1, 0, 1));
  assert.equal(place.lead, -1);
  assert.deepEqual(place.slots.map((s) => [s.agent, s.kids]), [[0, [2]], [1, [3]]]);
  assert.deepEqual(place.slotOf, [0, 1, 0, 1]);
});

test("a lone session sits on the orbit, not alone in the middle", () => {
  const place = placeAgents(agentsOf(-1));
  assert.equal(place.lead, -1);
  assert.equal(place.slots.length, 1);
});

test("every agent gets a place on the orbit, however many there are", () => {
  const place = placeAgents(agentsOf(...Array(30).fill(-1)));
  assert.equal(place.slots.length, 30);
  assert.deepEqual(place.slotOf, [...Array(30).keys()]);
  const kids = placeAgents(agentsOf(-1, -1, ...Array(20).fill(0)));
  assert.equal(kids.slots[0].kids.length, 20);
});

test("a crowded orbit drops labels and shrinks nodes so neighbours don't touch", () => {
  assert.equal(geometry(480, LABELLED).dense, false);
  for (const count of [13, 40, 100]) {
    for (const size of [280, 500]) {
      const geo = geometry(size, count), room = (2 * Math.PI * geo.orbit) / count;
      assert.equal(geo.dense, true);
      assert.ok(geo.orbit + geo.nodeMax / 2 <= size / 2, "nodes stay on the map");
      if (count <= 100 && size >= 500) assert.ok(geo.nodeMax < room, `${count} at ${size}: ${geo.nodeMax} in ${room}`);
    }
  }
});

test("every agent of a big run is drawn", () => {
  const agents = Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, parent: -1, calls: 10, start: 0, end: 1000, marks: [] }));
  const made = prepare({ start: 0, span: 1000, offsetMin: 0, agents, tools: ["Read"], files: [], events: agents.map((_, i) => [i, 10, 0, -1, 10, 0]), totals: { calls: 400, files: 0 } });
  const scene = sceneAt(made, 0.99, 30000, geometry(480, made.place.slots.length));
  assert.equal(scene.nodes.length, 40);
  assert.ok(scene.nodes.every((n) => n.size <= geometry(480, 40).nodeMax));
});

test("sparks in the air depend only on the place in the clip", () => {
  const drawn = [[0.1, 0, 0, 1], [0.11, 1, 0, 1], [0.5, 0, 0, 1]], duration = 30000, reach = FLIGHT_MS / duration;
  assert.deepEqual(sparksAt(drawn, 0.105, duration).map((s) => s.id), [0]);
  assert.deepEqual(sparksAt(drawn, 0.112, duration).map((s) => s.id), [0, 1]);
  assert.deepEqual(sparksAt(drawn, 0.3, duration), []);
  close(sparksAt(drawn, 0.5 + reach / 2, duration)[0].flown, 0.5);
});

test("a busy moment stays under the spark limit, keeping the newest", () => {
  const drawn = Array.from({ length: 100 }, (_, i) => [0.5 + i / 100000, 0, 0, 1]);
  const sparks = sparksAt(drawn, 0.502, 30000);
  assert.equal(sparks.length, MAX_SPARKS);
  assert.equal(sparks.at(-1).id, 99);
});

test("a node's calls go in, and the lead's go out to the newest place", () => {
  const place = { slotOf: [-1, 0, 1] };
  assert.deepEqual(sparkRoute(1, place, [0, 1]), { slot: 0, inward: true });
  assert.deepEqual(sparkRoute(0, place, [0, 1]), { slot: 1, inward: false });
  assert.equal(sparkRoute(0, place, []), null);
});

const run = () => ({
  folder: "lantern", start: 0, span: 5 * HOUR, offsetMin: 0, tools: ["Read", "Edit"], files: ["lamp.ts"], totals: { calls: 12, files: 1, agents: 3 },
  agents: [
    { name: "lantern", parent: -1, start: 0, end: 5 * HOUR, calls: 5, marks: [[HOUR, 4 * HOUR, "w"]] },
    { name: "fix-login", parent: -1, start: 30 * MIN, end: HOUR, calls: 2, marks: [] },
    { name: "Explore", parent: 0, start: 4 * HOUR, end: 4 * HOUR + MIN, calls: 1, marks: [] },
  ],
  events: [[0, 0, 0, 0, 1, 1], [0, 9 * MIN, 1, 0, 1, 0], [0, 18 * MIN, 1, -1, 1, 0], [1, 27 * MIN, 0, -1, 1, 0], [1, 36 * MIN, 0, -1, 1, 0], [0, 45 * MIN, 0, -1, 1, 0], [1, 54 * MIN, 1, -1, 1, 0],
    [1, HOUR, 1, -1, 1, 0], [0, 4 * HOUR, 0, -1, 1, 0], [2, 4 * HOUR + MIN, 0, -1, 1, 0], [0, 4 * HOUR + 9 * MIN, 0, -1, 1, 0], [0, 4 * HOUR + 18 * MIN, 0, -1, 1, 0]],
});

test("the scene adds up as the clip goes", () => {
  const made = prepare(run()), geo = geometry(480), at = (t) => sceneAt(made, fractionAt(made.timeline, t), 30000, geo);
  const start = at(1);
  assert.equal(start.nodes.length, 1);
  assert.equal(start.calls, 1);
  const both = at(40 * MIN);
  assert.equal(both.nodes.length, 2);
  assert.equal(both.running, 2);
  const [gap] = made.timeline.gaps, idle = sceneAt(made, (gap.x0 + gap.x1) / 2, 30000, geo);
  assert.ok(idle.gap, "the middle of the gap is inside it");
  assert.deepEqual(idle.tally, { working: 0, blocked: 0, waiting: 1, done: 1 });
  const end = sceneAt(made, 1, 30000, geo);
  assert.equal(end.calls, 12);
  assert.equal(end.files, 1);
  assert.equal(end.tally.done, 3);
  assert.deepEqual(end.sparks, []);
});

test("the same place in the clip always draws the same scene", () => {
  const made = prepare(run()), geo = geometry(480);
  assert.deepEqual(sceneAt(made, 0.3, 60000, geo), sceneAt(made, 0.3, 60000, geo));
});

test("the preparing can run a step twice and come out the same", () => {
  const { made, steps } = prepareSteps(run());
  for (const step of steps) { step(); step(); }
  assert.deepEqual(made.bars, prepare(run()).bars);
  assert.deepEqual(made.drawn, prepare(run()).drawn);
});

test("words", () => {
  assert.equal(spanText(9 * HOUR), "9h");
  assert.equal(spanText(9 * HOUR + 12 * MIN), "9h 12m");
  assert.equal(spanText(42 * MIN), "42m");
  assert.equal(spanText(29000), "29s");
  assert.equal(countText(1234567), "1,234,567");
  assert.equal(clipText(72000), "1:12");
  assert.equal(clockText(Date.UTC(2026, 10, 6, 2, 5), 60), "03:05");
  assert.equal(dayText(Date.UTC(2026, 10, 6, 23, 30), 60), "Sat 7 Nov");
  assert.equal(idleText({ from: 0, to: 3 * HOUR }), "3h with no tool calls");
  assert.equal(tallyText({ working: 2, blocked: 0, waiting: 1, done: 0 }), "2 working, 1 waiting");
  assert.equal(thinText(10, 10), "One spark for each tool call.");
  assert.equal(thinText(1000, 100), "One spark for about 10 tool calls. The counters are the real totals.");
  assert.equal(thinText(120, 100), "One spark for one or two tool calls. The counters are the real totals.");
  assert.equal(toneOf("Edit"), "write");
  assert.equal(toneOf("something_else"), "tool");
});

test("a press is a share of the strip at any zoom", () => {
  assert.equal(pressShare(150, 100, 200), 0.25);
  assert.equal(pressShare(50, 100, 200), 0);
  assert.equal(pressShare(900, 100, 200), 1);
  assert.equal(pressShare(NaN, 0, 200), null);
  assert.equal(pressShare(10, 0, 0), null);
});

test("gap labels leave out neighbours that would collide", () => {
  const timeline = compress([...busy(0, HOUR), ...busy(2 * HOUR, 2 * HOUR + 5 * MIN), ...busy(3 * HOUR, 4 * HOUR), ...busy(9 * HOUR, 10 * HOUR)], 10 * HOUR);
  assert.equal(timeline.gaps.length, 3);
  const labels = gapLabels(timeline, 200);
  assert.ok(labels.length < 3);
  assert.ok(labels.some((l) => l.text === "5h"), "the longest is kept");
  assert.equal(gapLabels(timeline, 4000).length, 3);
  for (let i = 1; i < labels.length; i++) assert.ok(labels[i].x - labels[i - 1].x >= 84);
});
