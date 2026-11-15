// Bot definitions over plain data: the `.herdr/bots.json` schema, its validation, the
// project key (DESIGN Decision 15), a member's effective lead (A1), bot ids (A9) and the
// default look. Pure: no `herdr`, `gpui-kit`, `gpui-base` or `fs`, so `node --test` runs it.
// Apache-2.0.

import { AGY_MODES, LEGACY_AGENTS, agyRuleProblem, normalizeAgyPermissions } from "./models.js";
import { hermesPairProblem, hermesPairConflict } from "./hermesPair.js";

/** The hc label key that ties a terminal to a bot; its value is the bot id (A9). */
export const BOT_LABEL = "bot";
/** The longest `instructions` a bot may carry. */
export const MAX_INSTRUCTIONS = 4000;
/** A project's definitions file, relative to its key folder. */
export const BOTS_PATH = ".herdr/bots.json";
export const KINDS = ["main", "member"];
/**
 * A bot's rank (A16): a closed set, for the pane's `role=` label the event meter reads. The
 * free-text `role` stays for the briefing. Optional. `main` is not a rank: role=main is the
 * main bot's alone, derived from its kind.
 */
export const RANKS = ["captain", "dev", "tester", "reviewer", "fixer", "integrator", "pm", "owner"];
/** A category id: a lowercase slug, as it goes into a pane's `category=` label (A16). */
export const CATEGORY_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Automagik's characters and colours, by name (apps/bots-dsh/src/client/characters.js and
// inks.js). Only the names: the drawing comes with the characters themselves (Group 3).
export const CHARACTERS = ["whale", "octopus", "star", "moon", "wave", "squircle", "zed", "hex", "gumdrop", "peanut",
  "saucer", "bunny", "kitty", "beacon", "plus", "magnet", "acorn", "pebbles", "cushion", "ring", "gem"];
export const COLOURS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray",
  "aurora", "deepseek", "charcoal", "graphite", "rose", "sky", "tangerine", "cobalt"];
const DEFAULT_CHARACTERS = ["star", "moon", "gumdrop", "peanut", "bunny", "kitty", "acorn"];
const DEFAULT_COLOURS = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta"];

// RFC 4648 base32, lowercase.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const ID_SHAPE = /^b-[a-z2-7]{10}$/;

/** `b-` plus 10 random lowercase base32 characters. `random` returns [0, 1). */
export function newBotId(random = Math.random) {
  let id = "b-";
  for (let i = 0; i < 10; i += 1) id += BASE32[Math.floor(random() * 32) % 32];
  return id;
}

