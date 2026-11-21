// The panel passes account data in private request files. The command line carries only
// the request id and the fields the CLI uses to check the decision it is applying.
import { cmp, confirmedClaude, FLAGS, idDigest, isClaudeKey, isCodexKey, LOCAL, MODES, own, PENDING_WHY, snapshotOf } from "./accountsPlanRecord.js";
import { planWords } from "./fleet.js";
import { sha256Hex } from "./sha256.js";

export function planArgs(op, { id, rev, tool, n, owner, snapshot, generation, intended, proxy, stamp, confirmForget } = {}) {
  switch (op) {
    case "show": return ["plan", "--show"];
    case "request": return ["plan", "--request", id];
    case "commit": return ["plan", "--commit", id, "--expect-rev", String(rev), ...(confirmForget ? ["--confirm-forget"] : [])];
    case "start-local": return ["plan", "--start-local", tool, "--owner", owner, "--expect-rev", String(rev), "--evidence", id];
    case "write-local": return ["plan", "--write-local", tool, "--attempt", String(n), "--owner", owner, "--snapshot", snapshot];
    case "fence-local": return ["plan", "--fence-local", tool, "--attempt", String(n), "--owner", owner,
      "--generation", generation ?? "none", "--intended", intended, "--proxy", proxy];
    case "install-local": return ["plan", "--install-local", tool, "--attempt", String(n), "--owner", owner,
      "--expect-rev", String(rev), "--intended", intended, "--stamp", stamp];
    case "record-local": return ["plan", "--record-local", tool, "--attempt", String(n), "--owner", owner, "--outcome", id];
    case "fail-local": return ["plan", "--fail-local", tool, "--expect-rev", String(rev), "--outcome", id];
    case "suspend-local": return ["plan", "--suspend-local", tool, "--expect-rev", String(rev)];
    default: throw new Error("unknown plan operation");
  }
}

const REFUSALS = {
  stale: "The plan changed since this preview: look again.",
  busy: "Machines are being switched now: press again once that is done.",
  "busy-local": "This Mac is being switched now: press again once that is done.",
  expired: "This preview is too old: look again.",
  "read-again": "Read the remaining machines and preview this change again.",
  "newer-plan": "This plan was written by a newer version: update this Mac's sidebar.",
};
const ERRORS = ["bad-request", "no-home", "no-plan", "exists", "held", "unknown-machine", "not-member",
  "member", "not-changed", "not-gone", "too-many", "missing", "claimed", "not-pending", "not-done",
  "changed", "conflict", "slot-changed", "off", "stopped", ...PENDING_WHY, ...Object.keys(REFUSALS)];

export const planError = (code) => ERRORS.includes(code) ? code : "failed";
export const refusalWords = (code) => own(REFUSALS, code) ?? `The plan wasn't changed (${planError(code)}).`;

export function localResult(tool, attempt, read, { recovering = false, snapshot } = {}) {
  const done = (placed) => ({ state: "done", why: null, read, ...(placed ? { placed } : {}) });
  const changed = { state: "changed", why: "changed", read: read.home === attempt.home ? read : null };
  const lost = { state: "lost", why: "lost", read };
  const failed = { state: "failed", why: "failed", read };
  if (attempt.home !== read.home) return changed;
  if (tool === "claude") {
    const observed = snapshotOf(read);
    if (recovering && attempt.after && (observed !== attempt.after || read.email !== attempt.assign)) return changed;
    if (confirmedClaude(read) === attempt.assign) return done();
    if (idDigest(read.effective, read.email ?? "", sha256Hex) !== attempt.effDigest) return changed;
    if (recovering && observed === attempt.before) return lost;
    return observed === (snapshot ?? attempt.after) ? failed : changed;
  }
  if (read.proxy !== attempt.proxy) return changed;
  if (attempt.fencedAt && read.generation === attempt.intended) {
    return read.account ? done({ name: attempt.assign, proxy: attempt.proxy, account: read.account,
      generation: attempt.intended }) : failed;
  }
  return recovering && !attempt.installStarted && read.generation === attempt.before ? lost : changed;
}

