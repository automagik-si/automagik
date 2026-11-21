// Plan decisions, without file or machine access. The CLI gives the planner its observations.
import {
  claudeDrift, codexDrift, eligibleClaudeSlot, LOCAL, TOOLS, MODES, PREVIEW_TTL_MS, cmp, compareMachines, emptyPlan, entryDigest, isClaudeKey, isCodexKey,
  isFingerprint, isHash, isHome, isIso, isMachine, isProxyId, machineOrder, newest, observedCodex, openDispatch, own, parsePlan,
  parseRead, pendingClaudeDrift, confirmedClaude, recoverable, routeManaged, snapshotOf,
} from "./accountsPlanRecord.js";
import { defaultHomeExceptions } from "./accountsRows.js";

const toolOf = (section) => Object.hasOwn(section, "machines") ? "codex" : "claude";
const time = (value) => isIso(value) ? Date.parse(value) : -Infinity;
const suspended = (section, id) => own(section.progress, id)?.state === "suspended";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const refuse = (error) => ({ error });

/** Read the account identity. A name alone cannot establish the origin of a Codex grant. */
export function observed(tool, view, input = {}, plan = null) {
  if (tool === "claude") return view?.claude?.email ?? null;
  return view?.id === LOCAL ? observedCodex(input.codexLocal, input.active, plan?.codex?.seen?.local?.placed) : null;
}

/** Return the distinct keys the machine can switch to. */
export function eligible(tool, view, input = {}) {
  const keys = tool === "codex" ? (view?.id === LOCAL ? input.codexUsable ?? [] : [])
    : (view?.claude?.slots ?? []).filter((slot) => slot.state === "eligible" && isClaudeKey(slot.email)).map((slot) => slot.email);
  return [...new Set(keys)].sort(cmp);
}

/** Manage can pin only a current, readable observation of the effective account. */
export function proven(tool, view) {
  // A Codex account fingerprint cannot identify the grant that was installed.
  return tool === "claude" && view?.read && !view.away && isHome(view.appHome) ? confirmedClaude(view.claude) : null;
}

/** Pick the least-used eligible key, breaking a tie by code point. */
export function placeOne(counts, keys) {
  let best = null;
  const count = (key) => (counts instanceof Map ? counts.get(key) : own(counts, key)) ?? 0;
  for (const key of keys) {
    if (best === null || count(key) < count(best) || count(key) === count(best) && cmp(key, best) < 0) best = key;
  }
  return best;
}

const indexViews = (views) => new Map(views.map((view) => [view.id, view]));
const bump = (counts, key, delta) => counts.set(key, (counts.get(key) ?? 0) + delta);
const observedHere = (tool, view, input, section) => view?.read && !view.away
  ? tool === "claude" ? confirmedClaude(view.claude) : observed(tool, view, input, { [tool]: section }) : null;

/** Place only the named machines. Each placement counts for the next machine. */
export function place(section, views, input, machines) {
  const byId = indexViews(views);
  const tool = toolOf(section);
  const targets = new Set(machines);
  const assign = new Map(Object.entries(section.assign));
  const counts = new Map();
  for (const [id, account] of assign) {
    if (targets.has(id)) continue;
    const view = byId.get(id), pin = own(section.pin, id);
    const fixed = pin && !eligible(tool, view, input).includes(pin) ? observedHere(tool, view, input, section) : null;
    bump(counts, fixed ?? account, 1);
  }
  for (const id of machineOrder(targets)) {
    const account = placeOne(counts, eligible(tool, byId.get(id), input)) ?? assign.get(id);
    if (account) {
      assign.set(id, account);
      bump(counts, account, 1);
    }
  }
  return Object.fromEntries(machineOrder(assign.keys()).map((id) => [id, assign.get(id)]));
}

export const MAX_NODES = 2_000_000;
const compareCounts = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

/** Find the exact spread. Keep pins, away machines and suspended assignments in the counts. */
export function rebalance(section, views, input, { maxNodes = MAX_NODES } = {}) {
  const tool = toolOf(section);
  const byId = indexViews(views);
  const machines = machineOrder(Object.keys(section.members));
  const fixed = new Map(), counts = new Map(), free = [], flags = [];
  for (const machine of machines) {
    const view = byId.get(machine);
    const observation = observedHere(tool, view, input, section);
    const approved = own(section.assign, machine);
    const current = observation ?? approved;
    const keys = eligible(tool, view, input);
    const pin = own(section.pin, machine);
    for (const key of [...keys, current, approved].filter(Boolean)) {
      if (!counts.has(key)) counts.set(key, 0);
    }
    let key = approved ?? current, code;
    if (suspended(section, machine)) {
      // A suspended machine keeps its assignment until the person acts.
    } else if (view?.away) {
      code = "away";
    } else if (!view?.read) {
      // An older inventory cannot authorize a move.
    } else if (pin) {
      if (keys.includes(pin)) key = pin;
      else {
        key = current;
        code = "pin-not-eligible";
      }
    } else if (keys.length === 0) {
      code = "nothing-eligible";
    } else {
      free.push({ current, keys, machine });
      continue;
    }
    if (code) flags.push({ tool, machine, code, ...(code === "pin-not-eligible" ? { account: pin } : {}) });
    if (key) {
      fixed.set(machine, key);
      bump(counts, key, 1);
    }
  }

  // A suffix class captures eligibility and whether choosing a key changes a machine.
  // With equal counts, two keys in the same class have interchangeable completions.
  const classes = [];
  let suffix = new Map();
  for (let i = free.length - 1; i >= 0; i--) {
    const { keys, current } = free[i];
    const available = new Set(keys), groups = new Map(), next = new Map();
    for (const key of counts.keys()) {
      const signature = [suffix.get(key) ?? 0, available.has(key), key === current].join("/");
      if (!groups.has(signature)) groups.set(signature, groups.size);
      next.set(key, groups.get(signature));
    }
    classes[i] = next;
    suffix = next;
  }

  const choices = [];
  const limit = Math.min(maxNodes, MAX_NODES);
  let nodes = 0, bestCounts = null, bestMoves = Infinity, best = null;
  function search(depth, moved) {
    if (++nodes > limit) return false;
    const loads = [...counts.values()].sort((a, b) => b - a);
    const order = bestCounts === null ? -1 : compareCounts(loads, bestCounts);
    if (order > 0) return true;
    if (depth === free.length) {
      // The first answer for equal loads and moves is the first in code-point order.
      if (order < 0 || moved < bestMoves) {
        bestCounts = loads;
        bestMoves = moved;
        best = [...choices];
      }
      return true;
    }
    const { keys, current } = free[depth];
    const seen = new Set();
    for (const key of keys) {
      const signature = classes[depth].get(key) + "/" + counts.get(key);
      if (seen.has(signature)) continue;
      seen.add(signature);
      bump(counts, key, 1);
      choices[depth] = key;
      if (!search(depth + 1, moved + Number(key !== current))) return false;
      bump(counts, key, -1);
    }
    return true;
  }
  if (!search(0, 0)) return refuse("too-many");
  free.forEach(({ machine }, i) => fixed.set(machine, best[i]));
  return { assign: Object.fromEntries(machines.filter((id) => fixed.has(id)).map((id) => [id, fixed.get(id)])), flags };
}

