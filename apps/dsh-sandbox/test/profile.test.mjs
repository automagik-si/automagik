// Hermetic tests for bin/dsh-sandbox.mjs: every profile is a temp file (a YAML list or the exact
// DSH template), every wrapper a temp executable. The live profile is never read or written.
// The helper writes one managed block, backs it up, and check reads only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BEGIN,
  checkRow,
  FAILURE_SIGNATURE,
  defaultProfile,
  END,
  findManaged,
  installRow,
  layerShape,
  MSG_PREFIX as HELPER_PREFIX,
  PLACEHOLDER,
  sandboxBlock,
} from '../bin/dsh-sandbox.mjs';
import { MSG_PREFIX as WRAPPER_PREFIX } from '../bin/hc-socket-mask.mjs';

const HELPER = fileURLToPath(new URL('../bin/dsh-sandbox.mjs', import.meta.url));

/** A dsh-tui profile patch like the live one: a YAML list of rows. */
const PROFILE = [
  '# a dsh-tui profile patch',
  '- id: sandbox-policy',
  '  config:',
  '    mode: workspace-write',
  '    workspaceRoot: !!js process.cwd()',
  '- id: approval',
  '  config:',
  '    policy: never',
  '',
].join('\n');

/**
 * The exact bytes @deepseek-ai/dsh-app-boot 0.2.2-rc.2 writes as a fresh profile patch layer
 * (PROFILE_PATCH_TEMPLATE in lib/index.js). A freshly initialized DSH profile is this file.
 */
const DSH_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n');

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sandbox-profile-'));
  roots.push(root);
  const dir = join(root, 'profiles', 'dsh-tui');
  mkdirSync(dir, { recursive: true });
  const profile = join(dir, 'cordis.patch.yml');
  writeFileSync(profile, PROFILE);
  const wrapper = join(root, 'hc-socket-mask.mjs');
  writeFileSync(wrapper, '#!/usr/bin/env node\n', { mode: 0o755 });
  return { root, dir, profile, wrapper };
}

function backupsOf(profile) {
  const prefix = `${basename(profile)}.dsh-sandbox-backup-`;
  return readdirSync(dirname(profile)).filter((name) => name.startsWith(prefix));
}

function runHelper(args, env = process.env) {
  return spawnSync(process.execPath, [HELPER, ...args], { env, encoding: 'utf8' });
}

test('the managed block carries the wrapper path and the failure signature', () => {
  const block = sandboxBlock("/tmp/a b/hc's-wrapper.mjs");
  assert.ok(block.startsWith(`${BEGIN}\n`));
  assert.ok(block.endsWith(`\n${END}`));
  assert.match(block, /^- id: sandbox$/m);
  assert.match(block, /^ {2}config:$/m);
  assert.ok(block.includes("runnerCommand: ['/tmp/a b/hc''s-wrapper.mjs']"));
  assert.ok(block.includes("runnerFailureSignatures: ['hc-socket-mask: ']"));
  assert.equal(block.split(BEGIN).length - 1, 1);
});

test('install writes one managed row and backs the profile up byte for byte', () => {
  const fixture = makeFixture();
  const now = new Date('2026-11-07T20:15:36.123Z');
  const result = installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now });
  assert.equal(result.changed, true);
  assert.equal(result.wrapper, fixture.wrapper);
  assert.equal(result.backup, `${fixture.profile}.dsh-sandbox-backup-2026-11-07T20-15-36-123Z`);
  const text = readFileSync(fixture.profile, 'utf8');
  assert.ok(text.startsWith(PROFILE));
  assert.equal(text.split(BEGIN).length - 1, 1);
  assert.equal(text.split(END).length - 1, 1);
  assert.ok(text.includes(`runnerCommand: ['${fixture.wrapper}']`));
  assert.ok(text.includes("runnerFailureSignatures: ['hc-socket-mask: ']"));
  assert.ok(text.endsWith('\n'));
  assert.equal(readFileSync(result.backup, 'utf8'), PROFILE);
  // The original rows still apply: the block is appended, not a replacement of the file.
  assert.match(text, /- id: sandbox-policy/);
  assert.match(text, /- id: approval/);
  assert.deepEqual(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }), {
    ok: true,
    message: `the sandbox row in ${fixture.profile} matches ${fixture.wrapper}`,
  });
});

