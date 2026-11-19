import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
