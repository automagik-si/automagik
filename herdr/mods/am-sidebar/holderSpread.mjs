// #1432 item 3: which hc core ("holder") a new agent's pane starts on, so one holder's loss
// cannot take every seat of a team.
//
// A holder is an hc session's core: the local one (`local`, the `HC_SESSION` the pack already
// talks to) or another local session the lead added with `am holders add --local <name>`, which
// `hc machine add` exposes as a linked machine on this host. A loss of one core's holder ends
// every pane it held (herdr-core's holder sweeps its terminals), so the pack puts new starts on
// the holder with the fewest of its agents, under a per-holder limit.
//
// The default is conservative: one holder, `local`, exactly as before this change; nothing is
// spread and no core is started until the lead adds a holder. The limit's default (6) is
// documented in README. Pure: no `herdr`, no `node:` import, so the CLI and the tests share it.
// Apache-2.0.

import { attachKey } from "./attach.js";

/** The holder pool's file under the app home (beside the attach and workers ledgers). */
export const HOLDERS_FILE = "automagik-herdr/holders.json";
/** The one holder before the lead adds another: this computer's own hc core. */
export const LOCAL_HOLDER = "local";
/** A conservative default: a holder loss ends at most this many pack agents before the pack spreads. */
export const DEFAULT_HOLDER_LIMIT = 6;
/** The largest limit a config may set (a typo can't turn the limit off). */
export const MAX_HOLDER_LIMIT = 64;
/** A holder's name: an hc machine name's shape, `local` reserved for this computer. */
export const HOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const localHolder = () => ({ name: LOCAL_HOLDER, machine: null, session: null });

/** Why `name` can't be a holder name, or null. */
export function holderNameProblem(name, holders = []) {
  if (typeof name !== "string" || !HOLDER_NAME.test(name)) {
    return `"${String(name)}" isn't a holder name: 1-32 of a-z 0-9 _ -, starting with a letter or digit`;
  }
  if (name === LOCAL_HOLDER) return `${LOCAL_HOLDER} is this computer's own holder; it is always in the pool`;
  if (holders.some((h) => h.name === name)) return `${name} is already a holder`;
  return null;
}

/**
 * The config a file (or its absence) yields: { limit, holders, warnings }. `text` null is the
 * default (one local holder); bad JSON or a bad field is said in `warnings` and replaced by its
 * default, never silently reinterpreted. Every pool starts with `local`, unique names only.
 */
export function parseHolders(text, { strict = false } = {}) {
  const warnings = [];
  const config = { limit: DEFAULT_HOLDER_LIMIT, holders: [localHolder()] };
  if (text === null || text === undefined || (!strict && String(text).trim() === "")) return { ...config, warnings };
  let raw;
  try { raw = JSON.parse(String(text)); } catch (e) {
    return { ...config, warnings: [`holders: the file isn't JSON (${String(e?.message ?? e).split("\n")[0]}); using one local holder`] };
  }
  if (!isObject(raw)) return { ...config, warnings: ["holders: the file isn't an object; using one local holder"] };
  if (strict && raw.holders !== undefined && !Array.isArray(raw.holders)) {
    warnings.push("holders: the holder list isn't an array; using one local holder");
  }
  if (raw.limit !== undefined) {
    const n = typeof raw.limit === "string" && raw.limit.trim() !== "" ? Number(raw.limit) : raw.limit;
    if (Number.isSafeInteger(n) && n >= 1 && n <= MAX_HOLDER_LIMIT) config.limit = n;
    else warnings.push(`holders: limit ${JSON.stringify(raw.limit)} isn't a whole number from 1 to ${MAX_HOLDER_LIMIT}; using ${DEFAULT_HOLDER_LIMIT}`);
  }
  const seen = new Set([LOCAL_HOLDER]);
  for (const entry of Array.isArray(raw.holders) ? raw.holders : []) {
    const held = typeof entry === "string" ? { name: entry } : entry;
    if (!isObject(held) || typeof held.name !== "string") { warnings.push(`holders: ${JSON.stringify(entry)} isn't a holder; left out`); continue; }
    const { name } = held;
    if (name === LOCAL_HOLDER) continue; // local is always first, whatever the file says
    if (!HOLDER_NAME.test(name) || seen.has(name)) {
      warnings.push(`holders: ${JSON.stringify(name)} isn't a usable holder name here; left out`);
      continue;
    }
    const machine = typeof held.machine === "string" && held.machine ? held.machine : name;
    if (!HOLDER_NAME.test(machine)) { warnings.push(`holders: ${name}'s machine ${JSON.stringify(held.machine)} isn't a machine name; left out`); continue; }
    const session = typeof held.session === "string" && held.session ? held.session : null;
    if (strict && held.session != null && (session === null || !/^[A-Za-z0-9._-]+$/.test(session)
        || [".", "..", "default"].includes(session))) {
      warnings.push(`holders: ${name}'s session isn't an extra holder session; left out`);
      continue;
    }
    seen.add(name);
    config.holders.push({ name, machine, session });
  }
  return { ...config, warnings };
}

