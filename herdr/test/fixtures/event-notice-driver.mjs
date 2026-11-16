#!/usr/bin/env node
// Live driver for the event-notice shim, kept for review and for the runbook.
// This file is NOT shipped to installs: the live run uses a checkout at the sha
// quoted in the runbook (the sha256 fixture line beside this file).
//
//   node event-notice-driver.mjs <thread-id> [sha256] < events.jsonl
//
// One JSON event per stdin line (a single pretty-printed object also works).
// DRY RUN by default: prints the argv it would spawn and a paused receipt, and
// calls nothing. Set LIVE=1 to spawn the queue argv array without a shell. It
// prints one receipt line (JSON) per event, never the event's raw text, and
// exits with the documented code. It imports only eventNotice.mjs and Node's
// own modules.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildNotice,
  createSeenJournal,
  deliver,
  deliverArgv,
  exitCodeFor,
  receiptLine,
} from "../../mods/am-sidebar/eventNotice.mjs";

const threadId = process.argv[2];
const expectedSha = process.argv[3];
const live = process.env.LIVE === "1";

function refuse(reason, code = 2) {
  process.stdout.write(`${receiptLine({ event_id: null, decision: "refused", queue_id: null, reason, at: new Date().toISOString() })}\n`);
  process.exit(code);
}

if (expectedSha) {
  const actual = createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex");
  if (actual !== expectedSha) refuse("driver hash does not match the runbook");
}

const raw = readFileSync(0, "utf8").trim();
if (raw === "") refuse("event: must be one JSON object", 1);

let events;
try {
  const whole = JSON.parse(raw);
  events = Array.isArray(whole) ? whole : [whole];
} catch {
  events = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      refuse(`event ${index + 1}: must be one JSON object`, 1);
    }
  }
}
if (events.length === 0) refuse("event: must be one JSON object", 1);

const queue = (argv) => {
  if (!live) return { exit: 3 };
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: "ignore" });
  if (result.error || result.status === null) return { exit: 1 };
  return { exit: result.status, queue_id: null };
};

const readControl = () => (live ? "running" : "paused");
const seen = createSeenJournal(1000);
const run = { stopped: false };
let code = 0;

for (const event of events) {
  if (!live) {
    const notice = buildNotice(event);
    if (notice.ok) {
      const argv = deliverArgv(threadId, notice.text);
      if (Array.isArray(argv)) process.stdout.write(`argv ${JSON.stringify(argv)}\n`);
    }
  }
  const result = await deliver({
    event,
    threadId,
    queue,
    seen,
    run,
    readControl,
    threadCurrent: () => threadId,
  });
  process.stdout.write(`${receiptLine(result.receipt)}\n`);
  const decisionCode = exitCodeFor(result.receipt.decision);
  if (decisionCode !== 0) code = decisionCode;
}

process.exit(code);
