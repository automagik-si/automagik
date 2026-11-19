import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { maskArgs } from "../mods/am-sidebar/bin/hc-socket-mask.mjs";
import { stableRootOf } from "../mods/am-sidebar/workers.js";

// A fixture pane behind the real wrapper's mount plan. The bwrap stand-in executes only
// the requested fixture edit: no real socket, owner data, or sandbox escape attempt. The
// wrapper's own argv puts one relay in front of the command (its own `--egress-relay ...
// -- <command>`), so the fixture starts the command the relay would start.
export function fixturePaneEdit(s, remove, index = 0) {
  const stable = stableRootOf(s.env);
  mkdirSync(stable, { recursive: true });
  const command = [process.execPath, "-e",
    'const fs = require("node:fs"); const p = process.argv[1]; '
    + 'const f = JSON.parse(fs.readFileSync(p)); '
    + (remove ? `delete f.bots[${index}].hcProxy; ` : `f.bots[${index}].hcProxy = false; `)
    + 'fs.writeFileSync(p, JSON.stringify(f));', join(s.project, ".herdr/bots.json")];
  const egressDir = join(s.root, "egress");
  mkdirSync(egressDir, { recursive: true });
  const masked = maskArgs(["--bind", s.project, s.project, "--", ...command], {
    HOME: join(s.root, "home"), DSH_SANDBOX_MASK: "1",
    AM_HC_REAL_SOCKET: join(s.root, "core/hc.sock"),
    AM_HC_PROXY_SOCKET: join(s.root, "run/automagik-hc-proxy/t5/hc.sock"),
  }, { containerSockets: [], packRoot: stable, egressDir });
  assert.equal(masked.fatal, null);
  assert.equal(masked.masked, true);
  assert.ok(masked.args.includes("--ro-bind"), "the wrapper protects the fixture approval parent");
  // The relay's own separator is the one before the pane command; the earlier one separates
  // the bwrap profile args from the command bwrap runs.
  const relayAt = masked.args.indexOf("--egress-relay");
  const cut = masked.args.indexOf("--", relayAt);
  assert.ok(relayAt > 0 && cut > relayAt, masked.args.join(" "));
  const child = spawnSync(masked.args[cut + 1], masked.args.slice(cut + 2), {
    env: { ...s.env, HC_TERMINAL_ID: "t5" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}
