import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASLEEP_MS, liveFrom, poseOf, nextWake, helpersOf, buildTree, placeTrees, placesOf, withSpaceless, visibleRows, botFold, categoryFold, knownBots, projectId,
  secondLine, modelDefaultsFrom, modelTextsUpdate, argvToAsk, argvEntry, argvAfter, argvReader, heldClickOf, heldTerminalOf, liveOf, paneCounts, listedKeyOf, parentMarkOf, parentMarkText,
  programForApp, needsYouText, NEEDS_YOU, NEEDS_YOU_PERMISSION,
  NEEDS_OWNER_LABEL, OWNER_QUESTION, ownerQuestionOf, RATE_LIMITED,
} from "../mods/am-sidebar/rows.js";
import { waitsOnPermission } from "../mods/am-sidebar/launchArgs.js";
import { parseBots } from "../mods/am-sidebar/model.js";
import { NEEDS_OWNER_LABEL as TIDY_NEEDS_OWNER_LABEL, STALE_NEEDS_OWNER_MS } from "../mods/am-sidebar/tidy.js";

const look = { character: "star", colour: "blue" };
const bot = (id, more = {}) => ({ id, name: id.slice(2), kind: "member", look, role: `${id} role`, instructions: "", agent: "claude", ...more });
// The C7 test project: a main bot, two categories, a captain with two members, one
// uncategorised member and one planned bot.
const FILE = {
  version: 1,
  categories: [{ id: "shared", title: "Shared", sub: "one of each" }, { id: "eng", title: "Engineering" }, { id: "empty", title: "Empty" }],
  bots: [
    bot("b-mainmainma", { kind: "main", look: { character: "octopus", colour: "deepseek" } }),
    bot("b-pmpmpmpmpm", { category: "shared" }),
    bot("b-captaincap", { category: "eng", role: "Captain", model: "GPT-6.1 Terra" }),
    bot("b-devdevdevd", { lead: "b-captaincap", category: "shared" }),
    bot("b-testtestte", { lead: "b-captaincap" }),
    bot("b-loneloneln"),
    bot("b-plannedpla", { category: "eng", planned: { wave: 3, note: "waits for auth v2" }, agent: undefined }),
  ],
};
const file = parseBots(JSON.stringify(FILE)).file;
const KEY = "/repo/proj";
const T = (address, more = {}) => ({ address, state: "live", labels: {}, parent: null, status: null, status_ms: null, created_ms: 1, program: { key: "claude", name: "Claude Code", agent: true }, ...more });
const NOW = 1_800_000_000_000;

test("a blocked chip names a permission only when herdr-core's report says blocked with kind permission", () => {
  const permission = { app: "claude-code", state: "blocked", kind: "permission", msg: "x" };
  assert.equal(NEEDS_YOU, "Needs you");
  assert.equal(NEEDS_YOU_PERMISSION, "Permission");
  assert.equal(waitsOnPermission(permission), true);
  assert.equal(needsYouText(permission), NEEDS_YOU_PERMISSION);
  for (const report of [null, undefined, "blocked", {}, { state: "blocked" },
    ...["question", "auth", "Permission"].map((kind) => ({ state: "blocked", kind })),
    ...["working", "done"].map((state) => ({ state, kind: "permission" }))]) {
    assert.equal(waitsOnPermission(report), false, JSON.stringify(report));
    assert.equal(needsYouText(report), NEEDS_YOU, JSON.stringify(report));
  }
});

test("a stopped pane's needs-owner label is the owner question, and a working or blocked pane has none", () => {
  // The marker tidy.js already reports on, held equal: one label, two readers.
  assert.equal(NEEDS_OWNER_LABEL, "automagik-herdr.needs-owner");
  assert.equal(NEEDS_OWNER_LABEL, TIDY_NEEDS_OWNER_LABEL);
  assert.equal(OWNER_QUESTION, "Question");
  const row = (label, status = "done") => ({ address: "t1", state: "live", status, labels: label === null ? {} : { [NEEDS_OWNER_LABEL]: label } });
  assert.equal(ownerQuestionOf(row("ship it?")), "ship it?");
  assert.equal(ownerQuestionOf(row("  which database?  ", "idle"), "idle"), "which database?");
  // No status reported is not an agent working: the label still speaks.
  assert.equal(ownerQuestionOf(row("waiting", null), null), "waiting");
  // Working, blocked and error are not waiting on an answer.
  for (const status of ["working", "blocked", "error"]) {
    assert.equal(ownerQuestionOf(row("x", status), status), null, status);
    assert.equal(ownerQuestionOf(row("x"), status), null, status);
  }
  for (const label of [null, undefined, "", "   "]) assert.equal(ownerQuestionOf(row(label), "done"), null, JSON.stringify(label));
  assert.equal(ownerQuestionOf(null, "done"), null);
  assert.equal(ownerQuestionOf({ address: "t1", status: "done" }, "done"), null);
  // One line, and short enough for a chip's tooltip.
  assert.equal(ownerQuestionOf(row("which\n  database?")), "which database?");
  const long = ownerQuestionOf(row("x".repeat(500)));
  assert.equal(long.length, 160);
  assert.match(long, /\.\.\.$/);
});

test("a label older than tidy's stale window, or on a terminal that is gone, is no question", () => {
  const NOW = 1_800_000_000_000;
  const at = (age, more = {}) => ({ address: "t1", state: "live", status: "done", status_ms: NOW - age,
    labels: { [NEEDS_OWNER_LABEL]: "ship it?" }, ...more });
  // The same boundary tidy.js reports (a strict >): a day is still fresh, a day and a millisecond is not.
  assert.equal(ownerQuestionOf(at(0), "done", NOW), "ship it?");
  assert.equal(ownerQuestionOf(at(STALE_NEEDS_OWNER_MS), "done", NOW), "ship it?");
  assert.equal(ownerQuestionOf(at(STALE_NEEDS_OWNER_MS + 1), "done", NOW), null);
  // Without a status clock, the terminal's creation age: tidy.js's own fallback.
  assert.equal(ownerQuestionOf(at(STALE_NEEDS_OWNER_MS + 1, { status_ms: null, created_ms: NOW - 1000 }), "done", NOW), "ship it?");
  assert.equal(ownerQuestionOf(at(0, { status_ms: null, created_ms: NOW - STALE_NEEDS_OWNER_MS - 1 }), "done", NOW), null);
  // No clock at all is not stale: tidy reports only a finite age.
  assert.equal(ownerQuestionOf(at(0, { status_ms: null, created_ms: null }), "done", NOW), "ship it?");
  // A terminal that exited while its label row survives, or one no longer in the snapshot, asks nothing.
  assert.equal(ownerQuestionOf(at(0, { state: "exited" }), "done", NOW), null);
  assert.equal(ownerQuestionOf(at(0, { state: undefined }), "done", NOW), null);
  assert.equal(ownerQuestionOf(undefined, "done", NOW), null);
});

test("liveFrom: label + live + agent in front; newest holder wins and is flagged; remote counts", () => {
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, status: "working", status_ms: NOW - 5 }),
    T("t2", { labels: { bot: "b-captaincap" }, created_ms: 10 }),
    T("t3", { labels: { bot: "b-captaincap" }, created_ms: 20, status: "idle", status_ms: NOW - 1000 }),
    T("box/t4", { labels: { bot: "b-devdevdevd" }, status: "done" }),
    T("t5", { labels: { bot: "b-testtestte" }, program: { key: "shell", agent: false } }),
    T("t6", { labels: { bot: "b-loneloneln" }, state: "exited" }),
    T("t7", { labels: { bot: "b-unknownbot" } }),
    T("t8", { labels: { bot: "b-pmpmpmpmpm" }, program: null, foreground: { argv: ["/usr/bin/codex"] } }),
    T("t9", { labels: { bot: "b-plannedpla" }, program: null, foreground: { argv: ["-zsh"] } }),
  ];
  const live = liveFrom(terms, knownBots([{ key: KEY, file }]));
  assert.deepEqual(Object.keys(live).sort(), ["b-captaincap", "b-devdevdevd", "b-mainmainma", "b-pmpmpmpmpm"]);
  assert.deepEqual({ ...live["b-captaincap"], program: undefined }, { terminal: "t3", duplicate: true, parent: null, status: "idle", status_ms: NOW - 1000, program: undefined, argv: null, panes: ["t3", "t2"] });
  assert.equal(live["b-mainmainma"].duplicate, false);
  assert.ok(!("panes" in live["b-mainmainma"]), "one holder: the entry is as before");
  assert.equal(live["b-devdevdevd"].terminal, "box/t4");
  // No filter: any label counts.
  assert.ok(liveFrom(terms)["b-unknownbot"]);
});

