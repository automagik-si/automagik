// am-quota's Accounts panel under a stub runtime (./am-quota-herdr.mjs: files in memory, `exec`
// recorded and never spawned, Linux, so no Keychain item is ever asked for) and a fake proxy.
// The switch itself is a fake module: what it writes is am-quota-switch.test.mjs's subject. Not
// Herdr: the in-app check in the mod's RECIPE still applies.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "./bounded.mjs";

const here = (f) => new URL(f, import.meta.url).href;
const FAKE_SWITCH = "data:text/javascript," + encodeURIComponent(`
  export const installs = [];
  export const switchFixture = {};
  export async function install({ provider, account, fence, installFenced }) {
    installs.push({ provider, id: account.id });
    if (switchFixture.place) return switchFixture.place({ provider, account, fence, installFenced });
    return { label: provider === "claude" ? "Claude Code" : "Codex", fingerprint: switchFixture.write?.(provider, account) ?? "fp-new" };
  }`);
const stubs = { herdr: here("./am-quota-herdr.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
const fromMod = (context) => context.parentURL?.includes("/mods/am-quota/");
registerHooks({
  resolve: (specifier, context, next) => {
    if (stubs[specifier] && fromMod(context)) return { url: stubs[specifier], shortCircuit: true };
    if (specifier === "./switch.js" && context.parentURL?.endsWith("/mods/am-quota/main.js")) return { url: FAKE_SWITCH, shortCircuit: true };
    return next(specifier, context);
  },
});

const { state, finishRun } = await import(stubs.herdr);
const { installs, switchFixture } = await import(FAKE_SWITCH);
const { default: Panel, plain, records } = await import("../mods/am-quota/main.js");
const { all, index, nodes, textOf } = await import(stubs["gpui-kit"]);
const { AUTH_SCRIPT, FOLDER_SCRIPT, PRESENT_SCRIPT } = await import("../mods/am-quota/logins.js");
const { SIDEBAR_MARKERS, SIDEBAR_VERSION, WRITER_FILE, snapshotOf } = await import("../mods/am-quota/setLogin.js");
const { layoutPopup } = await import("./popup-layout.mjs");

const { FLEET_FILE, nextObs } = await import("../mods/am-quota/accountsRows.js");
const { auth, fixtureHere, fpr, BOT } = await import("./accounts-fixture.mjs");

const NOW = Date.now();
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const BASE = "https://proxy.example.com";

// Two tools, example accounts: Codex's in-use account runs out (88% an hour ago, 92% now: 2 h
// left, its reset 10 h away), Claude's has nothing recorded. `poll` 0 is the earlier reading.
let poll = 1;
const quotas = () => ({ accounts: QUOTAS.accounts.map((a) => ({ ...a, fetched_at: iso(poll ? NOW : NOW - H),
  windows: a.windows.map((w) => ({ ...w, used_percent: a.email === "ana@example.com" && !poll ? 88 : w.used_percent })) })) });
const QUOTAS = { accounts: [
  { name: "codex-0a-ana-pro.json", provider: "codex", email: "ana@example.com", plan: "pro",
    windows: [{ id: "primary", used_percent: 92, reset_at: iso(NOW + 10 * H) }] },
  { name: "codex-0b-bo-pro.json", provider: "codex", email: "bo@example.com", plan: "pro",
    windows: [{ id: "primary", used_percent: 12, reset_at: iso(NOW + 6 * H) }] },
  { name: "claude-0c-cy.json", provider: "claude", email: "cy@example.com",
    windows: [{ id: "seven_day", used_percent: 41, reset_at: iso(NOW + 50 * H) }] },
] };
const CREDENTIALS = { files: QUOTAS.accounts.map((a) => ({ name: a.name, provider: a.provider, email: a.email, status: "active" })) };

function fakeFetch() {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    const body = url.endsWith("/v1/quotas") ? quotas() : url.endsWith("/v8/management/credentials") ? CREDENTIALS : null;
    if (!body) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => body };
  };
  return asked;
}

function makeCx() {
  const cx = { pending: [], spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    timer: { every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) }, notify() {} };
  cx.settle = async () => { while (cx.pending.length) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
}

const ACTIVE = `${state.appHome}/data/am-quota/active.json`;
const RUNNER = `${state.appHome}/mods/am-sidebar/bin/run.sh`;

const LOGINS = `${state.appHome}/claude-logins.json`;
const TWO = `${state.home}/.claude-2`;
const DEFAULT_DIR = `${state.home}/.claude`;
/** `claude auth status`'s canned answer for a login signed in as `email` (#453): never a real claude. */
const signedIn = (email, configDirectory, extra = {}) => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, configDirectory, ...extra }), stderr: "" });
/** Where the CLI says a launch finds claude (`launch-path claude`): a stand-in, never run. */
const WHERE = { program: "/stub-bin/claude", path: "/stub-bin:/usr/bin:/bin" };
/**
 * state.exec for the Claude logins (#453): the CLI's `launch-path claude` (`where`), each
 * login's folder check (`folders[dir]`, else ok), its `claude auth status` (`status.default` or
 * `status[dir]`, else signed out; a function is called, so a test can hold or never answer) and
 * Herdr's credential variables (`vars`, names only); any other command goes to `rest`.
 */
function claudeExec({ status = {}, folders = {}, vars = [], where = WHERE } = {}, rest = () => ({ code: 0, stdout: "", stderr: "" })) {
  return (command, args, options) => {
    if (command === "env" && args.includes("launch-path")) return { code: 0, stdout: JSON.stringify(where), stderr: "" };
    if (command === "sh" && args[1] === FOLDER_SCRIPT) return { code: 0, stdout: folders[args[3]] ?? "ok\n", stderr: "" };
    const auth = command === "/usr/bin/env" && args.at(-1) === "status" && args.at(-2) === "auth";
    if (auth || (command === "sh" && args[1] === AUTH_SCRIPT)) {
      const words = auth ? args : args.slice(3);
      const key = words[0] === "-u" ? "default" : words.find((w) => w.startsWith("CLAUDE_CONFIG_DIR=")).slice("CLAUDE_CONFIG_DIR=".length);
      const answer = status[key] ?? { code: 1, stdout: '{"loggedIn":false}', stderr: "" };
      return typeof answer === "function" ? answer() : answer;
    }
    if (command === "sh" && args[1] === PRESENT_SCRIPT) return { code: 0, stdout: vars.map((v) => `${v}\n`).join(""), stderr: "" };
    return rest(command, args, options);
  };
}
/** Two logins signed in: the default as cy (on the proxy), login 2 as dee (not on it). */
const TWO_IN = { status: { default: signedIn("cy@example.com", DEFAULT_DIR), [TWO]: signedIn("dee@example.com", TWO) } };

async function panel({ config = { url: BASE, name: "lab" }, key = "example-key", active = { codex: { name: "codex-0a-ana-pro.json" } }, sidebar = true,
  claude = null, record = undefined, settle = true, writer = false } = {}) {
  state.files = new Map();
  state.calls = [];
  state.runs = [];
  state.runAs = undefined;
  state.prepares = [];
  state.prepare = undefined;
  if (config) state.files.set(`${state.appHome}/cliproxy.json`, JSON.stringify(config));
  if (key) state.files.set(`${state.home}/.config/cliproxyapi/mgmt.key`, `${key}\n`);
  if (active) state.files.set(ACTIVE, JSON.stringify(active));
  if (sidebar) state.files.set(RUNNER, "#!/bin/sh\n");
  if (writer) {
    for (const file of SIDEBAR_MARKERS) state.files.set(`${state.appHome}/${file}`, "");
    state.files.set(`${state.appHome}/${SIDEBAR_VERSION}`, "1.2.3\n");
  }
  if (record !== undefined) state.files.set(LOGINS, typeof record === "string" ? record : JSON.stringify(record));
  if (claude) state.exec = claudeExec(claude);
  const asked = fakeFetch();
  const cx = makeCx();
  const view = new Panel();
  poll = 0;
  view.init({}, cx);
  if (!settle) return { view, cx, asked, draw: () => index(view.render()) };
  await cx.settle();
  poll = 1;
  view.reload(cx);
  await cx.settle();
  return { view, cx, asked, draw: () => index(view.render()) };
}

const text = (root) => textOf(root);

test("the tool switch shows one tool at a time; Codex lists its accounts by email · plan", async () => {
  const { view, cx, draw } = await panel();
  let root = draw();
  assert.ok(nodes.has("tool-claude") && nodes.has("tool-codex"));
  assert.match(text(root), /Claude Code logins on this Mac/, "Claude first: the logins signed in here (#453)");
  assert.ok(!text(root).includes("ana@example.com"), "no Codex account on the Claude card");
  nodes.get("tool-codex").click(null, cx);
  root = draw();
  const shown = text(root);
  assert.match(shown, /ana@example\.com · Pro/);
  assert.match(shown, /Running out/);
  assert.match(shown, /Other Codex accounts on lab/);
  assert.ok(!shown.includes(".json"), "never a credential file name");
  void view;
});

test("no saved-login UI: no name box, no Restore, no footer notes about saved logins", async () => {
  const { draw } = await panel();
  const root = draw();
  assert.equal(all(root).some((n) => n.kind === "input"), false);
  assert.doesNotMatch(text(root), /save this login|Restore|Re-save|Forget|saved/i);
});

test("the footer names the proxy and opens its URL; with no name, the host", async () => {
  let p = await panel();
  assert.match(text(p.draw()), /Claude logins are the ones signed in on this Mac; usage comes from your CLIProxyAPI, lab\./);
  p.view.tool = "codex";
  let root = p.draw();
  assert.match(text(root), /Accounts come from your CLIProxyAPI, lab\. To add one, sign in to it there\./);
  state.calls = [];
  nodes.get("am-open-proxy").click(null, p.cx);
  assert.deepEqual(state.calls, [["xdg-open", BASE]]);
  p = await panel({ config: { url: `${BASE}/` } });
  p.view.tool = "codex";
  root = p.draw();
  assert.match(text(root), /CLIProxyAPI, proxy\.example\.com\./);
});

test("no cliproxy.json: a setup line, the generic name, no Open button and no request", async () => {
  const { view, draw, asked } = await panel({ config: null });
  view.tool = "codex";
  const root = draw();
  assert.match(text(root), /your own CLIProxyAPI/);
  assert.match(text(root), /Accounts come from your CLIProxyAPI\. To add one/);
  assert.equal(nodes.has("am-open-proxy"), false);
  assert.deepEqual(asked, []);
});

// #929 G4: the footer's Accounts tab opens this panel as a popup as tall as its content
// (am-footer PANEL_POPUP, 0.6 of the window), and a body built with overflow_y_scrollbar measures
// 0 there: the installed app drew the title, the tool switch and the footer, and no setup line.
// Laid out through popup-layout.mjs (its rule held to live frames by popup-layout.test.mjs); the
// model clips a scroll area and has no scroll offset, so "scrolls" here means clipped, not moved.
const POPUP_H = 492; // 0.6 of the 820 px window, as popup-layout.test.mjs
const FIXED_H = 470; // a layout block of a set height: the control that drew the line
const setupRow = (root) => all(root).find((n) => n.kids.some((k) => typeof k === "string" && /your own CLIProxyAPI/.test(k)));

test("no cliproxy.json, as the footer's popup and in a fixed block: the setup line is drawn in the body, the same in both (#929 G4)", async () => {
  for (const tool of ["claude", "codex"]) {
    const { view, draw } = await panel({ config: null, claude: {} });
    view.tool = tool;
    const root = draw();
    const row = setupRow(root);
    assert.ok(row, `${tool}: the setup line is in the tree`);
    const popOut = layoutPopup(root, { height: POPUP_H }, nodes);
    const pop = popOut.box(row);
    assert.ok(pop.h > 0 && pop.visible === pop.h, `${tool}: as the popup, the setup line has its height, none of it clipped (got ${JSON.stringify(pop)})`);
    assert.ok(pop.y + pop.h <= popOut.height, `${tool}: inside the popup's own height (${popOut.height})`);
    const fixedOut = layoutPopup(root, { height: FIXED_H, fixed: true }, nodes);
    const fixed = fixedOut.box(row);
    assert.ok(fixed.visible > 0 && fixed.y + fixed.h <= fixedOut.height, `${tool}: in a fixed block too`);
    assert.equal(pop.visible, fixed.visible, `${tool}: the popup shows what the fixed block shows`);
  }
});

test("a list taller than the popup: the popup takes its full height, the body clips, the footer stays whole (#929 G4)", async () => {
  // Test-only accounts: forty more Codex accounts on the fake proxy, so the list overflows.
  const accounts = QUOTAS.accounts.slice(), files = CREDENTIALS.files;
  for (let i = 0; i < 40; i += 1) {
    QUOTAS.accounts.push({ name: `codex-9${i}-x${i}-pro.json`, provider: "codex", email: `x${i}@example.com`, plan: "pro",
      windows: [{ id: "primary", used_percent: 5, reset_at: iso(NOW + 6 * H) }] });
  }
  CREDENTIALS.files = QUOTAS.accounts.map((a) => ({ name: a.name, provider: a.provider, email: a.email, status: "active" }));
  try {
    const { view, draw } = await panel();
    view.tool = "codex";
    const root = draw();
    const rows = all(root).filter((n) => /^acct-/.test(n.id ?? ""));
    assert.ok(rows.length >= 40, `the long list is drawn (${rows.length} rows)`);
    const out = layoutPopup(root, { height: POPUP_H }, nodes);
    assert.equal(out.height, POPUP_H, "the body's rows size the popup up to its cap");
    const first = out.box(rows[0]), last = out.box(rows.at(-1));
    assert.ok(first.visible > 0, `the first account row is in view (got ${JSON.stringify(first)})`);
    assert.equal(last.visible, 0, "the last is clipped by the scroll area, below the fold");
    const foot = all(root).find((n) => n.kind === "h_flex" && n.calls.some(([m]) => m === "border_t"));
    const f = out.box(foot);
    assert.ok(f.h > 0 && f.visible === f.h && f.y + f.h <= out.height, "the footer stays whole at the bottom");
  } finally {
    QUOTAS.accounts.splice(0, Infinity, ...accounts);
    CREDENTIALS.files = files;
  }
});

test("Switch to <email>, then the bots still on the old account, and Restart after a confirmation", async () => {
  const { view, cx, draw, asked } = await panel();
  view.tool = "codex";
  draw();
  const bots = { projects: [{ project: "/work/a", bots: [
    { id: "orch", name: "Orchestrator", agent: "codex", project: "/work/a", terminal: "t1", status: "idle", since: iso(NOW - H) },
    { id: "late", name: "Late", agent: "codex", project: "/work/a", terminal: "t2", status: "idle", since: iso(NOW + 10 * H) },
    { id: "cl", name: "Claude bot", agent: "claude", project: "/work/a", terminal: "t3", status: "idle", since: iso(NOW - H) },
  ] }] };
  state.exec = (command, args) => {
    if (command === "env" && args.includes("ls")) return { code: 0, stdout: JSON.stringify(bots), stderr: "" };
    if (command === "env" && args.includes("restart")) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  nodes.get("primary-codex").click(null, cx);
  await cx.settle();
  assert.deepEqual(installs.at(-1), { provider: "codex", id: "codex-0b-bo-pro.json" });
  assert.equal(JSON.parse(state.files.get(ACTIVE)).codex.name, "codex-0b-bo-pro.json");
  assert.ok(!asked.some((u) => u.includes("/download")), "the fake switch downloads nothing");

  let root = draw();
  assert.match(text(root), /Codex is now on bo@example\.com · Pro/);
  assert.match(text(root), /This one started earlier and still uses ana@example\.com · Pro/);
  assert.match(text(root), /Orchestrator/);
  assert.ok(!text(root).includes("Late") && !text(root).includes("Claude bot"));

  const ls = state.calls.find((c) => c[0] === "env" && c.includes("ls"));
  assert.deepEqual(ls, ["env", "HERDR_APP_HOME=/stub-app", "sh", RUNNER, "/stub-app/mods/am-sidebar/bin/automagik-herdr.mjs", "ls", "--all", "--json"]);

  state.calls = [];
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  assert.equal(state.calls.length, 0, "the first press only asks to confirm");
  root = draw();
  assert.match(text(root), /Restart 1 bot\? Press again to confirm/);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  assert.deepEqual(state.calls.map((c) => c.slice(c.indexOf("restart"))), [["restart", "orch", "--project", "/work/a", "--json"]]);
  root = draw();
  assert.match(text(root), /Restarted 1: every Codex bot is on the new account/);
});

test("a refused restart is named, and the others still run", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }, { id: "b", name: "B", project: "/p" }], reliable: true } };
  state.exec = (_c, args) => (args.includes("a")
    ? { code: 1, stdout: "", stderr: "am: A is working; restart it when it is idle, or pass --force" }
    : { code: 0, stdout: "{}", stderr: "" });
  draw();
  nodes.get("restart-codex").click(null, cx);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  let root = draw();
  assert.match(text(root), /Restarted 1 of 2\. Not restarted:/);
  assert.match(text(root), /A: A is working; restart it when it is idle\./);
  // Pressing again retries only the one that failed.
  assert.match(text(root), /Restart 1 bot/);
  state.calls = [];
  state.exec = () => ({ code: 0, stdout: "{}", stderr: "" });
  nodes.get("restart-codex").click(null, cx);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  assert.deepEqual(state.calls.map((c) => c.slice(c.indexOf("restart"), c.indexOf("restart") + 2)), [["restart", "a"]]);
  root = draw();
  assert.match(text(root), /Restarted 2: every Codex bot is on the new account/);
});

test("a restart whose new pane exited names its agent's own cause, not the CLI's first stderr line (#413)", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }], reliable: true } };
  const cause = "Error: model provider example-proxy is no longer configured (modelProviderNotConfigured)";
  const error = `t100 exited before its agent was up; its agent said: "${cause}" (hc read t100 shows the rest); t5 still runs A, untouched.`;
  state.exec = () => ({ code: 1, stdout: JSON.stringify({ error, terminal: "t100", cause }),
    stderr: `am: A's pane moved to tab tb3.\nam: ${error}\n` });
  draw();
  nodes.get("restart-codex").click(null, cx);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  const root = draw();
  assert.match(text(root), /Restarted 0 of 1\. Not restarted:/);
  assert.ok(text(root).includes(`A: ${error}`), text(root));
  assert.ok(!text(root).includes("moved to tab"), "a warning before the refusal is not the reason");
});

test("a refusal is shown in the CLI's words, past its warnings, without the clause that names a flag (#413)", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }, { id: "b", name: "B", project: "/p" }], reliable: true } };
  const working = "A is working in t5; restarting now would cut its turn in half. Wait until it is idle.";
  const noId = "t6 carries no session id, so codex would resume the latest conversation in /p. Nothing was restarted.";
  // The CLI's own prefix goes from every line: am's, and the long one an older CLI wrote (B's).
  state.exec = (_c, args) => ({ code: 1, stdout: "",
    stderr: args.includes("a") ? `am: a warning first\nam: A is working in t5; restarting now would cut its turn in half. Wait until it is idle, or pass --force.\n`
      : `automagik-herdr: ${noId} Restart with --fresh for a new conversation, or pass --force to resume the latest one.\n` });
  draw();
  nodes.get("restart-codex").click(null, cx);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  const root = draw();
  assert.ok(text(root).includes(`A: ${working}`), text(root));
  assert.ok(text(root).includes(`B: ${noId}`), text(root));
  assert.ok(!text(root).includes("a warning first"));
  assert.doesNotMatch(text(root), /--[a-z]/);
});

test("plain: every clause that names a flag goes; what an agent said, in quotes, stays as it said it (#413)", () => {
  assert.equal(plain("Let it finish, pass --tree to restart it too (resumed, under the new pane), or pass --force to end it."), "Let it finish.");
  assert.equal(plain("A is working; restart it when it is idle, or pass --force"), "A is working; restart it when it is idle.");
  assert.equal(plain("t100 exited; t5 still runs A, untouched. Try am restart b-a --fresh."), "t100 exited; t5 still runs A, untouched.");
  assert.equal(plain(`its agent said: "Error: unknown option --foo. See help" (hc read t1 shows the rest). Pass --force.`),
    `its agent said: "Error: unknown option --foo. See help" (hc read t1 shows the rest).`);
  assert.equal(plain("Restart with --fresh (or --tree)."), "");
  assert.equal(plain("Keep a well-known-word and t-5."), "Keep a well-known-word and t-5.");
});

// #413: the CLI's --json refusals of a busy bot, as cmdRestart prints them.
const WORKING = "A is working in t5; restarting now would cut its turn in half. Wait until it is idle, or pass --force.";
const HELPERS = "t5 has a helper that ends with it: t7. Let it finish, pass --tree to restart it too (resumed, under the new pane), or pass --force to end it with the pane.";
const busyAnswer = (refused = "working", error = WORKING) => ({ code: 1, stdout: JSON.stringify({ error, refused, terminal: "t5" }), stderr: `am: ${error}\n` });
const OK = { code: 0, stdout: JSON.stringify({ terminal: "t100", mode: "resume" }), stderr: "" };
const ticks = async () => { for (let i = 0; i < 20; i += 1) await new Promise((go) => setImmediate(go)); };
// The hc a busy panel sees: `panes` (address → status, "gone", "broken" when hc get fails with no
// not_found, or null for a pane reporting none), t5's helpers as its rows. Read each time, so a test changes them while a wait runs.
const fakeHc = (panes, { outlives = [] } = {}) => (args) => {
  // A restart's own terminals, by their label (#433): none still running.
  if (args[0] === "ls" && args.includes("--label")) return { code: 0, stdout: JSON.stringify({ terminals: [] }), stderr: "" };
  if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ terminals: Object.keys(panes).filter((a) => a !== "t5").map((address) => ({ address, parent: "t5", state: "live" })) }), stderr: "" };
  const st = panes[args[1]];
  if (st === undefined || st === "gone") return { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) };
  if (st === "broken") return { code: 1, stdout: "", stderr: "hc: can't reach the server" };
  return { code: 0, stdout: JSON.stringify({ address: args[1], state: "live", status: st === null ? null : { state: st }, die_with_parent: !outlives.includes(args[1]) }), stderr: "" };
};
// A panel with A refused as `answer`. Its restart again answers `then`, and hc wait `wait(terminal)`.
// Each restart runs in a terminal of its own (#433), answered at once (am-quota-herdr.mjs runRestart).
async function busyPanel({ answer = busyAnswer(), panes = { t5: "done" }, outlives = [], then = OK, wait = () => ({ code: 0, stdout: "{}", stderr: "" }), press = true } = {}) {
  const p = await panel();
  p.view.tool = "codex";
  p.view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }], reliable: true } };
  state.hcCalls = [];
  state.calls = [];
  state.execOptions = [];
  state.hc = fakeHc(panes, { outlives });
  let refused = false;
  state.exec = (command, args) => {
    if (command === "hc") return wait(args[1]);
    if (!refused) { refused = true; return answer; }
    return typeof then === "function" ? then(args) : then;
  };
  p.draw();
  if (press) {
    nodes.get("restart-codex").click(null, p.cx);
    nodes.get("restart-codex").click(null, p.cx);
    await p.cx.settle();
    p.draw(); // the busy row's button, drawn
  }
  return p;
}
const restarts = () => state.calls.filter((c) => c[0] === "env" && c.includes("restart"));
const secondRestart = () => restarts()[1];
const waits = () => state.calls.filter((c) => c[0] === "hc");
const optionsOf = (call) => state.execOptions[state.calls.indexOf(call)];

test("a bot mid-turn shows busy with Restart when idle: hc wait through exec under its 10 min cap, then one restart (#413)", async () => {
  const panes = { t5: "working" };
  const { cx, draw } = await busyPanel({ panes, wait: () => { panes.t5 = "done"; return { code: 0, stdout: "{}", stderr: "" }; } });
  let root = draw();
  assert.match(text(root), /Restarted 0 of 1\. Not restarted:/);
  assert.ok(text(root).includes("A is busy: A is working in t5; restarting now would cut its turn in half. Wait until it is idle."), text(root));
  assert.match(text(root), /Restart A when idle/);
  assert.doesNotMatch(text(root), /\d+ min/, "no time is promised: a Herdr with no exec timeout cuts each wait at 30 s");
  assert.equal(restarts().length, 1, "no restart before the press");
  nodes.get("idle-codex-a").click(null, cx);
  await cx.settle();
  assert.deepEqual(waits(), [["hc", "wait", "t5", "--timeout", "450", "--json"]], "one wait, through exec (hc() stops at 30 s)");
  assert.deepEqual(optionsOf(waits()[0]), { timeout: 480000 }, "exec's own limit above hc's 450 s, below Herdr's 600 s cap");
  assert.equal(restarts().length, 2, "then one restart");
  assert.deepEqual(secondRestart().slice(secondRestart().indexOf("restart")), ["restart", "a", "--project", "/p", "--json"], "no helpers: no tree");
  assert.equal(optionsOf(secondRestart()), null, "not through exec: in a terminal of its own (#433)");
  assert.equal(state.runs.length, 2);
  root = draw();
  assert.match(text(root), /Restarted 1: every Codex bot is on the new account/);
});

