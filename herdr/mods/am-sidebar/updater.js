// The sidebar's update runs (A14), wired to what Herdr gives a mod but taking it all as arguments,
// so `node --test` drives it with a fake exec, fake timers and a Map for the shared values: the
// checks (CHECK_EVERY_MS), the status bar's requests (REQUEST_KEY), an install (asked for, or on
// its own when "Install updates automatically" is on), the setting's switch, the notice the new
// build posts after Herdr reloads the mods, and the one notice after a bad pack was restored.
// The plain-data rules are updateCheck.js's.
// Apache-2.0.

import { AUTO_FILE, CHECK_FILE, HELD_FILE, RESTORE_FILE, formatAuto, parseAuto } from "./release.js";
import {
  FIRST_CHECK_MS, LANDING_WAIT_MS, REQUEST_KEY, RELOAD_GRACE_MS, RETRY_MS, SHOWN_KEY, STATE_KEY, announce, applyNotice, applyPatch, heldRecordFrom,
  applyRefusal, autoFailedNotice, autoFailure, autoPlan, busyOf, checkFrom, checkPatch, claim, coolingDown, finish, heldFrom, heldNotice, landedNotice,
  landing, nextCheckIn, noReloadNotice, requestAnswer, requestDue, restoreFrom, restoredNotice, restoreFailedNotice, runCheck,
  seenRequest, shownFrom, stateFrom,
} from "./updateCheck.js";

const landingIdOf = (state) => state.busy?.id ?? state.landed?.id;

export class Updater {
  /**
   * `exec(command, args)`: Herdr's exec. `get`/`set`: shared/setShared. `notify`: Herdr's notify.
   * `after(ms, fn)`: a one-shot timer that stops when this build is reloaded (the mod passes its
   * init cx's timer). `spawn(fn)`: runs an async task (cx.spawn). `readText`/`writeText`: Herdr's
   * readTextFile/writeTextFile. `appHome`: the app home. `now`: the clock.
   */
  constructor({ exec, get, set, notify, after, spawn = (fn) => { fn(); }, readText, writeText, appHome, now = Date.now }) {
    Object.assign(this, { exec, get, set, notify, after, spawn, readText, writeText, now });
    this.script = `${appHome}/mods/am-sidebar/update.mjs`;
    this.mods = `${appHome}/mods`;
    this.autoFile = `${appHome}/automagik-herdr/${AUTO_FILE}`;
    this.heldFile = `${appHome}/automagik-herdr/${HELD_FILE}`;
    this.restoreFile = `${appHome}/automagik-herdr/${RESTORE_FILE}`;
    this.checkFile = `${appHome}/automagik-herdr/${CHECK_FILE}`;
    this.version = `${appHome}/mods/am-sidebar/VERSION`;
    this.node = null;
    // A request saved before this load that something already has (an answer, or the run in
    // flight) is its own; one still waiting is answered here, not dropped as someone else's.
    this.seen = seenRequest(get(REQUEST_KEY), get(STATE_KEY));
  }

  state() { return stateFrom(this.get(STATE_KEY)); }
  patch(fields) { this.set(STATE_KEY, { ...this.state(), ...fields }); }

  /** At load: the first check after FIRST_CHECK_MS, and the notice for an install that just landed. */
  start() {
    this.after(FIRST_CHECK_MS, () => this.check());
    this.spawn(() => this.arrive());
  }

