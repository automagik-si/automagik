// tidy (sidebar-rules Group 2): the planner over the recorded fixtures and plain-data cases,
// the State read from hc, herdr-app, git and the files, and the CLI: `tidy` changes nothing,
// and start, attach and create apply only the non-visual fixes. Fakes only: test/fake-hc.mjs
// and a herdr-app script that logs its calls; the real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plan, applyNonVisual, planText, folderFacts, displayName } from "../mods/am-sidebar/tidy.js";
import { readState, spacesOf } from "../mods/am-sidebar/bin/state.mjs";
import { runProgram } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { fixtures, golden, view } from "./sidebar-fixture.mjs";
import { readJsonLines, readLines } from "./log-lines.mjs";
import { assertSafeTmpdir, scratchProject, scratchRoot } from "./scratch-project.mjs";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const TIDY = new URL("./fixtures/tidy/", import.meta.url);
const load = (dir, name) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
const drift = () => load(TIDY, "drift-2026-11-02");
const owner = () => fixtures().find((f) => f.name === "owner-2026-11-02").state;

/** One line per action, for whole-plan comparisons. */
function brief(a) {
  switch (a.kind) {
    case "prune-registry": return `prune-registry ${a.key}`;
    case "relabel": return `relabel${a.visual ? "(visual)" : ""} ${a.terminal} ${Object.entries(a.set).map(([k, v]) => `${k}=${v}`).join(" ")}`;
    case "create-space": return `create-space ${a.machine ?? "-"} ${a.folder} "${a.name}"`;
    case "recreate-space": return `recreate-space ${a.space} ${a.from} -> ${a.to} "${a.name}"`;
    case "move-pane": return `move-pane ${a.terminal} ${a.from.space} -> ${a.to.space ?? `new:${a.to.key}`} ${a.reason}`;
    case "rename-space": return `rename-space ${a.space} "${a.from}" -> "${a.to}"`;
    case "close-space": return `close-space ${a.space}`;
    default: return `report ${a.report} ${a.terminal ?? a.space}`;
  }
}
const planOf = (state) => plan(state, { now: NOW, home: "~", appHome: "~/.config/herdr-app" });
const R = "~/workspace/repos";

// ---- the fixtures ----

test("tidy fixtures are anonymised like the sidebar ones: paths under ~, project-x folders, no instructions", () => {
  for (const f of readdirSync(TIDY).filter((x) => x.endsWith(".json"))) {
    const text = readFileSync(new URL(f, TIDY), "utf8");
    const state = JSON.parse(text);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|"(argv|foreground|records|screen|token)"|sk-[A-Za-z0-9]{8}/, f);
    for (const p of state.projects) for (const b of p.file.bots) assert.equal(b.instructions ?? "", "", `${f}: ${b.id}`);
    const folders = [...state.terminals.map((t) => t.cwd), ...state.spaces.map((s) => s.folder), ...state.projects.map((p) => p.key),
      ...state.registry, ...Object.keys(state.folders ?? {})];
    for (const x of folders) assert.match(x, /^~\/workspace\/repos\/project-[a-z]+(\.worktrees\/branch-\d+)?$/, `${f}: ${x}`);
  }
});

test("drift fixture: the whole plan, in its fixed order (non-visual, visual, reports)", () => {
  assert.deepEqual(planOf(drift()).map(brief), [
    `prune-registry ${R}/project-orchestrator`,
    "relabel t2 role=captain category=eng",
    `create-space - ${R}/project-omega "project-omega"`,
    `recreate-space sp02beta ${R}/project-alpha -> ${R}/project-beta "project-beta"`,
    `recreate-space sp03delta ${R}/project-alpha -> ${R}/project-delta "project-delta"`,
    `recreate-space sp04gamma ${R}/project-old -> ${R}/project-gamma "project-gamma"`,
    `recreate-space sp05work ${R}/project-epsilon -> ${R}/project-plain "Plain"`,
    "move-pane t20 sp01alpha -> sp02beta stray",
    "move-pane t3 sp06squad -> sp01alpha duplicate",
    'rename-space sp01alpha "Alpha HQ" -> "project-alpha"',
    "close-space sp09empty",
    "report stale-worktree-space sp07wt2",
    "report stale-needs-owner t1",
    "report orphan-helper t13",
  ]);
});

