// Lock (b), the file-owner proof: the shapes of the VM run sheet that one uid can show, and fault
// injection on every file system call of the peer path. Every failure is one plain refusal line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { PeerProof } from "../runner/locks.mjs";
import { Refusal } from "../runner/proto.mjs";
import { base, proofAttempt } from "./runner-helpers.mjs";

async function proofServer(t, { ttlMs = 250, dshUid = process.getuid() } = {}) {
  const root = base(t);
  const proofs = join(root, "proofs");
  mkdirSync(proofs);
  chmodSync(proofs, 0o1730);
  const lines = [];
  const proof = new PeerProof({ dir: proofs, dshUid, ttlMs, fs, log: (line) => lines.push(line) });
  proof.prepare();
  const socket = join(root, "sock");
  mkdirSync(socket);
  chmodSync(socket, 0o750);
  const server = createServer((conn) => {
    conn.on("error", () => {});
    proof.challenge(conn).catch(() => {});
  });
  await new Promise((resolve) => server.listen(join(socket, "runner.sock"), resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { root, proofs, socket: join(socket, "runner.sock"), proof, lines };
}

test("a peer that makes an empty regular file of the sent name is served once", async (t) => {
  const s = await proofServer(t);
  const result = await proofAttempt(s.socket, s.proofs, { ttlMs: 250 });
  assert.equal(result.verdict, "ok");
  assert.deepEqual(s.lines, []);
  assert.equal(readFileSync(join(s.proofs, ".clock")).length, 0);
});

test("a symlink, a hard link, a wrong name and a non-empty file are refused", async (t) => {
  const s = await proofServer(t);
  assert.equal((await proofAttempt(s.socket, s.proofs, { attack: "symlink" })).verdict, "refused: the proof is not a regular file");
  assert.equal((await proofAttempt(s.socket, s.proofs, { attack: "hardlink" })).verdict, "refused: the proof has more than one link");
  assert.equal((await proofAttempt(s.socket, s.proofs, { attack: "wrong-name" })).verdict, "refused: no proof file");
  assert.equal((await proofAttempt(s.socket, s.proofs, { attack: "nonempty" })).verdict, "refused: the proof is not empty");
});

test("silence and a late proof are refused after the three-second rule, here shortened", async (t) => {
  const s = await proofServer(t);
  const silent = await proofAttempt(s.socket, s.proofs, { attack: "silent", ttlMs: 250 });
  assert.equal(silent.verdict, "refused: no proof in time");
  const late = await proofAttempt(s.socket, s.proofs, { attack: "late", ttlMs: 250 });
  assert.equal(late.verdict, "refused: no proof in time");
});

test("a proof owned by another uid is refused", async (t) => {
  const s = await proofServer(t, { dshUid: process.getuid() + 4242 });
  const result = await proofAttempt(s.socket, s.proofs);
  assert.equal(result.verdict, `refused: the proof is owned by uid ${process.getuid()}`);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0], /^refused: /);
});

test("a name is used once: replaying an old name gets no proof file", async (t) => {
  const s = await proofServer(t);
  const first = await proofAttempt(s.socket, s.proofs);
  assert.equal(first.verdict, "ok");
  assert.ok(first.name);
  const second = await new Promise((resolve, reject) => {
    const conn = connect(s.socket);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n")).trim();
      if (line.startsWith("refused:")) {
        conn.end();
        resolve({ verdict: line });
        return;
      }
      writeFileSync(join(s.proofs, first.name), "", { flag: "wx", mode: 0o600 });
      conn.write("done\n");
      buffer = buffer.slice(buffer.indexOf("\n") + 1);
    });
    conn.on("error", reject);
  });
  assert.equal(second.verdict, "refused: no proof file");
});

test("strays are swept at prepare and after a verdict, and the marker stays", async (t) => {
  const root = base(t);
  const proofs = join(root, "proofs");
  mkdirSync(proofs);
  chmodSync(proofs, 0o1730);
  writeFileSync(join(proofs, "stray-a"), "");
  writeFileSync(join(proofs, "stray-b"), "");
  const proof = new PeerProof({ dir: proofs, dshUid: process.getuid(), fs });
  proof.prepare();
  assert.deepEqual(fs.readdirSync(proofs).sort(), [".clock"]);
  writeFileSync(join(proofs, "stray-c"), "");
  proof.sweep();
  assert.deepEqual(fs.readdirSync(proofs).sort(), [".clock"]);
});

test("a file made before the name was sent is refused (ctime against the marker)", async (t) => {
  const s = await proofServer(t);
  const name = "a".repeat(48);
  writeFileSync(join(s.proofs, name), "");
  const ctimeNs = fs.lstatSync(join(s.proofs, name), { bigint: true }).ctimeNs;
  assert.throws(() => s.proof.verifyFile(name, ctimeNs + 1n), (error) => {
    assert.ok(error instanceof Refusal);
    assert.equal(error.message, "the proof was made before the name was sent");
    return true;
  });
});

