// A visible question, permission or selection dialog on a pane's screen, and the prompt
// helpers that tell one from an idle agent prompt. The restart planner and the hc wrappers
// share it (#805, #1414): a dialog belongs to the person at the pane, so the pack never answers
// it, and a send must not be pasted into it as that person's answer. Pure: no herdr and no
// imports, so the tests and the CLI share it. Apache-2.0.

/** Only the visible tail matters: old scrollback is not a current prompt or dialog. */
export const screenLines = (text) => typeof text === "string" ? text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").slice(-40) : [];

const CONFIRM_FOOTER = /\[y\/n\]|\(y\/n\)|enter to confirm|esc to cancel/i;
const NUMBERED_DIALOG_CHOICE = /^\s*(?:[>❯›]\s*\d+[.)]\s+|\d+[.)]\s+(?:yes\b|no\b|allow\b|deny\b|proceed\b|cancel\b|skip\b))/i;
const DIALOG_HEADER = /\?|^\s*(?:choose|select|pick|allow|run|do you|would you|are you sure)\b/i;
const DIALOG_QUESTION = /(?:run this command\?|do you want to (?:proceed|make this edit|create|delete|run|execute|allow|overwrite)\b.*\?|would you like to run the following command\?|do you trust the contents of\b.*\?|requesting permission for:|^\s*allow\s+[^\n?]+\?|\d+\/\d+ answered.*(?:select|confirm))/i;

/** A prompt glyph, unboxed or inside a frame: `> `, `│ > │`, `⌸ ❯ … ⛶`, `› Ask …`, omp's `╰─`. */
export function isPromptLine(line) {
  if (typeof line !== "string" || NUMBERED_DIALOG_CHOICE.test(line) || CONFIRM_FOOTER.test(line)) return false;
  if (/^\s*╰─(?!─)/.test(line)) return true;
  const bare = line.replace(/^[\s│┃|⌸]+|[\s│┃|⛶]+$/g, "");
  if (/^(?:[>❯›$%](?:\s.*)?|.*[>❯›$%])$/.test(bare)) return true;
  return /^\s*[│┃|⌸].*[│┃|⛶]\s*$/.test(line)
    && (/[>❯›$%]/.test(line) || /\b(?:ask|type|enter|message|prompt|try)\b/i.test(line));
}

/** A visible permission or selection dialog belongs to the owner, never Herdr. */
export function pendingDialog(screenText) {
  const lines = screenLines(screenText).slice(-15).filter((line) => line.trim() !== "");
  const isDialogLine = (line) => DIALOG_QUESTION.test(line) || CONFIRM_FOOTER.test(line) || NUMBERED_DIALOG_CHOICE.test(line);
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (isPromptLine(lines[i])) { p = i; break; }
  // A prompt with only footer lines below it is idle: reply text above it is scrollback, not a
  // live dialog (a real dialog hides the input line or sits below scrollback prompts).
  if (p >= 0 && lines.length - 1 - p <= 5 && !lines.slice(p + 1).some(isDialogLine)) return null;
  // No prompt at the bottom: scan the visible tail (a prompt there made this scrollback).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (DIALOG_QUESTION.test(lines[i])) return { question: lines[i].trim().slice(0, 200), who: "the owner" };
    if (!isDialogLine(lines[i])) continue;
    // A choice belongs to a dialog only with no idle prompt below it (we would have returned).
    for (let j = i - 1, seen = 0; j >= 0 && seen < 6; j -= 1) {
      if (lines[j].trim() === "") continue;
      seen += 1;
      if (DIALOG_HEADER.test(lines[j])) return { question: lines[j].trim().slice(0, 200), who: "the owner" };
    }
    // A footer is the one evidence Claude Code's permission and rate-limit dialogs share
    // (`Esc to cancel`, `Press enter to confirm`). Mark it so a caller that knows the
    // rate-limit options shape can let that shape decide, while every guard still treats the
    // pane as held (the dialog is a person's to answer either way).
    if (CONFIRM_FOOTER.test(lines[i])) return { question: lines[i].trim().slice(0, 200), who: "the owner", footer: true };
  }
  return null;
}

// ---- Claude Code's rate-limit dialog (#1557): detect it in the pane tail, never answer it ----

/**
 * A limit statement a Claude Code seat shows when its account is out of usage. Deliberately
 * narrow: a mid-turn retry line ("rate limited, retrying in 30s") is a condition, not the
 * dialog the owner must answer.
 */
