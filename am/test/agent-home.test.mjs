// Exercise am's shipped copies independently in the am CI job (#1208).
import { agentHomeTests } from "../../herdr/test/agent-home.mjs";
agentHomeTests(new URL("../bin/automagik-herdr.mjs", import.meta.url).pathname);

// am's own entry (am/bin/am.mjs): help with --agent-home is refused, never ignored (#1208).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("#1208 am help with --agent-home exits 2 and prints no help", () => {
  const am = new URL("../bin/am.mjs", import.meta.url).pathname;
  for (const args of [["help", "--agent-home", "/x"], ["--help", "--agent-home=/x"], ["-h", "--agent-home", "/x"]]) {
    const r = spawnSync(process.execPath, [am, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^am: --agent-home goes with am worker "<task>" only/);
    assert.equal(r.stdout, "");
  }
});