// The same hash Automagik's lookOf() uses for a Bot with no stored look (FNV-1a, then
// mulberry32 for the colour and murmur3's fmix32 for the shape), so a bot id gets the
// same default character and colour here as there.
function fnv1a(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** A stable `{ character, colour }` for a bot id. */
export function defaultLook(botId) {
  const id = String(botId);
  const t = (fnv1a(id) + 1831565813) | 0;
  let n = Math.imul(t ^ (t >>> 15), 1 | t);
  n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
  const colour = DEFAULT_COLOURS[Math.floor((((n ^ (n >>> 14)) >>> 0) / 4294967296) * DEFAULT_COLOURS.length)];
  let v = fnv1a(id) | 0;
  v = Math.imul(v ^ (v >>> 16), 73244475);
  v = Math.imul(v ^ (v >>> 13), 3266489909);
  const character = DEFAULT_CHARACTERS[((v ^ (v >>> 16)) >>> 0) % DEFAULT_CHARACTERS.length];
  return { character, colour };
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isText = (x) => typeof x === "string" && x.trim() !== "";
const isWave = (x) => Number.isInteger(x) && x > 0;

/** An hc template name (a file in herdr-core's templates folder): no dash first, no spaces. */
export const TEMPLATE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The worker fields a bot may set (`worker: { agent?, model?, effort?, template?, agyMode? }`), each optional text. */
export const WORKER_FIELDS = ["agent", "model", "effort", "template", "agyMode"];

/**
 * Why a bot's `worker` (its workers' defaults) can't be used, or null when it is absent or
 * fine: an object whose agent, model, effort, template and agyMode, where given, are non-empty
 * text, none starting with a dash, and whose template is an hc template name (TEMPLATE_SHAPE).
 * An agyMode value is checked by checkBots and at a worker's start (workers.js workerPlan),
 * never silently defaulted. Other keys in it are kept as they are.
 */
export function workerProblem(worker) {
  if (worker === undefined) return null;
  if (!isObject(worker)) return "worker is not an object";
  const bad = WORKER_FIELDS.filter((k) => worker[k] !== undefined && !isText(worker[k]));
  if (bad.length) return `worker ${bad.join(", ")} not text`;
  const dashed = WORKER_FIELDS.filter((k) => typeof worker[k] === "string" && worker[k].trimStart().startsWith("-"));
  if (dashed.length) return `worker ${dashed.join(", ")} starts with a dash (an agent would read it as an option)`;
  if (worker.template !== undefined && !TEMPLATE_SHAPE.test(worker.template)) {
    return `worker template "${worker.template}" isn't an hc template name (letters, digits, ".", "_" and "-")`;
  }
  return swapProblem(worker.swap);
}

/** The fields of a bot's swap arm (`worker.swap`), the other agent, model or effort its planned swaps run. */
export const SWAP_FIELDS = ["agent", "model", "effort"];
const EFFORT_LIKE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Why a `worker.swap` can't be used, or null when it is absent or fine: an object with at
 * least one of agent, model and effort, each non-empty text not starting with a dash (an
 * effort as the agents spell one), and nothing else (a template never swaps).
 */
export function swapProblem(swap) {
  if (swap === undefined) return null;
  if (!isObject(swap)) return "worker swap is not an object";
  const other = Object.keys(swap).filter((k) => !SWAP_FIELDS.includes(k));
  if (other.length) return `worker swap takes only agent, model and effort, not ${other.join(", ")}`;
  if (!SWAP_FIELDS.some((k) => swap[k] !== undefined)) return "worker swap names no agent, model or effort";
  const bad = SWAP_FIELDS.filter((k) => swap[k] !== undefined && !isText(swap[k]));
  if (bad.length) return `worker swap ${bad.join(", ")} not text`;
  const dashed = SWAP_FIELDS.filter((k) => typeof swap[k] === "string" && swap[k].trimStart().startsWith("-"));
  if (dashed.length) return `worker swap ${dashed.join(", ")} starts with a dash (an agent would read it as an option)`;
  return swap.effort !== undefined && !EFFORT_LIKE.test(swap.effort) ? `worker swap effort "${swap.effort}" isn't an effort level` : null;
}

/**
 * The indentation `text` was written with: its first indented line's, none for one line
 * (the shared registry's rule, apps/bots-dsh/src/shared/registry.js indentOf).
 */
export function indentOf(text) {
  const found = /\n([ \t]+)\S/.exec(String(text ?? ""));
  if (found) return found[1];
  return String(text ?? "").trim().includes("\n") ? "  " : "";
}

/**
 * A bots.json text for `raw`, indented as `like` is (the text the edit started from; a project's
 * formatter may want tabs, #230), two spaces for a new file (`like` null), with a final newline.
 */
export const botsText = (raw, like = null) => `${JSON.stringify(raw, null, like === null ? "  " : indentOf(like))}\n`;

/**
 * Reads a definitions file for showing it. Throws when the text is not a version-1 file
 * at all (not JSON, no `bots` array, another version). Inside it, an entry with no usable
 * id or name, a repeated id or an unknown kind is left out; anything else is kept and
 * named in `warnings` (a long instructions text, a missing agent, an unknown look name,
 * a second main bot: the first one counts). A retired agent (models.js LEGACY_AGENTS, as
 * `gemini`) is read as its replacement, with a warning; a model pin made for it (the bot's
 * `model`, or `worker.model` when its workers ran it) is dropped, since the replacement
 * doesn't take it. `raw` is the file exactly as read, a separate
 * copy: edit that one to write the file back (bots.js writeBots), so entries left out of
 * `file` survive.
 */
export function parseBots(text) {
  const raw = JSON.parse(text);
  if (!isObject(raw)) throw new Error("bots.json: not an object");
  if (raw.version !== 1) throw new Error(`bots.json: version ${JSON.stringify(raw.version)}, expected 1`);
  if (!Array.isArray(raw.bots)) throw new Error("bots.json: no bots list");
  const warnings = [];
  const categories = [];
  for (const c of Array.isArray(raw.categories) ? raw.categories : []) {
    if (!isObject(c) || !isText(c.id) || typeof c.title !== "string") { warnings.push("a category with no id or title is left out"); continue; }
    if (categories.some((k) => k.id === c.id)) { warnings.push(`category ${c.id} is listed twice; the first counts`); continue; }
    if (!CATEGORY_ID.test(c.id)) warnings.push(`category ${JSON.stringify(c.id)}: an id is a lowercase slug (a-z, 0-9, single dashes); it gets no pane label`);
    const cat = { ...c };
    if (cat.sub !== undefined && typeof cat.sub !== "string") delete cat.sub;
    categories.push(cat);
  }
  const bots = [];
  raw.bots.forEach((b, i) => {
    const where = isObject(b) && isText(b.id) ? b.id : `entry ${i + 1}`;
    if (!isObject(b) || !isText(b.id)) return warnings.push(`${where}: no id, left out`);
    if (bots.some((k) => k.id === b.id)) return warnings.push(`${where}: id used twice, left out`);
    if (!isText(b.name)) return warnings.push(`${where}: no name, left out`);
    if (!KINDS.includes(b.kind)) return warnings.push(`${where}: unknown kind ${JSON.stringify(b.kind)}, left out`);
    const bot = { ...b };
    if (bot.code !== undefined && typeof bot.code !== "boolean") {
      warnings.push(`${where}: code is not a boolean; ignored`);
      delete bot.code;
    }
    if (bot.hcProxy !== undefined && typeof bot.hcProxy !== "boolean") {
      warnings.push(`${where}: hcProxy is not a boolean; ignored`);
      delete bot.hcProxy;
    }
    // Codex's auto mode switch (#946). Since #1125 (the owner's ruling: every Codex seat and
    // worker runs in auto mode with its sandbox on) false no longer opts out: kept as written,
    // ignored, and said once here.
    if (bot.codexAuto !== undefined && typeof bot.codexAuto !== "boolean") {
      warnings.push(`${where}: codexAuto is not a boolean; ignored`);
      delete bot.codexAuto;
    }
    if (bot.codexAuto === false) {
      warnings.push(`${where}: codexAuto false no longer opts out: every Codex seat and worker runs in auto mode `
        + "(--approve-for-me) with its sandbox on (#1125); remove the field");
    }
    if (!ID_SHAPE.test(bot.id)) warnings.push(`${where}: id is not b- plus 10 base32 characters`);
    if (typeof bot.role !== "string") { if (bot.role !== undefined) warnings.push(`${where}: role is not text`); bot.role = ""; }
    if (typeof bot.instructions !== "string") { if (bot.instructions !== undefined) warnings.push(`${where}: instructions are not text`); bot.instructions = ""; }
    if (bot.instructions.length > MAX_INSTRUCTIONS) warnings.push(`${where}: instructions longer than ${MAX_INSTRUCTIONS} characters`);
    if (!isObject(bot.look) || typeof bot.look.character !== "string" || typeof bot.look.colour !== "string") {
      warnings.push(`${where}: no look, the default is used`);
      bot.look = defaultLook(bot.id);
    } else {
      if (!CHARACTERS.includes(bot.look.character)) warnings.push(`${where}: unknown character ${bot.look.character}`);
      if (!COLOURS.includes(bot.look.colour)) warnings.push(`${where}: unknown colour ${bot.look.colour}`);
    }
    if (bot.planned !== undefined && (!isObject(bot.planned) || !isWave(bot.planned.wave))) {
      warnings.push(`${where}: planned needs a positive whole wave; ignored`);
      delete bot.planned;
    }
    if (bot.agent !== undefined && !isText(bot.agent)) delete bot.agent;
    if (!bot.agent && !bot.planned) warnings.push(`${where}: no coding agent`);
    if (bot.model !== undefined && typeof bot.model !== "string") delete bot.model;
    // Antigravity's launch mode: kept when it is text, even an unknown one, so a start refuses
    // it by name instead of silently launching on the default.
    if (bot.agyMode !== undefined) {
      if (bot.agyMode === "") delete bot.agyMode;
      else if (typeof bot.agyMode !== "string") { warnings.push(`${where}: agyMode is not text; ignored`); delete bot.agyMode; }
      else if (!AGY_MODES.includes(bot.agyMode)) warnings.push(`${where}: agyMode ${JSON.stringify(bot.agyMode)} isn't one of ${AGY_MODES.join(", ")}`);
    }
    // Antigravity's permission additions (#823): a malformed shape is dropped whole; a bad rule
    // is dropped on its own, with a warning, so nothing junk reaches agy.
    if (bot.agyPermissions !== undefined) {
      const normalized = normalizeAgyPermissions(bot.agyPermissions);
      if (!isObject(bot.agyPermissions)) {
        warnings.push(`${where}: ${normalized.problems[0]}; ignored`);
        delete bot.agyPermissions;
      } else {
        for (const why of normalized.problems) warnings.push(`${where}: agyPermissions: ${why}`);
        if (normalized.allow.length || normalized.deny.length) bot.agyPermissions = { allow: normalized.allow, deny: normalized.deny };
        else delete bot.agyPermissions;
      }
    }
    if (isObject(bot.worker) && bot.worker.agyMode === "") {
      bot.worker = { ...bot.worker };
      delete bot.worker.agyMode;
    }
    const workerWhy = workerProblem(bot.worker);
    if (workerWhy) { warnings.push(`${where}: ${workerWhy}; ignored`); delete bot.worker; }
    else if (isObject(bot.worker) && typeof bot.worker.agyMode === "string" && !AGY_MODES.includes(bot.worker.agyMode)) {
      warnings.push(`${where}: worker agyMode ${JSON.stringify(bot.worker.agyMode)} isn't one of ${AGY_MODES.join(", ")}`);
    }
    const retired = (k) => (typeof k === "string" && Object.hasOwn(LEGACY_AGENTS, k) ? k : null);
    const seatOld = retired(bot.agent);
    const workerOld = isObject(bot.worker) ? retired(bot.worker.agent) ?? (bot.worker.agent ? null : seatOld) : null;
    const old = seatOld ?? workerOld;
    if (old) {
      const dropped = [];
      if (seatOld) {
        bot.agent = LEGACY_AGENTS[seatOld];
        if (bot.model) { dropped.push(`model pin ${bot.model}`); delete bot.model; }
      }
      if (workerOld) {
        const w = { ...bot.worker };
        if (w.agent) w.agent = LEGACY_AGENTS[w.agent];
        if (w.model) { dropped.push(`worker model ${w.model}`); delete w.model; }
        bot.worker = w;
      }
      const tail = dropped.length ? ` (${dropped.join(" and ")} dropped)` : "";
      warnings.push(`${where}: agent ${old} is retired; it runs on ${LEGACY_AGENTS[old]}${tail}`);
    }
    if (bot.rank !== undefined && !RANKS.includes(bot.rank)) {
      warnings.push(`${where}: unknown rank ${JSON.stringify(bot.rank)}; ignored (one of ${RANKS.join(", ")})`);
      delete bot.rank;
    }
    if (bot.leadProject !== undefined) {
      if (!isText(bot.leadProject)) {
        warnings.push(`${where}: leadProject is not text; ignored`);
        delete bot.leadProject;
      } else {
        const clean = trimSlash(bot.leadProject.trim());
        if (!clean.startsWith("/")) {
          warnings.push(`${where}: leadProject must be an absolute folder path; ignored`);
          delete bot.leadProject;
        } else {
          bot.leadProject = clean;
        }
      }
    }
    if (bot.lead !== undefined && !isText(bot.lead)) delete bot.lead;
    if (bot.leadProject !== undefined && !isText(bot.lead)) {
      warnings.push(`${where}: leadProject without lead; ignored`);
      delete bot.leadProject;
    }
    if (bot.kind === "main" && bot.lead !== undefined && !bot.leadProject) {
      warnings.push(`${where}: a main bot has no lead; ignored`);
      delete bot.lead;
    }
    if (bot.crossMembers !== undefined || bot.members !== undefined) {
      const rawCross = bot.crossMembers !== undefined ? bot.crossMembers : bot.members;
      delete bot.members;
      if (!Array.isArray(rawCross)) {
        warnings.push(`${where}: crossMembers is not a list; ignored`);
        delete bot.crossMembers;
      } else {
        const keptCross = [];
        const seenCross = new Set();
        rawCross.forEach((m, idx) => {
          if (!isObject(m) || !isText(m.id) || !ID_SHAPE.test(m.id)) {
            warnings.push(`${where}: crossMembers[${idx}] entry must have a bot id (b- plus 10 base32 characters); ignored`);
            return;
          }
          const cleanProj = cleanProjectPath(m.project);
          if (!cleanProj.startsWith("/")) {
            warnings.push(`${where}: crossMembers[${idx}] entry must have an absolute folder path; ignored`);
            return;
          }
          const key = `${cleanProj}\0${m.id}`;
          if (seenCross.has(key)) return;
          seenCross.add(key);
          keptCross.push({ id: m.id, project: cleanProj });
        });
        if (keptCross.length) bot.crossMembers = keptCross;
        else delete bot.crossMembers;
      }
    }
    if (bot.category !== undefined && !categories.some((c) => c.id === bot.category)) warnings.push(`${where}: unknown category ${bot.category}`);
    bots.push(bot);
  });
  const mains = bots.filter((b) => b.kind === "main");
  if (mains.length === 0) warnings.push("no main bot");
  if (mains.length > 1) warnings.push(`${mains.length} main bots; ${mains[0].id} counts`);
  const file = { ...raw, version: 1, categories, bots };
  for (const b of bots) {
    if (b.leadProject) {
      const tail = b.kind === "main" || !mains[0] ? "" : "; reports to the main bot";
      if (!ID_SHAPE.test(b.lead)) warnings.push(`${b.id}: lead ${b.lead} in ${b.leadProject} is missing${tail}`);
      else if (b.lead === b.id) warnings.push(`${b.id}: lead ${b.lead} in ${b.leadProject} leads back to this bot${tail}`);
      continue;
    }
    if (b.kind !== "member") continue;
    const { warning } = effectiveLead(file, b.id);
    if (warning) warnings.push(`${b.id}: ${warning}`);
  }
  return { file, warnings, raw: JSON.parse(text) };
}

/** The project's main bot: the first `kind: "main"` entry, or null. */
export function mainBotOf(file) {
  return file.bots.find((b) => b.kind === "main") ?? null;
}

/** A normalized project folder path (without trailing slash, except "/"), or "". */
export const cleanProjectPath = (p) => (typeof p === "string" && p.trim() ? trimSlash(p.trim()) : "");

/** Normalized `{ id, project }` cross-project members listed on `bot` (`crossMembers` or `members`). */
export function crossMembersOf(bot) {
  if (!isObject(bot)) return [];
  const raw = Array.isArray(bot.crossMembers)
    ? bot.crossMembers
    : Array.isArray(bot.members) ? bot.members : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isObject(item) || !ID_SHAPE.test(item.id ?? "")) continue;
    const proj = cleanProjectPath(item.project);
    if (!proj.startsWith("/")) continue;
    const key = `${proj}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, project: proj });
  }
  return out;
}

/** Whether `leadBot` reciprocally lists `{ id: memberId, project: memberProject }` in `crossMembers`. */
export function hasCrossMember(leadBot, memberId, memberProject) {
  const cleanProj = cleanProjectPath(memberProject);
  if (!leadBot || !isText(memberId) || !cleanProj) return false;
  return crossMembersOf(leadBot).some((m) => m.id === memberId && m.project === cleanProj);
}

/** Warnings for one-sided or unresolvable `crossMembers` entries on `botId` in `file`. */
export function crossMemberWarnings(file, botId, { project = null, projects = null } = {}) {
  const bot = file?.bots?.find((b) => b.id === botId);
  const list = crossMembersOf(bot);
  if (!bot || !list.length) return [];
  const ownProject = inferProjectOf(file, botId, project, projects);
  if (!projects) {
    return list.map((m) => `crossMember ${m.id} in ${m.project} is unverified (project ${m.project} has no roster)`);
  }
  const out = [];
  for (const m of list) {
    if (ownProject && m.project === ownProject) {
      out.push(`crossMember ${m.id} in ${m.project} is in this bot's own project`);
      continue;
    }
    const memberFile = projectFileOf(projects, m.project);
    if (!memberFile) {
      out.push(`crossMember ${m.id} in ${m.project} is missing (project ${m.project} has no roster)`);
      continue;
    }
    const memberBot = memberFile.bots?.find((b) => b.id === m.id);
    if (!memberBot) {
      out.push(`crossMember ${m.id} in ${m.project} is missing`);
      continue;
    }
    if (memberBot.planned) {
      out.push(`crossMember ${m.id} in ${m.project} is planned`);
      continue;
    }
    const memberLeadProj = isText(memberBot.leadProject) ? cleanProjectPath(memberBot.leadProject) : "";
    if (memberBot.lead !== bot.id || !ownProject || memberLeadProj !== ownProject) {
      out.push(`crossMember ${m.id} in ${m.project} is one-sided (${m.id} in ${m.project} does not name ${bot.id} in ${ownProject || "this project"} as its lead)`);
    }
  }
  return out;
}