test("liveFrom: the ledger's binding decides the bot, never the pane's bot= label (#223)", () => {
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, created_ms: 10 }),
    T("t2", { labels: { bot: "b-loneloneln" }, created_ms: 20 }),
    T("t3", { labels: {}, created_ms: 30 }),
    T("hx/t4", { labels: { bot: "b-devdevdevd" }, created_ms: 40 }),
    T("t5", { labels: { bot: "b-captaincap" }, created_ms: 50, state: "exited" }),
  ];
  const bindings = [
    { bot: "b-captaincap", terminal: "t1", address: "t1", project: KEY, machine: null, state: "live", created_ms: 10 },
    { bot: "b-loneloneln", terminal: "t2", address: "t2", project: KEY, machine: null, state: "unknown", created_ms: 20 },
    { bot: "b-devdevdevd", terminal: "t3", address: "t3", project: KEY, machine: null, state: "live", created_ms: 30 },
    { bot: "b-mainmainma", terminal: "t4", address: "hx/t4", project: KEY, machine: "hx", state: "live", created_ms: 40 },
    { bot: "b-testtestte", terminal: "t5", address: "t5", project: KEY, machine: null, state: "live", created_ms: 50 },
  ];
  const known = knownBots([{ key: KEY, file }]);
  const live = liveFrom(terms, known, undefined, undefined, bindings);
  // The pane says the main bot, the ledger the captain; an unlabelled pane is the dev's; an
  // away binding is no row, nor is one whose terminal ended.
  assert.equal(liveOf(live, { key: KEY }, "b-captaincap").terminal, "t1");
  assert.equal(liveOf(live, { key: KEY }, "b-devdevdevd").terminal, "t3");
  assert.equal(liveOf(live, { key: KEY }, "b-loneloneln"), null);
  assert.equal(liveOf(live, { key: KEY }, "b-testtestte"), null);
  assert.equal(liveOf(live, { key: KEY, machine: "hx" }, "b-mainmainma").terminal, "hx/t4");
  assert.equal(liveOf(live, { key: KEY }, "b-mainmainma"), null, "no row at the wrong machine");
  // Without the ledger the label still decides (the fallback until the CLI answers --all).
  assert.equal(liveOf(liveFrom(terms, known), { key: KEY }, "b-mainmainma").terminal, "t1");
});

test("an agy pane (#793): agy in front counts even when the table says no agent, and its blocked prompt is needs-you", () => {
  const terms = [T("t1", { labels: { bot: "b-mainmainma" }, status: "blocked", status_ms: NOW,
    program: { key: "agy", name: "agy", agent: false }, foreground: { argv: ["agy", "--model", "gemini-4-argon-high"] } })];
  const live = liveFrom(terms, knownBots([{ key: KEY, file }]));
  assert.equal(live["b-mainmainma"].terminal, "t1");
  assert.equal(poseOf(live["b-mainmainma"], NOW), "needs-you");
  // The reported app name maps to Herdr's entry, the pack's agent table's, or a plain one.
  assert.equal(programForApp("claude-code", [{ key: "claude", name: "Claude Code" }]).key, "claude");
  assert.deepEqual(programForApp("agy", [{ key: "antigravity", name: "Antigravity", icon: null }]), { key: "antigravity", name: "Antigravity", icon: null });
  assert.deepEqual(programForApp("agy", []), { key: "antigravity", name: "Antigravity", icon: null, tint: false }, "Herdr's table may lack it");
  assert.equal(programForApp("nope", []), null);
});

test("poseOf: Decision 7's mapping, asleep at exactly ten idle minutes", () => {
  const at = (status, ago) => poseOf({ status, status_ms: ago === null ? null : NOW - ago }, NOW);
  assert.equal(at("working", 0), "working");
  assert.equal(at("blocked", 0), "needs-you");
  assert.equal(at("error", 0), "failed");
  assert.equal(at("done", ASLEEP_MS * 2), "done");
  assert.equal(at("idle", ASLEEP_MS - 1000), "idle");
  assert.equal(at("idle", ASLEEP_MS), "asleep");
  assert.equal(at(null, ASLEEP_MS * 3), "idle", "no status yet: idle, no asleep timer");
  assert.equal(at("idle", null), "idle");
  assert.equal(poseOf(null, NOW), "asleep", "not running");
});

test("nextWake: the soonest idle bot's ten-minute mark still ahead, else null", () => {
  const live = {
    a: { status: "idle", status_ms: NOW - 60_000 },
    b: { status: "idle", status_ms: NOW - 120_000 },
    c: { status: "idle", status_ms: NOW - ASLEEP_MS - 1 },
    d: { status: "working", status_ms: NOW },
    e: { status: null, status_ms: NOW },
  };
  assert.equal(nextWake(live, NOW), NOW - 120_000 + ASLEEP_MS);
  assert.equal(nextWake({ c: live.c, d: live.d }, NOW), null);
});

test("helpersOf: the parent tree, depth first, never a known bot's terminal or what it started", () => {
  const terms = [
    T("t1"), T("h1", { parent: "t1", name: "build" }), T("h2", { parent: "h1", template: "reviewer" }),
    T("h3", { parent: "t1", state: "exited" }),
    T("t9", { parent: "t1", labels: { bot: "b-devdevdevd" } }), T("h9", { parent: "t9" }),
    T("h4", { parent: "t1", labels: { bot: "b-notdefined" }, program: { key: "codex", name: "Codex" } }),
  ];
  const got = helpersOf(terms, "t1", new Set(["b-devdevdevd"]));
  assert.deepEqual(got.map((h) => [h.terminal, h.name, h.depth]), [["h1", "build", 0], ["h2", "reviewer", 1], ["h4", "Codex", 0]]);
});

test("helpersOf: a bot's worker (worker.of, task, no bot label) folds under its pane with its model, effort or template", () => {
  const terms = [
    T("t1", { labels: { bot: "b-devdevdevd" } }),
    T("w1", { parent: "t1", name: "feat-login", labels: { "worker.of": "b-devdevdevd", task: "feat/login", "worker.model": "opus", "worker.effort": "high" } }),
    T("w2", { parent: "t1", name: "fix-x", labels: { "worker.of": "b-devdevdevd", task: "fix/x" } }),
    T("w3", { parent: "t1", name: "feat-y", labels: { "worker.of": "b-devdevdevd", task: "feat/y", "worker.template": "dev-sol" } }),
  ];
  const got = helpersOf(terms, "t1", new Set(["b-devdevdevd"]));
  assert.deepEqual(got.map((h) => [h.terminal, h.name, h.depth, h.model, h.effort, h.template]),
    [["w1", "feat-login", 0, "opus", "high", null], ["w2", "fix-x", 0, null, null, null], ["w3", "feat-y", 0, null, null, "dev-sol"]]);
});

test("buildTree: the C7 project as plain data", () => {
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, status: "working" }),
    T("t2", { labels: { bot: "b-captaincap" }, parent: "t1", status: "idle", status_ms: NOW - ASLEEP_MS - 5 }),
    // A member started under the live main bot: drawn once, as a member, never as a helper.
    T("t3", { labels: { bot: "b-devdevdevd" }, parent: "t1", status: "blocked" }),
    T("h1", { parent: "t1", name: "main-helper" }),
    T("h2", { parent: "t2", name: "cap-helper", status: "working" }),
  ];
  const projects = [{ key: KEY, machine: null, file, spaces: ["s1", "s2"] }];
  const [tree, ...more] = buildTree({ projects, live: liveFrom(terms, knownBots(projects)), terminals: terms, now: NOW });
  assert.equal(more.length, 0);
  assert.equal(tree.main.bot.id, "b-mainmainma");
  assert.equal(tree.main.pose, "working");
  assert.deepEqual(tree.main.helpers.map((h) => h.terminal), ["h1"]);
  // Categories in file order, empty ones left out; the captain under its category, the planned bot too.
  assert.deepEqual(tree.categories.map((c) => [c.id, c.title, c.sub, c.bots.map((n) => n.bot.id)]), [
    ["shared", "Shared", "one of each", ["b-pmpmpmpmpm"]],
    ["eng", "Engineering", undefined, ["b-captaincap", "b-plannedpla"]],
  ]);
  const cap = tree.categories[1].bots[0];
  assert.equal(cap.pose, "asleep", "idle past ten minutes");
  // Members nest under their lead by definition; a member's category is ignored.
  assert.deepEqual(cap.members.map((n) => [n.bot.id, n.pose, n.live?.terminal ?? null]), [["b-devdevdevd", "needs-you", "t3"], ["b-testtestte", "asleep", null]]);
  assert.deepEqual(cap.helpers.map((h) => h.terminal), ["h2"]);
  const planned = tree.categories[1].bots[1];
  assert.deepEqual([planned.planned, planned.pose, planned.live, planned.members], [true, "asleep", null, []]);
  assert.deepEqual(tree.uncategorised.map((n) => n.bot.id), ["b-loneloneln"]);
  assert.equal(tree.uncategorised[0].live, null, "a defined bot that is not running still shows");
});

