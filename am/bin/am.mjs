// am, the one Automagik command (RFC 0012). Bot verbs (ls show create edit rm start attach detach
// whois brief worker category …) run the CLI copy beside this file, bin/automagik-herdr.mjs, in
// this process: their output is byte for byte `automagik-herdr`'s. am's own verbs:
//
//   am update [automagik.am | herdr.pack] [--check] [--json]   am from am-lane first, then the pack
//                                                              (where one is installed)
//   am update --rollback | --retry-skipped | --auto on|off|status   the pack CLI's update, as given
//   am rollback automagik.am | herdr.pack [--json]             back to the kept previous one
//   am self install | uninstall [--purge] | doctor [--json]    am's part entries (part.json)
//   am help                                                    this, then the Bot verbs
//
// Every one takes --json (one JSON value) and exits 0 done or healthy, 1 failed or broken, 2 not
// applicable (a usage error, an id am does not handle yet). Run through bin/am (run.sh finds node
// 22.7+ or bun). Apache-2.0.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POCKET, pocketMain, updatePocket } from "../pocket/pocket.mjs";
import { linkedUpdate } from "../machineUpdates.js";
import { PART } from "../lib/lane.mjs";
import { OWN_DIR, appHomeOf, doctorSelf, installExtract, installSigned, rollbackSelf, storeOf, uninstallSelf, updateSelf } from "../lib/self.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "automagik-herdr.mjs");
const PACK = "herdr.pack";

const HELP = `am: Automagik's one command (RFC 0012)

Usage: am <command> [options]

  update [automagik.am | herdr.pack] [--check] [--json]
                                am first, from the signed am-lane (checksum and signature
                                checked; never an older one), then the herdr pack where
                                one is installed; automagik.am includes an installed Pocket Link;
                                herdr.pack updates the pack alone
  update --rollback | --retry-skipped | --auto on|off|status
                                the herdr pack's own switches (update, below)
  rollback automagik.am | herdr.pack [--json]
                                back to the version each keeps (am: its previous copy)
  self install [--signed <folder>] | uninstall [--purge] | doctor [--json]
                                am's own part: install this copy and link am and
                                automagik-herdr; hand the links back; check them

  pocket pair [--minutes N] [--state DIR]
                                pair from an interactive terminal
  pocket link status|on|off|forget|reset|install|uninstall|doctor
                                manage Pocket Link on this computer
  install | uninstall | doctor pocket.link
                                Pocket Link's part entries; --purge erases pairings

Update and rollback exit 1 when any part failed.

Every other command:
`;

class Usage extends Error {}

/** Splits `args` into the words and the flags in `known` (true when given). */
function parse(args, known) {
  const flags = {};
  const words = [];
  for (const a of args) {
    if (a.startsWith("--")) {
      if (!known.includes(a)) throw new Usage(`unknown option ${a}`);
      flags[a.slice(2)] = true;
    } else words.push(a);
  }
  return { words, flags };
}

/** The CLI copy of the installed am (current), else this one's. */
const installedCli = () => {
  const cli = join(storeOf(), "current", "bin", "automagik-herdr.mjs");
  return existsSync(cli) ? cli : CLI;
};

