// Qualify the CLI on each linked machine and keep observations only for confirmed core ids.
import { barName, bytesOf, checkHere, FLEET_V, HERE_MAX_BYTES, ID, machineList, matches, nextObs,
  noExceptions, object, parseFleet, pathOkay, versionOkay } from "./accountsRows.js";
import { HERE_BUDGET_MS } from "./accountsHere.js";
import { isHash } from "./accountsPlanRecord.js";
import { CODES } from "./accountsWrite.js";
import { paneLogin, REAL_SCRIPT } from "./loginProbe.js";
import { hcExecArgs, MACHINE_NAME } from "./meterFleet.js";
import { compareVersions } from "./release.js";

export { hcExecArgs, REAL_SCRIPT };
export const HERE_SINCE = "3.160.3";
// The first patch that ships the writer, set against dev at the final rebase.
export const WRITE_SINCE = "3.160.3";
export const READ_SECONDS = 20;
export const HERE_BUDGET_S = HERE_BUDGET_MS / 1000;
// Leave time before hc's timeout for the target to end its probes and send the answer.
export const HERE_MARGIN_S = 3;
// Under this, the read is not started: it could not finish a single check.
export const HERE_MIN_S = 5;
export const FLEET_BUDGET_MS = 90_000;
export const MAX_BINDINGS = 20;
export const MAX_LOOKUPS = 60;
export const MAX_EXTRA_PROJECTS = 20;
export const MARKER = "bin/accounts.mjs";

export const DISCOVER = `set -u
am_home=\${AM_HOME:-$HOME/.automagik}
app_home=\${HERDR_APP_HOME:-$HOME/.config/herdr-app}
one() {
  d=$(cd -P -- "$1" 2>/dev/null && pwd -P) || return 0
  [ -f "$d/bin/automagik-herdr.mjs" ] && [ -f "$d/bin/run.sh" ] || return 0
  [ -f "$d/${MARKER}" ] && [ -f "$d/accountsHere.js" ] && m=yes || m=no
  [ -f "$d/accountsWrite.js" ] && [ -f "$d/${MARKER}" ] && w=yes || w=no
  v=$(head -n 1 "$d/VERSION" 2>/dev/null | head -c 65)
  [ \${#v} -le 64 ] || v='?'
  case $v in ''|*[!0-9A-Za-z.+-]*) v='?' ;; esac
  printf '%s %s %s %s %s\\n' "$2" "$v" "$m" "$w" "$d"
}
one "$app_home/mods/am-sidebar" pack
one "$am_home/parts/automagik.am/current" am`;

export function parseDiscover(stdout) {
  return String(stdout ?? "").split("\n").flatMap((line) => {
    if (bytesOf(line) > 600 || /\p{Cc}/u.test(line)) return [];
    const m = /^(pack|am) ([^ ]+) (yes|no) (yes|no) (\/.*)$/.exec(line);
    if (!m) return [];
    const [, kind, version, marker, write, dir] = m;
    return [{ kind, version: versionOkay(version) && compareVersions(version, version) === 0 ? version : null,
      marker: marker === "yes", write: write === "yes", dir }];
  });
}

function pick(found, since, requireWriter) {
  const compatible = found.filter((c) => c.marker === true && (!requireWriter || c.write === true)
    && versionOkay(c.version) && compareVersions(c.version, since) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version) || Number(b.kind === "pack") - Number(a.kind === "pack"));
  return compatible.length ? { cli: compatible[0] } : { reason: found.length ? "old-cli" : "no-cli" };
}

export const pickCli = (found) => pick(found, HERE_SINCE, false);
export const pickWriter = (found) => pick(found, WRITE_SINCE, true);

export const RUN_HERE = `set -u
t0=$(date +%s 2>/dev/null) || exit 92
case $t0 in ''|*[!0-9]*) exit 92 ;; esac
d=$1 want=$2; shift 2
[ -f "$d/${MARKER}" ] && [ -f "$d/accountsHere.js" ] && [ -f "$d/bin/run.sh" ] || exit 90
[ "$(head -n 1 "$d/VERSION" 2>/dev/null | head -c 65)" = "$want" ] || exit 91
exec sh "$d/bin/run.sh" "$d/${MARKER}" here --started "$t0" "$@" </dev/null 2>/dev/null`;

// The target gets at most half of what hc still waits: a slow delivery uses the other half.
export const hereWithin = (left) => {
  const within = Math.min(HERE_BUDGET_S, left - HERE_MARGIN_S, Math.floor(left / 2));
  return within >= HERE_MIN_S ? within : null;
};
export const hereArgv = (cli, projects, within) => ["sh", "-c", RUN_HERE, "sh", cli.dir, cli.version, "--within", String(within), ...projects];

export function execOutcome(r) {
  if (r?.killed || r?.late) return { kind: "timeout" };
  let reply;
  try { reply = JSON.parse(r?.stdout); } catch { return { kind: "unreachable" }; }
  if (!reply || !Object.hasOwn(reply, "code")) return { kind: "unreachable" };
  if (reply.timed_out) return { kind: "timeout" };
  return { kind: "ok", code: reply.code, stdout: typeof reply.stdout === "string" ? Buffer.from(reply.stdout, "base64").toString("utf8") : "" };
}

export const RUN_SET = `set -u
d=$1 want=$2; shift 2
[ -f "$d/${MARKER}" ] && [ -f "$d/accountsWrite.js" ] && [ -f "$d/bin/run.sh" ] || exit 90
[ "$(head -n 1 "$d/VERSION" 2>/dev/null | head -c 65)" = "$want" ] || exit 91
exec sh "$d/bin/run.sh" "$d/${MARKER}" set-login "$@" </dev/null 2>/dev/null`;

