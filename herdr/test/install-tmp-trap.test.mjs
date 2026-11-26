// install.sh removes its $TMP folder from an EXIT trap, and turns INT and TERM into `exit 130`.
// bash runs a background child (a watchdog subshell) with those traps for a moment after the fork.
// A TERM the installer sent that child at once (a watchdog stopped as soon as its command
// answered: the usagemeter smoke, shown_layout, bounded) ran `exit 130` there, so the child ran
// the EXIT trap and removed $TMP under the running installer. The held hooks notice then never
// printed, and a smoke answer read after that was empty, so usagemeter was not installed. These
// run install.sh's own trap lines: the trap's action run in a child must leave $TMP (deterministic),
// and the smoke pattern under both shells must never lose it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));
const TEXT = readFileSync(INSTALL, "utf8");
const RUNS = 300;

/** The top-level shell functions of install.sh the trap may call (each `name() {` ... `}`). */
const FUNCTIONS = [...TEXT.matchAll(/^[a-z_]+\(\) \{(?:[^\n]*\}\n|\n[\s\S]*?\n\}\n)/gm)].map((m) => m[0]).join("");

/** install.sh's own lines that set the traps: everything from `TMP=` up to the INT/TERM trap. */
function trapBlock() {
  const match = TEXT.match(/^ {2}TMP=\n[\s\S]*?^ {2}trap 'exit 130' INT TERM\n/m);
  assert.ok(match, "install.sh sets TMP, its EXIT trap and its INT/TERM trap in one block");
  assert.match(match[0], / EXIT\n/, "the block sets the EXIT trap");
  return match[0];
}

/** The EXIT trap's action text, as install.sh sets it. */
function exitAction() {
  const match = trapBlock().match(/^ {2}trap '([^']*)' EXIT$/m);
  assert.ok(match, "install.sh's EXIT trap is one quoted action");
  return match[1];
}

function run(t, shell, body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-install-trap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "run.sh");
  writeFileSync(script, `${FUNCTIONS}\nmain_shell() {\n${trapBlock()}\n${body}\n}\nmain_shell\n`);
  const r = spawnSync(shell, [script], { encoding: "utf8", timeout: 120_000, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
  assert.equal(r.error, undefined, `${r.error}`);
  return r;
}

for (const shell of ["bash", "dash"]) {
  test(`${shell}: the EXIT trap's action run in a forked child leaves $TMP; in the installer's shell it removes it`, (t) => {
    const action = exitAction().replace(/'/g, "'\\''");
    const r = run(t, shell, [
      'TMP=$(mktemp -d "$TMPDIR/automagik-herdr.XXXXXX")',
      `( eval '${action}' )`,
      '[ -d "$TMP" ] && echo "child: kept" || echo "child: removed"',
      `eval '${action}'`,
      '[ -d "$TMP" ] && echo "installer: kept" || echo "installer: removed"',
      "trap - EXIT",
    ].join("\n"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "child: kept\ninstaller: removed\n");
  });

  test(`${shell}: a watchdog stopped at once never takes $TMP with it (${RUNS} runs, the usagemeter smoke's pattern)`, (t) => {
    const r = run(t, shell, [
      'TMP=$(mktemp -d "$TMPDIR/automagik-herdr.XXXXXX")',
      "i=0",
      `while [ "$i" -lt ${RUNS} ]; do`,
      // The smoke's shape: a command that answers at once, a watchdog subshell, the command
      // waited, the watchdog sent a TERM and not waited (install.sh does not wait it either).
      // The watchdog's own work is a short sleep only, so no pid is ever killed late.
      '  true </dev/null >"$TMP/smoke" 2>/dev/null & usp=$!',
      '  ( sleep 2; : ) </dev/null >/dev/null 2>&1 & ukp=$!',
      '  wait "$usp"; kill "$ukp" 2>/dev/null',
      "  i=$((i + 1))",
      "done",
      // `wait` returns once every watchdog subshell has ended, so a child that ran the EXIT trap
      // has already removed $TMP by then: one check covers all the runs.
      "wait",
      '[ -d "$TMP" ] && echo "TMP kept" || echo "TMP lost"',
    ].join("\n"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "TMP kept\n", `${r.stdout}: a TERM sent to a fresh child ran the installer's EXIT trap there`);
  });
}