test("buildTree: one tree per project across worktree spaces; a lead that falls back is flagged", () => {
  const f = parseBots(JSON.stringify({ ...FILE, bots: [...FILE.bots, bot("b-orphanorph", { lead: "b-missingmis" })] })).file;
  const trees = buildTree({ projects: [{ key: KEY, file: f, spaces: ["s1"] }, { key: KEY, file: f, spaces: ["s2"] }, { key: KEY, machine: "box", file: f, spaces: ["s3"] }], now: NOW });
  assert.equal(trees.length, 2, "this computer's and box's");
  const orphan = trees[0].uncategorised.find((n) => n.bot.id === "b-orphanorph");
  assert.match(orphan.warning, /missing/);
});

test("buildTree: a project with no main bot lists its bots flat with the reason", () => {
  const noMain = parseBots(JSON.stringify({ version: 1, bots: [bot("b-aaaaaaaaaa"), bot("b-bbbbbbbbbb", { lead: "b-aaaaaaaaaa" })] })).file;
  const [tree] = buildTree({ projects: [{ key: KEY, file: noMain, warnings: ["no main bot"] }], now: NOW });
  assert.equal(tree.main, null);
  assert.deepEqual(tree.uncategorised.map((n) => [n.bot.id, n.members.length]), [["b-aaaaaaaaaa", 0], ["b-bbbbbbbbbb", 0]]);
  const rows = visibleRows(tree);
  assert.deepEqual(rows.map((r) => r.kind), ["notice", "bot", "bot"]);
  // An empty project that failed to parse.
  const [bad] = buildTree({ projects: [{ key: KEY, file: { version: 1, categories: [], bots: [] }, warnings: ["x: not JSON"] }] });
  assert.deepEqual(visibleRows(bad).map((r) => [r.kind, r.text]), [["notice", "x: not JSON"]]);
});

test("visibleRows: default is main open, categories open, bots folded; folds apply by id", () => {
  const terms = [T("t1", { labels: { bot: "b-mainmainma" } }), T("t2", { labels: { bot: "b-captaincap" } }), T("h2", { parent: "t2" }), T("h1", { parent: "t1" })];
  const projects = [{ key: KEY, file, spaces: ["s1"] }];
  const [tree] = buildTree({ projects, live: liveFrom(terms), terminals: terms, now: NOW });
  const ids = (rows) => rows.map((r) => `${r.kind}:${r.kind === "category" ? r.category.id : r.kind === "helper" ? r.helper.terminal : r.node?.bot.id}`);
  const dflt = visibleRows(tree);
  assert.deepEqual(ids(dflt), [
    "main:b-mainmainma",
    "category:shared", "bot:b-pmpmpmpmpm",
    "category:eng", "bot:b-captaincap", "planned:b-plannedpla",
    "bot:b-loneloneln",
    "helper:h1",
  ]);
  assert.deepEqual(dflt.find((r) => r.node?.bot.id === "b-captaincap").guides, ["main"]);
  assert.equal(dflt.find((r) => r.node?.bot.id === "b-captaincap").foldable, true);
  assert.equal(dflt.find((r) => r.node?.bot.id === "b-captaincap").open, false);
  assert.equal(dflt.find((r) => r.node?.bot.id === "b-pmpmpmpmpm").foldable, false);
  assert.ok(dflt.every((r) => !("count" in r)), "no fold counts");

  const open = new Map([[botFold("b-captaincap"), true], [categoryFold(tree, "shared"), false]]);
  const rows = visibleRows(tree, open);
  assert.deepEqual(ids(rows), [
    "main:b-mainmainma",
    "category:shared",
    "category:eng", "bot:b-captaincap", "bot:b-devdevdevd", "bot:b-testtestte", "helper:h2", "planned:b-plannedpla",
    "bot:b-loneloneln",
    "helper:h1",
  ]);
  assert.deepEqual(rows.find((r) => r.kind === "helper" && r.helper.terminal === "h2").guides, ["main", "member", "helper"]);
  assert.deepEqual(rows.find((r) => r.node?.bot.id === "b-devdevdevd").guides, ["main", "member"]);
  assert.deepEqual(rows.find((r) => r.kind === "helper" && r.helper.terminal === "h1").guides, ["main", "helper"]);

  assert.deepEqual(ids(visibleRows(tree, new Map([[botFold("b-mainmainma"), false]]))), ["main:b-mainmainma"]);
});

test("placeTrees: after the first shown space of a project, once; projects with no space go last", () => {
  const trees = buildTree({ projects: [
    { key: "/a", file, spaces: ["wt", "s1"] },
    { key: "/b", file, spaces: [] },
    { key: "/c", machine: "box", file, spaces: ["s9"] },
  ] });
  // The sidebar order puts the main checkout's space before its worktree's.
  const { at, rest } = placeTrees(["s1", "wt", "x", "s9"], trees);
  assert.deepEqual([...at], [["s1", projectId({ key: "/a" })], ["s9", projectId({ key: "/c", machine: "box" })]]);
  assert.deepEqual(rest, [projectId({ key: "/b" })]);
});

test("a project whose last space closes stays where that space was; one never placed goes right after the open spaces", () => {
  const trees = buildTree({ projects: [
    { key: "/a", file, spaces: ["s2"] },
    { key: "/b", file, spaces: ["s3"] },
    { key: "/c", file, spaces: [] },
  ] });
  const [a, b, c] = ["/a", "/b", "/c"].map((key) => projectId({ key }));
  // Drawn with every space open: where each placed project's tree is.
  const open = ["s1", "s2", "s3"];
  const last = placesOf(open, placeTrees(open, trees).at);
  assert.deepEqual([...last], [[a, 1], [b, 2]]);
  // /a's space closes: /a stays between s1 and s3; /c, never placed, after the open spaces.
  const now = ["s1", "s3"];
  const { rest } = placeTrees(now, trees);
  assert.deepEqual(rest, [a, c]);
  assert.deepEqual(withSpaceless(now, rest, last), [{ space: "s1" }, { project: a }, { space: "s3" }, { project: c }]);
  // Every space gone: the remembered order holds, after nothing.
  assert.deepEqual(withSpaceless([], [b, a, c], last), [{ project: a }, { project: b }, { project: c }]);
  // The first space closing keeps its project first.
  assert.deepEqual(withSpaceless(["s2"], [projectId({ key: "/z" })], new Map([[projectId({ key: "/z" }), 0]])),
    [{ project: projectId({ key: "/z" }) }, { space: "s2" }]);
});

