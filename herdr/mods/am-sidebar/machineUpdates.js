// Every machine linked into one Herdr follows the signed lanes (#954): am, the pack where one is
// installed, and usagemeter, with no person at each machine. The computer that runs Herdr drives
// one cycle (`automagik-herdr machines update`, started by the sidebar every MACHINES_EVERY_MS):
//
// - On each connected linked machine (and this computer, for am), that machine's own `am update`
//   runs there (`hc exec`). The trust is the one a person's `am update` has, checked on the machine
//   itself with the keys its own install pins: am-lane's signed pointer, the tarball's sha256, never
//   a sequence older than one it took, the replaced copy kept (`am rollback automagik.am`); then
//   the pack's own `update` where a pack is installed (herdr-lane's pointer, its sha256, its kept
//   set, `update --rollback`). Nothing here reads a pointer for the machine or hands it a file.
// - usagemeter is meterFleet.js's install: the meter-lane pointer checked once here, the build's
//   sha256 checked on the machine, never a downgrade, the old binary kept as usagemeter.prev. On a
//   machine that has a usagemeter, or everywhere the person agreed to (meterScope `all`); never
//   where install.sh was told --no-usagemeter.
// - A machine opts out with one file of its own, <AM_HOME, else ~/.automagik>/linked-update
//   holding `off` (`automagik-herdr machines --auto off`, there or with --machine): the cycle
//   reads it first and runs nothing on that machine. No file: on.
// - What each machine runs and how its last update went is kept in
//   <app home>/automagik-herdr/linked-updates.json, which `automagik-herdr machines` shows.
//
// Fixed scripts only, arguments as argv (never spliced into a script). Pure: the runner (`hc exec`
// for the CLI, Herdr's exec for the sidebar) is passed in, so `node --test` runs it. Apache-2.0.

import { installOn, resultLine } from "./meterFleet.js";

/** The record of every machine's versions and last update, in the app home's automagik-herdr folder. */
export const STATE_FILE = "linked-updates.json";
/** The cycle's lock, beside it. */
export const LOCK_FILE = "linked-updates.lock";
/** A machine's own switch, under its AM_HOME (else ~/.automagik): `off` opts it out. */
export const SETTING_FILE = "linked-update";

/** The sidebar starts a cycle this long after load, then looks every MACHINES_TICK_MS. */
export const MACHINES_FIRST_MS = 90_000;
export const MACHINES_TICK_MS = 10 * 60_000;
/** One cycle an hour at most, across sidebar copies: a release reaches every machine within it. */
export const MACHINES_EVERY_MS = 60 * 60_000;
/** The shared values: when the last cycle was started (ms), and the failures already said. */
export const MACHINES_KEY = "am.sidebar.machines-update-started";
export const MACHINES_SHOWN_KEY = "am.sidebar.machines-update-shown";

const HOMES = `am_home=\${AM_HOME:-$HOME/.automagik}
app_home=\${HERDR_APP_HOME:-$HOME/.config/herdr-app}
setting=$am_home/${SETTING_FILE}`;

/**
 * Run as `sh -c PROBE`: four lines, `am <v>`, `pack <v>`, `meter <v>` (`-`: not installed; `?`: a
 * usagemeter that reports no version) and `auto on|off`. It reads files and asks usagemeter its
 * version; it changes nothing.
 */
export const PROBE = `set -u
${HOMES}
one() { v=$(head -n 1 "$1" 2>/dev/null | tr -cd '0-9A-Za-z.+-' | cut -c1-40); echo "$2 \${v:--}"; }
one "$am_home/parts/automagik.am/current/VERSION" am
if [ -f "$app_home/mods/am-sidebar/VERSION" ]; then one "$app_home/mods/am-sidebar/VERSION" pack
else one "$app_home/mods/spaces-agents/VERSION" pack; fi
m=$HOME/.local/bin/usagemeter; v=
if [ -x "$m" ] && [ ! -d "$m" ]; then
  v=$("$m" --version </dev/null 2>/dev/null | sed -n 's/^usagemeter \\([0-9][0-9A-Za-z.+-]*\\)$/\\1/p' | head -n 1 | cut -c1-40)
  [ -n "$v" ] || v='?'
fi
echo "meter \${v:--}"
if [ "$(head -n 1 "$setting" 2>/dev/null | tr -d '[:space:]')" = off ]; then echo "auto off"; else echo "auto on"; fi`;

/**
 * Run as `sh -c UPDATE sh [automagik.am]`: the machine's own update, by its own command. First
 * line `via am` (then `am update [automagik.am] --json`'s one JSON value: am, then the pack where
 * installed), `via pack` (no am there, a pack: its `automagik-herdr update --json`) or `via none`
 * (neither; nothing runs). With `automagik.am` (this computer, whose pack the sidebar's own updater
 * installs): am alone, and never the pack's command.
 */
