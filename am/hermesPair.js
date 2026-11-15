// Explicit existing-Bot pairing. A workspace or a display name never selects a Hermes home.
// Pure data shared by the CLI, sidebar and restart planner. Apache-2.0.
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const word = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

export function hermesPairProblem(pair) {
  if (!object(pair)) return "Hermes pairing needs home and profile.";
  if (Object.keys(pair).some((k) => !["home", "profile"].includes(k))) return "Hermes pairing takes only home and profile; Bot Chat is resolved by title.";
  if (typeof pair.home !== "string" || !pair.home.startsWith("/") || pair.home.includes("//") || pair.home === "/" || /[\x00-\x1f\x7f]/.test(pair.home)
    || pair.home.split("/").some((part) => part === "." || part === "..") || pair.home.endsWith("/")) return "Hermes home must be an absolute folder without dot segments or a trailing slash.";
  if (!word(pair.profile) || pair.profile === "." || pair.profile === "..") return "Hermes profile must be an explicit profile name.";

  return null;
}

export function hermesPairArgs(bot) {
  if (bot?.agent !== "hermes" || bot.hermes === undefined) return [];
  const why = hermesPairProblem(bot.hermes);
  if (why) throw new Error(why);
  return ["--profile", bot.hermes.profile, "--tui", "--continue", "Bot Chat"];
}

export function hermesPairEnv(bot) {
  if (!hermesPairArgs(bot).length) return {};
  return { HERMES_HOME: bot.hermes.home, HERMES_PROFILE: bot.hermes.profile };
}

/** Keep the person's command and add the binding once, comparing options with their values. */
export function hermesPairRun(run, bot) {
  const pair = hermesPairArgs(bot);
  if (!pair.length) return [...run];
  const end = run.indexOf("--");
  const head = end < 0 ? run : run.slice(0, end);
  const tail = end < 0 ? [] : run.slice(end);
  const seen = new Set();
  const words = [head[0]];
  const add = (flag, value, original) => {
    if (flag === "--profile" && value !== bot.hermes.profile) {
      throw new Error("The command selects a different Hermes profile; match --profile to the bot's pairing.");
    }
    const key = JSON.stringify([flag, value]);
    if (!seen.has(key)) words.push(...original);
    seen.add(key);
  };
  for (let i = 1; i < head.length; i += 1) {
    const word = head[i];
    if (word === "--tui") add(word, null, [word]);
    else if (["--profile", "--continue"].includes(word)) {
      const value = head[++i];
      add(word, value, value === undefined ? [word] : [word, value]);
    } else if (/^--(?:profile|continue)=/.test(word)) {
      const at = word.indexOf("=");
      add(word.slice(0, at), word.slice(at + 1), [word]);
    } else words.push(word);
  }
  add("--profile", pair[1], pair.slice(0, 2));
  add("--tui", null, ["--tui"]);
  add("--continue", "Bot Chat", pair.slice(3));
  return [...words, ...tail];
}

export function hermesPairConflict(file, bot) {
  if (bot?.agent !== "hermes" || !bot.hermes || hermesPairProblem(bot.hermes)) return null;
  const other = file.bots.find((b) => b.id !== bot.id && b.agent === "hermes" && b.hermes?.home === bot.hermes.home && b.hermes?.profile === bot.hermes.profile);
  return other ? `Hermes profile is already paired to ${other.name ?? other.id}; unpair it before choosing another seat.` : null;
}
