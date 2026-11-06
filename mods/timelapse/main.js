// The Time-lapse overlay: a run of agents replayed at high speed. This file runs the helper and holds the state.
// The replay is worked out in timeline.js, runs in runs.js, drawing is in view.js, and helper.py reads the transcripts.
import { View } from "gpui-kit";
import { appHome, exec, home, props, theme } from "herdr";
import { HELPER_MS, RETRY_MS, TICK_MS, advance, helperArgs, helperFailure, helperReply, pageColours, readStep, savedText, stuckText, timed } from "./logic.js";
import { MAX_RUNS, groupRuns, latestBig } from "./runs.js";
import { DURATIONS, prepareSteps, pressShare } from "./timeline.js";
import { paneView } from "./view.js";

const KEY_STEP = 0.02;

export default class TimeLapse extends View {
  init(initial, cx) {
    this.demo = Boolean((initial ?? props())?.demo);
    this.keys = cx.focus_handle();
    this.keys.focus();
    this.closed = false; this.problem = null; this.progress = null; this.note = null;
    this.runs = null; this.run = null; this.now = 0; this.offsetMin = 0; this.leftOut = 0; this.leftOff = 0;
    this.page = "replay"; this.saving = false; this.loading = false;
    this.made = null; this.prep = null; this.paths = {};
    this.duration = DURATIONS[0].ms; this.fraction = 0; this.playing = false; this.ticker = null; this.lastTick = 0; this.drag = null;
    this.width = 0; this.height = 0; this.drawing = false;
    // Herdr stops a render or a task at about 55 ms, and code that has just loaded runs far slower than that. So this asks
    // again for a render that didn't finish, and restarts preparing a run if it was stopped between steps.
    cx.timer.every(RETRY_MS, (cx) => this.recover(cx));
    this.scan(cx);
  }

  async close() {
    this.closed = true;
    this.ticker?.cancel();
  }

  recover(cx) {
    if (this.prep && Date.now() - this.prep.touched >= RETRY_MS) this.pump(cx);
    if (this.drawing) cx.notify();
  }

  // One helper call, with what went wrong named. `sleep` is `cx.sleep`.
  async helper(action, options, sleep) {
    let result;
    try {
      result = await timed(exec("python3", helperArgs(appHome(), action, { demo: this.demo, ...options })), HELPER_MS, "helper.py", sleep);
    } catch (e) {
      return { value: null, error: helperFailure(e) };
    }
    return helperReply(result);
  }

  // A long history takes several passes the first time. Each pass keeps what it read, so the next starts from there.
  async passes(action, options, cx) {
    let last = -1;
    while (!this.closed) {
      const { value, error } = await this.helper(action, options, (ms) => cx.sleep(ms));
      if (error) return { value: null, error };
      const step = readStep(value, last);
      if (step === "done") { this.progress = null; return { value, error: null }; }
      if (step === "stuck") { this.progress = null; return { value: null, error: stuckText }; }
      last = value.read;
      this.progress = value;
      cx.notify();
    }
    return { value: null, error: null };
  }

  scan(cx) {
    cx.spawn(async (cx) => {
      const { value, error } = await this.passes("scan", {}, cx);
      if (error) this.problem = error;
      else if (value) {
        this.now = value.now; this.offsetMin = value.offsetMin; this.leftOut = value.leftOut; this.leftOff = value.leftOff;
        this.runs = groupRuns(value.sessions).slice(0, MAX_RUNS);
        const first = latestBig(this.runs);
        if (first) this.open(first, cx);
      }
      cx.notify();
    });
  }

