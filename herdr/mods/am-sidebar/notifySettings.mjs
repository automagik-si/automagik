// The `am notify` home settings: a small JSON file read once before stdin. It carries the
// operator's pause and stop switches and the quiet-hours window. Control precedence is
// stop > paused > quiet > running; an injected control read still wins over all of them.
//
//   { "paused": true, "stop": false, "quiet": { "from": "22:00", "to": "07:00" } }
//
// A missing file means running. A corrupt, unreadable, oversized or malformed file is refused by
// the CLI before it reads stdin: a bad setting must never silently deliver during quiet hours.
// Quiet uses the host's local clock: the from minute is inside, the to minute outside, a window
// with from > to wraps midnight, and from == to is empty (never quiet). Only the keys above are
// read; unknown keys are ignored so a newer writer can add them. Apache-2.0.

import { lstatSync, readFileSync } from "node:fs";

/** The settings file is small by design; a larger one is refused, never read whole. */
export const SETTINGS_MAX = 65536;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class NotifySettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotifySettingsError";
  }
}

function clockMinutes(text, field) {
  const match = typeof text === "string" ? TIME.exec(text) : null;
  if (!match) throw new NotifySettingsError(`${field} must be HH:MM between 00:00 and 23:59`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The settings an object holds, validated; throws NotifySettingsError on a malformed one. */
export function parseSettings(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NotifySettingsError("must be one JSON object");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NotifySettingsError("must be one JSON object");
  const settings = {};
  if ("paused" in raw) {
    if (typeof raw.paused !== "boolean") throw new NotifySettingsError("paused must be true or false");
    settings.paused = raw.paused;
  }
  if ("stop" in raw) {
    if (typeof raw.stop !== "boolean") throw new NotifySettingsError("stop must be true or false");
    settings.stop = raw.stop;
  }
  if ("quiet" in raw) {
    const quiet = raw.quiet;
    if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) throw new NotifySettingsError("quiet must be an object with from and to");
    settings.quiet = { from: clockMinutes(quiet.from, "quiet.from"), to: clockMinutes(quiet.to, "quiet.to") };
  }
  return settings;
}

/** The settings at `path`; a missing file is empty, every other read problem is an error. */
export function readNotifySettings(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new NotifySettingsError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  // The path must be a regular file, checked before any read: a FIFO would block before stdin, a
  // device could stream past the size cap, and a symlink (or a directory) is not a settings file.
  if (!stat.isFile()) throw new NotifySettingsError(`${path} must be a regular file (a FIFO, socket, device, directory or symlink is refused)`);
  if (!Number.isFinite(stat.size) || stat.size > SETTINGS_MAX) throw new NotifySettingsError(`is larger than ${SETTINGS_MAX} bytes`);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new NotifySettingsError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  return parseSettings(text);
}

/**
 * The control an `am notify` run takes at `at` (a Date, a date string or a number): "stopped"
 * when the stop switch is on, "paused" when paused or inside the quiet window, else "running".
 * An unusable clock falls back to the system one: quiet hours must not fail open.
 */
export function controlFor(settings, at) {
  if (settings.stop === true) return "stopped";
  if (settings.paused === true) return "paused";
  const quiet = settings.quiet;
  if (!quiet) return "running";
  let date;
  try {
    date = at instanceof Date ? at : new Date(at ?? Date.now());
  } catch {
    date = new Date();
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) date = new Date();
  const now = date.getHours() * 60 + date.getMinutes();
  const { from, to } = quiet;
  if (from === to) return "running";
  if (from < to) return now >= from && now < to ? "paused" : "running";
  return now >= from || now < to ? "paused" : "running";
}
