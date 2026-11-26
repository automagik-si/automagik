import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRoleCatalog } from '../apps/bots-dsh/src/host/role-catalog.js';
import { createRolePackages } from '../apps/bots-dsh/src/host/role-package.js';
import { readRoleTar } from '../apps/bots-dsh/src/host/role-tar.js';
import { KEY_ID } from './lane';

const ROOT = join(import.meta.dir, '..');
const PLUGIN = 'apps/bots-dsh';
const SOURCES = PLUGIN + '/roles';
const ISSUED = '2026-11-20T03:00:00Z';
const BASE_URL = 'https://github.com/automagik-si/automagik/releases/download/';
const LIMIT = 256 * 1024;
const A = '3.90.1';
const B = '3.90.2';
const ROLE = 'sample-role';
const ARCHIVE = (version: string, id = ROLE) => 'automagik-role-' + id + '-' + version + '.tgz';
const manifest = (id = ROLE) => ({
  id, version: '0.0.0', name: 'Fixture Role', publisher: 'automagik', entry: 'role.mjs', prompt: 'prompt.md',
  description: 'A role for the fixture.', capabilities: ['audio-out'],
  tools: [{ name: 'sample_tool', description: 'Fixture tool', parameters: {} }], settings: [], ui: [],
});
const MODULE = Buffer.from('// fixture\r\nthrow Error("Fixture bytes must stay inert");\r\n');
const PROMPT = Buffer.from('A fixture prompt.\r\nSecond line.\r\n');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const catalogDir = (root: string, version: string) => join(root, 'out', version);

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'role-pack-'));
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function copy(root: string, path: string) {
  const dest = join(root, path);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(ROOT, path), dest, { recursive: true });
}

function put(root: string, path: string, bytes: string | Buffer) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function run(cwd: string, cmd: string, ...args: string[]) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

function ok(result: ReturnType<typeof run>) {
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error ?? result.status));
  return result.stdout;
}

function fail(result: ReturnType<typeof run>, pattern: RegExp) {
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(pattern);
}

