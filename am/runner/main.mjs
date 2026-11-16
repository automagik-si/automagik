// The member runner: one JSON request line per unix socket connection, one shell under the
// member's own host uid. Apache-2.0.
//
// Started only as `node <am store>/runner/main.mjs --config <file>` by the template's unit. It
// holds no privilege DSH can reach: DSH's uid only opens the socket, after proving itself through
// the proof folder (locks.mjs). Nothing in am, its installer or the pack starts it or writes its
// unit (the held start; see PROTOCOL.md).
//
// On start it loads the config, checks all three locks and refuses to start when any fails, with
// one plain line on stderr and exit 125. Then it serves: proof, request, uid switch (spawn.mjs),
// stdout and stderr frames, then the child's exit code.

import { createServer as createUnixServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_REQUEST_BYTES, MAX_REQUEST_WAIT_MS, Refusal, parseRequest, plain } from "./proto.mjs";
import { PeerProof, checkLocks, checkSocketFile, lstatOr } from "./locks.mjs";
import { checkCwd, createRunner } from "./spawn.mjs";

const CONFIG_KEYS = new Set([
  "socket",
  "proofs",
  "group",
  "dshUid",
  "workRoot",
  "homesRoot",
  "state",
  "uidStart",
  "uidCount",
  "gidStart",
  "gidCount",
  "limits",
  "maxTimeoutMs",
  "maxOutputBytes",
  "maxConcurrent",
]);
const MEMORY_RE = /^[1-9][0-9]{0,6}[KMGTP]?$/;

const bad = (message) => {
  throw new Refusal("CONFIG_INVALID", message);
};

const integer = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return value;
};

const text = (value, name) => {
  if (typeof value !== "string" || value === "" || value.includes("\0")) bad(`${name} must be a non-empty string`);
  return value;
};

const absolute = (value, name) => {
  text(value, name);
  if (!isAbsolute(value)) bad(`${name} must be an absolute path`);
  return value;
};

/**
 * Checks a config object from the file. It names no environment allowlist: the runner's is fixed.
 * Nothing here touches the file system, so the tests can exercise it directly.
 */
export function validateConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad("the config is not an object");
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) bad(`unknown config field ${key}`);
  const config = {
    socket: absolute(value.socket, "socket"),
    proofs: absolute(value.proofs, "proofs"),
    group: text(value.group, "group"),
    dshUid: integer(value.dshUid, 1, 0xfffffffe, "dshUid"),
    workRoot: absolute(value.workRoot, "workRoot"),
    homesRoot: absolute(value.homesRoot, "homesRoot"),
    state: absolute(value.state, "state"),
    uidStart: integer(value.uidStart, 1000, 0xfffffffe, "uidStart"),
    uidCount: integer(value.uidCount, 1, 65536, "uidCount"),
    gidStart: integer(value.gidStart, 1000, 0xfffffffe, "gidStart"),
    gidCount: integer(value.gidCount, 1, 65536, "gidCount"),
    limits: value.limits,
    maxTimeoutMs: integer(value.maxTimeoutMs, 1, 3600000, "maxTimeoutMs"),
    maxOutputBytes: integer(value.maxOutputBytes, 1024, 64 * 1024 * 1024, "maxOutputBytes"),
    maxConcurrent: integer(value.maxConcurrent, 1, 64, "maxConcurrent"),
  };
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.group)) bad("group is not a group name");
  if (config.uidStart + config.uidCount - 1 > 0xfffffffe) bad("uidStart + uidCount is past the largest uid");
  if (config.gidStart + config.gidCount - 1 > 0xfffffffe) bad("gidStart + gidCount is past the largest gid");
  if (config.gidCount < config.uidCount) bad("gidCount is smaller than uidCount");
  if (config.dshUid >= config.uidStart && config.dshUid < config.uidStart + config.uidCount) {
    bad("dshUid is inside the member range");
  }
  if (value.limits === null || typeof value.limits !== "object" || Array.isArray(value.limits)) {
    bad("limits must be an object");
  }
  for (const key of Object.keys(value.limits)) if (key !== "memoryMax" && key !== "tasksMax") bad(`unknown limit ${key}`);
  if (typeof value.limits.memoryMax !== "string" || !MEMORY_RE.test(value.limits.memoryMax)) {
    bad("limits.memoryMax must be a systemd size, such as 2G");
  }
  config.limits = {
    memoryMax: value.limits.memoryMax,
    tasksMax: integer(value.limits.tasksMax, 1, 100000, "limits.tasksMax"),
  };
  if (config.socket.length > 100) bad("socket path is too long for a unix socket");
  return config;
}

