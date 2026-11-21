// The Claude slot record's edits and the evidence that the panel uses the same writer.
import { DEFAULT_LOGIN, formProblem, parseLogins } from "./logins.js";
import { ID, matches, versionOkay } from "./accountsRows.js";
import { isHash, isHome, isMachine } from "./accountsPlanRecord.js";

export const WRITE_V = 1;
export const PANEL_MARKER = "mods/am-quota/setLogin.js";
export const SIDEBAR_MARKERS = Object.freeze([
  "mods/am-sidebar/accountsWrite.js", "mods/am-sidebar/bin/accounts.mjs", "mods/am-sidebar/bin/run.sh",
]);
export const SIDEBAR_VERSION = "mods/am-sidebar/VERSION";
export const WRITER_FILE = "data/am-quota/writer.json";
export const WRITER_MAX_BYTES = 64 * 1024;
export const SNAPSHOT = /^([0-9a-f]{64}|none)$/;
export const CODES = Object.freeze(["conflict", "bad-record", "no-slot", "in-use", "exists",
  "bad-folder", "home", "no-home", "update-first", "no-core", "wrong-core", "slot-changed",
  "timeout", "busy", "failed", "stale"]);

const PANELS = ["on", "off", "absent", "unknown"];

export function writerQualified(writer, write) {
  if (write !== true || writer?.setLogin !== true || !PANELS.includes(writer.panel)
    || !["panelWrites", "sidebarWrites", "confirmed"].every((key) => typeof writer[key] === "boolean")
    || Object.keys(writer).length !== 5) return false;
  return writer.panel === "off" || writer.panel === "absent"
    || (writer.panel === "on" && writer.panelWrites && writer.sidebarWrites && writer.confirmed);
}

function panelKind(on, off) {
  if (on === "dir") return "on";
  if (on !== "none") return "unknown";
  const disabled = off();
  return disabled === "dir" ? "off" : disabled === "none" ? "absent" : "unknown";
}

function panelConfirmed(text, version) {
  if (!versionOkay(version)) return false;
  let record;
  try { record = JSON.parse(text); } catch { return false; }
  return record?.v === WRITE_V && record.setLogin === true && record.version === version
    && Object.keys(record).length === 3;
}

export function writerCapability(home, io, write = true) {
  const at = (file) => `${home}/${file}`;
  const panel = panelKind(io.dir(at("mods/am-quota")), () => io.dir(at("mods-disabled/am-quota")));
  const writer = {
    setLogin: true, panel,
    panelWrites: io.readable(at(PANEL_MARKER)) === "yes",
    sidebarWrites: SIDEBAR_MARKERS.every((file) => io.readable(at(file)) === "yes"),
    confirmed: panelConfirmed(io.readText(at(WRITER_FILE)), io.readText(at(SIDEBAR_VERSION))?.split(/\r?\n/, 1)[0]),
  };
  return { writer, qualified: writerQualified(writer, write) };
}

/** The next slot's folder, using the same numbering rule as the Accounts panel. */
export function nextSlotDir(home, logins) {
  for (let n = 2; ; n += 1) {
    const dir = `${home.replace(/\/+$/, "")}/.claude-${n}`;
    if (!logins.some((login) => login.id === String(n) || login.dir === dir)) return dir;
  }
}

export function loginEdit(text, { kind, id, dir }, io) {
  const record = text === null ? { use: DEFAULT_LOGIN, logins: [] } : parseLogins(text);
  if (record.problem) return { error: "bad-record" };
  const { use } = record;
  let { logins } = record;
  const listed = logins.some((login) => login.id === id);
  if (kind === "use") {
    if (id !== DEFAULT_LOGIN && !listed) return { error: "no-slot" };
    const original = text === null ? record : JSON.parse(text);
    return { use: id, text: `${JSON.stringify({ ...original, use: id }, null, 2)}\n` };
  } else if (kind === "add") {
    if (!matches(ID, id) || id === DEFAULT_LOGIN || listed || logins.some((login) => login.dir === dir)) {
      return { error: "exists" };
    }
    if (formProblem(dir, io)) return { error: "bad-folder" };
    logins.push({ id, dir });
  } else if (kind === "remove") {
    if (!listed) return { error: "no-slot" };
    if (id === use) return { error: "in-use" };
    logins = logins.filter((login) => login.id !== id);
  } else return { error: "failed" };
  return { use, text: `${JSON.stringify({ use, logins }, null, 2)}\n` };
}

export function setLoginOp(opts) {
  const { dir, snapshot, "expect-home": home, "expect-core": core,
    "expect-slot": slotDigest, "expect-eff": effDigest, "expect-rev": rev,
    "attempt": number, dispatch, "cancel-attempt": cancel, "launch-login": launch, "project-home": projectHome } = opts;
  if (launch) {
    if (!isHome(home) || !isMachine(core) || Object.keys(opts).some((key) =>
      !["json", "launch-login", "project-home", "expect-home", "expect-core"].includes(key))) return { usage: true };
    return { op: { kind: "launch", home, core, projectHome } };
  }
  if (projectHome) return { usage: true };
  const integer = (value) => matches(/^(0|[1-9][0-9]*)$/, value) && Number.isSafeInteger(Number(value));
  const linked = [rev, number, dispatch].some((value) => value !== undefined);
  if (linked && (!isHome(home) || !isMachine(core) || !integer(rev) || !integer(number) || Number(number) < 1
    || !matches(/^[a-f0-9]{32}$/, dispatch))) return { usage: true };
  const attempt = linked ? { rev: Number(rev), n: Number(number), dispatch } : undefined;
  if (cancel) {
    if (!attempt || [opts.use, opts.add, opts.remove, dir, snapshot, slotDigest, effDigest].some((v) => v !== undefined)) {
      return { usage: true };
    }
    return { op: { kind: "cancel", home, core, attempt } };
  }
  const kinds = ["use", "add", "remove"].filter((kind) => opts[kind] !== undefined);
  const [kind] = kinds;
  const id = opts[kind];
  if (kinds.length !== 1 || !matches(ID, id) || !matches(SNAPSHOT, snapshot)
    || (kind === "add" ? !isHome(dir) : dir !== undefined)
    || (home !== undefined && !isHome(home))
    || (core !== undefined && (!isMachine(core) || kind !== "use"))
    || (slotDigest !== undefined && (kind !== "use" || !isHash(slotDigest)))
    || (effDigest !== undefined && (kind !== "use" || !isHash(effDigest)))
    || (core !== undefined && (!attempt || !isHash(slotDigest) || !isHash(effDigest)))) return { usage: true };
  return { op: { kind, id, dir, snapshot, home, core, slotDigest, effDigest, ...(attempt ? { attempt } : {}) } };
}