/** The config as the file's text (the shape parseHolders reads), holders in order. */
export function holdersText(config) {
  const clean = parseHolders(JSON.stringify({ limit: config?.limit, holders: config?.holders ?? [] }));
  return `${JSON.stringify({ v: 1, limit: clean.limit, holders: clean.holders.filter((h) => h.name !== LOCAL_HOLDER) }, null, 2)}\n`;
}

/**
 * The pool as rows for `am holders`: { name, machine, session, local, limit, count, connected,
 * atLimit, overLimit }. `counts` maps holder name -> live pack agents; `connected` maps holder
 * name -> whether its hc core answers now (local always true). One meaning for the budget in
 * both this function and `chooseHolder`: `atLimit` is `count >= limit` (the holder is full), and
 * `overLimit` is `count > limit` (strictly above it), for the wording only.
 */
export function holderRows({ config, counts = new Map(), connected = new Map() } = {}) {
  const limit = config?.limit ?? DEFAULT_HOLDER_LIMIT;
  return (config?.holders ?? [localHolder()]).map((h) => {
    const count = counts.get(h.name) ?? 0;
    return { ...h, local: h.name === LOCAL_HOLDER, limit, count,
      connected: h.name === LOCAL_HOLDER ? true : connected.get(h.name) !== false,
      atLimit: count >= limit, overLimit: count > limit };
  });
}

/**
 * The holder a new agent's pane starts on: the one with the fewest pack agents, the pool's
 * order deciding a tie (so two counts at 0 spread in turn). With every holder full (at its
 * `limit`), the least loaded takes it anyway (`atLimit: true`): a start is never refused for
 * the budget, and the pack says so. `holder` names one explicitly; an unknown name is a usage
 * problem (`error`), and a full one still wins when named. `connected: false` holders are left
 * out unless every holder is. `reserved` maps holder name -> starts already chosen but whose
 * attach row isn't written yet; it is added to `counts`, so two starts in flight cannot both
 * pick the same holder.
 */
export function chooseHolder({ config, counts = new Map(), connected = new Map(), holder = undefined, reserved = new Map() } = {}) {
  const load = new Map((config?.holders ?? [localHolder()]).map((h) => [h.name, (counts.get(h.name) ?? 0) + (reserved.get(h.name) ?? 0)]));
  const rows = holderRows({ config, counts: load, connected });
  if (holder !== undefined) {
    const named = rows.find((r) => r.name === holder);
    if (!named) return { error: `no holder "${holder}" (am holders lists them)` };
    return { name: named.name, machine: named.machine, local: named.local, count: named.count,
      connected: named.connected, atLimit: named.atLimit, overLimit: named.overLimit };
  }
  const usable = rows.filter((r) => r.connected);
  const pool = usable.length ? usable : rows;
  const pick = pool.reduce((best, row) => {
    if (!best) return row;
    if (row.count !== best.count) return row.count < best.count ? row : best;
    return best; // a tie keeps the earlier holder, the pool's own order
  }, null);
  if (!pick) return { error: "the holder pool is empty" };
  return { name: pick.name, machine: pick.machine, local: pick.local, count: pick.count,
    connected: pick.connected, atLimit: pick.atLimit, overLimit: pick.overLimit };
}

/**
 * #1432 item 3's guarantee, as a property the tests hold: with `counts` over a pool of at
 * least two holders and at least `limit` agents in one of them, the least-loaded rule never
 * leaves every agent in one holder once there are more agents than one holder's limit. Returns
 * the holders in use and the largest count, for a report or a test.
 */
export function spreadSummary({ config, counts = new Map() } = {}) {
  const rows = holderRows({ config, counts });
  const used = rows.filter((r) => r.count > 0);
  return { holders: rows.length, used: used.map((r) => r.name), total: rows.reduce((n, r) => n + r.count, 0),
    largest: rows.reduce((n, r) => Math.max(n, r.count), 0), limit: rows[0]?.limit ?? DEFAULT_HOLDER_LIMIT };
}