/** Return the linked Claude members missing from a complete membership read. */
export function goneLinked(plan, first) {
  if (!first?.complete) return [];
  const present = new Set(first.list.map(({ id }) => id));
  return machineOrder(Object.keys(plan.claude.members)).filter((id) => id !== LOCAL && !present.has(id));
}

const exceptionsOf = (entry) => [...(entry?.exceptions?.bound ?? []), ...(entry?.exceptions?.list ?? []), ...defaultHomeExceptions(entry?.exceptions)]
  .filter(({ why }) => !routeManaged(why)).map(({ project, why }) => ({ project, why }));
const route = (email, state) => ({ email, state });
const recordRoute = (read) => route(read.email, ["eligible", "timeout", "failed", "not-signed-in", "unresolved"].includes(read.state) ? read.state : "failed");

/** Choose one bound Claude inventory per machine and keep the fleet's launch-route evidence. */
export function viewsFrom(record, plan, qualify = () => false) {
  const ids = new Set([...Object.keys(record?.machines ?? {}),
    ...TOOLS.flatMap((tool) => Object.keys(plan?.[tool]?.members ?? {}))]);
  return machineOrder(ids).map((id) => {
    const entry = own(record?.machines, id);
    const { read, readAt, from, failure } = newest(entry, own(plan?.claude?.progress, id), id);
    const bound = id === LOCAL ? isMachine(entry?.core) : entry?.core === id;
    const appHome = (from === "apply" ? read.home : bound ? entry.appHome : null) ?? null;
    const codex = bound ? entry.codex : null;
    const codexRead = newest(entry, own(plan?.codex?.progress, id), id, "codex");
    let claude = null;
    if (read) {
      const { record, snapshot, selected, effective, email, state, slots, slotsComplete, nextSlot } = read;
      const fleetRoutes = bound && appHome === entry.appHome ? entry.claude?.routes : null;
      const routes = from === "apply"
        ? { bare: fleetRoutes?.bare ?? route(null, "unresolved"), record: recordRoute(read) }
        : fleetRoutes ?? null;
      claude = { record, snapshot, selected, effective, email, state,
        slots: slots.map(({ id, email, state }) => ({ id, email, state })), slotsComplete, nextSlot: nextSlot ?? null,
        routes, routesDiffer: Boolean(routes?.bare.email && routes?.record.email && routes.bare.email !== routes.record.email) };
    }
    // A local read is dispatched here directly. Its real core id need not be the word "local".
    const localRead = id === LOCAL && entry?.state === "read" && bound && entry.appHome && !failure;
    const hasRead = Boolean(read && !failure || localRead && (codex || codexRead.read));
    return { id, name: entry?.name ?? own(plan?.names, id) ?? id, away: failure === "away", read: hasRead,
      readAt: readAt ?? (localRead ? entry.at : null), from, appHome,
      qualified: Boolean(entry && bound && qualify(entry.writer, entry.write)),
      claude, codex: codex ? { account: codex.account, generation: codex.generation, home: codex.home } : null,
      exceptions: exceptionsOf(entry) };
  });
}

const entryAt = (section, id) => own(section.progress, id);
const validInventory = (view, progress, home) => view?.read && !view.away && isHome(view.appHome)
  && (!home || view.appHome === home) && snapshotOf(view.claude) !== null && view.claude.slotsComplete
  && time(view.readAt) >= Math.max(time(progress?.attempt?.at), progress?.state === "suspended" ? time(progress.at) : -Infinity);

const codexLocalFields = {
  home: isHome, account: (v) => v === null || isFingerprint(v), generation: (v) => v === null || isHash(v),
  proxy: (v) => v === null || isProxyId(v),
};
const activeFields = { name: isCodexKey, fingerprint: isFingerprint };
const exact = (v, checks) => object(v) && Object.keys(v).length === Object.keys(checks).length
  && Object.entries(checks).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));
