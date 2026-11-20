// The account answers and observations shared by the CLI and Accounts panel.
export const FLEET_FILE = "data/am-quota/fleet.json";
export const FLEET_V = 1;
export const CHANGED_MS = 24 * 3600_000;
export const HERE_V = 1;
export const HERE_KIND = "accounts.here";
export const HERE_MAX_BYTES = 65536;
export const REASONS = Object.freeze(["no-cli", "old-cli", "unreachable", "timeout", "bad-answer", "failed"]);
export const CODEX_CODES = Object.freeze(["unreadable", "no-account-id"]);
export const SLOT_CODES = Object.freeze(["override", "not-signed-in", "bad-folder", "ambiguous", "timeout", "failed"]);
export const ROUTE_CODES = Object.freeze(["not-signed-in", "timeout", "failed", "unresolved"]);
export const STATES = Object.freeze(["observed", "changed", "no-login", "none", "away", "failed", "unknown"]);
export const HERE = Object.freeze(["same", "other", "none"]);
export const NOT_READ = "not-read";

export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const BOT_ID = /^(b-[a-z2-7]{10}|session-[A-Za-z0-9._-]+)$/;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TERMINAL = /^[A-Za-z0-9._-]+$/;
export const REFRESH = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:?\d\d)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}$/u;
const HASH = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^[a-f0-9]{8}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const PANEL = ["on", "off", "absent"];
const RECORD = ["ok", "absent", "bad"];
const ENTRY_STATES = ["read", "away", "failed", "unknown"];
const WHY = ["own-app-home", "own-path", "unread"];
export const noExceptions = () => ({ bound: [], list: [], more: 0 });

export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const matches = (shape, value) => typeof value === "string" && shape.test(value);
export const versionOkay = (value) => matches(VERSION, value) && value.length <= 64;
export const coreOkay = (value) => typeof value === "string" && value.length > 0 && !/[\s\p{Cc}]/u.test(value);
export const barName = (value, id) => matches(/^[\x20-\x7e]{1,64}$/, value) ? value : id;
export const timeOkay = (value) => matches(ISO, value) && Number.isFinite(Date.parse(value));
export const countOkay = (value) => Number.isSafeInteger(value) && value >= 0;

// hc machine ls reports a connection state. Allow the boolean form when supplied,
// and leave invalid entries visible to the completeness check.
export function machineList(r, nameShape = NAME) {
  if (r?.code !== 0) return null;
  let entries;
  try { entries = JSON.parse(r.stdout)?.machines; } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const candidates = entries.filter((m) => m?.temporary !== true);
  const ids = new Map(), names = new Map();
  for (const m of candidates) {
    ids.set(m?.id, (ids.get(m?.id) ?? 0) + 1);
    names.set(m?.name, (names.get(m?.name) ?? 0) + 1);
  }
  const connected = (m) => Object.hasOwn(m, "connected") ? m.connected
    : m.state === "connected" ? true : m.state === "disconnected" ? false : null;
  const list = candidates.filter((m) => coreOkay(m?.id) && m.id !== "local" && matches(nameShape, m.name)
    && (!Object.hasOwn(m, "temporary") || m.temporary === false)
    && typeof connected(m) === "boolean" && ids.get(m.id) === 1 && names.get(m.name) === 1)
    .map((m) => ({ id: m.id, name: m.name, connected: connected(m) }));
  return { list, complete: list.length === candidates.length };
}

