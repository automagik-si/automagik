// A worker reads only its Bot's publication in the physical team chosen at launch.
// See bots-dsh's skill-library.js, skill-library-rules.js and skill-check.js for the writer rules.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const KEY = "skill-review.key";
const IMPORT_MARK = "skill-library-imported";
const PUBLICATION_LINK = /^\.skill-review\.key\.publish-[a-f0-9-]{36}\.tmp$/;
const HEADING = "Your skills (load one with: am skill <name>):";
const COMPACT = "Your skills: run am skill to list them.";
const CATALOG_BYTES = 32 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const RESERVED = new Set([
  "side", "btw", "login", "model", "auth", "setup", "permission", "feedback", "compact",
  "clear", "resume", "restart", "help", "goal", "plan", "export", "upload",
]);

export const skillName = value => typeof value === "string" && value.length <= 32
  && /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(value) && value.trim() === value;
const hashOkay = value => typeof value === "string" && HASH.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validDescription = value => typeof value === "string" && value.trim() !== ""
  && value.length <= 200 && !/[\r\n\u0085\u2028\u2029]/u.test(value);
const wellFormed = value => typeof value === "string" && Buffer.from(value).toString("utf8") === value;
const sourceFile = name => typeof name === "string" && name.length <= 255 && basename(name) === name
  && !/[\\\p{Cc}\p{Cf}]/u.test(name) && /\.(?:md|markdown|txt)$/i.test(name);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes, ignoreBOM = true) => new TextDecoder("utf-8", { fatal: true, ignoreBOM }).decode(bytes);

export function textSkillMd({ name, description, content }) {
  const quoted = JSON.stringify(description ?? "").replace(/[\u2028\u2029\ufeff]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  return Buffer.from(`---\nname: ${name}\ndescription: ${quoted}\n---\n\n${content ?? ""}\n`);
}

export const skillMdHash = bytes => digest(JSON.stringify(["SKILL.md", bytes.byteLength, digest(bytes)]) + "\n");

function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("Unclosed quote");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/** The writer's two frontmatter forms, including its exact newline treatment for the body. */
function parseSkillMd(bytes) {
  const text = decode(bytes, false);
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)\n$/.exec(text);
  if (match && skillName(match[1])) {
    try {
      const description = JSON.parse(match[2]);
      if (typeof description === "string") return { name: match[1], description, body: match[3] };
    } catch { /* An imported file need not use the typed form. */ }
  }

  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n", 201);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 1 || end >= 200) return null;
  const fields = Object.create(null);
  for (let i = 1; i < end; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    const field = /^([\w-]+):\s*(.*?)\s*$/.exec(lines[i]);
    if (!field || Object.hasOwn(fields, field[1])) return null;
    const [, key, value] = field;
    const continued = [];
    while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !value && lines[i + 1].startsWith("- "))) {
      continued.push(lines[++i].trim());
    }
    if (value === ">" || value === "|") fields[key] = continued.join(value === ">" ? " " : "\n");
    else if (value.startsWith("[") && value.endsWith("]")) fields[key] = value.slice(1, -1).split(",").map(part => scalar(part.trim()));
    else if (!value && continued.every(part => part.startsWith("- ")) && continued.length) fields[key] = continued.map(part => scalar(part.slice(2)));
    else {
      if (continued.length) return null;
      fields[key] = scalar(value);
    }
  }
  return { name: fields.name, description: fields.description,
    body: normalized.split("\n").slice(end + 1).join("\n").replace(/^\n|\n$/g, "") };
}

function originalBytes(record) {
  if (record.frontmatter === undefined) return textSkillMd(record);
  if (record.source.kind === "file" && wellFormed(record.frontmatter)) return Buffer.from(record.frontmatter);
  return null;
}

export function teamHomes(env = process.env, home = homedir()) {
  const expand = value => value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const explicit = env.AUTOMAGIK_BOTS_HOME?.trim();
  if (explicit) return [resolve(expand(explicit))];
  const root = env.AUTOMAGIK_HOME?.trim() ? expand(env.AUTOMAGIK_HOME.trim()) : join(home, ".automagik");
  return [resolve(root, "desktop/bots"), resolve(root, "bots")];
}

const owned = (info, uid) => info.uid === BigInt(uid);
const privateMode = info => (info.mode & 0o077n) === 0n;
const privateDirectory = (info, uid) => info.isDirectory() && owned(info, uid) && privateMode(info);
const privateFile = (info, uid) => info.isFile() && owned(info, uid) && info.nlink === 1n && privateMode(info);
const snapshotFile = (info, uid) => info.isFile() && owned(info, uid) && info.nlink === 1n && (info.mode & 0o777n) === 0o444n;
const stat = (io, path) => io.lstatSync(path, { bigint: true, throwIfNoEntry: false });
const stamp = info => info && [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid, info.nlink].join(":");
const bad = (path, why) => new Error(`Bot skills at ${path}: ${why}`);
const empty = extra => ({ entries: [], changed: new Set(), ...extra });

function checked(path, info, test, uid, reason) {
  if (info && !test(info, uid)) throw bad(path, reason);
  return info;
}

