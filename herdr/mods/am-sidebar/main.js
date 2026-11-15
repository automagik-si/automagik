// Changed from Herdr's `spaces` 0.1.7 by the Automagik Herdr pack (the am-sidebar mod);
// see the repository history for each change. Apache-2.0.
//
// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Click to
// switch, right-click for its menu, drag to reorder. Under each space, its agents
// as the agents list names them (sub-agents beneath); click one to focus it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, focused, setAgentOrder, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, nextCommand, readTextFile, writeTextFile, appHome, home, knownAgents, notify, props } from "herdr";
import * as fs from "fs/promises";
import { isPng, keysFor, remote } from "./paste.js";
import { command } from "./argv.js";
import { discoverProjects, discoverySnapshot, restoreDiscovery, watchProject, paneKeyOfFolder } from "./bots.js";
import { BOT_LABEL } from "./model.js";
import { BotForm, FORM_SIZE } from "./create.js";
import { SpaceIconDialog, spaceIconOverlay } from "./spaceIcon.js";
import { ensureTheme, themeSettled } from "./theme.js";
import { SHARED_RENAMES, carryShared } from "./migrate.js";
import { Updater } from "./updater.js";
import { METER_EVERY_MS, METER_FIRST_MS, meterBin, syncMeter, syncTargets, writeFleetRecord } from "./meter.js";
import { parseMarker } from "./release.js";
import { fleetPlan, meterScope } from "./meterFleet.js";
import { MACHINES_FIRST_MS, MACHINES_SHOWN_KEY, MACHINES_TICK_MS, STATE_FILE as MACHINES_STATE, failureNotice, parseState as parseMachines, startCycle } from "./machineUpdates.js";
import { startBot, attachBot, botOfTerminal, modelTexts, sleepOf } from "./launch.js";
import { actionError } from "./actionError.js";
import { parseCommand } from "./launchArgs.js";
import { characterSvg, characterFile, inkOf, isDark } from "./characters.js";
import { workerClick, rowWorker, openWorkerTab } from "./workerTab.js";
import { liveFrom, buildTree, placeTrees, placesOf, withSpaceless, knownBots, nextWake, projectId, secondLine, modelTextsUpdate, argvToAsk, argvAfter, argvReader, spaceRowOrder, clickActionOf, heldTerminalOf, heldClickOf, listedKeyOf, parentMarkText, orderMachines, movedToTop, readMachineOrder, programForApp, needsYouText } from "./rows.js";

// The pack itself as a dialog: the bot form (create.js), or the attach picker, the Bots list
// and a bot row's menu as a popup (a popup is as tall as its items; height is only the most).
// The Bots list's rows carry Edit / Start / Restart, so it is as wide as the menu.
function openBotForm(form, kind = "dialog") {
  openOverlay(kind === "popup"
    ? { mod: "am-sidebar", kind: "popup", width: form.form === "attach" ? 300 : 380, height: form.form === "menu" ? 640 : 360, props: form }
    : { mod: "am-sidebar", kind: "dialog", modal: true, ...(form.form === "create" || form.form === "edit" ? FORM_SIZE : { width: 560, height: 0.85 }), props: form });
}

// A terminal row's click: its pane when it has one, else a peek (a parked seat has no pane).
function focusOrPeek(terminal) {
  const { command, args } = clickActionOf(terminal, panes());
  run(command, args);
}

