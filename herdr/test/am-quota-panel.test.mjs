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

const here = (f) => new URL(f, import.meta.url).href;
const FAKE_SWITCH = "data:text/javascript," + encodeURIComponent(`
  export const installs = [];
  export async function install({ provider, account }) {
    installs.push({ provider, id: account.id });
    return { label: provider === "claude" ? "Claude Code" : "Codex", fingerprint: "fp-new" };
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
const { installs } = await import(FAKE_SWITCH);
const { default: Panel, plain, records } = await import("../mods/am-quota/main.js");
const { all, index, nodes, textOf } = await import(stubs["gpui-kit"]);
const { AUTH_SCRIPT, FOLDER_SCRIPT, PRESENT_SCRIPT } = await import("../mods/am-quota/logins.js");

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
  claude = null, record = undefined, settle = true } = {}) {
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
  for (const until = Date.now() + 5000; asks() < 2 && Date.now() < until;) await new Promise((go) => setTimeout(go, 1));
  assert.equal(asks(), 2, "the first round: both logins, side by side");
  view.forceLogins = true;
  view.reload(cx);
  view.forceLogins = true;
  view.reload(cx);
  await new Promise((go) => setTimeout(go, 5));
  assert.equal(asks(), 2, "no round beside the one running");
  release();
  await cx.settle();
  assert.equal(asks(), 4, "one queued round after it, not two");
  assert.match(text(draw()), /dee@example\.com · login 2 Use/);
});
