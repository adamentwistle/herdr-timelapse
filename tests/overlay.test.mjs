// Runs main.js and view.js against the stand-ins in stubs.mjs: every state the overlay can be in, and every control.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fakeCx, world } from "./stubs.mjs";

const { default: TimeLapse } = await import("../mods/timelapse/main.js");
const { TICK_MS, advance, exportFacts, helperArgs, helperReply, leftOutText, pageColours, readStep } = await import("../mods/timelapse/logic.js");

const HOUR = 3600000, NOW = Date.UTC(2026, 10, 6, 12), START = Date.UTC(2026, 10, 5, 22);
const session = (id, from, to, calls, agents = 1, folder = "lantern") => ({ id, key: folder, folder, spans: [[from, to, calls, agents]] });
const scanned = (sessions, more = {}) => ({ partial: false, read: 2, total: 2, leftOut: 0, leftOff: 0, now: NOW, offsetMin: 0, sessions, ...more });
const reply = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

// A run with `agents` sessions on the orbit, each with a subagent, and a gap in the middle.
function bigRun(agents = 2, events = 200) {
  const list = [];
  for (let i = 0; i < agents; i++) list.push({ name: `agent ${i}`, parent: -1, start: i * 1000, end: 9 * HOUR, calls: events, marks: [[HOUR, HOUR + 60000, "b"]] });
  for (let i = 0; i < agents; i++) list.push({ name: `kid ${i}`, parent: i, start: i * 2000, end: 8 * HOUR, calls: 1, marks: [] });
  const rows = [];
  for (let i = 0; i < events; i++) rows.push([i % agents, i < events / 2 ? i * 20000 : 6 * HOUR + i * 20000, i % 3, i % 5 === 0 ? 0 : -1, 1, i === 0 ? 1 : 0]);
  return { folder: "lantern", start: START, span: 9 * HOUR, offsetMin: 0, agents: list, tools: ["Read", "Edit", "Bash"], files: ["lamp.ts"], events: rows, totals: { calls: events, files: 1, agents: list.length } };
}
const replayed = (run = bigRun()) => ({ partial: false, read: 2, total: 2, leftOut: 0, run });

// Answers each exec in turn and keeps what it was asked.
function script(...answers) {
  const asked = [];
  world.exec = async (command, args) => {
    asked.push({ command, args });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? reply({ error: "asked once too often" });
  };
  return asked;
}

async function open(props = {}) {
  world.props = props;
  const view = new TimeLapse(), cx = fakeCx();
  view.init(props, cx);
  await cx.settled();
  await cx.settled();
  return { view, cx, tree: () => view.render() };
}

const playingNow = (cx) => cx.repeating.filter((task) => task.ms === TICK_MS && !task.cancelled);

async function press(tree, id, cx) {
  const target = tree().find(id);
  assert.ok(target, `${id} is on screen`);
  assert.ok(target.press, `${id} can be pressed`);
  target.press({}, cx);
  await cx.settled();
}

const oneRun = () => [reply(scanned([session("a", START, START + 9 * HOUR, 200, 2), session("b", START + HOUR, START + 2 * HOUR, 3)])), reply(replayed())];

test("it opens on the latest big run and plays", async () => {
  const asked = script(...oneRun());
  const { tree, view, cx } = await open();
  assert.equal(asked[0].command, "python3");
  assert.ok(asked[0].args.includes("scan"));
  assert.ok(asked[1].args.includes("replay"));
  assert.equal(asked[1].args[asked[1].args.indexOf("--ids") + 1].split(",").sort().join(), "a,b");
  assert.ok(view.playing);
  assert.equal(playingNow(cx).length, 1);
  const text = tree().text();
  assert.match(text, /lantern, last night, 9h, 3 agents/);
  assert.match(text, /Tool calls/);
  assert.match(text, /Files/);
  assert.match(text, /22:00 to 07:00/);
});

