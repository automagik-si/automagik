// Antigravity's blocked prompts (RFC 0042): the match and which terminals are Antigravity.
// Agy fires no hook while it waits for the person at its prompt. Pure: no herdr. Apache-2.0.
import { isPromptLine, screenLines } from "./dialog.js";
import { agentKeyOfArgv } from "./models.js";
import { unwrapKeep } from "./launchArgs.js";
import { isRetired } from "./retired.js";

export const AGY_KINDS = Object.freeze(["folder-trust", "file-access"]);
// The captured shapes: agy 1.5.16 on Linux, fixtures under test/fixtures/agy-prompts/1.5.16/.
// Keyed on agy's own fixed lines only: never a path, a folder name or the model row, which is a free slot.
export const AGY_SHAPES = Object.freeze([
  Object.freeze({ kind: "folder-trust",
    question: /^Do you trust the contents of this project\? Antigravity CLI requires permission to read, edit, and execute files here\.$/,
    after: Object.freeze([/^(?:> )?Yes, I trust this folder$/, /^(?:> )?No, exit$/,
      /^↑\/↓ Navigate · enter Confirm$/, /^.+$/]),
    choices: Object.freeze([0, 1]),
    free: Object.freeze([3]) }),
  Object.freeze({ kind: "file-access", question: /^Allow access to this file\?$/,
    after: Object.freeze([/^(?:> )?1\. Yes, allow access$/, /^(?:> )?2\. Yes, and always allow non-workspace access$/,
      /^(?:> )?3\. No, deny access$/, /^↑\/↓ Navigate$/, /^esc to cancel(?:\s+\S.*)?$/]),
    choices: Object.freeze([0, 1, 2]),
    context: Object.freeze([/^File access$/, /^─+$/, /^Read: \S.*$/, /^Reason: outside workspace$/]) }),
]);
// The literal report app names from the captures (report.app or status.app). The 1.5.16 capture holds no hc
// record, so none is known: identity comes from the live foreground argv alone (RFC 0042 section 2).
// A retired alias such as gemini is never one.
export const AGY_APPS = Object.freeze([]);
export const QUESTION_MAX = 200;
// A core terminal address, local or machine/tN, as in the hc guard.
export const TERMINAL_ADDRESS = /^(?:[^\s/]+\/)?t[0-9a-z]+$/;

const collapse = (row) => row.trim().replace(/\s+/g, " ");
const pattern = (re) => re instanceof RegExp && !re.global && !re.sticky;
// The selection marker agy draws on exactly one choice.
const SELECTED = /^> /;
// A dense list: an array with every index present. A sparse list makes the shape invalid.
function dense(list) {
  for (let i = 0; i < list.length; i += 1) {
    if (!Object.hasOwn(list, i)) return false;
  }
  return true;
}
const slots = (list, n) => list === undefined
  || (Array.isArray(list) && list.length > 0 && list.length <= n && dense(list)
    && list.every((i) => Number.isInteger(i) && i >= 0 && i < n) && new Set(list).size === list.length);
const contextOk = (list) => list === undefined
  || (Array.isArray(list) && list.length === 4 && dense(list) && list.every(pattern));

// context is [heading, rule, field, reason]: one fixed block right above the question, blank rows dropped
// and bounded by the visible tail. The reason row sits directly above the question; above it, the field's
// rows run up to the field row, which sits directly under the rule, which sits directly under the heading.
// A wrapped path matches while the heading is visible and no continuation resembles a structural row.
// Path rows bypass isPromptLine and stay out of the question and block. A missing, reworded or scrolled-off
// structural row makes the block a miss.
function contextAbove(rows, start, context) {
  if (context === undefined) return true;
  const [heading, rule, field, reason] = context;
  const at = (i) => (i >= 0 ? rows[i].trim() : "");
  if (!reason.test(at(start - 1))) return false;
  for (let i = start - 2; i >= 2; i -= 1) {
    const row = at(i);
    if (field.test(row)) return rule.test(at(i - 1)) && heading.test(at(i - 2));
    if (heading.test(row) || rule.test(row) || reason.test(row) || /^(?:Read|Reason):/.test(row)) return false;
  }
  return false;
}

// A shape is { kind, question, after, choices?, free?, context? }. Its anchored question regexp sees the
// trimmed, joined question rows with spaces collapsed. The non-empty array of anchored after regexps each
// sees one trimmed non-blank row at the bottom, in order. `choices` (a dense list of distinct indexes into
// after): exactly one of those rows carries the selection marker. `free` (the same kind of list): a free
// slot, such as the model row, is never an idle input line (the shared isPromptLine). `context`: see
// contextAbove. A malformed shape is skipped.
export function agyPromptOf(screenText, shapes = AGY_SHAPES) {
  if (typeof screenText !== "string" || !Array.isArray(shapes)) return null;
  // hc read ends with a line terminator. It takes no slot in the 40-row screen.
  const lines = screenLines(screenText.replace(/\r?\n$/, "")).map((line) => line.replace(/\r$/, ""));
  const rows = lines.filter((line) => line.trim() !== "");
  for (const shape of shapes) {
    if (!shape || typeof shape !== "object" || !AGY_KINDS.includes(shape.kind)
      || !pattern(shape.question) || !Array.isArray(shape.after) || !shape.after.length
      || ![...shape.after].every(pattern) || !slots(shape.choices, shape.after.length)
      || !slots(shape.free, shape.after.length) || !contextOk(shape.context)) continue;
    const end = rows.length - shape.after.length;
    if (end < 1) continue;
    const afterRows = rows.slice(end);
    if (!afterRows.every((row, i) => shape.after[i].test(row.trim()))) continue;
    if ((shape.free ?? []).some((i) => isPromptLine(afterRows[i]))) continue;
    if (shape.choices && shape.choices.filter((i) => SELECTED.test(afterRows[i].trim())).length !== 1) continue;
    // An earlier idle input line ends the search. A choice can itself carry the prompt glyph.
    for (let start = end - 1; start >= 0; start -= 1) {
      if (isPromptLine(rows[start])) break;
      const joined = collapse(rows.slice(start, end).join(" "));
      if (shape.question.test(joined)) {
        if (!contextAbove(rows, start, shape.context)) break;
        // The 200-character limit is on the question alone: no context, path or rule is in it.
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