function snapshotAt(path, botId, uid, readStat) {
  const skills = join(path, "skills");
  const bots = join(skills, ".bots");
  for (const dir of [skills, bots]) {
    if (!checked(dir, readStat(dir), privateDirectory, uid, "expected an owned private directory")) return null;
  }
  const file = join(bots, botId + ".json");
  const info = checked(file, readStat(file), snapshotFile, uid, "expected an owned 0444 file with one link");
  return info ? { file, info } : null;
}

export function bindWorkerSkillTeam(botId, { env = process.env, home = homedir(), uid = process.getuid?.(), fs: io = fs } = {}) {
  if (uid === undefined || typeof botId !== "string" || !BOT_ID.test(botId)) return {};
  const explicit = Boolean(env.AUTOMAGIK_BOTS_HOME?.trim());
  const teams = new Map();
  try {
    for (const candidate of teamHomes(env, home)) {
      let path;
      try { path = io.realpathSync(candidate); } catch (error) {
        if (error.code === "ENOENT" && !stat(io, candidate)) continue;
        throw error;
      }
      if (teams.has(path)) continue;
      const info = checked(path, stat(io, path), (entry, owner) => entry.isDirectory() && owned(entry, owner), uid,
        "expected an owned team directory");
      if (info && (explicit || snapshotAt(path, botId, uid, file => stat(io, file)))) {
        teams.set(path, { path, dev: String(info.dev), ino: String(info.ino) });
      }
    }
    if (teams.size > 1) return { warning: `Bot skills for ${botId}: more than one team has a publication (${[...teams.keys()].join(", ")}).` };
    return { team: teams.values().next().value };
  } catch (error) { return { warning: error.message }; }
}

/** A JSON file is accepted only from its checked descriptor and after the path recheck. */
function readJson(io, file, info, valid, uid) {
  const fd = io.openSync(file, READ_FLAGS);
  try {
    const opened = io.fstatSync(fd, { bigint: true });
    if (!valid(opened, uid) || stamp(opened) !== stamp(info)) throw bad(file, "changed while it was read");
    let bytes;
    try { bytes = io.readFileSync(fd); }
    finally {
      if (stamp(io.fstatSync(fd, { bigint: true })) !== stamp(info)) throw bad(file, "changed while it was read");
    }
    try { return JSON.parse(decode(bytes)); }
    catch { throw bad(file, "expected UTF-8 JSON"); }
  } finally { io.closeSync(fd); }
}

function snapshotEntries(data, botId, file) {
  const refuse = () => bad(file, "invalid Bot publication");
  if (!exactKeys(data, ["version", "botId", "skills"]) || data.version !== 1 || data.botId !== botId || !Array.isArray(data.skills)) throw refuse();
  const names = new Set();
  for (const entry of data.skills) {
    const automatic = entry?.mode === "automatic";
    if (!exactKeys(entry, automatic ? ["name", "mode", "hash", "description"] : ["name", "mode", "hash"])
        || (!automatic && entry.mode !== "manual") || !skillName(entry.name) || names.has(entry.name)
        || !hashOkay(entry.hash) || (automatic && !validDescription(entry.description))) throw refuse();
    names.add(entry.name);
  }
  return data.skills.filter(entry => entry.mode === "automatic");
}

function currentAssignments(list, skills) {
  const active = new Map();
  if (!Array.isArray(list)) return active;
  for (const item of list) {
    const name = typeof item === "string" ? item : item?.name;
    if (own(skills, name) === undefined) continue;
    active.set(name, item?.mode === "automatic" && !active.has(name) ? "automatic" : "manual");
  }
  return active;
}

function keyIsCurrent(io, path, key, snapshot, uid, readStat) {
  if (!key?.isFile() || !owned(key, uid) || !privateMode(key) || key.size !== 32n || key.ctimeNs >= snapshot.ctimeNs) return false;
  if (key.nlink === 1n) return true;
  if (key.nlink !== 2n) return false;
  return io.readdirSync(path).some(name => {
    if (!PUBLICATION_LINK.test(name)) return false;
    const link = readStat(join(path, name));
    return link?.isFile() && link.dev === key.dev && link.ino === key.ino;
  });
}

function reviewCurrent(record, hash, data) {
  const review = record.review;
  if ((data.reviewBlocks && Object.hasOwn(data.reviewBlocks, hash)) || record.check?.verdict === "block"
      || record.check?.truncated || review?.status !== "done" || review.hash !== hash || !hashOkay(record.reviewSeal)
      || !Array.isArray(review.findings) || review.findings.some(finding => !object(finding) || finding.area === "prompt-injection")) return false;
  return !(record.check?.verdict === "warn" || review.findings.length)
    || (record.accepted === hash && record.acceptedReview === digest(JSON.stringify(review)) && hashOkay(record.acceptanceSeal));
}