test("the clock and counters run along, and the end stops the timer", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  view.fraction = 0.25;
  assert.notEqual(tree().text(), (view.fraction = 0.7, tree().text()));
  view.fraction = 0.9999; view.lastTick = Date.now() - 300;
  playingNow(cx)[0].handler(cx);
  assert.equal(view.fraction, 1);
  assert.equal(view.playing, false);
  assert.equal(playingNow(cx).length, 0);
  assert.match(tree().text(), /Replay/);
  assert.match(tree().text(), /200/);
});

test("pause stops the timer, and nothing ticks while paused", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  await press(tree, "play", cx);
  assert.equal(view.playing, false);
  assert.equal(playingNow(cx).length, 0);
  const notified = cx.notified;
  for (const task of cx.repeating.filter((t) => !t.cancelled)) task.handler(cx);
  assert.equal(cx.notified, notified, "the retry timer draws only when a render didn't finish");
  await press(tree, "play", cx);
  assert.equal(playingNow(cx).length, 1);
});

test("a render that was stopped is asked for again", async () => {
  script(...oneRun());
  const { view, cx } = await open();
  const retry = cx.repeating.find((task) => task.ms === 1000), notified = cx.notified;
  view.drawing = true;
  retry.handler(cx);
  assert.equal(cx.notified, notified + 1);
});

test("preparing a run starts again from the step that was stopped", async () => {
  script(...oneRun());
  const { view, cx } = await open();
  const made = view.made;
  let tries = 0;
  view.stop();
  view.made = null;
  view.prep = { made, steps: [() => { tries += 1; if (tries === 1) throw new Error("interrupted"); }], next: 0, touched: 0 };
  view.pump(cx);
  await assert.rejects(cx.settled(), /interrupted/);
  view.prep.touched = 0;
  view.recover(cx);
  await cx.settled();
  assert.equal(tries, 2);
  assert.equal(view.made, made);
});

test("the three clip lengths can be picked", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  for (const [id, ms] of [["duration-60", 60000], ["duration-120", 120000], ["duration-30", 30000]]) {
    await press(tree, id, cx);
    assert.equal(view.duration, ms);
  }
  assert.match(tree().text(), /30 s/);
  assert.match(tree().text(), /2 min/);
});

test("dragging moves the clip, holds the timer and picks up after", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  const strip = tree().find("strip"), root = tree();
  strip.handlers.down({ position: { x: 120 }, local_position: { x: 100 }, bounds: { width: 400 } }, { ...cx, notify() {}, stop_propagation() {}, timer: cx.timer });
  assert.equal(view.fraction, 0.25);
  assert.equal(view.playing, false);
  root.handlers.move({ position: { x: 320 } }, cx);
  assert.equal(view.fraction, 0.75);
  root.handlers.move({ position: { x: 900 } }, cx);
  assert.equal(view.fraction, 1);
  root.handlers.move({ position: { x: 220 } }, cx);
  root.handlers.up({}, cx);
  assert.equal(view.drag, null);
  assert.equal(view.playing, true);
  root.handlers.move({ position: { x: 20 } }, cx);
  assert.equal(view.fraction, 0.5, "a move after letting go does nothing");
});

test("leaving the overlay mid-drag lets go", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  tree().find("strip").handlers.down({ position: { x: 120 }, local_position: { x: 100 }, bounds: { width: 400 } }, cx);
  tree().handlers.hover(false, cx);
  assert.equal(view.drag, null);
});

test("space pauses, and the arrows step", async () => {
  script(...oneRun());
  const { tree, view, cx } = await open();
  tree().handlers.key({ key: "space" }, cx);
  assert.equal(view.playing, false);
  tree().handlers.key({ key: "right" }, cx);
  assert.equal(view.fraction, 0.02);
  const stopped = cx.stopped;
  tree().handlers.key({ key: "escape" }, cx);
  assert.equal(cx.stopped, stopped, "Esc is left for Herdr, which closes the overlay");
});