test("secondLine: the model a live pane runs (its command line, else the agent's default), never typed text", () => {
  const texts = { claudeSettings: JSON.stringify({ model: "sonnet" }) };
  const cap = file.bots.find((b) => b.id === "b-captaincap"); // pinned to an old free-text "GPT-6.1 Terra"
  const main = file.bots.find((b) => b.id === "b-mainmainma");
  const tree = { key: "/repo/proj/" };
  const row = (bot, kind, node = {}) => ({ kind, node: { bot, live: null, argv: null, ...node } });
  const live = { live: { terminal: "t7", duplicate: false } };
  // The row carries the command line: the model it names; with none named, the default.
  assert.equal(secondLine(row(cap, "bot", { ...live, argv: ["claude", "--model", "claude-opus-5-5"] }), tree, { texts }), "Captain · claude-opus-5-5");
  assert.equal(secondLine(row(cap, "bot", { ...live, argv: ["claude", "--resume", "x"] }), tree, { texts }), "Captain · sonnet");
  assert.equal(secondLine(row(cap, "bot", { ...live, argv: ["claude"] }), tree), "Captain");
  // Read with hc get by the caller (argvOf); not known yet: no model rather than a guess.
  assert.equal(secondLine(row(cap, "bot", live), tree, { texts, argvOf: (a) => (a === "t7" ? ["claude", "--model=opus"] : null) }), "Captain · opus");
  assert.equal(secondLine(row(cap, "bot", live), tree, { texts }), "Captain");
  // Stopped: A4's shape, no model (and never the pin's free text).
  assert.equal(secondLine(row(cap, "bot"), tree, { texts }), "not running · Captain");
  assert.equal(secondLine(row(main, "main"), tree, { texts }), "Main bot · not running · proj");
  assert.equal(secondLine(row(main, "main", { ...live, argv: ["claude", "--model", "haiku"] }), tree, { texts }), "Main bot · haiku · proj");
  const planned = file.bots.find((b) => b.id === "b-plannedpla");
  assert.equal(secondLine(row(planned, "planned"), tree, { texts }), "waits for auth v2");
  for (const kind of ["bot", "main"]) assert.doesNotMatch(secondLine(row(cap, kind, live), tree, { texts }), /GPT-6\.1 Terra/);
});

test("model defaults: the config texts are parsed once per change (main.js loadModelTexts), never per row drawn", () => {
  const big = (model) => JSON.stringify({ model, permissions: { allow: Array.from({ length: 2000 }, (_, i) => `Bash(tool-${i}:*)`) } });
  const files = (claude) => ({ claudeSettings: big(claude), codexConfig: 'model = "gpt-5.5"\n[profiles.x]\nmodel = "o9"\n', antigravitySettings: JSON.stringify({ model: "Gemini 3" }), hermesConfig: null });
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...a) => { parses += 1; return parse(...a); };
  try {
    // Every 15 s the same texts come back: parsed on the first read only.
    let seen, state;
    for (let i = 0; i < 5; i += 1) {
      const next = modelTextsUpdate(seen, files("sonnet"));
      if (i === 0) assert.ok(next); else assert.equal(next, null);
      if (next) ({ seen } = next), (state = next);
    }
    assert.equal(parses, 2, "claude's and antigravity's settings, once each");
    assert.deepEqual(state.defaults, { claude: "sonnet", codex: "gpt-5.5", antigravity: "Gemini 3" });
    assert.deepEqual(state.defaults, modelDefaultsFrom(state.texts));
    parses = 0;
    // Drawing: 3 agents x 50 live rows whose command line names no model read no text at all.
    const untouchable = new Proxy({}, { get: (_, k) => { throw new Error(`texts.${String(k)} read while drawing`); } });
    const tree = { key: "/repo/proj/" };
    const row = (agent) => ({ kind: "bot", node: { bot: bot(`b-${agent}`, { agent, role: "Dev" }), live: { terminal: "t1" }, argv: [agent === "antigravity" ? "agy" : agent] } });
    const want = { claude: "Dev · sonnet", codex: "Dev · gpt-5.5", antigravity: "Dev · Gemini 3" };
    for (let i = 0; i < 50; i += 1) {
      for (const agent of Object.keys(want)) assert.equal(secondLine(row(agent), tree, { texts: untouchable, defaults: state.defaults }), want[agent]);
    }
    assert.equal(parses, 0);
    // A changed text: parsed once more, and the rows show the new default.
    const changed = modelTextsUpdate(seen, files("opus"));
    assert.equal(parses, 2);
    assert.equal(secondLine(row("claude"), tree, { texts: untouchable, defaults: changed.defaults }), "Dev · opus");
    // Without parsed defaults (other callers), the default is parsed only when the command line names no model.
    parses = 0;
    const named = { kind: "bot", node: { bot: bot("b-claude", { role: "Dev" }), live: { terminal: "t1" }, argv: ["claude", "--model", "haiku"] } };
    assert.equal(secondLine(named, tree, { texts: untouchable }), "Dev · haiku");
    assert.equal(secondLine(row("claude"), tree, { texts: changed.texts }), "Dev · opus");
    assert.equal(parses, 1);
  } finally { JSON.parse = parse; }
});

test("liveFrom and buildTree carry the live pane's foreground command line when the row has it", () => {
  const rows = [T("t1", { labels: { bot: "b-captaincap" }, foreground: { argv: ["claude", "--model", "opus"] } }), T("t2", { labels: { bot: "b-mainmainma" } })];
  const live = liveFrom(rows);
  assert.deepEqual([live["b-captaincap"].argv, live["b-mainmainma"].argv], [["claude", "--model", "opus"], null]);
  const [tree] = buildTree({ projects: [{ key: KEY, file }], live, terminals: rows, now: NOW });
  const cap = tree.categories.find((c) => c.id === "eng").bots.find((n) => n.bot.id === "b-captaincap");
  assert.deepEqual(cap.argv, ["claude", "--model", "opus"]);
  assert.equal(tree.main.argv, null);
});

test("argvToAsk: live known-bot panes without a command line, not read for the same pane, three at most", () => {
  const known = new Set(["b-a", "b-b", "b-c", "b-d", "b-e"]);
  const rows = [
    T("t1", { labels: { bot: "b-a" }, created_ms: 10 }),
    T("t2", { labels: { bot: "b-b" }, created_ms: 20 }),
    T("t3", { labels: { bot: "b-c" }, foreground: { argv: ["claude"] } }), // the row has it
    T("t4", { labels: { bot: "b-zz" } }), // not a known bot
    T("t5", { labels: { bot: "b-d" }, state: "exited" }),
    T("box/t6", { labels: { bot: "b-d" }, created_ms: 60 }),
    T("t7", { labels: { bot: "b-e" }, created_ms: 70 }),
  ];
  assert.deepEqual(argvToAsk(rows, known), { ask: ["t1", "t2", "box/t6"], gone: [], next: 0 });
  // Read already for the same pane: skipped; a new pane at an old address: asked again.
  const cached = new Map([["t1", { argv: ["claude"], created: 10, settled: true }], ["t2", { argv: ["claude"], created: 19, settled: true }], ["t9", { argv: ["x"], created: 1, settled: true }]]);
  assert.deepEqual(argvToAsk(rows, known, cached), { ask: ["t2", "box/t6", "t7"], gone: ["t9"], next: 0 });
  assert.deepEqual(argvToAsk(rows, known, cached, 1).ask, ["t2"]);
});

test("argvEntry + argvToAsk: a pane read in its sh -c wrapper is asked again on the next refresh", () => {
  const known = new Set(["b-a"]);
  const rows = [T("t1", { labels: { bot: "b-a" }, created_ms: 10 })];
  const wrapper = argvEntry({ foreground: { argv: ["sh", "-c", "claude --model opus"] } }, 10);
  assert.deepEqual(wrapper, { argv: ["sh", "-c", "claude --model opus"], created: 10, settled: false });
  assert.deepEqual(argvToAsk(rows, known, new Map([["t1", wrapper]])).ask, ["t1"]);
  const agent = argvEntry({ foreground: { argv: ["claude", "--model", "opus"] } }, 10);
  assert.equal(agent.settled, true);
  assert.deepEqual(argvToAsk(rows, known, new Map([["t1", agent]])).ask, []);
  assert.deepEqual(argvEntry({}, undefined), { argv: null, created: null, settled: false });
});

test("clickActionOf: a terminal with a pane is focused; a parked one (no pane) is peeked, never kept; remote alike", async () => {
  const { clickActionOf } = await import("../mods/am-sidebar/rows.js");
  const panes = [{ pane: "p1", terminal: "t1dp" }, { pane: "p2", terminal: "box/t4" }, { pane: "p3", terminal: null, mod: "x" }];
  assert.deepEqual(clickActionOf("t1dp", panes), { command: "agent.focus", args: { terminal: "t1dp" } });
  assert.deepEqual(clickActionOf("t1pz", panes), { command: "terminal.peek", args: { terminal: "t1pz" } });
  assert.deepEqual(clickActionOf("box/t4", panes), { command: "agent.focus", args: { terminal: "box/t4" } });
  assert.deepEqual(clickActionOf("box/t9", panes), { command: "terminal.peek", args: { terminal: "box/t9" } });
  assert.deepEqual(clickActionOf("t4", panes), { command: "terminal.peek", args: { terminal: "t4" } }, "a local t4 is not box/t4");
  assert.deepEqual(clickActionOf("t1", null), { command: "terminal.peek", args: { terminal: "t1" } });
});

