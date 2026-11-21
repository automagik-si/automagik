// Automatic sends from am use this check even when core reports the pane as working.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingDialog, rateLimitDialog, screenLines } from "./dialog.js";
import { agyCandidate, agyPromptOf } from "./agyPrompt.js";

function readRows(home, name, field, label) {
  const file = join(home, "automagik-herdr", name);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const data = JSON.parse(text);
    const rows = field ? data[field] : data;
    if (Array.isArray(rows)) return rows;
  } catch {}
  throw new Error(`Can't read ${file}: invalid ${label}`);
}

export function hasRateLimitHold(home, terminal, createdMs) {
  if (!terminal || createdMs == null) throw new Error("Cannot check a delivery hold without the pane identity.");
  const same = (row) => row?.terminal === terminal && row.created_ms === createdMs;
  return readRows(home, "queued-restarts.json", null, "restart queue")
    .some((row) => same(row) && (row.episode || row.options?.rateLimit === true))
    || readRows(home, "attention.json", "items", "attention items")
      .some((row) => same(row) && row.kind === "rate-limit" && row.open === true);
}

export function automaticDelivery(pane, homes, capture, expected = null) {
  if (pane?.state !== "live" || !pane.address || !Number.isSafeInteger(pane.created_ms)
      || (expected && (pane.address !== expected.terminal || pane.created_ms !== expected.created_ms))) {
    throw new Error("Could not identify the live terminal for automatic delivery.");
  }
  const coreBlocked = pane.status === "blocked" || pane.status?.state === "blocked";
  const held = coreBlocked || homes.some(home => hasRateLimitHold(home, pane.address, pane.created_ms));
  if (held) return { terminal: pane.address, held: true };
  if (typeof capture === "function") capture = capture();
  if (!screenLines(capture).some(line => line.trim())) throw new Error("Could not read the terminal before automatic delivery.");
  return { terminal: pane.address, held: Boolean(pendingDialog(capture) || rateLimitDialog(capture)
    || (agyCandidate(pane) && agyPromptOf(capture))) };
}