export const UPDATE = `set -u
${HOMES}
am=$HOME/.local/bin/am
if [ -f "$am" ]; then
  echo "via am"
  if [ -n "\${1:-}" ]; then exec sh "$am" update "$1" --json </dev/null; fi
  exec sh "$am" update --json </dev/null
fi
if [ -z "\${1:-}" ]; then
  for mod in am-sidebar spaces-agents; do
    cli=$app_home/mods/$mod/bin/automagik-herdr
    if [ -f "$cli" ]; then echo "via pack"; exec sh "$cli" update --json </dev/null; fi
  done
fi
echo "via none"`;

/** Run as `sh -c SET_AUTO sh on|off`: writes the machine's own switch (on: no file) and prints it. */
export const SET_AUTO = `set -u
${HOMES}
case \${1:-} in
  off) mkdir -p "$am_home" && printf 'off\\n' > "$setting" || { echo "could not write $setting" >&2; exit 1; }; echo off ;;
  on) rm -f "$setting" || { echo "could not remove $setting" >&2; exit 1; }; echo on ;;
  *) echo "on or off" >&2; exit 2 ;;
esac`;

/**
 * Run by the sidebar as `sh -c START sh <the pack's automagik-herdr>`: one cycle, started apart
 * from Herdr's exec (which ends a program at 30 s) and never waited for: its answer is the record.
 */
export const START = `cli=$1
[ -f "$cli" ] || exit 0
if command -v setsid >/dev/null 2>&1; then setsid sh "$cli" machines update --json </dev/null >/dev/null 2>&1 &
else nohup sh "$cli" machines update --json </dev/null >/dev/null 2>&1 &
fi
exit 0`;

const short = (s) => String(s ?? "").trim().split("\n").filter(Boolean).pop()?.slice(0, 400) ?? "";
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;

/** PROBE's answer: `{ am, pack, meter (null: not installed; "?": no version), auto }`, or null when it is not one. */
export function parseProbe(stdout) {
  const found = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const [key, value, ...rest] = line.trim().split(/\s+/);
    if (rest.length || value === undefined) continue;
    if (["am", "pack", "meter"].includes(key)) found[key] = value === "-" ? null : VERSION.test(value) || (key === "meter" && value === "?") ? value : undefined;
    else if (key === "auto" && (value === "on" || value === "off")) found.auto = value === "on";
  }
  for (const key of ["am", "pack", "meter", "auto"]) if (found[key] === undefined) return null;
  return { am: found.am, pack: found.pack, meter: found.meter, auto: found.auto };
}

/** What a machine runs and its switch: `{ versions: { am, pack, meter }, auto }`, or `{ why }`. */
export async function probeOn(run, machine) {
  const r = await run(["sh", "-c", PROBE], { on: machine, timeout: 30 });
  if (r.code !== 0) return { why: short(r.stderr) || "could not reach it" };
  const p = parseProbe(r.stdout);
  if (!p) return { why: `unexpected answer: ${short(r.stdout) || "(none)"}` };
  return { versions: { am: p.am, pack: p.pack, meter: p.meter }, auto: p.auto };
}

/** The most one machine's own update may take (hc exec ends a program at 600 s at most). */
export const UPDATE_SECONDS = 600;

/** One part's step: `{ part, state: updated|current|absent|off|failed, from?, to?, why? }`. */
const step = (part, state, more = {}) => ({ part, state, ...more });

/** am's step from `am update --json`'s `am` value. */
function amStep(value, stderr) {
  if (!value || typeof value !== "object") return step("am", "failed", { why: short(stderr) || "am update gave no answer" });
  if (value.state === "updated") return step("am", "updated", { from: value.from ?? null, to: value.to ?? null });
  if (value.state === "current") return step("am", "current", { to: value.to ?? null });
  // Nothing posted on am-lane yet: nothing to follow, not this machine's fault.
  if (value.state === "none") return step("am", "current", { to: value.from ?? null });
  return step("am", "failed", { why: short(value.detail) || `am update answered ${String(value.state).slice(0, 40)}` });
}

