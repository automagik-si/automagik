// Automagik Automations — forked into automagik-herdr from DnzzL/herdr-automations (MIT, kept
// verbatim in LICENSE-upstream). This file is the pack's to change; RECIPE.md says what it does.
// Automations: scheduled agent prompts (herdr-automations), as a side panel. An automation may
// also be a plain command the scheduler runs itself, with no pane and no model (#938).
//
// Everything goes through the herdr-automations CLI (`… --json`): this mod
// never reads or writes automations.yaml or history.jsonl itself. The files
// are watched only to know when to ask again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { exec, hc, home, theme, terminals, panes, spaces, run, notify, pickFolder, watchFolder, knownAgents } from "herdr";
import { offeredAgents, RETIRED } from "./agents.js";
import { addressWarning, argsText, autoArgs, envText, modeOf, parseArgs, parseEnv, splitPermission, templateMode, withoutPermission } from "./modes.js";
import { RUNS_AS, parseTarget, targetLine, targetWarning } from "./targets.js";
import {
  FIND_SCHEDULER, SCHEDULER, quote, repairCommand, schedulerAsset, updateMessage,
} from "./scheduler.js";

// The scheduler's release pin and install line live in scheduler.js: pure, so the Node pin check
// (herdr/scripts/scheduler-pin.mjs) reads the same pins this panel offers.
export { SCHEDULER, repairCommand };

const PRESETS = [
  ["Hourly", "0 * * * *"],
  ["Every morning", "0 9 * * *"],
  ["Weekdays 9:00", "0 9 * * 1-5"],
  ["Mondays 9:00", "0 9 * * 1"],
  ["Fridays 17:00", "0 17 * * 5"],
];
const WORKSPACES = [["worktree", "New worktree"], ["root", "Repo root"], ["existing", "Existing space"]];
const FINISHED = new Set(["done", "failed", "cancelled"]);
// #938: what a run is. A command is run by the scheduler itself: no space, no agent, no model.
const KINDS = [["agent", "Agent prompt"], ["command", "Command (no model)"]];
/** A run in one line: a command's result line (its last output, or why it failed), else the error. */
const outcome = (r) => r.result || r.error || "";
/** Our scheduler's `version` output carries "-am." (herdr-automations-v<version>); upstream's never does. */
const oursVersion = (out) => /-am\./.test(out ?? "");
const VERSION_TIMEOUT_MS = 1500;
const PROBE_TIMEOUT_MS = 5000;
// The daemon checks the file every 30 seconds. Give it two ticks with no observed busy runs.
const RESTART_WAIT_MS = 60000;
const MAX_RESTART_WAIT_MS = 600000;
const DEFAULT_RUN_TIMEOUT_MINUTES = 60;
const RUN_TIMEOUT_MARGIN_MINUTES = 2;
const NATIVE_HEADERS = new Set([
  "7f454c46", // ELF
  "feedface", "cefaedfe", "feedfacf", "cffaedfe", // Mach-O
  "cafebabe", "bebafeca", "cafebabf", "bfbafeca", // Universal Mach-O
]);

