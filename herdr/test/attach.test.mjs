// The attach ledger (attach.js, and the CLI that alone writes it): the fold over plain rows,
// then automagik-herdr as a program against scratch git projects, a scratch HERDR_APP_HOME
// and the fake hc (test/fake-hc.mjs) and a fake herdr-app with no window (test/fake-herdr-app.mjs)
// first on PATH. The real hc, window and app home are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressOf, heldIn, attachKey, attachRow, confirmBindings, foldAttach, machinesById, modeProblem, readAttach, verdictOf } from "../mods/am-sidebar/attach.js";
import { readAttachFile } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc" };
const CORE = "fakecore0000";

// ---- the fold over plain rows ----

const row = (event, bot, terminal, extra = {}) => attachRow({ event, bot, project: "/p", terminal, core: CORE, created_ms: 1, by: "attach", ...extra });
const bound = (rows) => Object.fromEntries([...foldAttach(rows).byBot].map(([b, r]) => [b, r.terminal]));

test("fold: attach binds, detach of the same bot unbinds, end unbinds whatever bot; keyed by core, terminal, created_ms", () => {
  assert.deepEqual(bound([row("attach", ID.main, "t1")]), { [ID.main]: "t1" });
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("detach", ID.main, "t1")]), {});
  // A detach naming another bot is ignored.
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("detach", ID.cap, "t1")]), { [ID.main]: "t1" });
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("end", ID.cap, "t1", { by: "sweep", reason: "finished" })]), {});
  // An end of the same terminal id with another created_ms (another terminal) ends nothing.
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("end", ID.main, "t1", { created_ms: 2, by: "sweep" })]), { [ID.main]: "t1" });
  // A later attach ends the bot's earlier binding and the terminal's earlier one.
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("attach", ID.main, "t2")]), { [ID.main]: "t2" });
  assert.deepEqual(bound([row("attach", ID.main, "t1"), row("attach", ID.cap, "t1")]), { [ID.cap]: "t1" });
  assert.equal(attachKey(row("attach", ID.main, "t1")), `${CORE}\nt1\n1`);
});

test("fold: a torn line, a foreign row and a row without created_ms are skipped and counted", () => {
  const good = row("attach", ID.main, "t1");
  const text = [JSON.stringify(good), "{\"v\":1,\"event\":\"att", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, created_ms: undefined }),
    JSON.stringify({ ...good, event: "move" }), ""].join("\n");
  const { rows, skipped } = readAttach(text);
  assert.deepEqual(rows, [good]);
  assert.equal(skipped, 4);
});

test("rows carry the contract's fields in order; reason only when given", () => {
  const r = attachRow({ event: "detach", bot: ID.main, project: "/p", terminal: "t1", core: CORE, created_ms: 5, by: "attach", reason: "moved", at: 0 });
  assert.deepEqual(Object.keys(r), ["v", "event", "bot", "project", "terminal", "core", "created_ms", "machine", "at", "by", "reason"]);
  assert.deepEqual([r.v, r.machine, r.at], [1, null, "1970-01-01T00:00:00.000Z"]);
  assert.equal("reason" in row("attach", ID.main, "t1"), false);
});

test("verdict: live only when hc says live with the same created_ms; finished and reused ids read as ended", async () => {
  const b = row("attach", ID.main, "t1");
  assert.equal(verdictOf(b, { state: "live", created_ms: 1 }), "live");
  assert.equal(verdictOf(b, { state: "finished", created_ms: 1 }), "finished");
  assert.equal(verdictOf(b, null), "finished");
  assert.equal(verdictOf(b, { state: "live", created_ms: 2 }), "replaced");
  const gone = Symbol("unanswered");
  const answers = { t1: { state: "live", created_ms: 1 }, t2: { state: "live", created_ms: 9 }, t3: gone };
  const ask = async ([, t]) => answers[t] ?? null;
  const out = await confirmBindings([b, row("attach", ID.cap, "t2"), row("attach", ID.dev, "t3"), row("attach", "b-dddddddddd", "t4", { core: "other" })],
    CORE, ask, gone);
  assert.deepEqual(out.live.map((l) => l.binding.terminal), ["t1"]);
  assert.deepEqual(out.ended.map((e) => [e.binding.terminal, e.reason]).sort(), [["t2", "replaced"], ["t4", "finished"]]);
  assert.deepEqual(out.unknown.map((u) => u.terminal), ["t3"]);
});