test("Restart when idle: a pane done, idle or in error restarts, with no wait; only a question, gone or unreadable stay out (#413)", async () => {
  for (const status of ["done", "idle", "error"]) {
    const { cx } = await busyPanel({ panes: { t5: status } });
    nodes.get("idle-codex-a").click(null, cx);
    await cx.settle();
    assert.equal(restarts().length, 2, status);
    assert.equal(waits().length, 0, status);
  }
  for (const [status, why] of [["blocked", "its pane t5 is waiting for an answer"], ["gone", "its pane t5 is gone"], [null, "hc can't say how t5 is"], ["broken", "hc can't say how t5 is"]]) {
    const { cx, draw } = await busyPanel({ panes: { t5: status } });
    nodes.get("idle-codex-a").click(null, cx);
    await cx.settle();
    assert.equal(restarts().length, 1, why);
    assert.ok(text(draw()).includes(`A is busy: ${why}; nothing was restarted`), text(draw()));
  }
});

test("Restart when idle: waits cut by Herdr's exec limit while the pane works restart nothing: 4 waits, then still busy, the wait it really did (#413)", async () => {
  const { cx, draw } = await busyPanel({ panes: { t5: "working" }, wait: () => { throw new Error("hc took longer than 30 s and was stopped"); } });
  nodes.get("idle-codex-a").click(null, cx);
  await cx.settle();
  assert.equal(waits().length, 4, "one wait at a time, four at most, never a loop");
  assert.equal(restarts().length, 1, "never restarted while it works");
  const root = draw();
  assert.ok(text(root).includes("A is busy: t5 still working after under a minute of waiting; nothing was restarted"), text(root));
  assert.match(text(root), /Restart A when idle/, "offered again");
});

test("Restart when idle: a wait cut at the limit on a pane that finished meanwhile still restarts: the look decides (#413)", async () => {
  const panes = { t5: "working" };
  const { cx } = await busyPanel({ panes, wait: () => { panes.t5 = "done"; throw new Error("hc took longer than 30 s and was stopped"); } });
  nodes.get("idle-codex-a").click(null, cx);
  await cx.settle();
  assert.equal(waits().length, 1);
  assert.equal(restarts().length, 2);
});

test("helpers all finished: the bot restarts with them at once, with no extra press and no wait (#413)", async () => {
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done", t8: "idle" } });
  assert.equal(waits().length, 0, "nothing to wait for");
  assert.equal(restarts().length, 2, "the confirmed press is enough");
  const tree = secondRestart();
  assert.deepEqual(tree.slice(tree.indexOf("restart")), ["restart", "a", "--project", "/p", "--tree", "--json"]);
  assert.ok(tree.includes("AUTOMAGIK_HERDR_TREE_TURN_WAIT_MS=10000"), "the panel waited: the CLI's own wait is only a race guard");
  assert.equal(optionsOf(tree), null, "not through exec: in a terminal of its own (#433)");
  assert.match(text(draw()), /Restarted 1: every Codex bot is on the new account/);
  assert.doesNotMatch(text(draw()), /--[a-z]/);
});

test("a helper still working: the panel waits for that helper only, then restarts with --tree, reading them again first (#413)", async () => {
  const panes = { t5: "idle", t7: "done", t8: "working" };
  const asked = [];
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, wait: (t) => { asked.push(t); panes.t8 = "done"; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.deepEqual(asked, ["t8"], "only the one working");
  assert.equal(restarts().length, 2);
  assert.ok(secondRestart().includes("--tree"));
  assert.match(text(draw()), /Restarted 1: every Codex bot is on the new account/);
});

test("helpers: one that turns blocked during the wait stops the restart; so does a new one started meanwhile, until it is read (#413)", async () => {
  let panes = { t5: "idle", t8: "working" };
  let p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, wait: () => { panes.t8 = "blocked"; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.equal(restarts().length, 1, "the read right before the restart caught it");
  assert.ok(text(p.draw()).includes("A is busy: its helper t8 is waiting for an answer; nothing was restarted"), text(p.draw()));
  panes = { t5: "idle", t8: "working" };
  p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, wait: (t) => { if (t === "t8") { panes.t8 = "done"; panes.t9 = "working"; } else panes.t9 = "done"; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.deepEqual(waits().map((c) => c[2]), ["t8", "t9"], "one wait at a time, each on a pane working then");
  assert.ok(secondRestart().includes("--tree"));
});

test("a helper whose hc get fails with no not_found is not gone: no restart, with the reason, even as the sole helper (#413)", async () => {
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "broken" } });
  assert.equal(restarts().length, 1, "no plain restart that would end it with no word");
  assert.equal(waits().length, 0);
  assert.ok(text(draw()).includes("A is busy: hc can't say how its helper t7 is; nothing was restarted"), text(draw()));
  await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "gone" } });
  assert.equal(restarts().length, 2, "truly gone (exit 3, not_found): nothing left to end");
  assert.ok(!secondRestart().includes("--tree"));
});

test("a helper reporting no status doesn't hold the panel up: --tree runs, and the CLI's check judges it; an agent's refusal is listed without a flag (#413)", async () => {
  await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: null } });
  assert.ok(secondRestart().includes("--tree"), "a plain program such as a dev server passes");
  const said = "t7 doesn't tell hc whether it is busy, so --tree can't tell whether it has finished. Nothing was started. Look at it first, then pass --force to restart anyway.";
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: null }, then: { code: 1, stdout: "", stderr: `am: ${said}\n` } });
  const shown = text(draw());
  assert.ok(shown.includes("A: t7 doesn't tell hc whether it is busy. Nothing was started. Look at it first."), shown);
  assert.doesNotMatch(shown, /--[a-z]/);
  assert.match(shown, /Restart 1 bot/, "it stays on the list");
});

test("--tree refused though its JSON names a terminal is no restart: a new pane that exited, a turn started again; the bot stays listed (#413)", async () => {
  const cause = "Error: not logged in";
  const error = `t100 exited before its agent was up; its agent said: "${cause}" (hc read t100 shows the rest); t5 still runs A, untouched.`;
  let p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done" }, then: { code: 1, stdout: JSON.stringify({ error, terminal: "t100", cause }), stderr: `am: ${error}\n` } });
  let shown = text(p.draw());
  assert.doesNotMatch(shown, /every Codex bot is on the new account/);
  assert.ok(shown.includes(`A: ${error}`), shown);
  assert.deepEqual(p.view.switched.codex.look.bots.map((b) => b.id), ["a"], "still on the old account, still listed");
  p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done" }, then: busyAnswer("working") });
  shown = text(p.draw());
  assert.doesNotMatch(shown, /every Codex bot is on the new account/);
  assert.ok(shown.includes("A is busy: A is working in t5; restarting now would cut its turn in half. Wait until it is idle."), shown);
  assert.deepEqual(p.view.switched.codex.look.bots.map((b) => b.id), ["a"]);
});

test("a bot on a linked machine that needs --tree: the CLI's refusal (#437) keeps it on the old account, listed with why and no flag", async () => {
  // The CLI's words for restart --machine --tree, exit 2 with nothing on stdout, as the bot's name and machine fill them in.
  const said = "Restarting a bot's helpers on a linked machine isn't built yet, so nothing was read or restarted: A and its helpers on vm still run "
    + "as they were, on the account they started with. By hand: wait for a helper still working to finish, end each helper's pane "
    + "(hc kill vm/tN for one), then restart A there without --tree. A helper that still had work to do, start again yourself with hc run "
    + "on vm once A is back.";
  const p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done" }, then: { code: 2, stdout: "", stderr: `am: ${said}\n` } });
  assert.ok(secondRestart().includes("--tree"));
  const shown = text(p.draw());
  assert.ok(shown.includes("A: Restarting a bot's helpers on a linked machine isn't built yet, so nothing was read or restarted: A and its helpers on vm "
    + "still run as they were, on the account they started with. By hand: wait for a helper still working to finish, end each helper's pane "
    + "(hc kill vm/tN for one). A helper that still had work to do, start again yourself with hc run on vm once A is back."), shown);
  assert.doesNotMatch(shown, /--[a-z]/);
  assert.doesNotMatch(shown, /every Codex bot is on the new account/);
  assert.equal(p.view.switched.codex.result.done, 0, "never counted as restarted");
  assert.deepEqual(p.view.switched.codex.look.bots.map((b) => b.id), ["a"], "still on the old account, still listed");
});

test("helpers: blocked on a question or in error are not finished: no restart, with the reason; a pane that outlives the bot doesn't count (#413)", async () => {
  for (const [status, why] of [["blocked", "its helper t7 is waiting for an answer"], ["error", "its helper t7 is in error"]]) {
    const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: status, t8: "done" } });
    assert.equal(restarts().length, 1, why);
    assert.equal(waits().length, 0, why);
    const shown = text(draw());
    assert.ok(shown.includes(`A is busy: ${why}; nothing was restarted`), shown);
    assert.doesNotMatch(shown, /--[a-z]/);
  }
  await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "blocked" }, outlives: ["t7"] });
  assert.ok(!secondRestart().includes("--tree"), "a member bot isn't its helper");
});

test("a helper with helpers of its own: no restart, and why, before the CLI is asked (#413)", async () => {
  const panes = { t5: "idle", t7: "done" };
  const p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, press: false });
  const hcOf = state.hc;
  state.hc = (args) => {
    if (args[0] !== "ls" || args.includes("--label")) return hcOf(args);
    return { code: 0, stdout: JSON.stringify({ terminals: [{ address: "t7", parent: "t5", state: "live" }, { address: "t9", parent: "t7", state: "live" }] }), stderr: "" };
  };
  panes.t9 = "idle";
  nodes.get("restart-codex").click(null, p.cx);
  nodes.get("restart-codex").click(null, p.cx);
  await p.cx.settle();
  assert.equal(restarts().length, 1);
  assert.ok(text(p.draw()).includes("A is busy: its helper t7 has helpers of its own, which a restart wouldn't bring back; nothing was restarted"), text(p.draw()));
});

test("a bot mid-turn that has helpers: pressed, it waits for the bot, then for them, then restarts with --tree (#413)", async () => {
  const panes = { t5: "working", t7: "working" };
  const { cx } = await busyPanel({ panes, wait: (t) => { panes[t] = "done"; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.equal(restarts().length, 1, "mid-turn: it waits for the press");
  nodes.get("idle-codex-a").click(null, cx);
  await cx.settle();
  assert.deepEqual(waits().map((c) => c[2]), ["t5", "t7"]);
  assert.ok(secondRestart().includes("--tree"));
});

test("--tree exits 1 for a helper not run again though the bot restarted: restarted, and the helper is named without a flag (#413)", async () => {
  const then = { code: 1, stdout: JSON.stringify({ terminal: "t100", mode: "resume", helpers: [{ name: "fix", replaced: "t7", error: "t101 exited before its agent was up (hc read t101 says why)", by_hand: "hc run --name fix -- codex" }] }), stderr: "" };
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done" }, then });
  const shown = text(draw());
  assert.match(shown, /Restarted 1: every Codex bot is on the new account/);
  assert.ok(shown.includes("A's helper fix: t101 exited before its agent was up (hc read t101 says why)"), shown);
  assert.doesNotMatch(shown, /--[a-z]/);
});

test("a --tree restart whose terminal is gone with no answer says it may have stopped part-way (#433)", async () => {
  // Only its restart: the next test's panel() calls this exec too, before busyPanel replaces it.
  const then = (args) => { if (args.includes("restart")) state.runAs = "gone"; return OK; };
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: { t5: "idle", t7: "done" }, then });
  const t = state.runs[1].address;
  assert.ok(text(draw()).includes(`A: its restart's terminal ${t} is gone, with no answer from it. It may have stopped part-way: `
    + "check whether A and its helpers are back, then restart what is missing from a terminal, not from here"), text(draw()));
  assert.match(text(draw()), /Restart 1 bot/, "still listed");
});

const THREE = { t5: "idle", t7: "done", t8: "idle", t9: "done" };

test("no helpers cap (#433): 3 helpers restart by themselves with --tree, in a terminal of their own; exec's timeout is never probed", async () => {
  const { draw } = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes: THREE });
  assert.equal(restarts().length, 2);
  assert.ok(secondRestart().includes("--tree"));
  assert.equal(optionsOf(secondRestart()), null);
  assert.deepEqual(state.calls.filter((c) => c[0] === "true"), [], "no probe of the running Herdr");
  assert.match(text(draw()), /Restarted 1: every Codex bot is on the new account/);
  assert.doesNotMatch(text(draw()), /30 s|from a terminal/);
});

test("no helpers cap (#433): with 3 helpers and one working, the panel waits for it, then restarts with --tree", async () => {
  const panes = { ...THREE, t7: "working" };
  await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, wait: () => { panes.t7 = "done"; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.deepEqual(waits().map((w) => w[2]), ["t7"]);
  assert.equal(restarts().length, 2);
  assert.ok(secondRestart().includes("--tree"));
});

// #433: each restart runs in an hc terminal of its own, followed to its end. A panel with A to
// restart: `hc(args)` answers hc ls and get (a restart's own terminal is t900), `wait(terminal)` hc
// wait, `answer` the CLI. Not pressed: a test sets what it needs, then presses.
async function runPanel({ runAs = "done", answer = OK, hc: hcFn = () => ({ code: 0, stdout: JSON.stringify({ terminals: [] }), stderr: "" }), wait = () => ({ code: 0, stdout: "{}", stderr: "" }) } = {}) {
  const p = await panel();
  p.view.tool = "codex";
  p.view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }], reliable: true } };
  state.hcCalls = [];
  state.calls = [];
  state.execOptions = [];
  state.runAs = runAs;
  state.hc = hcFn;
  p.pauses = 0;
  p.view.pause = async (ms) => { p.pauses += 1; if (mock.timers.enabled) mock.timers.tick(ms); };
  state.exec = (command, args) => (command === "hc" ? wait(args[1]) : answer);
  p.draw();
  p.press = async () => {
    nodes.get("restart-codex").click(null, p.cx);
    nodes.get("restart-codex").click(null, p.cx);
    await p.cx.settle();
    return text(p.draw());
  };
  return p;
}
const liveGet = (t, st = "live") => ({ code: 0, stdout: JSON.stringify({ address: t, state: st, status: null }), stderr: "" });
const noRows = { code: 0, stdout: JSON.stringify({ terminals: [] }), stderr: "" };
const PART_WAY = "It may have stopped part-way: check whether A is back, then restart what is missing from a terminal, not from here";
/** Date.now under the test's control (node:test's mock timers), for the 5 min the panel follows a run. */
async function withClock(fn) {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  mock.timers.enabled = true;
  try {
    return await fn();
  } finally {
    mock.timers.enabled = false;
    mock.timers.reset();
  }
}

test("a restart runs in an hc terminal of its own, removed once it ends: no parent, the bot's label, Herdr's environment for the CLI; not through exec (#433)", async () => {
  const p = await runPanel();
  const shown = await p.press();
  assert.deepEqual(state.hcCalls[0], ["ls", "--label", "am-quota.restart=a", "--json"], "first: is one for A still running?");
  assert.deepEqual(state.prepares, [["-c", state.prepares[0][1], "sh", "/stub-app/data/am-quota/runs", "PATH", "HOME", "NVM_DIR", "VIRTUAL_ENV", "HERMES_HOME"]],
    "then, through exec: the folder made and Herdr's own values read");
  const run = state.hcCalls[1];
  const at = run.indexOf("--");
  assert.deepEqual(run.slice(0, at + 3), ["run", "--bg", "--json", "--rm", "--no-parent", "--cwd", "/stub-app", "--label", "am-quota.restart=a", "--", "sh", "-c"]);
  const [, out, err, code, ...argv] = run.slice(at + 4);
  assert.equal(run[at + 4], "sh");
  const stem = out.replace(/\.out$/, "");
  assert.match(stem, /^\/stub-app\/data\/am-quota\/runs\/a-\d+-[a-z0-9]+$/);
  assert.deepEqual([err, code], [`${stem}.err`, `${stem}.code`]);
  assert.deepEqual(argv, ["env", "-u", "NVM_DIR", "-u", "VIRTUAL_ENV", "-u", "HERMES_HOME", "HERDR_APP_HOME=/stub-app", "PATH=/herdr/bin:/usr/bin:/bin", "HOME=/stub-home",
    "sh", RUNNER, "/stub-app/mods/am-sidebar/bin/automagik-herdr.mjs", "restart", "a", "--project", "/p", "--json"],
    "the CLI sees Herdr's PATH and HOME, and none of the others herdr-core may have set");
  assert.equal(waits().length, 0, "its answer was there at the first look");
  assert.deepEqual(state.execOptions, [null], "the CLI is never run through exec");
  assert.match(shown, /Restarted 1: every Codex bot is on the new account/);
});

test("before a restart: a runs folder that can't be made, or Herdr's environment unread, starts nothing and says so (#433)", async () => {
  let p = await runPanel();
  state.prepare = () => ({ code: 3, stdout: "", stderr: "mkdir: Permission denied" });
  let shown = await p.press();
  assert.ok(shown.includes("A: couldn't make /stub-app/data/am-quota/runs for its answer, so no restart was started"), shown);
  assert.equal(state.runs.length, 0, "no terminal");
  p = await runPanel();
  state.prepare = () => { throw new Error("exec failed"); };
  shown = await p.press();
  assert.ok(shown.includes("A: couldn't read this app's environment for it, so no restart was started"), shown);
  assert.equal(state.runs.length, 0);
  // Values with no name, or names it didn't ask for, are no values.
  p = await runPanel();
  state.prepare = () => ({ code: 0, stdout: "PATH=/a:/b\nPATH=/second\nOTHER=x\nHOME=\n=y\nnoise\n", stderr: "" });
  await p.press();
  const argv = state.runs[0].args.slice(state.runs[0].args.indexOf("--") + 8);
  assert.deepEqual(argv.slice(0, 11), ["env", "-u", "HOME", "-u", "NVM_DIR", "-u", "VIRTUAL_ENV", "-u", "HERMES_HOME", "HERDR_APP_HOME=/stub-app", "PATH=/a:/b"]);
});

test("a restart's terminal is followed: hc wait under 30 s through exec, then its answer from the files, a refusal included (#433)", async () => {
  const hcFn = (args) => (args[0] === "get" ? liveGet(args[1]) : noRows);
  const asked = [];
  let p = await runPanel({ runAs: "live", hc: hcFn, wait: (t) => { asked.push(t); finishRun(state.runs[0]); return { code: 0, stdout: "{}", stderr: "" }; } });
  let shown = await p.press();
  assert.deepEqual(asked, ["t900"]);
  assert.deepEqual(waits(), [["hc", "wait", "t900", "--timeout", "25", "--json"]]);
  assert.deepEqual(optionsOf(waits()[0]), { timeout: 28000 }, "ends by itself on any Herdr");
  assert.match(shown, /Restarted 1: every Codex bot is on the new account/);
  const error = "t100 exited before its agent was up; t5 still runs A, untouched.";
  p = await runPanel({ runAs: "live", hc: hcFn, answer: { code: 1, stdout: JSON.stringify({ error, terminal: "t100" }), stderr: `am: a warning\nam: ${error}\n` },
    wait: () => { finishRun(state.runs[0]); return { code: 0, stdout: "{}", stderr: "" }; } });
  shown = await p.press();
  assert.ok(shown.includes(`Restarted 0 of 1. Not restarted: A: ${error}`), shown);
});

