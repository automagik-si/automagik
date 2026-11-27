import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { skillHash, textSkillFields, textSkillMd as writerTextSkillMd } from "../../apps/bots-dsh/src/host/skill-library-rules.js";
import { startFakeCore } from "./fake-core.mjs";
import { scratchRoot } from "./scratch-project.mjs";
import { startRow, workerTaskText, WORKER_DONE_LINE, WORKER_OWNER_QUESTION_LINE } from "../mods/am-sidebar/workers.js";
import { bindWorkerSkillTeam, readWorkerSkills, skillMdHash, textSkillMd, workerSkillCatalog, workerSkillLines } from "../mods/am-sidebar/workerSkills.mjs";

const BOT = "session-11111111-1111-4111-8111-111111111111";
const HEADING = "Your skills (load one with: am skill <name>):";
const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const oracle = bytes => skillHash([{ path: "SKILL.md", bytes }]);
const ownMode = { mode: 0o600 };

function record(name, content = "test body", description = "Test description", frontmatter) {
  const bytes = frontmatter === undefined ? writerTextSkillMd({ name, description, content }) : Buffer.from(frontmatter);
  const hash = oracle(bytes);
  return { name, content, description, hash, source: frontmatter === undefined ? { kind: "text" } : { kind: "file", fileName: "test.markdown" },
    ...(frontmatter === undefined ? {} : { frontmatter }), check: { verdict: "pass" },
    review: { status: "done", hash, findings: [] }, reviewSeal: "a".repeat(64) };
}

function publication(home, records = [record("notes"), record("memo")]) {
  const folder = join(home, "skills/.bots");
  const library = join(home, "skill-library/library.json");
  const snapshot = join(folder, BOT + ".json");
  const key = join(home, "skill-review.key");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(home, "skill-library"), { mode: 0o700 });
  const active = records.map(({ name }) => ({ name, mode: name === "memo" ? "manual" : "automatic" }));
  const skills = records.map(({ name, description, hash }, i) => ({ name, hash, mode: active[i].mode,
    ...(active[i].mode === "automatic" ? { description } : {}) }));
  const snapshotData = { version: 1, botId: BOT, skills };
  const data = { version: 1, skills: Object.fromEntries(records.map(row => [row.name, row])), active: { [BOT]: active }, reviewBlocks: {} };
  const writeLibrary = () => fs.writeFileSync(library, JSON.stringify(data), ownMode);
  const writeSnapshot = () => {
    fs.rmSync(snapshot, { force: true });
    fs.writeFileSync(snapshot, JSON.stringify(snapshotData, null, 2) + "\n", { mode: 0o444 });
  };
  fs.writeFileSync(key, Buffer.alloc(32), ownMode);
  writeLibrary();
  writeSnapshot();
  for (let i = 0; fs.lstatSync(snapshot, { bigint: true }).ctimeNs <= fs.lstatSync(key, { bigint: true }).ctimeNs; i++) {
    assert.ok(i < 50);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    writeSnapshot();
  }
  const { team } = bindWorkerSkillTeam(BOT, { env: { AUTOMAGIK_BOTS_HOME: home } });
  return { team, data, snapshotData, folder, library, snapshot, key, writeSnapshot, writeLibrary };
}

function read(p, options) {
  return readWorkerSkills(BOT, { team: p.team, name: "notes", ...options });
}

function unavailable(result) {
  assert.deepEqual(result.entries, []);
  assert.deepEqual(workerSkillLines(result.entries), []);
  assert.equal(workerSkillCatalog(result.entries), "");
  assert.equal(result.body, undefined);
}

test("#2085 U1: the publication contributes only Automatic metadata", t => {
  const p = publication(scratchRoot(t, "hb-skill-u1-"));
  assert.equal(workerSkillCatalog(read(p).entries), HEADING + "\nnotes: Test description");
  assert.deepEqual(workerSkillLines(read(p).entries), ["notes: Test description"]);
});