/** All `[cleanKey, BotsFile]` entries from a `projects` Map, array, or plain object. */
export function projectEntriesOf(projects) {
  if (!projects) return [];
  const out = [];
  const add = (k, v) => {
    const key = cleanProjectPath(k);
    const file = Array.isArray(v?.bots) ? v : Array.isArray(v?.file?.bots) ? v.file : null;
    if (key && file) out.push([key, file]);
  };
  if (projects instanceof Map) {
    for (const [k, v] of projects.entries()) add(k, v);
  } else if (Array.isArray(projects)) {
    for (const p of projects) add(p?.key ?? p?.project, p);
  } else if (typeof projects === "object") {
    for (const [k, v] of Object.entries(projects)) add(k, v);
  }
  return out;
}

/** Looks up a project's `BotsFile` in `projects` (Map, array, plain object, or resolver fn). */
export function projectFileOf(projects, folder) {
  if (!projects || !folder) return null;
  const key = cleanProjectPath(folder);
  if (!key) return null;
  if (typeof projects === "function") {
    const hit = projects(key) ?? projects(folder);
    return Array.isArray(hit?.bots) ? hit : Array.isArray(hit?.file?.bots) ? hit.file : null;
  }
  for (const [k, file] of projectEntriesOf(projects)) {
    if (k === key) return file;
  }
  return null;
}