test("a restart's terminal that ended or is gone with no answer is said, with what to check; once removed (--rm) its answer is read (#433)", async () => {
  let p = await runPanel({ runAs: "live", hc: (args) => (args[0] === "get" ? liveGet(args[1], "finished") : noRows) });
  let shown = await p.press();
  assert.ok(shown.includes(`A: its restart in t900 ended with no answer. ${PART_WAY}`), shown);
  assert.equal(waits().length, 0);
  assert.match(shown, /Restart 1 bot/, "still listed");
  const gone = { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found" } }) };
  p = await runPanel({ runAs: "live", hc: (args) => (args[0] === "get" ? gone : noRows) });
  shown = await p.press();
  assert.ok(shown.includes(`A: its restart's terminal t900 is gone, with no answer from it. ${PART_WAY}`), shown);
  // The usual end: the answer written, then the terminal removed, both between two looks.
  p = await runPanel({ runAs: "live", hc: (args) => {
    if (args[0] !== "get") return noRows;
    finishRun(state.runs[0]);
    return gone;
  } });
  shown = await p.press();
  assert.match(shown, /Restarted 1: every Codex bot is on the new account/);
});

test("a restart still running after 5 min of wall time is said, where; a second press starts no second one (#433)", async () => {
  await withClock(async () => {
    let rows = [];
    const hcFn = (args) => (args[0] === "get" ? liveGet(args[1]) : { code: 0, stdout: JSON.stringify({ terminals: rows }), stderr: "" });
    const p = await runPanel({ runAs: "live", hc: hcFn, wait: () => { mock.timers.tick(25000); return { code: 0, stdout: "{}", stderr: "" }; } });
    let shown = await p.press();
    assert.equal(waits().length, 12, "12 waits of 25 s: 5 min");
    assert.equal(p.pauses, 0, "a wait that took its time needs no pause");
    assert.ok(shown.includes("A: its restart still runs in t900 after 5 min; the panel stopped following it, so how it ends isn't shown here. "
      + "Check whether the bot is back once t900 is gone"), shown);
    assert.ok(!shown.includes("part-way") && !shown.includes("hc read"), "it is running, not stopped, and it goes once it ends");
    assert.match(shown, /Restart 1 bot/);
    rows = [{ address: "t900", state: "live" }];
    shown = await p.press();
    assert.equal(state.runs.length, 1, "no second run");
    assert.ok(shown.includes("A: its restart started earlier still runs in t900, so no second one was started"), shown);
  });
});

test("waits that answer at once count by the clock, with a pause after each, not by how many there were (#433)", async () => {
  await withClock(async () => {
    const p = await runPanel({ runAs: "live", hc: (args) => (args[0] === "get" ? liveGet(args[1]) : noRows), wait: () => { throw new Error("hc wait failed"); } });
    const shown = await p.press();
    assert.equal(waits().length, 60, "5 s apart: 60 in 5 min");
    assert.equal(p.pauses, 60, "a pause after each quick wait");
    assert.ok(shown.includes("A: its restart still runs in t900 after 5 min"), shown);
  });
  await withClock(async () => {
    const p = await runPanel({ runAs: "live", hc: (args) => (args[0] === "get" ? { code: 1, stdout: "", stderr: "hc: can't reach the server" } : noRows),
      wait: () => { mock.timers.tick(25000); return { code: 0, stdout: "{}", stderr: "" }; } });
    const shown = await p.press();
    assert.ok(shown.includes("A: its restart may still run in t900 (hc can't say how it is) after 5 min"), shown);
  });
});

test("a restart hc can't start, can't list, or can't place is said in plain words; nothing ran (#433)", async () => {
  let p = await runPanel();
  state.runFail = JSON.stringify({ error: { kind: "unavailable", message: "the server isn't running; pass --start to start it", hint: "hc server start" } });
  let shown = await p.press();
  delete state.runFail;
  assert.ok(shown.includes("A: hc couldn't start its restart in a terminal of its own (the server isn't running); nothing was restarted"), shown);
  assert.doesNotMatch(shown, /\{|--[a-z]|kind/, "no JSON and no flag");
  assert.equal(restarts().length, 0, "nothing ran");
  p = await runPanel();
  state.runFail = "hc: can't reach the server";
  shown = await p.press();
  delete state.runFail;
  assert.ok(shown.includes("A: hc couldn't start its restart in a terminal of its own (can't reach the server); nothing was restarted"), shown);
  p = await runPanel();
  state.runFail = "pass --cwd with a folder that exists";
  shown = await p.press();
  delete state.runFail;
  assert.ok(shown.includes("A: hc couldn't start its restart in a terminal of its own; nothing was restarted"), shown);
  p = await runPanel({ hc: () => ({ code: 1, stdout: "", stderr: "down" }) });
  shown = await p.press();
  assert.ok(shown.includes("A: hc can't list the restarts still running, so none was started"), shown);
  assert.equal(state.runs.length, 0);
  // No address in hc run's answer: found by its label, else said.
  let lists = 0;
  p = await runPanel({ runAs: "live", hc: (args) => {
    if (args[0] === "get") { finishRun(state.runs[0]); return liveGet(args[1], "finished"); }
    lists += 1;
    return { code: 0, stdout: JSON.stringify({ terminals: lists > 1 ? [{ address: "t900", state: "live" }] : [] }), stderr: "" };
  } });
  state.runNoAddress = true;
  shown = await p.press();
  assert.match(shown, /Restarted 1: every Codex bot is on the new account/);
  p = await runPanel({ runAs: "live" });
  shown = await p.press();
  delete state.runNoAddress;
  assert.ok(shown.includes(`A: hc started its restart without saying in which terminal, and none was found. ${PART_WAY}`), shown);
});

test("the restart terminal's script and the prepare, under a real sh: the CLI's stdout, stderr and exit code in the files, the code last; old files go (#433)", async () => {
  const p = await runPanel();
  await p.press();
  const run = state.hcCalls[1];
  const script = run[run.indexOf("-c") + 1];
  const prepare = state.prepares[0][1];
  const root = mkdtempSync(join(tmpdir(), "am-quota-run-"));
  try {
    const runs = join(root, "a", "runs");
    const env = { PATH: process.env.PATH, HOME: "/home/x", HERMES_HOME: "/h=1" };
    const made = spawnSync("sh", ["-c", prepare, "sh", runs, "PATH", "HOME", "NVM_DIR", "HERMES_HOME"], { env, encoding: "utf8" });
    assert.equal(made.status, 0);
    assert.equal(made.stdout, `PATH=${process.env.PATH}\nHOME=/home/x\nHERMES_HOME=/h=1\n`, "set ones only, in order");
    writeFileSync(join(root, "file"), "x");
    assert.equal(spawnSync("sh", ["-c", prepare, "sh", join(root, "file", "runs"), "PATH"], { env }).status, 3, "a folder that can't be made: 3");
    const stale = join(runs, "old.out");
    const recent = join(runs, "recent.out");
    writeFileSync(stale, "x");
    writeFileSync(recent, "x");
    const twoDays = (Date.now() - 2 * 24 * H) / 1000;
    utimesSync(stale, twoDays, twoDays);
    const files = ["a.out", "a.err", "a.code"].map((f) => join(runs, f));
    const cli = 'printf "{\\"in\\":\\"%s\\"}" "${HC_TERMINAL_ID-none}"; echo "am: refused." >&2; exit 3';
    const r = spawnSync("sh", ["-c", script, "sh", ...files, "sh", "-c", cli], { env: { ...process.env, HC_TERMINAL_ID: "t42" }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(readFileSync(files[0], "utf8"), '{"in":"none"}', "the CLI runs as under exec: not inside a pane of its own");
    assert.equal(readFileSync(files[1], "utf8"), "am: refused.\n");
    assert.equal(readFileSync(files[2], "utf8"), "3\n");
    assert.match(r.stderr, /refused\./, "its screen shows what the CLI said");
    assert.equal(existsSync(`${files[2]}.tmp`), false);
    assert.equal(existsSync(stale), false, "a day old: gone");
    assert.equal(existsSync(recent), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the wait is cancelable: pressed again, the wait's end restarts nothing; a retry press works; a reload holds no wait (#413)", async () => {
  let done;
  const panes = { t5: "working" };
  const { view, cx, draw } = await busyPanel({ panes, wait: () => new Promise((go) => { done = go; }) });
  nodes.get("idle-codex-a").click(null, cx);
  await ticks();
  assert.equal(waits().length, 1);
  assert.match(text(draw()), /Waiting for A · Cancel/);
  assert.match(text(draw()), /waiting for t5 to finish/);
  nodes.get("idle-codex-a").click(null, cx);
  assert.match(text(draw()), /A is busy: canceled; nothing was restarted/);
  assert.match(text(draw()), /Restart A when idle/);
  panes.t5 = "done";
  done({ code: 0, stdout: "{}", stderr: "" });
  await cx.settle();
  assert.equal(restarts().length, 1, "canceled: no restart");
  assert.equal(waits().length, 1, "and no second wait");
  assert.deepEqual(view.switched.codex.waiting, {});
  // A reloaded panel holds no wait at all: it is this panel's memory only.
  const again = await panel();
  assert.equal(again.view.switched.codex, undefined);
});

test("the helper wait is cancelable too, with no press needed to start it (#413)", async () => {
  let done;
  const panes = { t5: "idle", t7: "working" };
  const p = await busyPanel({ answer: busyAnswer("helpers", HELPERS), panes, press: false, wait: () => new Promise((go) => { done = go; }) });
  nodes.get("restart-codex").click(null, p.cx);
  nodes.get("restart-codex").click(null, p.cx);
  await ticks();
  p.draw();
  assert.match(text(p.draw()), /Waiting for A · Cancel/);
  nodes.get("idle-codex-a").click(null, p.cx);
  panes.t7 = "done";
  done({ code: 0, stdout: "{}", stderr: "" });
  await p.cx.settle();
  assert.equal(restarts().length, 1, "canceled: nothing restarted");
});

test("a switch running when the bot is ready: no restart, and it says so (#413)", async () => {
  const { view, cx, draw } = await busyPanel({ panes: { t5: "done" } });
  view.busy = { provider: "claude", label: "x" };
  nodes.get("idle-codex-a").click(null, cx);
  await cx.settle();
  assert.equal(restarts().length, 1);
  view.busy = null;
  assert.match(text(draw()), /A is busy: A is ready, but a switch was running; nothing was restarted/);
});

test("a restart that started fresh says which bot and why (#328: no session id, a teammate in the folder)", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }, { id: "b", name: "B", project: "/p" }], reliable: true } };
  const note = "no Codex session id is known for t5, and B (t9) also runs Codex in /p, so resume --last could resume theirs instead of A's";
  const shown = "no Codex session id is known for t5, and B (t9) also runs Codex in /p, so a resume could resume theirs instead of A's";
  state.exec = (_c, args) => ({ code: 0, stdout: JSON.stringify(args.includes("a") ? { mode: "fresh", note } : { mode: "resume", note: null }), stderr: "" });
  draw();
  nodes.get("restart-codex").click(null, cx);
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  const root = draw();
  assert.match(text(root), /Restarted 2: every Codex bot is on the new account/);
  assert.match(text(root), /Started on a new conversation instead of resuming it:/);
  assert.ok(text(root).includes(`A: ${shown}`), text(root));
  assert.doesNotMatch(text(root), /--[a-z]/);
  assert.ok(!text(root).includes("B: "), "a bot that resumed isn't listed");
});

test("no restart while a switch is running", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  view.switched.codex = { at: NOW, from: "ana@example.com · Pro", to: "bo@example.com · Pro",
    look: { bots: [{ id: "a", name: "A", project: "/p" }], reliable: true } };
  view.busy = "switching Codex…";
  draw();
  state.calls = [];
  nodes.get("restart-codex").click(null, cx);
  await cx.settle();
  assert.deepEqual(state.calls, []);
  assert.match(text(draw()), /a switch is running: restart the bots once it is done/);
});

test("no sidebar mod: the banner says how to restart, with no button", async () => {
  const { view, cx, draw } = await panel({ sidebar: false });
  view.tool = "codex";
  draw();
  nodes.get("primary-codex").click(null, cx);
  await cx.settle();
  const root = draw();
  assert.match(text(root), /am restart <bot>/);
  assert.equal(nodes.has("restart-codex"), false);
});

test("an unclear start time lists every bot of that tool, and says so", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  draw();
  state.exec = (command, args) => (command === "env" && args.includes("ls")
    ? { code: 0, stdout: JSON.stringify({ projects: [{ project: "/p", bots: [
      { id: "x", name: "X", agent: "codex", project: "/p", terminal: "t1", status: "idle", since: null },
      { id: "y", name: "Y", agent: "codex", project: "/p", terminal: "t2", status: "idle", since: iso(NOW + H) }] }] }), stderr: "" }
    : { code: 0, stdout: "", stderr: "" });
  nodes.get("primary-codex").click(null, cx);
  await cx.settle();
  const root = draw();
  assert.match(text(root), /can't tell which of these 2 Codex bots started before the switch/);
  assert.match(text(root), /Restart 2 bots/);
});

test("colours: suggestions are never red; running out is amber", async () => {
  const { view, draw } = await panel();
  view.tool = "codex";
  const root = draw();
  const colours = all(root).map((n) => n.props.color).filter(Boolean);
  assert.ok(colours.includes("t.working"), "the amber sentence");
  assert.equal(colours.includes("t.blocked"), false, "no red without an error");
});

test("Claude (#453): no proxy install; an old claude record is ignored, never checked in the Keychain, dropped at the next write", async () => {
  state.platform = "macos";
  try {
    const { view, cx, draw, asked } = await panel({ active: { codex: { name: "codex-0a-ana-pro.json" }, claude: { name: "claude-0c-cy.json", fingerprint: "fp" } } });
    const root = draw();
    assert.equal(view.tool, "claude");
    assert.match(text(root), /On your CLIProxyAPI, not signed in here \(lab\)\s+cy@example\.com/, "the proxy's Claude account: listed, never installable");
    assert.equal(nodes.has("primary-claude"), false, "no Use");
    assert.equal(all(root).some((n) => /^(use|login-use)-/.test(n.props?.id ?? "")), false, "no row button");
    assert.doesNotMatch(text(root), /\bUse\b|Switch to/);
    const before = installs.length;
    view.use("claude", { id: "claude-0c-cy.json", name: "claude-0c-cy.json", provider: "claude", email: "cy@example.com" }, cx);
    await cx.settle();
    assert.equal(installs.length, before, "a Claude use installs nothing");
    // A Codex switch writes active.json: the claude entry is gone from it.
    view.tool = "codex";
    draw();
    nodes.get("primary-codex").click(null, cx);
    await cx.settle();
    assert.deepEqual(Object.keys(JSON.parse(state.files.get(ACTIVE))), ["codex"], "the claude entry is dropped at the next write");
    const ran = state.calls.map((c) => c.join(" ")).join("\n");
    assert.doesNotMatch(ran, /security|find-generic-password|Claude Code-credentials|shasum/, "no Keychain call, no item name");
    assert.ok(!asked.some((u) => u.includes("/download")), "no credential download");
  } finally {
    state.platform = "linux";
  }
});

test("active.json from before: a bare name is a record, a saved-login record is none", () => {
  assert.deepEqual(records({ codex: "codex-a.json", claude: { name: "saved:work", fingerprint: "f", saved: "work" } }),
    { codex: { name: "codex-a.json", fingerprint: null } });
  assert.deepEqual(records({ codex: "codex-a.json", claude: { name: "claude-a.json", fingerprint: "f" } }),
    { codex: { name: "codex-a.json", fingerprint: null } }, "a claude record is ignored (#453)");
});

test("no switch while bots restart; a switch's busy line names the account by email", async () => {
  const { view, cx, draw } = await panel();
  view.tool = "codex";
  draw();
  view.restarting = { codex: true };
  const before = installs.length;
  nodes.get("primary-codex").click(null, cx);
  await cx.settle();
  assert.equal(installs.length, before, "nothing installed");
  assert.match(text(draw()), /bots are restarting: switch once they are done/);
  view.restarting = {};
  view.switchError = null;
  let line = null;
  const busyAt = installs.length;
  nodes.get("primary-codex").click(null, cx);
  line = view.busy;
  await cx.settle();
  assert.equal(line, "switching Codex to bo@example.com · Pro…");
  assert.equal(installs.length, busyAt + 1);
});

// ---- Claude logins on this Mac (#453, docs/local-logins.md sections 2 to 7) ----

const buttons = (root) => all(root).filter((n) => n.click).map((n) => n.id);
const ranNoCredential = (asked) => {
  const ran = state.calls.map((c) => c.join(" ")).join("\n");
  assert.doesNotMatch(ran, /security|find-generic-password|Claude Code-credentials|\.credentials\.json|auth login|auth logout/, "no Keychain, credential, login or logout");
  assert.ok(!asked.some((u) => u.includes("/download")), "no credential download");
};

test("Claude (#453): the logins signed in here, by email, quota matched by email; Use only on another signed-in login", async () => {
  const { draw, asked } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }] }, claude: TWO_IN });
  const root = draw();
  const shown = text(root);
  assert.match(shown, /cy@example\.com · the default login In use/, "the headline: the login new launches get");
  assert.match(shown, /41% used of this week/, "its bar from the proxy account with its email");
  assert.match(shown, /dee@example\.com · login 2 Use Remove usage not tracked/, "a login the proxy doesn't list");
  assert.match(shown, /The first launch under login 2 needs one answer in its pane\./);
  assert.ok(nodes.has("login-use-2") && !nodes.has("login-use-default"), "Use on the other login only");
  assert.equal(nodes.has("login-remove-default"), false, "login A is never removed");
  assert.doesNotMatch(shown, /not signed in here/, "every proxy account is signed in here");
  const runs = state.calls.filter((c) => c[0] === "/usr/bin/env" && c.at(-1) === "status").map((c) => c.slice(1).join(" "));
  assert.deepEqual(runs.sort(), [`-u CLAUDE_CONFIG_DIR PATH=${WHERE.path} ${WHERE.program} auth status`,
    `PATH=${WHERE.path} CLAUDE_CONFIG_DIR=${TWO} ${WHERE.program} auth status`], "claude where launches find it, in each login's own words, looked at once on open");
  ranNoCredential(asked);
});

test("Claude (#453): a proxy account with no login here is listed with no button; a signed-out login reads Sign in again, with the command", async () => {
  const { draw } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }] },
    claude: { status: { default: signedIn("eve@example.com", DEFAULT_DIR) } } });
  const root = draw();
  const shown = text(root);
  assert.match(shown, /On your CLIProxyAPI, not signed in here \(lab\) cy@example\.com/);
  const here = all(root).find((n) => /^not-here-/.test(n.id ?? ""));
  assert.equal(all({ __node: here }).some((n) => n.click), false, "never a button: a proxy account is never installed");
  assert.match(shown, /login 2 Remove usage not tracked Not signed in\. Sign in again from a terminal, then press ↻: CLAUDE_CONFIG_DIR="\$HOME\/\.claude-2" claude auth login/);
  assert.equal(nodes.has("login-use-2"), false, "no Use on a login that isn't signed in");
  assert.match(shown, /usage not tracked/, "the default login's account isn't on the proxy");
  assert.equal(state.calls.some((c) => c.join(" ").includes("auth login")), false, "the command is shown, never run");
});

test("Claude Use (#453): one write of use with the snapshot it replaces; then the bots on another login by value, and Restart N bots", async () => {
  const record = { use: "default", logins: [{ id: "2", dir: TWO }] };
  const { view, cx, draw, asked } = await panel({ record, claude: TWO_IN });
  const before = state.files.get(LOGINS);
  const bots = { projects: [{ project: "/work/a", bots: [
    { id: "on-a", name: "OnA", agent: "claude", project: "/work/a", terminal: "t1", status: "idle" },
    { id: "on-2", name: "OnTwo", agent: "claude", project: "/work/a", terminal: "t2", status: "idle" },
    { id: "old", name: "Old", agent: "claude", project: "/work/a", terminal: "t3", status: "idle" },
    { id: "odd", name: "Odd", agent: "claude", project: "/work/a", terminal: "t4", status: "idle" },
    { id: "cx", name: "Cx", agent: "codex", project: "/work/a", terminal: "t5", status: "idle" },
  ] }] };
  const argv = { t1: ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "PATH=/b", "claude"], t2: ["/usr/bin/env", "PATH=/b", `CLAUDE_CONFIG_DIR=${TWO}`, "claude"],
    t3: ["/usr/bin/env", "PATH=/b", "claude"], t4: ["/usr/bin/env", "PATH=/b", "CLAUDE_CONFIG_DIR=/elsewhere", "claude"] };
  state.exec = claudeExec(TWO_IN, (command, args) => {
    if (command === "env" && args.includes("ls")) return { code: 0, stdout: JSON.stringify(bots), stderr: "" };
    if (command === "env" && args.includes("restart")) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  state.hc = (args) => (args[0] === "get" ? { code: 0, stdout: JSON.stringify({ address: args[1], state: "live", argv: argv[args[1]] }), stderr: "" } : { code: 0, stdout: "[]", stderr: "" });
  draw();
  const writes = [];
  const realWrite = state.files.set.bind(state.files);
  state.files.set = (k, v) => { if (k === LOGINS) writes.push(v); return realWrite(k, v); };
  try {
    nodes.get("login-use-2").click(null, cx);
    await cx.settle();
  } finally {
    delete state.files.set;
  }
  assert.equal(writes.length, 1, "one write");
  assert.deepEqual(JSON.parse(writes[0]), { ...record, use: "2" }, "only use changed");
  assert.notEqual(before, writes[0]);
  let root = draw();
  const shown = text(root);
  assert.match(shown, /New Claude Code launches use dee@example\.com · login 2/);
  assert.match(shown, /These 3 run on another login, by how they were launched:/);
  assert.match(shown, /OnA · the default login/);
  assert.match(shown, /Old · started before logins were tracked/);
  assert.match(shown, /Odd · an unknown login \(\/elsewhere\)/);
  assert.doesNotMatch(shown, /OnTwo|Cx/, "on login 2 already, or not Claude");
  assert.match(shown, /dee@example\.com · login 2 In use/, "the pill follows the record");
  state.calls = [];
  nodes.get("restart-claude").click(null, cx);
  nodes.get("restart-claude").click(null, cx);
  await cx.settle();
  assert.deepEqual(state.calls.filter((c) => c[0] === "env").map((c) => c[c.indexOf("restart") + 1]), ["on-a", "old", "odd"]);
  root = draw();
  assert.match(text(root), /Restarted 3: every Claude Code bot is on the new login/);
  ranNoCredential(asked);
  void view;
});

test("Claude Use (#453): a record changed since the panel read it is never overwritten, and nothing is switched", async () => {
  const { cx, draw } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }] }, claude: TWO_IN });
  draw();
  const edited = JSON.stringify({ use: "default", logins: [{ id: "2", dir: TWO }, { id: "3", dir: `${state.home}/.claude-3` }] });
  state.files.set(LOGINS, edited);
  nodes.get("login-use-2").click(null, cx);
  await cx.settle();
  assert.equal(state.files.get(LOGINS), edited, "the edit made since stays");
  assert.match(text(draw()), /New Claude launches were not switched: claude-logins\.json changed since the panel read it/);
});

const WRITER_PATH = `${state.appHome}/${WRITER_FILE}`;
const ACCOUNTS_WRITER = [`env`, `HERDR_APP_HOME=${state.appHome}`, "sh", RUNNER, `${state.appHome}/mods/am-sidebar/bin/accounts.mjs`, "set-login"];
const SIGNED_IN = { status: { default: signedIn("ana@example.test", DEFAULT_DIR), [TWO]: signedIn("bo@example.test", TWO) } };
const SLOT_RECORD = { use: "default", logins: [{ id: "2", dir: TWO }] };

test("Claude Use, Add and Remove send the shown snapshot to the dedicated CLI writer", async () => {
  const cases = [
    { button: "login-use-2", record: SLOT_RECORD, claude: SIGNED_IN, args: ["--use", "2"] },
    { button: "login-add-button", claude: SIGNED_IN, args: ["--add", "2", "--dir", TWO] },
    { button: "login-remove-2", record: SLOT_RECORD, claude: { status: { default: SIGNED_IN.status.default } }, args: ["--remove", "2"] },
  ];
  for (const { button, record, claude, args } of cases) {
    const { cx, draw } = await panel({ record, claude, writer: true });
    const before = state.files.get(LOGINS) ?? null;
    state.exec = claudeExec(claude, (_, words) => words.includes("set-login")
      ? { code: 0, stdout: JSON.stringify({ ok: true, snapshot: "a".repeat(64) }), stderr: "" }
      : { code: 0, stdout: "", stderr: "" });
    state.hc = () => ({ code: 0, stdout: "[]", stderr: "" });
    const writes = [];
    state.onWrite = (...write) => { if (write[0] === LOGINS) writes.push(write); };
    try {
      draw();
      nodes.get(button).click(null, cx);
      if (button === "login-remove-2") {
        draw();
        nodes.get(button).click(null, cx);
      }
      await cx.settle();
      assert.deepEqual(state.calls.filter((call) => call.includes("set-login")), [
        [...ACCOUNTS_WRITER, ...args, "--snapshot", snapshotOf(before)],
      ]);
      assert.deepEqual(writes, []);
    } finally {
      delete state.onWrite;
      state.hc = () => ({ code: 0, stdout: "{}", stderr: "" });
    }
  }
});

test("Claude Use keeps the conflict line and shows only fixed set-login codes", async () => {
  const { cx, draw } = await panel({ record: SLOT_RECORD, claude: SIGNED_IN, writer: true });
  const before = state.files.get(LOGINS);
  for (const code of ["conflict", "busy", "failed"]) {
    state.exec = claudeExec(SIGNED_IN, (_, args) => args.includes("set-login")
      ? { code: 1, stdout: JSON.stringify({ error: code }), stderr: "CANARY-STDERR-0043" }
      : { code: 0, stdout: "", stderr: "" });
    draw();
    nodes.get("login-use-2").click(null, cx);
    await cx.settle();
    const shown = text(draw());
    assert.ok(shown.includes(`claude-logins.json changed since the panel read it, or couldn't be written (${code})`));
    assert.doesNotMatch(shown, /CANARY-STDERR-0043/);
    assert.equal(state.files.get(LOGINS), before);
  }
});

test("an absent or older sidebar keeps the legacy snapshot write and an unreadable sidebar refuses it", async () => {
  for (const marker of [null, SIDEBAR_MARKERS[0], SIDEBAR_MARKERS[1], "unreadable"]) {
    const { cx, draw } = await panel({ record: SLOT_RECORD, claude: SIGNED_IN, sidebar: Boolean(marker), writer: Boolean(marker) });
    if (marker === "unreadable") {
      state.onRead = (path) => {
        if (path === `${state.appHome}/${SIDEBAR_MARKERS[0]}`) throw Object.assign(new Error(), { code: "EACCES" });
      };
    } else if (marker) state.files.delete(`${state.appHome}/${marker}`);
    const before = state.files.get(LOGINS);
    const writes = [];
    state.onWrite = (...write) => { if (write[0] === LOGINS) writes.push(write); };
    try {
      draw();
      nodes.get("login-use-2").click(null, cx);
      await cx.settle();
      if (marker === "unreadable") {
        assert.deepEqual(writes, []);
        assert.equal(state.files.get(LOGINS), before);
      } else {
        assert.deepEqual(writes, [[LOGINS, `${JSON.stringify({ ...SLOT_RECORD, use: "2" }, null, 2)}\n`, before]]);
      }
      assert.equal(state.calls.some((call) => call.includes("set-login")), false);
    } finally {
      delete state.onRead;
      delete state.onWrite;
    }
  }
});

test("the panel confirms its loaded version at init and reload, and local edits survive a confirmation failure", async () => {
  const info = { v: 1, setLogin: true, version: "1.2.3" };
  const { view, cx, draw } = await panel({ record: SLOT_RECORD, claude: SIGNED_IN, writer: true, settle: false });
  await cx.settle();
  assert.deepEqual(JSON.parse(state.files.get(WRITER_PATH)), info);
  assert.deepEqual(state.calls.filter((call) => call[0] === "chmod"), [["chmod", "600", WRITER_PATH]]);
  state.files.set(`${state.appHome}/${SIDEBAR_VERSION}`, "1.2.4\n");
  state.files.set(WRITER_PATH, JSON.stringify({ ...info, version: "1.2.2" }));
  view.reload(cx);
  await cx.settle();
  assert.deepEqual(JSON.parse(state.files.get(WRITER_PATH)), info, "reload kept the version read at init");
  state.files.delete(WRITER_PATH);
  state.onWrite = (path) => { if (path === WRITER_PATH) throw new Error("CANARY-STDERR-0043"); };
  state.exec = claudeExec(SIGNED_IN, (_, args) => args.includes("set-login")
    ? { code: 0, stdout: JSON.stringify({ ok: true, snapshot: "a".repeat(64) }), stderr: "" }
    : { code: 0, stdout: "", stderr: "" });
  try {
    view.reload(cx);
    await cx.settle();
    assert.equal(state.files.has(WRITER_PATH), false);
    draw();
    nodes.get("login-use-2").click(null, cx);
    await cx.settle();
    assert.ok(state.calls.some((call) => call.includes("set-login")));
    assert.doesNotMatch(text(draw()), /CANARY-STDERR-0043|were not switched/);
  } finally { delete state.onWrite; }
});

test("Claude (#453): a bad record shows one red line naming the problem, and no Use, Add or Remove until it is fixed", async () => {
  // Login 2 itself is fine in the first two: only the record stops Use.
  for (const [record, said, folder] of [["{ not json", "is not valid JSON"], [{ use: "7", logins: [{ id: "2", dir: TWO }] }, "use names 7 that it doesn't list"],
    [{ use: "2", logins: [{ id: "2", dir: TWO }] }, `login 2's folder ${TWO} does not exist`, "missing\n"]]) {
    const { view, cx, draw } = await panel({ record, claude: { ...TWO_IN, folders: folder ? { [TWO]: folder } : {} } });
    if (!folder) assert.match(text(draw()), /dee@example\.com · login 2|cy@example\.com/, "login 2 signed in, its folder fine");
    const root = draw();
    const red = nodes.get("logins-problem");
    assert.equal(textOf({ __node: red }), `claude-logins.json ${said}: new Claude launches start on the default login until it is fixed`);
    assert.equal(red.props.color, "t.blocked");
    assert.deepEqual(buttons(root).filter((id) => /^(login-|primary-claude)/.test(id)), [], `no switch: ${said}`);
    const text0 = state.files.get(LOGINS);
    view.useLogin("2", cx);
    view.useLogin("default", cx);
    view.addLogin(cx);
    await cx.settle();
    assert.equal(state.files.get(LOGINS), text0, "nothing written");
    assert.match(text(root), /cy@example\.com · the default login In use/, "launches are on login A meanwhile");
  }
});

