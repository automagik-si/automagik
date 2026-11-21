// Antigravity's blocked prompts (RFC 0042): the match and which terminals are Antigravity.
// Agy fires no hook while it waits for the person at its prompt. Pure: no herdr. Apache-2.0.
import { isPromptLine, screenLines } from "./dialog.js";
import { agentKeyOfArgv } from "./models.js";
import { unwrapKeep } from "./launchArgs.js";
import { isRetired } from "./retired.js";

export const AGY_KINDS = Object.freeze(["folder-trust", "file-access"]);
// Delivery 3 adds each captured shape with its fixtures under test/fixtures/agy-prompts/<version>/.
// While empty, nothing matches and the sidebar scan stays off.
export const AGY_SHAPES = Object.freeze([]);
// The literal report app names from the captures (report.app or status.app).
// A retired alias such as gemini is never one.
export const AGY_APPS = Object.freeze([]);
export const QUESTION_MAX = 200;
// A core terminal address, local or machine/tN, as in the hc guard.
export const TERMINAL_ADDRESS = /^(?:[^\s/]+\/)?t[0-9a-z]+$/;

const collapse = (row) => row.trim().replace(/\s+/g, " ");
const pattern = (re) => re instanceof RegExp && !re.global && !re.sticky;

// A shape is { kind, question, after }. Its anchored question regexp sees the trimmed,
// joined question rows with spaces collapsed. The non-empty array of anchored after
// regexps each sees one trimmed non-blank row at the bottom, in order.
export function agyPromptOf(screenText, shapes = AGY_SHAPES) {
  if (typeof screenText !== "string" || !Array.isArray(shapes)) return null;
  // hc read ends with a line terminator. It takes no slot in the 40-row screen.
  const lines = screenLines(screenText.replace(/\r?\n$/, "")).map((line) => line.replace(/\r$/, ""));
  const rows = lines.filter((line) => line.trim() !== "");
  for (const shape of shapes) {
    if (!shape || typeof shape !== "object" || !AGY_KINDS.includes(shape.kind)
      || !pattern(shape.question) || !Array.isArray(shape.after) || !shape.after.length
      || ![...shape.after].every(pattern)) continue;
    const end = rows.length - shape.after.length;
    if (end < 1) continue;
    const afterRows = rows.slice(end);
    if (!afterRows.every((row, i) => shape.after[i].test(row.trim()))) continue;
    // An earlier idle input line ends the search. A choice can itself carry the prompt glyph.
    for (let start = end - 1; start >= 0; start -= 1) {
      if (isPromptLine(rows[start])) break;
      const joined = collapse(rows.slice(start, end).join(" "));
      if (shape.question.test(joined)) {
        return { kind: shape.kind, question: joined.slice(0, QUESTION_MAX),
          block: [joined, ...afterRows.map(collapse)].join("\n") };
      }
    }
  }
  return null;
}

export function coreStatusOf(record) {
  if (typeof record?.status === "string") return record.status;
  return typeof record?.status?.state === "string" ? record.status.state : null;
}

export function reportAppOf(record) {
  const report = record?.report?.app;
  if (typeof report === "string" && report) return report;
  const status = record?.status;
  const app = typeof status === "object" ? status?.app : null;
  return typeof app === "string" && app ? app : null;
}

// Live foreground evidence wins over a report. A kept terminal's launch argv survives
// the agent, so it cannot say what is in front now.
export function agyCandidate(record, apps = AGY_APPS) {
  if (!record || typeof record !== "object") return null;
  if (record.state !== "live") return false;
  if (typeof record.address !== "string" || !TERMINAL_ADDRESS.test(record.address)
    || !Number.isFinite(record.created_ms)) return null;
  const argv = record.foreground?.argv;
  if (Array.isArray(argv) && argv.length) return agentKeyOfArgv(unwrapKeep(argv)) === "antigravity";
  const app = reportAppOf(record);
  if (!app || isRetired(app)) return null;
  return Array.isArray(apps) && apps.includes(app) ? true : null;
}