const observations = {
  codexAccounts: (v) => Array.isArray(v) && v.every(isCodexKey),
  codexUsable: (v) => Array.isArray(v) && v.every(isCodexKey),
  codexLocal: (v) => v === null || exact(v, codexLocalFields),
  active: (v) => v === null || exact(v, activeFields),
};
const kinds = {
  manage: [[], []],
  mode: [["tool", "mode"], ["account"]],
  account: [["tool", "account"], []],
  pin: [["tool", "machine", "account"], []],
  unpin: [["tool", "machine"], []],
  add: [["tool", "machine"], ["account"]],
  "spread-again": [["tool"], []],
  adopt: [["tool", "machine"], []],
  reapply: [["tool", "machine"], []],
  rebind: [["from", "to"], []],
  forget: [["machine"], []],
  "dismiss-exposure": [["machine"], []],
  "second-login": [["machine", "allow"], []],
  "move-off": [["tool", "account"], ["to", "machine", "include"]],
};

function checkRequest(request, input, plan, controllerHome) {
  const spec = own(kinds, request?.kind);
  if (!spec || request.v !== 1) return "bad-request";
  const [required, optional] = spec;
  const codex = request.tool === "codex";
  const account = codex ? isCodexKey : isClaudeKey;
  const checks = { tool: (v) => TOOLS.includes(v), mode: (v) => MODES.includes(v), account, to: account,
    machine: isMachine, from: isMachine, allow: (v) => typeof v === "boolean",
    include: (v) => Array.isArray(v) && v.every(isMachine), ...observations };
  if (request.kind === "rebind") checks.to = isMachine;
  checks.claudeLocal = (value) => {
    try {
      const read = parseRead(value, "claude", LOCAL);
      return read?.core === null && read.home === controllerHome && read.slotsComplete
        && snapshotOf(read) !== null;
    } catch { return false; }
  };
  const allowed = [...required, ...optional, ...(codex || request.kind === "manage" ? Object.keys(observations) : []),
    ...(!codex && (request.tool === "claude" || request.kind === "manage") ? ["claudeLocal"] : [])];
  if (!required.every((key) => Object.hasOwn(request, key))
    || Object.keys(request).some((key) => key !== "v" && key !== "kind" && (!allowed.includes(key) || !checks[key](request[key])))) {
    return "bad-request";
  }
  if (codex && [request.machine, ...(request.include ?? [])].some((id) => id && id !== LOCAL)) return "held";
  if (request.kind === "mode" && request.mode === "one" && !request.account) return "bad-request";
  if (!codex) return null;
  const kind = request.kind;
  const needsUsable = ["mode", "account", "pin", "add", "spread-again", "move-off"].includes(kind)
    || kind === "unpin" && plan?.codex.mode !== "pinned";
  if (needsUsable && !observations.codexUsable(input.codexUsable)) return "bad-request";
  if (kind === "add" && (!request.account || !input.codexLocal)) return "bad-request";
  if (["adopt", "reapply"].includes(kind) && (!input.codexLocal || !Object.hasOwn(input, "active"))) return "bad-request";
  return null;
}

function observationFor(tool, view, input, placed = null) {
  if (tool === "codex") {
    const { home, account, generation, proxy } = input.codexLocal;
    return { home, account, generation, proxy, placed: placed?.proxy === proxy ? placed : null };
  }
  return { home: view.appHome, snapshot: snapshotOf(view.claude), email: observed(tool, view, input) };
}

const routeLabel = (result) => result?.email ?? result?.state ?? null;

function previewRoutes(tool, view, assign) {
  const { bare, record } = view?.claude?.routes ?? {};
  const now = { start: routeLabel(bare), tree: routeLabel(record) };
  if (tool !== "claude") return { now: { start: null, tree: null }, next: { start: null, tree: null } };
  // Project exceptions keep these 'now' routes. The next routes describe managed projects.
  const resolved = view?.qualified && view.read && !view.away && snapshotOf(view.claude) !== null
    && view.claude.state !== "unresolved" && record?.state !== "unresolved";
  const applies = resolved && eligibleClaudeSlot(view.claude, assign);
  const tree = applies && record?.state === "eligible" ? assign : now.tree;
  const bareResolved = bare?.state === "eligible" || bare?.state === "not-signed-in";
  const start = resolved && bareResolved && record?.state === "eligible" ? tree : now.start;
  return { now, next: { start, tree } };
}

function noAccount(tool, view, account) {
  if (tool === "claude" && !view?.claude?.slots.some(({ email }) => email === account)) return "no-login";
  return "not-eligible";
}

const timestamp = (now) => typeof now === "number" ? new Date(now).toISOString() : now;
const progressReset = (state, why = null) => ({ state, why });

