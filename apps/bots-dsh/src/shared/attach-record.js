// The attach ledger: which terminal plays which bot, as an append-only file the
// automagik-herdr CLI alone writes (`<app home>/automagik-herdr/attach.jsonl`, beside the
// workers ledger). The `bot=` label is a display hint; this file is the authority, so a
// relabel (`hc label`) moves nothing. Pure: no `herdr`, no `node:` import, so the CLI, the
// briefing hook and the tests share it. Apache-2.0.
//
// A row (one JSON object per line, one O_APPEND write each):
//   { v: 1, event: "attach" | "detach" | "end", bot: "b-…" | "session-…",
//     project: "<absolute main-checkout path>", terminal: "t…", core: "<hc core id>",
//     created_ms: <the terminal's hc created_ms>, machine: null | "<name>", at: "<ISO time>",
//     by: "start" | "attach" | "detach" | "sweep" | "import", reason?: "finished" | "moved" | "replaced" }
//
// `machine` (automagik#206, bots.attach-ledger@1): null, the pane runs on this computer; a name,
// it runs on that linked machine (hc machine ls), `terminal` is still its bare id there ("tN",
// never "<name>/tN"), and `core` is that machine's own core id (hc machine ls `id`, the same as
// its hc server status core.id), so a rename there keeps the row. Its hc address is
// "<machine>/<terminal>" (addressOf), the machine named as hc names it now. For example:
//   {"v":1,"event":"attach","bot":"b-atlasaaaaa","project":"/srv/ops",
//    "terminal":"t8","core":"5e1f0c2a9b7d4e3f8a6c1b2d3e4f5a6b","created_ms":1700000000008,
//    "machine":"lab","at":"2026-11-03T21:00:00.000Z","by":"attach"}
//
// The fold (foldAttach), over the rows in file order, keyed by (core, terminal, created_ms):
//   attach: ends any earlier binding of the same bot in the same place (this computer, or one
//           linked machine's core: a project's checkouts on two machines share their bots' ids,
//           so they are two bots) and any binding of the same key, then binds the key to the
//           row's bot;
//   detach: unbinds the key when it is bound to the row's bot (another bot's row is ignored);
//   end:    unbinds the key, whatever bot it held.
// What is left binds each bot to at most one key per place and each key to at most one bot. A binding
// is an attachment only once hc confirms it (confirmBindings): the core is this computer's
// (`hc server status` core.id), or a linked machine's that is connected now, and `hc get
// <address>` is live with the same created_ms. A machine's row whose machine isn't linked or
// isn't connected stays as it is (unknown: shown as last seen, never ended for it). A
// finished or vanished terminal reads as ended ("finished"), and a terminal id reused after
// an hc restart, a new created_ms, as ended too ("replaced"), before any end row is written.

export const ATTACH_FILE = "automagik-herdr/attach.jsonl";
export const attachPath = (appHome) => `${String(appHome).replace(/\/+$/, "")}/${ATTACH_FILE}`;

export const ATTACH_EVENTS = ["attach", "detach", "end"];
export const ATTACH_BY = ["start", "attach", "detach", "sweep", "import"];
export const ATTACH_REASONS = ["finished", "moved", "replaced"];
const BOT_SHAPE = /^(b-[a-z2-7]{10}|session-[A-Za-z0-9._-]+)$/;
// hc's addresses are `t7`, `t1b`; any one word without a slash (another machine's) is read.
const TERMINAL_SHAPE = /^[A-Za-z0-9._-]+$/;

/** The mode bits that make the file unsafe to read: group- or world-writable. */
export const UNSAFE_MODE = 0o022;
/** Why a ledger of `mode` (stat's mode) must not be read, or null. */
export function modeProblem(path, mode) {
  if (!(mode & UNSAFE_MODE)) return null;
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  return `${path} is group- or world-writable (mode ${octal}), so anyone could have written who plays which bot; `
    + `it was not read. Check its rows, then make it the owner's alone: chmod 600 ${path}`;
}

/** A row, its fields in the documented order; `reason` only when given. */
export function attachRow({ event, bot, project, terminal, core, created_ms, machine = null, by, reason, at }) {
  const row = { v: 1, event, bot, project: project ?? null, terminal, core, created_ms, machine: machine ?? null,
    at: new Date(at ?? Date.now()).toISOString(), by };
  if (reason) row.reason = reason;
  return row;
}

/** The row an end or detach of `binding` writes. */
export const closingRow = (binding, event, by, reason, at) => attachRow({ ...binding, event, by, reason, at });

export const attachLine = (row) => `${JSON.stringify(row)}\n`;

/** Whether `row` is one the fold reads: every field the key and the event need, well formed. */
export function validRow(row) {
  return Boolean(row) && typeof row === "object" && row.v === 1 && ATTACH_EVENTS.includes(row.event)
    && typeof row.bot === "string" && BOT_SHAPE.test(row.bot)
    && typeof row.terminal === "string" && TERMINAL_SHAPE.test(row.terminal)
    && typeof row.core === "string" && row.core !== ""
    && Number.isSafeInteger(row.created_ms)
    && (row.machine === null || row.machine === undefined || typeof row.machine === "string");
}