function git(root: string, ...args: string[]) {
  return ok(run(root, 'git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args)).trim();
}

function commit(root: string, message: string) {
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function writeRole(root: string, id = ROLE, overrides = {}, script = MODULE) {
  const path = join(SOURCES, id);
  put(root, join(path, 'role.json'), JSON.stringify({ ...manifest(id), ...overrides }));
  put(root, join(path, 'role.mjs'), script);
  put(root, join(path, 'prompt.md'), PROMPT);
}

function repo() {
  const { root, clean } = scratch();
  for (const path of [
    'scripts/lane.ts', 'scripts/role-pack.ts', 'scripts/version.ts', 'am/part.json', 'meter/usagemeter/part.json',
    ...['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'multiuser-dsh', 'vault-dsh', 'welcome-dsh'].map(plugin => 'apps/' + plugin + '/package.json'),
    ...['role-catalog.js', 'role-keys.json', 'role-package.js', 'role-tar.js', 'refusal.js', 'bounded-get.js', 'no-runner.js', 'bundled-roles.js', 'bundled-roles.json', 'lane-verify.js'].map(file => PLUGIN + '/src/host/' + file),
    PLUGIN + '/src/shared/roles.js', PLUGIN + '/src/shared/solver-method.js',
  ]) copy(root, path);
  put(root, '.gitignore', '/out/\n/' + PLUGIN + '/src/host/bundled-roles.json\n');
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'diff.renames', 'true');
  const keys = signer();
  put(root, 'plugin-lane/keys.json', JSON.stringify({ keys: keys.keys }));
  const base = commit(root, 'fixture base');
  return { root, clean, base, ...keys };
}

function signer() {
  const pair = generateKeyPairSync('ed25519');
  const keys = [{ keyId: KEY_ID, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  return {
    keys,
    signFiles(dir: string, json: string) {
      const bytes = Buffer.from(json);
      put(dir, 'roles.json', bytes);
      put(dir, 'roles.json.sig', sign(null, bytes, pair.privateKey).toString('base64') + '\n');
    },
  };
}

function lane(root: string, ...args: string[]) {
  return run(root, process.execPath, 'scripts/lane.ts', ...args);
}

function pack(root: string, dir: string, version: string, previous?: string, sha = git(root, 'rev-parse', 'HEAD')) {
  const previousDir = previous && catalogDir(root, previous);
  return lane(root, 'pack-roles', dir, version, sha, ...(previousDir
    ? ['--predecessor', join(previousDir, 'roles.json'), join(previousDir, 'roles.json.sig'), previous!]
    : ['--no-predecessor']));
}

function cut(fixture: ReturnType<typeof repo>, version: string, previous?: string) {
  const { root } = fixture;
  const dir = catalogDir(root, version);
  ok(pack(root, dir, version, previous));
  const json = ok(lane(root, 'roles-manifest', version, ISSUED, dir));
  fixture.signFiles(dir, json);
  ok(verify(root, dir, version));
  return { dir, catalog: JSON.parse(json) };
}

function verify(root: string, dir: string, version: string) {
  return lane(root, 'verify-roles', join(dir, 'roles.json'), join(dir, 'roles.json.sig'), version);
}

test('every role source in this repository packs and validates at HEAD', () => {
  ok(lane(ROOT, 'check-roles'));
});

test('archives preserve Git bytes across dirty clones and have fixed small and multi-block digests', () => {
  const fixture = repo();
  const { root } = fixture;
  try {
    writeRole(root);
    chmodSync(join(root, SOURCES, ROLE, 'role.mjs'), 0o755);
    const multi = Buffer.concat([MODULE, Buffer.alloc(70000, 32)]);
    const big = Buffer.concat([MODULE, Buffer.alloc(1024 * 1024 + 19, 32)]);
    writeRole(root, 'multi-block', {}, multi);
    writeRole(root, 'large-role', {}, big);
    // The packer imports the mapping from disk in both checkouts.
    git(root, 'add', '--force', PLUGIN + '/src/host/bundled-roles.json');
    commit(root, 'three roles');

    const first = cut(fixture, A);
    const clone = join(root, 'out', 'clone');
    git(root, '-c', 'core.autocrlf=true', 'clone', '-q', '-c', 'core.autocrlf=true', root, clone);
    expect(git(clone, 'config', 'core.autocrlf')).toBe('true');
    expect(git(root, 'config', 'core.autocrlf')).toBe('false');
    put(root, join(SOURCES, ROLE, 'prompt.md'), 'dirty original\n');
    put(clone, join(SOURCES, 'multi-block', 'role.mjs'), 'dirty clone\n');
    const dirty = join(root, 'out', 'dirty');
    const cloneOut = join(clone, 'out', 'pack');
    ok(pack(root, dirty, A));
    ok(pack(clone, cloneOut, A));

    expect(first.catalog.roles.map((row: { id: string }) => row.id)).toEqual(['large-role', 'multi-block', ROLE]);
    const digests = new Map<string, string>();
    for (const [id, entry] of [
      [ROLE, MODULE],
      ['multi-block', multi],
      ['large-role', big],
    ] as const) {
      const name = ARCHIVE(A, id);
      const bytes = readFileSync(join(first.dir, name));
      expect(readFileSync(join(dirty, name))).toEqual(bytes);
      expect(readFileSync(join(cloneOut, name))).toEqual(bytes);
      const tar = gunzipSync(bytes);
      expect(tar.length % 10240).toBe(0);
      expect(bytes.subarray(0, 10).toString('hex')).toBe('1f8b08000000000000ff');
      let offset = 10;
      const blocks = [];
      while (offset < bytes.length - 8) {
        const length = bytes.readUInt16LE(offset + 1);
        const last = offset + 5 + length === bytes.length - 8;
        expect(bytes[offset]).toBe(last ? 1 : 0);
        expect(bytes.readUInt16LE(offset + 3)).toBe(length ^ 0xffff);
        if (!last) expect(length).toBe(65535);
        blocks.push(bytes.subarray(offset + 5, offset + 5 + length));
        offset += 5 + length;
      }
      expect(Buffer.concat(blocks)).toEqual(tar);
      // Independent bitwise CRC and the stored ISIZE.
      let crc = 0xffffffff;
      for (const byte of tar) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      expect(bytes.readUInt32LE(offset)).toBe((~crc) >>> 0);
      expect(bytes.readUInt32LE(offset + 4)).toBe(tar.length);

      const files = readRoleTar(bytes);
      expect([...files.keys()]).toEqual(['prompt.md', 'role.json', 'role.mjs']);
      expect(files.get('prompt.md')).toEqual(PROMPT);
      expect(files.get('role.mjs')).toEqual(entry);
      expect(files.get('role.json')?.toString()).toBe(JSON.stringify({ ...manifest(id), version: A }, null, 2) + '\n');
      let member = 0;
      for (const [file, data] of files) {
        expect(tar.toString('ascii', member, member + ('package/' + file).length)).toBe('package/' + file);
        expect(tar.toString('ascii', member + 100, member + 124)).toBe('0000644\0' + '0000000\0'.repeat(2));
        expect(tar.toString('ascii', member + 136, member + 148)).toBe('00000000000\0');
        expect(tar.toString('ascii', member + 156, member + 157)).toBe('0');
        expect(tar.toString('ascii', member + 257, member + 265)).toBe('ustar\x0000');
        member += 512 + Math.ceil(data.length / 512) * 512;
      }
      expect(tar.length - member).toBeGreaterThanOrEqual(1024);
      expect(tar.subarray(member).every(byte => byte === 0)).toBe(true);
      expect(readFileSync(join(first.dir, name + '.sha256'), 'utf8')).toBe(hash(bytes) + '  ' + name + '\n');
      digests.set(id, hash(bytes));
    }
    expect(digests.get(ROLE)).toBe('1e94a7d7a188ac5cc7042f344f6e74fd08423cb62735c78fbd97c42ce5ec9357');
    expect(digests.get('multi-block')).toBe('caff16214581218967bf9a387d2c66841b52fbda22c0710bd79ea1302ff946d9');
  } finally { fixture.clean(); }
});

test('ustar headers carry exact sizes and checksums with zero-filled fields and padding', () => {
  const fixture = repo();
  const { root } = fixture;
  try {
    writeRole(root);
    commit(root, 'archive header fixture');
    const { dir } = cut(fixture, A);
    const files = readRoleTar(readFileSync(join(dir, ARCHIVE(A))));
    const tar = gunzipSync(readFileSync(join(dir, ARCHIVE(A))));
    let offset = 0;
    for (const [file, bytes] of files) {
      const header = Buffer.from(tar.subarray(offset, offset + 512));
      expect(header.subarray(0, 100).toString('utf8').replaceAll(/\0+$/g, '')).toBe('package/' + file);
      expect(header.subarray(124, 136).toString('ascii')).toBe(bytes.length.toString(8).padStart(11, '0') + '\0');
      expect(header.subarray(148, 156).toString('ascii')).toMatch(/^[0-7]{6}\0 $/);
      expect(header.subarray(157, 257).every(byte => byte === 0)).toBe(true);
      expect(header.subarray(265).every(byte => byte === 0)).toBe(true);
      const recorded = Number.parseInt(header.toString('ascii', 148, 154), 8);
      header.fill(32, 148, 156);
      expect(recorded).toBe(header.reduce((sum, byte) => sum + byte, 0));
      const padded = Math.ceil(bytes.length / 512) * 512;
      expect(tar.subarray(offset + 512 + bytes.length, offset + 512 + padded).every(byte => byte === 0)).toBe(true);
      offset += 512 + padded;
    }
  } finally { fixture.clean(); }
});

test('pack-roles reports every artifact once in role-id order', () => {
  const fixture = repo();
  const { root } = fixture;
  try {
    for (const id of ['zeta-role', 'alpha-role']) writeRole(root, id);
    commit(root, 'two role sources');
    const dir = catalogDir(root, A);
    const summary = ok(pack(root, dir, A)).trimEnd().split('\n');
    expect(summary).toHaveLength(2);
    for (const [index, id] of ['alpha-role', 'zeta-role'].entries()) {
      const archive = ARCHIVE(A, id);
      expect(summary[index]).toBe(`${id} ${A} ${hash(readFileSync(join(dir, archive)))}`);
    }
  } finally { fixture.clean(); }
});

test('refuses malformed source layouts and manifest data from Git objects', () => {
  const fixture = repo();
  const { root, base } = fixture;
  const folder = join(SOURCES, ROLE);
  try {
    const cases: [string, () => void, RegExp][] = [
      ['extra file', () => put(root, join(folder, 'extra'), 'extra'), /exactly/],
      ['nested file', () => put(root, join(folder, 'nested/entry'), 'extra'), /regular role file/],
      ['symlink', () => symlinkSync('role.mjs', join(root, folder, 'link')), /regular role file/],
      ['README in roles', () => put(root, SOURCES + '/README.md', 'extra'), /role id|regular role file/],
      ['folder and id differ', () => writeRole(root, ROLE, { id: 'other' }), /equal its folder/],
      ...['genie', 'test', 'data', 'con'].map(id => [id, () => writeRole(root, id), /invalid or never-shipped role id/] as [string, () => void, RegExp]),
      ['publisher', () => writeRole(root, ROLE, { publisher: 'community' }), /invalid id, version, publisher/],
      ['capability', () => writeRole(root, ROLE, { capabilities: ['invalid'] }), /or capabilities/],
      ['description', () => writeRole(root, ROLE, { description: 'x'.repeat(201) }), /description/],
      ['display name', () => writeRole(root, ROLE, { name: 'x'.repeat(61) }), /publisher or name/],
      ['ustar name', () => {
        const entry = 'x'.repeat(100) + '.mjs';
        writeRole(root, ROLE, { entry });
        rmSync(join(root, folder, 'role.mjs'));
        put(root, join(folder, entry), MODULE);
      }, /ustar name exceeds/],
      ['UTF-8', () => put(root, join(folder, 'role.json'), Buffer.from([0xff])), /UTF-8 JSON/],
      ['entry size', () => put(root, join(folder, 'role.mjs'), Buffer.alloc(8 * 1024 * 1024 + 1, 32)), /entry size limit/],
      ['package size', () => {
        put(root, join(folder, 'role.mjs'), Buffer.alloc(8 * 1024 * 1024, 32));
        put(root, join(folder, 'prompt.md'), Buffer.alloc(8 * 1024 * 1024, 32));
      }, /16 MiB/],
    ];
    for (const [label, modify, pattern] of cases) {
      git(root, 'reset', '-q', '--hard', base);
      writeRole(root);
      modify();
      commit(root, label);
      fail(lane(root, 'check-roles'), pattern);
    }
    git(root, 'reset', '-q', '--hard', base);
    git(root, 'update-index', '--add', '--cacheinfo', '160000,' + base + ',' + folder);
    git(root, 'commit', '-qm', 'gitlink instead of a role directory');
    fail(lane(root, 'check-roles'), /regular role file/);

    git(root, 'reset', '-q', '--hard', base);
    writeRole(root, 'constructor');
    const constructor = commit(root, 'constructor is a valid id');
    const out = catalogDir(root, A);
    put(out, ARCHIVE(A) + '.sha256', 'orphan');
    fail(pack(root, out, A), /already holds/);
    rmSync(out, { recursive: true });
    fail(pack(root, out, A, undefined, base), /HEAD must equal/);
    expect(lane(root, 'pack-roles', out, A, constructor).status).toBe(2);
    expect(lane(root, 'pack-roles', out, A, constructor, '--no-predecessor', '--predecessor').status).toBe(2);
    ok(lane(root, 'check-roles', base));
    ok(pack(root, out, A));
    expect(readdirSync(out).sort()).toEqual([ARCHIVE(A, 'constructor'), ARCHIVE(A, 'constructor') + '.sha256']);
    git(root, 'reset', '-q', '--hard', base);
    const empty = catalogDir(root, B);
    expect(ok(pack(root, empty, B))).toBe('');
    expect(existsSync(empty)).toBe(false);
    expect(ok(lane(root, 'roles-manifest', B, ISSUED, empty))).toBe(ok(lane(root, 'roles-manifest', B, ISSUED)));
  } finally { fixture.clean(); }
}, 30000);

test('ships and kind account for role additions, edits, removals and renames on both baselines', () => {
  const { root, clean, base } = repo();
  const decide = (full: string, last: string, expected = 'plugins') => {
    expect(ok(lane(root, 'ships', last)).trim()).toBe('yes');
    expect(ok(lane(root, 'kind', full, last)).trim()).toBe(expected);
  };
  try {
    writeRole(root);
    const added = commit(root, 'add a role');
    decide(base, base);
    put(root, join(SOURCES, ROLE, 'prompt.md'), 'edited\n');
    const edited = commit(root, 'edit a role');
    decide(base, added);
    rmSync(join(root, SOURCES, ROLE), { recursive: true });
    commit(root, 'remove a role');
    decide(added, edited);

    git(root, 'reset', '-q', '--hard', edited);
    put(root, 'scripts/role-format-fixture.txt', 'inert between releases\n');
    const last = commit(root, 'format-only change');
    expect(ok(lane(root, 'ships', edited)).trim()).toBe('no');
    git(root, 'mv', join(SOURCES, ROLE), 'scripts/moved-role');
    commit(root, 'move role to an inert path');
    for (const baseline of [edited, last]) {
      const detected = git(root, 'diff', '--name-status', baseline + '..HEAD');
      expect(detected).toContain('R100');
      expect(git(root, 'diff', '--name-only', baseline + '..HEAD')).not.toContain(SOURCES);
    }
    decide(edited, last);

    // Isolate the full-baseline and last-baseline effects.
    put(root, 'herdr/mods/fixture/main.js', '// changed\n');
    commit(root, 'a herdr change with a rename since the last tag');
    decide(edited, last);
    git(root, 'reset', '-q', '--hard', last);
    put(root, 'apps/bots-dsh/roles-adjacent/example.md', 'unpacked\n');
    commit(root, 'adjacent but outside the role directory');
    expect(ok(lane(root, 'ships', last)).trim()).toBe('no');
    put(root, join(SOURCES, ROLE, 'prompt.md'), 'edited again\n');
    put(root, 'apps/desktop/src/example.js', '// changed\n');
    commit(root, 'role and desktop');
    decide(edited, last, 'full');
  } finally { clean(); }
});

test('catalog derives its rows from artifacts and detects omissions and re-signed mismatches', () => {
  const fixture = repo();
  const { root, signFiles } = fixture;
  try {
    writeRole(root);
    commit(root, 'a role');
    const { dir, catalog } = cut(fixture, A);
    const name = ARCHIVE(A);
    const tar = readFileSync(join(dir, name));
    const sidecar = readFileSync(join(dir, name + '.sha256'));
    expect(catalog.roles).toEqual([{
      id: ROLE, version: A, name: 'Fixture Role', publisher: 'automagik', official: true,
      sha256: hash(tar), size: tar.length, capabilities: ['audio-out'], source: BASE_URL + 'v' + A + '/' + name,
      description: 'A role for the fixture.', tools: ['sample_tool'],
    }]);
    const entry = catalog.roles[0];
    const resign = (roles = catalog.roles) => signFiles(dir, JSON.stringify({ ...catalog, roles }, null, 2) + '\n');
    for (const override of [
      { size: entry.size + 1 }, { sha256: 'f'.repeat(64) }, { source: entry.source + '.old' }, { name: 'Wrong name' },
      { capabilities: ['task-start'] }, { description: 'Wrong description' }, { tools: ['wrong_tool'] }, { version: B },
    ]) {
      resign([{ ...entry, ...override }]);
      fail(verify(root, dir, A), /metadata does not match/);
    }
    resign([entry, entry]);
    fail(verify(root, dir, A), /duplicate role id/);
    resign([]);
    fail(verify(root, dir, A), /omits a staged role/);

    const write = () => lane(root, 'roles-manifest', A, ISSUED, dir);
    for (const [asset, message] of [
      [name + '.sha256', /missing .sha256/], [name, /orphan role artifact/],
    ] as const) {
      const bytes = readFileSync(join(dir, asset));
      rmSync(join(dir, asset));
      resign();
      fail(write(), message);
      fail(verify(root, dir, A), message);
      put(dir, asset, bytes);
    }
    put(dir, name + '.sha256', 'f'.repeat(64) + '  ' + name + '\n');
    resign();
    fail(verify(root, dir, A), /checksum does not match/);
    put(dir, name + '.sha256', sidecar);
    for (const extra of ['automagik-role-extra.tgz.sha256', 'automagik-role-extra.tgz.sha256.old']) {
      put(dir, extra, '');
      resign();
      fail(write(), /extra or orphan role artifact/);
      fail(verify(root, dir, A), /extra or orphan role artifact/);
      rmSync(join(dir, extra));
    }

    const other = ARCHIVE(B);
    put(dir, other, tar);
    put(dir, other + '.sha256', hash(tar) + '  ' + other + '\n');
    fail(write(), /filename does not match/);
    const otherDir = join(root, 'out', 'other');
    ok(pack(root, otherDir, B));
    for (const asset of readdirSync(otherDir)) cpSync(join(otherDir, asset), join(dir, asset));
    fail(write(), /duplicate role/);
    resign();
    fail(verify(root, dir, A), /duplicate role/);
    rmSync(join(dir, other));
    rmSync(join(dir, other + '.sha256'));

    // Pair deletion is visible from both the unsigned Write and the signed Check.
    rmSync(join(dir, name));
    rmSync(join(dir, name + '.sha256'));
    fail(write(), /source inventory/);
    resign();
    fail(verify(root, dir, A), /source inventory/);
    resign([]);
    fail(verify(root, dir, A), /source inventory/);

    // A signed empty inventory for a checkout without sources still refuses a staged pair.
    rmSync(join(root, SOURCES), { recursive: true });
    put(dir, name, tar);
    put(dir, name + '.sha256', sidecar);
    resign([]);
    fail(verify(root, dir, A), /source inventory/);
  } finally { fixture.clean(); }
});

test('Write and Check accept exactly 200 roles and 256 KiB including the newline', () => {
  const fixture = repo();
  const { root, signFiles } = fixture;
  try {
    for (let i = 0; i < 201; i++) writeRole(root, 'role-' + String(i).padStart(3, '0'));
    commit(root, '201 roles');
    const dir = catalogDir(root, A);
    ok(pack(root, dir, A));
    fail(lane(root, 'roles-manifest', A, ISSUED, dir), /at most 200/);
    rmSync(join(root, SOURCES, 'role-200'), { recursive: true });
    for (const suffix of ['', '.sha256']) rmSync(join(dir, ARCHIVE(A, 'role-200') + suffix));
    const plain = ok(lane(root, 'roles-manifest', A, '', dir));
    // JSON's escaped control bytes keep the argument below the OS's per-argument limit.
    const padding = (size: number) => '\u0001'.repeat(Math.floor(size / 6)) + 'x'.repeat(size % 6);
    const issuedAt = padding(LIMIT - Buffer.byteLength(plain));
    const exact = ok(lane(root, 'roles-manifest', A, issuedAt, dir));
    expect(Buffer.byteLength(exact)).toBe(LIMIT);
    const catalog = JSON.parse(exact);
    expect(catalog.roles).toHaveLength(200);
    signFiles(dir, exact);
    ok(verify(root, dir, A));
    const tooMany = JSON.parse(plain);
    tooMany.roles.push(tooMany.roles[0]);
    signFiles(dir, JSON.stringify(tooMany) + '\n');
    fail(verify(root, dir, A), /at most 200/);
    fail(lane(root, 'roles-manifest', A, issuedAt + 'x', dir), /256 KiB/);
    signFiles(dir, exact + '\n');
    fail(verify(root, dir, A), /256 KiB/);

    const empty = join(root, 'out', 'empty');
    rmSync(join(root, SOURCES), { recursive: true });
    const emptyPlain = ok(lane(root, 'roles-manifest', A, ''));
    const pad = padding(LIMIT - Buffer.byteLength(emptyPlain));
    const emptyExact = ok(lane(root, 'roles-manifest', A, pad, empty));
    expect(Buffer.byteLength(emptyExact)).toBe(LIMIT);
    signFiles(empty, emptyExact);
    ok(verify(root, empty, A));
    fail(lane(root, 'roles-manifest', A, pad + 'x'), /256 KiB/);
    signFiles(empty, emptyExact + '\n');
    fail(verify(root, empty, A), /256 KiB/);
  } finally { fixture.clean(); }
}, 30000);

test('check-roles budgets for a full release stamp at the 256 KiB boundary', () => {
  const fixture = repo();
  const { root } = fixture;
  try {
    const version = '999.999.999';
    const ids = Array.from({ length: 200 }, (_, i) => 'role-' + String(i).padStart(3, '0'));
    for (const id of ids) writeRole(root, id, { description: '' });
    commit(root, 'roles with empty descriptions');
    const baseline = join(root, 'out', 'baseline');
    ok(pack(root, baseline, version));
    const plain = ok(lane(root, 'roles-manifest', version, ISSUED, baseline));
    const remaining = LIMIT - Buffer.byteLength(plain);
    const descriptions = ids.map((_, i) => {
      const bytes = Math.floor(remaining / ids.length) + Number(i < remaining % ids.length);
      // A control character takes six bytes in JSON, well within the description's character limit.
      return '\u0001'.repeat(Math.floor(bytes / 6)) + 'x'.repeat(bytes % 6);
    });
    ids.forEach((id, i) => writeRole(root, id, { description: descriptions[i] }));
    commit(root, 'exact catalog limit');
    const exact = join(root, 'out', 'exact');
    ok(pack(root, exact, version));
    expect(Buffer.byteLength(ok(lane(root, 'roles-manifest', version, ISSUED, exact)))).toBe(LIMIT);
    ok(lane(root, 'check-roles'));

    const last = ids.length - 1;
    writeRole(root, ids[last], { description: descriptions[last] + 'x' });
    commit(root, 'one byte past the catalog limit');
    const over = join(root, 'out', 'over');
    ok(pack(root, over, version));
    fail(lane(root, 'roles-manifest', version, ISSUED, over), /256 KiB/);
    fail(lane(root, 'check-roles'), /256 KiB/);
  } finally { fixture.clean(); }
}, 30000);

test('role versions follow the predecessor digest and published removals', () => {
  const fixture = repo();
  const { root, signFiles } = fixture;
  try {
    writeRole(root);
    commit(root, 'original role');
    const first = cut(fixture, A);
    const common = first.catalog.roles[0];
    const assertStamp = (version: string, previous: string, stamp: string) => {
      const next = cut(fixture, version, previous);
      const row = next.catalog.roles[0];
      expect(next.catalog.version).toBe(version);
      expect(row.version).toBe(stamp);
      expect(row.source).toBe(BASE_URL + 'v' + version + '/' + ARCHIVE(stamp));
      expect(JSON.parse(readRoleTar(readFileSync(join(next.dir, ARCHIVE(stamp)))).get('role.json')!).version).toBe(stamp);
      return next;
    };
    chmodSync(join(root, SOURCES, ROLE, 'role.mjs'), 0o755);
    put(root, join(SOURCES, ROLE, 'role.json'), JSON.stringify({ ...manifest(), version: '99.99.99' }, null, 4));
    commit(root, 'mode and source placeholder change');
    const same = assertStamp(B, A, A);
    expect(same.catalog.roles[0].sha256).toBe(common.sha256);
    expect(readFileSync(join(same.dir, ARCHIVE(A)))).toEqual(readFileSync(join(first.dir, ARCHIVE(A))));

    put(root, join(SOURCES, ROLE, 'prompt.md'), 'unpublished deviation\n');
    commit(root, 'unpublished change');
    put(root, join(SOURCES, ROLE, 'prompt.md'), PROMPT);
    commit(root, 'revert before publishing');
    assertStamp('3.90.3', B, A);

    put(root, join(SOURCES, ROLE, 'prompt.md'), 'published deviation\n');
    commit(root, 'published change');
    assertStamp('3.90.4', '3.90.3', '3.90.4');
    put(root, join(SOURCES, ROLE, 'prompt.md'), PROMPT);
    commit(root, 'restore the original source after publication');
    const reverted = assertStamp('3.90.5', '3.90.4', '3.90.5');

    // An earlier packer encoding the same files with a different gzip OS byte.
    const legacy = readFileSync(join(reverted.dir, ARCHIVE('3.90.5')));
    legacy[9] = 3;
    expect(readRoleTar(legacy).get('prompt.md')).toEqual(PROMPT);
    const row = { ...reverted.catalog.roles[0], sha256: hash(legacy) };
    signFiles(reverted.dir, JSON.stringify({ ...reverted.catalog, roles: [row] }));
    assertStamp('3.90.6', '3.90.5', '3.90.6');

    rmSync(join(root, SOURCES, ROLE), { recursive: true });
    commit(root, 'remove the role');
    expect(cut(fixture, '3.90.7', '3.90.6').catalog.roles).toEqual([]);
    writeRole(root);
    commit(root, 're-add the original role');
    assertStamp('3.90.8', '3.90.7', '3.90.8');
  } finally { fixture.clean(); }
});

test('the real npm plugin tarball has no roles source paths', () => {
  const { root, clean } = scratch();
  try {
    copy(root, PLUGIN);
    ok(run(join(root, PLUGIN), 'npm', 'pack', '--offline', '--ignore-scripts',
      '--cache', join(root, 'npm-cache'), '--pack-destination', root));
    const tarballs = readdirSync(root).filter(file => file.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    const paths = ok(run(root, 'tar', '-tzf', tarballs[0])).trim().split('\n');
    expect(paths).toContain('package/src/host/role-package.js');
    expect(paths.filter(path => path.startsWith('package/roles/')).sort()).toEqual([
      'package/roles/solver/prompt.md',
      'package/roles/solver/role.json',
      'package/roles/solver/role.mjs',
    ]);
  } finally { clean(); }
}, 30000);

test('the plugin archive carries the pure manifest validator export', () => {
  const { root, clean } = scratch();
  try {
    copy(root, PLUGIN);
    ok(run(join(root, PLUGIN), 'npm', 'pack', '--offline', '--ignore-scripts',
      '--cache', join(root, 'npm-cache'), '--pack-destination', root));
    const [archive] = readdirSync(root).filter(file => file.endsWith('.tgz'));
    expect(archive).toBeDefined();
    const extracted = run(root, 'tar', '-xzOf', archive, 'package/src/host/role-package.js');
    expect(ok(extracted)).toBe(readFileSync(join(ROOT, PLUGIN, 'src/host/role-package.js'), 'utf8'));
    expect(extracted.stdout).toContain('export { validateManifest as validateRoleManifest }');
  } finally { clean(); }
}, 30000);

test('the real catalog lists and installs each packed role, including voice-mouth, without evaluating its module', async () => {
  const fixture = repo();
  const { root, keys } = fixture;
  try {
    writeRole(root);
    copy(root, SOURCES + '/voice-mouth');
    commit(root, 'fixture and actual official role');
    const version = JSON.parse(readFileSync(join(ROOT, PLUGIN, 'package.json'), 'utf8')).version;
    const { dir, catalog: index } = cut(fixture, version);
    const url = BASE_URL + 'v' + version + '/';
    const fetched: string[] = [];
    const assets = new Map(readdirSync(dir).map(file => [url + file, readFileSync(join(dir, file))]));
    const catalog = createRoleCatalog({
      keys, canFetch: () => true, warn() {},
      fetch: async (url: string) => {
        fetched.push(url);
        const bytes = assets.get(url);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
    });
    const home = join(root, 'out', 'team');
    mkdirSync(home);
    const state = { bots: {}, prefs: {} };
    const packages = createRolePackages({ home, state, holdsLock: () => true,
      saveCopy: async (_apply: unknown, opts: { beforeCommit: () => void; afterWrite: () => void }) => {
        opts.beforeCommit(); opts.afterWrite();
      },
    }, catalog);
    const snapshot = await catalog.snapshot();
    expect(snapshot.view.available).toBe(true);
    expect(snapshot.view.roles).toEqual(index.roles.map(({ id, version, name, publisher, capabilities }) =>
      ({ id, version, name, publisher, capabilities, installable: true })));
    for (const row of index.roles) {
      expect(snapshot.entries?.get(row.id)?.details).toEqual({
        version, sha256: row.sha256, description: row.description, tools: row.tools,
      });
      expect(await packages.install(row.id)).toMatchObject({ id: row.id, version });
      const from = join(root, SOURCES, row.id);
      const into = join(home, 'roles', row.id, version);
      const source = JSON.parse(readFileSync(join(from, 'role.json'), 'utf8'));
      expect(readdirSync(into).sort()).toEqual(['prompt.md', 'role.json', 'role.mjs']);
      expect(readFileSync(join(into, 'role.json'), 'utf8')).toBe(JSON.stringify({ ...source, version }, null, 2) + '\n');
      for (const file of [source.entry, source.prompt]) expect(readFileSync(join(into, file))).toEqual(readFileSync(join(from, file)));
    }
    expect(fetched).toEqual([url + 'roles.json', url + 'roles.json.sig', ...index.roles.map(row => row.source)]);
    expect(index.roles[1]).toMatchObject({ id: 'voice-mouth', capabilities: ['audio-out'], tools: ['speak'] });
  } finally { fixture.clean(); }
});

test('a plugin upgrade keeps unchanged role pins attachable and flags byte-changing updates in the real shop', () => {
  const fixture = repo();
  const { root, keys } = fixture;
  try {
    writeRole(root);
    commit(root, 'source at A');
    const first = cut(fixture, A);
    const unchanged = cut(fixture, B, A);
    const patched = '3.90.3';
    put(root, join(SOURCES, ROLE, 'prompt.md'), 'Changed prompt.\n');
    commit(root, 'source with a new prompt');
    const changed = cut(fixture, patched, B);
    expect(unchanged.catalog.roles[0]).toMatchObject({
      id: ROLE, version: A, sha256: first.catalog.roles[0].sha256,
    });
    expect(changed.catalog.roles[0].version).toBe(patched);

    // Real host and shop modules in separate plugin-version folders. Only the
    // framework boundaries and the runtime module loader are doubled.
    for (const version of [A, B, patched]) {
      const plugin = join(root, 'out', 'consumer-' + version);
      for (const file of [
        'host/role-catalog.js', 'host/role-package.js', 'host/role-runtime.js', 'host/role-tar.js', 'host/role-settings.js',
        'host/role-voice.js', 'host/roles.js', 'host/role-keys.json', 'host/refusal.js', 'host/bounded-get.js', 'host/no-runner.js',
        'host/bundled-roles.js', 'host/bundled-roles.json', 'host/lane-verify.js', 'host/session-route.js', 'host/solver-progress.js',
        'host/solver-check-command.js', 'shared/solver-model.js',
        'shared/review-guard.js', 'shared/review-mark.js', 'shared/native-tools.js', 'shared/permission-levels.js',
        'shared/roles.js', 'shared/solver-method.js', 'shared/routes.js', 'shared/machine-reservations.js', 'shared/own-tools.js', 'client/role-shop.js', 'client/i18n.js',
        'shared/guard-groups.js', 'shared/solver-looks.js',
      ]) {
        put(plugin, 'src/' + file, readFileSync(join(ROOT, PLUGIN, 'src', file)));
      }
      put(plugin, 'src/host/tools.js', 'export const output = {};');
      put(plugin, 'src/client/bot-settings.js',
        'export const Card = "card", Row = "row", roleHealth = value => value, roleReadOnly = () => false;');
      put(plugin, 'package.json', JSON.stringify({ type: 'module', version }));
    }
    put(root, 'out/acceptance.mjs', String.raw`
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
const [a, b, changed, id, base, keyJson] = process.argv.slice(2);
const keys = JSON.parse(keyJson);
const shimUrl = 'fixture:';
const shims = new Map([
  ['fixture:react', 'export const createElement = (type, props, ...children) => ({ type, props, children });'],
  ['fixture:dsh-tools', 'export const defineTool = x => x, parameterSchemaSpecToJsonSchema = x => x;'],
]);
const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react') return { url: shimUrl + 'react', shortCircuit: true };
    if (specifier === '@deepseek-ai/dsh-tools') return { url: shimUrl + 'dsh-tools', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (shims.has(url)) return { format: 'module', source: shims.get(url), shortCircuit: true };
    if (url.startsWith('data:text/javascript;base64,')) {
      const [data, key] = url.split('#');
      const source = Buffer.from(data.split(',')[1], 'base64').toString('utf8');
      assert.match(source, /Fixture bytes must stay inert/);
      loaded.push(key);
      // Supply a synthetic tool so the retained-proof activation path is exercised
      // without evaluating the source bytes from any role archive.
      return { format: 'module', shortCircuit: true,
        source: 'export function install(api) { api.registerTool("sample_tool", () => "fixture"); }' };
    }
    return next(url, context);
  },
});
const assets = new Map();
for (const version of [a, b, changed]) {
  for (const name of readdirSync(version)) {
    assets.set(base + 'v' + version + '/' + name, readFileSync(join(version, name)));
  }
}
const home = join(process.cwd(), 'team');
mkdirSync(home);
const calls = [];
const fetch = async url => {
  calls.push(url);
  assert.ok(assets.has(url), 'Unexpected fixture URL ' + url);
  return new Response(assets.get(url));
};
const start = async (version, state) => {
  const source = './consumer-' + version + '/src/';
  const { installRoles } = await import(source + 'host/roles.js');
  const { createRoleCatalog } = await import(source + 'host/role-catalog.js');
  const { RoleShopCard, shopRoles } = await import(source + 'client/role-shop.js');
  const rt = { home, state, holdsLock: () => true,
    ctx: { effect() {} }, own: (records, key) => Object.hasOwn(records, key) ? records[key] : undefined,
    load: async () => {},
    saveCopy: async (apply, options) => { options.beforeCommit(); apply(structuredClone(state)); options.afterWrite(); },
  };
  const deps = { fetch, keys, canFetch: () => true, warn() {} };
  installRoles(rt, deps);
  return {
    rt, catalog: createRoleCatalog(deps),
    async updateBadge() {
      const roster = { prefs: state.prefs, bots: Object.values(state.bots),
        roles: await rt.roleRecordsView(), roleDetails: rt.roleDetailsView(), roleCatalog: rt.roleCatalogView() };
      const [row] = shopRoles(roster);
      const rendered = RoleShopCard({ row, roster, actions: {}, operation: {} });
      return rendered.children.some(child => child?.props?.label === 'Update available');
    },
  };
};
const state = { prefs: {}, bots: { 'fixture-one': { id: 'fixture-one' }, 'fixture-two': { id: 'fixture-two' } } };
const first = await start(a, state);
await first.rt.roleCatalog();
await first.rt.installRole(id);
assert.deepEqual(await first.rt.attachRole('fixture-one', id), [id]);
assert.deepEqual(first.rt.roleRuntime.view()['fixture-one'].tools, ['sample_tool']);
const record = structuredClone(state.roles[id]);
const pin = structuredClone(state.bots['fixture-one'].roles[0]);
first.rt.roleRuntime.dispose();

const stable = await start(b, structuredClone(state));
await stable.rt.roleCatalog();
const index = await stable.catalog.snapshot();
const row = index.entries.get(id);
assert.equal(JSON.parse(index.bytes).version, b);
assert.equal(row.display.version, a);
assert.equal(row.sha256, record.sha256);
assert.equal(row.source, base + 'v' + b + '/automagik-role-' + id + '-' + a + '.tgz');
assert.deepEqual(assets.get(row.source), assets.get(record.source));
assert.equal(await stable.updateBadge(), false);
await stable.rt.roleRuntime.ready('fixture-one');
assert.deepEqual(stable.rt.roleRuntime.view()['fixture-one'].tools, ['sample_tool']);
assert.deepEqual(stable.rt.state.bots['fixture-one'].roles[0], pin);

// A separate cold start with only an unattached Bot exercises catalog-based
// admission before retained proof has authenticated any existing attachment.
const detached = structuredClone(state);
delete detached.bots['fixture-one'];
const fresh = await start(b, structuredClone(detached));
await fresh.rt.roleCatalog();
assert.equal(fresh.rt.roleDetailsView()[id].installed.verified, undefined);
assert.deepEqual(await fresh.rt.attachRole('fixture-two', id), [id]);
assert.equal(fresh.rt.state.bots['fixture-two'].roles[0].version, a);
assert.deepEqual(fresh.rt.state.roles[id], record);

const update = await start(changed, structuredClone(detached));
await update.rt.roleCatalog();
assert.equal(update.rt.roleCatalogView().roles[0].version, changed);
assert.equal(await update.updateBadge(), true);
await assert.rejects(update.rt.attachRole('fixture-two', id), /source cannot be confirmed/);
const retained = await start(changed, structuredClone(state));
await retained.rt.roleCatalog();
await retained.rt.roleRuntime.ready('fixture-one');
assert.deepEqual(retained.rt.roleRuntime.view()['fixture-one'].tools, ['sample_tool']);
assert.deepEqual(retained.rt.state.bots['fixture-one'].roles[0], pin);
assert.deepEqual(retained.rt.state.roles[id], record);
assert.ok(loaded.every(key => key === id + '@' + a + ':' + record.sha256));

const wrong = await start(b, structuredClone(detached));
assets.set(base + 'v' + b + '/roles.json', assets.get(base + 'v' + a + '/roles.json'));
assets.set(base + 'v' + b + '/roles.json.sig', assets.get(base + 'v' + a + '/roles.json.sig'));
assert.equal((await wrong.catalog.snapshot()).view.reason, 'unverified');
assert.ok(calls.includes(record.source));
for (const instance of [stable, fresh, update, retained, wrong]) instance.rt.roleRuntime.dispose();
`);
    ok(run(join(root, 'out'), 'node', 'acceptance.mjs', A, B, patched, ROLE, BASE_URL, JSON.stringify(keys)));
  } finally { fixture.clean(); }
}, 30000);
