// The mod's update check (A14) over plain data: which node runs `update.mjs check` (Herdr
// started from the Dock may lack /opt/homebrew/bin on its PATH), what its answer means, when
// to look again and what notice to post. A failed check is never an error to the user: it is
// "no update", tried again after RETRY_MS. Pure: no `herdr` import (exec is passed in), so
// `node --test` runs it; main.js wires it to Herdr's exec, timer and notify. Apache-2.0.

import { CHECK_EVERY_MS, FIRST_CHECK_MS, RETRY_MS, autoHold, heldModLine, noticeText } from "./release.js";

export { CHECK_EVERY_MS, FIRST_CHECK_MS, RETRY_MS };

/** The shared value (Herdr's `shared`/`setShared`) holding the version already announced, so a
 *  mod reload or a second sidebar view doesn't announce it again. */
export const SHOWN_KEY = "am.sidebar.update-shown";

/** The announced version from the shared value, or null when it isn't one. */
export const shownFrom = (value) => (typeof value === "string" && value !== "" ? value : null);

/** How long one `node update.mjs check` may take before the next node is tried (ms). */
export const EXEC_TIMEOUT_MS = 30_000;
const TIMED_OUT = Symbol("timed out");

/** Where node is looked for, in order: PATH, then Homebrew on Apple silicon, then on Intel. */
export const NODE_PATHS = Object.freeze(["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]);

/** NODE_PATHS, with the one that worked last time first. */
export function nodeOrder(last = null) {
  return last && NODE_PATHS.includes(last) ? [last, ...NODE_PATHS.filter((p) => p !== last)] : [...NODE_PATHS];
}

// update.mjs prints one JSON line; the last line that parses as an object is its answer.
function answerOf(stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

/**
 * Runs `<node> <script> check [--mods <mods>]` with the first node that starts and answers.
 * `exec(command, args)` resolves `{ code, stdout, stderr }` and rejects when the program can't
 * start (Herdr's exec). A node that starts but gives no answer of update.mjs's (too old to load
 * it, say), or takes longer than `timeoutMs`, is passed over too. `sleep(ms)` resolves after
 * ms (the mod builds it on Herdr's timer, which has no setTimeout); without it nothing is timed.
 * `mods`: the app home's mods folder, so update.mjs reads the installed version from the same
 * Herdr. `command`: "apply" installs the latest release the same way (update.mjs apply, what
 * `automagik-herdr update` runs: checksum checked, the replaced set kept), with `extra`
 * ["--expect", v] so only the confirmed version goes in; pass no sleep then, a download takes as
 * long as it takes. Resolves `{ node, result }`, node null when none answered.
 */
export async function runCheck(exec, script, last = null, { mods = null, sleep = null, timeoutMs = EXEC_TIMEOUT_MS, command = "check", extra = [] } = {}) {
  const args = [script, command, ...extra, ...(mods ? ["--mods", mods] : [])];
  let fallback = null;
  for (const node of nodeOrder(last)) {
    let result;
    try {
      const run = exec(node, args);
      result = sleep ? await Promise.race([run, sleep(timeoutMs).then(() => TIMED_OUT)]) : await run;
    } catch { continue; }
    if (result === TIMED_OUT) continue;
    if (answerOf(result?.stdout)) return { node, result };
    fallback ??= { node: null, result };
  }
  return fallback ?? { node: null, result: null };
}

/**
 * What a check's result means: `{ kind: "update", update }`, `{ kind: "current" }`,
 * `{ kind: "off" }` (AUTOMAGIK_HERDR_NO_UPDATE set where update.mjs runs), or
 * `{ kind: "retry", why }` for anything else: no node, a non-zero exit, no answer, an
 * `{ error }` answer (the network down, GitHub refusing).
 */
export function readCheck(result) {
  if (!result) return { kind: "retry", why: "node not found" };
  const answer = answerOf(result.stdout);
  if (result.code !== 0 || !answer) return { kind: "retry", why: answer?.error ?? `exit ${result.code}` };
  if (typeof answer.error === "string") return { kind: "retry", why: answer.error };
  if (answer.disabled === true) return { kind: "off" };
  const u = answer.update;
  if (u && typeof u.version === "string" && typeof u.page === "string") return { kind: "update", update: u };
  return { kind: "current" };
}

/** How long until the next check (ms), or null for none (updates are off). */
export function nextCheckIn(kind) {
  if (kind === "off") return null;
  return kind === "retry" ? RETRY_MS : CHECK_EVERY_MS;
}

/** The notice for a check, once per version: null when there is no update or it was shown
 *  (`shownVersion`: shownFrom(shared(SHOWN_KEY)), kept across reloads and views). */
export function noticeFor(check, shownVersion = null) {
  if (check?.kind !== "update" || check.update.version === shownVersion) return null;
  return { title: "Automagik Herdr update", body: noticeText(check.update), level: "info" };
}

/**
 * Posts a check's notice once per version across reloads and sidebar views: reads the
 * announced version with `get(SHOWN_KEY)`, and when the check found a newer one, stores it
 * with `set(SHOWN_KEY, version)` and posts the notice. The mod passes Herdr's shared,
 * setShared and notify. Returns the notice posted, or null.
 */
export function announce(check, get, set, notify) {
  const note = noticeFor(check, shownFrom(get(SHOWN_KEY)));
  if (!note) return null;
  set(SHOWN_KEY, check.update.version);
  notify(note);
  return note;
}

// ---- The status bar's view of the check (am-status) ----
// Herdr refuses an import from another mod folder, so am-status can't run a check itself: the
// sidebar runs every check and every install, and the two talk through two shared values.
// STATE_KEY (written here): the last answer plus `busy`, the lock that keeps one check or install
// at a time across sidebar copies (Herdr runs mods on one thread, so a read then a write of a
// shared value can't interleave). REQUEST_KEY (written by am-status): "check now" or "install".

/** The last check or install, and `busy` while one runs: `{ kind, current, latest, update, why,
 *  at, request, queued, applyError, from, auto, autoFailed, autoHeld, landed, announced, check, restore,
 *  restoreError, busy: { what, since, id, request?, to?, from?, auto? } | null }`. `queued`: the
 *  request that arrived while that run held the lock (`{ id, what, at }`), answered by its result when
 *  it finishes. auto: the setting as the last check read it (`{ on, skip, managed, why, at? }`); the
 *  rest: autoPlan and landing below. */
export const STATE_KEY = "am.update.state";
/** What am-status asks for: `{ id, what: "check" | "apply", at }`. */
export const REQUEST_KEY = "am.update.request";
/** A check holds the lock at most this long (every node timing out, plus slack), an install
 *  APPLY_STALE_MS: then a holder that was reloaded or closed mid-run no longer blocks the next. */
export const CHECK_STALE_MS = NODE_PATHS.length * EXEC_TIMEOUT_MS + 30_000;
export const APPLY_STALE_MS = 10 * 60_000;
/** A request older than this is dropped unanswered (a reload, or Herdr restarted with it saved). */
export const REQUEST_FRESH_MS = 2 * 60_000;

const objectOr = (value, fallback) => (value && typeof value === "object" && !Array.isArray(value) ? value : fallback);

/** The shared state as an object (`{}` when unset or not one). */
export const stateFrom = (value) => objectOr(value, {});

/** The lock in `state` while it is held and not stale at `now`, else null. */
export function busyOf(state, now) {
  const busy = objectOr(state?.busy, null);
  if (!busy || typeof busy.since !== "number" || typeof busy.id !== "string") return null;
  const stale = busy.what === "apply" ? APPLY_STALE_MS : CHECK_STALE_MS;
  return now - busy.since < stale ? busy : null;
}

/**
 * Takes the lock for one check or install (`what`), or returns null while another runs: one at a
 * time across every sidebar copy, whoever asked (the 4-hour timer, a reload, a click).
 * `get`/`set`: Herdr's shared/setShared. `extra` is kept on the lock (`request`, `to`).
 * Returns the lock's id, which `finish` needs.
 */
export function claim(get, set, what, now, extra = {}) {
  const state = stateFrom(get(STATE_KEY));
  if (busyOf(state, now)) return null;
  const id = `${what}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  set(STATE_KEY, { ...state, busy: { ...extra, what, since: now, id } });
  return id;
}

/** Records a run's answer (`patch`) and frees the lock if `id` still holds it (a run whose lock
 *  went stale and was taken over records its answer but leaves the newer lock alone). */
export function finish(get, set, id, patch) {
  const state = stateFrom(get(STATE_KEY));
  const busy = objectOr(state.busy, null);
  set(STATE_KEY, { ...state, ...patch, busy: busy && busy.id !== id ? busy : null });
}

/** A check's answer as STATE_KEY fields: readCheck's kind (and update or why), plus the installed
 *  and latest versions update.mjs reported, when it did. */
export function checkPatch(result, now) {
  const check = readCheck(result);
  const answer = answerOf(result?.stdout) ?? {};
  const version = (v) => (typeof v === "string" && v !== "" ? v : null);
  return { kind: check.kind, update: check.update ?? null, why: check.why ?? null, current: version(answer.current),
    latest: version(answer.latest), at: now, applyError: null, ...(autoOf(answer.auto) ? { auto: autoOf(answer.auto) } : {}) };
}

/** update.mjs's autoStatus answer, checked, or null (an older update.mjs gives none). */
function autoOf(value) {
  const a = objectOr(value, null);
  if (!a || typeof a.on !== "boolean" || typeof a.managed !== "boolean") return null;
  return { on: a.on, managed: a.managed, skip: typeof a.skip === "string" ? a.skip : null, why: typeof a.why === "string" ? a.why : null };
}

/** The mods an install held for a layout (update.mjs `installed.held`, #420, #432), as far as they read. */
const heldOf = (value) => (Array.isArray(value)
  ? value.filter((h) => typeof h?.mod === "string" && Array.isArray(h.layouts) && h.layouts.length > 0 && h.layouts.every((l) => typeof l === "string"))
  : []);

/** The held list in release.js HELD_FILE's `text`, for `version` only: another release's says nothing about this one. */
export function heldFrom(text, version) {
  try {
    const file = JSON.parse(text);
    return file?.version === version ? heldOf(file.held) : [];
  } catch { return []; }
}

/**
 * release.js RESTORE_FILE's note for `version`: `{ restore }` after a bad pack was put back,
 * `{ error }` when it could not be, or null when the note is not this build's or is too old (a
 * Herdr restarted long after the restore says nothing). The restored build reads it at load, since
 * the build that asked for the update is usually reloaded away before its answer arrives.
 */
export function restoreFrom(text, version, now) {
  let file = null;
  try { file = JSON.parse(text); } catch { return null; }
  if (!file || typeof file !== "object" || file.version !== version || typeof file.at !== "number") return null;
  if (now - file.at >= LANDING_MS || file.at - now > 5_000) return null;
  if (typeof file.error === "string" && file.error !== "") return { error: file.error };
  if (typeof file.failedVersion !== "string" || file.failedVersion === "") return null;
  const failed = Array.isArray(file.failed) ? file.failed.filter((m) => typeof m === "string" && m !== "") : [];
  const mod = typeof file.mod === "string" && file.mod !== "" ? file.mod : failed[0] ?? null;
  const unavailable = typeof file.unavailable === "string" && file.unavailable !== "" ? file.unavailable : null;
  const warnings = Array.isArray(file.warnings) ? file.warnings.filter((w) => typeof w === "string" && w !== "") : [];
  return { restore: { version, failedVersion: file.failedVersion, mod,
    failed: failed.length > 0 ? failed : (mod ? [mod] : []), checked: true, ...(file.prevRemoved === true ? { prevRemoved: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}), ...(unavailable ? { unavailable } : {}) } };
}

/**
 * release.js CHECK_FILE's note for `version`: `{ from, unavailable }` when herdr-app could not
 * judge the update just installed (it was kept), else null: another release's note, a stale one,
 * or none. The new build reads it at load, since the build that ran the update is usually gone.
 */
export function checkFrom(text, version, now) {
  let file = null;
  try { file = JSON.parse(text); } catch { return null; }
  if (!file || typeof file !== "object" || file.version !== version || typeof file.at !== "number") return null;
  if (now - file.at >= LANDING_MS || file.at - now > 5_000) return null;
  if (typeof file.unavailable !== "string" || file.unavailable === "") return null;
  return { from: typeof file.from === "string" && file.from !== "" ? file.from : null, unavailable: file.unavailable };
}

/**
 * An install's answer (`node update.mjs apply`) as STATE_KEY fields over the `state` before it:
 * `{ kind: "installed", from, current, latest }` when a release went in; `{ kind: "restored" }`
 * when herdr-app check found a mod that does not load and update.mjs put the kept set back (the
 * bad version is recorded as rolled back); `{ kind: "restore-failed" }` when that could not happen;
 * the check's own answer when there was nothing to install; else the state as it was with
 * `applyError` (why it failed), so the bar still offers the update.
 */
export function applyPatch(result, state, now) {
  const answer = answerOf(result?.stdout);
  const version = answer?.installed?.version;
  const restored = answer?.installed?.restored;
  if (typeof version === "string" && restored && typeof restored.version === "string") {
    return { kind: "restored", from: answer.current ?? state.current ?? null, current: restored.version,
      latest: restored.version, update: null, why: null, applyError: null, at: now,
      restore: { ...restored, failedVersion: restored.failedVersion ?? version }, check: answer.installed.check ?? null };
  }
  if (typeof version === "string" && typeof answer?.installed?.restoreError === "string") {
    return { kind: "restore-failed", from: answer.current ?? state.current ?? null, current: version, latest: version,
      update: null, why: null, applyError: null, at: now, restoreError: answer.installed.restoreError,
      check: answer.installed.check ?? null };
  }
  if (result?.code === 0 && typeof version === "string") {
    return { kind: "installed", from: answer.current ?? state.current ?? null, current: version, latest: version, update: null,
      why: null, applyError: null, at: now, restartBots: Array.isArray(answer.notice) && answer.notice.length > 0,
      heldMods: heldOf(answer.installed.held), check: answer.installed.check ?? null };
  }
  // An install on its own that update.mjs held back (the setting, a rollback's skip, another run):
  // nothing happened and nothing is wrong; the check's answer stands.
  if (result?.code === 0 && typeof answer?.held === "string") return { autoHeld: answer.held, at: now };
  if (result?.code === 0 && answer?.refused) {
    // The latest moved on after the confirm: offer the new one, nothing installed.
    return { ...checkPatch(result, now), refused: answer.refused,
      applyError: `${answer.refused.latest} is out now, not ${answer.refused.expected}: confirm again` };
  }
  if (result?.code === 0 && answer && !answer.error && answer.installed === null) return checkPatch(result, now);
  const why = typeof answer?.error === "string" ? answer.error : result ? `exit ${result.code}` : "node not found";
  return { applyError: why, at: now };
}

/**
 * The one notice after an update's own `herdr-app check` found a mod that does not load and the
 * kept set went back (#652): the version that failed, the mods, and the version that is back. When
 * the restore removed the failed pack (#671), it says a manual rollback has nothing to go back to;
 * when it could not remove a folder, the restore's own warning says where the folder stays.
 */
export function restoredNotice(restore) {
  const failed = Array.isArray(restore?.failed) && restore.failed.length > 0
    ? restore.failed : [restore?.mod].filter((m) => typeof m === "string" && m !== "");
  const mods = failed.length > 0 ? failed.join(", ") : "a pack mod";
  const bad = restore?.failedVersion ?? restore?.from ?? "The update";
  const back = restore?.version ?? "the previous version";
  const stopped = typeof restore?.unavailable === "string" && restore.unavailable !== "" ? `; ${restore.unavailable}` : "";
  const removed = restore?.prevRemoved === true
    ? " The failed pack was removed, so `am update --rollback` has nothing to go back to." : "";
  const warnings = Array.isArray(restore?.warnings) ? restore.warnings.filter((w) => typeof w === "string" && w !== "") : [];
  const warned = warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";
  return { title: `Automagik Herdr restored ${back}`, level: "warning",
    body: `${bad} failed to load (${mods} failed herdr-app check${stopped}): the previous version ${back} is back.${removed}${warned}` };
}

/** The one notice when the kept set itself could not be put back (#652): no crash, no retry loop. */
export function restoreFailedNotice(why, version = "The update") {
  const reason = String(why ?? "the previous version could not be restored").replace(/^could not restore:\s*/, "");
  return { title: "Automagik Herdr could not restore the previous version", level: "error",
    body: `${version} failed to load, but the previous version could not be restored: ${reason}. `
      + `${version} is still installed; auto-update waits for a newer release.` };
}

/** One line for an install's notice when herdr-app could not judge the new pack (the update was kept). */
export function checkNote(check) {
  if (!check || check.checked !== false) return "";
  return ` ${check.unavailable ?? "herdr-app check could not run"}: the update was kept, but its mods were not checked.`;
}

/** The install's notice: done (reload the mods to use it), or why it wasn't. */
export function applyNotice(patch) {
  if (patch.kind === "installed") {
    return { title: "Automagik Herdr updated", level: "success", body: `${patch.from ?? "?"} → ${patch.current}. The replaced pack is kept`
      + " (`am update --rollback` puts it back). Herdr reloads its mods on its own." };
  }
  if (patch.applyError) return { title: "Automagik Herdr not updated", level: "error", body: patch.applyError };
  return null;
}

/** Manual checks ("check now" in the status bar) at most once a minute: GitHub answers 60
 *  unauthenticated requests an hour. A click inside it is answered with the last check. */
export const MANUAL_CHECK_COOLDOWN_MS = 60_000;

/** True while a manual check would repeat one that finished less than the cooldown ago. */
export const coolingDown = (state, now) => typeof state?.at === "number" && now - state.at < MANUAL_CHECK_COOLDOWN_MS && now >= state.at;

/**
 * An install request against what the state offers: null when it may run, else why not. The
 * request carries the version the person confirmed (`to`); one that no longer matches the
 * offered update is refused, so the bar asks again with the new version.
 */
export function applyRefusal(request, state) {
  const offered = state?.kind === "update" ? (state.update?.version ?? state.latest ?? null) : null;
  const to = typeof request?.to === "string" && request.to !== "" ? request.to : null;
  if (!to) return "no confirmed version";
  if (!offered) return `nothing to install (the last check found no update over ${state?.current ?? "the installed pack"})`;
  if (to !== offered) return `${offered} is out now, not ${to}: confirm again`;
  return null;
}

/** What a request asks for ("check" | "apply" | "auto", the setting's switch) when it is new to this copy (`seen`: the last id it
 *  handled) and fresh at `now`, else null. */
export function requestDue(value, seen, now) {
  const r = objectOr(value, null);
  if (!r || typeof r.id !== "string" || r.id === seen || typeof r.at !== "number") return null;
  if (r.what !== "check" && r.what !== "apply" && r.what !== "auto") return null;
  return now - r.at <= REQUEST_FRESH_MS && r.at - now <= 5_000 ? r.what : null;
}

/**
 * The request saved before a build loaded that something else already has: its answer recorded
 * (`state.request`), the run in flight took it (`busy.request`), or an answer came after it
 * (`state.at`). Null: it still waits, and the new build answers it (queued behind the run, or run).
 */
export function seenRequest(request, state) {
  const r = objectOr(request, null);
  if (!r || typeof r.id !== "string" || typeof r.at !== "number") return null;
  const s = objectOr(state, {});
  if (s.request === r.id) return r.id;
  if (objectOr(s.busy, null)?.request === r.id) return r.id;
  return typeof s.at === "number" && s.at >= r.at ? r.id : null;
}

/**
 * The STATE_KEY patch for a finished run's request: the one `state.queued` recorded while it ran is
 * answered by its result (the bar's latest click), else the run's own `own` id. Frees `queued`.
 */
export function requestAnswer(state, own = null) {
  const queued = objectOr(state?.queued, null);
  const id = typeof queued?.id === "string" && queued.id !== "" ? queued.id : null;
  return { request: id ?? (typeof own === "string" && own !== "" ? own : null), queued: null };
}

// ---- Installing on its own (auto-update) ----
// After a check that found a newer release, the sidebar installs it through the same applyUpdates
// path a click takes (the claim, `update.mjs apply --expect <v>`), adding `--auto` so update.mjs
// reads the setting and the rollback skip again under its lock before any download.

/** A failed install on its own waits this long before the same version is tried again, doubling
 *  after each failure up to AUTO_BACKOFF_MAX_MS; the person hears of it once per version. The
 *  checks come every CHECK_EVERY_MS, so the tries land 4 h, 8 h, 16 h and 24 h after each failure,
 *  then daily: BACKOFF_SLACK_MS lets the check due at the end of a wait make the try. */
export const AUTO_BACKOFF_MS = CHECK_EVERY_MS;
export const AUTO_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
export const BACKOFF_SLACK_MS = 10 * 60_000;
export const backoffOf = (count) => Math.min(AUTO_BACKOFF_MS * 2 ** Math.max(0, count - 1), AUTO_BACKOFF_MAX_MS);

/**
 * What to do after a check (`state`: STATE_KEY with the check's answer): `{ apply: version }` to
 * install it now, `{ hold: why }` when it is held back (the reason the status bar shows), or null
 * when there is no update or the check carried no setting (an older update.mjs: today's notice).
 */
export function autoPlan(state, now) {
  if (state?.kind !== "update" || typeof state.update?.version !== "string") return null;
  const auto = objectOr(state.auto, null);
  if (!auto) return null;
  const version = state.update.version;
  const hold = autoHold(version, auto);
  if (hold) return { hold, manual: !auto.managed || auto.on === false };
  // Just installed (the record may say otherwise only when it failed): never the same one again.
  const landed = objectOr(state.landed, null);
  if (landed?.version === version && typeof landed.at === "number" && now - landed.at < LANDING_MS) {
    return { hold: `${version} was just installed` };
  }
  const failed = objectOr(state.autoFailed, null);
  if (failed?.version === version && typeof failed.at === "number" && now - failed.at < backoffOf(failed.count ?? 1) - BACKOFF_SLACK_MS) {
    return { hold: `the last try failed (${failed.why}): next try after ${new Date(failed.at + backoffOf(failed.count ?? 1)).toISOString()}` };
  }
  return { apply: version };
}

/** The notice for a held update, once per version (SHOWN_KEY): today's when the setting is off or
 *  doesn't apply here, the rollback's own when the version was rolled back. */
export function heldNotice(plan, update) {
  if (plan?.manual) return { title: "Automagik Herdr update", body: noticeText(update), level: "info" };
  if (plan?.hold?.includes("was rolled back")) {
    return { title: "Automagik Herdr update", level: "info", body: `${update.version} is out, but you rolled it back here, so it`
      + " won't install on its own: the next newer release will. Click update in the status bar to install it anyway." };
  }
  return null;
}

/** STATE_KEY fields after an install on its own failed for `version`: counts the failures. */
export function autoFailure(state, version, why, now) {
  const before = objectOr(state?.autoFailed, null);
  const count = before?.version === version ? (before.count ?? 1) + 1 : 1;
  return { autoFailed: { version, why, at: now, count } };
}

/** The one notice for a failed install on its own (the first failure of a version), else null. */
export function autoFailedNotice(failed) {
  if (!failed || failed.count !== 1) return null;
  const hours = Math.round(backoffOf(1) / 3_600_000);
  // update.mjs: the swap happened but the install record wasn't written (it still names the old version).
  if (/went in, but the install record could not be written/.test(failed.why)) {
    return { title: "Automagik Herdr update not finished", level: "error",
      body: `${failed.version} was put in place, but its install record could not be saved (${failed.why}). It tries again in ${hours} h.` };
  }
  return { title: "Automagik Herdr not updated", level: "error",
    body: `Installing ${failed.version} failed: ${failed.why}. Nothing was changed; it tries again in ${hours} h.` };
}

// ---- After an install: the notice from the new build ----
// The swap replaces mods/am-sidebar, and Herdr reloads every copy of a mod whose files change (its
// AGENTS.md, "Mods": "Saving any file reloads every copy in place"; the old build's timers stop).
// So the build that ran the install usually never hears back: the new build, at init, finds the
// install in STATE_KEY and posts "Automagik Herdr updated to X". The old build waits
// RELOAD_GRACE_MS: if it is still running then, no reload happened and its notice says what to do.

/** An install is announced by the new build at most this long after it started. */
export const LANDING_MS = APPLY_STALE_MS;
/** How long the new build waits for the old one to record the install (whether bots need a restart). */
export const LANDING_WAIT_MS = 60_000;
export const RELOAD_GRACE_MS = 30_000;

/**
 * At a build's init, what its own VERSION means for the last install: `{ ready: true, from,
 * restartBots, held }` to announce now (the old build recorded it), `{ ready: false, from, id }` while
 * the old build's lock is on it (wait for its answer, up to LANDING_WAIT_MS), or null.
 */
export function landing(state, version, now) {
  if (typeof version !== "string" || version === "" || state?.announced === version) return null;
  const landed = objectOr(state?.landed, null);
  if (landed?.version === version && typeof landed.at === "number" && now - landed.at < LANDING_MS) {
    return { ready: true, from: landed.from ?? null, restartBots: landed.restartBots === true, held: heldOf(landed.held),
      check: objectOr(landed.check, null) };
  }
  const busy = objectOr(state?.busy, null);
  if (busy?.what === "apply" && busy.announce === true && busy.to === version && typeof busy.since === "number" && now - busy.since < LANDING_MS) {
    return { ready: false, from: busy.from ?? null, id: busy.id, check: null };
  }
  return null;
}

/**
 * The notice after Herdr reloaded the mods into `version`. Bots are herdr-core's terminals: a mod
 * reload doesn't touch them. A moved briefing hook (rare: the sidebar's folder renamed) does.
 * `held`: the mods this install left in mods/ for a layout, each said with what retires it.
 * `check`: an install whose herdr-app check could not run says so here, once (the update was kept).
 */
export function landedNotice(version, from, restartBots = false, held = [], check = null) {
  const back = from ? ` \`am update --rollback\` puts ${from} back.` : "";
  return { title: `Automagik Herdr updated to ${version}`, level: "success",
    body: (restartBots ? "Your bots kept running; restart each Claude bot (am restart <bot>) so it gets its briefing again."
      : "Your bots kept running.") + checkNote(check) + heldOf(held).map((h) => ` ${heldModLine(h, version)}`).join("") + back };
}

/** The old build's notice when Herdr did not reload the mods within RELOAD_GRACE_MS. */
export function noReloadNotice(version, held = [], check = null) {
  return { title: `Automagik Herdr updated to ${version}`, level: "success",
    body: "Herdr did not reload its mods: quit Herdr (⌘Q) and open it again to use the new version."
      + checkNote(check) + heldOf(held).map((h) => ` ${heldModLine(h, version)}`).join("") };
}
