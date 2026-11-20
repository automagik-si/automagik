// A fake herdr-core 0.1.14 for the hc proxy's tests: plain mode only, one JSON-RPC message per
// line, calls on one connection handled one at a time, any number of connections. It answers
// exactly the methods the proxy may forward, plus `hello` (which the proxy must never forward),
// and records every request it sees so a row can prove a refusal never reached it. Hermetic: it
// listens on a caller-chosen Unix socket and never touches a real core. Apache-2.0.
import net from "node:net";
import { unlinkSync } from "node:fs";

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Start the fake. `terminals` are hc Public-like rows (address, name, labels, cwd, parent,
 * state); a row with `huge: true` answers terminal.read with `hugeBytes` of text. `machines`
 * is the `terminal.list` inventory (`{ name, target, state }` per connected machine), and a
 * machine's terminal rows join `terminals` under a `machine/tN` address. `afterGet`
 * runs after a terminal.get reply, so a row can rename a target between the check and the call.
 */
export async function startFakeCore({ socket, version = "0.1.14", terminals = [], machines = [], hugeBytes = 3 * 1024 * 1024 } = {}) {
  if (!socket) throw new Error("startFakeCore needs a socket path");
  try { unlinkSync(socket); } catch { /* first run */ }
  const log = [];
  const sockets = new Set();
  let connections = 0;
  const state = { version, terminals, machines, hugeBytes, afterGet: null, waitMs: 0, hang: null, templates: [], listError: null };
  const send = (sock, message) => sock.write(`${JSON.stringify(message)}\n`);
  const ok = (sock, id, result) => send(sock, { jsonrpc: "2.0", id, result });
  const fail = (sock, id, kind, message) => send(sock, {
    jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind } },
  });
  const record = (word) => state.terminals.find((t) => t.address === word) ?? state.terminals.find((t) => t.name === word) ?? null;

  async function handle(sock, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      fail(sock, null, "invalid", "not JSON");
      return;
    }
    if (!isRecord(request)) {
      fail(sock, null, "invalid", "not a request");
      return;
    }
    const { id, method, params = {} } = request;
    log.push({ conn: sock.connId, method, params: isRecord(params) ? params : {} });
    switch (method) {
      case "server.status":
        ok(sock, id, { version: state.version, core: { id: "fake-core", name: "fake" } });
        return;
      case "hello":
        ok(sock, id, { generation: 1, version: state.version, framed: true, methods: [], features: [] });
        return;
      case "terminal.list":
        if (state.hang === "terminal.list") return;
        // `state.listError` is an error reply that (malformed) also carries rows, so a row can
        // prove an error is never a way to pass the unfiltered list through.
        if (state.listError) {
          send(sock, { jsonrpc: "2.0", id, error: state.listError,
            result: { terminals: state.terminals, machines: state.machines, hidden_finished: 0 } });
          return;
        }
        ok(sock, id, { terminals: state.terminals, machines: state.machines, hidden_finished: 0 });
        return;
      case "terminal.get": {
        const found = record(params.terminal);
        if (!found) { fail(sock, id, "not_found", `no terminal ${params.terminal}`); return; }
        ok(sock, id, { ...found });
        state.afterGet?.(found, params);
        return;
      }
      case "terminal.read": {
        const found = record(params.terminal);
        if (!found) { fail(sock, id, "not_found", `no terminal ${params.terminal}`); return; }
        const text = found.huge ? "x".repeat(state.hugeBytes) : `screen of ${found.address}\n`;
        ok(sock, id, { text, complete: true, how: "screen", why: null });
        return;
      }
      case "terminal.wait": {
        if (state.hang === "terminal.wait") return;
        if (state.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, state.waitMs));
        ok(sock, id, {
          terminal: params.terminal ?? null, ended: false, reason: "timeout", status: "working", turn: 1,
          exit_code: null, signal: null, children: [],
        });
        return;
      }
      case "terminal.send": {
        const found = record(params.terminal);
        ok(sock, id, { status: "idle", turn: 1, started: true, target: found?.address ?? null });
        return;
      }
      case "terminal.kill":
        ok(sock, id, { address: record(params.terminal)?.address ?? params.terminal, state: "finished" });
        return;
      case "terminal.rm":
        ok(sock, id, { removed: record(params.terminal)?.address ?? params.terminal });
        return;
      case "terminal.label":
        ok(sock, id, { address: record(params.terminal)?.address ?? params.terminal, labels: params.labels });
        return;
      case "templates.list":
        ok(sock, id, { templates: state.templates });
        return;
      case "terminal.run":
        ok(sock, id, { terminal: { address: "t200", state: "live" }, argv: params.argv });
        return;
      default:
        fail(sock, id, "refused", `fake core has no ${method}`);
        return;
    }
  }

  const server = net.createServer((sock) => {
    sock.connId = ++connections;
    sock.unref();
    sockets.add(sock);
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    sock.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        const at = buffer.indexOf(10);
        if (at < 0) break;
        const line = buffer.subarray(0, at).toString("utf8");
        buffer = buffer.subarray(at + 1);
        if (!line.trim()) continue;
        chain = chain.then(() => handle(sock, line));
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {
      sockets.delete(sock);
      sock.destroy();
    });
  });
  server.unref();
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      try { server.close(); } catch { /* not listening */ }
      reject(err);
    };
    server.once("error", onError);
    server.listen(socket, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return {
    socket,
    log,
    state,
    calls: (method) => log.filter((row) => row.method === method),
    connections: () => connections,
    clearLog: () => { log.length = 0; },
    close: async () => {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      try { unlinkSync(socket); } catch { /* already gone */ }
    },
  };
}