/** A holder's name, its bots and optional seat identities. Never a path, socket, address or environment value. */
export function lossEvent({ at = new Date().toISOString(), holder = LOCAL_HOLDER, agents = [], reason = "holder_lost", seats } = {}) {
  const ids = [...new Set((agents ?? []).map((a) => (typeof a === "string" ? a : a?.bot)).filter((x) => typeof x === "string" && x))].sort();
  const event = { v: 1, at: String(at), holder: String(holder || LOCAL_HOLDER), reason: String(reason), agents: ids };
  if (seats) {
    event.seats = seats.map(({ bot, core, terminal, created_ms, machine, identity }) => ({
      bot, core, terminal, created_ms, machine: machine ?? null, ...(identity === "uncertain" ? { identity } : {}),
    })).sort((a, b) => a.bot.localeCompare(b.bot) || a.terminal.localeCompare(b.terminal));
  }
  return event;
}

/** A seat keeps its identity across observations. Older records can only be compared by their summaries. */
export function sameLoss(a, b) {
  if (!a || !b) return false;
  if (Array.isArray(a.seats) && Array.isArray(b.seats)) {
    const keys = (event) => JSON.stringify([...new Set(event.seats.map(attachKey))].sort());
    return keys(a) === keys(b);
  }
  return a.holder === b.holder && a.reason === b.reason && a.at === b.at
    && JSON.stringify(a.agents ?? []) === JSON.stringify(b.agents ?? []);
}

/** A loss record's one line for people: `holder lost: 3 agents in holder "local" (a, b, c) at …`. */
export function lossLine(event) {
  const what = event.reason === "holder_unreachable" ? "holder unreachable" : "holder lost";
  const agents = Array.isArray(event.agents) ? event.agents : [];
  const names = agents.length > 6 ? `${agents.slice(0, 6).join(", ")}, +${agents.length - 6}` : agents.join(", ");
  return `${what}: ${agents.length} ${agents.length === 1 ? "agent" : "agents"} in holder "${event.holder}"${names ? ` (${names})` : ""}`;
}

// #1432: the read-only cut-off check, independent of the attach view and revive.
export const CUT_OFF_REASONS = {
  platform: "process table not readable on this system",
  proc: "process table could not be read",
  time: "the check did not finish in time",
  pool: "the pool file could not be read",
  custom: "a custom core socket is set",
  socket: "a core socket could not be determined",
  answer: "its core did not answer",
  ambiguous: "pool membership is ambiguous",
  old: "its core does not list its holder processes",
  list: "its core gave an unreadable holder list",
  changed: "its core changed between the reads",
};

const positivePid = (n) => Number.isSafeInteger(n) && n > 0;
export const liveProc = ({ state }) => state !== "Z" && state !== "X" && state !== "x";

export function parseProcStat(text, pid) {
  // The process name can contain spaces, newlines and closing parentheses.
  const end = text.lastIndexOf(")");
  if (end < 0 || !text.startsWith(`${pid} (`)) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const [state, parent] = fields;
  const starttime = fields[19], ppid = Number(parent);
  if (!/^[RSDZTtWXxKPI]$/.test(state) || !/^\d+$/.test(parent ?? "") ||
      !Number.isSafeInteger(ppid) || !/^\d+$/.test(starttime ?? "") ||
      fields.slice(2, 19).some((field) => !/^-?\d+$/.test(field))) return null;
  return { state, ppid, starttime };
}

export function parseProcStatus(text) {
  const match = /^Uid:[ \t]+(\d+)[ \t]+\d+[ \t]+\d+[ \t]+\d+[ \t]*$/m.exec(text);
  const uid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(uid) ? uid : null;
}

export function parseCmdline(text) {
  // An empty cmdline is valid. Preserve empty arguments other than the final terminator.
  if (!text) return [];
  return text.endsWith("\0") ? text.slice(0, -1).split("\0") : null;
}

/** The literal sibling socket name used by a holder of this endpoint. */
export function holderSocketOf(endpoint, socket) {
  if (!endpoint.startsWith("/") || !endpoint.endsWith(".sock") || !socket.startsWith("/")) return false;
  const prefix = endpoint.slice(0, -5) + ".holder";
  return socket === prefix + ".sock" ||
    socket.startsWith(prefix + ".") && /^\.(?:[0-9a-f]{8}|[0-9a-f]{32})\.sock$/.test(socket.slice(prefix.length));
}

