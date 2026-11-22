// Show the approved assignment beside the latest observation of the machine.
import { rowFor } from "./accountsRows.js";
import { claudeDrift, codexDrift, confirmedClaude, isFingerprint, LOCAL, machineOrder, newest, observedCodex, openDispatch, own, snapshotOf, TOOLS } from "./accountsPlanRecord.js";

export { newest };

const eligibleEmail = (read) => read?.state === "eligible" ? read.email ?? null : null;

/** Codex observations take the panel's active record alongside the current file identity. */
export function onAccount(tool, machine, plan, obs) {
  const wanted = own(plan?.[tool]?.assign, machine);
  if (tool === "claude") return { on: Boolean(wanted && confirmedClaude(obs) === wanted), grant: null };
  const seen = plan?.codex?.seen?.local;
  const placed = seen?.placed;
  const on = Boolean(machine === LOCAL && wanted && isFingerprint(obs?.account) && obs.account === seen?.account
    && observedCodex(obs, obs.active, placed) === wanted);
  const exact = on && placed?.name === wanted && placed.proxy === obs.proxy && placed.account === obs.account
    && placed.generation === obs.generation;
  return { on, grant: on ? (exact ? "placed" : "origin-unknown") : "unknown" };
}

export function planRowFor(tool, entry, plan, machine, ref, now) {
  const section = plan?.[tool];
  const member = own(section?.members, machine);
  const codex = tool === "codex";
  const held = codex && machine !== LOCAL;
  const progress = own(section?.progress, machine);
  const { read, readAt, from, failure } = newest(entry, progress, machine, tool);
  if (!member || held) {
    const display = rowFor(tool, entry, ref, now);
    const actions = held ? [] : codex ? ["place"] : read && !failure ? ["add"] : [];
    return { ...display, code: held ? "held" : display.code, wanted: null, managed: false, actions };
  }

  const wanted = own(section.assign, machine);
  // A read of another app home cannot confirm or suspend this assignment.
  const home = from === "apply" ? read?.home : entry?.appHome;
  const current = codex
    ? (ref?.codexLocal ?? read)
    : home === member.home ? read : null;
  const obs = current && !failure ? { ...current, ...(codex ? { active: ref?.active } : {}) } : null;
  const fingerprint = obs?.account ?? null;
  const on = onAccount(tool, machine, plan, obs);
  const account = codex ? observedCodex(obs, ref?.active, section.seen?.local?.placed) ?? fingerprint : eligibleEmail(obs);
  const here = account == null ? null : wanted == null ? "none" : on.on ? "same" : "other";
  const moveOff = wanted && (progress?.why === "not-eligible" || (codex
    ? Array.isArray(ref?.codexUsable) && !ref.codexUsable.includes(wanted)
    : obs?.slotsComplete && !obs.slots.some((slot) => slot.state === "eligible" && slot.email === wanted)));
  const row = (state, code = null, actions = [], grant = codex ? "unknown" : null) => ({
    state, code, account, wanted, here, grant, managed: true,
    actions: moveOff && progress?.state !== "suspended" ? [...actions, "move-off"] : actions,
  });
  if (progress?.state === "suspended") {
    if (progress.why === "gone") return row("gone", "gone", openDispatch(progress) ? ["forget"] : ["rebind", "forget"]);
    if (!codex && machine !== LOCAL && !failure && home && home !== member.home
      && read?.slotsComplete && snapshotOf(read) !== null && Date.parse(readAt) >= Date.parse(progress.at)) {
      return row("changed", "changed", ["forget"]);
    }
    return row("changed", "changed", ["adopt", "reapply"]);
  }
  if (failure) return row(failure, entry.reason);
  if (codex && Date.parse(obs?.at ?? readAt) > Date.parse(progress?.at) && codexDrift(obs, own(section.seen, machine), progress)) {
    return row("changed", "changed", ["adopt", "reapply"]);
  }
  if (codex && !wanted) return row("still-on", null, ["place"]);
  // An approved local Codex placement still has to run, even on the same account.
  if (on.on && !(codex && progress?.state === "pending")) {
    return row("on", null, on.grant === "origin-unknown" ? ["place"] : [], on.grant);
  }
  if (progress?.state === "pending") {
    if (progress.attempt?.outcome === null && (!readAt || Date.parse(progress.attempt.at) > Date.parse(readAt))) {
      return row("switching");
    }
    if (progress.why === "no-login") return row("no-login", "no-login");
    if (progress.why === "update-first") return row("unknown", "update-first");
    return row("still-on", progress.why);
  }
  if (!codex && claudeDrift(obs, readAt, progress, wanted)) {
    return row("changed", "changed", ["adopt", "reapply"]);
  }
  return row("still-on");
}

/** Group the same machine list for both tools. Keep the plan's recorded progress in the answer. */
export function planRows({ plan, fleet, ref, now }) {
  const machines = fleet?.machines;
  const ids = new Set([...Object.keys(machines ?? {}),
    ...TOOLS.flatMap((tool) => Object.keys(plan?.[tool]?.members ?? {}))]);
  const ordered = machineOrder(ids);
  return Object.fromEntries(TOOLS.map((tool) => [tool, ordered.map((machine) => {
    const entry = own(machines, machine);
    const section = plan?.[tool];
    const row = planRowFor(tool, entry, plan, machine, ref?.[tool], now);
    const unbound = row.managed && machine !== LOCAL && entry?.state === "read" && entry.core !== machine;
    return { machine, name: entry?.name ?? own(plan?.names, machine) ?? machine,
      member: own(section?.members, machine), progress: own(section?.progress, machine),
      ...row, ...(unbound ? { observation: rowFor(tool, entry, ref?.[tool], now) } : {}) };
  })]));
}
