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
