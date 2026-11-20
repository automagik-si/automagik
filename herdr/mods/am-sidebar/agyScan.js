// Antigravity's sidebar scan (RFC 0042): the read budget, held samples and row placement.
// Pure: the sidebar supplies its snapshots, timer and reads. Apache-2.0.
import { agyCandidate, agyPromptOf, coreStatusOf } from "./agyPrompt.js";

export const AGY_SCAN_MS = 2500;
export const AGY_READ_LINES = 40;
export const AGY_READ_MS = 2000;
export const AGY_PER_TICK = 8;
export const AGY_LOCAL_LIMIT = 4;
export const AGY_REMOTE_LIMIT = 2;
export const AGY_FAILS_TO_CLEAR = 2;

export const readable = (status) => status == null || status === "working" || status === "idle" || status === "done";

export function machineOf(address) {
  const slash = address.indexOf("/");
  return slash < 0 ? null : address.slice(0, slash);
}

export function stillCandidate(record, created, apps) {
  return Boolean(record) && record.state === "live" && record.created_ms === created
    && agyCandidate(record, apps) === true && readable(coreStatusOf(record));
}

// Compare the raw rows, including blanks and CSI. The match alone normalizes them.
export function sampleOf(text) {
  return text.replace(/\r?\n$/, "").split("\n").slice(-AGY_READ_LINES).map((line) => line.replace(/\r$/, "")).join("\n");
}

export function observe(entry, outcome, created, shapes) {
  const empty = { created, tail: null, match: null, held: null, fails: 0 };
  const base = entry && entry.created === created ? entry : empty;
  if (!outcome.ok) {
    const fails = base.fails + 1;
    return fails >= AGY_FAILS_TO_CLEAR ? empty : { ...base, fails };
  }
  const tail = sampleOf(outcome.text);
  const match = agyPromptOf(tail, shapes);
  const held = match && base.match && base.tail === tail ? match : null;
  return { created, tail, match, held, fails: 0 };
}

export function heldKey(entry) {
  const held = entry?.held;
  return held ? JSON.stringify([held.kind, held.block, held.question]) : "";
}

export function nextVisits(list, cursor, max = AGY_PER_TICK) {
  if (!list.length) return { visit: [], next: 0 };
  const start = cursor % list.length;
  const visit = Array.from({ length: Math.min(max, list.length) }, (_, i) => list[(start + i) % list.length]);
  return { visit, next: (start + visit.length) % list.length };
}

// The bot tree's status targets, including parked bots and helpers with no tab.
export function treeTerminals(tree, terminalOf = (n) => n.live?.terminal ?? null, keep = () => true) {
  const addresses = [];
  const walk = (node) => {
    if (!node) return;
    const address = terminalOf(node);
    if (address != null) addresses.push(address);
    let skipDepth = Infinity;
    for (const helper of node.helpers) {
      if (helper.depth > skipDepth) continue;
      skipDepth = Infinity;
      if (keep(helper.terminal)) addresses.push(helper.terminal);
      else skipDepth = helper.depth;
    }
    node.members.forEach(walk);
  };
  [tree.main, ...tree.categories.flatMap((c) => c.bots), ...tree.uncategorised].forEach(walk);
  return addresses;
}

// A box's bare parent id can join to a local row. The remote child belongs to neither
// displayed space for this scan.
export function crossJoined(record) {
  return typeof record?.address === "string" && record.address.includes("/")
    && typeof record.parent === "string" && record.parent !== "" && !record.parent.includes("/");
}

// Mirrors main.js coreTerminal on the fresh snapshot. Keep the two lookups in step.
export function resolvePane(records, paneTerminal, paneTab, machineNames) {
  if (!paneTerminal) return null;
  const exact = records.find((k) => k.address === paneTerminal);
  if (exact || !paneTerminal.includes("/")) return exact ?? null;
  const local = (id) => (id ?? "").split("/").pop();
  const id = local(paneTerminal), tab = local(paneTab);
  const seen = new Set();
  let hit = null;
  for (const k of records) {
    if (typeof k.address !== "string" || seen.has(k.address)) continue;
    seen.add(k.address);
    const machine = machineOf(k.address);
    if (!machine || machineNames.has(machine) || local(k.address) !== id || k.labels?.["herdr.tab"] !== tab) continue;
    if (hit) return null;
    hit = k;
  }
  return hit;
}

export function heldSpaces(place, held) {
  const spaces = new Map();
  for (const [address, space] of place) {
    if (space != null && !spaces.has(space) && held.has(address)) spaces.set(space, held.get(address).question);
  }
  return spaces;
}