test("drift fixture names each drift of the request that tidy can see (2-5, 7) and the stale registry entry", () => {
  const acts = planOf(drift());
  const has = (pred, what) => assert.ok(acts.some(pred), what);
  has((a) => a.kind === "rename-space" && a.from === "Alpha HQ", "drift 2: a hand-typed name");
  has((a) => a.kind === "move-pane" && a.reason === "duplicate" && a.from.space === "sp06squad", "drift 3: a squad space");
  has((a) => a.kind === "prune-registry" && a.key === `${R}/project-orchestrator`, "drift 4: the deleted folder");
  has((a) => a.kind === "create-space" && a.key === `${R}/project-omega`, "drift 5: bots with no space");
  has((a) => a.report === "orphan-helper" && a.terminal === "t13", "drift 7: a helper whose parent is gone");
  has((a) => a.kind === "move-pane" && a.reason === "stray" && a.terminal === "t20", "a stray terminal of beta in alpha's space");
  has((a) => a.report === "stale-worktree-space" && a.space === "sp07wt2", "a worktree space no seat needs");
  // Drift 1 (where): never read. Drift 6 (row order) is R3's: the golden order below.
  assert.ok(acts.every((a) => !JSON.stringify(a).includes('"where"')));
});

test("D14: today's wrong spaces plan one recreate-space each, on the right folder", () => {
  const recreate = Object.fromEntries(planOf(drift()).filter((a) => a.kind === "recreate-space").map((a) => [a.space, a]));
  assert.equal(recreate.sp04gamma.to, `${R}/project-gamma`, "a folder that is gone");
  assert.match(recreate.sp04gamma.why, /is gone/);
  assert.equal(recreate.sp02beta.to, `${R}/project-beta`, "a project's space on another repo's folder");
  assert.equal(recreate.sp03delta.to, `${R}/project-delta`, "a second one");
  assert.equal(recreate.sp05work.to, `${R}/project-plain`, "a plain folder's space on a git repo");
  assert.equal(recreate.sp05work.name, "Plain", "the display name from bots.json (D7)");
  assert.ok(Object.values(recreate).every((a) => a.visual));
});

test("the owner's recorded fixture: its plan, with no folder guessed gone", () => {
  assert.deepEqual(planOf(owner()).map(brief), [
    `recreate-space sp23f728cb4a2cdd1b527e8420f0f83afb ${R}/project-n -> ${R}/project-c "project-c"`,
    `move-pane t187 spea78c8fb088b7856249fe52c41125af3 -> sp9d7f2575f71a6dbb5b4f6c790c55476b stray`,
    `move-pane t16r sp06181487e8d2804ed5d5509764c4f938 -> sp9d7f2575f71a6dbb5b4f6c790c55476b duplicate`,
    `move-pane t21z sp4dc68bcf46eda7eec9f83aafec09c603 -> sp9d7f2575f71a6dbb5b4f6c790c55476b duplicate`,
    'rename-space sp9d7f2575f71a6dbb5b4f6c790c55476b "space 2" -> "project-d"',
    'rename-space spb9ce4e08fb6697e48f73446db3ce837a "space 3" -> "project-a"',
    'rename-space spea78c8fb088b7856249fe52c41125af3 "Automagik Herdr" -> "herdr-bots"',
    'rename-space spfa1c2f98c795a969a394ff07609fc337 "space 4" -> "project-b"',
    "report orphan-helper t1zy",
  ]);
});

test("the recorded fixtures still give the golden row order", () => {
  for (const { name, state } of fixtures()) {
    const got = Object.fromEntries(view(state).map((v) => [v.space.id, { name: v.space.name, rows: v.rows.map((d) => `${d.kind} ${d.id}`) }]));
    assert.deepEqual(got, golden(name).rows, name);
  }
});

