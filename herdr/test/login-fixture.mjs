import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CliGenerations } from "../../apps/acp-dsh/src/host/cli-generations.js";
import { installationDigest, installationIdentity, publishSelectedRoot } from "../../apps/acp-dsh/src/host/installation.js";
import { POINTER_VAR } from "../mods/am-sidebar/loginRecord.js";

export function privateFixtureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function privateFixtureFile(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function privateFixtureHome(dir) {
  for (let at = dir; basename(at) && basename(at) !== "cli-homes"; at = dirname(at)) chmodSync(at, 0o700);
}

export function selectedRootFixture(t, acp, root, dsh, vendors = ["claude", "codex"]) {
  // ACP makes its roots 0700 (cli-homes.js, installation.js); a fixture made under umask 002 would
  // leave them group-writable, which the reader rightly refuses. Match ACP whatever the umask.
  privateFixtureDir(root);
  for (let dir = root; dir.startsWith(`${acp}/`); dir = dirname(dir)) chmodSync(dir, 0o700);
  chmodSync(acp, 0o700);
  const current = join(root, "current");
  if (lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) chmodSync(current, 0o700);
  const identity = installationIdentity(dsh);
  const instance = `${process.pid}-${randomUUID()}`;
  const generations = new CliGenerations(root, instance, { reader: true });
  for (const vendor of vendors) {
    generations.register(vendor);
    chmodSync(dirname(generations.instances(vendor)), 0o700);
    chmodSync(generations.instances(vendor), 0o700);
    chmodSync(join(generations.instances(vendor), instance), 0o600);
  }
  const directory = join(acp, "selected", installationDigest(identity));
  const path = join(directory, `${instance}.json`);
  privateFixtureDir(dirname(directory));
  privateFixtureDir(directory);
  const handle = publishSelectedRoot(dirname(directory), path, {
    version: 1, identity, root, instance, pid: process.pid, birth: generations.birth, vendors,
    startedAt: new Date().toISOString(),
  });
  let closed = false;
  const close = () => { if (!closed) { handle.close(); closed = true; } };
  t.after(close);
  return { path, record: JSON.parse(readFileSync(path, "utf8")), close,
    registration: (vendor) => join(generations.instances(vendor), instance) };
}

export function loginPointerFixture(t, pointer) {
  const root = dirname(dirname(pointer));
  const acp = dirname(root);
  const data = dirname(acp);
  const dsh = join(data, "dsh");
  const current = dirname(pointer);
  privateFixtureDir(current);
  for (const name of ["generation.json", "claude", "codex"]) {
    const path = join(current, name);
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) chmodSync(path, 0o600);
  }
  selectedRootFixture(t, acp, root, dsh);
  return { [POINTER_VAR]: pointer, AUTOMAGIK_NATIVE_WORKER_LOGIN: "", DSH_HOME: dsh, AUTOMAGIK_HOME: data };
}

/** Write the pointer first and the record last, in the layout ACP uses. */
export function loginFixture(t, root, vendor, generation = "11111111-1111-4111-8111-111111111111") {
  const current = join(root, "current");
  const dir = join(root, "homes", vendor, generation, `.${vendor}`);
  const pointer = join(current, vendor);
  const recordPath = join(current, "generation.json");
  privateFixtureDir(current);
  privateFixtureDir(dir);
  privateFixtureHome(dir);
  let record = { version: 1, sequence: 0, claude: null, codex: null };
  try { record = JSON.parse(readFileSync(recordPath, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  record.sequence += 1;
  record[vendor] = { generation, [vendor === "claude" ? "configDir" : "home"]: dir };
  const text = JSON.stringify(record);
  privateFixtureFile(pointer, generation);
  privateFixtureFile(recordPath, text);
  return { dir, pointer, recordPath, text, env: loginPointerFixture(t, pointer) };
}
