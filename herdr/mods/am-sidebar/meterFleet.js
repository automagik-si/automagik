// usagemeter on every linked machine: the pack is the one usagemeter installer for the fleet.
// Each machine's own `usagemeter sync` writes that machine's `herdr-meter` doc to its own
// herdr-core, and the phone reads each doc there (`doc.get {name: "herdr-meter", on: <machine>}`),
// so the binary has to be installed, and run, on every machine, not just this computer.
//
// - Install: the signed meter-lane pointer is read and checked once, on the computer running the
//   command (meterLane.mjs); `uname -sm` on each machine picks its target, and the pointer names
//   that build's asset and sha256. The machine itself downloads the asset from the release the
//   pointer names, checks it against that sha256, and renames a temp file beside
//   ~/.local/bin/usagemeter into place. One that already reports the pointer's version stays, a
//   newer one (or a dev build not older by its X.Y.Z) is never downgraded, and a link, a folder or
//   a binary that reports no version is left as it is.
// - Sync: the sidebar's (meter.js SYNC) on each connected machine, one at a time.
// - Uninstall: only a binary that still reports the version the pack recorded for that machine.
// Fixed scripts only, arguments as argv (never spliced into the script). Pure: the runner (`hc
// exec` for the CLI, Herdr's exec for the sidebar) is passed in, so `node --test` runs it.
// Apache-2.0.

/** `uname -sm` → the pointer's target (the aliases Pocket Link knew too); the Intel Mac build stays for good. */
const PLATFORMS = Object.freeze({
  "Darwin arm64": "darwin-arm64", "Darwin aarch64": "darwin-arm64", "Darwin x86_64": "darwin-x86_64",
  "Linux x86_64": "linux-x86_64", "Linux amd64": "linux-x86_64", "Linux aarch64": "linux-aarch64", "Linux arm64": "linux-aarch64",
});
/** The target for a machine's `uname -sm`, or null when no build is made for it. */
export const targetFor = (uname) => PLATFORMS[String(uname ?? "").trim().replace(/\s+/g, " ")] ?? null;
/** The build a checked pointer names for a machine's `uname -sm` (`{ name, sha256, size }`), or null. */
export const assetFor = (uname, pointer) => pointer?.assets?.[targetFor(uname)] ?? null;

/**
 * Where the person agreed to usagemeter, from the install record: `all` (this computer and every
 * linked machine), `local`, `none`, or null when nobody asked. The record's scope line says it,
 * and only an explicit `automagik-herdr meter install` or an install.sh run of this release writes
 * `all`. A record without one (an install.sh before this one wrote none, even for --no-usagemeter)
 * is never `all`: `local` when it shows the pack installed usagemeter on this computer, else
 * null (`update` then installs nowhere and prints OPT_IN).
 */
export function meterScope(record) {
  if (!record) return null;
  if (record.usagemeterScope) return record.usagemeterScope;
  return record.usagemeter ? "local" : null;
}

/** The line `update` prints when nobody asked: how to opt in. */
export const OPT_IN = "usagemeter: not installed by the update (no install has asked for it). To install it on this computer and every linked machine: am meter install";

/** A machine name as `hc machine ls` gives it, safe in the ownership record (`name:version,…`). */
export const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The linked machines in `hc machine ls --json` (it never lists this computer): `{ name, connected }`
 * each, temporary ones left out (the sidebar does the same), names the record can't hold dropped.
 */