test("plan is pure: the same answer twice, the State untouched", () => {
  for (const state of [drift(), owner()]) {
    const before = JSON.stringify(state);
    assert.deepEqual(planOf(state), planOf(state));
    assert.equal(JSON.stringify(state), before);
  }
});

test("the non-visual fixes done, the plan has no non-visual action left; the visual ones stay", () => {
  for (const state of [drift(), owner()]) {
    const first = planOf(state);
    const after = planOf(applyNonVisual(state, first));
    assert.deepEqual(after.filter((a) => !a.visual && a.kind !== "report"), []);
    assert.deepEqual(after.filter((a) => a.visual).map(brief), first.filter((a) => a.visual).map(brief));
  }
});

test("every action carries kind, visual and why; reports and non-visual kinds are never visual", () => {
  for (const a of planOf(drift())) {
    assert.equal(typeof a.why, "string");
    assert.equal(typeof a.visual, "boolean");
    if (["prune-registry", "report"].includes(a.kind)) assert.equal(a.visual, false);
  }
});

// ---- plain-data cases the fixtures don't hold ----

const look = { character: "star", colour: "blue" };
const bots = (...list) => ({ version: 1, categories: [], bots: list.map(([id, kind, more]) => ({ id, name: id, kind, role: "r", instructions: "", agent: "claude", look, ...more })) });
const T = (address, cwd, labels = {}, more = {}) => ({ address, agent: "codex", cwd, state: "live", status: "idle", parent: null,
  program: { key: "codex", agent: true }, labels, ...more });
const space = (id, folder, terminals, machine = null) => ({ id, name: id, machine, folder, selected: false,
  tabs: [{ id: `${id}-tab`, name: "tab", selected: true, panes: terminals.map((t) => ({ pane: `p-${t}`, terminal: t })) }] });
const A = "/r/a", B = "/r/b";
const MAIN_A = "b-aaaaaaaaaa", MAIN_B = "b-bbbbbbbbbb";
const base = (more = {}) => ({
  terminals: [T("t1", A, { bot: MAIN_A, role: "main", "herdr.space": "sa" })],
  spaces: [space("sa", A, ["t1"])],
  projects: [{ key: A, machine: null, file: bots([MAIN_A, "main"]) }, { key: B, machine: null, file: bots([MAIN_B, "main"]) }],
  registry: [A, B],
  folders: { [A]: { exists: true, key: A, top: A }, [B]: { exists: true, key: B, top: B }, [`${A}/docs`]: { exists: true, key: A, top: A } },
  ...more,
});

test("a tidy window plans nothing, and says so", () => {
  const s = base();
  s.spaces[0].name = "a";
  assert.deepEqual(planOf(s), []);
  assert.equal(planText([]), "Nothing to tidy.");
});

test("D14: a space on a git subfolder of its project is recreated on the top level", () => {
  const s = base({ spaces: [{ ...space("sa", `${A}/docs`, ["t1"]), name: "a" }] });
  const [a] = planOf(s);
  assert.deepEqual([a.kind, a.from, a.to], ["recreate-space", `${A}/docs`, A]);
  assert.match(a.why, /inside \/r\/a, not its top level/);
});

test("a stray whose project has no space: the space is created, and the move targets it", () => {
  const s = base({ terminals: [...base().terminals, T("t2", B, { bot: MAIN_B, role: "main" })], spaces: [{ ...space("sa", A, ["t1", "t2"]), name: "a" }] });
  assert.deepEqual(planOf(s).map(brief), [`create-space - ${B} "b"`, "move-pane t2 sa -> new:/r/b stray"]);
});

test("herdr.space is a visual relabel: only a bot pane already in its project's space, never a parked one", () => {
  const s = base({ terminals: [T("t1", A, { bot: MAIN_A, role: "main" }), T("t9", B, { bot: MAIN_B, role: "main" })] });
  s.spaces[0].name = "a";
  s.spaces.push({ ...space("sb", B, []), name: "b" }); // b's only space is empty: kept, as b has a live bot
  assert.deepEqual(planOf(s).map(brief), ["relabel(visual) t1 herdr.space=sa"]);
});

