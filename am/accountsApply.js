// Apply the approved Claude assignment on each linked machine, one at a time.
import { pickWriter } from "./accountsFleet.js";
import { close, finishUnpin, goneLinked, markRead, markTried, recordAttemptAfter, settle, startAttempt, suspend } from "./accountsPlan.js";
import { confirmedClaude, eligibleClaudeSlot, idDigest, linkedDue, LOCAL, machineOrder, openDispatch, own, parseRead, pendingClaudeDrift, PENDING_WHY, snapshotOf } from "./accountsPlanRecord.js";
import { writerQualified } from "./accountsWrite.js";

export const MACHINE_BUDGET_MS = 60_000;
export const APPLY_BUDGET_MS = 600_000;
const TOOL = "claude";
const progressOf = (plan, core) => own(plan.claude.progress, core);
const pending = (why) => PENDING_WHY.includes(why) ? why : "failed";

function binding(answer, core, home) {
  if (!answer || answer.reason) return pending(answer?.reason);
  if (!answer.core) return "no-core";
  if (answer.core !== core) return "rebound";
  return answer.appHome === home ? null : "changed";
}

export const attemptWords = (attempt) => ["--expect-home", attempt.home, "--expect-core", attempt.core,
  "--expect-rev", String(attempt.rev), "--attempt", String(attempt.n), "--dispatch", attempt.dispatch];
const sameAttempt = (plan, core, attempt) => {
  const kept = progressOf(plan, core)?.attempt;
  return kept?.outcome === null && kept.rev === attempt.rev && kept.n === attempt.n && kept.at === attempt.at
    && kept.dispatch === attempt.dispatch && kept.assign === attempt.assign
    && kept.slot === attempt.slot && kept.slotDigest === attempt.slotDigest
    && kept.before === attempt.before && kept.effDigest === attempt.effDigest
    && own(plan.claude.assign, core) === attempt.assign && own(plan.claude.members, core)?.home === attempt.home;
};

function writeRefusal(result) {
  switch (result?.error) {
    case "slot-changed": return { why: "changed", outcome: "changed" };
    case "wrong-core": return { why: "rebound", outcome: "lost" };
    case "stale": return { why: "lost", outcome: "lost" };
    case "no-core":
    case "timeout": return { why: result.error, outcome: "lost" };
    case "conflict":
    case "busy":
    case "old-cli":
    case "update-first": return { why: result.error, outcome: "failed" };
    // A generic failure can occur after the rename, while saving the target's receipt.
    default: return { why: "lost" };
  }
}