function endpointStem(path) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 ? path.slice(0, dot) : path;
}

export function holdProcess(entry) {
  const { argv } = entry;
  return liveProc(entry) && argv?.length === 4 && argv[0] && argv[1] === "hold" && argv[2] === "--socket"
    && argv[3].startsWith("/") ? argv[3] : null;
}

export function cutOffRecheckMs(value) {
  const delay = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(delay) && delay >= 0 && delay <= 60_000 ? delay : 5000;
}

class CutOffUnknown extends Error {}
const unknownCutOff = (why) => { throw new CutOffUnknown(why); };

function readCutOff(check, reason, read) {
  check();
  try { return read(); }
  catch (error) {
    if (error instanceof CutOffUnknown) throw error;
    if (error?.code === "CUSTOM_CORE_SOCKET") unknownCutOff(CUT_OFF_REASONS.custom);
    if (error?.code === "CORE_SOCKET_ABSENT") unknownCutOff(CUT_OFF_REASONS.answer);
    unknownCutOff(reason);
  } finally { check(); }
}

function memberVerdict(answer) {
  if (answer?.timedOut) unknownCutOff(CUT_OFF_REASONS.time);
  const status = answer?.status;
  if (answer?.error !== undefined || !status || typeof status.core?.id !== "string" ||
      !status.core.id.trim() || !positivePid(status.pid)) unknownCutOff(CUT_OFF_REASONS.answer);
  if (!Object.hasOwn(status, "holders")) unknownCutOff(CUT_OFF_REASONS.old);
  if (!Array.isArray(status.holders) || status.holders.some((row) => !positivePid(row?.pid))) {
    unknownCutOff(CUT_OFF_REASONS.list);
  }
  return status;
}

async function observationOf({ pool, discover, rpc, proc, clock, index, readPool }) {
  const deadline = clock.now() + 4000;
  const check = () => { if (clock.now() >= deadline) unknownCutOff(CUT_OFF_REASONS.time); };
  const members = readCutOff(check, CUT_OFF_REASONS.pool, readPool);
  if (members.warnings.length || members.holders.some((h) => h.name !== LOCAL_HOLDER && h.session !== `am-holder-${h.name}`)) {
    unknownCutOff(CUT_OFF_REASONS.pool);
  }
  if (pool && JSON.stringify(pool) !== JSON.stringify(members.holders)) unknownCutOff(CUT_OFF_REASONS.changed);

  const endpoints = new Map();
  const cores = members.holders.map((member) => {
    const targets = readCutOff(check, CUT_OFF_REASONS.socket, () => discover(member, check));
    if (!targets.length) unknownCutOff(CUT_OFF_REASONS.socket);
    const core = { member, targets, statuses: [] };
    for (const { socket } of targets) {
      if (endpoints.has(socket) && endpoints.get(socket) !== core) unknownCutOff(CUT_OFF_REASONS.ambiguous);
      endpoints.set(socket, core);
    }
    return core;
  });

  // Take the process table before any status RPC, so a subsequent adoption can veto a candidate.
  const table = readCutOff(check, CUT_OFF_REASONS.proc, () => proc(index, check));
  const listed = new Set();
  const requests = [...endpoints];
  for (let i = 0; i < requests.length; i += 4) {
    const batch = requests.slice(i, i + 4);
    const replies = await Promise.allSettled(batch.map(async ([socket, core]) => {
      check();
      return rpc(socket, Math.max(1, Math.ceil(deadline - clock.now())), core.member);
    }));
    check();
    for (const [index, reply] of replies.entries()) {
      const [socket, core] = batch[index];
      const status = memberVerdict(reply.value);
      core.statuses.push({ socket, id: status.core.id, pid: status.pid });
      for (const row of status.holders) listed.add(row.pid);
    }
  }

  const coreIds = new Set(), corePids = new Set();
  for (const core of cores) {
    const { id, pid } = core.statuses[0];
    if (coreIds.has(id) || corePids.has(pid) || core.statuses.some((status) => status.id !== id || status.pid !== pid)) {
      unknownCutOff(CUT_OFF_REASONS.ambiguous);
    }
    coreIds.add(id);
    corePids.add(pid);
    const sockets = core.statuses.map((status) => status.socket);
    const proof = readCutOff(check, CUT_OFF_REASONS.proc, () => table.coreProof(pid, sockets));
    if (!proof) unknownCutOff(CUT_OFF_REASONS.socket);
    if (proof.namespace !== table.namespace) unknownCutOff(CUT_OFF_REASONS.proc);
    core.exe = proof.exe;
    core.starttime = proof.starttime;
  }

  // Core replaces the final extension when naming a holder socket. Include listeners
  // outside the pool here, since a different endpoint can produce the same name.
  const listenersByStem = new Map();
  for (const path of table.listeningPaths()) {
    check();
    const stem = endpointStem(path);
    listenersByStem.set(stem, listenersByStem.has(stem) ? null : path);
  }

  const candidates = new Map();
  for (const entry of table.entries) {
    check();
    const socket = holdProcess(entry);
    if (!socket) continue;
    const matches = requests.filter(([endpoint]) => holderSocketOf(endpoint, socket));
    if (!matches.length) continue;
    if (matches.length !== 1) unknownCutOff(CUT_OFF_REASONS.ambiguous);
    const [endpoint, core] = matches[0];
    const namespace = readCutOff(check, CUT_OFF_REASONS.proc, () => table.namespaceOf(entry));
    if (entry.exe !== core.exe || namespace !== table.namespace) unknownCutOff(CUT_OFF_REASONS.proc);
    if (listed.has(entry.pid)) continue;
    if (listenersByStem.get(endpointStem(endpoint)) !== endpoint) unknownCutOff(CUT_OFF_REASONS.ambiguous);
    candidates.set(entry.pid, { holder: core.member.name, socket, ...entry });
  }
  check();
  return { members: members.holders, cores, candidates, entries: table.entries, namespace: table.namespace };
}

