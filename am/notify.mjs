// `am notify`: JSON lines on stdin, one event each, passed one by one to the event-notice shim
// (eventNotice.mjs: strict schema, refusal with zero calls, the fixed template, dedupe, pause and
// stop). One receipt line (JSON) per input line on stdout, never the line's own text. The queue
// call, the control read, the thread check and the clock are injected: this module spawns
// nothing, opens no file and reaches no network.
//
// Exit codes (NOTIFY_EXIT); a run reports its most severe outcome, io over failed over refused:
//   0  every line queued, deduped, suppressed, paused or stopped; also an input with no lines
//   1  at least one line refused (malformed JSON, too long, outside the schema, a thread refusal),
//      each with zero queue calls; the lines after it still run
//   2  a usage mistake (the CLI's own code; this module never returns it)
//   3  reading the input (or writing a receipt) threw: reading stops, the lines before keep
//      their receipts
//   4  at least one queue call failed (it threw or exited nonzero)
//
// A blank line is skipped with no receipt. A stop ends the run after its own receipt: the lines
// after it are not read. Dedupe holds within one run (a bounded journal), not across runs.
// Apache-2.0.

import { createSeenJournal, deliver, receiptLine } from "./eventNotice.mjs";

export const NOTIFY_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2, io: 3, failed: 4 });
export const MAX_LINE = 65536;

const SEVERITY = new Map([[0, 0], [1, 1], [4, 2], [3, 3]]);

function stamp(now) {
  try {
    const value = typeof now === "function" ? now() : undefined;
    if (typeof value === "string" && value.length > 0 && !value.includes("\n")) return value;
  } catch { /* the clock is a hint: fall back to the system one */ }
  return new Date().toISOString();
}

function refusedLine(number, reason, now) {
  return { event_id: null, decision: "refused", queue_id: null, reason: `line ${number}: ${reason}`, at: stamp(now) };
}

function lineItem(number, text, maxLine) {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (line.length > maxLine) return { number, tooLong: true };
  return line.trim() === "" ? null : { number, text: line };
}

/**
 * The lines of `input` (an async iterable of strings or byte chunks), as { number, text } or
 * { number, tooLong: true }. UTF-8 is decoded across chunk boundaries; a trailing "\r" is dropped.
 * A line is refused as too long as soon as it passes `maxLine` characters, before its newline
 * arrives, and the rest of it is dropped unbuffered. Blank lines are skipped but counted, so a
 * receipt's line number is the input's own.
 */
export async function* jsonLines(input, maxLine = MAX_LINE) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let number = 0;
  let skipping = false;
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (skipping) {
        skipping = false;
      } else {
        number += 1;
        const item = lineItem(number, text, maxLine);
        if (item) yield item;
      }
      at = buffer.indexOf("\n");
    }
    if (skipping) {
      buffer = "";
    } else if ((buffer.endsWith("\r") ? buffer.length - 1 : buffer.length) > maxLine) {
      number += 1;
      skipping = true;
      buffer = "";
      yield { number, tooLong: true };
    }
  }
  buffer += decoder.decode();
  if (!skipping && buffer.length > 0) {
    const item = lineItem(number + 1, buffer, maxLine);
    if (item) yield item;
  }
}

/**
 * Runs every line of `input` through the shim. `write(text)` takes each receipt line; `queue`,
 * `readControl`, `threadCurrent`, `threadExists` and `now` go to deliver() as they are.
 * Resolves with { code, lines, stopped }: `lines` counts the receipts written.
 */
export async function runNotify(options = {}) {
  const { input, write, queue, threadId, readControl, threadCurrent, threadExists, now } = options;
  const seen = options.seen ?? createSeenJournal(1000);
  const maxLine = options.maxLine ?? MAX_LINE;
  const run = { stopped: false };
  let code = NOTIFY_EXIT.ok;
  let lines = 0;
  const raise = (next) => {
    if (SEVERITY.get(next) > SEVERITY.get(code)) code = next;
  };
  try {
    for await (const item of jsonLines(input, maxLine)) {
      let receipt;
      if (item.tooLong) {
        receipt = refusedLine(item.number, `longer than ${maxLine} characters`, now);
      } else {
        let event;
        try {
          event = JSON.parse(item.text);
        } catch {
          receipt = refusedLine(item.number, "must be one JSON object", now);
        }
        if (!receipt) {
          const result = await deliver({ event, threadId, queue, seen, run, readControl, threadCurrent, threadExists, now });
          receipt = result.receipt;
        }
      }
      write(`${receiptLine(receipt)}\n`);
      lines += 1;
      if (receipt.decision === "refused") raise(NOTIFY_EXIT.refused);
      if (receipt.decision === "failed") raise(NOTIFY_EXIT.failed);
      if (run.stopped) break;
    }
  } catch {
    raise(NOTIFY_EXIT.io);
  }
  return { code, lines, stopped: run.stopped };
}