/** Describe the press as a patch with a precondition on each entry it would change. */
export function buildPreview({ plan, base, views, request, input = {}, now, id, sha256Hex, controllerHome }) {
  const evidence = Object.fromEntries(Object.keys(observations)
    .filter((key) => Object.hasOwn(request ?? {}, key) || Object.hasOwn(input, key))
    .map((key) => [key, Object.hasOwn(request ?? {}, key) ? request[key] : input[key]]));
  if (Object.entries(evidence).some(([key, value]) => !observations[key](value))) return refuse("bad-request");
  const invalid = checkRequest(request, evidence, plan, controllerHome);
  if (invalid) return refuse(invalid);
  if (base.state === "newer") return refuse("newer-plan");
  if (request.claudeLocal) request = { ...request, claudeLocal: parseRead(request.claudeLocal, "claude", LOCAL) };
  const { kind, account, machine, from, to, allow, include = [] } = request;
  const manage = kind === "manage";
  if (manage && base.state === "ok") return refuse("exists");
  if (!manage && base.state !== "ok") return refuse("no-plan");

  const at = timestamp(now);
  const before = plan ?? emptyPlan(at);
  const byId = indexViews(views);
  const local = byId.get(LOCAL);
  if (request.claudeLocal || evidence.codexLocal && !local?.appHome && isHome(controllerHome)) {
    // The local panel reads in its own environment. Its evidence says nothing about a linked core.
    const read = request.claudeLocal;
    const newer = read && (!local?.readAt || time(read.at) >= time(local.readAt));
    byId.set(LOCAL, { ...local, id: LOCAL, name: "This Mac",
      ...(newer ? { read: true, readAt: read.at, appHome: read.home, qualified: true,
        claude: { ...read, routes: local?.claude?.routes ?? null } } : {}),
      ...(!local?.appHome && !newer ? { appHome: controllerHome, read: Boolean(evidence.codexLocal) } : {}),
    });
    views = [...byId.values()];
  }
  const patch = { entries: [], section: {}, names: { set: {}, drop: {} } };
  const flags = [], moves = [], changes = [];
  const tool = request.tool ?? "claude";
  const section = before[tool];
  const names = before.names;
  const flag = (tool, machine, code, details = {}) => {
    if (!flags.some((f) => f.tool === tool && f.machine === machine && f.code === code && f.account === details.account)) {
      flags.push({ tool, machine, code, ...details });
    }
  };
  const drift = (id) => {
    const view = byId.get(id), member = own(section.members, id);
    const progress = entryAt(section, id), wanted = own(section.assign, id);
    if (!member) return false;
    if (tool === "codex") return id === LOCAL && codexDrift(evidence.codexLocal, own(section.seen, id), progress);
    if (!view?.read || view.appHome !== member.home) return false;
    if (progress?.state === "pending") {
      const seen = own(section.seen, id);
      return seen && time(view.readAt) >= Math.max(time(member.since), time(progress.attempt?.at))
        && pendingClaudeDrift(view.claude, seen, progress.attempt, wanted);
    }
    return claudeDrift(view.claude, view.readAt, progress, wanted);
  };
  const skip = (id) => {
    if (!suspended(section, id) && !drift(id)) return false;
    flag(tool, id, "suspended-stays");
    return true;
  };

  function addPatch(tool, id, set, { leaving = false } = {}) {
    if (Object.keys(set).length === 0) return;
    const section = before[tool], view = byId.get(id);
    const member = own(section.members, id);
    const previous = own(section.assign, id), oldPin = own(section.pin, id);
    const wanted = leaving ? null : Object.hasOwn(set, "assign") ? set.assign : previous;
    const newPin = leaving ? null : Object.hasOwn(set, "pin") ? set.pin : oldPin;
    const name = view?.name ?? own(names, id) ?? id;
    const reads = observed(tool, view, evidence, before);
    const exceptions = tool === "claude" ? view?.exceptions ?? [] : [];
    const routes = previewRoutes(tool, view, wanted);
    if (leaving) routes.next = routes.now;
    patch.entries.push({ tool, machine: id, pre: entryDigest(before, tool, id, sha256Hex), set });
    changes.push({ tool, machine: id, name, join: !member && !leaving,
      pin: oldPin !== newPin ? [oldPin, newPin] : null, assign: [previous, wanted], observed: reads,
      home: set.member?.home ?? member?.home ?? null, routes, exceptions });
    if (!manage && wanted && reads !== wanted && (set.progress || wanted !== previous)) {
      moves.push({ tool, machine: id, name, from: reads, to: wanted });
    }
    if (view?.away) flag(tool, id, "away");
    if (tool === "claude") {
      if (view && !view.qualified) flag(tool, id, "update-first");
      if (exceptions.length) flag(tool, id, "unmanaged-home");
      if (view?.claude?.routesDiffer) flag(tool, id, "routes-differ");
    }
    if (!leaving && id !== LOCAL && view && own(names, id) !== name) {
      patch.names.set = { ...patch.names.set, [id]: [own(names, id), name] };
    }
  }

  function needsRead(tool, id, member = null, progress = null) {
    const view = byId.get(id);
    if (tool === "codex" ? Boolean(view && evidence.codexLocal) : validInventory(view, progress, member?.home)) return false;
    if (view?.away) flag(tool, id, "away");
    flag(tool, id, "read-again");
    return true;
  }

  function setWanted(tool, id, wanted, set = {}, { pending = false, seen = null } = {}) {
    const section = before[tool], view = byId.get(id);
    const current = own(section.assign, id);
    if (!wanted) return set;
    const resets = current !== wanted || pending || Boolean(seen);
    if (resets && !seen && needsRead(tool, id, own(section.members, id), entryAt(section, id))) return null;
    const checksEligibility = tool === "claude" || Object.hasOwn(evidence, "codexUsable");
    const state = checksEligibility && !eligible(tool, view, evidence).includes(wanted) ? noAccount(tool, view, wanted) : null;
    if (state) flag(tool, id, state, { account: wanted });
    if (!resets) return set;
    const oldPlacement = own(section.seen, id)?.placed;
    return { ...set, ...(current === wanted ? {} : { assign: wanted }),
      seen: seen ?? observationFor(tool, view, evidence, oldPlacement),
      progress: (tool === "claude" ? confirmedClaude(view?.claude) : observed(tool, view, evidence, before)) === wanted && !pending
        ? progressReset("done") : progressReset("pending", state) };
  }

  function sectionChange(key, value) {
    if (section[key] !== value) patch.section[tool] = { ...patch.section[tool], [key]: [section[key], value] };
  }

  const machines = machineOrder(Object.keys(section.members));
  const needsOneReads = (wanted, from) => {
    let blocked = false;
    for (const id of machines) {
      const assigned = own(section.assign, id);
      if (own(section.pin, id) || assigned === wanted || from && assigned !== from || skip(id)) continue;
      if (needsRead(tool, id, own(section.members, id), entryAt(section, id))) {
        flag(tool, id, "one-incomplete");
        blocked = true;
      }
    }
    return blocked;
  };
  const member = own(section.members, machine);
  const progress = entryAt(section, machine);
  const view = byId.get(machine);

  if (manage) {
    for (const tool of TOOLS) {
      for (const id of machineOrder(byId.keys())) {
        const view = byId.get(id);
        const key = proven(tool, view);
        if (!key) {
          flag(tool, id, "unmanaged");
          continue;
        }
        addPatch(tool, id, { member: { since: at, home: view.appHome }, assign: key, pin: key,
          seen: observationFor(tool, view, evidence), progress: progressReset("done") });
      }
    }
  } else if (kind === "mode" || kind === "account") {
    if (kind === "account" && section.mode !== "one") return refuse("bad-request");
    const mode = request.mode ?? section.mode;
    const wanted = mode === "one" ? account : null;
    // Do not approve a group account change that would silently leave a member on the old one.
    if (tool === "claude" && mode === "one" && needsOneReads(wanted)) return answer();
    sectionChange("mode", mode);
    sectionChange("account", wanted);
    const toPlace = [];
    for (const id of machines) {
      if (skip(id)) continue;
      const pin = own(section.pin, id);
      const v = byId.get(id), keys = eligible(tool, v, evidence);
      if (v?.away) flag(tool, id, "away");
      if (mode === "spread" && !pin) {
        if (keys.includes(own(section.assign, id))) continue;
        if (!needsRead(tool, id, own(section.members, id), entryAt(section, id))) {
          if (keys.length) toPlace.push(id);
          else flag(tool, id, "nothing-eligible");
        }
        continue;
      }
      if (pin && !keys.includes(pin)) {
        if (!needsRead(tool, id, own(section.members, id), entryAt(section, id))) {
          flag(tool, id, "pin-not-eligible", { account: pin });
          const kept = setWanted(tool, id, observedHere(tool, v, evidence, section));
          if (kept) addPatch(tool, id, kept);
        }
        continue;
      }
      if (mode === "pinned" && !pin) {
        flag(tool, id, "no-pin");
        continue;
      }
      const set = setWanted(tool, id, pin ?? wanted);
      if (set) addPatch(tool, id, set);
    }
    if (toPlace.length) {
      const approvedPins = Object.fromEntries(patch.entries.filter(({ set }) => set.assign)
        .map(({ machine, set }) => [machine, set.assign]));
      const assignments = place({ ...section, assign: { ...section.assign, ...approvedPins } }, views, evidence, toPlace);
      for (const id of toPlace) {
        const set = setWanted(tool, id, own(assignments, id));
        if (set) addPatch(tool, id, set);
      }
    }
  } else if (kind === "pin" || kind === "unpin") {
    if (!member) return refuse("not-member");
    const clearing = kind === "unpin" && section.mode === "pinned" && !suspended(section, machine);
    if (clearing || !skip(machine)) {
      const pin = own(section.pin, machine), nextPin = account ?? null;
      const setPin = pin === nextPin ? {} : { pin: nextPin };
      let wanted = null;
      if (nextPin) {
        if (!needsRead(tool, machine, member, progress)) {
          if (eligible(tool, view, evidence).includes(nextPin)) wanted = nextPin;
          else {
            flag(tool, machine, "pin-not-eligible", { account: nextPin });
            wanted = observedHere(tool, view, evidence, section);
          }
        } else return answer();
      } else if (section.mode === "one") wanted = section.account;
      else if (clearing) {
        flag(tool, machine, "no-pin");
        if (own(section.assign, machine)) Object.assign(setPin, { assign: null, progress: null });
      }
      else {
        if (needsRead(tool, machine, member, progress)) return answer();
        if (eligible(tool, view, evidence).length) wanted = own(place(section, views, evidence, [machine]), machine);
        else flag(tool, machine, "nothing-eligible");
      }
      const set = setWanted(tool, machine, wanted, setPin);
      if (set) addPatch(tool, machine, set);
    }
  } else if (kind === "add") {
    const codex = tool === "codex";
    const usable = eligible(tool, view, evidence);
    if (!view || !isHome(view.appHome ?? (codex ? member?.home : null))) return refuse("unknown-machine");
    const placed = codex && own(section.seen, machine)?.placed;
    const currentPlacement = placed && placed.name === account && placed.account === evidence.codexLocal.account
      && placed.generation === evidence.codexLocal.generation && placed.proxy === evidence.codexLocal.proxy;
    if (member && (!codex || currentPlacement)) return refuse("member");
    if (member && skip(machine)) return answer();
    if (needsRead(tool, machine, member, progress)) return answer();
    if (codex && !usable.includes(account)) {
      flag(tool, machine, "not-eligible", { account });
      return answer();
    }
    const set = member ? {} : { member: { since: at, home: view.appHome } };
    let wanted = section.account;
    if (member && codex && own(section.assign, machine)) {
      wanted = own(section.assign, machine);
    } else if (section.mode === "spread") {
      wanted = own(place(section, views, evidence, [machine]), machine);
      if (!usable.length) flag(tool, machine, "nothing-eligible");
    } else if (section.mode === "pinned") {
      wanted = usable.includes(account) ? account : proven(tool, view);
      if (wanted) set.pin = wanted;
      else flag(tool, machine, "no-pin");
    }
    if (codex && account !== wanted) return refuse("not-eligible");
    const seen = observationFor(tool, view, evidence);
    const changed = setWanted(tool, machine, wanted, set, { pending: codex, seen });
    addPatch(tool, machine, { seen, ...changed });
  } else if (kind === "spread-again") {
    const fixed = new Map();
    for (const id of machines) {
      if (suspended(section, id) || byId.get(id)?.away) continue;
      if (drift(id) || needsRead(tool, id, own(section.members, id), entryAt(section, id))) fixed.set(id, { state: "suspended" });
    }
    const result = rebalance({ ...section, progress: { ...section.progress, ...Object.fromEntries(fixed) } }, views, evidence);
    if (result.error) return result;
    for (const { tool, machine, code, account } of result.flags) flag(tool, machine, code, account ? { account } : {});
    for (const id of machines) {
      if (skip(id) || fixed.has(id) || own(section.assign, id) === own(result.assign, id)) continue;
      const set = setWanted(tool, id, own(result.assign, id));
      if (set) addPatch(tool, id, set);
    }
  } else if (kind === "adopt" || kind === "reapply") {
    if (!member) return refuse("not-member");
    if (!(progress?.state === "suspended" && progress.why === "changed") && !drift(machine)) return refuse("not-changed");
    if (needsRead(tool, machine, member, progress)) return answer();
    const observedNow = observed(tool, view, evidence, before);
    const seen = observationFor(tool, view, evidence, kind === "adopt" ? null : own(section.seen, machine)?.placed);
    if (kind === "adopt") {
      if (!observedNow) {
        flag(tool, machine, "read-again");
        return answer();
      }
      const set = { assign: observedNow, seen, progress: progressReset("done") };
      if (own(section.pin, machine) || section.mode !== "spread") set.pin = observedNow;
      addPatch(tool, machine, set);
    } else {
      const set = setWanted(tool, machine, own(section.assign, machine), {}, { pending: true, seen });
      addPatch(tool, machine, set);
    }
  } else if (kind === "rebind" || kind === "forget") {
    const old = kind === "rebind" ? from : machine;
    if (old === LOCAL || kind === "rebind" && to === LOCAL) return refuse("bad-request");
    const prior = own(section.members, old), status = entryAt(section, old);
    const newHome = kind === "forget" && status?.why === "changed" && view?.appHome !== prior?.home
      && validInventory(view, status);
    if (!prior || status?.why !== "gone" && !newHome) return refuse("not-gone");
    if (kind === "forget" && status.why === "gone" && openDispatch(status)) flag(tool, old, "open-dispatch");
    if (kind === "rebind") {
      if (own(section.members, to)) return refuse("member");
      const target = byId.get(to);
      if (!target) return refuse("unknown-machine");
      if (needsRead(tool, to)) return answer();
      const set = { member: { since: at, home: target.appHome }, seen: observationFor(tool, target, evidence) };
      const pin = own(section.pin, old);
      if (pin) set.pin = pin;
      if (own(section.secondLogin, old)) set.secondLogin = true;
      const wanted = own(section.assign, old);
      addPatch(tool, to, setWanted(tool, to, wanted, set, { seen: set.seen }));
    }
    addPatch(tool, old, { member: null }, { leaving: true });
    if (own(names, old)) patch.names.drop = { ...patch.names.drop, [old]: names[old] };
  } else if (kind === "dismiss-exposure") {
    if (!own(before.exposures, machine)) return refuse("not-member");
  } else if (kind === "second-login") {
    if (!member) return refuse("not-member");
    if (!skip(machine) && Boolean(own(section.secondLogin, machine)) !== allow) {
      addPatch(tool, machine, { secondLogin: allow ? true : null });
    }
  } else if (kind === "move-off") {
    if (machine && !member) return refuse("not-member");
    const changesOne = section.mode === "one" && section.account === account && !machine;
    if (section.mode === "one" && section.account === account) {
      if (!to || to === account) return refuse("bad-request");
      if (!machine) {
        if (tool === "claude" && needsOneReads(to, account)) return answer();
        sectionChange("account", to);
      }
    }
    const counts = new Map();
    for (const key of Object.values(section.assign)) bump(counts, key, 1);
    for (const id of machine ? [machine] : machines) {
      if (own(section.assign, id) !== account || skip(id)) continue;
      const pin = own(section.pin, id);
      if (pin && !include.includes(id)) {
        flag(tool, id, "pinned-stays", { account: pin });
        continue;
      }
      if (needsRead(tool, id, own(section.members, id), entryAt(section, id))) continue;
      const keys = eligible(tool, byId.get(id), evidence).filter((key) => key !== account);
      const wanted = changesOne && !pin || keys.includes(to) ? to : placeOne(counts, keys);
      if (!wanted) {
        flag(tool, id, "nothing-eligible");
        continue;
      }
      const override = pin || machine && section.mode === "one" && wanted !== section.account;
      const set = setWanted(tool, id, wanted, override ? { pin: wanted } : {});
      if (set) {
        addPatch(tool, id, set);
        bump(counts, account, -1);
        bump(counts, wanted, 1);
      }
    }
  }
  return answer();

  function answer() {
    const byMachine = (a, b) => TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool)
      || compareMachines(a.machine, b.machine);
    for (const list of [patch.entries, moves, flags, changes]) list.sort(byMachine);
    return { preview: { v: 1, kind: "accounts.preview", id, base, at, request, patch, moves, flags, changes } };
  }
}

