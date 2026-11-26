import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../mods/am-quota/sha256.js";
import * as panel from "../mods/am-quota/setLogin.js";
import * as cli from "../mods/am-sidebar/accountsWrite.js";

test("panel SHA-256 matches Node over UTF-8, padding boundaries and a MiB", () => {
  for (const text of ["", "abc", "café 漢字 🎵\ud800", ...[55, 56, 63, 64, 65, 1 << 20].map((n) => "a".repeat(n))]) {
    const digest = createHash("sha256").update(text).digest("hex");
    assert.equal(sha256Hex(text), digest, `length ${text.length}`);
    assert.equal(panel.snapshotOf(text), digest);
  }
  assert.equal(panel.snapshotOf(null), "none");
});

test("panel and CLI agree on the markers, operation arguments and fixed result codes", () => {
  for (const name of ["PANEL_MARKER", "SIDEBAR_MARKERS", "SIDEBAR_VERSION", "WRITER_FILE", "WRITER_MAX_BYTES"]) {
    assert.deepEqual(panel[name], cli[name]);
  }
  assert.deepEqual(panel.setLoginArgs({ kind: "use", id: "default" }, "none"),
    ["set-login", "--use", "default", "--snapshot", "none"]);
  assert.deepEqual(panel.setLoginArgs({ kind: "add", id: "slot-two", dir: "/scratch/login" }, "none"),
    ["set-login", "--add", "slot-two", "--dir", "/scratch/login", "--snapshot", "none"]);
  assert.deepEqual(panel.setLoginArgs({ kind: "remove", id: "slot-two" }, "none"),
    ["set-login", "--remove", "slot-two", "--snapshot", "none"]);
  const snapshot = "a".repeat(64);
  const stderr = "CANARY-STDERR-0043";
  assert.deepEqual(panel.setLoginResult({ code: 0, stdout: JSON.stringify({ ok: true, snapshot, use: "default" }), stderr }),
    { ok: true, snapshot });
  for (const code of cli.CODES) {
    assert.deepEqual(panel.setLoginResult({ code: 1, stdout: JSON.stringify({ error: code }), stderr }), { code });
  }
  for (const result of [null, { code: 2, stdout: '{"error":"busy"}', stderr },
    { code: 0, stdout: '{"ok":true,"snapshot":"CANARY-STDERR-0043"}', stderr },
    { code: 1, stdout: '{"error":"CANARY-STDERR-0043"}', stderr }]) {
    assert.deepEqual(panel.setLoginResult(result), { code: "failed" });
  }
});
