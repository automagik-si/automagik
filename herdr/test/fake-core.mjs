import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortSocketDir } from "./scratch-project.mjs";

/** Synchronous readiness for harnesses whose CLI calls block the parent event loop. */
export function startFakeCore(t, env) {
  const dir = shortSocketDir(t, "hc1497-");
  const socket = join(dir, "core.sock"), ready = join(dir, "ready"), controlFile = join(dir, "control.json");
  const root = env.AUTOMAGIK_HERDR_TEST_ROOTS || env.GIT_CEILING_DIRECTORIES ||
    (env.HC_FAKE_STATE ? dirname(env.HC_FAKE_STATE) : env.HOME);
  const fakeEnv = { AUTOMAGIK_HERDR_CORE_SOCKET: socket, AUTOMAGIK_HERDR_TEST_ROOTS: `${root}:${dir}` };
  const control = (current) => {
    const temp = `${controlFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...current, ...fakeEnv }));
    renameSync(temp, controlFile);
  };
  control(env);
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
  return { env: fakeEnv, control };
}