// The t21v case: herdr-core lists the pane by its shell (program.agent false, no report) while
// claude runs in the foreground; only `hc get` shows that foreground.
test("liveFrom: an agent in the foreground counts when the program table says shell", () => {
  const shell = { key: "shell", name: "zsh", agent: false, shell: true };
  const rows = [
    T("t1", { labels: { bot: "b-mainmainma" }, program: shell, foreground: { argv: ["claude", "--resume", "x"] } }),
    T("t2", { labels: { bot: "b-captaincap" }, program: shell }), // argv only from hc get
    T("t3", { labels: { bot: "b-devdevdevd" }, program: shell }), // hc get: a shell in front
    T("t4", { labels: { bot: "b-testtestte" }, program: shell }), // hc get: the sh -c wrapper
    T("t5", { labels: { bot: "b-loneloneln" }, program: shell }), // not read yet
  ];
  const read = { t2: ["claude", "--model", "opus"], t3: ["-zsh"], t4: ["sh", "-c", "claude"] };
  const live = liveFrom(rows, null, (a) => read[a] ?? null);
  assert.deepEqual(Object.keys(live).sort(), ["b-captaincap", "b-mainmainma"]);
  assert.deepEqual(live["b-mainmainma"].argv, ["claude", "--resume", "x"]);
  assert.deepEqual(live["b-captaincap"].argv, ["claude", "--model", "opus"], "the hc get command line is carried");
  // Without the hc get reads only the row's own foreground counts; a non-array read is ignored.
  assert.deepEqual(Object.keys(liveFrom(rows)), ["b-mainmainma"]);
  assert.deepEqual(Object.keys(liveFrom(rows, null, () => "claude")), ["b-mainmainma"]);
  // The main bot's card reads as running, not "Main bot · not running".
  const [tree] = buildTree({ projects: [{ key: KEY, file }], live, terminals: rows, now: NOW });
  assert.equal(tree.main.live.terminal, "t1");
  assert.match(secondLine({ kind: "main", node: tree.main }, tree), /^Main bot · (?!not running)/);
});

test("argvToAsk: a settled pane the program table calls no agent is read again, after the unread ones", () => {
  const known = new Set(["b-a", "b-b", "b-c"]);
  const shell = { key: "shell", agent: false };
  const rows = [
    T("t1", { labels: { bot: "b-a" }, created_ms: 10, program: shell }),
    T("t2", { labels: { bot: "b-b" }, created_ms: 20 }),
    T("t3", { labels: { bot: "b-c" }, created_ms: 30 }),
  ];
  const settled = (created) => ({ argv: ["claude"], created, settled: true });
  // t1 and t2 settled: t2 (table says agent) is skipped, t1 (table says shell) is read again.
  assert.deepEqual(argvToAsk(rows, known, new Map([["t1", settled(10)], ["t2", settled(20)]])).ask, ["t3", "t1"]);
  assert.deepEqual(argvToAsk(rows, known, new Map([["t1", settled(10)], ["t2", settled(20)]]), 1).ask, ["t3"]);
});

test("heldTerminalOf: a bot's live terminal for its row's click, shown in a pane first, then newest", async () => {
  const { heldTerminalOf } = await import("../mods/am-sidebar/rows.js");
  const rows = [
    T("t1", { labels: { bot: "b-a" }, created_ms: 10 }),
    T("t2", { labels: { bot: "b-a" }, created_ms: 30 }),
    T("t3", { labels: { bot: "b-a" }, created_ms: 99, state: "exited" }),
    T("t4", { labels: { bot: "b-b" }, created_ms: 5 }),
  ];
  assert.equal(heldTerminalOf("b-a", rows), "t2", "newest live");
  assert.equal(heldTerminalOf("b-a", rows, [{ pane: "p1", terminal: "t1" }]), "t1", "a pane shows it");
  assert.equal(heldTerminalOf("b-b", rows, null), "t4");
  assert.equal(heldTerminalOf("b-c", rows), null, "no live terminal");
  assert.equal(heldTerminalOf("b-a", [T("t3", { labels: { bot: "b-a" }, state: "exited" })]), null);
  assert.equal(heldTerminalOf(null, rows), null);
  // The ledger's binding, not the label, says which terminal a row's click holds (#223).
  const terms = [...rows, T("t5", { created_ms: 40 })];
  const bindings = [{ bot: "b-a", terminal: "t5", address: "t5", project: null, machine: null, state: "live" }];
  assert.equal(heldTerminalOf("b-a", terms, [], null, () => null, bindings), "t5");
  assert.equal(heldTerminalOf("b-b", terms, [], null, () => null, bindings), null, "the label alone counts nothing");
  assert.equal(heldClickOf("b-a", terms, [], null, () => null, bindings).args.terminal, "t5");
});

test("argvToAsk: panes that never settle can't starve a stale re-read; the cursor goes round", () => {
  const shell = { key: "shell", agent: false };
  const known = new Set(["b-1", "b-2", "b-3", "b-4", "b-5"]);
  // Four bot panes sitting at zsh (read, never settled) and one read as claude that has since
  // quit back to zsh: the table says shell for all five.
  const rows = ["t1", "t2", "t3", "t4", "t5"].map((a, n) => T(a, { labels: { bot: `b-${n + 1}` }, created_ms: n, program: shell }));
  const cached = new Map(rows.map((k) => [k.address, argvEntry({ foreground: { argv: ["-zsh"] } }, k.created_ms)]));
  cached.set("t5", argvEntry({ foreground: { argv: ["claude"] } }, 4));
  const argvOf = (a) => cached.get(a)?.argv ?? null;
  assert.ok(liveFrom(rows, known, argvOf)["b-5"], "live on the old read");
  const first = argvToAsk(rows, known, cached);
  assert.deepEqual(first.ask, ["t1", "t2", "t3"]);
  const second = argvToAsk(rows, known, cached, 3, first.next);
  assert.ok(second.ask.includes("t5"), "the stale pane is read on the next call");
  // That read finds zsh: the bot stops counting.
  cached.set("t5", argvEntry({ foreground: { argv: ["-zsh"] } }, 4));
  assert.equal(liveFrom(rows, known, argvOf)["b-5"], undefined);
  // The cursor wraps and never asks a pane twice in one call.
  assert.deepEqual(argvToAsk(rows.slice(0, 2), known, cached, 3, 7).ask.sort(), ["t1", "t2"]);
  assert.deepEqual(argvToAsk([], known, cached, 3, 5), { ask: [], gone: [...cached.keys()], next: 0 });
});

test("argvToAsk: a row with no program is re-read too, so a quit agent stops counting", () => {
  const known = new Set(["b-a"]);
  const rows = [T("t1", { labels: { bot: "b-a" }, created_ms: 10, program: null })];
  const cached = new Map([["t1", argvEntry({ foreground: { argv: ["claude"] } }, 10)]]);
  assert.ok(liveFrom(rows, known, (a) => cached.get(a)?.argv)["b-a"]);
  assert.deepEqual(argvToAsk(rows, known, cached).ask, ["t1"]);
  // With program.agent true the table answers; a settled read isn't asked again.
  assert.deepEqual(argvToAsk([{ ...rows[0], program: { agent: true } }], known, cached).ask, []);
});

