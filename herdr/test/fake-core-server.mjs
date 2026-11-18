// A separate process keeps serving while its harness blocks in spawnSync.
import { createServer } from "node:net";
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { inTestRoots } from "../mods/am-sidebar/coreSocket.mjs";
import { isGuardFolder } from "../mods/am-sidebar/hcGuard.mjs";

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
      if (request.method !== "server.status") throw new Error("unsupported method");
      const env = JSON.parse(readFileSync(control, "utf8"));
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
      const r = spawnSync(hc, ["server", "status", "--json"], { env, encoding: "utf8", timeout: 15000 });
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
