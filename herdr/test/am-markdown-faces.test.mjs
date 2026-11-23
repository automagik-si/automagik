// am-markdown's contract, driven through a stub runtime: what the terminal printed becomes rows, a
// missing path stays hidden, and a click opens or re-points the preview the way the shared keys say.
// Not Herdr itself — the in-app check in RECIPE.md still applies.
//
// Determinism: the mod shells out (`hc`, `git`, one `sh` per open), so nothing here waits a fixed
// time. Every assertion is preceded by `until(predicate)`, and each case waits for the previous
// case's spawned work to settle before it resets the shared stub state — a late `reveal` from one
// case must not write into the next one's `slots`/`show`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

const stubs = {
  herdr: new URL("./am-markdown-herdr.mjs", import.meta.url).href,
  "gpui-kit": new URL("./gpui-stub.mjs", import.meta.url).href,
  "gpui-base": new URL("./gpui-stub.mjs", import.meta.url).href,
};
const fromMod = (context) => context.parentURL?.includes("/mods/am-markdown/");
registerHooks({
  resolve: (specifier, context, next) =>
    stubs[specifier] && fromMod(context) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context),
});

const herdr = await import(stubs.herdr);
const { state } = herdr;
const { default: MdMenu } = await import("../mods/am-markdown/main.js");
const { index, textOf, nodes } = await import(stubs["gpui-kit"]);

const SLOTS = "am.markdown.slots";
const SHOW = "am.markdown.show";
const LAST = "am.markdown.last";

// Every task this file's views spawn, so a case can wait for its work to finish before the next
// one resets the shared state. The preview's folder watch never resolves, so the wait is bounded.
let spawned = [];
const cxFor = () => {
  const cx = {
    // Run the task now and capture it, as Herdr does: a view relies on it having started (and on
    // having taken its "before" snapshot) by the time the click handler returns.
    spawn: (fn) => {
      let p;
      try {
        p = Promise.resolve(fn(cx));
      } catch (e) {
        p = Promise.reject(e);
      }
      spawned.push(p.catch(() => {}));
      return p;
    },
    timer: { every: () => ({ cancel() {} }) },
    focus_handle: () => ({ focus() {} }),
    sleep: async () => {},
    notify: () => {},
    stop_propagation: () => {},
  };
  return cx;
};

/** Waits for `predicate` to hold, polling; never a fixed sleep. */
async function until(predicate, what, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Lets the previous case's spawned work finish (bounded: a folder watch never resolves). */
async function quiesce() {
  const batch = spawned;
  spawned = [];
  await Promise.race([Promise.allSettled(batch), new Promise((r) => setTimeout(r, 2000))]);
}

async function reset({ props, panes, printed = "" }) {
  await quiesce();
  state.shared.clear();
  state.runs.length = 0;
  state.hcCalls.length = 0;
  state.notes.length = 0;
  herdr.ui.props = props;
  herdr.ui.panes = panes;
  herdr.ui.closed = 0;
  state.hcAnswer = () => ({ code: 0, stdout: printed, stderr: "" });
}

// A directory to resolve paths against, with the file a terminal "printed".
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "am-markdown-"));
  writeFileSync(join(dir, "NOTES.md"), "# Notes\n");
  return dir;
};

const menuView = async (dir) => {
  const pane = { pane: "p1", tab: "t1", terminal: "t1", focused: true, cwd: dir };
  await reset({ props: { tab: "pane", target: { pane: "p1" } }, panes: [pane], printed: `opened ${dir}/NOTES.md\n` });
  state.focused = { tab: "t1", pane: "p1" };
  const view = new MdMenu();
  view.init(null, cxFor());
  await until(() => view.marks.length === 1, "the printed file to become a row");
  return view;
};

test("the menu lists the Markdown the terminal printed, and hides a path that is not there", async () => {
  const dir = folder();
  const view = await menuView(dir);
  assert.match(textOf(view.render(cxFor())), /NOTES\.md/, "the printed file is a row");
  assert.match(textOf(view.render(cxFor())), /Markdown in this terminal/);

  // A path the terminal printed but that is not on disk never becomes a row.
  const pane = { pane: "p1", tab: "t1", terminal: "t1", focused: true, cwd: dir };
  await reset({ props: { tab: "pane", target: { pane: "p1" } }, panes: [pane], printed: "see /nope/MISSING.md\n" });
  state.focused = { tab: "t1", pane: "p1" };
  const spent = new MdMenu();
  spent.init(null, cxFor());
  await until(() => spent.note === "No Markdown files in this terminal", "the empty-menu note");
  const empty = textOf(spent.render(cxFor()));
  assert.doesNotMatch(empty, /MISSING\.md/);
  assert.match(empty, /No Markdown files in this terminal/);
});