/** The pack's step from `automagik-herdr update --json`'s value (update.mjs installUpdate). */
function packStep(value, stderr) {
  if (value && typeof value === "object" && value.state === "not-installed") return step("pack", "absent");
  if (!value || typeof value !== "object") return step("pack", "failed", { why: short(stderr) || "the pack's update gave no answer" });
  if (value.disabled) return step("pack", "off", { to: value.current ?? null, why: "update checks are off there (AUTOMAGIK_HERDR_NO_UPDATE=1)" });
  const done = value.installed;
  if (done?.restored) return step("pack", "failed", { to: done.restored.version ?? null, why: `${done.restored.failedVersion ?? done.version} did not load there; ${done.restored.version} is back` });
  if (done?.restoreError) return step("pack", "failed", { to: done.version ?? null, why: `${done.version} did not load there, and ${done.restoreError}` });
  if (done) return step("pack", "updated", { from: value.current ?? null, to: done.version ?? null });
  if (value.update) return step("pack", "failed", { to: value.current ?? null, why: `${value.update.version} is out and was not installed${value.held ? ` (${short(value.held)})` : ""}` });
  return step("pack", "current", { to: value.current ?? null });
}

/** UPDATE's answer (`{ code, stdout, stderr }`) as the am and pack steps. */
export function readUpdate(r, { amOnly = false } = {}) {
  const text = String(r.stdout ?? "");
  const nl = text.indexOf("\n");
  const via = (nl < 0 ? text : text.slice(0, nl)).trim();
  let value = null;
  try { value = JSON.parse(nl < 0 ? "" : text.slice(nl + 1)); } catch { /* no JSON: a failure below */ }
  if (via === "via none") return [step("am", "absent"), ...(amOnly ? [] : [step("pack", "absent")])];
  if (via === "via pack") return [step("am", "absent"), packStep(value, r.stderr)];
  if (via !== "via am") return [step("am", "failed", { why: short(r.stderr) || short(r.stdout) || `exit ${r.code}` })];
  const am = amStep(value?.am, r.stderr);
  // `am update --json` puts the pack's own stderr line (its refusal) on stderr, its value null.
  return amOnly ? [am] : [am, value && "pack" in value ? packStep(value.pack, r.stderr) : step("pack", "failed", { why: short(r.stderr) || "the pack was not looked at" })];
}

/** Whether usagemeter follows the lane on a machine: everywhere agreed to, or where one already is. */
export const meterFollows = (scope, has) => scope !== "none" && (scope === "all" || Boolean(has));

/** usagemeter's step from meterFleet.js installOn's result. */
function meterStep(r) {
  if (r.status === "installed") return step("meter", "updated", { to: r.version, meter: r });
  if (r.status === "current" || r.status === "newer") return step("meter", "current", { to: r.version ?? null, meter: r });
  if (r.status === "link" || r.status === "unknown") return step("meter", "current", { why: r.status === "link" ? "a link or a folder, left as it is" : "it reports no version, left as it is", meter: r });
  return step("meter", "failed", { why: r.why ?? "failed", meter: r });
}

/**
 * One machine's update (null: this computer, am and usagemeter only). `lane()`: resolves the
 * checked meter-lane pointer (`{ pointer, base }`), or `{ why }` when it was refused here; asked
 * only when a machine's usagemeter follows it. `scope`:
 * meterFleet.js meterScope. Resolves the record's entry: `{ machine, at, result:
 * updated|current|off|failed, auto, versions, steps, why }` (`why`: one line per part that failed).
 */