/** The caller holds accounts.lock. Its write(fn, rev) returns the saved plan, or null on a new rev. */
export async function applyRun({ io, retry = false, now = io.clock() }) {
  const base = io.readPlan();
  if (base.state !== "ok") return { error: base.state === "newer" ? "newer-plan" : "no-plan" };
  if (!io.quotaOn()) return { error: "off" };

  let { plan } = base;
  const { rev } = plan;
  let stopped = null;
  const deadline = now + APPLY_BUDGET_MS;
  const first = await io.machines(deadline);
  const listed = new Map(first?.list.map((machine) => [machine.id, machine]));
  const answer = (linked) => ({ v: 1, kind: "accounts.apply", rev, stopped, linked,
    machines: machineOrder(Object.keys(plan.claude.members)).filter((core) => core !== LOCAL).map((core) => {
      const progress = progressOf(plan, core);
      return { core, name: listed.get(core)?.name ?? own(plan.names, core) ?? core,
        state: progress?.state ?? null, why: progress?.why ?? null };
    }) });
  if (!first?.complete) return answer({ reason: "failed" });

  function save(edit) {
    const next = io.write(edit, rev);
    if (!next) { stopped = "rev"; return false; }
    plan = next;
    return true;
  }

  function check() {
    const live = io.readPlan();
    if (live.state !== "ok" || live.plan.rev !== rev) stopped = "rev";
    else {
      plan = live.plan;
      if (!io.quotaOn()) stopped = "off";
    }
    return live;
  }

  check();
  const gone = goneLinked(plan, first);
  if (!stopped && gone.length) save((live) => gone.reduce((next, core) => suspend(next, TOOL, core, "gone", io.clock()), live));
  if (stopped) return answer(null);

  for (const { machine: core } of linkedDue(plan, { now, retry, fleet: io.fleet(), members: first.list })) {
    if (stopped || io.clock() >= deadline) break;
    await applyMachine(core, Math.min(deadline, io.clock() + MACHINE_BUDGET_MS));
  }
  return answer(null);

  async function applyMachine(core, until) {
    check();
    if (stopped) return;
    const { claude } = plan;
    const current = progressOf(plan, core), member = own(claude.members, core), assign = own(claude.assign, core);
    const outstanding = openDispatch(current);
    const returned = current?.why === "gone" && Boolean(outstanding?.dispatch);
    if (!member || !assign || !current || current.state === "suspended" && !current.cancel && !returned) return;
    if (!save((live) => markTried(live, TOOL, core, io.clock()))) return;

    const { home } = member;
    const { name, connected } = listed.get(core) ?? {};
    const expired = () => io.clock() >= until;
    const miss = (why, attempt, outcome) => save((live) => {
      if (current.state !== "pending") return live;
      const next = outcome ? close(live, TOOL, core, attempt.n, outcome) : live;
      return settle(next, TOOL, core, { state: "pending", why: pending(why), now: io.clock() });
    });
    const changed = (attempt = current.attempt, read = null) => save((live) => {
      const next = attempt ? close(live, TOOL, core, attempt.n, "changed") : live;
      return read ? settle(next, TOOL, core, { state: "suspended", why: "changed", read, now: read.at })
        : suspend(next, TOOL, core, "changed", io.clock());
    });
    const reading = (answer) => parseRead({ ...answer.claude, at: new Date(io.clock()).toISOString(), core, home }, TOOL, core);
    const done = (read, snapshot) => save((live) => {
      const attempt = progressOf(live, core)?.attempt;
      const next = attempt ? close(live, TOOL, core, attempt.n, "done") : live;
      return settle(next, TOOL, core, { state: "done", seen: { home, snapshot, email: assign }, read, now: io.clock() });
    });

    if (!connected) return miss("away");
    const found = await io.discover(name, until);
    if (expired()) return miss("timeout");
    if (found.reason) return miss(found.reason);
    const { cli, reason } = pickWriter(found);
    if (!cli) return miss(reason);
    let firstRead = await io.here(name, cli, until);
    if (expired()) return miss("timeout");
    let receipt;
    if (outstanding) {
      // The first read can still see the old login while the disconnected writer is probing.
      // The target checks the dispatch's outcome as it fences any delayed writer.
      if (binding(firstRead, core, home) || !outstanding.dispatch) return miss("lost");
      check();
      if (stopped || !sameAttempt(plan, core, outstanding)) return;
      receipt = await io.setLogin(name, cli, ["--cancel-attempt", ...attemptWords(outstanding)], until);
      check();
      if (stopped || !sameAttempt(plan, core, outstanding)) return;
      if (!receipt?.cancelled || expired()) return miss("lost");
      if (current.cancel) return save((live) => finishUnpin(live, core, io.clock()));
      // Reconnecting lets us fence the old dispatch. Only a new press can resume a gone entry.
      if (returned) return save((live) => {
        const next = receipt.outcome === "written"
          ? recordAttemptAfter(live, TOOL, core, outstanding.n, receipt.snapshot, io.clock()) : live;
        return close(next, TOOL, core, outstanding.n, receipt.outcome === "not-written" ? "lost" : "changed");
      });
      if (receipt.outcome === "written"
        && !save((live) => recordAttemptAfter(live, TOOL, core, outstanding.n, receipt.snapshot, io.clock()))) return;
      firstRead = await io.here(name, cli, until);
      check();
      if (stopped || !sameAttempt(plan, core, outstanding)) return;
      if (expired()) return miss("timeout");
      if (binding(firstRead, core, home) || snapshotOf(firstRead.claude) === null) return miss("lost");
    }
    const unbound = binding(firstRead, core, home);
    if (unbound) return unbound === "changed" ? changed() : miss(unbound);
    const read = firstRead.claude ? reading(firstRead) : null;
    if (read && !save((live) => markRead(live, TOOL, core, read, io.clock()))) return;
    const snapshot = snapshotOf(firstRead.claude);
    if (snapshot === null) return miss("bad-answer");
    const email = confirmedClaude(firstRead.claude);
    const written = receipt?.snapshot ?? current.attempt?.after;
    if ((written && current.state === "pending" && (snapshot !== written || email && email !== assign))
      || (receipt && !written && receipt.outcome !== "not-written" && snapshot === outstanding.before)) {
      return changed(current.attempt, read);
    }
    if (!writerQualified(firstRead.writer, true) || firstRead.claude.state === "unresolved") return miss("update-first");
    if (email === assign) return done(read, snapshot);
    if (written && current.attempt?.outcome === null) return miss("failed");
    if (current.state === "done") return email ? changed(current.attempt, read) : undefined;
    if (pendingClaudeDrift(firstRead.claude, own(claude.seen, core), current.attempt, assign)) return changed(current.attempt, read);
    if (current.attempt?.outcome === null
      && !save((live) => close(live, TOOL, core, current.attempt.n, "lost"))) return;

    const { slots, slotsComplete, effective } = firstRead.claude;
    if (!slotsComplete || slots.some((slot) => slot.state === "timeout" || slot.state === "failed")) {
      return miss(slots.some((slot) => slot.state === "timeout") ? "timeout" : "failed");
    }
    if (firstRead.claude.state === "eligible" && !email) return miss("bad-answer");
    const matching = slots.filter((slot) => slot.email === assign);
    const eligible = eligibleClaudeSlot(firstRead.claude, assign);
    if (!eligible) return miss(matching.length ? "not-eligible" : "no-login");
    const { id: slot } = eligible;

    check();
    if (stopped) return;
    const latest = await io.machines(until);
    if (expired()) return miss("timeout");
    if (!latest?.complete) return miss("failed");
    if (!latest.list.some((machine) => machine.name === name && machine.id === core)) return miss("rebound");

    const slotDigest = idDigest(slot, assign, io.sha256Hex), effDigest = idDigest(effective, email ?? "", io.sha256Hex);
    if (!save((live) => startAttempt(live, TOOL, core, { rev, slot, slotDigest, before: snapshot,
      eff: email, effDigest, home, core, dispatch: io.dispatchId(), now: io.clock() }))) return;
    const attempt = progressOf(plan, core).attempt;
    const verify = ({ sent = false, after } = {}) => {
      const live = check();
      if (!stopped && sameAttempt(plan, core, attempt)) return true;
      stopped ??= "rev";
      if (live.state === "ok") {
        const kept = io.write((fresh) => {
          if (!sameAttempt(fresh, core, attempt)) return fresh;
          if (!sent) return close(fresh, TOOL, core, attempt.n, "lost");
          const next = after ? recordAttemptAfter(fresh, TOOL, core, attempt.n, after, io.clock()) : fresh;
          return settle(next, TOOL, core, { state: "pending", why: "lost", now: io.clock() });
        }, live.plan.rev);
        if (kept?.rev === rev) plan = kept;
      }
      return false;
    };
    if (!verify()) return;
    if (expired()) return miss("timeout", attempt, "lost");

    const result = await io.setLogin(name, cli, ["--use", slot, "--snapshot", snapshot, ...attemptWords(attempt),
      "--expect-slot", slotDigest, "--expect-eff", effDigest], until);
    if (!verify({ sent: true, after: result?.snapshot })) return;
    if (!result?.ok) {
      const { why, outcome } = writeRefusal(result);
      if (expired()) return miss("timeout", attempt, outcome === "changed" ? "lost" : outcome);
      if (why === "changed") return changed(attempt);
      return miss(why, attempt, outcome);
    }
    if (!save((fresh) => recordAttemptAfter(fresh, TOOL, core, attempt.n, result.snapshot, io.clock()))) return;
    if (expired()) return miss("timeout");
    const back = await io.here(name, cli, until);
    if (!verify({ sent: true })) return;
    if (expired()) return miss("timeout");
    const after = snapshotOf(back?.claude);
    if (binding(back, core, home) || after === null) return miss("lost");
    const confirmed = reading(back);
    const emailBack = confirmedClaude(back.claude);
    if (pendingClaudeDrift(back.claude, null, { ...attempt, after: result.snapshot }, assign)) {
      return changed(attempt, confirmed);
    }
    if (emailBack === assign) return done(confirmed, after);
    if (!save((fresh) => markRead(fresh, TOOL, core, confirmed, io.clock()))) return;
    if (!back.claude.slotsComplete) return miss(back.claude.slots.some(({ state }) => state === "timeout") ? "timeout" : "failed");
    if (back.claude.state === "eligible" && !emailBack) return miss("bad-answer");
    return miss("failed", attempt, "failed");
  }
}
