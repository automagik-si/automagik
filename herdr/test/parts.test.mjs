// The herdr parts' entries (mods/am-sidebar/parts.mjs, pack/part.mjs): install, uninstall and doctor
// of each part, with the pack made from this checkout, in a temp app home and a temp HOME. Programs
// run through an injected exec whose PATH has no herdr-app; doctor gets an exec that fails the test
// if called (it runs nothing). Never the real ~/.config/herdr-app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PART_IDS, contextOf, doctor, install, packSource, partOf, runCommand, sidebarCarries, uninstall } from "../mods/am-sidebar/parts.mjs";
import { main, parseArgs } from "../mods/am-sidebar/pack/part.mjs";
import { ownHook, withoutHooks } from "../mods/am-sidebar/migrateHooks.mjs";
import { directHookCommand, hookCommand, amPartHookCommand } from "../mods/am-sidebar/briefingText.mjs";
import { OFF_BY_DEFAULT, PACK_MODS } from "../mods/am-sidebar/release.js";
import { placeLayout, readMarker, readVersion, writeMarker } from "../mods/am-sidebar/update.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = readVersion(join(ROOT, "mods", "am-sidebar"));
const P = (id) => partOf(id);

/** A scratch machine: HOME and HERDR_APP_HOME in a temp folder, a PATH with node and tar but no herdr-app. */
function machine(t) {
  const dir = mkdtempSync(join(tmpdir(), "am-parts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), app = join(dir, "app");
  mkdirSync(home);
  mkdirSync(app);
  const binDir = join(home, ".local", "bin");
  const env = { HOME: home, HERDR_APP_HOME: app, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, AM_PART_DIR: join(ROOT, "mods", "am-footer") };
  const logs = [];
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, ...args]); return runCommand(cmd, args, opts); };
  const ctx = (extra = {}, opts = {}) => contextOf({ env: { ...env, ...extra }, exec, log: (l) => logs.push(l), platform: "darwin", ...opts });
  return { dir, home, app, binDir, mods: join(app, "mods"), off: join(app, "mods-disabled"), env, logs, calls, ctx };
}
const noExec = () => { throw new Error("doctor ran a program"); };
/** am's briefing entry point, as am places it: a link into its parts store (~/.automagik/parts/…). */
function amEntry(m) {
  const store = join(m.home, ".automagik", "parts", "sha-am", "briefing");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "briefing.mjs"), "// am's briefing entry point\n");
  const entry = join(m.app, "automagik-herdr", "briefing.mjs");
  rmSync(entry, { force: true });
  symlinkSync(join(store, "briefing.mjs"), entry);
  return entry;
}
const doctorOf = (m, id, extra) => doctor(contextOf({ env: { ...m.env, ...extra }, exec: noExec, log: () => {}, platform: "darwin", project: join(m.dir, "project") }), P(id));
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.check);
const ls = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test("the ids, the argv and the contract around them", () => {
  assert.deepEqual(PART_IDS, ["herdr.pack", ...PACK_MODS.map((m) => `herdr.${m}`), "herdr.layout"]);
  assert.deepEqual(P("herdr.pack"), { id: "herdr.pack", kind: "pack" });
  assert.deepEqual(P("herdr.am-sidebar"), { id: "herdr.am-sidebar", kind: "mod", mod: "am-sidebar" });
  assert.deepEqual(P("herdr.am-tabs"), { id: "herdr.am-tabs", kind: "mod", mod: "am-tabs" });
  assert.equal(P("herdr.pocket-link"), null);
  assert.equal(P("me.my-sidebar"), null);
  assert.deepEqual(parseArgs(["uninstall", "herdr.am-tabs", "--purge"]), { verb: "uninstall", part: P("herdr.am-tabs"), purge: true });
  for (const bad of [["install"], ["install", "herdr.nope"], ["remove", "herdr.layout"], ["install", "herdr.layout", "--purge"], ["doctor", "herdr.layout", "-v"], ["install", "herdr.cli"]]) {
    assert.throws(() => parseArgs(bad), /usage: node part.mjs/, bad.join(" "));
  }
});

test("off macOS every entry is not applicable (exit 2) and changes nothing", (t) => {
  const m = machine(t);
  const out = [];
  const ctx = m.ctx({ AM_JSON: "1" }, { platform: "linux" });
  assert.equal(main(["install", "herdr.am-sidebar"], { ctx, out: (l) => out.push(l) }), 2);
  assert.equal(JSON.parse(out[0]).ok, false);
  assert.equal(main(["doctor", "herdr.layout"], { ctx, out: (l) => out.push(l) }), 2);
  assert.match(JSON.parse(out[1]).detail, /not applicable/);
  assert.deepEqual(ls(m.app), []);
  assert.equal(main(["bogus"], { ctx, out: () => {} }), 64, "a usage error (EX_USAGE), never 2 (not applicable)");
});

test("install from a checkout: the whole pack once, the record its marker; a second install is a no-op", (t) => {
  const m = machine(t);
  const out = [];
  assert.equal(main(["install", "herdr.am-footer"], { ctx: m.ctx({ AM_JSON: "1" }), out: (l) => out.push(l) }), 0, m.logs.join("\n"));
  assert.deepEqual(JSON.parse(out[0]), { part: "herdr.am-footer", ok: true, changed: true, detail: `am-footer is on (pack ${VERSION})` });
  const record = readMarker(m.mods);
  assert.equal(record.version, VERSION);
  assert.deepEqual([...record.mods].sort(), [...PACK_MODS].sort());
  assert.deepEqual(ls(m.mods), PACK_MODS.filter((x) => !OFF_BY_DEFAULT.includes(x)).sort(), "every pack mod that ships on, and nothing else");
  assert.deepEqual(ls(m.off), [...OFF_BY_DEFAULT].sort(), "the ones that ship off are in mods-disabled/");
  assert.ok(existsSync(join(m.app, "layouts", "automagik.json")), "the layout placed");
  assert.ok(existsSync(join(m.mods, "am-footer", "part.json")), "part.json ships in the mod folder");
  assert.equal(existsSync(join(m.app, "keys.json")), false, "first launch must initialize Herdr's native shortcuts");
  const installs = m.calls.filter((c) => c.some((a) => a.endsWith("update.mjs"))).length;
  assert.equal(installs, 1);

  // The pack is in; the sidebar's part also links the command (a change), then nothing changes again.
  assert.equal(install(m.ctx({ AM_VERSION: VERSION }), P("herdr.pack"), packSource).changed, true);
  for (const id of PART_IDS) {
    const r = install(m.ctx({ AM_VERSION: VERSION }), P(id), packSource);
    // Installing a mod that ships off by name switches it on: that is the one change.
    assert.equal(r.changed, OFF_BY_DEFAULT.includes(P(id).mod), id);
  }
  assert.deepEqual(ls(m.off), [], "named, it is on");
  assert.equal(m.calls.filter((c) => c.some((a) => a.endsWith("update.mjs"))).length, 1, "the same version never reinstalls");
});

