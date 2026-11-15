// #631 PR C1: the approved roster snapshot. Direct rows over the record module (shape, key,
// mode, diff, reader) and one CLI row each for `proxy approve` writing and refusing a data
// root inside the project. Hermetic: temp project, data home and app home; no Herdr, no hc.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { approveProject, approvedProxyEnabled, approvedProxyState, approvedRootOf,
  projectKey, readApprovedRecord, recordFileOf,
  sha256Of } from "../mods/am-sidebar/approved.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const HARNESS = new URL("./cli-approve-harness.mjs", import.meta.url).pathname;
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc",
  jun: "b-dddddddddd", rev: "b-eeeeeeeeee" };
const bot = (id, kind, extra = {}) => ({
  id, name: id.slice(0, 8), kind, look: { character: "star", colour: "blue" }, role: "r",
    instructions: "i",
  agent: "dsh-tui", ...extra,
});
const team = () => ({
  version: 1,
  categories: [],
  bots: [
    bot(ID.main, "main", { name: "Main" }),
    bot(ID.cap, "member", { name: "Captain", rank: "captain" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.jun, "member", { name: "Junior", lead: ID.dev }),
    bot(ID.rev, "member", { name: "Reviewer", rank: "reviewer" }),
  ],
});

/** A temp project, data home, app home and pane temp folder. */
function scene(t) {
  const root = scratchRoot(t, "hb-approved-");
  const project = scratchProject(root, "proj", { bots: team() });
  const data = join(root, "data"), home = join(root, "home");
  const app = join(root, "app"), paneTmp = join(root, "pane-tmp"), runtime = join(root, "run");
  for (const dir of [data, home, app, paneTmp, runtime]) {
    mkdirSync(dir, { recursive: true });
  }
  const bots = join(project, ".herdr", "bots.json");
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: data, HERDR_APP_HOME: app,
    TMPDIR: paneTmp,
    USER: "tester", XDG_RUNTIME_DIR: runtime, GIT_CEILING_DIRECTORIES: root };
  delete env.HC_TERMINAL_ID;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [HARNESS, ...args],
      { cwd: root, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { root, project, data, home, app, paneTmp, runtime, bots, env, cli };
}

test("G1 (e): approve writes 0600, keyed by the canonical project, and prints the diff", (t) => {
  const s = scene(t);
  const result = approveProject({ project: s.project, env: s.env,
    approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: "tester",
    beforeWrite: ({ diff }) => {
      assert.equal(existsSync(recordFileOf(s.project, s.env)), false,
        "the person sees the diff before a record is written");
      assert.equal(diff.length, team().bots.length);
    } });
  assert.equal(statSync(result.path).mode & 0o777, 0o600, "the record is 0600");
  assert.equal(basename(result.path), `${projectKey(s.project)}.json`);
  assert.equal(result.path, recordFileOf(s.project, s.env));
  assert.equal(result.path.startsWith(approvedRootOf(s.env)), true);
  const record = JSON.parse(readFileSync(result.path, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["approvedAt", "approvedBy", "project", "roster",
    "sha256", "v"]);
  assert.equal(record.v, 1);
  assert.equal(record.project, realpathSync(s.project));
  assert.equal(record.roster, readFileSync(s.bots, "utf8"), "the exact working bytes");
  assert.equal(record.sha256, sha256Of(record.roster));
  assert.equal(record.approvedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(record.approvedBy, "tester");
  assert.equal(result.diff.length, team().bots.length, "a first approval lists every bot as added");
  assert.ok(result.diff.every((line) => line.startsWith("+ ")));
  assert.equal(readApprovedRecord({ project: s.project, env: s.env }).file.bots.length,
    team().bots.length);
});

test("G1 (e): approve prints added, removed, rank, lead and kind changes through the CLI", (t) => {
  const s = scene(t);
  s.cli(["proxy", "approve", "--project", s.project]);
  const next = team();
  next.bots = next.bots.filter((b) => b.id !== ID.dev);
  next.bots.find((b) => b.id === ID.cap).rank = "pm";
  next.bots.find((b) => b.id === ID.cap).hcProxy = true;
  next.bots.find((b) => b.id === ID.jun).lead = ID.cap;
  next.bots.find((b) => b.id === ID.rev).kind = "main";
  next.bots.push(bot("b-zzzzzzzzzz", "member", { name: "Injected" }));
  writeFileSync(s.bots, `${JSON.stringify(next, null, 2)}\n`);
  const r = s.cli(["proxy", "approve", "--project", s.project]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /approved 5 bots/);
  assert.match(r.out, /^- b-cccccccccc Dev \(removed\)$/m);
  assert.match(r.out, /^\+ b-zzzzzzzzzz Injected \(added\)$/m);
  assert.match(r.out, /^~ b-bbbbbbbbbb Captain: rank captain -> pm$/m);
  assert.match(r.out, /^~ b-bbbbbbbbbb Captain: hcProxy off -> on$/m);
  assert.match(r.out, /^~ b-dddddddddd Junior: lead b-cccccccccc -> b-bbbbbbbbbb$/m);
  assert.match(r.out, /^~ b-eeeeeeeeee Reviewer: kind member -> main$/m);
  assert.match(r.out, /record: .* \(0600\)/);
  const again = s.cli(["proxy", "approve", "--project", s.project]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /no roster changes from the previous approval/);
  const json = s.cli(["proxy", "approve", "--project", s.project, "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(JSON.parse(json.out).diff, []);
  assert.equal(JSON.parse(json.out).record, recordFileOf(s.project, s.env));
  assert.equal(statSync(recordFileOf(s.project, s.env)).mode & 0o777, 0o600);
});

test("G1 (a): the reader returns the approved roster after the working file changes", (t) => {
  const s = scene(t);
  approveProject({ project: s.project, env: s.env, approvedAt: "2026-11-01T00:00:00.000Z",
    approvedBy: "tester" });
  const changed = team();
  changed.bots.find((b) => b.id === ID.dev).rank = "pm";
  changed.bots.push(bot("b-zzzzzzzzzz", "member", { name: "Injected" }));
  writeFileSync(s.bots, `${JSON.stringify(changed, null, 2)}\n`);
  const read = readApprovedRecord({ project: s.project, env: s.env });
  assert.equal(read.file.bots.length, team().bots.length);
  assert.equal(read.file.bots.find((b) => b.id === ID.dev).rank, undefined);
  assert.equal(read.record.sha256, sha256Of(read.record.roster));
});

test("G1 (c): a missing record is refused and names proxy approve", (t) => {
  const s = scene(t);
  assert.throws(() => readApprovedRecord({ project: s.project, env: s.env }),
    /no approved roster .*am proxy approve/s);
  rmSync(approvedRootOf(s.env), { recursive: true, force: true });
  assert.throws(() => readApprovedRecord({ project: s.project, env: s.env }), /no approved roster/);
});

test("G1: a corrupt, foreign or 0644 record is refused; approve replaces a corrupt one", (t) => {
  const s = scene(t);
  const result = approveProject({ project: s.project, env: s.env,
    approvedAt: "2026-11-01T00:00:00.000Z", approvedBy: "tester" });
  const original = readFileSync(result.path, "utf8");
  const record = JSON.parse(original);
  writeFileSync(result.path, `${JSON.stringify({ ...record, sha256: "0".repeat(64) }, null, 2)}\n`);
  assert.throws(() => readApprovedRecord({ project: s.project, env: s.env }),
    /does not match its sha256/);
  writeFileSync(result.path, `${JSON.stringify({ ...record, project: "/elsewhere" }, null, 2)}\n`);
  assert.throws(() => readApprovedRecord({ project: s.project, env: s.env }), /is for \/elsewhere/);
  writeFileSync(result.path, original);
  chmodSync(result.path, 0o644);
  assert.throws(() => readApprovedRecord({ project: s.project, env: s.env }), /is not 0600/);
  // Approve is the recovery path: a corrupt record is printed as a note and replaced.
  writeFileSync(result.path, "{not json\n");
  const replaced = approveProject({ project: s.project, env: s.env,
    approvedAt: "2026-11-02T00:00:00.000Z", approvedBy: "tester" });
  assert.match(replaced.note, /previous record was unreadable/);
  assert.equal(statSync(replaced.path).mode & 0o777, 0o600);
});

test("invalid approvals have no trusted value: off is plain and on refuses for the same record", (t) => {
  const s = scene(t);
  const { path, record } = approveProject({ project: s.project, env: s.env });
  const invalidRoster = "[]";
  for (const [name, text, mode] of [
    ["unreadable", JSON.stringify(record), 0o000],
    ["not private", JSON.stringify(record), 0o644],
    ["not JSON", "{broken", 0o600],
    ["other version", JSON.stringify({ ...record, v: 999 }), 0o600],
    ["sha mismatch", JSON.stringify({ ...record, sha256: "invalid" }), 0o600],
    ["invalid roster", JSON.stringify({ ...record, roster: invalidRoster,
      sha256: sha256Of(invalidRoster) }), 0o600],
  ]) {
    chmodSync(path, 0o600);
    writeFileSync(path, text);
    chmodSync(path, mode);
    for (const working of [false, true]) {
      const state = approvedProxyState({ project: s.project, env: s.env,
        bot: { id: ID.main, hcProxy: working } });
      assert.equal(state.approved, null, name);
      assert.ok(state.error?.includes(path), `${name}: warning names the invalid record`);
      if (working) assert.throws(() => approvedProxyEnabled(state, "linux"), /proxy approve first/);
      else assert.equal(approvedProxyEnabled(state, "linux"), false, name);
    }
  }
  chmodSync(path, 0o600);
});

test("doctor warns about invalid approval even with no bot switches to inspect", (t) => {
  const s = scene(t);
  const { path } = approveProject({ project: s.project, env: s.env });
  writeFileSync(path, "{broken");
  writeFileSync(s.bots, JSON.stringify({ version: 1, categories: [], bots: [] }));
  const result = spawnSync(process.execPath,
    [CLI, "dsh-tui", "doctor", "--project", s.project, "--json"],
    { cwd: s.root, env: { ...s.env, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  const row = JSON.parse(result.stdout).checks.find((entry) => entry.check === "approved-roster");
  assert.equal(row.warning, true);
  assert.ok(row.detail.includes(path));
  assert.match(row.detail, /not JSON/);
});

test("G1 (d): proxy approve refuses writable data roots and writes nothing", (t) => {
  const s = scene(t);
  const literalTmp = join(realpathSync("/tmp"), `am-approve-literal-${process.pid}-${Date.now()}`);
  for (const [name, parent] of [
    ["project", s.project], ["app home", s.app], ["temp folder", s.paneTmp],
    ["runtime folder", s.runtime], ["literal temp folder", literalTmp],
  ]) {
    const data = join(parent, `c1-refused-${process.pid}`);
    const r = spawnSync(process.execPath, [CLI, "proxy", "approve", "--project", s.project], {
      cwd: s.project, env: { ...s.env, XDG_DATA_HOME: data }, encoding: "utf8",
    });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /approved data root .* is inside/, name);
    assert.equal(existsSync(join(data, "automagik-herdr", "approved")), false, name);
  }
});

test("G1: proxy approve --help carries the residual; no --project is a usage mistake", (t) => {
  const s = scene(t);
  const help = s.cli(["proxy", "approve", "--help"]);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /Residual: a sandboxed bot can ask an in-team unsandboxed pane/);
  assert.match(help.out, /printed diff is the check, and approving is the person's act/);
  const missing = s.cli(["proxy", "approve"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /needs --project/);
});