export function bytesOf(text) {
  let bytes = 0;
  for (const c of text) {
    const n = c.codePointAt(0);
    bytes += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const pathOkay = (value) => typeof value === "string" && value.startsWith("/")
  && !/\p{Cc}/u.test(value) && bytesOf(value) <= 512;

/** The same account-id fingerprint the local Codex card uses. */
export function fingerprint(value) {
  const s = typeof value === "string" ? value : "";
  if (!s) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function accountFingerprint(text) {
  let id;
  try { id = JSON.parse(text)?.tokens?.account_id; } catch { return null; }
  return fingerprint(typeof id === "string" ? id.trim() : null);
}

// Rebuild a wire answer from the listed fields. At the source, an invalid optional value may
// be dropped and a broken tool left out. A received answer must already have the right shape.
export function checkHere(answer, { source = false } = {}) {
  if (!object(answer) || answer.v !== HERE_V || answer.kind !== HERE_KIND) return null;
  let invalid = false;
  const need = (test, value) => {
    if (test(value)) return value;
    invalid = true;
    return null;
  };
  const optional = (test, value) => value === null || source && !test(value) ? null : need(test, value);
  const one = (choices) => (value) => choices.includes(value);
  const id = (value) => matches(ID, value);
  const email = (value) => optional((e) => matches(EMAIL, e) && matches(EMAIL, e.toLowerCase()), value)?.toLowerCase() ?? null;
  const hash = (value) => optional((h) => matches(HASH, h), value);
  const accountId = (value) => optional((f) => matches(FINGERPRINT, f), value);
  const slotCode = one(["eligible", ...SLOT_CODES]);
  const effectiveCode = one(["eligible", ...SLOT_CODES, "unresolved"]);
  const routeCode = one(["eligible", ...ROUTE_CODES]);
  const bool = (value) => typeof value === "boolean";
  const record = (value, build) => need(object, value) ? build(value) : null;
  const array = (value, build) => need(Array.isArray, value) ? value.map(build) : [];
  const tool = (value, build) => {
    if (value === null) return null;
    const prior = invalid;
    invalid = false;
    const result = record(value, build);
    const bad = invalid;
    invalid = prior || (!source && bad);
    return bad ? null : result;
  };
  const versions = record(answer.versions, (v) => ({ pack: optional(versionOkay, v.pack), am: optional(versionOkay, v.am) }));
  const panel = need(one(PANEL), answer.panel);
  const codex = tool(answer.codex, (c) => ({
    home: need(pathOkay, c.home),
    from: need(one(["env", "default"]), c.from),
    file: need(one(["absent", "unreadable", "present"]), c.file),
    account: accountId(c.account),
    accountId: need(one(["present", "absent"]), c.accountId),
    lastRefresh: optional((t) => matches(REFRESH, t), c.lastRefresh),
    generation: hash(c.generation),
  }));
  const route = (value) => record(value, (r) => {
    const address = email(r.email);
    const state = need(routeCode, r.state);
    return { email: state === "eligible" ? address : null, state: source && state === "eligible" && !address ? "failed" : state };
  });
  const claude = tool(answer.claude, (c) => {
    const slots = array(c.slots, (value) => record(value, (s) => {
      const address = email(s.email);
      const state = need(slotCode, s.state);
      return { id: need(id, s.id), dir: optional(pathOkay, s.dir), email: address,
        state: source && state === "eligible" && !address ? "failed" : state };
    }));
    const routes = record(c.routes, (r) => ({ record: route(r.record), bare: route(r.bare) }));
    const state = need(effectiveCode, c.state);
    const address = email(c.email);
    const complete = need(bool, c.slotsComplete);
    need(bool, c.routesDiffer);
    // A record route nobody probed (the machine's own launcher) names no effective account,
    // whatever the answer says; the slots stay.
    const unprobed = routes?.record?.state === "unresolved";
    return {
      record: need(one(RECORD), c.record), snapshot: hash(c.snapshot), selected: need(id, c.selected),
      effective: need(id, c.effective), slots, slotsComplete: complete && (!source || !slots.some((s) => s?.state === "failed")),
      email: unprobed ? null : address,
      state: unprobed ? "unresolved" : source && state === "eligible" && !address ? "failed" : state,
      routes, routesDiffer: Boolean(routes?.record?.email && routes?.bare?.email && routes.record.email !== routes.bare.email),
    };
  });
  const exception = (value) => record(value, (e) => ({ project: need(pathOkay, e.project), why: need(one(WHY), e.why) }));
  const exceptions = record(answer.exceptions, (e) => ({
    bound: array(e.bound, exception), list: array(e.list, exception), more: need(countOkay, e.more),
  }));
  return invalid ? null : { v: HERE_V, kind: HERE_KIND, versions, panel, codex, claude, exceptions };
}

export function nextObs(tool, prev, read, at) {
  if (!read) return null;
  const key = tool === "codex" ? "account" : "email";
  const previous = tool === "codex" ? "prevAccount" : "prevEmail";
  const changed = prev?.[key] && read[key] && prev[key] !== read[key];
  const observation = { ...read, readAt: at, [previous]: changed ? prev[key] : prev?.[previous] ?? null,
    changedAt: changed ? at : prev?.changedAt ?? null };
  if (tool === "claude") observation.slots = read.slots.map(({ id, email, state }) => ({ id, email, state }));
  return observation;
}

function fleetEntry(entry, core) {
  if (!object(entry) || !timeOkay(entry.at) || !ENTRY_STATES.includes(entry.state)
    || (core === "local" ? entry.name !== null : !matches(NAME, entry.name))
    || !(entry.reason === null || REASONS.includes(entry.reason)) || ![null, "pack", "am"].includes(entry.cli)
    || !(entry.panel === null || PANEL.includes(entry.panel))) return null;
  const { name, at, state, reason, cli, panel } = entry;
  const checked = checkHere({ ...entry, v: HERE_V, kind: HERE_KIND, panel: panel ?? "absent",
    claude: Array.isArray(entry.claude?.slots) ? { ...entry.claude, slots: entry.claude.slots.map((s) => ({ ...s, dir: null })) } : entry.claude });
  if (!checked) return null;
  const stored = (key, previous, shape) => {
    const raw = entry[key];
    if (raw === null) return null;
    if (!object(raw) || !timeOkay(raw.readAt) || !(raw.changedAt === null || timeOkay(raw.changedAt))
      || !(raw[previous] === null || matches(shape, raw[previous]))) return undefined;
    return { ...nextObs(key, null, checked[key], raw.readAt), [previous]: raw[previous], changedAt: raw.changedAt };
  };
  const codex = stored("codex", "prevAccount", FINGERPRINT);
  const claude = stored("claude", "prevEmail", EMAIL);
  if (codex === undefined || claude === undefined) return null;
  return { name, at, state, reason, cli, versions: checked.versions, panel, codex, claude, exceptions: checked.exceptions };
}

export function parseFleet(text) {
  const empty = { v: FLEET_V, at: null, linked: null, machines: {} };
  let data;
  try { data = JSON.parse(text); } catch { return empty; }
  if (!object(data) || data.v !== FLEET_V || !timeOkay(data.at) || !object(data.machines)) return empty;
  const machines = Object.fromEntries(Object.entries(data.machines).flatMap(([core, value]) => {
    const entry = coreOkay(core) && fleetEntry(value, core);
    return entry ? [[core, entry]] : [];
  }));
  const linked = data.linked?.reason === "failed" && timeOkay(data.linked.at) ? { at: data.linked.at, reason: "failed" } : null;
  return { v: FLEET_V, at: data.at, linked, machines };
}

export function rowFor(tool, entry, ref, now) {
  const obs = entry?.[tool];
  const codex = tool === "codex";
  const wanted = codex ? ref?.fingerprint : ref?.email;
  const account = (codex ? obs?.account : obs?.email) ?? null;
  const here = account === null ? null : !wanted ? "none" : account === wanted ? "same" : "other";
  const row = (state, code = null) => ({ state, code, account, here, grant: codex ? "unknown" : null });
  if (!entry) return row("unknown", NOT_READ);
  if (entry.state !== "read") return row(entry.state, entry.reason);
  if (!obs) return row("unknown", "failed");
  if (codex) {
    if (obs.file === "absent") return row("none");
    if (obs.file === "unreadable") return row("unknown", "unreadable");
    if (obs.accountId === "absent") return row("unknown", "no-account-id");
  } else {
    if (obs.state !== "eligible") return row("unknown", obs.state === "unresolved" ? "own-launcher" : obs.state);
    if (!account) return row("unknown", "failed");
  }
  if (obs.changedAt && now - Date.parse(obs.changedAt) < CHANGED_MS) return row("changed");
  if (!codex && here === "other" && !obs.slots.some((s) => s.email === wanted)) {
    if (obs.slotsComplete) return row("no-login");
    return row("unknown", obs.slots.some((s) => s.state === "timeout") ? "timeout" : "failed");
  }
  return row("observed");
}