  // Opens a run from the list.
  open(run, cx) {
    this.stop();
    this.run = run; this.page = "replay"; this.made = null; this.prep = null; this.paths = {}; this.note = null; this.problem = null; this.fraction = 0;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const { value, error } = await this.passes("replay", { run }, cx);
      if (this.run !== run || this.closed) return;
      this.loading = false;
      if (error) this.problem = error;
      else if (value) {
        const { made, steps } = prepareSteps(value.run);
        this.prep = { made, steps, next: 0, touched: Date.now() };
        this.pump(cx);
      }
      cx.notify();
    });
  }

  // Works through the preparing a step at a time, with a pause between, so each step gets a render's limit of its own.
  // Each one can run twice, so if Herdr stops this task, `recover` starts another from the same step.
  pump(cx) {
    const prep = this.prep;
    prep.touched = Date.now();
    cx.spawn(async (cx) => {
      while (this.prep === prep && prep.next < prep.steps.length) {
        prep.steps[prep.next]();
        prep.next += 1;
        prep.touched = Date.now();
        await cx.sleep(1);
      }
      if (this.prep !== prep) return;
      this.prep = null; this.made = prep.made;
      this.play(cx);
    });
  }

  stop() {
    this.playing = false;
    this.ticker?.cancel();
    this.ticker = null;
  }

  play(cx) {
    if (this.fraction >= 1) this.fraction = 0;
    this.stop();
    this.playing = true; this.lastTick = Date.now();
    this.ticker = cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.notify();
  }

  pause(cx) {
    this.stop();
    cx.notify();
  }

  toggle(cx) {
    if (!this.made) return;
    if (this.playing) this.pause(cx); else this.play(cx);
  }

  // The only clock in the overlay, and it only runs while the replay plays.
  tick(cx) {
    const now = Date.now();
    this.fraction = advance(this.fraction, now - this.lastTick, this.duration);
    this.lastTick = now;
    if (this.fraction >= 1) this.stop();
    cx.notify();
  }

  pickDuration(ms, cx) {
    this.duration = ms;
    if (this.playing) this.lastTick = Date.now();
    cx.notify();
  }

  // A press on the timeline. `position` and `local_position` are both real parts of a press, and their difference is where
  // the strip starts, in the same pixels as every move after it.
  press(e, cx) {
    const width = e.bounds?.width, x = e.position?.x, local = e.local_position?.x;
    if (!(width > 0) || !Number.isFinite(x) || !Number.isFinite(local) || !this.made) return;
    this.drag = { left: x - local, width, resume: this.playing };
    this.stop();
    this.dragTo(x, cx);
  }

  dragTo(x, cx) {
    if (!this.drag) return;
    const share = pressShare(x, this.drag.left, this.drag.width);
    if (share == null || share === this.fraction) return;
    this.fraction = share;
    cx.notify();
  }

  release(cx) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.resume && this.fraction < 1) this.play(cx); else cx.notify();
  }

  key(e, cx) {
    if (e.key === "space") this.toggle(cx);
    else if (e.key === "left" || e.key === "right") {
      if (!this.made) return;
      this.fraction = Math.max(0, Math.min(1, this.fraction + (e.key === "left" ? -KEY_STEP : KEY_STEP)));
      cx.notify();
    } else return;
    cx.stop_propagation();
  }

  showRuns(cx) {
    this.page = this.page === "runs" ? "replay" : "runs"; this.note = null;
    this.stop();
    cx.notify();
  }

  // Export shows what the file holds first. Nothing is written until Save.
  askExport(cx) {
    if (!this.made) return;
    this.page = "export"; this.note = null;
    this.stop();
    cx.notify();
  }

  backToReplay(cx) {
    this.page = "replay";
    cx.notify();
  }

  saveExport(cx) {
    if (this.saving || !this.made) return;
    this.saving = true; this.note = { text: "Saving" };
    cx.notify();
    cx.spawn(async (cx) => {
      const { value, error } = await this.passes("export", { run: this.run, out: `${home()}/Downloads`, colours: pageColours(theme()) }, cx);
      this.saving = false;
      this.page = "replay";
      this.note = error ? { text: error, bad: true } : value ? { text: savedText(value, home()) } : null;
      cx.notify();
    });
  }

  render() {
    this.drawing = true;
    const drawn = paneView(this, theme());
    this.drawing = false;
    return drawn;
  }
}
