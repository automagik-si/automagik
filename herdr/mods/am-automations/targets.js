// An automation's target (#498): who its prompt goes to instead of a fresh
// session. Stored as one string, "<kind>:<bot id>", by the bot's stable id
// from the project's .herdr/bots.json — never a terminal address, which
// changes on every restart. Pure: no `herdr`, so the panel's tests read the
// same rules the panel draws. Apache-2.0.

/** A bot id: `b-` and ten lowercase base32 characters (model.js's ID_SHAPE). */
export const BOT_ID = /^b-[a-z2-7]{10}$/;

/** The form's "runs as" choices: the value saved in `target`, and its words. */
export const RUNS_AS = [["none", "New session"], ["bot", "A bot"], ["worker", "A worker of a bot"]];

/**
 * `"bot:<id>"` or `"worker:<id>"` as `{ kind, bot }`, or null when the value is
 * not a target this panel knows. Never a terminal address.
 */
export function parseTarget(value) {
  if (typeof value !== "string" || !value) return null;
  const at = value.indexOf(":");
  if (at < 0) return null;
  const kind = value.slice(0, at), bot = value.slice(at + 1);
  if ((kind !== "bot" && kind !== "worker") || !BOT_ID.test(bot)) return null;
  return { kind, bot };
}

/** What a target is to a person: "bot Housekeeper", "a worker of Housekeeper". */
export function targetLine(target, nameOf = () => null) {
  const parsed = parseTarget(target);
  if (!parsed) return String(target ?? "");
  const who = nameOf(parsed.bot) || parsed.bot;
  return parsed.kind === "bot" ? `bot ${who}` : `a worker of ${who}`;
}

/**
 * Why a saved target will not run, or null: the bot left the project's roster,
 * or it is only planned. `bots` may be null while the roster is not loaded,
 * in which case nothing is claimed.
 */
export function targetWarning(target, bots) {
  if (!target) return null;
  const parsed = parseTarget(target);
  if (!parsed) return `"${target}" isn't a target this panel knows: it must be bot:<id> or worker:<id>.`;
  if (!Array.isArray(bots)) return null;
  const hit = bots.find((b) => b?.id === parsed.bot);
  if (!hit) return `That bot is no longer in this project's bots.json. Pick another; the run fails until you do.`;
  if (hit.planned) return `${hit.name || parsed.bot} is only planned and starts no runs.`;
  return null;
}