test("a click splits a new pane to the right, as am-markdown, and records its slot", async () => {
  const dir = folder();
  const view = await menuView(dir);
  index(view.render(cxFor()));
  assert.ok(nodes.get("mm-0"), "the first Markdown row is drawn");
  nodes.get("mm-0").click(null, cxFor());
  // The app creates the pane within the same turn; the mod polls for it before it will record it.
  herdr.ui.panes = [...herdr.ui.panes, { pane: "p2", tab: "t1", mod: "am-markdown" }];
  await until(() => state.shared.get(SLOTS) && state.shared.get(SHOW), "the slot to be recorded");

  const split = state.runs.find(([name]) => name === "pane.split");
  assert.ok(split, "the panes were split");
  const args = split[1];
  assert.equal(args.direction, "right");
  assert.equal(args.mod, "am-markdown", "the preview is this mod now, not the old Markdown panel");
  assert.equal(args.pane, "p1", "beside the pane that was clicked");
  assert.equal(args.props.file, join(dir, "NOTES.md"));
  assert.ok(args.props.slot, "the new pane carries a slot");
  assert.deepEqual(state.shared.get(SLOTS), { p2: args.props.slot });
  assert.deepEqual(state.shared.get(SHOW), { [args.props.slot]: { file: join(dir, "NOTES.md"), on: null } });
  assert.ok(state.shared.has(LAST), "the tab's focused preview is recorded");
  await until(() => herdr.ui.closed === 1, "the popup to close once the work has started");
});

test("a second click switches the tab's preview in place instead of splitting again", async () => {
  const dir = folder();
  const pane = { pane: "p1", tab: "t1", terminal: "t1", focused: true, cwd: dir };
  const preview = { pane: "p2", tab: "t1", mod: "am-markdown", focused: true };
  await reset({ props: { tab: "pane", target: { pane: "p1" } }, panes: [pane, preview], printed: `opened ${dir}/NOTES.md\n` });
  state.focused = { tab: "t1", pane: "p1" };
  state.shared.set(SLOTS, { p2: "s1" });
  const view = new MdMenu();
  view.init(null, cxFor());
  await until(() => view.marks.length === 1, "the printed file to become a row");
  index(view.render(cxFor()));
  assert.ok(nodes.get("mm-0"), "the row is drawn");
  nodes.get("mm-0").click(null, cxFor());
  await until(() => state.shared.get(SHOW)?.s1, "the slot to be re-pointed");

  assert.equal(state.runs.some(([name]) => name === "pane.split"), false, "no new pane");
  assert.deepEqual(state.shared.get(SHOW), { s1: { file: join(dir, "NOTES.md"), on: null } }, "the slot is re-pointed");
  assert.deepEqual(state.runs.find(([name]) => name === "pane.focus")?.[1], { pane: "p2" });
  await until(() => herdr.ui.closed === 1, "the popup to close");
});

const open = async (dir, answer) => {
  const pane = { pane: "p1", tab: "t1", terminal: "t1", focused: true, cwd: dir };
  await reset({ props: { tab: "pane", target: { pane: "p1" } }, panes: [pane] });
  state.hcAnswer = answer;
  state.focused = { tab: "t1", pane: "p1" };
  const view = new MdMenu();
  view.init(null, cxFor());
  return view;
};

test("the menu says Searching… until find is done, then lists the files", async () => {
  const dir = folder();
  const view = await open(dir, () => ({ code: 0, stdout: `see ${dir}/NOTES.md\n`, stderr: "" }));
  assert.match(textOf(view.render(cxFor())), /Searching…/);
  await until(() => view.marks.length === 1, "the row");
  assert.doesNotMatch(textOf(view.render(cxFor())), /Searching…/);
});

test("a pane that is working lists the screen's paths and says so; the read asks for --json", async () => {
  const dir = folder();
  const json = JSON.stringify({ text: `see ${dir}/NOTES.md\n`, how: "screen", complete: false, why: "working" });
  const view = await open(dir, () => ({ code: 0, stdout: json, stderr: "" }));
  await until(() => view.marks.length === 1, "the row");
  assert.ok(state.hcCalls.some((a) => a[0] === "read" && a.includes("--json")));
  assert.match(textOf(view.render(cxFor())), /Pane is working: only paths on screen/);

  const none = JSON.stringify({ text: "nothing here", how: "screen", complete: false, why: "working" });
  const bare = await open(dir, () => ({ code: 0, stdout: none, stderr: "" }));
  await until(() => bare.note === "Pane is working: only paths on screen", "the working note");
});

test("a failed hc read shows its stderr instead of an empty list", async () => {
  const view = await open(folder(), () => ({ code: 1, stdout: "", stderr: "no such terminal" }));
  await until(() => view.note !== null && view.note !== undefined && !view.searching, "the error note");
  assert.match(view.note, /no such terminal/);
  assert.doesNotMatch(view.note, /No Markdown files/);
});

test("a failing existence check shows the error, not an empty list", async () => {
  const dir = folder();
  const view = await open(dir, () => ({ code: 0, stdout: `see ${dir}/NOTES.md\n`, stderr: "" }));
  state.execFault = (command) => (command === "sh" ? new Error("sh blew up") : undefined);
  try {
    await until(() => /sh blew up/.test(view.note ?? ""), "the exec error");
  } finally {
    state.execFault = undefined;
  }
});

test("~/ is expanded by the terminal's own $HOME and the row shows the resolved path", async () => {
  const home = mkdtempSync(join(tmpdir(), "am-markdown-home-"));
  writeFileSync(join(home, "todo.md"), "# t\n");
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const view = await open(folder(), () => ({ code: 0, stdout: "wrote ~/todo.md\n", stderr: "" }));
    await until(() => view.marks.length === 1, "the home file");
    assert.equal(view.marks[0].path, join(home, "todo.md"));
  } finally {
    process.env.HOME = saved;
  }
});
