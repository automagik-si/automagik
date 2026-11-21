// A test's own PATH keeps some of the host's folders (node's, /usr/bin, /bin …). Herdr's installer puts
// herdr-app, hc and herdr-core in ~/.local/bin, which those PATHs never hold; on a machine that put one in a
// kept folder, that folder is replaced by a mirror without them, so a test never runs the host's copy.
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOST_PROGRAMS = Object.freeze(["herdr-app", "hc", "herdr-core"]);
const mirrors = new Map();
let tempRoot;

function defaultRoot() {
  if (!tempRoot) {
    tempRoot = mkdtempSync(join(tmpdir(), "system-path-"));
    process.once("exit", () => rmSync(tempRoot, { recursive: true, force: true }));
  }
  return tempRoot;
}

/**
 * `dirs` as a PATH string. A folder holding none of `names` is kept as it is (so on CI and on a usual
 * machine the result is exactly `dirs.join(":")`); one holding any is replaced by a mirror (links to
 * every other entry) made once per real folder under `root` (default: one temp folder per process,
 * removed at exit). A missing folder is kept as it is. No folder is dropped or merged.
 */
export function pathWithout(dirs, { names = HOST_PROGRAMS, root } = {}) {
  const excluded = new Set(names);
  const sortedNames = [...excluded].sort();
  return dirs.map((dir) => {
    let real;
    let entries;
    try {
      real = realpathSync(dir);
      entries = readdirSync(real);
    } catch (error) {
      if (error.code === "ENOENT") return dir;
      throw error;
    }
    if (!entries.some((name) => excluded.has(name))) return dir;

    const parent = root ?? defaultRoot();
    const key = JSON.stringify([parent, sortedNames, real]);
    if (!mirrors.has(key)) {
      const mirror = mkdtempSync(join(parent, "bin-"));
      for (const name of entries) {
        if (!excluded.has(name)) symlinkSync(join(real, name), join(mirror, name));
      }
      mirrors.set(key, mirror);
    }
    return mirrors.get(key);
  }).join(":");
}