const RATE_LIMIT_CUE = /\b(?:rate[\s-]?limit(?:ed)?|usage limit|limit reached|reached (?:your|the) (?:usage\s+|rate\s+)?limit|hit (?:your|the) (?:usage\s+|rate\s+)?limit|out of usage|quota (?:reached|exhausted|exceeded))\b/i;
/** The dialog's reset or retry words: what makes the cue a wait, not a passing error line. */
const RATE_LIMIT_RESET_WORDS = /\b(?:resets?|reset at|try again|available again|unlimited again|wait until|comes back|continue in)\b/i;
/**
 * One of the dialog's numbered options, with its selection cursor when the line carries one.
 * The cursor is the dialog's own shape: a markdown list is numbered too, so the numbers alone
 * are never enough (the review's false positive was an ordinary report with a 1./2./3. list).
 */
const RATE_LIMIT_OPTION = /^[\s│┃|]*([❯›])?\s*(\d+)[.)]\s+(\S.*)$/;
const RATE_LIMIT_FOOTER = /\b(?:press enter|enter to (?:confirm|continue|select)|esc to (?:cancel|close|exit)|↑↓|up\/down to|select an option|choose an option)\b/i;
/** A fenced code block, a patch hunk or a `>` quote: text a person is reading, not a modal. */
const RATE_LIMIT_FENCE = /^\s*(?:```|~~~)/;
const RATE_LIMIT_PATCH = /^\s*(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|(?:\+\+\+|---) [ab]\/)/;
const RATE_LIMIT_QUOTE = /^\s*>\s/;

/** The visible tail's lines, ANSI-free, blank lines kept (a dialog's blank lines are its shape). */
const tailLines = (text, keep = 40) => typeof text === "string"
  ? text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").slice(-keep) : [];

const DURATION_UNITS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000 };

/** A "2 hours 10 minutes" / "5m" duration in milliseconds, or null. */
export function durationMs(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let total = 0, found = false;
  for (const m of text.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi)) {
    const unit = DURATION_UNITS[m[2].toLowerCase()];
    if (!unit) continue;
    total += Number(m[1]) * unit;
    found = true;
  }
  return found ? total : null;
}

/**
 * A clock time in a dialog's words as the next local instant, or null: `3:00 PM`, `15:00`, `5pm`.
 * `dayOffset` is the day the dialog itself names (`tomorrow` 1, `today` 0): it is applied even
 * when the clock time would still be ahead today, so "tomorrow at 9:00" never lands today.
 */
function clockTime(segment, now, { dayOffset = null } = {}) {
  const m = /(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s|$|\()/i.exec(segment);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? null : Number(m[2]);
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");
  if (minute === null && !meridiem) return null; // "resets at 5" is not a time to guess
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (minute !== null && (minute > 59 || hour > 23)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, minute ?? 0, 0, 0);
  if (dayOffset !== null) at.setDate(at.getDate() + dayOffset);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * The reset instant a rate-limit dialog names, as an ISO string, or null when it names none.
 * Understood, in this order: an ISO 8601 timestamp; a duration after "resets/try again/… in";
 * a clock time after "resets/try again/… at"; a clock time with a meridiem anywhere in the
 * reset sentence; "tomorrow"/"today"/"tonight" choose the day a clock time lands on. A past
 * ISO timestamp proves nothing about the next reset, so it is unknown (null): it must never
 * wake a restart immediately. Nothing is guessed: a bare number, a date without a time or a
 * duration with no unit leaves it null (the caller omits the time, and the wake with it).
 */
export function resetTimeFrom(text, now = Date.now()) {
  const tail = tailLines(text, 40).join("\n");
  const sentinel = /\b(?:resets?|reset at|try again|available again|unlimited again|comes back|continue in)\b/i;
  // 1. An explicit timestamp is unambiguous, unless it is already past: then it is unknown,
  // never a reset that fires a restart now.
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(tail);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return t > now ? new Date(t).toISOString() : null;
  }
  // 2. A duration: "resets in 2 hours 10 minutes", "try again in 5m".
  const duration = /(?:resets?|reset at|try again|available again|unlimited again|comes back|continue)[^.\n]{0,40}?\bin\s+([^.();\n]{1,60})/i.exec(tail);
  if (duration) {
    const ms = durationMs(duration[1]);
    if (ms !== null && ms > 0) return new Date(now + ms).toISOString();
  }
  // 3. A clock time in the same line as the reset words, on the day the line names.
  for (const line of tailLines(text, 40)) {
    if (!sentinel.test(line)) continue;
    const dayOffset = /\btomorrow\b/i.test(line) ? 1 : /\b(?:today|tonight)\b/i.test(line) ? 0 : null;
    const after = /(?:resets?|reset at|try again|available again|unlimited again|comes back)\b[^.\n]{0,30}?\bat\s+([^.\n]{1,40})/i.exec(line);
    const segment = after ? after[1] : line;
    const at = clockTime(segment, now, { dayOffset });
    if (at) return at.toISOString();
  }
  return null;
}

/**
 * The rate-limit dialog a Claude Code pane is blocked on, from its tail (`hc read`'s text,
 * ANSI allowed), or null. The test is the dialog's own shape, never a word search: a run of at
 * least two consecutive numbered options must end the visible tail (only a footer may follow),
 * the options must start at 1 and be consecutive, one of them must carry the selection cursor
 * (`❯`/`›`), and the limit cue must be the dialog's own line: one of the three non-empty lines
 * directly above the choices (the modal's limit line and its reset line), with no other prose
 * between it and them. A limit sentence in a report or in scrollback ten lines up is therefore
 * not a cue. A permission/selection question is rejected explicitly with pendingDialog()'s own
 * evidence; the footer both Claude Code dialogs may show is not a question, so the options/limit
 * shape decides it. A quoted, fenced or patched transcript is not the live dialog, and a patch
 * stays text however far its hunk header sits above the dialog. `resets_at` is the dialog's own
 * ISO time when it shows one, absent when it shows none (never guessed). Detection is read-only:
 * nothing here types into the pane or answers the dialog.
 */
export function rateLimitDialog(screenText, now = Date.now()) {
  if (typeof screenText !== "string" || !screenText.trim()) return null;
  // A screen with a prompt, confirmation or permission question is the owner's dialog: the
  // limit rule must never label it rate-limited (the cue may belong to a sentence above it).
  // The one shared case is the footer both Claude Code dialogs show: it is only a footer, so
  // the options/limit shape below decides. A permission question or choice still wins here.
  const pending = pendingDialog(screenText);
  if (pending && !pending.footer) return null;
  const lines = tailLines(screenText, 40);
  const visible = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.trim() !== "");
  // The options end the dialog: after them only a footer (never prose, never an idle prompt).
  let last = visible.length - 1;
  while (last >= 0 && RATE_LIMIT_FOOTER.test(visible[last].line)) last -= 1;
  if (last < 0 || !RATE_LIMIT_OPTION.test(visible[last].line)) return null;
  let first = last;
  while (first > 0 && RATE_LIMIT_OPTION.test(visible[first - 1].line)) first -= 1;
  const block = visible.slice(first, last + 1);
  if (block.length < 2) return null;
  const numbered = block.map(({ line }) => RATE_LIMIT_OPTION.exec(line));
  // The dialog numbers its choices from 1, in order: a numbered section of a report does not
  // have to, and never carries the cursor below.
  if (numbered[0][2] !== "1" || numbered.some((m, i) => Number(m[2]) !== i + 1)) return null;
  if (!numbered.some((m) => m[1])) return null;
  // The limit statement belongs to this dialog, not to scrollback or a report above the options:
  // it has to be one of the three non-empty lines directly above the choices (the modal's own
  // limit/reset header). A sentence ten lines up is not the dialog's line.
  let cueAt = -1;
  for (let i = first - 1, seen = 0; i >= 0 && seen < 3; i -= 1, seen += 1) {
    if (RATE_LIMIT_CUE.test(visible[i].line)) { cueAt = i; break; }
  }
  if (cueAt < 0) return null;
  // Only the dialog's own limit/reset words may sit between the cue and the choices. A report's
  // "Findings:" or a permission question there means the cue belongs to something else.
  for (let i = cueAt + 1; i < first; i += 1) {
    if (!RATE_LIMIT_CUE.test(visible[i].line) && !RATE_LIMIT_RESET_WORDS.test(visible[i].line)) return null;
  }
  // A quote or a pasted transcript is text, not the modal: the block must not sit inside an
  // open fenced code block, and no unified-diff marker may sit anywhere in the visible tail.
  // The marker's distance from the cue never decides: a hunk header can be many context lines
  // above the dialog, so the whole visible tail is scanned.
  if (visible.slice(0, last + 1).filter(({ line }) => RATE_LIMIT_FENCE.test(line)).length % 2 === 1) return null;
  for (let i = 0; i <= last; i += 1) if (RATE_LIMIT_PATCH.test(visible[i].line)) return null;
  // A `>` quote is adjacent evidence: the cue is at most three visible lines above the choices,
  // so a window above it covers every quoted form this rule can see.
  for (let i = Math.max(0, cueAt - 5); i <= last; i += 1) if (RATE_LIMIT_QUOTE.test(visible[i].line)) return null;
  const dialog = visible.slice(cueAt, last + 1).map(({ line }) => line);
  if (!dialog.some((line) => RATE_LIMIT_RESET_WORDS.test(line))) return null;
  const question = visible[cueAt].line.trim().replace(/\s+/g, " ").slice(0, 200);
  const resetsAt = resetTimeFrom(dialog.join("\n"), now);
  return { question, ...(resetsAt ? { resets_at: resetsAt } : {}) };
}
