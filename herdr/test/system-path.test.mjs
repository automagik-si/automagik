import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_PROGRAMS, pathWithout } from "./system-path.mjs";

function scratch(t) {
  const tmp = mkdtempSync(join(tmpdir(), "system-path-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const a = join(tmp, "a");
  const b = join(tmp, "b");
  const root = join(tmp, "mirrors");
  for (const folder of [a, b, root]) mkdirSync(folder);
  return { tmp, a, b, root };
}

function tool(dir, name) {
  writeFileSync(join(dir, name), "#!/bin/sh\necho tool\n", { mode: 0o755 });
}

test("pathWithout: folders with none of Herdr's programs come back unchanged", (t) => {
  const { a, b, root } = scratch(t);
  tool(a, "tool");
  tool(b, "tool");
  assert.equal(pathWithout([a, b], { root }), `${a}:${b}`);
});

test("pathWithout: a folder holding herdr-app, hc or herdr-core is mirrored without them", (t) => {
  const { a, b, root } = scratch(t);
  for (const name of [...HOST_PROGRAMS, "tool"]) tool(a, name);
  const result = pathWithout([a, b], { root });
  const [first, second] = result.split(":");
  assert.notEqual(first, a);
  assert.equal(second, b);
  const sh = (command) => spawnSync("/bin/sh", ["-c", command], { env: { PATH: result }, encoding: "utf8" });
  for (const name of HOST_PROGRAMS) {
    const r = sh(`command -v ${name}`);
    assert.ok(r.status > 0, r.stdout || r.error?.message);
  }
  const r = sh("tool");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "tool");
});

test("pathWithout: a missing folder is kept as it is", (t) => {
  const { tmp, root } = scratch(t);
  const missing = join(tmp, "nope");
  assert.equal(pathWithout([missing], { root }), missing);
});

test("pathWithout: the same real folder is mirrored once", (t) => {
  const { tmp, a, root } = scratch(t);
  tool(a, "herdr-app");
  const link = join(tmp, "link");
  symlinkSync(a, link);
  const [first, second] = pathWithout([a, link], { root }).split(":");
  assert.equal(first, second);
  assert.equal(readdirSync(root).length, 1);
});
