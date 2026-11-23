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
