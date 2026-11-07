// Stand-ins for Herdr's modules, so the mod's own files can run under `node --test`. An element records every call, so a
// test can read its text, count it and press what's pressable. This proves the mod's logic, not that the real app accepts
// its calls: `herdr-app check` does that.
import { registerHooks } from "node:module";

export class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.calls = []; this.press = null; this.elementId = null; this.handlers = {}; }
  child(value) { if (value !== undefined && value !== null) this.kids.push(value); return this; }
  children(list) { for (const value of list) this.child(value); return this; }
  when(on, change) { return on ? change(this) : this; }
  on_click(press) { this.press = press; return this; }
  on_mouse_down(_button, handler) { this.handlers.down = handler; return this; }
  on_mouse_up(_button, handler) { this.handlers.up = handler; return this; }
  on_mouse_move(handler) { this.handlers.move = handler; return this; }
  on_hover(handler) { this.handlers.hover = handler; return this; }
  on_key_down(handler) { this.handlers.key = handler; return this; }
  id(value) { this.elementId = value; return this; }
  hover(style) { style(element("hover")); return this; }
  text() { return this.kids.map((k) => (k instanceof El ? k.text() : String(k))).join(" "); }
  count() { return 1 + this.kids.reduce((sum, k) => sum + (k instanceof El ? k.count() : 0), 0); }
  find(id) {
    if (this.elementId === id) return this;
    for (const k of this.kids) {
      const found = k instanceof El ? k.find(id) : null;
      if (found) return found;
    }
    return null;
  }
}

export const element = (tag) => new Proxy(new El(tag), {
  get(target, name, self) {
    if (name in target || typeof name === "symbol") {
      const value = target[name];
      return typeof value === "function" ? value.bind(self) : value;
    }
    return (...args) => { target.calls.push([name, args]); return self; };
  },
});

// What the fake `herdr` module reads. A test sets these.
export const world = { exec: async () => ({ code: 0, stdout: "{}", stderr: "" }), props: {}, paths: 0 };

export const theme = Object.fromEntries(["background", "canvas", "surface", "popover", "raised", "border", "input", "foreground", "muted", "dim", "accent", "solid", "solid_foreground", "blocked", "working", "done", "idle", "ansi3", "ansi6", "hover", "selected"]
  .map((name, i) => [name, `#${String(i + 10).repeat(3)}`]));

// Counts the paths built, so a test can see they're kept between renders.
const pathBuilder = () => {
  const path = { move_to: () => path, line_to: () => path, add_polygon: () => path, build: () => { world.paths += 1; return {}; } };
  return path;
};
export const PathBuilderStub = { stroke: pathBuilder, fill: pathBuilder };
globalThis.window = { paint_path: () => element("path") };

const stubs = {
  "gpui-kit": `import { element, PathBuilderStub } from ${JSON.stringify(import.meta.url)};
export class View {}
export const div = () => element("div");
export const PathBuilder = PathBuilderStub;`,
  "gpui-base": `import { element } from ${JSON.stringify(import.meta.url)};
export const v_flex = () => element("v_flex");
export const h_flex = () => element("h_flex");
export const HoverCard = { new: (id) => element("hover_card").id(id) };`,
  herdr: `import { world, theme as colours } from ${JSON.stringify(import.meta.url)};
export const appHome = () => "/h/.config/herdr-app";
export const home = () => "/h";
export const exec = (...args) => world.exec(...args);
export const props = () => world.props;
export const settings = () => ({ zoom: 1 });
export const theme = () => colours;`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) return { url: `stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("stub:")) return { format: "module", source: stubs[url.slice(5)], shortCircuit: true };
    return next(url, context);
  },
});

// A cx whose short sleeps pass at once. A long one is `timed`'s limit, which never ends unless a test says so. Timers are
// held, so a test runs them by hand.
export function fakeCx() {
  const tasks = [];
  const cx = {
    notified: 0, stopped: 0, repeating: [],
    notify() { this.notified += 1; },
    stop_propagation() { this.stopped += 1; },
    focus_handle: () => ({ focus() {} }),
    sleep: (ms) => (ms > 1000 ? new Promise(() => {}) : Promise.resolve()),
    spawn(body) { tasks.push(body(cx)); },
    timer: {
      every(ms, handler) {
        const task = { ms, handler, cancelled: false, cancel() { this.cancelled = true; } };
        cx.repeating.push(task);
        return task;
      },
    },
    settled: async () => { while (tasks.length) await tasks.shift(); },
  };
  return cx;
}