function currentEntries(data, botId, entries, name) {
  const result = empty();
  const assignments = currentAssignments(own(data.active, botId), data.skills);
  for (const entry of entries) {
    const record = own(data.skills, entry.name);
    if (assignments.get(entry.name) !== "automatic" || !object(record) || record.name !== entry.name
        || record.hash !== entry.hash || record.description !== entry.description || RESERVED.has(entry.name)
        || !["text", "file"].includes(record.source?.kind) || (record.source.kind === "file" && !sourceFile(record.source.fileName))
        || !reviewCurrent(record, entry.hash, data)) continue;
    const bytes = wellFormed(record.content) ? originalBytes(record) : null;
    let parsed = null;
    if (bytes && bytes.length <= 65536 && skillMdHash(bytes) === entry.hash) {
      try { parsed = parseSkillMd(bytes); } catch { /* Refused as changed below. */ }
    }
    if (!parsed || parsed.name !== entry.name || parsed.description !== entry.description || parsed.body !== record.content) {
      result.changed.add(entry.name);
      continue;
    }
    result.entries.push(entry);
    if (name === entry.name) result.body = record.content;
  }
  return result;
}

function readBoundTeam(team, botId, uid, io, readStat, name) {
  const { path, dev, ino } = team;
  const root = readStat(path);
  if (!root?.isDirectory() || !owned(root, uid) || String(root.dev) !== dev || String(root.ino) !== ino) return empty({ moved: true });
  const snapshot = snapshotAt(path, botId, uid, readStat);
  if (!snapshot) return empty();
  const entries = snapshotEntries(readJson(io, snapshot.file, snapshot.info, snapshotFile, uid), botId, snapshot.file);
  if (!entries.length) return empty();
  const library = join(path, "skill-library");
  if (!checked(library, readStat(library), privateDirectory, uid, "expected an owned private directory")) return empty();
  const file = join(library, "library.json");
  const info = checked(file, readStat(file), privateFile, uid, "expected an owned private file with one link");
  if (!info) return empty();
  const data = readJson(io, file, info, privateFile, uid);
  if (data?.version !== 1 || !object(data.skills) || !object(data.active)) throw bad(file, "invalid Skills library");
  const key = readStat(join(path, KEY));
  readStat(join(path, IMPORT_MARK));
  if (!keyIsCurrent(io, path, key, snapshot.info, uid, readStat)) return empty();
  return currentEntries(data, botId, entries, name);
}

/** The caller selects once and passes only that binding here for prompt, list and load. */
export function readWorkerSkills(botId, { team, name, uid = process.getuid?.(), fs: io = fs } = {}) {
  if (uid === undefined || typeof botId !== "string" || !BOT_ID.test(botId)) return empty();
  if (typeof team?.path !== "string" || !isAbsolute(team.path) || resolve(team.path) !== team.path
      || typeof team.dev !== "string" || !/^\d+$/.test(team.dev) || typeof team.ino !== "string" || !/^\d+$/.test(team.ino)) return empty({ moved: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen = new Map();
    const readStat = path => {
      const info = stat(io, path);
      seen.set(path, stamp(info));
      return info;
    };
    let result, warning;
    try { result = readBoundTeam(team, botId, uid, io, readStat, name); }
    catch (error) { warning = error.message; }
    try {
      if ([...seen].every(([path, before]) => stamp(stat(io, path)) === before)) return result ?? empty({ warning });
    } catch (error) { return empty({ warning: error.message }); }
  }
  return empty({ warning: bad(team.path, "changed while it was read").message });
}

export const workerSkillLines = entries => entries.map(({ name, description }) => `${name}: ${description}`);
const remainder = n => `${n} more: run am skill to list them all.`;

function catalogAt(lines, length) {
  return [HEADING, ...lines.slice(0, length), ...(length < lines.length ? [remainder(lines.length - length)] : [])].join("\n");
}

function boundedCatalogLength(lines) {
  let bytes = Buffer.byteLength(HEADING);
  if (lines.reduce((total, line) => total + 1 + Buffer.byteLength(line), bytes) <= CATALOG_BYTES) return lines.length;
  for (let i = 0; i < lines.length; i++) {
    const next = bytes + 1 + Buffer.byteLength(lines[i]);
    const left = lines.length - i - 1;
    if (next + (left ? 1 + Buffer.byteLength(remainder(left)) : 0) > CATALOG_BYTES) return i;
    bytes = next;
  }
  return lines.length;
}

export function workerSkillCatalog(entries) {
  const lines = workerSkillLines(entries);
  return lines.length ? catalogAt(lines, boundedCatalogLength(lines)) : "";
}

/** Choose a catalog against the exact serialized transport frame, with the original kept intact. */
export function fitWorkerSkillArgs(original, entries, serialize, fits) {
  if (!entries.length) return original;
  const lines = workerSkillLines(entries);
  const max = boundedCatalogLength(lines);
  const full = serialize(catalogAt(lines, max));
  if (fits(full)) return full;
  // Among shortened prefixes the remainder line can lose at most one digit with each added row.
  let low = 1, high = max - 1;
  let best = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = serialize(catalogAt(lines, length));
    if (fits(candidate)) { best = candidate; low = length + 1; }
    else high = length - 1;
  }
  if (best) return best;
  const compact = serialize(COMPACT);
  return fits(compact) ? compact : original;
}