test("mode: group- or world-writable is a problem, naming the fix; 0600 and 0644 are not", () => {
  assert.equal(modeProblem("/a", 0o100600), null);
  assert.equal(modeProblem("/a", 0o100644), null);
  assert.match(modeProblem("/a", 0o100664), /\/a is group- or world-writable \(mode 664\).*chmod 600 \/a/);
  assert.match(modeProblem("/a", 0o100602), /mode 602/);
});

// ---- the CLI, the ledger's only writer ----

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const TEAM = { version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" }), bot(ID.cap, "member", { name: "Captain" }), bot(ID.dev, "member", { name: "Dev" })] };
const term = (address, { bot: b, cwd, created = 1, state = "live" } = {}) => ({ address, name: address, cwd, state, parent: null, created_ms: created,
  labels: b ? { bot: b } : {}, foreground: { argv: ["claude"], cwd }, status: { app: "claude-code", state: "idle" } });

function scene(t, terminals = () => []) {
  const root = scratchRoot(t, "hb-attach-");
  const project = scratchProject(root, "proj", { commit: true, bots: TEAM });
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  writeFileSync(join(root, "herdr-app.json"), JSON.stringify({ down: true }));
  writeFileSync(join(root, "herdr-app.log"), "");
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const statePath = join(root, "hc.json");
  const logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals: terminals(project), next: 100 }));
  writeFileSync(logPath, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: join(root, "herdr-app.json"), HERDR_APP_FAKE_LOG: join(root, "herdr-app.log"), GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const ledgerPath = join(app, "automagik-herdr/attach.jsonl");
  const ledger = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (fn) => { const st = hcState(); fn(st); writeFileSync(statePath, JSON.stringify(st)); };
  const whois = (t) => cli("whois", t, "--json").json();
  return { root, project, app, cli, ledger, ledgerPath, hcState, edit, whois };
}
const brief = (rows) => rows.map((r) => [r.event, r.bot, r.terminal, r.by, r.reason ?? null]);

// -- negative --

test("NEGATIVE: a relabel changes nothing: hc label moves no bot, in whois, ls or start", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  const before = s.ledger();
  // Someone relabels: the label goes to t2, off t1.
  s.edit((st) => { st.terminals[0].labels = {}; st.terminals[1].labels = { bot: ID.main }; });
  assert.equal(s.whois("t1").bot, ID.main);
  assert.equal(s.whois("t2").bot, null);
  assert.equal(s.cli("whois", "--bot", ID.main, "--json").json().terminal, "t1");
  const genie = s.cli("ls", "--json").json().projects[0].bots.find((b) => b.id === ID.main);
  assert.equal(genie.terminal, "t1");
  assert.match(s.cli("start", "Genie").out, /already running in t1/);
  assert.deepEqual(s.ledger(), before, "no row written by any of it");
});

test("NEGATIVE: a duplicate bot is refused, naming its terminal; so is a duplicate terminal, naming its bot", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  const dupBot = s.cli("attach", "Genie", "t2");
  assert.notEqual(dupBot.code, 0);
  assert.match(dupBot.err, /Genie \(b-aaaaaaaaaa\) is attached to t1 \(since .*\); nothing was attached/);
  const dupTerminal = s.cli("attach", "Captain", "t1");
  assert.notEqual(dupTerminal.code, 0);
  assert.match(dupTerminal.err, /t1 already plays Genie \(b-aaaaaaaaaa\), since .*; nothing was attached/);
  assert.deepEqual(brief(s.ledger()), [["attach", ID.main, "t1", "attach", null]]);
  // --move doesn't take another bot's terminal either.
  assert.notEqual(s.cli("attach", "Captain", "t1", "--move").code, 0);
});