test("AM_ARTIFACT: am's verified tarball is installed as it is", (t) => {
  const m = machine(t);
  const src = packSource(m.ctx());
  t.after(src.cleanup);
  const r = install(m.ctx({ AM_ARTIFACT: src.tgz, AM_VERSION: VERSION, AM_PART_DIR: join(m.dir, "nowhere") }), P("herdr.pack"), packSource);
  assert.equal(r.ok, true);
  assert.equal(readMarker(m.mods).version, VERSION);
  // A version am names that the tarball does not carry is refused by update.mjs, writing nothing more.
  const m2 = machine(t);
  assert.throws(() => install(m2.ctx({ AM_ARTIFACT: src.tgz, AM_VERSION: "9.9.9" }), P("herdr.pack"), packSource), /was not installed/);
  assert.equal(readMarker(m2.mods), null);
});

test("one mod: uninstall switches it off, an update keeps it off, doctor says not applicable, install switches it on", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-tabs"), packSource);
  install(m.ctx(), P("herdr.pack"), packSource);
  assert.equal(doctorOf(m, "herdr.am-tabs").code, 0);

  const r = uninstall(m.ctx(), P("herdr.am-tabs"));
  assert.equal(r.changed, true);
  assert.ok(!existsSync(join(m.mods, "am-tabs")));
  assert.ok(existsSync(join(m.off, "am-tabs", "main.js")));
  assert.ok(readMarker(m.mods).mods.includes("am-tabs"), "the marker keeps mods= as it is");
  assert.equal(uninstall(m.ctx(), P("herdr.am-tabs")).changed, false, "idempotent");
  const d = doctorOf(m, "herdr.am-tabs");
  assert.equal(d.code, 2);
  assert.deepEqual(d.checks.map((c) => c.check), ["record", "switched-off"]);
  assert.equal(doctorOf(m, "herdr.pack").code, 0, "the pack is healthy with a mod off");

  assert.equal(install(m.ctx(), P("herdr.am-tabs"), packSource).changed, true);
  assert.ok(existsSync(join(m.mods, "am-tabs", "main.js")));
  assert.deepEqual(ls(m.off), [...OFF_BY_DEFAULT].sort(), "only the mods that ship off are left off");
});

test("am-mods: its key goes with it while it is the pack's, a rebound one stays, and install puts it back", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-mods"), packSource);
  assert.equal(existsSync(join(m.app, "keys.json")), false, "the part entry must not recreate a pack-only key file");
  const native = { terminal: { "ctrl-shift-v": "terminal.paste", "shift-insert": "terminal.paste" } };
  writeFileSync(join(m.app, "keys.json"), JSON.stringify(native), { flag: "wx" });
  install(m.ctx(), P("herdr.am-mods"), packSource);
  const keys = () => JSON.parse(readFileSync(join(m.app, "keys.json"), "utf8"));
  assert.deepEqual(keys().terminal, native.terminal, "native paste bindings survive the post-launch install");
  uninstall(m.ctx(), P("herdr.am-mods"));
  assert.equal(keys().global["cmd-shift-m"], undefined);
  assert.deepEqual(failed(doctorOf(m, "herdr.am-mods")), [], "off: not checked");
  install(m.ctx(), P("herdr.am-mods"), packSource);
  assert.equal(keys().global["cmd-shift-m"], "mod.open:am-mods");
  assert.equal(doctorOf(m, "herdr.am-mods").code, 0);

  writeFileSync(join(m.app, "keys.json"), JSON.stringify({ global: { "cmd-shift-m": "my.action" } }));
  uninstall(m.ctx(), P("herdr.am-mods"));
  assert.equal(keys().global["cmd-shift-m"], "my.action", "the person's binding stays");
  install(m.ctx(), P("herdr.am-mods"), packSource);
  assert.equal(keys().global["cmd-shift-m"], "my.action");
  assert.match(doctorOf(m, "herdr.am-mods").checks.find((c) => c.check === "keys").detail, /is yours/);
});

test("herdr.pack links automagik-herdr as install.sh does, leaves someone else's, and records AM_SEQUENCE", (t) => {
  const m = machine(t);
  const r = install(m.ctx({ AM_SEQUENCE: "630001" }), P("herdr.pack"), packSource);
  assert.equal(r.ok, true);
  assert.equal(readMarker(m.mods).sequence, 630001, "the signed pointer's sequence: install.sh's replay guard stays on");
  const link = join(m.binDir, "automagik-herdr");
  assert.equal(readlinkSync(link), join(m.mods, "am-sidebar", "bin", "automagik-herdr"));
  assert.equal(readlinkSync(join(m.binDir, "am")), readlinkSync(link), "am beside it, the same wrapper (install.sh does both)");
  const d = doctorOf(m, "herdr.pack");
  assert.deepEqual(failed(d), [], JSON.stringify(d.checks));
  assert.deepEqual(d.checks.map((c) => c.check).filter((c) => !c.startsWith("dsh-tui")), ["restart-path", "record", "pack-version", "pack-mods", "briefing-entry", "briefing-hook", "command", "am command", "path", "node", "agent-antigravity"]);
  const noPath = doctorOf(m, "herdr.pack", { PATH: "/usr/bin" });
  assert.equal(noPath.code, 0, "not on PATH is a note, never a rollback");
  assert.match(noPath.checks.find((c) => c.check === "path").fix, /export PATH=/);
  assert.equal(install(m.ctx(), P("herdr.pack"), packSource).changed, false, "idempotent");

  rmSync(link);
  assert.deepEqual(failed(doctorOf(m, "herdr.pack")), ["command"]);
  assert.equal(doctorOf(m, "herdr.pack").checks.find((c) => c.check === "command").fix, "am install herdr.pack");
  assert.equal(install(m.ctx(), P("herdr.pack"), packSource).changed, true, "the link comes back");

  rmSync(link);
  symlinkSync("/usr/bin/true", link);
  assert.equal(install(m.ctx(), P("herdr.pack"), packSource).ok, true);
  assert.ok(m.logs.some((l) => /points at \/usr\/bin\/true, not this install: left alone/.test(l)));
  uninstall(m.ctx(), P("herdr.pack"));
  assert.equal(readlinkSync(link), "/usr/bin/true", "the person's link stays");
  install(m.ctx(), P("herdr.pack"), packSource);
  const theirs = doctorOf(m, "herdr.pack");
  assert.equal(theirs.code, 0, "someone else's link is a note, never a rollback");
  const cmd = theirs.checks.find((c) => c.check === "command");
  assert.match(cmd.detail, /points at \/usr\/bin\/true, not this install: left alone/);
  assert.equal(cmd.fix, `rm ${link} && am install herdr.pack`);
  rmSync(link);
  writeFileSync(link, "#!/bin/sh\n");
  assert.equal(doctorOf(m, "herdr.pack").code, 0, "a file of the person's: a note too");
  assert.equal(P("herdr.cli"), null, "herdr.cli is retired (D34)");
});