export function inferProjectOf(file, botId, project, projects) {
  const given = cleanProjectPath(project);
  if (given) return given;
  if (!projects) return "";
  const entries = projectEntriesOf(projects);
  const byRef = entries.find(([, f]) => f === file);
  if (byRef) return byRef[0];
  const mainId = file ? mainBotOf(file)?.id : null;
  const byBot = entries.find(([, f]) => (mainId && mainBotOf(f)?.id === mainId) || f.bots?.some((b) => b.id === botId));
  return byBot ? byBot[0] : "";
}

export function leadsBackTo(startProj, startFile, startBot, originProj, originId, projects, { includePlanned = false } = {}) {
  const seen = new Set();
  let curProj = startProj;
  let curFile = startFile;
  let curBot = startBot;
  while (curBot && curFile) {
    if (curBot.id === originId && (!originProj || !curProj || curProj === originProj)) return true;
    const key = `${curProj ?? ""}\0${curBot.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (curBot.planned && !includePlanned) return false;
    const curMain = mainBotOf(curFile);
    const nextCross = isText(curBot.leadProject) ? cleanProjectPath(curBot.leadProject) : "";
    if (nextCross && (!curProj || nextCross !== curProj)) {
      if (!projects || !isText(curBot.lead)) return false;
      const nextFile = projectFileOf(projects, nextCross);
      const nextBot = nextFile?.bots?.find((b) => b.id === curBot.lead);
      if (!nextBot || (nextBot.planned && !includePlanned)) {
        if (curBot === curMain || !curMain) return false;
        curBot = curMain;
        continue;
      }
      curProj = nextCross;
      curFile = nextFile;
      curBot = nextBot;
      continue;
    }
    if (curBot === curMain || curBot.kind === "main") return false;
    const nextId = curBot.lead ?? curMain?.id;
    if (!nextId) return false;
    curBot = curFile.bots?.find((b) => b.id === nextId);
  }
  return false;
}

/**
 * Whom a bot reports to (A1): its `lead`, else the main bot. A lead that is missing,
 * planned, not a counting bot, or that leads back to this bot falls back to the main bot
 * with a warning. The main bot itself, an unknown id, or a file with no main bot: "".
 * When a bot (`member` or `main`) has `leadProject`, its lead is resolved in that project
 * when `projects` is given, returning `{ lead, leadProject, leadBot }`, or falling back
 * to the main bot (for a member) or `""` (for a main bot) with a warning when invalid.
 */
export function effectiveLead(file, botId, { project = null, projects = null } = {}) {
  const main = mainBotOf(file);
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot) return { lead: "", warning: `no bot ${botId}` };
  const ownProject = inferProjectOf(file, botId, project, projects);
  const targetProject = isText(bot.leadProject) ? cleanProjectPath(bot.leadProject) : "";
  if (targetProject && ownProject && targetProject === ownProject && (bot === main || bot.kind === "main")) {
    return { lead: "", warning: `lead ${bot.lead} in ${targetProject}: a main bot has no lead in its own project` };
  }
  if (targetProject && (!ownProject || targetProject !== ownProject)) {
    const crossFallback = (why) => (bot === main || bot.kind === "main" || !main
      ? { lead: "", warning: `lead ${bot.lead} in ${targetProject} ${why}` }
      : { lead: main.id, warning: `lead ${bot.lead} in ${targetProject} ${why}; reports to the main bot` });
    if (!targetProject.startsWith("/") || !isText(bot.lead) || !ID_SHAPE.test(bot.lead)) return crossFallback("is missing");
    if (bot.lead === bot.id) return crossFallback("leads back to this bot");
    if (!projects) return crossFallback(`is unverified (project ${targetProject} has no roster)`);
    const targetFile = projectFileOf(projects, targetProject);
    if (!targetFile) return crossFallback(`is missing (project ${targetProject} has no roster)`);
    const targetBot = targetFile.bots?.find((b) => b.id === bot.lead);
    if (!targetBot) return crossFallback("is missing");
    if (targetBot.planned) return crossFallback("is planned");
    const targetMain = mainBotOf(targetFile);
    if (targetBot.kind === "main" && targetBot !== targetMain) return crossFallback("is not the counting main bot");
    if (leadsBackTo(targetProject, targetFile, targetBot, ownProject, bot.id, projects)) {
      return crossFallback("leads back to this bot");
    }
    if (!ownProject || !hasCrossMember(targetBot, bot.id, ownProject)) {
      return crossFallback(`is one-sided (${targetBot.id} in ${targetProject} does not list ${bot.id}${ownProject ? ` from ${ownProject}` : ""} in crossMembers)`);
    }
    return { lead: targetBot.id, leadProject: targetProject, leadBot: targetBot };
  }
  if (!main) return { lead: "", warning: "no main bot" };
  if (bot === main) return { lead: "" };
  const byId = new Map(file.bots.map((b) => [b.id, b]));
  const leadOf = (b) => b.lead ?? main.id;
  const first = leadOf(bot);
  const fallback = (why) => ({ lead: main.id, warning: `lead ${first} ${why}; reports to the main bot` });
  if (first === main.id) {
    if (projects && main.leadProject && leadsBackTo(ownProject, file, main, ownProject, bot.id, projects)) {
      return fallback("leads back to this bot");
    }
    return { lead: main.id };
  }
  const target = byId.get(first);
  if (!target) return fallback("is missing");
  if (target.planned) return fallback("is planned");
  if (target.kind === "main") return fallback("is not the counting main bot");
  if (projects && leadsBackTo(ownProject, file, target, ownProject, bot.id, projects)) {
    return fallback("leads back to this bot");
  }
  // Follow the chain up: back to this bot is a cycle. A chain that breaks further up
  // (missing, planned, a cycle not through this bot) ends at the main bot there instead.
  const seen = new Set([bot.id]);
  for (let cur = target; cur && cur !== main && cur.kind !== "main" && !cur.planned;) {
    if (seen.has(cur.id)) return cur.id === bot.id ? fallback("leads back to this bot") : { lead: first };
    seen.add(cur.id);
    if (cur.leadProject && (!ownProject || cleanProjectPath(cur.leadProject) !== ownProject)) break;
    cur = byId.get(leadOf(cur));
  }
  return { lead: first };
}

/**
 * A bot's squad (RFC 0021 (e)): the id of the bot heading its chain of effective leads, the
 * last one before the main bot. A bot that reports to the main bot directly is its own squad,
 * whether it leads others or not. Null for the main bot, an unknown id, a file with no main bot,
 * and a chain that can't be followed to the main bot: a lead that is missing or planned (where
 * effectiveLead falls back to the main bot with a warning), or a loop. Never guessed. The start
 * row freezes it at launch: it is never recomputed for a launch already written.
 */
export function squadOf(file, botId) {
  const main = mainBotOf(file);
  const byId = new Map((file?.bots ?? []).map((b) => [b.id, b]));
  let cur = byId.get(botId);
  if (!main || !cur || cur === main || cur.kind === "main") return null;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    const { lead, leadProject, warning } = effectiveLead(file, cur.id);
    if (warning || !lead) return null;
    if (leadProject || lead === main.id) return cur.id;
    cur = byId.get(lead);
  }
  return null;
}

/**
 * Every reason a file must not be written as it is (empty: fine). Stricter than parseBots.
 * A category id that isn't a slug is refused only when it is new: one `before` (the file the
 * edit started from, its text or object; null: none) already lists stays writable, so a
 * hand-written file is never locked; it just gets no category= label (effectiveCategory).
 * Planned leads use effectiveLead's main-bot fallback with a read warning and do not
 * block unrelated saves. Missing leads, self-leads and cycles still refuse a write.
 */
export function checkBots(file, before = null, { project = null, projects = null } = {}) {
  let had = before;
  if (typeof had === "string") { try { had = JSON.parse(had); } catch { had = null; } }
  const oldIds = new Set((Array.isArray(had?.categories) ? had.categories : []).map((c) => c?.id).filter(isText));
  const errors = [];
  if (!isObject(file) || file.version !== 1 || !Array.isArray(file.bots)) return ["not a version-1 bots file"];
  const cats = Array.isArray(file.categories) ? file.categories : [];
  if (!Array.isArray(file.categories)) errors.push("no categories list");
  const catIds = new Set();
  for (const c of cats) {
    if (!isObject(c) || !isText(c.id) || typeof c.title !== "string") errors.push("a category has no id or title");
    else if (catIds.has(c.id)) errors.push(`category ${c.id} is listed twice`);
    else if (!CATEGORY_ID.test(c.id) && !oldIds.has(c.id)) { errors.push(`category ${JSON.stringify(c.id)}: a new id is a lowercase slug (a-z, 0-9, single dashes)`); catIds.add(c.id); }
    else catIds.add(c.id);
  }
  const ids = new Set();
  for (const b of file.bots) {
    if (!isObject(b) || !ID_SHAPE.test(b.id ?? "")) { errors.push(`${b?.id ?? "a bot"}: id is not b- plus 10 base32 characters`); continue; }
    const at = b.id;
    if (b.hermes !== undefined) {
      const why = b.agent !== "hermes" ? "Hermes pairing requires the Hermes agent" : hermesPairProblem(b.hermes) ?? hermesPairConflict(file, b);
      if (why) errors.push(`${at}: ${why}`);
      if (b.model) errors.push(`${at}: a paired Hermes bot uses its own model; clear the model pin`);
    }
    if (ids.has(at)) errors.push(`${at}: id used twice`);
    ids.add(at);
    if (!isText(b.name)) errors.push(`${at}: no name`);
    if (!KINDS.includes(b.kind)) errors.push(`${at}: unknown kind`);
    if (!isObject(b.look) || !isText(b.look.character) || !isText(b.look.colour)) errors.push(`${at}: no look`);
    if (typeof b.role !== "string") errors.push(`${at}: no role`);
    if (b.code !== undefined && typeof b.code !== "boolean") errors.push(`${at}: code is not a boolean`);
    if (b.hcProxy !== undefined && typeof b.hcProxy !== "boolean") {
      errors.push(`${at}: hcProxy is not a boolean`);
    }
    if (b.codexAuto !== undefined && typeof b.codexAuto !== "boolean") {
      errors.push(`${at}: codexAuto is not a boolean`);
    }
    if (typeof b.instructions !== "string") errors.push(`${at}: no instructions`);
    else if (b.instructions.length > MAX_INSTRUCTIONS) errors.push(`${at}: instructions longer than ${MAX_INSTRUCTIONS} characters`);
    if (b.planned !== undefined && (!isObject(b.planned) || !isWave(b.planned.wave))) errors.push(`${at}: planned needs a positive whole wave`);
    if (!b.planned && !isText(b.agent)) errors.push(`${at}: no coding agent`);
    if (b.agyMode !== undefined && b.agyMode !== "" && !AGY_MODES.includes(b.agyMode)) {
      errors.push(`${at}: agyMode ${JSON.stringify(b.agyMode)} isn't one of ${AGY_MODES.join(", ")}`);
    }
    if (isObject(b.worker) && b.worker.agyMode !== undefined && b.worker.agyMode !== "" && !AGY_MODES.includes(b.worker.agyMode)) {
      errors.push(`${at}: worker agyMode ${JSON.stringify(b.worker.agyMode)} isn't one of ${AGY_MODES.join(", ")}`);
    }
    if (b.agyPermissions !== undefined) {
      if (!isObject(b.agyPermissions)) errors.push(`${at}: agyPermissions is not an object with allow and deny lists`);
      else {
        for (const key of Object.keys(b.agyPermissions)) {
          if (!["allow", "deny"].includes(key)) errors.push(`${at}: agyPermissions ${key} isn't allow or deny`);
          else if (!Array.isArray(b.agyPermissions[key])) errors.push(`${at}: agyPermissions ${key} is not a list of rules`);
          else {
            for (const rule of b.agyPermissions[key]) {
              const why = agyRuleProblem(rule);
              if (why) errors.push(`${at}: agyPermissions ${key}: ${why}`);
            }
          }
        }
      }
    }
    if (b.leadProject !== undefined) {
      if (!isText(b.leadProject) || !cleanProjectPath(b.leadProject).startsWith("/")) {
        errors.push(`${at}: leadProject must be an absolute folder path`);
      } else if (!isText(b.lead)) {
        errors.push(`${at}: leadProject needs a lead`);
      }
    }
    if (b.kind === "main" && b.lead !== undefined && !isText(b.leadProject)) errors.push(`${at}: a main bot has no lead`);
    const rawCross = b.crossMembers !== undefined ? b.crossMembers : b.members;
    if (rawCross !== undefined) {
      if (!Array.isArray(rawCross)) {
        errors.push(`${at}: crossMembers is not a list`);
      } else {
        const ownProj = cleanProjectPath(project);
        for (const m of rawCross) {
          if (!isObject(m) || !ID_SHAPE.test(m.id ?? "")) {
            errors.push(`${at}: crossMembers entry needs a bot id (b- plus 10 base32 characters)`);
          } else if (!isText(m.project) || !cleanProjectPath(m.project).startsWith("/")) {
            errors.push(`${at}: crossMembers ${m.id} project must be an absolute folder path`);
          } else if (ownProj && cleanProjectPath(m.project) === ownProj) {
            errors.push(`${at}: crossMembers ${m.id} cannot name this bot's own project`);
          }
        }
      }
    }
    if (b.category !== undefined && !catIds.has(b.category)) errors.push(`${at}: unknown category ${b.category}`);
    if (b.rank !== undefined && !RANKS.includes(b.rank)) errors.push(`${at}: unknown rank ${JSON.stringify(b.rank)}`);
  }
  const mains = file.bots.filter((b) => b?.kind === "main").length;
  if (mains !== 1) errors.push(`${mains} main bots; a project has exactly one`);
  else if (!errors.length) {
    const byId = new Map(file.bots.map((b) => [b.id, b]));
    const ownProject = cleanProjectPath(project);
    for (const b of file.bots) {
      if (b.kind !== "member" && !b.leadProject) continue;
      const isCross = Boolean(b.leadProject && (!ownProject || cleanProjectPath(b.leadProject) !== ownProject));
      if (isCross && !projects) continue;
      // Validate the stored graph too: planning a bot must not hide a dormant cycle.
      // Reads still use effectiveLead's fallback for a planned lead.
      const targetProject = isCross ? cleanProjectPath(b.leadProject) : ownProject;
      const targetFile = isCross ? projectFileOf(projects, targetProject) : file;
      const storedLead = targetFile?.bots.find((row) => row.id === (b.lead ?? mainBotOf(file)?.id));
      if (leadsBackTo(targetProject, targetFile, storedLead, ownProject, b.id, projects, { includePlanned: true })) {
        errors.push(`${b.id}: lead ${storedLead.id} leads back to this bot`);
        continue;
      }
      const { warning } = effectiveLead(file, b.id, { project, projects });
      const target = !isCross ? byId.get(b.lead) : null;
      if (warning && !/is one-sided/.test(warning) && (isCross || b.lead === b.id || !target?.planned)) {
        errors.push(`${b.id}: ${warning}`);
      }
    }
  }
  return errors;
}