/** Runs the CLI copy as its own program; with `json`, returns its parsed stdout. */
function cli(args, { json = false } = {}) {
  const r = spawnSync(process.execPath, [installedCli(), ...args], { stdio: json ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  let value = null;
  if (json) { try { value = JSON.parse(r.stdout); } catch { value = r.stdout.trim() || null; } }
  return { code: r.status ?? 1, value };
}

const worst = (a, b) => a === 1 || b === 1 ? 1 : b || a;
const say = (text) => process.stdout.write(`${text}\n`);
const lineOf = (r) => ({
  none: `am: ${r.detail}; am stays at ${r.from ?? "this copy"}.`,
  current: `am ${r.to} is the newest.`,
  available: `am ${r.to} is out (installed: ${r.from ?? "none"}); am update installs it.`,
  updated: `Updated am ${r.from ?? "(none)"} → ${r.to}. The replaced one is kept: am rollback automagik.am puts it back.`,
}[r.state]);

/** The pack's own update switches (rollback, retry a skipped release, automatic updates): forwarded as given. */
const PACK_SWITCH = /^--(?:rollback|auto|retry-skipped)(?:=|$)/;
/** What may stand beside them: their own switches and the pack update's --check and --json. Any other word is a target. */
const PACK_FLAG = /^--(?:(?:rollback|auto|retry-skipped)(?:=.*)?|check|json)$/;

async function update(args) {
  if (args.some((a) => PACK_SWITCH.test(a))) {
    // The pack's own switches act on the pack only: a named other part (am itself) is refused.
    // The only word allowed besides the switches is the pack's own id (--auto's value, as in
    // --auto status, is no word of this kind).
    const named = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--auto") i++;
      else if (!args[i].startsWith("-") || !PACK_FLAG.test(args[i])) named.push(args[i]);
    }
    const otherTargets = named.filter((a) => a !== PACK);
    if (otherTargets.length) {
      const target = otherTargets.join(" ");
      if (args.some((a) => /^--retry-skipped(?:=|$)/.test(a))) {
        throw new Usage(`--retry-skipped is ${PACK}'s own update, not ${target}'s (am update ${PACK} --retry-skipped)`);
      }
      throw new Usage(`--rollback and --auto are ${PACK}'s own update, not ${target}'s (am update ${PACK} --rollback)`);
    }
    return cli(["update", ...args]).code;
  }
  const { words, flags } = parse(args, ["--check", "--json"]);
  const [id, extra] = words;
  if (extra || (id && id !== PART && id !== PACK)) throw new Usage(`am update takes ${PART} or ${PACK}, not ${words.join(" ")}`);
  const out = {};
  let code = 0;
  if (id !== PACK) {
    try {
      out.am = await updateSelf({ check: Boolean(flags.check) });
      if (!flags.json) say(lineOf(out.am));
    } catch (e) {
      out.am = { state: "failed", detail: e.message };
      code = 1;
      if (!flags.json) process.stderr.write(`am update: ${e.message}\n`);
    }
  }
  // The pack only where one is installed (its marker, or a sidebar folder from before the marker):
  // on a machine without it (work only), `am update` is am's alone.
  const packInstalled = [["automagik-herdr", "installed-by-install.sh"], ["mods", "am-sidebar"], ["mods", "spaces-agents"]]
    .some((p) => existsSync(join(appHomeOf(), ...p)));
  if (id === PACK && !packInstalled) {
    out.pack = { state: "not-installed" };
    if (!flags.json) process.stderr.write("am update: the herdr pack is not installed on this machine\n");
    code = 2;
  } else if (id !== PART && !packInstalled) {
    out.pack = { state: "not-installed" };
  } else if (id !== PART) {
    const r = cli(["update", ...(flags.check ? ["--check"] : []), ...(flags.json ? ["--json"] : [])], { json: Boolean(flags.json) });
    out.pack = r.value;
    code = worst(code, r.code);
  }
  if (id !== PACK && !flags.check && !linkedUpdate(process.env)) {
    out.pocket = await updatePocket();
    if (out.pocket.state !== "not-installed" && !flags.json) say(out.pocket.detail);
    code = worst(code, out.pocket.state === "failed" ? 1 : 0);
  }
  if (flags.json) say(JSON.stringify(out));
  return code;
}

async function rollback(args) {
  const { words, flags } = parse(args, ["--json"]);
  if (words.length !== 1) throw new Usage(`am rollback takes one id: ${PART} or ${PACK}`);
  if (words[0] === PACK) return cli(["update", "--rollback", ...(flags.json ? ["--json"] : [])]).code;
  if (words[0] !== PART) {
    if (flags.json) say(JSON.stringify({ part: words[0], ok: false, detail: "am cannot roll this part back yet" }));
    else process.stderr.write(`am rollback: ${words[0]} is not a part am handles yet (${PART}, ${PACK})\n`);
    return 2;
  }
  try {
    const r = rollbackSelf();
    const pocket = await updatePocket();
    if (flags.json) say(JSON.stringify({ part: PART, ok: true, changed: true, detail: r, pocket }));
    else {
      say(`Rolled am back ${r.from} → ${r.to}. am update moves it forward again.`);
      if (pocket.state !== "not-installed") say(pocket.detail);
    }
    return pocket.state === "failed" ? 1 : 0;
  } catch (e) {
    if (flags.json) say(JSON.stringify({ part: PART, ok: false, changed: false, detail: e.message }));
    else process.stderr.write(`am rollback: ${e.message}\n`);
    return 1;
  }
}

function self(args) {
  const { words, flags } = parse(args, ["--json", "--purge", "--signed"]);
  const [what, folder, extra] = words;
  if (flags.signed ? what !== "install" || !folder || flags.purge : folder !== undefined) {
    throw new Usage("am self install --signed takes one folder holding the signed pointer and tarball");
  }
  if (extra || !["install", "uninstall", "doctor"].includes(what)) throw new Usage("am self takes install, uninstall or doctor");
  if (what === "doctor") {
    const { lines, code } = doctorSelf();
    for (const l of lines) say(flags.json ? JSON.stringify(l) : `${l.ok ? "ok  " : "FAIL"} ${l.check}: ${l.detail}${l.fix ? ` (fix: ${l.fix})` : ""}`);
    return code;
  }
  try {
    if (flags.signed) {
      const result = installSigned(folder);
      say(flags.json ? JSON.stringify(result) : `am: ${result.state} ${result.version}${result.cleanup ? ` (${result.cleanup})` : ""}`);
      return 0;
    }
    const detail = what === "install"
      ? installExtract(OWN_DIR, { sequence: null, signed: false, source: realpathSync(OWN_DIR) })
      : uninstallSelf({ purge: Boolean(flags.purge) });
    if (flags.json) say(JSON.stringify({ part: PART, ok: true, changed: true, detail }));
    else {
      if (what === "install") say(`am ${detail.version} is installed in ${storeOf()}.`);
      for (const l of detail.links) say(`${l.link}: ${l.state}${l.detail ? ` (${l.detail})` : ""}`);
      if (detail.entry?.path) say(`${detail.entry.path}: ${detail.entry.state}`);
    }
    return 0;
  } catch (e) {
    if (flags.json) say(JSON.stringify({ part: PART, ok: false, changed: false, ...(flags.signed ? { state: e.state ?? "failed" } : {}), detail: e.message }));
    else process.stderr.write(`am self ${what}: ${e.message}\n`);
    return 1;
  }
}

/** Runs the CLI copy in this process, as the program node started (its stdin, env and exit code). */
async function forward(args) {
  const target = realpathSync(CLI);
  process.argv = [process.argv[0], target, ...args];
  await import(pathToFileURL(target).href);
}

async function main(args) {
  const [verb, ...rest] = args;
  const partVerb = ["install", "uninstall", "doctor"].includes(verb);
  const ownVerb = partVerb || ["update", "rollback", "self", "help", "--help", "-h", "pocket"].includes(verb);
  if (ownVerb
    && rest.some((word) => word === "--local-only" || word.startsWith("--local-only="))) {
    const error = "--local-only goes with am start <bot-id> --project DIR only.";
    process.stderr.write(`am: ${error}\n`);
    if (rest.includes("--json")) say(JSON.stringify({ error, refused: "usage" }));
    return 2;
  }
  try {
    if (ownVerb) {
      for (const word of rest) {
        if (word === "--") break;
        if (/^--confirm(?:=|$)/.test(word)) throw new Usage("--confirm goes with am proxy approve only.");
      }
    }
    if (verb === "update") return await update(rest);
    if (verb === "rollback") return await rollback(rest);
    if (verb === "pocket") return await pocketMain(rest);
    if (partVerb) {
      const id = rest.find(arg => !arg.startsWith("--"));
      if (id !== POCKET) throw new Usage(`${id ?? "This command needs a part id"} is not a part am installs yet (RFC 0012 delivery 3)`);
      return await pocketMain(["link", verb, ...rest.filter((_, i) => i !== rest.indexOf(id))]);
    }
    if (verb === "self") return self(rest);
    if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
      // #1208: --agent-home starts one worker (am worker "<task>"); help with it is refused, never ignored.
      if (rest.some((w) => w === "--agent-home" || w.startsWith("--agent-home="))) {
        throw new Usage("--agent-home goes with am worker \"<task>\" only: it starts one new worker on a chosen login folder");
      }
      process.stdout.write(HELP);
      await forward(["--help"]);
      return null;
    }
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    process.stderr.write(`am: ${e.message} (am help)\n`);
    return 2;
  }
  await forward(args);
  return null;
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
