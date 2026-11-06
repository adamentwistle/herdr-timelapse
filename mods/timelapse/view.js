// Draws the overlay. Colours are theme names only. A state has one colour everywhere and a tool's kind has one colour
// everywhere. Sizes are designed for mod.json's 1000 by 700 overlay.
// A render happens ten times a second while the replay plays, against Herdr's 55 ms limit. So the sky, the timeline's bars
// and the lines on the orbit are paths kept between renders, and everything that moves between renders moves natively.
import { PathBuilder, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings } from "herdr";
import { TICK_MS, exportFacts, exportLeftOut, exportWarning, leftOutText, progressText } from "./logic.js";
import { runLabel, whenText } from "./runs.js";
import {
  DURATIONS, arcPoints, clipText, clockText, countText, dayText, durationKey, gapLabels, geometry, idleText, labelSpot, sceneAt,
  segments, slotPoint, spanText, spokeEnds, starField, stateWord, tallyText, thinText,
} from "./timeline.js";

const PAD = 20;
const SIDE_MIN = 300;
const STRIP_H = 52;
const CHROME_H = 158;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STEP = { duration: TICK_MS, easing: "linear" };

export const tones = (t) => ({
  working: t.working, blocked: t.blocked, waiting: t.idle, done: t.done,
  write: t.ansi3, shell: t.accent, read: t.ansi6, agent: t.foreground, tool: t.muted,
});
const tint = (colour, alpha) => `${colour.slice(0, 7)}${alpha}`;
// `colour` laid over `under` at `share`, as one solid colour. A done node is dimmed this way rather than with opacity, so
// the orbit behind it doesn't show through.
export function mix(colour, under, share) {
  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}/i.test(colour ?? "") || !/^#[0-9a-f]{6}/i.test(under ?? "")) return colour;
  const [a, b] = [rgb(colour), rgb(under)];
  return `#${a.map((v, i) => Math.round(v * share + b[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}
const mono = () => settings().font_family ?? "JetBrains Mono";
const painted = (path, colour, width, height) => window.paint_path(path, colour).absolute().top(0).left(0).w(width).h(height);

// Paths are kept on the view, and made again only when `key` changes.
function kept(view, name, key, make) {
  const hit = view.paths[name];
  if (hit?.key === key) return hit.value;
  const value = make();
  view.paths[name] = { key, value };
  return value;
}

function strokes(width) {
  const path = PathBuilder.stroke(width);
  return {
    line(from, to) { path.move_to(from[0], from[1]).line_to(to[0], to[1]); return this; },
    through(points) { points.forEach(([x, y], i) => (i ? path.line_to(x, y) : path.move_to(x, y))); return this; },
    build: () => path.build(),
  };
}

function backdrop(view, geo, t) {
  const size = geo.size;
  const sky = kept(view, "sky", size, () => {
    const dim = strokes(1.2), bright = strokes(1.6);
    for (const star of starField(size, 46)) (star.bright ? bright : dim).line([star.x, star.y], [star.x + 1, star.y]);
    return { dim: dim.build(), bright: bright.build(), orbit: strokes(1).through(arcPoints(geo.centre, geo.centre, geo.orbit, 0, 2 * Math.PI)).build() };
  });
  return [painted(sky.dim, t.popover, size, size), painted(sky.bright, t.dim, size, size), painted(sky.orbit, t.border, size, size)];
}

// The spokes, the ring round the middle and the arcs for subagents. They change only when an agent appears or changes
// state, so the paths are kept between those, one pair for each state showing.
function lines(view, scene, geo, tone) {
  const key = `${geo.size}|${scene.nodes.map((n) => `${n.i}${n.state}${n.size}${n.kids.join("")}`).join(",")}`;
  const layers = kept(view, "lines", key, () => {
    const byState = new Map();
    const pens = (state) => {
      if (!byState.has(state)) byState.set(state, { spokes: strokes(1.5), arcs: strokes(3), used: { spokes: false, arcs: false } });
      return byState.get(state);
    };
    const count = view.made.place.slots.length, ring = segments(count, 0.22), radius = geo.hub / 2 + 7;
    for (const node of scene.nodes) {
      const own = pens(node.state);
      own.spokes.line(...spokeEnds(node, geo, node.size));
      own.used.spokes = true;
      own.arcs.through(arcPoints(geo.centre, geo.centre, radius, ring[node.i][0], ring[node.i][1]));
      own.used.arcs = true;
      segments(Math.max(1, node.kids.length), node.kids.length > 1 ? 0.3 : 0.5).slice(0, node.kids.length).forEach(([from, to], i) => {
        const kid = pens(node.kids[i]);
        kid.arcs.through(arcPoints(node.x, node.y, node.size / 2 + 5, from, to));
        kid.used.arcs = true;
      });
    }
    return [...byState].map(([state, p]) => ({ state, spokes: p.used.spokes ? p.spokes.build() : null, arcs: p.used.arcs ? p.arcs.build() : null }));
  });
  const out = [];
  for (const layer of layers) {
    if (layer.spokes) out.push(painted(layer.spokes, tint(tone[layer.state], "77"), geo.size, geo.size));
    if (layer.arcs) out.push(painted(layer.arcs, tone[layer.state], geo.size, geo.size));
  }
  return out;
}

// A spark's place comes from the clip, and it glides to the next one between renders.
function spark(s, tone) {
  const size = s.big ? 7 : 5;
  return div().id(`spark-${s.id}`).absolute().size(size).rounded_full().bg(tone[s.tone]).left(s.x - size / 2).top(s.y - size / 2).opacity(s.opacity)
    .transition("left", STEP).transition("top", STEP).transition("opacity", STEP);
}

function hub(view, scene, geo, tone, t) {
  const at = geo.centre - geo.hub / 2, glow = geo.hub + 30, c = geo.centre;
  const lead = view.made.place.lead >= 0 ? view.made.data.agents[view.made.place.lead] : null;
  return [
    ...(view.playing && scene.running ? [div().absolute().left(c - glow / 2).top(c - glow / 2).size(glow).rounded_full().bg(t.accent).loop("opacity", { from: 0.03, to: 0.11, period: 3200 })] : []),
    v_flex().absolute().left(at).top(at).w(geo.hub).h(geo.hub).items_center().justify_center().rounded_full().bg(t.raised).border(1).border_color(t.border)
      .child(div().text_size(Math.round(geo.hub * 0.34)).line_height(1.05).font_semibold().child(String(scene.running)))
      .child(div().text_size(11).line_height(1.1).text_color(t.muted).child("running"))
      .when(Boolean(lead && scene.leadState), (e) => e.child(div().pt(2).text_size(11).line_height(1.1).font_medium().text_color(tone[scene.leadState]).child(stateWord(scene.leadState)))),
  ];
}

function node(n, tone, t) {
  const fill = n.state === "done" ? mix(tone.done, t.canvas, 0.55) : tone[n.state], at = (size) => ({ left: n.x - size / 2, top: n.y - size / 2 });
  const blocked = n.state === "blocked", box = at(n.size), ring = at(n.size + 12);
  const dot = div().id(`node-${n.i}`).absolute().left(box.left).top(box.top).size(n.size).flex().items_center().justify_center().rounded_full()
    .bg(n.more ? t.canvas : fill).border(1.5).border_color(n.more ? t.dim : fill).opacity(n.opacity)
    .transition("opacity", STEP).transition("width", STEP).transition("height", STEP)
    .when(blocked, (e) => e.text_color(t.background).text_size(Math.round(n.size * 0.62)).font_bold().child("!"))
    .when(n.more > 0, (e) => e.text_color(t.muted).text_size(9).font_semibold().child(`+${n.more}`));
  if (!blocked) return [dot];
  return [div().absolute().left(ring.left).top(ring.top).size(n.size + 12).rounded_full().bg(fill).loop("opacity", { from: 0.06, to: 0.6, period: 800 }), dot];
}

function label(n, geo, tone, t) {
  const at = labelSpot(n, n.size, geo), line = (top, text, colour, weight) => div().absolute().left(at.left).top(top).w(at.width).truncate().text_center().text_size(11).line_height(1.2)
    .text_color(colour).when(weight, (e) => e.font_medium()).child(text);
  return n.more ? [line(at.top, n.name, t.muted, false)] : [line(at.top, n.name, t.foreground, true), line(at.top + 14, stateWord(n.state), tone[n.state], false)];
}

function idleChip(scene, geo, t) {
  return h_flex().absolute().left(0).w(geo.size).top(geo.centre + geo.hub / 2 + 16).justify_center()
    .child(div().px(10).py(4).rounded(6).bg(t.canvas).border(1).border_color(t.input).text_size(12).font_medium().text_color(t.foreground).child(idleText(scene.gap)));
}

function mapView(view, scene, geo, tone, t) {
  return div().id("map").relative().w(geo.size).h(geo.size).flex_none()
    .children(backdrop(view, geo, t))
    .children(lines(view, scene, geo, tone))
    .children(scene.sparks.map((s) => spark(s, tone)))
    .children(hub(view, scene, geo, tone, t))
    .children(scene.nodes.flatMap((n) => node(n, tone, t)))
    .children(scene.nodes.flatMap((n) => label(n, geo, tone, t)))
    .when(Boolean(scene.gap), (e) => e.child(idleChip(scene, geo, t)));
}

const stat = (value, word, t) => v_flex().flex_1().min_w(0).gap(1)
  .child(div().truncate().font_family(mono()).text_size(30).line_height(1.1).font_semibold().child(value))
  .child(div().text_size(12).text_color(t.muted).child(word));

function latestLine(scene, t) {
  const l = scene.latest;
  if (!l) return div().h(16);
  return div().truncate().font_family(mono()).text_size(12).text_color(t.muted).child(`${l.agent}: ${l.tool}${l.file ? ` ${l.file}` : ""}`);
}

function side(view, scene, t) {
  const { data } = view.made, moment = data.start + scene.t;
  return v_flex().flex_1().min_w(SIDE_MIN).gap(14).pt(6)
    .child(v_flex().flex_none().gap(2)
      .child(div().font_family(mono()).text_size(64).line_height(1).font_semibold().child(clockText(moment, data.offsetMin)))
      .child(div().text_size(13).text_color(t.muted).child(dayText(moment, data.offsetMin))))
    .child(h_flex().flex_none().gap(16)
      .child(stat(countText(scene.calls), "Tool calls", t))
      .child(stat(countText(scene.files), "Files", t)))
    .child(div().flex_none().text_size(13).text_color(t.foreground).child(tallyText(scene.tally) || "No agents yet"))
    .child(latestLine(scene, t))
    .child(div().flex_1())
    .child(div().flex_none().text_size(11).line_height(1.35).text_color(t.dim).child(thinText(data.totals.calls, view.made.drawn[durationKey(view.duration)].length)))
    .child(div().flex_none().text_size(11).line_height(1.35).text_color(t.dim).child("Times come from transcript timestamps. Blocked and waiting are worked out from them."));
}

function barsPath(bars, width, top) {
  const path = PathBuilder.fill(), step = width / bars.length;
  bars.forEach((height, i) => {
    if (!height) return;
    const x = i * step, y = top + (STRIP_H - top - 2) * (1 - height), right = x + Math.max(1, step - 1);
    path.add_polygon([[x, y], [right, y], [right, STRIP_H], [x, STRIP_H]], true);
  });
  return path.build();
}

// Each gap is a hatched band, so it can't be read as a stretch of the run that just happened to be quiet.
function gapPaths(gaps, width) {
  const bands = PathBuilder.fill(), hatch = strokes(1);
  for (const gap of gaps) {
    const left = gap.x0 * width, right = gap.x1 * width;
    bands.add_polygon([[left, 0], [right, 0], [right, STRIP_H], [left, STRIP_H]], true);
    for (let x = left - STRIP_H; x < right; x += 7) {
      const from = Math.max(left, x), to = Math.min(right, x + STRIP_H);
      if (to > from) hatch.line([from, STRIP_H - (from - x)], [to, STRIP_H - (to - x)]);
    }
  }
  return gaps.length ? { bands: bands.build(), hatch: hatch.build() } : null;
}

function strip(view, width, t) {
  const { bars, timeline } = view.made, x = view.fraction * width;
  const drawn = kept(view, "strip", width, () => ({ bars: barsPath(bars, width, 4), gaps: gapPaths(timeline.gaps, width) }));
  const smooth = view.playing;
  return v_flex().flex_none().gap(2)
    .child(div().relative().h(14).w(width).flex_none()
      .children(gapLabels(timeline, width).map((g) => div().absolute().top(0).left(g.x - 42).w(84).text_center().text_size(10).line_height(1.3).text_color(t.dim).child(`${g.text} idle`))))
    .child(div().id("strip").relative().w(width).h(STRIP_H).flex_none().overflow_hidden().rounded(8).bg(t.canvas).cursor_pointer()
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); view.press(e, cx); })
      .child(painted(drawn.bars, t.input, width, STRIP_H))
      .child(div().absolute().left(0).top(0).h(STRIP_H).w(x).overflow_hidden().when(smooth, (e) => e.transition("width", STEP)).child(painted(drawn.bars, t.accent, width, STRIP_H)))
      .when(Boolean(drawn.gaps), (e) => e.child(painted(drawn.gaps.bands, t.raised, width, STRIP_H)).child(painted(drawn.gaps.hatch, t.dim, width, STRIP_H)))
      .child(div().absolute().top(0).left(x - 1).w(2).h(STRIP_H).bg(t.foreground).when(smooth, (e) => e.transition("left", STEP))));
}

function button(id, text, primary, ready, t, press) {
  return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(7).text_size(12).font_medium()
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
    .when(ready, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(press))
    .when(!ready, (e) => e.opacity(0.45))
    .child(text);
}

function durations(view, t) {
  return h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.canvas).children(DURATIONS.map((d) => {
    const on = d.ms === view.duration;
    return h_flex().id(`duration-${d.key}`).h(26).px(10).items_center().rounded(6).text_size(12).font_medium().cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.raised))
      .on_click((_e, cx) => view.pickDuration(d.ms, cx)).child(d.label);
  }));
}

function controls(view, t) {
  const word = view.playing ? "Pause" : view.fraction >= 1 ? "Replay" : "Play", { data } = view.made;
  return h_flex().flex_none().items_center().gap(10)
    .child(button("play", word, true, true, t, (_e, cx) => view.toggle(cx)))
    .child(durations(view, t))
    .child(div().flex_none().font_family(mono()).text_size(12).text_color(t.muted).child(`${clipText(view.fraction * view.duration)} / ${clipText(view.duration)}`))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(view.note?.bad ? t.blocked : t.muted).child(view.note?.text ?? ""))
    .child(div().flex_none().font_family(mono()).text_size(12).text_color(t.dim)
      .child(`${clockText(data.start, data.offsetMin)} to ${clockText(data.start + data.span, data.offsetMin)}`));
}

function header(view, t) {
  const picked = view.run ? runLabel(view.run, view.now, view.offsetMin) : "";
  return h_flex().flex_none().items_center().gap(10)
    .child(div().flex_none().text_size(13).font_semibold().text_color(t.muted).child("Time-lapse"))
    .when(view.demo, (e) => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.dim).child("Demo data")))
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(picked))
    .child(button("runs", view.page === "runs" ? "Back" : "Runs", false, Boolean(view.runs?.length), t, (_e, cx) => view.showRuns(cx)))
    .child(button("export", "Export", false, Boolean(view.made) && view.page === "replay", t, (_e, cx) => view.askExport(cx)));
}

function runRow(view, run, t) {
  const on = run === view.run, cell = (text, width) => div().w(width).flex_none().text_right().font_family(mono()).text_size(12).text_color(t.muted).child(text);
  return h_flex().id(`run-${run.key}-${run.from}`).h(40).px(12).gap(12).flex_none().items_center().rounded(8).cursor_pointer()
    .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.open(run, cx))
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().child(run.folder))
    .child(div().w(120).flex_none().text_size(12).text_color(t.muted).child(whenText(run.from, view.now, view.offsetMin)))
    .child(cell(spanText(run.to - run.from), 70))
    .child(cell(`${run.agents} ${run.agents === 1 ? "agent" : "agents"}`, 80))
    .child(cell(`${countText(run.calls)} calls`, 100));
}

function runsPage(view, t) {
  const left = leftOutText(view.leftOut, view.leftOff);
  return v_flex().flex_1().min_h(0).gap(8)
    .child(v_flex().id("run-list").flex_1().min_h(0).gap(2).overflow_y_scrollbar().children(view.runs.map((run) => runRow(view, run, t))))
    .when(Boolean(left), (e) => e.child(div().flex_none().text_size(12).text_color(t.muted).child(left)));
}

function exportPage(view, t) {
  const line = (text, colour) => div().text_size(13).line_height(1.4).text_color(colour).child(text);
  return v_flex().flex_1().min_h(0).items_center().justify_center()
    .child(v_flex().w(520).gap(14).p(22).rounded(12).bg(t.canvas)
      .child(div().text_size(15).font_semibold().child("What this file holds"))
      .child(v_flex().gap(3).children(exportFacts(view.made.data).map((fact) => line(fact, t.foreground))))
      .child(line(exportLeftOut, t.foreground))
      .child(line(exportWarning, t.muted))
      .child(line("It saves to ~/Downloads as one HTML file that plays in any browser, with no network and no other files.", t.muted))
      .child(h_flex().gap(8).pt(4)
        .child(button("save", view.saving ? "Saving" : "Save", true, !view.saving, t, (_e, cx) => view.saveExport(cx)))
        .child(button("cancel", "Cancel", false, !view.saving, t, (_e, cx) => view.backToReplay(cx)))));
}

const centred = (child) => v_flex().flex_1().min_h(0).items_center().justify_center().child(child);

function waiting(view, t) {
  return centred(h_flex().items_center().gap(8).text_size(13).text_color(t.muted)
    .child(div().w(14).flex_none().text_color(t.accent).frames(SPINNER, 90).child(SPINNER[0]))
    .child(div().child(progressText(view.progress))));
}

const problem = (view, t) => centred(div().max_w(520).text_center().text_size(13).line_height(1.4).text_color(t.blocked).child(view.problem));

const empty = (t) => centred(div().text_size(13).text_color(t.muted).child("No runs with tool calls yet."));

function replay(view, width, height, tone, t) {
  const size = Math.max(280, Math.min(height - CHROME_H, width - SIDE_MIN - 20)), geo = geometry(Math.floor(size));
  const scene = sceneAt(view.made, view.fraction, view.duration, geo);
  return [
    h_flex().flex_1().min_h(0).gap(20).items_start()
      .child(div().flex_none().rounded(12).bg(t.canvas).overflow_hidden().child(mapView(view, scene, geo, tone, t)))
      .child(side(view, scene, t)),
    strip(view, width, t),
    controls(view, t),
  ];
}

export function paneView(view, t) {
  const zoom = settings().zoom || 1, width = Math.max(600, (view.width || 1000 * zoom) / zoom - PAD * 2), height = Math.max(420, (view.height || 700 * zoom) / zoom - PAD * 2);
  const root = v_flex().id("timelapse").size_full().min_h(0).min_w(0).p(PAD).gap(10).overflow_hidden().bg(t.popover).text_color(t.foreground).text_size(13)
    .track_focus(view.keys).on_key_down((e, cx) => view.key(e, cx))
    .on_size_change((size, cx) => { if (size.width !== view.width || size.height !== view.height) { view.width = size.width; view.height = size.height; cx.notify(); } })
    .on_mouse_move((e, cx) => view.dragTo(e.position.x, cx))
    .on_mouse_up("left", (_e, cx) => view.release(cx))
    .on_hover((hovered, cx) => { if (!hovered) view.release(cx); })
    .child(header(view, t));
  if (view.page === "runs" && view.runs) return root.child(runsPage(view, t));
  if (view.problem) return root.child(problem(view, t));
  if (view.page === "export" && view.made) return root.child(exportPage(view, t));
  if (view.made) return root.children(replay(view, width, height, tones(t), t));
  if (view.runs && !view.runs.length) return root.child(empty(t));
  return root.child(waiting(view, t));
}
