// The Create / Edit form, the Attach picker, the bot list and a bot row's menu (Configure, its
// Prompt edited in place, Run: Start or Focus, Restart, Restart on…, Attach, Detach; Inspect:
// what happened, by `automagik-herdr history`): the pack opened as a Herdr dialog or popup
// (props.form "create" | "edit" | "attach" | "pick" | "menu"). The Create / Edit form is
// drawn to the owner-approved mockup (A13, mockup/create-form.dc.html): a live character
// preview, look, name and sidebar preview on the left; role, instructions, coding agent and
// model, place in the team and planned on the right; the matching `automagik-herdr` line in the
// footer. Its rules live in formModel.js. Text fields are Herdr's Input and Textarea; the two
// lists are Herdr's Popover. The form reads the project's .herdr/bots.json itself and writes
// back its raw copy with the text it read as the snapshot, so an entry it can't show, or
// someone's edit since, is never lost. A project on a linked machine (props.machine, or the
// focused space's) is read there and written there through herdr-core (bots.js writeBots),
// by the same rule, and its bots start, restart, attach and detach there (the CLI's --machine);
// What happened stays this computer's for now (automagik#206). Apache-2.0.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Popover, Button, Scrollbar } from "gpui-base";
import { theme, readTextFile, pickFolder, knownAgents, openOverlay, closeOverlay, spaces, panes, focused, run, home, appHome, settings, hc, notify, exec } from "herdr";
import * as fs from "fs/promises";
import { BOTS_PATH, CHARACTERS, MAX_INSTRUCTIONS, RANKS, botsText, parseBots, newBotId, applyBotEdit } from "./model.js";
import { AGENTS, LEGACY_AGENTS, agModelsPath, configPaths, detectModel } from "./models.js";
import { refreshAgModels } from "./modelCache.js";
import { INKS, characterSvg, characterFile, inkOf, isDark } from "./characters.js";
import { UI_ICONS, uiIconFile, NEW_CATEGORY, MAX_WAVE, commandOf, countTone, editChanged, entryOf, formFrom, leadOptions, modelInfo, modelLine, modelOptions, omniLook, placeOf, problemOf, rowLineOf, thousands } from "./formModel.js";
import { restartAnswer, restartArgs } from "./restart.js";
import { changesIn, discoverProjects, editFolderOf, folderExists, keyOf, ownKeyOf, projectOfFolder, writeBots } from "./bots.js";
import { attachBot, startBot, liveTerminalOf, machineCli, runCli, sleepOf } from "./launch.js";
import { historyLines, menuItems } from "./inspect.js";
import { clickActionOf } from "./rows.js";
import { openWorkerTab, workerClick } from "./workerTab.js";

const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? p;
// The form's dialog size: the mockup's 1000 × 840 (main.js opens it the same way).
export const FORM_SIZE = { width: 1000, height: 840 };
// Character pictures: the sidebar's folder under the app home, outside mods/ (a write inside
// a mod folder reloads it), drawn by the path relative to the app home, as image() takes it.
const PETS = "am-sidebar-pets";
// The app homes whose Antigravity model cache was looked at this Herdr session: `agy models`
// runs at most once per session (modelCache.js), never on a render or per opened form.
const MODELS_LOOKED = new Set();
// The one pack agent the form adds to Herdr's list (#793): every other agent the form offers
// is exactly what knowAgents reports, and an existing bot's own agent still shows as it did.
const PACK_FORM_AGENTS = new Set(["antigravity"]);
const COLOUR_ORDER = Object.keys(INKS); // the mockup's swatch order
const CLEAR = "#00000000";

// A program's Herdr icon, as main.js draws it (Program.icon's tint rule, herdr.d.ts).
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// "Not saved: <why>", once: bots.js's writeBots says "Not saved:" itself.
// Which Restart a busy menu runs (the item whose label says "Restarting…").
const restartKey = ({ agent = null, force = false, fresh = false } = {}) => (agent ? "restart-on" : force ? "restart-force" : fresh ? "restart-fresh" : "restart");

// A linked machine's write whose answer was lost says "State unknown:" itself (remoteFile.js).
const notSaved = (why) => (/^(Not saved|State unknown):/.test(String(why)) ? String(why) : `Not saved: ${why}`);

// The form's text fields, read into the plain state formModel works on.
const TEXT = ["name", "role", "note", "catTitle", "catSub", "hermesHome", "hermesProfile"];