  // One look through `node update.mjs check`, one notice per new version, then the next look
  // scheduled by what it found (`scheduled`; a look the status bar asked for schedules nothing).
  // One look or install at a time across sidebar copies (claim): a timer that finds one running
  // looks again after RETRY_MS. A newer release goes in on its own when autoPlan says so.
  check(scheduled = true, request = null) {
    const started = this.now();
    const id = claim(this.get, this.set, "check", started, request ? { request } : {});
    if (id === null) {
      if (scheduled) this.after(RETRY_MS, () => this.check());
      return;
    }
    this.spawn(async () => {
      let patch = { kind: "retry", why: "the check did not run", at: this.now() };
      try {
        const sleep = (ms) => new Promise((done) => this.after(ms, done));
        const { node, result } = await runCheck(this.exec, this.script, this.node, { mods: this.mods, sleep });
        if (node) this.node = node;
        patch = checkPatch(result, this.now());
      } catch {}
      // The switch flipped while this check ran: its answer is older than the switch.
      const before = this.state();
      if (patch.auto && typeof before.auto?.at === "number" && before.auto.at >= started) patch.auto = before.auto;
      try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(before, request), autoHeld: null }); } catch {}
      const plan = autoPlan(this.state(), this.now());
      if (plan?.apply && this.apply(null, plan.apply, { auto: true })) {
        // Announced by the install's own notice; SHOWN_KEY keeps a later check quiet about it.
        this.set(SHOWN_KEY, plan.apply);
      } else if (plan?.hold) {
        this.patch({ autoHeld: plan.hold });
        const note = shownFrom(this.get(SHOWN_KEY)) === patch.update.version ? null : heldNotice(plan, patch.update);
        if (note) { this.set(SHOWN_KEY, patch.update.version); try { this.notify(note); } catch {} }
      } else {
        // The version already announced is shared, so a reload or a second view stays quiet.
        try { announce(patch, this.get, this.set, this.notify); } catch {}
      }
      const wait = nextCheckIn(patch.kind);
      if (scheduled && wait !== null) this.after(wait, () => this.check());
    });
  }

  // An install: `node update.mjs apply --expect <to>`, the path `automagik-herdr update` takes
  // (the signed pointer, the checksum, the replaced pack kept for --rollback). `auto`: on its own,
  // with --auto so update.mjs holds it back under its lock when the setting or a rollback says so.
  // Returns false when another check or install holds the claim (nothing runs).
  apply(request, to, { auto = false } = {}) {
    const before = this.state();
    const from = before.current ?? null;
    const id = claim(this.get, this.set, "apply", this.now(), { request, to, from, auto, announce: true });
    if (id === null) return false;
    this.spawn(async () => {
      let patch = { applyError: "the install did not run", at: this.now() };
      try {
        const { node, result } = await runCheck(this.exec, this.script, this.node,
          { mods: this.mods, command: "apply", extra: ["--expect", to, ...(auto ? ["--auto"] : []), "--landing-id", id] });
        if (node) this.node = node;
        patch = applyPatch(result, before, this.now());
      } catch (e) { patch = { applyError: String(e?.message ?? e), at: this.now() }; }
      if (patch.kind === "restored" || patch.kind === "restore-failed") {
        // The bad release did not load and update.mjs put the kept set back (or could not). One
        // notice, from this build if it is still here; `announced` keeps the reloaded build quiet.
        const before = this.state();
        try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(before, request), autoFailed: null, landed: null, autoHeld: null, announced: patch.current }); } catch {}
        try { this.set(SHOWN_KEY, patch.kind === "restored" ? patch.restore?.failedVersion ?? patch.current : patch.current); } catch {}
        // The restored build may have read update.mjs's note and said it already.
        if (before.announced !== patch.current) {
          const note = patch.kind === "restored" ? restoredNotice(patch.restore) : restoreFailedNotice(patch.restoreError, patch.current);
          if (note) try { this.notify(note); } catch {}
        }
        return;
      }
      if (patch.kind === "installed") {
        const landed = { version: patch.current, from: patch.from, restartBots: patch.restartBots === true, held: patch.heldMods ?? [],
          check: patch.check ?? null, warnings: patch.warnings ?? [], at: this.now(), id };
        try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(this.state(), request), autoFailed: null, landed }); } catch {}
        // Herdr reloads the mods as the folders swap, and the new build announces it (arrive).
        // Still here after the grace: no reload happened, so say what to do.
        try { this.after(RELOAD_GRACE_MS, () => this.unreloaded(patch.current, patch.heldMods, patch.check, patch.warnings)); } catch {}
        return;
      }
      if (auto && patch.refused) {
        // The latest moved on between the check and the install: not a failure, and nothing to
        // tell the person. The new release goes in at the next check.
        try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(this.state(), request), applyError: null, autoHeld: "a newer release came out; it installs at the next check" }); } catch {}
        return;
      }
      if (auto && patch.applyError) {
        // A failed install on its own: one notice per version, then backoffOf before the next try.
        const failed = autoFailure(this.state(), to, patch.applyError, this.now());
        try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(this.state(), request), ...failed }); } catch {}
        const note = autoFailedNotice(failed.autoFailed);
        if (note) try { this.notify(note); } catch {}
        return;
      }
      try { finish(this.get, this.set, id, { ...patch, ...requestAnswer(this.state(), request) }); } catch {}
      const note = auto ? null : applyNotice(patch);
      if (note) try { this.notify(note); } catch {}
    });
    return true;
  }

  unreloaded(version, held = [], check = null, warnings = []) {
    if (this.state().announced === version) return;
    this.patch({ announced: version });
    try { this.notify(noReloadNotice(version, held, check, warnings)); } catch {}
  }

  async readLandingHeld(version, step, id) {
    let text = null;
    try { text = await this.readText(this.heldFile); } catch {}
    if (!step) return { held: heldFrom(text, version) };

    const record = heldRecordFrom(text, version);
    if (record?.notes.length && record.landingId && record.landingId !== id) {
      // A pending landing has no result of its own to announce when the record is from another attempt.
      return step.ready ? step : null;
    }
    const held = step.held?.length ? step.held : record?.held ?? [];
    const notes = id && record?.landingId === id ? record.notes : [];
    return { held, warnings: [...new Set([...(step.warnings ?? []), ...notes])] };
  }

  // At load: when this build is the release an install just put in, say so once. The old build
  // records whether bots need a restart; wait for that up to LANDING_WAIT_MS, then announce anyway
  // (the old build may have stopped with the reload) and free its claim.
  async arrive(waited = 0) {
    const started = landingIdOf(this.state());
    let version = null;
    try { version = (await this.readText(this.version))?.trim() || null; } catch { return; }
    let state = this.state();
    if (typeof version !== "string" || state.announced === version) return;

    if (landingIdOf(state) !== started) return;
    const landingState = () => {
      const current = this.state();
      return current.announced !== version && landingIdOf(current) === started ? current : null;
    };
    // The update's own build is usually reloaded away before its answer arrives: update.mjs leaves
    // this note for the restored build, which says the one notice instead (and never repeats it).
    let note = null;
    try { note = restoreFrom(await this.readText(this.restoreFile), version, this.now()); } catch {}
    const afterRestore = landingState();
    if (!afterRestore) return;
    if (note) {
      // The update's claim died with the old build: free it here (a later check starts clean), and
      // answer a request that was queued behind it with the install's result.
      finish(this.get, this.set, state.busy?.id ?? null, { announced: version, ...requestAnswer(this.state(), null) });
      try { this.set(SHOWN_KEY, note.error ? version : note.restore.failedVersion); } catch {}
      try { this.notify(note.error ? restoreFailedNotice(note.error, version) : restoredNotice(note.restore)); } catch {}
      return;
    }
    const step = landing(afterRestore, version, this.now());
    const id = step?.ready ? afterRestore.landed?.id : step?.id;
    if (step?.ready && afterRestore.busy?.what === "apply" && afterRestore.busy.id !== id) return;
    if (!step || !step.ready) {
      // The build that ran the update is gone and never recorded its answer: update.mjs's note
      // says the update was kept but herdr-app could not judge it. Checked before the wait, since
      // the note appearing is itself the answer.
      let unchecked = null;
      try { unchecked = checkFrom(await this.readText(this.checkFile), version, this.now()); } catch {}
      const current = landingState();
      if (!current) return;
      if (landing(current, version, this.now())?.ready) return this.arrive(waited);
      const record = unchecked && await this.readLandingHeld(version, step, id);
      const afterHeld = landingState();
      if (!afterHeld) return;
      if (unchecked && landing(afterHeld, version, this.now())?.ready) return this.arrive(waited);
      if (unchecked && !record) return;
      if (unchecked && step) step.warnings = record.warnings;
      if (unchecked) {
        finish(this.get, this.set, state.busy?.id ?? null, { announced: version, ...requestAnswer(this.state(), null) });
        try { this.set(SHOWN_KEY, version); } catch {}
        const { held } = record;
        try { this.notify(landedNotice(version, unchecked.from, false, held, { checked: false, unavailable: unchecked.unavailable }, step?.warnings)); } catch {}
        return;
      }
    }
    if (step && !step.ready && waited < LANDING_WAIT_MS) {
      this.after(1000, () => this.spawn(() => this.arrive(waited + 1000)));
      return;
    }
    const record = step && await this.readLandingHeld(version, step, id);
    if (step) {
      const afterHeld = landingState();
      if (!afterHeld) return;
      if (!step.ready && landing(afterHeld, version, this.now())?.ready) return this.arrive(waited);
      if (!record) return;
      step.warnings = record.warnings;
    }
    if (!step) return;
    state = this.state();
    if (state.announced === version) return;
    if (!step.ready) {
      finish(this.get, this.set, step.id, { kind: "installed", from: step.from, current: version, latest: version, update: null,
        why: null, applyError: null, at: this.now(), ...requestAnswer(state, null) });
    }
    this.patch({ announced: version });
    const { held } = record;
    try { this.notify(landedNotice(version, step.from, step.restartBots === true, held, step.check, step.warnings)); } catch {}
  }

  // "Install updates automatically", switched from the status bar: written to the pack's own
  // setting file (update.mjs and the CLI read the same), mirrored in STATE_KEY for the bar.
  async setAuto(on, request) {
    let error = null;
    let auto = null;
    try {
      const text = await this.readText(this.autoFile);
      auto = { ...parseAuto(text ?? ""), on };
      await this.writeText(this.autoFile, formatAuto(auto), text ?? null);
    } catch (e) { error = String(e?.message ?? e); }
    const state = this.state();
    const shown = { ...(state.auto ?? { managed: false, skip: null, why: null }), ...(error ? {} : { on }), at: this.now() };
    this.patch({ auto: shown, request, autoError: error });
  }

  // On the 250 ms timer: a new request from the status bar. A look asked for while one runs is
  // queued and answered by that one's result, never a second look (GitHub's hourly limit), and one
  // within a minute of the last is answered by that one; an install asked for while one runs is
  // that one, one for a version no longer offered is refused (the bar asks again), and one waits
  // for a running look (fresh for REQUEST_FRESH_MS). The switch is written at once.
  request() {
    const value = this.get(REQUEST_KEY);
    const now = this.now();
    const what = requestDue(value, this.seen, now);
    if (!what) return;
    const { id } = value;
    const state = this.state();
    const busy = busyOf(state, now);
    if (what === "auto") {
      this.seen = id;
      // One sidebar copy writes it: the first to see the request claims its id.
      if (typeof value.on !== "boolean" || state.autoRequest === id) return;
      this.patch({ autoRequest: id });
      this.spawn(() => this.setAuto(value.on, id));
      return;
    }
    if (what === "check") {
      this.seen = id;
      if (busy) {
        // Taken by the run in flight: queued, so its result answers this request (its answer or
        // the install's), and the bar never shows it as unanswered.
        this.patch({ queued: { id, what, at: value.at } });
        return;
      }
      if (coolingDown(state, now)) finish(this.get, this.set, null, { request: id });
      else this.check(false, id);
      return;
    }
    if (busy?.what === "apply") {
      // An install asked for while one runs is that one: its result answers this request too.
      this.seen = id;
      this.patch({ queued: { id, what, at: value.at } });
      return;
    }
    if (busy) return;
    const refused = applyRefusal(value, state);
    if (refused) {
      this.seen = id;
      finish(this.get, this.set, null, { request: id, applyError: refused });
    } else if (this.apply(id, value.to)) this.seen = id;
  }
}