/** The rows of a ledger's text: { rows, skipped } (a torn or foreign line is skipped and counted). */
export function readAttach(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { row = null; }
    if (validRow(row)) rows.push(row); else skipped += 1;
  }
  return { rows, skipped };
}

/** A binding's fold key. */
export const attachKey = ({ core, terminal, created_ms }) => `${core}\n${terminal}\n${created_ms}`;

/** A binding's place: null on this computer, else its linked machine's core id. */
export const placeOf = (row) => (row?.machine ? row.core : null);

/**
 * The fold (see the top of this file): { byBot: Map bot -> this computer's binding, byBotOn:
 * Map core id -> Map bot -> that linked machine's binding, byKey: Map key -> binding }, a
 * binding being the attach row that made it. heldIn(fold, bot, place) reads either.
 */
export function foldAttach(rows) {
  const byKey = new Map();
  const byBot = new Map();
  const byBotOn = new Map();
  const bots = (row) => {
    const at = placeOf(row);
    if (at === null) return byBot;
    if (!byBotOn.has(at)) byBotOn.set(at, new Map());
    return byBotOn.get(at);
  };
  const unbind = (key) => {
    const b = byKey.get(key);
    if (!b) return;
    byKey.delete(key);
    const m = bots(b);
    if (m.get(b.bot) === b) m.delete(b.bot);
  };
  for (const row of rows) {
    if (!validRow(row)) continue;
    const key = attachKey(row);
    if (row.event === "attach") {
      const held = bots(row).get(row.bot);
      if (held) unbind(attachKey(held));
      unbind(key);
      byKey.set(key, row);
      bots(row).set(row.bot, row);
    } else if (row.event === "detach") {
      if (byKey.get(key)?.bot === row.bot) unbind(key);
    } else unbind(key);
  }
  return { byBot, byBotOn, byKey };
}

/** A bot's binding in a place (placeOf: null, this computer; else that machine's core id). */
export const heldIn = (fold, bot, place = null) => (place === null ? fold.byBot.get(bot) : fold.byBotOn.get(place)?.get(bot)) ?? null;

/**
 * The linked machines by core id, from `hc machine ls --json` (its text or parsed answer):
 * Map id -> { name, connected }. Anything unreadable: none.
 */
export function machinesById(json) {
  let list = [];
  try { list = (typeof json === "string" ? JSON.parse(json) : json)?.machines ?? []; } catch { return new Map(); }
  const out = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    if (m && typeof m.id === "string" && m.id && typeof m.name === "string" && TERMINAL_SHAPE.test(m.name)) {
      out.set(m.id, { name: m.name, connected: m.state === "connected" });
    }
  }
  return out;
}

/**
 * A binding's hc address: its terminal on this computer; "<name>/<terminal>" on a linked
 * machine, the name hc gives that machine's core now (`machines`, machinesById), else the
 * row's own name. Never stored: rows keep the bare terminal.
 */
export function addressOf(binding, machines = new Map()) {
  if (!binding?.machine) return binding?.terminal ?? null;
  return `${machines.get(binding.core)?.name ?? binding.machine}/${binding.terminal}`;
}

/**
 * Checks bindings against hc. `core` is this computer's core id; `ask(args)` resolves with
 * `hc <args> --json` parsed, null when hc says there is no such terminal, or `unanswered`
 * when it gave no answer (it may also throw: a failed hc never reads as "ended").
 * Resolves { live: [{ binding, get }], ended: [{ binding, reason }], unknown: [binding] }:
 * another core's local row is ended ("finished": this core no longer runs it). A linked
 * machine's row (`machine` set) is asked at its address only while its core is a linked machine
 * that is connected (`machines`, machinesById); otherwise it stays unknown, never ended and
 * never asked, so a machine away doesn't make hc fail every lookup.
 */
export async function confirmBindings(bindings, core, ask, unanswered = undefined, machines = new Map()) {
  const live = [];
  const ended = [];
  const unknown = [];
  await Promise.all(bindings.map(async (binding) => {
    if (binding.machine) {
      if (!machines.get(binding.core)?.connected) { unknown.push(binding); return; }
    } else if (binding.core !== core) { ended.push({ binding, reason: "finished" }); return; }
    const get = await ask(["get", addressOf(binding, machines)]);
    if (unanswered !== undefined && get === unanswered) { unknown.push(binding); return; }
    const verdict = verdictOf(binding, get);
    if (verdict === "live") live.push({ binding, get });
    else ended.push({ binding, reason: verdict });
  }));
  return { live, ended, unknown };
}

/** "live", "finished" (no terminal, or not live) or "replaced" (same id, another created_ms). */
export function verdictOf(binding, get) {
  if (!get || typeof get !== "object" || get.state !== "live") return "finished";
  if (get.created_ms !== binding.created_ms) return "replaced";
  return "live";
}
