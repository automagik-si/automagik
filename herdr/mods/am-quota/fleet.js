// The words and restart bindings shown for the linked accounts read.
import { barName, BOT_ID, coreOkay, countOkay, FLEET_V, machineList, matches, object, pathOkay, REASONS, rowFor, TERMINAL, timeOkay } from "./accountsRows.js";
import { who } from "./view.js";

const LINES = Object.freeze({
  "no-cli": "no am or sidebar there",
  "old-cli": "its am or sidebar is older than this read needs: update it there",
  unreachable: "hc couldn't reach it",
  timeout: "it didn't answer in 20 s",
  "bad-answer": "its answer couldn't be read",
  failed: "the read failed",
  unreadable: "its Codex sign-in file can't be read",
  "no-account-id": "its Codex sign-in names no account",
  "not-read": "not read yet",
  override: "another way to sign in outranks its login",
  "not-signed-in": "the login a new launch gets there is signed out",
  "bad-folder": "that login's folder isn't in the form launches use",
  ambiguous: "two logins there are one account",
  "own-launcher": "Claude starts there with its own command, which this read doesn't run",
  unresolved: "this Mac starts Claude with its own command, which this read doesn't follow",
  unread: "its launch settings couldn't be read",
});

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const routeWords = (route) => (route?.state === "eligible" ? route.email : null) ?? LINES[route?.state] ?? null;
const timeWords = (time) => new Date(time).toLocaleString();

export const members = (r) => machineList(r)?.list ?? null;

function wordsFor(tool, row, ref, refName) {
  const { state, account, here, code } = row;
  if (state === "away") return "away (not connected)";
  if (state === "failed" || state === "unknown") return `${state}: ${code}`;
  if (state === "none") return "no Codex sign-in there";
  if (state === "no-login") return `no login of ${ref.email} here`;
  const codex = tool === "codex";
  const named = typeof refName === "string" ? refName : refName ? who(refName) : null;
  const acct = codex ? (here === "same" && named ? named : `account ${account}`) : account;
  if (state === "changed") return `changed on the machine: now ${acct}`;
  if (codex) {
    if (here === "same") return `the same account as this Mac (${acct}), grant origin unknown`;
    if (here === "other") return `another account than this Mac's (${acct}), grant origin unknown`;
    return `signed in (${acct}); this Mac has no Codex login to compare with`;
  }
  if (here === "same") return `signed in as ${acct}, the same account as this Mac`;
  if (here === "other") return `signed in as ${acct}; this Mac uses ${ref.email}`;
  return `signed in as ${acct}; this Mac has no Claude login to compare with`;
}

export function fleetRows({ record, answer, tool, ref, refName, now }) {
  const current = answer && record && answer.at === record.at;
  return Object.entries(record?.machines ?? {}).filter(([core]) => core !== "local")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([core, entry]) => {
      const { name } = entry;
      const row = rowFor(tool, entry.state ? entry : null, ref, now);
      const { state, here, code } = row;
      const words = wordsFor(tool, row, ref, refName);
      const tone = state === "observed" && here === "same" ? "good" :
        state === "observed" && here === "other" || ["changed", "no-login", "failed"].includes(state) ? "warn" : "none";
      const lines = [];
      if (code && LINES[code]) lines.push(LINES[code]);
      const obs = entry[tool];
      if (entry.state !== "read" && obs?.readAt) {
        const last = rowFor(tool, { ...entry, state: "read" }, ref, Date.parse(obs.readAt));
        lines.push(`Last read ${timeWords(obs.readAt)}: ${wordsFor(tool, last, ref, refName)}`);
      }
      if (state === "changed" && tool === "codex" && here !== "none") {
        lines.push(here === "same" ? "The same account as this Mac." : "Another account than this Mac's.");
      }
      let restart = null;
      if (tool === "claude" && obs) {
        for (const slot of obs.slots) {
          if (slot.state !== "eligible") lines.push(`${slot.email ?? `login ${slot.id}`} · ${LINES[slot.state]}`);
        }
        const bare = routeWords(obs.routes.bare);
        const tree = obs.routes.record.state === "unresolved" ? "its own Claude launcher, which this read doesn't run" : routeWords(obs.routes.record);
        if (obs.routes.bare.email || obs.routes.record.email) {
          lines.push(`A start or restart from here starts ${bare}; a tree restart there starts ${tree}.${obs.routesDiffer ? " They differ." : ""}`);
        }
        if (bare) restart = `A restart from here starts ${bare}`;
      }
      const exceptions = entry.exceptions;
      for (const { project, why } of [...(exceptions?.bound ?? []), ...(exceptions?.list ?? [])]) {
        lines.push(why === "own-app-home" ? `${project} uses its own app home: not managed` :
          why === "own-path" ? `${project} sets its own PATH: not covered by this read` : `${project} · ${LINES.unread}`);
      }
      if (exceptions?.more) lines.push(`+${exceptions.more} more`);
      const looked = current && entry.state === "read" && Object.hasOwn(answer.bots ?? {}, core) ? answer.bots[core] : null;
      if (answer && !current && entry.state === "read") lines.push("Its bots are listed again after the next read.");
      const bots = looked?.[tool] ?? [];
      if (looked?.reason) lines.push("Its bots couldn't be read.");
      if (looked?.ownHome) lines.push(`${count(looked.ownHome, "bot")} there use their project's own app home: not checked`);
      if (looked?.unbound) lines.push(`${count(looked.unbound, "bot")} there have no binding here, so they are not listed`);
      if (looked?.more) lines.push(`+${looked.more} more bindings there, not checked`);
      if (tool === "codex" && bots.length && looked.codexReliable === false) {
        lines.push("Which login each Codex bot there started with can't be told: all are listed.");
      }
      return { core, name, state, words, tone, lines, bots, restart };
    });
}

