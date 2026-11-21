import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signedRelease } from "./signed-release.mjs";
import { VERIFY_JS } from "../machineInstall.js";
import { RELEASES, REPOSITORY, LANE_RELEASE, POINTER, SIGNATURE } from "../lib/lane.mjs";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const CLI = readFileSync(new URL("../bin/am.mjs", import.meta.url), "utf8");
const HELP = CLI.match(/const HELP = `([\s\S]*?)`;/)[1];

test("the standalone install uses am-lane and the repository am actually trusts", () => {
  for (const file of [POINTER, SIGNATURE]) {
    assert.ok(README.includes(`${RELEASES}/download/${LANE_RELEASE}/${file}`), file);
  }
  assert.ok(README.includes(`"${REPOSITORY}"`));
});

test("the documented am commands and flags are supported by its CLI", () => {
  const self = HELP.match(/^  self (.+)$/m)[1];
  for (const verb of ["install", "doctor", "uninstall"]) {
    assert.ok(README.includes(`self ${verb}`), verb);
    assert.ok(self.split(/\W+/).includes(verb), verb);
  }
  assert.ok(README.includes("--purge"));
  assert.ok(self.includes("[--purge]"));
  assert.ok(README.includes("update --check automagik.am"));
  assert.match(HELP, /^  update \[automagik\.am \| herdr\.pack\] \[--check\]/m);
  assert.ok(README.includes("rollback automagik.am"));
  assert.match(HELP, /^  rollback automagik\.am \| herdr\.pack/m);
  assert.ok(README.includes("am self doctor --json"));
  assert.ok(self.includes("[--json]"));
  assert.match(CLI, /verb === "help"/);
  assert.match(CLI, /await forward\(args\)/);
  const pack = readFileSync(new URL("../bin/automagik-herdr.mjs", import.meta.url), "utf8");
  assert.match(pack, /am --version/);
});

test("the README runs the linked verifier verbatim and installs a fixture release", (t) => {
  assert.ok(README.includes(`node -e '${VERIFY_JS}' am.json am.json.sig am-keys.json > verified.txt`));
  const shell = README.match(/```sh\n([\s\S]*?)\n```/)[1];
  const root = mkdtempSync(join(tmpdir(), "am-readme-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), home = join(root, "home");
  for (const dir of [bin, home]) mkdirSync(dir);
  const lane = signedRelease(root);
  const version = "3.162.4";
  lane.post(version, lane.pack(version).archive);
  lane.curl(bin);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root, NODE_OPTIONS: process.env.NODE_OPTIONS };
  const r = spawnSync("sh", ["-c", shell], { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, r.stderr);
  const link = join(home, ".local/bin/am");
  assert.ok(existsSync(link));
  const got = spawnSync("sh", [link, "--version"], { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(got.stdout.trim(), `am ${version}`);
});