test("an idle gap is marked on the map and on the timeline", async () => {
  script(...oneRun());
  const { tree, view } = await open();
  const [gap] = view.made.timeline.gaps;
  assert.ok(gap, "the run has a gap");
  view.fraction = (gap.x0 + gap.x1) / 2;
  assert.match(tree().text(), /with no tool calls/);
  assert.match(tree().text(), /idle/);
});

test("the list shows runs by folder and time, and opens one", async () => {
  const asked = script(reply(scanned([session("a", START, START + 9 * HOUR, 200, 6), session("c", START - 72 * HOUR, START - 70 * HOUR, 40, 2, "tidepool")], { leftOut: 1 })), reply(replayed()), reply(replayed()));
  const { tree, view, cx } = await open();
  await press(tree, "runs", cx);
  assert.equal(view.page, "runs");
  assert.equal(view.playing, false);
  const text = tree().text();
  assert.match(text, /tidepool/);
  assert.match(text, /Agents/);
  assert.match(text, /Tool calls/);
  assert.match(text, /1 transcript couldn't be read/);
  await press(tree, `run-tidepool-${START - 72 * HOUR}`, cx);
  await cx.settled();
  assert.equal(view.page, "replay");
  assert.equal(view.run.folder, "tidepool");
  assert.ok(asked[2].args.includes("c"));
});

test("Export says what the file holds and writes nothing until Save", async () => {
  const asked = script(...oneRun(), reply({ partial: false, saved: "/h/Downloads/time-lapse-lantern-2026-11-05.html", bytes: 100 }));
  const { tree, view, cx } = await open();
  await press(tree, "export", cx);
  assert.equal(view.page, "export");
  assert.equal(asked.length, 2, "no helper call yet");
  const text = tree().text();
  assert.match(text, /What this file holds/);
  assert.match(text, /The folder name: lantern/);
  assert.match(text, /4 agent names/);
  assert.match(text, /3 tool names/);
  assert.match(text, /1 file base name/);
  assert.match(text, /Never prompts, tool results, file contents, commands or paths/);
  await press(tree, "save", cx);
  assert.equal(asked.length, 3);
  assert.ok(asked[2].args.includes("export"));
  assert.equal(asked[2].args[asked[2].args.indexOf("--out") + 1], "/h/Downloads");
  assert.match(tree().text(), /Saved to ~\/Downloads\/time-lapse-lantern-2026-11-05\.html/);
});

test("Cancel leaves without writing", async () => {
  const asked = script(...oneRun());
  const { tree, view, cx } = await open();
  await press(tree, "export", cx);
  await press(tree, "cancel", cx);
  assert.equal(view.page, "replay");
  assert.equal(asked.length, 2);
});

test("a failed save is named", async () => {
  script(...oneRun(), reply({ error: "PermissionError: no" }));
  const { tree, cx } = await open();
  await press(tree, "export", cx);
  await press(tree, "save", cx);
  assert.match(tree().text(), /PermissionError/);
});

test("a long history takes passes, with progress", async () => {
  const asked = script(reply({ partial: true, read: 40, total: 90, leftOut: 0 }), reply({ partial: true, read: 80, total: 90, leftOut: 0 }), ...oneRun());
  await open();
  assert.equal(asked.filter((a) => a.args.includes("scan")).length, 3);
});

test("a pass that gets no further stops and says so", async () => {
  script(reply({ partial: true, read: 40, total: 90, leftOut: 0 }), reply({ partial: true, read: 40, total: 90, leftOut: 0 }));
  const { tree } = await open();
  assert.match(tree().text(), /stopped getting further/);
});

test("no python3 is named", async () => {
  script(new Error("program not found"));
  const { tree } = await open();
  assert.match(tree().text(), /python3 couldn't start helper\.py/);
});

test("nothing to show says so", async () => {
  script(reply(scanned([])));
  const { tree } = await open();
  assert.match(tree().text(), /No runs with tool calls yet/);
});

test("demo mode says it's demo data and asks the helper for it", async () => {
  const asked = script(...oneRun());
  const { tree } = await open({ demo: true });
  assert.ok(asked.every((a) => a.args.includes("--demo")));
  assert.match(tree().text(), /Demo data/);
});

test("closing stops the timer", async () => {
  script(...oneRun());
  const { view, cx } = await open();
  await view.close();
  assert.equal(playingNow(cx).length, 0);
});

test("a render stays small however big the run is", async () => {
  script(reply(scanned([session("a", START, START + 9 * HOUR, 6000, 100)])), reply(replayed(bigRun(40, 6000))));
  const { tree, view } = await open();
  let most = 0;
  for (let f = 0; f <= 1; f += 0.01) { view.fraction = f; most = Math.max(most, tree().count()); }
  assert.ok(most <= 110, `${most} elements at the most`);
});

test("paths are kept between renders while the states hold still", async () => {
  script(...oneRun());
  const { tree, view } = await open();
  view.fraction = 0.2;
  tree();
  const built = world.paths;
  view.fraction = 0.2001;
  tree();
  assert.equal(world.paths, built);
});

test("timers only go through cx", () => {
  for (const name of readdirSync(new URL("../mods/timelapse/", import.meta.url)).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(new URL(`../mods/timelapse/${name}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\b(setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame)\b/, name);
  }
});

test("helper arguments", () => {
  const args = helperArgs("/a", "export", { demo: true, run: { ids: ["x", "y"], from: 5, to: 9 }, out: "/d", colours: { accent: "#123456" } });
  assert.deepEqual(args.slice(0, 7), ["-I", "-S", "-B", "/a/mods/timelapse/helper.py", "export", "--cache", "/a/data/timelapse"]);
  assert.deepEqual(args.slice(7), ["--demo", "--ids", "x,y", "--from", "5", "--to", "9", "--out", "/d", "--colours", '{"accent":"#123456"}']);
});

test("helper replies", () => {
  assert.deepEqual(helperReply({ code: 0, stdout: '{"a":1}' }), { value: { a: 1 }, error: null });
  assert.match(helperReply({ code: 1, stderr: "x\nboom" }).error, /code 1: boom/);
  assert.match(helperReply({ code: 0, stdout: "nope" }).error, /isn't JSON/);
  assert.equal(helperReply({ code: 0, stdout: '{"error":"no"}' }).error, "no");
});

test("small sums", () => {
  assert.equal(readStep({ partial: false }, 0), "done");
  assert.equal(readStep({ partial: true, read: 5 }, 4), "again");
  assert.equal(readStep({ partial: true, read: 4 }, 4), "stuck");
  assert.equal(advance(0, 300, 30000), 0.01);
  assert.equal(advance(0, 99999, 40000), 0.01, "a long stall can't jump the clip");
  assert.equal(advance(0.999, 400, 1000), 1);
  assert.equal(leftOutText(0, 0), null);
  assert.equal(leftOutText(2, 3), "2 transcripts couldn't be read. The oldest 3 sessions are left out.");
  assert.equal(exportFacts(bigRun()).length, 5);
  assert.equal(pageColours({ accent: "#112233ff" }).accent, "#112233ff");
});

test("a done node is dimmed with a solid colour, so the orbit behind it doesn't show through", async () => {
  const { mix } = await import("../mods/timelapse/view.js");
  assert.equal(mix("#ffffff", "#000000", 0.55), "#8c8c8c");
  assert.equal(mix("#4c8dffcc", "#101010", 1), "#4c8dff");
  assert.equal(mix("transparent", "#101010", 0.5), "transparent");
});

test("the notes on sparks and times sit in a card behind the i, not under the stats", async () => {
  script(...oneRun());
  const { tree } = await open();
  const card = tree().find("info-card");
  assert.ok(card, "there's an info card");
  assert.doesNotMatch(tree().text(), /Times come from transcript timestamps/);
  const content = card.calls.find(([name]) => name === "content")[1][0];
  assert.match(content.text(), /Times come from transcript timestamps/);
  assert.match(content.text(), /spark/);
});