// Agent naming, as in the agents mod.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
// `byTab`: each tab's panes that have a terminal, in panes() order (groupBy, once per render).
function lead(tab, byTab) {
  const mine = byTab.get(tab.id) ?? [];
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}
// The lookups a render joins its lists by, each built in one pass (never a search of a whole
// list per row): the first row for each key, as find() would pick it, or every row for each
// key in list order, as filter() would keep them.
function firstBy(list, key) {
  const out = new Map();
  for (const x of list) { const k = key(x); if (!out.has(k)) out.set(k, x); }
  return out;
}
function groupBy(list, key, keep = () => true) {
  const out = new Map();
  for (const x of list) {
    if (!keep(x)) continue;
    const k = key(x);
    const got = out.get(k);
    if (got) got.push(x); else out.set(k, [x]);
  }
  return out;
}
function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
// A sub-agent without a pane isn't in agents(): its raw word, error counting as blocked.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}
// The clipboard holds an image and no text: its type list only, never its contents.
// The clipboard image, as a PNG checked by its bytes, put beside `address` on its machine
// and its path typed there (no Enter). Any failure says so and pastes nothing else:
// the native paste would send the image as it is (often TIFF).
async function pngPaste(address) {
  const dir = `${appHome()}/paste-tmp`;
  const file = `${dir}/paste-${Date.now()}.png`;
  try {
    await fs.mkdir(dir, { recursive: true });
    const r = await exec("osascript", ["-l", "JavaScript", `${appHome()}/mods/am-sidebar/clipboard-png.jxa`, file]);
    if (r.code !== 0) throw new Error("Couldn't turn the clipboard image into a PNG.");
    if (!isPng(await fs.readFile(file))) throw new Error("The converted image isn't a PNG.");
    const put = await hc(["put", "--json", address, file]);
    if (put.code !== 0) throw new Error(`Couldn't send the PNG to ${address}.`);
    const landed = JSON.parse(put.stdout).path;
    const keys = keysFor(landed);
    if (!keys) throw new Error(`The PNG is at ${landed} on ${address.split("/")[0]}, but that path can't be typed.`);
    const k = await hc(["keys", address, ...keys]);
    if (k.code !== 0) throw new Error(`The PNG is at ${landed}, but typing its path failed.`);
  } catch (e) {
    notify({ title: "Image not pasted", body: e?.message ?? String(e), level: "warning", timeout: 6000 });
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function imageOnly() {
  try {
    const r = await exec("osascript", ["-e", "clipboard info"]);
    const info = r.stdout;
    const pic = /«class (PNGf|TIFF|JPEG|GIFf|8BPS|BMP )»|TIFF picture|JPEG picture|GIF picture/.test(info);
    const text = /(^|, )(string|Unicode text|«class utf8»|«class ut16»)(?=,|$)/.test(info);
    return r.code === 0 && pic && !text;
  } catch { return false; }
}

// Each tab's first pane with a folder in `ps`: { i: its index there, cwd }.
function firstFolders(ps) {
  const out = new Map();
  ps.forEach((p, i) => { if (p.cwd && !out.has(p.tab)) out.set(p.tab, { i, cwd: p.cwd }); });
  return out;
}
// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane). `first`:
// firstFolders(ps), when the caller places several spaces: the first of the space's panes
// with a folder, in panes() order, is the one with the lowest index over its tabs.
function place(s, ps, first = firstFolders(ps)) {
  let at = null;
  for (const c of s.tabs ?? []) { const f = first.get(c.id); if (f && (!at || f.i < at.i)) at = f; }
  return at?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps, first) => JSON.stringify([s.machine ?? null, place(s, ps, first)]);
// A terminals() row's folder as an absolute path ("~" is the home folder), or null.
function paneFolder(t) {
  const f = t?.cwd ?? t?.foreground?.cwd;
  if (typeof f !== "string") return null;
  const full = f === "~" || f.startsWith("~/") ? `${home()}${f.slice(1)}` : f;
  return full.startsWith("/") ? full : null;
}
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Character pictures (characters.js), under the app home outside mods/, by their path
// relative to the app home, as image() takes it.
const PETS = "am-sidebar-pets";
// The last bot discovery (bots.js discoverySnapshot), in the mod's localStorage: drawn at
// startup until the first discovery answers.
const BOTS_SAVED = "bots.last";

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

/** The sidebar's shared keys from before the rename: the old names migrate.js SHARED_RENAMES maps to these. */
const SHARED_NEW = ["am.sidebar.icons", "am.sidebar.projects", "am.sidebar.update-shown", "am.sidebar.theme-selected",
  "am.space.colors", "am.sidebar.collapsed"];
const SHARED_OLD = Object.keys(SHARED_RENAMES).filter((old) => SHARED_NEW.includes(SHARED_RENAMES[old]));

export default class Spaces extends View {
  init(given, cx) {
    // The rename shim (D12): the sidebar's shared keys live under am.*; an install from before
    // the rename has them under the old names, copied over once here (the old ones stay).
    carryShared(shared, setShared, SHARED_OLD);
    // Opened as a dialog (New bot, Edit, Attach as bot…): the form only, no sidebar.
    const p = props() ?? given;
    if (p?.form) { this.form = new BotForm(p, cx); return; }
    if (p?.spaceIcon) { this.form = new SpaceIconDialog(p, cx); return; } // a space's icon (spaceIcon.js)
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.machineOrder = readMachineOrder(localStorage.getItem("machines.order")); // topButton
    this.refreshMachines(cx);
    // Hermes reports no status to the core: read its screen for the question footer.
    this.screen = {}; // terminal address -> "blocked" | null
    cx.timer.every(2500, (cx) => this.scanHermes(cx));
    cx.timer.every(15000, cx => {
      this.refreshMachines(cx); this.loadExtra(cx); this.refreshBots(cx); this.loadModelTexts(cx);
      if (!themeSettled()) this.applyTheme(cx); // Herdr may list a copied theme only later
      this.petsFailed.clear(); // a picture whose write failed is tried again at the next render
    });
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => { this.checkNew(cx); this.botTick(cx); this.updater.request(); });
    // Updates (A14, updater.js): a look FIRST_CHECK_MS after load, then every CHECK_EVERY_MS; a
    // failed look is "no update", tried again after RETRY_MS, never an error. A newer verified
    // release installs on its own while "Install updates automatically" is on (the default). The
    // status bar (am-status) shows the answer and asks for a look, an install or the switch
    // (REQUEST_KEY). The timers are this init's: a reload (the install's own swap) stops them.
    this.updater = new Updater({ exec, get: shared, set: setShared, notify, appHome: appHome(),
      readText: (path) => readTextFile(path), writeText: (path, text, before) => writeTextFile(path, text, before),
      after: (ms, fn) => cx.timer.after(ms, () => fn()), spawn: (fn) => cx.spawn(async () => { await fn(); }) });
    // The Automagik theme, selected once (theme.js): now, then on the 15-second timer until done.
    this.applyTheme(cx);
    this.updater.start();
    // usagemeter (Group 6c): `usagemeter sync` METER_FIRST_MS after load, then every
    // METER_EVERY_MS while Herdr is open, one run at a time (meter.js). No LaunchAgent, no daemon.
    this.meter = { busy: false };
    cx.timer.after(METER_FIRST_MS, (cx) => this.meterTick(cx));
    // Every linked machine follows the signed lanes (#954, machineUpdates.js): one cycle of
    // `automagik-herdr machines update` an hour, started apart and never waited for; its record
    // is read at each look, and a machine that was not updated is said once.
    cx.timer.after(MACHINES_FIRST_MS, (cx) => this.machinesTick(cx));
    // Cmd+V ("am-sidebar.paste") and Ctrl+V ("am-sidebar.paste_image"). An image
    // alone, into a terminal on another machine: sent there as a real PNG (pngPaste).
    // Otherwise as before: Cmd+V pastes text, or gives a local agent its Ctrl+V for an
    // image; Ctrl+V stays terminal.paste_image. The terminal is the one focused at the key.
    cx.spawn(async (cx) => {
      for (;;) {
        const { name: c, args } = parseCommand(await nextCommand());
        if (["new-bot", "edit", "start", "attach", "refresh"].includes(c)) {
          // A throw here must not end this loop (paste and every command would stop).
          try { await this.botCommand(c, args, cx); } catch (e) {
            console.error(e?.stack ?? e);
            notify({ title: "Bots", body: actionError(e, c === "start" ? "Start" : "Bot action"), level: "error" });
          }
        }
        else if (c === "paste" || c === "paste_image") {
          const address = focused()?.terminal;
          const image = await imageOnly();
          if (image && remote(address)) await pngPaste(address);
          else run(c === "paste" && !image ? "terminal.paste" : "terminal.paste_image", {});
        }
        cx.notify();
      }
    });
    // Names for terminals listed though they report no status: sidebar-agents.json in the
    // app home (outside mods/, so saving it reloads nothing), by full address ({name,
    // program, tab}). Read now and on the 15-second timer.
    this.extra = {};
    this.loadExtra(cx);
    // Bot definitions (bots.js): every project with a .herdr/bots.json, read now, on the
    // 15-second timer (another machine's) and on a change under a local project's .herdr/.
    // Until the first discovery answers, the last one saved (BOTS_SAVED) is drawn.
    try { this.bots = restoreDiscovery(localStorage.getItem(BOTS_SAVED)); } catch { this.bots = []; }
    this.botsSeen = JSON.stringify(this.bots); // the last result, as text: re-render only on a change
    this.botsRun = 0; // the latest discovery started
    this.botsShown = 0; // the discovery drawn last: an older one answering after it is dropped
    this.botWatch = new Map(); // local project key -> the token of its one watcher
    this.refreshBots(cx);
    // The bot view (rows.js): the folds made this session (A7: fold id -> open), the row under
    // the pointer, the trees drawn last, the terminals drawn as bots (left out of the space's
    // own agent rows), the pictures known to be on disk, and when the next idle bot falls
    // asleep (one wake-up then, on the 250 ms timer below). The bot rows take no keyboard
    // focus: a focus target in the sidebar would take typing from the terminal on a click
    // (shipped mods track focus only on overlays), so the fold arrow shows on hover only.
    this.open = new Map();
    this.hoverRow = null;
    this.hoverMachine = undefined; // the hovered machine header (null is this computer)
    this.trees = [];
    // Per project id, from the last draw that showed its space: its index in its sidebar
    // list, where its rows stay once that space closes.
    this.places = new Map();
    this.botOf = new Map(); // terminal address -> bot id
    this.pets = new Set();
    this.petsWanted = new Map(); // file -> { look, pose, dark }
    this.petsFailed = new Set();
    this.wakeAt = null;
    // The model a bot row shows (A12, rows.js secondLine): the agents' own config files, read
    // now and on the 15-second timer, and each live bot pane's foreground command line by
    // address ({ argv, created }), read with hc get after each bot discovery when terminals()
    // didn't carry it.
    this.modelTexts = {};
    this.modelDefaults = {}; // rows.js modelDefaultsFrom(this.modelTexts), parsed once per change
    this.argvOf = new Map();
    // Each live bot pane's project key on this computer (automagik#227: by project and id), by
    // address ({ cwd, created, key }), read after each bot discovery and when the bot panes
    // change (readPaneKeys).
    this.paneKeys = new Map();
    // Workers whose tab is on its way (openWorker): a second click waits for it.
    this.opening = new Set();
    this.loadModelTexts(cx);
    // Hermes's own icon from the program table (its process shows as Python).
    this.hermes = { key: "hermes", name: "Hermes", icon: "icons/hermes.svg", tint: true };
    cx.spawn(async (cx) => {
      try { this.known = await knownAgents(); this.hermes = this.known.find((a) => a.key === "hermes" && a.icon) ?? this.hermes; } catch {}
      cx.notify();
    });
  }

  // The core terminal behind a pane: by address; else, for a machine renamed in the app
  // whose terminals still carry its old name (server/t2 behind host-b/t2), the one with
  // the same local id and the core's own herdr.tab label for that pane's tab.
  // Looked up in maps prepareAgents builds from this.all (byAddress, remoteByLocal, machineNames).
  coreTerminal(p) {
    if (!p?.terminal) return null;
    const exact = this.byAddress.get(p.terminal);
    if (exact || !p.terminal.includes("/")) return exact ?? null;
    const local = (id) => (id ?? "").split("/").pop();
    this.machineNames ??= new Set(this.snap.machines.map((m) => m.name).filter(Boolean));
    const hits = (this.remoteByLocal.get(local(p.terminal))?.get(local(p.tab)) ?? [])
      .filter((k) => !this.machineNames.has(k.address.split("/")[0]));
    return hits.length === 1 ? hits[0] : null;
  }

  // The maps coreTerminal reads, from this render's terminals(): the first terminal per
  // address, and the remote ones by local id, then by their core's herdr.tab label.
  indexTerminals() {
    const local = (id) => (id ?? "").split("/").pop();
    this.byAddress = firstBy(this.all, (k) => k.address);
    this.remoteByLocal = new Map();
    for (const k of this.all) {
      const tab = k.labels?.["herdr.tab"];
      if (typeof k.address !== "string" || !k.address.includes("/") || typeof tab !== "string") continue;
      const id = local(k.address);
      if (!this.remoteByLocal.has(id)) this.remoteByLocal.set(id, new Map());
      const byTab = this.remoteByLocal.get(id);
      if (byTab.has(tab)) byTab.get(tab).push(k); else byTab.set(tab, [k]);
    }
    this.machineNames = null; // read on the first renamed-machine lookup of this render
    // kids(): each terminal's live children, in terminals() order.
    this.children = groupBy(this.all, (k) => k.parent, (k) => k.state === "live");
  }

  // This render's terminals(), first row per address.
  reportOf(address) { return this.byAddress?.get(address)?.report ?? null; }

  // Agents agents() misses because of that rename: their pane joins no terminal there.
  // Shown with the core's own reported status; never one that reports nothing.
  aliased(ps) {
    const listed = new Set(this.agentList.map((a) => a.address));
    const listedPanes = new Set(this.agentList.map((a) => a.pane));
    const spaceOf = new Map(this.snap.spaces.flatMap((s) => (s.tabs ?? []).map((c) => [c.id, s])));
    return ps.flatMap((p) => {
      if (!p.terminal || listed.has(p.terminal) || listedPanes.has(p.pane)) return [];
      const k = this.coreTerminal(p);
      if (!k || k.address === p.terminal || k.state !== "live" || !k.report?.app) return [];
      if (!["working", "blocked", "idle", "done"].includes(k.status)) return [];
      const s = spaceOf.get(p.tab);
      const app = k.report.app;
      const program = programForApp(app, this.known) ?? p.program;
      return [{ alias: true, core: k.address, address: p.terminal, pane: p.pane, tab: p.tab, status: k.status, app,
        program, focused: p.focused, title: p.title, space: s?.id, space_name: s?.name ?? "", seq: 0 }];
    });
  }

  // Hermes terminals agents() leaves out (they report no status): live, with a pane,
  // and Hermes by their argv, never by a title. Their status is unknown, never guessed.
  // Name: sidebar-agents.json's, else the tab's name, else the pane's title.
  extras(ps) {
    const listed = new Set(this.agentList.map((a) => a.address));
    const listedPanes = new Set(this.agentList.map((a) => a.pane));
    const tabs = new Map(this.snap.spaces.flatMap((s) => s.tabs ?? []).map((c) => [c.id, c]));
    const rows = ps.flatMap((p) => {
      if (!p.terminal || listed.has(p.terminal) || listedPanes.has(p.pane)) return [];
      const core = this.coreTerminal(p);
      const term = core?.state === "live" ? core : null;
      if (command(term?.argv) !== "hermes") return [];
      const e = this.extra[p.terminal];
      const named = e?.name && (!e.tab || e.tab === p.tab) ? e.name : null;
      return [{ extra: true, address: p.terminal, pane: p.pane, tab: p.tab, named, status: this.screen?.[p.terminal] ?? null, program: this.hermes, focused: p.focused }];
    });
    // A tab's name says which only when it holds one of them.
    const perTab = {};
    for (const r of rows) perTab[r.tab] = (perTab[r.tab] ?? 0) + 1;
    for (const r of rows) {
      const tab = tabs.get(r.tab)?.name;
      const tabName = tab && !/^\d+$/.test(tab) && perTab[r.tab] === 1 ? tab : null;
      const p = this.paneById.get(r.pane);
      r.name = r.named ?? tabName ?? (clean(p?.title) || tab || this.hermes.name);
    }
    return rows;
  }

  // The agents mod's status marks. `report` is herdr-core's status object for the row's
  // terminal; a blocked mark names a permission when it says so.
  status(t, a, report = null) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(needsYouText(report));
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  kids(addr, lines = []) {
    // A terminal drawn as a bot is placed by its definition only, never as someone's child.
    const kids = (this.children.get(addr) ?? []).filter((k) => !this.botOf.has(k.address));
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [{ k, lines: [...lines, last ? "└" : "├"] }, ...this.kids(k.address, [...lines, last ? "" : "│"])];
    });
  }

  // A space's plain agents (none drawn as a bot), in agents() order, each with its
  // sub-agents: spaceRowOrder's `agents`.
  // this.agentsByTab (prepareAgents): each tab's agents with their index in that order, so a
  // space's agents across its tabs are merged back into it.
  spaceAgents(w) {
    const tabs = new Set((w.tabs ?? []).map((c) => c.id));
    const asBot = (a) => this.botOf.has(a.address) || (a.core && this.botOf.has(a.core));
    const mine = [...tabs].flatMap((id) => this.agentsByTab.get(id) ?? []).sort((x, y) => x.i - y.i).map((x) => x.a);
    return mine.filter((a) => !asBot(a)).map((a) => ({
      terminal: a.core ?? a.address, a,
      subs: this.kids(a.core ?? a.address).map(({ k, lines }) => ({ terminal: k.address, depth: lines.length - 1, k, lines })),
    }));
  }

  // A plain agent's row. `indent`: 44 under a worktree space, else 20.
  agentRow(a, indent, t) {
    if (!a.extra) this.order.push(a.address);
    const pic = icon(a.program, 14, t.foreground);
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const idle = a.status === "idle" && !a.focused;
    return h_flex().id(`ag-${a.address}`).h(26).flex_none().pl(indent).pr(8).gap(8).items_center().rounded(8).text_size(12.5)
      .cursor_pointer()
      .when(a.focused, (el) => el.bg(t.selected))
      .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
      // Not in agents() (no status, or a renamed machine): agent.focus wouldn't know it; its pane does.
      .on_click(() => (a.extra || a.alias ? run("pane.focus", { pane: a.pane }) : focusOrPeek(a.address)))
      // "Attach as bot…": the clone has no terminal menu of its own, so the row's right-click.
      .when(!machine, (el) => el.on_mouse_down("right", () => openBotForm({ form: "attach", terminal: a.address, known: this.knownLocal() }, "popup")))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(a.extra ? a.name : this.agentName(a)))
      .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machine)))
      .child(a.extra && !a.status
        ? div().id(`unknown-${a.address}`).size(7).mx(3).flex_none().rounded(4).bg(t.unknown).tooltip("No status reported")
        : this.status(t, a, this.reportOf(a.core ?? a.address)));
  }

  // A plain agent's sub-agent, with the tree lines in front of it.
  subRow(k, lines, indent, t) {
    const on = k.address === this.snap.focused?.agent;
    const kpic = icon(k.program, 13, t.foreground);
    return h_flex().id(`sub-${k.address}`).h(24).flex_none().pl(indent + 4).pr(8).items_center().rounded(8).text_size(12)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => focusOrPeek(k.address))
      .children(lines.map((l) => div().self_start().mt(-4).w(8).h(16).mr(3).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(kpic), (el) => el.child(div().mr(7).child(kpic)))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: kidStatus(k, this.listed) }, k.report ?? null));
  }

  // The agents list's grouped-view name: a tab someone named or the agent's own
  // title; an automatic tab number only when two of a space's rows would read the same.
  prepareAgents() {
    this.all = this.snap.terminals;
    this.indexTerminals();
    const ps = this.snap.panes;
    this.paneById = firstBy(ps, (p) => p.pane);
    this.agentList = this.snap.agents;
    this.agentList = [...this.agentList, ...this.aliased(ps)];
    this.listed = new Map(this.agentList.map((a) => [a.address, a.status]));
    this.order = [];
    this.extraList = this.extras(ps);
    this.agentsByTab = groupBy([...this.agentList, ...this.extraList].map((a, i) => ({ a, i })), (x) => x.a.tab);
    const tabs = firstBy(this.snap.spaces.flatMap((s) => s.tabs ?? []), (tab) => tab.id);
    const byTab = groupBy(ps, (p) => p.tab, (p) => p.terminal);
    const label = (a) => {
      const tab = tabs.get(a.tab);
      return tab ? title(tab, lead(tab, byTab)) : a.title || a.program?.name || "";
    };
    const labels = new Map(this.agentList.map((a) => [a.address, label(a)]));
    const detail = new Map(this.agentList.map((a) => [a.address, /^\d+$/.test(labels.get(a.address)) ? null : labels.get(a.address)]));
    const seen = {};
    for (const a of this.agentList) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of this.agentList) if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, labels.get(a.address));
    // Two of a space's rows still reading the same (one tab's split): each its own title.
    for (const a of this.agentList) {
      const d = detail.get(a.address), own = clean(a.title);
      if (d != null && own && seen[`${a.space_name}\u0000${d}`] > 1) detail.set(a.address, own);
    }
    this.agentName = (a) => {
      const l = labels.get(a.address);
      return detail.get(a.address) ?? (/^\d+$/.test(l) ? a.program?.name || l : l);
    };
  }

  // ---- The bot view (Group 3): each project's bots as the approved mockup draws them ----

  // Live bots, poses and trees from this render's terminals() (rows.js decides; no hc get
  // here: terminals() carries program.agent, status, status_ms and created_ms on this host;
  // a command line it lacks comes from readBotArgv, read off the drawing path, and counts
  // for liveness too: the program table can say shell while the agent runs).
  prepareBots() {
    const now = Date.now();
    const known = knownBots(this.bots);
    this.keyOf = listedKeyOf(this.bots, this.paneKeyReader());
    const live = liveFrom(this.all, known, argvReader(this.argvOf), this.keyOf);
    // The bot panes as readPaneKeys asks for them: a new one, or one in another folder, is
    // read on the next tick (botTick), not only after the next discovery.
    this.paneSig = JSON.stringify(this.all.filter((k) => k.state === "live" && !String(k.address).includes("/") && known.has(k.labels?.[BOT_LABEL]))
      .map((k) => [k.address, k.created_ms ?? null, paneFolder(k)]));
    this.botOf = new Map(this.all.filter((k) => known.has(k.labels?.[BOT_LABEL])).map((k) => [k.address, k.labels[BOT_LABEL]]));
    this.trees = buildTree({ projects: this.bots, live, terminals: this.all, now });
    this.wakeAt = nextWake(live, now);
  }

  // Name only an unnamed tab whose first terminal is a defined bot. The app persists
  // named=true; the set also covers renders before that document change comes back.
  nameBotTabs() {
    this.namedBotTabs ??= new Set();
    const first = firstBy(this.snap.panes.filter((p) => p.terminal), (p) => p.tab);
    const bots = firstBy(this.bots.flatMap((p) => p.file?.bots ?? []), (b) => b.id);
    for (const space of this.snap.spaces) for (const tab of space.tabs ?? []) {
      if (tab.named !== false || this.namedBotTabs.has(tab.id)) continue;
      const terminal = this.coreTerminal(first.get(tab.id));
      const bot = bots.get(terminal?.labels?.[BOT_LABEL]);
      if (!bot) continue;
      run("tab.rename", { id: tab.id, name: bot.name });
      this.namedBotTabs.add(tab.id);
    }
  }

  // Copies the Automagik themes into the app home when absent, and selects them the first
  // time only (theme.js). Never an error to the person: it is tried again on the timer, and
  // each distinct failure goes to the mod's log once (not every 15 s tick, never a notice).
  applyTheme(cx) {
    if (this.themeBusy) return;
    this.themeBusy = true;
    this.themeWhys ??= new Set();
    cx.spawn(async () => {
      let why = null;
      try { ({ why } = await ensureTheme()); } catch (e) { why = String(e?.message ?? e); }
      if (why && !this.themeWhys.has(why)) {
        this.themeWhys.add(why);
        try { console.log(`Automagik theme: ${why}`); } catch {}
      }
      this.themeBusy = false;
    });
  }

  // One due `usagemeter sync` through Herdr's exec, here and then on each connected linked machine
  // the person agreed to (meterScope "all", or one a meter install --machine put it on), then the next look.
  // Where the person agreed to usagemeter at all (scope all or local), the same run asks each of
  // those machines for its bot-tag coverage and writes the fleet record (RFC 0026 (e)).
  meterTick(cx) {
    cx.spawn(async (cx) => {
      let wait = METER_EVERY_MS;
      try {
        let scope = null, owned = [];
        try {
          const record = parseMarker(await readTextFile(`${appHome()}/automagik-herdr/installed-by-install.sh`));
          scope = meterScope(record);
          owned = Object.keys(record?.usagemeterOn ?? {});
        } catch {}
        const machines = syncTargets(this.machines, scope, owned);
        const plan = fleetPlan(this.machines, scope, owned);
        const fleet = scope === "all" || scope === "local" ? { disconnected: plan.disconnected, outOfScope: plan.outOfScope,
          write: (text) => writeFleetRecord({ exec, writeText: writeTextFile, appHome: appHome(), text }) } : null;
        ({ wait } = await syncMeter({ exec, bin: meterBin(home()), get: shared, set: setShared, state: this.meter, machines, sleep: sleepOf(cx), fleet }));
      } catch {}
      cx.timer.after(wait, (cx) => this.meterTick(cx));
    });
  }

  // The linked machines' updates (#954): what the last cycle could not update, said once, then a
  // cycle when one is due (startCycle: one an hour across sidebar copies).
  machinesTick(cx) {
    cx.spawn(async (cx) => {
      try {
        let text = null;
        try { text = await readTextFile(`${appHome()}/automagik-herdr/${MACHINES_STATE}`); } catch {}
        const { sig, notice } = failureNotice(parseMachines(text ?? ""), shared(MACHINES_SHOWN_KEY) ?? null);
        if (sig !== (shared(MACHINES_SHOWN_KEY) ?? "")) setShared(MACHINES_SHOWN_KEY, sig);
        if (notice) notify({ ...notice, timeout: 15000 });
        await startCycle({ exec, cli: `${appHome()}/mods/am-sidebar/bin/automagik-herdr`, get: shared, set: setShared });
      } catch {}
      cx.timer.after(MACHINES_TICK_MS, (cx) => this.machinesTick(cx));
    });
  }

  // On the 250 ms timer: one redraw when the next idle bot reaches its asleep mark, and the
  // character pictures the last render asked for, written once each.
  botTick(cx) {
    if (this.wakeAt !== null && Date.now() >= this.wakeAt) { this.wakeAt = null; cx.notify(); }
    if (this.petsWanted.size && !this.petsBusy) this.writePets(cx);
    if (this.paneSig !== undefined && this.paneSig !== this.paneSigRead && !this.paneKeysBusy) {
      this.paneSigRead = this.paneSig;
      this.readPaneKeys(cx);
    }
  }

  // A character picture is a file under the app home outside mods/ (a write inside a mod
  // folder reloads it, DESIGN Decision 8), drawn by its path relative to the app home
  // (image() draws nothing for an absolute path on this host). Written when absent or stale.
  writePets(cx) {
    const wanted = [...this.petsWanted];
    this.petsWanted.clear();
    this.petsBusy = true;
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${appHome()}/${PETS}`, { recursive: true });
        for (const [file, { look, pose, dark }] of wanted) {
          const path = `${appHome()}/${PETS}/${file}`;
          const svg = characterSvg(look.character, look.colour, pose, dark);
          try {
            const had = await fs.readFile(path, "utf8").catch(() => null);
            if (had !== svg) await fs.writeFile(path, svg);
            this.pets.add(file);
          } catch (e) { this.petsFailed.add(file); this.petsTrouble(e); }
        }
      } catch (e) { for (const [file] of wanted) this.petsFailed.add(file); this.petsTrouble(e); }
      this.petsBusy = false;
      cx.notify();
    });
  }

  // Pictures that can't be written: said once (the first failure), naming the folder; they
  // are tried again on the 15-second timer either way.
  petsTrouble(e) {
    if (this.petsWarned) return;
    this.petsWarned = true;
    notify({ title: "Bots", level: "warning", timeout: 15000,
      body: `Couldn't write bot pictures in ${appHome()}/${PETS} (${e?.message ?? e}). Bots show without them until it works; it is tried again every 15 seconds.` });
  }

  // A bot's character in its pose; until its file is written, an empty box the same size.
  pet(bot, pose, size, dark) {
    const look = bot.look ?? {};
    const file = characterFile(look.character, look.colour, pose, dark);
    if (!this.pets.has(file)) {
      if (!this.petsFailed.has(file)) this.petsWanted.set(file, { look, pose, dark });
      return div().size(size).flex_none();
    }
    const pic = image(`${PETS}/${file}`).size(size).flex_none();
    // Needs you: Herdr's own motion, a small bob.
    return pose === "needs-you" ? div().relative().flex_none().child(pic).loop("top", { from: 0, to: -2, period: 700 }) : pic;
  }

  // The coding agent's Herdr icon: the live pane's program, else the agent the bot runs
  // (knownAgents), else the shell icon.
  agentIcon(node, size, t) {
    const program = node.program ?? (this.known ?? []).find((k) => k.key === node.bot.agent);
    return icon(program, size, t.foreground) ?? image("icons/shell.svg").size(size).flex_none();
  }

  toggle(id, open, cx) {
    this.open.set(id, !open);
    cx.notify();
  }

  // The lines on a row's left (A4): inside the main bot and a bot's team solid, helpers dashed.
  guides(list, t) {
    return list.map((g) => div().flex_none().self_stretch()
      .ml(g === "main" ? 22 : g === "member" ? 31 : 2).w(g === "helper" ? 9 : 7)
      .border_l(1).border_color(t.border).when(g === "helper", (el) => el.border_dashed()));
  }

  // The fold arrow: its slot always there (10 px), seen only while the row is hovered (A7,
  // hover half: see the bot view's state in init); down when open, right when folded;
  // nothing else marks a fold.
  arrow(r, t) {
    const slot = div().id(`fold-${r.id}`).w(10).flex_none().flex().items_center().justify_center();
    if (!r.foldable) return slot;
    const shown = this.hoverRow === r.id;
    return slot.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggle(r.id, r.open, cx); })
      .child(svg(`mods/workspace-chrome/chevron-${r.open ? "down" : "right"}.svg`).size(10).text_color(t.dim).opacity(shown ? 1 : 0));
  }

  // A row's shared behaviour: hover (for its arrow), click and right-click.
  rowEvents(el, r, t, onClick, onMenu) {
    return el.id(`row-${r.id}`)
      .on_hover((over, cx) => {
        const next = over ? r.id : this.hoverRow === r.id ? null : this.hoverRow;
        if (next !== this.hoverRow) { this.hoverRow = next; cx.notify(); }
      })
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
      .when(Boolean(onMenu), (el) => el.on_mouse_down("right", () => onMenu()));
  }

  // One tree's rows, as spaceRowOrder gives them, in one block; dimmed while it shows a file
  // from the last run of Herdr its machine hasn't confirmed (bots.js lastOf: `stale`).
  botBlock(tree, t, dark, shown) {
    const rows = shown.map((r) => {
      if (r.kind === "category") return this.categoryRow(r, t);
      if (r.kind === "helper") return this.helperRow(r, t);
      if (r.kind === "notice") return h_flex().id(`row-${r.id}`).px(8).py(4).gap(6).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${base(tree.key)}: ${r.text}`));
      return this.botRow(r, tree, t, dark);
    });
    return [v_flex().id(`bots-${projectId(tree)}`).opacity(tree.stale ? 0.5 : 1).children(rows)];
  }

  categoryRow(r, t) {
    const c = r.category;
    return h_flex().items_stretch()
      .children(this.guides(r.guides, t))
      .child(this.rowEvents(h_flex().flex_1().min_w(0).mt(8).mb(2).py(3).pl(2).pr(8).gap(8).items_center().rounded(8)
        .border_1().border_color(`${t.chrome}00`)
        .hover((s) => s.bg(t.hover)), r, t, (cx) => this.toggle(r.id, r.open, cx))
        .child(this.arrow(r, t))
        .child(div().flex_none().text_size(11).font_bold().text_color(t.muted).child(c.title.toUpperCase()))
        .when(Boolean(c.sub), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.sub))));
  }

  helperRow(r, t) {
    const h = r.helper;
    this.order.push(h.terminal);
    const shown = this.snap.focused?.agent === h.terminal;
    const pic = icon(h.program, 14, t.foreground) ?? image("icons/shell.svg").size(14).flex_none();
    return h_flex().items_stretch()
      .children(this.guides(r.guides, t))
      .child(h_flex().id(`row-${r.id}`).flex_1().min_w(0).h(26).px(6).gap(8).items_center().rounded(8).text_size(12).cursor_pointer()
        .when(shown, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openWorker(r, cx))
        .child(pic)
        .child(div().flex_1().min_w(0).truncate().text_color(shown ? t.foreground : t.muted).child(h.name))
        .when(Boolean(h.template || h.model || h.effort), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(10)
          .text_color(t.dim).child([h.template, h.model, h.effort].filter(Boolean).join(" · "))))
        .when(h.terminal.includes("/"), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(h.terminal.split("/")[0])))
        .child(this.status(t, { status: kidStatus({ address: h.terminal, status: h.status }, this.listed) }, this.reportOf(h.terminal))));
  }

  // A helper, worker or live bot row's click (workerTab.js rowWorker): its pane; else a tab
  // after its bot's (a bot row: its hc parent's) tab, once per terminal while that tab is on
  // its way; else a peek.
  openWorker(r, cx) {
    const w = rowWorker(r);
    if (!w) return;
    const plan = workerClick({ ...w, panes: panes(), spaces: spaces() });
    if (plan.kind !== "open") return focusOrPeek(w.terminal);
    if (this.opening.has(w.terminal)) return;
    this.opening.add(w.terminal);
    cx.spawn(async (cx) => {
      const sleep = (ms) => new Promise((done) => cx.timer.after(ms, () => done()));
      try { await openWorkerTab(plan, { run, panes, spaces, hc, sleep, notify }); } finally { this.opening.delete(w.terminal); }
    });
  }

  // A bot row (A4): fold slot, character, name in its ink over `role · model`, the agent's
  // icon and the status mark. The main bot's is a raised card bordered in its ink; a planned
  // bot's is dimmed and dashed, asleep, with its note and wave (A3).
  botRow(r, tree, t, dark) {
    const n = r.node, b = n.bot;
    const main = r.kind === "main", planned = r.kind === "planned";
    const ink = inkOf(b.look?.colour, dark);
    const live = n.live;
    if (live) this.order.push(live.terminal);
    const second = secondLine(r, tree, { texts: this.modelTexts, defaults: this.modelDefaults, argvOf: (a) => this.argvOf.get(a)?.argv ?? null });
    const s = n.status === "error" ? "blocked" : n.status;
    const project = { key: n.project ?? tree.key, machine: tree.machine };
    // Not counted live but holding a live terminal (no agent seen in front yet): its pane, or
    // a peek, rather than nothing; read again at click time (panes() too), nothing if it is gone.
    const held = live || planned ? null : heldTerminalOf(b.id, this.all, [], project, this.keyOf);
    const onClick = live
      ? (cx) => this.openWorker(r, cx)
      : held ? () => { const a = heldClickOf(b.id, terminals(), panes(), project, this.keyOf); if (a) run(a.command, a.args); }
        : r.foldable ? (cx) => this.toggle(r.id, r.open, cx) : null;
    // live: its own pane, or the terminal it holds before an agent shows (Focus goes where the
    // row's click goes; Detach); worker: what the row's own click opens (Focus, as openWorker);
    // terminal: the pane focused at the click (Attach).
    const onMenu = () => openBotForm({ form: "menu", bot: b.id, name: b.name, planned: planned, project: project.key,
      machine: project.machine, stale: Boolean(tree.stale), terminal: focused()?.terminal ?? null, live: live?.terminal ?? held ?? null, worker: rowWorker(r),
      helpers: (n.helpers ?? []).map((h) => ({ terminal: h.terminal, name: h.name ?? null })) }, "popup");
    const size = main ? 30 : 26;
    let row = h_flex().flex_1().min_w(0).gap(8).items_center()
      .when(!planned, (el) => el.child(this.arrow(r, t)))
      .child(planned ? div().flex_none().opacity(0.45).child(this.pet(b, "asleep", size, dark)) : this.pet(b, n.pose, size, dark))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(5).items_center()
          .child(div().min_w(0).truncate().text_size(main ? 14 : 13).font_weight(main ? 700 : 600).text_color(planned ? t.muted : ink).child(b.name))
          .when(Boolean(live?.duplicate), (el) => el.child(div().id(`dup-${b.id}`).flex_none().text_size(10).text_color(t.blocked)
            .tooltip("More than one pane carries this bot; the newest counts").child("×2")))
          .when(Boolean(n.parentMark), (el) => el.child(div().id(`parent-${b.id}`).flex_none().text_size(10).text_color(t.muted)
            .tooltip(n.parentMark ? parentMarkText(n.parentMark) : "").child("↑")))
          .when(Boolean(n.warning), (el) => el.child(div().id(`warn-${b.id}`).flex_none().text_size(10).font_bold().text_color(t.blocked)
            .tooltip(n.warning).child("!"))))
        .child(div().min_w(0).truncate().text_size(11).text_color(planned ? t.dim : t.muted).child(second)))
      .when(Boolean(tree.machine) && main, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(tree.machine)));
    if (planned) {
      row = row.child(div().flex_none().px(7).py(2).rounded(999).border_1().border_color(t.border)
        .text_size(10).font_semibold().text_color(t.muted).child(`Wave ${b.planned.wave}`));
    } else {
      row = row.child(this.agentIcon(n, main ? 16 : 15, t))
        .child(live ? this.status(t, { status: s }, this.reportOf(live.terminal)) : div().w(13).flex_none());
    }
    const box = this.rowEvents(row, r, t, onClick, onMenu).rounded(main ? 10 : 8);
    const styled = main
      ? box.mt(3).py(7).pl(2).pr(8).bg(t.raised).border_1().border_color(`${ink}40`)
      : planned
        ? box.my(2).ml(18).py(5).px(8).border_1().border_color(t.border).border_dashed()
        : box.py(5).pl(2).pr(8).border_1().border_color(`${t.chrome}00`)
          .when(Boolean(live) && this.snap.focused?.agent === live?.terminal, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover));
    return h_flex().items_stretch().children(this.guides(r.guides, t)).child(styled);
  }

  // A project with no open space (A8): its tree where its space was, under a plain header
  // with Start on the main bot (Start opens a space on the project).
  projectHeader(tree, t) {
    const b = this.startable(tree);
    return h_flex().id(`project-${projectId(tree)}`).h(28).mt(6).px(8).gap(8).items_center().text_size(12).text_color(t.dim)
      .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(base(tree.key)))
      .when(Boolean(tree.machine), (el) => el.child(div().flex_none().text_size(10).child(tree.machine)))
      .when(Boolean(b), (el) => el.child(div().id(`project-start-${projectId(tree)}`).flex_none().px(7).py(1).rounded(999)
        .border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.startFromRow(b.id, cx)).child("Start")));
  }

  // The same project while the sidebar is narrow: its main bot; a click starts it.
  compactProject(tree, t, dark) {
    const b = this.startable(tree), main = tree.main;
    return h_flex().id(`project-${projectId(tree)}`).h(26).flex_none().justify_center().items_center().hover((s) => s.bg(t.hover))
      .tooltip(main ? `${main.bot.name} · ${base(tree.key)}` : base(tree.key))
      .when(Boolean(b), (el) => el.cursor_pointer().on_click((_e, cx) => this.startFromRow(b.id, cx)))
      .child(main ? this.pet(main.bot, main.pose, 18, dark) : svg("mods/workspace-chrome/folder.svg").size(13).flex_none());
  }

  // The bot a spaceless project's Start starts: its main bot, on this computer, not live.
  startable(tree) {
    const n = tree.main;
    return !tree.machine && n && !n.planned && !n.live ? n.bot : null;
  }

  startFromRow(bot, cx) {
    cx.spawn(async (cx) => {
      try { await this.botCommand("start", { bot }, cx); } catch (e) {
        console.error(e?.stack ?? e);
        notify({ title: "Bots", body: actionError(e, "Start"), level: "error" });
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    // Each key once per tick, as in render.
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes(), machines());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps, ms) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of ms) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  scanHermes(cx) {
    const rows = (this.extraList ?? []).filter((a) => a.extra);
    if (!rows.length || this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const next = {};
        await Promise.all(rows.map(async (a) => {
          try {
            const r = await hc(["read", a.address]);
            if (r.code !== 0) return;
            const tail = r.stdout.split("\n").slice(-14).join("\n");
            // Hermes's clarify/ask footer: "0/1 answered · ↑/↓ select · Enter confirm".
            next[a.address] = /\d+\/\d+ answered\b.*(select|confirm)/.test(tail) ? "blocked" : null;
          } catch {}
        }));
        const changed = JSON.stringify(next) !== JSON.stringify(this.screen);
        this.screen = next;
        if (changed) cx.notify();
      } finally { this.scanning = false; }
    });
  }

  // The rename map: an absent file is an empty map; one that can't be read or parsed
  // (mid-save, say), or isn't a JSON object, keeps the last map until the next look.
  loadExtra(cx) {
    cx.spawn(async (cx) => {
      let text;
      try { text = await readTextFile(`${appHome()}/sidebar-agents.json`); } catch { return; }
      if (text === this.extraText) return;
      let map;
      try { map = text === null ? {} : JSON.parse(text); } catch { return; }
      if (map === null || typeof map !== "object" || Array.isArray(map)) return;
      this.extraText = text;
      this.extra = map;
      cx.notify();
    });
  }

  // Bot commands (A10). Herdr hands nextCommand() only the name, so arguments come after
  // it as JSON or key=value when a caller can send them; bare, they act on the focused pane.
  async botCommand(c, args, cx) {
    if (c === "refresh") return this.refreshBots(cx);
    if (c === "new-bot") return openBotForm({ form: "create" });
    const terminal = args.terminal ?? focused()?.terminal ?? null;
    // The focused pane's bot is the attach ledger's answer (automagik-herdr whois), never its label.
    const bot = args.bot ?? (terminal && c !== "attach" ? await botOfTerminal(terminal) : null);
    const title = { edit: "Edit bot", start: "Start bot", attach: "Attach as bot" }[c];
    if (c === "attach" && !terminal) return notify({ title, body: "Focus the pane to attach first.", level: "warning" });
    // Attach with no bot named: the picker, for the pane.
    if (c === "attach" && !args.bot) return openBotForm({ form: "attach", terminal, known: this.knownLocal() });
    // No bot named and the focused pane isn't one: the Bots list, to pick one.
    if (!bot) return openBotForm({ form: "pick", known: this.knownAll() }, "popup");
    if (c === "edit") return openBotForm({ form: "edit", bot });
    // A bot's project: looked up by its id (ids are random, so it is one project).
    const has = (q) => !q.machine && q.file.bots.some((b) => b.id === bot);
    const project = this.bots.find(has) ?? (await discoverProjects()).find(has);
    if (!project) return notify({ title, body: `No project on this computer defines ${bot}.`, level: "warning" });
    // Start opens a space on the project when none is open (sleepOf: to wait for it).
    const r = c === "start" ? await startBot(project.key, bot, { sleep: sleepOf(cx) }) : await attachBot(project.key, bot, terminal);
    if (r.refused) notify({ title, body: r.refused, level: "warning", timeout: 12000 });
    this.refreshBots(cx);
  }

  // This computer's projects as the sidebar last found them (#74's first paint, then each
  // discovery): the pick and attach lists draw them at once and refresh behind (#85).
  knownLocal() {
    return (this.bots ?? []).filter((q) => !q.machine).map((q) => ({ key: q.key, machine: null, file: q.file }));
  }

  // Every project the sidebar knows, linked machines' too (the Bots list).
  knownAll() {
    return (this.bots ?? []).map((q) => ({ key: q.key, machine: q.machine ?? null, file: q.file }));
  }

  // A discovery's lists are drawn as they come (this computer's projects first, each other
  // machine as it answers); one still running when the next starts is drawn until a newer
  // one has been (a discovery longer than the 15-second timer still shows).
  refreshBots(cx) {
    const run = ++this.botsRun;
    cx.spawn(async (cx) => {
      const sleep = (ms) => new Promise((done) => cx.timer.after(ms, () => done()));
      const show = (found) => {
        if (run < this.botsShown) return;
        this.botsShown = run;
        const seen = JSON.stringify(found);
        if (seen === this.botsSeen) return;
        this.botsSeen = seen;
        this.bots = found;
        cx.notify();
      };
      let found;
      try { found = await discoverProjects({ sleep, onUpdate: show }); } catch { return; }
      if (run < this.botsShown) return;
      // For the footer's Bots tab (am-footer): whether there is a bot the Bot settings list
      // can configure, this computer's or an answering linked machine's (not one drawn
      // from the last run of Herdr while its machine is away). Set only on a change.
      const defined = found.some((p) => (!p.machine || !p.stale) && p.file?.bots?.length > 0);
      if (shared("bots.defined") !== defined) setShared("bots.defined", defined);
      const local = new Set(found.filter((p) => !p.machine).map((p) => p.key));
      for (const key of this.botWatch.keys()) if (!local.has(key)) this.botWatch.delete(key);
      for (const key of local) {
        if (this.botWatch.has(key)) continue;
        const token = {};
        this.botWatch.set(key, token);
        cx.spawn(async (cx) => {
          await watchProject(key, () => this.botWatch.get(key) === token, () => this.refreshBots(cx));
          if (this.botWatch.get(key) === token) this.botWatch.delete(key);
        });
      }
      show(found);
      try {
        const saved = discoverySnapshot(found);
        if (saved !== this.botsSaved) { this.botsSaved = saved; localStorage.setItem(BOTS_SAVED, saved); }
      } catch {}
      this.readBotArgv(cx);
      this.readPaneKeys(cx);
    });
  }

  // The project key of a pane's folder as readPaneKeys found it for the same pane (created_ms)
  // in the same folder, else null (counts for every project: paneCounts). rows.js listedKeyOf
  // keeps it only for a listed project defining the pane's bot (prepareBots).
  paneKeyReader() {
    return (t) => {
      const e = this.paneKeys.get(t?.address);
      return e && e.created === (t.created_ms ?? null) && e.cwd === paneFolder(t) ? e.key : null;
    };
  }

  // automagik#227: the project key of each live pane on this computer labelled with a known bot
  // (bots.js paneKeyOfFolder: git's main checkout, cached a minute), asked after each discovery,
  // and when the bot panes change (botTick), never while drawing; a pane gone is dropped. A
  // remote pane, or one with no folder, is never asked: it has no key, so it counts as before.
  // Redraws on a change only.
  readPaneKeys(cx) {
    if (this.paneKeysBusy) return;
    const known = knownBots(this.bots);
    const rows = terminals().filter((t) => t?.state === "live" && typeof t.address === "string" && !t.address.includes("/")
      && known.has(t.labels?.[BOT_LABEL]));
    const here = new Set(rows.map((t) => t.address));
    let changed = false;
    for (const a of [...this.paneKeys.keys()]) if (!here.has(a)) { this.paneKeys.delete(a); changed = true; }
    const ask = rows.map((t) => ({ address: t.address, created: t.created_ms ?? null, cwd: paneFolder(t) })).filter((r) => r.cwd);
    if (!ask.length) { if (changed) cx.notify(); return; }
    this.paneKeysBusy = true;
    cx.spawn(async (cx) => {
      try {
        for (const r of ask) {
          const key = await paneKeyOfFolder(r.cwd);
          const old = this.paneKeys.get(r.address);
          if (!old || old.key !== key || old.cwd !== r.cwd || old.created !== r.created) changed = true;
          this.paneKeys.set(r.address, { ...r, key });
        }
      } catch {} finally { this.paneKeysBusy = false; }
      if (changed) cx.notify();
    });
  }

  // The agents' config files (models.js configPaths) for each bot's default model, parsed
  // here once per change (rows.js modelTextsUpdate), never per row drawn; redraw on a change only.
  loadModelTexts(cx) {
    cx.spawn(async (cx) => {
      let texts;
      try { texts = await modelTexts(); } catch { return; }
      const next = modelTextsUpdate(this.modelTextsSeen, texts);
      if (!next) return;
      this.modelTextsSeen = next.seen;
      this.modelTexts = next.texts;
      this.modelDefaults = next.defaults;
      cx.notify();
    });
  }

  // A12: each live bot pane's foreground command line, for the model it runs. rows.js
  // argvToAsk picks the panes: labelled with a known bot, no `foreground.argv` in the row, not
  // read already for the same pane (created_ms), three at most. Asked after each discovery
  // (on load, the 15-second timer and a .herdr change), never while drawing. A failed or empty
  // ask keeps what was read before, else marks the pane read (rows.js argvAfter); a pane gone
  // is dropped.
  readBotArgv(cx) {
    if (this.argvBusy) return;
    const rows = terminals();
    const { ask, gone, next } = argvToAsk(rows, knownBots(this.bots), this.argvOf, 3, this.argvCursor ?? 0);
    this.argvCursor = next;
    let changed = gone.length > 0;
    for (const a of gone) this.argvOf.delete(a);
    if (!ask.length) { if (changed) cx.notify(); return; }
    const createdOf = new Map(rows.map((k) => [k.address, k.created_ms ?? null]));
    this.argvBusy = true;
    cx.spawn(async (cx) => {
      try {
        for (const address of ask) {
          let get = null;
          try {
            const r = await hc(["get", address, "--json"]);
            if (r.code === 0) get = JSON.parse(r.stdout);
          } catch {}
          const entry = argvAfter(this.argvOf.get(address), get, createdOf.get(address));
          if (JSON.stringify(entry.argv) !== JSON.stringify(this.argvOf.get(address)?.argv)) changed = true;
          this.argvOf.set(address, entry);
        }
      } finally { this.argvBusy = false; }
      if (changed) cx.notify();
    });
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const { spaces: sp, panes: ps } = this.snap;
    // Each space's where(), once per render.
    const first = firstFolders(ps);
    const at = new Map(sp.map((w) => [w, where(w, ps, first)]));
    const ready = (w) => this.shown.has(w.id) || at.get(w) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[at.get(w)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    // A8: each project's bot tree after the first space row of it, in this order; a project
    // with no space shown stays where its space last was in its machine's list (else right
    // after the open spaces) under a plain header; one compact row while the sidebar is narrow.
    const dark = isDark(t.chrome);
    const { at, rest } = placeTrees(rows.map((r) => r.w.id), this.trees);
    const byId = new Map(this.trees.map((tr) => [projectId(tr), tr]));
    const treeRows = (tree) => spaceRowOrder({ tree, open: this.open }).map((d) => d.row);
    const spaceless = (tree) => (collapsed ? [this.compactProject(tree, t, dark)]
      : [this.projectHeader(tree, t), ...this.botBlock(tree, t, dark, treeRows(tree))]);
    const list = (mine, m) => {
      const ids = mine.map((r) => r.w.id), rowOf = new Map(mine.map((r) => [r.w.id, r]));
      for (const [id, i] of placesOf(ids, at)) this.places.set(id, i);
      const orphans = rest.filter((id) => (byId.get(id).machine ?? null) === m);
      return withSpaceless(ids, orphans, this.places).flatMap((x) => (x.space ? draw(rowOf.get(x.space)) : spaceless(byId.get(x.project))));
    };
    // A space's row, then (expanded) its rows in R3 order (spaceRowOrder): the bot tree placed
    // there, then its plain agents with their sub-agents. Built in that order, so this.order
    // (agent cycling) follows the drawn order.
    const draw = (r) => {
      if (collapsed) return [this.compact(r, t)];
      const tree = at.has(r.w.id) ? byId.get(at.get(r.w.id)) : null;
      const shown = spaceRowOrder({ tree, agents: this.spaceAgents(r.w), shells: [], open: this.open });
      const indent = r.tree ? 44 : 20;
      const out = [this.row(r, t)];
      const placed = shown.filter((d) => d.row).map((d) => d.row);
      if (placed.length) out.push(...this.botBlock(tree, t, dark, placed));
      for (const d of shown) {
        if (d.kind !== "agent") continue;
        out.push(d.sub ? this.subRow(d.sub.k, d.sub.lines, indent, t) : this.agentRow(d.agent.a, indent, t));
      }
      return out;
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = this.snap.machines.find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || this.snap.spaces.some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    const machineNames = orderMachines([null, ...remote], this.machineOrder ?? []);
    const tail = rest.filter((id) => !machineNames.includes(byId.get(id).machine ?? null)).flatMap((id) => spaceless(byId.get(id)));
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : [...list(rows, null), ...tail];
    return [...machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_hover((over, cx) => {
          const next = over ? m : this.hoverMachine === m ? undefined : this.hoverMachine;
          if (next === this.hoverMachine) return;
          this.hoverMachine = next;
          cx.notify();
        })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(m !== machineNames[0], el => el.child(this.topButton(m, t)))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : [...(mine.length ? [] : [loading(m) ? loadingRow(m) : empty]), ...list(mine, m)])];
    }), ...tail];
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const colors = shared("am.space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color === "transparent" ? null : color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.border_t(2).border_color(t.accent))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((over, cx) => {
        const next = over ? w.id : this.hoverSpace === w.id ? null : this.hoverSpace;
        if (next === this.hoverSpace) return;
        this.hoverSpace = next;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(this.avatar(w, fill, t)))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .child(this.addButton(w, t)),
      );
  }

  // A machine header's "Move to top" (every header but the first, while expanded): always
  // there at the same size, like the row's +, seen and pressable only while the header is
  // hovered. The order is this person's, kept like the folds (localStorage machines.order).
  topButton(m, t) {
    const el = div().id(`machine-top-${m ?? "local"}`).flex_none().px(4).rounded(4).child("\u2191");
    if (this.hoverMachine !== m) return el.opacity(0);
    return el.hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Move to top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.machineOrder = movedToTop(this.machineOrder ?? [], m);
        localStorage.setItem("machines.order", JSON.stringify(this.machineOrder));
        cx.notify();
      });
  }

  // The row's + (new agent in this space): always there at the same size, so hovering
  // changes no layout; seen and pressable only while the row is hovered.
  addButton(w, t) {
    const el = div().id(`space-add-${w.id}`).flex_none().w(20).h(20).rounded(5).flex().items_center().justify_center()
      .text_size(13).text_color(t.dim).child("+");
    if (this.hoverSpace !== w.id) return el.opacity(0);
    return this.ownPress(el.hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("New agent here"),
      () => openOverlay({ mod: "am-new-menu", kind: "popup", width: 250, height: 512, props: { space: w.id } }));
  }

  // A control inside a row: its press neither selects nor drags the row (a drag from
  // another row that ends here still moves it there).
  ownPress(el, action) {
    return el.cursor_pointer()
      .on_mouse_down("left", (_e, cx) => { if (this.pressed === null) cx.stop_propagation(); })
      .on_mouse_up("left", (_e, cx) => { if (this.pressed !== null) return; cx.stop_propagation(); action(); });
  }

  // The space's icon: an emoji or an uploaded image (the icon dialog, spaceIcon.js; shared
  // "am.sidebar.icons" by full space id), else its letter on its color. Click to change.
  avatar(w, fill, t) {
    const held = (shared("am.sidebar.icons") ?? {})[w.id];
    const pic = typeof held === "string" ? held : held?.kind === "image" ? held.file : null;
    const emoji = held && typeof held === "object" && held.kind === "emoji" ? held.char : null;
    return this.ownPress(div().id(`space-icon-${w.id}`).size(18).flex_none().rounded(5).tooltip("Change icon")
      .child(pic
        ? image(pic).size(18).rounded(5)
        : emoji
          ? h_flex().size(18).rounded(5).when(Boolean(fill), (el) => el.bg(fill)).items_center().justify_center().text_size(12).child(emoji)
          : h_flex().size(18).rounded(5).when(Boolean(fill), (el) => el.bg(fill)).items_center().justify_center()
            .text_size(10.5).font_bold().text_color(fill ? "#ffffff" : t.foreground).child(w.name[0]?.toUpperCase() ?? "?")),
      () => openOverlay(spaceIconOverlay(w.id)));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render(cx) {
    if (this.form) return this.form.render(cx);
    const t = theme();
    const collapsed = shared("am.sidebar.collapsed") === true;
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    // Each Herdr snapshot key read once per render (each read copies the whole key) and drawn
    // from by every row: the main thread is the only one, so it can't change during a render.
    // A click reads it again (the snapshot of that moment), never this one.
    this.snap = { spaces: spaces(), panes: panes(), terminals: terminals(), agents: agents(), machines: machines(), focused: focused() };
    const sp = this.snap.spaces;
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("am.space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("am.space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("am.space.colors", kept);
    this.prepareAgents();
    this.prepareBots();
    this.nameBotTabs();
    const list = this.grouped(t, collapsed);
    // agent.next / agent.prev follow the rows; ones not shown come after, in model order.
    setAgentOrder(this.order);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").p(4).rounded(5).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("space.new")).child("+")))
      // An id keeps the scroll position across renders (hover, live data).
      .child(v_flex().id("space-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list));
  }
}