test("herdr.layout: uninstall removes the pack's copy and no update puts it back; install does; yours stays", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.layout"), packSource);
  const live = join(m.app, "layouts", "automagik.json");
  assert.equal(doctorOf(m, "herdr.layout").code, 0);
  uninstall(m.ctx(), P("herdr.layout"));
  assert.ok(!existsSync(live));
  assert.equal(readMarker(m.mods).layout, "removed");
  assert.equal(doctorOf(m, "herdr.layout").code, 2);

  // What an update or install.sh's repair runs: the layout stays out.
  const src = packSource(m.ctx());
  t.after(src.cleanup);
  const record = readMarker(m.mods);
  assert.equal(placeLayout({ modsDir: m.mods, tgzDir: src.tree, record, log: () => {} }), "removed");
  assert.ok(!existsSync(live));
  assert.equal(readMarker(m.mods).layout, "removed");

  install(m.ctx(), P("herdr.layout"), packSource);
  assert.ok(existsSync(live));
  assert.equal(readMarker(m.mods).layout, "added");

  writeFileSync(live, "{\"mine\": true}\n");
  const r = uninstall(m.ctx(), P("herdr.layout"));
  assert.match(r.detail, /it is yours, left as it is/);
  assert.equal(readFileSync(live, "utf8"), "{\"mine\": true}\n");
  assert.match(doctorOf(m, "herdr.layout").checks.find((c) => c.check === "layout").detail, /is yours/);
});

test("herdr.pack install links am beside the old name; the sidebar guard and doctor know it", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const old = join(m.binDir, "automagik-herdr"), am = join(m.binDir, "am");
  assert.equal(readlinkSync(am), readlinkSync(old), "the same wrapper");
  assert.ok(m.logs.some((l) => l === `linked ${am}`), "said");
  assert.equal(install(m.ctx(), P("herdr.pack"), packSource).changed, false, "idempotent");
  const check = doctorOf(m, "herdr.pack").checks.find((c) => c.check === "am command");
  assert.equal(check.ok, true);
  // Only am's link left on the pack: the sidebar is still in use.
  rmSync(old);
  assert.match(sidebarCarries(m.ctx()).join("\n"), /the command \(.*\/am runs mods\/am-sidebar\/bin\)/);
  rmSync(am);
  assert.doesNotMatch(sidebarCarries(m.ctx()).join("\n"), /the command/);
  // Missing on an install from before it: a notice, not a failure.
  const missing = doctorOf(m, "herdr.pack").checks.find((c) => c.check === "am command");
  assert.equal(missing.ok, true);
  assert.match(missing.detail, /is missing/);
  // A person's own file or link is never replaced.
  writeFileSync(am, "mine\n");
  install(m.ctx(), P("herdr.pack"), packSource);
  assert.equal(readFileSync(am, "utf8"), "mine\n");
  rmSync(am);
  symlinkSync("/somewhere/else/am", am);
  install(m.ctx(), P("herdr.pack"), packSource);
  assert.equal(readlinkSync(am), "/somewhere/else/am");
});

test("herdr.pack uninstall removes the am link beside the old one, and leaves a user-owned am alone", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const old = join(m.binDir, "automagik-herdr"), am = join(m.binDir, "am");
  assert.equal(readlinkSync(am), readlinkSync(old), "install made both");
  uninstall(m.ctx(), P("herdr.pack"));
  assert.ok(!existsSync(old) && !lstatSync(am, { throwIfNoEntry: false }), "both links go");
  install(m.ctx(), P("herdr.pack"), packSource);
  rmSync(am);
  writeFileSync(am, "mine\n");
  const r = uninstall(m.ctx(), P("herdr.pack"));
  assert.ok(!existsSync(old));
  assert.equal(readFileSync(am, "utf8"), "mine\n", "a file of the person's stays");
  assert.ok(r.ok);
  rmSync(am);
  symlinkSync("/somewhere/else/am", am);
  install(m.ctx(), P("herdr.pack"), packSource);
  uninstall(m.ctx(), P("herdr.pack"));
  assert.equal(readlinkSync(am), "/somewhere/else/am", "a link elsewhere stays");
});

test("herdr.pack uninstall: the whole pack out; hooks, entry point, keys and links go; Herdr's and Pocket's files stay", (t) => {
  const m = machine(t);
  writeFileSync(join(m.app, "keys.json"), "{}\n"); // Herdr already initialized its key file.
  install(m.ctx(), P("herdr.pack"), packSource);
  uninstall(m.ctx(), P("herdr.am-quota"));
  assert.equal(doctorOf(m, "herdr.pack").code, 0, JSON.stringify(doctorOf(m, "herdr.pack").checks));

  // A project the CLI knows, with the pack's hook beside a hook of the person's.
  const project = join(m.dir, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const settings = join(project, ".claude", "settings.local.json");
  const theirs = { type: "command", command: "echo mine" };
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(m.app) }, theirs] }] } }, null, 2));
  writeFileSync(join(m.app, "am-sidebar-projects.json"), JSON.stringify([project]));
  // Herdr's own files and Pocket Link: never touched.
  writeFileSync(join(m.app, "shared.json"), "{\"herdr\": 1}\n");
  mkdirSync(join(m.mods, "pocket-link"));
  writeFileSync(join(m.mods, "pocket-link", "main.js"), "pocket\n");
  const data = ls(join(m.app, "data"));

  const r = uninstall(m.ctx(), P("herdr.pack"));
  assert.equal(r.ok, true);
  assert.deepEqual(ls(m.mods), ["pocket-link"]);
  assert.deepEqual(ls(m.off), [], "a switched-off mod leaves too");
  const prev = join(m.app, "automagik-herdr", ".prev");
  assert.deepEqual(ls(prev), [".pack", ...PACK_MODS].sort(), "kept, with its data, without --purge");
  assert.equal(readMarker(m.mods), null, "the record is gone");
  assert.ok(!existsSync(join(m.app, "automagik-herdr", "briefing.mjs")));
  assert.ok(!existsSync(join(m.app, "layouts", "automagik.json")));
  assert.ok(!existsSync(join(m.binDir, "automagik-herdr")));
  assert.equal(JSON.parse(readFileSync(join(m.app, "keys.json"), "utf8")).global["cmd-shift-m"], undefined);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(after, { permissions: { allow: ["Bash"] }, hooks: { UserPromptSubmit: [{ hooks: [theirs] }] } });
  assert.ok(existsSync(`${settings}.am-backup`), "backed up first");
  assert.equal(readFileSync(join(m.app, "shared.json"), "utf8"), "{\"herdr\": 1}\n");
  assert.equal(readFileSync(join(m.mods, "pocket-link", "main.js"), "utf8"), "pocket\n");
  assert.deepEqual(ls(join(m.app, "data")), data);

  assert.match(uninstall(m.ctx(), P("herdr.pack")).detail, /not installed: nothing to do/, "idempotent");
  for (const id of PART_IDS) assert.equal(uninstall(m.ctx(), P(id)).ok, true, id);
  assert.equal(doctorOf(m, "herdr.pack").code, 1);
  assert.equal(doctorOf(m, "herdr.pack").checks.find((c) => c.check === "record").fix, "am install herdr.pack");

  // Reinstalled, then purged: the kept set goes too.
  install(m.ctx(), P("herdr.pack"), packSource);
  uninstall(m.ctx(), P("herdr.pack"), { purge: true });
  assert.ok(!existsSync(prev));
  assert.deepEqual(ls(m.mods), ["pocket-link"]);
});

