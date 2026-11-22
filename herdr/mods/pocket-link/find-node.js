// Which Node runs the bridge. Herdr started from the Dock or by launchd has a short PATH, without
// nvm, volta, fnm or asdf, so a bare `node` often isn't there even when the bridge runs fine.
// Looks, in order: (a) what the bridge was last run with (its login service, then the `.node` it
// records in the mod folder), (b) the user's login shell, then Herdr's own PATH, (c) the usual
// install places. (b) finds a Node set up in login files (.zprofile, .bash_profile, .profile);
// nvm usually lives in .zshrc or .bashrc, which a non-interactive login shell skips, so (c) finds it. Every candidate must answer `--version` with 20.3 or newer.
// Pure: main.js passes Herdr's exec and file reads; find-node.test.mjs passes fakes.

import { servicePaths } from "./bridge/service-paths.js";

export { servicePaths };

export const MIN = [20, 3, 0];
const LABEL = "dev.herdr.pocket-link"; // bridge/bridge.mjs
const UNIT = "herdr-pocket-link.service";

// "v22.3.0" → [22, 3, 0]
export function version(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? m.slice(1).map(Number) : null;
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export const newEnough = (v) => Boolean(v) && compare(v, MIN) >= 0;

// The Node a LaunchAgent plist or systemd unit runs.
export function servicePath(text) {
  const { node } = servicePaths(text ?? "");
  return node?.startsWith("/") ? node : null;
}

// The login shell, with 3 s to answer: a slow rc file can't hang the dialog. The shell gets its own
// process group (setsid on Linux, where sh is dash and has no job control without a terminal;
// `set -m` elsewhere), and at 3 s the whole group gets SIGKILL, so neither a shell that ignores
// TERM nor a child it started outlives the cap. Without either, only the shell itself is killed.
// Its answer goes to a temp file, so nothing left behind can hold stdout open.
// `kill -SIG -pid` names a group in dash and bash alike; dash's kill rejects `--`.
export const SHELL_PROBE = [
  'f=$(mktemp) || exit 1; s="${SHELL:-/bin/sh}"',
  'if command -v setsid >/dev/null 2>&1; then setsid "$s" -lc "command -v node" >"$f" 2>/dev/null </dev/null & else set -m 2>/dev/null; "$s" -lc "command -v node" >"$f" 2>/dev/null </dev/null & fi',
  'p=$!; (sleep 3; kill -KILL -$p 2>/dev/null || kill -KILL $p) >/dev/null 2>&1 & w=$!',
  'wait $p; c=$?; kill -TERM -$w 2>/dev/null || kill $w 2>/dev/null; cat "$f"; rm -f "$f"; exit $c',
].join("\n");

const lastPath = (out) => (out ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")).pop() ?? null;

// Version folders ("v22.1.0", "22.1.0"), newest first, only those new enough.
const newestFirst = (names) =>
  names
    .map((n) => ({ n, v: version(n) }))
    .filter((x) => newEnough(x.v))
    .sort((a, b) => compare(b.v, a.v))
    .map((x) => x.n);

/**
 * io: { home, platform, mod, exec(cmd, args) → Promise<{code, stdout, stderr}> (rejects when it can't
 * start), read(path) → Promise<string|null>, list(dir) → Promise<string[]> }
 * → { path, version, from } or { path: null, checked: [{ place, old? }] }
 */
export async function findNode(io) {
  const { home, platform, mod } = io;
  const checked = [];
  const tried = new Set();

  // Answers --version with 20.3+? Notes an older one on the place, for the message.
  const works = async (path, place) => {
    if (!path || tried.has(path)) return null;
    tried.add(path);
    const r = await io.exec(path, ["--version"]).catch(() => null);
    const v = r && r.code === 0 ? version(r.stdout) : null;
    if (newEnough(v)) return { path, version: v.join("."), from: place.place };
    if (v) place.old = `${path} is v${v.join(".")}`;
    return null;
  };
  const look = async (label, paths) => {
    const place = { place: label };
    checked.push(place);
    for (const p of await paths()) {
      const hit = await works(p, place);
      if (hit) return hit;
    }
    return null;
  };
  const read = (p) => io.read(p).catch(() => null);
  const list = (dir) => io.list(dir).catch(() => []);
  const sh = (script) => io.exec("sh", ["-c", script]).then((r) => lastPath(r.stdout), () => null);
  const versions = async (dir, tail) => newestFirst(await list(dir)).map((n) => `${dir}/${n}${tail}`);

  const mac = platform === "darwin";
  const fnm = [`${home}/.local/share/fnm`, ...(mac ? [`${home}/Library/Application Support/fnm`] : [])];
  const places = [
    // (a) what the bridge was installed or started with
    ["the login service", async () => [servicePath(await read(mac ? `${home}/Library/LaunchAgents/${LABEL}.plist` : `${home}/.config/systemd/user/${UNIT}`))]],
    ["the Node Pocket Link last started with", async () => [lastPath(await read(`${mod}/.node`))]],
    // (b) the shells
    ["your login shell's PATH", async () => [await sh(SHELL_PROBE)]],
    ["Herdr's PATH", async () => [await sh("command -v node")]],
    // (c) where version managers and package managers put it
    ["~/.nvm/versions/node", () => versions(`${home}/.nvm/versions/node`, "/bin/node")],
    ["~/.volta/bin", async () => [`${home}/.volta/bin/node`]],
    [fnm.map((d) => d.replace(home, "~")).join(", "), async () => (await Promise.all(fnm.map((d) => versions(`${d}/node-versions`, "/installation/bin/node")))).flat().concat(fnm.map((d) => `${d}/aliases/default/bin/node`))],
    ["~/.asdf/shims", async () => [`${home}/.asdf/shims/node`]],
    [mac ? "/opt/homebrew/bin, /usr/local/bin" : "/usr/local/bin, /usr/bin", async () => (mac ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"] : ["/usr/local/bin/node", "/usr/bin/node"])],
  ];
  for (const [label, paths] of places) {
    const hit = await look(label, paths);
    if (hit) return hit;
  }
  return { path: null, checked };
}

// The dialog's "no Node" text: the places it looked, and any Node it found that is too old.
export function noNodeMessage(checked, home) {
  const tilde = (s) => (home ? s.split(home).join("~") : s);
  const old = (checked ?? []).filter((c) => c.old).map((c) => tilde(c.old));
  return [
    "Pocket Link runs a small bridge with Node.js 20.3 or newer, and couldn't find one.",
    checked?.length ? ` It looked in ${checked.map((c) => c.place).join("; ")}.` : "",
    old.length ? ` Too old: ${old.join("; ")}.` : "",
    " Install Node (nodejs.org, or your package manager), then open Pocket Link again.",
  ].join("");
}