const PENDING_LINES = {
  away: "away: it takes it when it is back",
  "no-cli": "no am or sidebar there",
  "old-cli": "its am or sidebar is older than this needs",
  timeout: "it didn't answer",
  lost: "the switch there wasn't confirmed: it will be read again",
  rebound: "its name now points at another machine: it will be read again",
  conflict: "another change landed there first: it will be read again",
  "no-core": "that machine couldn't confirm which machine it is (no core answered, or more than one runs there): nothing was changed there",
  "proxy-url": "the proxy's address in cliproxy.json carries more than an address: nothing was placed",
  busy: "it is busy: it will be read again",
  unreachable: "it couldn't be reached",
  "bad-answer": "its answer couldn't be read",
  "no-account-id": "the proxy's credential names no account",
  failed: "the switch wasn't confirmed",
  ambiguous: "two logins there are one account",
};

const modeWords = { one: "One account", pinned: "Pinned", spread: "Spread" };
const action = (id, label, request) => ({ id, label, request });

/** The words and actions are derived from the observations the rows already use. */
export function planBlock({ plan: stored, preview, rows, tool, accounts, verdict, linked, error }) {
  const { state, plan } = stored;
  if (state === "absent" && !linked && !preview && !error) return null;
  const readOnly = state === "newer";
  const shown = plan ?? (readOnly ? stored.view ?? null : null);
  const section = shown?.[tool];
  const names = new Map(rows.map((row) => [row.machine, row.name]));
  const label = (key) => key === null ? "an unknown account" :
    tool === "claude" ? key : accounts.labels.get(key) ?? "an unknown account";
  const options = (keys) => [...new Set(keys)].sort(cmp);
  const current = options(rows.flatMap((row) => row.eligible));
  const head = [], buttons = [], list = [];
  if (error) head.push(refusalWords(error));
  if (readOnly && error !== "newer-plan") head.push(refusalWords("newer-plan"));
  if (!section && !readOnly) {
    if (state === "corrupt") head.push("The plan can't be read: Manage across machines starts a new one.");
    buttons.push(action("manage", "Manage across machines", { kind: "manage" }));
    head.push("Pins every machine to the account it is proven on. Nothing moves.");
  } else if (section) {
    head.push(section.mode === "one" ? `Plan: one account (${label(section.account)})`
      : section.mode === "pinned" ? "Plan: each machine pinned" : "Plan: spread evenly");
    if (tool === "claude") for (const [machine, at] of Object.entries(shown.exposures ?? {})) {
      head.push(`${machine} (${at.slice(0, 10)}): a login switch sent there may still land.`);
      if (!readOnly) buttons.push(action(`dismiss-${machine}`, `Dismiss warning for ${machine}`, { kind: "dismiss-exposure", machine }));
    }
    if (!readOnly) {
      const preferred = own(section.assign, LOCAL) ?? Object.values(section.assign).find((key) => current.includes(key));
      const first = current.includes(preferred) ? preferred : current[0];
      for (const mode of MODES) {
        buttons.push(action(mode, modeWords[mode], mode === section.mode || mode === "one" && !first ? null
          : { kind: "mode", tool, mode, ...(mode === "one" ? { account: first } : {}) }));
      }
      if (section.mode === "spread") buttons.push(action("spread-again", "Spread again", { kind: "spread-again", tool }));
      if (section.mode === "one") for (const [i, account] of current.entries()) {
        buttons.push(action(`account-${i}`, `Use ${label(account)} everywhere`, { kind: "account", tool, account }));
      }
      if (verdict?.from && verdict.to && Object.values(section.assign).includes(verdict.from)) {
        buttons.push(action("move-off", `Preview moving machines off ${label(verdict.from)}`,
          { kind: "move-off", tool, account: verdict.from, to: verdict.to }));
      }
    }
    for (const row of rows) {
      const { machine, name, actions, eligible, read, writer } = row;
      if (row.code === "held") continue; // The linked block already shows the read-only row.
      const controls = [], lines = [];
      if (!readOnly) {
        const offer = (id, words, kind, fields = {}) => controls.push(action(id, words, { kind, tool, machine, ...fields }));
        const pin = own(section.pin, machine);
        if (row.member && !["gone", "changed"].includes(row.state)) {
          for (const [i, account] of eligible.entries()) {
            if (account !== pin) offer(`pin-${i}`, `Pin to ${label(account)}`, "pin", { account });
          }
          if (pin) offer("unpin", "Unpin", "unpin");
        }
        if (actions.includes("add")) offer("add", "Add to the plan", "add");
        const placement = row.wanted ?? (section.mode === "one" ? section.account
          : section.mode === "spread" ? [...eligible].sort(cmp)[0] : null);
        const places = placement ? eligible.filter((key) => key === placement) : eligible;
        if (actions.includes("place")) for (const [i, account] of places.entries()) {
          offer(`place-${i}`, `Place ${label(account)} on this Mac`, "add", { account });
        }
        if (actions.includes("adopt")) offer("adopt", "Adopt", "adopt");
        if (actions.includes("reapply")) offer("reapply", "Re-apply the plan", "reapply");
        if (actions.includes("forget")) controls.push(action("forget", "Forget", { kind: "forget", machine }));
        if (actions.includes("rebind")) for (const target of rows.filter((r) => r.machine !== LOCAL && !r.member && r.connected)) {
          controls.push(action(`rebind-${target.machine}`, `Rebind to ${target.name}`, { kind: "rebind", from: machine, to: target.machine }));
        }
        if (actions.includes("move-off")) {
          const to = current.find((key) => key !== row.wanted);
          if (to || section.mode !== "one" || section.account !== row.wanted) {
            offer("move-off", `Preview moving ${name} off ${label(row.wanted)}`, "move-off",
              { account: row.wanted, ...(to ? { to } : {}) });
          }
        }
      }
      if (row.state === "no-login" && tool === "claude") {
        if (!own(section.secondLogin, machine)) {
          if (!readOnly) controls.push(action("second-login", `Allow a second login on ${name}`, { kind: "second-login", machine, allow: true }));
        } else if (!read?.nextSlot) {
          lines.push("sign in a second login there, then add it in that machine's Accounts panel");
        } else {
          lines.push("then add it in that machine's Accounts panel");
        }
      }
      if (row.code === "update-first" && writer?.panel === "on" && writer.panelWrites && writer.sidebarWrites && !writer.confirmed) {
        lines.push("update this machine first: open Herdr there once so its Accounts panel can confirm it, or switch that panel off");
      } else if (Object.hasOwn(PENDING_LINES, row.code)) lines.push(PENDING_LINES[row.code]);
      else if (row.code === "not-eligible") lines.push(`${label(row.wanted)} can't be used there`);
      const words = row.member ? planWords({ ...row, account: row.account && label(row.account), wanted: row.wanted && label(row.wanted) })
        : actions.includes("add") || tool === "codex" ? "not in the plan" : "read it again first";
      list.push({ machine, name, words, lines, controls, readAgain: !readOnly && !row.member && tool === "claude" && !actions.includes("add"),
        command: !readOnly && row.state === "no-login" && own(section.secondLogin, machine) && read?.nextSlot
          ? `CLAUDE_CONFIG_DIR='${read.nextSlot.replace(/'/g, "'\\''")}' claude auth login` : null });
    }
  }
  return { head, buttons, rows: list, preview: preview && previewWords(preview, names, accounts.labels) };
}