test("doctor notes Antigravity's agy, installed or missing, without failing the pack (#793)", (t) => {
  const m = machine(t);
  writeFileSync(join(m.app, "keys.json"), "{}\n"); // This scene has completed native initialization.
  install(m.ctx(), P("herdr.pack"), packSource);
  const missing = doctorOf(m, "herdr.pack").checks.find((c) => c.check === "agent-antigravity");
  assert.equal(missing.ok, true, "a person's absent agent is a note, never a broken pack");
  assert.match(missing.detail, /agy\) is not installed/);
  assert.equal(missing.fix, null);
  mkdirSync(m.binDir, { recursive: true });
  const agy = join(m.binDir, "agy");
  writeFileSync(agy, "#!/bin/sh\nexit 0\n");
  chmodSync(agy, 0o755);
  const there = doctorOf(m, "herdr.pack").checks.find((c) => c.check === "agent-antigravity");
  assert.match(there.detail, /agy\) is installed at .*\/agy$/);
});

test("doctor reads only: a healthy pack passes every part, a broken one names the check and its fix", (t) => {
  const m = machine(t);
  writeFileSync(join(m.app, "keys.json"), "{}\n"); // This scene has completed native initialization.
  install(m.ctx(), P("herdr.pack"), packSource);
  const before = execFileSync("find", [m.dir, "-print"], { encoding: "utf8" });
  for (const id of PART_IDS) {
    const r = doctorOf(m, id, { AM_VERSION: VERSION });
    if (OFF_BY_DEFAULT.includes(P(id).mod)) {
      // Shipped off: not applicable until it is turned on, like a mod switched off.
      assert.equal(r.code, 2, id);
      assert.deepEqual(r.checks.map((c) => c.check), ["record", "switched-off"], id);
      continue;
    }
    assert.equal(r.code, 0, `${id}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
    for (const c of r.checks) {
      assert.deepEqual(Object.keys(c), ["part", "check", "ok", "detail", "fix"]);
      assert.equal(c.part, id);
      assert.equal(c.fix, null);
    }
  }
  assert.equal(execFileSync("find", [m.dir, "-print"], { encoding: "utf8" }), before, "nothing written");

  assert.deepEqual(failed(doctorOf(m, "herdr.am-footer", { AM_VERSION: "9.9.9" })), ["version"]);
  rmSync(join(m.app, "automagik-herdr", "briefing.mjs"));
  const d = doctorOf(m, "herdr.pack");
  assert.deepEqual(failed(d), ["briefing-entry"]);
  assert.equal(d.checks.find((c) => c.check === "briefing-entry").fix, "am install herdr.pack");
  rmSync(join(m.mods, "am-status", "mod.json"));
  assert.deepEqual(failed(doctorOf(m, "herdr.am-status")), ["files"]);
  rmSync(join(m.mods, "am-tabs"), { recursive: true });
  assert.deepEqual(failed(doctorOf(m, "herdr.am-tabs")), ["folder"]);
  assert.deepEqual(failed(doctorOf(m, "herdr.pack")), ["pack-mods", "briefing-entry"]);

  // Through the entry: JSON lines, exit 1.
  const out = [];
  const code = main(["doctor", "herdr.am-tabs"], { ctx: contextOf({ env: m.env, exec: noExec, log: () => {}, platform: "darwin" }), out: (l) => out.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(out.map((l) => JSON.parse(l).check), ["record", "folder"]);
});

test("withoutHooks takes out only the pack's own hook for this app home", () => {
  const app = "/tmp/app";
  const other = hookCommand("/tmp/other-app");
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(app) }] }, { hooks: [{ type: "command", command: other }] }], Stop: [] } });
  const r = withoutHooks(text, ownHook(app));
  assert.equal(r.removed, 1);
  assert.deepEqual(JSON.parse(r.text), { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: other }] }], Stop: [] } });
  const only = withoutHooks(JSON.stringify({ a: 1, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(app) }] }] } }), ownHook(app));
  assert.deepEqual(JSON.parse(only.text), { a: 1 }, "an emptied list and hooks go");
  assert.equal(withoutHooks("{}", ownHook(app)).removed, 0);
  assert.match(withoutHooks("{ x", ownHook(app)).error, /not valid JSON/);
  assert.equal(lstatSync(ROOT).isDirectory(), true);
});

test("herdr.am-sidebar switches off like any member only once the command and the briefing no longer run from its folder", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const link = join(m.binDir, "automagik-herdr");
  const entry = join(m.app, "automagik-herdr", "briefing.mjs");
  assert.equal(sidebarCarries(m.ctx()).length, 2);
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-sidebar")), /mods\/am-sidebar still carries the command .* and every bot's briefing .*: switched off, they would stop working\. `am uninstall herdr.pack` removes the whole pack/);
  assert.ok(existsSync(join(m.mods, "am-sidebar")), "nothing moved");
  const out = [];
  assert.equal(main(["uninstall", "herdr.am-sidebar"], { ctx: m.ctx({ AM_JSON: "1" }), out: (l) => out.push(l) }), 1);
  assert.equal(JSON.parse(out[0]).ok, false);
  const why = doctorOf(m, "herdr.am-sidebar").checks.find((c) => c.check === "switch-off");
  assert.equal(why.ok, true, "not broken, only not yet switchable");
  assert.match(why.detail, /cannot be switched off yet: mods\/am-sidebar still carries the command/);

  // am takes the command over (its own link) and places its own entry point: the refusal lifts by itself.
  const am = join(m.dir, "am");
  mkdirSync(am);
  writeFileSync(join(am, "am.mjs"), "// am\n");
  rmSync(link);
  symlinkSync(join(am, "am.mjs"), link);
  assert.equal(sidebarCarries(m.ctx()).length, 2, "am's link still runs the sidebar's command");
  rmSync(join(m.binDir, "am"));
  symlinkSync(join(am, "am.mjs"), join(m.binDir, "am"));
  assert.equal(sidebarCarries(m.ctx()).length, 1, "the briefing still runs from the sidebar");
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-sidebar")), /every bot's briefing/);
  // A plain file there is not positively am's: still refused (fail closed).
  writeFileSync(entry, "// someone's entry point\n");
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-sidebar")), /every bot's briefing .* is not am's/);
  amEntry(m);
  // A project hook that still calls the sidebar's briefing.mjs directly keeps it on too.
  const project = join(m.dir, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const settings = join(project, ".claude", "settings.local.json");
  const hooked = (command) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } });
  writeFileSync(settings, hooked(directHookCommand(m.app)));
  writeFileSync(join(m.app, "am-sidebar-projects.json"), JSON.stringify([project]));
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-sidebar")), /the briefing hook in 1 project .* call mods\/am-sidebar\/briefing.mjs/);
  // The pack's own hook (hookCommand) starts through the sidebar's bin/run.sh: switched off, it
  // would run nothing, so it keeps the sidebar on too, until am runs the hooks (delivery 3).
  writeFileSync(settings, hooked(hookCommand(m.app)));
  assert.equal(sidebarCarries(m.ctx()).length, 1);
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-sidebar")),
    /the briefing hook in 1 project .*, which starts through mods\/am-sidebar\/bin\/run\.sh: with the sidebar off, that hook would run nothing/);
  assert.ok(existsSync(join(m.mods, "am-sidebar")), "nothing moved");
  // A hook through am's own runner (delivery 3's shape) does not need the sidebar.
  writeFileSync(settings, hooked(`sh '${join(m.dir, ".automagik", "parts", "automagik.am", "current", "bin", "run.sh")}' '${entry}'`));
  assert.deepEqual(sidebarCarries(m.ctx()), []);
  assert.match(doctorOf(m, "herdr.am-sidebar").checks.find((c) => c.check === "switch-off").detail, /can be switched off/);
  assert.equal(doctorOf(m, "herdr.pack").checks.find((c) => c.check === "command").ok, true, "am's link is not the pack's to fix");
  assert.equal(install(m.ctx(), P("herdr.pack"), packSource).ok, true);
  assert.equal(readlinkSync(link), join(am, "am.mjs"), "the pack leaves am's link");

  assert.equal(uninstall(m.ctx(), P("herdr.am-sidebar")).changed, true);
  assert.ok(existsSync(join(m.off, "am-sidebar", "main.js")));
  assert.equal(doctorOf(m, "herdr.am-sidebar").code, 2);
  assert.equal(uninstall(m.ctx(), P("herdr.am-sidebar")).changed, false, "idempotent once off");
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  assert.ok(existsSync(join(m.mods, "am-sidebar", "main.js")));
});

test("herdr.pack and herdr.layout run from am's stored extract, outside the app home, while the sidebar is off", async (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  install(m.ctx(), P("herdr.layout"), packSource);
  // am takes over the command and the briefing; the sidebar then switches off like any member.
  const am = join(m.dir, "am");
  mkdirSync(am);
  writeFileSync(join(am, "am.mjs"), "// am\n");
  const link = join(m.binDir, "automagik-herdr");
  rmSync(link);
  symlinkSync(join(am, "am.mjs"), link);
  rmSync(join(m.binDir, "am"));
  symlinkSync(join(am, "am.mjs"), join(m.binDir, "am"));
  const entry = amEntry(m);
  uninstall(m.ctx(), P("herdr.am-sidebar"));
  uninstall(m.ctx(), P("herdr.am-tabs"));
  assert.ok(existsSync(join(m.off, "am-sidebar")) && !existsSync(join(m.mods, "am-sidebar")));

  // am's stored copy of the verified extract: the entries load from there, never from mods/.
  const store = join(m.dir, "store");
  mkdirSync(store);
  const tgz = join(m.dir, "p.tgz");
  execFileSync(process.execPath, [join(ROOT, "scripts", "pack.mjs"), "--worktree", "--out", tgz]);
  execFileSync("tar", ["-xzf", tgz, "-C", store]);
  const entryOf = await import(pathToFileURL(join(store, "am-sidebar", "pack", "part.mjs")).href);
  const partsOf = await import(pathToFileURL(join(store, "am-sidebar", "parts.mjs")).href);
  const run = (argv, select) => {
    const out = [];
    const ctx = partsOf.contextOf({ env: { ...m.env, AM_PART_DIR: join(store, select), AM_JSON: "1" }, log: () => {}, platform: "darwin" });
    return { code: entryOf.main(argv, { ctx, out: (l) => out.push(l) }), lines: out.map((l) => JSON.parse(l)) };
  };

  const d = run(["doctor", "herdr.pack"], "am-sidebar/pack");
  assert.equal(d.code, 0, JSON.stringify(d.lines.filter((c) => !c.ok)));
  assert.match(d.lines.find((c) => c.check === "pack-version").detail, /mods-disabled\/am-sidebar\/VERSION/);
  assert.match(d.lines.find((c) => c.check === "briefing-entry").detail, /\(not the pack's\)/);
  assert.equal(run(["doctor", "herdr.layout"], "am-sidebar/layout").code, 0);

  assert.equal(run(["uninstall", "herdr.layout"], "am-sidebar/layout").code, 0);
  assert.ok(!existsSync(join(m.app, "layouts", "automagik.json")));
  assert.equal(run(["uninstall", "herdr.pack"], "am-sidebar/pack").code, 0);
  assert.deepEqual(ls(m.mods), []);
  assert.deepEqual(ls(m.off), [], "the switched-off mods leave with the pack");
  const kept = readFileSync(join(m.app, "automagik-herdr", ".prev", ".pack"), "utf8");
  // am-automations and am-quota ship off, so they are among them (OFF_BY_DEFAULT).
  assert.match(kept, /^off=am-automations,am-quota,am-sidebar,am-tabs$/m, "the kept set says which were off");
  assert.equal(readFileSync(entry, "utf8"), "// am's briefing entry point\n", "am's briefing entry point stays");
  assert.equal(readlinkSync(link), join(am, "am.mjs"), "am's command stays");
  assert.equal(readMarker(m.mods), null);
  assert.equal(run(["doctor", "herdr.pack"], "am-sidebar/pack").code, 1, "not installed any more");
});

test("a plain copy of the repository (no .git) is refused in plain words, never packed from a guess", (t) => {
  const m = machine(t);
  const copy = join(m.dir, "copy");
  mkdirSync(join(copy, "herdr", "scripts"), { recursive: true });
  mkdirSync(join(copy, "herdr", "mods", "am-sidebar"), { recursive: true });
  writeFileSync(join(copy, "herdr", "scripts", "pack.mjs"), "");
  writeFileSync(join(copy, "herdr", "mods", "am-sidebar", "update.mjs"), "");
  assert.throws(() => packSource(m.ctx({ AM_PART_DIR: join(copy, "herdr", "mods", "am-footer") })), /is a copy of the repository, not a git checkout: am installs a herdr part from a git checkout \(git clone\) or a release/);
});

test("--purge keeps the hooks journal when the briefing entry point is am's, and drops it when it is the pack's", (t) => {
  for (const ams of [true, false]) {
    const m = machine(t);
    install(m.ctx(), P("herdr.pack"), packSource);
    if (ams) amEntry(m);
    const journal = join(m.app, "automagik-herdr", "hooks-journal.json");
    writeFileSync(journal, JSON.stringify({ version: 1, hooks: [] }));
    uninstall(m.ctx(), P("herdr.pack"), { purge: true });
    assert.equal(existsSync(journal), ams, ams ? "am's journal stays" : "the pack's journal goes");
    assert.ok(m.logs.some((l) => (ams ? /left the briefing hooks and their entry point: they are not the pack's/ : /removed the briefing hook's entry point/).test(l)));
  }
});

// #414: uninstall of one mod asks the layout Herdr shows, as the mod manager's off and remove do
// (#305): "layout" from `herdr-app status` (a fake in this machine's ~/.local/bin, never the real
// one), its tree from the app home's layouts/<name>.json.
function showing(m, layout) {
  mkdirSync(m.binDir, { recursive: true });
  const fake = join(m.binDir, "herdr-app");
  writeFileSync(fake, layout === null ? "#!/bin/sh\nexit 1\n"
    : `#!/bin/sh\n[ "$1" = status ] || exit 2\nprintf '{\\n  "layout": "%s",\\n  "zoom": false\\n}\\n' '${layout}'\n`);
  execFileSync("chmod", ["755", fake]);
}
const isOff = (m, mod) => existsSync(join(m.off, mod, "main.js")) && !existsSync(join(m.mods, mod));

test("uninstall of a mod the shown layout's blocks name is refused, naming the layout; the folder stays", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  assert.ok(existsSync(join(m.app, "layouts", "automagik.json")), "the pack's layout is in place");
  showing(m, "automagik");
  for (const mod of ["am-footer", "am-status", "am-tabs"]) {
    assert.throws(() => uninstall(m.ctx(), P(`herdr.${mod}`)),
      new RegExp(`^Error: ${mod} stays on: the automagik layout shows it, .*Switch layouts first \\(ctrl-shift-l\\), then uninstall it; from a terminal: herdr-app do layout\\.switch`));
    assert.ok(existsSync(join(m.mods, mod, "main.js")) && !existsSync(join(m.off, mod)), `${mod} stays in mods/`);
  }
  // The same through the entry am runs: exit 1, the message on stdout.
  const out = [];
  assert.equal(main(["uninstall", "herdr.am-footer"], { ctx: m.ctx({ AM_JSON: "1" }), out: (l) => out.push(l) }), 1);
  assert.match(JSON.parse(out[0]).detail, /^am-footer stays on: the automagik layout shows it/);
  assert.ok(m.calls.some((c) => c[0] === "herdr-app" && c[1] === "status"));
});

test("uninstall of a mod the shown layout doesn't name switches it off; the menu's mod goes with a note", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  showing(m, "automagik");
  const before = m.logs.length;
  assert.equal(uninstall(m.ctx(), P("herdr.am-new-menu")).changed, true);
  assert.ok(isOff(m, "am-new-menu"));
  assert.ok(!m.logs.slice(before).some((l) => /layout/.test(l)), m.logs.slice(before).join("\n"));
  // terminal_menu: Herdr warns and falls back to its own menu, the layout stays.
  assert.equal(uninstall(m.ctx(), P("herdr.am-markdown")).changed, true);
  assert.ok(isOff(m, "am-markdown"));
  assert.ok(m.logs.includes("am-markdown was the automagik layout's right-click menu: Herdr's own menu shows instead"), m.logs.join("\n"));
  // Another layout shown, one of the person's that names none of the pack: am-footer goes.
  writeFileSync(join(m.app, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "pane" } }] }));
  showing(m, "mine");
  assert.equal(uninstall(m.ctx(), P("herdr.am-footer")).changed, true);
  assert.ok(isOff(m, "am-footer"));
});