test("NEGATIVE: two CLIs attaching one bot at once: one wins, the other is refused", async (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  s.cli("ls"); // the one-time import, first, so both runs read the same file
  const { execFile } = await import("node:child_process");
  const env = { ...process.env, PATH: `${join(s.root, "bin")}:${process.env.PATH}`, HOME: join(s.root, "home"), HERDR_APP_HOME: s.app,
    HC_FAKE_STATE: join(s.root, "hc.json"), HC_FAKE_LOG: join(s.root, "hc.log"),
    HERDR_APP_FAKE_STATE: join(s.root, "herdr-app.json"), HERDR_APP_FAKE_LOG: join(s.root, "herdr-app.log") };
  delete env.HC_TERMINAL_ID;
  const go = (terminal) => new Promise((done) => execFile(process.execPath, [CLI, "attach", "Genie", terminal], { cwd: s.project, env },
    (e) => done(e ? e.code : 0)));
  const codes = await Promise.all([go("t1"), go("t2")]);
  assert.deepEqual(codes.sort(), [0, 1]);
  assert.equal(s.ledger().filter((r) => r.event === "attach").length, 1);
});

test("NEGATIVE: a finished terminal reads as unattached at once, and the next run writes its end row", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  s.edit((st) => { st.terminals[0].state = "finished"; });
  // The reader treats it as ended; whois (a CLI run that read the ledger) appended the end row.
  assert.deepEqual(s.cli("whois", "--bot", ID.main, "--json").json(), { terminal: null, core: CORE, created_ms: null, bot: ID.main, project: null, since: null });
  assert.deepEqual(brief(s.ledger()), [["attach", ID.main, "t1", "attach", null], ["end", ID.main, "t1", "sweep", "finished"]]);
  // A terminal hc no longer knows at all reads the same, and Genie attaches anew with no --move.
  assert.equal(s.cli("attach", "Genie", "t2").code, 0);
  s.edit((st) => { st.terminals.splice(1, 1); });
  assert.equal(s.cli("whois", "--bot", ID.main, "--json").json().terminal, null);
  assert.deepEqual(s.ledger().at(-1) && brief([s.ledger().at(-1)]), [["end", ID.main, "t2", "sweep", "finished"]]);
});

test("NEGATIVE: a terminal id reused with a new created_ms reads as unattached (end row: replaced)", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p, created: 1000 })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  assert.equal(s.ledger()[0].created_ms, 1000);
  // hc restarted and handed out t1 again: same address, another terminal.
  s.edit((st) => { st.terminals[0].created_ms = 2000; });
  assert.deepEqual(s.whois("t1"), { terminal: "t1", core: CORE, created_ms: 2000, bot: null });
  assert.deepEqual(brief([s.ledger().at(-1)]), [["end", ID.main, "t1", "sweep", "replaced"]]);
  assert.equal(s.ledger().at(-1).created_ms, 1000, "the end row names the old terminal");
  // So is a row of another core (hc's state wiped): its terminals are gone.
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  s.edit((st) => { st.core = { id: "newcore", name: "fake" }; });
  assert.equal(s.whois("t1").bot, null);
});

test("NEGATIVE: a failed hc get is not a missing pane: whois refuses, the binding stays and no end row is written", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  const before = s.ledger();
  const refused = (args, why) => {
    const r = s.cli(...args);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
    assert.match(r.err, why, args.join(" "));
    assert.equal(/plays no bot|attached to no terminal/.test(r.out), false, `${args.join(" ")} never reads as no pane`);
    assert.deepEqual(s.ledger(), before, `${args.join(" ")} wrote no end row`);
  };
  // hc get exits 5 with an error of another kind than not_found: for the bound t1 (the ledger's
  // own check) and for the unbound t2 (whois' lookup).
  s.edit((st) => { st.failGet = ["t1"]; st.failGetExit = 5; });
  refused(["whois", "--bot", ID.main], /hc get t1 failed: .*"kind":"internal".*server error reading t1/);
  refused(["whois", "t1"], /hc get t1 failed: .*server error reading t1/);
  s.edit((st) => { st.failGet = ["t2"]; });
  refused(["whois", "t2", "--json"], /hc get t2 failed: .*server error reading t2/);
  // hc get exits 0 with an answer that isn't JSON: a failure too.
  s.edit((st) => { st.failGet = []; st.badGet = ["t1"]; });
  refused(["whois", "--bot", ID.main, "--json"], /hc get t1 printed no JSON/);
  s.edit((st) => { st.badGet = ["t2"]; });
  refused(["whois", "t2"], /hc get t2 printed no JSON/);
  // hc answers again: the binding was never ended.
  s.edit((st) => { st.badGet = []; });
  assert.equal(s.whois("t1").bot, ID.main);
  assert.equal(s.whois("t2").bot, null);
});