test("#2085 U2: worker task text keeps both fixed lines and excludes Hermes", () => {
  const base = `do it\n\n${WORKER_OWNER_QUESTION_LINE}\n\n${WORKER_DONE_LINE}`;
  const catalog = HEADING + "\nnotes: Test description";
  assert.equal(workerTaskText("do it", "claude", ""), base);
  assert.equal(workerTaskText("do it", "claude", catalog),
    `do it\n\n${catalog}\n\n${WORKER_OWNER_QUESTION_LINE}\n\n${WORKER_DONE_LINE}`);
  assert.equal(workerTaskText("do it", "hermes", catalog), `do it\n\n${WORKER_DONE_LINE}`);
});

test("#2085 U3: refused publications never return a partial catalog", async t => {
  const cases = {
    "symlinked file": p => { fs.renameSync(p.snapshot, p.snapshot + ".original"); fs.symlinkSync(p.snapshot + ".original", p.snapshot); },
    "0644 file": p => fs.chmodSync(p.snapshot, 0o644),
    "hard link": p => fs.linkSync(p.snapshot, p.snapshot + ".copy"),
    "foreign ownership": () => ({ uid: process.getuid() + 1 }),
    "0755 directory": p => fs.chmodSync(p.folder, 0o755),
    "symlinked directory": p => { fs.renameSync(p.folder, p.folder + ".original"); fs.symlinkSync(p.folder + ".original", p.folder); },
    "bad JSON": p => { fs.rmSync(p.snapshot); fs.writeFileSync(p.snapshot, "{", { mode: 0o444 }); },
    "fatal UTF-8": p => { fs.rmSync(p.snapshot); fs.writeFileSync(p.snapshot, Buffer.from([255]), { mode: 0o444 }); },
    "wrong version": p => { p.snapshotData.version = 2; p.writeSnapshot(); },
    "wrong Bot": p => { p.snapshotData.botId = "different-bot"; p.writeSnapshot(); },
    "extra content": p => { p.snapshotData.skills[0].content = "text"; p.writeSnapshot(); },
    "multiline description": p => { p.snapshotData.skills[0].description = "one\ntwo"; p.writeSnapshot(); },
    "manual description": p => { p.snapshotData.skills[1].description = "manual"; p.writeSnapshot(); },
    "duplicate name": p => { p.snapshotData.skills.push(p.snapshotData.skills[0]); p.writeSnapshot(); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, sub => {
    const p = publication(scratchRoot(sub, "hb-skill-u3-"));
    const options = change(p);
    if (options?.uid) {
      const selection = bindWorkerSkillTeam(BOT, { uid: options.uid, env: { AUTOMAGIK_BOTS_HOME: p.team.path } });
      assert.equal(selection.team, undefined);
      assert.match(selection.warning, /owned team directory/);
      unavailable(read(p, options));
    } else {
      const result = read(p);
      unavailable(result);
      assert.match(result.warning, /Bot skills at /);
    }
  });
});

test("#2085 U4: default, explicit empty, ambiguous and absent homes", t => {
  const home = scratchRoot(t, "hb-skill-u4-");
  const env = { AUTOMAGIK_BOTS_HOME: "   " };
  assert.deepEqual(bindWorkerSkillTeam(BOT, { home, env }), { team: undefined });
  const a = publication(join(home, ".automagik/desktop/bots"));
  fs.mkdirSync(join(home, "explicit"));
  assert.deepEqual(bindWorkerSkillTeam(BOT, { home, env }).team, a.team);
  const empty = bindWorkerSkillTeam(BOT, { home, env: { AUTOMAGIK_BOTS_HOME: "~/explicit" } }).team;
  assert.equal(empty.path, join(home, "explicit"));
  unavailable(readWorkerSkills(BOT, { team: empty, name: "notes" }));
  publication(join(home, ".automagik/bots"));
  const ambiguous = bindWorkerSkillTeam(BOT, { home, env });
  assert.equal(ambiguous.team, undefined);
  assert.match(ambiguous.warning, /more than one team/);
});

test("#2085 U5: a large valid library remains discoverable beyond the bounded prompt", t => {
  const root = scratchRoot(t, "hb-skill-u5-");
  const home = join(root, "team");
  const desc = "界".repeat(200);
  const records = Array.from({ length: 2000 }, (_, index) => record("skill" + index, "b".repeat(62 * 1024), desc));
  const p = publication(home, records);
  assert.ok(fs.statSync(p.snapshot).size > 1024 * 1024);
  assert.ok(fs.statSync(p.library).size > 64 * 1024 * 1024);
  const expected = records.map(({ name }) => `${name}: ${desc}`);
  const current = read(p, { name: "skill1999" });
  assert.deepEqual(workerSkillLines(current.entries), expected);
  assert.equal(current.body, records.at(-1).content);
  const catalog = workerSkillCatalog(current.entries);
  const lines = catalog.split("\n");
  assert.ok(Buffer.byteLength(catalog) <= 32 * 1024);
  assert.equal(lines.at(-1), `${expected.length - (lines.length - 2)} more: run am skill to list them all.`);
  assert.equal(workerSkillCatalog(current.entries.slice(0, 3)), [HEADING, ...expected.slice(0, 3)].join("\n"));

  const app = join(root, "app"), bin = join(root, "bin");
  const state = join(root, "hc.json"), log = join(root, "hc.log");
  fs.mkdirSync(join(app, "automagik-herdr"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(state, JSON.stringify({ terminals: [{ address: "t100", created_ms: 17, state: "live" }] }));
  fs.writeFileSync(log, "");
  fs.writeFileSync(join(app, "automagik-herdr/workers.jsonl"), JSON.stringify(startRow({ kind: "worker", core: "fakecore0000",
    terminal: "t100", createdMs: 17, botId: BOT, skillTeam: p.team })) + "\n", ownMode);
  const env = { ...process.env, HOME: root, HERDR_APP_HOME: app, PATH: `${bin}:${process.env.PATH}`,
    HC_FAKE_STATE: state, HC_FAKE_LOG: log, HC_TERMINAL_ID: "t100", AUTOMAGIK_HERDR_TEST_ROOTS: root };
  const core = startFakeCore(t, env);
  const list = spawnSync(process.execPath, [CLI, "skill"], { env: { ...env, ...core.env, HC_SOCKET: core.env.AUTOMAGIK_HERDR_CORE_SOCKET },
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, expected.join("\n") + "\n");
});

test("#2085 U6: match the writer's exact SKILL.md hash and reviewed body", t => {
  const typed = ["plain", '"quotes"', "line\u2028separator", "😀"].map((body, i) => record("type" + i, body));
  const imported = record("imported", "literal body\nsecond line", "Folded description",
    "---\r\n# comment\r\nname: imported\r\ndescription: >\r\n  Folded\r\n  description\r\nlicense: MIT\r\n---\r\n\r\nliteral body\r\nsecond line\r\n");
  const p = publication(scratchRoot(t, "hb-skill-u6-"), [...typed, imported]);
  for (const row of typed) {
    const bytes = textSkillMd(row);
    assert.deepEqual(bytes, writerTextSkillMd(row));
    assert.equal(skillMdHash(bytes), oracle(bytes));
    assert.deepEqual(textSkillFields(bytes), { name: row.name, description: row.description, body: row.content });
  }
  assert.equal(skillMdHash(Buffer.from(imported.frontmatter)), imported.hash);
  for (const row of [...typed, imported]) assert.equal(read(p, { name: row.name }).body, row.content);
});

const stale = {
  a: p => { p.data.active[BOT].shift(); p.writeLibrary(); },
  b: p => { p.data.active[BOT][0].mode = "manual"; p.writeLibrary(); },
  c: p => { p.data.reviewBlocks[p.data.skills.notes.hash] = {}; p.writeLibrary(); },
  d: p => { delete p.data.skills.notes.review; p.writeLibrary(); },
  e: p => { p.data.skills.notes.review.findings.push({ area: "scripts-binaries" }); p.writeLibrary(); },
  f: p => fs.rmSync(p.key),
  g: p => {
    fs.writeFileSync(p.key + ".replacement", Buffer.alloc(32, 1), ownMode);
    fs.renameSync(p.key + ".replacement", p.key);
    for (let i = 0; fs.lstatSync(p.key, { bigint: true }).ctimeNs <= fs.lstatSync(p.snapshot, { bigint: true }).ctimeNs; i++) {
      assert.ok(i < 50);
      fs.utimesSync(p.key, 0, 0);
    }
  },
  "note 1 duplicate": p => { p.data.active[BOT].push(p.data.active[BOT][0]); p.writeLibrary(); },
  "note 1 source kind": p => { p.data.skills.notes.source = { kind: "unknown" }; p.writeLibrary(); },
  "note 1 source filename": p => { p.data.skills.notes.source = { kind: "file", fileName: "../skill.md" }; p.writeLibrary(); },
  "note 2 invalid size": p => fs.truncateSync(p.key, 31),
  "note 2 invalid mode": p => fs.chmodSync(p.key, 0o644),
  "note 2 invalid link": p => fs.linkSync(p.key, p.key + ".other"),
};
for (const [name, change] of Object.entries(stale)) test(`#2085 U7${name}: refuse a retained publication`, t => {
  const p = publication(scratchRoot(t, "hb-skill-u7-"));
  assert.equal(read(p).body, "test body", "valid control");
  change(p);
  if (name.startsWith("note 2 invalid")) {
    for (let i = 0; fs.lstatSync(p.snapshot, { bigint: true }).ctimeNs <= fs.lstatSync(p.key, { bigint: true }).ctimeNs; i++) {
      assert.ok(i < 50);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      p.writeSnapshot();
    }
  }
  unavailable(read(p));
});

test("#2085 U7h: retry one replacement and refuse repeated replacements", t => {
  for (const repeated of [false, true]) {
    const p = publication(scratchRoot(t, "hb-skill-u7h-"));
    let reads = 0, libraryFd;
    const io = { ...fs,
      openSync(path, flags) {
        const fd = fs.openSync(path, flags);
        libraryFd = path === p.library ? fd : undefined;
        return fd;
      },
      readFileSync(fd) {
        const bytes = fs.readFileSync(fd);
        if (fd === libraryFd && (++reads === 1 || repeated)) {
          p.data.active[BOT].shift();
          fs.writeFileSync(p.library + ".replace", JSON.stringify(p.data), ownMode);
          fs.renameSync(p.library + ".replace", p.library);
        }
        return bytes;
      },
    };
    const result = read(p, { fs: io });
    unavailable(result);
    assert.equal(reads, 2);
    if (repeated) assert.match(result.warning, /changed while it was read/);
    else assert.equal(result.warning, undefined);
  }
});

test("#2085 U7 note 2: timestamps must have an order and the key is metadata only", t => {
  const p = publication(scratchRoot(t, "hb-skill-key-"));
  let keyContentReads = 0;
  const io = { ...fs, openSync(path, flags) {
    if (path === p.key) { keyContentReads++; throw new Error("key content is off limits"); }
    return fs.openSync(path, flags);
  } };
  assert.equal(read(p, { fs: io }).body, "test body");
  const snapshotTime = fs.lstatSync(p.snapshot, { bigint: true }).ctimeNs;
  io.lstatSync = (path, options) => {
    const info = fs.lstatSync(path, options);
    if (path === p.key) info.ctimeNs = snapshotTime;
    return info;
  };
  unavailable(read(p, { fs: io }));
  assert.equal(keyContentReads, 0);
});

test("#2085 U8: start rows carry an additive physical team binding", () => {
  const row = { kind: "worker", terminal: "t1", pid: 10, botId: BOT, core: "test", createdMs: 1 };
  const skillTeam = { path: "/test/team", dev: "1", ino: "23" };
  assert.deepEqual(startRow({ ...row, skillTeam }).skillTeam, skillTeam);
  assert.equal(Object.hasOwn(startRow(row), "skillTeam"), false);
});