test("uninstall when the shown layout can't be read: the mod goes off, and the layouts that show it are named", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const warned = (mod, why) => m.logs.some((l) => l.startsWith(`switching ${mod} off without knowing the layout Herdr shows (${why}): automagik shows it`));
  // No herdr-app at all: this machine's PATH has none, so nothing reaches a running Herdr.
  assert.ok(!m.env.PATH.split(":").some((d) => existsSync(join(d, "herdr-app"))), m.env.PATH);
  assert.equal(uninstall(m.ctx(), P("herdr.am-footer")).changed, true);
  assert.ok(isOff(m, "am-footer"));
  assert.ok(warned("am-footer", "no herdr-app"), m.logs.join("\n"));
  // herdr-app status fails (Herdr not running).
  showing(m, null);
  assert.equal(uninstall(m.ctx(), P("herdr.am-status")).changed, true);
  assert.ok(warned("am-status", "herdr-app status gave no layout: is Herdr running?"), m.logs.join("\n"));
  // A layout named whose file is not readable JSON: fail open, said.
  writeFileSync(join(m.app, "layouts", "broken.json"), "{");
  showing(m, "broken");
  assert.equal(uninstall(m.ctx(), P("herdr.am-tabs")).changed, true);
  assert.ok(m.logs.some((l) => /^switching am-tabs off without knowing the layout Herdr shows \(.*broken\.json is unreadable/.test(l)), m.logs.join("\n"));
  // A mod no layout's block names: nothing said about layouts.
  const before = m.logs.length;
  uninstall(m.ctx(), P("herdr.am-new-menu"));
  assert.ok(!m.logs.slice(before).some((l) => /layout/.test(l)), m.logs.slice(before).join("\n"));
});

