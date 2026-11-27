// The `herdr` surface am-automations needs under `node --test`: an exec the test answers itself
// (state.exec), a scratch home and a plain theme. Every exec is logged, so a test can show the panel
// never ran the install line it offers. Not Herdr: the in-app check in the mod's RECIPE still applies.
export const state = {
  home: "/home/someone", calls: [], runs: [], agents: [], hc: null,
  exec: async () => ({ code: 127, stdout: "", stderr: "no such file" }),
};
export async function exec(command, args = []) { state.calls.push([command, ...args]); return state.exec(command, args); }
export const home = () => state.home;
const T = ["background", "border", "foreground", "muted", "dim", "raised", "solid", "solid_foreground", "selected", "accent",
  "input", "hover", "blocked", "working", "idle", "ansi1"];
// Each key its own value, so a test can tell which one an element was drawn in.
export const theme = () => Object.fromEntries(T.map((k) => [k, `#${k}`]));
export const terminals = () => state.terminals ?? [];
export const panes = () => state.panes ?? [];
export const spaces = () => state.spaces ?? [];
export function run(name, args) { state.runs.push([name, args]); }
export function notify() {}
// state.hc, when a test sets it, answers hc itself (a fake hc: `templates --json`).
export async function hc(args = []) { return state.hc ? state.hc(args) : { code: 0, stdout: "[]", stderr: "" }; }
export async function pickFolder() { return null; }
export const watchFolder = () => new Promise(() => {});
export async function knownAgents() { return state.agents; }