async function probe(bin, args, timeout = PROBE_TIMEOUT_MS) {
  try {
    const r = await exec(bin, args, { timeout });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

async function linuxImage(pid, asset) {
  const exe = `/proc/${pid}/exe`;
  const [path, stamp] = await Promise.all([
    probe("readlink", [exe]), probe("stat", [...asset.stat, exe]),
  ]);
  if (!path?.startsWith("/") || !stamp) return null;
  return { path: path.replace(/ \(deleted\)$/, ""), stamp };
}

async function macImage(pid, bin) {
  const id = String(pid);
  const [files, command] = await Promise.all([
    probe("/usr/sbin/lsof", ["-a", "-p", id, "-d", "txt", "-F", "fDin"]),
    probe("/bin/ps", ["-ww", "-p", id, "-o", "comm="]),
  ]);
  if (!files || !command) return null;
  // lsof's text mappings include libraries. Match the executable named by ps.
  const mappings = files.split(/(?:^|\n)ftxt\n/).slice(1).map((record) => {
    const fields = record.split("\n");
    const path = fields.find((field) => field.startsWith("n/"))?.slice(1);
    const inode = fields.find((field) => /^i\d+$/.test(field))?.slice(1);
    const dev = fields.find((field) => /^D0x[0-9a-f]+$/i.test(field))?.slice(3);
    return { path, stamp: dev && inode ? `${dev} ${inode}` : null };
  });
  const absolute = command.startsWith("/");
  const path = absolute && (command === bin ? bin : await probe("realpath", [command]) ?? command);
  let mapping = mappings.find((image) => image.path === path || image.path === command);
  if (!absolute) {
    const suffix = "/" + command.replace(/^\.\//, "");
    const matches = mappings.filter((image) => image.path?.endsWith(suffix));
    if (matches.length === 1) [mapping] = matches;
  }
  if (mapping?.stamp) return mapping;
  // An unlinked executable can lose its lsof filename while ps still reports its launch path.
  if (path && mappings.some((image) => image.path && image.stamp)) return { path, stamp: null };
  return null;
}

function sameImage(image, stamp, os) {
  if (os === "Linux") return image.stamp === stamp;
  const identity = (value) => value.split(" ").slice(0, 2).join(" ")
    .replace(/^0+(?=\w)/, "").toLowerCase();
  return image.stamp !== null && identity(image.stamp) === identity(stamp);
}

const human = (cron) => PRESETS.find(([, c]) => c === cron)?.[0] ?? cron;
const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p ?? "");
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function until(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  const d = new Date(iso), hm = d.toTimeString().slice(0, 5);
  if (s < 86400 && d.getDate() === new Date().getDate()) return `today ${hm}`;
  // Spelled out: the mod runtime ignores toLocaleDateString's options.
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}
function duration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}`;
}

export default class Automations extends View {
  init(_props, cx) {
    this.list = null; // `ls --json`
    this.runs = []; // `history --json`
    this.view = { kind: "list" }; // list | detail {name} | form {original}
    this.error = null; this.note = null;
    this.known = null; // run ids already seen by this copy, to toast only new failures
    this.missing = null; // the repair command while the scheduler is not installed, else null
    this.build = null;
    this.running = null;
    this.copied = false;
    this.installing = false; // while the Install button's command runs
    this.handle = cx.focus_handle();
    this.bin = null; this.schedulerVersion = ""; this.watching = false;
    this.rosters = new Map(); // expanded project folder -> { list, note } (#498)
    this.amBin = null; // the am CLI that read a project's bots
    cx.spawn((cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => this.refresh(cx)); // next-run times and the scheduler's pid
  }

  async checkBuild() {
    const local = `${home()}/.local/bin/herdr-automations`;
    const [machine, os] = this.platform ??= await Promise.all([
      probe("uname", ["-m"]), probe("uname", ["-s"]),
    ]);
    const asset = schedulerAsset(machine, os);
    const previous = this.bin;
    const lookup = await probe("sh", ["-c", FIND_SCHEDULER, "sh", local]);
    const [found, resolved = found] = lookup?.split("\0") ?? [];
    this.bin = resolved || found || null;
    // Keep the CLI usable where there is no POSIX shell.
    if (!this.bin && !os) {
      for (const candidate of ["herdr-automations", local]) {
        if (await probe(candidate, ["version"], VERSION_TIMEOUT_MS) !== null) {
          this.bin = candidate;
          break;
        }
      }
    }
    this.looked = true;
    if (previous !== this.bin) {
      this.list = null; this.runs = []; this.copied = false; this.running = null;
    }
    this.missing = this.bin ? null : repairCommand(machine, os);
    if (!this.bin) {
      this.build = null;
      this.schedulerVersion = "";
      return;
    }

    const bin = this.bin;
    const stamp = asset && await probe("stat", [...asset.stat, bin]);
    const cached = stamp && this.build?.bin === bin && this.build.stamp === stamp
      ? this.build : null;
    const [version, header] = await Promise.all([
      cached?.version ?? probe(bin, ["version"], VERSION_TIMEOUT_MS),
      cached?.header ?? (stamp && probe("od", ["-An", "-tx1", "-N", "4", bin])),
    ]);
    this.schedulerVersion = version ?? "";
    this.build = { bin, found, stamp, version, header };
    if (!asset) return;
    const unchecked = `Could not check the scheduler build at ${bin}.`;
    if (!resolved || !stamp || header === null) { this.build.notice = unchecked; return; }
    // A "#!" launcher (23 21) and other unrecognized formats belong to their own install.
    if (!NATIVE_HEADERS.has(header.replace(/\s/g, ""))) {
      this.build.notice = `The scheduler at ${bin} is managed by another install. Update it there.`;
      return;
    }
    let sha256 = cached?.sha256;
    if (!sha256) {
      const sum = await probe(asset.hash[0], [...asset.hash.slice(1), bin]);
      // GNU sha256sum prefixes a backslash when it has to escape the printed filename.
      sha256 = sum?.match(/^\\?([0-9a-f]{64})(?:\s|$)/)?.[1];
    }
    if (!sha256) { this.build.notice = unchecked; return; }
    this.build.sha256 = sha256;
    if (sha256 === asset.sha256) return;
    const dir = bin.slice(0, bin.lastIndexOf("/")) || "/";
    if (await probe("test", ["-w", dir]) === null || await probe("test", ["-x", dir]) === null) {
      this.build.notice = `The scheduler lives at ${bin}. This app cannot write to ${dir}.`
        + " Update the scheduler where it was installed.";
      return;
    }
    this.build.command = repairCommand(machine, os, { bin, stamp });
  }

  async cli(args, timeout) {
    const r = await exec(this.bin, args, timeout ? { timeout } : undefined);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^error: /, ""));
    return r.stdout;
  }

  async refresh(cx) {
    if (this.installing) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readScheduler(cx);
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  async readScheduler(cx) {
    await this.checkBuild();
    if (!this.bin) { this.error = null; this.running = null; cx.notify(); return; }
    cx.notify();
    try {
      this.list = JSON.parse(await this.cli(["ls", "--json"], PROBE_TIMEOUT_MS));
      const pid = this.list.scheduler;
      const image = this.runningImage(pid);
      let history = null;
      try {
        history = JSON.parse(await this.cli(["history", "--json"], PROBE_TIMEOUT_MS));
        this.runs = history;
      } finally {
        await this.checkRunning(pid, await image, history);
      }
      // Once, for the template modes the rows show (#498); the form asks again when it opens.
      if (!this.templates) this.templates = await this.loadTemplates();
      this.error = null;
      this.announce();
      this.loadTargetRosters(cx);
      if (!this.watching) { this.watching = true; this.watch(cx); }
    } catch (e) { this.error = String(e.message ?? e); }
    cx.notify();
  }

  // Config and state folders: a change there is a change to show.
  watch(cx) {
    const dirs = [this.list?.config?.replace(/\/[^/]+$/, ""), this.list?.state].filter(Boolean);
    for (const dir of dirs) cx.spawn(async (cx) => {
      for (;;) { try { await watchFolder(dir); } catch { return; } await this.refresh(cx); }
    });
  }

  // A failure finds you (ADR 0007): toast runs that failed or were missed
  // since this copy started. The first read only learns what is there.
  announce() {
    const ids = new Set(this.runs.map((r) => r.run_id));
    if (this.known) for (const r of this.runs) {
      if (this.known.has(r.run_id) || !(r.status === "failed" || r.status === "missed")) continue;
      notify({
        title: `${r.automation} ${r.status === "failed" ? "failed" : "missed a run"}`,
        body: outcome(r), level: r.status === "failed" ? "error" : "warning",
        ...(r.terminal && this.live(r.terminal) ? { action: { name: "pane.focus", args: { terminal: r.terminal } } } : {}),
      });
    }
    this.known = ids;
  }

  // #938: whether this scheduler runs a plain command. Its ls --json says so (kinds); a build
  // that does not would drop the command key from a put, so the form never offers it there.
  get commands() { return Boolean(this.list?.kinds?.includes("command")); }

  get ours() { return oursVersion(this.schedulerVersion); }
  canClose(workspace) {
    // The first fork release supports closing fresh spaces. Closing a tab arrived in am.2.
    return this.ours && (workspace !== "existing" || this.schedulerVersion !== "0.12.1-am.1");
  }

  // #498: whether this scheduler build runs targets (ls --json's targets), and the kinds it
  // names. A build that predates them has no Target field, so it cannot return a saved target
  // in ls: the form shows an ordinary entry, offers none, and a save sends no target key (put
  // keeps the hand-written one).
  get targets() { return Array.isArray(this.list?.targets) ? this.list.targets : null; }
  canTarget(kind) { return Boolean(this.targets?.includes(kind)); }
  get targetable() { return this.canTarget("bot") || this.canTarget("worker"); }

  // A target names a bot by its id; the name a person reads comes from the project's roster
  // (`am ls --json --project`, the CLI's own read). Cached per folder, failures included, so a
  // form and a refresh do not ask twice.
  rosterDir(repo) { return repo?.startsWith("~/") ? home() + repo.slice(1) : repo ?? ""; }
  rosterOf(repo) { return this.rosters.get(this.rosterDir(repo))?.list ?? null; }
  botName(repo, id) { return this.rosterOf(repo)?.find((b) => b?.id === id)?.name ?? null; }

  // The form's and the detail's bot list for one project, or why there is none.
  async loadBots(repo, { fresh = false } = {}) {
    const dir = this.rosterDir(repo);
    if (!dir) return { list: null, note: "Choose the project folder first: its bots come from its .herdr/bots.json." };
    const hit = this.rosters.get(dir);
    if (hit && !fresh) return hit;
    // `am` is the command; a pack that predates it installs the same CLI as
    // `automagik-herdr`.
    const bins = this.amBin ? [this.amBin]
      : ["am", "automagik-herdr", `${home()}/.local/bin/am`, `${home()}/.local/bin/automagik-herdr`];
    let why = null;
    for (const bin of bins) {
      let r;
      try { r = await exec(bin, ["ls", "--json", "--project", dir]); } catch (e) { why = String(e.message ?? e); continue; }
      if (r.code === 127) { why = "the am CLI is not installed"; continue; }
      this.amBin = bin;
      if (r.code !== 0) {
        const miss = { list: null, note: `The project's bots could not be read: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop()}` };
        this.rosters.set(dir, miss);
        return miss;
      }
      try {
        const project = JSON.parse(r.stdout)?.projects?.[0];
        if (!project) { const miss = { list: null, note: "The project's bots could not be read: am ls gave no project." }; this.rosters.set(dir, miss); return miss; }
        if (project.error) { const miss = { list: null, note: `The project's bots could not be read: ${project.error}` }; this.rosters.set(dir, miss); return miss; }
        const list = (project.bots ?? []).map((b) => ({ id: b.id, name: b.name, planned: b.planned ?? null,
          status: b.status, terminal: typeof b.terminal === "string" && b.terminal ? b.terminal : null }));
        const ok = { list, note: null };
        this.rosters.set(dir, ok);
        return ok;
      } catch (e) {
        const miss = { list: null, note: `The project's bots could not be read: ${String(e.message ?? e)}` };
        this.rosters.set(dir, miss);
        return miss;
      }
    }
    const miss = { list: null, note: `The project's bots could not be read (${why ?? "am ls failed"}).` };
    this.rosters.set(dir, miss);
    return miss;
  }

  // #498: entries and history show bot names from one roster read per project.
  loadTargetRosters(cx) {
    for (const a of this.list?.automations ?? []) {
      if (!a.target && !this.runs.some((r) => r.automation === a.name && r.target)) continue;
      const dir = this.rosterDir(a.repo);
      if (!dir || this.rosters.has(dir)) continue;
      this.rosters.set(dir, { list: null, note: null });
      cx.spawn(async (cx) => { await this.loadBots(a.repo, { fresh: true }); cx.notify(); });
    }
  }

  live(address) { return terminals().find((t) => t.address === address && t.state === "live"); }
  liveFor(name) { return terminals().find((t) => t.labels?.automation === name && t.state === "live"); }

  act(cx, args, then) {
    this.note = null;
    cx.spawn(async (cx) => {
      try { await this.cli(args); then?.(); } catch (e) { this.note = String(e.message ?? e); }
      await this.refresh(cx);
    });
  }

  open(run_, cx) {
    if (!run_.seen && FINISHED.has(run_.status)) this.act(cx, ["seen", run_.run_id]);
    if (run_.terminal && this.live(run_.terminal)) run("pane.focus", { terminal: run_.terminal });
    else { this.view = { kind: "detail", name: run_.automation }; cx.notify(); }
  }

  // #498: the history target opens the bot's current terminal in this project.
  openBot(repo, target, cx) {
    const parsed = parseTarget(target);
    if (!parsed) return;
    cx.spawn(async (cx) => {
      const { list, note } = await this.loadBots(repo, { fresh: true });
      const bot = list?.find((b) => b.id === parsed.bot);
      if (!list) this.note = note;
      else if (!bot) this.note = "That bot is no longer in this project's bots.json.";
      else if (bot.terminal) {
        const shown = (panes() ?? []).some((p) => p?.terminal === bot.terminal);
        run(shown ? "agent.focus" : "terminal.peek", { terminal: bot.terminal });
        this.note = null;
      } else {
        const name = bot.name || bot.id;
        if (bot.status === "stopped") this.note = `${name} is not running. Start it from the sidebar.`;
        else if (bot.planned) this.note = `${name} is only planned and starts no runs.`;
        else this.note = `${name}: ${bot.status || "unknown"}; its terminal is not known.`;
      }
      cx.notify();
    });
  }

  installScheduler(cx) {
    const update = this.build?.command ? this.build : null;
    const command = update?.command ?? this.missing;
    if (this.installing || !command) return;
    this.installing = true; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const action = update ? "updated" : "installed";
      try {
        await this.refreshing;
        if ((update ? this.build?.command : this.missing) !== command) {
          throw new Error("The scheduler changed. Check the panel and try again.");
        }
        const r = await exec("sh", ["-c", `exec ${command}`], { timeout: 45000 });
        if (r.code !== 0) {
          throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop());
        }
        this.build = null;
      } catch (e) {
        this.note = `The scheduler was not ${action}: ${String(e.message ?? e)}`;
      } finally { this.installing = false; }
      await this.refresh(cx);
    });
  }

  runningImage(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const [machine, os] = this.platform;
    const asset = schedulerAsset(machine, os);
    if (!asset) return null;
    return os === "Linux" ? linuxImage(pid, asset) : macImage(pid, this.bin);
  }

  async checkRunning(pid, image, history) {
    const { bin, stamp } = this.build;
    const [machine, os] = this.platform;
    const previous = this.running;
    this.running = null;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !schedulerAsset(machine, os)) return;
    if (!image) {
      this.running = {
        message: "Could not check which build the running scheduler is using."
          + " Reopen Automations to try again.",
      };
      return;
    }
    if (image.path !== bin) {
      this.running = {
        message: `The running scheduler uses a different file (${image.path}).`
          + ` This panel checks ${bin}. Check how the scheduler was started and update it there.`,
      };
      return;
    }
    if (!stamp || sameImage(image, stamp, os)) return;
    // Keep the waiting time for this pair of files. The image probe must run again even with
    // the same PID and disk stamp because the daemon switches builds without changing its PID.
    const same = previous?.pid === pid && previous.bin === bin
      && previous.stamp === stamp && previous.loaded === image.stamp;
    const now = Date.now();
    const since = same ? previous.since : now;
    const timeouts = new Map(this.list.automations.map((a) => [a.name, a.timeout_minutes]));
    const idle = Array.isArray(history)
      && !history.some((r) => {
        if (r.status !== "running" && r.status !== "scheduled") return false;
        const timeout = timeouts.get(r.automation);
        const minutes = timeout > 0 && Number.isFinite(timeout) ? timeout : DEFAULT_RUN_TIMEOUT_MINUTES;
        return now - Date.parse(r.at) < (minutes + RUN_TIMEOUT_MARGIN_MINUTES) * 60000;
      });
    const idleSince = idle ? (same ? previous.idleSince : null) ?? now : null;
    let message = "The scheduler switches to the new build when no run is busy.";
    if ((idleSince !== null && now - idleSince >= RESTART_WAIT_MS)
        || now - since >= MAX_RESTART_WAIT_MS) {
      const status = await probe(bin, ["service", "status"]);
      const installed = status?.match(/^service installed: (true|false)$/m)?.[1];
      message = `The scheduler is still using the old build. Run ${quote(bin)} service status`
        + " to check it before restarting.";
      if (installed && status.split("\n").includes(`scheduler running: true (pid ${pid})`)) {
        const how = installed === "false"
          ? `run kill -TERM ${pid}. Once it stops, start it the same way if you know how it was`
            + ` launched, or run ${quote(bin)} service install to start it as a login service.`
            + ` If you run ${quote(bin)} daemon in a terminal, it will stop when that terminal closes.`
          : os === "Darwin"
            ? `run ${quote(bin)} service install.`
            : "run systemctl --user restart herdr-automations.service.";
        message = `The scheduler is still using the old build. After your runs finish, ${how}`
          + " Restarting stops running commands and the scheduler loses track of agent runs in progress.";
      }
    }
    this.running = { pid, bin, stamp, loaded: image.stamp, since, idleSince, message };
  }

  // hc's templates, or null when hc gave no list: a failure is never kept as an empty list, so
  // the next refresh asks again (template modes read "not known" until then).
  async loadTemplates() {
    try {
      const r = await hc(["templates", "--json"]);
      const list = r.code === 0 ? JSON.parse(r.stdout).templates : null;
      return Array.isArray(list) ? list : null;
    } catch { return null; }
  }

  // ---- form ----

  edit(original, cx) {
    const a = this.list?.automations.find((x) => x.name === original) ?? {
      name: "", cron: "0 9 * * 1-5", repo: "", workspace: "worktree", agent: "claude", prompt: "", timeout_minutes: 60,
    };
    const field = (value, placeholder) => {
      const s = InputState.new({ placeholder, value: value ?? "" });
      s.on("change", (_e, cx) => this.preview(cx));
      return s;
    };
    // #498: who the prompt goes to, from the entry's own target. A build that does not announce
    // targets keeps the saved key untouched ("kept") and offers none.
    const saved = parseTarget(a.target);
    const keptTarget = Boolean(a.target) && !this.canTarget(saved?.kind);
    this.form = {
      // #938: a command entry has no repo, space or agent; switched to a prompt it starts on the
      // defaults a new one gets.
      kind: a.command ? "command" : "agent", wasCommand: Boolean(a.command),
      command: field(argsText(a.command?.argv), "./check.sh --all"),
      cwd: field(tilde(a.command?.cwd), "your home folder"),
      env: field(envText(a.command?.env), 'optional: KEY=value KEY2="two words"'),
      notify: field(a.notify, "optional: a bot id (b-…) or a terminal name"),
      original, workspace: a.workspace || "worktree", workspace_id: a.workspace_id ?? "",
      target: saved && this.canTarget(saved.kind) ? saved.kind : a.target ? "kept" : "none", bot: saved?.bot ?? "",
      busy: a.target_when_busy || "queue", savedTarget: a.target ?? "",
      bots: null, botsNote: null,
      // #498 (D2): new entries opt in to closing on success. Saved entries use the value from ls.
      close: original ? a.close_workspace === "on-success" : true,
      agent: a.template ? "" : a.agent || "claude", template: a.template ?? "",
      name: field(a.name, "issue-triage"), cron: field(a.cron, "0 9 * * 1-5"), repo: field(tilde(a.repo), "~/Projects/myapp"),
      model: field(a.model, "agent default"), timeout: field(String(a.timeout_minutes ?? 60), "60"),
      mcp: field(tilde(a.mcp_config), "optional: path to an MCP servers JSON"),
      // #501: what the form doesn't edit goes back to put as it came. Since v0.12.0 put keeps the
      // keys it is not sent; sending them back stays harmless and keeps an older scheduler right.
      untouched: { catch_up_minutes: a.catch_up_minutes, disabled: a.disabled, workflow: a.workflow },
      // #501: the entry's own agent_args, kept as they are unless the person changes them here.
      // #498: a new entry starts on the automatic mode ("auto"); an existing one on "kept", its
      // saved args as they are, so nothing is migrated on load (housekeeper-daily included).
      // Kept exactly only while the agent is the saved one (savedAgent; "" for a template entry):
      // after a switch the other agent's permission flags never carry over (agentArgsOf).
      agentArgs: Array.isArray(a.agent_args) ? [...a.agent_args] : null,
      savedAgent: a.template ? "" : a.agent || "claude",
      mode: original ? "kept" : "auto",
      prompt: TextareaState.new({ placeholder: "What should the agent do each time?", value: a.prompt ?? "" }),
      result: null, warning: null, seq: 0,
    };
    const f = this.form;
    f.args = field(argsText(splitPermission(f.agent, f.agentArgs).rest), "optional: more words for the agent, after its flags");
    f.argsLine = f.args.value();
    this.form.prompt.set_auto_grow(4, 12);
    this.form.prompt.on("change", (_e, cx) => this.preview(cx));
    this.view = { kind: "form" };
    cx.spawn(async (cx) => {
      this.templates = (await this.loadTemplates()) ?? this.templates;
      try { this.installed = (await knownAgents()).filter((a) => a.installed).map((a) => a.key); } catch { this.installed = null; }
      if (this.form === f && a.target) {
        const r = await this.loadBots(f.repo.value());
        f.bots = r.list; f.botsNote = r.note;
      }
      cx.notify();
    });
    this.preview(cx);
  }

  entry() {
    const f = this.form, num = parseInt(f.timeout.value(), 10);
    const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
    const timeout_minutes = Number.isFinite(num) ? num : 0;
    // #498: a target hands the prompt to a bot (or a worker of one). Every agent and space key
    // goes empty, which put removes: the scheduler refuses a target that still names one, and
    // the bot's own launch supplies them. The bot is named by id, never by an address.
    if (f.kind !== "command" && (f.target === "bot" || f.target === "worker")) return {
      ...(f.wasCommand ? { command: null, notify: "" } : {}),
      name: f.name.value().trim(), cron: f.cron.value().trim(), repo: expand(f.repo.value().trim()),
      prompt: f.prompt.value(), timeout_minutes,
      target: `${f.target}:${f.bot}`,
      target_when_busy: f.target === "bot" ? f.busy : "",
      workspace: "", workspace_id: "", session: "", agent: "", template: "", model: "",
      mcp_config: "", agent_args: [], close_workspace: "", workflow: "", notify: "",
      ...Object.fromEntries(Object.entries({ catch_up_minutes: f.untouched.catch_up_minutes, disabled: f.untouched.disabled })
        .filter(([, v]) => v !== undefined && v !== null)),
    };
    // #938: a command. Every agent and space key goes empty, which put removes: the scheduler
    // refuses a command that still names one. What the form does not edit stays as it came.
    if (f.kind === "command") return {
      name: f.name.value().trim(), cron: f.cron.value().trim(), timeout_minutes,
      command: { argv: parseArgs(f.command.value()), cwd: expand(f.cwd.value().trim()), env: parseEnv(f.env.value()).env ?? {} },
      notify: f.notify.value().trim(),
      repo: "", workspace: "", workspace_id: "", session: "", agent: "", template: "", model: "", prompt: "", workflow: "",
      mcp_config: "", agent_args: [], blocked_grace_minutes: 0, close_workspace: "",
      ...(this.targetable || f.savedTarget ? { target: "", target_when_busy: "" } : {}),
      ...Object.fromEntries(Object.entries({ catch_up_minutes: f.untouched.catch_up_minutes, disabled: f.untouched.disabled })
        .filter(([, v]) => v !== undefined && v !== null)),
    };
    return {
      // An entry that was a command and is a prompt now: its command and its bot go.
      ...(f.wasCommand ? { command: null, notify: "" } : {}),
      name: f.name.value().trim(), cron: f.cron.value().trim(), repo: expand(f.repo.value().trim()),
      workspace: f.workspace, workspace_id: f.workspace === "existing" ? f.workspace_id : "",
      agent: f.template ? "" : f.agent, template: f.template, model: f.template ? "" : f.model.value().trim(),
      prompt: f.prompt.value(), mcp_config: expand(f.mcp.value().trim()), timeout_minutes: Number.isFinite(num) ? num : 0,
      ...Object.fromEntries(Object.entries(f.untouched).filter(([, v]) => v !== undefined && v !== null)),
      ...this.agentArgsOf(f),
      // Only our build's put and ls --json carry close_workspace. Upstream put drops a sent key
      // it does not recognize (its api.Automation has no field).
      ...(this.ours ? { close_workspace: f.close && this.canClose(f.workspace) ? "on-success" : "never" } : {}),
      // #498: switching back to a new session removes the target, but only where the build
      // knows the key; an older one keeps the hand-written value it cannot run.
      ...(this.targetable || f.savedTarget ? { target: "", target_when_busy: "" } : {}),
    };
  }

  // The flags the run starts the agent with (#498, #501), as { agent_args }, [] for none: since
  // v0.12.0 put keeps a key it is not sent, so leaving it out would keep the old flags.
  // An existing entry the person did not touch here sends its own args back exactly. A template
  // run gets no flags from the panel (its command brings its own): its saved args go back as
  // they were. Otherwise: the chosen mode's permission flags, then the words of AGENT ARGS.
  // After a switch away from the saved agent, every permission word is dropped from the words that
  // carry over, and "kept" reads as Agent default.
  agentArgsOf(f) {
    const own = f.agentArgs, same = this.sameAgent(f);
    const mode = f.mode === "kept" && !same ? "default" : f.mode;
    const args = f.template || (mode === "kept" && f.args.value() === f.argsLine) ? own
      : [...(mode === "kept" ? splitPermission(f.agent, own).perm : mode === "auto" ? autoArgs(f.agent) ?? [] : []),
        ...(same ? parseArgs(f.args.value()) : withoutPermission(parseArgs(f.args.value())))];
    return { agent_args: args ?? [] };
  }

  // Whether the form's agent is the one the entry was saved with (always, for a new entry).
  sameAgent(f) { return !f.original || (!f.template && f.agent === f.savedAgent); }

  // The binary checkBuild() found can be replaced while the panel is open, so put() asks
  // once more, right before it builds the JSON. A probe that fails or errors reads as upstream
  // (fail closed): close_workspace must never reach upstream's put.
  async probeVersion() {
    this.schedulerVersion = await probe(this.bin, ["version"], VERSION_TIMEOUT_MS) ?? "";
  }

  async put(dryRun) {
    const f = this.form, args = ["put", ...(f.original ? ["--original", f.original] : []), ...(dryRun ? ["--dry-run"] : [])];
    // #498: a kept target on a build that cannot run one is never rewritten: its keys would be
    // dropped or its agent/space keys refused. Installing our build is the fix.
    if (f.target === "kept") return { problem: `This entry targets ${targetLine(f.savedTarget, (id) => this.botName(f.repo.value(), id))}; `
      + `this scheduler build cannot run a target (ours is ${SCHEDULER.version}). Install it before editing this entry.` };
    if (f.kind !== "command" && (f.target === "bot" || f.target === "worker") && !f.bot)
      return { problem: "Choose a bot: a target needs one." };
    // A word in ENV that is not KEY=value is said here: the scheduler would never see it.
    const env = f.kind === "command" ? parseEnv(f.env.value()) : {};
    if (env.problem) return { problem: env.problem };
    await this.probeVersion();
    // exec has no stdin: hand the JSON over through the shell.
    const r = await exec("sh", ["-c", 'bin=$1 json=$2; shift 2; printf %s "$json" | "$bin" "$@"', "sh", this.bin, JSON.stringify(this.entry()), ...args]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return JSON.parse(r.stdout);
  }

  preview(cx) {
    const f = this.form, seq = ++f.seq;
    // #498: a prompt naming a terminal is saved all the same, with a warning beside it.
    f.warning = f.kind === "command" ? null : addressWarning(f.prompt.value());
    cx.spawn(async (cx) => {
      let result;
      try { result = await this.put(true); } catch (e) { result = { problem: String(e.message ?? e) }; }
      if (this.form === f && seq === f.seq) { f.result = result; cx.notify(); }
    });
  }

  save(cx) {
    const f = this.form;
    f.warning = f.kind === "command" ? null : addressWarning(f.prompt.value());
    cx.spawn(async (cx) => {
      try {
        // #498: the roster is read again for this folder before a target is
        // saved: a bot that left it, or a planned one, is said now, not at 3am.
        if (f.kind !== "command" && (f.target === "bot" || f.target === "worker")) {
          if (!f.bot) { f.seq += 1; f.result = { problem: "Choose a bot: a target needs one." }; cx.notify(); return; }
          const r = await this.loadBots(f.repo.value(), { fresh: true });
          f.bots = r.list; f.botsNote = r.note;
          const why = targetWarning(`${f.target}:${f.bot}`, f.bots);
          if (why) { f.seq += 1; f.result = { problem: why }; cx.notify(); return; }
        }
        const res = await this.put(false);
        if (res.problem) f.result = res;
        else if (f.kind !== "command" && (f.target === "bot" || f.target === "worker")) {
          // #498: the capability is a claim until the save is read back. A build that says it
          // runs targets but drops the key must not look like a successful save.
          const want = `${f.target}:${f.bot}`, name = f.name.value().trim();
          let kept = null, why = null;
          try { kept = (JSON.parse(await this.cli(["ls", "--json"]))?.automations ?? []).find((a) => a.name === name)?.target ?? null; }
          catch (e) { why = String(e.message ?? e); }
          if (kept !== want) {
            f.seq += 1;
            f.result = { problem: `The scheduler took the save but does not keep ${targetLine(want, (id) => this.botName(f.repo.value(), id))}`
              + `${why ? ` (${why})` : ""}: it does not run targets. Install a build whose ls --json names them.` };
            cx.notify(); return;
          }
          this.view = { kind: "detail", name }; this.form = null;
        } else { this.view = { kind: "detail", name: this.entry().name }; this.form = null; }
      } catch (e) { f.result = { problem: String(e.message ?? e) }; }
      await this.refresh(cx);
    });
  }

  // ---- render ----

  render(cx) {
    const t = theme();
    const body = this.view.kind === "form" && this.form ? this.renderForm(t, cx)
      : this.view.kind === "detail" ? this.renderDetail(t, cx) : this.renderList(t, cx);
    // The footer's Automations tab opens this panel as a popup (am-footer PANEL_POPUP), and a
    // popup is as tall as its content, its height only the most. A body built with
    // overflow_y_scrollbar measures 0 there (its wrapper is a share of nothing): the popup drew
    // the header alone, light and dark, on Herdr 0.1.13 and 0.1.15 (#938). So the body is
    // am-sidebar's bot-form shape (#239, #397): a flex column holding the scroll area as a flex
    // item, which takes its rows' height, and a bar paired with it by name. In a layout block
    // (a set height) both fill, as before.
    return v_flex().id("automations").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(this.header(t, cx))
      .when(Boolean(this.missing), (el) => el.child(this.repair(t, cx)))
      .when(Boolean(this.build?.command), (el) => el.child(this.updateRow(t)))
      .when(Boolean(this.build?.notice), (el) =>
        el.child(this.schedulerNotice("scheduler-build-notice", this.build.notice, t)))
      .when(Boolean(this.running), (el) =>
        el.child(this.schedulerNotice("scheduler-handoff", this.running.message, t)))
      .when(Boolean(this.list && !this.list.scheduler), (el) => el.child(this.banner(t, cx)))
      .when(this.list?.backend === "herdr" || this.list?.backend === "", (el) => el.child(this.backendNotice(t)))
      .when(Boolean(this.error || this.note), (el) => el.child(div().px(14).py(6).text_size(12).text_color(t.ansi1).child(this.error || this.note)))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(div().id("automations-body").flex_1().min_h(0).overflow_y_scroll().child(body))
        .child(Scrollbar.vertical("automations-body").absolute().inset_0()));
  }

  button(id, label, t, onClick, opts = {}) {
    return h_flex().id(id).h(opts.h ?? 26).px(opts.px ?? 9).flex_none().items_center().justify_center().rounded(7).text_size(12)
      .bg(opts.solid ? t.solid : t.raised).text_color(opts.solid ? t.solid_foreground : opts.danger ? t.ansi1 : t.foreground)
      .border_1().border_color(opts.solid ? t.solid : t.border).cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => onClick(cx)).child(label);
  }

  // An option is [value, label] or [value, label, true]: the last draws it dimmed (a retired agent).
  pills(id, options, value, t, pick) {
    return h_flex().flex_wrap().gap(5).children(options.map(([v, label, dim]) =>
      h_flex().id(`${id}-${v}`).h(24).px(8).items_center().rounded(6).text_size(12).cursor_pointer()
        .bg(v === value ? t.selected : t.raised).text_color(dim ? t.dim : v === value ? t.foreground : t.muted)
        .border_1().border_color(v === value ? t.accent : t.border).hover((s) => s.bg(t.hover))
        .when(Boolean(dim), (el) => el.opacity(0.6))
        .on_click((_e, cx) => pick(v, cx)).child(label)));
  }

  switch_(id, on, t, toggle) {
    return h_flex().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer().bg(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end()).on_click((_e, cx) => toggle(cx))
      .child(div().size(13).rounded(7).bg(t.background));
  }

  header(t, cx) {
    const paused = Boolean(this.list?.paused);
    const back = this.view.kind !== "list";
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(back, (el) => el.child(this.button("back", "‹", t, (cx) => { this.view = { kind: "list" }; this.form = null; cx.notify(); }, { px: 7 })))
      .child(div().font_semibold().child("Automations"))
      .child(div().flex_1())
      .when(Boolean(this.list), (el) => el
        .child(div().text_size(11).text_color(paused ? t.blocked : t.dim).child(paused ? "All paused" : "Active"))
        .child(this.switch_("pause-all", !paused, t, (cx) => this.act(cx, [paused ? "resume" : "pause", "--all"]))))
      // No scheduler, no form: its preview and Save both need the CLI.
      .when(!back && Boolean(this.bin), (el) => el.child(
        this.button("new", "+", t, (cx) => this.edit(null, cx), { px: 8 })));
  }

  banner(t, cx) {
    return h_flex().px(14).py(8).gap(8).items_center().bg(t.blocked + "22").border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(12).child("Scheduler stopped: nothing will run on time."))
      .child(this.button("start", "Start", t, (cx) => this.act(cx, ["service", "install"]), { solid: true }));
  }

  // Readiness (#220): under `backend: herdr` (the scheduler's default: ls --json says "" while no
  // automations.yaml exists) a run opens in the Herdr TUI's server, never in this app. The panel
  // never edits automations.yaml, so it names the file and the line to set.
  backendNotice(t) {
    return div().id("backend-notice").px(14).py(8).text_size(12).bg(t.blocked + "22").border_b(1).border_color(t.border)
      .child(`Backend is herdr: runs open in the Herdr TUI, not in this app. Set "backend: hc" in ${tilde(this.list.config) || "automations.yaml"}.`);
  }

  // One line for what is missing, the exact command, Copy and Install. Only a click on Install runs it.
  repair(t, cx) {
    return v_flex().id("scheduler-missing").px(14).py(8).gap(6).bg(t.blocked + "22").border_b(1).border_color(t.border)
      .child(div().text_size(12).child("Missing the scheduler: herdr-automations is not on PATH or in ~/.local/bin."))
      .child(h_flex().gap(8).items_start()
        .child(div().id("repair-command").flex_1().min_w(0).p(6).rounded(6).bg(t.input).font_family("JetBrains Mono")
          .text_size(11).text_color(t.muted).child(this.missing))
        .child(this.button("copy-repair", this.copied ? "Copied" : "Copy", t, (cx) => {
          cx.write_to_clipboard(this.missing); this.copied = true; cx.notify();
        }))
        .child(this.button("install-repair", this.installing ? "Installing…" : "Install", t, (cx) => this.installScheduler(cx), { solid: true })))
      .child(div().text_size(11).text_color(t.dim).child("Install runs it here; or run it in a terminal, and this panel finds it within 30 s."));
  }

  updateRow(t) {
    const { bin, found, version } = this.build;
    return v_flex().id("scheduler-update").px(14).py(8).gap(6).bg(t.blocked + "22")
      .border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(12).child(updateMessage(version ?? "")))
        .child(this.button("update-scheduler", this.installing ? "Updating…" : "Update", t,
          (cx) => this.installScheduler(cx), { solid: true })))
      .child(div().text_size(11).text_color(t.dim).child(found && found !== bin
        ? `Update replaces ${bin}, the file that ${found} points to.`
        : `Update replaces ${bin}.`));
  }

  schedulerNotice(id, message, t) {
    return div().id(id).px(14).py(8).text_size(12).bg(t.blocked + "22")
      .border_b(1).border_color(t.border).child(message);
  }

  dot(a, t) {
    const live = this.liveFor(a.name);
    // A command has no terminal to be live in: its running record is the sign.
    const color = live ? (live.status === "blocked" ? t.blocked : t.working)
      : (a.command || a.target) && a.last?.status === "running" ? t.working
      : a.disabled || this.list.paused ? t.dim : a.last?.status === "failed" || a.last?.status === "missed" ? t.ansi1 : t.idle;
    return div().size(8).rounded(4).flex_none().bg(color);
  }

  renderList(t, cx) {
    if (!this.list) {
      const message = this.looked && !this.bin ? "The scheduler is unavailable." : "Loading…";
      return div().p(14).text_color(t.dim).child(this.error || this.missing ? "" : message);
    }
    const inbox = this.runs.filter((r) => FINISHED.has(r.status) && !r.seen).slice(0, 20);
    const section = (label, n) => h_flex().px(14).pt(12).pb(4).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
      .child(label).when(n > 0, (el) => el.child(div().px(5).rounded(4).bg(t.raised).child(String(n))));
    const col = v_flex().pb(10);
    col.child(section("INBOX", inbox.length).when(inbox.length > 0, (el) => el.child(div().flex_1())
      .child(div().id("seen-all").font_normal().cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.act(cx, ["seen", "--all"])).child("Mark all read"))));
    if (!inbox.length) col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("Nothing new."));
    for (const r of inbox) col.child(this.inboxRow(r, t));
    col.child(section("AUTOMATIONS", 0));
    if (!this.list.automations.length && !this.list.invalid.length)
      col.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("None yet. + creates one."));
    for (const a of this.list.automations) col.child(this.row(a, t));
    for (const d of this.list.invalid) col.child(v_flex().mx(8).my(2).px(8).py(6).rounded(7).bg(t.ansi1 + "18")
      .child(div().text_size(12).font_semibold().child(d.name || `line ${d.line}`))
      .child(div().text_size(11).text_color(t.muted).child(d.message)));
    return col;
  }

  inboxRow(r, t) {
    const ok = r.status === "done", color = ok ? t.ansi2 : r.status === "failed" ? t.ansi1 : t.dim;
    return v_flex().id(`inbox-${r.run_id}`).mx(8).px(8).py(6).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(r, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(color))
        .child(div().flex_1().min_w(0).truncate().child(r.automation))
        .child(div().text_size(11).text_color(color).child(r.status))
        .child(div().text_size(11).text_color(t.dim).child(ago(r.at))))
      .child(div().id(`inbox-line-${r.run_id}`).pl(13).text_size(11).text_color(t.muted).truncate()
        .child(outcome(r) || `${duration(r.seconds)}${r.terminal && this.live(r.terminal) ? " · open" : ""}`));
  }

  row(a, t) {
    const live = this.liveFor(a.name);
    const sub = live ? `running · ${live.status ?? "starting"}` : (a.command || a.target) && a.last?.status === "running" ? "running"
      : a.disabled ? "paused"
      : `${human(a.cron)} · ${this.list.paused ? "held" : until(a.next)}`;
    return v_flex().id(`auto-${a.name}`).mx(8).px(8).py(7).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = { kind: "detail", name: a.name }; cx.notify(); })
      .child(h_flex().gap(7).items_center().child(this.dot(a, t)).child(div().flex_1().min_w(0).truncate().font_semibold().child(a.name))
        .child(this.button(`run-${a.name}`, "▶", t, (cx) => this.act(cx, ["run", a.name, "--bg"]), { px: 6, h: 22 })))
      .child(div().pl(15).text_size(11).text_color(t.muted).truncate().child(sub))
      .child(div().id(`auto-kind-${a.name}`).pl(15).text_size(11).text_color(t.dim).truncate().child(a.command
        ? `command · ${argsText(a.command.argv)}${a.notify ? ` · tells ${a.notify}` : ""}`
        : a.target ? `${targetLine(a.target, (id) => this.botName(a.repo, id))} · its own launch`
        : `${a.template ? "template " + a.template : a.agent + (a.model ? " · " + a.model : "")} · ${a.workspace} · ${this.modeLine(a)}`));
  }

  // #938: a command's last run, spelled out: the status and exit code, its one line, the last
  // lines of stderr when it failed, and what became of the report to its bot.
  lastRun(a, t) {
    const r = a.last;
    if (!r || !FINISHED.has(r.status)) return null;
    const ok = r.status === "done";
    const head = `${r.status}${typeof r.exit_code === "number" ? ` · exit ${r.exit_code}` : ""} · ${ago(r.at)}`;
    return v_flex().id("d-last").p(8).gap(4).rounded(7).bg(t.raised).text_size(12)
      .child(div().id("d-last-status").text_size(11).text_color(ok ? t.ansi2 : t.ansi1).child(head))
      .child(div().id("d-last-result").child(outcome(r) || "no output"))
      .when(!ok && Boolean(r.stderr), (el) => el.child(v_flex().id("d-last-stderr").font_family("JetBrains Mono").text_size(11).text_color(t.muted)
        .children(String(r.stderr).split("\n").map((line) => div().child(line)))))
      .when(Boolean(r.notified), (el) => el.child(div().id("d-last-notified").text_size(11)
        .text_color(r.notified.startsWith("sent") ? t.dim : t.blocked).child(`${a.notify || "bot"}: ${r.notified}`)));
  }

  renderDetail(t, cx) {
    const a = this.list?.automations.find((x) => x.name === this.view.name);
    if (!a) return div().p(14).text_color(t.dim).child("This automation is gone.");
    const runs = this.runs.filter((r) => r.automation === a.name && r.status !== "scheduled").slice(0, 30);
    const kv = (k, v) => h_flex().gap(8).text_size(12).child(div().w(78).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().child(v || "—"));
    const deleting = this.deleting === a.name;
    return v_flex().p(14).gap(10)
      .child(h_flex().gap(8).items_center().child(this.dot(a, t)).child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(a.name)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("d-run", "Run now", t, (cx) => this.act(cx, ["run", a.name, "--bg"]), { solid: true }))
        .child(this.button("d-pause", a.disabled ? "Resume" : "Pause", t, (cx) => this.act(cx, [a.disabled ? "resume" : "pause", a.name])))
        .child(this.button("d-edit", "Edit", t, (cx) => this.edit(a.name, cx)))
        .child(this.button("d-rm", deleting ? "Confirm delete" : "Delete", t, (cx) => {
          if (!deleting) { this.deleting = a.name; cx.notify(); return; }
          this.deleting = null;
          this.act(cx, ["rm", a.name], () => { this.view = { kind: "list" }; });
        }, { danger: true })))
      .child(v_flex().gap(4)
        .child(kv("Schedule", `${human(a.cron)}${human(a.cron) !== a.cron ? ` (${a.cron})` : ""}`))
        .child(kv("Next", a.disabled ? "paused" : this.list.paused ? "held: all paused" : until(a.next)))
        .when(!a.command, (el) => el
          .child(kv("Repo", tilde(a.repo)))
          .when(Boolean(a.target), (el2) => el2
            .child(kv("Target", targetLine(a.target, (id) => this.botName(a.repo, id))))
            .child(kv("Launch", "the bot's own"))
            .when(String(a.target).startsWith("bot:") && a.target_when_busy === "skip",
              (el3) => el3.child(kv("When busy", "skip the run"))))
          .when(!a.target, (el2) => el2
            .child(kv("Runs in", WORKSPACES.find(([w]) => w === a.workspace)?.[1] ?? a.workspace))
            .child(kv(a.template ? "Template" : "Agent", a.template || `${a.agent}${a.model ? " · " + a.model : ""}`))
            .child(kv("Permissions", this.modeLine(a)))))
        // #938: a command runs as you, in its folder, with no agent; these are its own lines.
        .when(Boolean(a.command), (el) => el
          // Short enough for the 320 px panel's value column (#938: "no agent, no model" was cut).
          .child(kv("Runs", "a command, as you, no model"))
          .child(kv("Folder", tilde(a.command.cwd) || "your home folder"))
          .child(kv("Env", Object.keys(a.command.env ?? {}).join(", ")))
          .child(kv("Timeout", `${a.timeout_minutes} min`))
          .child(kv("Tells", a.notify))))
      .child(div().id("d-work").p(8).rounded(7).bg(t.raised).text_size(12).text_color(t.muted)
        .when(Boolean(a.command), (el) => el.font_family("JetBrains Mono"))
        .child(a.command ? argsText(a.command.argv) : a.prompt || a.workflow || ""))
      .when(Boolean(a.command && this.lastRun(a, t)), (el) => el
        .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child("LAST RESULT"))
        .child(this.lastRun(a, t)))
      .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child("HISTORY"))
      .children(runs.length ? runs.flatMap((r) => {
        const row = h_flex().id(`h-${r.run_id}`).gap(8).px(6).py(4).rounded(6).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(r, cx))
          .child(div().w(66).flex_none().text_size(11).text_color(r.status === "done" ? t.ansi2 : r.status === "failed" || r.status === "missed" ? t.ansi1 : t.muted).child(r.status))
          .child(div().id(`h-line-${r.run_id}`).flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(outcome(r) || (r.seconds ? duration(r.seconds) : "")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.at)));
        if (!parseTarget(r.target)) return [row];
        return [row, div().id(`h-target-${r.run_id}`).pl(80).text_size(11).text_color(t.dim).truncate().cursor_pointer()
          .hover((s) => s.bg(t.hover)).rounded(6).on_click((_e, cx) => this.openBot(a.repo, r.target, cx))
          .child(`→ ${targetLine(r.target, (id) => this.botName(a.repo, id))}`)];
      })
        : [div().text_size(12).text_color(t.dim).child("No runs yet.")]);
  }

  // The template's mode, read from its hc command (#498); the panel adds nothing to it.
  templateModeOf(name) {
    const tp = (this.templates ?? []).find((x) => x?.name === name);
    return tp ? templateMode(tp.command) : "not known (hc lists no such template)";
  }

  // What the saved entry (a) runs with, in words, for the list row and the detail (#498).
  modeLine(a) {
    if (a.template) return `${this.templateModeOf(a.template)} (template)`;
    return modeOf(a.agent || "claude", a.agent_args);
  }

  // PERMISSIONS (#498): the mode the run starts the agent in. A new entry starts on the agent's
  // automatic mode, when it has one; an existing one on its saved args ("As saved"), never
  // migrated. Picking Agent default saves no permission flag. A template brings its own.
  modeForm(f, t, input) {
    const note = (id, text) => div().id(id).text_size(11).text_color(t.muted).child(text);
    if (f.template) return note("f-mode-template", `${f.template}: ${this.templateModeOf(f.template)}. `
      + "The template's command brings its own flags; the panel adds none.");
    const auto = autoArgs(f.agent);
    const same = this.sameAgent(f);
    const picked = (f.mode === "auto" && !auto) || (f.mode === "kept" && !same) ? "default" : f.mode;
    const options = [
      ...(f.original && same ? [["kept", `As saved: ${modeOf(f.agent, f.agentArgs)}`]] : []),
      ...(auto ? [["auto", `Automatic (${auto.join(" ")})`]] : []),
      ["default", "Agent default"],
    ];
    const args = this.agentArgsOf(f).agent_args ?? [];
    const why = auto ? null : `${f.agent} has no known automatic mode: it runs with its own default.`;
    return v_flex().gap(4)
      .child(this.pills("f-mode", options, picked, t, (v, cx) => { f.mode = v; this.preview(cx); cx.notify(); }))
      .when(Boolean(why), (el) => el.child(note("f-mode-none", why)))
      .child(note("f-mode-now", `Runs ${modeOf(f.agent, args)}${args.length ? `: ${f.agent} ${argsText(args)}` : ""}`))
      .child(input("f-args", f.args));
  }

  renderForm(t, cx) {
    const f = this.form;
    const label = (s) => div().pt(6).text_size(11).font_semibold().text_color(t.dim).child(s);
    const input = (id, state) => div().id(id).h(30).px(9).flex().items_center().rounded(7).border_1().border_color(t.input).bg(t.surface ?? t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().w_full().text_size(12));
    const cron = f.cron.value().trim();
    const presets = [...PRESETS.map(([l, c]) => [c, l]), ["custom", "Custom"]];
    const preset = PRESETS.some(([, c]) => c === cron) ? cron : "custom";
    // Installed ones, and the entry's own agent even if it is not (any more).
    const offered = offeredAgents(this.installed, f.agent);
    // A retired agent is never offered, but an entry saved with one shows it, dimmed, so the
    // person sees what is set; the value is kept and saved back unchanged.
    const retired = !f.template && RETIRED.has(f.agent) ? [[f.agent, `${f.agent} (retired)`, true]] : [];
    const agents = [...offered.map((a) => [a, a]), ...retired, ...(this.templates ?? []).map((tp) => [`template:${tp.name}`, `${tp.name} (template)`])];
    const agentValue = f.template ? `template:${f.template}` : f.agent;
    const res = f.result;
    return v_flex().p(14).gap(4)
      .child(div().text_size(15).font_semibold().child(f.original ? `Edit ${f.original}` : "New automation"))
      .child(label("NAME")).child(input("f-name", f.name))
      .child(label("SCHEDULE")).child(this.pills("f-preset", presets, preset, t, (v, cx) => { if (v !== "custom") f.cron.set_value(v); this.preview(cx); cx.notify(); }))
      .child(input("f-cron", f.cron))
      // #938: what the run is. Offered only by a scheduler whose ls --json names the command kind.
      .when(this.commands, (el) => el.child(label("RUNS")).child(this.pills("f-kind", KINDS, f.kind, t, (v, cx) => { f.kind = v; this.preview(cx); cx.notify(); })))
      .when(!this.commands, (el) => el.child(div().id("f-kind-old").pt(6).text_size(11).text_color(t.muted)
        .child("This scheduler build runs agent prompts only. A newer herdr-automations also runs a plain command, with no model.")))
      // #498: who the prompt goes to. Offered only by a scheduler whose ls --json names the
      // kinds; a build that does not would drop the key from a put.
      .when(f.kind !== "command" && (this.targetable || f.target === "kept"), (el) => el
        .child(label("RUNS AS"))
        .child(this.pills("f-runs", RUNS_AS.filter(([v]) => v === "none" || this.canTarget(v)), f.target, t, (v, cx) => {
          f.target = v; if (v === "none") f.bot = "";
          this.loadBotsForForm(f, cx);
          this.preview(cx); cx.notify();
        })))
      .when(f.kind !== "command" && f.target === "kept", (el) => el.child(div().id("f-target-kept").pt(6).text_size(11).text_color(t.blocked)
        .child(`This entry targets ${targetLine(f.savedTarget, (id) => this.botName(f.repo.value(), id))}; this scheduler build `
          + `cannot run a target (ours is ${SCHEDULER.version}). Pick New session to remove it, or install our build.`)))
      .when(f.kind === "command", (el) => this.commandForm(el, f, t, label, input))
      .when(f.kind !== "command", (el) => this.agentForm(el, f, t, label, input, agents, agentValue))
      .child(label("TIMEOUT (MINUTES)")).child(input("f-timeout", f.timeout))
      .when(f.kind !== "command" && f.target !== "bot" && f.target !== "worker", (el) => el.child(label("MCP CONFIG")).child(input("f-mcp", f.mcp)))
      .child(div().id("f-result").pt(8).text_size(12)
        .when(Boolean(res?.problem), (el) => el.text_color(t.ansi1).child(res.problem))
        .when(Boolean(res && !res.problem && res.next), (el) => el.text_color(t.muted)
          .child(`Next: ${res.next.map((n) => until(n)).join(", ")}`)))
      .child(h_flex().pt(8).gap(8).justify_end()
        .child(this.button("f-cancel", "Cancel", t, (cx) => { this.view = f.original ? { kind: "detail", name: f.original } : { kind: "list" }; this.form = null; cx.notify(); }))
        .child(this.button("f-save", "Save", t, (cx) => this.save(cx), { solid: true })));
  }

  // #938: the command kind's fields. The scheduler starts the program itself, as the user it
  // runs as: no shell reads the line (words split on spaces, quotes keep theirs), no space opens.
  commandForm(el, f, t, label, input) {
    const note = (id, text) => div().id(id).text_size(11).text_color(t.muted).child(text);
    return el
      .child(label("COMMAND")).child(input("f-command", f.command))
      .child(note("f-command-note", "The program and its arguments. No shell reads this line: for pipes or &&, run a script. "
        + "It runs as you, with your network and files. Exit 0 is done; any other exit, or the timeout, is failed."))
      .child(label("WORKING FOLDER")).child(h_flex().gap(6).child(div().flex_1().child(input("f-cwd", f.cwd)))
        .child(this.button("f-cwd-pick", "Choose…", t, (cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Folder the command runs in" });
          if (dir) { f.cwd.set_value(tilde(dir)); this.preview(cx); }
          cx.notify();
        }), { h: 30 })))
      .child(label("ENV")).child(input("f-env", f.env))
      .child(label("TELL A BOT")).child(input("f-notify", f.notify))
      .child(note("f-notify-note", "The run's one line (its last line of output, or why it failed) is sent to this bot with hc send."));
  }

  // #498: a target's fields. The bot comes from the project's roster, never typed as an address;
  // its launch is the bot's own, so there is no agent, model or permission choice here.
  targetForm(el, f, t, label) {
    const note = (id, text) => div().id(id).text_size(11).text_color(t.muted).child(text);
    const bots = f.bots;
    const nameOf = (id) => bots?.find((b) => b?.id === id)?.name ?? null;
    const options = (bots ?? []).filter((b) => b && !b.planned).map((b) => [b.id, b.name || b.id]);
    if (f.bot && !options.some(([id]) => id === f.bot)) options.push([f.bot, nameOf(f.bot) || f.bot, true]);
    const why = f.target === "kept" ? targetWarning(f.savedTarget, bots)
      : f.bot ? targetWarning(`${f.target}:${f.bot}`, bots) : null;
    return el
      .child(label("BOT"))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(bots) && (bots.length > 0 || f.bot), (el2) => el2
          .child(this.pills("f-bot", options, f.bot, t, (v, cx) => { f.bot = v; this.preview(cx); cx.notify(); })))
        .child(this.button("f-bots-reload", "Reload", t, (cx) => this.loadBotsForForm(f, cx, { fresh: true }), { h: 22, px: 6 })))
      .when(bots === null, (el2) => el2.child(note("f-bots-note", f.botsNote || "Looking up the project's bots…")))
      .when(Array.isArray(bots) && bots.length === 0, (el2) => el2.child(note("f-bots-empty",
        "This project's .herdr/bots.json names no bots. A target needs one.")))
      .when(f.target === "bot", (el2) => el2
        .child(label("WHEN THE BOT IS BUSY"))
        .child(this.pills("f-busy", [["queue", "Queue it"], ["skip", "Skip this run"]], f.busy, t, (v, cx) => {
          f.busy = v; this.preview(cx); cx.notify();
        })))
      .child(note("f-target-note", f.target === "bot"
        ? "The prompt goes into the bot's own terminal with hc send; a stopped bot is started first. "
          + "The bot's own launch and permissions apply."
        : "A worker starts under the bot, takes the prompt in a fresh worktree, and is ended when the run finishes. "
          + "The bot's own worker launch and permissions apply."))
      .when(Boolean(why), (el2) => el2.child(div().id("f-target-warn").pt(2).text_size(11).text_color(t.blocked).child(why)));
  }

  // Ask the project's roster again for a target form (the pills ask on pick; Reload forces it).
  loadBotsForForm(f, cx, { fresh = false } = {}) {
    if (f.target !== "bot" && f.target !== "worker") return;
    cx.spawn(async (cx) => {
      const r = await this.loadBots(f.repo.value(), { fresh });
      if (this.form !== f) return;
      f.bots = r.list; f.botsNote = r.note;
      cx.notify();
    });
  }

  // The agent kind's fields: where it runs, the agent, its permissions and its prompt. A target
  // replaces all of that with the bot's own launch; a kept target shows only the project and the
  // prompt, because this build cannot edit one.
  agentForm(el, f, t, label, input, agents, agentValue) {
    const targeted = f.target === "bot" || f.target === "worker";
    const held = f.target === "kept";
    const repoRow = h_flex().gap(6).child(div().flex_1().child(input("f-repo", f.repo)))
      .child(this.button("f-pick", "Choose…", t, (cx) => cx.spawn(async (cx) => {
        const dir = await pickFolder({ prompt: "Repository for this automation" });
        if (dir) { f.repo.set_value(tilde(dir)); this.preview(cx); }
        cx.notify();
      }), { h: 30 }));
    if (held) return this.promptForm(el.child(label("PROJECT")).child(repoRow), f, t, label);
    if (targeted) return this.promptForm(this.targetForm(el.child(label("PROJECT")).child(repoRow), f, t, label), f, t, label);
    const closeObject = f.workspace === "existing" ? "the run's tab" : "the space";
    const canClose = this.canClose(f.workspace);
    return this.promptForm(el
      .child(label("REPO")).child(repoRow)
      .child(label("RUNS IN")).child(this.pills("f-ws", WORKSPACES, f.workspace, t, (v, cx) => { f.workspace = v; this.preview(cx); cx.notify(); }))
      .when(f.workspace === "existing", (el) => el.child(this.pills("f-space",
        spaces().filter((s) => !s.machine).map((s) => [s.id, s.name]), f.workspace_id, t,
        (v, cx) => { f.workspace_id = v; this.preview(cx); cx.notify(); })))
      .child(label("AFTER A RUN"))
      .when(canClose, (el) => el.child(h_flex().gap(8).items_center()
        .child(this.switch_("f-close", f.close, t, (cx) => { f.close = !f.close; this.preview(cx); cx.notify(); }))
        .child(div().text_size(12).child(`Close ${closeObject} after a successful run`))))
      .when(!canClose, (el) => el.child(div().id("f-close-upstream").text_size(11).text_color(t.muted)
        .child(`Our scheduler build (${SCHEDULER.version}) is needed to close ${closeObject} after a run.`)))
      .child(label("AGENT")).child(this.pills("f-agent", agents, agentValue, t, (v, cx) => {
        if (v.startsWith("template:")) { f.template = v.slice(9); f.agent = ""; } else { f.template = ""; f.agent = v; }
        // An existing entry: its saved agent gets its saved args back; any other lands on Agent
        // default, never on Automatic (nothing is migrated; #505).
        if (f.original) f.mode = this.sameAgent(f) ? "kept" : "default";
        this.preview(cx); cx.notify();
      }))
      .when(!f.template, (el) => el.child(label("MODEL")).child(input("f-model", f.model)))
      .child(label("PERMISSIONS")).child(this.modeForm(f, t, input)), f, t, label);
  }

  // The prompt is the same field for every agent-kind run; the target and held forms append it
  // last so no builder fragment is built twice.
  promptForm(el, f, t, label) {
    return el.child(label("PROMPT")).child(div().id("f-prompt").p(8).rounded(7).border_1().border_color(t.input)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(f.prompt).w_full().text_size(12)))
      .when(Boolean(f.warning), (el2) => el2.child(div().id("f-address").pt(2).text_size(11).text_color(t.blocked).child(f.warning)));
  }

}