// POSIX path helpers: the folders come from spaces and git, on this machine or another.
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const parentOf = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * The project a folder belongs to (DESIGN Decision 15), two ways: `{ key, own }`.
 * In git both are its main checkout, the parent of
 * `git rev-parse --path-format=absolute --git-common-dir` (for a common dir not named
 * `.git`, a bare repo or a submodule, the folder's own top level). Outside git, or where git
 * is missing or fails: `key` is the nearest folder at or above it holding
 * `.herdr/bots.json`, else the folder itself (the walk-up, for a folder seen in passing: a
 * pane's or a space's); `own` is the folder itself (for a folder someone picked or named
 * as the project: never keyed to a parent project without asking).
 * `git(args, cwd)` resolves with git's stdout, or null when git failed or is missing;
 * `exists(path)` with whether that file is there. Either rejecting means the folder's
 * machine can't be asked now: projectOf rejects too, never guessing "not in git".
 */
export async function projectOf(folder, git, exists) {
  const start = trimSlash(folder);
  const ask = async (args) => (await git(args, start))?.trim() || null;
  const common = await ask(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    const dir = trimSlash(common);
    if (baseOf(dir) === ".git") { const main = parentOf(dir); return { key: main, own: main }; }
    const top = await ask(["rev-parse", "--show-toplevel"]);
    if (top) return { key: trimSlash(top), own: trimSlash(top) };
  }
  for (let dir = start; ; dir = parentOf(dir)) {
    if (await exists(`${dir === "/" ? "" : dir}/${BOTS_PATH}`)) return { key: dir, own: start };
    if (dir === "/" || !dir.includes("/")) break;
  }
  return { key: start, own: start };
}

/**
 * Where an edit made from `folder` is written (RFC 0014 Q16, #234): its git top level, so an
 * edit from a worktree lands in that worktree and a main checkout's in itself; null outside
 * git (the caller writes the project key, as before). Reads stay on projectOf's `key`.
 * `git` as projectOf's.
 */
export async function writeFolderOf(folder, git) {
  const top = (await git(["rev-parse", "--show-toplevel"], trimSlash(folder)))?.trim();
  return top ? trimSlash(top) : null;
}

/** The walk-up key of a folder seen in passing (projectOf's `key`). */
export async function projectKeyOf(folder, git, exists) {
  return (await projectOf(folder, git, exists)).key;
}

/**
 * The project a bot's pane runs in, from its folder (automagik#227, RFC 0014 Q16): projectOf's
 * `key` when git or a `.herdr/bots.json` above the folder gave it, else null (not in git, git
 * missing or failing, no bots file above: the folder names no project). A worktree keys to its
 * main checkout, a clone to itself. Rejects as projectOf does.
 */
export async function paneKeyOf(folder, git, exists) {
  let told = false;
  const { key } = await projectOf(folder,
    async (args, cwd) => { const out = await git(args, cwd); if (out?.trim()) told = true; return out; },
    async (path) => { const there = await exists(path); if (there) told = true; return there; });
  return told ? key : null;
}

/** The bots under `botId` at any depth (by effective lead): none of them can be its lead. */
export function descendantsOf(file, botId, { project = null, projects = null } = {}) {
  if (!projects) {
    const ownProject = cleanProjectPath(project);
    const out = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of file?.bots ?? []) {
        if (out.has(b.id) || b.id === botId || b.kind !== "member") continue;
        const { lead, leadProject } = effectiveLead(file, b.id, { project: ownProject || null });
        if (leadProject && (!ownProject || leadProject !== ownProject)) continue;
        if (lead === botId || out.has(lead)) { out.add(b.id); grew = true; }
      }
    }
    return out;
  }
  const ownProject = inferProjectOf(file, botId, project, projects);
  const entries = projectEntriesOf(projects);
  if (file && Array.isArray(file.bots) && !entries.some(([k, f]) => f === file || (ownProject && k === ownProject))) {
    entries.unshift([ownProject, file]);
  }
  const reachPairs = new Set([`${ownProject}\0${botId}`]);
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [projKey, projFile] of entries) {
      for (const b of projFile?.bots ?? []) {
        if (!b?.id || b.planned || (b.id === botId && (!ownProject || projKey === ownProject))) continue;
        if (b.kind !== "member" && !b.leadProject) continue;
        const pairKey = `${projKey}\0${b.id}`;
        if (reachPairs.has(pairKey)) continue;
        const eff = effectiveLead(projFile, b.id, { project: projKey || null, projects });
        if (!eff.lead) continue;
        const targetProj = eff.leadProject ?? projKey;
        const targetPair = `${targetProj}\0${eff.lead}`;
        if (reachPairs.has(targetPair) || (!ownProject && !targetProj && (eff.lead === botId || out.has(eff.lead)))) {
          reachPairs.add(pairKey);
          out.add(b.id);
          grew = true;
        }
      }
    }
  }
  return out;
}

