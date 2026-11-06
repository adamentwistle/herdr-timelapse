// Grouping sessions into runs, and saying which to show.
import assert from "node:assert/strict";
import test from "node:test";
import { JOIN_MS, groupRuns, latestBig, runLabel, whenText } from "../mods/timelapse/runs.js";

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const session = (id, spans, key = "k1", folder = "lantern") => ({ id, key, folder, spans });

test("sessions that overlap in one folder are one run", () => {
  const runs = groupRuns([session("a", [[0, 2 * HOUR, 10, 1]]), session("b", [[HOUR, 3 * HOUR, 5, 1]])]);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].from, runs[0].to, runs[0].calls, runs[0].agents], [0, 3 * HOUR, 15, 2]);
  assert.deepEqual(runs[0].ids.sort(), ["a", "b"]);
});

test("a chain of overlaps is one run", () => {
  const runs = groupRuns([session("a", [[0, 2 * HOUR, 1, 1]]), session("b", [[HOUR, 3 * HOUR, 1, 1]]), session("c", [[2.5 * HOUR, 4 * HOUR, 1, 1]])]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agents, 3);
});

test("a long session takes in short ones inside it, and what follows it still joins", () => {
  const runs = groupRuns([session("a", [[0, 5 * HOUR, 1, 1]]), session("b", [[HOUR, 2 * HOUR, 1, 1]]), session("c", [[4 * HOUR, 6 * HOUR, 1, 1]])]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].to, 6 * HOUR);
});

test("the same times in two folders are two runs", () => {
  const runs = groupRuns([session("a", [[0, HOUR, 1, 1]], "k1", "lantern"), session("b", [[0, HOUR, 1, 1]], "k2", "lantern")]);
  assert.equal(runs.length, 2);
});

test("sessions apart in one folder are two runs, newest first", () => {
  const runs = groupRuns([session("a", [[0, HOUR, 1, 1]]), session("b", [[3 * HOUR, 4 * HOUR, 1, 1]])]);
  assert.deepEqual(runs.map((r) => r.ids[0]), ["b", "a"]);
});

test("a transcript that starts right after another joins it, as a /clear does", () => {
  assert.equal(groupRuns([session("a", [[0, HOUR, 1, 1]]), session("b", [[HOUR + JOIN_MS, 2 * HOUR, 1, 1]])]).length, 1);
  assert.equal(groupRuns([session("a", [[0, HOUR, 1, 1]]), session("b", [[HOUR + JOIN_MS + 1, 2 * HOUR, 1, 1]])]).length, 2);
});

test("a session resumed days later gives two runs, each with only its own part", () => {
  const runs = groupRuns([session("a", [[0, HOUR, 4, 1], [5 * DAY, 5 * DAY + HOUR, 6, 1]])]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.calls), [6, 4]);
});

test("subagents count as agents, and a session in two spans of one run counts once", () => {
  const runs = groupRuns([session("a", [[0, HOUR, 4, 3], [HOUR - 1, 2 * HOUR, 6, 2]]), session("b", [[0, HOUR, 1, 1]])]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agents, 2 + 2 + 1);
});

test("a run with no tool calls isn't listed", () => {
  assert.deepEqual(groupRuns([session("a", [[0, HOUR, 0, 1]])]), []);
});

const run = (to, calls, agents, length = HOUR) => ({ from: to - length, to, calls, agents, folder: "lantern" });

test("the default is the latest big run, not the latest", () => {
  const big = run(5 * HOUR, 900, 6), small = run(9 * HOUR, 12, 1);
  assert.equal(latestBig([small, big]), big);
});

test("a long run on its own counts as big, and a short one doesn't", () => {
  const long = run(5 * HOUR, 150, 1, 2 * HOUR), short = run(9 * HOUR, 150, 1, 10 * MIN);
  assert.equal(latestBig([short, long]), long);
});

test("with nothing big, the default is the latest", () => {
  const newest = run(9 * HOUR, 5, 1);
  assert.equal(latestBig([newest, run(HOUR, 4, 1)]), newest);
  assert.equal(latestBig([]), null);
});

const NOON = Date.UTC(2026, 10, 6, 12);

test("when a run happened, in words", () => {
  assert.equal(whenText(Date.UTC(2026, 10, 5, 22, 14), NOON, 0), "last night");
  assert.equal(whenText(Date.UTC(2026, 10, 6, 1, 0), NOON, 0), "last night");
  assert.equal(whenText(Date.UTC(2026, 10, 6, 9, 0), NOON, 0), "today");
  assert.equal(whenText(Date.UTC(2026, 10, 6, 19, 0), Date.UTC(2026, 10, 6, 21), 0), "tonight");
  assert.equal(whenText(Date.UTC(2026, 10, 5, 9, 0), NOON, 0), "yesterday");
  assert.equal(whenText(Date.UTC(2026, 10, 3, 9, 0), NOON, 0), "Tuesday");
  assert.equal(whenText(Date.UTC(2026, 9, 3, 9, 0), NOON, 0), "3 Oct");
});

test("days are local days", () => {
  assert.equal(whenText(Date.UTC(2026, 10, 5, 23, 30), NOON, 120), "last night");
  assert.equal(whenText(Date.UTC(2026, 10, 6, 8, 0), Date.UTC(2026, 10, 6, 9), -600), "tonight");
});

test("a run's label reads like a sentence", () => {
  const from = Date.UTC(2026, 10, 5, 22, 14);
  assert.equal(runLabel({ folder: "lantern", from, to: from + 9 * HOUR, agents: 6 }, NOON, 0), "lantern, last night, 9h, 6 agents");
  assert.equal(runLabel({ folder: "lantern", from, to: from + 42 * MIN, agents: 1 }, NOON, 0), "lantern, last night, 42m, 1 agent");
});
