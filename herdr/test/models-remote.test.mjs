import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROBE, REMOTE_MODEL_EVERY_MS, dueRemoteProbes, parseModelProbe, remoteModelMachines } from "../mods/am-sidebar/modelsRemote.js";
import { modelDefaultsFrom } from "../mods/am-sidebar/rows.js";

// Each awk this host has (a linked machine may run any of them: mawk on Debian, busybox on a
// small image, the one-true-awk on macOS), put first on PATH as `awk`.
const AWKS = ["gawk", "mawk", "original-awk", "busybox"].flatMap((name) => {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? [[name, r.stdout.trim()]] : [];
});

const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), "am-probe-"));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const put = (home, rel, text) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const probe = (home, awkPath = null) => {
  let PATH = process.env.PATH;
  if (awkPath) {
    const bin = join(home, ".probe-bin");
    mkdirSync(bin, { recursive: true });
    if (!existsSync(join(bin, "awk"))) {
      if (awkPath.endsWith("/busybox")) writeFileSync(join(bin, "awk"), `#!/bin/sh\nexec ${awkPath} awk "$@"\n`, { mode: 0o755 });
      else symlinkSync(awkPath, join(bin, "awk"));
    }
    PATH = `${bin}:${PATH}`;
  }
  const r = spawnSync("sh", ["-c", MODEL_PROBE], { env: { PATH, HOME: home }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const SECRET = "sk-ant-do-not-send";
const CLAUDE = JSON.stringify({
  env: { ANTHROPIC_API_KEY: SECRET, note: "a } and a \" and \"model\": \"fake\" in a string" },
  hooks: { PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: "echo {[" }] }] },
  statusLine: { model: "nested-not-the-default" },
  model: "claude-opus-5-5",
}, null, 2);
const CODEX = `# top\napi_key = "${SECRET}"\nmodel = "gpt-6.2-sol" # the default\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n`;
const AGY = `{"theme":"dark","token":"${SECRET}","model":"Gemini 4 Pro (High)"}`;

for (const [name, awkPath] of [["sh's own awk", null], ...AWKS]) {
  test(`the probe (${name}) sends only each agent's top-level model, never the rest of the file`, () => withHome((home) => {
    put(home, ".claude/settings.json", CLAUDE);
    put(home, ".codex/config.toml", CODEX);
    put(home, ".gemini/antigravity-cli/settings.json", AGY);
    const r = probe(home, awkPath);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(SECRET), `no secret crosses the link: ${r.stdout}`);
    assert.ok(!r.stdout.includes("nested-not-the-default") && !r.stdout.includes("gpt-6-luna") && !r.stdout.includes("fake"), r.stdout);
    assert.deepEqual(r.stdout.trim().split("\n"), [
      '@@am-model claude "claude-opus-5-5"',
      '@@am-model codex model = "gpt-6.2-sol" # the default',
      '@@am-model antigravity "Gemini 4 Pro (High)"',
      "@@am-model end",
    ]);
    assert.deepEqual(parseModelProbe(r), { claude: "claude-opus-5-5", codex: "gpt-6.2-sol", antigravity: "Gemini 4 Pro (High)" });
  }));

  test(`the probe (${name}) reads as models.js does: the last top-level string, escapes decoded, none for a non-string`, () => withHome((home) => {
    put(home, ".claude/settings.json", '{"model":"first","x":[1,{"model":"no"}],"model":"op\\"us\\u0021"}');
    put(home, ".gemini/antigravity-cli/settings.json", '{"model":"a",\n "model": 5}');
    put(home, ".codex/config.toml", "[profiles.p]\nmodel = \"in-a-profile\"\n");
    assert.deepEqual(parseModelProbe(probe(home, awkPath)), { claude: 'op"us!', codex: null, antigravity: null });
  }));
}

test("the probe on a machine with no files answers whole with no defaults; a failed or cut-short answer reads as unreadable", () => {
  withHome((home) => {
    const r = probe(home);
    assert.equal(r.stdout, "@@am-model end\n");
    assert.deepEqual(parseModelProbe(r), { claude: null, codex: null, antigravity: null });
    // The parsed answer has rows.js modelDefaultsFrom's shape, so a row reads it as a local one.
    assert.deepEqual(Object.keys(parseModelProbe(r)), Object.keys(modelDefaultsFrom({})));
  });
  assert.equal(parseModelProbe({ code: 1, stdout: "", stderr: "away" }), null);
  assert.equal(parseModelProbe({ code: -1, stdout: "", stderr: "timed out" }), null);
  assert.equal(parseModelProbe(null), null);
  assert.equal(parseModelProbe({ code: 0, stdout: '@@am-model codex model = "x"\n' }), null, "no end line: cut short");
  assert.equal(parseModelProbe({ code: 0, stdout: "@@am-model nope x\n@@am-model end\n" }), null, "an unknown agent");
  assert.equal(parseModelProbe({ code: 0, stdout: "stray\n@@am-model end\n" }), null, "a line that is not the probe's");
  assert.deepEqual(parseModelProbe({ code: 0, stdout: "@@am-model claude 1}, {\"model\": \"x\"\n@@am-model end\n" }),
    { claude: null, codex: null, antigravity: null }, "a value that isn't one JSON string is no model");
});

test("remoteModelMachines: connected linked machines with a bot whose agent has a file default", () => {
  const codex = { file: { bots: [{ agent: "codex" }] } }, hermes = { file: { bots: [{ agent: "hermes" }] } };
  const bots = [
    { key: "/a", ...codex }, // this computer
    { key: "/b", machine: "linux", ...codex },
    { key: "/c", machine: "mac", ...codex, stale: true }, // drawn from an earlier run while away
    { key: "/d", machine: "pi", ...hermes }, // no file default to show
    { key: "/e", machine: "away", ...codex },
  ];
  const machines = [{ name: "linux", state: "connected" }, { name: "mac", state: "connected" }, { name: "pi", state: "connected" }, { name: "away", state: "disconnected" }];
  assert.deepEqual([...remoteModelMachines(bots, machines)], ["linux"]);
  assert.deepEqual([...remoteModelMachines(undefined, undefined)], []);
});

test("dueRemoteProbes: a machine is read when it joins, then once a minute, not on every 15-second tick", () => {
  const want = new Set(["linux", "mac"]);
  const at = new Map([["linux", 1_000_000]]);
  assert.deepEqual(dueRemoteProbes(want, at, 1_000_000 + 15_000), ["mac"], "mac just joined; linux was read 15 s ago");
  at.set("mac", 1_000_000 + 15_000);
  assert.deepEqual(dueRemoteProbes(want, at, 1_000_000 + 30_000), []);
  assert.deepEqual(dueRemoteProbes(want, at, 1_000_000 + REMOTE_MODEL_EVERY_MS), ["linux"]);
  assert.deepEqual(dueRemoteProbes(want, at, 999_000), ["linux", "mac"], "the clock moved back: read again");
  assert.equal(REMOTE_MODEL_EVERY_MS, 60_000);
  // Across an hour of 15-second ticks a connected machine is read 60 times, not 240.
  const t = new Map(); let reads = 0;
  for (let now = 0; now < 3_600_000; now += 15_000) for (const m of dueRemoteProbes(new Set(["linux"]), t, now)) { reads++; t.set(m, now); }
  assert.equal(reads, 60);
});
