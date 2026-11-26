import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WRAPPER = new URL('../bin/hc-socket-mask.mjs', import.meta.url);
const RUNNER_ARGS = ['--ro-bind', '/', '/', '--', 'fixture-command'];
const STATUS_ARGS = ['--json-status-fd', '3', ...RUNNER_ARGS];
const PREFIX = 'hc-socket-mask: ';
const VALID_STATUS = `printf '{"child-pid":1}\\n{"exit-code":3}\\n' >&3`;

function fixture(t, script) {
  const root = realpathSync(mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'ds-status-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const argsFile = join(root, 'argv');
  const sleeper = join(root, 'sleeper');
  writeFileSync(join(root, 'bwrap'), [
    '#!/bin/sh',
    'case " $* " in *" -- "*) ;; *) exit 0 ;; esac',
    'printf "%s\\n" "$@" > "$BWRAP_ARGS_FILE"',
    script,
    '',
  ].join('\n'), { mode: 0o755 });
  const env = {
    PATH: `${root}:${process.env.PATH}`,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    BWRAP_ARGS_FILE: argsFile,
    BWRAP_SLEEPER_FILE: sleeper,
  };
  return { root, argsFile, env, sleeper };
}

async function runNode(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 8000 });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stderr }));
  });
}

async function runStatus(t, script) {
  const scene = fixture(t, script);
  try {
    return await runNode(['--input-type=module', '--eval',
      `import { runBwrap } from ${JSON.stringify(WRAPPER.href)};
       runBwrap(process.argv.slice(1), process.env, { status: true });`,
      '--', ...STATUS_ARGS,
    ], scene.env);
  } finally {
    if (existsSync(scene.sleeper)) {
      const pid = Number(readFileSync(scene.sleeper, 'utf8'));
      try { process.kill(pid); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
}

for (const [name, script, code, line] of [
  ['a setup exit without a status record', 'exit 1', 1, 'bwrap exited 1 without reporting payload status'],
  ['a child pid without an exit record', `printf '{"child-pid":1}\\n' >&3; exit 1`, 1,
    'bwrap exited 1 without reporting payload status'],
  ['a reported payload status', `${VALID_STATUS}; exit 3`, 3, null],
  ['garbage', 'printf "garbage\\n" >&3; exit 7', 7, "bwrap's status could not be read (exit 7)"],
  ['a truncated line', `printf '{"exit-code":0}' >&3; exit 0`, 1, "bwrap's status could not be read (exit 0)"],
  ['a successful exit without a record', 'exit 0', 0, 'bwrap exited 0 without reporting payload status'],
  ['a descendant holding only fd 3', `${VALID_STATUS}; sleep 30 0<&- 1>&- 2>&- & echo "$!" > "$BWRAP_SLEEPER_FILE"; exit 3`, 3, null],
]) {
  test(`masked bwrap handles ${name}`, async (t) => {
    const result = await runStatus(t, script);
    assert.equal(result.status, code);
    assert.equal(result.stderr, line === null ? '' : `${PREFIX}${line}\n`);
  });
}

test('a bwrap signal takes precedence over unreadable status and is re-raised', async (t) => {
  const result = await runStatus(t, 'printf "garbage\\n" >&3; kill -TERM "$$"');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
  assert.equal(result.stderr, `${PREFIX}bwrap ended by signal SIGTERM\n`);
});

test('launch prepends the status flag only when masked', async (t) => {
  if (process.platform !== 'linux') return t.skip('masked runs are Linux-only');
  const { root, argsFile, env } = fixture(t,
    `if [ "$1" = --json-status-fd ]; then ${VALID_STATUS}; fi; exit 3`);
  for (const dir of ['core', 'automagik-hc-proxy/pane']) mkdirSync(join(root, dir), { recursive: true });
  const run = (extra) => runNode([fileURLToPath(WRAPPER), ...RUNNER_ARGS], { ...env, ...extra });
  const off = await run({});
  assert.equal(off.status, 3, off.stderr);
  assert.equal(off.stderr, '');
  assert.deepEqual(readFileSync(argsFile, 'utf8').trimEnd().split('\n'), RUNNER_ARGS);
  const on = await run({
    DSH_SANDBOX_MASK: '1',
    AM_HC_REAL_SOCKET: join(root, 'core', 'core.sock'),
    AM_HC_PROXY_SOCKET: join(root, 'automagik-hc-proxy', 'pane', 'proxy.sock'),
  });
  assert.equal(on.status, 3, on.stderr);
  assert.deepEqual(readFileSync(argsFile, 'utf8').trimEnd().split('\n').slice(0, 2), STATUS_ARGS.slice(0, 2));
  assert.doesNotMatch(on.stderr, /^hc-socket-mask: bwrap/m);
});