const setEntry = (section, field, id, value) => {
  if (value === null) {
    delete section[field][id];
  } else {
    Object.defineProperty(section[field], id, { value, enumerable: true, configurable: true, writable: true });
  }
};

// Claude previews need the last bound read even after the machine's assignment is cleared.
function clearProgress(section, tool, machine) {
  const read = tool === "claude" ? own(section.progress, machine)?.read : null;
  setEntry(section, "progress", machine, read ? { read } : null);
}

const PATCH_FIELDS = { member: "members", assign: "assign", pin: "pin", seen: "seen", secondLogin: "secondLogin" };

/** Check the preview against the live entries before merging only the fields it changes. */
export function commitPreview(live, liveBase, preview, { expectRev, now, sha256Hex, confirmForget = false }) {
  if (liveBase.state === "newer") return refuse("newer-plan");
  const { base, patch } = preview;
  if (expectRev !== base.rev || liveBase.state !== base.state || liveBase.rev !== base.rev
    || base.state === "corrupt" && (liveBase.digest !== base.digest || preview.request?.kind !== "manage")
    || base.state === "absent" && preview.request?.kind !== "manage") return refuse("stale");
  const at = timestamp(now);
  if (!isIso(preview.at) || time(at) - time(preview.at) >= PREVIEW_TTL_MS) return refuse("expired");
  const before = live ?? emptyPlan(at);
  if (preview.flags?.some(({ code }) => code === "one-incomplete")) return refuse("read-again");

  try {
    const entries = new Set();
    for (const { tool, machine, pre, set } of patch.entries) {
      const key = tool + ":" + machine;
      if (!TOOLS.includes(tool) || !isMachine(machine) || tool === "codex" && machine !== LOCAL
        || entries.has(key) || !object(set) || Object.keys(set).some((field) =>
          field !== "progress" && (!Object.hasOwn(PATCH_FIELDS, field) || tool === "codex" && field === "secondLogin"))
        || Object.hasOwn(set, "assign") && set.assign !== own(before[tool].assign, machine)
          && (set.assign === null ? set.progress !== null : !set.seen || !set.progress)) return refuse("stale");
      entries.add(key);
      if (pre !== entryDigest(before, tool, machine, sha256Hex)) return refuse("stale");
    }
    for (const [tool, edits] of Object.entries(patch.section)) {
      if (!TOOLS.includes(tool)) return refuse("stale");
      for (const [field, [old, next]] of Object.entries(edits)) {
        if (!["mode", "account"].includes(field) || before[tool][field] !== old) return refuse("stale");
        // The retained pin hides this machine from a mode change until its Unpin can finish.
        if (next !== old && Object.values(before[tool].progress).some((progress) => progress.cancel)) return refuse("busy");
      }
    }
    for (const [id, [old]] of Object.entries(patch.names.set)) {
      if (own(before.names, id) !== old) return refuse("stale");
    }
    for (const [id, old] of Object.entries(patch.names.drop)) {
      if (own(before.names, id) !== old) return refuse("stale");
    }
    const cancel = new Set();
    let retired;
    for (const { tool, machine, set } of patch.entries) {
      const progress = own(before[tool].progress, machine);
      const attempt = progress?.attempt;
      if (machine === LOCAL && attempt?.outcome === null && !recoverable(attempt, at)) return refuse("busy-local");
      if (machine !== LOCAL && attempt?.outcome === null) {
        if (set.member === null && progress.why === "gone" && attempt.after) continue;
        if (set.member === null && progress.why === "gone" && confirmForget
          && preview.request?.kind === "forget" && preview.request.machine === machine) {
          retired = { machine, at: attempt.at };
          continue;
        }
        if (set.member !== null && set.assign === null && preview.request?.kind === "unpin"
          && preview.request.tool === tool && preview.request.machine === machine) {
          if (!attempt.after) cancel.add(machine);
          continue;
        }
        return refuse("busy");
      }
    }

    const plan = { ...before, rev: base.rev + 1, at, names: { ...before.names } };
    if (retired) {
      const { machine, at } = retired;
      plan.exposures = { ...before.exposures, [machine]: own(before.exposures, machine) ?? at };
    }
    if (preview.request?.kind === "dismiss-exposure") {
      const { machine } = preview.request;
      if (!own(before.exposures, machine)) return refuse("stale");
      plan.exposures = { ...before.exposures };
      delete plan.exposures[machine];
      if (!Object.keys(plan.exposures).length) delete plan.exposures;
    }
    for (const tool of TOOLS) {
      const section = before[tool];
      plan[tool] = { ...section };
      for (const field of [...Object.values(PATCH_FIELDS), "progress"]) {
        if (Object.hasOwn(section, field)) plan[tool][field] = { ...section[field] };
      }
    }
    for (const { tool, machine, set } of patch.entries) {
      const section = plan[tool];
      if (set.member === null) {
        for (const field of [...Object.values(PATCH_FIELDS), "progress"]) {
          if (Object.hasOwn(section, field)) setEntry(section, field, machine, null);
        }
        continue;
      }
      const old = own(section.progress, machine);
      if (tool === "claude" && cancel.has(machine)) {
        setEntry(section, "progress", machine, { ...old, cancel: true, at, tried: null });
        continue;
      }
      let attempt = old?.attempt ?? null;
      const changed = Object.hasOwn(set, "assign") && set.assign !== own(section.assign, machine);
      if (changed || preview.request?.kind === "reapply") attempt = null;
      else if (machine === LOCAL && attempt?.outcome === null) attempt = { ...attempt, outcome: "lost" };
      for (const [field, map] of Object.entries(PATCH_FIELDS)) {
        if (Object.hasOwn(set, field)) setEntry(section, map, machine, set[field]);
      }
      if (set.progress === null) clearProgress(section, tool, machine);
      else if (set.progress) setEntry(section, "progress", machine, {
        ...set.progress, at, tried: null, attempt, read: old?.read ?? null,
      });
      else if (old?.attempt && attempt !== old.attempt) setEntry(section, "progress", machine, { ...old, attempt });
    }
    for (const [tool, edits] of Object.entries(patch.section)) {
      for (const [field, [, next]] of Object.entries(edits)) plan[tool][field] = next;
    }
    for (const [id, [, value]] of Object.entries(patch.names.set)) setEntry(plan, "names", id, value);
    for (const id of Object.keys(patch.names.drop)) setEntry(plan, "names", id, null);
    const checked = parsePlan(JSON.stringify(plan));
    return checked.state === "ok" ? { plan: checked.plan } : refuse("stale");
  } catch {
    return refuse("stale");
  }
}

