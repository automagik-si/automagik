// install.sh holds the briefing hooks' notice in $TMP/notice and prints it at the end of the run.
// The install e2e once missed that notice on CI with no suppressed-notice line either, so the
// notice was lost between the two. With the pack's AUTOMAGIK_HERDR_DIAG=1 (the e2e rows set it),
// install.sh says where the notice stood when it was held and when it was printed; without it,
// a person's run prints nothing new. These run install.sh's own functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));

/** One shell function's text from install.sh (a one-line `name() { ... }` or a block to its `}`). */
function shellFunction(name) {
  const text = readFileSync(INSTALL, "utf8");
  const match = text.match(new RegExp(`^${name}\\(\\) \\{(?:[^\\n]*\\}\\n|\\n[\\s\\S]*?\\n\\}\\n)`, "m"));
  assert.ok(match, `install.sh defines ${name}()`);
  return match[0];
}

/** Runs `body` after install.sh's say, diag, notice_state and held_notice, with $TMP a scratch folder. */
function run(t, body, { diag }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-install-notice-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  const script = join(root, "run.sh");
  const fns = ["say", "diag", "notice_state", "held_notice"].map(shellFunction).join("");
  writeFileSync(script, `${fns}TMP=${tmp}\n${body}\n`);
  const env = { PATH: "/usr/bin:/bin", HOME: root, ...(diag ? { AUTOMAGIK_HERDR_DIAG: "1" } : {}) };
  const r = spawnSync("sh", [script], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, tmp };
}

const HELD = 'printf \'IMPORTANT: one\\n  two\\n\' >"$TMP/notice"\ndiag "hooks notice held after the install: $(notice_state)"';

test("with AUTOMAGIK_HERDR_DIAG=1 the held notice is counted where it is held and where it is printed", (t) => {
  const { out, tmp } = run(t, `${HELD}\nheld_notice`, { diag: true });
  assert.equal(out, [
    `diag: hooks notice held after the install: 2 line(s) in ${tmp}/notice`,
    `diag: hooks notice at the end of the run: 2 line(s) in ${tmp}/notice`,
    "", "IMPORTANT: one", "  two", "", "",
  ].join("\n"));
});

test("with AUTOMAGIK_HERDR_DIAG=1 a notice file gone, or the whole $TMP gone, is said at the end", (t) => {
  const missing = run(t, `${HELD}\nrm "$TMP/notice"\nheld_notice`, { diag: true });
  assert.match(missing.out, new RegExp(`^diag: hooks notice at the end of the run: ${missing.tmp}/notice is missing$`, "m"));
  assert.doesNotMatch(missing.out, /IMPORTANT/);
  const gone = run(t, `${HELD}\nrm -r "$TMP"\nheld_notice`, { diag: true });
  assert.match(gone.out, new RegExp(`^diag: hooks notice at the end of the run: ${gone.tmp} is gone$`, "m"));
  const empty = run(t, `: >"$TMP/notice"\nheld_notice`, { diag: true });
  assert.equal(empty.out, `diag: hooks notice at the end of the run: 0 line(s) in ${empty.tmp}/notice\n`);
});

test("without AUTOMAGIK_HERDR_DIAG nothing new is printed: the notice alone, as before", (t) => {
  const { out } = run(t, `${HELD}\nheld_notice`, { diag: false });
  assert.equal(out, "\nIMPORTANT: one\n  two\n\n");
});