// #420: the whole pack's uninstall asks the shown layout before anything leaves, as one mod's does.
const packOn = (m) => PACK_MODS.filter((mod) => !OFF_BY_DEFAULT.includes(mod)).every((mod) => existsSync(join(m.mods, mod, "main.js")));

test("uninstall of the pack while the shown layout's blocks name its mods is refused; nothing moves", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const layout = join(m.app, "layouts", "automagik.json");
  const marker = join(m.app, "automagik-herdr", "installed-by-install.sh");
  showing(m, "automagik");
  assert.throws(() => uninstall(m.ctx(), P("herdr.pack")),
    /^Error: am-\S+ stays on: the automagik layout shows it, .*Switch layouts first \(ctrl-shift-l\), then uninstall the pack \(its blocks name .+ too\); from a terminal: herdr-app do layout\.switch/);
  assert.ok(packOn(m) && existsSync(layout) && existsSync(marker), "the pack, its layout and its record stay");
  // A layout of the person's that shows the sidebar: refused too, naming it.
  writeFileSync(join(m.app, "layouts", "main-agents.json"), JSON.stringify({ id: "root", children: [{ id: "s", content: { mod: "am-sidebar" } }] }));
  showing(m, "main-agents");
  assert.throws(() => uninstall(m.ctx(), P("herdr.pack")), /^Error: am-sidebar stays on: the main-agents layout shows it, .*then uninstall the pack; from a terminal/);
  assert.ok(packOn(m));
  // One that names none of the pack: the pack goes.
  writeFileSync(join(m.app, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "p", content: { mod: "pane" } }] }));
  showing(m, "mine");
  assert.equal(uninstall(m.ctx(), P("herdr.pack")).changed, true);
  assert.ok(!existsSync(join(m.mods, "am-sidebar")) && !existsSync(marker));
});

test("uninstall of the pack with no shown layout to read goes on, naming the person's layouts that show its mods", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  writeFileSync(join(m.app, "layouts", "main-agents.json"), JSON.stringify({ id: "root", children: [{ id: "s", content: { mod: "am-sidebar" } }] }));
  // A name with a path: the real reason, never "is Herdr running".
  showing(m, "../elsewhere");
  assert.equal(uninstall(m.ctx(), P("herdr.pack")).changed, true);
  const said = m.logs.find((l) => l.startsWith("uninstalling the pack without knowing the layout Herdr shows"));
  assert.ok(said, m.logs.join("\n"));
  assert.match(said, /\(Herdr shows the layout "\.\.\/elsewhere", a name with a path, so no file in .*layouts was read\): main-agents \(am-sidebar\) shows the pack's mods/);
  assert.doesNotMatch(said, /automagik \(/, "the pack's own layout, removed with it, is not listed");
  assert.ok(!m.logs.some((l) => /is Herdr running/.test(l)));
  assert.ok(!existsSync(join(m.mods, "am-sidebar")));
});

test("one mod's uninstall with a shown layout name holding a path gives that reason", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  showing(m, "sub/automagik");
  assert.equal(uninstall(m.ctx(), P("herdr.am-footer")).changed, true);
  assert.ok(m.logs.some((l) => l.startsWith('switching am-footer off without knowing the layout Herdr shows (Herdr shows the layout "sub/automagik", a name with a path')), m.logs.join("\n"));
});

