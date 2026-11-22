// A linked Claude launch follows its own machine's login record. Apache-2.0.
import { chooseLogin } from "./logins.js";
export { routeManaged } from "./accountsPlanRecord.js";

export function loginIoFrom({ text, folder, home }) {
  return {
    read: () => {
      if (text === null) throw Object.assign(new Error(), { code: "ENOENT" });
      return text;
    },
    realpath: (path) => {
      if (folder === "symlink") return path + "/.";
      if (folder === "ok" || folder === "notdir") return path;
      throw new Error();
    },
    isDir: () => folder === "ok",
    home,
  };
}

// The two unlinked-file notices are advisory. Only the last line describes the folder.
export function folderVerdict(lines) {
  const nonempty = lines.split("\n").filter(Boolean);
  const verdict = nonempty.pop();
  if (!["missing", "symlink", "notdir", "ok"].includes(verdict)) return null;
  return nonempty.every((line) => line === "unlinked settings.json" || line === "unlinked CLAUDE.md") ? verdict : null;
}

const WHY = {
  "no-home": "app home unavailable",
  unread: "couldn't read the launch settings",
  late: "ran out of time",
  "refused-env": "pane environment was refused",
  rebound: "machine binding couldn't be confirmed",
  "own-path": "project uses its own PATH",
  "own-launcher": "the launch uses its own Claude command",
};

export function exceptionWarning(bot, machine, why) {
  if (why === "other-home") return `${bot}'s project on ${machine} uses another app home: not managed, so it starts as before.`;
  return `${bot}'s Claude login on ${machine} ${why === "fallback"
    ? "couldn't be followed: it starts with the default login."
    : `couldn't be resolved (${WHY[why]}): it starts as before.`}`;
}

export function managedLogin({ member, home, text, folder, targetHome, bot, machine }) {
  if (home !== member.home) return { words: null, warning: exceptionWarning(bot, machine, "other-home") };
  const { words, warning } = chooseLogin(home, loginIoFrom({ text, folder, home: targetHome }));
  return { words, warning: warning ? exceptionWarning(bot, machine, "fallback") : null };
}
