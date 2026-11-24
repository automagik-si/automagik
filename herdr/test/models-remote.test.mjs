import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROBE, parseModelProbe } from "../mods/am-sidebar/modelsRemote.js";
import { modelDefaultsFrom } from "../mods/am-sidebar/rows.js";

const probe = (home) => {
  const r = spawnSync("sh", ["-c", MODEL_PROBE], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("the probe reads the default-model files under the machine's own home and parses them back", () => {
  const home = mkdtempSync(join(tmpdir(), "am-probe-"));
  try {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n');
    const texts = parseModelProbe(probe(home));
    assert.equal(texts.codexConfig, 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n');
    assert.equal(texts.claudeSettings, null);
    assert.equal(texts.antigravitySettings, null);
    assert.equal(modelDefaultsFrom(texts).codex, "gpt-6.2-sol");
    assert.equal(modelDefaultsFrom(texts).claude, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a machine with no files reads as whole with no texts; a failed or cut-short answer reads as unreadable", () => {
  const home = mkdtempSync(join(tmpdir(), "am-probe-"));
  try {
    assert.deepEqual(parseModelProbe(probe(home)), { claudeSettings: null, codexConfig: null, antigravitySettings: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.equal(parseModelProbe({ code: 1, stdout: "", stderr: "away" }), null);
  assert.equal(parseModelProbe({ code: -1, stdout: "", stderr: "timed out" }), null);
  assert.equal(parseModelProbe(null), null);
  assert.equal(parseModelProbe({ code: 0, stdout: "@@am-model codexConfig ok\nmodel = \"x\"\n" }), null, "no end line: cut short");
  assert.equal(parseModelProbe({ code: 0, stdout: "@@am-model nope ok\nx\n@@am-model end ok\n" }), null, "an unknown file name");
});