// RFC 0012 delivery 7 decides how a fork takes a member's place; until then its folder changes nothing.
test("a fork's folder in mods/ doesn't lift the refusal: the member stays on, the layout's bytes don't change", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  showing(m, "automagik");
  mkdirSync(join(m.mods, "my-footer"), { recursive: true });
  writeFileSync(join(m.mods, "my-footer", "main.js"), "// a fork\n");
  writeFileSync(join(m.mods, "my-footer", "mod.json"), "{}\n");
  const layout = join(m.app, "layouts", "automagik.json");
  const before = readFileSync(layout);
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-footer")), /^Error: am-footer stays on: the automagik layout shows it/);
  assert.ok(existsSync(join(m.mods, "am-footer", "main.js")));
  assert.ok(readFileSync(layout).equals(before));
});

test("uninstall of the pack: a switched-off mod the shown layout names doesn't refuse it", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  showing(m, "automagik");
  uninstall(m.ctx(), P("herdr.am-new-menu"));
  assert.ok(isOff(m, "am-new-menu"));
  writeFileSync(join(m.app, "layouts", "mine.json"), JSON.stringify({ id: "root", children: [{ id: "n", content: { mod: "am-new-menu" } }] }));
  showing(m, "mine");
  assert.equal(uninstall(m.ctx(), P("herdr.pack")).changed, true);
  assert.ok(!existsSync(join(m.mods, "am-sidebar")));
});

// #430: `am uninstall herdr.layout` asks the shown layout as the mod manager's package remove does (#420).
test("uninstall of herdr.layout while Herdr shows it is refused, naming it and both ways to switch; nothing changes", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.layout"), packSource);
  const live = join(m.app, "layouts", "automagik.json");
  const before = readFileSync(live);
  for (const name of ["automagik", "Automagik"]) {
    showing(m, name);
    assert.throws(() => uninstall(m.ctx(), P("herdr.layout")), (e) => e.message === `the ${name} layout is this package's (layouts/automagik.json) `
      + "and Herdr shows it: removing the package takes it away (plain Herdr instead). Switch layouts first (ctrl-shift-l), "
      + `then uninstall it; from a terminal: herdr-app do layout.switch '{"name":"main"}'`);
    assert.ok(readFileSync(live).equals(before), "the layout's bytes don't change");
    assert.equal(readMarker(m.mods).layout, "added");
  }
  // The same through the entry am runs: exit 1, the message on stdout.
  showing(m, "automagik");
  const out = [];
  assert.equal(main(["uninstall", "herdr.layout"], { ctx: m.ctx({ AM_JSON: "1" }), out: (l) => out.push(l) }), 1);
  assert.match(JSON.parse(out[0]).detail, /^the automagik layout is this package's \(layouts\/automagik\.json\) and Herdr shows it/);
  assert.ok(readFileSync(live).equals(before));
  // A copy that is yours is left whatever is shown: never refused, never removed.
  writeFileSync(live, "{\"mine\": true}\n");
  assert.match(uninstall(m.ctx(), P("herdr.layout")).detail, /it is yours, left as it is/);
  assert.equal(readFileSync(live, "utf8"), "{\"mine\": true}\n");
});

test("uninstall of herdr.layout while Herdr shows another layout removes it, main included", (t) => {
  for (const shown of ["main", "mine"]) {
    const m = machine(t);
    install(m.ctx(), P("herdr.layout"), packSource);
    const live = join(m.app, "layouts", "automagik.json");
    showing(m, shown);
    assert.equal(uninstall(m.ctx(), P("herdr.layout")).changed, true);
    assert.ok(!existsSync(live), shown);
    assert.equal(readMarker(m.mods).layout, "removed");
    assert.ok(m.logs.includes(`removed ${live}`), m.logs.join("\n"));
  }
});

test("uninstall of herdr.layout when the shown layout can't be read goes on, saying why and how to switch back", (t) => {
  const removed = (m, why) => m.logs.includes(`removed ${join(m.app, "layouts", "automagik.json")} without knowing the layout Herdr shows (${why}); `
    + `if Herdr shows it, switch layouts (ctrl-shift-l); from a terminal: herdr-app do layout.switch '{"name":"main"}'`);
  // No herdr-app at all: this machine's PATH has none.
  const a = machine(t);
  install(a.ctx(), P("herdr.layout"), packSource);
  assert.ok(!a.env.PATH.split(":").some((d) => existsSync(join(d, "herdr-app"))), a.env.PATH);
  assert.equal(uninstall(a.ctx(), P("herdr.layout")).changed, true);
  assert.ok(!existsSync(join(a.app, "layouts", "automagik.json")));
  assert.ok(removed(a, "no herdr-app"), a.logs.join("\n"));
  // herdr-app status fails (Herdr not running).
  const b = machine(t);
  install(b.ctx(), P("herdr.layout"), packSource);
  showing(b, null);
  assert.equal(uninstall(b.ctx(), P("herdr.layout")).changed, true);
  assert.ok(!existsSync(join(b.app, "layouts", "automagik.json")));
  assert.ok(removed(b, "herdr-app status gave no layout: is Herdr running?"), b.logs.join("\n"));
});

test("the refusal leaves out the layout.switch command while main is the layout in the way", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  writeFileSync(join(m.app, "layouts", "main.json"), JSON.stringify({ id: "root", children: [{ id: "s", content: { mod: "am-sidebar" } }] }));
  showing(m, "main");
  assert.throws(() => uninstall(m.ctx(), P("herdr.pack")), (e) => /^am-sidebar stays on: the main layout shows it, .*then uninstall the pack$/.test(e.message));
  assert.ok(existsSync(join(m.mods, "am-sidebar", "main.js")));
});

// ---- #494: a linked mods/ is the person's folder: nothing moves through it, and the refusal says why ----

/** The pack installed, then mods/ made a link to a folder outside the app home (the folders inside it). */
function linkedMods(t) {
  const m = machine(t);
  install(m.ctx(), P("herdr.pack"), packSource);
  const ext = join(m.dir, "their-mods");
  renameSync(m.mods, ext);
  symlinkSync(ext, m.mods);
  return { m, ext, prev: join(m.app, "automagik-herdr", ".prev") };
}
/** The refusal's exact words (layoutSafe.mjs linkedModsLine), written out so a changed line fails here. */
const linkedLine = (mods, to) => `mods/ (${mods}) is a link to ${to}, your own folder, not one this install made: nothing is moved `
  + "through it, and the folders in it stay as they are. Put that folder in the link's place (a plain mods/), then run this again";

for (const purge of [false, true]) {
  test(`am uninstall herdr.pack${purge ? " --purge" : ""} with a linked mods/: refused in the CLI's output, nothing moves, the record stays (#494)`, (t) => {
    const { m, ext, prev } = linkedMods(t);
    const before = readdirSync(ext).sort();
    const record = readMarker(m.mods);
    const out = [];
    assert.equal(main(["uninstall", "herdr.pack", ...(purge ? ["--purge"] : [])], { ctx: m.ctx(), out: (l) => out.push(l) }), 1);
    assert.deepEqual(out, [linkedLine(m.mods, ext)]);
    assert.deepEqual(readdirSync(ext).sort(), before, "every folder in the linked mods/ stays");
    assert.equal(existsSync(prev), false, "nothing went into the kept set");
    assert.deepEqual(readMarker(m.mods), record, "the record stays");
    assert.ok(existsSync(join(m.app, "layouts", "automagik.json")), "the layout stays");
  });
}