test('install replaces the DSH template [] and check accepts the result', () => {
  const fixture = makeFixture();
  writeFileSync(fixture.profile, DSH_TEMPLATE);
  const before = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(before.ok, false);
  assert.match(before.message, /no managed dsh-sandbox block/);
  const installed = installRow({
    profile: fixture.profile,
    wrapper: fixture.wrapper,
    now: new Date(1),
  });
  assert.equal(installed.changed, true);
  const text = readFileSync(fixture.profile, 'utf8');
  // The template comments stay, the [] line becomes the one managed block.
  assert.equal(text, DSH_TEMPLATE.replace('[]\n', `${sandboxBlock(fixture.wrapper)}\n`));
  assert.ok(text.startsWith('# Your patch layer for this dsh profile'));
  assert.ok(text.includes('# overrides, disables, and insert lists'));
  assert.ok(!text.split('\n').includes('[]'));
  assert.equal(text.split(BEGIN).length - 1, 1);
  assert.equal(text.split(END).length - 1, 1);
  assert.equal(layerShape(text).shape, 'block-array');
  assert.equal(readFileSync(installed.backup, 'utf8'), DSH_TEMPLATE);
  assert.deepEqual(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }), {
    ok: true,
    message: `the sandbox row in ${fixture.profile} matches ${fixture.wrapper}`,
  });
});

test('install keeps comments and blank lines around a lone []', () => {
  const fixture = makeFixture();
  const layer = '# before\n\n[]\n\n# after\n';
  writeFileSync(fixture.profile, layer);
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  assert.equal(readFileSync(fixture.profile, 'utf8'),
    `# before\n\n${sandboxBlock(fixture.wrapper)}\n\n# after\n`);
});

test('check refuses the corrupted [] plus managed block state the old install made', () => {
  const fixture = makeFixture();
  const corrupted = `${DSH_TEMPLATE}${sandboxBlock(fixture.wrapper)}\n`;
  writeFileSync(fixture.profile, corrupted);
  const result = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(result.ok, false);
  assert.match(result.message, /top-level \[\] with other content/);
  const cli = runHelper(['check', '--profile', fixture.profile, '--wrapper', fixture.wrapper]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  const lines = cli.stderr.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(HELPER_PREFIX));
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: fixture.wrapper }),
    /top-level \[\] with other content/,
  );
  assert.equal(readFileSync(fixture.profile, 'utf8'), corrupted);
});

test('install refuses a mapping layer and leaves it byte for byte', () => {
  const fixture = makeFixture();
  const mapping = [
    '# a mapping layer',
    'id: sandbox',
    'config:',
    '  policy: never',
    '',
  ].join('\n');
  writeFileSync(fixture.profile, mapping);
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) }),
    /top-level mapping or scalar/,
  );
  assert.equal(readFileSync(fixture.profile, 'utf8'), mapping);
  assert.deepEqual(backupsOf(fixture.profile), []);
  const checked = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(checked.ok, false);
  assert.match(checked.message, /top-level mapping or scalar/);
});

test('the top-level shape check accepts empty, lone [] and block arrays only', () => {
  assert.equal(layerShape('').shape, 'empty');
  assert.equal(layerShape('# a comment\n\n').shape, 'empty');
  assert.deepEqual(layerShape(DSH_TEMPLATE), { shape: 'empty-flow', line: 3 });
  assert.equal(layerShape(PROFILE).shape, 'block-array');
  assert.equal(layerShape('- id: a\n  config:\n    mode: x\n').shape, 'block-array');
  assert.throws(() => layerShape('[]\n- id: a\n'), /top-level \[\] with other content/);
  assert.throws(() => layerShape('[{ id: a }]\n'), /flow array with entries/);
  assert.throws(() => layerShape('id: a\n'), /mapping or scalar/);
  assert.throws(() => layerShape('sandbox\n'), /mapping or scalar/);
  assert.throws(() => layerShape('- id: a\nid: b\n'), /not a list item/);
  assert.throws(() => layerShape('  - id: a\n'), /not a top-level list/);
});

test('install appends after a comments-only layer', () => {
  const fixture = makeFixture();
  const comments = '# no rows yet\n\n# still comments\n';
  writeFileSync(fixture.profile, comments);
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  assert.equal(readFileSync(fixture.profile, 'utf8'),
    `${comments}\n${sandboxBlock(fixture.wrapper)}\n`);
  assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }).ok, true);
});

