// A stand-in for `herdr-app` in the CLI tests: `ls` answers the window in the state file
// (HERDR_APP_FAKE_STATE), `do space.new <json>` adds a space with one tab and a shell to it and
// prints the new pane and terminal, as the real one documents; every call is logged
// (HERDR_APP_FAKE_LOG). `down: true` in the state is no window; `rival: true` has another start's
// space on the same folder open just before ours (two starts at once); `space.close` removes one.
// `place: true` plays Herdr showing hc's terminals: on `ls`, each live terminal of the fake hc
// (HC_FAKE_STATE) labelled `herdr.space` with a space here gets a pane, in its `herdr.tab` when
// that tab is there, else in a new tab of its own (id `tb-<address>`). `tab.move` (index from 1),
// `tab.rename` and `tab.close` change the window. With `place: true`, space.new's shell is a
// terminal of the fake hc too (live, the shell itself in front, its foreground pid the
// terminal's; `shellBusy: true`: vim in front, another pid; `shellJob: true`: at its prompt with a
// job left running, a child pid for fake-pgrep.mjs; `shellUnknown: true`: children pgrep can't
// tell, exit 3; `shellPgrepError: true`: pgrep failing with exit 1 and an error; `shellPgrepKilled: true`: pgrep
// killed before it exits, as at its timeout). space.new with a `machine` makes that machine's space: its shell is `<machine>/t-shN`
// to hc and in ls (as the bot's panes there), and space.new prints it bare (`t-shN`): neither
// shape is documented, so the CLI takes either. `qualifiedSpare: "lab"` gives even a local
// space.new a qualified spare in both the window and its reply. `canonicalSpare: true` uses an
// hc terminal id for the shell. `spaceReply` overrides reply fields,
// and `rivalTerminal` sets the rival's terminal when testing ambiguous ownership. `waitForSpace`
// holds space.new until a file appears. The tabs have Herdr's real ls shape
// (id, name, active, terminals: no pane count, no mod panes) unless `paneCounts: true` gives
// each a `panes` count; `modInSpare: true` then counts a mod pane beside the shell (as a count
// only). `probe: <path>` records, on every `do`, whether that file exists then (state.probed).
// The real window is never touched.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendLine } from "./log-lines.mjs";

const [command, ...rest] = process.argv.slice(2);
const statePath = process.env.HERDR_APP_FAKE_STATE;
appendLine(process.env.HERDR_APP_FAKE_LOG, JSON.stringify([command, ...rest]));
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.down) {
  process.stderr.write("herdr-app: no window is open\n");
  process.exit(1);
}
const save = () => writeFileSync(statePath, JSON.stringify(state));
const hcPath = process.env.HC_FAKE_STATE;
const linkedState = (hc, machine) => process.env.HC_FAKE_TWO_CORE === "1"
  ? hc.machines?.find((m) => m.name === machine)?.remoteState : null;