test("Claude overrides (#453 section 5): settings moving the folder, a credential method, Herdr's variables, a linked file turned real", async () => {
  const { draw } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }, { id: "3", dir: `${state.home}/.claude-3` }, { id: "4", dir: `${state.home}/.claude-4` }] },
    claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR, { authMethod: "api_key" }), [TWO]: signedIn("dee@example.com", "/moved"),
      [`${state.home}/.claude-4`]: signedIn("gus@example.com", `${state.home}/.claude-4`, { authMethod: "oauth_token" }),
      [`${state.home}/.claude-3`]: signedIn("fay@example.com", `${state.home}/.claude-3`) },
    folders: { [`${state.home}/.claude-3`]: "unlinked settings.json\nok\n" }, vars: ["ANTHROPIC_API_KEY"] } });
  const root = draw();
  const shown = text(root);
  assert.match(shown, /an API key outranks this sign-in/);
  assert.match(shown, /cy@example\.com · the default login In use not this sign-in's/, "its quota is not this sign-in's");
  assert.match(shown, /settings move login 2 to another folder: switching can't choose it/);
  assert.equal(nodes.has("login-use-2"), false, "no Use on a moved folder");
  assert.match(shown, /settings\.json in login 3 is no longer shared/);
  assert.match(shown, /gus@example\.com · login 4 Remove not this sign-in's a token variable outranks this sign-in/);
  assert.equal(nodes.has("login-use-4"), false, "an outranked sign-in on another login gets no Use");
  assert.ok(nodes.has("login-use-3"), "a file no longer shared is said, not a reason to refuse");
  assert.match(shown, /ANTHROPIC_API_KEY is set in Herdr's environment/);
  assert.doesNotMatch(JSON.stringify(state.calls), /sk-|printenv -- "\$n"\)/, "presence only: no value is read");
  const colour = (re) => all(root).find((n) => typeof n.kids[0] === "string" && re.test(n.kids[0]))?.props.color;
  assert.equal(colour(/settings move login 2/), "t.blocked");
  assert.equal(colour(/an API key outranks/), "t.working");
});

test("Claude Add login (#453 section 7): the next slot, recorded only once its folder passes and it is signed in", async () => {
  const { cx, draw } = await panel({ claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR) }, folders: { [TWO]: "missing\n" } } });
  let shown = text(draw());
  assert.match(shown, /To add login 2: make "\$HOME\/\.claude-2" and its links .* CLAUDE_CONFIG_DIR="\$HOME\/\.claude-2" claude auth login Add login 2/);
  nodes.get("login-add-button").click(null, cx);
  await cx.settle();
  assert.equal(state.files.has(LOGINS), false, "a missing folder records nothing");
  assert.match(text(draw()), /login 2 wasn't added: its folder .* does not exist: make it first/);
  state.exec = claudeExec({ status: { default: signedIn("cy@example.com", DEFAULT_DIR) } });
  nodes.get("login-add-button").click(null, cx);
  await cx.settle();
  assert.equal(state.files.has(LOGINS), false, "not signed in: nothing");
  assert.match(text(draw()), /doesn't say signed in: sign in first/);
  state.exec = claudeExec(TWO_IN);
  nodes.get("login-add-button").click(null, cx);
  await cx.settle();
  assert.deepEqual(JSON.parse(state.files.get(LOGINS)), { use: "default", logins: [{ id: "2", dir: TWO }] }, "use unchanged");
  shown = text(draw());
  assert.match(shown, /login 2 added: dee@example\.com\. Press Use on it/);
  assert.match(shown, /dee@example\.com · login 2 Use/);
  assert.match(shown, /Add login 3/);
});

test("Claude Remove login (#453 section 7): never the one in use; refused while signed in or while a pane runs on it by value", async () => {
  const record = { use: "default", logins: [{ id: "2", dir: TWO }] };
  const { cx, draw } = await panel({ record, claude: TWO_IN });
  const press = async () => {
    draw();
    nodes.get("login-remove-2").click(null, cx);
    draw();
    nodes.get("login-remove-2").click(null, cx);
    await cx.settle();
    return text(draw());
  };
  assert.match(await press(), /login 2 wasn't removed: it is still signed in: first, in a terminal, run CLAUDE_CONFIG_DIR="\$HOME\/\.claude-2" claude auth logout/);
  state.exec = claudeExec({ status: { default: signedIn("cy@example.com", DEFAULT_DIR) } });
  draw();
  nodes.get("am-refresh").click(null, cx);
  await cx.settle();
  state.hc = (args) => (args[0] === "ls" ? { code: 0, stdout: JSON.stringify([{ address: "t6", name: "w-6", state: "live" }, { address: "t7", state: "live" }]), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ argv: args[1] === "t6" ? ["/usr/bin/env", `CLAUDE_CONFIG_DIR=${TWO}`, "sh", "-c", "claude"] : ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "claude"] }), stderr: "" });
  assert.match(await press(), /login 2 wasn't removed: w-6 still runs on it: restart or stop it first/);
  assert.deepEqual(JSON.parse(state.files.get(LOGINS)), record);
  state.hc = (args) => (args[0] === "ls" ? { code: 0, stdout: JSON.stringify([{ address: "t7", state: "live" }]), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ argv: ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "claude"] }), stderr: "" });
  assert.match(await press(), /login 2 removed from the panel\. Its folder stays/);
  assert.deepEqual(JSON.parse(state.files.get(LOGINS)), { use: "default", logins: [] });
  // The login in use offers no Remove.
  const inUse = await panel({ record: { use: "2", logins: [{ id: "2", dir: TWO }] }, claude: TWO_IN });
  inUse.draw();
  assert.equal(nodes.has("login-remove-2"), false);
  assert.ok(nodes.has("login-use-default"), "the default login gets Use");
  state.hc = () => ({ code: 0, stdout: "{}", stderr: "" });
});

test("Claude Remove (#453 review M1): asked again at the press; a crash, unreadable output or no answer refuses, saying the panel can't tell", async () => {
  const record = { use: "default", logins: [{ id: "2", dir: TWO }] };
  for (const [answer, said] of [[{ code: 1, stdout: "", stderr: "node crashed" }, /claude auth status gave no answer the panel can read/],
    [{ code: 0, stdout: "Signed in as someone", stderr: "" }, /gave no answer the panel can read/],
    [() => new Promise(() => {}), /didn't answer in 0\.05 s/]]) {
    Panel.prototype.probeMs = 50;
    try {
      // Signed out when the panel last looked: only the press's own answer decides.
      const { cx, draw } = await panel({ record, claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR) } } });
      state.exec = claudeExec({ status: { default: signedIn("cy@example.com", DEFAULT_DIR), [TWO]: answer } });
      state.hc = () => ({ code: 0, stdout: "[]", stderr: "" });
      draw();
      nodes.get("login-remove-2").click(null, cx);
      draw();
      nodes.get("login-remove-2").click(null, cx);
      await cx.settle();
      assert.match(text(draw()), new RegExp(`login 2 wasn't removed: the panel can't tell whether login 2 is signed out \\(.*${said.source}`));
      assert.deepEqual(JSON.parse(state.files.get(LOGINS)), record, "the record keeps login 2");
    } finally {
      delete Panel.prototype.probeMs;
      state.hc = () => ({ code: 0, stdout: "{}", stderr: "" });
    }
  }
});

test("Claude Remove (#453 review L5): a pane on the folder by another spelling, or on an unmatched folder under home, refuses", async () => {
  const record = { use: "default", logins: [{ id: "2", dir: TWO }] };
  const { cx, draw } = await panel({ record, claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR) } } });
  const press = async () => {
    draw();
    nodes.get("login-remove-2").click(null, cx);
    draw();
    nodes.get("login-remove-2").click(null, cx);
    await cx.settle();
    return text(draw());
  };
  const panes = (argv) => (args) => (args[0] === "ls" ? { code: 0, stdout: JSON.stringify([{ address: "t6", name: "w-6", state: "live" }]), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ argv }), stderr: "" });
  try {
    state.hc = panes(["/usr/bin/env", `CLAUDE_CONFIG_DIR=${TWO}/`, "claude"]);
    assert.match(await press(), /w-6 still runs on it/);
    state.hc = panes(["/usr/bin/env", `CLAUDE_CONFIG_DIR=${state.home}/.claude-2-alias`, "claude"]);
    assert.match(await press(), /w-6 runs on a login folder the panel can't match to a login/);
    state.hc = panes(["/usr/bin/env", "CLAUDE_CONFIG_DIR=/elsewhere/x", "claude"]);
    assert.match(await press(), /login 2 removed from the panel/, "a folder outside home is not this login");
  } finally {
    state.hc = () => ({ code: 0, stdout: "{}", stderr: "" });
  }
});

test("Claude logins (#453 review M2): a check that never answers lands as didn't answer; a round asked for meanwhile waits, never runs beside it", async () => {
  Panel.prototype.probeMs = 40;
  try {
    const { draw } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }] },
      claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR), [TWO]: () => new Promise(() => {}) } } });
    const shown = text(draw());
    assert.doesNotMatch(shown, /Reading the logins/);
    assert.match(shown, /login 2 Remove usage not tracked claude auth status didn't answer in time/);
    assert.equal(nodes.has("login-use-2"), false);
  } finally {
    delete Panel.prototype.probeMs;
  }
  // A round held open: reloads meanwhile start no claude beside it; one more round follows it.
  let release;
  const held = new Promise((go) => { release = go; });
  const { view, cx, draw } = await panel({ record: { use: "default", logins: [{ id: "2", dir: TWO }] }, settle: false,
    claude: { status: { default: signedIn("cy@example.com", DEFAULT_DIR), [TWO]: () => held.then(() => signedIn("dee@example.com", TWO)) } } });
  const asks = () => state.calls.filter((c) => c[0] === "/usr/bin/env" && c.at(-1) === "status").length;
  for (const until = Date.now() + 10_000; asks() < 2 && Date.now() < until;) await new Promise((go) => setTimeout(go, 1));
  assert.equal(asks(), 2, "the first round: both logins, side by side");
  view.forceLogins = true;
  view.reload(cx);
  view.forceLogins = true;
  view.reload(cx);
  // Both reloads arrive while the round is held: the panel queues them (`probeAgain`) instead
  // of starting a round beside it. The queue marker is the proof; bounded() only turns a panel
  // that never handled the reload into a named failure instead of a hang. A panel that starts
  // the round anyway is named by the asks assertion. The wait ends on either outcome so a
  // broken panel fails on that assertion, not on the queue marker's 10 s net.
  //
  // One immediate at a time, cleared in `finally`: when bounded() gives up, the poll stops with
  // it. A poll that kept scheduling would keep the event loop alive, so the row would report its
  // failure and the file would still not exit.
  let pollHandle;
  try {
    await bounded(new Promise((resolve) => {
      const seen = () => {
        if (view.probeAgain || asks() > 2) return resolve();
        pollHandle = setImmediate(seen);
      };
      seen();
    }), "the reloads asked for while a round runs to reach its queue", {
      where: 'herdr/test/am-quota-panel.test.mjs, the "held round" row',
    });
  } finally {
    clearImmediate(pollHandle);
  }
  assert.equal(asks(), 2, "no round beside the one running");
  assert.equal(view.probeAgain, true, "the reload is queued behind the held round");
  assert.equal(view.probing, true, "the held round is still the one running");
  release();
  // The released round's own state is the proof; bounded() only fails the row, naming the
  // release, if the held status never settles and the queued round therefore never runs.
  await bounded(cx.settle(), "the released login round (and the one queued after it) to settle",
    { where: 'herdr/test/am-quota-panel.test.mjs, the "held round" row' });
  assert.equal(asks(), 4, "one queued round after it, not two");
  assert.match(text(draw()), /dee@example\.com · login 2 Use/);
});

const FLEET = `${state.appHome}/${FLEET_FILE}`;
const READER = `${state.appHome}/mods/am-sidebar/bin/accounts.mjs`;
const FLEET_CORE = "core-vm-other";
const FLEET_NAME = "vm-other";
const fixed = (stdout, code = 0, stderr = "") => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
const noFleet = () => fixed({});
const linkedMachine = () => fixed({ machines: [{ id: FLEET_CORE, name: FLEET_NAME, state: "connected" }] });
const linkedBot = (id = BOT, terminal = "t8", name = "Bot A") => ({
  id, name, project: "/project", expect: { core: FLEET_CORE, terminal, created_ms: 8 }, on: "login unknown",
});
const fleetRuns = () => state.runs.filter((run) => run.args.includes("am-quota.accounts=fleet"));
const fleetReads = () => state.hcCalls.filter((args) => args[0] === "machine");

function fleetRecord({ linked = null, effective = "ana@example.com", selected = "default" } = {}) {
  const at = iso(NOW);
  const entry = (name, identity) => ({
    name, at, state: "read", reason: null, cli: "pack", versions: identity.versions, panel: identity.panel,
    codex: nextObs("codex", null, identity.codex, at), claude: nextObs("claude", null, identity.claude, at), exceptions: identity.exceptions,
  });
  const local = entry(null, fixtureHere({ email: effective }));
  local.claude.selected = selected;
  return { v: 1, at, linked, machines: { local, [FLEET_CORE]: entry(FLEET_NAME, fixtureHere()) } };
}

function fleetReply({ bots = [], linked = null } = {}) {
  return fixed({ v: 1, at: iso(NOW), linked, machines: [{ core: FLEET_CORE, bots: {
    codex: [], claude: bots, ownHome: 0, unbound: 0, more: 0, codexReliable: false,
  } }] });
}

async function linkedPanel(t, { bots = [], seed = false, reader = true, sidebar = true, config, answer, listed, settle = true, record } = {}) {
  const oldHc = state.hc, oldExec = state.exec;
  t.after(() => { state.hc = oldHc; state.exec = oldExec; });
  state.hc = noFleet;
  const p = await panel({ config, sidebar, claude: TWO_IN, record });
  state.hcCalls = [];
  const hc = (args) => {
    if (args[0] === "machine") return listed ? listed() : linkedMachine();
    if (args[0] === "ls") return fixed({ terminals: [] });
    if (args[0] === "get") return fixed({ address: args[1], state: "live" });
    return fixed({});
  };
  state.hc = hc;
  if (reader) state.files.set(READER, "example program");
  if (seed) state.files.set(FLEET, JSON.stringify(fleetRecord()));
  const fallback = claudeExec(TWO_IN);
  state.exec = (program, args) => {
    if (program === "rm") {
      for (const file of args.slice(2)) state.files.delete(file);
      return fixed("");
    }
    if (program === "env" && args.at(-1) === "fleet") {
      if (answer) return answer();
      state.files.set(FLEET, JSON.stringify(fleetRecord()));
      return fleetReply({ bots });
    }
    return fallback(program, args);
  };
  state.calls = [];
  p.view.readFleet(p.cx, { force: true });
  if (settle) await p.cx.settle();
  return p;
}

test("no linked machine: one hc machine ls, no section or fleet run, and the same shell calls", async (t) => {
  const old = state.hc;
  t.after(() => { state.hc = old; });
  state.hcCalls = [];
  state.hc = noFleet;
  const p = await panel({ claude: TWO_IN });
  assert.deepEqual(fleetReads(), [["machine", "ls", "--json"]]);
  assert.equal(fleetRuns().length, 0);
  assert.doesNotMatch(text(p.draw()), /On linked machines/);
  assert.ok(state.calls.every((a) => a[0] !== "rm" && !a.includes("fleet")));
});