/** Reads the config file: the runner's or root's, never writable by group or others. */
export function readConfigFile(path, host) {
  absolute(path, "config");
  const info = lstatOr(host.fs, path);
  if (info === null) bad(`the config file ${path} does not exist`);
  if (info.isSymbolicLink() || !info.isFile()) bad(`the config file ${path} is not a regular file`);
  if (info.uid !== host.uid && info.uid !== 0) bad(`the config file ${path} is not the runner's or root's`);
  if ((info.mode & 0o022) !== 0) bad(`the config file ${path} is writable by group or others`);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    bad(`the config file ${path} is not JSON: ${plain(error)}`);
  }
  return validateConfig(value);
}

/** Resolves each path through its parent's real path, so the folder-chain lock sees no symlink. */
export function resolveConfigPaths(config, fsApi) {
  const through = (path) => {
    const parent = dirname(path);
    try {
      return join(fsApi.realpathSync(parent), basename(path));
    } catch (error) {
      throw new Refusal("CONFIG_INVALID", `the folder of ${path}: ${plain(error)}`);
    }
  };
  return {
    ...config,
    socket: through(config.socket),
    proofs: through(config.proofs),
    homesRoot: through(config.homesRoot),
    workRoot: through(config.workRoot),
    state: through(config.state),
  };
}

/** The runner's own host: real ids, real accounts, the template's environment and PATH. */
export function realHost() {
  const readOrNull = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
      throw error;
    }
  };
  return {
    uid: process.getuid(),
    gid: process.getgid(),
    platform: process.platform,
    fs,
    spawn,
    spawnSync,
    env: process.env,
    now: () => Date.now(),
    log: (line) => process.stderr.write(`member-runner: ${line}\n`),
    accounts: {
      passwd: readOrNull("/etc/passwd") ?? "",
      group: readOrNull("/etc/group") ?? "",
      shadow: readOrNull("/etc/shadow"),
    },
  };
}

function end(conn) {
  try {
    conn.end();
  } catch {
    /* already closed */
  }
}

/** One request line, at most 64 KiB, within the wait: { text }, { error, message } or null. */
function readRequestLine(conn) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.off("data", onData);
      resolve(value);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_REQUEST_BYTES) {
          finish({ error: "TOO_LARGE", message: `the request is over ${MAX_REQUEST_BYTES} bytes` });
        }
        return;
      }
      if (newline > MAX_REQUEST_BYTES) {
        finish({ error: "TOO_LARGE", message: `the request is over ${MAX_REQUEST_BYTES} bytes` });
        return;
      }
      if (buffer.length > newline + 1) {
        finish({ error: "BAD_REQUEST", message: "one request per connection" });
        return;
      }
      finish({ text: buffer.subarray(0, newline).toString("utf8") });
    };
    const timer = setTimeout(() => {
      finish({ error: "BAD_REQUEST", message: "no request line in time" });
    }, MAX_REQUEST_WAIT_MS);
    conn.on("data", onData);
    conn.once("close", () => finish(null));
    conn.on("error", () => finish(null));
  });
}

/** One connection: the proof, the request, the run and its frames. */
async function handleConnection(conn, ctx) {
  const runId = randomBytes(6).toString("hex");
  const { config, host, runner } = ctx;
  conn.on("error", () => {});
  const send = (frame) => {
    try {
      if (conn.destroyed !== true) conn.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* the peer is gone */
    }
  };
  const fail = (code, message) => {
    host.log(`run=${runId} refused ${code}: ${message}`);
    send({ t: "error", code, message });
    end(conn);
  };
  try {
    if (!(await ctx.proof.challenge(conn))) return;
    const line = await readRequestLine(conn);
    if (line === null) return;
    if (line.error !== undefined) return fail(line.error, line.message);
    let request;
    try {
      request = parseRequest(line.text, config);
    } catch (error) {
      return fail(error?.code ?? "BAD_REQUEST", plain(error));
    }
    if (ctx.state.running >= config.maxConcurrent) {
      return fail("BUSY", `${config.maxConcurrent} runs are already going`);
    }
    let ids;
    let layout;
    try {
      checkCwd(config, request.member, request.cwd);
      ids = runner.idsFor(request.member);
      layout = runner.provision(request.member, ids);
    } catch (error) {
      return fail(error?.code ?? "INTERNAL", plain(error));
    }
    ctx.state.running += 1;
    let finished = false;
    const done = () => {
      if (finished) return false;
      finished = true;
      ctx.state.running -= 1;
      return true;
    };
    const io = {
      start: (info) => send({ t: "start", ...info }),
      out: (chunk) => send({ t: "out", d: chunk.toString("base64") }),
      err: (chunk) => send({ t: "err", d: chunk.toString("base64") }),
      exit: (result) => {
        if (!done()) return;
        send({ t: "exit", ...result });
        host.log(
          `run=${runId} member=${request.member} uid=${ids.uid} exit=${result.code ?? result.signal}` +
            `${result.timedOut ? " timedOut" : ""}${result.truncated ? " truncated" : ""}`,
        );
        end(conn);
      },
      fail: (code, message) => {
        if (!done()) return;
        fail(code, message);
      },
    };
    let handle;
    conn.once("close", () => handle?.stop());
    handle = runner.start(request, ids, layout, runId, io);
  } catch (error) {
    host.log(`run=${runId} refused INTERNAL: ${plain(error)}`);
    send({ t: "error", code: "INTERNAL", message: plain(error) });
    end(conn);
  }
}

