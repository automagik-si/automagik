// am-quota: the Accounts panel, and the one thing it changes: which account the local clients use.
//
// Reads: the proxy's own endpoints (via ./proxy.js), the management key from cliproxyapi's key
// file or $CLIPROXY_MGMT_KEY, the base URL and optional display name from <app home>/cliproxy.json,
// and what this panel installed from <app home>/data/am-quota/active.json. ./view.js turns that
// into what each tool's card says; this file draws it.
// Writes after a person presses Switch, Use or approves a plan: Codex's local credential file, through ./switch.js,
// with a backup, 0600, temp + atomic rename, and never a token in a log, a notify, shared state or
// an error message. Claude is never installed from the proxy, and nothing here reads or writes a
// Claude Keychain item or credential (#453, docs/local-logins.md): the Claude card lists the logins
// signed in on this Mac (./logins.js), and its Use, Add login and Remove login write only
// <app home>/claude-logins.json through am accounts set-login where present. Apply uses the same
// command on linked machines. New Claude launches read that record. After a switch, Restart runs
// `automagik-herdr restart <bot>` for the bots still on the old account or login, once the person
// confirms.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, hc, theme, appHome, home, readTextFile, window as appWindow, writeTextFile } from "herdr";
import { client, QuotaSampler } from "./proxy.js";
import { credentialTarget, tokenIdentity, TARGETS } from "./translate.js";
import { install } from "./switch.js";
import { claim, release } from "./lock.js";
import { payloadDir, sweepScript } from "./write.js";
import { TOOLS, instanceName, loginsView, offLogin, openUrl, runningBots, staleBots, toolView, who } from "./view.js";
import { DEFAULT_LOGIN, PROBE_MS, bounded, loginName, matchReal, nextSlot, paneLogin, presentVars, probeLogin, readRecord, signedOut, typed, writeRecord } from "./logins.js";

import { FLEET_FILE, parseFleet, accountFingerprint, bytesOf, versionOkay } from "./accountsRows.js";
import { fleetRows, members, restartArgs, frozen, sameList, readFleetAnswer, restartWords } from "./fleet.js";
import { setLoginArgs, setLoginResult, SIDEBAR_MARKERS, SIDEBAR_VERSION, snapshotOf, WRITER_FILE, WRITER_MAX_BYTES } from "./setLogin.js";
import { idDigest, isClaudeKey, isCodexKey, isFingerprint, isHome, linkedDue, LOCAL, localDue, LOCAL_START_MS, newest, own,
  parsePlan, PENDING_WHY, PLAN_FILE, proxyId, REQUESTS_DIR, RETRY_EVERY_MS, snapshotOf as planSnapshot } from "./accountsPlanRecord.js";
import { planRows } from "./accountsPlanRows.js";
import { slotStates } from "./loginProbe.js";
import { sha256Hex } from "./sha256.js";
import { usable } from "./policy.js";
import { localResult, planArgs, planBlock, planError, refusalWords } from "./plan.js";

const POLL = 60000;
/** How often the installed credential's identity is re-read. It is a token-bearing item; the
 *  badge does not need it sixty times an hour. */
const IDENTITY_EVERY = 300000;
const KEY_FILE = "~/.config/cliproxyapi/mgmt.key";
const KEY_ENV = "CLIPROXY_MGMT_KEY";
const STATE = "am-quota/active.json";
/** How long the Restart button stays armed for its confirming second click. */
const ARMED = 5000;
// Waiting for a busy bot (#413): one hc wait at a time, each at most IDLE_WAIT_S (hc's own
// --timeout), through exec with IDLE_EXEC_MS, under Herdr's 10 min exec cap (hc() stops at 30 s, and
// a Herdr with no exec timeout cuts each wait at 30 s). IDLE_WAITS waits at most, plus one for each
// helper, and never past IDLE_WAITS * IDLE_WAIT_S in all. What it waited is said, never promised.
const IDLE_WAIT_S = 450;
const IDLE_EXEC_MS = 480_000;
const IDLE_WAITS = 4;
// A restart runs in an hc terminal of its own (#433), not through exec: Herdr ends what exec runs at
// its limit (30 s on a Herdr that ignores exec's timeout), which can be part-way through a restart.
// The panel follows that terminal to its end and reads the CLI's answer from the files it leaves.
// Each look: the answer's files, then hc get of the terminal, then one hc wait of RUN_WAIT_S (under
// 30 s, so it ends by itself on any Herdr). The panel follows a restart RUN_FOLLOW_MS, plus
// RUN_HELPER_MS per helper on a --tree one (65 s for the bot at worst, then 40 s per helper, one at
// a time: its old pane's end 10 s, its new one 30 s), then says it still runs and where.
const RUN_WAIT_S = 25;
const RUN_WAIT_EXEC_MS = 28_000;
const RUN_FOLLOW_MS = 300_000;
const RUN_HELPER_MS = 40_000;
// A wait that answers at once (hc refusing it, say) is followed by this pause, so a look is never a busy loop.
const RUN_PAUSE_MS = 5_000;
/** The label of a restart's terminal: the bot's id, so a second press finds a run still going. */
const RUN_LABEL = "am-quota.restart";
const FLEET_LABEL = "am-quota.accounts";
const FLEET_FOLLOW_MS = 120_000;
const APPLY_FOLLOW_MS = 660_000;
const MACHINES_MS = 10_000;
/** Where a restart's terminal leaves the CLI's stdout, stderr and exit code, under the app's data. */
const RUNS = "data/am-quota/runs";
const accountsRuns = new Set();
const opaqueId = () => globalThis.crypto?.randomUUID?.().replaceAll("-", "")
  ?? Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")).join("");
const appDir = () => appHome().replace(/\/+$/, "");
// The restart terminal's program: `sh -c RUN_SCRIPT sh <out> <err> <code> <the CLI's argv…>`. The
// paths and the argv are its arguments, never part of the script. Files older than a day go first.
// The exit code is written last, through a rename, so a code read means the other two are whole.
// HC_TERMINAL_ID is unset so the CLI runs as it does under exec: not inside a pane of its own. The
// folder is made before (PREPARE_SCRIPT), so a folder that can't be made is said: nothing ran.
const RUN_SCRIPT = [
  'out=$1 err=$2 code=$3; shift 3',
  'find "${out%/*}" -maxdepth 1 -type f -mmin +1440 -exec rm -f {} + 2>/dev/null',
  'unset HC_TERMINAL_ID',
  '"$@" >"$out" 2>"$err"; c=$?',
  'cat "$err" >&2',
  'printf "%s\\n" "$c" >"$code.tmp" && mv -f "$code.tmp" "$code"',
].join("\n");
// Keep the reply private, discard stderr and remove only files abandoned by older runs.
const PRIVATE_RUN_SCRIPT = [
  'umask 077',
  'out=$1 code=$2 slug=$3; shift 3',
  'find "${out%/*}" -maxdepth 1 -type f -name "$slug-*" -mmin +1440 -exec rm -f -- {} + 2>/dev/null',
  'unset HC_TERMINAL_ID',
  '"$@" >"$out" 2>/dev/null; c=$?',
  '[ -f "$out" ] && printf "%s\\n" "$c" >"$code.tmp" && mv -f "$code.tmp" "$code"',
].join("\n");
// Run through exec before each restart, in Herdr's environment: `sh -c PREPARE_SCRIPT sh <runs
// folder> <names…>` makes the folder (exit 3 when it can't) and prints NAME=value for each name set.
const PREPARE_SCRIPT = 'mkdir -p -- "$1" || exit 3; shift; for n; do v=$(printenv -- "$n") && printf "%s=%s\\n" "$n" "$v"; done; exit 0';
// What the CLI reads from its environment: PATH (its node through run.sh, hc, an agent's program and
// the PATH a new pane gets), HOME, NVM_DIR (run.sh's nvm node), VIRTUAL_ENV (left off a pane's PATH)
// and HERMES_HOME. A restart's terminal starts in herdr-core's environment, not Herdr's, so these are
// passed as Herdr has them (one Herdr hasn't set is unset): the CLI runs as it did under exec.
const CLI_ENV = ["PATH", "HOME", "NVM_DIR", "VIRTUAL_ENV", "HERMES_HOME"];
// A --tree restart: the panel has waited already, so the CLI's own wait for a turn (10 min unless
// told) is only a guard against a race.
const TREE_TURN_WAIT_MS = 10_000;
/** The bot CLI, run the way the sidebar runs it (am-sidebar/launch.js runCli). */
const SIDEBAR = "am-sidebar";