test("NEGATIVE: a group- or world-writable ledger is refused on read, with a clear message, by every reader", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  for (const mode of [0o664, 0o646]) {
    chmodSync(s.ledgerPath, mode);
    for (const args of [["whois", "t1"], ["whois", "--bot", ID.main], ["ls"], ["show", "Genie"], ["start", "Dev"], ["attach", "Dev", "t1"], ["detach", "Genie"]]) {
      const r = s.cli(...args);
      assert.notEqual(r.code, 0, `${args.join(" ")} at ${mode.toString(8)}`);
      assert.match(r.err, /attach\.jsonl is group- or world-writable \(mode 6\d\d\).*chmod 600/, args.join(" "));
    }
  }
  chmodSync(s.ledgerPath, 0o600);
  assert.equal(s.whois("t1").bot, ID.main);
});

test("NEGATIVE: readAttachFile refuses a symlink and a FIFO without hanging (#839)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hb-attach-safe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "target.jsonl");
  writeFileSync(target, `${JSON.stringify(row("attach", ID.main, "t1"))}\n`);
  chmodSync(target, 0o600);
  const path = join(dir, "attach.jsonl");
  symlinkSync(target, path);
  assert.throws(() => readAttachFile(path), /Can't read .*attach\.jsonl/);

  unlinkSync(path);
  assert.equal(spawnSync("mkfifo", [path]).status, 0);
  chmodSync(path, 0o600);
  assert.throws(() => readAttachFile(path), /Can't read .*attach\.jsonl: not a regular file/);
});

// -- positive --

test("whois: both forms, attached and not, with created_ms from hc get", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p, created: 77 }), term("t2", { cwd: p, created: 88 })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  const since = s.ledger()[0].at;
  const attached = { terminal: "t1", core: CORE, created_ms: 77, bot: ID.main, project: s.project, since };
  assert.deepEqual(s.whois("t1"), attached);
  assert.deepEqual(s.cli("whois", "--bot", ID.main, "--json").json(), attached);
  assert.deepEqual(s.cli("whois", "--bot", "Genie", "--json").json(), attached, "a name resolves in the project");
  assert.deepEqual(s.whois("t2"), { terminal: "t2", core: CORE, created_ms: 88, bot: null });
  assert.deepEqual(s.whois("t9"), { terminal: "t9", core: CORE, created_ms: null, bot: null });
  assert.deepEqual(s.cli("whois", "--bot", ID.cap, "--json").json(), { terminal: null, core: CORE, created_ms: null, bot: ID.cap, project: null, since: null });
  assert.match(s.cli("whois", "t1").out, /t1 plays b-aaaaaaaaaa/);
  assert.equal(s.cli("whois").code, 2);
  assert.equal(s.cli("whois", "t1", "--bot", ID.main).code, 2);
  assert.notEqual(s.cli("whois", "vps/t1").code, 0);
});