test('install and check require an absolute wrapper path', () => {
  const fixture = makeFixture();
  const relative = 'hc-socket-mask.mjs';
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: relative }),
    /must be absolute/,
  );
  assert.equal(readFileSync(fixture.profile, 'utf8'), PROFILE);
  assert.deepEqual(backupsOf(fixture.profile), []);
  const checked = checkRow({ profile: fixture.profile, wrapper: relative });
  assert.equal(checked.ok, false);
  assert.match(checked.message, /must be absolute/);
  const cli = runHelper(['install', '--profile', fixture.profile, '--wrapper', relative]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr.trim().split('\n').length, 1);
  assert.ok(cli.stderr.startsWith(HELPER_PREFIX));
});

test('re-install is idempotent: one block, no second backup, no rewrite', () => {
  const fixture = makeFixture();
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  const first = readFileSync(fixture.profile, 'utf8');
  const second = installRow({
    profile: fixture.profile,
    wrapper: fixture.wrapper,
    now: new Date(2),
  });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(fixture.profile, 'utf8'), first);
  assert.equal(findManaged(first).begins.length, 1);
  assert.equal(backupsOf(fixture.profile).length, 1);
});

test('install into a profile that does not exist creates it with only the row', () => {
  const fixture = makeFixture();
  const profile = join(fixture.dir, 'fresh.yml');
  const result = installRow({ profile, wrapper: fixture.wrapper, now: new Date(1) });
  assert.equal(result.changed, true);
  assert.equal(result.backup, null);
  assert.equal(readFileSync(profile, 'utf8'), `${sandboxBlock(fixture.wrapper)}\n`);
  assert.equal(checkRow({ profile, wrapper: fixture.wrapper }).ok, true);
});

test('check fails when no managed row is there, and never writes', () => {
  const fixture = makeFixture();
  const result = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(result.ok, false);
  assert.match(result.message, /no managed dsh-sandbox block/);
  assert.equal(readFileSync(fixture.profile, 'utf8'), PROFILE);
  assert.deepEqual(backupsOf(fixture.profile), []);
});

test('check fails on an altered row and on a different wrapper path', () => {
  const fixture = makeFixture();
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  const installed = readFileSync(fixture.profile, 'utf8');
  writeFileSync(fixture.profile, installed.replace(
    "runnerFailureSignatures: ['hc-socket-mask: ']",
    'runnerFailureSignatures: []',
  ));
  const altered = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(altered.ok, false);
  assert.match(altered.message, /altered row or a different wrapper path/);
  writeFileSync(fixture.profile, installed);
  const other = join(fixture.root, 'other-wrapper.mjs');
  writeFileSync(other, '#!/usr/bin/env node\n', { mode: 0o755 });
  const different = checkRow({ profile: fixture.profile, wrapper: other });
  assert.equal(different.ok, false);
  // The file check compares did not change the profile.
  assert.equal(readFileSync(fixture.profile, 'utf8'), installed);
});

test('a duplicated or broken marker pair is refused, never collapsed', () => {
  const fixture = makeFixture();
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  const installed = readFileSync(fixture.profile, 'utf8');
  writeFileSync(fixture.profile, `${installed}\n${sandboxBlock(fixture.wrapper)}\n`);
  const duplicated = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(duplicated.ok, false);
  assert.match(duplicated.message, /keep exactly one block/);
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: fixture.wrapper }),
    /keep exactly one block/,
  );
  writeFileSync(fixture.profile, installed.replace(`\n${END}\n`, '\n'));
  const broken = checkRow({ profile: fixture.profile, wrapper: fixture.wrapper });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /end markers/);
});

test('install refuses a missing or non-executable wrapper and leaves the profile alone', () => {
  const fixture = makeFixture();
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: join(fixture.root, 'absent.mjs') }),
    /does not exist/,
  );
  chmodSync(fixture.wrapper, 0o644);
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: fixture.wrapper }),
    /not executable/,
  );
  assert.equal(readFileSync(fixture.profile, 'utf8'), PROFILE);
  assert.deepEqual(backupsOf(fixture.profile), []);
});

test('the default profile is $DSH_HOME/profiles/dsh-tui/cordis.patch.yml (~/.dsh)', () => {
  assert.equal(defaultProfile({ DSH_HOME: '/opt/dsh', HOME: '/home/a' }),
    '/opt/dsh/profiles/dsh-tui/cordis.patch.yml');
  assert.equal(defaultProfile({ HOME: '/home/a' }),
    '/home/a/.dsh/profiles/dsh-tui/cordis.patch.yml');
  assert.equal(defaultProfile({ DSH_HOME: '/opt/dsh' }),
    '/opt/dsh/profiles/dsh-tui/cordis.patch.yml');
});