export const restartArgs = (bot, name) => ["restart", bot.id, "--project", bot.project, "--machine", name, "--expect-pane",
  `${bot.expect.core}/${bot.expect.terminal}/${bot.expect.created_ms}`];

export const frozen = (bots) => bots.map(({ id, project, expect }) => ({ id, project,
  expect: { core: expect.core, terminal: expect.terminal, created_ms: expect.created_ms } }));

export function sameList(a, b) {
  return a.length === b.length && a.every((bot, i) => bot.id === b[i].id && bot.project === b[i].project
    && bot.expect.core === b[i].expect.core && bot.expect.terminal === b[i].expect.terminal
    && bot.expect.created_ms === b[i].expect.created_ms);
}

function readBots(value, core) {
  if (!object(value)) return null;
  if (value.reason === "failed") return { reason: "failed" };
  const { codexReliable, ownHome, unbound, more } = value;
  if (codexReliable !== false || ![ownHome, unbound, more].every(countOkay)) return null;
  const read = (list) => Array.isArray(list) && list.every((bot) => object(bot) && matches(BOT_ID, bot.id) && bot.id.length <= 128 && pathOkay(bot.project)
    && bot.expect?.core === core && matches(TERMINAL, bot.expect.terminal) && countOkay(bot.expect.created_ms)
    && (["login unknown", "an unknown folder"].includes(bot.on) || /^slot [A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(bot.on)))
    ? list.map(({ id, name, project, expect, on }) => ({ id, name: barName(name, id), project,
      expect: { core, terminal: expect.terminal, created_ms: expect.created_ms }, on })) : null;
  const codex = read(value.codex), claude = read(value.claude);
  return codex && claude ? { codex, claude, codexReliable, ownHome, unbound, more } : null;
}

export function readFleetAnswer(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data?.v !== FLEET_V || !timeOkay(data.at) || !Array.isArray(data.machines)
    || !(data.linked === null || REASONS.includes(data.linked?.reason))) return null;
  const bots = new Map();
  for (const machine of data.machines) {
    const core = machine?.core;
    if (!coreOkay(core) || core === "local" || bots.has(core)) return null;
    if (machine.bots === null) bots.set(core, null);
    else {
      const checked = readBots(machine.bots, core);
      if (!checked) return null;
      bots.set(core, checked);
    }
  }
  return { at: data.at, linked: data.linked ? { reason: data.linked.reason } : null, bots: Object.fromEntries(bots) };
}

export function restartWords(r) {
  const name = r.name;
  if (r.code === 0) {
    if (["ended", "gone", "kept"].includes(r.retired)) return `${name} restarted.`;
    if (r.retired === "unconfirmed") return `${name} restarted in a new pane, but its old pane couldn't be confirmed ended: check it in Herdr before ending it.`;
    return `${name} restarted in a new pane, but whether its old pane ended couldn't be verified: check it in Herdr.`;
  }
  const refused = r.out?.refused ?? r.refused;
  if (refused === "binding") return `${name}'s pane is no longer the one shown: nothing was restarted.`;
  if (refused === "helpers") return `${name} has running helpers: nothing was restarted.`;
  if (refused === "busy" || refused === "working") return `${name} is busy: nothing was restarted.`;
  if (refused === "duplicate") return `${name} has more than one live pane: nothing was restarted.`;
  return `${name} wasn't restarted (see the sidebar's actions log).`;
}
