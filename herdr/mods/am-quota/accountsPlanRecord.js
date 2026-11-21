// The Accounts plan shared by the CLI and the panel. Rebuild records from their listed fields.
export const PLAN_FILE = "accounts-plan.json";
export const PLAN_V = 1;
export const LOCK_FILE = "automagik-herdr/accounts.lock";
export const PREVIEWS_DIR = "automagik-herdr/accounts-previews";
export const REQUESTS_DIR = "data/am-quota/plan-requests";
export const PREVIEW_TTL_MS = 600_000;
export const RETRY_EVERY_MS = 300_000;
export const NO_LOGIN_EVERY_MS = 3_600_000;
export const DRIFT_EVERY_MS = 3_600_000;
export const LOCAL_START_MS = 30_000;
export const LOCAL_CLAIM_MS = 300_000;
export const LOCAL_FENCE_MS = 60_000;

export const LOCAL = "local";
export const TOOLS = Object.freeze(["codex", "claude"]);
export const MODES = Object.freeze(["one", "pinned", "spread"]);
export const PENDING_WHY = Object.freeze(["away", "no-cli", "old-cli", "update-first", "no-login",
  "not-eligible", "conflict", "busy", "lost", "rebound", "no-core", "timeout", "unreachable",
  "bad-answer", "proxy-url", "no-account-id", "failed"]);
export const SUSPENDED_WHY = Object.freeze(["changed", "gone"]);
export const FLAGS = Object.freeze(["unmanaged", "no-login", "not-eligible", "pin-not-eligible",
  "nothing-eligible", "no-pin", "away", "update-first", "unmanaged-home", "routes-differ",
  "suspended-stays", "pinned-stays", "held", "read-again", "one-incomplete", "open-dispatch"]);

const SLOT_STATES = ["eligible", "override", "not-signed-in", "bad-folder", "ambiguous", "timeout", "failed"];
const EFFECTIVE_STATES = [...SLOT_STATES, "unresolved"];
const OUTCOMES = ["done", "failed", "changed", "lost"];
const matches = (shape, value) => typeof value === "string" && shape.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const oneOf = (values) => (value) => values.includes(value);
const nullable = (check) => (value) => value === null || check(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const bool = (value) => typeof value === "boolean";
const slotId = (value) => matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, value);
const ownerId = (value) => matches(/^[a-f0-9]{32}$/, value);
const nameOkay = (value) => matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, value);

function bytesOf(value) {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const isMachine = (value) => matches(/^[^\s\p{Cc}]+$/u, value) && value.length <= 128;
export const isClaudeKey = (value) => matches(/^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}$/u, value)
  && value === value.toLowerCase();
export const isCodexKey = (value) => matches(/^[\x20-\x2e\x30-\x7e]{1,200}$/, value);
export const isHash = (value) => matches(/^[a-f0-9]{64}$/, value);
export const isFingerprint = (value) => matches(/^[a-f0-9]{8}$/, value);
export const isIso = (value) => matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/, value)
  && Number.isFinite(Date.parse(value));
