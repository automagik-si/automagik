// #1497: `hc server status` (and any hc client call) auto-starts a core when none
// answers. The pack's core-id lookup talks JSON-RPC straight to the socket and
// never runs a program.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, relative } from "node:path";
import { createConnection } from "node:net";

/** Test-only boundary, shared with the CLI's executable lookup. */
export function inTestRoots(path, env = process.env) {
  if (!env.AUTOMAGIK_HERDR_TEST_ROOTS) return true;
  if (!isAbsolute(path)) return false;
  return env.AUTOMAGIK_HERDR_TEST_ROOTS.split(":").filter(isAbsolute).some((root) => {
    const rest = relative(resolve(root), resolve(path));
    return !rest || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
  });
}

/** The client's default socket, then its recorded socket; explicit overrides stand alone. */
export function coreSockets(env = process.env, { platform = process.platform, uid = process.getuid?.(), home = env.HOME || homedir() } = {}) {
  const allowed = (paths) => [...new Set(paths)].filter((p) => isAbsolute(p) && inTestRoots(p, env));
  const override = env.AUTOMAGIK_HERDR_CORE_SOCKET || env.HC_SOCKET;
  if (override) return allowed([override]);
  const session = env.HC_SESSION || "default";
  if (!/^[A-Za-z0-9._-]+$/.test(session) || session === "." || session === ".." || platform === "win32") return [];
  const state = isAbsolute(env.XDG_STATE_HOME || "") ? env.XDG_STATE_HOME : join(home, ".local/state");
  const sessionState = join(state, "herdr-core", session);
  let socketDir = sessionState;
  if (isAbsolute(env.XDG_RUNTIME_DIR || "")) {
    socketDir = join(env.XDG_RUNTIME_DIR, "herdr-core");
  } else if (typeof uid === "number") {
    const runtime = `/run/user/${uid}`;
    if (inTestRoots(runtime, env)) {
      try {
        if (statSync(runtime).isDirectory()) socketDir = join(runtime, "herdr-core");
      } catch { /* Use session state when the runtime directory is unavailable. */ }
    }
  }
  const paths = [join(socketDir, `${session}.sock`)];
  const lockPath = join(sessionState, "core.lock");
  if (inTestRoots(lockPath, env)) {
    try {
      const lock = readFileSync(lockPath, "utf8").split("\n")[0].trim();
      if (isAbsolute(lock) && lock.endsWith(".sock")) paths.push(lock);
    } catch { /* No readable lock: the default is still a candidate. */ }
  }
  return allowed(paths);
}

/** One overall deadline; only a failed connection permits trying another candidate. */
export async function coreStatus(env = process.env, { timeoutMs = 3000, sockets } = {}) {
  const paths = (sockets ?? coreSockets(env)).filter((p) => isAbsolute(p) && inTestRoots(p, env));
  const until = Date.now() + timeoutMs;
  const tried = [];
  for (const path of paths) {
    tried.push(path);
    const answer = await new Promise((done) => {
      let socket, timer, finished = false, connected = false, buffer = Buffer.alloc(0);
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket?.destroy();
        done(value);
      };
      const error = (why) => finish({ error: `${path}: ${why}` });
      const remaining = until - Date.now();
      if (remaining <= 0) return error("timed out");
      timer = setTimeout(() => error("timed out"), remaining);
      timer.unref();
      try {
        socket = createConnection(path);
        socket.once("connect", () => {
          connected = true;
          socket.write('{"jsonrpc":"2.0","id":1,"method":"server.status","params":{}}\n');
        });
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if ((newline < 0 ? buffer.length : newline) > 64 * 1024) return error("reply exceeds 64 KiB");
          if (newline < 0) return;
          let reply;
          try { reply = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { return error("reply is not JSON"); }
          if (reply?.id !== 1) return error("reply id is not 1");
          if (Object.hasOwn(reply, "error")) return finish({ error: reply.error?.message ?? String(reply.error) });
          finish({ status: reply.result, socket: path });
        });
        socket.once("error", (e) => {
          if (!connected && ["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES"].includes(e.code)) return finish(null);
          error(e.message);
        });
        socket.once("close", () => error("closed before a reply line"));
      } catch (e) { error(e.message); }
    });
    if (answer) return answer;
  }
  return { none: true, tried };
}
