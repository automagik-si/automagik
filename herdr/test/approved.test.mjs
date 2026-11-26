// #631 PR C1: the approved roster snapshot. Direct rows over the record module (shape, key,
// mode, diff, reader) and one CLI row each for `proxy approve` writing and refusing a data
// root inside the project. Hermetic: temp project, data home and app home; no Herdr, no hc.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { approveProject, approvedProxyEnabled, approvedProxyState, approvedRootOf,
  projectKey, readApprovedRecord, recordFileOf,
  sha256Of } from "../mods/am-sidebar/approved.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const HARNESS = new URL("./cli-approve-harness.mjs", import.meta.url).pathname;
const AM = new URL("../../am/bin/am", import.meta.url).pathname;
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

function runCli(root, file, args, env, cwd = root) {
  const out = join(root, "cli.stdout");
  const err = join(root, "cli.stderr");
  const stdout = openSync(out, "w");
  const stderr = openSync(err, "w");
  let result;
  try {
    result = spawnSync(file, args, { cwd, env, stdio: ["ignore", stdout, stderr], timeout: 5000 });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  return { code: result.status, out: readFileSync(out, "utf8"), err: readFileSync(err, "utf8") };
}

/** A temp project, data home, app home and pane temp folder. */
function scene(t, { isGit = true } = {}) {
  const root = scratchRoot(t, "hb-approved-");
  const project = scratchProject(root, "proj", { bots: team(), isGit });
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
  const marker = join(root, "repaired-links");
  env.AM_TEST_LINK_MARKER = marker;
  const cli = (args, extra = {}) =>
    runCli(root, process.execPath, [HARNESS, ...args], { ...env, ...extra });
  const args = ["proxy", "approve", "--project", project];
  const preview = () => {
    const r = cli([...args, "--json"]);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  return { root, project, data, home, app, paneTmp, runtime, bots, env, cli, args, preview, marker };
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
  const first = s.cli([...s.args, "--confirm", s.preview().digest]);
  assert.equal(first.code, 0, first.err);
  const next = team();
  next.bots = next.bots.filter((b) => b.id !== ID.dev);
  next.bots.find((b) => b.id === ID.cap).rank = "pm";
  next.bots.find((b) => b.id === ID.cap).hcProxy = true;
  next.bots.find((b) => b.id === ID.jun).lead = ID.cap;
  next.bots.find((b) => b.id === ID.rev).kind = "main";
  next.bots.push(bot("b-zzzzzzzzzz", "member", { name: "Injected" }));
  writeFileSync(s.bots, `${JSON.stringify(next, null, 2)}\n`);
  const r = s.cli([...s.args, "--confirm", s.preview().digest]);
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
  const json = s.cli([...s.args, "--confirm", s.preview().digest, "--json"]);
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

test("preview writes nothing and returns the candidate's digest and record path", (t) => {
  const s = scene(t, { isGit: false });
  const preview = s.preview();
  assert.deepEqual(Object.keys(preview).sort(), ["diff", "digest", "entries", "key", "note",
    "preview", "previous", "project", "raw_diff", "record", "warnings"]);
  assert.equal(preview.preview, true);
  assert.equal(preview.project, realpathSync(s.project));
  assert.equal(preview.key, projectKey(s.project));
  assert.equal(preview.record, recordFileOf(s.project, s.env));
  assert.equal(preview.digest, sha256Of(readFileSync(s.bots)));
  assert.equal(preview.previous, false);
  assert.equal(preview.note, null);
  assert.equal(existsSync(preview.record), false);
  assert.equal(existsSync(approvedRootOf(s.env)), false);
  assert.equal(existsSync(s.marker), false);
});

test("confirm repairs links and writes the reviewed record once, with mode 0600", (t) => {
  const s = scene(t, { isGit: false });
  const preview = s.preview();
  const confirmed = s.cli([...s.args, "--confirm", preview.digest, "--json"]);
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.equal(existsSync(s.marker), true);
  assert.deepEqual(readdirSync(approvedRootOf(s.env)), [basename(preview.record)]);
  assert.equal(statSync(preview.record).mode & 0o777, 0o600);
  assert.equal(JSON.parse(confirmed.out).digest, preview.digest);
});

test("an edit between preview and confirm is refused before any write or link repair", (t) => {
  const s = scene(t, { isGit: false });
  const { digest } = s.preview();
  writeFileSync(s.bots, JSON.stringify(team()));
  const refused = s.cli([...s.args, "--confirm", digest]);
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.err, /roster changed since the preview; run .am proxy approve --project <dir>. again/);
  assert.equal(refused.out, "");
  assert.equal(existsSync(approvedRootOf(s.env)), false);
  assert.equal(existsSync(s.marker), false);
});

test("both CLI entry points refuse malformed, empty, uppercase and stray confirmations", (t) => {
  const s = scene(t, { isGit: false });
  const digest = s.preview().digest;
  // The real am entry point receives no test hook. A stale link is its repair marker.
  const links = join(s.home, ".local", "bin");
  const installed = join(s.app, "mods", "am-sidebar", "bin");
  mkdirSync(links, { recursive: true });
  mkdirSync(installed, { recursive: true });
  const link = join(links, "am");
  const stale = join(installed, "automagik-herdr.mjs");
  writeFileSync(stale, "");
  writeFileSync(join(installed, "automagik-herdr"), "");
  symlinkSync(stale, link);
  const am = (args) => runCli(s.root, AM, args, s.env);
  for (const cli of [s.cli, am]) {
    for (const [args, problem] of [
      [[...s.args, "--confirm", "invalid"], /lowercase hexadecimal digest/],
      [[...s.args, "--confirm="], /lowercase hexadecimal digest/],
      [[...s.args, "--confirm", digest.toUpperCase()], /lowercase hexadecimal digest/],
      [["ls", "--confirm", digest], /--confirm goes with am proxy approve only/],
      [["help", "--confirm", digest], /--confirm goes with am proxy approve only/],
      [["--help", `--confirm=${digest}`], /--confirm goes with am proxy approve only/],
      [["proxy", "--help", "--confirm", digest], /--confirm goes with am proxy approve only/],
      [["accounts", "--help", "--confirm", digest], /--confirm goes with am proxy approve only/],
    ]) {
      const result = cli(args);
      assert.equal(result.code, 2, result.err);
      assert.match(result.err, problem);
      assert.equal(result.out, "");
      assert.equal(existsSync(s.marker), false);
      assert.equal(readlinkSync(link), stale);
      assert.equal(existsSync(approvedRootOf(s.env)), false);
    }
  }
});

test("preview and confirm refuse a BOM, invalid UTF-8, a FIFO and a symlink", (t) => {
  const s = scene(t, { isGit: false });
  const { digest } = s.preview();
  const bytes = readFileSync(s.bots);
  const target = join(s.root, "roster.json");
  writeFileSync(target, bytes);
  const rows = [
    [() => writeFileSync(s.bots, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
      /starts with a byte-order mark; remove it/],
    [() => writeFileSync(s.bots, bytes.map((byte, i) => i === 2 ? 0xff : byte)),
      /roster is not valid UTF-8/],
    [() => execFileSync("mkfifo", [s.bots], { stdio: "ignore" }), /roster is not a regular file/],
    [() => symlinkSync(target, s.bots), /roster is a symlink/],
  ];
  for (const [replace, problem] of rows) {
    rmSync(s.bots);
    replace();
    for (const args of [s.args, [...s.args, "--confirm", digest]]) {
      const result = s.cli(args);
      assert.equal(result.code, 1, result.err);
      assert.match(result.err, problem);
      assert.equal(result.out, "");
      assert.equal(existsSync(s.marker), false);
      assert.equal(existsSync(approvedRootOf(s.env)), false);
    }
  }
});

test("a non-ASCII roster round-trips with the digest printed by the CLI", (t) => {
  const s = scene(t, { isGit: false });
  const roster = team();
  roster.bots[0].name = "Capitã 東京 🐝";
  const text = `${JSON.stringify(roster, null, 2)}\n`;
  writeFileSync(s.bots, text);
  const { digest } = s.preview();
  const confirmed = s.cli([...s.args, "--confirm", digest]);
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.match(confirmed.out, new RegExp(`^digest: ${digest}$`, "m"));
  const read = readApprovedRecord({ project: s.project, env: s.env });
  assert.equal(read.record.roster, text);
  assert.equal(read.record.sha256, digest);
});

test("a failed rename keeps the previous approval and leaves no temporary file", (t) => {
  const s = scene(t, { isGit: false });
  const first = approveProject({ project: s.project, env: s.env });
  const before = readFileSync(first.path);
  const roster = team();
  roster.bots[0].name = "New Name";
  writeFileSync(s.bots, JSON.stringify(roster));
  const { digest } = s.preview();
  for (const flags of [[], ["--json"]]) {
    const result = s.cli([...s.args, "--confirm", digest, ...flags], { AM_TEST_APPROVAL_RENAME_FAIL: "1" });
    assert.equal(result.code, 1, result.err);
    assert.match(result.err, /injected approval rename failure/);
    assert.equal(result.out, "");
    assert.deepEqual(readFileSync(first.path), before);
    assert.deepEqual(readdirSync(approvedRootOf(s.env)), [basename(first.path)]);
    assert.equal(existsSync(s.marker), false);
  }
});

test("preview shows parsed entry changes and raw lines the parser drops", (t) => {
  const s = scene(t, { isGit: false });
  const roster = team();
  const duplicate = { ...roster.bots[0], name: "Dropped Before" };
  roster.bots.push(duplicate);
  writeFileSync(s.bots, `${JSON.stringify(roster, null, 2)}\n`);
  approveProject({ project: s.project, env: s.env });
  duplicate.name = "Dropped After";
  writeFileSync(s.bots, `${JSON.stringify(roster, null, 2)}\n`);
  const dropped = s.preview();
  assert.deepEqual(dropped.diff, []);
  assert.deepEqual(dropped.entries, []);
  assert.match(dropped.warnings.join("\n"), /id used twice, left out/);
  assert.deepEqual(dropped.raw_diff.map((line) => line.replace(/^\D\d+: /, "")), [
    '      "name": "Dropped Before",', '      "name": "Dropped After",',
  ]);
  const first = s.cli([...s.args, "--confirm", dropped.digest]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /no rank\/lead\/kind\/hcProxy changes; other changes below/);
  assert.match(first.out, /raw diff:\n-[^\n]+Dropped Before[^\n]+\n\+[^\n]+Dropped After/);
  roster.bots[0].model = "new-model";
  const added = bot("b-zzzzzzzzzz", "member", { name: "New", model: "another-model" });
  roster.bots.push(added);
  roster.settings = { note: "new setting" };
  writeFileSync(s.bots, `${JSON.stringify(roster, null, 2)}\n`);
  const changed = s.preview();
  assert.ok(changed.entries.includes(JSON.stringify(added)));
  assert.ok(changed.entries.includes('~ b-aaaaaaaaaa Main: model absent -> "new-model"'));
  assert.ok(changed.entries.includes('~ roster: settings absent -> {"note":"new setting"}'));
  const confirmed = s.cli([...s.args, "--confirm", changed.digest]);
  assert.equal(confirmed.code, 0, confirmed.err);
  for (const entry of changed.entries) assert.ok(confirmed.out.includes(`  ${entry}\n`));
});

test("preview and confirm escape terminal controls while JSON preserves the name", (t) => {
  const s = scene(t, { isGit: false });
  const roster = team();
  const name = "Bot\t\u001b\u007f\u0085\u202e\u2066 name";
  roster.bots[0].name = name;
  writeFileSync(s.bots, JSON.stringify(roster));
  const preview = s.preview();
  assert.ok(preview.diff[0].includes(name));
  const text = s.cli(s.args);
  const confirmed = s.cli([...s.args, "--confirm", preview.digest]);
  for (const result of [text, confirmed]) {
    assert.equal(result.code, 0, result.err);
    assert.ok(result.out.includes("Bot\\x09\\x1b\\x7f\\x85\\u{202e}\\u{2066} name"));
    assert.doesNotMatch(result.out, /[\t\u001b\u007f\u0085\u202e\u2066]/);
  }
});

test("an unreadable previous record is described before and after replacement", (t) => {
  const s = scene(t, { isGit: false });
  const { path } = approveProject({ project: s.project, env: s.env });
  writeFileSync(path, "{broken");
  const preview = s.preview();
  assert.match(preview.note, /the previous record is unreadable .*; confirming replaces it/);
  assert.equal(readFileSync(path, "utf8"), "{broken");
  const confirmed = s.cli([...s.args, "--confirm", preview.digest]);
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.match(confirmed.out, /note: the previous record was unreadable .*; replaced/);
});

test("the data-root refusal also holds for --confirm", (t) => {
  const s = scene(t, { isGit: false });
  const { digest } = s.preview();
  const literalTmp = join(realpathSync("/tmp"), `am-approve-literal-${process.pid}-${Date.now()}`);
  for (const [name, parent] of [
    ["project", s.project], ["app home", s.app], ["temp folder", s.paneTmp],
    ["runtime folder", s.runtime], ["literal temp folder", literalTmp],
  ]) {
    const data = join(parent, `d2-refused-${process.pid}`);
    const r = runCli(s.root, process.execPath, [CLI, ...s.args, "--confirm", digest],
      { ...s.env, XDG_DATA_HOME: data }, s.project);
    assert.notEqual(r.code, 0, name);
    assert.match(r.err, /approved data root .* is inside/, name);
    assert.equal(existsSync(join(data, "automagik-herdr", "approved")), false, name);
    assert.equal(existsSync(s.marker), false, name);
  }
});