test("linked machines use a private fleet terminal and clean its files after success and failure", async (t) => {
  const p = await linkedPanel(t);
  assert.equal(fleetRuns().length, 1);
  const run = fleetRuns()[0];
  const tail = run.args.slice(run.args.indexOf("--") + 1);
  assert.deepEqual(tail.slice(-6), ["env", `HERDR_APP_HOME=${state.appHome}`, "sh", RUNNER, READER, "fleet"]);
  assert.match(tail[2], /^umask 077/);
  assert.ok(tail[2].includes('find "${out%/*}"') && tail[2].includes('-name "$slug-*"'));
  assert.equal(tail[6], "fleet");
  assert.match(tail[2], /"\$@" >"\$out" 2>\/dev\/null/);
  assert.doesNotMatch(tail.join(" "), /cat "\$err"|CODEX_HOME|automagik-herdr\.mjs/);
  assert.equal(run.files.err, null);
  assert.ok(state.calls.some((a) => a[0] === "rm" && a.includes(run.files.out) && a.includes(run.files.code)));
  assert.ok(!state.files.has(run.files.out) && !state.files.has(run.files.code));
  assert.match(text(p.draw()), /On linked machines.*vm-other/s);
  const leftover = `${state.appHome}/data/am-quota/runs/fleet-leftover.out`;
  state.files.set(leftover, "example");
  state.fileMtimes = new Map([[leftover, Date.now() - 2 * 24 * H]]);
  state.runFail = "CANARY-STDERR-0043";
  t.after(() => { state.runFail = undefined; delete state.fileMtimes; });
  p.view.readFleet(p.cx, { force: true });
  await p.cx.settle();
  assert.ok(state.calls.filter((a) => a[0] === "rm").length >= 2);
  assert.ok(state.files.has(leftover));
  assert.match(text(p.draw()), /The linked machines weren't read \(failed\)/);
  assert.doesNotMatch(text(p.draw()), /CANARY-STDERR-0043/);
  state.runFail = undefined;
  p.view.readFleet(p.cx, { force: true });
  await p.cx.settle();
  assert.equal(state.files.has(leftover), false);
});

test("a fleet run removes only abandoned private files", async (t) => {
  await linkedPanel(t);
  const args = fleetRuns()[0].args;
  const script = args[args.indexOf("-c") + 1];
  const runs = mkdtempSync(join(tmpdir(), "am-quota-fleet-runs-"));
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const fresh = join(runs, "fleet-new"), old = join(runs, "fleet-old");
  writeFileSync(fresh, "example");
  writeFileSync(old, "example");
  const abandoned = new Date(Date.now() - 2 * 24 * H);
  utimesSync(old, abandoned, abandoned);
  const r = spawnSync("sh", ["-c", script, "sh", join(runs, "fleet-done.out"), join(runs, "fleet-done.code"), "fleet", "true"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(fresh, "utf8"), "example");
});

test("a private apply and fleet read each refuse to start while the other is live", async (t) => {
  const p = await linkedPanel(t);
  const options = { runLabel: "am-quota.accounts", privateRun: true, followMs: 1_000 };
  const hc = state.hc;
  const originalRuns = state.runs.length;
  const dir = `${state.appHome}/data/am-quota/runs`;
  for (const [live, asked, error] of [
    ["fleet", "apply", { message: "the fleet read is still running", partway: true }],
    ["apply", "fleet", { code: "apply-running", partway: true }],
  ]) {
    const output = `${dir}/${live}-running.out`;
    state.files.set(output, "example");
    state.hcCalls = [];
    state.hc = (args) => args[0] === "ls" && args.includes(`am-quota.accounts=${live}`) ?
      fixed({ terminals: [{ address: "t8", state: "live" }] }) : hc(args);
    await assert.rejects(p.view.cliRun([asked], { ...options, label: asked }), error);
    assert.deepEqual(state.hcCalls, ["fleet", "apply"].map((label) => ["ls", "--label", `am-quota.accounts=${label}`, "--json"]));
    assert.equal(state.runs.length, originalRuns);
    assert.equal(state.files.get(output), "example");
  }
});

test("private fleet and apply scripts sweep only their own files older than a day", async (t) => {
  const p = await linkedPanel(t);
  await p.view.cliRun(["apply"], { runLabel: "am-quota.accounts", label: "apply", privateRun: true, followMs: 1_000 });
  const runs = mkdtempSync(join(tmpdir(), "am-quota-private-runs-"));
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const abandoned = new Date(Date.now() - 2 * 24 * H);
  const recent = new Date(Date.now() - 20 * 60_000);
  for (const label of ["fleet", "apply"]) {
    const other = label === "fleet" ? "apply" : "fleet";
    const args = state.runs.find((run) => run.args.includes(`am-quota.accounts=${label}`)).args;
    const [script, , , , slug] = args.slice(args.indexOf("-c") + 1);
    assert.equal(slug, label);
    const ownOld = join(runs, `${label}-old.out`);
    const ownRecent = join(runs, `${label}-recent.out`);
    const otherOld = join(runs, `${other}-old.out`);
    for (const [file, time] of [[ownOld, abandoned], [ownRecent, recent], [otherOld, abandoned]]) {
      writeFileSync(file, "example");
      utimesSync(file, time, time);
    }
    const out = join(runs, `${label}-done.out`), code = join(runs, `${label}-done.code`);
    const result = spawnSync("sh", ["-c", script, "sh", out, code, slug, "sh", "-c",
      "echo example; echo CANARY-STDERR-0043 >&2; exit 7"], { cwd: runs, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(out, "utf8"), "example\n");
    assert.equal(readFileSync(code, "utf8"), "7\n");
    assert.equal(existsSync(ownOld), false);
    assert.equal(existsSync(ownRecent), true);
    assert.equal(existsSync(otherOld), true);
  }
});

test("a sidebar without its dedicated reader gives the update line without running it", async (t) => {
  const p = await linkedPanel(t, { reader: false });
  assert.match(text(p.draw()), /Reading linked machines needs the sidebar mod switched on and up to date\./);
  assert.equal(fleetRuns().length, 0);
});

test("a failed list or run keeps cached rows and shows the failed attempt beside them", async (t) => {
  const p = await linkedPanel(t, { seed: true, listed: () => fixed("CANARY-STDERR-0043", 1),
    answer: () => fixed({ error: "busy" }, 1, "CANARY-STDERR-0043") });
  const drawn = text(p.draw());
  assert.match(drawn, /vm-other/);
  assert.match(drawn, /The linked machines weren't read \(busy\)/);
  assert.match(drawn, /The list of linked machines couldn't be read .+: rows show the last read\./);
  assert.match(drawn, /Last fleet read /);
  assert.doesNotMatch(drawn, /CANARY-STDERR-0043/);
});

test("fleet.json is drawn before the run answers, and a running read keeps a second from starting", async (t) => {
  let release, asked;
  const reply = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { asked = resolve; });
  const p = await linkedPanel(t, { seed: true, settle: false, answer: () => { asked(); return reply; } });
  await started;
  assert.match(text(p.draw()), /ana@example\.com, the same account as this Mac/);
  p.view.readFleet(p.cx, { force: true });
  release(fleetReply());
  await p.cx.settle();
  assert.equal(fleetRuns().length, 1);
  assert.equal(fleetReads().length, 1);
});

test("refresh forces a read and a tick reads at most every five minutes", async (t) => {
  const p = await linkedPanel(t);
  assert.equal(fleetRuns().length, 1);
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(fleetRuns().length, 1);
  p.draw();
  nodes.get("am-refresh").click(null, p.cx);
  await p.cx.settle();
  assert.equal(fleetRuns().length, 2);
  p.view.fleet.at -= 300_001;
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(fleetRuns().length, 3);
});

test("a Codex switch or ↻ reads this Mac's Codex reference again", async (t) => {
  const p = await linkedPanel(t);
  const file = `${state.home}/.codex/auth.json`;
  let reads = 0;
  state.onRead = (path) => { if (path === file) reads += 1; };
  switchFixture.write = (_provider, _account) => {
    state.files.set(file, auth("account-b"));
    return fpr("account-b");
  };
  t.after(() => { delete state.onRead; delete switchFixture.write; });
  state.files.set(file, auth("account-a"));
  p.view.tool = "codex";
  p.view.readFleet(p.cx, { force: true });
  await p.cx.settle();
  assert.match(text(p.draw()), /the same account as this Mac/i);
  const beforeSwitch = reads;
  nodes.get("primary-codex").click(null, p.cx);
  await p.cx.settle();
  assert.ok(reads > beforeSwitch);
  assert.match(text(p.draw()), /another account than this Mac's/i);
  const beforeRefresh = reads;
  state.files.set(file, auth("account-a"));
  nodes.get("am-refresh").click(null, p.cx);
  await p.cx.settle();
  assert.ok(reads > beforeRefresh);
  assert.match(text(p.draw()), /the same account as this Mac/i);
});

test("Codex linked rows show with no proxy and with a failed proxy read", async (t) => {
  const p = await linkedPanel(t, { config: null });
  p.view.tool = "codex";
  assert.match(text(p.draw()), /your own CLIProxyAPI/);
  assert.match(text(p.draw()), /signed in \(account [a-f0-9]{8}\); this Mac has no Codex login/);
  p.view.setup = null;
  p.view.error = "Proxy unavailable";
  assert.match(text(p.draw()), /Proxy unavailable.*On linked machines/s);
  assert.match(text(p.draw()), /vm-other/);
});

test("linked Restart checks the frozen bot and pane list, runs one at a time and rereads", async (t) => {
  const first = linkedBot(), second = linkedBot("b-bbbbbbbbbb", "t9", "Bot B");
  const p = await linkedPanel(t, { bots: [first, second] });
  const press = () => { p.draw(); nodes.get(`restart-claude-${FLEET_CORE}`).click(null, p.cx); };
  press();
  assert.match(text(p.draw()), /Restart 2 bots on vm-other\? Press again to confirm/);
  assert.match(text(p.draw()), /A restart from here starts ana@example\.com/);
  const old = p.view.fleet.answer.bots[FLEET_CORE].claude;
  p.view.fleet.answer.bots[FLEET_CORE].claude = [{ ...first, id: "b-cccccccccc" }, second];
  press();
  assert.match(text(p.draw()), /The list changed: press Restart again\./);
  assert.equal(state.runs.length, 1);
  p.view.fleet.answer.bots[FLEET_CORE].claude = old;
  const exec = state.exec;
  const issued = [];
  let finish, began;
  const started = new Promise((resolve) => { began = resolve; });
  state.exec = (program, args) => {
    if (!args.includes("--expect-pane")) return exec(program, args);
    issued.push(args.slice(args.indexOf("restart"), -1));
    if (issued.length === 1) return new Promise((resolve) => { finish = resolve; began(); });
    return fixed({});
  };
  press();
  press();
  await started;
  assert.equal(issued.length, 1);
  finish(fixed({ refused: "binding", error: "CANARY-STDERR-0043" }, 1, "CANARY-STDERR-0043"));
  await p.cx.settle();
  assert.deepEqual(issued, [first, second].map((bot) => ["restart", bot.id, "--project", bot.project,
    "--machine", FLEET_NAME, "--expect-pane", `${FLEET_CORE}/${bot.expect.terminal}/8`]));
  assert.match(text(p.draw()), /Bot A's pane is no longer the one shown: nothing was restarted\./);
  assert.doesNotMatch(text(p.draw()), /CANARY-STDERR-0043/);
  assert.equal(fleetRuns().length, 2);
});

test("linked Restart says when the old pane couldn't be confirmed ended", async (t) => {
  const p = await linkedPanel(t, { bots: [linkedBot()] });
  const exec = state.exec;
  state.exec = (program, args) => args.includes("--expect-pane") ? fixed({ retired: "unconfirmed" }, 0) : exec(program, args);
  const press = () => { p.draw(); nodes.get(`restart-claude-${FLEET_CORE}`).click(null, p.cx); };
  press();
  press();
  await p.cx.settle();
  assert.ok(text(p.draw()).includes("Bot A restarted in a new pane, but its old pane couldn't be confirmed ended: check it in Herdr before ending it."));
});

test("linked Restart with a readable exit code but unreadable output never says restarted", async (t) => {
  for (const [name, stdout] of [["truncated", '{"retired":"end'], ["empty", ""]]) {
    await t.test(name, async (t) => {
      const p = await linkedPanel(t, { bots: [linkedBot()] });
      const exec = state.exec;
      state.exec = (program, args) => args.includes("--expect-pane") ? fixed(stdout, 0) : exec(program, args);
      const press = () => { p.draw(); nodes.get(`restart-claude-${FLEET_CORE}`).click(null, p.cx); };
      press();
      press();
      await p.cx.settle();
      const drawn = text(p.draw());
      assert.match(drawn, /whether its old pane ended couldn't be verified/);
      assert.doesNotMatch(drawn, /Bot A restarted\./);
    });
  }
});

test("failed reads show only the fixed code, clear stdout files and never create stderr files", async (t) => {
  const p = await linkedPanel(t, { seed: true, answer: () => fixed({ error: "CANARY-STDERR-0043" }, 1, "CANARY-STDERR-0043") });
  assert.match(text(p.draw()), /The linked machines weren't read \(failed\)/);
  assert.doesNotMatch(text(p.draw()), /CANARY-STDERR-0043/);
  assert.ok(![...state.files.keys()].some((file) => file.includes("/runs/fleet-")));
  assert.doesNotMatch(JSON.stringify(fleetRuns().map((r) => r.args)), /CANARY-STDERR-0043/);
});

test("Claude compares against fleet.json's local effective email when the selected slot has a bad folder", async (t) => {
  const p = await linkedPanel(t, { record: { use: "2", logins: [{ id: "2", dir: "relative" }] }, answer: () => {
    state.files.set(FLEET, JSON.stringify(fleetRecord({ effective: "ana@example.com", selected: "2" })));
    return fleetReply();
  } });
  assert.match(text(p.draw()), /ana@example\.com, the same account as this Mac/);
});

test("without the sidebar runner a linked machine gives the update line without a terminal", async (t) => {
  const p = await linkedPanel(t, { sidebar: false });
  assert.match(text(p.draw()), /Reading linked machines needs the sidebar mod switched on and up to date\./);
  assert.equal(fleetRuns().length, 0);
});

test("the local Claude and Codex cards, banners and Restart draw as before", async (t) => {
  const p = await linkedPanel(t, { settle: false });
  p.view.switched.codex = { at: NOW, from: "ana@example.com", to: "bo@example.com",
    look: { bots: [{ id: BOT, name: "Bot A", project: "/project" }], reliable: true } };
  const marks = new Map();
  for (const tool of ["claude", "codex"]) {
    p.view.tool = tool;
    p.draw();
    marks.set(tool, ["card-" + tool, "switched-" + tool, "restart-" + tool].map((id) => nodes.has(id) ? text(nodes.get(id)) : null));
  }
  await p.cx.settle();
  for (const tool of ["claude", "codex"]) {
    p.view.tool = tool;
    p.draw();
    assert.deepEqual(["card-" + tool, "switched-" + tool, "restart-" + tool].map((id) => nodes.has(id) ? text(nodes.get(id)) : null), marks.get(tool));
  }
  assert.match(text(p.draw()), /On linked machines/);
});

const { buildPreview, commitPreview, settle: settleProgress, startAttempt, fence: fenceAttempt, close: closeAttempt } =
  await import("../mods/am-sidebar/accountsPlan.js");
const { emptyPlan, parsePlan, idDigest, PLAN_FILE, REQUESTS_DIR, LOCAL_CLAIM_MS, LOCAL_START_MS, LOCAL_FENCE_MS } =
  await import("../mods/am-quota/accountsPlanRecord.js");
const { sha256Hex } = await import("../mods/am-quota/sha256.js");

const PLAN = `${state.appHome}/${PLAN_FILE}`;
const REQUESTS = `${state.appHome}/${REQUESTS_DIR}`;
const ANA = "ana@example.test", BO = "bo@example.test", CY = "cy@example.test";
const PLAN_LOGIN = { use: "default", logins: [{ id: "2", dir: TWO }] };
const PLAN_PROBES = { status: { default: signedIn(ANA, DEFAULT_DIR), [TWO]: signedIn(BO, TWO) } };
const TARGET_HOME = "/example-app";
const PLAN_ID = "1".repeat(32);
const PLAN_PROXY = "https://proxy.example.test";
const PLAN_CREDENTIAL = "CANARY-PLAN-0043";
const planProgress = (kind, now = Date.now()) => ({ state: kind, why: null, at: iso(now), tried: null, attempt: null, read: null });

function addPlanMember(plan, tool, machine, account, home, seen, status) {
  const section = plan[tool];
  section.members[machine] = { home, since: plan.at };
  section.seen[machine] = { home, ...seen };
  section.assign[machine] = account;
  section.pin[machine] = account;
  section.progress[machine] = planProgress(status);
  if (machine !== "local") plan.names[machine] = "vm-one";
  return plan;
}

function planViews() {
  const identity = fixtureHere({ email: ANA }).claude;
  identity.slots.push({ id: "2", email: BO, state: "eligible" });
  identity.nextSlot = "/example-home/.claude-3";
  return [{ id: FLEET_CORE, name: "vm-one", appHome: TARGET_HOME, read: true, readAt: iso(Date.now()),
    qualified: true, claude: identity, exceptions: [{ project: "/example/projects/sample", why: "own-path" }] }];
}

async function planPanel(t, { linked = true, plan = null, probes = PLAN_PROBES, config } = {}) {
  const before = { exec: state.exec, hc: state.hc, onWrite: state.onWrite };
  t.after(() => Object.assign(state, before));
  state.hc = noFleet;
  const p = await panel({ claude: probes, config, active: null, writer: true, record: PLAN_LOGIN });
  state.calls = [];
  state.hcCalls = [];
  if (linked) p.view.fleet.members = [{ id: FLEET_CORE, name: "vm-one", connected: true }];
  const values = { committed: plan, preview: null, history: [], views: planViews(), handlers: {}, modes: [] };
  const save = (next) => {
    values.committed = next;
    state.files.set(PLAN, JSON.stringify(next));
  };
  if (plan) save(plan);
  const home = state.appHome;
  const base = () => ({ state: values.committed ? "ok" : "absent", rev: values.committed?.rev ?? 0, digest: null });
  const fallback = claudeExec(probes);
  state.exec = (program, args) => {
    if (program === "rm") {
      for (const file of args.slice(2)) state.files.delete(file);
      return fixed("");
    }
    if (program === "chmod" && args[1].startsWith(REQUESTS)) {
      values.modes.push([args[0], args[1]]);
      return fixed("");
    }
    if (program === "env" && args.includes(READER)) {
      const words = args.slice(args.indexOf(READER) + 1);
      values.history.push(words);
      if (words[0] === "apply") return fixed({ kind: "accounts.apply" }, 0, "CANARY-STDERR-0043");
      if (words[0] === "fleet") return fleetReply();
      const [, flag, arg] = words;
      const op = flag.slice(2);
      const file = ["request", "evidence", "outcome"].map((key) => words.includes(`--${key}`)
        ? `${REQUESTS}/${words[words.indexOf(`--${key}`) + 1]}.json` : null).find(Boolean);
      const request = file ? JSON.parse(state.files.get(file)) : null;
      if (file) state.files.delete(file);
      if (request) values.history.push(request);
      const refuse = (error) => fixed({ error }, 1, "CANARY-STDERR-0043");
      if (values.handlers[op]) return values.handlers[op]({ words, arg, request, refuse });
      if (op === "request") {
        const { preview, error } = buildPreview({ plan: values.committed, base: base(), views: values.views,
          request, now: Date.now(), id: PLAN_ID, sha256Hex, controllerHome: home });
        if (error) return refuse(error);
        values.preview = preview;
        return fixed({ kind: preview.kind, id: preview.id, rev: preview.base.rev, moves: preview.moves, flags: preview.flags,
          changes: preview.changes });
      }
      if (op === "commit") {
        const result = commitPreview(values.committed, base(), values.preview, { expectRev: Number(words[4]), now: Date.now(),
          sha256Hex, confirmForget: words.includes("--confirm-forget") });
        if (result.error) return refuse(result.error);
        save(result.plan);
        return fixed({ ok: true, rev: result.plan.rev });
      }
      throw new Error(`unexpected plan operation ${op}`);
    }
    return fallback(program, args);
  };
  state.hc = (args) => args[0] === "machine" && linked ? linkedMachine() : fixed({ terminals: [] });
  const click = async (id) => {
    p.draw();
    const node = nodes.get(`plan-${id}`);
    assert.ok(node?.click, id);
    node.click(null, p.cx);
    await p.cx.settle();
    return text(p.draw());
  };
  return { ...p, ...values, get committed() { return values.committed; }, save, click };
}

test("Manage previews every proved pin and linked launch effect and commits without a switch", async (t) => {
  const p = await planPanel(t);
  assert.match(text(p.draw()), /Manage across machines/);
  const shown = await p.click("manage");
  assert.match(shown, /This Mac: joins the plan on ana@example\.test/);
  assert.match(shown, /vm-one: pinned to ana@example\.test/);
  assert.match(shown, /vm-one: uses its managed app home/);
  assert.match(shown, /Its next start or restart from here starts ana@example\.test; a tree restart there starts ana@example\.test/);
  assert.match(shown, /sample sets its own PATH: not managed/);
  assert.doesNotMatch(shown, /\/example\/projects/);
  assert.equal(state.files.has(PLAN), false);
  const request = p.history.find((item) => item.kind === "manage");
  assert.equal(request.claudeLocal.email, ANA);
  const argv = state.calls.find((call) => call.includes("--request"));
  assert.match(argv.at(-1), /^[a-f0-9]{32}$/);
  assert.ok(state.calls.some((call) => call[0] === "sh" && call[2].includes('chmod 700') && call.at(-1) === REQUESTS));
  assert.deepEqual(p.modes, [["600", `${REQUESTS}/${argv.at(-1)}.json`]]);
  assert.doesNotMatch(JSON.stringify(state.calls), /ana@example\.test/);
  assert.match(await p.click("commit"), /Plan: each machine pinned/);
  assert.deepEqual(p.history.find((item) => item[1] === "--commit"), ["plan", "--commit", PLAN_ID, "--expect-rev", "0"]);
  assert.equal(p.committed.claude.pin[FLEET_CORE], ANA);
  assert.equal(state.runs.length, 0);
});

test("committing a linked pin runs Apply privately and follows it with a fleet read", async (t) => {
  const p = await planPanel(t);
  await p.click("manage");
  await p.click("commit");
  // The bound fleet row supplies the pin choices and the preview's current login.
  const view = p.views[0];
  const fixture = fleetRecord();
  fixture.machines[FLEET_CORE] = { ...fixture.machines[FLEET_CORE], core: FLEET_CORE, appHome: view.appHome,
    claude: nextObs("claude", null, view.claude, view.readAt) };
  p.view.fleet.record = fixture;
  assert.match(await p.click(`${FLEET_CORE}-pin-1`), /vm-one: ana@example\.test → bo@example\.test/);
  await p.click("commit");
  assert.equal(p.committed.claude.assign[FLEET_CORE], BO);
  assert.deepEqual(state.runs.map((run) => run.args.find((word) => word.startsWith("am-quota.accounts="))),
    ["am-quota.accounts=apply", "am-quota.accounts=fleet"]);
  const apply = state.runs[0];
  assert.match(apply.args[apply.args.indexOf("-c") + 1], /2>\/dev\/null/);
  assert.deepEqual(apply.args.slice(-2), [READER, "apply"]);
  assert.doesNotMatch(JSON.stringify(apply.args), /CODEX_HOME|example-key|CANARY-/);
  assert.doesNotMatch(text(p.draw()), /CANARY-/);
  assert.ok(![...state.files.keys()].some((path) => path.includes("/runs/")));
});

test("commit displays fixed refusals and an overlapping fleet read leaves the preview alone", async (t) => {
  const p = await planPanel(t);
  for (const [code, line] of [
    ["stale", /The plan changed since this preview: look again/],
    ["busy", /Machines are being switched now/],
    ["busy-local", /This Mac is being switched now/],
    ["expired", /This preview is too old/],
    ["newer-plan", /This plan was written by a newer version/],
  ]) {
    await p.click("manage");
    p.handlers.commit = ({ refuse }) => refuse(code);
    assert.match(await p.click("commit"), line);
  }
  const pview = p.view;
  pview.preview = { id: PLAN_ID, rev: 0, changes: [], flags: [], moves: [{ tool: "claude", machine: FLEET_CORE, to: BO }] };
  pview.fleet.running = true;
  const writes = p.history.length;
  const output = `${state.appHome}/data/am-quota/runs/fleet-active.out`;
  state.files.set(output, "fleet evidence");
  assert.match(await p.click("commit"), /Machines are being switched now/);
  assert.equal(p.history.length, writes);
  assert.equal(state.files.get(output), "fleet evidence");
});

test("a gone row offers Rebind and Forget while changed offers Adopt and Re-apply", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  addPlanMember(plan, "claude", "core-one", ANA, TARGET_HOME, { snapshot: "none", email: ANA }, "suspended");
  addPlanMember(plan, "claude", FLEET_CORE, ANA, TARGET_HOME, { snapshot: "none", email: ANA }, "suspended");
  plan.names[FLEET_CORE] = "vm-two";
  plan.claude.progress["core-one"].why = "gone";
  plan.claude.progress[FLEET_CORE].why = "changed";
  const p = await planPanel(t, { plan });
  p.view.fleet.members.push({ id: "core-new", name: "vm-new", connected: true });
  await p.view.readPlan();
  const shown = text(p.draw());
  assert.match(shown, /vm-one gone: unlinked.*Forget/s);
  assert.match(shown, /Rebind to vm-new/);
  assert.ok(nodes.get("plan-core-one-forget") && !nodes.get(`plan-${FLEET_CORE}-forget`));
  assert.ok(nodes.get(`plan-${FLEET_CORE}-adopt`) && nodes.get(`plan-${FLEET_CORE}-reapply`));
  await p.click("core-one-forget");
  await p.click("commit");
  assert.equal(p.committed.claude.members["core-one"], undefined);
  assert.equal(p.committed.claude.progress[FLEET_CORE].why, "changed");
});

test("a new panel reads a pending local Claude slot, claims it at the revision and awaits the read-back", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  plan.rev = 7;
  const snapshot = sha256Hex(JSON.stringify(PLAN_LOGIN));
  addPlanMember(plan, "claude", "local", BO, state.appHome, { snapshot, email: ANA }, "pending");
  const p = await planPanel(t, { linked: false, plan });
  p.handlers["start-local"] = ({ words, request }) => {
    assert.equal(words[words.indexOf("--expect-rev") + 1], "7");
    assert.deepEqual(request, { v: 1, kind: "evidence", assign: BO, before: snapshot, home: state.appHome,
      eff: ANA, effSlot: "default", slot: "2", proxy: null });
    return fixed({ ok: true, attempt: { n: 1, at: iso(Date.now()), rev: 7, assign: BO, slot: "2", proxy: null }, seen: plan.claude.seen.local });
  };
  p.handlers["write-local"] = ({ words }) => {
    assert.ok(words.includes(snapshot) && !words.includes("--slot"));
    const next = JSON.stringify({ ...PLAN_LOGIN, use: "2" });
    state.files.set(LOGINS, next);
    return fixed({ ok: true, snapshot: sha256Hex(next) });
  };
  p.handlers["record-local"] = ({ request }) => {
    assert.equal(request.state, "done");
    assert.equal(request.read.email, BO);
    assert.equal(request.read.effective, "2");
    p.save(settleProgress(plan, "claude", "local", { state: "done",
      seen: { home: state.appHome, snapshot: request.read.snapshot, email: BO }, read: request.read, now: Date.now() }));
    return fixed({ ok: true });
  };
  p.view.reload(p.cx);
  await p.cx.settle();
  assert.deepEqual(p.history.filter(Array.isArray).map((item) => item[1]), ["--start-local", "--write-local", "--record-local"]);
  assert.match(text(p.draw()), /This Mac on bo@example\.test/);
  assert.doesNotMatch(JSON.stringify(state.calls), /ana@example\.test|bo@example\.test/);
});

test("a stale local claim writes no slot, and a differently signed-in effective slot suspends recovery", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  plan.rev = 9;
  const snapshot = sha256Hex(JSON.stringify(PLAN_LOGIN));
  addPlanMember(plan, "claude", "local", BO, state.appHome, { snapshot, email: ANA }, "pending");
  const p = await planPanel(t, { plan, linked: false,
    probes: { status: { default: signedIn(CY, DEFAULT_DIR), [TWO]: signedIn(BO, TWO) } } });
  p.handlers["start-local"] = ({ refuse }) => refuse("stale");
  p.view.reload(p.cx);
  await p.cx.settle();
  assert.ok(p.history.some((item) => item[1] === "--start-local"));
  assert.ok(!p.history.some((item) => item[1] === "--write-local"));
  const started = startAttempt(plan, "claude", "local", { rev: 9, slot: "2", slotDigest: idDigest("2", BO, sha256Hex),
    before: snapshot, eff: ANA, effDigest: idDigest("default", ANA, sha256Hex), home: state.appHome,
    owner: "2".repeat(32), now: Date.now() - LOCAL_CLAIM_MS - 1 });
  p.save(started);
  p.handlers["record-local"] = ({ request }) => {
    assert.equal(request.state, "changed");
    assert.equal(request.read.snapshot, snapshot);
    assert.equal(request.read.email, CY);
    return fixed({ ok: true });
  };
  p.view.reload(p.cx);
  await p.cx.settle();
  assert.deepEqual(p.history.filter(Array.isArray).map((item) => item[1]), ["--start-local", "--record-local"]);
});

test("poll retries only a due linked member, at most once in five minutes", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  addPlanMember(plan, "claude", FLEET_CORE, BO, TARGET_HOME, { snapshot: "none", email: ANA }, "pending");
  const p = await planPanel(t, { plan });
  await p.view.readPlan();
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.deepEqual(p.history.filter((item) => item[0] === "apply"), [["apply", "--retry"]]);
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.history.filter((item) => item[0] === "apply").length, 1);
  p.view.applyAt -= 300_001;
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.history.filter((item) => item[0] === "apply").length, 2);
  state.files.delete(PLAN);
  p.view.applyAt -= 300_001;
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.history.filter((item) => item[0] === "apply").length, 2);
});

// RFC 0043 delivery 2, step 8: the rest of the panel's plan cases. The CLI's local verbs are
// played by `localCli` below, a small stand-in built on the same pure plan functions the CLI uses
// (accountsPlan.js), so two panels on one app home share one plan file and its checks.
const { suspend: suspendEntry } = await import("../mods/am-sidebar/accountsPlan.js");
const { own: ownKey, proxyId, recoverable, snapshotOf: readSnapshot } = await import("../mods/am-quota/accountsPlanRecord.js");
const CODEX_FILE = `${state.home}/.codex/auth.json`;
const CODEX_DIR = `${state.home}/.codex`;
const CODEX_BO = "codex-0b-bo-pro.json";
const PROXY_ID = proxyId(BASE);
const word = (words, flag) => words[words.indexOf(flag) + 1];

function localCli(p, { clock = () => Date.now() } = {}) {
  const live = () => parsePlan(state.files.get(PLAN) ?? null).plan;
  const attemptOf = (plan, tool) => ownKey(plan[tool].progress, "local")?.attempt ?? null;
  const liveAttempt = (plan, tool, words) => {
    const a = attemptOf(plan, tool);
    return a && a.n === Number(word(words, "--attempt")) && a.outcome === null && a.owner === word(words, "--owner")
      && a.rev === plan.rev && a.assign === ownKey(plan[tool].assign, "local") && clock() - Date.parse(a.at) < LOCAL_START_MS ? a : null;
  };
  const log = [];
  Object.assign(p.handlers, {
    "start-local": ({ words, arg: tool, request: ev, refuse }) => {
      log.push(["start-local", tool]);
      const plan = live();
      if (plan.rev !== Number(word(words, "--expect-rev"))) return refuse("stale");
      const progress = ownKey(plan[tool].progress, "local");
      const assign = ownKey(plan[tool].assign, "local");
      if (progress?.state !== "pending" || !assign) return refuse("not-pending");
      if (progress.attempt?.outcome === null) return refuse("claimed");
      if (ev.assign !== assign) return refuse("stale");
      const seen = plan[tool].seen.local;
      const claude = tool === "claude";
      const changed = ev.home !== seen.home || (claude
        ? ev.before !== seen.snapshot && ev.before !== progress.attempt?.after || Boolean(seen.email && ev.eff && seen.email !== ev.eff)
        : ev.before !== seen.generation || Boolean(seen.proxy && ev.proxy !== seen.proxy));
      if (changed) {
        p.save(suspendEntry(plan, tool, "local", "changed", clock()));
        return refuse("changed");
      }
      const next = startAttempt(plan, tool, "local", { rev: plan.rev, slot: ev.slot, before: ev.before, eff: ev.eff,
        home: ev.home, owner: word(words, "--owner"), proxy: ev.proxy, now: clock(),
        slotDigest: claude ? idDigest(ev.slot, assign, sha256Hex) : null,
        effDigest: claude ? idDigest(ev.effSlot, ev.eff ?? "", sha256Hex) : null });
      p.save(next);
      const { n, at } = attemptOf(next, tool);
      return fixed({ ok: true, attempt: { n, at, rev: plan.rev, assign, slot: ev.slot, proxy: ev.proxy }, seen });
    },
    "write-local": ({ words, refuse }) => {
      log.push(["write-local"]);
      const plan = live();
      const a = liveAttempt(plan, "claude", words);
      if (!a || a.after !== null) return refuse("stale");
      if (word(words, "--snapshot") !== a.before) return refuse("conflict");
      const text = state.files.get(LOGINS) ?? null;
      if ((text === null ? "none" : sha256Hex(text)) !== a.before) return refuse("conflict");
      const next = JSON.stringify({ ...JSON.parse(text), use: a.slot });
      state.files.set(LOGINS, next);
      plan.claude.progress.local.attempt.after = sha256Hex(next);
      p.save(plan);
      return fixed({ ok: true, snapshot: sha256Hex(next) });
    },
    "fence-local": ({ words, refuse }) => {
      log.push(["fence-local"]);
      const plan = live();
      const a = liveAttempt(plan, "codex", words);
      if (!a || a.fencedAt || word(words, "--proxy") !== a.proxy) return refuse("stale");
      const generation = word(words, "--generation");
      if ((generation === "none" ? null : generation) !== a.before) return refuse("changed");
      p.save(fenceAttempt(plan, "codex", "local", a.n, { intended: word(words, "--intended"), now: clock() }));
      return fixed({ ok: true });
    },
    "install-local": ({ words, refuse }) => {
      const plan = live(), a = attemptOf(plan, "codex");
      if (!a || a.n !== Number(word(words, "--attempt")) || a.owner !== word(words, "--owner")
        || a.rev !== plan.rev || a.rev !== Number(word(words, "--expect-rev")) || a.outcome !== null
        || a.intended !== word(words, "--intended") || !a.fencedAt || clock() - Date.parse(a.fencedAt) >= LOCAL_FENCE_MS) {
        return refuse("stale");
      }
      return fixed({ ok: true });
    },
    "record-local": ({ words, arg: tool, request: out, refuse }) => {
      log.push(["record-local", tool, out.state, out.why]);
      const plan = live();
      const a = attemptOf(plan, tool);
      const n = Number(word(words, "--attempt"));
      if (a?.n !== n || a.outcome !== null || a.assign !== ownKey(plan[tool].assign, "local")) return refuse("stale");
      if (word(words, "--owner") !== a.owner && (out.state === "failed" || !recoverable(a, clock()))) return refuse("claimed");
      const { read } = out;
      let seen, placed;
      if (out.state === "done") {
        if (tool === "claude") {
          if (read?.email !== a.assign) return refuse("bad-request");
          seen = { home: read.home, snapshot: readSnapshot(read), email: read.email };
        } else {
          if (!a.fencedAt || read?.generation !== a.intended) return refuse("bad-request");
          seen = { home: read.home, account: read.account, generation: read.generation, proxy: read.proxy };
          placed = out.placed ? { ...out.placed, at: iso(clock()) } : null;
        }
      }
      const next = settleProgress(plan, tool, "local", {
        state: out.state === "changed" ? "suspended" : out.state === "done" ? "done" : "pending",
        why: out.state === "changed" || out.state === "lost" ? out.state : out.why, seen,
        read: read ?? undefined, placed, now: clock() });
      p.save(closeAttempt(next, tool, "local", n, out.state));
      return fixed(placed ? { ok: true, rev: plan.rev } : { ok: true });
    },
    "suspend-local": ({ words, arg: tool, refuse }) => {
      log.push(["suspend-local", tool, word(words, "--expect-rev")]);
      const plan = live();
      if (Number(word(words, "--expect-rev")) !== plan.rev) return refuse("stale");
      if (ownKey(plan[tool].progress, "local")?.state !== "done") return refuse("not-done");
      p.save(suspendEntry(plan, tool, "local", "changed", clock()));
      return fixed({ ok: true });
    },
    "fail-local": ({ words, arg: tool, request: out, refuse }) => {
      log.push(["fail-local", tool, out.why]);
      const plan = live();
      if (Number(word(words, "--expect-rev")) !== plan.rev) return refuse("stale");
      const progress = ownKey(plan[tool].progress, "local");
      if (progress?.state !== "pending") return refuse("not-pending");
      if (progress.attempt?.outcome === null) return refuse("claimed");
      p.save(settleProgress(plan, tool, "local", { state: "pending", why: out.why, read: out.read, now: clock() }));
      return fixed({ ok: true });
    },
  });
  return { live, log };
}

/** A second Accounts panel on the same app home (another Herdr window): its own owner id. */
async function otherPanel() {
  const cx = makeCx();
  const view = new Panel();
  view.init({}, cx);
  await cx.settle();
  return { view, cx, draw: () => index(view.render()) };
}

const localClaudePlan = (assign = BO, { rev = 7, email = ANA, state: status = "pending" } = {}) => {
  const plan = emptyPlan(iso(Date.now()));
  plan.rev = rev;
  addPlanMember(plan, "claude", "local", assign, state.appHome, { snapshot: sha256Hex(JSON.stringify(PLAN_LOGIN)), email }, status);
  return plan;
};

const localCodexPlan = ({ rev = 3, assign = CODEX_BO, generation = sha256Hex(auth("account-a")), account = fpr("account-a"),
  proxy = PROXY_ID, status = "pending" } = {}) => {
  const plan = emptyPlan(iso(Date.now()));
  plan.rev = rev;
  addPlanMember(plan, "codex", "local", assign, CODEX_DIR, { account, generation, proxy, placed: null }, status);
  return plan;
};

const planOps = (p) => p.history.filter(Array.isArray).filter((item) => item[0] === "plan").map((item) => item[1]);
const reloadAll = async (p) => {
  p.view.reload(p.cx);
  await p.cx.settle();
};

test("local Claude writes nothing for a slot no longer eligible, another snapshot, another effective account or an incomplete round", async (t) => {
  // No login of the assigned account here: recorded as a pending refusal, with no attempt and no write.
  let p = await planPanel(t, { linked: false, plan: localClaudePlan(CY) });
  let cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, [["fail-local", "claude", "no-login"]]);
  assert.equal(p.committed.claude.progress.local.why, "no-login");
  assert.equal(p.committed.claude.progress.local.attempt, null);
  assert.equal(state.files.get(LOGINS), JSON.stringify(PLAN_LOGIN));
  // A second draw with nothing new sends nothing.
  await reloadAll(p);
  assert.equal(cli.log.length, 1);

  // The slot is signed in but no longer eligible (signed out): not-eligible, nothing written.
  p = await planPanel(t, { linked: false, plan: localClaudePlan(BO),
    probes: { status: { default: signedIn(ANA, DEFAULT_DIR) } } });
  state.files.set(PLAN, JSON.stringify(localClaudePlan(BO)));
  cli = localCli(p);
  await reloadAll(p);
  assert.ok(!cli.log.some(([op]) => op === "start-local" || op === "write-local"));
  assert.equal(state.files.get(LOGINS), JSON.stringify(PLAN_LOGIN));

  // The record changed since the commit (another snapshot): the CLI suspends it, nothing written.
  p = await planPanel(t, { linked: false, plan: localClaudePlan(BO) });
  cli = localCli(p);
  const other = { ...PLAN_LOGIN, logins: [...PLAN_LOGIN.logins] };
  state.files.set(LOGINS, JSON.stringify(other) + " ");
  p.view.forceLogins = true;
  await reloadAll(p);
  assert.deepEqual(cli.log.map(([op]) => op), ["start-local"]);
  assert.equal(p.committed.claude.progress.local.state, "suspended");
  assert.equal(p.committed.claude.progress.local.why, "changed");
  assert.match(text(p.draw()), /changed on the machine: now ana@example\.test/);

  // Another account signed into the effective slot since the commit: suspended, nothing written.
  p = await planPanel(t, { linked: false, plan: localClaudePlan(BO),
    probes: { status: { default: signedIn(CY, DEFAULT_DIR), [TWO]: signedIn(BO, TWO) } } });
  cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log.map(([op]) => op), ["start-local"]);
  assert.equal(p.committed.claude.progress.local.state, "suspended");
  assert.equal(state.files.get(LOGINS), JSON.stringify(PLAN_LOGIN));

  // An incomplete round (a login that didn't answer) records and writes nothing.
  p = await planPanel(t, { linked: false, plan: localClaudePlan(BO),
    probes: { status: { default: signedIn(ANA, DEFAULT_DIR), [TWO]: { code: 1, stdout: "CANARY-STATUS-0043", stderr: "CANARY-STATUS-0043" } } } });
  p.view.probeMs = 5;
  cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, []);
  assert.equal(p.committed.claude.progress.local.state, "pending");
  assert.doesNotMatch(text(p.draw()) + JSON.stringify([...state.files.values()]), /CANARY-STATUS-0043/);
});