test("the marker itself must be the runner's regular, single-linked file", (t) => {
  const root = base(t);
  const proofs = join(root, "proofs");
  mkdirSync(proofs);
  chmodSync(proofs, 0o1730);
  const target = join(root, "target");
  writeFileSync(target, "");
  fs.symlinkSync(target, join(proofs, ".clock"));
  assert.throws(() => new PeerProof({ dir: proofs, dshUid: process.getuid(), fs }).prepare(), /proof marker/);
  fs.rmSync(join(proofs, ".clock"), { force: true });
  writeFileSync(join(proofs, ".clock"), "");
  fs.linkSync(join(proofs, ".clock"), join(proofs, "other"));
  assert.throws(() => new PeerProof({ dir: proofs, dshUid: process.getuid(), fs }).prepare(), /proof marker/);
});

test("prepare refuses when the proof folder or its marker cannot be made", (t) => {
  const root = base(t);
  const proofs = join(root, "proofs");
  mkdirSync(proofs);
  const broken = (patch) => {
    const api = Object.create(fs);
    Object.assign(api, patch);
    return new PeerProof({ dir: proofs, dshUid: process.getuid(), fs: api });
  };
  assert.throws(() => broken({ openSync: () => { throw new Error("open failed"); } }).prepare(), /open failed/);
  const missing = join(root, "nope");
  assert.throws(
    () => new PeerProof({ dir: missing, dshUid: process.getuid(), fs }).prepare(),
    /does not exist/,
  );
});

/** One fault on the peer path: a plain refusal line, a one-line log, no stack. */
async function fault(t, { patch, create, stray }) {
  const root = base(t);
  const proofs = join(root, "proofs");
  mkdirSync(proofs);
  chmodSync(proofs, 0o1730);
  const lines = [];
  const proof = new PeerProof({ dir: proofs, dshUid: process.getuid(), ttlMs: 120, fs, log: (line) => lines.push(line) });
  proof.prepare();
  if (stray) writeFileSync(join(proofs, "stray-file"), "");
  const api = Object.create(fs);
  Object.assign(api, patch(proofs));
  proof.fs = api;
  const handlers = {};
  const conn = {
    destroyed: false,
    writes: [],
    ended: false,
    once(event, cb) {
      handlers[event] = cb;
    },
    on(event, cb) {
      handlers[event] = cb;
    },
    off(event) {
      delete handlers[event];
    },
    write(text) {
      this.writes.push(text);
    },
    end() {
      this.ended = true;
    },
    fire(event, value) {
      handlers[event]?.(value);
    },
  };
  const running = proof.challenge(conn);
  const name = conn.writes.find((text) => !text.startsWith("refused:"))?.trim();
  if (create && name !== undefined) {
    writeFileSync(join(proofs, name), "");
    conn.fire("data", Buffer.from("done\n"));
  }
  await running;
  const refused = conn.writes.filter((text) => text.startsWith("refused:"));
  assert.equal(refused.length, 1, `${refused.join("|")}`);
  assert.ok(!refused[0].replace(/\n$/, "").includes("\n"), "one line on the wire");
  assert.ok(lines.length >= 1, "one log line");
  assert.ok(lines.every((line) => line.startsWith("refused: ")), lines.join("|"));
  return { lines, conn, proofs };
}

test("every peer-path file system call is caught into a plain refusal, never a stack", async (t) => {
  const cases = [
    ["the marker's utimes", { patch: () => ({ utimesSync: () => { throw new Error("utimes failed"); } }) }],
    ["the marker's lstat", { patch: (p) => ({ lstatSync: (path, options) => {
      if (path === join(p, ".clock")) throw new Error("marker lstat failed");
      return fs.lstatSync(path, options);
    } }) }],
    ["the marker's missing", { patch: (p) => ({ lstatSync: (path, options) => {
      if (path === join(p, ".clock")) return null;
      return fs.lstatSync(path, options);
    } }) }],
    ["the proof's lstat", { patch: (p) => ({ lstatSync: (path, options) => {
      if (path !== join(p, ".clock") && path.startsWith(p + "/")) throw new Error("proof lstat failed");
      return fs.lstatSync(path, options);
    } }), create: true }],
    ["the proof's unlink", { patch: (p) => ({ unlinkSync: (path) => {
      if (path.startsWith(p + "/")) throw new Error("unlink failed");
    } }), create: true }],
    ["the stray sweep's readdir", { patch: () => ({ readdirSync: () => { throw new Error("readdir failed"); } }), create: true }],
    ["the stray sweep's rm", { patch: (p) => ({ rmSync: (path) => {
      if (path.startsWith(p + "/")) throw new Error("rm failed");
    } }), create: true, stray: true }],
  ];
  for (const [label, options] of cases) {
    const result = await fault(t, options);
    assert.ok(result.lines.length >= 1, label);
  }
});