/** Every folder under `dir`, sorted, as paths relative to it (what a move would change). */
const folders = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

for (const purge of [false, true]) {
  test(`am uninstall herdr.pack${purge ? " --purge" : ""}, every pack mod switched off and one adopted, linked mods/: refused before anything (#494 L1)`, (t) => {
    const { m, ext, prev } = linkedMods(t);
    // Every pack folder off (in mods-disabled/, beside the link), and one the install adopted, kept in backup/.
    mkdirSync(m.off, { recursive: true });
    for (const x of readdirSync(ext)) renameSync(join(ext, x), join(m.off, x));
    const record = readMarker(m.mods);
    writeMarker(m.mods, { ...record, adopted: [{ mod: "am-tabs", path: "backup/am-tabs-old" }] });
    mkdirSync(join(m.app, "automagik-herdr", "backup", "am-tabs-old"), { recursive: true });
    writeFileSync(join(m.app, "automagik-herdr", "backup", "am-tabs-old", "main.js"), "// mine\n");
    const before = { off: folders(m.off), ext: folders(ext), record: readMarker(m.mods) };
    assert.throws(() => uninstall(m.ctx(), P("herdr.pack"), { purge }), (e) => e.message === linkedLine(m.mods, ext));
    assert.deepEqual(folders(m.off), before.off, "every switched-off folder stays");
    assert.deepEqual(folders(ext), before.ext, "nothing went into the linked mods/");
    assert.ok(existsSync(join(m.app, "layouts", "automagik.json")), "the layout stays");
    assert.equal(existsSync(prev), false, "nothing went into the kept set");
    assert.ok(existsSync(join(m.app, "automagik-herdr", "backup", "am-tabs-old", "main.js")), "the adopted folder stays in backup/");
    assert.deepEqual(readMarker(m.mods), before.record, "the record stays");
  });
}

test("am install herdr.am-tabs, switched off, with a linked mods/: refused, it stays in mods-disabled/ (#494 L3)", (t) => {
  const { m, ext } = linkedMods(t);
  mkdirSync(m.off, { recursive: true });
  renameSync(join(ext, "am-tabs"), join(m.off, "am-tabs"));
  const before = folders(ext);
  assert.throws(() => install(m.ctx(), P("herdr.am-tabs"), packSource), (e) => e.message === linkedLine(m.mods, ext));
  assert.ok(existsSync(join(m.off, "am-tabs", "main.js")), "still off, where it was");
  assert.deepEqual(folders(ext), before, "nothing went into the linked mods/");
});

test("am uninstall herdr.am-tabs with a linked mods/: refused, it stays in mods/, nothing in mods-disabled/ (#494)", (t) => {
  const { m, ext } = linkedMods(t);
  assert.throws(() => uninstall(m.ctx(), P("herdr.am-tabs")), (e) => e.message === linkedLine(m.mods, ext));
  assert.ok(existsSync(join(ext, "am-tabs", "main.js")));
  assert.equal(existsSync(join(m.off, "am-tabs")), false);
});

test("doctor reports which briefing a project's hook runs: the pack's stable entry, am's entry, or none", (t) => {
  const m = machine(t);
  writeFileSync(join(m.app, "keys.json"), "{}\n");
  install(m.ctx(), P("herdr.pack"), packSource);
  const project = join(m.dir, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const file = join(project, ".claude", "settings.local.json");
  const settings = (command) => writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } }, null, 2));
  const check = () => doctor(contextOf({ env: m.env, exec: noExec, log: () => {}, platform: "darwin", project }), P("herdr.pack"))
    .checks.find((c) => c.check === "briefing-hook");
  settings(hookCommand(m.app));
  const packHook = check();
  assert.equal(packHook.ok, true, packHook.detail);
  assert.match(packHook.detail, /the pack's stable entry \(.*briefing\.mjs\) in .*settings\.local\.json$/);
  // A CLI-only hook: am's own entry, named with its path.
  const store = join(m.home, ".automagik", "parts", "automagik.am");
  mkdirSync(join(store, "current", "bin"), { recursive: true });
  writeFileSync(join(store, "current", "bin", "run.sh"), "#!/bin/sh\n");
  writeFileSync(join(store, "current", "briefingEntry.mjs"), "// am's entry\n");
  settings(amPartHookCommand(m.app, store));
  const amHook = check();
  assert.equal(amHook.ok, true, amHook.detail);
  assert.match(amHook.detail, /am's entry \(.*briefingEntry\.mjs\) in .*settings\.local\.json$/);
  rmSync(join(store, "current", "briefingEntry.mjs"));
  const broken = check();
  assert.equal(broken.ok, false);
  assert.equal(broken.fix, "am self install");
  // No briefing hook at all: none; with neither installed, the detail says so plainly.
  writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2));
  const none = check();
  assert.equal(none.ok, true);
  assert.match(none.detail, /none: .*settings\.local\.json has no briefing hook$/);
  rmSync(join(m.app, "automagik-herdr", "briefing.mjs"));
  rmSync(join(m.mods, "am-sidebar", "briefing.mjs"));
  const neither = check();
  assert.equal(neither.ok, true, "a note, as am self doctor says it (#815)");
  assert.match(neither.detail, /; neither the pack's entry \(.*\) nor am's entry \(.*\) is installed$/);
  // #815: a malformed settings file is that project's state: named, and the doctor goes on.
  writeFileSync(file, "{ not json");
  const run = () => doctor(contextOf({ env: m.env, exec: noExec, log: () => {}, platform: "darwin", project }), P("herdr.pack"));
  const bad = run().checks.find((c) => c.check === "briefing-hook");
  assert.equal(bad.ok, true);
  assert.match(bad.detail, /^not checked: .*settings\.local\.json is not valid JSON \(.*\), so this project's briefing hook could not be read$/);
  assert.ok(run().checks.findIndex((c) => c.check === "briefing-hook") < run().checks.length - 1, "the checks after it still ran");
  // An am entry under another am home than this host's is not this host's hook (#815).
  const elsewhere = join(m.dir, "elsewhere", "parts", "automagik.am");
  mkdirSync(join(elsewhere, "current", "bin"), { recursive: true });
  writeFileSync(join(elsewhere, "current", "bin", "run.sh"), "#!/bin/sh\n");
  writeFileSync(join(elsewhere, "current", "briefingEntry.mjs"), "// another am's entry\n");
  settings(amPartHookCommand(m.app, elsewhere));
  assert.match(check().detail, /^none: .*settings\.local\.json has no briefing hook/);
});


test("#805 pack doctor describes the supported restart path", (t) => {
  const m = machine(t);
  const note = doctorOf(m, "herdr.pack").checks.find((l) => l.check === "restart-path");
  assert.ok(note);
  assert.equal(note.ok, true);
  assert.match(note.detail, /with am restart <bot>, never \/restart/);
});