test("two panels: a commit landing after a panel resolved the slot makes its claim stale, and it writes nothing", async (t) => {
  const p = await planPanel(t, { linked: false, plan: localClaudePlan(BO) });
  const cli = localCli(p);
  const start = p.handlers["start-local"];
  p.handlers["start-local"] = (args) => {
    // Panel B commits C between panel A's read and its claim.
    const plan = cli.live();
    plan.rev += 1;
    plan.claude.assign.local = CY;
    plan.claude.pin.local = CY;
    p.save(plan);
    return start(args);
  };
  await reloadAll(p);
  assert.deepEqual(cli.log.map(([op]) => op), ["start-local"]);
  assert.equal(state.files.get(LOGINS), JSON.stringify(PLAN_LOGIN));
  assert.equal(p.committed.claude.progress.local.attempt, null);
});

test("local drift: a Use here with a plan suspends local at the revision read, offering Adopt and Re-apply; an incomplete read suspends nothing", async (t) => {
  const plan = localClaudePlan(ANA, { rev: 4, email: ANA, state: "done" });
  const p = await planPanel(t, { linked: false, plan });
  const cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, []);
  assert.match(text(p.draw()), /This Mac on ana@example\.test/);
  // An incomplete round changes nothing.
  const exec = state.exec;
  state.exec = (program, args, options) => program === "/usr/bin/env" && args.includes(`CLAUDE_CONFIG_DIR=${TWO}`)
    ? fixed("", 1, "CANARY-STATUS-0043") : exec(program, args, options);
  p.view.probeMs = 5;
  p.view.forceLogins = true;
  await reloadAll(p);
  state.exec = exec;
  assert.deepEqual(cli.log, []);
  // A Use of login 2 on this Mac: the next round reads bo, so local is suspended at rev 4.
  p.handlers.use = ({ words }) => {
    const next = JSON.stringify({ ...PLAN_LOGIN, use: words[2] });
    state.files.set(LOGINS, next);
    return fixed({ ok: true, snapshot: sha256Hex(next) });
  };
  p.view.forceLogins = true;
  await reloadAll(p);
  p.draw();
  nodes.get("login-use-2").click(null, p.cx);
  await p.cx.settle();
  assert.deepEqual(cli.log.filter(([op]) => op === "suspend-local"), [["suspend-local", "claude", "4"]]);
  assert.equal(p.committed.claude.progress.local.state, "suspended");
  const drawn = text(p.draw());
  assert.match(drawn, /changed on the machine: now bo@example\.test/);
  assert.ok(nodes.get("plan-local-adopt") && nodes.get("plan-local-reapply"));
  assert.doesNotMatch(drawn, /CANARY-STATUS-0043/);
});

test("the reload path applies a pending local committed by another panel, and never runs it twice at once", async (t) => {
  const p = await planPanel(t, { linked: false, plan: localClaudePlan(BO) });
  const cli = localCli(p);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const start = p.handlers["start-local"];
  p.handlers["start-local"] = async (args) => {
    await held;
    return start(args);
  };
  await p.view.readPlan();
  const runs = [p.view.maybeLocal(p.cx), p.view.maybeLocal(p.cx), p.view.maybeLocal(p.cx)];
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all(runs);
  await p.cx.settle();
  assert.deepEqual(cli.log.map(([op]) => op), ["start-local", "write-local", "record-local"]);
  assert.equal(p.committed.claude.progress.local.state, "done");
  assert.equal(JSON.parse(state.files.get(LOGINS)).use, "2");
});

test("retries start no apply while one runs", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  addPlanMember(plan, "claude", FLEET_CORE, BO, TARGET_HOME, { snapshot: "none", email: ANA }, "pending");
  const p = await planPanel(t, { plan });
  await p.view.readPlan();
  p.view.applying = true;
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.history.filter((item) => item[0] === "apply").length, 0);
});

test("no linked machine and no plan: nothing of the plan is drawn or read", async (t) => {
  const p = await planPanel(t, { linked: false });
  await reloadAll(p);
  const drawn = text(p.draw());
  assert.doesNotMatch(drawn, /Manage across machines|Plan:|Pins every machine/);
  assert.ok(![...nodes.keys()].some((id) => String(id).startsWith("plan-")));
  assert.equal(p.history.length, 0);
});

const { place: realPlace } = await import("../mods/am-quota/switch.js");

test("place() runs its fence after the payload is written and restricted, right before the install; a refused fence installs nothing", async () => {
  const order = [];
  const target = `${state.home}/.codex/auth.json`;
  const io = {
    home: state.home, appHome: state.appHome, env: {},
    exec: async (command, args) => {
      order.push(command === "chmod" ? "chmod" : args.at(-1) === target ? "install" : "prepare");
      return { code: 0, stdout: "", stderr: "" };
    },
    writeTextFile: async () => { order.push("payload"); },
    unlink: async () => { order.push("unlink"); },
  };
  let fenced = null;
  await realPlace({ provider: "codex", body: auth("account-b"), ...io, fence: async (body) => { order.push("fence"); fenced = body; } });
  assert.deepEqual(order, ["prepare", "payload", "chmod", "fence", "install", "unlink"]);
  assert.equal(fenced, auth("account-b"));
  order.length = 0;
  await assert.rejects(realPlace({ provider: "codex", body: auth("account-b"), ...io,
    fence: async () => { order.push("fence"); throw new Error("fenced"); } }), /fenced/);
  assert.deepEqual(order, ["prepare", "payload", "chmod", "fence", "unlink"]);
  order.length = 0;
  await realPlace({ provider: "codex", body: auth("account-b"), ...io });
  assert.deepEqual(order, ["prepare", "payload", "chmod", "install", "unlink"]);
});

/** A panel with a pending local Codex assignment and a fake place() that calls the fence. */
async function codexPanel(t, { plan = localCodexPlan(), file = auth("account-a"), body = auth("account-b"), config, before, after, fail } = {}) {
  const p = await planPanel(t, { linked: false, plan, config });
  p.view.tool = "codex";
  if (file !== null) state.files.set(CODEX_FILE, file);
  const cli = localCli(p);
  const steps = [];
  const fence = p.handlers["fence-local"];
  p.handlers["fence-local"] = (args) => {
    steps.push("fence");
    return fence(args);
  };
  t.after(() => { delete switchFixture.place; });
  switchFixture.place = async ({ fence: check, installFenced }) => {
    steps.push("payload");
    before?.();
    if (check) await check(body);
    if (fail) throw new Error(fail);
    if (installFenced) await installFenced("2026-11-20T12-00-00-000Z");
    steps.push("install");
    state.files.set(CODEX_FILE, after ?? body);
    return { label: "Codex", fingerprint: fpr("account-b") };
  };
  return Object.assign(p, { cli, steps });
}

const codexEntry = (p) => p.committed.codex;

function listCodexBots(...starts) {
  const bots = starts.map(([id, since], i) => ({ id, name: id, status: "idle", agent: "codex",
    since: iso(since), project: "/scratch/project", terminal: `t${i + 1}` }));
  const exec = state.exec;
  state.exec = (command, args) => command === "env" && args.includes("ls") && args.includes("--all")
    ? fixed({ projects: [{ project: bots[0].project, bots }] }) : exec(command, args);
}

async function placeCodexC(p, other) {
  const name = "codex-cy-pro.json";
  other.view.accounts = [...other.view.accounts, { ...p.view.codexAccounts()[0], id: name, name, email: CY }];
  const live = p.committed;
  const { at, ...codexLocal } = (await other.view.readPlanCodex()).read;
  const base = { state: "ok", rev: live.rev };
  const options = { now: Date.now(), sha256Hex };
  const { preview } = buildPreview({ plan: live, base, views: [], controllerHome: state.appHome, ...options,
    request: { v: 1, kind: "pin", tool: "codex", machine: "local", account: name, codexLocal, codexUsable: [name] } });
  const committed = commitPreview(live, base, preview, { expectRev: base.rev, ...options });
  assert.ok(committed.plan, committed.error);
  p.save(committed.plan);
  switchFixture.place = async ({ account, fence, installFenced }) => {
    assert.equal(account.name, name);
    const body = auth("account-c");
    await fence(body);
    await installFenced("2026-11-20T12-00-00-000Z");
    state.files.set(CODEX_FILE, body);
    return { fingerprint: fpr("account-c") };
  };
  await other.view.readPlan();
  await other.view.maybeLocal(other.cx, { force: true, tools: ["codex"] });
  await other.cx.settle();
  assert.equal(codexEntry(p).seen.local.placed.name, name);
}

function seedCodexCard(p, name = "codex-0a-ana-pro.json", fingerprint = fpr("account-a")) {
  p.view.active = { codex: { name, fingerprint } };
  const bytes = JSON.stringify(p.view.active);
  state.files.set(ACTIVE, bytes);
  return bytes;
}

test("local Codex: the fence runs before the install, and done records placed only from the exact bytes installed", async (t) => {
  const p = await codexPanel(t);
  await reloadAll(p);
  assert.deepEqual(p.cli.log.map(([op]) => op), ["start-local", "fence-local", "record-local"]);
  assert.deepEqual(p.steps, ["payload", "fence", "install"]);
  const { progress, seen } = codexEntry(p);
  assert.equal(progress.local.state, "done");
  assert.deepEqual({ ...seen.local.placed, at: null }, { name: CODEX_BO, proxy: PROXY_ID, account: fpr("account-b"),
    generation: sha256Hex(auth("account-b")), at: null });
  assert.equal(progress.local.attempt.intended, sha256Hex(auth("account-b")));
  assert.match(text(p.draw()), /This Mac on bo@example\.com · Pro, placed here/);
  const evidence = p.history.find((item) => item.kind === "evidence");
  assert.deepEqual(evidence, { v: 1, kind: "evidence", assign: CODEX_BO, before: sha256Hex(auth("account-a")), home: CODEX_DIR,
    eff: null, effSlot: null, slot: null, proxy: PROXY_ID });
  assert.doesNotMatch(JSON.stringify(p.history) + JSON.stringify(state.calls), /CANARY-REFRESH-0043/);
});

test("a malformed Codex card leaves the confirmed managed switch, badge and bot lookup intact", async (t) => {
  const p = await codexPanel(t);
  const malformed = '{"codex":';
  state.files.set(ACTIVE, malformed);
  const exec = state.exec;
  const bot = { id: "b-demo", name: "Old Codex bot", agent: "codex", project: "/scratch/project", terminal: "t1",
    status: "idle", since: iso(Date.now() - H) };
  state.exec = (command, args) => command === "env" && args.includes("ls")
    ? fixed({ projects: [{ project: bot.project, bots: [bot] }] }) : exec(command, args);
  const cardWrites = [];
  state.onWrite = (path, _text, expected) => { if (path === ACTIVE) cardWrites.push(expected); };
  await reloadAll(p);

  const managed = state.files.get(ACTIVE);
  assert.deepEqual(JSON.parse(managed).codex, { name: CODEX_BO, fingerprint: fpr("account-b") });
  assert.deepEqual(cardWrites, [malformed]);
  assert.equal(codexEntry(p).progress.local.state, "done");
  assert.equal(p.view.view("codex").current.name, CODEX_BO);
  p.draw();
  assert.match(text(nodes.get("switched-codex")), /Codex is now on.*Old Codex bot/s);
  assert.ok(state.calls.some((call) => call[0] === "env" && call.includes("ls") && call.includes("--all")));

  const next = p.view.codexAccounts().find(({ name }) => name !== CODEX_BO);
  switchFixture.place = async ({ account }) => {
    assert.equal(account, next);
    state.files.set(CODEX_FILE, auth("account-a"));
    return { label: "Codex", fingerprint: fpr("account-a") };
  };
  p.view.use("codex", next, p.cx);
  await p.cx.settle();
  assert.deepEqual(cardWrites, [malformed, managed]);
  assert.equal(JSON.parse(state.files.get(ACTIVE)).codex.name, next.name);
});

test("Codex refresh after managed placement keeps the ordinary card in use and changes the plan's grant origin", async (t) => {
  const p = await codexPanel(t);
  seedCodexCard(p);
  await reloadAll(p);
  assert.match(text(p.draw()), /placed here/);

  state.files.set(CODEX_FILE, auth("account-b", { refreshed: true }));
  p.view.identities.codex.at -= 300_001;
  p.view.localAt.codex -= 300_001;
  await reloadAll(p);

  assert.equal(p.view.view("codex").current.name, CODEX_BO);
  assert.deepEqual(p.view.badges.codex, { text: "in use" });
  const drawn = text(p.draw());
  assert.doesNotMatch(drawn, /Changed outside this panel/);
  assert.match(drawn, /grant origin unknown/);
});

test("Codex Unpin followed by an outside switch uses the installed fingerprint even with a cached placement", async (t) => {
  const p = await codexPanel(t);
  seedCodexCard(p);
  await reloadAll(p);
  await p.click("local-unpin");
  await p.click("commit");
  assert.equal(codexEntry(p).progress.local, undefined);
  assert.equal(codexEntry(p).seen.local.placed.name, CODEX_BO);
  assert.equal(p.view.planCodex.generation, sha256Hex(auth("account-b")));

  state.files.set(CODEX_FILE, auth("account-c"));
  p.view.identities.codex.at -= 300_001;
  await reloadAll(p);

  assert.equal(p.view.planCodex.generation, sha256Hex(auth("account-b")));
  assert.equal(p.view.view("codex").current, null);
  assert.match(text(p.draw()), /Changed outside this panel/);
});

test("a delayed managed Codex reply cannot record or offer Restart after another panel places C", async (t) => {
  const p = await codexPanel(t);
  const first = p.handlers["record-local"];
  let resume, recorded;
  const paused = new Promise((resolve) => { resume = resolve; });
  const done = new Promise((resolve) => { recorded = resolve; });
  p.handlers["record-local"] = async (args) => {
    const reply = first(args);
    if (args.request.placed?.name === CODEX_BO) {
      recorded();
      await paused;
    }
    return reply;
  };
  const a = seedCodexCard(p);
  const cardWrites = [];
  state.onWrite = (path, body, expected) => {
    if (path === ACTIVE) cardWrites.push({ name: JSON.parse(body).codex.name, expected });
  };
  p.view.reload(p.cx);
  await done;
  try {
    assert.equal(codexEntry(p).progress.local.state, "done");
    const other = await otherPanel();
    const next = { ...p.view.codexAccounts()[0], id: "codex-cy-pro.json", name: "codex-cy-pro.json", email: CY };
    other.view.accounts = [...other.view.accounts, next];
    const live = p.committed, current = (await other.view.readPlanCodex()).read;
    const { at, ...codexLocal } = current;
    const base = { state: "ok", rev: live.rev };
    const options = { now: Date.now(), sha256Hex };
    const { preview } = buildPreview({ plan: live, base, views: [], controllerHome: state.appHome, ...options,
      request: { v: 1, kind: "pin", tool: "codex", machine: "local", account: next.name, codexLocal, codexUsable: [next.name] } });
    const committed = commitPreview(live, base, preview, { expectRev: base.rev, ...options });
    assert.ok(committed.plan, committed.error);
    p.save(committed.plan);
    switchFixture.place = async ({ account, fence, installFenced }) => {
      assert.equal(account.name, next.name);
      const body = auth("account-c");
      await fence(body);
      await installFenced("2026-11-20T12-00-00-000Z");
      state.files.set(CODEX_FILE, body);
      return { fingerprint: fpr("account-c") };
    };
    await other.view.readPlan();
    await other.view.maybeLocal(other.cx, { force: true, tools: ["codex"] });
    await other.cx.settle();
    assert.equal(codexEntry(p).seen.local.placed.name, next.name);
    assert.equal(state.files.get(CODEX_FILE), auth("account-c"));
    assert.deepEqual(cardWrites, [{ name: next.name, expected: a }]);
    state.calls = [];
  } finally {
    resume();
    await p.cx.settle();
  }
  assert.equal(cardWrites.length, 1);
  assert.ok(!p.view.switched.codex);
  p.draw();
  assert.ok(!nodes.has("switched-codex") && !nodes.has("restart-codex"));
  assert.ok(!state.calls.some((call) => call.includes("ls") && call.includes("--all")));
});

test("a new generation alone after Codex is recorded done prevents the card write and bot lookup", async (t) => {
  const p = await codexPanel(t);
  const original = seedCodexCard(p);
  const record = p.handlers["record-local"];
  p.handlers["record-local"] = (args) => {
    const reply = record(args);
    state.files.set(CODEX_FILE, auth("account-b", { refreshed: true }));
    return reply;
  };
  await reloadAll(p);

  assert.equal(codexEntry(p).progress.local.state, "done");
  assert.equal(state.files.get(ACTIVE), original);
  assert.ok(!p.view.switched.codex);
  assert.ok(!state.calls.some((call) => call.includes("ls") && call.includes("--all")));

  // The next poll reads B's refreshed bytes and uses the plan's name without writing the card.
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.view.view("codex").current.name, CODEX_BO);
  assert.equal(p.view.view("codex").pill.text, "In use");
  assert.doesNotMatch(text(p.draw()), /Changed outside this panel/);
  assert.equal(state.files.get(ACTIVE), original);

  state.files.set(`${state.appHome}/cliproxy.json`, JSON.stringify({ url: "https://other-proxy.example.test" }));
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.view.view("codex").current, null);
  assert.match(text(p.draw()), /Changed outside this panel/);
});

test("a newer plan revision alone after Codex is recorded done prevents the card write and bot lookup", async (t) => {
  const p = await codexPanel(t);
  const original = seedCodexCard(p);
  const record = p.handlers["record-local"];
  p.handlers["record-local"] = (args) => {
    const reply = record(args);
    const next = { ...p.committed, rev: p.committed.rev + 1 };
    p.save(next);
    return reply;
  };
  await reloadAll(p);

  assert.equal(codexEntry(p).seen.local.placed.generation, sha256Hex(state.files.get(CODEX_FILE)));
  assert.equal(state.files.get(ACTIVE), original);
  assert.ok(!p.view.switched.codex);
  assert.ok(!state.calls.some((call) => call.includes("ls") && call.includes("--all")));
});