test("argvToAsk: a pane never read is asked first, ahead of the shell-held rotation", () => {
  const shell = { key: "shell", agent: false };
  const known = new Set(["b-1", "b-2", "b-3", "b-4", "b-5", "b-6"]);
  const held = ["t1", "t2", "t3", "t4", "t5"].map((a, n) => T(a, { labels: { bot: `b-${n + 1}` }, created_ms: n, program: shell }));
  const cached = new Map(held.map((k) => [k.address, argvEntry({ foreground: { argv: ["-zsh"] } }, k.created_ms)]));
  const fresh = T("t6", { labels: { bot: "b-6" }, created_ms: 50, program: shell }); // just started
  const rows = [...held, fresh];
  for (const start of [0, 1, 2, 3, 4]) {
    const r = argvToAsk(rows, known, cached, 3, start);
    assert.equal(r.ask[0], "t6", `start ${start}`);
    assert.equal(r.ask.length, 3);
  }
  // The rotation of the rest still moves on: two slots each call.
  const a = argvToAsk(rows, known, cached), b = argvToAsk(rows, known, cached, 3, a.next);
  assert.deepEqual([a.ask, b.ask], [["t6", "t1", "t2"], ["t6", "t3", "t4"]]);
  // A new pane at an old address counts as never read.
  const reborn = held.map((k) => (k.address === "t3" ? { ...k, created_ms: 99 } : k));
  assert.equal(argvToAsk(reborn, known, cached, 3, 4).ask[0], "t3");
});

test("argvAfter: a failed or empty read marks the pane read, keeps an earlier read of the same pane", () => {
  const claude = argvEntry({ foreground: { argv: ["claude"] } }, 10);
  assert.deepEqual(argvAfter(undefined, null, 10), { argv: null, created: 10, settled: false }, "failed first read");
  assert.deepEqual(argvAfter(undefined, {}, 10), { argv: null, created: 10, settled: false }, "no argv");
  assert.equal(argvAfter(claude, null, 10), claude, "a failed ask keeps the read before");
  assert.deepEqual(argvAfter(claude, null, 11), { argv: null, created: 11, settled: false }, "not for a new pane");
  assert.deepEqual(argvAfter(claude, { foreground: { argv: ["-zsh"] } }, 10).argv, ["-zsh"], "a read replaces it");
});

test("argvToAsk: panes whose reads fail join the rotation; a quit agent is re-read; a new pane is read", () => {
  const shell = { key: "shell", agent: false };
  const known = new Set(["b-1", "b-2", "b-3", "b-4", "b-5"]);
  // Three remote panes on a machine that is down: every hc get fails. One quit agent.
  const down = ["box/t1", "box/t2", "box/t3"].map((a, n) => T(a, { labels: { bot: `b-${n + 1}` }, created_ms: n, program: shell }));
  const quit = T("t4", { labels: { bot: "b-4" }, created_ms: 40, program: shell });
  const rows = [...down, quit];
  const cached = new Map([["t4", argvEntry({ foreground: { argv: ["claude"] } }, 40)]]);
  // Simulate readBotArgv: ask, then store what each read gives (the remote ones fail).
  const reads = { t4: { foreground: { argv: ["-zsh"] } } };
  let start = 0, askedT4 = false;
  for (let tick = 0; tick < 3 && !askedT4; tick++) {
    const { ask, next } = argvToAsk(rows, known, cached, 3, start);
    start = next;
    askedT4 = ask.includes("t4");
    for (const a of ask) cached.set(a, argvAfter(cached.get(a), reads[a] ?? null, rows.find((k) => k.address === a).created_ms));
  }
  assert.ok(askedT4, "the quit agent is re-read despite three failing panes");
  assert.equal(liveFrom(rows, known, (a) => cached.get(a)?.argv)["b-4"], undefined, "and stops counting");
  // Even before any failed read is cached, one slot stays with the rotation.
  const none = new Map([["t4", argvEntry({ foreground: { argv: ["claude"] } }, 40)]]);
  assert.deepEqual(argvToAsk(rows, known, none).ask, ["box/t1", "box/t2", "t4"]);
  // A fourth, new pane is read on the next call: the failed ones are no longer "never read".
  const fresh = T("t5", { labels: { bot: "b-5" }, created_ms: 50, program: shell });
  assert.ok(argvToAsk([...rows, fresh], known, cached, 3, start).ask.includes("t5"));
  for (const a of ["box/t1", "box/t2", "box/t3"]) cached.set(a, argvAfter(cached.get(a), null, rows.find((k) => k.address === a).created_ms));
  assert.equal(argvToAsk([...rows, fresh], known, cached, 3, start).ask[0], "t5", "first once all three have failed");
});

test("argvReader: a read counts only for the pane it was made of; a reused address doesn't count a shell", () => {
  const shell = { key: "shell", agent: false };
  const cache = new Map([["t1", argvEntry({ foreground: { argv: ["claude"] } }, 10)]]);
  const read = argvReader(cache);
  assert.deepEqual(read("t1", 10), ["claude"]);
  assert.equal(read("t1", 11), null, "another pane at t1");
  assert.equal(read("t9", 10), null);
  assert.equal(argvReader(new Map([["t1", { argv: null, created: 10, settled: false }]]))("t1", 10), null);
  // t1 reborn as a shell (created_ms 11) with the old claude read still cached: not live.
  const reborn = [T("t1", { labels: { bot: "b-a" }, created_ms: 11, program: shell })];
  assert.equal(liveFrom(reborn, null, read)["b-a"], undefined);
  const same = [T("t1", { labels: { bot: "b-a" }, created_ms: 10, program: shell })];
  assert.deepEqual(liveFrom(same, null, read)["b-a"].argv, ["claude"]);
});

test("liveFrom: the cached read is used only when the row has no foreground.argv", () => {
  const shell = { key: "shell", agent: false };
  const claude = () => ["claude"];
  // The row says a shell is in front now: an older cached claude read doesn't override it.
  const atShell = [T("t1", { labels: { bot: "b-a" }, program: shell, foreground: { argv: ["-zsh"] } })];
  assert.equal(liveFrom(atShell, null, claude)["b-a"], undefined);
  const noArgv = [T("t1", { labels: { bot: "b-a" }, program: shell })];
  assert.ok(liveFrom(noArgv, null, claude)["b-a"]);
});

test("heldClickOf: decided at click time; nothing when the bot holds no live terminal any more", () => {
  const rows = [T("t1", { labels: { bot: "b-a" }, created_ms: 1 })];
  assert.deepEqual(heldClickOf("b-a", rows, [{ pane: "p1", terminal: "t1" }]), { command: "agent.focus", args: { terminal: "t1" } });
  assert.deepEqual(heldClickOf("b-a", rows, []), { command: "terminal.peek", args: { terminal: "t1" } });
  assert.equal(heldClickOf("b-a", [{ ...rows[0], state: "exited" }], []), null, "gone since the render");
  assert.equal(heldClickOf("b-a", [], null), null);
});

// automagik#227 (RFC 0014 Q16): a clone or second checkout carries the same .herdr/bots.json ids,
// so a pane counts for a project by project and id. keyOf maps a pane to its project key (main.js
// reads it from the pane's folder with model.js paneKeyOf); null: no project, counts everywhere.
const MAIN = "/repo/proj", CLONE = "/repo/proj-clone";
const keyByCwd = { "/repo/proj": MAIN, "/repo/proj-wt": MAIN, "/repo/proj-clone": CLONE };
const keyOf = (t) => keyByCwd[t.cwd] ?? null;
const twoCheckouts = [{ key: MAIN, file, spaces: ["s1"] }, { key: CLONE, file, spaces: ["s2"] }];
const mainBotIn = (trees, key) => trees.find((x) => x.key === key).main;

test("#227: the main checkout's pane is live under main only; the clone with the same ids is not running", () => {
  const terms = [T("t1", { labels: { bot: "b-mainmainma" }, cwd: "/repo/proj", status: "working" })];
  const live = liveFrom(terms, knownBots(twoCheckouts), undefined, keyOf);
  const trees = buildTree({ projects: twoCheckouts, live, terminals: terms, now: NOW });
  assert.equal(mainBotIn(trees, MAIN).live.terminal, "t1");
  assert.equal(mainBotIn(trees, MAIN).pose, "working");
  assert.equal(mainBotIn(trees, CLONE).live, null);
  assert.equal(mainBotIn(trees, CLONE).pose, "asleep");
  assert.equal(liveOf(live, { key: CLONE }, "b-mainmainma"), null);
});

