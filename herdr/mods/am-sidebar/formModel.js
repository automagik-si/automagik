// The Create / Edit bot form's rules over plain data (A13, to the approved mockup
// mockup/create-form.dc.html): the form's state from a bot, the bots it may report to, the
// model line and pin list (A12: picked from the agent's list, never typed), what stops a
// save, the entry a save writes, the `automagik-herdr create|edit …` line it matches (A11), and
// the sidebar preview's second line. Pure: no `herdr`, `gpui-kit`, `gpui-base` or `fs`,
// so `node --test` runs it. Apache-2.0.

import { MAX_INSTRUCTIONS, OMNI_LOOK, RANKS, defaultLook, descendantsOf, effectiveLead, mainBotOf, newCategoryId, plannedOf } from "./model.js";
import { AGY_MODE_DEFAULT, AGY_MODES, LEGACY_AGENTS, defaultModelFrom, knownModelsFrom } from "./models.js";
import { hermesPairProblem, hermesPairConflict } from "./hermesPair.js";

/** Waves the stepper offers (the mockup's 1..9); a stored later wave stays reachable. */
export const MAX_WAVE = 9;
/** The counter turns to a warning colour past this many characters (the mockup's 3,600). */
export const NEAR_LIMIT = 3600;
/** The "+ New" category chip's value. */
export const NEW_CATEGORY = "+new";

/**
 * A word as a POSIX shell (and zsh) reads it: bare when it is plain, else single-quoted.
 * A leading `=` is quoted too: zsh expands a bare `=word` to the path of command `word`.
 */
export function shellQuote(value) {
  const v = String(value ?? "");
  return /^[A-Za-z0-9._/:@%+,-][A-Za-z0-9._/:@%+=,-]*$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * One option with its value as one shell word, `--name=<quoted>`. The CLI's parser (node's
 * strict parseArgs) refuses `--name value` when the value starts with `-` (a markdown list
 * in the instructions, say); the `=` spelling takes any value.
 */
export const opt = (name, value) => `--${name}=${shellQuote(value)}`;

const str = (x, or = "") => (typeof x === "string" ? x : or);
const isWave = (x) => Number.isInteger(x) && x > 0;