test("Codex bot lookup uses the placement time when a successful completion reply is delayed", async (t) => {
  const p = await codexPanel(t);
  const record = p.handlers["record-local"];
  const bot = (id, since) => ({ id, name: id, status: "idle", agent: "codex", since,
    project: "/scratch/project", terminal: id === "old-bot" ? "t1" : "t2" });
  let placementAt;
  p.handlers["record-local"] = async (args) => {
    const reply = record(args);
    placementAt = Date.parse(codexEntry(p).seen.local.placed.at);
    const bots = [bot("old-bot", iso(placementAt - 1)), bot("new-bot", iso(placementAt + 1))];
    const exec = state.exec;
    state.exec = (command, words) => command === "env" && words.includes("ls")
      ? fixed({ projects: [{ project: bots[0].project, bots }] }) : exec(command, words);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return reply;
  };
  await reloadAll(p);
  assert.equal(p.view.switched.codex.at, placementAt);
  p.draw();
  assert.match(text(nodes.get("switched-codex")), /old-bot/);
  assert.doesNotMatch(text(nodes.get("switched-codex")), /new-bot/);
});

test("Codex recovery after a lost install reply lists every running Codex bot", async (t) => withClock(async () => {
  const p = await codexPanel(t);
  seedCodexCard(p);
  const install = p.handlers["install-local"], record = p.handlers["record-local"];
  const installedAt = Date.now();
  p.handlers["install-local"] = (args) => {
    const reply = install(args);
    if (reply.code !== 0) return reply;
    state.files.set(CODEX_FILE, auth("account-b"));
    const plan = p.cli.live();
    plan.codex.progress.local.attempt.installStarted = true;
    p.save(plan);
    return fixed("", 1);
  };
  // The installing panel goes away with the attempt still open.
  p.handlers["record-local"] = ({ refuse }) => refuse("failed");
  await reloadAll(p);
  assert.equal(codexEntry(p).progress.local.attempt.outcome, null);
  assert.equal(state.files.get(CODEX_FILE), auth("account-b"));
  assert.ok(!p.view.switched.codex);

  mock.timers.tick(1);
  listCodexBots(["old-bot", installedAt - 1], ["already-on-b", Date.now()]);
  mock.timers.tick(Math.max(LOCAL_CLAIM_MS, LOCAL_FENCE_MS) + 1);
  p.handlers["record-local"] = record;
  const other = await otherPanel();
  other.view.tool = "codex";
  assert.notEqual(other.view.owner, p.view.owner);
  assert.equal(codexEntry(p).progress.local.state, "done");
  assert.equal(other.view.switched.codex.look.reliable, false);
  assert.deepEqual(other.view.switched.codex.look.bots.map(({ id }) => id), ["old-bot", "already-on-b"]);
  other.draw();
  assert.match(text(nodes.get("switched-codex")), /lists them all:.*old-bot.*already-on-b/s);
}));

test("a managed Codex card write that returns after another panel installs C offers no Restart for B", async (t) => {
  const p = await codexPanel(t);
  const original = seedCodexCard(p);
  listCodexBots(["old-bot", Date.now() - H]);
  const bWriting = Promise.withResolvers(), bResume = Promise.withResolvers();
  const cWriting = Promise.withResolvers(), cResume = Promise.withResolvers();
  state.onWrite = (path, body, expected) => {
    if (path !== ACTIVE) return;
    assert.equal(expected, original);
    const isB = JSON.parse(body).codex.name === CODEX_BO;
    const writing = isB ? bWriting : cWriting;
    writing.resolve();
    return (isB ? bResume : cResume).promise;
  };
  t.after(() => { delete state.onWrite; });
  p.view.reload(p.cx);
  let c;
  try {
    await bounded(bWriting.promise, "B's card write");
    const other = await otherPanel();
    c = placeCodexC(p, other);
    await bounded(cWriting.promise, "C's card write");
    assert.equal(state.files.get(CODEX_FILE), auth("account-c"));
    assert.equal(state.files.get(ACTIVE), original);

    bResume.resolve();
    await p.cx.settle();
    assert.equal(JSON.parse(state.files.get(ACTIVE)).codex.name, CODEX_BO, "B's write succeeded");
    p.draw();
    assert.ok(!nodes.has("switched-codex") && !nodes.has("restart-codex"));
    assert.ok(!state.calls.some((call) => call.includes("ls") && call.includes("--all")));
  } finally {
    bResume.resolve();
    cResume.resolve();
    await p.cx.settle();
    await c;
  }
});

test("a confirmed managed Codex Restart refuses after another panel places C", async (t) => {
  const p = await codexPanel(t);
  seedCodexCard(p);
  listCodexBots(["old-bot", Date.now() - H]);
  await reloadAll(p);
  p.draw();
  nodes.get("restart-codex").click(null, p.cx);
  await p.cx.settle();
  assert.match(text(p.draw()), /Restart 1 bot\? Press again to confirm/);
  const confirm = nodes.get("restart-codex");

  const other = await otherPanel();
  await placeCodexC(p, other);
  confirm.click(null, p.cx);
  await p.cx.settle();
  assert.match(text(p.draw()), /This Codex placement was superseded\./);
  assert.ok(!nodes.has("restart-codex"));
  assert.deepEqual(restarts(), []);
});

test("a managed completion paused at Herdr's writer passes the same expected bytes as an ordinary Switch", async (t) => {
  const p = await codexPanel(t);
  const original = seedCodexCard(p);
  let resume, writing;
  const paused = new Promise((resolve) => { resume = resolve; });
  const atWriter = new Promise((resolve) => { writing = resolve; });
  const writes = [];
  state.onWrite = (path, body, expected) => {
    if (path !== ACTIVE) return;
    const { name } = JSON.parse(body).codex;
    writes.push({ name, expected });
    if (name === CODEX_BO) {
      writing();
      return paused;
    }
  };
  p.view.reload(p.cx);
  await atWriter;
  try {
    const other = await otherPanel();
    const next = { ...p.view.codexAccounts()[0], id: "codex-cy-pro.json", name: "codex-cy-pro.json", email: CY };
    switchFixture.place = async ({ account, fence }) => {
      assert.equal(account.name, next.name);
      assert.equal(fence, undefined);
      state.files.set(CODEX_FILE, auth("account-c"));
      return { fingerprint: fpr("account-c") };
    };
    other.view.use("codex", next, other.cx);
    await other.cx.settle();
    assert.deepEqual(writes, [{ name: CODEX_BO, expected: original }, { name: next.name, expected: original }]);
  } finally {
    resume();
    await p.cx.settle();
  }
  assert.equal(JSON.parse(state.files.get(ACTIVE)).codex.name, "codex-cy-pro.json");
  assert.equal(state.files.get(CODEX_FILE), auth("account-c"));
  assert.ok(!p.view.switched.codex);
});

test("local Codex: a same-account file with other bytes is changed, never placed; an install failure records a fixed code", async (t) => {
  let p = await codexPanel(t, { after: auth("account-b", { refreshed: true }) });
  await reloadAll(p);
  assert.deepEqual(p.steps, ["payload", "fence", "install"]);
  assert.equal(codexEntry(p).progress.local.state, "suspended");
  assert.equal(codexEntry(p).progress.local.why, "changed");
  assert.equal(codexEntry(p).seen.local.placed, null);

  p = await codexPanel(t, { fail: "could not write ~/.codex/auth.json: CANARY-SHELL-0043" });
  await reloadAll(p);
  assert.deepEqual(p.steps, ["payload", "fence"]);
  assert.deepEqual(p.cli.log.at(-1), ["record-local", "codex", "failed", "failed"]);
  assert.equal(codexEntry(p).seen.local.placed, null);
  assert.doesNotMatch(text(p.draw()) + JSON.stringify([...state.files.values()]) + JSON.stringify(p.history), /CANARY-SHELL-0043/);
});

test("local Codex reads back an empty install reply before settling the fenced attempt", async (t) => {
  for (const [file, outcome] of [[auth("account-b"), "done"], [auth("account-a"), "changed"]]) {
    const p = await codexPanel(t);
    p.handlers["install-local"] = () => {
      assert.equal(codexEntry(p).progress.local.attempt.outcome, null);
      state.files.set(CODEX_FILE, file);
      return fixed("");
    };
    await reloadAll(p);
    assert.deepEqual(p.cli.log.at(-1), ["record-local", "codex", outcome, outcome === "done" ? null : "changed"]);
    assert.equal(codexEntry(p).seen.local.placed?.generation ?? null, outcome === "done" ? sha256Hex(file) : null);
  }
});

test("ordinary Switch installs C on a managed Mac and the next poll suspends A without reinstalling it", async (t) => {
  const initial = "codex-0a-ana-pro.json";
  const next = "codex-cy-pro.json";
  const a = auth("account-a"), c = auth("account-c");
  const plan = localCodexPlan({ assign: initial, status: "done" });
  plan.codex.seen.local.placed = { name: initial, account: fpr("account-a"), generation: sha256Hex(a), proxy: PROXY_ID, at: plan.at };
  const p = await planPanel(t, { linked: false, plan });
  const cli = localCli(p);
  state.files.set(CODEX_FILE, a);
  state.files.set(ACTIVE, JSON.stringify({ codex: { name: initial, fingerprint: fpr("account-a") } }));
  p.view.tool = "codex";
  await reloadAll(p);

  const account = { ...p.view.codexAccounts()[0], id: next, name: next, email: CY };
  const shell = [];
  t.after(() => { delete switchFixture.place; });
  switchFixture.place = ({ provider, account: selected, fence, installFenced }) => {
    assert.equal(selected.name, next);
    assert.equal(fence, undefined);
    assert.equal(installFenced, undefined);
    return realPlace({ provider, body: c, home: state.home, appHome: state.appHome,
      writeTextFile: async (path, body) => state.files.set(path, body),
      unlink: async (path) => state.files.delete(path),
      exec: async (command, args) => {
        if (command === "sh" && args.at(-1) === CODEX_FILE) {
          shell.push(args[1]);
          state.files.set(CODEX_FILE, state.files.get(args.at(-2)));
        }
        return fixed("");
      } });
  };
  const count = installs.length;
  p.view.use("codex", account, p.cx);
  await p.cx.settle();
  assert.equal(shell.length, 1);
  assert.match(shell[0], /mv "\$2\.tmp-/);
  assert.equal(state.files.get(CODEX_FILE), c);
  assert.equal(JSON.parse(state.files.get(ACTIVE)).codex.name, next);
  p.view.localAt.codex = 0;
  p.view.tick(p.cx);
  await p.cx.settle();
  assert.equal(p.committed.codex.assign.local, initial);
  assert.equal(p.committed.codex.progress.local.state, "suspended");
  assert.equal(p.committed.codex.progress.local.why, "changed");
  assert.deepEqual(cli.log, [["suspend-local", "codex", String(plan.rev)]]);
  assert.deepEqual(installs.slice(count), [{ provider: "codex", id: next }]);
  assert.equal(state.files.get(CODEX_FILE), c);
  p.draw();
  assert.ok(nodes.get("plan-local-adopt") && nodes.get("plan-local-reapply"));
});

test("Manage leaves a sole listed Codex name observed after an alias disappears and offers Place", async (t) => {
  const p = await planPanel(t);
  const old = p.view.codexAccounts()[0];
  p.view.accounts = [old];
  const installed = auth("account-a").replace("CANARY-REFRESH-0043", "CANARY-REFRESH-0043-ALIAS");
  state.files.set(CODEX_FILE, installed);
  state.files.set(ACTIVE, JSON.stringify({ codex: { name: old.name, fingerprint: fpr("account-a") } }));
  p.view.tool = "codex";
  await p.click("manage");
  const request = p.history.find(({ kind }) => kind === "manage");
  assert.deepEqual(request.codexAccounts, [old.name]);
  assert.equal(request.codexLocal.account, request.active.fingerprint);
  assert.equal(p.view.preview.changes.some(({ tool }) => tool === "codex"), false);
  await p.click("commit");
  assert.equal(p.committed.codex.pin.local, undefined);
  assert.equal(p.committed.codex.members.local, undefined);
  assert.equal(state.files.get(CODEX_FILE), installed);
  assert.match(text(p.draw()), /Place .+ on this Mac/);
});

test("Place for a Codex One override previews, commits and downloads the pinned account", async (t) => {
  const plan = localCodexPlan();
  const group = "codex-0a-ana-pro.json";
  plan.codex.mode = "one";
  plan.codex.account = group;
  Object.assign(plan.codex.seen.local, { account: fpr("account-b"), generation: sha256Hex(auth("account-b")) });
  plan.codex.progress.local.state = "done";
  const p = await codexPanel(t, { plan, file: auth("account-b", { refreshed: true }) });
  state.files.set(ACTIVE, JSON.stringify({ codex: { name: CODEX_BO, fingerprint: fpr("account-b") } }));
  await reloadAll(p);
  p.draw();
  const button = nodes.get("plan-local-place-0");
  const label = p.view.codexAccounts().find(({ name }) => name === CODEX_BO).email;
  assert.equal(text(button), `Place ${label} · Pro on this Mac`);
  const wrong = await p.view.planCommand("request", {}, { kind: "add", tool: "codex", machine: "local",
    account: group, codexUsable: [group, CODEX_BO], codexLocal: { home: CODEX_DIR, account: fpr("account-b"),
      generation: sha256Hex(auth("account-b", { refreshed: true })), proxy: PROXY_ID } });
  assert.equal(wrong.error, "not-eligible");
  const count = installs.length;
  await p.click("local-place-0");
  assert.deepEqual(p.view.preview.changes[0].assign, [CODEX_BO, CODEX_BO]);
  await p.click("commit");
  await reloadAll(p);
  assert.equal(p.committed.codex.assign.local, CODEX_BO);
  assert.equal(p.committed.codex.pin.local, CODEX_BO);
  assert.deepEqual(installs.slice(count), [{ provider: "codex", id: CODEX_BO }]);
});

test("initial Codex Place in One and Spread offers, previews and installs the account the mode chooses", async (t) => {
  const target = "codex-0a-ana-pro.json";
  for (const mode of ["one", "spread"]) {
    const plan = emptyPlan(iso(Date.now()));
    plan.rev = 3;
    Object.assign(plan.codex, { mode, account: mode === "one" ? target : null });
    const p = await codexPanel(t, { plan, file: auth("account-b"), body: auth("account-a") });
    state.files.set(ACTIVE, JSON.stringify({ codex: { name: CODEX_BO, fingerprint: fpr("account-b") } }));
    await reloadAll(p);
    p.draw();
    const buttons = [...nodes.keys()].filter((id) => id.startsWith("plan-local-place-"));
    assert.deepEqual(buttons, ["plan-local-place-0"]);
    const label = p.view.codexAccounts().find(({ name }) => name === target).email;
    assert.equal(text(nodes.get(buttons[0])), `Place ${label} · Pro on this Mac`);
    const wrong = await p.view.planCommand("request", {}, { kind: "add", tool: "codex", machine: "local",
      account: CODEX_BO, codexUsable: [target, CODEX_BO], codexLocal: { home: CODEX_DIR, account: fpr("account-b"),
        generation: sha256Hex(auth("account-b")), proxy: PROXY_ID } });
    assert.equal(wrong.error, "not-eligible");
    const count = installs.length;
    await p.click("local-place-0");
    assert.deepEqual(p.view.preview.changes[0].assign, [null, target]);
    assert.equal(p.view.preview.moves[0].to, target);
    await p.click("commit");
    await reloadAll(p);
    assert.equal(p.committed.codex.assign.local, target);
    assert.deepEqual(installs.slice(count), [{ provider: "codex", id: target }]);
  }
});

test("local Codex installs nothing for another CODEX_HOME, a refreshed file, a changed proxy, an unusable account, a refused fence or a slow start", async (t) => {
  const installed = () => installs.filter((item) => item.provider === "codex").length;
  // Another CODEX_HOME in Herdr's environment: the CLI suspends it at the claim.
  let p = await codexPanel(t);
  const exec = state.exec;
  state.exec = (program, args, options) => program === "sh" && args.at(-1) === "CODEX_HOME"
    ? fixed(`${state.home}/other-codex`) : exec(program, args, options);
  let count = installed();
  await reloadAll(p);
  state.exec = exec;
  assert.deepEqual(p.cli.log.map(([op]) => op), ["start-local"]);
  assert.equal(codexEntry(p).progress.local.why, "changed");
  assert.equal(installed(), count);

  // The file refreshed between the claim and the fence: the fence refuses, nothing is installed.
  p = await codexPanel(t, { before: () => state.files.set(CODEX_FILE, auth("account-a", { refreshed: true })) });
  await reloadAll(p);
  assert.deepEqual(p.steps, ["payload"]);
  assert.equal(codexEntry(p).progress.local.why, "changed");

  // The proxy's identity changed since the commit.
  p = await codexPanel(t, { config: { url: "https://other.example.test", name: "lab" } });
  count = installed();
  await reloadAll(p);
  assert.deepEqual(p.cli.log.map(([op]) => op), ["start-local"]);
  assert.equal(codexEntry(p).progress.local.why, "changed");
  assert.equal(installed(), count);

  // The assigned account is no longer on the proxy (not usable).
  p = await codexPanel(t, { plan: localCodexPlan({ assign: "codex-0z-gone.json" }) });
  count = installed();
  await reloadAll(p);
  assert.deepEqual(p.cli.log.map(([op, , st, why]) => [op, st ?? null, why ?? null]),
    [["start-local", null, null], ["record-local", "failed", "not-eligible"]]);
  assert.equal(installed(), count);

  // A refused fence: nothing installed.
  p = await codexPanel(t);
  p.handlers["fence-local"] = ({ refuse }) => {
    p.steps.push("fence");
    return refuse("stale");
  };
  await reloadAll(p);
  assert.deepEqual(p.steps, ["payload", "fence"]);
  assert.equal(codexEntry(p).progress.local.attempt.outcome, null);

  // Past LOCAL_START_MS before the download: no fence is asked for and nothing is installed.
  p = await codexPanel(t);
  const start = p.handlers["start-local"];
  p.handlers["start-local"] = (args) => {
    const reply = JSON.parse(start(args).stdout);
    reply.attempt.at = iso(Date.now() - LOCAL_START_MS - 1);
    return fixed(reply);
  };
  count = installed();
  await reloadAll(p);
  assert.deepEqual(p.steps, []);
  assert.equal(installed(), count);
  assert.ok(!p.cli.log.some(([op]) => op === "fence-local"));
});

test("two panels, the Codex form: a commit after a panel's claim makes its fence stale, and it installs nothing", async (t) => {
  const p = await codexPanel(t, { before: () => {
    const plan = parsePlan(state.files.get(PLAN)).plan;
    plan.rev += 1;
    plan.codex.progress.local = { ...plan.codex.progress.local, attempt: null, state: "pending", why: null };
    p.save(plan);
  } });
  await reloadAll(p);
  assert.deepEqual(p.steps, ["payload", "fence"]);
  assert.ok(!p.cli.log.some(([op]) => op === "record-local"));
  assert.equal(state.files.get(CODEX_FILE), auth("account-a"));
});

test("a paused Codex writer: another panel recovers it as lost and a new commit lands; the resumed writer's fence is stale", async (t) => {
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  let p;
  p = await codexPanel(t, { before: () => {} });
  const place = switchFixture.place;
  let stalled;
  const stalling = new Promise((resolve) => { stalled = resolve; });
  switchFixture.place = async (args) => {
    stalled();
    await paused;
    return place(args);
  };
  p.view.reload(p.cx);
  await stalling;
  // Time passes past LOCAL_CLAIM_MS with no fence: another panel reads it back (unchanged: lost).
  const plan = parsePlan(state.files.get(PLAN)).plan;
  plan.codex.progress.local.attempt.at = iso(Date.now() - LOCAL_CLAIM_MS - 1);
  p.save(plan);
  const other = await otherPanel();
  await other.cx.settle();
  assert.deepEqual(p.cli.log.filter(([op]) => op === "record-local").map(([, , st]) => st), ["lost"]);
  // A new commit lands (the attempt is retired), then the paused writer resumes.
  const next = parsePlan(state.files.get(PLAN)).plan;
  next.rev += 1;
  next.codex.progress.local = { ...next.codex.progress.local, state: "pending", why: null, attempt: null };
  p.save(next);
  resume();
  await p.cx.settle();
  assert.deepEqual(p.steps, ["payload", "fence"]);
  assert.equal(state.files.get(CODEX_FILE), auth("account-a"));
});

test("a Codex writer paused after a successful fence holds off recovery and commits for LOCAL_FENCE_MS", async (t) => {
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  let stalled;
  const stalling = new Promise((resolve) => { stalled = resolve; });
  const p = await codexPanel(t);
  const fence = p.handlers["fence-local"];
  p.handlers["fence-local"] = async (args) => {
    const reply = fence(args);
    stalled();
    await paused;
    return reply;
  };
  p.view.reload(p.cx);
  await stalling;
  const plan = parsePlan(state.files.get(PLAN)).plan;
  plan.codex.progress.local.attempt.at = iso(Date.now() - LOCAL_CLAIM_MS - 1);
  p.save(plan);
  const ops = p.cli.log.length;
  const other = await otherPanel();
  await other.cx.settle();
  assert.equal(p.cli.log.length, ops, "the other panel waits on a fenced attempt");
  // A commit touching local while it is fenced is busy-local (the CLI's commit check).
  const { preview } = buildPreview({ plan: p.committed, base: { state: "ok", rev: p.committed.rev, digest: null }, views: [],
    request: { v: 1, kind: "pin", tool: "codex", machine: "local", account: "codex-0a-ana-pro.json",
      codexUsable: ["codex-0a-ana-pro.json", CODEX_BO], codexLocal: { home: CODEX_DIR, account: fpr("account-a"),
        generation: sha256Hex(auth("account-a")), proxy: PROXY_ID }, active: null },
    now: Date.now(), id: PLAN_ID, sha256Hex, controllerHome: state.appHome });
  assert.ok(preview);
  const result = commitPreview(p.committed, { state: "ok", rev: p.committed.rev, digest: null }, preview,
    { expectRev: p.committed.rev, now: Date.now(), sha256Hex });
  assert.equal(result.error, "busy-local");
  // Once the fence expires, another panel recovers the unchanged file before replacing the decision.
  const expired = parsePlan(state.files.get(PLAN)).plan;
  expired.codex.progress.local.attempt.fencedAt = iso(Date.now() - LOCAL_FENCE_MS - 1);
  p.save(expired);
  const recovery = await otherPanel();
  await recovery.cx.settle();
  assert.equal(p.cli.log.at(-1)[2], "lost");
  const replacement = commitPreview(p.committed, { state: "ok", rev: p.committed.rev, digest: null },
    buildPreview({ plan: p.committed, base: { state: "ok", rev: p.committed.rev, digest: null }, views: [],
      request: preview.request, now: Date.now(), id: PLAN_ID, sha256Hex, controllerHome: state.appHome }).preview,
    { expectRev: p.committed.rev, now: Date.now(), sha256Hex });
  assert.ok(replacement.plan);
  p.save(replacement.plan);
  assert.equal(p.committed.codex.assign.local, "codex-0a-ana-pro.json");
  resume();
  await p.cx.settle();
  assert.deepEqual(p.steps, ["payload", "fence"]);
  assert.equal(state.files.get(CODEX_FILE), auth("account-a"));
});

test("proxy URL canaries: a url with userinfo or a query gives proxy-url, no placement, and never travels; unmanaged Switch works as today", async (t) => {
  for (const url of ["https://user:CANARY-PLAN-0043@proxy.example.test", "https://proxy.example.test/?key=CANARY-PLAN-0043"]) {
    // Manage's request and preview carry no proxy identity for such a url, and never the url.
    const m = await planPanel(t, { config: { url, name: "lab" } });
    state.files.set(CODEX_FILE, auth("account-a"));
    await m.click("manage");
    const manage = m.history.find((item) => item.kind === "manage");
    assert.equal(manage.codexLocal.proxy, null);
    assert.doesNotMatch(JSON.stringify(m.history) + JSON.stringify(m.preview ?? m.view.preview) + JSON.stringify(state.calls), /CANARY-PLAN-0043/);
    const p = await codexPanel(t, { config: { url, name: "lab" } });
    await reloadAll(p);
    assert.deepEqual(p.cli.log, [["fail-local", "codex", "proxy-url"]]);
    assert.equal(codexEntry(p).progress.local.why, "proxy-url");
    assert.equal(codexEntry(p).progress.local.attempt, null);
    assert.equal(codexEntry(p).seen.local.placed, null);
    assert.deepEqual(p.steps, []);
    assert.match(text(p.draw()), /carries more than an address: nothing was placed/);
    const leaked = () => {
      const files = [...state.files.entries()].filter(([path]) => !path.endsWith("/cliproxy.json")).map(([, value]) => value);
      return JSON.stringify(files) + JSON.stringify(p.history) + JSON.stringify(state.calls) + JSON.stringify(state.hcCalls);
    };
    assert.doesNotMatch(leaked(), /CANARY-PLAN-0043/);
    delete switchFixture.place;
    const count = installs.length;
    // Without the plan, Switch still installs as before with no fence.
    p.save(null);
    p.draw();
    nodes.get("primary-codex").click(null, p.cx);
    await p.cx.settle();
    assert.equal(installs.length, count + 1);
    assert.doesNotMatch(leaked(), /CANARY-PLAN-0043/);
  }
});

/** The linked machine's bound read in fleet.json, as `accounts fleet` leaves it. */
function seedLinked(p, { claude } = {}) {
  const view = p.views[0];
  const fixture = fleetRecord();
  fixture.machines[FLEET_CORE] = { ...fixture.machines[FLEET_CORE], core: FLEET_CORE, appHome: view.appHome,
    claude: nextObs("claude", null, claude ?? view.claude, view.readAt) };
  p.view.fleet.record = fixture;
}

function pressPlan(p) {
  return async (id, kind) => {
    seedLinked(p);
    const asked = state.calls.filter((call) => call.includes("--request")).length;
    const shown = await p.click(id);
    const argv = state.calls.filter((call) => call.includes("--request"));
    assert.equal(argv.length, asked + 1, id);
    const requestId = argv.at(-1).at(-1);
    assert.match(requestId, /^[a-f0-9]{32}$/);
    assert.deepEqual(p.modes.at(-1), ["600", `${REQUESTS}/${requestId}.json`]);
    assert.ok(state.calls.some((call) => call[0] === "sh" && call[2].includes("chmod 700") && call.at(-1) === REQUESTS));
    assert.equal(state.files.has(`${REQUESTS}/${requestId}.json`), false, "the request file is removed");
    const request = p.history.filter((item) => !Array.isArray(item) && item.kind === kind).at(-1);
    assert.ok(request, `${id} sent a ${kind} request`);
    return { shown, request };
  };
}

const commitShown = async (p) => {
  p.draw();
  assert.ok(nodes.has("plan-commit"), "a preview to apply");
  return p.click("commit");
};

test("mode, Use everywhere, Pin to, Unpin and Spread again: each a private request file and plan --request; commits keep them", async (t) => {
  const p = await planPanel(t);
  localCli(p);
  await p.click("manage");
  await p.click("commit");
  const press = pressPlan(p);
  let r = await press(`${FLEET_CORE}-pin-1`, "pin");
  assert.equal(r.request.account, BO);
  await commitShown(p);
  assert.equal(p.committed.claude.pin[FLEET_CORE], BO);
  await press(`${FLEET_CORE}-unpin`, "unpin");
  await commitShown(p);
  assert.equal(ownKey(p.committed.claude.pin, FLEET_CORE), null);
  r = await press("spread", "mode");
  assert.equal(r.request.mode, "spread");
  await commitShown(p);
  assert.equal(p.committed.claude.mode, "spread");
  await press("spread-again", "spread-again");
  r = await press("one", "mode");
  assert.equal(r.request.mode, "one");
  await commitShown(p);
  assert.equal(p.committed.claude.mode, "one");
  r = await press("account-1", "account");
  assert.equal(r.request.account, BO);
  assert.match(r.shown, /Use ana@example\.test everywhere|Use bo@example\.test everywhere/);
  await commitShown(p);
  assert.equal(p.committed.claude.account, BO);
  assert.doesNotMatch(JSON.stringify(state.calls), /@example\.test/);
});

test("Add to the plan, Allow a second login, Place on this Mac and Forget: each a request; a later preview keeps what was approved", async (t) => {
  const plan = localClaudePlan(ANA, { rev: 2, state: "done" });
  addPlanMember(plan, "claude", "core-one", ANA, TARGET_HOME, { snapshot: "none", email: ANA }, "suspended");
  plan.claude.progress["core-one"].why = "gone";
  const p = await planPanel(t, { plan });
  localCli(p);
  state.files.set(CODEX_FILE, auth("account-a"));
  await p.view.readPlan();
  const press = pressPlan(p);
  // A linked machine read but not in the plan joins it.
  let r = await press(`${FLEET_CORE}-add`, "add");
  assert.deepEqual([r.request.tool, r.request.machine], ["claude", FLEET_CORE]);
  assert.match(r.shown, /joins the plan on ana@example\.test/);
  await commitShown(p);
  assert.ok(p.committed.claude.members[FLEET_CORE]);
  // A gone core is forgotten.
  await press("core-one-forget", "forget");
  await commitShown(p);
  assert.equal(ownKey(p.committed.claude.members, "core-one"), null);

  // No login of the assigned account there: Allow a second login, then the shown command.
  const next = parsePlan(state.files.get(PLAN)).plan;
  next.claude.assign[FLEET_CORE] = CY;
  next.claude.pin[FLEET_CORE] = CY;
  next.claude.progress[FLEET_CORE] = { ...next.claude.progress[FLEET_CORE], state: "pending", why: "no-login" };
  p.save(next);
  await p.view.readPlan();
  r = await press(`${FLEET_CORE}-second-login`, "second-login");
  assert.deepEqual([r.request.machine, r.request.allow], [FLEET_CORE, true]);
  await commitShown(p);
  assert.equal(p.committed.claude.secondLogin[FLEET_CORE], true);
  seedLinked(p);
  const drawn = text(p.draw());
  assert.match(drawn, /CLAUDE_CONFIG_DIR='\/example-home\/\.claude-3' claude auth login/);
  assert.match(drawn, /then add it in that machine's Accounts panel/);

  // Codex on this Mac: Place <acct> on this Mac enrolls it, placed by a fenced install.
  t.after(() => { delete switchFixture.place; });
  switchFixture.place = async ({ fence }) => {
    await fence(auth("account-b"));
    state.files.set(CODEX_FILE, auth("account-b"));
    return { label: "Codex", fingerprint: fpr("account-b") };
  };
  p.view.tool = "codex";
  p.draw();
  const place = [...nodes.keys()].find((id) => String(id).startsWith("plan-local-place-") && /bo@example\.com/.test(text(nodes.get(id))));
  assert.ok(place, "Place bo on this Mac");
  r = await press(place.slice("plan-".length), "add");
  assert.deepEqual([r.request.tool, r.request.machine, r.request.account], ["codex", "local", CODEX_BO]);
  assert.ok(Array.isArray(r.request.codexUsable) && r.request.codexLocal.home === CODEX_DIR);
  await commitShown(p);
  assert.equal(p.committed.codex.progress.local.state, "done");
  assert.equal(p.committed.codex.seen.local.placed.name, CODEX_BO);
  // A later preview, built on the committed plan, keeps the enrolled local Codex and the forgotten core gone.
  r = await press("spread", "mode");
  assert.doesNotMatch(r.shown, /leaves the plan/);
  await commitShown(p);
  assert.ok(p.committed.codex.members.local);
  assert.equal(p.committed.codex.seen.local.placed.name, CODEX_BO);
  assert.equal(ownKey(p.committed.claude.members, "core-one"), null);
  assert.equal(p.committed.claude.secondLogin[FLEET_CORE], true);
  assert.doesNotMatch(JSON.stringify(state.calls), /@example\.(test|com)/);
});

test("Forget previews an unresolved Claude switch, then keeps one warning until dismissed", async (t) => {
  const core = "core-one";
  const now = Date.now();
  const plan = addPlanMember(emptyPlan(iso(now)), "claude", core, BO, TARGET_HOME,
    { snapshot: "none", email: ANA }, "pending");
  plan.names[core] = FLEET_NAME;
  const dispatched = startAttempt(plan, "claude", core, { rev: plan.rev, slot: "2",
    slotDigest: idDigest("2", BO, sha256Hex), before: "none", eff: ANA,
    effDigest: idDigest("default", ANA, sha256Hex), home: TARGET_HOME, core, dispatch: PLAN_ID, now });
  const gone = suspendEntry(dispatched, "claude", core, "gone", now);
  const p = await planPanel(t, { plan: gone });
  p.views[0].name = FLEET_NAME;
  seedLinked(p);
  await p.view.readPlan();
  p.draw();
  assert.ok(!nodes.has(`plan-${core}-rebind-${FLEET_CORE}`));
  const preview = await p.click(`${core}-forget`);
  assert.match(preview, /a login switch sent there may still land/);
  assert.match(text(nodes.get("plan-commit")), /Forget\? Press again to confirm/);
  assert.ok(p.committed.claude.members[core]);
  assert.equal(p.committed.exposures, undefined);

  const after = await p.click("commit");
  const warning = `${core} (${iso(now).slice(0, 10)}): a login switch sent there may still land.`;
  assert.ok(after.includes(warning));
  assert.equal(after.split(warning).length, 2);
  assert.equal(p.committed.claude.members[core], undefined);
  assert.equal(p.committed.claude.members[FLEET_CORE], undefined);
  assert.ok(p.history.some((entry) => Array.isArray(entry) && entry.includes("--confirm-forget")));

  seedLinked(p);
  await p.click(`${FLEET_CORE}-add`);
  assert.equal(p.committed.claude.members[FLEET_CORE], undefined);
  await p.click("commit");
  assert.ok(p.committed.claude.members[FLEET_CORE]);
  assert.ok(text(p.draw()).includes(warning));
  await p.click(`dismiss-${core}`);
  assert.ok(p.committed.exposures[core]);
  const dismissed = await p.click("commit");
  assert.ok(!dismissed.includes(warning));
  assert.equal(p.committed.exposures, undefined);
});

test("changed on the machine previews Adopt and Re-apply, never Forget", async (t) => {
  const plan = emptyPlan(iso(Date.now()));
  addPlanMember(plan, "claude", FLEET_CORE, ANA, TARGET_HOME, { snapshot: "none", email: ANA }, "suspended");
  plan.claude.progress[FLEET_CORE].why = "changed";
  const p = await planPanel(t, { plan });
  await p.view.readPlan();
  const press = pressPlan(p);
  let r = await press(`${FLEET_CORE}-adopt`, "adopt");
  assert.deepEqual([r.request.tool, r.request.machine], ["claude", FLEET_CORE]);
  assert.ok(nodes.has("plan-commit"));
  await p.click("cancel");
  r = await press(`${FLEET_CORE}-reapply`, "reapply");
  assert.deepEqual([r.request.tool, r.request.machine], ["claude", FLEET_CORE]);
  assert.equal(nodes.has(`plan-${FLEET_CORE}-forget`), false);
});

test("move-off: offered for the card's suggestion and for a linked member no longer eligible; Include asks again; quota alone asks nothing", async (t) => {
  const plan = localCodexPlan({ assign: "codex-0a-ana-pro.json", status: "done" });
  addPlanMember(plan, "claude", FLEET_CORE, CY, TARGET_HOME, { snapshot: "none", email: CY }, "pending");
  plan.claude.progress[FLEET_CORE].why = "not-eligible";
  plan.claude.progress[FLEET_CORE].tried = iso(Date.now());
  const p = await planPanel(t, { plan });
  localCli(p);
  state.files.set(CODEX_FILE, auth("account-a"));
  state.files.set(ACTIVE, JSON.stringify({ codex: { name: "codex-0a-ana-pro.json", fingerprint: fpr("account-a") } }));
  p.view.active = { codex: { name: "codex-0a-ana-pro.json", fingerprint: fpr("account-a") } };
  p.view.applyAt = Date.now();
  await reloadAll(p);
  const press = pressPlan(p);
  // The linked member whose account is no longer eligible there, whatever the card suggests.
  p.view.tool = "claude";
  let r = await press(`${FLEET_CORE}-move-off`, "move-off");
  assert.deepEqual([r.request.tool, r.request.machine, r.request.account], ["claude", FLEET_CORE, CY]);
  await p.click("cancel");
  // The Codex card suggests moving off ana once it has two readings an hour apart (a panel
  // opened now): one preview, and Include asks for the pinned machine too.
  poll = 0;
  const q = await otherPanel();
  poll = 1;
  q.view.tool = "codex";
  q.view.reload(q.cx);
  await q.cx.settle();
  const tap = async (id) => {
    q.draw();
    assert.ok(nodes.get(`plan-${id}`)?.click, id);
    nodes.get(`plan-${id}`).click(null, q.cx);
    await q.cx.settle();
    return text(q.draw());
  };
  const lastMoveOff = () => p.history.filter((item) => !Array.isArray(item) && item.kind === "move-off").at(-1);
  assert.match(text(q.draw()), /Preview moving machines off ana@example\.com · Pro/);
  let shown = await tap("move-off");
  assert.deepEqual([lastMoveOff().tool, lastMoveOff().account, lastMoveOff().to], ["codex", "codex-0a-ana-pro.json", CODEX_BO]);
  assert.match(shown, /This Mac: pinned: it stays/);
  shown = await tap("include-local");
  assert.deepEqual(lastMoveOff().include, ["local"]);
  await tap("cancel");
  p.view.tool = "codex";
  // Quota readings changing alone: no request, no preview, no write.
  const asked = state.calls.filter((call) => call.includes("--request")).length;
  const bytes = state.files.get(PLAN);
  poll = 0;
  await reloadAll(p);
  poll = 1;
  await reloadAll(p);
  assert.equal(state.calls.filter((call) => call.includes("--request")).length, asked);
  assert.equal(p.view.preview, null);
  assert.equal(state.files.get(PLAN), bytes);
});

test("two panels and lost completions: wait while claimed, then read back only once recoverable", async (t) => {
  const OTHER = "f".repeat(32);
  const snapshot = sha256Hex(JSON.stringify(PLAN_LOGIN));
  const open = (plan, ago, extra = {}) => startAttempt(plan, "claude", "local", { rev: plan.rev, slot: "2",
    slotDigest: idDigest("2", BO, sha256Hex), before: snapshot, eff: ANA, effDigest: idDigest("default", ANA, sha256Hex),
    home: state.appHome, owner: OTHER, now: Date.now() - ago, ...extra });
  // Another panel's open attempt, however recent: this one does nothing.
  let p = await planPanel(t, { linked: false, plan: open(localClaudePlan(BO), 0) });
  let cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, []);
  // Recoverable and unchanged: lost, then a fresh attempt of its own.
  p = await planPanel(t, { linked: false, plan: open(localClaudePlan(BO), LOCAL_CLAIM_MS + 1) });
  cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, [["record-local", "claude", "lost", "lost"]]);
  await reloadAll(p);
  assert.deepEqual(cli.log.slice(1).map(([op]) => op), ["start-local", "write-local", "record-local"]);
  assert.equal(p.committed.claude.progress.local.state, "done");
  // Recoverable and the other panel's write landed: done, never written again.
  const landed = JSON.stringify({ ...PLAN_LOGIN, use: "2" });
  const plan = open(localClaudePlan(BO), LOCAL_CLAIM_MS + 1);
  plan.claude.progress.local.attempt.after = sha256Hex(landed);
  p = await planPanel(t, { linked: false, plan });
  state.files.set(LOGINS, landed);
  cli = localCli(p);
  p.view.forceLogins = true;
  await reloadAll(p);
  assert.deepEqual(cli.log, [["record-local", "claude", "done", null]]);
  // Recoverable, another account now in the effective slot: changed, never lost.
  p = await planPanel(t, { linked: false, plan: open(localClaudePlan(BO), LOCAL_CLAIM_MS + 1),
    probes: { status: { default: signedIn(CY, DEFAULT_DIR), [TWO]: signedIn(BO, TWO) } } });
  cli = localCli(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, [["record-local", "claude", "changed", "changed"]]);
});

