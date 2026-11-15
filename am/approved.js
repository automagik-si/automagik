#!/usr/bin/env node
// The approved roster snapshot (#631 PR C1): one person-approved record per project, outside
// the project and outside every sandbox. The proxy reads this record and never the working
// tree; `automagik-herdr proxy approve --project <dir>` is its only writer.
//
// Layout: <data root>/approved/<key>.json, where the data root is
// $XDG_DATA_HOME/automagik-herdr under the XDG data home. The key is the
// first 32 hex characters of sha256 over the project's canonical realpath. A record is
// { v, project, roster, sha256, approvedAt, approvedBy }: `roster` is the exact bytes of the
// approved .herdr/bots.json and `sha256` their digest. Mode 0600, folder 0700.
//
// The sandbox binds the data root read-only as one parent mount, so a sandboxed bot cannot
// write the record. It can still ask an unsandboxed in-team pane to run approve: the printed
// diff is the check, and approving is the person's act.
//
// Apache-2.0.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseBots } from "./model.js";
import { dataRootOf } from "./workers.js";

/** The record shape this pack writes and reads. */
export const RECORD_VERSION = 1;
/** The record folder under the data root. */
export const APPROVED_DIR = "approved";
/** Hex characters kept from the project key (128 bits of sha256). */
export const KEY_HEX = 32;

/** The folder holding every project's approved record. */
export const approvedRootOf = (env = process.env) => join(dataRootOf(env), APPROVED_DIR);

/**
 * The folder the per-pane proxy writes an approved worker's Antigravity permission file in
 * (#823 review H1): under the approved root, which the sandbox binds read-only, so a sandboxed
 * pane can neither plant nor edit it. Only the unsandboxed proxy writes here.
 */
export const approvedSettingsDir = (env = process.env) => join(approvedRootOf(env), "agy-settings");

/** The digest an approved roster and a working file are compared by. */
export const sha256Of = (text) => createHash("sha256").update(String(text)).digest("hex");

/** A project's canonical folder (symlinks resolved); throws when it is not a folder. */
export function canonicalProject(project) {
  const real = realpathSync(project);
  if (!statSync(real).isDirectory()) throw new Error(`${real} is not a folder`);
  return real;
}

/** The project key: sha256 of the canonical realpath, truncated. */
export function projectKey(project) {
  return createHash("sha256").update(canonicalProject(project)).digest("hex").slice(0, KEY_HEX);
}

/** The record file a project's approval lives in. */
export const recordFileOf = (project, env = process.env) =>
  join(approvedRootOf(env), `${projectKey(project)}.json`);

/** The person's name for approvedBy, from the environment that ran approve. */
export const approverOf = (env = process.env) =>
  env.SUDO_USER || env.USER || env.LOGNAME || "unknown";

/** The record for a project's roster bytes. */
export function recordFor({ project, roster, approvedAt, approvedBy }) {
  return {
    v: RECORD_VERSION,
    project: canonicalProject(project),
    roster,
    sha256: sha256Of(roster),
    approvedAt,
    approvedBy,
  };
}

/** A record as its file bytes: two-space JSON and a final newline. */
export const recordText = (record) => `${JSON.stringify(record, null, 2)}\n`;

function missingRecord(project) {
  const error = new Error(`no approved roster for ${project}: run `
    + `\`am proxy approve --project ${project}\` from an unsandboxed terminal, `
    + "then restart the pane");
  error.code = "ENOENT";
  return error;
}

/** The checked record in `text` for `project`; throws when it is corrupt or for another project. */
function checkedRecord(text, project) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`the approved record for ${project} is not JSON`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`the approved record for ${project} is not an object`);
  }
  if (record.v !== RECORD_VERSION)
    throw new Error(`the approved record for ${project} has version ${record.v}, `
      + `not ${RECORD_VERSION}`);
  if (record.project !== project)
    throw new Error(`the approved record is for ${record.project}, not ${project}`);
  if (typeof record.roster !== "string")
    throw new Error(`the approved record for ${project} has no roster text`);
  if (record.sha256 !== sha256Of(record.roster)) {
    throw new Error(`the approved record for ${project} does not match its sha256`);
  }
  if (typeof record.approvedAt !== "string" || !record.approvedAt) {
    throw new Error(`the approved record for ${project} has no approvedAt`);
  }
  if (typeof record.approvedBy !== "string" || !record.approvedBy) {
    throw new Error(`the approved record for ${project} has no approvedBy`);
  }
  return record;
}

/**
 * Read and check one project's approved record. Returns { record, file, path, text } where
 * `file` is the parsed roster. A missing record throws with code ENOENT; a corrupt one throws
 * without it, so the proxy and approve can tell them apart.
 */
export function readApprovedRecord({ project, env = process.env, path = undefined }) {
  const main = canonicalProject(project);
  const file = path ?? recordFileOf(main, env);
  let text;
  try {
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error(`the approved record ${file} is not a regular file`);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`the approved record ${file} is not 0600; run `
        + `\`am proxy approve --project ${main}\` again`);
    }
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw missingRecord(main);
    if (e?.code === "EACCES")
      throw new Error(`cannot read the approved record ${file}: permission denied`);
    throw e;
  }
  return { ...parseApprovedRecord(text, main), path: file, text };
}

