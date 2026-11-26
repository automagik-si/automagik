// CI only: starts socket servers. The targets answer server.status on scratch sockets.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { AM } from "./accounts-fixture.mjs";
import { setupLinked, verifyLinked } from "./accounts-apply-fixture.mjs";

test("apply switches one bound target, reads it back and leaves mixed, away and old targets unchanged", async (t) => {
  const fixture = setupLinked(t);
  const [one, mixed] = fixture.machines;
  const calls = [];
  for (const vm of [one, mixed]) {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const { id, method } = JSON.parse(buffer.slice(0, end));
        calls.push([vm.id, method]);
        socket.end(JSON.stringify({ jsonrpc: "2.0", id, result: { core: { id: vm.id } } }) + "\n");
      });
    });
    server.listen(vm.env.AUTOMAGIK_HERDR_CORE_SOCKET);
    await once(server, "listening");
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  }
  const reply = await fixture.s.start(AM, ["accounts", "apply"]);
  verifyLinked(fixture, reply, { positive: true });
  assert.deepEqual(calls, [[mixed.id, "server.status"], ...Array.from({ length: 3 }, () => [one.id, "server.status"])]);
});
