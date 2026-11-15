// What the status bar says about Automagik Herdr's version (am-status), over plain data: the
// update state the sidebar shares (am-sidebar/updateCheck.js, STATE_KEY), the bar's own pending
// request (REQUEST_KEY) and the installed VERSION. Pure: no imports, so `node --test` runs it;
// main.js draws the parts. Herdr refuses imports across mod folders, so the two keys are named
// here again (a test keeps them equal to updateCheck.js's). Apache-2.0.

export const STATE_KEY = "am.update.state";
export const REQUEST_KEY = "am.update.request";
/** A request the sidebar hasn't picked up after this long gets "couldn't check" (no sidebar), unless
 *  it arrived while a run was busy and that run is still live: its result answers it. */
export const ANSWER_MS = 10_000;
/** A lock older than these is a run that was reloaded or closed (updateCheck.js's values). */
export const CHECK_STALE_MS = 120_000;
export const APPLY_STALE_MS = 600_000;

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);

/** "just now", "12 min ago", "3 h ago": how long ago `at` was. */
export function ago(at, now) {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}

/**
 * The bar's text for the update state, as parts `{ text, tone: "dim" | "accent", click: "check" |
 * "update" | null }` and one tooltip:
 * - up to date: "Automagik Herdr 0.8.0" (click: check now);
 * - update available: "0.8.0 → 0.8.1 · update" ("update" in accent; click: install);
 * - checking (a click, a timer): "Automagik Herdr 0.8.0 · checking…"; a request that waited behind a
 *   live check or install says checking/updating too, never "couldn't check": that run answers it;
 * - failed, offline, no sidebar answering, or a queued request whose run died before it answered
 *   (the tooltip says the run did not finish): "0.8.0 · couldn't check" (the reason in the tooltip;
 *   click: try again); updates off: the version alone, nothing to click.
 * `version`: the installed VERSION file (null when unread); `request`: REQUEST_KEY's value.
 */
export function statusLabel({ state = null, request = null, version = null, now = 0 } = {}) {
  const s = obj(state) ?? {};
  const r = obj(request);
  const current = str(version) ?? str(s.current);
  const name = current ? `Automagik Herdr ${current}` : "Automagik Herdr";
  const dim = (text, click = null) => ({ text, tone: "dim", click });
  const busy = obj(s.busy);
  const stale = busy?.what === "apply" ? APPLY_STALE_MS : CHECK_STALE_MS;
  const running = busy && typeof busy.since === "number" && now - busy.since < stale ? busy : null;

  // An install: done once the VERSION file says the release it went for (Herdr reloads the mods
  // as the folders swap, possibly before the sidebar records the answer).
  if (running?.what === "apply" && !(current && current === str(running.to))) {
    return { parts: [dim(`${current ?? "?"} → ${str(running.to) ?? "latest"} · updating…`)],
      tooltip: "Downloading the release and checking its checksum; the replaced pack is kept." };
  }
  if (running?.what === "check") return { parts: [dim(`${name} · checking…`)], tooltip: "Looking for a newer Automagik Herdr release." };

  // The bar's own request, not yet answered: checking, until the sidebar should have taken it.
  const answered = r && (s.request === r.id || str(busy?.request) === r.id || (typeof s.at === "number" && s.at >= r.at));
  // A request that arrived while a run was busy (the sidebar queued it, or the run's own lock shows
  // it) waits for that run's result while the run is live: a stale or freed lock is not a wait, so
  // a queued request whose run died falls back to "couldn't check" (the tooltip says why), and the
  // 2-minute request window still forgets it. An install's landing answers within LANDING_WAIT_MS.
  const queued = obj(s.queued);
  const acknowledged = r && queued?.id === r.id;
  const waited = r && !answered && running && (acknowledged
    || (typeof running.since === "number" && typeof r.at === "number" && running.since <= r.at));
  if (r && typeof r.at === "number" && !answered && now - r.at >= 0) {
    if (now - r.at < ANSWER_MS || waited) return { parts: [dim(r.what === "apply" ? `${name} · updating…` : `${name} · checking…`)], tooltip: null };
    if (now - r.at < 2 * 60_000) {
      return { parts: [dim(`${current ?? "Automagik Herdr"} · couldn't ${r.what === "apply" ? "update" : "check"}`, "check")],
        tooltip: acknowledged
          ? "The Automagik sidebar took this request, but its run did not finish (it was closed or reloaded): click to try again."
          : "The Automagik sidebar runs update checks and installs and didn't answer: is it in this layout? Click to try again." };
    }
  }

  const checked = typeof s.at === "number" ? ` (checked ${ago(s.at, now)})` : "";
  if (s.kind === "off") return { parts: [dim(name)], tooltip: "Update checks are off (AUTOMAGIK_HERDR_NO_UPDATE is set)." };
  if (s.kind === "update") {
    const latest = str(s.update?.version) ?? str(s.latest);
    if (latest && latest !== current) {
      const why = str(s.applyError) ? `Not installed: ${s.applyError}. ` : "";
      return { parts: [dim(`${current ?? "?"} → ${latest}`), dim(" · "), { text: "update", tone: "accent", click: "update" }],
        tooltip: `${why}Automagik Herdr ${latest} is out${checked}. Click update to install it.` };
    }
  }
  if (s.kind === "retry") {
    return { parts: [dim(`${current ?? "Automagik Herdr"} · couldn't check`, "check")],
      tooltip: `Couldn't check for updates${checked}: ${str(s.why) ?? "no answer"}. Click to try again.` };
  }
  if (s.kind === "installed" && str(s.from)) {
    return { parts: [dim(name, "check")], tooltip: `Updated from ${s.from}; Herdr reloaded its mods. If anything still looks old, quit and reopen Herdr. Click to check again.` };
  }
  if (s.kind === "current" || s.kind === "update" || s.kind === "installed") {
    return { parts: [dim(name, "check")], tooltip: `Up to date${checked}. Click to check now.` };
  }
  return { parts: [dim(name, "check")], tooltip: "Not checked yet. Click to check now." };
}

