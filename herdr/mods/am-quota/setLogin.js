// This file marks a panel that sends its Claude slot edits through the accounts CLI.
import { sha256Hex } from "./sha256.js";

export const PANEL_MARKER = "mods/am-quota/setLogin.js";
export const SIDEBAR_MARKERS = Object.freeze([
  "mods/am-sidebar/accountsWrite.js", "mods/am-sidebar/bin/accounts.mjs", "mods/am-sidebar/bin/run.sh",
]);
export const SIDEBAR_VERSION = "mods/am-sidebar/VERSION";
export const WRITER_FILE = "data/am-quota/writer.json";
export const WRITER_MAX_BYTES = 64 * 1024;
const CODES = ["conflict", "bad-record", "no-slot", "in-use", "exists", "bad-folder", "home",
  "no-home", "update-first", "no-core", "wrong-core", "slot-changed", "timeout", "busy", "failed", "stale"];

export const snapshotOf = (text) => text === null ? "none" : sha256Hex(text);

export function setLoginArgs({ kind, id, dir }, snapshot) {
  return ["set-login", `--${kind}`, id, ...(kind === "add" ? ["--dir", dir] : []), "--snapshot", snapshot];
}

export function setLoginResult(result) {
  let answer;
  try { answer = JSON.parse(result?.stdout ?? ""); } catch { return { code: "failed" }; }
  if (result.code === 0 && answer?.ok === true && typeof answer.snapshot === "string" && /^[0-9a-f]{64}$/.test(answer.snapshot)) {
    return { ok: true, snapshot: answer.snapshot };
  }
  return { code: result.code === 1 && CODES.includes(answer?.error) ? answer.error : "failed" };
}
