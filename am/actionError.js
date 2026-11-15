// One sentence for a bot action's UI; callers keep the complete diagnostic in their log.
// Pure, shared by the CLI and sidebar. Apache-2.0.
export function actionError(error, action = "Start") {
  const text = String(error?.message ?? error ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  if (/^Herdr ended am /.test(text)) {
    return `Herdr stopped the ${action.toLowerCase()} command before it finished; check the panes for a partial start before retrying from a terminal.`;
  }
  if (/^This Herdr ends the sidebar's programs at 30 s/.test(text)) {
    return /a restart on this computer /.test(text)
      ? "This Herdr cannot wait long enough for a restart with its helpers; restart it from a terminal."
      : "This Herdr cannot wait long enough for a linked-machine restart; restart it from a terminal.";
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.findLast((line) => /^am: /.test(line))
    ?? lines.find((line) => /^(?:\w*Error): /.test(line))
    ?? lines.filter((line) => !/^(?:at\s|\^|Node\.js\b)/.test(line)).at(-1);
  if (!diagnostic) return `${action} failed; check the log and try again.`;
  const reason = diagnostic.replace(/^(?:am: )?(?:\w*Error: )?/, "")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)[0].replace(/[.!?;]+$/, "");
  if (/; (?:match|unpair|check|wait|choose|install)\b/.test(reason)) return `${reason}.`;
  const next = /different Hermes profile/.test(text) ? "match --profile to the bot's pairing"
    : /paired|pairing requires the Hermes agent/i.test(text) ? "unpair it in Configure before changing its conversation or agent"
    : /pass --force/.test(text) ? "wait until it is idle or choose Restart anyway"
    : /--fresh\b/.test(text) ? "choose Restart with a new conversation"
    : /isn't installed|not installed/.test(text) ? "install the agent on that machine and try again"
    : /30 s|timeout|timed out|ended.*CLI/.test(text) ? "check the pane and retry from a terminal"
    : "check the log and try again";
  return `${reason || `${action} failed`}; ${next}.`;
}