test("a space holding bots of two projects, on neither's folder, is reported, never recreated", () => {
  const s = base({ terminals: [T("t1", A, { bot: MAIN_A, role: "main" }), T("t2", B, { bot: MAIN_B, role: "main" })],
    spaces: [space("sx", "/r/x", ["t1", "t2"])], folders: { ...base().folders, "/r/x": { exists: true, key: "/r/x", top: "/r/x" } } });
  const acts = planOf(s);
  assert.ok(acts.some((a) => a.report === "foreign" && a.space === "sx"));
  assert.ok(!acts.some((a) => a.kind === "recreate-space"));
});

test("a plain folder's space (no bots, outside git) is left alone, even under a bots project", () => {
  const s = base({ terminals: [...base().terminals, T("t5", "/r/a/notes", {}, { program: { key: "zsh", agent: false } })],
    spaces: [{ ...space("sa", A, ["t1"]), name: "a" }, space("notes", "/r/a/notes", ["t5"])],
    folders: { ...base().folders, "/r/a/notes": { exists: true, key: A, top: null } } });
  assert.deepEqual(planOf(s), []);
});

test("relabel: role and category follow bots.json; a stale one comes off; other machines' panes are left alone", () => {
  const file = { version: 1, categories: [{ id: "eng", title: "Eng" }], bots: [
    { id: MAIN_A, kind: "main", name: "m", role: "r", agent: "claude", look },
    { id: "b-cccccccccc", kind: "member", name: "c", role: "r", agent: "codex", look, category: "eng" },
  ] };
  const s = base({
    terminals: [T("t1", A, { bot: MAIN_A, role: "main", category: "eng", "herdr.space": "sa" }), T("t2", A, { bot: "b-cccccccccc", role: "dev" }),
      T("machine-1/t3", A, { bot: "b-cccccccccc" })],
    projects: [{ key: A, machine: null, file }],
  });
  s.spaces[0].name = "a";
  assert.deepEqual(planOf(s).filter((a) => a.kind === "relabel").map(brief), ["relabel t1 category=", "relabel t2 role= category=eng"]);
});

test("cross-machine: a pane in another machine's space, or a local pane playing only another machine's bot, is reported", () => {
  const remote = { key: "/r/z", machine: "machine-1", file: bots(["b-zzzzzzzzzz", "main"]) };
  const s = base({ terminals: [...base().terminals, T("machine-1/t4", "/r/z", { bot: MAIN_A }), T("t5", A, { bot: "b-zzzzzzzzzz" })],
    spaces: [{ ...space("sa", A, ["t1"]), name: "a" }, space("machine-2/s1", "/r/z", ["machine-1/t4"], "machine-2")],
    projects: [...base().projects, remote] });
  const reports = planOf(s).filter((a) => a.report === "cross-machine").map((a) => a.terminal);
  // machine-1/t4 twice: shown in machine-2's space, and playing a bot of this computer's project.
  assert.deepEqual(reports, ["machine-1/t4", "machine-1/t4", "t5"]);
});

test("a remote bot pane whose machine's projects this State doesn't hold is not called cross-machine", () => {
  const s = base({ terminals: [...base().terminals, T("machine-1/t4", A, { bot: MAIN_A })] });
  s.spaces[0].name = "a";
  assert.deepEqual(planOf(s).filter((a) => a.report === "cross-machine"), []);
});

test("a bot id two projects define: the pane's folder picks the project; still unsure, reported and never relabelled", () => {
  const X = "b-xxxxxxxxxx";
  const both = (cwdB) => base({
    terminals: [T("t1", A, { bot: X, role: "main" }), T("t2", cwdB, { bot: X, role: "dev" })],
    spaces: [],
    projects: [{ key: A, machine: null, file: bots([X, "main"]) }, { key: B, machine: null, file: bots([MAIN_B, "main"], [X, "member", { rank: "dev" }]) }],
    folders: { ...base().folders, "/r/elsewhere": { exists: true, key: "/r/elsewhere", top: "/r/elsewhere" } },
  });
  assert.deepEqual(planOf(both(B)).filter((a) => a.kind === "relabel" || a.kind === "report").map(brief), [], "each pane keeps its own project's role");
  const unsure = planOf(both("/r/elsewhere"));
  assert.deepEqual(unsure.filter((a) => a.kind === "relabel").map(brief), []);
  assert.ok(unsure.some((a) => a.report === "foreign" && a.terminal === "t2" && /both define/.test(a.note)));
});