/**
 * The category a bot shows under (A2): a direct report of the main bot carries its own;
 * a deeper member is under its lead's chain, so it takes the category of the direct report
 * that chain ends at. Null for the main bot, an unknown bot, a category not in the file, or
 * an id that isn't a slug (free text never reaches a pane label).
 */
export function effectiveCategory(file, botId) {
  const main = mainBotOf(file);
  const byId = new Map(file.bots.map((b) => [b.id, b]));
  let bot = byId.get(botId);
  for (let steps = 0; bot && main && bot !== main && steps <= file.bots.length; steps += 1) {
    const { lead, leadProject } = effectiveLead(file, bot.id);
    if (leadProject) return null;
    if (lead === main.id) {
      const known = (file.categories ?? []).some((c) => c?.id === bot.category);
      return known && CATEGORY_ID.test(bot.category) ? bot.category : null;
    }
    bot = byId.get(lead);
  }
  return null;
}

/** `planned` from the form: wave and note from it, the stored object's other keys kept. */
export function plannedOf(stored, wave, note) {
  const out = { ...(stored ?? {}), wave };
  if (note) out.note = note; else delete out.note;
  return out;
}

/** Automagik's Omni look: the octopus in deepseek. */
export const OMNI_LOOK = Object.freeze({ character: "octopus", colour: "deepseek" });