const expand = (p) => (p.startsWith("~/") ? `${home()}${p.slice(1)}` : p);
const slug = (s) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
const wake = (context) => context.notify();
const message = (err) => String(err?.message ?? err);
const QUOTED = /"[^"]*"/g;
/** A sentence up to the clause that names a flag ("Let it finish, or pass …": "Let it finish."). */
const beforeFlag = (line) => {
  const at = line.search(/(^|[\s(])--[a-z]/);
  if (at < 0) return line;
  const comma = line.slice(0, at).lastIndexOf(", ");
  return comma > 0 ? `${line.slice(0, comma)}.` : "";
};
/**
 * CLI text as the panel may show it (#413): no clause that names a flag, because the panel never
 * offers one as a way out. What an agent said is in double quotes, kept as it said it.
 */
export function plain(text) {
  const quotes = [];
  const masked = String(text ?? "").replace(QUOTED, (q) => `\u0000${quotes.push(q) - 1}\u0000`);
  const kept = masked.split(/(?<=[.!?])\s+/).map(beforeFlag).filter(Boolean).join(" ");
  return kept.replace(/\u0000(\d+)\u0000/g, (_m, i) => quotes[Number(i)]);
}
/** A restart's note for the panel: its resume words ("resume --last") as words, not a flag. */
const noteText = (note) => note.replace(/(resume )?--[a-z][a-z-]*/g, "a resume");
/**
 * Why a bot CLI run failed, as cli() gives it (#413): the --json \`error\` when it printed one (a
 * restart whose new pane exited names its agent's own last line there), else stderr's last line.
 * The refusal is the CLI's last word: warnings come before it, so never its first line.
 */
const refusal = (r) => plain(typeof r?.out?.error === "string" && r.out.error.trim()
  ? r.out.error.trim() : String(r?.err ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "");
/**
 * The bot CLI's argv with --json, run the way the sidebar runs it (am-sidebar/launch.js runCli), or
 * null when the sidebar mod (which carries the CLI) is not installed. `env`: more KEY=value words.
 */
async function cliArgv(args, env = [], unset = []) {
  const dir = appHome().replace(/\/+$/, "");
  const runner = `${dir}/mods/${SIDEBAR}/bin/run.sh`;
  const there = await readTextFile(runner).then((t) => t !== null && t !== undefined, () => false);
  if (!there) return null;
  return ["env", ...unset.flatMap((n) => ["-u", n]), `HERDR_APP_HOME=${dir}`, ...env, "sh", runner, `${dir}/mods/${SIDEBAR}/bin/automagik-herdr.mjs`, ...args, "--json"];
}
async function writerStatus(dir) {
  const markers = await Promise.all(SIDEBAR_MARKERS.map(async (file) => {
    try {
      const text = await readTextFile(`${dir}/${file}`);
      if (text == null) return "absent";
      if (typeof text === "string" && bytesOf(text) <= WRITER_MAX_BYTES) return "present";
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "absent";
    }
    return "unknown";
  }));
  return markers.includes("unknown") ? "unknown" : markers.includes("absent") ? "absent" : "present";
}

async function accountsArgv(args, { write = false, status } = {}) {
  const dir = appHome().replace(/\/+$/, "");
  const bin = `${dir}/mods/${SIDEBAR}/bin`;
  const runner = `${bin}/run.sh`, program = `${bin}/accounts.mjs`;
  const found = write ? (status ?? await writerStatus(dir)) === "present" :
    (await Promise.all([runner, program].map((path) => readTextFile(path).catch(() => null)))).every((text) => text != null);
  return found ? ["env", `HERDR_APP_HOME=${dir}`, "sh", runner, program, ...args] : null;
}

/** What hc said when it failed, in plain words: its JSON error's message, else its last line, never a flag. */
function hcSaid(r) {
  const text = String(r?.stderr || r?.stdout || "").trim();
  let said = text.split("\n").at(-1) ?? "";
  try {
    const e = JSON.parse(text)?.error;
    if (typeof e?.message === "string" && e.message.trim()) said = e.message.trim();
    else if (typeof e?.kind === "string") said = e.kind.replace(/_/g, " ");
  } catch {}
  // Up to the first clause that names a flag ("…; pass --start to start it"), then plain().
  const clauses = said.replace(/^hc: /, "").split(/(?<=[;,])\s+/);
  const flagged = clauses.findIndex((c) => /(^|[\s(])--[a-z]/.test(c));
  const kept = flagged < 0 ? clauses : clauses.slice(0, flagged);
  return plain(kept.join(" ").replace(/[;,.]\s*$/, "")).replace(/[.]$/, "");
}
/** A CLI run's { code, out: its --json stdout or null, err: stderr without the CLI's name }. */
function cliAnswer(code, stdout, stderr) {
  let out = null;
  try {
    out = JSON.parse(stdout ?? "");
  } catch {}
  return { code, out, err: String(stderr ?? "").replace(/^(?:am|automagik-herdr): /gm, "").trim() };
}
/** Why a restart's terminal gave no answer; `partway`: it may have stopped part-way. */
function runError(why, { partway = false, code } = {}) {
  return Object.assign(new Error(why), { partway, ...(code ? { code } : {}) });
}
/** The live rows of `hc ls --json`'s stdout (a list, or { terminals }), each with an address. */
function liveRows(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(rows) ? rows : rows?.terminals ?? [];
  return list.filter((r) => r?.address && (r.state === undefined || r.state === "live"));
}
/** "2 min", from ms: what a wait really took. */
const waited = (ms) => (ms < 60000 ? "under a minute" : `${Math.round(ms / 60000)} min`);
/** The platform the panel runs on, for the command that opens a URL (`open` on macOS). */
const platform = () => {
  try {
    return appWindow()?.platform ?? "macos";
  } catch {
    return "macos";
  }
};
/**
 * Values of the named environment variables (the shell's real environment): never logged. An unset
 * variable is not a failure (the script exits 0); a read that could not run rejects.
 */
const readEnv = async (names) => {
  const out = {};
  await Promise.all(names.map(async (name) => {
    const r = await exec("sh", ["-c", 'v=$(printenv -- "$1") || exit 0; printf %s "$v"', "sh", name]);
    if (r?.code !== 0) throw new Error(`could not read ${name}`);
    const v = String(r.stdout ?? "").trim();
    if (v) out[name] = v;
  }));
  return out;
};
/**
 * What the record this panel keeps says about Codex's login on the Mac. The record is only a
 * claim: an open session can refresh the *old* account back into the file, so it is checked
 * against the installed credential. An unreadable file keeps the claim, because a guess is worse
 * than the record.
 */
export const badgeFor = (record, installed) => {
  if (!record) return null;
  if (!record.fingerprint || !installed?.known) return { text: "in use" };
  if (!installed.fingerprint) return { text: "no longer installed" };
  return installed.fingerprint === record.fingerprint ? { text: "in use" } : { text: "changed outside this panel" };
};

/**
 * `active.json`, tolerant of its older shapes: a bare name is a record, and a record left by the
 * saved Claude logins this panel no longer keeps (`saved:<name>`) is no proxy account's. A
 * `claude` entry (the proxy login an older version installed) is ignored, and so dropped at the
 * next write: Claude is never installed from the proxy (#453).
 */
export const records = (raw) => {
  const out = {};
  for (const [provider, value] of Object.entries(raw ?? {})) {
    if (provider === "claude") continue;
    const name = typeof value === "string" ? value : typeof value?.name === "string" ? value.name : null;
    if (!name || name.startsWith("saved:")) continue;
    out[provider] = { name, fingerprint: typeof value?.fingerprint === "string" ? value.fingerprint : null };
  }
  return out;
};

export default class AmQuota extends View {
  init(_given, cx) {
    this.tool = "claude";   // the tool the switch at the top shows
    this.accounts = null;   // the proxy's accounts, sampled for a burn rate; null before a read
    this.badges = {};       // provider → badgeFor(...) of the last read
    this.config = null;     // cliproxy.json: { url, name? }
    this.error = null;      // the proxy read's own error
    this.setup = null;      // what is missing before there is anything to read
    this.switchError = null; // a failed switch, kept until the next one
    this.busy = null;       // the running switch, or null
    this.active = {};       // provider → { name, fingerprint } this panel installed
    this.identities = {};   // provider → { at, value }: the last read of what is installed
    this.env = {};          // Codex's environment (CODEX_HOME)
    this.quotaError = null;
    this.switched = {};     // provider → the last switch: { at, from, to, look, result }
    this.armed = null;      // "restart:<provider>" waiting for its second click
    this.restarting = {};   // provider → true while its bots restart (lock.claim reads it)
    this.logins = null;     // Claude's logins on this Mac: { record, probes, vars, at } (#453)
    this.fleet = { record: null, bots: {}, members: null, at: 0, running: false, error: null, needsSidebar: false };
    this.linked = {};
    this.plan = { state: "absent", plan: null };
    this.preview = null;
    this.owner = opaqueId();
    this.applying = false;
    this.applyAt = null;
    this.applyingLocal = {};
    this.localAt = {};      // tool → when this panel last read this Mac for the plan
    this.loginNote = null;  // the last Add or Remove that worked
    this.seen = 0;          // last render; a hidden copy stops polling
    this.hidden = false;
    this.sampler = new QuotaSampler();
    this.writerVersion = readTextFile(`${appHome().replace(/\/+$/, "")}/${SIDEBAR_VERSION}`)
      .then((text) => text?.split(/\r?\n/, 1)[0], () => null);
    cx.timer.every(POLL, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      // Which account this panel installed, read once — before the first proxy read, so the
      // first verdict already knows what is in use.
      try {
        const raw = await readTextFile(`${appHome()}/data/${STATE}`);
        if (raw) this.active = records(JSON.parse(raw));
      } catch {}
      await exec("sh", ["-c", sweepScript(), "sh", payloadDir(appHome())]).catch(() => {});
      this.reload(cx);
    });
  }

  async settings() {
    // The app's environment does not change while it runs: read it once, not once a minute. A
    // failed read is not cached (the next call tries again) and is reported as `envKnown: false`.
    let env = {};
    let envKnown = true;
    try {
      env = await (this.envVars ??= readEnv([KEY_ENV, "CODEX_HOME"]));
    } catch {
      this.envVars = null;
      envKnown = false;
    }
    let config = null;
    try {
      const parsed = JSON.parse((await readTextFile(`${appHome()}/cliproxy.json`)) ?? "null");
      if (parsed && typeof parsed.url === "string") config = { url: parsed.url, name: parsed.name ?? null };
    } catch {}
    let key = env[KEY_ENV] || null;
    if (!key) {
      try {
        key = ((await readTextFile(expand(KEY_FILE))) ?? "").trim() || null;
      } catch {}
    }
    const clients = { CODEX_HOME: env.CODEX_HOME };
    return { config, key, envKnown, env: clients };
  }

  /** The timer's body: a hidden panel does not need a fresh read (its timer keeps running). */
  tick(cx) {
    if (this.hidden) return;
    if (this.seen && Date.now() - this.seen > POLL * 2) return;
    this.reload(cx);
  }

  reload(cx) {
    const seq = (this.seq ?? 0) + 1;
    this.seq = seq;
    this.readLogins(cx, { force: !this.logins || this.forceLogins });
    this.readFleet(cx, { force: !this.fleet.at || this.forceLogins });
    cx.spawn(() => this.confirmWriter());
    this.forceLogins = false;
    cx.spawn(async (cx) => {   // one read of the proxy; the newest wins
      const { config, key, env, envKnown } = await this.settings();
      if (seq !== this.seq) return;
      this.env = env;
      this.config = config;
      this.fleetEnvReady = envKnown;
      if (envKnown && this.hasLinkedRows()) void this.codexRef(env).then(() => wake(cx));
      try {
        this.setup = !config ? "proxy" : !key ? "key" : null;
        if (this.setup) {
          this.accounts = null;
          this.error = null;
          return;
        }
        const api = client({ base: config.url, key, fetch });
        const { accounts, quotaError } = await api.accounts();
        if (seq !== this.seq) return;   // a newer read owns the panel, and the samples
        const sampled = this.sampler.read(accounts, { now: Date.now() });
        const badges = {};
        for (const provider of Object.keys(TOOLS)) {
          const installed = await this.installedIdentity(provider, env);
          badges[provider] = badgeFor(this.active[provider] ?? null, installed);
        }
        if (seq !== this.seq) return;
        this.api = api;
        this.apiProxy = proxyId(config.url);
        this.accounts = sampled;
        this.badges = badges;
        this.quotaError = quotaError;
        this.error = null;
      } catch (err) {
        if (seq !== this.seq) return;
        this.error = message(err);
        this.accounts = null;
      } finally {
        if (seq === this.seq) {
          wake(cx);
          await this.reloadPlan(cx, seq);
        }
      }
    });
  }

  // A running panel confirms the version it loaded with, even if newer files are on disk.
  async confirmWriter() {
    const dir = appHome().replace(/\/+$/, "");
    const path = `${dir}/${WRITER_FILE}`;
    try {
      const version = await this.writerVersion;
      if (!versionOkay(version) || await writerStatus(dir) !== "present") return;
      const before = await readTextFile(path);
      let record;
      try { record = JSON.parse(before); } catch { /* Replace a record this panel can't read. */ }
      if (record?.v === 1 && record.setLogin === true && record.version === version && Object.keys(record).length === 3) return;
      const made = await exec("sh", ["-c", 'umask 077; mkdir -p -- "$1"', "sh", path.slice(0, path.lastIndexOf("/"))]);
      if (made?.code !== 0) return;
      const text = `${JSON.stringify({ v: 1, setLogin: true, version })}\n`;
      await writeTextFile(path, text, before ?? null);
      const mode = await exec("chmod", ["600", path]).catch(() => null);
      if (mode?.code !== 0 && await readTextFile(path) === text) await exec("rm", ["-f", "--", path]);
    } catch { /* Local edits still take the login lock when the writer is present. */ }
  }

  hasLinkedRows() {
    return Boolean(this.fleet.members?.length || Object.keys(this.fleet.record?.machines ?? {}).some((core) => core !== "local"));
  }

  async readPlan() {
    const id = (this.planRead ?? 0) + 1;
    this.planRead = id;
    const text = await readTextFile(`${appDir()}/${PLAN_FILE}`).catch(() => "");
    if (id === this.planRead) this.plan = parsePlan(text ?? null);
    return this.plan;
  }

  async planRequest(body) {
    const id = opaqueId();
    const folder = `${appDir()}/${REQUESTS_DIR}`;
    const path = `${folder}/${id}.json`;
    let created = false;
    try {
      const dir = await exec("sh", ["-c", 'umask 077; mkdir -p -- "$1" && chmod 700 -- "$1"', "sh", folder]);
      if (dir?.code !== 0) return null;
      await writeTextFile(path, `${JSON.stringify({ v: 1, ...body })}\n`, null);
      created = true;
      if ((await exec("chmod", ["600", path]))?.code === 0) return id;
    } catch { /* The panel shows a fixed refusal. */ }
    if (created) await exec("rm", ["-f", "--", path]).catch(() => {});
    return null;
  }

  async planCommand(op, fields, body) {
    const id = body ? await this.planRequest(body) : fields?.id;
    if (body && !id) return { error: "failed" };
    const mayHaveWritten = op === "write-local" || op === "install-local";
    try {
      const argv = await accountsArgv(planArgs(op, { ...fields, id }), { write: true });
      const result = argv && await exec(argv[0], argv.slice(1));
      const out = JSON.parse(result?.stdout ?? "null");
      if (result?.code === 0 && (mayHaveWritten ? out?.ok === true : out)) return out;
      if (op === "install-local" && (result?.code !== 1
        || !["stale", "changed", "busy", "no-plan", "newer-plan", "no-home", "failed", "off", "stopped"].includes(out?.error))) {
        return { error: "lost" };
      }
      if (mayHaveWritten && !out?.error) return { error: "lost" };
      return { error: planError(out?.error) };
    } catch { return { error: mayHaveWritten ? "lost" : "failed" }; }
    finally {
      if (body) await exec("rm", ["-f", "--", `${appDir()}/${REQUESTS_DIR}/${id}.json`]).catch(() => {});
    }
  }

  codexAccounts() {
    return (this.accounts ?? []).filter((account) => account.provider === "codex" && isCodexKey(account.name));
  }

  async readPlanCodex() {
    try {
      const env = await readEnv(["CODEX_HOME"]);
      const file = credentialTarget("codex", { home: home(), env }).file;
      const dir = file.slice(0, file.lastIndexOf("/"));
      if (!isHome(dir)) return null;
      const [text, config] = await Promise.all([
        readTextFile(file),
        readTextFile(`${appDir()}/cliproxy.json`).then((text) => JSON.parse(text ?? "null"), () => null).catch(() => null),
      ]);
      return { env, read: { at: new Date().toISOString(), home: dir, account: accountFingerprint(text),
        generation: text == null ? null : sha256Hex(text), proxy: proxyId(config?.url) } };
    } catch { return null; }
  }

  async readPlanActive() {
    try {
      const active = records(JSON.parse(await readTextFile(`${appDir()}/data/${STATE}`))).codex;
      return isCodexKey(active?.name) && isFingerprint(active?.fingerprint)
        ? { name: active.name, fingerprint: active.fingerprint } : null;
    } catch { return null; }
  }

  previewPlan(request, cx) {
    if (this.planEditing) return;
    this.planEditing = true;
    this.planError = null;
    cx.spawn(async (cx) => {
      try {
        const { kind, tool } = request;
        const body = { ...request };
        if (kind === "manage" || tool === "codex") {
          const current = await this.readPlanCodex();
          const { at, ...observation } = current?.read ?? {};
          body.codexLocal = current ? observation : null;
          const accounts = this.codexAccounts();
          body.codexUsable = accounts.filter(usable).map(({ name }) => name);
          if (kind === "manage") body.codexAccounts = accounts.map(({ name }) => name);
          body.active = await this.readPlanActive();
        }
        if ((kind === "manage" || tool === "claude") && kind !== "second-login") {
          const local = await this.probeRound();
          if (local) body.claudeLocal = local;
        }
        const reply = await this.planCommand("request", {}, body);
        if (reply.kind !== "accounts.preview" || !/^[0-9a-f]{32}$/.test(reply.id) || !Number.isSafeInteger(reply.rev)
          || ![reply.moves, reply.flags, reply.changes].every(Array.isArray)) {
          this.planError = reply.error ?? "failed";
          return;
        }
        this.preview = { ...reply, request };
      } finally {
        this.planEditing = false;
        wake(cx);
      }
    });
  }

  commitPlan(cx, { preview = this.preview, confirmForget = false } = {}) {
    if (!preview || this.preview !== preview || this.planEditing) return;
    const linked = preview.moves.some(({ machine }) => machine !== LOCAL);
    if (linked && (this.fleet.running || accountsRuns.has(appDir()))) {
      this.planError = "busy";
      return wake(cx);
    }
    this.planEditing = true;
    this.planError = null;
    cx.spawn(async (cx) => {
      try {
        const reply = await this.planCommand("commit", { id: preview.id, rev: preview.rev, confirmForget });
        if (!reply.ok) {
          this.planError = reply.error ?? "failed";
          if (["expired", "stale", "missing", "newer-plan"].includes(this.planError)) this.preview = null;
          await this.readPlan();
          return;
        }
        this.preview = null;
        await this.readPlan();
        await this.maybeLocal(cx, { force: true });
        if (linked) await this.startApply(cx);
      } finally {
        this.planEditing = false;
        wake(cx);
      }
    });
  }

  async reloadPlan(cx, seq) {
    await this.readPlan();
    if (seq !== this.seq || this.plan.state !== "ok") return;
    await this.maybeLocal(cx);
    if (seq === this.seq) this.maybeRetry(cx);
    wake(cx);
  }

  maybeRetry(cx) {
    const now = Date.now();
    if (this.planEditing || this.applying || this.fleet.running || accountsRuns.has(appDir())
      || this.applyAt !== null && now - this.applyAt < RETRY_EVERY_MS) return;
    if (linkedDue(this.plan.plan, { now, retry: true, fleet: this.fleet.record, members: this.fleet.members }).length) {
      cx.spawn((cx) => this.startApply(cx, { retry: true }));
    }
  }

  async startApply(cx, { retry = false } = {}) {
    if (this.applying) return;
    if (this.fleet.running || accountsRuns.has(appDir())) {
      if (!retry) this.planError = "busy";
      return;
    }
    this.applying = true;
    this.applyAt = Date.now();
    try {
      const reply = await this.cliRun(retry ? ["apply", "--retry"] : ["apply"], {
        label: "apply", runLabel: FLEET_LABEL, followMs: APPLY_FOLLOW_MS, privateRun: true,
      });
      this.planError = reply?.code === 0 && reply.out?.kind === "accounts.apply" ? null : planError(reply?.out?.error);
    } catch (err) {
      this.planError = ["apply-running", "fleet-running"].includes(err?.code) ? "busy" : "failed";
    } finally {
      this.applying = false;
      await this.readPlan();
      this.readFleet(cx, { force: true });
      wake(cx);
    }
  }

  // This Mac's part of the plan. A fresh assignment or an open attempt is acted on at once. A
  // recorded refusal is tried again at most every five minutes, and a done member is checked for
  // a change at most as often as the installed identity is read, or after a login round or a
  // switch here. A plan with no local member reads nothing.
  async maybeLocal(cx, { force = false, tools = ["claude", "codex"], round } = {}) {
    for (const tool of tools) {
      const plan = this.plan.plan;
      if (!plan || this.plan.state !== "ok") return;
      if (this.busy || this.applyingLocal[tool]) continue;
      const progress = own(plan[tool]?.progress, LOCAL);
      if (!progress) continue;
      const now = Date.now();
      const due = localDue(plan, tool, now, this.owner);
      if (due === "wait" || !due && progress.state !== "done") continue;
      const urgent = due === "read-back" || due === "apply" && (progress.why === null || progress.why === "lost");
      const fresh = force || round !== undefined || now - (this.localAt[tool] ?? 0) >= (due ? RETRY_EVERY_MS : IDENTITY_EVERY);
      if (!urgent && !fresh) continue;
      this.localAt[tool] = now;
      this.applyingLocal[tool] = true;
      try {
        await this.applyLocal(plan, tool, due, cx, round);
      } finally {
        this.applyingLocal[tool] = false;
      }
    }
  }

  async applyLocal(plan, tool, due, cx, round) {
    const section = plan[tool];
    const progress = own(section.progress, LOCAL);
    const assign = own(section.assign, LOCAL);
    const claude = tool === "claude";
    const current = claude ? null : await this.readPlanCodex();
    const read = claude ? round !== undefined ? round : await this.probeRound() : current?.read;
    if (!claude) {
      this.planCodex = read;
      this.planActive = await this.readPlanActive();
    }
    if (!read) return;
    if (progress?.state === "done") {
      const before = own(section.seen, LOCAL);
      const drift = claude ? read.state === "eligible" && read.email !== assign
        : read.account !== null && own(section.seen, LOCAL)?.account !== read.account;
      if (drift || before?.home !== read.home) {
        await this.planCommand("suspend-local", { tool, rev: plan.rev });
        await this.readPlan();
      }
      return;
    }
    if (!due || this.busy || this.restarting[tool]) return;
    if (due === "read-back") {
      const attempt = progress.attempt;
      const outcome = localResult(tool, attempt, read, { recovering: true });
      if (outcome.state === "failed" && attempt.owner !== this.owner) {
        outcome.state = "changed";
        outcome.why = "changed";
      }
      const previous = !claude && this.view("codex").current;
      const result = await this.recordLocal(tool, attempt, outcome);
      if (!claude) await this.finishLocalCodex(attempt, outcome, result, previous, cx);
      return;
    }
    const slot = claude && read.slots.find((item) => item.email === assign && item.state === "eligible");
    const before = claude ? planSnapshot(read) : read.generation;
    const why = claude ? slot ? null : read.slots.some((item) => item.email === assign) ? "not-eligible" : "no-login"
      : !read.proxy ? "proxy-url" : null;
    if (why) {
      const seen = own(section.seen, LOCAL);
      if (progress.why !== why || seen.home !== read.home || (claude
        ? seen.snapshot !== before || Boolean(seen.email && read.email && seen.email !== read.email)
        : seen.generation !== before)) {
        await this.planCommand("fail-local", { tool, rev: plan.rev }, { kind: "outcome", assign, why, read });
        await this.readPlan();
      }
      return;
    }
    if (claim(this, tool, null, `Switching ${TOOLS[tool]} on this Mac…`)) return;
    wake(cx);
    try {
      const start = await this.planCommand("start-local", { tool, owner: this.owner, rev: plan.rev },
        { kind: "evidence", assign, before, home: read.home, eff: claude ? read.email : null,
          effSlot: claude ? read.effective : null, slot: slot?.id ?? null, proxy: claude ? null : read.proxy });
      if (!start.ok) return;
      const attempt = { ...start.attempt, home: start.seen.home,
        before: claude ? start.seen.snapshot : start.seen.generation,
        effDigest: claude ? idDigest(read.effective, read.email ?? "", sha256Hex) : null };
      if (claude) {
        const write = await this.planCommand("write-local", { tool, n: attempt.n, owner: this.owner, snapshot: before });
        if (["stale", "lost", "failed", "off", "stopped"].includes(write.error)) return;
        if (!write.ok) {
          const changed = ["conflict", "slot-changed"].includes(write.error);
          await this.recordLocal(tool, attempt, changed ? { state: "changed", why: "changed", read: null }
            : { state: "failed", why: PENDING_WHY.includes(write.error) ? write.error : "failed", read: null });
          return;
        }
        const back = await this.probeRound();
        if (back) {
          const outcome = localResult(tool, attempt, back, { snapshot: write.snapshot });
          const recorded = await this.recordLocal(tool, attempt, outcome);
          if (recorded.ok && outcome.state === "done" && read.email !== back.email) {
            this.armed = null;
            this.switched.claude = { at: Date.now(), from: read.email, to: back.email, login: back.effective, look: "loading" };
            this.findBots("claude", cx);
          }
        }
      } else {
        await this.applyLocalCodex(attempt, cx);
      }
    } finally {
      release(this);
      await this.readPlan();
      wake(cx);
    }
  }

  async recordLocal(tool, attempt, outcome) {
    const reply = await this.planCommand("record-local", { tool, n: attempt.n, owner: this.owner },
      { kind: "outcome", ...outcome });
    await this.readPlan();
    return reply;
  }

  async applyLocalCodex(attempt, cx) {
    const { home } = attempt;
    const fail = (why) => this.recordLocal("codex", attempt, { state: "failed", why, read: null });
    const changed = () => this.recordLocal("codex", attempt, { state: "changed", why: "changed", read: null });
    const eligible = () => this.codexAccounts().find((account) => account.name === attempt.assign && usable(account));
    const started = () => Date.now() - Date.parse(attempt.at) < LOCAL_START_MS;
    const before = await this.readPlanCodex();
    if (!before) return fail("failed");
    if (before.read.home !== home || before.read.generation !== attempt.before) return changed();
    if (before.read.proxy !== attempt.proxy || this.apiProxy !== attempt.proxy) return fail("proxy-url");
    const account = eligible();
    if (!account || !this.api) return fail("not-eligible");
    if (!started()) return;
    let refused = null, intended;
    const previous = this.view("codex").current;
    const fence = async (body) => {
      const latest = await this.readPlanCodex();
      if (!latest) refused = "failed";
      else if (latest.read.home !== home || latest.read.generation !== attempt.before) refused = "changed";
      else if (latest.read.proxy !== attempt.proxy || this.apiProxy !== attempt.proxy) refused = "proxy-url";
      else if (!eligible()) refused = "not-eligible";
      else if (!accountFingerprint(body)) refused = "no-account-id";
      else if (!started()) refused = "stale";
      if (!refused) {
        intended = sha256Hex(body);
        const reply = await this.planCommand("fence-local", { tool: "codex", n: attempt.n, owner: this.owner,
          generation: latest.read.generation, proxy: attempt.proxy, intended });
        if (!reply.ok) refused = reply.error ?? "failed";
      }
      if (refused) throw new Error("fenced");
    };
    try {
      const installFenced = async (stamp) => {
        const reply = await this.planCommand("install-local", { tool: "codex", n: attempt.n, rev: attempt.rev,
          owner: this.owner, intended, stamp });
        if (!reply.ok) {
          refused = reply.error ?? "failed";
          throw new Error("fenced");
        }
      };
      await this.switchCodex(account, { env: before.env, fence, installFenced });
    } catch {
      if (refused === "changed") return changed();
      if (refused === "stale" || refused === "off" || refused === "stopped") return;
      if (refused !== "lost") return fail(PENDING_WHY.includes(refused) ? refused : "failed");
    }
    const after = (await this.readPlanCodex())?.read;
    this.planCodex = after;
    if (!after) return;
    const outcome = localResult("codex", { ...attempt, home, intended, fencedAt: attempt.at }, after);
    const result = await this.recordLocal("codex", attempt, outcome);
    await this.finishLocalCodex(attempt, outcome, result, previous, cx, { switchConfirmed: refused !== "lost" });
  }

  async readCodexPlacement({ rev, n, generation, name }) {
    const current = (await this.readPlanCodex())?.read;
    const text = await readTextFile(`${appDir()}/${PLAN_FILE}`).catch(() => "");
    const { plan } = parsePlan(text ?? null);
    const section = plan?.codex, seen = own(section?.seen, LOCAL), placed = seen?.placed;
    const progress = own(section?.progress, LOCAL);
    if (plan?.rev === rev && progress?.state === "done" && progress.attempt?.n === n
      && placed?.name === name && placed.generation === generation
      && current?.generation === generation && current.home === seen.home && current.proxy === placed.proxy) return placed;
    return null;
  }

  async finishLocalCodex(attempt, outcome, result, previous, cx, { switchConfirmed = false } = {}) {
    if (!result.ok || !outcome.placed || !Number.isSafeInteger(result.rev)) return;
    const { generation, name } = outcome.placed;
    const placement = { rev: result.rev, n: attempt.n, generation, name };
    try {
      const recorded = await this.record("codex", async () => {
        const placed = await this.readCodexPlacement(placement);
        if (placed) return { name, fingerprint: placed.account };
      });
      const placed = recorded && await this.readCodexPlacement(placement);
      if (!placed) return;
      const account = this.codexAccounts().find((account) => account.name === name);
      // Recovery proves what was installed. Its record time cannot tell which bots started on it.
      const at = switchConfirmed ? Date.parse(placed.at) : null;
      this.armed = null;
      this.switched.codex = { at, from: previous ? who(previous) : null,
        to: account ? who(account) : "the planned account", look: "loading", placement };
      this.findBots("codex", cx);
      this.reload(cx);
    } catch (err) {
      this.switchError = message(err);
    }
  }

  planView(t, tool, cxView) {
    const value = this.plan.plan ?? this.plan.view ?? null;
    const observed = this.fleet.record?.machines ?? {};
    const machines = Object.fromEntries((this.fleet.members ?? []).map(({ id, name, connected }) => [
      id, own(observed, id) ?? { name, ...(connected ? {} : { state: "away" }) },
    ]));
    Object.assign(machines, observed);
    const local = this.planClaude;
    if (local) machines.local = { ...machines.local, core: LOCAL, appHome: local.home,
      state: "read", at: local.at, claude: { ...local, readAt: local.at } };
    else machines.local = { ...machines.local, name: "This Mac" };
    const codex = this.codexAccounts();
    const labels = new Map(codex.map((account) => [account.name, who(account)]));
    const codexUsable = this.accounts ? codex.filter(usable).map(({ name }) => name) : null;
    const ref = { codex: { codexLocal: this.planCodex, active: this.planActive, codexUsable },
      claude: { email: local?.email ?? observed.local?.claude?.email ?? null } };
    const rows = planRows({ plan: value, fleet: { machines }, ref, now: Date.now() })[tool].map((row) => {
      const entry = own(machines, row.machine);
      const { read, failure } = newest(entry, row.progress, row.machine, tool);
      const known = this.fleet.members?.find(({ id }) => id === row.machine);
      const eligible = tool === "codex" ? codexUsable ?? []
        : !failure && read?.slotsComplete ? read.slots.filter((item) => item.state === "eligible").map((item) => item.email) : [];
      return { ...row, name: row.machine === LOCAL ? "This Mac" : row.name, read, eligible,
        connected: known?.connected ?? entry?.state === "read", writer: entry?.writer };
    });
    const verdict = cxView?.primary && cxView?.current
      ? tool === "codex" ? { from: cxView.current.name, to: cxView.primary.account.name }
        : { from: cxView.current.email?.toLowerCase(), to: cxView.primary.row.email?.toLowerCase() } : null;
    const model = planBlock({ plan: this.plan, preview: this.preview, rows, tool, accounts: { labels }, verdict,
      linked: this.hasLinkedRows(), error: this.planError });
    if (!model) return null;
    const block = v_flex().mx(14).gap(6);
    const say = (row, text) => row.child(this.said(t, { text, tone: "none" }));
    const controls = (parent, list, prefix) => {
      if (!list.length) return;
      const group = h_flex().gap(4).flex_wrap();
      for (const { id, label, request } of list) {
        const key = `plan-${prefix}${id}`;
        if (!request) group.child(this.pill(t, { text: label, tone: "none" }).id(key));
        else group.child(this.button(t, key, label, (_e, cx) => {
          const previous = this.preview?.request;
          const next = request.include && typeof request.include === "string" && previous?.kind === "move-off"
            ? { ...previous, include: [...new Set([...(previous.include ?? []), request.include])] } : request;
          this.previewPlan(next, cx);
        }));
      }
      parent.child(group);
    };
    const readAgain = (row, id) => row.child(this.button(t, id, "Read linked machines", (_e, cx) => this.readFleet(cx, { force: true })));
    for (const line of model.head) say(block, line);
    controls(block, model.buttons, "");
    for (const entry of model.rows) {
      const row = v_flex().gap(4).child(h_flex().gap(6).items_center()
        .child(div().font_semibold().child(entry.name)).child(this.pill(t, { text: entry.words, tone: "none" })));
      if (entry.command) row.child(this.shownCommand(t, entry.command));
      for (const line of entry.lines) say(row, line);
      controls(row, entry.controls, `${slug(entry.machine)}-`);
      if (entry.readAgain) readAgain(row, `plan-read-${slug(entry.machine)}`);
      block.child(row);
    }
    if (model.preview) {
      const box = v_flex().gap(4).px(8).py(6).rounded(7).bg(t.raised);
      for (const line of model.preview.lines) say(box, line);
      // A plan from a newer version is read-only: its preview keeps only Cancel, so it can be put away.
      if (!this.plan.view) controls(box, model.preview.buttons, "");
      if (!this.plan.view && model.preview.readAgain) readAgain(box, "plan-read-preview");
      const decisions = h_flex().gap(4).flex_wrap();
      if (!this.plan.view && !model.preview.blocked) {
        const { confirmForget } = model.preview;
        const preview = this.preview;
        decisions.child(this.button(t, "plan-commit", confirmForget ? "Forget? Press again to confirm" : "Apply this plan",
          (_e, cx) => this.commitPlan(cx, { preview, confirmForget }), { primary: true }));
      }
      box.child(decisions.child(this.button(t, "plan-cancel", "Cancel", (_e, cx) => {
        if (this.planEditing) return;
        this.preview = null;
        this.planError = null;
        wake(cx);
      })));
      block.child(box);
    }
    return block;
  }

  readFleet(cx, { force = false } = {}) {
    cx.spawn(async (cx) => {
      const fleet = this.fleet;
      const read = async () => parseFleet(await readTextFile(`${appHome()}/${FLEET_FILE}`).catch(() => null));
      fleet.record = await read();
      wake(cx);
      const checkedCodex = this.fleetEnvReady && this.hasLinkedRows();
      if (checkedCodex) void this.codexRef(this.env, { force }).then(() => wake(cx));
      if (fleet.running || !force && Date.now() - fleet.at < IDENTITY_EVERY) return;

      fleet.running = true;
      try {
        const listed = await bounded((_command, args) => hc(args), "hc", ["machine", "ls", "--json"], MACHINES_MS);
        fleet.members = members(listed);
        fleet.at = Date.now();
        wake(cx);
        if (!this.hasLinkedRows()) {
          fleet.needsSidebar = false;
          fleet.error = null;
          fleet.answer = null;
          return;
        }
        if (this.fleetEnvReady) void this.codexRef(this.env, { force: force && !checkedCodex }).then(() => wake(cx));
        if (!await accountsArgv(["fleet"])) {
          fleet.needsSidebar = true;
          return;
        }
        fleet.needsSidebar = false;
        const reply = await this.cliRun(["fleet"], { label: "fleet", runLabel: FLEET_LABEL,
          followMs: FLEET_FOLLOW_MS, privateRun: true });
        if (!reply) {
          fleet.needsSidebar = true;
          return;
        }
        const answer = reply.code === 0 ? readFleetAnswer(JSON.stringify(reply.out)) : null;
        if (!answer) {
          fleet.error = reply.out?.error === "busy" ? "busy" : "failed";
          return;
        }
        fleet.record = await read();
        fleet.answer = answer;
        fleet.error = null;
      } catch (error) {
        if (error?.code === "apply-running") this.planError = "busy";
        else fleet.error = error?.partway ? "timeout" : "failed";
      } finally {
        fleet.running = false;
        this.maybeRetry(cx);
        wake(cx);
      }
    });
  }

  async codexRef(env, { force = false } = {}) {
    const file = credentialTarget("codex", { home: home(), env }).file;
    if (!force && this.fleetCodex?.file === file && Date.now() - this.fleetCodex.at < IDENTITY_EVERY) return this.fleetCodex.value;
    const value = readTextFile(file).then(accountFingerprint, () => null);
    const check = { file, value, fingerprint: null, at: Date.now() };
    this.fleetCodex = check;
    check.fingerprint = await value;
    return check.fingerprint;
  }

  linkedRows(tool) {
    const fleet = this.fleet;
    const stored = fleet.record?.machines ?? {};
    const known = new Map(Object.entries(stored));
    for (const { id, name, connected } of fleet.members ?? []) {
      if (!known.has(id)) known.set(id, { name, ...(connected ? {} : { state: "away", reason: null }) });
    }
    const fingerprint = this.fleetEnvReady ? this.fleetCodex?.fingerprint ?? null : null;
    const active = this.active.codex;
    const account = fingerprint && active?.fingerprint === fingerprint &&
      this.accounts?.find((a) => a.provider === "codex" && a.name === active.name);
    const local = stored.local?.claude;
    const ref = tool === "codex" ? { fingerprint } : { email: local?.state === "eligible" ? local.email : null };
    return fleetRows({ record: { at: fleet.record?.at, machines: Object.fromEntries(known) }, answer: fleet.error || fleet.needsSidebar ? null : fleet.answer,
      tool, ref, refName: account ? who(account) : null, now: Date.now(), plan: this.plan.plan });
  }

  restartLinked(tool, core, cx) {
    const key = `restart:${tool}:${core}`;
    const row = this.linkedRows(tool).find((r) => r.core === core);
    const entry = this.linked[`${tool}:${core}`] ??= { restarting: false, result: null };
    if (entry.restarting) return;
    if (this.busy) {
      this.armed = null;
      this.switchError = "a switch is running: restart the bots once it is done";
      wake(cx);
      return;
    }
    if (this.armed !== key) {
      if (!row?.bots.length) return;
      this.armed = key;
      entry.result = null;
      const list = frozen(row.bots);
      entry.list = list;
      entry.names = row.bots.map((bot) => bot.name);
      entry.name = row.name;
      cx.timer.after(ARMED, (cx) => {
        if (this.armed === key && this.linked[`${tool}:${core}`]?.list === list) {
          this.armed = null;
          wake(cx);
        }
      });
      wake(cx);
      return;
    }
    this.armed = null;
    if (row?.name !== entry.name || !sameList(entry.list, row.bots)) {
      entry.result = ["The list changed: press Restart again."];
      wake(cx);
      return;
    }
    entry.restarting = true;
    cx.spawn(async (cx) => {
      wake(cx);
      const result = [];
      for (const [i, bot] of entry.list.entries()) {
        result.push(await this.restartOne({ ...bot, name: entry.names[i] }, { on: { name: entry.name } }));
      }
      entry.restarting = false;
      entry.result = result;
      wake(cx);
      this.readFleet(cx, { force: true });
    });
  }

  fleetBlock(t, tool) {
    const rows = this.linkedRows(tool);
    const fleet = this.fleet;
    if (!rows.length && !fleet.needsSidebar && !fleet.error) return null;
    const block = v_flex().mx(14).gap(6).child(div().font_semibold().child("On linked machines"));
    const say = (parent, text) => parent.child(this.said(t, { text, tone: "none" }));
    if (fleet.needsSidebar) say(block, "Reading linked machines needs the sidebar mod switched on and up to date.");
    if (fleet.error) {
      say(block, `The linked machines weren't read (${fleet.error}).`);
      if (fleet.record?.at) say(block, `Last fleet read ${new Date(fleet.record.at).toLocaleString()}.`);
    }
    if (fleet.answer?.linked || fleet.record?.linked || fleet.members === null && fleet.at) {
      const time = fleet.record?.linked?.at ?? (fleet.at ? new Date(fleet.at).toISOString() : fleet.record?.at);
      say(block, `The list of linked machines couldn't be read${time ? ` ${new Date(time).toLocaleString()}` : ""}: rows show the last read.`);
    }
    for (const { core, name, words, tone, lines, bots, restart } of rows) {
      const row = v_flex().gap(4);
      row.child(h_flex().gap(6).items_center().child(div().font_semibold().child(name)).child(this.pill(t, { text: words, tone })));
      for (const line of lines) say(row, line);
      const state = this.linked[`${tool}:${core}`];
      if (bots.length) {
        const chips = h_flex().gap(4).flex_wrap();
        for (const bot of bots) chips.child(div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised)
          .text_size(10.5).child(`${bot.name} · ${bot.on}${bot.restart ? ` · ${bot.restart}` : ""}`));
        row.child(chips);
        const prompt = `Restart ${bots.length} bot${bots.length === 1 ? "" : "s"} on ${name}`;
        const armed = this.armed === `restart:${tool}:${core}`;
        row.child(this.button(t, `restart-${tool}-${core}`, state?.restarting ? "Restarting…" : armed ? `${prompt}? Press again to confirm` : prompt,
          (_e, cx) => this.restartLinked(tool, core, cx), { small: restart }));
      }
      for (const line of state?.result ?? []) say(row, line);
      block.child(row);
    }
    return block;
  }

  /**
   * The token identity of what is installed now, for the badge. Read when the panel opens, after a
   * switch, and then at most every five minutes: the file holds tokens, and a fingerprint compare
   * is not worth reading it on every 60 s poll. Null when nothing can be read: an unverifiable
   * record keeps its badge rather than flipping on a guess. Never logged.
   */
  async installedIdentity(provider, env) {
    const codex = this.plan.plan?.codex;
    if (!this.active[provider]?.fingerprint
      && !(provider === "codex" && own(codex?.progress, LOCAL) && own(codex.seen, LOCAL)?.placed)) return null;
    const now = Date.now();
    const cached = this.identities[provider];
    if (cached && now - cached.at < IDENTITY_EVERY) return cached.value;
    const value = await this.readIdentity(provider, env);
    this.identities[provider] = { at: now, value };
    return value;
  }

  /** Codex's installed identity, from its file; null for a provider with no writer (Claude). */
  async readIdentity(provider, env) {
    const target = credentialTarget(provider, { home: home(), env });
    if (!target) return null;
    try {
      const text = await readTextFile(target.file);
      return { known: true, fingerprint: tokenIdentity(provider, text), account: accountFingerprint(text),
        generation: text == null ? null : sha256Hex(text), home: target.file.slice(0, target.file.lastIndexOf("/")) };
    } catch {
      return null;
    }
  }

  /**
   * Claude's logins on this Mac (#453): the record on every read (one small file), and each
   * login looked at (its folder, `claude auth status`, Herdr's credential variables) when the
   * panel opens, after a switch, on ↻, when the record lists other logins, and at most every five
   * minutes. One round at a time: a round asked for while one runs is queued behind it, never
   * started beside it, and a record read never throws a round away. Logins are looked at side by
   * side, each check bounded (logins.js PROBE_MS), so a round always lands, a login that didn't
   * answer saying so.
   */
  readLogins(cx, { force = false } = {}) {
    cx.spawn(async (cx) => {
      const record = await readRecord(appHome(), readTextFile);
      const want = [{ id: DEFAULT_LOGIN, dir: null }, ...record.logins];
      const had = this.logins;
      const same = (probes) => probes?.length === want.length && want.every((l, i) => probes[i].id === l.id && probes[i].dir === l.dir);
      if (had && same(had.probes)) this.logins = { ...had, record };
      if (!force && had && same(had.probes) && Date.now() - had.at < IDENTITY_EVERY) return wake(cx);
      if (this.probing) {
        this.probeAgain = true;
        return wake(cx);
      }
      let round = null;
      try {
        round = await this.probeRound(record);
      } finally {
        wake(cx);
        // A finished round is the fresh read the plan's local Claude part checks against.
        if (this.plan.state === "ok" && own(this.plan.plan.claude.progress, LOCAL)) {
          await this.maybeLocal(cx, { tools: ["claude"], round });
          wake(cx);
        }
        if (this.probeAgain) {
          this.probeAgain = false;
          this.readLogins(cx, { force: true });
        }
      }
    });
  }

  async probeRound(initial) {
    while (this.probePending) await this.probePending;
    const run = async () => {
      const record = initial ?? await readRecord(appHome(), readTextFile);
      const want = [{ id: DEFAULT_LOGIN, dir: null }, ...record.logins];
      const ms = this.probeMs ?? PROBE_MS;
      const io = { exec, home: home(), readTextFile, where: await this.whereClaude(ms), ms };
      const [probes, vars] = await Promise.all([Promise.all(want.map((login) => probeLogin(login, io))), presentVars(exec, ms)]);
      const now = await readRecord(appHome(), readTextFile);
      const sameSlots = now.logins.length === record.logins.length
        && now.logins.every((login, i) => login.id === record.logins[i].id && login.dir === record.logins[i].dir);
      const sameRecord = sameSlots && now.text === record.text && !now.problem;
      const slots = slotStates(probes, { vars, home: home() }).map(({ id, email, state }) => ({
        id, email: isClaudeKey(email) ? email : null, state: email && !isClaudeKey(email) ? "failed" : state,
      }));
      if (!sameSlots) this.probeAgain = true;
      this.logins = { record: sameSlots ? now : record, probes, vars, at: Date.now() };
      const selected = now.use;
      const effective = probes.find((probe) => probe.id === selected)?.problem ? DEFAULT_LOGIN : selected;
      const chosen = slots.find((slot) => slot.id === effective);
      if (!sameRecord || vars === null || !chosen || slots.some((slot) => ["timeout", "failed"].includes(slot.state))) return null;
      // Only a complete round is this Mac's observation for the plan; an incomplete one keeps the last.
      this.planClaude = { at: new Date().toISOString(), core: null, home: appDir(), selected, effective,
        record: record.text === null ? "absent" : "ok", snapshot: record.text === null ? null : snapshotOf(record.text),
        email: chosen.state === "eligible" ? chosen.email : null, state: chosen.state,
        slots, slotsComplete: true, nextSlot: nextSlot(now.logins, home()).dir };
      return this.planClaude;
    };
    this.probing = true;
    try { return await (this.probePending = run()); }
    finally {
      this.probing = false;
      this.probePending = null;
    }
  }

  /**
   * Where a launch finds claude, from the CLI (`launch-path claude`): { program, path }, with
   * program null when launches can't find it; undefined when the CLI can't say (no sidebar mod, or
   * no answer), and the probes then use AUTH_SCRIPT.
   */
  async whereClaude(ms) {
    const argv = await cliArgv(["launch-path", "claude"]);
    if (!argv) return undefined;
    const r = await bounded(exec, argv[0], argv.slice(1), ms);
    try {
      const out = JSON.parse(r?.stdout ?? "");
      if (r.code === 0 && (out.program === null || (typeof out.program === "string" && typeof out.path === "string"))) return out;
    } catch {}
    return undefined;
  }

  /** The card for one tool, from the last read. */
  view(provider) {
    if (provider === "claude") {
      return loginsView({ record: this.logins?.record ?? null, probes: this.logins?.probes ?? null, accounts: this.accounts ?? [],
        now: Date.now(), source: instanceName(this.config), home: home(), vars: this.logins?.vars ?? null });
    }
    const codex = this.plan.plan?.codex;
    const seen = own(codex?.seen, LOCAL), placed = seen?.placed;
    const installed = this.identities[provider]?.value;
    // A Codex refresh changes the bytes without changing the account named by this proxy.
    const refreshed = own(codex?.progress, LOCAL) && placed && installed?.account === placed.account && installed.home === seen.home
      && installed.generation !== placed.generation && placed.proxy === proxyId(this.config?.url);
    const record = refreshed ? { name: placed.name, fingerprint: placed.account } : this.active[provider] ?? null;
    const badge = refreshed ? { text: "in use" } : this.badges[provider] ?? null;
    return toolView({ provider, accounts: this.accounts ?? [], record, badge, now: Date.now(), source: instanceName(this.config) });
  }

  // Installs one credential into the client that owns that provider (Codex only: Claude has no
  // writer, so a Claude call stops here, before any download). The flow lives in ./switch.js
  // (tested with its shell and files injected); the panel owns the record, the banner and the lock.
  use(provider, account, cx) {
    if (!TARGETS[provider]) return;
    if (!this.api) {
      this.switchError = "no proxy read yet";
      wake(cx);
      return;
    }
    // A second click starts nothing; the busy line names the account by email, never its file.
    const refused = claim(this, provider, account, `switching ${TOOLS[provider]} to ${who(account)}…`);
    if (refused) {
      this.switchError = refused;
      wake(cx);
      return;
    }
    this.switchError = null;
    const before = this.view(provider).current;
    cx.spawn(async (cx) => {   // one switch at a time
      wake(cx);
      try {
        const result = await this.switchCodex(account);
        this.planCodex = null;
        this.active[provider] = { name: account.name, fingerprint: result.fingerprint };
        await this.record(provider);
        this.armed = null;
        this.switched[provider] = { at: Date.now(), from: before ? who(before) : null, to: who(account), look: "loading" };
        this.findBots(provider, cx);
        this.localAt[provider] = 0;   // with a plan, the next read checks this Mac against it
        this.reload(cx);   // the card and the verdict follow the credential that is now installed
      } catch (err) {
        this.switchError = message(err);
      } finally {
        release(this);
        wake(cx);
      }
    });
  }

  switchCodex(account, options = {}) {
    return install({ api: this.api, provider: "codex", account, ...this.io(), ...options });
  }

  /**
   * A current sidebar shares its login lock with the panel. Older installs keep the same
   * writeTextFile call and the same snapshot.
   */
  async writeLogins(record, op) {
    const status = await writerStatus(appDir());
    if (status === "unknown") throw new Error("writer-unreadable: try again");
    const argv = await accountsArgv(setLoginArgs(op, snapshotOf(record.text)), { write: true, status });
    if (argv) {
      const result = setLoginResult(await exec(argv[0], argv.slice(1)).catch(() => null));
      if (!result.ok) throw new Error(result.code);
      return;
    }
    const { kind, id, dir } = op;
    const next = { use: kind === "use" ? id : record.use, logins: record.logins };
    if (kind === "add") next.logins = [...next.logins, { id, dir }];
    if (kind === "remove") next.logins = next.logins.filter((login) => login.id !== id);
    await writeRecord(appHome(), next, record.text, writeTextFile);
  }

  /**
   * Use (#453): new Claude launches get login `id`. One write of claude-logins.json's `use`,
   * with the snapshot the panel read (a change made since is never overwritten); no credential
   * is touched. Only a row the card offers Use on: never while the record is bad.
   */
  useLogin(id, cx) {
    const v = this.view("claude");
    const target = v.rows.find((r) => r.id === id);
    if (!target?.use) return;
    const refused = claim(this, "claude", null, `switching new Claude launches to ${target.who}…`);
    if (refused) {
      this.switchError = refused;
      wake(cx);
      return;
    }
    this.switchError = null;
    const { record } = this.logins;
    cx.spawn(async (cx) => {
      wake(cx);
      try {
        await this.writeLogins(record, { kind: "use", id });
        this.armed = null;
        this.switched.claude = { at: Date.now(), from: v.current?.who ?? null, to: target.who, login: id, look: "loading" };
        this.findBots("claude", cx);
      } catch (err) {
        this.switchError = `New Claude launches were not switched: claude-logins.json changed since the panel read it, or couldn't be written (${message(err).slice(0, 80)})`;
      } finally {
        release(this);
        this.readLogins(cx, { force: true });
        wake(cx);
      }
    });
  }

  /**
   * Add login (#453 section 7): records the next slot once its folder passes the form rule and
   * `claude auth status` there says signed in. The person made the folder and signed in; the
   * panel runs neither.
   */
  addLogin(cx) {
    const slot = this.view("claude").add;
    if (!slot) return;
    const name = loginName(slot.id);
    const refused = claim(this, "claude", null, `checking ${name}…`);
    if (refused) {
      this.switchError = refused;
      wake(cx);
      return;
    }
    this.switchError = null;
    this.loginNote = null;
    const { record } = this.logins;
    cx.spawn(async (cx) => {
      wake(cx);
      try {
        const ms = this.probeMs ?? PROBE_MS;
        const p = await probeLogin(slot, { exec, home: home(), readTextFile, where: await this.whereClaude(ms), ms });
        if (p.problem) throw new Error(`its ${p.problem}: make it first, as the steps say`);
        if (p.status.state !== "in") throw new Error("claude auth status there doesn't say signed in: sign in first, as the steps say");
        if (p.status.configDirectory && p.status.configDirectory.replace(/\/+$/, "") !== slot.dir) throw new Error(`settings move ${name} to another folder`);
        await this.writeLogins(record, { kind: "add", id: slot.id, dir: slot.dir });
        this.loginNote = `${name} added${p.email ? `: ${p.email}` : ""}. Press Use on it to start new Claude launches there.`;
      } catch (err) {
        this.switchError = `${name} wasn't added: ${message(err)}`;
      } finally {
        release(this);
        this.readLogins(cx, { force: true });
        wake(cx);
      }
    });
  }

  /**
   * Remove login (#453 section 7), on a second press: refused for the login in use, while it is
   * still signed in (its logout is the person's, in a terminal), and while any pane's launch argv
   * names its folder by value. Drops it from the record; its folder and files stay.
   */
  removeLogin(id, cx) {
    const row = this.view("claude").rows.find((r) => r.id === id);
    if (!row?.remove) return;
    const key = `remove:${id}`;
    if (this.armed !== key) {
      this.armed = key;
      cx.timer.after(ARMED, (cx) => {
        if (this.armed === key) {
          this.armed = null;
          wake(cx);
        }
      });
      wake(cx);
      return;
    }
    this.armed = null;
    const refused = claim(this, "claude", null, `checking ${row.name}…`);
    if (refused) {
      this.switchError = refused;
      wake(cx);
      return;
    }
    this.switchError = null;
    this.loginNote = null;
    const { record } = this.logins;
    cx.spawn(async (cx) => {
      wake(cx);
      try {
        // Asked again at the press, never from the last look: only a JSON loggedIn: false lets it go.
        const ms = this.probeMs ?? PROBE_MS;
        const out = await signedOut({ id, dir: row.dir }, { exec, home: home(), where: await this.whereClaude(ms), ms });
        if (!out.ok) throw new Error(out.why);
        const ls = await hc(["ls", "--json"]);
        if (ls?.code !== 0) throw new Error("hc can't list the panes, so the panel can't tell whether one still runs on it");
        const reads = await Promise.all(liveRows(ls.stdout).map((r) => this.paneGet(r.address).then((g) => ({ r, g }), () => ({ r, g: undefined }))));
        const lost = reads.find((x) => x.g === undefined);
        if (lost) throw new Error(`hc can't read ${lost.r.address}, so the panel can't tell whether it runs on ${row.name}`);
        const ons = await Promise.all(reads.map((x) => (x.g ? matchReal(paneLogin(x.g.argv, record.logins), record.logins, exec, ms) : null)));
        const named = (pick) => reads.filter((_x, i) => pick(ons[i])).map((x) => x.r.name ?? x.r.address);
        const on = named((o) => o?.id === id);
        if (on.length) throw new Error(`${on.join(", ")} still ${on.length === 1 ? "runs" : "run"} on it: restart or stop ${on.length === 1 ? "it" : "them"} first`);
        // A folder under home that no login lists may be this one by another spelling: refused too.
        const odd = named((o) => typeof o?.unknown === "string" && o.unknown.startsWith(`${home().replace(/\/+$/, "")}/`));
        if (odd.length) throw new Error(`${odd.join(", ")} ${odd.length === 1 ? "runs" : "run"} on a login folder the panel can't match to a login: restart or stop ${odd.length === 1 ? "it" : "them"} first`);
        await this.writeLogins(record, { kind: "remove", id });
        this.loginNote = `${row.name} removed from the panel. Its folder stays; delete it by hand if you want.`;
      } catch (err) {
        this.switchError = `${row.name} wasn't removed: ${message(err)}`;
      } finally {
        release(this);
        this.readLogins(cx, { force: true });
        wake(cx);
      }
    });
  }

  /** The machine the writers act on: the runtime's files and shell, the clients' environment. */
  io() {
    return { home: home(), appHome: appHome(), env: this.env, exec, writeTextFile };
  }

  /**
   * Writes `active.json` and drops the cached identity, so the card follows what was written. A
   * failed write is shown, not swallowed: a stale record would name the wrong account in use.
   */
  async record(provider, validate) {
    delete this.identities[provider];
    if (provider === "codex") this.fleetCodex = null;
    // writeTextFile wants the snapshot it replaces: null only creates.
    const statePath = `${appHome()}/data/${STATE}`;
    const before = await readTextFile(statePath).catch(() => null);
    if (validate) {
      // Check the managed placement after reading the snapshot. Switch may have updated it.
      const record = await validate();
      if (!record) return false;
      this.active[provider] = record;
    }
    try {
      await writeTextFile(statePath, JSON.stringify(this.active, null, 2) + "\n", before ?? null);
    } catch (err) {
      // Keep memory equal to disk: the record on disk is what the next session will read.
      try {
        this.active = before ? records(JSON.parse(before)) : {};
      } catch {}
      throw new Error(`the login was written, but active.json could not record it (${message(err).slice(0, 80)}) — the panel may name the wrong account in use`);
    }
    return true;
  }

  /**
   * The bot CLI with --json through exec, as the sidebar runs it: { code, out, err }, or null when
   * the sidebar mod (which carries the CLI) is not installed. Under exec's 30 s: a quick question
   * only (ls); a restart goes through cliRun.
   */
  async cli(args) {
    const argv = await cliArgv(args);
    if (!argv) return null;
    const r = await exec(argv[0], argv.slice(1));
    return cliAnswer(r?.code ?? 1, r?.stdout, r?.stderr);
  }

  /**
   * The bot CLI with --json in an hc terminal of its own (#433), followed to its end: what cli()
   * resolves, so outside exec's limit, or null when the sidebar mod is not installed. `label`: the
   * bot's id, on the terminal; one still running for it refuses a second. For private accounts
   * runs, either live label refuses a second run. `followMs`: how long the
   * panel follows it. Throws a RunError when there is no answer: not started (nothing ran), its
   * terminal gone or ended with none (`partway`: it may have stopped part-way), or still running.
   */
  async cliRun(args, { env = [], label, followMs, runLabel = RUN_LABEL, privateRun = false }) {
    const dir = appDir();
    if (privateRun && accountsRuns.has(dir)) {
      throw runError("an accounts run is still running", { code: "apply-running", partway: true });
    }
    if (privateRun) accountsRuns.add(dir);
    try {
      return await this.runCliTerminal(args, { dir, env, label, followMs, runLabel, privateRun });
    } finally {
      if (privateRun) accountsRuns.delete(dir);
    }
  }

  async runCliTerminal(args, { dir, env, label, followMs, runLabel, privateRun }) {
    const privateArgv = privateRun ? await accountsArgv(args) : null;
    if (privateRun ? !privateArgv : !(await cliArgv(args))) return null;
    const listRun = (value) => ["ls", "--label", `${runLabel}=${value}`, "--json"];
    const mine = listRun(label);
    if (privateRun) {
      const [fleet, apply] = await Promise.all([hc(listRun("fleet")), hc(listRun("apply"))]);
      if (fleet?.code !== 0 || apply?.code !== 0) throw runError("hc can't list the restarts still running, so none was started");
      if (liveRows(fleet.stdout)[0]) throw runError("the fleet read is still running", { code: "fleet-running", partway: true });
      if (liveRows(apply.stdout)[0]) throw runError("machines are being switched now", { code: "apply-running", partway: true });
    } else {
      const before = await hc(mine);
      if (before?.code !== 0) throw runError("hc can't list the restarts still running, so none was started");
      const going = liveRows(before.stdout)[0];
      if (going) throw runError(`its restart started earlier still runs in ${going.address}, so no second one was started`);
    }
    // Its own names: never a file an earlier run left, even one started in the same millisecond.
    const base = `${dir}/${RUNS}/${slug(label)}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const files = { out: `${base}.out`, err: privateRun ? null : `${base}.err`, code: `${base}.code` };
    try {
      let argv = privateArgv;
      if (privateRun) {
        const made = await exec("sh", ["-c", 'umask 077; mkdir -p -- "$1"', "sh", `${dir}/${RUNS}`]);
        if (made?.code !== 0) throw runError("the fleet read could not start");
      } else {
        const herdr = await this.prepare(`${dir}/${RUNS}`);
        argv = await cliArgv(args, [...CLI_ENV.filter((n) => n in herdr).map((n) => `${n}=${herdr[n]}`), ...env],
          CLI_ENV.filter((n) => !(n in herdr)));
      }
      // --rm: hc removes it once it ends; its answer is in the files.
      const r = await hc(["run", "--bg", "--json", "--rm", "--no-parent", "--cwd", dir, "--label", `${runLabel}=${label}`,
        "--", "sh", "-c", ...(privateRun ? [PRIVATE_RUN_SCRIPT, "sh", files.out, files.code, slug(label)] :
          [RUN_SCRIPT, "sh", files.out, files.err, files.code]), ...argv]);
      if (r?.code !== 0) {
        if (privateRun) throw runError("the fleet read could not start");
        const said = hcSaid(r);
        throw runError(`hc couldn't start its restart in a terminal of its own${said ? ` (${said})` : ""}; nothing was restarted`);
      }
      let terminal = null;
      try {
        terminal = JSON.parse(r.stdout).address ?? null;
      } catch {}
      // It may run anyway: found by its label.
      if (typeof terminal !== "string" || !terminal) {
        const after = await hc(mine).catch(() => null);
        terminal = after?.code === 0 ? liveRows(after.stdout)[0]?.address ?? null : null;
      }
      if (!terminal) {
        const got = await this.runAnswer(files);
        if (got) return got;
        throw runError("hc started its restart without saying in which terminal, and none was found", { partway: true });
      }
      return await this.follow(terminal, files, followMs);
    } finally {
      if (privateRun) await exec("rm", ["-f", "--", files.out, files.code, `${files.code}.tmp`]).catch(() => {});
    }
  }

  /**
   * Before a restart, through exec (Herdr's environment): makes the runs folder and reads CLI_ENV as
   * Herdr has them, { NAME: value } for each one set. Throws when either fails: nothing ran.
   */
  async prepare(folder) {
    let r;
    try {
      r = await exec("sh", ["-c", PREPARE_SCRIPT, "sh", folder, ...CLI_ENV]);
    } catch (err) {
      r = { code: null, stderr: message(err) };
    }
    if (r?.code === 3) throw runError(`couldn't make ${folder} for its answer, so no restart was started`);
    if (r?.code !== 0) throw runError("couldn't read this app's environment for it, so no restart was started");
    const vars = {};
    for (const line of String(r.stdout ?? "").split("\n")) {
      const at = line.indexOf("=");
      const name = line.slice(0, at);
      if (at > 0 && CLI_ENV.includes(name) && !(name in vars) && line.slice(at + 1)) vars[name] = line.slice(at + 1);
    }
    return vars;
  }

  /** The CLI's answer a restart's terminal left (cli()'s shape), or null while its exit code isn't written. */
  async runAnswer(files) {
    const read = (path) => readTextFile(path).catch(() => null);
    const code = await read(files.code);
    if (code === null || code === undefined) return null;
    const n = Number.parseInt(String(code).trim(), 10);
    return cliAnswer(Number.isSafeInteger(n) ? n : 1, await read(files.out), files.err ? await read(files.err) : null);
  }

  /**
   * Follows a restart's terminal until its answer is written (see RUN_WAIT_S). Its terminal gone or
   * ended with no answer, or still running after `followMs`: a RunError, never a silent end.
   */
  async follow(terminal, files, followMs) {
    const started = Date.now();
    let quick = false;
    for (;;) {
      const got = await this.runAnswer(files);
      if (got) return got;
      if (quick) await this.pause(RUN_PAUSE_MS);
      let pane;
      let unread = false;
      try {
        pane = await this.paneGet(terminal);
      } catch {
        unread = true;
      }
      if (pane === null || (pane && pane.state && pane.state !== "live")) {
        // The answer may land just before the terminal ends.
        const late = await this.runAnswer(files);
        if (late) return late;
        throw runError(pane === null ? `its restart's terminal ${terminal} is gone, with no answer from it`
          : `its restart in ${terminal} ended with no answer`, { partway: true });
      }
      // Wall time, not waits: a wait that answers at once is followed by a pause, never counted.
      if (Date.now() - started >= followMs) {
        throw runError(`its restart ${unread ? `may still run in ${terminal} (hc can't say how it is)` : `still runs in ${terminal}`} after `
          + `${waited(Date.now() - started)}; the panel stopped following it, so how it ends isn't shown here. Check whether the bot is back once ${terminal} is gone`, files.err ? {} : { partway: true });
      }
      const asked = Date.now();
      try {
        await exec("hc", ["wait", terminal, "--timeout", String(RUN_WAIT_S), "--json"], { timeout: RUN_WAIT_EXEC_MS });
      } catch {}
      quick = Date.now() - asked < 1000;
    }
  }

  /** A pause between looks at a restart's terminal (a test replaces it). */
  pause(ms) {
    return new Promise((go) => setTimeout(go, ms));
  }

  /**
   * After a switch: the bots still on the old one, by `automagik-herdr ls`. Codex: those started
   * before it, or all of them when the switch time is unknown. Claude (#453 section 3): those
   * whose pane's launch argv names another login, by value.
   */
  findBots(provider, cx) {
    const s = this.switched[provider];
    cx.spawn(async (cx) => {
      try {
        const r = await this.cli(["ls", "--all"]);
        if (this.switched[provider] !== s) return;
        if (!r) s.look = "no-cli";
        else if (r.code !== 0 || !r.out) s.look = { error: refusal(r) || `am ls failed (exit ${r.code})` };
        else if (provider !== "claude") s.look = staleBots(r.out, provider, s.at);
        else {
          const bots = runningBots(r.out, "claude");
          const logins = this.logins?.record?.logins ?? [];
          const ons = await Promise.all(bots.map((b) => this.paneGet(b.terminal).then(
            (g) => (g ? matchReal(paneLogin(g.argv, logins), logins, exec) : null), () => ({ why: "hc can't read its pane" }))));
          if (this.switched[provider] !== s) return;
          s.look = offLogin(bots, ons, s.login);
        }
      } catch (err) {
        if (this.switched[provider] === s) s.look = { error: message(err) };
      }
      wake(cx);
    });
  }

  async checkCodexRestart(s, cx) {
    if (this.switched.codex === s && await this.readCodexPlacement(s.placement) && this.switched.codex === s) return true;
    if (this.switched.codex === s) {
      delete this.switched.codex;
      this.armed = null;
    }
    this.switchError = "This Codex placement was superseded.";
    wake(cx);
    return false;
  }

  withRestartOffer(s, cx, run) {
    if (!s.placement) return run();
    cx.spawn(async (cx) => {
      if (await this.checkCodexRestart(s, cx)) run();
    });
  }

  /**
   * Restart N bots: the first click arms it, a second within five seconds runs each restart. Not
   * while a switch runs (the bots would restart onto a login that is still being written). After a
   * run only the bots that failed stay listed, so pressing again retries those alone.
   */
  restartBots(provider, cx) {
    const s = this.switched[provider];
    const bots = s?.look?.bots ?? [];
    if (!bots.length || s.restarting) return;
    if (this.busy) {
      this.armed = null;
      this.switchError = "a switch is running: restart the bots once it is done";
      wake(cx);
      return;
    }
    const key = `restart:${provider}`;
    if (this.armed !== key) {
      this.armed = key;
      cx.timer.after(ARMED, (cx) => {
        if (this.armed === key) {
          this.armed = null;
          wake(cx);
        }
      });
      wake(cx);
      return;
    }
    this.armed = null;
    s.restarting = true;
    // lock.claim refuses this provider's switch until its restarts are done; the other's is free.
    this.restarting = { ...this.restarting, [provider]: true };
    s.result = null;
    s.waiting = {}; // this run replaces any wait still going
    cx.spawn(async (cx) => {
      wake(cx);
      const failed = [];
      const left = [];
      // The ones that restarted on a new conversation, and why (#328: no session id known and a
      // teammate on that agent in the folder; #413: codex can't resume the thread): the CLI's note.
      const fresh = [];
      // The ones refused as busy (#413): { bot, why, refused, terminal }, each with Restart when idle.
      const busy = [];
      let done = (s.done ?? 0);
      // One at a time: each restart waits for the new pane's agent to stay up.
      for (const bot of bots) {
        if (s.placement && !await this.checkCodexRestart(s, cx)) break;
        const one = await this.restartOne(bot);
        if (one.note) fresh.push(`${bot.name}: ${noteText(one.note)}`);
        if (one.busy) busy.push(one.busy);
        else if (one.why !== null) failed.push(`${bot.name}: ${one.why}`);
        if (one.why === null) done += 1;
        else left.push(bot);
      }
      s.restarting = false;
      delete this.restarting[provider];
      s.done = done;
      s.result = { done, failed, fresh, busy, helpers: [] };
      // Only the ones that failed are left to restart.
      s.look = { bots: left, reliable: left.length ? s.look.reliable : true };
      // A bot held only by its helpers needs no second press (the owner's rule): the panel sees to it,
      // one bot at a time, outside the restart lock, so a Cancel and a switch stay open meanwhile.
      const held = busy.filter((b) => b.refused === "helpers");
      for (const b of held) s.waiting[b.bot.id] = {};
      wake(cx);
      for (const b of held) await this.whenReady(provider, s, b, cx);
    });
  }

  /**
   * One bot's restart through the CLI: { why: null | the reason it wasn't, note: a fresh start's
   * note or null, busy: { bot, why, refused, terminal } when the CLI refused it as busy (its
   * --json `refused`: "working", or "helpers" that would end with its pane), helpers: the lines of
   * helpers `tree` didn't run again }. `tree`: its helpers restart with it. Such a restart exits 1
   * when a helper wasn't run again, though the bot did restart: its new `terminal` with no `error`
   * says so. A refusal can carry a `terminal` too (a new pane that exited, a turn started again).
   */
  async restartOne(bot, { tree = false, helpers: count = 0, on = null } = {}) {
    try {
      const args = on ? restartArgs(bot, on.name) : ["restart", bot.id, "--project", bot.project, ...(tree ? ["--tree"] : [])];
      // In a terminal of its own (#433): a restart waits up to 30 s for its new pane, twice when
      // codex can't resume (#413), and a --tree one 40 s more per helper, past exec's limit.
      const r = await this.cliRun(args, { label: bot.id, followMs: RUN_FOLLOW_MS + (tree ? count * RUN_HELPER_MS : 0),
        env: tree ? [`AUTOMAGIK_HERDR_TREE_TURN_WAIT_MS=${TREE_TURN_WAIT_MS}`] : [] });
      if (on) return restartWords({ name: bot.name, code: r?.code, refused: r?.out?.refused, retired: r?.out?.retired });
      const helpers = (Array.isArray(r?.out?.helpers) ? r.out.helpers : []).filter((h) => h?.error)
        .map((h) => `${bot.name}'s helper ${h.name ?? h.replaced}: ${plain(h.error)}`);
      if (r?.code === 0 || (tree && typeof r?.out?.terminal === "string" && r.out.error === undefined)) {
        return { why: null, note: r.out?.mode === "fresh" && typeof r.out.note === "string" && r.out.note ? r.out.note : null, busy: null, helpers };
      }
      const why = refusal(r) || `exit ${r?.code ?? "?"}`;
      const refused = r?.out?.refused;
      const busy = (refused === "working" || refused === "helpers") && typeof r.out.terminal === "string"
        ? { bot, why, refused, terminal: r.out.terminal } : null;
      return { why, note: null, busy, helpers };
    } catch (err) {
      if (on) return restartWords({ name: bot.name });
      // Its terminal ended with no answer: the restart may have stopped part-way.
      const back = tree ? `${bot.name} and its helpers are back` : `${bot.name} is back`;
      const why = err?.partway ? `${message(err)}. It may have stopped part-way: check whether ${back}, then restart what is missing from a terminal, not from here` : message(err);
      return { why, note: null, busy: null, helpers: [] };
    }
  }

  /**
   * Restart when idle (#413): the button for a bot mid-turn, and the press that retries one the
   * panel gave up on. A second press cancels: the wait's answer is dropped (hc wait itself ends by
   * its timeout). Kept in this panel only, so a reload of the panel clears it.
   */
  restartWhenIdle(provider, botId, cx) {
    const s = this.switched[provider];
    const entry = s?.result?.busy?.find((b) => b.bot.id === botId);
    if (!entry) return;
    s.waiting ??= {};
    if (s.waiting[botId]) {
      delete s.waiting[botId];
      entry.why = "canceled; nothing was restarted";
      wake(cx);
      return;
    }
    s.waiting[botId] = {};
    cx.spawn(async (cx) => {
      wake(cx);
      await this.whenReady(provider, s, entry, cx);
    });
  }

  /**
   * Waits for a busy bot, then restarts it once. Each look re-reads hc: the bot's pane and every
   * helper that would end with it. Its pane done, idle or in error and its helpers done or idle:
   * one restart, with its helpers if it has any. Something working: one wait, on that pane only,
   * then look again, within the bounds above. Anything else (a question waiting, gone, unreadable,
   * a helper in error): no restart, and the bot stays listed with why. A look is what decides, not
   * how a wait ended: Herdr may cut a wait, and the pane may be finished by then.
   */
  async whenReady(provider, s, entry, cx) {
    const id = entry.bot.id;
    const token = s.waiting?.[id];
    if (!token) return;
    const live = () => this.switched[provider] === s && s.waiting?.[id] === token;
    const stop = (why, next = "") => {
      delete s.waiting[id];
      entry.why = `${why}; nothing was restarted${next}`;
      wake(cx);
    };
    const started = Date.now();
    let waits = 0;
    let most = null;
    let helpers = 0;
    for (;;) {
      const now = await this.lookAt(entry.terminal);
      if (!live()) return;
      if (now.stop) return stop(now.stop);
      helpers = now.helpers;
      if (!now.working.length) break;
      most ??= IDLE_WAITS + now.helpers;
      if (waits >= most || Date.now() - started >= IDLE_WAITS * IDLE_WAIT_S * 1000) {
        return stop(`${now.working.join(", ")} still working after ${waited(Date.now() - started)} of waiting`);
      }
      waits += 1;
      entry.why = `waiting for ${now.working.join(", ")} to finish`;
      wake(cx);
      try {
        await exec("hc", ["wait", now.working[0], "--timeout", String(IDLE_WAIT_S), "--json"], { timeout: IDLE_EXEC_MS });
      } catch {}
      if (!live()) return;
    }
    if (s.placement && (!await this.checkCodexRestart(s, cx) || !live())) return;
    // A switch or another restart running now: this one does not wait for it.
    if (this.busy || s.restarting) {
      delete s.waiting[id];
      entry.why = `${entry.bot.name} is ready, but ${this.busy ? "a switch" : "a restart"} was running; nothing was restarted`;
      wake(cx);
      return;
    }
    s.restarting = true;
    this.restarting = { ...this.restarting, [provider]: true };
    wake(cx);
    const one = await this.restartOne(entry.bot, { tree: helpers > 0, helpers });
    s.restarting = false;
    delete this.restarting[provider];
    delete s.waiting[id];
    const r = s.result;
    r.busy = r.busy.filter((b) => b.bot.id !== id);
    if (one.note) r.fresh = [...r.fresh, `${entry.bot.name}: ${noteText(one.note)}`];
    r.helpers = [...r.helpers, ...one.helpers];
    if (one.busy) r.busy = [...r.busy, one.busy];
    else if (one.why !== null) r.failed = [...r.failed, `${entry.bot.name}: ${one.why}`];
    if (one.why === null) {
      r.done += 1;
      s.done = r.done;
      const left = (s.look?.bots ?? []).filter((b) => b.id !== id);
      s.look = { bots: left, reliable: left.length ? s.look.reliable : true };
    }
    wake(cx);
  }

  /**
   * `hc get` of `terminal`, or null when hc says there is no such pane (exit 3, not_found). Any other
   * failure throws: a pane hc can't read may still be running, so it is never taken for gone.
   */
  async paneGet(terminal) {
    const r = await hc(["get", terminal, "--json"]);
    if (r?.code === 0) return JSON.parse(r.stdout);
    if (r?.code === 3 || /not_found/.test(r?.stderr ?? "")) return null;
    throw new Error(`hc get ${terminal} failed`);
  }

  /** `hc get` of each of `rows`: { lost: the first address hc can't read, or null, gets }. */
  async paneGets(rows) {
    const reads = await Promise.all(rows.map((r) => this.paneGet(r.address).then((get) => ({ get }), () => ({ lost: r.address }))));
    return { lost: reads.find((x) => x.lost)?.lost ?? null, gets: reads.map((x) => x.get) };
  }

  /**
   * How a bot's pane and the helpers that would end with it stand now: { stop: why nothing may
   * restart, or null, working: the panes working, helpers: how many there are }.
   */
  async lookAt(terminal) {
    const none = (stop) => ({ stop, working: [], helpers: 0 });
    try {
      const pane = await this.paneGet(terminal);
      if (!pane || (pane.state && pane.state !== "live")) return none(`its pane ${terminal} is gone`);
      const state = pane.status?.state;
      if (typeof state !== "string") return none(`hc can't say how ${terminal} is`);
      if (state === "blocked") return none(`its pane ${terminal} is waiting for an answer`);
      const ls = await hc(["ls", "--json"]);
      if (ls?.code !== 0) return none(`hc can't list ${terminal}'s helpers`);
      const rows = JSON.parse(ls.stdout);
      const list = Array.isArray(rows) ? rows : rows?.terminals ?? [];
      const kids = list.filter((r) => r?.parent === terminal && r.state !== "finished" && r.address);
      const { lost, gets } = await this.paneGets(kids);
      if (lost) return none(`hc can't say how its helper ${lost} is`);
      // A member bot outlives the pane, and one gone by now has nothing left to end.
      const helpers = gets.filter((g) => g?.state === "live" && g.die_with_parent !== false);
      const working = state === "working" ? [terminal] : [];
      for (const h of helpers) {
        // A restart runs a bot's helpers again, not theirs: those would end and stay ended.
        const under = list.filter((r) => r?.parent === h.address && r.state !== "finished" && r.address);
        const nested = await this.paneGets(under);
        if (nested.lost) return none(`hc can't say how its helper ${nested.lost} is`);
        if (nested.gets.some((g) => g?.state === "live" && g.die_with_parent !== false)) {
          return none(`its helper ${h.address} has helpers of its own, which a restart wouldn't bring back`);
        }
        const st = h.status?.state;
        if (st === "working") working.push(h.address);
        else if (st === "blocked") return none(`its helper ${h.address} is waiting for an answer`);
        // No status: a plain program, or an agent that may be mid-turn. Only the CLI knows which, and
        // its last check refuses the agent.
        else if (typeof st === "string" && st !== "idle" && st !== "done") return none(`its helper ${h.address} is in ${st}`);
      }
      return { stop: null, working, helpers: helpers.length };
    } catch {
      return none(`hc can't say how ${terminal} is`);
    }
  }

  // ---- drawing ----

  tone(t, name) {
    return name === "good" ? t.done : name === "warn" ? t.working : t.dim;
  }

  button(t, id, label, onClick, { primary = false, small = null } = {}) {
    const el = v_flex().id(id).justify_center().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick)
      .bg(primary ? t.accent : t.raised).text_color(primary ? t.accent_foreground : t.foreground)
      .text_size(primary ? 12.5 : 11).child(div().font_semibold().child(label));
    if (primary) el.px(12).py(7).rounded(8);
    else el.flex_none().px(8).h(22).rounded(6);
    if (small) el.child(div().text_size(10.5).opacity(0.85).child(small));
    return el;
  }

  bar(t, usage) {
    const fill = div().h_full().bg(usage.hot ? t.working : t.done).w(`${usage.used ?? 0}%`);
    return h_flex().h(5).w_full().rounded(3).bg(t.raised).overflow_hidden().child(fill);
  }

  meta(t, usage) {
    const line = h_flex().gap(8).text_size(10.5).text_color(t.dim).child(div().child(usage.text));
    if (usage.reset) line.child(div().flex_1().min_w(0)).child(div().child(usage.reset));
    for (const f of usage.flags) line.child(div().text_color(t.working).child(f));
    return line;
  }

  pill(t, pill) {
    return div().px(6).h(16).flex().items_center().rounded(8).bg(t.raised).text_size(10)
      .text_color(this.tone(t, pill.tone)).child(pill.text);
  }

  segment(t) {
    const seg = h_flex().mx(14).mt(10).p(3).gap(4).rounded(9).bg(t.chrome ?? t.raised);
    for (const provider of Object.keys(TOOLS)) {
      const on = provider === this.tool;
      const dot = this.accounts ? this.view(provider).dot : "none";
      seg.child(h_flex().id(`tool-${provider}`).flex_1().h(28).gap(6).items_center().justify_center()
        .rounded(7).cursor_pointer().bg(on ? t.raised : t.background ?? t.raised)
        .text_color(on ? t.foreground : t.muted).text_size(12.5).font_semibold()
        .on_click((_e, cx) => {
          this.tool = provider;
          this.armed = null;
          wake(cx);
        })
        .child(div().size(7).rounded_full().bg(this.tone(t, dot)))
        .child(TOOLS[provider]));
    }
    return seg;
  }

  banner(t, provider) {
    const s = this.switched[provider];
    const label = TOOLS[provider];
    const byLogin = provider === "claude";
    const old = byLogin ? "login" : "account";
    const box = v_flex().id(`switched-${provider}`).mx(14).p(10).gap(6).rounded(9).bg(t.selected ?? t.raised)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).font_semibold().text_size(12.5).child(byLogin ? `New ${label} launches use ${s.to}` : `${label} is now on ${s.to}`))
        .child(div().id(`switched-close-${provider}`).px(4).rounded(5).text_color(t.dim).cursor_pointer()
          .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => {
            delete this.switched[provider];
            this.armed = null;
            wake(cx);
          }).child("×")));
    const hint = (text) => box.child(div().text_size(11).text_color(t.dim).child(text));
    const look = s.look;
    if (look === "loading") hint(`New bots start on it. Looking for bots still on the old ${old}…`);
    else if (look === "no-cli") hint(`New bots start on it. Bots already running keep the old ${old} until restarted: am restart <bot>.`);
    else if (look?.error) hint(`New bots start on it. The panel couldn't list the bots (${look.error}); restart the ones that use ${label} to move them.`);
    else if (!look.bots.length) {
      hint(s.result ? `Restarted ${s.result.done}: every ${label} bot is on the new ${old}.`
        : byLogin ? `New bots start on it. Every running ${label} bot is on it already.` : `New bots start on it. No running ${label} bot started before the switch.`);
    }
    else {
      const n = look.bots.length;
      hint(byLogin ? `New bots start on it. ${n === 1 ? "This one runs" : `These ${n} run`} on another login, by how ${n === 1 ? "it was" : "they were"} launched:`
        : look.reliable ? `New bots start on it. ${n === 1 ? "This one started earlier and still uses" : `These ${n} started earlier and still use`} ${s.from ?? "the old login"}:`
        : `New bots start on it. The panel can't tell which of these ${n} ${label} bots started before the switch, so it lists them all:`);
      const chips = h_flex().gap(4).flex_wrap();
      const shown = look.bots.slice(0, 6);
      for (const b of shown) chips.child(div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).child(b.on ? `${b.name} · ${b.on}` : b.name));
      if (n > shown.length) chips.child(div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).child(`+${n - shown.length}`));
      box.child(chips);
      const armed = this.armed === `restart:${provider}`;
      const what = `Restart ${n} bot${n === 1 ? "" : "s"}`;
      box.child(this.button(t, `restart-${provider}`, s.restarting ? "Restarting…" : armed ? `${what}? Press again to confirm` : what,
        (_e, cx) => this.withRestartOffer(s, cx, () => this.restartBots(provider, cx)),
        { primary: true, small: `Each one resumes its conversation on the new ${old} where it can` }));
      const busy = s.result?.busy ?? [];
      if (s.result?.failed.length || busy.length) {
        hint(`Restarted ${s.result.done} of ${s.result.done + s.result.failed.length + busy.length}. Not restarted:`);
        for (const f of s.result.failed) box.child(div().text_size(10.5).text_color(t.working).child(f));
        // Busy (#413): its refusal as the CLI words it, and Restart when idle (pressed: Cancel).
        for (const b of busy) {
          const waiting = Boolean(s.waiting?.[b.bot.id]);
          box.child(div().text_size(10.5).text_color(t.working).child(`${b.bot.name} is busy: ${b.why}`));
          box.child(this.button(t, `idle-${provider}-${b.bot.id}`,
            waiting ? `Waiting for ${b.bot.name} · Cancel` : `Restart ${b.bot.name} when idle`,
            (_e, cx) => this.withRestartOffer(s, cx, () => this.restartWhenIdle(provider, b.bot.id, cx))));
        }
      }
    }
    if (s.result?.helpers?.length) {
      hint("Restarted, but a helper wasn't run again:");
      for (const f of s.result.helpers) box.child(div().text_size(10.5).text_color(t.working).child(f));
    }
    if (s.result?.fresh?.length) {
      hint("Started on a new conversation instead of resuming it:");
      for (const f of s.result.fresh) box.child(div().text_size(10.5).text_color(t.working).child(f));
    }
    return box;
  }

  card(t, v) {
    const now = v_flex().mx(14).p(10).gap(6).rounded(9).bg(t.raised).border_l(3)
      .border_color(v.state === "low" ? t.working : v.state === "new" ? t.border : t.done)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).child(v.headline))
        .child(this.pill(t, v.pill)));
    if (v.current && v.usage?.tracked) now.child(this.bar(t, v.usage)).child(this.meta(t, v.usage));
    now.child(div().text_size(12).text_color(this.tone(t, v.sentence.tone)).child(v.sentence.text));
    if (v.primary) {
      const target = v.primary.account;
      const go = v.provider === "claude" ? (_e, cx) => this.useLogin(v.primary.row.id, cx) : (_e, cx) => this.use(v.provider, target, cx);
      now.child(this.button(t, `primary-${v.provider}`, v.primary.label, go,
        { primary: true, small: v.primary.why }));
    }
    if (v.fine) now.child(div().text_size(10.5).text_color(t.dim).child(v.fine));
    return now;
  }

  /** A line in a tone: bad (red), warn (amber) or none (dim). */
  said(t, line) {
    return div().text_size(10.5).text_color(line.tone === "bad" ? t.blocked : this.tone(t, line.tone)).child(line.text);
  }

  /** A command shown for the person to run in a terminal, never run by the panel. */
  shownCommand(t, text) {
    return div().px(6).py(3).rounded(5).bg(t.background ?? t.raised).text_size(10.5).font_family("JetBrains Mono").child(text);
  }

  /** The Claude card's lists (#453): the logins on this Mac, the proxy's accounts not here, Add login. */
  loginList(t, v, source) {
    const list = v_flex().mx(6).gap(2);
    list.child(div().px(8).pt(2).text_size(10.5).text_color(t.dim).child(`${v.label} logins on this Mac`));
    for (const r of v.rows) {
      const line = h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(12).child(r.who));
      if (r.inUse) line.child(this.pill(t, { text: "In use", tone: "good" }));
      if (r.use) line.child(this.button(t, `login-use-${slug(r.id)}`, "Use", (_e, cx) => this.useLogin(r.id, cx)));
      if (r.remove) {
        line.child(this.button(t, `login-remove-${slug(r.id)}`, this.armed === `remove:${r.id}` ? "Remove? Press again" : "Remove",
          (_e, cx) => this.removeLogin(r.id, cx)));
      }
      const el = v_flex().id(`login-${slug(r.id)}`).px(8).py(6).gap(4).rounded(7).hover((s) => s.bg(t.hover)).child(line);
      if (r.usage.tracked) el.child(this.bar(t, r.usage));
      el.child(this.meta(t, r.usage));
      for (const l of r.lines) el.child(this.said(t, l));
      if (r.signIn) el.child(this.shownCommand(t, r.signIn));
      list.child(el);
    }
    if (v.notHere.length) {
      list.child(div().px(8).pt(6).text_size(10.5).text_color(t.dim).child(`On your CLIProxyAPI, not signed in here (${source})`));
      for (const n of v.notHere) {
        list.child(v_flex().id(`not-here-${slug(n.account.id)}`).px(8).py(6).gap(4).child(div().text_size(12).child(n.who)).child(this.meta(t, n.usage)));
      }
    }
    if (v.add) {
      const box = v_flex().id("login-add").px(8).pt(6).gap(4)
        .child(div().text_size(10.5).text_color(t.dim).child(`To add ${loginName(v.add.id)}: make ${typed(v.add.dir, home())} and its links (the mod's docs/local-logins.md, "The second sign-in"), sign in from a terminal, then press Add.`))
        .child(this.shownCommand(t, v.add.signIn))
        .child(this.button(t, "login-add-button", `Add ${loginName(v.add.id)}`, (_e, cx) => this.addLogin(cx)));
      list.child(box);
    }
    return list;
  }

  row(t, v, r) {
    const line = h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(r.who));
    if (r.next) line.child(div().px(5).h(15).flex().items_center().rounded(4).bg(t.raised).text_size(9.5).text_color(t.accent).child("next"));
    if (r.switchable) {
      line.child(this.button(t, `use-${slug(r.account.id)}`, v.state === "new" ? "Use" : "Switch",
        (_e, cx) => this.use(v.provider, r.account, cx)));
    }
    const el = v_flex().id(`acct-${slug(r.account.id)}`).px(8).py(6).gap(4).rounded(7).hover((s) => s.bg(t.hover)).child(line);
    if (r.usage.tracked) el.child(this.bar(t, r.usage));
    return el.child(this.meta(t, r.usage));
  }

  setupText() {
    return this.setup === "proxy"
      ? "This panel lists the Claude Code and Codex accounts on your own CLIProxyAPI and moves this Mac between them. Point it at yours in cliproxy.json in the Herdr app folder (see the mod's RECIPE)."
      : `No management key for your CLIProxyAPI: set $${KEY_ENV} or put it in ${KEY_FILE}.`;
  }

  render() {
    const t = theme();
    this.seen = Date.now();
    const source = instanceName(this.config);
    const root = v_flex().id("am-quota").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        const shown = size.width > 0 && size.height > 0;
        const was = this.hidden;
        this.hidden = !shown;
        // Shown again: the panel may be an hour old. Deferred, because this runs in the layout
        // pass — the read belongs on the foreground executor.
        if (was && shown) cx.timer.after(0, (cx) => this.reload(cx));
      });
    root.child(h_flex().flex_none().px(14).pt(12).gap(8).items_start()
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_semibold().child("Accounts"))
        .child(div().text_size(11).text_color(t.dim).child("Keeps your bots working when a plan hits its limit")))
      .child(div().id("am-refresh").px(4).rounded(5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.forceLogins = true; this.reload(cx); }).child("↻")));
    root.child(this.segment(t));

    const lines = v_flex().px(14).pt(8).gap(4).text_size(11.5);
    if (this.busy) lines.child(div().text_color(t.dim).child(this.busy));
    if (this.switchError) lines.child(div().text_color(t.blocked).child(this.switchError));
    if (this.loginNote && this.tool === "claude") lines.child(div().text_color(t.dim).child(this.loginNote));
    if (this.error) lines.child(div().text_color(t.blocked).child(this.error));
    if (this.quotaError && this.accounts) {
      lines.child(div().text_color(t.working).child(`${source} didn't send usage (${this.quotaError}), so no account's use is known right now`));
    }
    root.child(lines);

    const body = v_flex().pt(6).pb(10).gap(10);
    const claude = this.tool === "claude" ? this.view("claude") : null;
    if (claude?.problem) {
      // One red line naming the problem; no switch until it is fixed (section 2). The CLI never repairs it.
      body.child(div().id("logins-problem").mx(14).text_size(12).text_color(t.blocked)
        .child(`claude-logins.json ${claude.problem}: new Claude launches start on the default login until it is fixed`));
    }
    for (const e of claude?.envLines ?? []) body.child(div().mx(14).text_size(11).text_color(t.working).child(e));
    if (this.setup) body.child(div().mx(14).text_size(12).text_color(t.dim).child(this.setupText()));
    if (claude?.rows.length) {
      if (this.switched.claude) body.child(this.banner(t, "claude"));
      body.child(this.card(t, claude));
      body.child(this.loginList(t, claude, source));
    } else if (this.setup) {
      // the setup line above says what is missing
    } else if (claude) body.child(div().mx(14).text_size(12).text_color(t.dim).child("Reading the logins on this Mac…"));
    else if (!this.accounts) body.child(div().mx(14).text_size(12).text_color(t.dim).child(this.error ? "" : `Reading ${source}…`));
    else {
      const v = this.view(this.tool);
      if (this.switched[this.tool]) body.child(this.banner(t, this.tool));
      body.child(this.card(t, v));
      const list = v_flex().mx(6).gap(2);
      list.child(div().px(8).pt(2).text_size(10.5).text_color(t.dim)
        .child(`${v.state === "new" ? "" : "Other "}${v.label} accounts on ${source}`));
      if (!v.others.length) list.child(div().px(8).text_size(11).text_color(t.dim).child("None."));
      for (const r of v.others) list.child(this.row(t, v, r));
      body.child(list);
    }
    const fleet = this.fleetBlock(t, this.tool);
    if (fleet) body.child(fleet);
    const plan = this.planView(t, this.tool, claude ?? (this.accounts ? this.view(this.tool) : null));
    if (plan) body.child(plan);
    // Keep the scroll area in flow so its rows give the footer popup its body height.
    root.child(v_flex().relative().flex_1().min_h(0)
      .child(div().id("am-quota-body").flex_1().min_h(0).overflow_y_scroll().child(body))
      .child(Scrollbar.vertical("am-quota-body").absolute().inset_0()));

    const url = openUrl(this.config);
    const foot = h_flex().flex_none().px(14).py(10).gap(10).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim)
        .child(claude ? `Claude logins are the ones signed in on this Mac; usage comes from your CLIProxyAPI${this.config ? `, ${source}` : ""}.`
          : `Accounts come from your CLIProxyAPI${this.config ? `, ${source}` : ""}. To add one, sign in to it there.`));
    if (url) {
      foot.child(this.button(t, "am-open-proxy", `Open ${source}`, () => {
        exec(platform() === "macos" ? "open" : "xdg-open", [url]).catch(() => {});
      }));
    }
    root.child(foot);
    return root;
  }
}
