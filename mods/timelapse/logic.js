// What the overlay works out that isn't the replay itself, kept apart from drawing. No Herdr imports, so `node --test` can
// load this file.
export const HELPER_MS = 28000;
export const TICK_MS = 100;
export const MAX_STEP_MS = 400;
export const RETRY_MS = 1000;

// Rejects once `ms` has passed with no answer, so one hung call can't hold the overlay. `sleep` is `cx.sleep`.
export function timed(promise, ms, what, sleep) {
  const late = sleep(ms).then(() => { throw new Error(`${what} didn't answer within ${Math.round(ms / 1000)} s`); });
  return Promise.race([promise, late]);
}

// The cache sits outside mods/timelapse, because a new file under mods/ makes Herdr reload the mod.
export const cacheDir = (appHome) => `${appHome}/data/timelapse`;

// -I and -S keep the user's Python setup out of it. -B keeps __pycache__ out of the mod folder, for the same reason.
export function helperArgs(appHome, action, { demo = false, run = null, out = null, colours = null } = {}) {
  const args = ["-I", "-S", "-B", `${appHome}/mods/timelapse/helper.py`, action, "--cache", cacheDir(appHome)];
  if (demo) args.push("--demo");
  if (run) args.push("--ids", run.ids.join(","), "--from", String(run.from), "--to", String(run.to));
  if (out) args.push("--out", out);
  if (colours) args.push("--colours", JSON.stringify(colours));
  return args;
}

// What the helper printed, as `{ value, error }`. A crash or bad output is named, not passed off as nothing to show.
export function helperReply(result) {
  if (result?.code !== 0) {
    const why = String(result?.stderr ?? "").trim().split("\n").at(-1)?.slice(0, 160);
    return { value: null, error: `helper.py stopped with code ${result?.code ?? "unknown"}${why ? `: ${why}` : ""}` };
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch { return { value: null, error: "helper.py printed something that isn't JSON" }; }
  if (!value || typeof value !== "object") return { value: null, error: "helper.py printed something that isn't JSON" };
  return value.error ? { value: null, error: String(value.error) } : { value, error: null };
}

// Why the helper couldn't run at all: it didn't answer, or python3 couldn't start it.
export const helperFailure = (e) => {
  const why = String(e?.message ?? e);
  return /didn't answer/.test(why) ? why : `python3 couldn't start helper.py: ${why}`;
};

// What to do after a pass: "done", "again" for a partial one, or "stuck" if it got no further than the last.
export function readStep(reply, lastRead) {
  if (!reply.partial) return "done";
  return reply.read > lastRead ? "again" : "stuck";
}

export const stuckText = "Reading stopped getting further. Check that the data folder in Herdr's home can be written to.";

export function progressText(progress) {
  if (!progress) return "Reading transcripts";
  return `Reading transcripts: ${progress.read.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")}`;
}

// A note under the list, so what's listed isn't taken for the whole history.
export function leftOutText(leftOut, leftOff) {
  const parts = [];
  if (leftOut) parts.push(leftOut === 1 ? "1 transcript couldn't be read." : `${leftOut.toLocaleString("en-US")} transcripts couldn't be read.`);
  if (leftOff) parts.push(`The oldest ${leftOff.toLocaleString("en-US")} sessions are left out.`);
  return parts.join(" ") || null;
}

// The clip moves on by the time that really passed, so a late tick doesn't stretch it, and a long stall can't jump it.
export function advance(fraction, elapsedMs, durationMs) {
  return Math.min(1, fraction + Math.min(MAX_STEP_MS, Math.max(0, elapsedMs)) / durationMs);
}

export const tilde = (path, home) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export const savedText = (reply, home) => `Saved to ${tilde(reply.saved, home)}`;

const counted = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// What the file will hold, for the note before saving. Every count is of what's really in it.
export function exportFacts(run) {
  return [
    `The folder name: ${run.folder}`,
    counted(run.agents.length, "agent name", "agent names"),
    counted(run.tools.length, "tool name", "tool names"),
    `${counted(run.events.length, "timestamped event", "timestamped events")}, with state changes`,
    counted(run.files.length, "file base name", "file base names"),
  ];
}

export const exportLeftOut = "Never prompts, tool results, file contents, commands or paths.";

export const exportWarning = "File base names can say what you're working on. Read them before you post it.";

// The colours the page takes from the theme.
const PAGE_COLOURS = ["background", "canvas", "popover", "raised", "border", "input", "foreground", "muted", "dim", "accent", "working", "blocked", "done", "idle", "ansi3", "ansi6"];
export const pageColours = (t) => Object.fromEntries(PAGE_COLOURS.map((name) => [name, String(t[name] ?? "").slice(0, 9)]));
