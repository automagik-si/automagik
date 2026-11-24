// A separate process keeps serving while its harness blocks in spawnSync.
import { createServer } from "node:net";
import { appendFileSync, accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { inTestRoots } from "../mods/am-sidebar/coreSocket.mjs";
import { isGuardFolder } from "../mods/am-sidebar/hcGuard.mjs";
import { appendLine } from "./log-lines.mjs";

const [socket, ready, control] = process.argv.slice(2);
const server = createServer((client) => {
  let input = "";
  client.on("error", () => {});
  client.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      const env = JSON.parse(readFileSync(control, "utf8"));
      if (env.HC_FAKE_RPC_LOG) appendFileSync(env.HC_FAKE_RPC_LOG, JSON.stringify({ socket, ...request }) + "\n");
      if (env.HC_FAKE_CUTOFF_LOG) appendLine(env.HC_FAKE_CUTOFF_LOG, JSON.stringify({ kind: "rpc", socket, method: request.method }));
      if (request.method === "server.status" && env.HC_FAKE_CUTOFF_STATUS) {
        const { statusMode, ...result } = env.HC_FAKE_CUTOFF_STATUS;
        if (statusMode === "hang") return;
        if (statusMode === "malformed") { client.end("not JSON\n"); return; }
        client.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        return;
      }
      if (request.method === "proxy.workerTransport" && env.HC_FAKE_PROXY_TERMINAL) {
        const { core } = JSON.parse(readFileSync(env.HC_FAKE_STATE, "utf8"));
        client.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { v: 1, terminal: env.HC_FAKE_PROXY_TERMINAL, core } })}\n`);
        return;
      }
      if (env.HC_FAKE_STATE && (env.HC_FAKE_DIRECT_RPC === "1" || ["hello", "proxy.status", "terminal.get"].includes(request.method)
          || env.HC_FAKE_LINK_RPC === "1" && ["server.status", "machine.list"].includes(request.method)
          || env.HC_FAKE_TWO_CORE === "1" && request.method === "machine.list")) {
        const file = env.HC_FAKE_SOCKET_STATES ? JSON.parse(env.HC_FAKE_SOCKET_STATES)[socket] : env.HC_FAKE_STATE;
        const state = JSON.parse(readFileSync(file, "utf8"));
        const core = state.core ?? { id: "fakecore0000", name: "fake" };
        const result = request.method === "hello" && !state.proxyTerminal ? { core, you: state.boundTerminal ? { terminal: state.boundTerminal } : undefined }
          : request.method === "proxy.status" && state.proxyTerminal ? { terminal: state.proxyTerminal }
          : request.method === "server.status" ? { core }
          : request.method === "machine.list" ? { machines: state.machines ?? [] }
          : request.method === "terminal.get" ? state.terminals.find((pane) => pane.address === request.params.terminal)
          : request.method === "terminal.list" ? { terminals: state.terminals.filter((pane) => pane.state === "live") } : null;
        if (!result) throw new Error("unsupported method");
        client.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        return;
      }
      let words;
      if (request.method === "server.status") words = ["server", "status", "--json"];
      if (env.HC_FAKE_LINK_RPC === "1") {
        if (request.method === "machine.list") words = ["machine", "ls", "--json"];
        if (request.method === "machine.exec") {
          const { argv, on, cwd, timeout } = request.params;
          words = ["exec", "--json", "--timeout", String(timeout), "--on", on, "--cwd", cwd, "--", ...argv];
        }
      }
      if (!words) throw new Error("unsupported method");
      let hc;
      for (const dir of [...(env.PATH || "").split(":"), join(env.HOME || "", ".local/bin"), dirname(process.execPath)]) {
        if (!dir || isGuardFolder(dir)) continue;
        const file = join(dir, "hc");
        try { accessSync(file, constants.X_OK); } catch { continue; }
        if (!inTestRoots(file, env)) throw new Error(`test guard: ${file} is outside AUTOMAGIK_HERDR_TEST_ROOTS; nothing was run.`);
        hc = file;
        break;
      }
      if (!hc) throw new Error("hc (herdr-core) is not on PATH.");
      const r = spawnSync(hc, words, {
        env: { ...env, ...(env.HC_FAKE_LINK_RPC === "1" ? { HC_SOCKET: socket } : {}),
          HC_FAKE_ORIGIN: "core-status-helper" },
        encoding: "utf8", timeout: 15000,
      });
      if (r.status !== 0) throw new Error(r.stderr?.trim() || `exit ${r.status}`);
      client.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: JSON.parse(r.stdout) })}\n`);
    } catch (e) {
      client.end(`${JSON.stringify({ jsonrpc: "2.0", id: request?.id, error: { code: -32000, message: e.message } })}\n`);
    }
  });
});
const cleanup = () => { try { rmSync(socket, { force: true }); } catch {} };
process.on("exit", cleanup);
const stop = () => { cleanup(); process.exit(0); };
process.on("SIGTERM", stop);
process.stdin.resume();
process.stdin.on("end", stop);
server.listen(socket, () => writeFileSync(ready, "ready"));
