// install.sh bounds `herdr-app status` (shown_layout) and the scheduler's calls (bounded) with a
// watchdog subshell, because macOS has no `timeout`. The caller stops the watchdog with a TERM the
// moment the command answers. A TERM that landed while the watchdog forked its sleep, with its
// trap already set, was lost by dash: the caller then waited the whole bound for the sleep (60 s
// in the layout-safety matrix, 10 s in production) although the command had answered at once.
// The window is inside dash's fork, which no test can aim at, so the rule is checked on the text
// (the trap comes after the sleep's pid is kept, and nothing forks while it is set), and each
// function, as install.sh has it, then runs many times against a command that answers at once,
// under a bound longer than all of the calls together take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));
const CALLS = 400;
const BOUND_S = 30;

/** One shell function's text from install.sh, from `name() {` to its closing brace. */
function shellFunction(name) {
  const text = readFileSync(INSTALL, "utf8");
  const match = text.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  assert.ok(match, `install.sh defines ${name}()`);
  return match[0];
}

/** Runs `body` in sh after the named functions, with a herdr-app that fails at once on PATH. */
function runLoop(t, names, body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "am-install-watchdog-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "herdr-app"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "herdr-app"), 0o755);
  const script = join(root, "loop.sh");
  writeFileSync(script, `${names.map(shellFunction).join("\n")}\n${body}\n`);
  const started = Date.now();
  const r = spawnSync("sh", [script], {
    encoding: "utf8",
    timeout: (BOUND_S + 30) * 1000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, STATUS_SECONDS: String(BOUND_S) },
  });
  return { ...r, ms: Date.now() - started };
}

/** The watchdog subshell of a function: the lines between `(` and `) >/dev/null 2>&1 &`. */
function watchdogLines(name) {
  const body = shellFunction(name).split("\n");
  const start = body.findIndex((line) => line.trim() === "(");
  const end = body.findIndex((line, i) => i > start && line.trim().startsWith(") >/dev/null 2>&1 &"));
  assert.ok(start >= 0 && end > start, `${name}() has a watchdog subshell`);
  return body.slice(start + 1, end).map((line) => line.trim()).filter(Boolean);
}

for (const name of ["shown_layout", "bounded"]) {
  test(`${name}'s watchdog sets its TERM trap only after its sleep's pid is kept, and forks nothing after`, () => {
    const lines = watchdogLines(name);
    const fork = lines.findIndex((line) => /^sleep "\$\w+" &$/.test(line));
    const kept = lines.indexOf("nap=$!");
    const trap = lines.findIndex((line) => /^trap .* TERM$/.test(line));
    assert.ok(fork >= 0, `${name}: the watchdog starts its sleep in the background`);
    assert.equal(kept, fork + 1, `${name}: the sleep's pid is kept right after it starts`);
    assert.ok(trap > kept, `${name}: the TERM trap is set only after the sleep's pid is kept`);
    // From the trap on, only builtins: no background job and no other program is started, so no
    // fork can swallow the caller's TERM.
    for (const line of lines.slice(trap)) {
      assert.doesNotMatch(line, /&\s*$/, `${name}: nothing goes to the background after the trap: ${line}`);
      assert.match(line, /^(trap |wait |kill )/, `${name}: only trap, wait and kill after the trap: ${line}`);
    }
    assert.match(lines[trap], /^trap 'kill "\$nap" 2>\/dev\/null; wait "\$nap"; exit 0' TERM$/);
  });
}

test("shown_layout returns as soon as herdr-app answers: no call waits out the status bound", (t) => {
  const r = runLoop(t, ["shown_layout"], [
    "i=0",
    `while [ "$i" -lt ${CALLS} ]; do`,
    "  layout=$(shown_layout)",
    '  [ -z "$layout" ] || { echo "unexpected layout: $layout"; exit 3; }',
    "  i=$((i + 1))",
    "done",
    "echo done",
  ].join("\n"));
  assert.equal(r.error, undefined, `${r.error}`);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "done\n");
  assert.ok(r.ms < BOUND_S * 1000, `${CALLS} calls took ${r.ms} ms: a call waited out the ${BOUND_S} s bound`);
});

test("bounded returns as soon as its command ends: no call waits out its bound", (t) => {
  const r = runLoop(t, ["bounded"], [
    'out="$TMPDIR/out"',
    "i=0",
    `while [ "$i" -lt ${CALLS} ]; do`,
    `  bounded ${BOUND_S} "$out" herdr-app status && { echo "herdr-app status passed"; exit 3; }`,
    "  i=$((i + 1))",
    "done",
    "echo done",
  ].join("\n"));
  assert.equal(r.error, undefined, `${r.error}`);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "done\n");
  assert.ok(r.ms < BOUND_S * 1000, `${CALLS} calls took ${r.ms} ms: a call waited out the ${BOUND_S} s bound`);
});