export const setArgv = (cli, words) => ["sh", "-c", RUN_SET, "sh", cli.dir, cli.version, ...words];

// A transport failure leaves the write's outcome unknown. A target refusal has a fixed code.
export function setOutcome(result) {
  const outcome = execOutcome(result);
  if (outcome.kind !== "ok") return outcome;
  if (outcome.code === 90 || outcome.code === 2) return { error: "old-cli" };
  if (outcome.code === 91) return { error: "failed" };
  let reply;
  try { reply = JSON.parse(outcome.stdout); } catch { return { kind: "unreachable" }; }
  if (outcome.code === 0 && reply?.ok === true && reply.cancelled === true && Object.keys(reply).length === 2) {
    return { ok: true, cancelled: true };
  }
  if (outcome.code === 0 && reply?.ok === true && reply.cancelled === true && Object.keys(reply).length === 4
    && (reply.outcome === "written" ? isHash(reply.snapshot)
      : ["not-written", "indeterminate"].includes(reply.outcome) && reply.snapshot === null)) {
    return { ok: true, cancelled: true, outcome: reply.outcome, snapshot: reply.snapshot };
  }
  if (object(reply) && outcome.code === 0 && reply.ok === true && !Object.hasOwn(reply, "error")
    && isHash(reply.snapshot) && matches(ID, reply.use)) return { ok: true, snapshot: reply.snapshot, use: reply.use };
  return outcome.code === 1 && CODES.includes(reply?.error) ? { error: reply.error } : { kind: "unreachable" };
}

export function readHere(text) {
  const bad = { reason: "bad-answer" };
  if (typeof text !== "string" || bytesOf(text) > HERE_MAX_BYTES) return bad;
  try { return checkHere(JSON.parse(text)) ?? bad; } catch { return bad; }
}

export const fleetMembers = (r) => machineList(r, MACHINE_NAME);

const emptyEntry = () => ({ cli: null, versions: { pack: null, am: null }, panel: null,
  appHome: null, writer: null, write: null, core: null, codex: null, claude: null, exceptions: noExceptions() });

export function fleetAfter(prev, reads, { first, final, at }) {
  const linked = !first?.complete || !final?.complete ? { at, reason: "failed" } : null;
  const before = new Map(first?.list.map((m) => [m.id, m]) ?? []);
  const after = new Map(final?.list.map((m) => [m.id, m]) ?? []);
  const old = new Map(Object.entries(prev.machines));
  const keys = new Set(["local", ...old.keys(), ...before.keys(), ...after.keys()]);
  const entries = [];
  for (const core of keys) {
    const was = before.get(core), now = after.get(core);
    const previous = old.get(core);
    if (core !== "local" && !was && !now && !linked) continue;
    const read = reads.get(core);
    const observed = core === "local" || was && now && was.name === now.name && read?.name === now.name;
    const name = core === "local" ? null : ((!first || !final) && previous?.name) || now?.name || was?.name || previous?.name;
    if (!name && core !== "local") continue;
    let result;
    if (observed && read?.answer) {
      const { versions, panel, appHome, writer, core: answeredCore, codex, claude, exceptions } = read.answer;
      result = { versions, panel, appHome, writer, write: read.write === true, core: answeredCore,
        exceptions, cli: read.cli ?? null, state: now?.connected === false ? "away" : "read", reason: null,
        codex: nextObs("codex", previous?.codex, codex, read.at ?? at),
        claude: nextObs("claude", previous?.claude, claude, read.at ?? at) };
    } else {
      const state = observed && read ? read.state
        : !first || !final || (was && now) ? "failed" : "unknown";
      const reason = observed && read ? read.reason ?? null : "failed";
      result = { ...(previous ?? emptyEntry()), state, reason };
    }
    entries.push([core, { ...result, name, at }]);
  }
  return parseFleet(JSON.stringify({ v: FLEET_V, at, linked, machines: Object.fromEntries(entries) }));
}

export const slotsWithDir = (claude) => (claude?.slots ?? []).filter((slot) => typeof slot.dir === "string");

export function botsOff({ claude, bindings, exceptions, unbound = 0, more = 0, reason }) {
  if (reason) return { reason: "failed" };
  const result = { claude: [], codex: [], codexReliable: false, ownHome: 0, unbound, more };
  const bound = exceptions?.bound ?? [];
  const own = new Set(bound.filter((e) => e.why === "own-app-home").map((e) => e.project));
  const unread = new Set(bound.filter((e) => e.why === "unread").map((e) => e.project));
  const slots = slotsWithDir(claude);
  const wanted = claude?.routes.record.email;
  for (const { id, name, project, expect, agent, argv, real } of bindings) {
    if (!pathOkay(project)) continue;
    const key = project.replace(/\/+$/, "") || "/";
    if (own.has(key)) { result.ownHome += 1; continue; }
    if (unread.has(key)) { result.more += 1; continue; }
    let on = "login unknown";
    if (agent === "claude") {
      const login = paneLogin(argv, slots);
      const slot = login.id ?? (login.unknown && real ? slots.find((s) => s.dir === real)?.id : null);
      if (slot) {
        const email = claude?.slots.find((s) => s.id === slot)?.email;
        if (email && email === wanted) continue;
        on = `slot ${slot}`;
      } else if (login.unknown !== undefined) on = "an unknown folder";
    } else if (agent !== "codex") continue;
    result[agent].push({ id, name: barName(name, id), project, expect, on });
  }
  return result;
}