export function linkedMachines(json) {
  let list = [];
  try { list = (typeof json === "string" ? JSON.parse(json) : json)?.machines ?? []; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((m) => m && !m.temporary && typeof m.name === "string" && MACHINE_NAME.test(m.name))
    .map((m) => ({ name: m.name, connected: m.state === "connected" }));
}

// The version a usagemeter reports (`usagemeter X.Y.Z`, a dev build `X.Y.Z-dev` or `X.Y.Z+b`),
// install.sh's meter_version, and its version_ge (field by field as numbers).
const VERSION_SH = `ver() {
  "$1" --version </dev/null 2>/dev/null \\
    | sed -n 's/^usagemeter \\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\([-+][0-9A-Za-z.+-]*\\)\\{0,1\\}\\)$/\\1/p' | head -n 1
}
ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }' </dev/null
}
dest=$HOME/.local/bin/usagemeter`;

/**
 * Run on the machine as `sh -c INSTALL sh <base> <asset> <version> <sha256>`: <base> the download
 * folder of the release the checked pointer names (https, or a test's file://), <sha256> the one it
 * names for <asset>. One download, checked against <sha256> before anything is written beside the
 * binary. Only then is the new binary run once, from beside the binary (a temp folder may be
 * noexec): `--version` under `env -i` (no variable but a bare PATH and a scratch HOME; usagemeter
 * opens no network connection), killed after SMOKE_SECONDS, and its whole output must be exactly
 * `usagemeter <version>`. The binary it replaces, which at that point can only be a regular file
 * reporting an older version (a link, an unversioned or a newer one never reaches the swap), is kept
 * as ~/.local/bin/usagemeter.prev: a hard link, so its mode is the binary's, replaced at the next
 * swap. A broken release still leaves a working meter and one rename back:
 * `mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter`. Prints one line: `current`,
 * `newer <v>`, `link`, `unknown` (left as it is), `installed`, or `installed prev` (the old one
 * kept). Fails (stderr, exit 3: checksum, 4: no curl, 5: download, 6: write, 7: the new binary
 * does not run as <version>) with the old binary in place and no temp file left. The state is
 * looked at again just before the rename, in case something else put a usagemeter there meanwhile.
 */
/** How long the new binary's `--version` may take before the swap is refused. */
export const SMOKE_SECONDS = 10;
export const INSTALL = `set -u
base=$1; asset=$2; want=$3; sum=$4
${VERSION_SH}
dir=\${dest%/*}
state() {
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then echo link; return 0; fi
  [ -f "$dest" ] || return 0
  have=$(ver "$dest")
  if [ -z "$have" ]; then echo unknown
  elif [ "$have" = "$want" ]; then echo current
  elif ge "\${have%%[-+]*}" "$want"; then echo "newer $have"
  fi
}
s=$(state); if [ -n "$s" ]; then echo "$s"; exit 0; fi
case $sum in *[!0-9a-f]*|'') echo "no sha256 for $asset" >&2; exit 3 ;; esac
[ \${#sum} -eq 64 ] || { echo "no sha256 for $asset" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "curl is not installed" >&2; exit 4; }
case $base in https://*) proto='=https' ;; file://*) proto='=file' ;; *) echo "not a release folder: $base" >&2; exit 5 ;; esac
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/usagemeter.XXXXXX") || { echo "could not make a temporary folder" >&2; exit 6; }
part=
trap 'rm -rf "$tmp"; if [ -n "$part" ]; then rm -f "$part"; fi' EXIT
curl -fsSL --path-as-is --proto "$proto" --proto-redir '=https' "$base/$asset" -o "$tmp/$asset" </dev/null 2>/dev/null \\
  || { echo "could not download $base/$asset" >&2; exit 5; }
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$asset" </dev/null); else got=$(shasum -a 256 "$tmp/$asset" </dev/null); fi
got=\${got%% *}
[ "$got" = "$sum" ] || { echo "$asset is not the build the signed meter-lane pointer names (sha256 $got, expected $sum): nothing was installed" >&2; exit 3; }
mkdir -p "$dir" || { echo "could not make $dir" >&2; exit 6; }
part=$(mktemp "$dir/.usagemeter.XXXXXX") || { echo "could not write in $dir" >&2; exit 6; }
cp "$tmp/$asset" "$part" && chmod 755 "$part" || { echo "could not write $dest" >&2; exit 6; }
env -i PATH=/usr/bin:/bin HOME="$tmp" "$part" --version </dev/null >"$tmp/smoke" 2>/dev/null & sp=$!
( sleep ${SMOKE_SECONDS}; kill -9 "$sp" ) </dev/null >/dev/null 2>&1 & kp=$!
wait "$sp"; kill "$kp" 2>/dev/null
runs=$(cat "$tmp/smoke")
[ "$runs" = "usagemeter $want" ] || { said=$(printf '%s' "$runs" | tr '\\n' ' ' | cut -c1-80); echo "the new usagemeter does not run as $want (--version said: \${said:-nothing}): the old binary stays, nothing was installed" >&2; exit 7; }
s=$(state); if [ -n "$s" ]; then echo "$s"; exit 0; fi
prev="$dest.prev"; kept=
if [ -f "$dest" ] && [ ! -L "$dest" ]; then
  if [ -L "$prev" ] || { [ -e "$prev" ] && [ ! -f "$prev" ]; }; then echo "$prev is a link or a folder, not the backup this keeps: nothing was installed" >&2; exit 6; fi
  ln -f "$dest" "$prev" 2>/dev/null || { echo "could not keep the previous binary as $prev: nothing was installed" >&2; exit 6; }
  kept=prev
fi
mv -f "$part" "$dest" || { echo "could not write $dest" >&2; exit 6; }
part=
echo "installed $kept"`;

/** Run as `sh -c UNINSTALL sh <version>`: removes the binary only if it still reports <version>. */
export const UNINSTALL = `set -u
${VERSION_SH}
if [ ! -f "$dest" ] || [ -L "$dest" ]; then echo absent; exit 0; fi
have=$(ver "$dest")
if [ "$have" != "$1" ]; then echo "other \${have:-none}"; exit 0; fi
rm -f "$dest" && echo removed`;

const short = (s) => String(s ?? "").trim().split("\n").filter(Boolean).pop()?.slice(0, 400) ?? "";

/** `hc exec --json` output ({ code, stdout, stderr: base64, timed_out }) as { code, stdout, stderr }. */
export function decodeExec(r, timeout) {
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  if (!j || typeof j !== "object" || !("code" in j)) return { code: -1, stdout: "", stderr: short(r.stderr) || short(r.stdout) || `hc exec failed (exit ${r.code})` };
  if (j.timed_out) return { code: -1, stdout: "", stderr: `timed out after ${timeout} s` };
  const text = (b) => { try { return Buffer.from(String(b ?? ""), "base64").toString("utf8"); } catch { return ""; } };
  return { code: typeof j.code === "number" ? j.code : -1, stdout: text(j.stdout), stderr: text(j.stderr) };
}

/** The `hc` arguments that run `argv` on `machine` within `timeout` seconds. */
export const hcExecArgs = (machine, argv, timeout) => ["exec", "--json", "--timeout", String(timeout), "--on", machine, "--", ...argv];

/**
 * Installs the build a checked meter-lane pointer names (meterLane.mjs readMeterLane: `pointer`, and
 * `base`, its release's download folder) on one machine (null: this computer). `run(argv, { on,
 * timeout })` resolves `{ code, stdout, stderr }` and never rejects. Resolves `{ machine, status,
 * version?, want, why? }`, status one of installed | current | newer | link | unknown | failed.
 */
export async function installOn(run, machine, { pointer, base }) {
  const want = pointer.version;
  const u = await run(["uname", "-sm"], { on: machine, timeout: 20 });
  if (u.code !== 0) return { machine, status: "failed", want, why: short(u.stderr) || "could not reach it" };
  const asset = assetFor(u.stdout, pointer);
  if (!asset) return { machine, status: "failed", want, why: `no usagemeter build for ${short(u.stdout).slice(0, 40) || "this system"}` };
  const r = await run(["sh", "-c", INSTALL, "sh", base, asset.name, want, asset.sha256], { on: machine, timeout: 180 });
  if (r.code !== 0) return { machine, status: "failed", want, why: short(r.stderr) || `exit ${r.code}` };
  const [word, have] = short(r.stdout).split(/\s+/);
  if (word === "installed") return { machine, status: word, version: want, want, ...(have === "prev" ? { prev: true } : {}) };
  if (word === "current") return { machine, status: word, version: want, want };
  if (word === "newer") return { machine, status: "newer", version: have ?? null, want };
  if (word === "link" || word === "unknown") return { machine, status: word, want };
  return { machine, status: "failed", want, why: `unexpected answer: ${short(r.stdout) || "(none)"}` };
}

/** Removes the pack's usagemeter from one machine: `{ machine, status: removed|absent|other|failed, why? }`. */
export async function uninstallOn(run, machine, version) {
  const r = await run(["sh", "-c", UNINSTALL, "sh", version], { on: machine, timeout: 30 });
  if (r.code !== 0) return { machine, status: "failed", why: short(r.stderr) || `exit ${r.code}` };
  const [word, have] = short(r.stdout).split(/\s+/);
  if (word === "removed" || word === "absent") return { machine, status: word };
  if (word === "other") return { machine, status: "other", why: have === "none" ? "it reports no usagemeter version" : `it is usagemeter ${have}` };
  return { machine, status: "failed", why: `unexpected answer: ${short(r.stdout) || "(none)"}` };
}

/**
 * The record's per-machine line after `results`: installed → that version, newer/link/unknown → not
 * the pack's any more, current/failed/removed-elsewhere → as it was. `machines`: { name: version }.
 */
export function recordAfter(machines, results) {
  const next = { ...machines };
  for (const r of results) {
    if (!r.machine) continue;
    if (r.status === "installed") next[r.machine] = r.version;
    else if (["newer", "link", "unknown", "removed", "absent", "other"].includes(r.status)) delete next[r.machine];
  }
  return next;
}

/** One line for a person per result. */
export function resultLine(r) {
  const where = r.machine ? `on ${r.machine}` : "on this computer";
  switch (r.status) {
    case "installed": return `usagemeter ${r.version} ${where}: installed (signed pointer, checksum ok)${r.prev ? "; the previous one is kept as ~/.local/bin/usagemeter.prev (to go back: mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter)" : ""}.`;
    case "current": return `usagemeter ${r.version} ${where}: already installed.`;
    case "newer": return `usagemeter ${r.version ?? "(newer)"} ${where} is not older than ${r.want ?? "the meter lane's"}: not replacing it.`;
    case "link": return `usagemeter ${where}: ~/.local/bin/usagemeter is a link or a folder; left as it is.`;
    case "unknown": return `Warning: usagemeter ${where}: ~/.local/bin/usagemeter reports no usagemeter version; left as it is.`;
    case "disconnected": return `Warning: usagemeter ${where}: skipped, the machine is not connected.`;
    case "removed": return `Removed usagemeter ${where}. Its store is kept.`;
    case "absent": return `usagemeter ${where}: nothing to remove.`;
    case "other": return `Left usagemeter ${where}: ${r.why}, not the one the pack put there.`;
    case "kept": return `Left usagemeter ${where}: ${r.why}.`;
    default: return `Warning: usagemeter ${where}: ${r.why ?? "failed"}.`;
  }
}

// ---- The fleet coverage record (RFC 0026 (e), delivery 5) ----
//
// The sidebar's meter run (meter.js) asks each machine's own usagemeter for its bot-tag coverage
// (`usagemeter coverage --window <FLEET_WINDOW> --json`) and writes one record beside the pack's
// install record: the machines that answered with their counts, classes, bots and repos, and
// the ones that did not, by name. The fleet number is a reader's sum over it (fleetSum), over
// the summed tokens and never the mean of the machines' ratios. Every field of an answer is
// read, checked and written again by name: nothing a machine's meter prints is passed through,
// so the record holds no session id, request hash, path or raw log id whatever a meter (or a
// machine) answers. The contract is meter/schema/fleet/v1/.

/** The record's version (`v`). */
export const FLEET_V = 1;
/** The one window the record holds: d30, the outcome window (RFC 0026 (a)). */
export const FLEET_WINDOW = "d30";
/** The record, beside the install record under the app home; 0600, replaced on every run. */
export const FLEET_FILE = "automagik-herdr/fleet-coverage.json";
/** The most one machine's entry may take as JSON, and the whole record (RFC 0026 (g)). */
export const FLEET_ENTRY_MAX = 64 * 1024;
export const FLEET_RECORD_MAX = 1024 * 1024;
/** The longest answer (in characters) that is read at all; a longer one is `invalid`. */
export const FLEET_ANSWER_MAX = 512 * 1024;
/** This computer's name in the record (`here: true` tells it from a linked machine so named). */
export const FLEET_HERE = "local";
/** The five classes, in the report's order: [state, reason]. */
export const FLEET_PARTS = Object.freeze([["ambiguous", "claimants_differ"], ["unlinked", "no_record"], ["unlinked", "dsh_tui_seat"],
  ["unlinked", "other_machine"], ["before_evidence", "before_evidence"]]);
/**
 * Why a machine is in `missing`: `timeout` (past the run's 30 s), a coverage exit by name
 * (`no_coverage` 2: its meter has no coverage verb; `no_store` 10; `locked` 11; `newer_store` 12;
 * `outdated_store` 13; `error` for 1 and any other exit, the exit beside it), `no_meter` (no
 * usagemeter there), `unreachable` (the program could not be run there), `disconnected` (linked,
 * not connected now), `invalid` (an answer that is not a v1 coverage record for the window) and
 * `record_full` (its entry did not fit the record's 1 MiB).
 */
export const FLEET_REASONS = Object.freeze(["timeout", "no_coverage", "no_store", "locked", "newer_store", "outdated_store", "error",
  "no_meter", "unreachable", "disconnected", "invalid", "record_full"]);
const EXIT_REASON = Object.freeze({ 2: "no_coverage", 10: "no_store", 11: "locked", 12: "newer_store", 13: "outdated_store", 127: "no_meter" });
/** A coverage exit (not 0) as a `missing` row's `{ reason, exit }`. */
export const exitReason = (code) => ({ reason: EXIT_REASON[code] ?? "error", exit: Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null });

/**
 * A share as the report prints it: four decimals, null (never 0) over nothing, and a share above
 * 0 is never rounded to 0 (it keeps its exact value), as usagemeter's own.
 */
export function fleetRatio(part, total) {
  if (!(total > 0)) return null;
  const v = Math.max(0, part) / total;
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 && v > 0 ? v : r;
}

const count = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const time = (x) => (typeof x === "string" && TIME.test(x) ? x : null);
const METER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
// A bot id, a machine id: one word of at most 64 characters with no separator a path has.
const WORD = /^[^\s/\\\u0000-\u001f\u007f]{1,64}$/;
// Contract 1's normalized repo, `host/owner/repo`: never absolute, no backslash, no `..` part.
const REPO = /^[a-z0-9.-]+(\/[^/\s\\\u0000-\u001f\u007f]+)+$/;
const repoName = (x) => (typeof x === "string" && x.length <= 512 && REPO.test(x) && !x.split("/").includes("..") ? x : null);

/** The four counts and their sum, or null when one is not a count or `total` is not their sum. */
function totalsOf(t) {
  const out = { attributed: count(t?.attributed), ambiguous: count(t?.ambiguous), unlinked: count(t?.unlinked),
    before_evidence: count(t?.before_evidence), total: count(t?.total) };
  if (Object.values(out).includes(null)) return null;
  return out.attributed + out.ambiguous + out.unlinked + out.before_evidence === out.total ? out : null;
}
function basisOf(b) {
  const out = { session: count(b?.session), label: count(b?.label), worktree: count(b?.worktree) };
  return Object.values(out).includes(null) ? null : out;
}
function botLine(b, named) {
  const tokens = count(b?.tokens), basis = basisOf(b?.tokens_by_basis);
  if (tokens === null || !basis) return null;
  if (!named) return { tokens, tokens_by_basis: basis };
  return typeof b.bot === "string" && WORD.test(b.bot) ? { bot: b.bot, tokens, tokens_by_basis: basis } : null;
}
function repoLine(r, named) {
  const totals = totalsOf(r?.totals);
  if (!totals) return null;
  if (!named) return { totals };
  const repo = repoName(r.repo);
  return repo && ["measured", "no_usage", "unknown"].includes(r.state) ? { repo, state: r.state, totals } : null;
}
/** A list of at most 50 lines, each read by `line`; null when it is not one or a line is not. */
function linesOf(list, line) {
  if (!Array.isArray(list) || list.length > 50) return null;
  const out = list.map((x) => line(x, true));
  return out.includes(null) ? null : out;
}
/** A string's length in UTF-8 bytes (no Buffer or TextEncoder: a mod's runtime may have neither). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
const size = (x) => utf8Length(JSON.stringify(x));

/** `entry` with its bot and repo lists cut to `bots` and `repos` lines; the cut ones are counted and summed into the `other` lines. */
function cutEntry(entry, bots, repos) {
  const out = { ...entry };
  if (bots < entry.bots.length) {
    const cut = entry.bots.slice(bots);
    const other = entry.bots_other ?? { tokens: 0, tokens_by_basis: { session: 0, label: 0, worktree: 0 } };
    out.bots = entry.bots.slice(0, bots);
    out.bots_omitted = entry.bots_omitted + cut.length;
    out.bots_other = { tokens: other.tokens + cut.reduce((n, b) => n + b.tokens, 0),
      tokens_by_basis: Object.fromEntries(["session", "label", "worktree"].map((k) => [k, other.tokens_by_basis[k] + cut.reduce((n, b) => n + b.tokens_by_basis[k], 0)])) };
    out.truncated = true;
  }
  if (repos < entry.repos.length) {
    const cut = entry.repos.slice(repos);
    const other = entry.repos_other?.totals ?? { attributed: 0, ambiguous: 0, unlinked: 0, before_evidence: 0, total: 0 };
    out.repos = entry.repos.slice(0, repos);
    out.repos_omitted = entry.repos_omitted + cut.length;
    out.repos_other = { totals: Object.fromEntries(Object.keys(other).map((k) => [k, other[k] + cut.reduce((n, r) => n + r.totals[k], 0)])) };
    out.truncated = true;
  }
  return out;
}
/** `entry` within `max` bytes of JSON: its lists halved (cutEntry) until it fits. */
function fitEntry(entry, max = FLEET_ENTRY_MAX) {
  let out = entry;
  while (size(out) > max && (out.bots.length || out.repos.length)) out = cutEntry(out, out.bots.length >> 1, out.repos.length >> 1);
  return out;
}

/**
 * One machine's entry from what its `usagemeter coverage --window <FLEET_WINDOW> --json` printed:
 * `{ entry }`, or `{ reason: "invalid" }` when it is not a v1 coverage record holding that window
 * with counts that add up. `machine`: its name (a linked machine's as hc lists it, FLEET_HERE for
 * this computer, `here` true). Every field is copied by name after its check; the lists are the
 * report's (50 at most, the rest already counted in its `other` lines), cut further only to keep
 * the entry within FLEET_ENTRY_MAX, with `truncated: true`.
 */
export function coverageEntry(machine, stdout, { here = false } = {}) {
  const bad = { reason: "invalid" };
  if (typeof stdout !== "string" || stdout.length > FLEET_ANSWER_MAX) return bad;
  let r = null;
  try { r = JSON.parse(stdout); } catch { return bad; }
  if (!r || typeof r !== "object" || Array.isArray(r) || r.v !== 1 || !Array.isArray(r.windows)) return bad;
  const w = r.windows.find((x) => x?.window === FLEET_WINDOW);
  const totals = totalsOf(w?.totals);
  if (!totals) return bad;
  // The classes: each of the five exactly once, and each state's classes add up to its count.
  if (!Array.isArray(w.parts) || w.parts.length !== FLEET_PARTS.length) return bad;
  const parts = FLEET_PARTS.map(([state, reason]) => {
    const p = w.parts.filter((x) => x?.state === state && x?.reason === reason);
    return p.length === 1 && count(p[0].tokens) !== null ? { state, reason, tokens: p[0].tokens } : null;
  });
  if (parts.includes(null)) return bad;
  for (const state of ["ambiguous", "unlinked", "before_evidence"]) {
    if (parts.filter((p) => p.state === state).reduce((n, p) => n + p.tokens, 0) !== totals[state]) return bad;
  }
  const bots = linesOf(w.bots, botLine), repos = linesOf(w.repos, repoLine);
  const botsOmitted = count(w.bots_omitted), reposOmitted = count(w.repos_omitted);
  const botsOther = w.bots_other == null ? null : botLine(w.bots_other, false);
  const reposOther = w.repos_other == null ? null : repoLine(w.repos_other, false);
  if (!bots || !repos || botsOmitted === null || reposOmitted === null) return bad;
  if ((w.bots_other != null && !botsOther) || (w.repos_other != null && !reposOther)) return bad;
  const start = time(w.start), end = time(w.end), countedFrom = time(r.counted_from);
  const flags = [w.complete, w.stale, w.clipped];
  if (!start || !end || !countedFrom || flags.some((f) => typeof f !== "boolean")) return bad;
  if (typeof r.meter_version !== "string" || r.meter_version.length > 64 || !METER_VERSION.test(r.meter_version)) return bad;
  if (!["full", "partial", "none"].includes(w.evidence)) return bad;
  if ((r.as_of != null && !time(r.as_of)) || (w.evidence_from != null && !time(w.evidence_from))) return bad;
  return { entry: fitEntry({
    machine, here: Boolean(here), machine_id: typeof r.machine === "string" && WORD.test(r.machine) ? r.machine : null,
    meter_version: r.meter_version, as_of: time(r.as_of), evidence_from: time(w.evidence_from), evidence: w.evidence,
    counted_from: countedFrom, start, end, complete: w.complete, stale: w.stale, clipped: w.clipped,
    truncated: w.truncated === true || botsOmitted > 0 || reposOmitted > 0,
    totals, bot_coverage: fleetRatio(totals.attributed, totals.total),
    inspected: fleetRatio(totals.attributed, totals.attributed + totals.ambiguous + totals.unlinked),
    parts, bots, bots_omitted: botsOmitted, bots_other: botsOther, repos, repos_omitted: reposOmitted, repos_other: reposOther,
  }) };
}

/**
 * Which linked machines a fleet run asks, from the sidebar's machine list (no temporary ones):
 * `ask` (in the meter's scope and connected: meter.js syncTargets' rule), `disconnected` (in
 * scope, not connected now: named in `missing`) and `outOfScope` (linked, but the person did not
 * agree to usagemeter there). A name the record cannot hold (MACHINE_NAME) is left out of all three.
 */
export function fleetPlan(machines, scope = null, owned = []) {
  const plan = { ask: [], disconnected: [], outOfScope: [] };
  for (const m of machines ?? []) {
    if (!m || m.temporary || typeof m.name !== "string" || !MACHINE_NAME.test(m.name)) continue;
    const inScope = scope === "all" || (scope !== "none" && owned.includes(m.name));
    (inScope ? (m.state === "connected" ? plan.ask : plan.disconnected) : plan.outOfScope).push(m.name);
  }
  return plan;
}

/**
 * The record: `answers` in the order asked, each `{ machine, here?, entry }` or `{ machine, here?,
 * reason, exit? }`; `disconnected` and `outOfScope` from fleetPlan. Within FLEET_RECORD_MAX: past
 * it the largest entry's lists are halved (`truncated`), and an entry with no line left to cut
 * moves to `missing` as `record_full`, last machine first; nothing is cut without being counted.
 */
export function fleetRecord({ generatedAt, answers = [], disconnected = [], outOfScope = [] }) {
  const missingRow = (a) => ({ machine: a.machine, here: Boolean(a.here), reason: FLEET_REASONS.includes(a.reason) ? a.reason : "error",
    ...(Number.isSafeInteger(a.exit) ? { exit: a.exit } : {}) });
  const record = {
    v: FLEET_V, generated_at: generatedAt, window: FLEET_WINDOW,
    machines: answers.filter((a) => a.entry).map((a) => a.entry),
    missing: [...answers.filter((a) => !a.entry).map(missingRow), ...disconnected.map((machine) => ({ machine, here: false, reason: "disconnected" }))],
    out_of_scope: [...outOfScope],
  };
  while (size(record) > FLEET_RECORD_MAX && record.machines.length) {
    const sizes = record.machines.map((e) => (e.bots.length || e.repos.length ? size(e) : -1));
    const i = sizes.indexOf(Math.max(...sizes));
    if (sizes[i] >= 0) { const e = record.machines[i]; record.machines[i] = cutEntry(e, e.bots.length >> 1, e.repos.length >> 1); continue; }
    const last = record.machines.pop();
    record.missing.push({ machine: last.machine, here: last.here, reason: "record_full" });
  }
  return record;
}

/**
 * The fleet number, a reader's sum of a record (RFC 0026 (e)): the machines' four counts added
 * as tokens, the classes by reason, the bots by bot id and the repos by name, and the ratios
 * over the summed tokens (token-weighted, never the mean of the machines' ratios). `answered`
 * of `machines` (those that answered, plus `missing`; `out_of_scope` is apart and never counted,
 * neither as a machine nor as 0). `lower_bound`: a machine that answered is stale, incomplete
 * or clipped, so the token totals are "at least"; the ratio is always "over counted
 * usage", never a bound. `bots_other` and `repos_other`: what the machines' capped lists left
 * unnamed, so a bot's or repo's own line is a lower bound whenever they are above zero.
 */
export function fleetSum(record) {
  const zero = () => ({ attributed: 0, ambiguous: 0, unlinked: 0, before_evidence: 0, total: 0 });
  const add = (into, t) => { for (const k of Object.keys(into)) into[k] += t[k]; return into; };
  const basis = () => ({ session: 0, label: 0, worktree: 0 });
  const entries = record?.machines ?? [];
  const totals = zero(), bots = new Map(), repos = new Map();
  const parts = FLEET_PARTS.map(([state, reason]) => ({ state, reason, tokens: 0 }));
  const botsOther = { tokens: 0, tokens_by_basis: basis() }, reposOther = zero();
  const addBot = (into, b) => { into.tokens += b.tokens; add(into.tokens_by_basis, b.tokens_by_basis); };
  for (const e of entries) {
    add(totals, e.totals);
    for (const p of e.parts) parts.find((x) => x.reason === p.reason).tokens += p.tokens;
    for (const b of e.bots) {
      if (!bots.has(b.bot)) bots.set(b.bot, { bot: b.bot, tokens: 0, tokens_by_basis: basis(), machines: [] });
      const line = bots.get(b.bot);
      addBot(line, b);
      line.machines.push(e.machine);
    }
    if (e.bots_other) addBot(botsOther, e.bots_other);
    for (const r of e.repos) {
      if (!repos.has(r.repo)) repos.set(r.repo, { repo: r.repo, totals: zero(), machines: [] });
      const line = repos.get(r.repo);
      add(line.totals, r.totals);
      line.machines.push(e.machine);
    }
    if (e.repos_other) add(reposOther, e.repos_other.totals);
  }
  const answered = entries.length, machines = answered + (record?.missing?.length ?? 0);
  return {
    window: record?.window ?? null, answered, machines, over: `over ${answered} of ${machines} machines`,
    missing: (record?.missing ?? []).map((m) => m.machine), out_of_scope: [...(record?.out_of_scope ?? [])],
    lower_bound: entries.some((e) => !e.complete || e.stale || e.clipped),
    totals, bot_coverage: fleetRatio(totals.attributed, totals.total),
    inspected: fleetRatio(totals.attributed, totals.attributed + totals.ambiguous + totals.unlinked),
    parts: parts.map((p) => ({ ...p, share: fleetRatio(p.tokens, totals.total) })),
    bots: [...bots.values()].sort((a, b) => b.tokens - a.tokens || (a.bot < b.bot ? -1 : 1)).map((b) => ({ ...b, share: fleetRatio(b.tokens, totals.total) })),
    bots_other: botsOther,
    repos: [...repos.values()].sort((a, b) => b.totals.total - a.totals.total || (a.repo < b.repo ? -1 : 1))
      .map((r) => ({ ...r, bot_coverage: fleetRatio(r.totals.attributed, r.totals.total) })),
    repos_other: reposOther,
  };
}