test("#227: each checkout keeps its own pane, picked newest within the project; a worktree is main's", () => {
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, cwd: "/repo/proj", created_ms: 1 }),
    T("t2", { labels: { bot: "b-mainmainma" }, cwd: "/repo/proj-clone", created_ms: 9 }),
    T("t3", { labels: { bot: "b-captaincap" }, cwd: "/repo/proj-wt" }),
  ];
  const trees = buildTree({ projects: twoCheckouts, live: liveFrom(terms, knownBots(twoCheckouts), undefined, keyOf), terminals: terms, now: NOW });
  assert.deepEqual([mainBotIn(trees, MAIN).live, mainBotIn(trees, CLONE).live],
    [{ terminal: "t1", duplicate: false, parent: null }, { terminal: "t2", duplicate: false, parent: null }]);
  const cap = (key) => trees.find((x) => x.key === key).categories.find((c) => c.id === "eng").bots.find((n) => n.bot.id === "b-captaincap");
  assert.equal(cap(MAIN).live.terminal, "t3", "the worktree's pane counts for its main checkout");
  assert.equal(cap(CLONE).live, null);
});

test("#227: a pane with no project (no folder, not in git, not read yet) still counts for every project", () => {
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, cwd: "/repo/proj", created_ms: 1 }),
    T("t4", { labels: { bot: "b-mainmainma" }, cwd: "/elsewhere", created_ms: 5 }),
    T("t5", { labels: { bot: "b-captaincap" } }),
  ];
  const trees = buildTree({ projects: twoCheckouts, live: liveFrom(terms, knownBots(twoCheckouts), undefined, keyOf), terminals: terms, now: NOW });
  // Main has its own pane and the unknown one: the newest is shown, flagged duplicate.
  assert.deepEqual(mainBotIn(trees, MAIN).live, { terminal: "t4", duplicate: true, parent: null });
  assert.deepEqual(mainBotIn(trees, CLONE).live, { terminal: "t4", duplicate: false, parent: null });
  for (const key of [MAIN, CLONE]) {
    assert.equal(trees.find((x) => x.key === key).categories.find((c) => c.id === "eng").bots.find((n) => n.bot.id === "b-captaincap").live.terminal, "t5");
  }
  // With no keyOf (every older caller) nothing changes: the map is by id, as before.
  assert.deepEqual(Object.keys(liveFrom(terms, knownBots(twoCheckouts))).sort(), ["b-captaincap", "b-mainmainma"]);
  assert.equal(paneCounts(terms[1], { key: CLONE }, keyOf), true);
  assert.equal(paneCounts(terms[0], { key: CLONE }, keyOf), false);
  // A project on another machine with the same key is another project.
  assert.equal(paneCounts(terms[0], { key: MAIN, machine: "box" }, keyOf), false);
});

test("#227: a held bot row's click goes to a terminal of its own project only", () => {
  const terms = [T("t1", { labels: { bot: "b-mainmainma" }, cwd: "/repo/proj", program: { key: "shell", agent: false } })];
  assert.equal(heldTerminalOf("b-mainmainma", terms, [], { key: MAIN }, keyOf), "t1");
  assert.equal(heldTerminalOf("b-mainmainma", terms, [], { key: CLONE }, keyOf), null);
  assert.equal(heldClickOf("b-mainmainma", terms, [], { key: CLONE }, keyOf), null);
  assert.equal(heldTerminalOf("b-mainmainma", [{ ...terms[0], cwd: undefined }], [], { key: CLONE }, keyOf), "t1", "no project: as before");
  assert.equal(heldTerminalOf("b-mainmainma", terms), "t1", "no project given: as before");
});

test("#227: a pane keyed to a project no listed checkout of its bot is (restart --cwd elsewhere, an unlisted clone) counts as before", () => {
  const onlyMain = [{ key: MAIN, file, spaces: ["s1"] }];
  const other = { "/repo/proj": MAIN, "/elsewhere/repo": "/elsewhere/repo", "/repo/proj-clone": CLONE };
  const folderKeyOf = (t) => other[t.cwd] ?? null;
  const terms = [
    T("t1", { labels: { bot: "b-mainmainma" }, cwd: "/elsewhere/repo" }),
    T("t2", { labels: { bot: "b-captaincap" }, cwd: "/repo/proj-clone" }),
    T("t3", { labels: { bot: "b-devdevdevd" }, cwd: "/repo/proj" }),
  ];
  const keyOf = listedKeyOf(onlyMain, folderKeyOf);
  assert.deepEqual(terms.map(keyOf), [null, null, MAIN]);
  const [tree] = buildTree({ projects: onlyMain, live: liveFrom(terms, knownBots(onlyMain), undefined, keyOf), terminals: terms, now: NOW });
  assert.equal(tree.main.live.terminal, "t1", "a pane in another repository still shows under main");
  const eng = tree.categories.find((c) => c.id === "eng").bots;
  assert.equal(eng.find((n) => n.bot.id === "b-captaincap").live.terminal, "t2", "a pane in an unlisted clone still shows");
  // Listed, but that project doesn't define the pane's bot: no key either.
  const lone = { version: 1, categories: [], bots: [file.bots.find((b) => b.id === "b-mainmainma")] };
  assert.equal(listedKeyOf([{ key: MAIN, file: lone }], folderKeyOf)(terms[2]), null);
  // Once the clone is listed, its pane is the clone's alone.
  assert.equal(listedKeyOf(twoCheckouts, folderKeyOf)(terms[1]), CLONE);
  // A pane on another machine pairs with that machine's project of the key, never this computer's.
  assert.equal(listedKeyOf(onlyMain, () => MAIN)({ ...terms[2], address: "box/t3" }), null);
  assert.equal(listedKeyOf([{ key: MAIN, machine: "box", file }], () => MAIN)({ ...terms[2], address: "box/t3" }), MAIN);
});

// automagik#231: membership stays from bots.json's lead; a row only marks a live pane whose hc
// parent is neither absent nor its lead's live pane, naming both addresses in the tooltip.
const markOf = (terms, projects = [{ key: KEY, file, spaces: ["s1"] }]) => {
  const trees = buildTree({ projects, live: liveFrom(terms, knownBots(projects)), terminals: terms, now: NOW });
  const eng = trees[0].categories.find((c) => c.id === "eng").bots.find((n) => n.bot.id === "b-captaincap");
  return { main: trees[0].main, cap: eng, dev: eng.members.find((n) => n.bot.id === "b-devdevdevd") };
};
const captainAt = (address) => T(address, { labels: { bot: "b-captaincap" } });
const devAt = (address, parent) => T(address, { labels: { bot: "b-devdevdevd" }, parent });

test("#231: a live pane whose hc parent is not its lead's pane is marked with both addresses", () => {
  const { dev } = markOf([T("t1", { labels: { bot: "b-mainmainma" } }), captainAt("t2"), devAt("t3", "t1")]);
  assert.deepEqual(dev.parentMark, { parent: "t1", leadPanes: ["t2"], lead: "b-captaincap", leadName: "captaincap" });
  assert.equal(dev.members.length, 0, "membership is the file's lead, never the hc parent");
  // A dead parent (the dogfooding case: t19s -> t19q, gone) is marked the same way.
  assert.equal(markOf([captainAt("t2"), devAt("t3", "t19q")]).dev.parentMark.parent, "t19q");
});

test("#231: no mark when the parent is the lead's pane, absent, or the lead has no live pane", () => {
  for (const [why, terms] of [
    ["equal", [captainAt("t2"), devAt("t3", "t2")]],
    ["absent", [captainAt("t2"), devAt("t3", null)]],
    ["no lead pane", [devAt("t3", "t9")]],
  ]) {
    const { dev, cap, main } = markOf(terms);
    assert.ok(dev.live && !("parentMark" in dev), why);
    assert.ok(!("parentMark" in cap) && !("parentMark" in main), why);
  }
  // The main bot has no lead: never marked, whatever its parent.
  const { main } = markOf([T("t1", { labels: { bot: "b-mainmainma" }, parent: "t7" })]);
  assert.ok(main.live && !("parentMark" in main));
});

test("#231: a remote pane compares on its own machine, a bare parent id being that machine's", () => {
  const box = [{ key: KEY, machine: "box", file, spaces: ["s1"] }];
  for (const parent of ["t2", "box/t2"]) assert.ok(!("parentMark" in markOf([captainAt("box/t2"), devAt("box/t3", parent)], box).dev), parent);
  assert.deepEqual(markOf([captainAt("box/t2"), devAt("box/t3", "t9")], box).dev.parentMark,
    { parent: "box/t9", leadPanes: ["box/t2"], lead: "b-captaincap", leadName: "captaincap" });
  // The same id on another machine is another pane.
  assert.equal(markOf([captainAt("t2"), devAt("box/t3", "t2")]).dev.parentMark.parent, "box/t2");
});