test("another machine's space on the wrong folder is reported, never recreated", () => {
  const remote = { key: "/r/z", machine: "machine-1", file: bots(["b-zzzzzzzzzz", "main"]) };
  const s = base({ terminals: [...base().terminals, T("machine-1/t4", "/r/z/sub", { bot: "b-zzzzzzzzzz" })],
    spaces: [{ ...space("sa", A, ["t1"]), name: "a" }, space("machine-1/s1", "/r/z/sub", ["machine-1/t4"], "machine-1")], projects: [...base().projects, remote] });
  const acts = planOf(s);
  assert.ok(!acts.some((a) => a.kind === "recreate-space"));
  assert.ok(acts.some((a) => a.report === "foreign" && a.space === "machine-1/s1" && /another machine's spaces/.test(a.note)));
});

test("a space on the home folder holding a bot: recreated, and never called gone", () => {
  const s = base({ spaces: [space("sh", "~", ["t1"])] });
  const [a] = planOf(s);
  assert.deepEqual([a.kind, a.to], ["recreate-space", A]);
  assert.match(a.why, /on the home folder, not on a project/);
  assert.doesNotMatch(a.why, /gone/);
});

test("a symlinked space folder (readState's `real`) is its project's top level, not recreated", () => {
  const s = base({ spaces: [{ ...space("sa", "/link/a", ["t1"]), name: "a" }], folders: { ...base().folders, "/link/a": { exists: true, key: A, top: A, real: A } } });
  assert.deepEqual(planOf(s), []);
});

test("needs-owner: reported once its terminal has been waiting over a day, not before", () => {
  const waiting = (ms) => base({ terminals: [T("t1", A, { bot: MAIN_A, role: "main", "herdr.space": "sa", "automagik-herdr.needs-owner": "ship?" }, { status_ms: ms })] });
  const stale = (s) => { s.spaces[0].name = "a"; return planOf(s).filter((a) => a.report === "stale-needs-owner").length; };
  assert.equal(stale(waiting(NOW - 25 * 3600_000)), 1);
  assert.equal(stale(waiting(NOW - 3600_000)), 0);
});

test("folderFacts guesses only for folders it was told nothing about; displayName falls back to the folder", () => {
  assert.deepEqual(folderFacts({}, "/r/a.worktrees/x"), { exists: true, key: "/r/a", top: "/r/a.worktrees/x", real: null, recorded: false });
  assert.equal(folderFacts({ folders: { "/g": { exists: false, key: null, top: null } } }, "/g").exists, false);
  assert.equal(folderFacts({ folders: { "/g": { exists: false } } }, "/g", "machine-1").exists, true, "another machine's: unknown");
  assert.equal(displayName({ key: "/r/alpha", raw: { name: "  " } }), "alpha");
});

test("planText groups the plan: non-visual, visual, reports", () => {
  const text = planText(planOf(drift()));
  const at = (s) => text.indexOf(s);
  assert.ok(at("Non-visual") === 0 && at("Non-visual") < at("Visual (") && at("Visual (") < at("Reports"));
  assert.match(text, /prune {5}~\/workspace\/repos\/project-orchestrator/);
  assert.match(text, /recreate {2}sp05work on ~\/workspace\/repos\/project-plain as "Plain"/);
});

test("spacesOf turns herdr-app ls into State spaces", () => {
  assert.deepEqual(spacesOf({ spaces: [{ id: "s1", name: "a", folder: "/r/a", machine: null, active: true,
    tabs: [{ id: "tb", name: "t", active: false, terminals: [{ terminal: "t1", pane: "p1", app: "codex" }] }] }] }), [
    { id: "s1", name: "a", machine: null, folder: "/r/a", selected: true, tabs: [{ id: "tb", name: "t", selected: false, panes: [{ pane: "p1", terminal: "t1" }], paneCount: null }] },
  ]);
  // Herdr's ls has no pane count today: paneCount is null (unknown), never the terminals' number.
  // When a tab says how many panes it holds (a mod pane too), that count is kept.
  const [mod] = spacesOf({ spaces: [{ id: "s2", tabs: [{ id: "tb2", panes: 2, terminals: [{ terminal: "t-sh", pane: "p2" }] }] }] });
  assert.deepEqual([mod.tabs[0].panes.map((p) => p.terminal), mod.tabs[0].paneCount], [["t-sh"], 2]);
});

// ---- the CLI, against fakes ----

const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const ID = { main: "b-mmmmmmmmmm", cap: "b-cccccccccc", dev: "b-dddddddddd", beta: "b-bbbbbbbbbb" };

/**
 * Two git projects (alpha with a worktree, beta), a folder that is gone in the project list,
 * a fake hc whose captain pane carries a stale role, and a fake herdr-app whose one space
 * is beta's bots on alpha's folder.
 */
function scene(t) {
  const root = scratchRoot(t, "hb-tidy-");
  const repo = (name, file) => {
    const dir = scratchProject(root, name, { bots: file });
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "start");
    return dir;
  };
  const alpha = repo("alpha", { version: 1, categories: [], bots: [
    { id: ID.main, kind: "main", name: "Main", role: "r", instructions: "", agent: "claude", look },
    { id: ID.cap, kind: "member", name: "Cap", role: "r", instructions: "", agent: "codex", look },
    { id: ID.dev, kind: "member", name: "Dev", role: "r", rank: "dev", lead: ID.cap, instructions: "", agent: "codex", look },
  ] });
  const beta = repo("beta", bots([ID.beta, "main"]));
  const worktree = join(root, "alpha.worktrees", "branch-1");
  git(alpha, "worktree", "add", "-q", worktree);
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  const appLog = join(root, "herdr-app.log"), appLs = join(root, "herdr-app.json");
  exe(join(bin, "herdr-app"), `#!/bin/sh\necho "$*" >> "${appLog}"\n[ "$1" = ls ] && exec cat "${appLs}"\nexit 3\n`);
  writeFileSync(appLog, "");
  writeFileSync(appLs, JSON.stringify({ spaces: [
    { id: "s1", name: "Beta", folder: alpha, machine: null, active: true, tabs: [{ id: "tb1", name: "t", active: true, terminals: [{ terminal: "t2", pane: "p2" }] }] },
    { id: "s2", name: "alpha", folder: alpha, machine: null, active: false, tabs: [{ id: "tb2", name: "t", active: true, terminals: [{ terminal: "t1", pane: "p1" }, { terminal: "t3", pane: "p3" }] }] },
  ], recent: [] }));
  const term = (address, cwd, labels, parent = null) => ({ address, name: address, cwd, state: "live", parent, created_ms: 1, labels,
    foreground: { argv: ["codex"], cwd }, status: { app: "codex", state: "idle" } });
  const hcState = join(root, "hc.json"), hcLog = join(root, "hc.log");
  writeFileSync(hcState, JSON.stringify({ next: 100, terminals: [
    term("t1", alpha, { bot: ID.main, role: "main", "herdr.space": "s2" }),
    term("t2", beta, { bot: ID.beta, role: "main", "herdr.space": "s1" }),
    term("t3", alpha, { bot: ID.cap, role: "dev", "herdr.space": "s2" }, "t1"),
    term("t4", worktree, {}, "t9"),
  ] }));
  writeFileSync(hcLog, "");
  const home = join(root, "home"), app = join(root, "app");
  mkdirSync(home);
  mkdirSync(app);
  const list = join(app, "am-sidebar-projects.json");
  writeFileSync(list, `${JSON.stringify([alpha, join(root, "gone"), beta], null, 2)}\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: hcState, HC_FAKE_LOG: hcLog, GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  const cli = (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: alpha, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const read = (p) => readFileSync(p, "utf8");
  const hcCalls = () => readJsonLines(hcLog);
  const appCalls = () => readLines(appLog);
  const snapshot = () => [read(list), read(hcState), read(join(alpha, ".herdr/bots.json")), read(join(beta, ".herdr/bots.json"))];
  return { root, alpha, beta, worktree, app, list, cli, hcCalls, appCalls, snapshot, hcState, env };
}

test("tidy and tidy --json print the plan and change no file, label or window", (t) => {
  const s = scene(t);
  const before = s.snapshot();
  const text = s.cli(["tidy"]);
  assert.equal(text.code, 0, text.err);
  const json = s.cli(["tidy", "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(s.snapshot(), before, "no file, and no label in hc's state");
  assert.deepEqual(s.hcCalls().map((c) => c[0]).filter((c) => !["ls", "get"].includes(c)), [], "only hc ls and hc get");
  assert.deepEqual(s.appCalls(), ["ls", "ls"], "only herdr-app ls");
  const acts = JSON.parse(json.out);
  assert.deepEqual(acts.map(brief), [
    `prune-registry ${join(s.root, "gone")}`,
    "relabel t3 role=captain",
    `recreate-space s1 ${s.alpha} -> ${s.beta} "beta"`,
    "report orphan-helper t4",
  ]);
  assert.match(text.out, /^Non-visual .*\n {2}prune {5}\S+\/gone: /);
  assert.match(text.out, /Visual .*\n {2}recreate {2}s1 on \S+\/beta as "beta"/);
});

test("tidy needs the window: herdr-app failing, a clear error and nothing changed", (t) => {
  const s = scene(t);
  // A failing fake, never a missing one: the host's own herdr-app may be next on PATH.
  exe(join(s.root, "bin", "herdr-app"), "#!/bin/sh\necho 'no window' >&2\nexit 1\n");
  const before = s.snapshot();
  const r = s.cli(["tidy"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Can't plan: herdr-app ls failed: no window/);
  assert.deepEqual(s.snapshot(), before);
});

test("readState names a program that isn't there; with no hc the window-free read goes on with no terminals", async () => {
  const run = async () => ({ code: 127, stdout: "", stderr: "spawn hc ENOENT" });
  await assert.rejects(readState({ run, home: "/h", appHome: "/nowhere" }), /hc is not on PATH/);
  const state = await readState({ run, home: "/h", appHome: "/nowhere" }, { window: false });
  assert.deepEqual([state.terminals, state.spaces], [[], []]);
});

test("readState: only a folder found missing under a parent that is there counts as gone", async (t) => {
  const root = realpathSync(mkdtempSync(join(assertSafeTmpdir(), "hb-gone-")));
  const locked = join(root, "locked");
  mkdirSync(join(locked, "proj"), { recursive: true });
  chmodSync(locked, 0o000);
  t.after(() => { chmodSync(locked, 0o755); rmSync(root, { recursive: true, force: true }); });
  const app = join(root, "app");
  mkdirSync(app);
  const gone = join(root, "gone"), unmounted = join(root, "volume", "proj"), unreadable = join(locked, "proj");
  writeFileSync(join(app, "am-sidebar-projects.json"), JSON.stringify([gone, unmounted, unreadable]));
  const run = async (cmd, args) => (cmd === "hc" ? { code: 0, stdout: JSON.stringify({ terminals: [] }), stderr: "" } : runProgram(cmd, args));
  const state = await readState({ run, home: "/h", appHome: app }, { window: false });
  assert.deepEqual(Object.keys(state.folders), [gone], "the unreadable and the unmounted ones are left out");
  assert.deepEqual(planOf(state).map(brief), [`prune-registry ${gone}`]);
});

test("create runs the non-visual fixes only: the registry pruned, a role set; never the window; twice changes nothing more", (t) => {
  const s = scene(t);
  const first = s.cli(["create", "--name", "Helper", "--agent", "codex", "--json"]);
  assert.equal(first.code, 0, first.err);
  // One line per entry taken off (#229); stdout is still the command's own JSON.
  assert.equal(first.err, `am: tidy: ${join(s.root, "gone")} taken off the project list: its folder is gone.\n`);
  JSON.parse(first.out);
  assert.deepEqual(JSON.parse(readFileSync(s.list, "utf8")), [s.beta, s.alpha], "the gone folder is off the list (alpha listed again, last)");
  assert.deepEqual(s.hcCalls().filter((c) => c[0] === "label"), [["label", "t3", "role=captain"]]);
  assert.deepEqual(s.appCalls(), [], "start, attach and create never ask the window");
  const labels = JSON.parse(readFileSync(s.hcState, "utf8")).terminals.find((x) => x.address === "t2").labels;
  assert.equal(labels["herdr.space"], "s1", "no herdr.space relabel: that one is visual");

  const listed = readFileSync(s.list, "utf8");
  const calls = s.hcCalls().length;
  const second = s.cli(["create", "--name", "Helper Two", "--agent", "codex"]);
  assert.equal(second.code, 0, second.err);
  assert.equal(readFileSync(s.list, "utf8"), listed);
  assert.deepEqual(s.hcCalls().slice(calls).filter((c) => c[0] === "label"), []);
});

test("a fix that fails is a warning, never a failed command", (t) => {
  const s = scene(t);
  const state = JSON.parse(readFileSync(s.hcState, "utf8"));
  writeFileSync(s.hcState, JSON.stringify({ ...state, failLabel: "t3" }));
  const r = s.cli(["create", "--name", "Helper", "--agent", "codex"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /tidy: t3's labels role=captain weren't set/);
  writeFileSync(s.hcState, JSON.stringify({ ...state, fail: ["ls"] }));
  const down = s.cli(["create", "--name", "Helper Two", "--agent", "codex"]);
  assert.equal(down.code, 0, down.err);
  assert.match(down.err, /tidy: hc ls --json failed/);
});

test("readState: one hc ls, an hc get per local terminal, and what git says of each folder", async (t) => {
  const s = scene(t);
  const prev = { ...process.env };
  t.after(() => {
    for (const k of ["PATH", "HC_FAKE_STATE", "HC_FAKE_LOG", "GIT_CEILING_DIRECTORIES"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
  Object.assign(process.env, { PATH: s.env.PATH, HC_FAKE_STATE: s.env.HC_FAKE_STATE, HC_FAKE_LOG: s.env.HC_FAKE_LOG, GIT_CEILING_DIRECTORIES: s.root });
  const state = await readState({ run: runProgram, home: join(s.root, "home"), appHome: s.app });
  assert.deepEqual(s.hcCalls().map((c) => c.join(" ")).sort(),
    ["get t1 --json", "get t2 --json", "get t3 --json", "get t4 --json", "ls --json"]);
  assert.deepEqual(state.spaces.map((x) => x.id), ["s1", "s2"]);
  assert.deepEqual(state.registry, [s.alpha, join(s.root, "gone"), s.beta]);
  assert.deepEqual(state.folders[s.alpha], { exists: true, key: s.alpha, top: s.alpha });
  assert.deepEqual(state.folders[s.worktree], { exists: true, key: s.alpha, top: s.worktree });
  assert.deepEqual(state.folders[join(s.root, "gone")], { exists: false, key: null, top: null });
  assert.deepEqual(state.projects.map((p) => p.key), [s.alpha, s.beta]);
  assert.deepEqual(state.terminals.find((x) => x.address === "t3").labels, { bot: ID.cap, role: "dev", "herdr.space": "s2" });
  assert.equal(state.terminals.find((x) => x.address === "t4").parent, "t9");
});

test("create with no hc on PATH warns once, about its own panes, and nothing from tidy", (t) => {
  const root = scratchRoot(t, "hb-nohc-");
  const bin = join(root, "bin"), app = join(root, "app");
  for (const d of [bin, app]) mkdirSync(d);
  const project = scratchProject(root, "p");
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const r = spawnSync(process.execPath, [CLI, "create", "--name", "Solo", "--agent", "claude"],
    { cwd: project, env: { HOME: root, PATH: bin, HERDR_APP_HOME: app, GIT_CEILING_DIRECTORIES: root }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /tidy/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
});