/** A category id for a new title, unique among `categories`. */
export function newCategoryId(title, categories = []) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
  const taken = new Set(categories.map((c) => c?.id));
  let id = slug;
  for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
  return id;
}

/**
 * A copy of `raw` (parseBots' raw file, or a new one) with one bot created or edited, the
 * Create form's write-back. `entry` holds every field the form edits; an optional one it
 * leaves out or empty is removed (planned, lead, leadProject, category, agent, model, agyMode);
 * other keys the stored entry had are kept. `rank` (A16) and `worker` are removed only when
 * `entry` names them empty, so a front end that doesn't edit them (the form has no worker fields)
 * keeps the stored ones; a `worker` with none of its fields left is removed too.
 * A lead equal to the main bot (with no leadProject) is stored as no lead; a category goes only
 * with the main bot as lead; `newCategory` ({ title, sub }) is added to the categories and used.
 */
export function applyBotEdit(raw, entry, newCategory = null) {
  const out = JSON.parse(JSON.stringify(raw ?? { version: 1, categories: [], bots: [] }));
  out.version ??= 1;
  if (!Array.isArray(out.categories)) out.categories = [];
  if (!Array.isArray(out.bots)) out.bots = [];
  const bot = { ...entry };
  if (newCategory?.title?.trim()) {
    const cat = { id: newCategoryId(newCategory.title, out.categories), title: newCategory.title.trim() };
    if (newCategory.sub?.trim()) cat.sub = newCategory.sub.trim();
    out.categories.push(cat);
    bot.category = cat.id;
  }
  if (bot.leadProject) bot.leadProject = cleanProjectPath(bot.leadProject);
  if (!bot.lead || !bot.leadProject) delete bot.leadProject;
  const main = out.bots.find((b) => b?.kind === "main" && b.id !== bot.id);
  if (!bot.leadProject && (bot.kind === "main" || (main && bot.lead === main.id))) delete bot.lead;
  if (bot.kind === "main" || bot.lead) delete bot.category;
  if ("crossMembers" in bot || "members" in bot) {
    const normalizedCross = crossMembersOf(bot);
    delete bot.members;
    if (normalizedCross.length) bot.crossMembers = normalizedCross;
    else delete bot.crossMembers;
  }
  const i = out.bots.findIndex((b) => b?.id === bot.id);
  const merged = i >= 0 ? { ...out.bots[i], ...bot } : bot;
  if (Object.hasOwn(bot, "hermes") && bot.hermes === undefined) delete merged.hermes;
  for (const k of ["planned", "lead", "leadProject", "category", "agent", "model", "agyMode", "agyPermissions"]) {
    if (!(k in bot) || bot[k] === undefined || bot[k] === null || bot[k] === "") delete merged[k];
  }
  if (("crossMembers" in entry || "members" in entry) && !bot.crossMembers) {
    delete merged.crossMembers;
    delete merged.members;
  }
  if ("rank" in bot && (bot.rank === undefined || bot.rank === null || bot.rank === "")) delete merged.rank;
  if ("code" in bot && (bot.code === undefined || bot.code === null || bot.code === "")) delete merged.code;
  if (isObject(merged.worker) && merged.worker.agyMode === "") {
    merged.worker = { ...merged.worker };
    delete merged.worker.agyMode;
    if (!Object.keys(merged.worker).length) delete merged.worker;
  }
  if ("worker" in bot && (!isObject(bot.worker) || Object.keys(bot.worker).length === 0)) delete merged.worker;
  if (i >= 0) out.bots[i] = merged; else out.bots.push(merged);
  return out;
}