test("#231: the mark's tooltip names the hc parent, then the lead's pane and name", () => {
  assert.equal(parentMarkText({ parent: "box/t9", leadPanes: ["box/t2"], lead: "b-captaincap", leadName: "Captain" }),
    "Its hc parent is box/t9, not its lead's pane box/t2 (Captain)");
  assert.equal(parentMarkText({ parent: "t1", leadPanes: ["t2"], lead: "b-x", leadName: null }), "Its hc parent is t1, not its lead's pane t2");
  assert.equal(parentMarkText({ parent: "t9", leadPanes: ["t5", "t2"], lead: "b-x", leadName: "Captain" }),
    "Its hc parent is t9, not its lead's panes t5, t2 (Captain)");
  assert.equal(parentMarkOf({ terminal: "t3", parent: "t2" }, { terminal: "t2" }), null);
  assert.equal(parentMarkOf({ terminal: "t3", parent: "t2" }, null), null);
});

test("#231: a lead with two live panes: a parent that is either is no mark; a third terminal is, naming both", () => {
  const older = T("t2", { labels: { bot: "b-captaincap" }, created_ms: 10 }), newer = T("t5", { labels: { bot: "b-captaincap" }, created_ms: 20 });
  for (const parent of ["t2", "t5"]) assert.ok(!("parentMark" in markOf([older, newer, devAt("t3", parent)]).dev), parent);
  const { dev, cap } = markOf([older, newer, devAt("t3", "t9")]);
  assert.equal(cap.live.terminal, "t5", "the sidebar shows the newest");
  assert.deepEqual(dev.parentMark, { parent: "t9", leadPanes: ["t5", "t2"], lead: "b-captaincap", leadName: "captaincap" });
  assert.equal(parentMarkText(dev.parentMark), "Its hc parent is t9, not its lead's panes t5, t2 (captaincap)");
  // On a remote machine too: a bare parent id is that machine's, matched against every pane.
  const box = [{ key: KEY, machine: "box", file, spaces: ["s1"] }];
  const remote = (parent) => markOf([{ ...older, address: "box/t2" }, { ...newer, address: "box/t5" }, devAt("box/t3", parent)], box).dev;
  assert.ok(!("parentMark" in remote("t2")));
  assert.deepEqual(remote("t9").parentMark.leadPanes, ["box/t5", "box/t2"]);
});

test("cross-project lead (#850): buildTree nests a cross-project main or member under its lead in the other project only when reciprocal and tags projectName", () => {
  const hubFile = parseBots(JSON.stringify({
    version: 1,
    categories: [],
    bots: [
      bot("b-coordcoord", {
        kind: "main",
        name: "Coord",
        crossMembers: [{ id: "b-spokemainm", project: "/work/spoke" }],
      }),
    ],
  })).file;
  const spokeFile = parseBots(JSON.stringify({
    version: 1,
    categories: [],
    bots: [
      bot("b-spokemainm", { kind: "main", name: "SpokeMain", lead: "b-coordcoord", leadProject: "/work/hub" }),
      bot("b-spokedevdv", { kind: "member", name: "SpokeDev", lead: "b-spokemainm" }),
    ],
  })).file;
  const projects = [
    { key: "/work/hub", file: hubFile, spaces: ["s1"] },
    { key: "/work/spoke", file: spokeFile, spaces: ["s2"] },
  ];
  const terms = [
    T("t1", { labels: { bot: "b-coordcoord" }, status: "idle", status_ms: NOW }),
    T("t2", { labels: { bot: "b-spokemainm" }, parent: "t1", status: "working", status_ms: NOW }),
    T("t3", { labels: { bot: "b-spokedevdv" }, parent: "t2", status: "idle", status_ms: NOW }),
  ];
  const trees = buildTree({ projects, live: liveFrom(terms, knownBots(projects)), terminals: terms, now: NOW });
  const hubTree = trees.find((t) => t.key === "/work/hub");
  const spokeTree = trees.find((t) => t.key === "/work/spoke");

  // SpokeMain and its member SpokeDev nest under Coord in hubTree, tagged with /work/spoke and projectName "spoke".
  assert.equal(spokeTree.main, null);
  assert.equal(hubTree.uncategorised.length, 1);
  const nestedMain = hubTree.uncategorised[0];
  assert.equal(nestedMain.bot.id, "b-spokemainm");
  assert.equal(nestedMain.project, "/work/spoke");
  assert.equal(nestedMain.projectName, "spoke");
  assert.ok(!("parentMark" in nestedMain), "parent t1 matches cross-project lead Coord's pane");
  assert.equal(nestedMain.members.length, 1);
  assert.equal(nestedMain.members[0].bot.id, "b-spokedevdv");
  assert.equal(nestedMain.members[0].project, "/work/spoke");
  assert.equal(nestedMain.members[0].projectName, "spoke");

  // secondLine and visibleRows carry project and projectName for cross-project rows.
  const rows = visibleRows(hubTree, new Map([[botFold("b-spokemainm"), true]]));
  const spokeMainRow = rows.find((r) => r.node?.bot.id === "b-spokemainm");
  const spokeDevRow = rows.find((r) => r.node?.bot.id === "b-spokedevdv");
  assert.equal(spokeMainRow.project, "/work/spoke");
  assert.equal(spokeMainRow.projectName, "spoke");
  assert.equal(spokeDevRow.project, "/work/spoke");
  assert.match(secondLine(spokeMainRow), / · spoke$/);

  // One-sided declaration: when Coord does not list SpokeMain in crossMembers, SpokeMain stays in spokeTree with a warning.
  const oneSidedHub = parseBots(JSON.stringify({
    version: 1,
    categories: [],
    bots: [bot("b-coordcoord", { kind: "main", name: "Coord" })],
  })).file;
  const oneSidedTrees = buildTree({
    projects: [
      { key: "/work/hub", file: oneSidedHub, spaces: ["s1"] },
      { key: "/work/spoke", file: spokeFile, spaces: ["s2"] },
    ],
    live: {},
    terminals: [],
    now: NOW,
  });
  const oneSidedSpoke = oneSidedTrees.find((t) => t.key === "/work/spoke");
  assert.equal(oneSidedSpoke.main.bot.id, "b-spokemainm");
  assert.match(oneSidedSpoke.main.warning, /is one-sided/);

  // When the target leadProject is not loaded, the bot stays in its own project tree with a warning.
  const loneSpoke = buildTree({
    projects: [{ key: "/work/spoke", file: spokeFile, spaces: ["s2"] }],
    live: {},
    terminals: [],
    now: NOW,
  })[0];
  assert.equal(loneSpoke.main.bot.id, "b-spokemainm");
  assert.match(loneSpoke.main.warning, /project \/work\/hub has no roster/);
});

test("#1557 the sidebar marks a live Claude seat's rate-limit record on its node, and leaves a healthy one alone", () => {
  assert.equal(RATE_LIMITED, "Rate limited");
  const trees = buildTree({
    projects: [{ key: KEY, file }],
    live: { "b-mainmainma": { terminal: "t1", status: "idle", status_ms: NOW } },
    terminals: [], now: NOW,
    rateLimited: new Map([["t1", { question: "Rate limit reached", resets_at: "2026-11-19T14:10:00.000Z" }]]),
  });
  assert.deepEqual(trees[0].main.rateLimited, { question: "Rate limit reached", resets_at: "2026-11-19T14:10:00.000Z" });
  assert.equal(trees[0].main.status, "idle", "the core status is kept beside the added word");
  assert.equal(trees[0].main.pose, "idle", "the character keeps its core pose; the chip carries the word");
  const clean = buildTree({
    projects: [{ key: KEY, file }],
    live: { "b-mainmainma": { terminal: "t1", status: "idle", status_ms: NOW } },
    terminals: [], now: NOW, rateLimited: new Map(),
  });
  assert.equal("rateLimited" in clean[0].main, false);
  const noLive = buildTree({ projects: [{ key: KEY, file }], live: {}, terminals: [], now: NOW,
    rateLimited: new Map([["t1", { question: "x" }]]) });
  assert.equal("rateLimited" in noLive[0].main, false, "a record on a stopped seat's old address is never drawn");
});
