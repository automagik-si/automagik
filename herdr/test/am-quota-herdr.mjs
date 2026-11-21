// The `herdr` surface am-quota's panel imports, all in memory: files are a Map (nothing on disk is
// read or written), `exec` only records its calls and answers from `state.exec` (nothing is
// spawned), and the platform is Linux, so the panel never asks for a Keychain item at all.
export const state = {
  appHome: "/stub-app",
  home: "/stub-home",
  platform: "linux",
  files: new Map(),
  calls: [],
  exec: () => ({ code: 0, stdout: "", stderr: "" }),
  // hc: recorded in hcCalls, answered by state.hc (a promise the test resolves, to hold a wait).
  hcCalls: [],
  hc: () => ({ code: 0, stdout: "{}", stderr: "" }),
};

export const appHome = () => state.appHome;
export const home = () => state.home;
export const window = () => ({ platform: state.platform });
// Each theme token reads as its own name, so a test can say which colour a line was drawn in.
export const theme = () => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `t.${k}` : undefined) });
export async function readTextFile(path) {
  state.onRead?.(path);
  return state.files.has(path) ? state.files.get(path) : null;
}
export async function writeTextFile(path, text, expected) {
  const pause = state.onWrite?.(path, text, expected);
  if (pause?.then) await pause;
  const now = state.files.has(path) ? state.files.get(path) : null;
  if ((expected ?? null) !== now) throw new Error(`stale write to ${path}`);
  state.files.set(path, text);
}
// The restart's own terminal (#433): `hc run … -- sh -c <script> sh <out> <err> <code> <argv…>`.
// Nothing is spawned: <argv> is answered by state.exec, as a direct exec would be, and recorded in
// calls with no options. state.runAs: "done" (default: the answer lands in the three files), "gone"
// (no files, and hc says there is no such terminal) or "live" (no files yet: a test writes them
// with finishRun, say from its fake hc wait). Each run's { address, files, answer } is in
// state.runs; hc ls and hc get of a run's terminal still go to state.hc.
export function finishRun(run, answer = run.answer) {
  state.files.set(run.files.out, answer?.stdout ?? "");
  if (run.files.err) state.files.set(run.files.err, answer?.stderr ?? "");
  state.files.set(run.files.code, `${answer?.code ?? 0}\n`);
}
// state.runFail: hc run refuses (nothing starts); state.runNoAddress: it starts, its answer names no terminal.
async function runRestart(args) {
  if (state.runFail) return { code: 1, stdout: "", stderr: state.runFail };
  const at = args.indexOf("--");
  const privateRun = args[at + 3].startsWith("umask 077");
  const [out, ...words] = args.slice(at + 5);
  const [err, code, ...argv] = privateRun ? [null, words[0], ...words.slice(2)] : words;
  if (privateRun) {
    const slug = words[1];
    const folder = out.slice(0, out.lastIndexOf("/"));
    for (const path of state.files.keys()) {
      if (path.startsWith(`${folder}/${slug}-`) && Date.now() - state.fileMtimes?.get(path) >= 1441 * 60_000) state.files.delete(path);
    }
  }
  const address = `t${900 + (state.runs ??= []).length}`;
  state.calls.push(argv);
  (state.execOptions ??= []).push(null);
  const answer = await state.exec(argv[0], argv.slice(1), undefined);
  const run = { address, args, files: { out, err, code }, answer };
  state.runs.push(run);
  if ((state.runAs ?? "done") === "done") finishRun(run);
  return { code: 0, stdout: JSON.stringify(state.runNoAddress ? {} : { address }), stderr: "" };
}
export async function hc(args) {
  state.hcCalls.push(args);
  if (args[0] === "run" && args.includes("--") && args[args.indexOf("--") + 2] === "-c") return runRestart(args);
  return state.hc(args);
}
// Each call's options (exec's { timeout }) in execOptions, beside its argv in calls.
// The panel's prepare before a restart (#433): `sh -c 'mkdir -p -- "$1" || exit 3; …' sh <folder>
// <names…>`, kept in state.prepares (not calls) and answered by state.prepare(args) when a test sets
// it, else as a Herdr with PATH and HOME set: NAME=value lines.
const PREPARED = { code: 0, stdout: "PATH=/herdr/bin:/usr/bin:/bin\nHOME=/stub-home\n", stderr: "" };
export async function exec(command, args = [], options) {
  if (command === "sh" && String(args[1] ?? "").startsWith('mkdir -p -- "$1" || exit 3;')) {
    (state.prepares ??= []).push(args);
    return state.prepare ? state.prepare(args) : PREPARED;
  }
  state.calls.push([command, ...args]);
  (state.execOptions ??= []).push(options ?? null);
  return state.exec(command, args, options);
}
