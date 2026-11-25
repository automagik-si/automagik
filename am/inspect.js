// A bot's right-click menu (create.js menuBody) and its "What happened" view, as plain data:
// which items the menu shows, and what the two ledgers say a bot did (`automagik-herdr
// history`). Pure: no `herdr`, no `node:` import, so the CLI, the form and the tests share
// it. It reads the ledgers' rows as they are and changes neither row shape. Apache-2.0.

/** How many rows of each kind the history keeps, newest last. */
export const HISTORY_LIMIT = 20;

const stamp = (at) => (typeof at === "string" ? at : "");
const latest = (rows, limit) => (limit > 0 ? rows.slice(-limit) : []);

/**
 * What a bot did, by the attach ledger's rows (attach.js readAttach) and the workers ledger's
 * (workers.js readLedger): `attach`, its attach/detach/end rows; `starts`, the seat start rows
 * (start and attach); `workers`, the worker start rows it asked for; `sessions`, the Claude
 * session rows of the terminals it played in, each while it played there by the rows' times;
 * `transcript`, the newest session's transcript path, or null. Each list keeps its last
 * `limit` rows, in file order. Session rows carry a terminal id and no core, so the match is
 * exact once a pane's detach or end row is written: a terminal id hc reused before the sweep
 * writes that end row can show the new pane's sessions here meanwhile.
 */
export function botHistory({ attachRows = [], ledgerRows = [], botId, limit = HISTORY_LIMIT }) {
  const attach = attachRows.filter((r) => r?.bot === botId);
  const seat = (r) => r?.event === "start" && r.kind === "seat";
  const starts = ledgerRows.filter((r) => seat(r) && r.botId === botId);
  const workers = ledgerRows.filter((r) => r?.event === "start" && r.kind === "worker" && r.botId === botId);
  // Who held each terminal from when: every bot's attach rows and seat starts, by time.
  const holds = [
    ...attachRows.filter((r) => r?.event === "attach").map((r) => ({ terminal: r.terminal, bot: r.bot, at: stamp(r.at) })),
    ...attachRows.filter((r) => r?.event === "detach" || r?.event === "end").map((r) => ({ terminal: r.terminal, bot: null, at: stamp(r.at) })),
    ...ledgerRows.filter(seat).map((r) => ({ terminal: r.terminal, bot: r.botId, at: stamp(r.at) })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const holder = (terminal, at) => {
    let who = null;
    for (const h of holds) {
      if (h.at > at) break;
      if (h.terminal === terminal) who = h.bot;
    }
    return who;
  };
  const sessions = ledgerRows.filter((r) => r?.event === "session" && typeof r.terminal === "string"
    && holder(r.terminal, stamp(r.at)) === botId);
  const transcript = [...sessions].reverse().find((r) => typeof r.transcript === "string" && r.transcript)?.transcript ?? null;
  return { bot: botId, attach: latest(attach, limit), starts: latest(starts, limit), workers: latest(workers, limit),
    sessions: latest(sessions, limit), transcript };
}

const when = (at) => (typeof at === "string" && at.length >= 16 ? `${at.slice(0, 10)} ${at.slice(11, 16)}` : "?");
const joined = (...parts) => parts.filter(Boolean).join(" · ");

/**
 * The history as lines to show, newest first: { timeline: [{ at, text }], workers: [text],
 * transcript }. Attach, detach, end and start rows share the timeline.
 */
export function historyLines(h) {
  const events = [
    ...(h?.attach ?? []).map((r) => ({ at: stamp(r.at), text: joined(`${r.event === "attach" ? "attached to" : r.event === "detach" ? "detached from" : "ended in"} ${r.terminal}`,
      r.by && `by ${r.by}`, r.reason) })),
    ...(h?.starts ?? []).map((r) => ({ at: stamp(r.at), text: joined(`started in ${r.terminal}`, r.agent, r.model) })),
    ...(h?.sessions ?? []).map((r) => ({ at: stamp(r.at), text: `session ${String(r.session ?? "?").slice(0, 8)} in ${r.terminal}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const workers = [...(h?.workers ?? [])].reverse().map((r) => joined(`${when(r.at)} ${r.branch || r.task || r.terminal}`,
    r.role, r.template || r.agent, r.terminal));
  return { timeline: events.map((e) => ({ at: e.at, text: `${when(e.at)} ${e.text}` })), workers, transcript: h?.transcript ?? null };
}

/**
 * The bot menu's items, in order, by section: "configure" and "prompt" for every bot; for a
 * bot that isn't planned, Run: "focus" (a pane to focus, label-derived included) and/or
 * "start" (no ledger-confirmed pane), "restart", "restart-fresh" (a ledger-confirmed pane),
 * "restart-on", "attach" (a focused pane that isn't its confirmed one) and "detach" (a
 * confirmed pane); then "inspect". `live`: the bot's own ledger-confirmed pane, `focus`: the
 * pane its Focus opens (defaults to `live`; a label-only live pane is Focus but not `live`),
 * `pane`: the pane focused at the right-click (a local terminal), both or null.
 */
export function menuItems({ planned = false, live = null, focus = live, pane = null } = {}) {
  const run = planned ? [] : [
    ...(focus ? ["focus"] : []), ...(live ? [] : ["start"]), "restart", ...(live ? ["restart-fresh"] : []), "restart-on",
    ...(pane && pane !== live ? ["attach"] : []), ...(live ? ["detach"] : []),
  ];
  return ["configure", "prompt", ...run, "inspect"];
}