test("attach --move: the detach (moved) of the old terminal, then the attach, in one run, in that order", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p, created: 10 }), term("t2", { cwd: p, created: 20 })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  const r = s.cli("attach", "Genie", "t2", "--move", "--json");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().movedFrom, ["t1"]);
  const rows = s.ledger();
  assert.deepEqual(brief(rows), [["attach", ID.main, "t1", "attach", null], ["detach", ID.main, "t1", "attach", "moved"], ["attach", ID.main, "t2", "attach", null]]);
  assert.equal(rows[1].created_ms, 10);
  assert.equal(rows[2].created_ms, 20);
  assert.equal(s.whois("t2").bot, ID.main);
  assert.equal(s.whois("t1").bot, null);
  // The labels followed, as a hint.
  const labels = Object.fromEntries(s.hcState().terminals.map((x) => [x.address, x.labels.bot ?? null]));
  assert.deepEqual(labels, { t1: null, t2: ID.main });
  // Attaching it again where it is writes nothing.
  assert.match(s.cli("attach", "Genie", "t2").out, /already t2/);
  assert.equal(s.ledger().length, 3);
});

test("start, attach and detach rows: by start, attach and detach, each with core, created_ms and project; the file is 0600", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p, created: 5 })]);
  const started = s.cli("start", "Genie");
  assert.equal(started.code, 0, started.err);
  assert.equal(s.cli("attach", "Captain", "t1").code, 0);
  assert.equal(s.cli("detach", "Captain").code, 0);
  const rows = s.ledger();
  assert.deepEqual(brief(rows), [["attach", ID.main, "t100", "start", null], ["attach", ID.cap, "t1", "attach", null], ["detach", ID.cap, "t1", "detach", null]]);
  const t100 = s.hcState().terminals.find((x) => x.address === "t100");
  assert.equal(rows[0].created_ms, t100.created_ms);
  for (const r of rows) {
    assert.equal(r.v, 1);
    assert.equal(r.core, CORE);
    assert.equal(r.project, s.project);
    assert.equal(r.machine, null);
    assert.ok(!Number.isNaN(Date.parse(r.at)));
  }
  assert.equal(rows[1].created_ms, 5);
  assert.equal(statSync(s.ledgerPath).mode & 0o777, 0o600);
  assert.match(s.cli("detach", "Captain").out, /no pane on this computer/);
  assert.equal(s.ledger().length, 3, "a second detach writes nothing");
});

test("detach: the row is the authority; an hc failure clearing labels afterwards only warns", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  s.edit((st) => { st.fail = ["ls"]; });
  const r = s.cli("detach", "Genie");
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Genie is detached from t1, but its labels weren't cleared/);
  assert.deepEqual(brief([s.ledger().at(-1)]), [["detach", ID.main, "t1", "detach", null]]);
});

test("the end row on a sweep: ls notices the finished terminal, appends one end row, and only once", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p }), term("t2", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  assert.equal(s.cli("attach", "Captain", "t2").code, 0);
  s.edit((st) => { st.terminals[1].state = "finished"; });
  const bots = s.cli("ls", "--json").json().projects[0].bots;
  assert.equal(bots.find((b) => b.id === ID.cap).terminal, null);
  assert.equal(bots.find((b) => b.id === ID.main).terminal, "t1");
  s.cli("ls");
  assert.deepEqual(brief(s.ledger()).slice(2), [["end", ID.cap, "t2", "sweep", "finished"]]);
});

test("the one-time import: live bot= labels become attach rows by import, once; later labels are hints only", (t) => {
  const s = scene(t, (p) => [term("t1", { bot: ID.main, cwd: p }), term("t2", { bot: "b-zzzzzzzzzz", cwd: p }), term("t3", { cwd: p })]);
  assert.equal(existsSync(s.ledgerPath), false);
  assert.equal(s.whois("t1").bot, ID.main);
  assert.deepEqual(brief(s.ledger()), [["attach", ID.main, "t1", "import", null]], "a label naming no bot defined here is left out");
  assert.equal(statSync(s.ledgerPath).mode & 0o777, 0o600);
  // A label set after the import is a hint: nothing imports it.
  s.edit((st) => { st.terminals[2].labels = { bot: ID.cap }; });
  assert.equal(s.whois("t3").bot, null);
  assert.equal(s.ledger().length, 1);
  // Even an empty import leaves a file, so it happens once.
  const empty = scene(t);
  empty.cli("ls");
  assert.equal(readFileSync(empty.ledgerPath, "utf8"), "");
});