test('the CLI installs and checks a temp profile, and exits 0/1 with one clear line', () => {
  const fixture = makeFixture();
  const install = runHelper([
    'install', '--profile', fixture.profile, '--wrapper', fixture.wrapper,
  ]);
  assert.equal(install.status, 0, install.stderr);
  const installLine = install.stdout.trim().split('\n');
  assert.equal(installLine.length, 1);
  assert.ok(installLine[0].startsWith('dsh-sandbox: '));
  assert.ok(installLine[0].includes(fixture.profile));

  const check = runHelper(['check', '--profile', fixture.profile, '--wrapper', fixture.wrapper]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim().split('\n').length, 1);

  writeFileSync(fixture.profile, PROFILE);
  const missing = runHelper(['check', '--profile', fixture.profile, '--wrapper', fixture.wrapper]);
  assert.equal(missing.status, 1);
  const failure = missing.stderr.trim().split('\n');
  assert.equal(failure.length, 1);
  assert.ok(failure[0].startsWith('dsh-sandbox: '));

  const usage = runHelper(['bogus']);
  assert.equal(usage.status, 2);
});

test('the shipped profile row snippet is OFF by default and carries the placeholder', () => {
  const snippet = readFileSync(new URL('../profile/sandbox-row.yml', import.meta.url), 'utf8');
  assert.match(snippet, /^- id: sandbox$/m);
  assert.match(snippet, /^ {2}config:$/m);
  assert.ok(snippet.includes(`runnerCommand: ['${PLACEHOLDER}', '--pack-root', '{{PACK_ROOT}}']`));
  assert.ok(snippet.includes("runnerFailureSignatures: ['hc-socket-mask: ']"));
  assert.doesNotMatch(snippet, /danger-full-access|workspace-write/);
  // The helper and the snippet are one row: only the markers (the helper's) are extra.
  const rows = snippet.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  const blockRows = sandboxBlock(PLACEHOLDER, '{{PACK_ROOT}}').split('\n')
    .filter((line) => line !== BEGIN && line !== END);
  assert.deepEqual(rows, blockRows);
  // The runner's own prefix is the row's failure signature, so DSH reports it as a runner failure.
  assert.equal(WRAPPER_PREFIX, FAILURE_SIGNATURE);
});

test('the managed block lists the pack folder the wrapper keeps read-only', () => {
  const block = sandboxBlock('/w/hc-socket-mask.mjs', '/packs/am-sidebar');
  assert.ok(block.includes("runnerCommand: ['/w/hc-socket-mask.mjs', '--pack-root', '/packs/am-sidebar']"), block);
  assert.ok(block.includes("runnerFailureSignatures: ['hc-socket-mask: ']"));
});

test('install and check carry --pack-root through the managed row', () => {
  const fixture = makeFixture();
  const pack = join(fixture.root, 'am-sidebar');
  mkdirSync(pack);
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, packRoot: pack, now: new Date(1) });
  const text = readFileSync(fixture.profile, 'utf8');
  assert.ok(text.includes(`'--pack-root', '${pack}'`), text);
  assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper, packRoot: pack }).ok, true);
  assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }).ok, false);
});

// #631 (the #642 review low 1): the DSH template's [] with a trailing comment, accepted only when
// every other line is blank or a full-line comment. Anything else keeps base's refusal (low 3,
// an indented [] inside a block array, included). Each row names the inputs it covers.

const COMMENTED_TEMPLATE = DSH_TEMPLATE.replace('[]\n', '[] # empty for now\n');

/** Refused before any write: the error matches, the bytes survive and no backup is taken. */
function assertRefused(text, error) {
  assert.throws(() => layerShape(text), error);
  const fixture = makeFixture();
  writeFileSync(fixture.profile, text);
  assert.throws(() => installRow({ profile: fixture.profile, wrapper: fixture.wrapper }), error);
  assert.equal(readFileSync(fixture.profile, 'utf8'), text);
  assert.deepEqual(backupsOf(fixture.profile), []);
}

test('631: install keeps the template [] trailing comment on its own line above the block', () => {
  const fixture = makeFixture();
  writeFileSync(fixture.profile, COMMENTED_TEMPLATE);
  assert.deepEqual(layerShape(COMMENTED_TEMPLATE), { shape: 'empty-flow', line: 3 });
  assert.deepEqual(layerShape('[]\t# c\n'), { shape: 'empty-flow', line: 0 });
  const installed = installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  assert.equal(installed.changed, true);
  assert.equal(readFileSync(fixture.profile, 'utf8'), COMMENTED_TEMPLATE.replace(
    '[] # empty for now\n', `# empty for now\n${sandboxBlock(fixture.wrapper)}\n`));
  assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }).ok, true);
  const again = installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(2) });
  assert.equal(again.changed, false);
  assert.equal(again.backup, null);
  assert.equal(backupsOf(fixture.profile).length, 1);
});