function updateProgress(plan, tool, machine, update, now, seen) {
  const section = plan[tool];
  const current = own(section.progress, machine);
  if (!own(section.members, machine)) return plan;
  const progress = update(current);
  if (progress === current) return plan;
  return { ...plan, at: now ?? plan.at, [tool]: { ...section,
    ...(seen === undefined ? {} : { seen: { ...section.seen, [machine]: seen } }),
    progress: { ...section.progress, [machine]: progress } } };
}

/** Finish an Unpin after the target fences its outstanding dispatch. */
export function finishUnpin(plan, machine, now) {
  const section = structuredClone(plan.claude);
  for (const field of ["pin", "assign"]) delete section[field][machine];
  clearProgress(section, "claude", machine);
  return { ...plan, claude: section, at: timestamp(now) };
}

/** Persist the observed inputs to a try before the caller lets it write. */
export function startAttempt(plan, tool, machine, {
  rev, number, slot = null, slotDigest = null, before, eff = null, effDigest = null, home, core = null, owner = null, proxy = null, dispatch, now,
}) {
  const at = timestamp(now);
  const assign = own(plan[tool].assign, machine);
  if (!assign) return plan;
  return updateProgress(plan, tool, machine, (progress) => progress?.attempt?.outcome === null ? progress : ({
    ...progress, tried: at, attempt: {
      n: number ?? (progress?.attempt?.n ?? 0) + 1, at, rev, assign, slot, slotDigest, before, eff, effDigest, home,
      core, owner, proxy, intended: null, fencedAt: null, after: null, outcome: null,
      ...(dispatch === undefined ? {} : { dispatch }),
    },
  }), at);
}