test("a torn line in the ledger is skipped; the rows around it still count", (t) => {
  const s = scene(t, (p) => [term("t1", { cwd: p })]);
  assert.equal(s.cli("attach", "Genie", "t1").code, 0);
  appendFileSync(s.ledgerPath, "{\"v\":1,\"event\":\"det");
  appendFileSync(s.ledgerPath, "\n");
  assert.equal(s.whois("t1").bot, ID.main);
});

// ---- automagik#206: a linked machine's rows ----

const LAB = "5e1f0c2a9b7d4e3f8a6c1b2d3e4f5a6b";
const remoteRow = (extra = {}) => attachRow({ event: "attach", bot: "b-atlasaaaaa", project: "/srv/ops",
  terminal: "t8", core: LAB, created_ms: 1700000000008, machine: "lab", by: "attach", at: 0, ...extra });

test("a linked machine's row: bare terminal, the machine's core, read and folded like a local one", () => {
  const row = remoteRow();
  assert.equal(row.terminal, "t8");
  assert.equal(row.machine, "lab");
  const { rows, skipped } = readAttach(`${JSON.stringify(row)}\n`);
  assert.equal(skipped, 0);
  const fold = foldAttach(rows);
  assert.equal(fold.byBot.get("b-atlasaaaaa"), undefined, "not this computer's");
  assert.equal(heldIn(fold, "b-atlasaaaaa", row.core).terminal, "t8");
});

test("machinesById and addressOf: the address uses the name hc gives that core now", () => {
  const machines = machinesById(JSON.stringify({ machines: [{ id: LAB, name: "lab", state: "connected" }, { id: "x", name: "bad/name", state: "connected" }, { name: "noid" }] }));
  assert.deepEqual([...machines], [[LAB, { name: "lab", connected: true }]]);
  assert.equal(addressOf(remoteRow(), machines), "lab/t8");
  assert.equal(addressOf(remoteRow(), machinesById({ machines: [{ id: LAB, name: "nebula", state: "connected" }] })), "nebula/t8", "renamed");
  assert.equal(addressOf(remoteRow(), new Map()), "lab/t8", "unlinked: the row's own name");
  assert.equal(addressOf({ terminal: "t3", machine: null }), "t3");
  assert.deepEqual([...machinesById("not json")], []);
});

test("confirmBindings: a connected machine's row is asked at its address; away or unlinked stays unknown, never asked", async () => {
  const asked = [];
  const ask = async (args) => { asked.push(args); return { state: "live", created_ms: 1700000000008 }; };
  const connected = machinesById({ machines: [{ id: LAB, name: "lab", state: "connected" }] });
  const on = await confirmBindings([remoteRow()], "mac", ask, undefined, connected);
  assert.equal(on.live.length, 1);
  assert.deepEqual(asked, [["get", "lab/t8"]]);
  asked.length = 0;
  const away = await confirmBindings([remoteRow()], "mac", ask, undefined, machinesById({ machines: [{ id: LAB, name: "lab", state: "disconnected" }] }));
  const unlinked = await confirmBindings([remoteRow()], "mac", ask);
  for (const r of [away, unlinked]) assert.deepEqual([r.live.length, r.ended.length, r.unknown.length], [0, 0, 1]);
  assert.deepEqual(asked, [], "a machine away is never asked");
  // Ended there: finished or replaced, like a local pane.
  const gone = await confirmBindings([remoteRow()], "mac", async () => null, undefined, connected);
  assert.equal(gone.ended[0].reason, "finished");
  const reused = await confirmBindings([remoteRow()], "mac", async () => ({ state: "live", created_ms: 5 }), undefined, connected);
  assert.equal(reused.ended[0].reason, "replaced");
  // A local row of another core still ends as before.
  const other = await confirmBindings([remoteRow({ machine: null, core: "old" })], "mac", ask, undefined, connected);
  assert.equal(other.ended[0].reason, "finished");
});
