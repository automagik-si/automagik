// Refs #631, #700, #743: real bwrap, fixture roots only. No host core, credentials or runtime
// sockets. The pane is started through the pack's wrapper itself, so the test covers the mask
// mounts, the pane's own network namespace and its egress relay, not just the mount plan.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approveProject, readApprovedRecord } from "../mods/am-sidebar/approved.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const wrapper = fileURLToPath(new URL("../mods/am-sidebar/bin/hc-socket-mask.mjs", import.meta.url));

test("approved snapshot write and rename are refused inside the sandbox wrapper", (t) => {
  if (process.platform !== "linux") return t.skip("the sandbox wrapper uses Linux bwrap");
  const capability = spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/",
    process.execPath, "-e", ""], { encoding: "utf8", timeout: 5000 });
  if (capability.error?.code === "ENOENT") return t.skip("bwrap is not installed");
  if (capability.status !== 0) {
    return t.skip(`bwrap namespaces unavailable: ${(capability.stderr || capability.error?.message)
      .replace(/\s+/g, " ").trim()}`);
  }
  const root = scratchRoot(t, "approved-worker-");
  const home = join(root, "home");
  const project = scratchProject(root, "project", { bots: { version: 1, categories: [], bots: [] } });
  const env = { PATH: "/usr/bin:/bin", HOME: home, XDG_DATA_HOME: join(root, "data"), GIT_CEILING_DIRECTORIES: root };
  const packRoot = join(env.XDG_DATA_HOME, "automagik-herdr", "dsh-sandbox");
  const proxy = join(root, "automagik-hc-proxy", "t1", "fixture.sock");
  const real = join(root, "fixture-runtime", "fixture.sock");
  for (const dir of [home, packRoot,
    join(root, "fixture-runtime"), join(root, "automagik-hc-proxy", "t1")]) {
    mkdirSync(dir, { recursive: true });
  }
  const approved = approveProject({ project, env, approvedAt: "2026-11-02", approvedBy: "fixture" });
  const before = readFileSync(approved.path, "utf8");
  const incoming = join(dirname(approved.path), "replacement.json");
  const probe = join(root, "probe.mjs");
  writeFileSync(probe, `
import { writeFileSync, renameSync } from "node:fs";
const [target, source, sibling] = process.argv.slice(2);
// A writable sibling proves that refusal comes from the parent's read-only bind.
writeFileSync(sibling, "writable");
const results = {};
for (const [name, action] of [["write", () => writeFileSync(target, "changed")],
  ["rename", () => renameSync(source, target)]]) {
  try { action(); results[name] = "allowed"; }
  catch (error) { results[name] = error.code; }
}
console.log(JSON.stringify(results));
`);
  // The wrapper's own profile: a minimal read-only /, the shell's tools, this node and the
  // fixture root. `--unshare-all` already makes the network namespace, so the wrapper adds no
  // second switch; the egress relay still runs, because the pane command is always wrapped.
  const profile = ["--unshare-all", "--new-session", "--die-with-parent",
    "--ro-bind", "/", "/",
    "--ro-bind", process.execPath, process.execPath,
    "--proc", "/proc", "--dev", "/dev", "--bind", root, root, "--chdir", root];
  const run = (mask) => {
    writeFileSync(incoming, "replacement", { mode: 0o600 });
    return spawnSync(process.execPath, [wrapper, "--pack-root", packRoot, ...profile, "--",
      process.execPath, probe, approved.path, incoming, join(root, "writable")], {
      encoding: "utf8", timeout: 30000,
      env: { ...env, DSH_SANDBOX_MASK: mask, AM_HC_REAL_SOCKET: real, AM_HC_PROXY_SOCKET: proxy },
    });
  };
  const control = run("0");
  assert.equal(control.status, 0, `unmasked fixture control: ${control.stderr}`);
  assert.deepEqual(JSON.parse(control.stdout), { write: "allowed", rename: "allowed" });
  writeFileSync(approved.path, before);
  assert.equal(readApprovedRecord({ project, env }).text, before, "the masked fixture is valid approval");
  const masked = run("1");
  assert.equal(masked.status, 0, `sandbox wrapper probe: ${masked.stderr}`);
  const results = JSON.parse(masked.stdout);
  for (const name of ["write", "rename"]) {
    assert.match(results[name], /^(EROFS|EACCES|EPERM)$/, `${name} was refused inside the sandbox`);
  }
  assert.equal(readFileSync(approved.path, "utf8"), before, "the approved snapshot was not changed");
});