if (command === "do" && state.probe) {
  state.probed = [...(state.probed ?? []), [rest[0], existsSync(state.probe)]];
  save();
}
if (command === "ls" && state.place && process.env.HC_FAKE_STATE) {
  const hcState = JSON.parse(readFileSync(process.env.HC_FAKE_STATE, "utf8"));
  const shown = new Set((state.spaces ?? []).flatMap((s) => s.tabs.flatMap((t) => (t.terminals ?? []).map((p) => p.terminal))));
  for (const k of hcState.terminals ?? []) {
    const space = (state.spaces ?? []).find((s) => s.id === k.labels?.["herdr.space"]);
    if (k.state !== "live" || !space || shown.has(k.address)) continue;
    const pane = { terminal: k.address, pane: `p-${k.address}` };
    const tab = space.tabs.find((t) => t.id === k.labels["herdr.tab"]);
    if (tab) { tab.terminals.push(pane); if (state.paneCounts) tab.panes = (tab.panes ?? 0) + 1; }
    else space.tabs.push({ id: `tb-${k.address}`, name: String(space.tabs.length + 1), active: false, terminals: [pane], ...(state.paneCounts ? { panes: 1 } : {}) });
  }
  save();
}
if (command === "ls") {
  process.stdout.write(JSON.stringify({ spaces: state.spaces ?? [], recent: [] }));
  process.exit(0);
}
if (command === "do" && rest[0] === "space.new") {
  if (state.waitForSpace) {
    const until = Date.now() + 10_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(state.waitForSpace) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 20);
    if (!existsSync(state.waitForSpace)) {
      process.stderr.write("fake herdr-app: timed out waiting to open the space\n");
      process.exit(1);
    }
  }
  const args = JSON.parse(rest[1] ?? "{}");
  const n = state.next ?? 1;
  state.next = n + 1;
  state.spaces = (state.spaces ?? []).map((s) => ({ ...s, active: false }));
  if (state.rival) {
    state.rival = false;
    state.spaces.push({ id: "sp-rival", name: args.name ?? "", folder: args.folder ?? "", machine: null, active: false,
      tabs: [{ id: "tb-rival", name: "1", active: true, terminals: [{ terminal: state.rivalTerminal ?? "t-rival", pane: "p-rival" }] }] });
  }
  const count = state.paneCounts ? { panes: state.modInSpare ? 2 : 1 } : {};
  const machine = args.machine || null;
  const shellMachine = machine ?? state.qualifiedSpare;
  const bareShell = state.canonicalSpare ? `tsh${n}` : `t-sh${n}`;
  const shell = shellMachine ? `${shellMachine}/${bareShell}` : bareShell;
  state.spaces.push({ id: `sp-new${n}`, name: args.name ?? "", folder: args.folder ?? "", machine, active: true,
    tabs: [{ id: `tb-new${n}`, name: "1", active: true, terminals: [{ terminal: shell, pane: `p-new${n}` }], ...count }] });
  if (state.place && process.env.HC_FAKE_STATE) {
    const hcState = JSON.parse(readFileSync(hcPath, "utf8"));
    const target = linkedState(hcState, machine);
    const core = target ? JSON.parse(readFileSync(target, "utf8")) : hcState;
    const fg = state.shellBusy ? { argv: ["vim", "notes.md"], cwd: args.folder, pid: 9100 + n } : { argv: ["-zsh"], cwd: args.folder, pid: 9000 + n };
    const children = state.shellUnknown ? null : state.shellPgrepError ? "exit1" : state.shellPgrepKilled ? "killed" : state.shellJob ? [String(9500 + n)] : [];
    core.terminals.push({ address: target ? bareShell : shell, name: bareShell, cwd: args.folder, state: "live", parent: null, created_ms: 1, labels: {},
      pid: 9000 + n, foreground: fg, status: { app: "zsh", state: "idle" }, children });
    writeFileSync(target ?? hcPath, JSON.stringify(core));
  }
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ pane: `p-new${n}`, terminal: state.qualifiedSpare ? shell : bareShell, ...state.spaceReply }));
  process.exit(0);
}
if (command === "do" && rest[0] === "space.close") {
  const { id } = JSON.parse(rest[1] ?? "{}");
  const space = state.spaces?.find((s) => s.id === id);
  if (space?.machine && hcPath) {
    const target = linkedState(JSON.parse(readFileSync(hcPath, "utf8")), space.machine);
    if (target) {
      const core = JSON.parse(readFileSync(target, "utf8"));
      for (const tab of space.tabs) for (const { terminal } of tab.terminals) {
        const pane = core.terminals.find((p) => p.address === terminal.split("/").at(-1));
        if (pane) pane.state = "finished";
      }
      writeFileSync(target, JSON.stringify(core));
    }
  }
  state.spaces = (state.spaces ?? []).filter((s) => s.id !== id);
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write("{}");
  process.exit(0);
}
const tabIn = (id) => {
  for (const space of state.spaces ?? []) {
    const at = space.tabs.findIndex((t) => t.id === id);
    if (at >= 0) return { space, at };
  }
  return null;
};
if (command === "do" && ["tab.move", "tab.rename", "tab.close"].includes(rest[0])) {
  const args = JSON.parse(rest[1] ?? "{}");
  const hit = tabIn(args.id);
  if (!hit) {
    process.stdout.write(JSON.stringify({ error: `no tab ${args.id}` }));
    process.exit(1);
  }
  const [tab] = hit.space.tabs.splice(hit.at, 1);
  if (rest[0] === "tab.move") hit.space.tabs.splice(Math.max(0, args.index - 1), 0, tab);
  if (rest[0] === "tab.rename") hit.space.tabs.splice(hit.at, 0, { ...tab, name: args.name });
  save();
  process.stdout.write("{}");
  process.exit(0);
}
process.stderr.write(`fake herdr-app: ${command} is not faked\n`);
process.exit(3);