/**
 * The projects the command line touched (it creates, edits, starts or attaches bots in them),
 * so the sidebar shows them with no open space: a JSON array of project keys on this
 * computer, `PROJECTS_FILE` in the app home (outside mods/, so writing it reloads nothing).
 * Only the CLI writes it; the sidebar reads it beside its own remembered list.
 */
export const PROJECTS_FILE = "am-sidebar-projects.json";
export const MAX_LISTED_PROJECTS = 200;

/** The keys in a PROJECTS_FILE text (null, unparsable or the wrong shape: none). */
export function listedProjects(text) {
  let list;
  try { list = typeof text === "string" && text ? JSON.parse(text) : []; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((k) => typeof k === "string" && k.startsWith("/")))];
}

/** A PROJECTS_FILE text with `key` last (the most recent), once, keeping the newest `max`. */
export function withListedProject(text, key, max = MAX_LISTED_PROJECTS) {
  const keys = [...listedProjects(text).filter((k) => k !== key), key].slice(-max);
  return `${JSON.stringify(keys, null, 2)}\n`;
}

/**
 * Known projects on this machine for cross-project lead / team resolution (`project -> BotsFile`).
 * Reads `project`, any `leadProject` or `crossMembers` referenced by loaded bots (transitively),
 * `extraKeys`, `<appHome>/am-sidebar-projects.json`, `<appHome>/shared.json`, and immediate sibling
 * folders of `project` when `listDir` is supplied.
 */
export function collectProjectMap({
  project = null,
  file = null,
  appHome = null,
  readText = () => null,
  listDir = () => [],
  extraKeys = [],
} = {}) {
  const map = new Map();
  const queue = [];
  const seen = new Set();
  const enqueue = (k) => {
    const clean = cleanProjectPath(k);
    if (!clean || !clean.startsWith("/") || seen.has(clean)) return;
    seen.add(clean);
    queue.push(clean);
  };
  const enqueueBots = (bots) => {
    for (const b of bots ?? []) {
      if (b?.leadProject) enqueue(b.leadProject);
      for (const m of crossMembersOf(b)) enqueue(m.project);
    }
  };
  const ownKey = cleanProjectPath(project);
  if (ownKey) {
    seen.add(ownKey);
    if (file && Array.isArray(file.bots)) {
      map.set(ownKey, file);
      enqueueBots(file.bots);
    } else {
      queue.push(ownKey);
    }
  } else if (file && Array.isArray(file.bots)) {
    enqueueBots(file.bots);
  }
  for (const k of extraKeys ?? []) enqueue(k);
  if (appHome) {
    const home = cleanProjectPath(appHome);
    for (const k of listedProjects(readText(`${home}/${PROJECTS_FILE}`))) enqueue(k);
    for (const k of listedProjects(readText(`${home}/automagik-herdr/projects.json`))) enqueue(k);
    try {
      const shared = JSON.parse(readText(`${home}/shared.json`) ?? "null");
      const list = shared?.["am.sidebar.projects"] ?? shared?.["spaces-agents.projects"];
      if (Array.isArray(list)) {
        for (const p of list) {
          if (typeof p === "string") enqueue(p);
          else if (p && typeof p.key === "string" && !p.machine) enqueue(p.key);
        }
      }
    } catch { /* ignore */ }
  }
  if (ownKey && ownKey !== "/") {
    const parent = parentOf(ownKey);
    if (parent && parent !== "/") {
      let names = [];
      try { names = listDir(parent) ?? []; } catch { names = []; }
      for (const name of names.slice(0, 64)) {
        if (typeof name === "string" && name && !name.startsWith(".")) enqueue(`${parent}/${name}`);
      }
    }
  }
  while (queue.length) {
    const key = queue.shift();
    if (map.has(key)) continue;
    const text = readText(`${key === "/" ? "" : key}/${BOTS_PATH}`);
    if (typeof text !== "string" || !text.trim()) continue;
    try {
      const parsed = parseBots(text).file;
      map.set(key, parsed);
      enqueueBots(parsed.bots);
    } catch { /* skip invalid project */ }
  }
  return map;
}