function confirmCutOffs(first, second) {
  if (first.namespace !== second.namespace || JSON.stringify(first.cores) !== JSON.stringify(second.cores)) {
    unknownCutOff(CUT_OFF_REASONS.changed);
  }
  const children = new Map();
  for (const entry of second.entries) {
    if (liveProc(entry)) children.set(entry.ppid, (children.get(entry.ppid) ?? 0) + 1);
  }
  const confirmed = [];
  for (const [pid, before] of first.candidates) {
    const after = second.candidates.get(pid);
    if (after && ["holder", "starttime", "socket", "exe"].every((key) => before[key] === after[key])) {
      confirmed.push({ holder: after.holder, pid, programs: children.get(pid) ?? 0 });
    }
  }
  return confirmed;
}

/** At most two complete pool observations, with one wait only if the first has a candidate. */
export async function holderCutOffs({ members, discover, rpc, proc, clock, recheckMs, platform = "linux" }) {
  const seen = new Set([LOCAL_HOLDER]);
  const readPool = () => {
    const pool = members();
    for (const member of pool.holders) seen.add(member.name);
    return pool;
  };
  const delay = cutOffRecheckMs(recheckMs);
  const result = { holders: [], unchecked: [], recheckMs: delay };
  try {
    if (platform !== "linux") {
      try { readPool(); } catch { /* The unsupported platform still determines the result. */ }
      unknownCutOff(CUT_OFF_REASONS.platform);
    }
    const readers = { discover, rpc, proc, clock, readPool };
    const first = await observationOf({ ...readers, index: 0 });
    if (first.candidates.size) {
      await clock.sleep(delay);
      const second = await observationOf({ ...readers, index: 1, pool: first.members });
      result.holders = confirmCutOffs(first, second);
    }
  } catch (error) {
    if (!(error instanceof CutOffUnknown)) throw error;
    result.unchecked = [...seen].map((holder) => ({ holder, reason: error.message }));
  }
  return result;
}

export function cutOffLines({ holders, unchecked }) {
  if (!holders.length && !unchecked.length) return [];
  const lines = ["cut-off check:"];
  for (const { holder, pid, programs } of holders) {
    const first = `  ${holder}: No pool core listed holder process ${pid} in either read. At the second read it had `;
    lines.push(first + (programs === 0 ? "no same-user live direct children. This does not establish that a previous agent stopped."
      : `${programs} same-user live direct ${programs === 1 ? "child" : "children"}. They may include working agents. Verify that the previous agent stopped before starting it again.`));
  }
  for (const { holder, reason } of unchecked) lines.push(`  ${holder}: not checked (${reason})`);
  return lines;
}