/** Record the digest that only this local Codex install is authorized to place. */
export function fence(plan, tool, machine, n, { intended, now }) {
  const at = timestamp(now);
  return updateProgress(plan, tool, machine, (progress) => {
    const attempt = progress?.attempt;
    return tool === "codex" && machine === LOCAL && attempt?.n === n && attempt.outcome === null && !attempt.fencedAt
      ? { ...progress, attempt: { ...attempt, intended, fencedAt: at } } : progress;
  }, at);
}

/** Close an open attempt and keep it for the next read to compare against. */
export function close(plan, tool, machine, n, outcome) {
  return updateProgress(plan, tool, machine, (progress) => {
    const attempt = progress?.attempt;
    return attempt?.n === n && attempt.outcome === null ? { ...progress, attempt: { ...attempt, outcome } } : progress;
  });
}

/** Keep the snapshot that the Claude writer reported, before reading the machine again. */
export function recordAttemptAfter(plan, tool, machine, n, after, now) {
  return updateProgress(plan, tool, machine, (progress) => {
    const attempt = progress?.attempt;
    return attempt?.n === n && attempt.outcome === null
      ? { ...progress, attempt: { ...attempt, after } } : progress;
  }, timestamp(now));
}

/** Record the outcome of a bound read or a pending failure without replacing earlier evidence. */
export function settle(plan, tool, machine, { state, why = null, seen, read, placed, now }) {
  const at = timestamp(now);
  const prev = own(plan[tool].seen, machine);
  let evidence = seen;
  if (tool === "codex" && seen) {
    const attempt = own(plan.codex.progress, machine)?.attempt;
    const installed = state === "done" && placed && read && attempt?.fencedAt
      && attempt.intended === read.generation && placed.generation === read.generation
      && placed.proxy === read.proxy && placed.proxy === attempt.proxy
      && placed.account === read.account && placed.name === attempt.assign;
    evidence = { ...seen, placed: installed ? placed : placed === undefined ? prev?.placed ?? null : null };
  }
  return updateProgress(plan, tool, machine, (progress) => ({
    state, why, at, tried: progress?.tried ?? null, attempt: progress?.attempt ?? null,
    read: read === undefined ? progress?.read ?? null : read,
    ...(progress?.cancel ? { cancel: true } : {}),
  }), at, evidence);
}

/** A changed machine or a gone core waits for a new press. */
export function suspend(plan, tool, machine, why, now) {
  if (own(plan[tool].progress, machine)?.why === why) return plan;
  return settle(plan, tool, machine, { state: "suspended", why, now });
}

/** Record that a retry or drift read was tried, even if it could not get an answer. */
export function markTried(plan, tool, machine, now) {
  const at = timestamp(now);
  return updateProgress(plan, tool, machine, (progress) => progress && { ...progress, tried: at }, at);
}

/** Save only successful, bound reads here. A read alone does not change progress state. */
export function markRead(plan, tool, machine, read, now) {
  const at = timestamp(now);
  return updateProgress(plan, tool, machine, (progress) => progress && { ...progress, read, tried: at }, at);
}