export class BotForm {
  constructor(p, cx) {
    this.p = p;
    this.mode = p.form;
    // The project's machine (a linked one's name), null for this computer.
    this.machine = typeof p.machine === "string" && p.machine ? p.machine : null;
    this.error = null; // why it can't be saved, shown above the buttons
    this.busy = false;
    if (this.mode === "menu") {
      // The sections opened in place ("prompt", "inspect"), the prompt as read (its file's
      // text is the save's snapshot) and the history as the CLI answered it.
      this.shown = new Set();
      this.prompt = TextareaState.new({ placeholder: "What it does, how it works, whom it reports to" });
      this.prompt.set_auto_grow(4, 10);
      this.prompt.on("change", (_e, cx) => cx.notify()); // the count under it
      this.promptBase = null;
      this.history = null;
      return;
    }
    if (this.mode === "attach" || this.mode === "pick") {
      // The sidebar's projects as it last found them (props.known, its #74 first paint)
      // draw at once; a fresh discovery replaces them when it answers. The Bots list (pick)
      // shows linked machines' projects too; Attach ties a pane here to a bot here.
      const shown = (q) => q && Array.isArray(q.file?.bots) && (this.mode === "pick" || !q.machine);
      this.projects = Array.isArray(p.known) ? p.known.filter(shown) : null;
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try { this.projects = (await discoverProjects()).filter(shown); } catch (e) { if (!this.projects) this.error = String(e?.message ?? e); }
        this.refreshing = false;
        cx.notify();
      });
      return;
    }
    const notify = (_e, cx) => { this.copied = false; cx.notify(); };
    const field = (placeholder) => { const s = InputState.new({ placeholder }); s.on("change", notify); return s; };
    this.inputs = {
      name: field("Name"), role: field("What it is, in a few words"), note: field("Why it waits"),
      catTitle: field("Category title"), catSub: field("Subtitle (optional)"),
      hermesHome: field("Absolute Hermes data folder"), hermesProfile: field("Exact profile name (default is explicit)"),
    };
    this.instructions = TextareaState.new({ placeholder: "What it does, how it works, whom it reports to" });
    this.instructions.set_auto_grow(5, 10);
    this.instructions.on("change", notify);
    // Every field that isn't typed; formFrom fills it.
    this.s = formFrom({ mode: "create", id: this.mode === "create" ? newBotId() : null });
    this.initial = null; // edit: the state as opened, for "changes only"
    this.file = null;
    this.raw = null;
    this.choice = null; // { parent, own }: the focused folder's project, still to be picked
    this.agents = [];
    this.texts = {}; // the agents' config files (models.js configPaths), for the model line
    this.live = null; // edit of a running bot: { terminal, model }
    this.pop = null; // the open list: "models" | "leads"
    this.copied = false;
    this.pets = new Set();
    this.petsFailed = new Set(); // written once and failed: not tried again (as main.js)
    this.petsNoticed = false;
    this.petsBusy = false;
    this.models = new Map(); // agent -> modelInfo, read once from this.texts
    this.agentsError = null;
    this.dark = isDark(theme().background);
    cx.spawn(async (cx) => {
      await this.loadAgents(this.machine);
      for (const [name, path] of Object.entries(configPaths(home()))) {
        try { this.texts[name] = await readTextFile(path); } catch { this.texts[name] = null; }
      }
      // The pack's Antigravity model cache (modelCache.js): read here, refreshed once a session
      // when Antigravity is the bot's agent and the cache is missing or old (load, set), so the
      // pin list is a local file on every render after that.
      try { this.texts.antigravityModels = await readTextFile(agModelsPath(appHome())); } catch { this.texts.antigravityModels = null; }
      this.models.clear();
      try { await this.open(cx); } catch (e) { this.error = String(e?.message ?? e); }
      this.ensurePets(cx);
      cx.notify();
    });
  }

  // The coding agents Herdr can start on `machine` (null: this computer), installed first.
  // Herdr's own table may not list an agent the pack knows (Antigravity's agy, #793): the
  // pack's AGENTS fills those in, installed by whether their program is on this PATH.
  async loadAgents(machine) {
    this.agentsOn = machine;
    this.agentsError = null;
    try {
      const listed = await knownAgents({ on: machine });
      this.agents = machine ? listed : await this.withPackAgents(listed);
      this.agents.sort((a, b) => Number(b.installed) - Number(a.installed));
    } catch (e) {
      this.agents = [];
      this.agentsError = `Herdr couldn't list ${machine ? `${machine}'s` : "its"} coding agents (${e?.message ?? e}).`;
    }
  }

  // `listed` (knownAgents) with Antigravity added when Herdr doesn't list it (#793), its
  // installed flag read from this computer's PATH and `~/.local/bin` (where agy installs), as
  // knownAgents does. No other pack agent is added: their picker entries stay Herdr's.
  async withPackAgents(listed) {
    const out = (Array.isArray(listed) ? listed : []).map((a) => ({ ...a }));
    const have = new Set(out.map((a) => a.key));
    for (const [key, a] of Object.entries(AGENTS)) {
      if (have.has(key) || !PACK_FORM_AGENTS.has(key)) continue;
      out.push({ key, name: a.name, installed: (await this.programFile(a.run?.[0])) !== null, icon: null, tint: false });
    }
    return out;
  }

  // Where this computer runs `program` from, as the CLI's programPath finds it: PATH, the
  // user bin folder where agy installs, then beside the node running Herdr (an nvm install).
  // Null when it isn't there, so the form and the CLI agree on the program they run.
  async programFile(program) {
    if (typeof program !== "string" || !program) return null;
    if (program.includes("/")) return (await fs.exists(program)) ? program : null;
    const env = typeof process === "undefined" ? {} : process.env;
    const execPath = typeof process === "undefined" ? "" : process.execPath;
    const dirs = [...String(env.PATH ?? "").split(":"), `${home()}/.local/bin`,
      String(execPath ?? "").replace(/\/[^/]*$/, "")].filter(Boolean);
    for (const dir of dirs) {
      const file = `${dir.replace(/\/+$/, "")}/${program}`;
      if (await fs.exists(file)) return file;
    }
    return null;
  }

  // The Antigravity model cache, refreshed once this session when the bot's agent is Antigravity
  // and the cache is missing or older than modelCache's day: `agy models` at most once, then a
  // local file. A failed refresh keeps the last list and records why for the model line.
  async refreshModels() {
    if (this.s?.agent !== "antigravity") return;
    const app = appHome();
    if (MODELS_LOOKED.has(app)) return;
    MODELS_LOOKED.add(app);
    try {
      const r = await refreshAgModels({
        appHome: app,
        read: (path) => readTextFile(path),
        write: async (path, text) => {
          await fs.mkdir(`${app}/automagik-herdr`, { recursive: true });
          await fs.writeFile(path, text);
        },
        // The Herdr mod fs API has no rename: /bin/mv puts the temp file in place, so a reader
        // never sees half a cache. `agy` is resolved as the CLI resolves it (programFile), then
        // run by that absolute path, so PATH differences cannot pick another program.
        rename: async (from, to) => {
          const r = await exec("/bin/mv", [from, to]);
          if (r?.code !== 0) throw new Error(`mv failed (${r?.stderr || `exit ${r?.code}`})`);
        },
        exec: async (command, args, options) => {
          const file = await this.programFile(command);
          if (!file) throw new Error(`${command} isn't installed`);
          return exec(file, args, options);
        },
        now: Date.now(),
      });
      if (typeof r.text === "string") this.texts.antigravityModels = r.text;
      this.modelsWhy = r.why ?? null;
    } catch (e) {
      this.modelsWhy = String(e?.message ?? e);
    }
  }

  // The project's file, named for people: `<key>/.herdr/bots.json`, and its machine.
  fileName(key = this.key, machine = this.machine) {
    return `${key}/${BOTS_PATH}${machine ? ` on ${machine}` : ""}`;
  }

  // Which project (and machine), then its file as it is now (kept as the write's snapshot).
  async open(cx) {
    let key = this.p.project ?? null;
    let machine = this.machine;
    if (this.mode === "edit" && !key) {
      const hit = (await discoverProjects()).find((q) => q.file.bots.some((b) => b.id === this.p.bot));
      if (!hit) throw new Error(`No project has bot ${this.p.bot}.`);
      key = hit.key;
      machine = hit.machine ?? null;
    }
    if (!key) {
      // The focused space's folder (on its machine), when it is still there. Outside git, a
      // walk-up that lands on a parent's project is offered, never assumed (this.choice).
      const shown = spaces().find((s) => s.id === focused()?.space);
      const on = shown?.machine || null;
      if (shown?.folder && await folderExists(shown.folder, on)) {
        const found = await projectOfFolder(shown.folder, on);
        if (found.key === found.own) { key = found.key; machine = on; }
        else this.choice = { parent: found.key, own: found.own, machine: on };
      }
    }
    if (key) await this.load(key, machine);
    cx.notify();
  }

  // Where this form's edit to `key` is written, and the snapshots (RFC 0014 Q16, #234): made
  // from a worktree of the project (the folder picked, `from`, else the focused space's), that
  // worktree's file, which the edit starts from (the key's where the worktree has none yet);
  // else the key's, as before. { dir, text: the text the edit starts from, expected: dir's }.
  async target(key, machine, from = undefined) {
    const shown = spaces().find((s) => s.id === focused()?.space);
    const folder = from !== undefined ? from : (shown?.machine || null) === machine ? shown?.folder : null;
    let dir = key;
    if (folder) {
      try { if (folder === key || await keyOf(folder, machine) === key) dir = await editFolderOf(folder, key, machine); } catch {}
    }
    const expected = await readTextFile(`${dir}/${BOTS_PATH}`, { on: machine });
    const text = dir === key || expected !== null ? expected : await readTextFile(`${key}/${BOTS_PATH}`, { on: machine });
    // readFrom: the file `text` came from; changes: the key's file a pull would stop on.
    const readFrom = dir === key || expected !== null ? dir : key;
    return { dir, text, expected, readFrom, changes: dir !== key ? await changesIn(key, dir) : null };
  }

  // A worktree edit (dir isn't the key): where it is saved, and when the sidebar shows it. The
  // warning sentences are the CLI's worktreeNote's, word for word (#665): only the file shown
  // may differ.
  worktreeNote(dir, key, changes, saved = false) {
    const where = `${saved ? "Saved" : "Saves"} in ${this.fileName(dir)}, this worktree's file. The sidebar reads `
      + `${this.fileName(key)}, so this shows there once the worktree's change is merged and pulled.`;
    const file = this.fileName(key);
    if (changes === "untracked") return `${where} ${file} isn't committed: commit or remove it before pulling, or the pull stops on it.`;
    if (changes === "modified") return `${where} ${file} has local changes: commit or discard them before pulling, or the pull stops on it.`;
    if (changes === "deleted") return `${where} ${file} is deleted: a merge pull brings it back with this worktree's version (a committed deletion would be a modify/delete conflict instead); pull.rebase=true refuses the pull until the deletion is committed or discarded.`;
    if (changes === "deleted-autostash") return `${where} ${file} is deleted: a merge pull brings it back with this worktree's version (a committed deletion would be a modify/delete conflict instead); pull.rebase=true with rebase.autoStash=true stashes the deletion and lets the pull through, then the stash apply conflicts (UD).`;
    if (changes === "staged-deletion") return `${where} ${file} has a staged deletion: restore and commit the file, or unstage the deletion, before pulling; committing the deletion ends the pull in a modify/delete conflict.`;
    if (changes === "committed-deletion") return `${where} ${file} has a committed deletion: a pull that brings this worktree's version ends in a modify/delete conflict; restore and commit the file before pulling, or resolve the conflict after.`;
    return where;
  }

  // An edit's bot missing from the file read: named with the other file when that one has it.
  async noBot(id, dir, key, readFrom) {
    const plain = `${this.fileName(readFrom)} has no bot ${id}.`;
    if (dir === key || readFrom !== dir) return plain;
    let text = null;
    try { text = await readTextFile(`${key}/${BOTS_PATH}`); } catch { return plain; }
    let has = false;
    try { has = text !== null && parseBots(text).file.bots.some((b) => b.id === id); } catch { return plain; }
    return has ? `${this.fileName(dir)}, this worktree's file, has no bot ${id}; ${this.fileName(key)} has it. `
      + `Update this worktree from the main checkout's branch first, or edit it from there.` : plain;
  }

  async load(key, machine = null, from = undefined) {
    this.key = key;
    this.machine = machine;
    this.choice = null;
    this.loadError = null;
    if (this.agentsOn !== machine) await this.loadAgents(machine);
    ({ dir: this.dir, text: this.text, expected: this.expected, readFrom: this.readFrom, changes: this.changes } = await this.target(key, machine, from));
    let file = { version: 1, categories: [], bots: [] };
    this.raw = null;
    if (this.text !== null) {
      try { ({ file, raw: this.raw } = parseBots(this.text)); } catch (e) {
        this.loadError = `${this.fileName(this.readFrom)} can't be read (${e?.message ?? e}); fix it by hand before adding bots.`;
      }
    }
    this.file = file;
    this.space = null;
    for (const s of spaces()) {
      if ((s.machine || null) !== machine || !s.folder) continue;
      try { if (s.folder === key || await keyOf(s.folder, machine) === key) { this.space = s.name; break; } } catch {}
    }
    if (this.mode === "edit") {
      // The entry as stored (raw), so a field the form leaves alone is written back as it was.
      const b = this.raw?.bots?.find((x) => x?.id === this.p.bot) ?? file.bots.find((x) => x.id === this.p.bot);
      if (!b) throw new Error(await this.noBot(this.p.bot, this.dir, key, this.readFrom));
      this.fill(formFrom({ mode: "edit", bot: b }));
      // Snapshot before the model refresh (a slow `agy models`): a field typed while it runs
      // must still differ from the opened state, or the save would look like no change.
      this.initial = this.snapshot();
      await this.refreshModels();
      this.models.clear(); // the refreshed list, not one read before it
      // The model a running pane shows, read from its pane where it runs (machine/tN there).
      this.live = null;
      await this.detect(b, machine);
    } else {
      const agent = this.s.agent || (this.agents.find((a) => a.installed)?.key ?? "");
      const fresh = formFrom({ mode: "create", file, id: this.s.id, agent });
      this.s = { ...this.s, kind: fresh.kind, agent, lead: "", category: "" };
      await this.refreshModels();
    }
  }

  fill(state) {
    this.s = state;
    for (const k of TEXT) this.inputs[k].set_value(state[k] ?? "");
    this.instructions.set_value(state.instructions ?? "");
  }

  // The form as plain data (formModel's state): the picked fields and the typed ones.
  snapshot() {
    const out = { ...this.s, instructions: this.instructions.value() };
    for (const k of TEXT) out[k] = this.inputs[k].value();
    return out;
  }

  // Edit of a running bot: the model its pane runs, read from the pane's command line (A12).
  async detect(bot, machine = null) {
    this.live = null;
    try {
      const live = await liveTerminalOf(bot.id, machine);
      if (!live) return;
      const r = await hc(["get", live.terminal, "--json"]);
      const argv = r.code === 0 ? JSON.parse(r.stdout)?.foreground?.argv : null;
      this.live = { terminal: live.terminal, model: Array.isArray(argv) ? detectModel(argv, bot.agent) : null };
    } catch { this.live = null; }
  }

  // An agent's default model and pin list, read once from the config texts (formModel).
  modelInfo(agent) {
    if (!this.models.has(agent)) this.models.set(agent, modelInfo(agent, this.texts));
    return this.models.get(agent);
  }

  // ---- character pictures ----

  // Every picture the form shows now, as [file, () => its SVG text]: the six interface
  // icons, the preview and the grid in the chosen colour, the sidebar preview (a stopped bot
  // sleeps, A6) and the leads in their own looks.
  wantedPets() {
    const s = this.s;
    const looks = [[s.character, s.colour, "idle"], [s.character, s.colour, "asleep"],
      ...CHARACTERS.map((c) => [c, s.colour, "idle"])];
    for (const o of this.file ? leadOptions(this.file, s.id) : []) looks.push([o.look?.character, o.look?.colour, "idle"]);
    return [
      ...Object.entries(UI_ICONS).map(([name, text]) => [uiIconFile(name), () => text]),
      ...looks.filter(([c, k]) => c && k).map(([c, k, pose]) => [characterFile(c, k, pose, this.dark), () => characterSvg(c, k, pose, this.dark)]),
    ];
  }

  // Writes the pictures not written yet, then redraws (until then each is an empty box). A
  // picture that fails to write is not tried again, and one notice names the folder.
  missingPets() {
    return this.wantedPets().filter(([file]) => !this.pets.has(file) && !this.petsFailed.has(file));
  }

  ensurePets(cx) {
    const todo = this.missingPets();
    if (!todo.length || this.petsBusy) return;
    this.petsBusy = true;
    const folder = `${appHome()}/${PETS}`;
    cx.spawn(async (cx) => {
      let why = null;
      try { await fs.mkdir(folder, { recursive: true }); } catch (e) { why = e; }
      for (const [file, text] of todo) {
        if (why) { this.petsFailed.add(file); continue; }
        const svgText = text();
        try {
          const had = await fs.readFile(`${folder}/${file}`, "utf8").catch(() => null);
          if (had !== svgText) await fs.writeFile(`${folder}/${file}`, svgText);
          this.pets.add(file);
        } catch (e) { this.petsFailed.add(file); why ??= e; }
      }
      if (why && !this.petsNoticed) {
        this.petsNoticed = true;
        notify({ title: "Bots: form pictures not written", body: `Can't write to ${folder} (${why?.message ?? why}); the form shows empty boxes instead.`, level: "warning" });
      }
      this.petsBusy = false;
      cx.notify();
      // A colour picked while writing: its pictures next (failed ones are not retried).
      if (this.missingPets().length) this.ensurePets(cx);
    });
  }

  // An interface icon tinted in `color`, as the sidebar tints Herdr's icons; an empty box
  // of the same size until its file is written.
  glyph(name, size, color) {
    const file = uiIconFile(name);
    return this.pets.has(file) ? svg(`${PETS}/${file}`).size(size).flex_none().text_color(color) : div().size(size).flex_none();
  }

  pet(look, pose, size) {
    const file = characterFile(look?.character, look?.colour, pose, this.dark);
    return this.pets.has(file) ? image(`${PETS}/${file}`).size(size).flex_none() : div().size(size).flex_none();
  }

  set(patch, cx) {
    this.s = { ...this.s, ...patch };
    this.copied = false;
    this.error = null;
    if ("character" in patch || "colour" in patch) this.ensurePets(cx);
    // Antigravity picked for the first time this session: its model list is fetched once now,
    // after the picker draws (modelCache.js), never on a render.
    if (patch.agent === "antigravity") cx.spawn(async (cx) => { await this.refreshModels(); this.models.clear(); cx.notify(); });
    cx.notify();
  }

  // ---- saving ----

  save(cx, andStart = false) {
    if (this.busy) return;
    const state = this.snapshot();
    const info = this.modelInfo(state.agent);
    // A stored pin left alone is written back as it was, listed or not (changes only).
    const pinKept = this.initial && state.pin === this.initial.pin && state.agent === this.initial.agent;
    const why = problemOf(state, { key: this.key, loadError: this.loadError, file: this.file, info: pinKept ? null : info });
    if (why) { this.error = notSaved(why); cx.notify(); return; }
    if (this.mode === "edit" && !editChanged(state, this.initial)) { closeOverlay(this.p.overlay); return; }
    const { entry, newCategory } = entryOf(state, this.file);
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        await writeBots(this.key, applyBotEdit(this.raw, entry, newCategory), this.expected, this.machine, { dir: this.dir, before: this.text });
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = notSaved(/stale/i.test(msg) ? `${this.fileName(this.dir)} changed since this form opened; close it and open it again.` : msg);
        this.busy = false;
        cx.notify();
        return;
      }
      run("am-sidebar.refresh");
      if (this.dir !== this.key) {
        // The sidebar reads the main checkout (Q16): closing would look like nothing was saved.
        this.notice = this.worktreeNote(this.dir, this.key, this.changes, true);
        this.saved = true;
        this.busy = false;
        cx.notify();
        return;
      }
      if (andStart) {
        // Saved either way from here: a refused or failed Start says so, and the form
        // stops offering to create the bot a second time.
        let refused = null;
        try { refused = (await startBot(this.key, entry.id, { sleep: sleepOf(cx) }, this.machine))?.refused ?? null; } catch (e) { refused = String(e?.message ?? e); }
        if (refused) {
          this.error = `Saved, not started: ${refused}`;
          this.saved = true;
          this.busy = false;
          cx.notify();
          return;
        }
      }
      closeOverlay(this.p.overlay);
      this.busy = false;
      cx.notify();
    });
  }

  attach(project, bot, cx) {
    if (this.busy) return;
    this.busy = "attach";
    this.error = null;
    cx.spawn(async (cx) => {
      const r = await attachBot(project.key, bot.id, this.p.terminal, project.machine ?? null);
      this.busy = false;
      if (r.refused) this.error = r.refused;
      else { run("am-sidebar.refresh"); closeOverlay(this.p.overlay); }
      cx.notify();
    });
  }

  // The bot list's and the row menu's actions.
  create() {
    openOverlay({ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE, props: { form: "create" } });
    closeOverlay(this.p.overlay);
  }

  edit(project, bot) {
    openOverlay({ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE,
      props: { form: "edit", bot: bot.id, project: project.key, machine: project.machine ?? null } });
    closeOverlay(this.p.overlay);
  }

  start(project, bot, cx) {
    if (this.busy) return;
    this.busy = "start";
    this.error = null;
    cx.spawn(async (cx) => {
      const r = await startBot(project.key, bot.id, { sleep: sleepOf(cx) }, project.machine ?? null);
      this.busy = false;
      if (r.refused) this.error = r.refused;
      else { run("am-sidebar.refresh"); closeOverlay(this.p.overlay); }
      cx.notify();
    });
  }

  // Restart (the CLI's `restart`, through runCli): the bot's agent again in its pane's
  // place, the old pane ended once the new one is up; `agent` swaps it (Restart on…). A
  // refusal --force overrides (a turn in progress) is offered once more as "Restart anyway".
  restart(project, bot, cx, { agent = null, force = false, fresh = false, tree = false } = {}) {
    if (this.busy) return;
    this.busy = restartKey({ agent, force, fresh });
    this.error = null;
    this.forceable = null;
    this.freshable = null;
    this.helperRestart = null;
    cx.spawn(async (cx) => {
      // On a linked machine: past Herdr's 30 s exec limit, or refused where Herdr has only that (#444).
      const args = restartArgs({ botId: bot.id, projectKey: project.key, agent, force, fresh, tree, machine: project.machine ?? null });
      let result;
      try { result = await (project.machine || tree ? machineCli(args, "restart") : runCli(args)); }
      catch (e) {
        console.error(e?.stack ?? e);
        result = { code: 1, err: String(e?.message ?? e) };
      }
      if (result.code !== 0) console.error(`am restart: ${result.err}`);
      const r = restartAnswer(result);
      this.busy = false;
      if (r.refused) {
        this.error = r.refused;
        this.forceable = r.forceable ? { project, bot, agent } : null;
        this.freshable = r.freshable ? { project, bot } : null;
        this.helperRestart = r.helpers ? { project, bot, agent, fresh } : null;
      } else {
        if (r.queued) {
          notify({ title: "Bots", level: "info", timeout: 15000,
            body: `${bot.name}: restart queued for ${r.terminal} (${r.dialog?.question
              ? `blocked on "${r.dialog.question}" — ${r.dialog.who ?? "the owner"} must answer`
              : `${bot.name} is working`}); it will restart at its next idle.` });
        }
        if (r.warnings.length) notify({ title: "Bots", level: "warning", timeout: 15000, body: r.warnings.join("\n") });
        run("am-sidebar.refresh");
        closeOverlay(this.p.overlay);
      }
      cx.notify();
    });
  }

  /** Restart on…: the installed agents, loaded once when the submenu opens. */
  toggleSwap(cx) {
    this.swapOpen = !this.swapOpen;
    if (this.swapOpen && !this.swapAgents) {
      cx.spawn(async (cx) => {
        try { this.swapAgents = (await this.withPackAgents(await knownAgents())).filter((a) => a.installed !== false && !LEGACY_AGENTS[a.key]); }
        catch { this.swapAgents = []; }
        cx.notify();
      });
    }
    cx.notify();
  }

  // ---- the bot menu's Prompt, Inspect, Focus and Detach ----

  /** Opens or closes a menu section in place; the first open reads what it shows. */
  toggle(section, cx) {
    if (this.shown.has(section)) { this.shown.delete(section); cx.notify(); return; }
    this.shown.add(section);
    if (section === "prompt" && !this.promptBase && !this.promptReading) {
      cx.spawn(async (cx) => {
        this.promptError = null;
        this.promptReading = true;
        try { await this.loadPrompt(); } catch (e) { this.promptError = String(e?.message ?? e); }
        this.promptReading = false;
        cx.notify();
      });
    }
    if (section === "inspect" && !this.history) {
      cx.spawn(async (cx) => {
        const r = await runCli(["history", this.p.bot, "--project", this.p.project]);
        this.history = r.code === 0 && r.out ? r.out : { error: r.err || `am history failed (exit ${r.code}).` };
        cx.notify();
      });
    }
    cx.notify();
  }

  // The bot as its project's file holds it now, as the Edit form opens it (load): the text
  // read is the save's snapshot, the raw entry what the save edits.
  async loadPrompt() {
    const key = this.p.project;
    const { dir, text, expected, readFrom, changes } = await this.target(key, this.machine ?? null);
    if (text === null) throw new Error(`${this.fileName(readFrom)} is gone.`);
    const { file, raw } = parseBots(text);
    const b = raw?.bots?.find((x) => x?.id === this.p.bot) ?? file.bots.find((x) => x.id === this.p.bot);
    if (!b) throw new Error(await this.noBot(this.p.bot, dir, key, readFrom));
    this.promptBase = { dir, text, expected, changes, raw, file, state: formFrom({ mode: "edit", bot: b }) };
    this.prompt.set_value(this.promptBase.state.instructions ?? "");
  }

  // The Edit form's save (save()) with only the instructions changed: the same rules
  // (problemOf), entry (entryOf) and stale-snapshot write.
  savePrompt(cx) {
    if (this.busy || !this.promptBase) return;
    const { dir, text, expected, changes, raw, file, state: initial } = this.promptBase;
    const key = this.p.project;
    const state = { ...initial, instructions: this.prompt.value() };
    const why = problemOf(state, { key, file });
    if (why) { this.error = notSaved(why); cx.notify(); return; }
    if (!editChanged(state, initial)) { closeOverlay(this.p.overlay); return; }
    const { entry, newCategory } = entryOf(state, file);
    this.busy = "prompt";
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        await writeBots(key, applyBotEdit(raw, entry, newCategory), expected, this.machine, { dir, before: text });
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = notSaved(/stale/i.test(msg) ? `${this.fileName(dir)} changed since this menu opened; close it and open it again.` : msg);
        this.busy = false;
        cx.notify();
        return;
      }
      run("am-sidebar.refresh");
      if (dir !== key) {
        // The row shows the main checkout's file (Q16): the menu stays, saying where it went.
        // Its snapshot is now the text written, so another Save works.
        const saved = applyBotEdit(raw, entry, newCategory);
        const now = botsText(saved, expected ?? text); // the text writeBots wrote
        this.promptBase = { ...this.promptBase, text: now, expected: now, raw: saved, file: parseBots(now).file, state };
        this.promptNotice = this.worktreeNote(dir, key, changes, true);
        this.busy = false;
        cx.notify();
        return;
      }
      closeOverlay(this.p.overlay);
      this.busy = false;
      cx.notify();
    });
  }

  // Focus: what a click on the bot's row does (main.js openWorker): its pane when Herdr shows
  // it; a kept pane without one opens as a tab after its starter's (workerTab.js); else a peek.
  // props.worker is the row's rowWorker(); without it, the bot's own pane by itself.
  focusPane(cx) {
    if (this.busy) return;
    const w = this.p.worker?.terminal ? this.p.worker : { terminal: this.p.live, botTerminal: null, name: this.p.name ?? null };
    const plan = workerClick({ ...w, panes: panes(), spaces: spaces() });
    if (plan.kind !== "open") {
      const { command, args } = clickActionOf(w.terminal, panes());
      run(command, args);
      closeOverlay(this.p.overlay);
      return;
    }
    this.busy = "focus";
    cx.spawn(async (cx) => {
      try { await openWorkerTab(plan, { run, panes, spaces, hc, sleep: sleepOf(cx), notify }); } finally {
        this.busy = false;
        closeOverlay(this.p.overlay);
        cx.notify();
      }
    });
    cx.notify();
  }

  // Detach: the CLI's `detach`, which writes the attach ledger's row and clears the labels.
  detach(cx) {
    if (this.busy) return;
    this.busy = "detach";
    this.error = null;
    cx.spawn(async (cx) => {
      const r = await runCli(["detach", this.p.bot, "--project", this.p.project, ...(this.machine ? ["--machine", this.machine] : [])]);
      this.busy = false;
      if (r.code !== 0) this.error = r.err || `am detach failed (exit ${r.code}).`;
      else { run("am-sidebar.refresh"); closeOverlay(this.p.overlay); }
      cx.notify();
    });
  }

  // ---- drawing (automations' helpers) ----

  button(id, label, t, onClick, opts = {}) {
    return h_flex().id(id).h(opts.h ?? 26).px(9).flex_none().items_center().justify_center().rounded(7).text_size(12)
      .bg(opts.solid ? t.solid : t.raised).text_color(opts.solid ? t.solid_foreground : t.foreground)
      .border_1().border_color(opts.solid ? t.solid : t.border).cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    if (this.mode === "create" || this.mode === "edit") return this.formView(t, cx);
    const list = this.mode === "attach" || this.mode === "pick" || this.mode === "menu";
    const title = { attach: `Attach ${this.p.terminal} as a bot`, pick: "Bots", menu: this.p.name }[this.mode] ?? "Bots";
    const body = this.mode === "menu" ? this.menuBody(t) : this.listBody(t);
    // A popup is as tall as its content, its height only the most (openOverlay), and a live
    // Herdr showed what keeps the body's height there. A scroll area sized as a share of its
    // wrapper (size_full) measures 0 in it: overflow_y_scrollbar's wrapper (#239) and #327's
    // relative wrapper both drew only the title and Cancel (#397). A scroll area that is a flex
    // item itself (flex_1().min_h(0).overflow_y_scroll(), #239's fix) takes its items' height.
    // So the wrapper is a flex column and the area is that item; the bar, paired by name and
    // the only absolute element, fills the wrapper (#241). Past the popup's height both shrink
    // (min_h(0)) and the area scrolls; in a dialog (Attach from the command palette) both fill.
    return v_flex().id("bot-form").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).items_center().border_b(1).border_color(t.border).child(div().font_semibold().child(title)))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(div().id("bot-form-body").flex_1().min_h(0).overflow_y_scroll().child(body))
        .child(Scrollbar.vertical("bot-form-body").absolute().inset_0()))
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_t(1).border_color(t.border)
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
        .child(h_flex().gap(8).justify_end()
          .when(list, (el) => el.child(this.button("bot-cancel", "Cancel", t, () => closeOverlay(this.p.overlay))))));
  }

  // A bot row's right-click (A10, #85): Configure (the Edit form), its Prompt edited in
  // place, Run (inspect.js menuItems: Start or Focus, Restart, Restart with a new
  // conversation, Restart on…, Attach to the pane focused at the click, Detach; none for a
  // planned bot) and Inspect, what happened. A bot defined on a linked machine: Configure and
  // its Prompt, written there (remoteMenu).
  menuBody(t) {
    if (this.machine && this.p.stale) return this.remoteMenu(t);
    const project = { key: this.p.project, machine: this.machine }, bot = { id: this.p.bot };
    // The panes this bot can play: its project machine's (this computer's: a bare tN).
    const local = (x) => (typeof x === "string" && x && (this.machine ? x.startsWith(`${this.machine}/`) : !x.includes("/")) ? x : null);
    const pane = local(this.p.terminal), live = local(this.p.live);
    const items = new Set(menuItems({ planned: Boolean(this.p.planned), live, pane }));
    const item = (id, label, onClick) => h_flex().id(id).h(30).px(10).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    const label = (s) => div().px(10).pt(8).pb(2).text_size(10).font_semibold().text_color(t.dim).child(s);
    const fold = (section) => (this.shown.has(section) ? "▾" : "▸");
    const note = (s) => div().px(10).text_size(12).text_color(t.muted).child(s);
    const fresh = items.has("restart-fresh") || this.freshable;
    return v_flex().p(6).gap(2)
      .child(item("menu-configure", "Configure…", () => this.edit(project, bot)))
      .child(item("menu-prompt", `Prompt ${fold("prompt")}`, (cx) => this.toggle("prompt", cx)))
      .when(this.shown.has("prompt"), (el) => el.child(this.promptView(t)))
      .when(items.has("start") || items.has("focus"), (el) => el.child(label("RUN")))
      .when(items.has("focus"), (el) => el.child(item("menu-focus", this.busy === "focus" ? "Opening…" : `Focus (${live})`, (cx) => this.focusPane(cx))))
      .when(items.has("start"), (el) => el.child(item("menu-start", this.busy === "start" ? "Starting…" : "Start", (cx) => this.start(project, bot, cx))))
      .when(items.has("restart"), (el) => el.child(item("menu-restart", this.busy === "restart" ? "Restarting…" : "Restart", (cx) => this.restart(project, bot, cx))))
      .when(Boolean(this.forceable), (el) => el.child(item("menu-restart-force", this.busy === "restart-force" ? "Restarting…" : "Restart anyway (ends what it is doing)",
        (cx) => {
          const next = this.forceable;
          if (next) this.restart(next.project, next.bot, cx, { agent: next.agent, force: true });
        })))
      .when(Boolean(this.helperRestart), (el) => el
        .child(item("menu-restart-helpers", "Restart with its helpers", (cx) => {
          const next = this.helperRestart;
          if (!next) return;
          this.restart(next.project, next.bot, cx, { agent: next.agent, fresh: next.fresh, tree: true, force: true });
        }))
        .child(item("menu-end-helpers-restart", "End helpers and restart", (cx) => {
          const next = this.helperRestart;
          if (!next) return;
          this.restart(next.project, next.bot, cx, { agent: next.agent, fresh: next.fresh, force: true });
        })))
      .when(Boolean(fresh), (el) => el.child(item("menu-restart-fresh", this.busy === "restart-fresh" ? "Restarting…" : "Restart with a new conversation",
        (cx) => this.restart(project, bot, cx, { fresh: true }))))
      .when(items.has("restart-on"), (el) => el.child(item("menu-restart-on", this.busy === "restart-on" ? "Restarting…" : `Restart on… ${this.swapOpen ? "▾" : "▸"}`, (cx) => this.toggleSwap(cx))))
      .when(items.has("restart-on") && this.swapOpen, (el) => el.children(!this.swapAgents ? [div().px(22).h(26).text_size(12).text_color(t.muted).child("Finding agents…")]
        : this.swapAgents.map((a) => item(`menu-restart-on-${a.key}`, `    ${a.name ?? a.key}`, (cx) => this.restart(project, bot, cx, { agent: a.key })))))
      .when(items.has("attach"), (el) => el.child(item("menu-attach", this.busy === "attach" ? "Attaching…" : `Attach to the focused pane (${pane})`, (cx) => this.attach(project, bot, cx))))
      .when(items.has("detach"), (el) => el.child(item("menu-detach", this.busy === "detach" ? "Detaching…" : `Detach from ${live}`, (cx) => this.detach(cx))))
      // What happened reads this computer's ledgers; a linked machine's comes with part (c).
      .when(!this.machine, (el) => el.child(label("INSPECT"))
        .child(item("menu-inspect", `What happened ${fold("inspect")}`, (cx) => this.toggle("inspect", cx)))
        .when(this.shown.has("inspect"), (el) => el.child(this.historyView(t, note))))
      .when(Boolean(this.machine), (el) => el.child(div().id("menu-remote-note").px(10).pt(6).pb(4).text_size(12).text_color(t.muted)
        .child(`On ${this.machine}. What happened isn't shown for its bots yet.`)));
  }

  // A linked machine that isn't answering (its rows drawn from the last run of Herdr,
  // props.stale): nothing to press until it is back.
  remoteMenu(t) {
    return v_flex().p(6).child(div().id("menu-remote-note").px(10).pt(6).pb(4).text_size(12).text_color(t.muted)
      .child(`${this.machine} isn't answering, so ${this.p.name} shows as last seen. Its menu works once it is back.`));
  }

  // The prompt in place: the bot's instructions, Save writes them as the Edit form would.
  promptView(t) {
    if (this.promptError) return div().id("menu-prompt-error").px(10).text_size(12).text_color(t.ansi1).child(`Can't read the prompt: ${this.promptError}`);
    if (!this.promptBase) return div().px(10).h(26).text_size(12).text_color(t.muted).child("Reading…");
    const n = this.prompt.value().length;
    return v_flex().id("menu-prompt-box").px(6).pb(4).gap(6)
      .child(div().id("menu-prompt-text").p(8).rounded(8).border_1().border_color(t.input).bg(t.surface ?? t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.prompt).w_full().text_size(12)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(n > MAX_INSTRUCTIONS ? t.ansi1 : t.dim).child(`${thousands(n)} / ${thousands(MAX_INSTRUCTIONS)}`))
        .child(this.button("menu-prompt-save", this.busy === "prompt" ? "Saving…" : "Save", t, (cx) => this.savePrompt(cx), { h: 24, solid: true })))
      .when(this.promptBase.dir !== this.p.project, (el) => el.child(div().id("menu-prompt-where").text_size(11).text_color(t.muted)
        .child(this.promptNotice ?? this.worktreeNote(this.promptBase.dir, this.p.project, this.promptBase.changes))));
  }

  // What happened (`automagik-herdr history`): its panes, starts and sessions newest first,
  // the newest transcript (a click copies its path), its workers, and the helpers its pane
  // runs now (props.helpers, from the sidebar's row).
  historyView(t, note) {
    const helpers = Array.isArray(this.p.helpers) ? this.p.helpers.filter((h) => typeof h?.terminal === "string") : [];
    const box = v_flex().id("menu-history").px(4).pb(6).gap(2).text_size(12);
    if (!this.history) return box.child(note("Reading the ledgers…"));
    if (this.history.error) return box.child(div().px(10).text_size(12).text_color(t.ansi1).child(this.history.error));
    const { timeline, workers, transcript } = historyLines(this.history);
    const line = (id, s) => div().id(id).px(10).min_w(0).truncate().text_color(t.foreground).child(s);
    return box
      .children(timeline.length ? timeline.map((e, i) => line(`menu-history-${i}`, e.text)) : [note("Nothing recorded on this computer yet.")])
      .when(Boolean(transcript), (el) => el.child(h_flex().id("menu-transcript").px(10).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(transcript)
        .on_click((_e, cx) => { cx.write_to_clipboard(transcript); this.copiedTranscript = true; cx.notify(); })
        .child(div().flex_none().text_color(t.muted).child(this.copiedTranscript ? "Copied:" : "Transcript:"))
        .child(div().flex_1().min_w(0).truncate().child(transcript))))
      .when(workers.length > 0, (el) => el.child(div().px(10).pt(4).text_size(10).font_semibold().text_color(t.dim).child("WORKERS"))
        .children(workers.map((w, i) => line(`menu-worker-${i}`, w))))
      .when(helpers.length > 0, (el) => el.child(div().px(10).pt(4).text_size(10).font_semibold().text_color(t.dim).child("HELPERS NOW"))
        .children(helpers.map((h) => line(`menu-helper-${h.terminal}`, [h.name, h.terminal].filter(Boolean).join(" · ")))));
  }

  // The bots by project: click one to attach the pane (attach: this computer's), or Edit /
  // Start / Restart (pick; a linked machine's project named with its machine).
  listBody(t) {
    const label = (s) => div().pt(8).text_size(11).font_semibold().text_color(t.dim).child(s);
    if (!this.projects) return div().p(14).text_color(t.muted).child("Finding bots…");
    const pick = this.mode === "pick";
    const rows = this.projects.flatMap((q) => {
      const bots = q.file.bots.filter((b) => pick || !b.planned);
      if (!bots.length) return [];
      const title = base(q.key).toUpperCase();
      return [label(q.machine ? `${title} · ${q.machine}` : title), ...bots.map((b) =>
        h_flex().id(`pick-${b.id}`).h(30).px(8).gap(8).items_center().rounded(7).hover((s) => s.bg(t.hover))
          .when(!pick, (el) => el.cursor_pointer().on_click((_e, cx) => this.attach(q, b, cx)))
          // The name truncates after the role, so Edit / Start / Restart stay inside the popup.
          .child(div().min_w(0).truncate().child(b.name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
            .child(b.planned ? `planned · wave ${b.planned.wave}` : b.kind === "main" ? "Main bot" : b.role))
          .when(pick, (el) => el.child(this.button(`edit-${b.id}`, "Edit", t, () => this.edit(q, b), { h: 22 }))
            .when(!b.planned, (el) => el.child(this.button(`start-${b.id}`, "Start", t, (cx) => this.start(q, b, cx), { h: 22 }))
              .child(this.button(`restart-${b.id}`, "Restart", t, (cx) => this.restart(q, b, cx), { h: 22 })))))];
    });
    if (!rows.length && pick && !this.refreshing) {
      // No bot yet: the list offers the one thing to do, the Create form.
      return v_flex().p(14).gap(2).child(h_flex().id("pick-new").h(30).px(8).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => this.create()).child("New bot"));
    }
    // Nothing known yet and the discovery still out: it is looking, not empty.
    const none = this.refreshing ? "Finding bots…" : "No bots on this computer yet. Create one first.";
    return v_flex().p(14).gap(2).children(rows.length ? rows : [div().text_color(t.muted).child(none)]);
  }

  // ---- the Create / Edit form (mockup/create-form.dc.html) ----

  formView(t, cx) {
    const state = this.snapshot();
    const file = this.file;
    const agent = this.agents.find((a) => a.key === state.agent) ?? null;
    const info = this.modelInfo(state.agent);
    const live = this.live && this.live.model ? this.live : null;
    const model = modelLine({ agentName: agent?.name ?? state.agent, agentKey: state.agent, pin: state.pin, info, detected: live?.model ?? null, terminal: live?.terminal ?? null });
    const place = placeOf(state, file);
    const cli = commandOf(state, { key: this.dir ?? this.key, file, initial: this.initial, machine: this.machine });
    const pinKept = this.initial && state.pin === this.initial.pin && state.agent === this.initial.agent;
    const refusal = problemOf(state, { key: this.key, loadError: this.loadError, file, info: pinKept ? null : info });
    const v = { t, state, agent, info, model, place, cli, refusal, mono: settings()?.font_family ?? "JetBrains Mono" };
    return v_flex().id("bot-form").size_full().min_h(0).rounded(14).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(v))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(this.leftColumn(v))
        .child(this.rightColumn(v)))
      .child(this.footer(v));
  }

  label(t, text) {
    return div().text_size(11).font_semibold().text_color(t.muted).child(text.toUpperCase());
  }

  // A text field framed as the mockup draws it.
  field(t, id, state, opts = {}) {
    return div().id(id).h(opts.h ?? 36).px(opts.px ?? 12).flex().items_center().rounded(8).border_1().border_color(t.input)
      .bg(t.surface ?? t.background).when(Boolean(opts.grow), (el) => el.flex_1().min_w(0))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().w_full().text_size(opts.size ?? 13).when(Boolean(opts.bold), (el) => el.font_semibold()));
  }

  chip(t, id, text, onClick, { on = false, dashed = false } = {}) {
    return h_flex().id(id).px(11).py(5).items_center().rounded_full().text_size(12).font_medium().cursor_pointer()
      .border_1().when(dashed, (el) => el.border_dashed()).border_color(on ? t.accent : t.border)
      .bg(on ? t.selected : CLEAR).text_color(on ? t.foreground : dashed ? t.muted : t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(text);
  }

  header({ t, state }) {
    const chip = h_flex().id("bot-project").gap(6).px(10).py(4).items_center().rounded_full().border_1().border_color(t.border)
      .bg(t.surface ?? t.background).text_size(12)
      .child(this.glyph("folder", 13, t.muted))
      .child(div().text_color(t.foreground).child(this.key ? base(this.key) : "Pick a project…"))
      .when(Boolean(this.key && this.machine), (el) => el.child(div().id("bot-machine").text_color(t.muted).child(`on ${this.machine}`)))
      .when(Boolean(this.space), (el) => el.child(div().text_color(t.muted).child(`· ${this.space}`)))
      .when(this.mode === "create", (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(this.key ? `${this.key}. Change project` : "Pick the project folder")
        .child(this.glyph("chevron", 10, t.muted))
        .on_click((_e, cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Use this project" });
          if (dir) {
            // A picked folder is the project itself outside git (its git main checkout in it).
            try { await this.load(await ownKeyOf(dir), null, dir); this.error = null; this.ensurePets(cx); } catch (e) { this.error = String(e?.message ?? e); }
          }
          cx.notify();
        })))
      .when(this.mode !== "create" && Boolean(this.key), (el) => el.tooltip(this.machine ? `${this.key} on ${this.machine}` : this.key));
    // The focused folder sits under another project's folder: which project is it?
    const pick = (id, text, key) => this.chip(t, id, text, (cx) => cx.spawn(async (cx) => {
      try { await this.load(key, this.choice?.machine ?? null); this.error = null; this.ensurePets(cx); } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    }));
    const choice = this.mode === "create" && !this.key && this.choice ? this.choice : null;
    return h_flex().flex_none().gap(12).px(20).py(16).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(12).items_center()
        .child(div().text_size(17).font_semibold().child(this.mode === "edit" ? "Edit bot" : "New bot"))
        .child(chip)
        .when(Boolean(choice), (el) => el
          .child(pick("bot-project-parent", `${base(choice.parent)} (parent project)`, choice.parent))
          .child(pick("bot-project-own", `Make ${base(choice.own)} its own project`, choice.own))))
      .when(Boolean(this.loadError), (el) => el.child(div().max_w(360).text_size(11).text_color(t.ansi1).child(this.loadError)))
      .child(h_flex().id("bot-close").size(32).flex_none().items_center().justify_center().rounded(8).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Close").accessibility_label("Close")
        .on_click(() => closeOverlay(this.p.overlay)).child(this.glyph("close", 16, t.muted)));
  }

  leftColumn({ t, state, agent, model }) {
    const look = { character: state.character, colour: state.colour };
    const ink = INKS[state.colour]?.[this.dark ? 1 : 0] ?? t.accent;
    const tiles = CHARACTERS.map((c) => {
      const on = c === state.character;
      return h_flex().id(`bot-char-${c}`).flex_1().h(40).p(4).items_center().justify_center().rounded(8).cursor_pointer()
        .border_1().border_color(on ? ink : CLEAR).bg(on ? t.selected : t.surface ?? t.background)
        .hover((s) => s.bg(t.hover)).tooltip(c).accessibility_label(c)
        .on_click((_e, cx) => this.set({ character: c }, cx))
        .child(this.pet({ character: c, colour: state.colour }, "idle", 30));
    });
    const rows = [0, 7, 14].map((i) => h_flex().gap(4).children(tiles.slice(i, i + 7)));
    const swatches = COLOUR_ORDER.map((k) => {
      const on = k === state.colour;
      const paint = INKS[k][this.dark ? 1 : 0];
      return h_flex().id(`bot-colour-${k}`).size(26).flex_none().items_center().justify_center().rounded_full().cursor_pointer()
        .border_2().border_color(on ? paint : CLEAR).tooltip(k).accessibility_label(k)
        .on_click((_e, cx) => this.set({ colour: k }, cx))
        .child(div().size(18).rounded_full().bg(paint));
    });
    const pill = (id, text, onClick, glyph = null) => h_flex().id(id).gap(5).px(10).py(4).items_center().rounded_full().text_size(11)
      .border_1().border_color(t.border).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).when(Boolean(glyph), (el) => el.child(this.glyph(glyph, 11, t.foreground))).child(text);
    const program = agent ?? null;
    return v_flex().id("bot-left").w(340).h_full().flex_none().px(20).py(18).gap(16).overflow_y_scrollbar()
      .bg(t.chrome ?? t.surface ?? t.background).border_r(1).border_color(t.border)
      .child(v_flex().items_center().gap(10).pt(16).pb(12).rounded(12).bg(t.surface ?? t.background).border_1().border_color(t.border)
        .child(this.pet(look, "idle", 112))
        .child(h_flex().gap(6)
          .child(pill("bot-omni", "Omni preset", (cx) => this.set(omniLook(), cx)))
          .child(pill("bot-shuffle", "Shuffle", (cx) => this.set({
            character: CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)],
            colour: COLOUR_ORDER[Math.floor(Math.random() * COLOUR_ORDER.length)],
          }, cx), "shuffle"))))
      .child(v_flex().gap(6).child(this.label(t, "Name")).child(this.field(t, "bot-name", this.inputs.name, { size: 14, bold: true })))
      .child(v_flex().gap(6).child(this.label(t, "Character")).child(v_flex().gap(4).children(rows)))
      .child(v_flex().gap(8).child(this.label(t, "Colour")).child(h_flex().flex_wrap().gap(3).children(swatches)))
      .child(v_flex().mt_auto().gap(6).child(this.label(t, "In the sidebar"))
        .child(h_flex().gap(8).px(8).py(6).items_center().rounded(8).bg(t.surface ?? t.background).border_1().border_color(t.border)
          .child(this.pet(look, "asleep", 26))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().truncate().text_size(13).font_semibold().text_color(inkOf(state.colour, this.dark)).child(state.name.trim() || "new-bot"))
            .child(div().truncate().text_size(11).text_color(t.muted).child(rowLineOf(state, model.shown))))
          .when(!state.planned, (el) => el
            .child(icon(program, 15, t.foreground) ?? image("icons/shell.svg").size(15).flex_none())
            .child(div().size(8).mx(3).flex_none().rounded_full().border_1().border_color(t.muted).tooltip("Not running")))));
  }

  rightColumn(v) {
    const { t, state } = v;
    const n = state.instructions.length;
    const tone = countTone(n);
    return v_flex().id("bot-right").flex_1().min_w(0).h_full().px(24).py(18).gap(18).overflow_y_scrollbar()
      .child(v_flex().gap(6).child(this.label(t, "Role")).child(this.field(t, "bot-role", this.inputs.role)))
      .child(v_flex().gap(6)
        .child(h_flex().gap(8).items_baseline()
          .child(div().flex_1().child(this.label(t, "Instructions")))
          .child(div().font_family(v.mono).text_size(11).text_color(tone === "over" ? t.ansi1 : tone === "near" ? t.ansi3 : t.muted)
            .child(`${thousands(n)} / ${thousands(MAX_INSTRUCTIONS)}`)))
        .child(div().id("bot-instructions").px(12).py(10).rounded(8).border_1().border_color(tone === "over" ? t.ansi1 : t.input)
          .bg(t.surface ?? t.background).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.instructions).w_full().text_size(13)))
        .child(div().text_size(11).text_color(tone === "over" ? t.ansi1 : t.muted).child(tone === "over"
          ? `${thousands(n - MAX_INSTRUCTIONS)} characters over the limit; it can't be saved like this.`
          : "Given to the bot when it starts, in its system prompt; an edit reaches it at its next restart.")))
      .child(this.runsOn(v))
      .child(this.team(v));
  }

  // "Runs on": Herdr's own agents (knownAgents) as cards, installed first; one not installed
  // is shown dimmed and can't be picked. Then the model line and the pin list.
  runsOn(v) {
    const { t, state, info, model } = v;
    // Installed agents only, plus the bot's own agent when it isn't installed (shown dimmed).
    // Retired agents (LEGACY_AGENTS: gemini) are never offered, though Herdr still lists them.
    const listed = this.agents.filter((a) => a.installed && !Object.hasOwn(LEGACY_AGENTS, a.key));
    if (state.agent && !listed.some((a) => a.key === state.agent)) {
      listed.push(this.agents.find((a) => a.key === state.agent) ?? { key: state.agent, name: state.agent, installed: false, icon: null });
    }
    const cards = listed.map((a) => {
      const on = a.key === state.agent;
      const can = a.installed || on;
      return v_flex().id(`bot-agent-${a.key}`).flex_1().min_w(0).h(56).p(6).gap(5).items_center().justify_center().rounded(10)
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface ?? t.background)
        .opacity(a.installed ? 1 : 0.45)
        .when(can, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.pop = null; this.set({ agent: a.key, pin: "" }, cx); }))
        .when(!can, (el) => el.cursor_not_allowed().tooltip(`${a.name} isn't installed on this computer`))
        .child(icon(a, 18, t.foreground) ?? image("icons/shell.svg").size(18).flex_none())
        .child(div().max_w_full().truncate().text_size(11).font_medium().text_color(t.foreground).child(a.installed ? a.name : `${a.name} · not installed`));
    });
    const rows = [];
    for (let i = 0; i < cards.length; i += 5) {
      const row = cards.slice(i, i + 5);
      while (row.length < 5) row.push(div().flex_1());
      rows.push(h_flex().gap(6).children(row));
    }
    const options = modelOptions(info, state.pin);
    const open = this.pop === "models";
    const trigger = Button.new("bot-pin").flex_none().gap(6).px(10).py(6).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).accessibility_label("Pin a model")
      .child(state.pin ? "Change pin" : "Pin a model").child(this.glyph("chevron", 10, t.muted));
    const list = v_flex().w(260).p(4).gap(1).rounded(10).border_1().border_color(t.border).bg(t.popover ?? t.raised)
      .children(options.map((o, i) => Button.new(`bot-pin-${i}`).h(30).px(10).gap(8).items_center().rounded(7).cursor_pointer()
        .selected(o.id === state.pin).set_position(i + 1, options.length).accessibility_label(o.label)
        .bg(o.id === state.pin ? t.selected : CLEAR).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pop = null; this.set({ pin: o.id }, cx); })
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).when(Boolean(o.id), (el) => el.font_family(v.mono)).child(o.label))
        .child(div().text_size(11).text_color(t.muted).child(o.hint))));
    const pin = Popover.new("bot-models").anchor("top_right").trigger(trigger).open(open)
      .on_open_change((o, cx) => { this.pop = o ? "models" : null; cx.notify(); })
      .when(open, (el) => el.content(list));
    const modeChoice = (value, text) => {
      const on = state.agyMode === value;
      return h_flex().id(`bot-agy-mode-${value}`).px(12).py(5).rounded(7).text_size(12).cursor_pointer()
        .bg(on ? t.selected : CLEAR).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.pop = null; this.set({ agyMode: value }, cx); })
        .child(text);
    };
    return v_flex().gap(10)
      .child(this.label(t, "Runs on"))
      .when(state.agent === "hermes", (el) => el.child(v_flex().gap(6)
        .child(this.label(t, "Pair an existing Hermes Bot"))
        .child(this.field(t, "bot-hermes-home", this.inputs.hermesHome))
        .child(this.field(t, "bot-hermes-profile", this.inputs.hermesProfile))
        .child(div().text_size(11).text_color(t.muted).child("Start and restart open this profile's existing Bot Chat on the selected machine. Leave both empty for an unpaired session. Pairing keeps Hermes's own instructions and model."))))
      .child(v_flex().gap(6).children(rows.length ? rows : [div().text_size(12).text_color(this.agentsError ? t.ansi1 : t.muted)
        .child(this.agentsError ?? (this.agents.length ? "No coding agent is installed on this computer." : "Finding Herdr's coding agents…"))]))
      .child(h_flex().gap(10).px(12).py(10).items_center().rounded(10).border_1().border_color(t.border).bg(t.surface ?? t.background)
        .child(this.glyph("clock", 16, t.accent))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(4).text_size(13).font_medium().child("Model:")
            .child(div().min_w(0).truncate().font_family(v.mono).text_color(t.accent).child(model.shown)))
          .child(div().text_size(11).text_color(t.muted).child(model.note)))
        .when(info.models.length > 0 || Boolean(state.pin), (el) => el.child(pin)))
      .when(state.agent === "antigravity", (el) => el.child(v_flex().gap(6)
        .child(this.label(t, "Antigravity mode"))
        .child(h_flex().items_center().gap(10)
          .child(h_flex().p(3).rounded(9).bg(t.surface ?? t.background).border_1().border_color(t.border)
            .child(modeChoice("auto", "Auto"))
            .child(modeChoice("accept-edits", "Accept edits"))
            .child(modeChoice("plan", "Plan")))
          .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted)
            .child("Passed to agy as --mode at this bot's start and restart (auto is the default). agy's own settings are never written.")))));
  }

  // "Place in the team": kind, lead, category (A1, A2) and planned (A3).
  team(v) {
    const { t, state, place } = v;
    const seg = (kind, text) => {
      const on = state.kind === kind;
      const why = place.why[kind];
      return h_flex().id(`bot-kind-${kind}`).px(14).py(6).rounded(7).text_size(12)
        .bg(on ? t.selected : CLEAR).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
        .when(!on && !why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.pop = null; this.set({ kind, lead: "", category: "" }, cx); this.ensurePets(cx); }))
        .when(!on && Boolean(why), (el) => el.opacity(0.55).cursor_not_allowed().tooltip(why))
        .child(text);
    };
    const reason = state.kind === "member" ? place.why.main : place.why.member;
    const member = state.kind === "member";
    return v_flex().gap(12)
      .child(this.label(t, "Place in the team"))
      .child(h_flex().gap(12).items_center()
        .child(h_flex().p(3).rounded(9).bg(t.surface ?? t.background).border_1().border_color(t.border)
          .child(seg("main", "Main bot")).child(seg("member", "Team member")))
        .when(Boolean(reason), (el) => el.child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(reason))))
      .when(member, (el) => el.child(this.reportsTo(v)).child(this.category(v)).child(this.rank(v)))
      .when(!member, (el) => el.child(div().text_size(12).text_color(t.muted)
        .child("The project's main bot: every other bot reports to it, directly or through a lead.")))
      .child(this.codeBlock(v))
      .child(this.plannedBlock(v));
  }

  reportsTo(v) {
    const { t, state, place } = v;
    const options = this.file ? leadOptions(this.file, state.id) : [];
    const lead = place.lead;
    const open = this.pop === "leads";
    const who = (o, size) => [this.pet(o.look, "idle", size),
      div().flex_none().text_size(size > 20 ? 13 : 12).font_semibold().text_color(inkOf(o.look?.colour, this.dark)).child(o.name),
      div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(o.note)];
    const trigger = Button.new("bot-lead").w_full().h(38).px(10).gap(8).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(t.input).bg(t.surface ?? t.background).hover((s) => s.bg(t.hover)).accessibility_label("Reports to")
      .children(lead ? who(lead, 22) : [div().flex_1().text_size(12).text_color(t.muted).child("No main bot in this project")])
      .child(this.glyph("chevron", 10, t.muted));
    const list = v_flex().w(420).max_h(320).overflow_y_scrollbar().id("bot-lead-list").p(4).gap(1).rounded(10)
      .border_1().border_color(t.border).bg(t.popover ?? t.raised)
      .children(options.map((o, i) => Button.new(`bot-lead-${o.id}`).h(30).pl(10 + o.depth * 18).pr(10).gap(8).items_center().rounded(7)
        .cursor_pointer().selected(o.id === place.leadId).set_position(i + 1, options.length).accessibility_label(o.name)
        .bg(o.id === place.leadId ? t.selected : CLEAR).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pop = null; this.set({ lead: o.id }, cx); })
        .children(who(o, 20))));
    const pick = Popover.new("bot-leads").anchor("top_left").trigger(trigger).open(open)
      .on_open_change((o, cx) => { this.pop = o ? "leads" : null; cx.notify(); })
      .when(open, (el) => el.content(list));
    return v_flex().gap(4)
      .child(h_flex().gap(12).items_center()
        .child(div().w(84).flex_none().text_size(12).text_color(t.foreground).child("Reports to"))
        .child(div().flex_1().min_w(0).child(pick)))
      .when(Boolean(place.stale), (el) => el.child(div().pl(96).text_size(11).text_color(t.ansi3).child(`Stored lead: ${place.stale}.`)));
  }

  category(v) {
    const { t, state, place } = v;
    const row = h_flex().gap(12).items_start()
      .child(div().w(84).flex_none().pt(6).text_size(12).text_color(t.foreground).child("Category"));
    if (!place.byMain) {
      return row.child(div().flex_1().pt(6).text_size(12).text_color(t.muted).child(`Shows under ${place.lead?.name ?? "its lead"}, in its category.`));
    }
    const cats = this.file?.categories ?? [];
    const pickCat = (id) => (cx) => this.set({ category: state.category === id ? "" : id }, cx);
    return row.child(v_flex().flex_1().min_w(0).gap(8)
      .child(h_flex().flex_wrap().gap(6)
        .children(cats.map((c) => this.chip(t, `bot-cat-${c.id}`, c.title, pickCat(c.id), { on: c.id === state.category })
          .when(Boolean(c.sub), (el) => el.tooltip(c.sub))))
        .child(this.chip(t, "bot-cat-new", "+ New", pickCat(NEW_CATEGORY), { on: state.category === NEW_CATEGORY, dashed: state.category !== NEW_CATEGORY })))
      .when(state.category === NEW_CATEGORY, (el) => el.child(h_flex().gap(8)
        .child(this.field(t, "bot-cat-title", this.inputs.catTitle, { h: 32, size: 12, px: 10, grow: true }))
        .child(this.field(t, "bot-cat-sub", this.inputs.catSub, { h: 32, size: 12, px: 10, grow: true })))));
  }

  // A16: an optional rank, the pane's role= label; none plus the closed set, as chips.
  rank(v) {
    const { t, state } = v;
    const pick = (rank) => (cx) => this.set({ rank }, cx);
    return h_flex().gap(12).items_start()
      .child(div().w(84).flex_none().pt(6).text_size(12).text_color(t.foreground).child("Rank"))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(h_flex().flex_wrap().gap(6)
          .child(this.chip(t, "bot-rank-none", "None", pick(""), { on: !state.rank }))
          .children(RANKS.map((r) => this.chip(t, `bot-rank-${r}`, r, pick(r), { on: state.rank === r }))))
        .child(div().text_size(11).text_color(t.muted)
          .child("Optional; the pane's role= label. The main bot is role=main, and a bot others report to is captain, automatically.")));
  }

  booleanToggle(t, id, on, label, field) {
    return h_flex().id(id).w(34).h(20).flex_none().p(2).rounded_full().cursor_pointer()
      .bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end()).accessibility_label(label)
      .on_click((_e, cx) => this.set({ [field]: !on }, cx))
      .child(div().size(14).rounded_full().bg(on ? t.accent_foreground ?? "#ffffff" : t.muted));
  }

  codeBlock(v) {
    const { t, state } = v;
    const toggle = this.booleanToggle(t, "bot-code", state.code !== false,
      "Code bot (worker instruction in Git projects)", "code");
    return v_flex().gap(10).px(12).py(10).rounded(10).border_1().border_color(t.border)
      .bg(t.surface ?? t.background)
      .child(h_flex().gap(10).items_center()
        .child(toggle)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(13).font_medium().child("Code bot"))
          .child(div().text_size(11).text_color(t.muted)
            .child("Gets the worker instruction in Git projects. Turn off for writing, planning or research bots."))));
  }

  plannedBlock(v) {
    const { t, state } = v;
    const on = state.planned;
    const top = Math.max(MAX_WAVE, this.initial?.wave ?? 1);
    const step = (id, text, label, d) => h_flex().id(id).w(28).h(30).items_center().justify_center().cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).accessibility_label(label)
      .on_click((_e, cx) => this.set({ wave: Math.min(top, Math.max(1, state.wave + d)) }, cx)).child(text);
    const toggle = this.booleanToggle(t, "bot-planned", on, "Planned for a later wave", "planned");
    return v_flex().gap(10).px(12).py(10).rounded(10).border_1().when(on, (el) => el.border_dashed()).border_color(t.border)
      .bg(on ? t.background : t.surface ?? t.background)
      .child(h_flex().gap(10).items_center()
        .child(toggle)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(13).font_medium().child("Planned for later"))
          .child(div().text_size(11).text_color(t.muted).child("Shows dimmed in the sidebar with its wave; it can't start until you clear this."))))
      .when(on, (el) => el.child(h_flex().pl(44).gap(10).items_center()
        .child(h_flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.surface ?? t.background)
          .child(step("bot-wave-down", "−", "Earlier wave", -1))
          .child(div().min_w(54).text_center().text_size(12).font_semibold().child(`Wave ${state.wave}`))
          .child(step("bot-wave-up", "+", "Later wave", 1)))
        .child(this.field(t, "bot-note", this.inputs.note, { h: 32, size: 12, px: 10, grow: true }))));
  }

  footer(v) {
    const { t, state, cli, refusal } = v;
    const creating = this.mode === "create";
    const done = this.saved === true; // created, Start refused (or saved in a worktree): nothing left to create
    // Saved in a worktree (RFC 0014 Q16): bots start from the main checkout's file, so no Create & start.
    const worktree = Boolean(this.key && this.dir && this.dir !== this.key);
    const save = creating ? (state.planned ? "Create planned bot" : "Create") : "Save";
    const btn = (id, text, onClick, kind) => h_flex().id(id).h(38).px(16).flex_none().items_center().rounded(8).text_size(13)
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx))
      .when(kind === "ghost", (el) => el.font_medium().text_color(t.foreground))
      .when(kind === "raised", (el) => el.font_semibold().border_1().border_color(t.border).bg(t.raised).text_color(t.foreground))
      .when(kind === "solid", (el) => el.font_bold().bg(t.accent).text_color(t.accent_foreground ?? t.background))
      .child(text);
    return v_flex().flex_none().gap(8).px(20).py(14).border_t(1).border_color(t.border).bg(t.chrome ?? t.surface ?? t.background)
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .when(worktree, (el) => el.child(div().id("bot-where").text_size(12).text_color(t.muted)
        .child(this.notice ?? this.worktreeNote(this.dir, this.key, this.changes))))
      .child(h_flex().gap(12).items_center()
        .child(h_flex().flex_1().min_w(0).gap(8).py(6).pl(10).pr(6).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
          .child(div().flex_none().font_family(v.mono).text_size(11).text_color(t.muted).child("$"))
          .child(div().flex_1().min_w(0).truncate().font_family(v.mono).text_size(11).text_color(t.foreground).tooltip(cli).child(cli))
          .child(h_flex().id("bot-copy").flex_none().gap(5).px(8).py(4).items_center().rounded(6).bg(t.raised).text_size(11)
            .text_color(t.foreground).accessibility_label("Copy the command")
            // A line the form would refuse to save is never copied: the refusal shows instead.
            .when(!refusal, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.write_to_clipboard(cli); this.copied = true; cx.notify(); }))
            .when(Boolean(refusal), (el) => el.opacity(0.5).cursor_not_allowed().tooltip(`Not copied: ${refusal}`)
              .on_click((_e, cx) => { this.error = `Not copied: ${refusal}`; cx.notify(); }))
            .child(this.glyph("copy", 12, t.foreground)).child(this.copied ? "Copied" : "Copy")))
        .child(btn("bot-cancel", done ? "Close" : "Cancel", () => closeOverlay(this.p.overlay), "ghost"))
        .when(!done, (el) => el.child(btn("bot-save", this.busy ? "Saving…" : save, (cx) => this.save(cx), "raised")))
        .when(!done && creating && !state.planned && !worktree, (el) => el.child(btn("bot-save-start", this.busy ? "Starting…" : "Create & start", (cx) => this.save(cx, true), "solid"))));
  }
}