test('631: a template comment that reads as a marker stays a plain comment', () => {
  for (const marker of [BEGIN, END]) {
    const fixture = makeFixture();
    const text = `# Your patch layer\n[] ${marker}\n`;
    writeFileSync(fixture.profile, text);
    assert.doesNotThrow(() => {
      installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
    });
    const written = readFileSync(fixture.profile, 'utf8');
    assert.equal(written, `# Your patch layer\n ${marker}\n${sandboxBlock(fixture.wrapper)}\n`);
    const { begins, ends } = findManaged(written);
    assert.equal(begins.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }).ok, true);
    const again = installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(2) });
    assert.equal(again.changed, false);
    assert.equal(again.backup, null);
    assert.equal(backupsOf(fixture.profile).length, 1);
  }
});

test('631: the template comment runs to the line end (U+2028 and U+2029 inside it)', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const fixture = makeFixture();
    const text = `[] # x${separator}y\n`;
    let shape;
    assert.doesNotThrow(() => {
      shape = layerShape(text);
    });
    assert.deepEqual(shape, { shape: 'empty-flow', line: 0 });
    writeFileSync(fixture.profile, text);
    installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
    assert.equal(readFileSync(fixture.profile, 'utf8'),
      `# x${separator}y\n${sandboxBlock(fixture.wrapper)}\n`);
    assert.equal(checkRow({ profile: fixture.profile, wrapper: fixture.wrapper }).ok, true);
  }
});

test('631: a commented [] beside anything but blank lines and full-line comments keeps base', () => {
  const entries = /flow array with entries/;
  assertRefused('\u00a0[] # c\n', entries);
  assertRefused('\u00a0# kept\n[] # c\n', entries);
  assertRefused('[] # c\n- id: a\n', entries);
  assertRefused('[] # c\n[] # d\n', entries);
  assertRefused('# h\r\n[] # c\r\n', entries);
  assertRefused('"x\n[] # c\n"\n', /top-level mapping or scalar/);
  assertRefused('---\n[] # c\n', /top-level content that is not a list item/);
  assertRefused('  [] # c\n', /not a top-level list/);
  assertRefused('[]#x\n', entries);
  assertRefused(`${BEGIN}\n# keep me\n[] # c\n${END}\n`, /flow array with entries at line 3/);

  const fixture = makeFixture();
  const invalidUtf8 = Buffer.from([0x5b, 0x5d, 0x20, 0x23, 0x20, 0xff, 0x0a]);
  writeFileSync(fixture.profile, invalidUtf8);
  assert.throws(
    () => installRow({ profile: fixture.profile, wrapper: fixture.wrapper }),
    /flow array with entries at line 1/,
  );
  assert.deepEqual(readFileSync(fixture.profile), invalidUtf8);
  assert.deepEqual(backupsOf(fixture.profile), []);
});

test('631: an indented [] beside other content keeps base refusal (low 3 is not in this PR)', () => {
  const mixed = /top-level \[\] with other content/;
  for (const text of [
    '- id: a\n  config:\n    list:\n      []\n',
    '---\n- id: a\n  config:\n    list:\n      []\n',
    '- id: a\n  config:\n    note: |\n      []\n',
    '- note: |+\n    []\n',
    '--- "\n- a\n  []\n-"\n',
    '- id: a\n---\n- note: |\n    []\n',
    '---\n  []\n',
    '---\n[]\n',
    '- id: a\n---\n  []\n',
    '- id: a\n\t[]\n',
  ]) assertRefused(text, mixed);
});

test('631: a lone space-indented [] is still the template', () => {
  let shape;
  assert.doesNotThrow(() => {
    shape = layerShape('  []\n');
  });
  assert.deepEqual(shape, { shape: 'empty-flow', line: 0 });
  const fixture = makeFixture();
  writeFileSync(fixture.profile, '  []\n');
  installRow({ profile: fixture.profile, wrapper: fixture.wrapper, now: new Date(1) });
  assert.equal(readFileSync(fixture.profile, 'utf8'), `${sandboxBlock(fixture.wrapper)}\n`);
});