/** A listening-worth server with its proof and runner, without the start locks. */
export function createServer(config, host, options = {}) {
  const runner = createRunner(config, host);
  const proof =
    options.proof ??
    new PeerProof({
      dir: config.proofs,
      dshUid: config.dshUid,
      runnerUid: host.uid,
      fs: host.fs,
      log: host.log ?? (() => {}),
    });
  if (options.proof === undefined) proof.prepare();
  const state = { running: 0 };
  const server = createUnixServer((conn) => {
    handleConnection(conn, { config, host, runner, proof, state }).catch(() => {});
  });
  return { server, runner, proof };
}

/** Listens on the socket, created 0600 and opened to the socket group afterwards by start(). */
export function listenServer(server, socket) {
  return new Promise((resolve, reject) => {
    const old = process.umask(0o177);
    const onError = (error) => {
      process.umask(old);
      reject(new Refusal("SOCKET_FAILED", `the socket ${socket}: ${plain(error)}`));
    };
    server.once("error", onError);
    try {
      server.listen(socket, () => {
        process.umask(old);
        server.off("error", onError);
        resolve();
      });
    } catch (error) {
      process.umask(old);
      reject(new Refusal("SOCKET_FAILED", `the socket ${socket}: ${plain(error)}`));
    }
  });
}

/**
 * Starts serving: config, locks, proof, state and roots, then the socket. Throws a Refusal on any
 * failure; the CLI turns that into one plain line and exit 125.
 */
export async function start(config, host) {
  validateConfig(config);
  if (host.platform !== "linux") throw new Refusal("CONFIG_INVALID", "the member runner runs on Linux");
  const resolved = resolveConfigPaths(config, host.fs);
  const lock = checkLocks(resolved, host);
  const instance = createServer(resolved, host);
  try {
    await listenServer(instance.server, resolved.socket);
    host.fs.chownSync(resolved.socket, host.uid, lock.group.gid);
    host.fs.chmodSync(resolved.socket, 0o660);
    checkSocketFile(host.fs, resolved.socket, host.uid, lock.group.gid);
  } catch (error) {
    await new Promise((resolve) => {
      try {
        instance.server.close(resolve);
      } catch {
        resolve();
      }
    });
    try {
      host.fs.unlinkSync(resolved.socket);
    } catch {
      /* not made */
    }
    throw error instanceof Refusal ? error : new Refusal("SOCKET_FAILED", plain(error));
  }
  instance.server.on("error", (error) => host.log(`socket error: ${plain(error)}`));
  host.log(`listening on ${resolved.socket} as uid ${host.uid}, group ${lock.group.name}`);
  const close = async () => {
    await new Promise((resolve) => instance.server.close(resolve));
    try {
      host.fs.unlinkSync(resolved.socket);
    } catch {
      /* already gone */
    }
  };
  return { ...instance, close, lock };
}

const USAGE = "usage: node main.mjs --config <file>";

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") throw new Refusal("USAGE", USAGE);
  const host = realHost();
  const config = readConfigFile(argv[1], host);
  const instance = await start(config, host);
  const shutdown = () => {
    instance.close().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
  return instance;
}

function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isEntryPoint()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`member-runner: refused to start: ${plain(error)}\n`);
    process.exitCode = 125;
  }
}

export { USAGE, main };
