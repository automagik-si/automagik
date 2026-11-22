// #1497: `hc server status` (and any hc client call) auto-starts a core when none
// answers. The pack's core-id lookup talks JSON-RPC straight to the socket and
// never runs a program.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import { createConnection } from "node:net";

const testRoots = (env) => env.AUTOMAGIK_HERDR_TEST_ROOTS.split(":").filter(isAbsolute);
const contains = (root, path) => {
  const rest = relative(root, path);
  return !rest || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
};

/** Test-only boundary, shared with the CLI's executable lookup. */
export function inTestRoots(path, env = process.env) {
  if (!env.AUTOMAGIK_HERDR_TEST_ROOTS) return true;
  if (!isAbsolute(path)) return false;
  return testRoots(env).some((root) => contains(resolve(root), resolve(path)));
}

// A stale name may be missing. Resolve its existing ancestors, including symlinked
// directories, before deciding where that name is allowed to land.
function realPathPrefix(path) {
  try { return realpathSync.native(path); } catch (error) {
    if (error?.code !== "ENOENT" || dirname(path) === path || basename(path) === "..") return null;
  }
  try {
    lstatSync(path);
    return null; // A dangling link has no verified target.
  } catch (error) { if (error?.code !== "ENOENT") return null; }
  const parent = realPathPrefix(dirname(path));
  return parent === null ? null : join(parent, basename(path));
}

/** Both the supplied and resolved names must stay in the scratch roots. */
export function inTestRootsReal(path, env = process.env) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  if (!env.AUTOMAGIK_HERDR_TEST_ROOTS) return true;
  if (!inTestRoots(path, env)) return false;
  const real = realPathPrefix(path);
  return real !== null && testRoots(env).some((root) => {
    const realRoot = realPathPrefix(root);
    return realRoot !== null && contains(realRoot, real);
  });
}

const MAX_CONFIG_BYTES = 64 * 1024;
const BASIC = String.raw`"(?:[^"\\\x00-\x1f\x7f]|\\(?:[btnfr"\\]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"`;
const LITERAL = String.raw`'[^'\x00-\x1f\x7f]*'`;
const STRING = `(?:${BASIC}|${LITERAL})`;
const LINE = new RegExp(String.raw`^[ \t]*(?:#[^\n]*|([A-Za-z0-9_-]+|${STRING})[ \t]*=[ \t]*([^\n]*))?$`);
const DECIMAL = String.raw`[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?`;
const ARRAY = String.raw`\[[ \t]*(?:${STRING}(?:[ \t]*,[ \t]*${STRING})*[ \t]*,?[ \t]*)?\]`;
const VALUE = new RegExp(String.raw`^(${STRING}|true|false|${DECIMAL}|${ARRAY})[ \t]*(?:#[^\n]*)?$`);
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const CONFIG_TYPES = new Map(Object.entries({
  socket: "string", detach_key: "string", headless: "string",
  notes: "boolean", restore_screen: "boolean",
  wait_timeout: "number", notes_quiet: "number", draft_wait: "number", history_mb: "number", machine_timeout: "number",
}));
const INDETERMINATE = Symbol("indeterminate core config");

function configString(token) {
  const body = token.slice(1, -1);
  if (token[0] === "'") return body;
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_escape, code) => {
    if (code.length === 1) return ESCAPES[code];
    const point = Number.parseInt(code.slice(1), 16);
    if (point >= 0xd800 && point <= 0xdfff) throw new Error("surrogate escape");
    return String.fromCodePoint(point);
  });
}

function configValue(token) {
  if (token[0] === '"' || token[0] === "'") return configString(token);
  if (token[0] === "[") return Array.from(token.matchAll(new RegExp(STRING, "g")), ([word]) => configString(word));
  if (token === "true" || token === "false") return token === "true";
  const n = Number(token);
  if (Math.abs(n) > 1e9) throw new Error("number outside config subset");
  return n;
}

function readConfig(path) {
  // Bound the read even if the file is replaced or grows. Do not wait on a pipe.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new Error("invalid config file");
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_CONFIG_BYTES) throw new Error("invalid config size");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