test("local Claude recovery suspends a confirmed switch that the operator switched back", async (t) => {
  const plan = startAttempt(localClaudePlan(BO), "claude", "local", { rev: 7, slot: "2",
    before: sha256Hex(JSON.stringify(PLAN_LOGIN)), eff: ANA, effDigest: idDigest("default", ANA, sha256Hex),
    slotDigest: idDigest("2", BO, sha256Hex), home: state.appHome, owner: "f".repeat(32), now: Date.now() - LOCAL_CLAIM_MS - 1 });
  plan.claude.progress.local.attempt.after = sha256Hex(JSON.stringify({ ...PLAN_LOGIN, use: "2" }));
  const p = await planPanel(t, { linked: false, plan });
  const cli = localCli(p);
  await reloadAll(p);
  await reloadAll(p);
  assert.deepEqual(cli.log, [["record-local", "claude", "changed", "changed"]]);
  assert.equal(p.committed.claude.progress.local.state, "suspended");
  assert.deepEqual(JSON.parse(state.files.get(LOGINS)), PLAN_LOGIN);
});

test("two panels, Codex: a recoverable fenced attempt equal to its intended bytes is done; never fenced and changed is changed", async (t) => {
  const OTHER = "f".repeat(32);
  const intended = sha256Hex(auth("account-b"));
  const fenced = (ago) => {
    const plan = localCodexPlan();
    const started = startAttempt(plan, "codex", "local", { rev: plan.rev, before: sha256Hex(auth("account-a")),
      home: CODEX_DIR, owner: OTHER, proxy: PROXY_ID, now: Date.now() - LOCAL_CLAIM_MS - 1 });
    return ago === null ? started : fenceAttempt(started, "codex", "local", 1, { intended, now: Date.now() - ago });
  };
  let p = await codexPanel(t, { plan: fenced(LOCAL_FENCE_MS + 1), file: auth("account-b") });
  await reloadAll(p);
  assert.deepEqual(p.cli.log, [["record-local", "codex", "done", null]]);
  assert.equal(codexEntry(p).seen.local.placed.generation, intended);
  assert.deepEqual(p.steps, []);
  assert.deepEqual(JSON.parse(state.files.get(ACTIVE)).codex, { name: CODEX_BO, fingerprint: fpr("account-b") });
  assert.equal(p.view.view("codex").current.name, CODEX_BO);
  assert.ok(text(p.draw()).includes(p.view.view("codex").current.email));
  // Fenced moments ago: the other panel waits.
  p = await codexPanel(t, { plan: fenced(0), file: auth("account-b") });
  await reloadAll(p);
  assert.deepEqual(p.cli.log, []);
  // Never fenced, and the file changed meanwhile: changed.
  p = await codexPanel(t, { plan: fenced(null), file: auth("account-c") });
  await reloadAll(p);
  assert.deepEqual(p.cli.log, [["record-local", "codex", "changed", "changed"]]);
  assert.equal(codexEntry(p).seen.local.placed, null);
});

test("Codex recovery suspends unchanged bytes after an installer started and its reply was lost", async (t) => {
  const plan = localCodexPlan();
  const before = sha256Hex(auth("account-a")), intended = sha256Hex(auth("account-b"));
  const started = startAttempt(plan, "codex", "local", { rev: plan.rev, before, home: CODEX_DIR,
    owner: "f".repeat(32), proxy: PROXY_ID, now: Date.now() - LOCAL_CLAIM_MS - 1 });
  const fenced = fenceAttempt(started, "codex", "local", 1, { intended, now: Date.now() - LOCAL_FENCE_MS - 1 });
  fenced.codex.progress.local.attempt.installStarted = true;
  const p = await codexPanel(t, { plan: fenced });
  await reloadAll(p);
  await reloadAll(p);
  assert.deepEqual(p.cli.log, [["record-local", "codex", "changed", "changed"]]);
  assert.deepEqual(p.steps, []);
});

test("a commit touching local while its attempt is not recoverable is busy-local; the first owner's late record after a commit is stale", async (t) => {
  const plan = startAttempt(localClaudePlan(BO), "claude", "local", { rev: 7, slot: "2", before: sha256Hex(JSON.stringify(PLAN_LOGIN)),
    slotDigest: idDigest("2", BO, sha256Hex), effDigest: idDigest("default", ANA, sha256Hex),
    eff: ANA, home: state.appHome, owner: "f".repeat(32), now: Date.now() });
  let p = await planPanel(t, { linked: false, plan });
  localCli(p);
  await reloadAll(p);
  await p.click("local-pin-0");
  assert.match(await p.click("commit"), /This Mac is being switched now: press again once that is done\./);

  p = await planPanel(t, { linked: false, plan: localClaudePlan(BO) });
  const cli = localCli(p);
  const write = p.handlers["write-local"];
  p.handlers["write-local"] = (args) => {
    const reply = write(args);
    const next = cli.live();
    next.rev += 1;
    next.claude.progress.local = { ...next.claude.progress.local, attempt: null };
    p.save(next);
    return reply;
  };
  await reloadAll(p);
  assert.deepEqual(cli.log.map(([op]) => op), ["start-local", "write-local", "record-local"]);
  assert.equal(p.committed.claude.progress.local.attempt, null);
  assert.equal(p.committed.claude.progress.local.state, "pending");
  assert.doesNotMatch(text(p.draw()), /The plan wasn't changed/);
});

test("the local card, banner, Use, Switch and Restart draw and act the same with a plan as without", async (t) => {
  const scene = async (withPlan) => {
    const plan = emptyPlan(iso(Date.now()));
    addPlanMember(plan, "claude", FLEET_CORE, ANA, TARGET_HOME, { snapshot: "none", email: ANA }, "done");
    plan.claude.progress[FLEET_CORE].tried = iso(Date.now());
    const p = await planPanel(t, { plan: withPlan ? plan : null, linked: false });
    await reloadAll(p);
    state.calls = [];
    p.view.tool = "codex";
    p.draw();
    nodes.get("primary-codex").click(null, p.cx);
    await p.cx.settle();
    const calls = state.calls.map((call) => call.join(" "));
    const marks = [];
    for (const tool of ["claude", "codex"]) {
      p.view.tool = tool;
      p.draw();
      marks.push(["card-" + tool, "switched-" + tool, "restart-" + tool].map((id) => nodes.has(id) ? text(nodes.get(id)) : null));
    }
    state.calls = [];
    p.view.tool = "claude";
    p.draw();
    nodes.get("login-use-2").click(null, p.cx);
    await p.cx.settle();
    return { calls, marks, use: state.calls.map((call) => call.join(" ")) };
  };
  const without = await scene(false);
  const withPlan = await scene(true);
  assert.deepEqual(withPlan.marks, without.marks);
  assert.deepEqual(withPlan.calls, without.calls);
  assert.deepEqual(withPlan.use.filter((call) => !call.includes(" plan ")), without.use);
});

test("canaries in apply's stderr, hc's refusal and claude's status never reach the panel, the runs folder or argv", async (t) => {
  const p = await planPanel(t, { probes: { status: { default: { ...signedIn(ANA, DEFAULT_DIR),
    stderr: "CANARY-STATUS-0043" }, [TWO]: signedIn(BO, TWO) } } });
  await p.click("manage");
  await p.click("commit");
  seedLinked(p);
  const exec = state.exec;
  state.exec = (program, args, options) => program === "env" && args.at(-1) === "apply"
    ? fixed({ error: "CANARY-RPC-0043" }, 1, "CANARY-STDERR-0043") : exec(program, args, options);
  await p.click(`${FLEET_CORE}-pin-1`);
  await p.click("commit");
  state.exec = exec;
  assert.match(text(p.draw()), /The plan wasn't changed \(failed\)/);
  const hc = state.hc;
  state.hc = (args) => args[0] === "ls" ? fixed("", 1, "CANARY-RPC-0043") : hc(args);
  await p.view.startApply(p.cx);
  await p.cx.settle();
  state.hc = hc;
  const everything = text(p.draw()) + JSON.stringify([...state.files.entries()]) + JSON.stringify(state.calls)
    + JSON.stringify(state.hcCalls) + JSON.stringify(p.history);
  assert.doesNotMatch(everything, /CANARY-(STDERR|RPC|STATUS)-0043/);
});

test("an indeterminate marker read on a confirmed panel refuses the slot edit and allows a retry", async () => {
  const { view, cx, draw } = await panel({ record: SLOT_RECORD, claude: SIGNED_IN, writer: true });
  await view.confirmWriter();
  assert.equal(JSON.parse(state.files.get(`${state.appHome}/${WRITER_FILE}`)).setLogin, true);
  const before = state.files.get(LOGINS);
  state.onRead = (path) => {
    if (path === `${state.appHome}/${SIDEBAR_MARKERS[0]}`) throw Object.assign(new Error("CANARY-STDERR-0043"), { code: "EIO" });
  };
  try {
    draw();
    nodes.get("login-use-2").click(null, cx);
    await cx.settle();
    assert.equal(state.files.get(LOGINS), before);
    assert.match(text(draw()), /writer-unreadable: try again/);
    assert.doesNotMatch(text(draw()), /CANARY-STDERR-0043/);
  } finally { delete state.onRead; }
  const exec = state.exec;
  state.exec = claudeExec(SIGNED_IN, (program, args) => {
    if (!args.includes("set-login")) return exec(program, args);
    state.files.set(LOGINS, JSON.stringify({ ...SLOT_RECORD, use: "2" }));
    return fixed({ ok: true, snapshot: "a".repeat(64) });
  });
  draw();
  nodes.get("login-use-2").click(null, cx);
  await cx.settle();
  assert.equal(JSON.parse(state.files.get(LOGINS)).use, "2");
});