/** 4000 → "4,000" (no Intl: Herdr's runtime may not carry locales). */
export function thousands(n) {
  return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// A retired agent's replacement (LEGACY_AGENTS), else the key as given.
const currentAgent = (key) => (Object.hasOwn(LEGACY_AGENTS, key) ? LEGACY_AGENTS[key] : key);

/**
 * The form's state. Create: a new bot (`id`), its default look, the project's main bot when
 * it has none yet, else a member reporting to the main bot. Edit: every field from the
 * stored entry (`bot`, as parseBots' raw copy holds it), so a field left alone is written
 * back as it was (a pin the list no longer has, a lead that fell back, planned's other keys).
 * A retired agent (LEGACY_AGENTS) opens as its replacement with no pin, as parseBots reads it.
 */
export function formFrom({ mode = "create", bot = null, file = null, id = null, agent = "" } = {}) {
  if (mode === "edit" && bot) {
    // Stored values as text only: a hand-edited file may hold anything, and every one of
    // them ends up in the copied command line.
    const look = defaultLook(bot.id);
    const planned = bot.planned && typeof bot.planned === "object" ? bot.planned : null;
    return {
      mode, id: bot.id, name: str(bot.name), kind: bot.kind === "main" ? "main" : "member",
      character: str(bot.look?.character, look.character), colour: str(bot.look?.colour, look.colour),
      role: str(bot.role), instructions: str(bot.instructions), agent: currentAgent(str(bot.agent)), pin: currentAgent(str(bot.agent)) === str(bot.agent) ? str(bot.model) : "",
      code: bot.code !== false,
      agyMode: AGY_MODES.includes(bot.agyMode) ? bot.agyMode : AGY_MODE_DEFAULT,
      // Kept as stored for the write-back: the form edits no permission rule (#823).
      agyPermissions: bot.agyPermissions,
      hermesHome: str(bot.hermes?.home), hermesProfile: str(bot.hermes?.profile),
      lead: bot.kind === "main" ? "" : str(bot.lead), category: str(bot.category), catTitle: "", catSub: "",
      rank: str(bot.rank), planned: Boolean(planned), wave: isWave(planned?.wave) ? planned.wave : 1, note: str(planned?.note),
      storedPlanned: planned,
    };
  }
  const look = defaultLook(id);
  return {
    mode: "create", id, name: "", kind: file && mainBotOf(file) ? "member" : "main",
    character: look.character, colour: look.colour, role: "", instructions: "", agent, pin: "",
    code: true, agyMode: AGY_MODE_DEFAULT,
    hermesHome: "", hermesProfile: "",
    lead: "", category: "", catTitle: "", catSub: "", rank: "", planned: false, wave: 1, note: "", storedPlanned: null,
  };
}

/** The Omni preset's look. */
export const omniLook = () => ({ character: OMNI_LOOK.character, colour: OMNI_LOOK.colour });

/** The lead a member's state means: its own `lead` when that one may lead it, else the main bot. */
export function leadIdOf(state, file) {
  const main = file ? mainBotOf(file) : null;
  if (state.kind === "main" || !main) return "";
  if (!state.lead || state.lead === main.id) return main.id;
  const ok = leadOptions(file, state.id).some((o) => o.id === state.lead);
  return ok ? state.lead : main.id;
}

/**
 * The bots `selfId` may report to (A1), in tree order for an indented list: the main bot,
 * then every member that is not planned, not `selfId` and not under it, each under its own
 * effective lead. `note`: "Main bot", else its role and, for one the main bot leads, its
 * category's title ("Captain · Platform").
 */
export function leadOptions(file, selfId) {
  const main = file ? mainBotOf(file) : null;
  if (!main) return [];
  const below = selfId ? descendantsOf(file, selfId) : new Set();
  const can = (b) => b.kind === "member" && !b.planned && b.id !== selfId && !below.has(b.id);
  const title = new Map((file.categories ?? []).map((c) => [c.id, c.title]));
  const kids = new Map();
  for (const b of file.bots) {
    if (!can(b)) continue;
    const lead = effectiveLead(file, b.id).lead || main.id;
    if (!kids.has(lead)) kids.set(lead, []);
    kids.get(lead).push(b);
  }
  const out = [{ id: main.id, name: main.name, look: main.look, note: "Main bot", depth: 0, main: true }];
  const seen = new Set([main.id]);
  const walk = (leadId, depth) => {
    for (const b of kids.get(leadId) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const cat = leadId === main.id && b.category ? title.get(b.category) : null;
      out.push({ id: b.id, name: b.name, look: b.look, note: [b.role, cat].filter(Boolean).join(" · "), depth, main: false });
      walk(b.id, depth + 1);
    }
  };
  walk(main.id, 1);
  return out;
}

/**
 * Where the bot sits (the "Place in the team" block): which kind buttons are offered and why
 * one is not, its lead, and whether it picks a category (only a member the main bot leads,
 * A2) or shows under its lead's.
 */
export function placeOf(state, file) {
  const main = file ? mainBotOf(file) : null;
  const editing = state.mode === "edit";
  const why = { main: null, member: null };
  if (editing) {
    why[state.kind === "main" ? "member" : "main"] = "A bot's kind is set when it is created.";
  } else if (main) {
    why.main = `${main.name} is this project's main bot.`;
  } else {
    why.member = "A project's first bot is its main bot.";
  }
  const leadId = leadIdOf(state, file);
  const member = state.kind === "member";
  const byMain = member && Boolean(main) && leadId === main.id;
  const lead = leadOptions(file, state.id).find((o) => o.id === leadId) ?? null;
  const stale = member && Boolean(state.lead) && state.lead !== leadId ? effectiveLead(file, state.id).warning ?? null : null;
  return { why, leadId, lead, byMain, underLead: member && !byMain, stale };
}

/** Where an agent's own default model is read from, as the model line names it. */
const SOURCES = { claude: "your Claude settings", codex: "your Codex config", antigravity: "your Antigravity settings" };

/**
 * An agent's model facts for the form: its own default (A12, from its config) and where that
 * comes from, and the models a bot may be pinned to. `texts`: configPaths' names mapped to
 * each file's text, as for models.js.
 */
export function modelInfo(agentKey, texts = {}) {
  const def = agentKey ? defaultModelFrom(agentKey, texts) : null;
  return { def, from: def ? SOURCES[agentKey] ?? "its own settings" : null, models: agentKey ? knownModelsFrom(agentKey, texts) : [] };
}

/**
 * The pin list: "Default (…)" first (no pin), then only the agent's known models (A12),
 * never a typed one. A stored pin the list no longer has is kept as the selected entry,
 * marked, so opening the list doesn't silently drop it.
 */
export function modelOptions(info, pin = "") {
  const out = [{ id: "", label: `Default (${info.def ?? "its own"})`, hint: info.from ?? "" }];
  for (const m of info.models) out.push({ id: m, label: m, hint: m === info.def ? "default" : "" });
  if (pin && !info.models.includes(pin)) out.push({ id: pin, label: pin, hint: "not in the list" });
  return out;
}

/**
 * The model line: what the bot runs and why. `detected`: the model read from the bot's
 * running pane (edit of a live bot), with `terminal` its address. `agentKey`: the agent, so a
 * pinless Antigravity says where its list would come from (`agy models`) instead of a bare
 * "doesn't list its models".
 */
export function modelLine({ agentName, agentKey = null, pin, info, detected = null, terminal = null }) {
  const name = agentName || "The agent";
  if (detected) {
    const shown = pin || detected;
    const note = pin && pin !== detected
      ? `Pinned. ${terminal ?? "Its pane"} runs ${detected} now; the pin applies at the next Start.`
      : `Running in ${terminal ?? "its pane"}, read from the pane.${pin ? " Pinned." : ""}`;
    return { shown, note, source: pin ? "pinned" : "detected" };
  }
  if (pin) return { shown: pin, note: `Pinned. Start runs ${name} with this model; the sidebar shows what the pane really runs.`, source: "pinned" };
  if (info.def) return { shown: info.def, note: `${name}'s default, from ${info.from}. Read from the running pane once started.`, source: "default" };
  if (agentKey === "antigravity") {
    return { shown: "its own default", note: "Antigravity's models come from `agy models`; none are cached here yet (agy may not be installed). Read from the running pane once started.", source: null };
  }
  return { shown: "its own default", note: `${name} doesn't list its models. Read from the running pane once started.`, source: null };
}

/** The sidebar preview's second line, as the row draws a stopped or planned bot. */
export function rowLineOf(state, modelShown) {
  const first = state.planned ? `planned · wave ${state.wave}` : "not running";
  const role = state.role.trim() || (state.kind === "main" ? "Main bot" : "no role");
  return [first, role, modelShown].filter(Boolean).join(" · ");
}

/** The instructions counter's tone: "ok", "near" (past NEAR_LIMIT) or "over". */
export function countTone(n) {
  return n > MAX_INSTRUCTIONS ? "over" : n > NEAR_LIMIT ? "near" : "ok";
}

/**
 * Why the form can't be saved as it is, or null. The CLI's create/edit rules (entryFrom in
 * bin/automagik-herdr.mjs): a name not taken in the project (names pick bots), the first bot is
 * the main bot and there is only one, instructions within the limit, a planned bot's wave,
 * an agent unless planned, a pin from the agent's list, a new category's title.
 * `ctx`: { key, loadError, file, info } (`info` from modelInfo for state.agent).
 */
export function problemOf(state, { key = null, loadError = null, file = null, info = null } = {}) {
  if (!key) return "Pick the project folder first.";
  if (loadError) return loadError;
  if (state.hermesHome || state.hermesProfile) {
    if (state.agent !== "hermes") return "Unpair Hermes before choosing another agent.";
    if (state.pin) return "A paired Hermes bot uses its own model; clear the model pin.";
    const hermes = { home: state.hermesHome, profile: state.hermesProfile };
    const why = hermesPairProblem(hermes) ?? hermesPairConflict(file ?? { bots: [] }, { id: state.id, agent: state.agent, hermes });
    if (why) return why;
  }
  const name = state.name.trim();
  if (!name) return "Give the bot a name.";
  const bots = file?.bots ?? [];
  const twin = bots.find((b) => b.id !== state.id && String(b.name).toLowerCase() === name.toLowerCase());
  if (twin) return `${twin.name} already has that name in this project; names pick bots, so pick another.`;
  const main = file ? mainBotOf(file) : null;
  if (state.mode === "create" && !main && state.kind !== "main") return "The first bot in a project must be its main bot.";
  if (state.kind === "main" && main && main.id !== state.id) return `This project already has a main bot, ${main.name}.`;
  const n = state.instructions.length;
  if (n > MAX_INSTRUCTIONS) return `Instructions are ${thousands(n)} characters; the limit is ${thousands(MAX_INSTRUCTIONS)}.`;
  if (state.planned && !(Number.isInteger(state.wave) && state.wave > 0)) return "A planned bot needs a wave: a whole number from 1.";
  if (!state.planned && !state.agent) return "Pick what it runs on (or plan it for later).";
  if (state.pin && !state.agent) return "A model pin needs a coding agent.";
  if (state.pin && info && !info.models.includes(state.pin)) {
    return `${state.pin} isn't a model ${state.agent} lists; pick one from the list or use the default.`;
  }
  if (state.agyMode !== undefined && !AGY_MODES.includes(state.agyMode)) {
    return `Antigravity mode "${state.agyMode}" isn't one of ${AGY_MODES.join(", ")}.`;
  }
  const { byMain } = placeOf(state, file);
  if (byMain && state.category === NEW_CATEGORY && !state.catTitle.trim()) return "Give the new category a title.";
  if (state.kind === "member" && state.rank && !RANKS.includes(state.rank)) {
    return `"${state.rank}" isn't a rank; pick one of ${RANKS.join(", ")}, or none.`;
  }
  return null;
}

/**
 * What a save writes: the bot entry for applyBotEdit (every field the form edits; an
 * optional one left empty is removed there) and a new category, or null. A member the main
 * bot doesn't lead carries no category; the main bot no lead.
 */
export function entryOf(state, file) {
  const { leadId, byMain } = placeOf(state, file);
  const main = file ? mainBotOf(file) : null;
  const member = state.kind === "member";
  const newCat = byMain && state.category === NEW_CATEGORY;
  // A16: a member's rank, "" clearing it; the main bot's entry leaves rank out, so a stored
  // one stays (the form picks ranks for members only).
  const rank = member ? { rank: state.rank ?? "" } : {};
  // Keep an explicit setting when editing, including true; new defaults stay implicit.
  const hadCode = file?.bots.find((b) => b.id === state.id)?.code !== undefined;
  return {
    entry: {
      ...rank,
      id: state.id, name: state.name.trim(), kind: state.kind,
      look: { character: state.character, colour: state.colour },
      role: state.role.trim(), instructions: state.instructions,
      code: state.code === false ? false : hadCode ? true : undefined,
      agent: state.agent || undefined, model: state.pin || undefined,
      hermes: state.hermesHome || state.hermesProfile ? { home: state.hermesHome, profile: state.hermesProfile } : undefined,
      // Antigravity's launch mode: the default is applied at launch, so only another one is stored.
      agyMode: state.agyMode && state.agyMode !== AGY_MODE_DEFAULT ? state.agyMode : undefined,
      // The form edits no permission rule: a stored field is written back as it was (#823).
      agyPermissions: state.agyPermissions,
      // An untouched stale lead is written back as stored; the view keeps warning on it.
      lead: member ? (state.lead && state.lead !== leadId ? state.lead : leadId && leadId !== main?.id ? leadId : undefined) : undefined,
      category: byMain && state.category && !newCat ? state.category : undefined,
      planned: state.planned ? plannedOf(state.storedPlanned, state.wave, state.note.trim()) : undefined,
    },
    newCategory: newCat ? { title: state.catTitle.trim(), sub: state.catSub.trim() } : null,
  };
}

/**
 * The `automagik-herdr` line that does what the form will do (A11), shown live in the footer and
 * copied by Copy. Create: every chosen field, in the mockup's order. Edit: `edit <bot>` and
 * only what changed since `initial`, with the CLI's clearing spellings (--no-model,
 * --no-category, --unplanned, --rank=). A new category is added first with `category add --id`, the
 * id the create line names. The project is named with --project (and --machine, a linked
 * machine's), so the line writes the same file from any folder. Every value goes as `--option=<quoted>` (see opt). Instructions
 * go inline (the mockup's `--instructions-file -` would wait on stdin when pasted).
 */
export function commandOf(state, { key = null, file = null, initial = null, machine = null } = {}) {
  const { leadId, byMain } = placeOf(state, file);
  const project = key ? [...(machine ? [opt("machine", machine)] : []), opt("project", key)] : [];
  const cats = file?.categories ?? [];
  const pre = [];
  let categoryId = state.category;
  if (byMain && state.category === NEW_CATEGORY) {
    categoryId = newCategoryId(state.catTitle.trim() || "category", cats);
    pre.push(["am category add", opt("id", categoryId), opt("title", state.catTitle.trim()),
      ...(state.catSub.trim() ? [opt("sub", state.catSub.trim())] : []), ...project].join(" "));
  }
  const parts = [];
  const was = state.mode === "edit" && initial ? initial : null;
  const changed = (k) => !was || was[k] !== state[k];
  const wave = String(state.wave);
  if (!was) {
    parts.push("am create", opt("name", state.name.trim() || "new-bot"));
    if (state.kind === "main") parts.push(opt("kind", "main"));
    if (state.agent) parts.push(opt("agent", state.agent));
    if (state.role.trim()) parts.push(opt("role", state.role.trim()));
    if (state.code === false) parts.push(opt("code", "false"));
    if (state.kind === "member" && leadId) parts.push(opt("lead", leadId));
    if (byMain && categoryId) parts.push(opt("category", categoryId));
    if (state.kind === "member" && state.rank) parts.push(opt("rank", state.rank));
    parts.push(opt("character", state.character), opt("colour", state.colour));
    if (state.pin) parts.push(opt("model", state.pin));
    if (state.agyMode !== AGY_MODE_DEFAULT) parts.push(opt("agy-mode", state.agyMode));
    if (state.planned) {
      parts.push(opt("planned-wave", wave));
      if (state.note.trim()) parts.push(opt("planned-note", state.note.trim()));
    }
    parts.push(...project);
    if (state.instructions) parts.push(opt("instructions", state.instructions));
  } else {
    parts.push(`am edit ${shellQuote(state.id)}`);
    if (changed("name")) parts.push(opt("name", state.name.trim()));
    if (changed("agent") && state.agent) parts.push(opt("agent", state.agent));
    if (changed("role")) parts.push(opt("role", state.role.trim()));
    if (changed("code")) parts.push(opt("code", state.code === false ? "false" : "true"));
    const wasPlace = placeOf(was, file);
    if (state.kind === "member" && leadId !== wasPlace.leadId) parts.push(opt("lead", leadId));
    if (byMain && (categoryId !== was.category || !wasPlace.byMain)) {
      parts.push(categoryId ? opt("category", categoryId) : "--no-category");
    }
    if (state.kind === "member" && changed("rank")) parts.push(state.rank ? opt("rank", state.rank) : "--rank=");
    if (changed("character") || changed("colour")) parts.push(opt("character", state.character), opt("colour", state.colour));
    if (changed("pin") || (changed("agent") && was.pin)) parts.push(state.pin ? opt("model", state.pin) : "--no-model");
    if (changed("agyMode")) parts.push(opt("agy-mode", state.agyMode));
    if (!state.planned && was.planned) parts.push("--unplanned");
    if (state.planned && (!was.planned || changed("wave") || changed("note"))) {
      parts.push(opt("planned-wave", wave));
      if (state.note.trim() || was.note) parts.push(opt("planned-note", state.note.trim()));
    }
    parts.push(...project);
    if (changed("instructions")) parts.push(opt("instructions", state.instructions));
  }
  if (changed("hermesHome") || changed("hermesProfile")) {
    if (state.hermesHome || state.hermesProfile) parts.push(opt("hermes-home", state.hermesHome), opt("hermes-profile", state.hermesProfile));
    else if (was?.hermesHome || was?.hermesProfile) parts.push("--no-hermes");
  }
  return [...pre, parts.join(" ")].join(" && ");
}

/** Whether an edit changed anything the form edits. */
export function editChanged(state, initial) {
  if (!initial) return true;
  return ["name", "kind", "character", "colour", "role", "instructions", "code", "agent", "pin", "agyMode", "lead", "category",
    "catTitle", "catSub", "rank", "planned", "wave", "note", "hermesHome", "hermesProfile"].some((k) => state[k] !== initial[k]);
}

// The mockup's six interface icons (mockup/create-form.dc.html), as whole SVG documents in a
// 24-unit box, stroked in currentColor like Herdr's own lucide icons (icons/agent.svg): svg() draws them in the text colour, so
// the form tints them as the sidebar tints Herdr's own icons.
const stroke = (width, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const UI_ICONS = Object.freeze({
  folder: stroke(2, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  clock: stroke(2, '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/>'),
  shuffle: stroke(2.5, '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  chevron: stroke(3, '<path d="M6 9l6 6 6-6"/>'),
  close: stroke(2, '<path d="M6 6l12 12M18 6L6 18"/>'),
  copy: stroke(2, '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
});
/** The file an interface icon is kept in, beside the character pictures. */
export const uiIconFile = (name) => `ui-${name}.svg`;