export async function updateOn(run, machine, { lane = async () => null, scope = null, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const before = await probeOn(run, machine);
  if (before.why) return { machine, at, result: "failed", auto: null, versions: null, steps: [], why: [before.why] };
  if (!before.auto) return { machine, at, result: "off", auto: false, versions: before.versions, steps: [], why: [] };
  const amOnly = machine === null;
  const r = await run(["sh", "-c", UPDATE, "sh", ...(amOnly ? ["automagik.am"] : [])], { on: machine, timeout: UPDATE_SECONDS });
  const steps = readUpdate(r, { amOnly });
  if (meterFollows(scope, before.versions.meter)) {
    const l = await lane();
    steps.push(l?.pointer ? meterStep(await installOn(run, machine, l)) : step("meter", "failed", { why: l?.why ?? "the meter-lane pointer was not read" }));
  }
  const after = await probeOn(run, machine);
  const why = steps.filter((s) => s.state === "failed").map((s) => `${NAMES[s.part]}: ${s.why}`);
  const result = why.length ? "failed" : steps.some((s) => s.state === "updated") ? "updated" : "current";
  return { machine, at, result, auto: true, versions: after.versions ?? before.versions, steps, why };
}

const NAMES = { am: "am", pack: "the pack", meter: "usagemeter" };

/** The record's text as `{ at, here, machines: { name: entry } }` (empty when there is none). */
export function parseState(text) {
  let j = null;
  try { j = JSON.parse(text); } catch { /* none yet */ }
  const entry = (e) => (e && typeof e === "object" && typeof e.result === "string" ? e : null);
  const machines = {};
  if (j?.machines && typeof j.machines === "object") for (const [name, e] of Object.entries(j.machines)) if (entry(e)) machines[name] = e;
  return { at: typeof j?.at === "string" ? j.at : null, here: entry(j?.here), machines };
}

/**
 * The record after a cycle's `entries`: each replaces its machine's; a machine that was not
 * connected keeps the versions it last reported; one no longer linked (`linked`: the names `hc
 * machine ls` gives now, null when hc could not say) is dropped.
 */
export function stateAfter(state, entries, { at, linked = null } = {}) {
  const machines = {};
  for (const [name, e] of Object.entries(state.machines)) if (!linked || linked.includes(name)) machines[name] = e;
  let here = state.here;
  for (const e of entries) {
    if (e.machine === null) here = e;
    else machines[e.machine] = e.result === "disconnected" ? { ...e, versions: state.machines[e.machine]?.versions ?? null, auto: state.machines[e.machine]?.auto ?? null } : e;
  }
  return { schemaVersion: 1, at: at ?? state.at, here, machines };
}

const stepText = (s) => {
  const name = NAMES[s.part];
  if (s.state === "updated") return `${name} ${s.from ? `${s.from} → ` : ""}${s.to ?? "updated"}`;
  if (s.state === "failed") return `${name} not updated (${s.why})`;
  if (s.state === "off") return `${name}: ${s.why}`;
  return null;
};

/** How an entry's last update went, in words. */
export function resultText(e) {
  if (e.result === "disconnected") return "not connected: nothing was checked";
  if (e.result === "off") return "updates are off there (am machines --auto on turns them on)";
  if (e.result === "failed" && !e.steps?.length) return `not checked (${e.why?.[0] ?? "failed"})`;
  const said = (e.steps ?? []).map(stepText).filter(Boolean);
  return said.length ? said.join("; ") : "up to date";
}

/** One line for a person per machine: what it runs, then how its last update went. */
export function entryLine(e) {
  const where = e.machine ?? "this computer";
  const v = e.versions;
  const runs = v ? `am ${v.am ?? "none"}, pack ${v.pack ?? "none"}, usagemeter ${v.meter === "?" ? "(no version)" : v.meter ?? "none"}` : "versions not known";
  return `${where}: ${runs}. ${e.at ? `${e.at}: ` : ""}${resultText(e)}.`;
}

/** The lines `automagik-herdr machines` prints. `linked`: names with no entry yet. */
export function stateLines(state, linked = []) {
  const lines = [];
  if (state.here) lines.push(entryLine(state.here));
  const names = [...new Set([...Object.keys(state.machines), ...linked])].sort();
  for (const name of names) lines.push(state.machines[name] ? entryLine(state.machines[name]) : `${name}: not checked yet (am machines update).`);
  return lines;
}

/** usagemeter's lines for the meter's install record (meterFleet.js recordAfter): each machine's installOn result. */
export const meterResults = (entries) => entries.flatMap((e) => (e.steps ?? []).filter((s) => s.part === "meter" && s.meter).map((s) => s.meter));
export { resultLine as meterLine };

/**
 * The one notice for a record's failures, said once per set of reasons (`shown`: the last
 * signature said): `{ sig, notice }` (notice null when there is nothing new to say; sig "" when
 * nothing failed, so the same failure after a good cycle is said again).
 */
export function failureNotice(state, shown = null) {
  const failed = [state.here, ...Object.values(state.machines)].filter((e) => e?.result === "failed");
  const lines = failed.map((e) => `${e.machine ?? "This computer"}: ${e.why?.join("; ") || "not updated"}`);
  const sig = lines.join("\n");
  if (!sig || sig === shown) return { sig, notice: null };
  return { sig, notice: { title: failed.length === 1 ? `${failed[0].machine ?? "This computer"} was not updated` : `${failed.length} machines were not updated`,
    level: "warning", body: `${lines.join(" ")} \`am machines\` shows each machine.` } };
}

/**
 * One due cycle, started and not waited for: `exec("sh", ["-c", START, "sh", cli])`, unless one
 * was started less than MACHINES_EVERY_MS ago by any sidebar copy (`get(MACHINES_KEY)`). The CLI's
 * own lock keeps two cycles apart. Resolves `{ started, why? }`.
 */
export async function startCycle({ exec, cli, now = Date.now, get = () => null, set = () => {} }) {
  const at = now();
  const last = Number(get(MACHINES_KEY));
  if (Number.isFinite(last) && last > 0 && at - last >= 0 && at - last < MACHINES_EVERY_MS) return { started: false, why: "fresh" };
  try { set(MACHINES_KEY, at); } catch {}
  try { await exec("sh", ["-c", START, "sh", cli]); } catch { return { started: false, why: "no-shell" }; }
  return { started: true };
}
