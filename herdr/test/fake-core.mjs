import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortSocketDir } from "./scratch-project.mjs";

/** Synchronous readiness for harnesses whose CLI calls block the parent event loop. */
export function startFakeCore(t, env, { socket: listenAt, status } = {}) {
  const dir = shortSocketDir(t, "hc1497-");
  const socket = listenAt ?? join(dir, "core.sock"), ready = join(dir, "ready"), controlFile = join(dir, "control.json");
  const root = env.AUTOMAGIK_HERDR_TEST_ROOTS || env.GIT_CEILING_DIRECTORIES ||
    (env.HC_FAKE_STATE ? dirname(env.HC_FAKE_STATE) : env.HOME);
  const fakeEnv = { AUTOMAGIK_HERDR_CORE_SOCKET: socket, AUTOMAGIK_HERDR_TEST_ROOTS: `${root}:${dir}` };
  let current;
  const control = (next) => {
    current = next;
    const temp = `${controlFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...current, ...fakeEnv }));
    renameSync(temp, controlFile);
  };
  control(status === undefined ? env : { ...env, HC_FAKE_CUTOFF_STATUS: status });
  const patchStatus = (patch) => control({ ...current, HC_FAKE_CUTOFF_STATUS: { ...current.HC_FAKE_CUTOFF_STATUS, ...patch } });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-core-server.mjs", import.meta.url)), socket, ready, controlFile], {
    stdio: ["pipe", "ignore", "ignore"], detached: false,
  });
  child.on("error", () => {});
  child.unref();
  child.stdin.unref();
  const cleanup = () => {
    child.stdin.destroy();
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
    process.removeListener("exit", cleanup);
  };
  process.once("exit", cleanup);
  if (typeof t === "function") t(cleanup); else t?.after?.(cleanup);
  const until = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(ready)) {
    if (Date.now() >= until) { cleanup(); throw new Error(`fake core did not become ready: ${socket}`); }
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return { env: fakeEnv, control, patchStatus };
}

// Synthetic Linux process and socket tables, independent of the fake listener PIDs.
export const CUT_OFF_EXE = "/fixture/bin/herdr-core";
export const CUT_OFF_NS = "pid:[404]";
export function fixtureProcStat(pid, { ppid = 1, state = "S", starttime = "600", comm = "herdr-core" } = {}) {
  return `${pid} (${comm}) ${state} ${ppid} ${"0 ".repeat(17)}${starttime} 0\n`;
}

export function writeFixtureProc(root, pid, options = {}) {
  const { uid = process.getuid(), argv = [CUT_OFF_EXE], exe = CUT_OFF_EXE, namespace = CUT_OFF_NS, fd = {} } = options;
  const dir = join(root, String(pid));
  mkdirSync(join(dir, "ns"), { recursive: true });
  mkdirSync(join(dir, "fd"), { recursive: true });
  writeFileSync(join(dir, "status"), `Name:\tfake\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(dir, "stat"), fixtureProcStat(pid, options));
  if (!["Z", "X"].includes(options.state)) {
    writeFileSync(join(dir, "cmdline"), argv.length ? argv.join("\0") + "\0" : "");
    symlinkSync(exe, join(dir, "exe"));
    symlinkSync(namespace, join(dir, "ns/pid"));
  }
  for (const [number, inode] of Object.entries(fd)) symlinkSync(`socket:[${inode}]`, join(dir, "fd", number));
}

export function writeFixtureProcRoot(root, listeners) {
  mkdirSync(join(root, "self/ns"), { recursive: true });
  mkdirSync(join(root, "net"), { recursive: true });
  symlinkSync(CUT_OFF_NS, join(root, "self/ns/pid"));
  const header = "Num       RefCount Protocol Flags    Type St Inode Path\n";
  const rows = listeners.map(([path, inode]) => `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} ${path}\n`);
  writeFileSync(join(root, "net/unix"), header + rows.join(""));
}