// null: no setting. A path is trusted only when the entire file fits this TOML subset.
function configuredSocket(env, home) {
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  if (!isAbsolute(config)) return INDETERMINATE;
  const path = `${config}/herdr-core/config.toml`;
  if (!inTestRoots(path, env)) return null;
  if (!inTestRootsReal(path, env)) return INDETERMINATE;
  try {
    const source = readConfig(path);
    if (!source.includes("socket")) return null;
    const entries = new Map();
    for (const line of source.split(/\r?\n/)) {
      const assignment = LINE.exec(line);
      if (!assignment || /[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return INDETERMINATE;
      if (!assignment[1]) continue;
      const [, word, rest] = assignment;
      const key = word[0] === '"' || word[0] === "'" ? configString(word) : word;
      const match = VALUE.exec(rest);
      if (key.includes(".") || entries.has(key) || !match) return INDETERMINATE;
      const value = configValue(match[1]);
      const type = CONFIG_TYPES.get(key);
      if (type && typeof value !== type) return INDETERMINATE;
      if (key === "shell" && (!Array.isArray(value) || !value[0])) return INDETERMINATE;
      entries.set(key, value);
    }
    if (!entries.has("socket")) return null;
    const socket = entries.get("socket");
    return isAbsolute(socket) && !socket.includes("\0") ? socket : INDETERMINATE;
  } catch (error) { return error?.code === "ENOENT" ? null : INDETERMINATE; }
}

const stateHome = (env, home) => isAbsolute(env.XDG_STATE_HOME || "") ? env.XDG_STATE_HOME : join(home, ".local/state");
function readLockSocket(lock) {
  const fd = openSync(lock, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Not a regular herdr-core lock file: ${lock}.`);
    return readFileSync(fd, "utf8").split("\n", 1)[0].trim();
  } finally { closeSync(fd); }
}

function socketDiscovery(env, { platform, uid, home }, configured = () => configuredSocket(env, home)) {
  const only = (path) => ({ sockets: inTestRootsReal(path, env) ? [path] : [] });
  const rawSession = env.HC_SESSION || "";
  const session = rawSession.trim() || "default";
  if (platform === "win32" || /[\p{Cc}\/\\:*?"<>|]/u.test(rawSession) || session === "." || session === "..") return { sockets: [] };
  const override = env.HC_SOCKET || env.AUTOMAGIK_HERDR_CORE_SOCKET;
  if (override) return only(override);
  const setting = configured();
  if (setting === INDETERMINATE) return { sockets: [] };
  if (setting !== null) return only(setting);
  const state = stateHome(env, home);
  const sessionState = join(state, "herdr-core", session);
  let socketDir = sessionState;
  if (isAbsolute(env.XDG_RUNTIME_DIR || "")) {
    socketDir = join(env.XDG_RUNTIME_DIR, "herdr-core");
  } else if (typeof uid === "number") {
    const runtime = `/run/user/${uid}`;
    if (inTestRootsReal(runtime, env)) {
      try {
        if (statSync(runtime).isDirectory()) socketDir = join(runtime, "herdr-core");
      } catch { /* Use session state when the runtime directory is unavailable. */ }
    }
  }
  const defaultSocket = join(socketDir, `${session}.sock`);
  const discovery = only(defaultSocket);
  const lockPath = join(sessionState, "core.lock");
  if (inTestRootsReal(lockPath, env)) {
    try {
      const lockSocket = readLockSocket(lockPath);
      if (lockSocket !== defaultSocket && inTestRootsReal(lockSocket, env)) {
        discovery.sockets.push(lockSocket);
        discovery.lockSocket = lockSocket;
      }
    } catch { /* No readable lock: the default is still a candidate. */ }
  }
  return discovery;
}

/** The chosen socket, or the default followed by an endpoint recorded in the lock. */
export function coreSocketDiscovery(env = process.env, { platform = process.platform, uid = process.getuid?.(), home = env.HOME || homedir() } = {}) {
  return socketDiscovery(env, { platform, uid, home });
}

export function coreSockets(env, options) {
  return coreSocketDiscovery(env, options).sockets;
}

/** All this user's core candidates, including sessions other than the caller's. */
export function userCoreSockets(env = process.env, { platform = process.platform, uid = process.getuid?.(), home = env.HOME || homedir() } = {}) {
  if (platform === "win32") return [];
  const allowed = (path) => inTestRootsReal(path, env);
  const list = (dir) => {
    if (!allowed(dir)) return [];
    try { return readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  };
  const configured = configuredSocket(env, home);
  if (configured === INDETERMINATE) throw new Error("Cannot determine the configured herdr-core socket.");
  const paths = new Set(socketDiscovery(env, { platform, uid, home }, () => configured).sockets);
  for (const path of [env.HC_SOCKET, env.AUTOMAGIK_HERDR_CORE_SOCKET, configured]) {
    if (path && allowed(path)) paths.add(path);
  }
  const runtime = isAbsolute(env.XDG_RUNTIME_DIR || "") ? env.XDG_RUNTIME_DIR :
    typeof uid === "number" ? `/run/user/${uid}` : null;
  if (runtime) {
    const dir = join(runtime, "herdr-core");
    for (const entry of list(dir)) {
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".sock") && allowed(path)) paths.add(path);
    }
  }
  const state = stateHome(env, home);
  const dir = join(state, "herdr-core");
  for (const session of list(dir)) {
    if (!session.isDirectory()) continue;
    const lock = join(dir, session.name, "core.lock");
    if (!allowed(lock)) continue;
    try {
      const path = readLockSocket(lock);
      if (!isAbsolute(path)) throw new Error(`Invalid herdr-core lock path in ${lock}.`);
      if (allowed(path)) paths.add(path);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return [...paths];
}

/** A direct core RPC with one deadline. Only a failed connection permits trying another socket. */
export async function coreStatus(env = process.env, { timeoutMs = 3000, sockets, strict = false, method = "server.status", params = {} } = {}) {
  const paths = sockets ?? coreSockets(env);
  const until = Date.now() + timeoutMs;
  const tried = [];
  for (const path of paths) {
    if (!inTestRootsReal(path, env)) continue;
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
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
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
          if (!connected && (["ENOENT", "ECONNREFUSED"].includes(e.code)
            || !strict && ["ENOTSOCK", "EACCES"].includes(e.code))) return finish(null);
          error(e.message);
        });
        socket.once("close", () => error("closed before a reply line"));
      } catch (e) { error(e.message); }
    });
    if (answer) return answer;
  }
  return { none: true, tried };
}