/** The confirm dialog's words for an install from `current` to `latest`. */
export function confirmText(current, latest) {
  return {
    title: `Update Automagik Herdr to ${latest}?`,
    detail: `Installs ${latest} in place of ${current ?? "the installed pack"}: the release's checksum is checked first, and `
      + `${current ?? "the installed pack"} is kept, so \`am update --rollback\` puts it back. Herdr reloads its mods on its own.`,
  };
}

/** The latest version the state offers over `current`, or null (no update to confirm). */
export function offered(state, current) {
  const s = obj(state);
  if (s?.kind !== "update") return null;
  const latest = str(s.update?.version) ?? str(s.latest);
  return latest && latest !== current ? latest : null;
}

/**
 * The switch beside the version: "Install updates automatically: on" (or off), `{ text, on, tooltip }`,
 * or null when the sidebar's last check says it doesn't apply here (a checkout, a hand-installed
 * pack: the update stays a notice) or no check carried it yet. A click asks the sidebar to flip it
 * (REQUEST_KEY `{ what: "auto", on }`); until it answers, the bar shows what was asked.
 */
export function autoLabel({ state = null, request = null, now = 0 } = {}) {
  const s = obj(state) ?? {};
  const auto = obj(s.auto);
  if (!auto || auto.managed !== true) return null;
  const r = obj(request);
  const pending = r?.what === "auto" && typeof r.on === "boolean" && s.request !== r.id && typeof r.at === "number" && now - r.at < ANSWER_MS;
  const on = pending ? r.on : auto.on !== false;
  const lines = [on
    ? "Verified releases install on their own; the replaced pack is kept (`am update --rollback`). Click to turn off."
    : "New releases are only announced; click update to install one. Click to turn on."];
  if (on && str(auto.skip)) lines.push(`${auto.skip} was rolled back here: it waits for a newer release.`);
  if (on && str(s.autoHeld) && !str(s.autoHeld).includes("was rolled back")) lines.push(`Not installed yet: ${s.autoHeld}.`);
  if (str(s.autoError)) lines.push(`The setting was not saved: ${s.autoError}.`);
  return { text: `Install updates automatically: ${on ? "on" : "off"}`, on, tooltip: lines.join(" ") };
}
