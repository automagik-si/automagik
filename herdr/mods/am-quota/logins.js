// The Accounts panel's Claude login record and controls (#453). The probe lives in
// loginProbe.js, a byte copy of the sidebar's, shared with `am accounts here`.
// The panel uses `am accounts set-login` where present. Its older-sidebar fallback writes with
// the snapshot it read. Apply uses the CLI writer for linked Claude assignments.

import { LOGINS_FILE, DEFAULT_LOGIN, PROBE_MS, loginsPath, shapeProblem, askStatus, REAL_SCRIPT, bounded } from "./loginProbe.js";
export { LOGINS_FILE, CONFIG_VAR, DEFAULT_LOGIN, DEFAULT_WORDS, CREDENTIAL_VARS, PROBE_MS, loginsPath, loginWords, parseLogins, shapeProblem, FOLDER_SCRIPT, AUTH_SCRIPT, PRESENT_SCRIPT, bounded, readStatus, authCommand, askStatus, accountEmail, readRecord, probeLogin, presentVars, REAL_SCRIPT, paneLogin } from "./loginProbe.js";

const shown = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
const trim = (p) => String(p).replace(/\/+$/, "");

/** How the panel names a login: "the default login", "login 2". */
export const loginName = (id) => (id === DEFAULT_LOGIN ? "the default login" : `login ${id}`);
/** `dir` as a person types it in a terminal: `"$HOME/.claude-2"` under the home folder. */
export const typed = (dir, home) => (dir.startsWith(`${trim(home)}/`) ? `"$HOME/${dir.slice(trim(home).length + 1)}"` : `'${dir.replace(/'/g, "'\\''")}'`);

/** What outranks a sign-in, in plain words, from `authMethod` (anything but claude.ai). */
export function methodLine(method) {
  const m = String(method);
  if (/key/i.test(m)) return "an API key outranks this sign-in";
  if (/token/i.test(m)) return "a token variable outranks this sign-in";
  if (/bedrock|vertex|foundry|third|provider/i.test(m)) return "a third-party provider is set";
  return `another way to sign in (${shown(m).slice(0, 40)}) outranks this sign-in`;
}

/**
 * The one write of the record: `{ use, logins }`, through writeTextFile with the snapshot it
 * replaces (Herdr's writer compares, then writes a temp file and renames it into place, RFC
 * 0014), so a launch never reads half a record and an edit made since the read is never lost.
 */
export async function writeRecord(appHome, { use, logins }, before, writeTextFile) {
  const text = `${JSON.stringify({ use, logins: logins.map((l) => ({ id: l.id, dir: l.dir })) }, null, 2)}\n`;
  await writeTextFile(loginsPath(appHome), text, before ?? null);
  return text;
}

/**
 * Whether login `l` may leave the record (#453 section 7), asked at the press: { ok } only when
 * `claude auth status` there says `loggedIn: false`, else { why }. Asked even when its folder is
 * gone (its sign-in can outlive the folder); never for a folder the CLI could not launch with.
 */
export async function signedOut(l, { exec, home, where, ms = PROBE_MS }) {
  const shape = shapeProblem(l.dir, home);
  if (shape) return { why: `its ${shape}: fix ${LOGINS_FILE} by hand` };
  const st = await askStatus(l, { exec, where, ms });
  if (st.state === "out") return { ok: true };
  if (st.state === "in") return { why: `it is still signed in: first, in a terminal, run CLAUDE_CONFIG_DIR=${typed(l.dir, home)} claude auth logout` };
  const said = { late: `claude auth status didn't answer in ${ms / 1000} s`, nobin: "claude isn't found where launches look for it",
    unread: "claude auth status gave no answer the panel can read" }[st.state];
  return { why: `the panel can't tell whether ${loginName(l.id)} is signed out (${said})` };
}

/**
 * `on` (paneLogin's answer) with an unknown folder matched by its real path, the way the form
 * rule takes a folder: a pane started by hand through a link maps to its login.
 */
export async function matchReal(on, logins, exec, ms = PROBE_MS) {
  if (!on?.unknown) return on;
  const r = await bounded(exec, "sh", ["-c", REAL_SCRIPT, "sh", on.unknown], ms);
  const real = r?.code === 0 ? String(r.stdout ?? "").trim() : null;
  const l = real ? logins.find((x) => x.dir === real) : null;
  return l ? { id: l.id } : on;
}

/** The next slot for Add login: the lowest n ≥ 2 whose id and `<home>/.claude-<n>` no login has. */
export function nextSlot(logins, home) {
  for (let n = 2; ; n += 1) {
    const id = String(n), dir = `${trim(home)}/.claude-${n}`;
    if (!logins.some((l) => l.id === id || l.dir === dir)) return { id, dir };
  }
}