/** Check record bytes read on the project's own computer (including linked reads). */
export function parseApprovedRecord(text, project) {
  const record = checkedRecord(text, project);
  let roster;
  try {
    roster = parseBots(record.roster).file;
  } catch (e) {
    throw new Error(`the approved roster for ${project} is not valid: ${e?.message ?? e}`);
  }
  return { record, file: roster };
}

/** Both switch values; a missing record or bot is distinct from an approved off value. */
export function proxyStateFor(bot, file = null, error = null) {
  const approved = file?.bots.find((entry) => entry.id === bot.id);
  return { working: bot.hcProxy === true, approved: approved ? approved.hcProxy === true : null,
    error: error ? String(error?.message ?? error).replace(/\s+/g, " ").trim() : null };
}

/** Fresh read for each start, restart, worker start, or diagnostic. Never cached. */
export function approvedProxyState({ project, bot, env = process.env }) {
  let path;
  try {
    path = recordFileOf(project, env);
    return proxyStateFor(bot, readApprovedRecord({ project, env, path }).file);
  } catch (e) {
    return proxyStateFor(bot, null, e?.code === "ENOENT" ? null
      : `invalid approved record ${path ?? project}: ${e?.message ?? e}`);
  }
}

/** Invalid approval cannot supply a value: only a working opt-in refuses. Callers warn off. */
export function approvedProxyEnabled(state, platform = process.platform) {
  if (platform !== "linux") return false;
  if (state.error) {
    if (state.working) {
      throw new Error(`hc proxy: ${state.error}; run am proxy approve first`);
    }
    return false;
  }
  if (state.working && state.approved !== true) {
    throw new Error("hc proxy: working switch is on but approval is off or missing; "
      + "run am proxy approve first");
  }
  return state.approved === true;
}

/** Write one record atomically with mode 0600; returns the path. */
export function writeApprovedRecord(record, env = process.env) {
  const root = approvedRootOf(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root,
    `${createHash("sha256").update(record.project).digest("hex").slice(0, KEY_HEX)}.json`);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`the approved record ${path} is a symlink; refusing to write through it`);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const tmp = join(root, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, recordText(record), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  return path;
}

/** The roster diff a person reads before approving: added, removed, rank, lead and kind. */
export function rosterDiff(previousText, rosterText) {
  const before = previousText === null ? [] : parseBots(previousText).file.bots;
  const after = parseBots(rosterText).file.bots;
  const old = new Map(before.map((bot) => [bot.id, bot]));
  const now = new Map(after.map((bot) => [bot.id, bot]));
  const lines = [];
  for (const bot of before) {
    if (!now.has(bot.id)) lines.push(`- ${bot.id} ${bot.name} (removed)`);
  }
  for (const bot of after) {
    if (!old.has(bot.id)) lines.push(`+ ${bot.id} ${bot.name} (added)`);
  }
  for (const bot of after) {
    const was = old.get(bot.id);
    if (!was) continue;
    const name = `${bot.id} ${bot.name}`;
    if ((was.rank ?? "") !== (bot.rank ?? "")) {
      lines.push(`~ ${name}: rank ${was.rank ?? "none"} -> ${bot.rank ?? "none"}`);
    }
    if ((was.lead ?? "") !== (bot.lead ?? "")) {
      lines.push(`~ ${name}: lead ${was.lead ?? "none"} -> ${bot.lead ?? "none"}`);
    }
    if (was.kind !== bot.kind) lines.push(`~ ${name}: kind ${was.kind} -> ${bot.kind}`);
    if ((was.hcProxy === true) !== (bot.hcProxy === true)) {
      lines.push(`~ ${name}: hcProxy ${was.hcProxy === true ? "on" : "off"} -> `
        + `${bot.hcProxy === true ? "on" : "off"}`);
    }
  }
  return lines;
}

/**
 * `proxy approve`: read the project's working .herdr/bots.json, diff it against the previous
 * record, then write the new record 0600. Approving is the person's act; this is the only
 * writer. Returns { path, record, diff, previous, note }.
 */
export function approveProject({ project, env = process.env, approvedAt = new Date().toISOString(),
  approvedBy = approverOf(env), beforeWrite = null } = {}) {
  const main = canonicalProject(project);
  const working = join(main, ".herdr", "bots.json");
  let roster;
  try {
    roster = readFileSync(working, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
      throw new Error(`no working roster at ${working}`);
    }
    throw new Error(`cannot read the working roster ${working}: ${e?.message ?? e}`);
  }
  parseBots(roster);
  let previous = null;
  let note = null;
  try {
    previous = readApprovedRecord({ project: main, env }).record;
  } catch (e) {
    if (e?.code !== "ENOENT") {
      note = `the previous record was unreadable (${e?.message ?? e}); replaced`;
    }
  }
  const diff = rosterDiff(previous ? previous.roster : null, roster);
  const record = recordFor({ project: main, roster, approvedAt, approvedBy });
  // The command prints the diff before the record exists: the check comes first, the write is
  // the person's act. A later write error leaves the printed diff to read, no record.
  if (beforeWrite) beforeWrite({ diff, record, previous: Boolean(previous), note });
  const path = writeApprovedRecord(record, env);
  return { path, record, diff, previous: Boolean(previous), note };
}
