// Run the real CLI against the linked machine's own view of fake-hc. Its pane IDs
// are local there; the controller sees those same panes with the machine prefix.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outerPath = process.env.HC_FAKE_STATE;
const outer = JSON.parse(readFileSync(outerPath, "utf8"));
const localPath = `${outerPath}.holding`;
const prefix = "vm/";
const local = (value) => value?.startsWith(prefix) ? value.slice(prefix.length) : value;
const state = { ...outer, core: { id: "core-of-vm", name: "vm" }, machines: [], terminals: outer.terminals
  .filter((pane) => pane.address.startsWith(prefix))
  .map((pane) => ({ ...pane, address: local(pane.address), parent: local(pane.parent) })) };
writeFileSync(localPath, JSON.stringify(state));
const result = spawnSync(process.execPath, [process.env.HOLDING_CLI, ...process.argv.slice(2)], {
  encoding: "utf8", env: { ...process.env, HC_FAKE_STATE: localPath,
    HC_FAKE_LOG: `${outerPath}.holding.log`, HERDR_APP_HOME: process.env.HOLDING_APP,
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "1", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "2000" },
});
const after = JSON.parse(readFileSync(localPath, "utf8"));
outer.next = after.next;
outer.terminals = [...outer.terminals.filter((pane) => !pane.address.startsWith(prefix)),
  ...after.terminals.map((pane) => ({ ...pane, address: prefix + pane.address,
    parent: pane.parent ? prefix + pane.parent : null }))];
writeFileSync(outerPath, JSON.stringify(outer));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