const ROUTES = {
  failed: "a login this read couldn't confirm", timeout: "a login that didn't answer",
  "not-signed-in": "a signed-out login", override: "a sign-in set by the launch environment",
  ambiguous: "a login this read couldn't distinguish", unread: "a login this read couldn't confirm",
};
const routeWords = (word) => isClaudeKey(word) ? word : own(ROUTES, word) ?? "a login this read couldn't confirm";

function previewWords(preview, names, labels) {
  const lines = [], buttons = [];
  if (preview.request?.kind === "dismiss-exposure") lines.push(`Dismiss the warning for ${preview.request.machine}.`);
  const acct = (tool, key) => tool === "claude" && isClaudeKey(key) ? key
    : tool === "codex" && isCodexKey(key) ? labels.get(key) ?? "an unknown account" : "an unknown account";
  for (const change of preview.changes) {
    const { tool, name, machine, join, pin, assign, observed, routes, exceptions } = change;
    names.set(machine, name);
    const wanted = acct(tool, assign[1]);
    if (join) lines.push(`${name}: joins the plan${assign[1] ? ` on ${wanted}` : ""}`);
    if (pin) lines.push(pin[1] ? `${name}: pinned to ${acct(tool, pin[1])}` : `${name}: pin removed`);
    if (!join && assign[0] !== assign[1] && assign[1] === null) lines.push(`${name}: leaves the plan`);
    if (tool === "claude" && machine !== LOCAL && (join || preview.moves.some((move) => move.tool === tool && move.machine === machine))) {
      if (change.home) lines.push(`${name}: uses its managed app home for these launches`);
      lines.push(`${name}: ${routes?.next?.start === "unresolved"
        ? "Its next start from here uses this Mac's own command, which this read doesn't follow"
        : `Its next start or restart from here starts ${routeWords(routes?.next?.start)}`}; a tree restart there starts ${routeWords(routes?.next?.tree)}.`);
    }
    for (const { project: path, why } of exceptions) {
      const project = path.split("/").filter(Boolean).at(-1) ?? "This project";
      lines.push(why === "own-app-home" ? `${project} uses its own app home: not managed` :
        why === "default-app-home" ? `${project} uses the default app home: not managed` :
        why === "own-path" ? `${project} sets its own PATH: not managed` : `${project}'s launch settings couldn't be read: not managed`);
      lines.push(`except ${project}, which starts as before`);
    }
    if (assign[1] && !join && observed === assign[1] && !pin) lines.push(`${name}: on ${wanted}`);
  }
  for (const { tool, machine, name, from, to } of preview.moves) {
    lines.push(`${name}: ${acct(tool, from)} → ${acct(tool, to)}`);
    names.set(machine, name);
  }
  let readAgain = false;
  for (const { tool, machine, code, account } of preview.flags) {
    if (!FLAGS.includes(code)) continue;
    const name = names.get(machine) ?? machine;
    const flag = {
      unmanaged: "not in the plan", "no-login": `no login of ${acct(tool, account)} there: it stays`,
      "not-eligible": `${acct(tool, account)} can't be used there: it stays`,
      "pin-not-eligible": `${acct(tool, account)} can't be used there: it stays`,
      "nothing-eligible": "no eligible account there: it stays", "no-pin": "no pin: it stays",
      away: PENDING_LINES.away, "update-first": "update this machine first",
      "suspended-stays": "changed on the machine: it stays until you choose",
      "pinned-stays": "pinned: it stays", held: "Codex isn't moved on other machines yet.",
      "read-again": "read it again first", "open-dispatch": "a login switch sent there may still land",
    }[code];
    if (flag) lines.push(`${name}: ${flag}`);
    if (code === "pinned-stays") buttons.push(action(`include-${machine}`, `Include ${name}`, { include: machine }));
    if (code === "read-again") readAgain = true;
  }
  return { lines, buttons, readAgain, confirmForget: preview.flags.some(({ code }) => code === "open-dispatch"),
    blocked: preview.flags.some(({ code }) => code === "one-incomplete") };
}