export const isHome = (value) => matches(/^\/[^\p{Cc}]*$/u, value) && bytesOf(value) <= 512;
export const isProxyId = (value) => matches(/^https?:\/\/[^\s@/?#\p{Cc}]+(\/[^\s?#\p{Cc}]*)?$/u, value)
  && bytesOf(value) <= 512;
const snapshot = (value) => value === "none" || isHash(value);

export function snapshotOf(claude) {
  if (claude?.record === "ok" && isHash(claude.snapshot)) return claude.snapshot;
  return claude?.record === "absent" && claude.snapshot === null ? "none" : null;
}

// An unfinished inventory could still contain another login for this account.
export function confirmedClaude(read) {
  if (read?.state !== "eligible" || snapshotOf(read) === null || !read.slotsComplete || !Array.isArray(read.slots)) return null;
  const effective = read.slots.filter(({ id }) => id === read.effective);
  const slot = eligibleClaudeSlot(read, read.email);
  return effective.length === 1 && slot === effective[0] ? read.email : null;
}

export function eligibleClaudeSlot(read, email) {
  if (!isClaudeKey(email) || !read?.slotsComplete || !Array.isArray(read.slots) || read.state === "unresolved"
    || read.slots.some(({ state }) => state === "timeout" || state === "failed")) return null;
  const matching = read.slots.filter((slot) => slot.email === email);
  return matching.length === 1 && matching[0].state === "eligible" ? matching[0] : null;
}

export function codexDrift(read, seen, progress) {
  if (!read || !seen || !progress) return false;
  if (read.home !== seen.home) return true;
  if (progress.state === "done") return isFingerprint(read.account) && read.account !== seen.account;
  if (progress.state !== "pending") return false;
  const attempt = progress.attempt;
  if (attempt?.outcome === null && attempt.fencedAt && read.generation === attempt.intended && read.proxy === attempt.proxy) return false;
  return read.generation !== seen.generation || isFingerprint(read.account) && read.account !== seen.account;
}

export function pendingClaudeDrift(read, seen, attempt, wanted) {
  const snapshot = snapshotOf(read);
  if (snapshot === null) return false;
  const email = confirmedClaude(read);
  if (attempt?.after) return snapshot !== attempt.after || Boolean(email && email !== wanted);
  if (email === wanted) return false;
  const before = attempt ? attempt.after ?? attempt.before : seen?.snapshot;
  const effective = attempt ? attempt.eff : seen?.email;
  return snapshot !== before || Boolean((attempt || effective) && email && email !== effective);
}

// A fresh read of the managed home can show a change before apply saves a suspension.
export function claudeDrift(read, readAt, progress, wanted) {
  const email = confirmedClaude(read);
  return progress?.state === "done" && email && email !== wanted
    && time(readAt) > time(progress.at);
}

// Follow openUrl's spelling for plain URLs. A URL carrying authentication or parameters
// cannot identify a proxy for placement.
export function proxyId(url) {
  if (typeof url !== "string") return null;
  const match = /^(https?):\/\/(\[[^\]/?#]*\]|[^:/?#]+)(:\d+)?([^?#]*)$/i.exec(url.trim());
  if (!match) return null;
  const id = match[1].toLowerCase() + "://" + match[2] + (match[3] ?? "") + match[4].replace(/\/+$/, "");
  return isProxyId(id) ? id : null;
}

export const idDigest = (id, email, sha256Hex) => sha256Hex(id + "\n" + email);

export function cmp(a, b) {
  const right = b[Symbol.iterator]();
  for (const char of a) {
    const next = right.next();
    if (next.done) return 1;
    const delta = char.codePointAt(0) - next.value.codePointAt(0);
    if (delta !== 0) return Math.sign(delta);
  }
  return right.next().done ? 0 : -1;
}

export const compareMachines = (a, b) => a === b ? 0 : a === LOCAL ? -1 : b === LOCAL ? 1 : cmp(a, b);
export const machineOrder = (ids) => [...ids].sort(compareMachines);

// Maps are keyed by core id. A core name such as "constructor" is just a key.
export const own = (map, key) => map && Object.hasOwn(map, key) ? map[key] : null;

// The active record can name an account but cannot establish the origin of its grant.
export function observedCodex(current, active, placed) {
  if (!isFingerprint(current?.account)) return null;
  if (placed && placed.proxy === current.proxy && placed.account === current.account) return placed.name;
  return active?.fingerprint === current.account ? active.name : null;
}

function need(check, value) {
  if (!check(value)) throw new Error("corrupt");
  return value;
}

function fields(value, checks) {
  need(object, value);
  return Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, need(check, value[key])]));
}

function mapOf(value, build, keyCheck = isMachine) {
  need(object, value);
  return Object.fromEntries(machineOrder(Object.keys(value)).map((key) => [need(keyCheck, key), build(value[key], key)]));
}

const memberFields = { since: isIso, home: isHome };
const codexFields = { home: isHome, account: nullable(isFingerprint), generation: nullable(isHash), proxy: nullable(isProxyId) };
const placedFields = { name: isCodexKey, proxy: isProxyId, account: isFingerprint, generation: isHash, at: isIso };
const claudeFields = { home: isHome, snapshot, email: nullable(isClaudeKey) };

export function parseRead(value, tool, machine) {
  if (value === null) return null;
  if (tool === "codex") return fields(value, { at: isIso, account: codexFields.account, generation: codexFields.generation,
    home: isHome, proxy: codexFields.proxy });
  const read = fields(value, { at: isIso, core: machine === LOCAL ? nullable(isMachine) : (id) => id === machine,
    home: isHome, record: oneOf(["ok", "absent", "bad"]), snapshot: nullable(isHash),
    selected: slotId, effective: slotId, email: nullable(isClaudeKey), state: oneOf(EFFECTIVE_STATES),
    slots: Array.isArray, slotsComplete: bool, nextSlot: nullable(isHome) });
  read.slots = read.slots.map((slot) => fields(slot, { id: slotId, email: nullable(isClaudeKey), state: oneOf(SLOT_STATES) }));
  return read;
}

function parseAttempt(value, tool, machine, keyCheck) {
  if (value === null) return null;
  const claude = tool === "claude";
  const attempt = fields(value, {
    n: (n) => count(n) && n > 0, at: isIso, rev: count, assign: keyCheck,
    slot: claude ? slotId : oneOf([null]), slotDigest: claude ? isHash : oneOf([null]),
    before: claude ? snapshot : nullable(isHash), eff: claude ? nullable(isClaudeKey) : oneOf([null]),
    effDigest: claude ? isHash : oneOf([null]), home: isHome,
    core: machine === LOCAL ? oneOf([null]) : (id) => id === machine,
    owner: machine === LOCAL ? ownerId : oneOf([null]), proxy: claude ? oneOf([null]) : isProxyId,
    intended: claude ? oneOf([null]) : nullable(isHash), fencedAt: claude ? oneOf([null]) : nullable(isIso),
    after: claude ? nullable(isHash) : oneOf([null]), outcome: nullable(oneOf(OUTCOMES)),
  });
  if ((attempt.intended === null) !== (attempt.fencedAt === null)) throw new Error("corrupt");
  if (Object.hasOwn(value, "dispatch")) {
    need(claude && machine !== LOCAL ? ownerId : () => false, value.dispatch);
    attempt.dispatch = value.dispatch;
  }
  if (Object.hasOwn(value, "installStarted")) {
    need((v) => !claude && machine === LOCAL && attempt.fencedAt !== null && v === true, value.installStarted);
    attempt.installStarted = true;
  }
  return attempt;
}

function parseProgress(value, tool, machine, keyCheck) {
  if (tool === "claude" && object(value) && Object.keys(value).length === 1 && object(value.read)) {
    return { read: parseRead(value.read, tool, machine) };
  }
  const progress = fields(value, {
    state: oneOf(["pending", "done", "suspended"]), why: nullable(oneOf([...PENDING_WHY, ...SUSPENDED_WHY])),
    at: isIso, tried: nullable(isIso), attempt: nullable(object), read: nullable(object),
  });
  const reasons = progress.state === "pending" ? [null, ...PENDING_WHY]
    : progress.state === "suspended" ? SUSPENDED_WHY : [null];
  need(oneOf(reasons), progress.why);
  if (machine === LOCAL && progress.why === "gone") throw new Error("corrupt");
  progress.attempt = parseAttempt(progress.attempt, tool, machine, keyCheck);
  progress.read = parseRead(progress.read, tool, machine);
  if (Object.hasOwn(value, "cancel")) {
    need((cancel) => cancel === true && tool === "claude" && machine !== LOCAL
      && progress.attempt?.outcome === null && progress.attempt.after === null, value.cancel);
    progress.cancel = true;
  }
  return progress;
}

function parseSeen(value, tool) {
  if (tool === "claude") return fields(value, claudeFields);
  const seen = fields(value, { ...codexFields, placed: nullable(object) });
  if (seen.placed) seen.placed = fields(seen.placed, placedFields);
  return seen;
}

const maps = ["pin", "assign", "members", "seen", "progress"];

function parseSection(value, tool, rev) {
  const codex = tool === "codex";
  const keyCheck = codex ? isCodexKey : isClaudeKey;
  const section = fields(value, { mode: oneOf(MODES), account: nullable(keyCheck) });
  if (section.mode === "one") need(keyCheck, section.account);
  section.pin = mapOf(value.pin, (key) => need(keyCheck, key));
  if (codex) section.machines = need((list) => Array.isArray(list) && list.length === 0, value.machines);
  section.assign = mapOf(value.assign, (key) => need(keyCheck, key));
  section.members = mapOf(value.members, (m) => fields(m, memberFields));
  section.seen = mapOf(value.seen, (s) => parseSeen(s, tool));
  if (!codex) section.secondLogin = mapOf(value.secondLogin, (allow) => need(oneOf([true]), allow));
  section.progress = mapOf(value.progress, (p, machine) => parseProgress(p, tool, machine, keyCheck));
  for (const key of maps.filter((key) => key !== "members")) {
    for (const machine of Object.keys(section[key])) {
      if (!own(section.members, machine)) throw new Error("corrupt");
    }
  }
  for (const [machine, assignment] of Object.entries(section.assign)) {
    const progress = own(section.progress, machine);
    if (!own(section.seen, machine) || !progress?.state) throw new Error("corrupt");
    const { attempt } = progress;
    if (attempt && (attempt.assign !== assignment || attempt.rev > rev)) throw new Error("corrupt");
  }
  for (const [machine, member] of Object.entries(section.members)) {
    const progress = own(section.progress, machine), seen = own(section.seen, machine);
    if ((progress?.attempt || progress?.state === "done") && !own(section.assign, machine)) throw new Error("corrupt");
    if (!codex && [seen, progress?.read, progress?.attempt].some((evidence) => evidence && evidence.home !== member.home)) {
      throw new Error("corrupt");
    }
  }
  return section;
}

function linkedCodex(section) {
  const linked = (id) => isMachine(id) && id !== LOCAL;
  return (Array.isArray(section?.machines) && section.machines.some(linked))
    || maps.some((key) => object(section?.[key]) && Object.keys(section[key]).some(linked));
}

export function parsePlan(text) {
  if (text === null) return { state: "absent", plan: null };
  try {
    const value = JSON.parse(text);
    if (Number.isInteger(value?.v) && (value.v > PLAN_V || value.v === PLAN_V && linkedCodex(value.codex))) {
      return { state: "newer", plan: null };
    }
    const plan = fields(value, { v: oneOf([PLAN_V]), rev: count, at: isIso });
    plan.names = mapOf(value.names, (name) => need(nameOkay, name), (id) => isMachine(id) && id !== LOCAL);
    if (Object.hasOwn(value, "exposures")) {
      plan.exposures = mapOf(value.exposures, (at) => need(isIso, at), (id) => isMachine(id) && id !== LOCAL);
    }
    for (const tool of TOOLS) plan[tool] = parseSection(value[tool], tool, plan.rev);
    return { state: "ok", plan };
  } catch {
    return { state: "corrupt", plan: null };
  }
}

export function emptyPlan(now) {
  const section = (tool) => ({ mode: "pinned", account: null, pin: {},
    ...(tool === "codex" ? { machines: [] } : {}), assign: {}, members: {}, seen: {},
    ...(tool === "claude" ? { secondLogin: {} } : {}), progress: {} });
  return { v: PLAN_V, rev: 0, at: now, names: {}, codex: section("codex"), claude: section("claude") };
}

// Rebuild valid records in file order, including the order of maps keyed by machine.
export function planText(plan) {
  const parsed = parsePlan(JSON.stringify(plan));
  if (parsed.state !== "ok") throw new Error("corrupt");
  return JSON.stringify(parsed.plan, null, 2) + "\n";
}

export function entryDigest(plan, tool, machine, sha256Hex) {
  const section = plan?.[tool];
  const progress = own(section?.progress, machine);
  const member = own(section?.members, machine), seen = own(section?.seen, machine);
  const entry = {
    member: member ? fields(member, memberFields) : null, assign: own(section?.assign, machine),
    pin: own(section?.pin, machine), seen: seen ? parseSeen(seen, tool) : null,
  };
  if (tool === "claude") entry.secondLogin = own(section?.secondLogin, machine);
  if (progress) {
    const { tried, ...rest } = parseProgress(progress, tool, machine, tool === "claude" ? isClaudeKey : isCodexKey);
    entry.progress = rest;
  } else {
    entry.progress = null;
  }
  return sha256Hex(JSON.stringify(entry, null, 2) + "\n");
}

export function claudeMember(plan, core) {
  const member = own(plan?.claude?.members, core);
  return member ? { home: member.home } : null;
}

// A project whose launch settings have an exception keeps its own route.
export const routeManaged = (why) => why == null;
const time = (value) => isIso(value) ? Date.parse(value) : -Infinity;
const millis = (now) => typeof now === "number" ? now : Date.parse(now);

// Both previews and rows can use this selector. A failed newer fleet attempt hides an old read
// as current, while the old observation stays available for display.
export function newest(entry, progress, core, tool = "claude") {
  const bound = core === LOCAL ? isMachine(entry?.core) : entry?.core === core;
  const fleetRead = bound ? entry[tool] : null;
  const applyRead = tool === "codex" || core === LOCAL || progress?.read?.core === core ? progress?.read : null;
  const useApply = Boolean(applyRead && time(applyRead.at) > time(fleetRead?.readAt));
  const read = useApply ? applyRead : fleetRead ?? null;
  const readAt = useApply ? applyRead.at : fleetRead?.readAt ?? null;
  const failure = entry && entry.state !== "read" && time(entry.at) > time(readAt) ? entry.state : null;
  return { read, readAt, from: useApply ? "apply" : "fleet", failure };
}

export function openDispatch(progress) {
  const attempt = progress?.attempt;
  return attempt?.outcome === null && !attempt.after ? attempt : null;
}

export function linkedDue(plan, { now, retry, fleet, members }) {
  const section = plan?.claude;
  if (!section) return [];
  const connected = new Set(members?.filter((member) => member.connected).map((member) => member.id));
  const due = machineOrder(Object.keys(section.members)).filter((machine) => {
    if (machine === LOCAL || !own(section.assign, machine)) return false;
    const progress = own(section.progress, machine);
    if (!progress) return false;
    const elapsed = millis(now) - time(progress.tried);
    if (progress.cancel) return !retry || elapsed >= RETRY_EVERY_MS;
    if (progress.why === "gone" && openDispatch(progress)?.dispatch && connected.has(machine)) {
      return !retry || elapsed >= RETRY_EVERY_MS;
    }
    if (progress.state === "suspended") return false;
    if (progress.state === "pending") {
      if (progress.why === "no-login") return elapsed >= NO_LOGIN_EVERY_MS;
      return !retry || elapsed >= RETRY_EVERY_MS;
    }
    if (elapsed >= DRIFT_EVERY_MS) return true;
    const entry = own(fleet?.machines, machine);
    const readAt = time(entry?.claude?.readAt);
    return entry?.state === "read" && entry.core === machine && isClaudeKey(entry.claude?.email)
      && entry.claude.email !== section.assign[machine] && readAt > Math.max(time(progress.at), time(progress.read?.at));
  });
  return due.map((machine) => ({ tool: "claude", machine }));
}

const open = (attempt) => attempt?.outcome === null;
const fenced = (attempt, now) => millis(now) - time(attempt.fencedAt) < LOCAL_FENCE_MS;

export function recoverable(attempt, now) {
  return open(attempt) && millis(now) - time(attempt.at) >= LOCAL_CLAIM_MS && !fenced(attempt, now);
}

export function localDue(plan, tool, now, owner) {
  const progress = own(plan?.[tool]?.progress, LOCAL);
  if (progress?.state !== "pending" || !own(plan[tool].assign, LOCAL)) return null;
  const { attempt } = progress;
  if (!open(attempt)) return "apply";
  if (fenced(attempt, now)) return "wait";
  return attempt.owner === owner || recoverable(attempt, now) ? "read-back" : "wait";
}
