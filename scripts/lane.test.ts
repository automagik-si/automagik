import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync as mkdir, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AM, METER, METER_CONTRACT, METER_KEYS, addonPinsOnly, contractHeld, keysHeld, meterHold, amPaths, globPattern, herdrShips, kindOf, LANE_ADDONS, manifest, meterHeld, meterPaths, meterShips, meterSince, nextPatch, pocketShips, pocketSince, sequenceOf, ships, signLane, unpackedIn, verifyLane, versionOnly } from './lane';

describe('the plugin lane', () => {
  test('only changes inside the plugins ride the lane; anything the app or an install sees is a full release', () => {
    const none = () => false;
    expect(kindOf(['apps/bots-dsh/src/client/mark.js', 'apps/welcome-dsh/client.js', 'marketplace/automagik.json'], none)).toBe('plugins');
    expect(kindOf(['apps/bots-dsh/src/client/mark.js', 'apps/desktop/src/main.js'], none)).toBe('full');
    expect(kindOf(['apps/bots-dsh/dev/harness/package.json'], none)).toBe('full');
    expect(kindOf(['apps/welcome-dsh/bun.lock'], none)).toBe('full');
    expect(kindOf(['.github/workflows/release.yml', 'scripts/lane.ts', 'scripts/version.test.ts', 'apps/desktop/test/version.test.js', 'AGENTS.md', 'apps/welcome-dsh/client.js'], none)).toBe('plugins');
    expect(kindOf(['apps/desktop/package.json', 'apps/welcome-dsh/client.js'], none)).toBe('full');
    expect(kindOf(['apps/desktop/package.json', 'apps/desktop/package-lock.json', 'package.json', 'apps/welcome-dsh/client.js'], none, path => path !== 'apps/welcome-dsh/client.js')).toBe('plugins');
    expect(kindOf(['apps/desktop/electron-builder.yml', 'apps/welcome-dsh/client.js'], none, () => false)).toBe('full');
    expect(kindOf(['apps/bots-dsh/package.json'], plugin => plugin === 'bots-dsh')).toBe('full');
    expect(kindOf([], none)).toBe('full');
    expect(kindOf(['apps/automagik-pets/src/bake.js', 'apps/automagik-pets/bun.lock', 'apps/bots-dsh/client.js'], none)).toBe('plugins');
    // Meter's local tools ship nothing: a meter/ change beside a plugin is still a plugin patch.
    expect(kindOf(['meter/statusline/automagik-statusline.mjs', 'meter/statusline/test/statusline.test.mjs', 'apps/bots-dsh/client.js'], none)).toBe('plugins');
  });

  test('an engines-only rc.2 floor change selects a full release', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lane-engines-'));
    const root = join(import.meta.dir, '..');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    try {
      for (const path of ['scripts/lane.ts', 'scripts/version.ts', 'scripts/release-plugins.ts', 'package.json', 'am/part.json', 'meter/usagemeter/part.json',
        'meter/usagemeter/Cargo.toml', 'meter/usagemeter/Cargo.lock', 'apps/acp-dsh/package.json', 'apps/bots-dsh/package.json',
        'apps/locale-pt-br-dsh/package.json', 'apps/welcome-dsh/package.json']) {
        mkdir(dirname(join(repo, path)), { recursive: true });
        cpSync(join(root, path), join(repo, path));
      }
      const file = join(repo, 'apps/bots-dsh/package.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.engines.dsh = '>=0.2.2-rc.1 <0.3.0-0';
      writeFileSync(file, JSON.stringify(manifest));
      git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base'); git('tag', 'v3.200.0');
      manifest.engines.dsh = '>=0.2.2-rc.2 <0.3.0-0';
      writeFileSync(file, JSON.stringify(manifest));
      git('commit', '-qam', 'build(dsh): raise the floor');
      const result = spawnSync('bun', [join(repo, 'scripts/lane.ts'), 'kind', 'v3.200.0', 'v3.200.0'], { cwd: repo, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('full');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('the usagemeter crate ships on the meter lane, its notes and tests never (RFC 0017 delivery 4)', () => {
    const none = () => false;
    const crate = ['meter/usagemeter/src/main.rs', 'meter/usagemeter/install.sh', 'meter/usagemeter/part.json', 'meter/usagemeter/.gitignore'];
    for (const path of crate) expect(ships([path], none)).toBe(true);
    expect(meterShips(crate)).toBe(true);
    // Its top-level notes and its tests/ (Rust's name) never ship; a nested .md in src/ is the crate's.
    const notes = ['meter/usagemeter/README.md', 'meter/usagemeter/CHANGELOG.md', 'meter/usagemeter/tests/install.sh', 'meter/usagemeter/tests/fixtures/a.jsonl'];
    expect(ships(notes, none)).toBe(false);
    expect(meterShips(notes)).toBe(false);
    expect(meterShips(['meter/usagemeter/src/notes.md'])).toBe(true);
    expect(herdrShips(crate)).toBe(false);
    expect(pocketShips(crate)).toBe(false);
    expect(AM.test('meter/usagemeter/src/main.rs')).toBe(false);
  });

  test('a statusline-only or schema-only change ships nothing; the meter part is meter/usagemeter alone', () => {
    const none = () => false;
    const local = ['meter/statusline/automagik-statusline.mjs', 'meter/statusline/claude-limits-statusline.mjs', 'meter/statusline/README.md'];
    const schema = ['meter/schema/query/v1/envelope.schema.json', 'meter/schema/query/v1/examples/usage.json', 'meter/schema/query/v1/repo-normalization.json'];
    for (const changed of [local, schema, [...local, ...schema]]) {
      expect(ships(changed, none)).toBe(false);
      expect(meterShips(changed)).toBe(false);
    }
    expect(METER.test('meter/statusline/automagik-statusline.mjs')).toBe(false);
    expect(METER.test('meter/schema/query/v1/envelope.schema.json')).toBe(false);
    expect(METER.test('meter/usagemeterx/a')).toBe(false);
    expect(meterPaths({ paths: ['meter/usagemeter/**'] }).map(String)).toEqual(['/^meter\\/usagemeter\\/.*$/']);
    // A file directly under meter/ matches no part and is a full release, on purpose (RFC 0017).
    expect(ships(['meter/Cargo.toml'], none)).toBe(true);
    expect(kindOf(['meter/Cargo.toml'], none, none, ['meter/Cargo.toml'])).toBe('full');
  });

  test('a meter-only change is a meter patch; the meter never makes a release more than it is otherwise', () => {
    const none = () => false;
    const meter = ['meter/usagemeter/src/main.rs', 'meter/usagemeter/Cargo.toml'];
    expect(kindOf(meter, none, none, meter)).toBe('meter');
    // With what ships nothing (its notes, tests, the tooling, the statusline), still a meter patch.
    const withNotes = [...meter, 'meter/usagemeter/README.md', 'meter/usagemeter/tests/install.sh', 'meter/statusline/automagik-statusline.mjs', 'scripts/lane.ts', 'docs/rfcs/0017-usagemeter-crate.md'];
    expect(kindOf(withNotes, none, none, withNotes)).toBe('meter');
    // With am: a meter patch, am along (every release carries it).
    expect(kindOf([...meter, 'am/bin/am.mjs'], none, none, [...meter, 'am/bin/am.mjs'])).toBe('meter');
    // With herdr/: a herdr patch, and it builds both.
    const withHerdr = [...meter, 'herdr/mods/am-sidebar/meterFleet.js'];
    expect(kindOf(withHerdr, none, none, withHerdr)).toBe('herdr');
    expect(herdrShips(withHerdr)).toBe(true);
    expect(meterShips(withHerdr)).toBe(true);
    // With Pocket: a pocket patch; beside plugins: a plugin patch; beside the app: a full release.
    const withPocket = [...meter, 'apps/pocket/android/app/build.gradle.kts'];
    expect(kindOf(withPocket, none, none, withPocket)).toBe('pocket');
    expect(kindOf(['apps/bots-dsh/client.js', ...meter], none, none, ['apps/bots-dsh/client.js', ...meter])).toBe('plugins');
    expect(kindOf(['apps/desktop/src/main.js', ...meter], none, none, ['apps/desktop/src/main.js', ...meter])).toBe('full');
    // The plugin loop skips the meter as it skips herdr/, apps/pocket/ and am/: never a full release on its own.
    expect(kindOf(meter, none)).toBe('plugins');
    // A meter change since the last full release, but nothing shipping since the last release: the plugin rule.
    expect(kindOf(['apps/bots-dsh/client.js', ...meter], none, none, ['meter/usagemeter/README.md'])).toBe('plugins');
  });

  test('a chore(release) bump of the crate\'s two version lines cuts no meter release; a real crate change does', () => {
    const toml = readFileSync(join(import.meta.dir, '..', 'meter', 'usagemeter', 'Cargo.toml'), 'utf8');
    const lock = readFileSync(join(import.meta.dir, '..', 'meter', 'usagemeter', 'Cargo.lock'), 'utf8');
    const bump = (text: string) => text.replace(/^version = "\d+\.\d+\.\d+"$/m, 'version = "3.999.998"');
    const bumpLock = (text: string) => text.replace(/(\[\[package\]\]\nname = "usagemeter"\nversion = )"[^"]*"/, '$1"3.999.998"');
    expect(bump(toml)).not.toBe(toml);
    expect(bumpLock(lock)).not.toBe(lock);
    expect(versionOnly('meter/usagemeter/Cargo.toml', toml, bump(toml))).toBe(true);
    expect(versionOnly('meter/usagemeter/Cargo.lock', lock, bumpLock(lock))).toBe(true);
    // The release's own commit: the crate's two lines and the other version files.
    const bumped = ['meter/usagemeter/Cargo.toml', 'meter/usagemeter/Cargo.lock', 'package.json', 'am/VERSION', 'herdr/package.json'];
    const after: Record<string, string> = { 'meter/usagemeter/Cargo.toml': bump(toml), 'meter/usagemeter/Cargo.lock': bumpLock(lock) };
    const before: Record<string, string> = { 'meter/usagemeter/Cargo.toml': toml, 'meter/usagemeter/Cargo.lock': lock };
    const inert = (path: string) => path in after ? versionOnly(path, before[path], after[path]) : !METER.test(path);
    expect(meterShips(bumped, inert)).toBe(false);
    expect(ships(bumped.filter(path => METER.test(path)), inert)).toBe(false);
    // A real change: a dependency moved beside the version, another crate's lock entry, or any other line.
    const dep = bump(toml).replace(/^serde_json = "1"$/m, 'serde_json = "1.0.200"');
    expect(dep).not.toBe(bump(toml));
    expect(versionOnly('meter/usagemeter/Cargo.toml', toml, dep)).toBe(false);
    const memchr = bumpLock(lock).replace(/(name = "memchr"\nversion = )"[^"]*"/, '$1"9.9.9"');
    expect(memchr).not.toBe(bumpLock(lock));
    expect(versionOnly('meter/usagemeter/Cargo.lock', lock, memchr)).toBe(false);
    expect(versionOnly('meter/usagemeter/Cargo.toml', toml, toml.replace('edition = "2024"', 'edition = "2021"'))).toBe(false);
    after['meter/usagemeter/Cargo.toml'] = dep;
    expect(meterShips(bumped, inert)).toBe(true);
    // Only a release version: a fourth part, or a version line gone, is a real change.
    expect(versionOnly('meter/usagemeter/Cargo.toml', toml, toml.replace(/^version = "[^"]*"$/m, 'version = "3.1.2.3"'))).toBe(false);
    expect(versionOnly('meter/usagemeter/Cargo.toml', toml, toml.replace(/^version = "[^"]*"\n/m, ''))).toBe(false);
    // A file missing on either side is a real change; the JSON and plain-text rules stand as they were.
    expect(versionOnly('meter/usagemeter/Cargo.toml', undefined, toml)).toBe(false);
    expect(versionOnly('herdr/mods/am-sidebar/VERSION', '3.1.0\n', '3.1.1\n')).toBe(true);
    expect(versionOnly('herdr/mods/am-sidebar/VERSION', '3.1.0\n', 'oops\n')).toBe(false);
    expect(versionOnly('package.json', '{"name":"a","version":"3.1.0"}', '{"name":"a","version":"3.1.1"}')).toBe(true);
    expect(versionOnly('package.json', '{"name":"a","version":"3.1.0"}', '{"name":"b","version":"3.1.1"}')).toBe(false);
    expect(versionOnly('meter/usagemeter/src/main.rs', 'a', 'a')).toBe(false);
  });

  test('the contract holds the meter lane until RFC 0021 delivery 2 widens attribution.precision', () => {
    const contract = readFileSync(join(import.meta.dir, '..', METER_CONTRACT), 'utf8');
    const precision = (values: unknown) => JSON.stringify({ properties: { rows: { items: { properties: { attribution: { properties: { precision: values } } } } } } });
    // RFC 0021 delivery 2 widened the committed contract, so it no longer holds the lane (a listed key
    // still must). Dev's contract before it (v3.108.14, frozen below) named branch_window alone.
    expect(contractHeld(contract)).toBe(false);
    const before = readFileSync(join(import.meta.dir, 'fixtures', 'meter-hold', 'contract-dev-v3.108.14.schema.json'), 'utf8');
    expect(before).toContain('"enum": ["branch_window"]');
    expect(contractHeld(before)).toBe(true);
    expect(contractHeld(before.replace('"enum": ["branch_window"]', '"enum": ["branch_window", "task_interval", "actor_interval"]'))).toBe(false);
    expect(contractHeld(precision({ enum: ['branch_window', 'task_interval'] }))).toBe(true);
    expect(contractHeld(precision({ oneOf: [{ const: 'branch_window' }, { const: 'actor_interval' }] }))).toBe(false);
    // A $ref'd attribution, or a row picked by its precision (oneOf branches), opens it too.
    expect(contractHeld(JSON.stringify({ $defs: { attribution: { properties: { precision: { enum: ['branch_window', 'actor_interval'] } } } }, properties: { attribution: { $ref: '#/$defs/attribution' } } }))).toBe(false);
    expect(contractHeld(JSON.stringify({ properties: { attribution: { properties: { precision: { $ref: '#/$defs/p' } } } }, $defs: { p: { anyOf: [{ const: 'branch_window' }, { const: 'actor_interval' }] } } }))).toBe(false);
    // Decoys keep it held: actor_interval in another field named precision, a mention, a field named
    // otherwise, a negation (not) or a condition (if) on attribution.precision.
    const decoys = [
      { description: 'actor_interval', properties: { by: { enum: ['actor_interval'] } } },
      { properties: { tokens: { properties: { precision: { enum: ['actor_interval'] } } }, attribution: { properties: { precision: { enum: ['branch_window'] } } } } },
      { properties: { attribution: { properties: { precision: { enum: ['branch_window'], not: { const: 'actor_interval' } } } } } },
      { properties: { attribution: { properties: { precision: { enum: ['branch_window'] }, actor_precision: { const: 'actor_interval' } } } } },
      { not: { properties: { attribution: { properties: { precision: { const: 'actor_interval' } } } } } },
      { if: { properties: { attribution: { properties: { precision: { const: 'actor_interval' } } } } }, then: {} },
    ];
    for (const decoy of decoys) expect(contractHeld(JSON.stringify(decoy))).toBe(true);
    // The contract before delivery 2 with a decoy precision elsewhere naming actor_interval: still held.
    const decoyed = JSON.parse(before);
    decoyed.properties.decoy = { type: 'object', properties: { precision: { enum: ['actor_interval'] } } };
    expect(contractHeld(JSON.stringify(decoyed))).toBe(true);
    // No contract, or one that does not parse, holds.
    expect(contractHeld(undefined)).toBe(true);
    expect(contractHeld('{')).toBe(true);
  });

  // The key comes first (Chat, 2026-11-09): the lane opens only when the contract allows
  // actor_interval AND meter-keys.json lists a key. Frozen copies: dev's contract at v3.108.14 and
  // RFC 0021 delivery 2's (PR 825 at 0daf5c6c).
  const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'meter-hold', name), 'utf8');
  const DEV = fixture('contract-dev-v3.108.14.schema.json');
  const RFC0021 = fixture('contract-rfc0021-825.schema.json');
  const NO_KEY = '{\n  "keys": []\n}\n';
  const ONE_KEY = JSON.stringify({ keys: [{ keyId: 'meter-test', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }] });
  const meterOnly = ['meter/usagemeter/src/main.rs', 'meter/usagemeter/Cargo.toml'];
  const heldInert = (held: boolean) => (path: string) => held && METER.test(path);

  test('the lane opens only with RFC 0021\'s contract AND a listed key', () => {
    expect(contractHeld(DEV)).toBe(true);
    expect(contractHeld(RFC0021)).toBe(false);
    // (a) 825's contract, no key listed: held, and a meter-only change ships nothing.
    expect(meterHold(RFC0021, NO_KEY)).toEqual([`${METER_KEYS} lists no key (the owner's, RFC 0017 delivery 5)`]);
    expect(ships(meterOnly, heldInert(meterHeld(RFC0021, NO_KEY)))).toBe(false);
    expect(meterShips(meterOnly, heldInert(meterHeld(RFC0021, NO_KEY)))).toBe(false);
    // (b) 825's contract and a listed key: open, a meter patch that builds the meter.
    expect(meterHold(RFC0021, ONE_KEY)).toEqual([]);
    expect(ships(meterOnly, heldInert(meterHeld(RFC0021, ONE_KEY)))).toBe(true);
    expect(meterShips(meterOnly, heldInert(meterHeld(RFC0021, ONE_KEY)))).toBe(true);
    expect(kindOf(meterOnly, () => false, heldInert(meterHeld(RFC0021, ONE_KEY)), meterOnly)).toBe('meter');
    // (c) a listed key but dev's contract: held.
    expect(meterHold(DEV, ONE_KEY)).toEqual([`${METER_CONTRACT}'s attribution.precision names no actor_interval (RFC 0021 delivery 2)`]);
    expect(meterShips(meterOnly, heldInert(meterHeld(DEV, ONE_KEY)))).toBe(false);
    expect(meterHold(DEV, NO_KEY)).toHaveLength(2);
    // What lists no key: an empty list, a missing or broken file, an entry with no id or a key that does not parse.
    for (const keys of [NO_KEY, undefined, '{', '{}', '{"keys":{}}', '{"keys":[{"keyId":"x"}]}', '{"keys":[{"keyId":"","publicKey":"x"}]}', '{"keys":[{"keyId":"x","publicKey":"not a key"}]}']) expect(keysHeld(keys)).toBe(true);
    expect(keysHeld(ONE_KEY)).toBe(false);
    // Only an ed25519 public key in SPKI PEM is listed (PR 834's review): a private key, which
    // createPublicKey would take, another key type, a raw base64 key or a PEM with extra text holds it.
    const pair = generateKeyPairSync('ed25519');
    const spki = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const listing = (publicKey: string) => JSON.stringify({ keys: [{ keyId: 'meter-test', publicKey }] });
    const held = [
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      // A second block after the public key (its label built here, so no key header is spelled).
      `${spki}-----BEGIN ${['PRIVATE', 'KEY'].join(' ')}-----\nAAAA\n-----END ${['PRIVATE', 'KEY'].join(' ')}-----\n`,
      `junk\n${spki}`,
    ];
    for (const k of held) expect(keysHeld(listing(k))).toBe(true);
    expect(keysHeld(listing(spki))).toBe(false);
    // The repository's own keys file lists the owner's key (RFC 0017 delivery 5), and its contract is
    // RFC 0021's: the committed state opens the lane.
    const keys = readFileSync(join(import.meta.dir, '..', METER_KEYS), 'utf8');
    const contract = readFileSync(join(import.meta.dir, '..', METER_CONTRACT), 'utf8');
    expect(keysHeld(keys)).toBe(false);
    expect(meterHold(contract, keys)).toEqual([]);
  });

  // End to end, as release.yml runs lane.ts: a scratch repository with this lane.ts, a release tag,
  // then a crate change on top of RFC 0021's contract. With no key listed, `ships` says no (no
  // release at all from it) and `meter` says no (no meter jobs: no build, no attach, no SHA256SUMS,
  // no meter-lane); `meter-since` gives '' and `meter ''` still says no. Listing a key opens it.
  test('as the release runs it: 825\'s contract and no key listed cut no meter release; a listed key does', () => {
    const repo = mkdtempSync(join(tmpdir(), 'meter-hold-'));
    const root = join(import.meta.dir, '..');
    const put = (path: string, text: string) => { mkdir(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
    const copy = (path: string) => { mkdir(dirname(join(repo, path)), { recursive: true }); cpSync(join(root, path), join(repo, path)); };
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    const lane = (...args: string[]) => spawnSync('bun', [join(repo, 'scripts', 'lane.ts'), ...args], { cwd: repo, encoding: 'utf8' });
    try {
      for (const path of ['scripts/lane.ts', 'scripts/version.ts', 'scripts/release-plugins.ts', 'am/part.json', 'meter/usagemeter/part.json',
        'meter/usagemeter/Cargo.toml', 'meter/usagemeter/Cargo.lock', 'apps/acp-dsh/package.json', 'apps/bots-dsh/package.json',
        'apps/locale-pt-br-dsh/package.json', 'apps/welcome-dsh/package.json']) copy(path);
      put('meter/usagemeter/src/main.rs', 'fn main() {}\n');
      put(METER_KEYS, NO_KEY);
      put(METER_CONTRACT, DEV);
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'base');
      git('tag', 'v3.200.0');
      // 822 and 825 merged, a crate change after them, no key listed.
      put(METER_CONTRACT, RFC0021);
      put('meter/usagemeter/src/main.rs', 'fn main() { println!("meter"); }\n');
      git('commit', '-qam', 'feat(meter): a change');
      expect(lane('ships', 'v3.200.0').stdout.trim()).toBe('no');
      const meter = lane('meter', 'v3.200.0');
      expect(meter.stdout.trim()).toBe('no');
      expect(meter.stderr).toContain(`meter lane: held (${METER_KEYS} lists no key`);
      expect(lane('meter-since', 'v3.200.0', '').stdout.trim()).toBe('');
      expect(lane('meter', '').stdout.trim()).toBe('no');
      // The owner lists a key (delivery 5): the lane opens, and that merge is the first meter release.
      put(METER_KEYS, ONE_KEY);
      git('commit', '-qam', 'chore(meter): the meter-lane key');
      expect(lane('ships', 'v3.200.0').stdout.trim()).toBe('yes');
      expect(lane('kind', 'v3.200.0', 'v3.200.0').stdout.trim()).toBe('meter');
      expect(lane('meter', 'v3.200.0').stdout.trim()).toBe('yes');
      // Held at the last tag, no lane posted: every change since counts, so nothing held is lost.
      expect(lane('meter-since', 'v3.200.0', '').stdout.trim()).toBe('');
      expect(lane('meter', '').stdout.trim()).toBe('yes');
      // The first meter release was a prerelease: never the base, so the next stable one builds again.
      git('tag', 'v3.200.1');
      expect(lane('meter-since', 'v3.200.1', '', 'v3.200.1').stdout.trim()).toBe('');
      expect(lane('meter-since', 'v3.200.1', '').stdout.trim()).toBe('v3.200.1');
      // A key listed but the contract back to dev's: held again.
      put(METER_CONTRACT, DEV);
      git('commit', '-qam', 'revert the contract');
      expect(lane('meter', 'v3.200.0').stdout.trim()).toBe('no');
      expect(lane('ships', 'v3.200.0').stdout.trim()).toBe('no');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  test('lane.ts meter, as the release runs it here: yes, now this repository opens the lane', () => {
    const root = join(import.meta.dir, '..');
    const committed = (path: string) => { const run = spawnSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' }); return run.status === 0 ? run.stdout : undefined; };
    // The committed contract allows actor_interval and meter-keys.json lists a key: open.
    expect(meterHold(committed(METER_CONTRACT), committed(METER_KEYS))).toEqual([]);
    expect(meterHeld(committed(METER_CONTRACT), committed(METER_KEYS))).toBe(false);
    // '' is meter-since's "no release has carried the meter": build it.
    const run = spawnSync('bun', [join(import.meta.dir, 'lane.ts'), 'meter', ''], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('yes');
    expect(run.stderr).not.toContain('meter lane: held');
  }, 30_000);

  test('the meter is measured from the build meter-lane names, else the newest stable release once one carried it', () => {
    const tags = ['v3.109.0', 'v3.109.1', 'v3.109.2', 'v3.110.0'];
    const open = () => false;
    expect(meterSince('v3.110.0', '3.109.1', tags, open)).toBe('v3.109.1');
    expect(meterSince('v3.110.0', '3.110.0', tags, open)).toBe('v3.110.0');
    // No lane yet, unreadable, or naming no tag here: the newest stable release.
    for (const lane of [undefined, '', 'null', '0.3.0', '3.111.0']) expect(meterSince('v3.110.0', lane, tags, open)).toBe('v3.110.0');
    // No release has carried the meter while the lane was held at that release: build it ('').
    expect(meterSince('v3.110.0', undefined, tags, () => true)).toBe('');
    expect(meterSince('', undefined, [], open)).toBe('');
    // A posted lane wins over the hold: a release carried the meter, and the lane names it.
    expect(meterSince('v3.110.0', '3.109.2', tags, () => true)).toBe('v3.109.2');
  });

  // The Reviewer's L2: a prerelease never moves meter-lane, so it is never the base either, lane or no
  // lane: a meter change that shipped only in a prerelease is built again by the next stable release.
  test('a prerelease that built the meter is never meter-since\'s base', () => {
    const tags = ['v3.109.0', 'v3.110.0', 'v3.110.1', 'v3.110.2'];
    const open = () => false;
    expect(meterSince('v3.110.2', undefined, tags, open, ['v3.110.1', 'v3.110.2'])).toBe('v3.110.0');
    expect(meterSince('v3.110.2', '', tags, open, ['v3.110.2'])).toBe('v3.110.1');
    // Every release a prerelease: none carried the meter to machines, so build it.
    expect(meterSince('v3.110.2', undefined, tags, open, tags)).toBe('');
    // The hold is read at the stable base, not at the prerelease.
    const heldAt: string[] = [];
    expect(meterSince('v3.110.2', undefined, tags, tag => { heldAt.push(tag); return tag === 'v3.110.0'; }, ['v3.110.1', 'v3.110.2'])).toBe('');
    expect(heldAt).toEqual(['v3.110.0']);
    // Order is by number, not text; tags past `last` and other tags are ignored.
    expect(meterSince('v3.10.0', undefined, ['v3.9.0', 'v3.10.0', 'v3.11.0', 'v3.9.5', 'pocket-lane'], open, ['v3.10.0'])).toBe('v3.9.5');
  });

  test('a .gitignore-only change cuts no release', () => {
    const none = () => false;
    expect(ships(['.gitignore'], none)).toBe(false);
  });

  test('a .gitignore change beside a shipped file takes that file\'s lane', () => {
    const none = () => false;
    const changed = ['.gitignore', 'herdr/mods/am-sidebar/main.js'];
    expect(ships(changed, none)).toBe(true);
    expect(kindOf(changed, none, none, changed)).toBe('herdr');
  });

  test('the Windows helper\'s image and launcher (apps/desktop/wslc/) ship nothing until Windows reads them', () => {
    const none = () => false;
    const wslc = ['apps/desktop/wslc/Dockerfile', 'apps/desktop/wslc/bin/dsh-launch.mjs', 'apps/desktop/wslc/lib/launcher.mjs',
      'apps/desktop/wslc/smoke/smoke.mjs', 'apps/desktop/wslc/test/launcher.test.mjs', 'apps/desktop/wslc/README.md'];
    // Alone: no release at all.
    expect(ships(wslc, none)).toBe(false);
    // Beside a plugin: a plugin patch, no desktop build.
    expect(ships([...wslc, 'apps/bots-dsh/src/host/turns.js'], none)).toBe(true);
    expect(kindOf([...wslc, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    expect(kindOf([...wslc, 'apps/bots-dsh/src/host/turns.js'], none, none, [...wslc, 'apps/bots-dsh/src/host/turns.js'])).toBe('plugins');
    // The app's own code is still a full release, and so is its packaging.
    expect(kindOf([...wslc, 'apps/desktop/src/main.js'], none)).toBe('full');
    expect(kindOf([...wslc, 'apps/desktop/electron-builder.yml'], none)).toBe('full');
  });

  test('the server image (server/) publishes from its own workflow, and a server-only change cuts no release', () => {
    const none = () => false;
    const server = ['server/Dockerfile', 'server/assemble.mjs', 'server/entrypoint.mjs', 'server/smoke.mjs',
      'server/README.md', 'server/test/lib.test.mjs'];
    // Alone: no release at all.
    expect(ships(server, none)).toBe(false);
    // Beside a plugin: a plugin patch, no desktop build.
    expect(kindOf([...server, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    expect(kindOf([...server, 'apps/bots-dsh/src/host/turns.js'], none, none, [...server, 'apps/bots-dsh/src/host/turns.js'])).toBe('plugins');
    // The app's own code is still a full release.
    expect(kindOf([...server, 'apps/desktop/src/main.js'], none)).toBe('full');
  });

  test('the dsh-sandbox runner (apps/dsh-sandbox/) ships with the pack, never as a plugin', () => {
    const none = () => false;
    const sandbox = ['apps/dsh-sandbox/bin/hc-socket-mask.mjs',
      'apps/dsh-sandbox/bin/dsh-sandbox.mjs', 'apps/dsh-sandbox/profile/sandbox-row.yml',
      'apps/dsh-sandbox/test/wrapper.test.mjs', 'apps/dsh-sandbox/README.md'];
    // Alone: no release at all.
    expect(ships(sandbox, none)).toBe(false);
    // Beside a plugin: a plugin patch, no desktop build.
    expect(ships([...sandbox, 'apps/bots-dsh/src/host/turns.js'], none)).toBe(true);
    expect(kindOf([...sandbox, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    expect(kindOf([...sandbox, 'apps/bots-dsh/src/host/turns.js'], none, none,
      [...sandbox, 'apps/bots-dsh/src/host/turns.js'])).toBe('plugins');
    // Beside the desktop app's own code: still a full release.
    expect(kindOf([...sandbox, 'apps/desktop/src/main.js'], none)).toBe('full');
  });

  test('the landing page (apps/landing/) ships from the site, never from a release', () => {
    const none = () => false;
    const landing = ['apps/landing/index.html', 'apps/landing/styles.css', 'apps/landing/assets/hero.png',
      'apps/landing/landing.test.mjs', 'apps/landing/verify-browser.mjs', 'apps/landing/README.md'];
    // Alone: no release at all.
    expect(ships(landing, none)).toBe(false);
    // Beside a plugin: a plugin patch, no desktop build.
    expect(ships([...landing, 'apps/bots-dsh/src/host/turns.js'], none)).toBe(true);
    expect(kindOf([...landing, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    expect(kindOf([...landing, 'apps/bots-dsh/src/host/turns.js'], none, none, [...landing, 'apps/bots-dsh/src/host/turns.js'])).toBe('plugins');
    // Beside the app's own code: still a full release.
    expect(kindOf([...landing, 'apps/desktop/src/main.js'], none)).toBe('full');
  });

  test('Automagik ID is deployed independently and never changes a release lane', () => {
    const none = () => false;
    const id = ['apps/id/src/index.ts', 'apps/id/src/auth.ts', 'apps/id/bun.lock',
      'apps/id/migrations/0001_auth.sql', 'apps/id/clients.json', 'apps/id/pages/sign-in.html'];
    expect(ships(id, none)).toBe(false);
    expect(herdrShips(id)).toBe(false);
    expect(pocketShips(id)).toBe(false);
    expect(meterShips(id)).toBe(false);
    expect(kindOf([...id, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    expect(kindOf([...id, 'apps/desktop/src/main.js'], none)).toBe('full');
  });

  test('no Unfold folder ships: the removal\'s deleted folders, or one that came back, cut no release', () => {
    const none = () => false;
    // The paths the removal (RFC 0020) deletes count as changed since the last release.
    const unfold = ['bot', 'bridge', 'capabilities', 'events', 'mind', 'session', 'settings', 'sse', 'trajectory']
      .map((name) => `apps/unfold-${name}-dsh/src/index.js`);
    // Alone: no tarball, no lane entry, no release here; Unfold's own release ships them.
    expect(ships(unfold, none)).toBe(false);
    // Beside a plugin: that plugin's patch, and the lane still names no Unfold plugin.
    expect(ships([...unfold, 'apps/bots-dsh/src/host/turns.js'], none)).toBe(true);
    expect(kindOf([...unfold, 'apps/bots-dsh/src/host/turns.js'], none)).toBe('plugins');
    // Nor is an Unfold folder a plugin's for `unpackedIn`: nothing in it rides the lane.
    expect(kindOf(['apps/unfold-bridge-dsh/dev/harness/package.json', 'apps/bots-dsh/client.js'], none)).toBe('plugins');
  });

  test('a herdr-only change is a herdr patch: no desktop build, no plugins, the pack alone', () => {
    const none = () => false;
    const pack = ['herdr/mods/am-sidebar/main.js', 'herdr-layout/layouts/automagik.json', 'herdr/install.sh'];
    // Since the last release (here also the last full one), only herdr/ ships.
    expect(kindOf(pack, none, none, pack)).toBe('herdr');
    expect(herdrShips(pack)).toBe(true);
    // The import itself: the pack, its tests, notes and catalog, the release tooling and the RFC.
    const importing = [...pack, 'herdr/test/update.test.mjs', 'herdr/README.md', 'herdr/.genie/INDEX.md', 'herdr/catalog/index.json',
      '.github/workflows/release.yml', 'scripts/lane.ts', 'scripts/import-herdr.sh', 'docs/rfcs/0011-monorepo-parts-and-releases.md', 'AGENTS.md'];
    expect(kindOf(importing, none, none, importing)).toBe('herdr');
    // After a plugin patch (v3.N.1), a herdr-only change since it is still herdr: the plugins are not packed again.
    expect(kindOf(['apps/bots-dsh/client.js', ...pack], none, none, pack)).toBe('herdr');
    // With a plugin change since the last release it is a plugin patch, and the pack comes along.
    expect(kindOf(['apps/bots-dsh/client.js', ...pack], none, none, ['apps/bots-dsh/client.js', ...pack])).toBe('plugins');
    expect(herdrShips(['apps/bots-dsh/client.js', ...pack])).toBe(true);
    // With an app change it is a full release, the pack included; herdr/ alone never makes one.
    expect(kindOf(['apps/desktop/src/main.js', ...pack], none, none, ['apps/desktop/src/main.js', ...pack])).toBe('full');
    expect(kindOf(pack, none)).toBe('plugins');
    // What the pack does not carry ships nothing: tests, notes, plans, the mockup, the catalog (read from dev).
    const notes = ['herdr/test/update.test.mjs', 'herdr/README.md', 'herdr/RECIPE.md', 'herdr/docs/agent-install.md', 'herdr/.genie/INDEX.md',
      'herdr/mockup/gen-sidebar.mjs', 'herdr/catalog/index.json', 'docs/rfcs/0011-monorepo-parts-and-releases.md'];
    expect(ships(notes, none)).toBe(false);
    expect(herdrShips(notes)).toBe(false);
    // NOTICE is provenance the pack never carries (pack.mjs archives PACK_MODS and the layout
    // files): a change to it alone cuts nothing; beside a herdr mod, the mod is the release.
    const notice = ['herdr/NOTICE'];
    expect(ships(notice, none)).toBe(false);
    expect(herdrShips(notice)).toBe(false);
    const withNotice = ['herdr/mods/am-sidebar/main.js', ...notice];
    expect(ships(withNotice, none)).toBe(true);
    expect(kindOf(withNotice, none, none, withNotice)).toBe('herdr');
    // The pack's version files, bumped by a release, ship nothing on their own.
    const versions = ['herdr/package.json', 'herdr/mods/am-sidebar/VERSION'];
    expect(herdrShips(versions, path => versions.includes(path))).toBe(false);
    expect(herdrShips(versions)).toBe(true);
    // Nothing shipping since the last release falls back to the rule since the last full one.
    expect(kindOf(['apps/bots-dsh/client.js'], none, none, ['herdr/README.md'])).toBe('plugins');
  });

  test('herdr/scripts/ is repository tooling: only the pack build rides the herdr lane', () => {
    const none = () => false;
    // #824 changed only the privacy scanner's list (v3.108.13): the pack carried no such change.
    const privacyList = ['herdr/scripts/privacy-list.json'];
    expect(ships(privacyList, none)).toBe(false);
    expect(herdrShips(privacyList)).toBe(false);
    expect(kindOf(privacyList, none)).toBe('plugins');
    // A CI-only script, existing or new, alone and beside a plugin: no release and no herdr lane.
    for (const path of ['herdr/scripts/catalog.mjs', 'herdr/scripts/new-tool.mjs']) {
      expect(ships([path], none)).toBe(false);
      expect(herdrShips([path])).toBe(false);
      expect(kindOf([path], none)).toBe('plugins');
      const besidePlugin = [path, 'apps/bots-dsh/client.js'];
      expect(ships(besidePlugin, none)).toBe(true);
      expect(kindOf(besidePlugin, none, none, besidePlugin)).toBe('plugins');
      expect(herdrShips(besidePlugin)).toBe(false);
    }
    // The pack build itself: release.yml runs the tag's own pack.mjs to build the attached tarball.
    const packBuild = ['herdr/scripts/pack.mjs'];
    expect(ships(packBuild, none)).toBe(true);
    expect(herdrShips(packBuild)).toBe(true);
    expect(kindOf(packBuild, none, none, packBuild)).toBe('herdr');
  });

  test('a root .genie/ plan ships nothing: it never makes a full release', () => {
    const none = () => false;
    const plan = ['.genie/wishes/restore-official-sidebar-with-advanced-b/WISH.md'];
    // Alone: no release at all, and no part carries it.
    expect(ships(plan, none)).toBe(false);
    expect(herdrShips(plan)).toBe(false);
    expect(pocketShips(plan)).toBe(false);
    // Beside a plugin: that plugin's patch, no desktop build.
    expect(ships([...plan, 'apps/bots-dsh/client.js'], none)).toBe(true);
    expect(kindOf([...plan, 'apps/bots-dsh/client.js'], none)).toBe('plugins');
    // The plan alone falls back to the plugin rule, never a full release.
    expect(kindOf(plan, none)).toBe('plugins');
  });

  test('a Claude Code skill (.claude/skills/) ships nothing: the brand skill and the brand copy tool cut no release', () => {
    const none = () => false;
    const brand = ['.claude/skills/automagik-brand/SKILL.md', 'scripts/brand-sync.mjs', 'scripts/brand-sync.test.ts', 'docs/brand/README.md', '.gitignore'];
    expect(ships(brand, none)).toBe(false);
    expect(herdrShips(brand)).toBe(false);
    expect(pocketShips(brand)).toBe(false);
    // Beside a shipped file, that file's lane decides.
    expect(ships([...brand, 'apps/bots-dsh/client.js'], none)).toBe(true);
    expect(kindOf([...brand, 'apps/bots-dsh/client.js'], none)).toBe('plugins');
  });

  test('a published skill (skills/) ships nothing: the skills CLI reads it from the repository', () => {
    const none = () => false;
    const skill = ['skills/am/SKILL.md', 'README.md'];
    expect(ships(skill, none)).toBe(false);
    expect(herdrShips(skill)).toBe(false);
    expect(pocketShips(skill)).toBe(false);
    // No am release either: the skill is not under am/, and am's tarball never carries it.
    expect(skill.some(path => AM.test(path))).toBe(false);
    // Beside a shipped file, that file's lane decides.
    expect(ships([...skill, 'am/bin/am.mjs'], none)).toBe(true);
    expect(kindOf([...skill, 'am/bin/am.mjs'], none, none, [...skill, 'am/bin/am.mjs'])).toBe('am');
    expect(kindOf([...skill, 'apps/bots-dsh/client.js'], none)).toBe('plugins');
    // Only that folder: one that merely starts with the name, or a root file of the name, still ships.
    expect(ships(['skills-extra/am/SKILL.md'], none)).toBe(true);
    expect(ships(['skills.json'], none)).toBe(true);
  });

  test('a scheduler-only change (herdr/scheduler/, vendored) cuts no release and never reaches the pack', () => {
    const none = () => false;
    const scheduler = ['herdr/scheduler/main.go', 'herdr/scheduler/internal/daemon/daemon.go', 'herdr/scheduler/go.mod',
      'herdr/scheduler/UPSTREAM.md', 'herdr/scheduler/LICENSE-upstream'];
    // The binary ships from its own release lane: nothing here reaches an install, so no release kind.
    expect(ships(scheduler, none)).toBe(false);
    expect(herdrShips(scheduler)).toBe(false);
    // The check scripts (herdr/scripts/scheduler-upstream.mjs, scheduler-pin.mjs) are tooling too:
    // on their own, and beside the scheduler, they cut no release and never reach the pack.
    const check = ['herdr/scripts/scheduler-upstream.mjs', 'herdr/scripts/scheduler-pin.mjs'];
    expect(ships(check, none)).toBe(false);
    expect(herdrShips(check)).toBe(false);
    expect(ships([...scheduler, ...check], none)).toBe(false);
    expect(herdrShips([...scheduler, ...check])).toBe(false);
    // Beside a plugin change it is a plugin patch; beside an app change, a full release.
    expect(kindOf([...scheduler, 'apps/bots-dsh/client.js'], none, none, [...scheduler, 'apps/bots-dsh/client.js'])).toBe('plugins');
    expect(kindOf([...scheduler, 'apps/desktop/src/main.js'], none, none, [...scheduler, 'apps/desktop/src/main.js'])).toBe('full');
    // The rule is the scheduler folder alone: anything else under herdr/ still makes a herdr patch.
    expect(herdrShips(['herdr/scheduler/main.go', 'herdr/mods/am-sidebar/main.js'])).toBe(true);
  });

  test('an am-only change is an am patch; am never makes a release more than it is otherwise', () => {
    const none = () => false;
    const am = ['am/bin/am.mjs', 'am/lib/self.mjs', 'am/am-keys.json'];
    expect(kindOf(am, none, none, am)).toBe('am');
    // am's tests and notes ship nothing; with them alone there is nothing am-only to release.
    expect(ships(['am/test/am.test.mjs', 'am/README.md'], none)).toBe(false);
    expect(kindOf(['apps/bots-dsh/client.js'], none, none, ['am/test/am.test.mjs'])).toBe('plugins');
    // A herdr change that resyncs am's copies of the pack's CLI is a herdr patch, not a full release.
    const resync = ['herdr/mods/am-sidebar/model.js', 'am/model.js', 'am/copies.json'];
    expect(kindOf(resync, none, none, resync)).toBe('herdr');
    expect(kindOf([...resync, 'apps/pocket/android/app/build.gradle.kts'], none, none, [...resync, 'apps/pocket/android/app/build.gradle.kts'])).toBe('pocket');
    // Beside a plugin change it is still a plugin patch; beside an app change, a full release.
    expect(kindOf(['apps/bots-dsh/client.js', ...am], none, none, ['apps/bots-dsh/client.js', ...am])).toBe('plugins');
    expect(kindOf(['apps/desktop/src/main.js', ...am], none, none, ['apps/desktop/src/main.js', ...am])).toBe('full');
  });

  test('the am part\'s paths come from its part.json', () => {
    expect(amPaths({ paths: ['am/**'] }).map(String)).toEqual(['/^am\\/.*$/']);
    expect(globPattern('herdr/mods/*/part.json').test('herdr/mods/am-footer/part.json')).toBe(true);
    expect(globPattern('herdr/mods/*/part.json').test('herdr/mods/a/b/part.json')).toBe(false);
    expect(AM.test('am/bin/am.mjs')).toBe(true);
    expect(AM.test('amx/file')).toBe(false);
    expect(AM.test('herdr/mods/am-sidebar/model.js')).toBe(false);
  });

  test('a Pocket-only change is a pocket patch: the phone app, no desktop build, no plugins', () => {
    const none = () => false;
    const app = ['apps/pocket/android/app/src/main/java/ai/namastex/automagik/Updater.kt', 'apps/pocket/android/app/build.gradle.kts'];
    expect(kindOf(app, none, none, app)).toBe('pocket');
    expect(pocketShips(app)).toBe(true);
    expect(herdrShips(app)).toBe(false);
    // The import itself: the app, its docs, Pocket Link under herdr/, the tooling, the RFC.
    const importing = [...app, 'apps/pocket/README.md', 'apps/pocket/docs/guides/releasing.md', 'herdr/mods/pocket-link/main.js',
      '.github/workflows/ci.yml', 'scripts/lane.ts', 'scripts/import-pocket.sh', 'docs/rfcs/0011-monorepo-parts-and-releases.md', 'AGENTS.md'];
    expect(kindOf(importing, none, none, importing)).toBe('pocket');
    expect(herdrShips(importing)).toBe(true);
    // With the layout's own folder (herdr-layout/, the herdr part) it is still a pocket patch, the pack along.
    expect(kindOf([...app, 'herdr-layout/layouts/automagik.json'], none, none, [...app, 'herdr-layout/layouts/automagik.json'])).toBe('pocket');
    // A Pocket Link change alone is the pack's lane: herdr/.
    expect(kindOf(['herdr/mods/pocket-link/bridge/bridge.mjs'], none, none, ['herdr/mods/pocket-link/bridge/bridge.mjs'])).toBe('herdr');
    expect(pocketShips(['herdr/mods/pocket-link/bridge/bridge.mjs'])).toBe(false);
    // With a plugin change it is a plugin patch, with an app change a full release: Pocket comes along, never makes one.
    expect(kindOf(['apps/bots-dsh/client.js', ...app], none, none, ['apps/bots-dsh/client.js', ...app])).toBe('plugins');
    expect(kindOf(['apps/desktop/src/main.js', ...app], none, none, ['apps/desktop/src/main.js', ...app])).toBe('full');
    expect(kindOf(app, none)).toBe('plugins');
    // What no APK carries ships nothing: its notes, docs, unit tests and the Android project's scripts.
    const notes = ['apps/pocket/README.md', 'apps/pocket/AGENTS.md', 'apps/pocket/docs/rfcs/0002-release-and-update-channel.md',
      'apps/pocket/android/app/src/test/java/ai/namastex/automagik/ReleaseTest.kt', 'apps/pocket/android/scripts/test_terminal.py'];
    expect(ships(notes, none)).toBe(false);
    expect(pocketShips(notes)).toBe(false);
  });

  // Pocket is rebuilt from what phones have, the version pocket-lane names, not from the last tag: a
  // prerelease never moves the lane, so a Pocket fix that shipped only in one reaches phones with the
  // next release, even when that release changes nothing under apps/pocket/.
  test('Pocket\'s changes are measured from the build pocket-lane names, past prereleases and failed posts', () => {
    const tags = ['v3.59.0', 'v3.59.1', 'v3.59.2', 'v3.60.0'];
    // v3.59.1 was a prerelease with a Pocket fix; pocket-lane still names 3.59.0.
    expect(pocketSince('v3.60.0', '3.59.0', tags)).toBe('v3.59.0');
    const sincePrerelease = ['apps/pocket/android/app/src/main/java/ai/namastex/automagik/Updater.kt', 'apps/desktop/src/main.js'];
    expect(pocketShips(sincePrerelease)).toBe(true);
    // Up to date: the lane names the last release.
    expect(pocketSince('v3.60.0', '3.60.0', tags)).toBe('v3.60.0');
    // No lane yet (before the first Pocket release), an unreadable one, or a version with no tag here: the last release.
    for (const lane of [undefined, '', 'null', '0.23.0', '3.61.0', 'pocket-lane']) expect(pocketSince('v3.60.0', lane, tags)).toBe('v3.60.0');
    expect(pocketSince('', undefined, [])).toBe('');
  });

  test('a patch stops at 3.N.999: Pocket\'s versionCode gives a patch three digits', () => {
    expect(nextPatch(['v3.22.0', 'v3.22.998'])).toBe('3.22.999');
    expect(() => nextPatch(['v3.22.0', 'v3.22.999'])).toThrow(/cut 3\.23\.0 instead/);
  });

  test('a change no install sees is no release: a plugin file its package does not carry', () => {
    const unpacked = unpackedIn({ 'bots-dsh': ['index.js', 'src/host/', 'client.js'], 'welcome-dsh': ['src/*.js'] });
    expect(ships(['apps/bots-dsh/scripts/lint.mjs', 'apps/bots-dsh/dev/bench.sh', 'apps/bots-dsh/test/x.test.js', '.github/workflows/ci.yml'], unpacked)).toBe(false);
    expect(ships(['apps/bots-dsh/scripts/lint.mjs', 'apps/bots-dsh/src/host/turns.js'], unpacked)).toBe(true);
    // What the app's build reads, and a plugin whose files has a glob, still count.
    for (const path of ['apps/bots-dsh/dev/harness/package.json', 'apps/bots-dsh/bun.lock', 'apps/bots-dsh/package.json', 'apps/welcome-dsh/scripts/lint.mjs']) expect(ships([path], unpacked)).toBe(true);
    expect(kindOf(['apps/bots-dsh/dev/harness/package.json'], () => false, unpacked)).toBe('full');
  });

  test('the lane carries no add-on, so moving an add-on\'s pin is a full release', () => {
    expect(LANE_ADDONS).toEqual([]);
    const profile = (subscriptions = '2eff034', more = {}) => JSON.stringify({
      omni: { addonVersions: { '@goodandready/dsh-subscriptions': '0.7.21-omni.1' } },
      dependencies: { '@automagik/bots-dsh': '*', '@goodandready/dsh-subscriptions': `github:automagik-genie/dsh-subscriptions#${subscriptions}` },
      ...more,
    });
    expect(addonPinsOnly(profile(), profile())).toBe(true);
    // dsh-subscriptions has dependencies of its own: its pin, or anything else, is a full release.
    expect(addonPinsOnly(profile(), profile('ffff000'))).toBe(false);
    expect(addonPinsOnly(profile(), profile('2eff034', { dsh: { profile: { bundles: [] } } }))).toBe(false);
  });

  test('a patch goes on the newest 3.N, and the sequence keeps the releases in order', () => {
    expect(nextPatch(['v3.21.0', 'v3.22.0', 'v3.9.4', 'v3.261024.1'])).toBe('3.22.1');
    expect(nextPatch(['v3.22.0', 'v3.22.1', 'v3.22.2'])).toBe('3.22.3');
    expect(sequenceOf('3.22.1')).toBeGreaterThan(sequenceOf('3.22.0'));
    expect(sequenceOf('3.23.0')).toBeGreaterThan(sequenceOf('3.22.9'));
  });

  test('the manifest names each tarball on its own release, and only its signer\'s key opens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-'));
    writeFileSync(join(dir, 'automagik-bots-dsh-3.22.1.tgz'), 'tarball');
    const lane = manifest({
      repository: 'https://github.com/automagik-si/automagik',
      version: '3.22.1',
      commit: 'a'.repeat(40),
      packages: { '@automagik/bots-dsh': { version: '3.22.1', file: 'automagik-bots-dsh-3.22.1.tgz', integrity: 'sha512-x', size: 7 } },
    }, { base: '3.22.0', issuedAt: '2026-10-26T03:00:00Z', dir, engines: () => '>=0.2.1-rc.3 <0.2.2-0' });
    expect(lane.plugins[0].url).toBe('https://github.com/automagik-si/automagik/releases/download/v3.22.1/automagik-bots-dsh-3.22.1.tgz');
    expect(lane.plugins[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lane.plugins[0].engines.dsh).toBe('>=0.2.1-rc.3 <0.2.2-0');
    expect([lane.base, lane.sequence, lane.keyId]).toEqual(['3.22.0', 220001, 'automagik-2026-10']);
    writeFileSync(join(dir, 'dsh-addon-1.5.6-omni.8.tgz'), 'addon');
    const carried = manifest({ repository: 'https://github.com/automagik-si/automagik', version: '3.22.1', commit: 'a'.repeat(40), packages: {} }, {
      base: '3.22.0', issuedAt: '2026-10-26T03:00:00Z', dir, engines: () => '',
      addons: { 'dsh-addon': { version: '1.5.6-omni.8', file: 'dsh-addon-1.5.6-omni.8.tgz', integrity: 'sha512-y', size: 5, engines: { dsh: '>=0.2.0-rc.1 <0.3.0' }, source: `github:automagik-genie/dsh-addon#${'b'.repeat(40)}` } },
    });
    // Apart from plugins[] (Omni serves those, checking each), on this release, in the plugins' shape.
    expect(carried.addons).toEqual([{ name: 'dsh-addon', version: '1.5.6-omni.8', url: 'https://github.com/automagik-si/automagik/releases/download/v3.22.1/dsh-addon-1.5.6-omni.8.tgz', integrity: 'sha512-y', sha256: createHash('sha256').update('addon').digest('hex'), size: 5, engines: { dsh: '>=0.2.0-rc.1 <0.3.0' } }]);
    const pair = generateKeyPairSync('ed25519');
    const bytes = Buffer.from(JSON.stringify(lane));
    const signature = signLane(bytes, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const keys = [{ keyId: 'automagik-2026-10', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
    expect(verifyLane(bytes, signature, keys).version).toBe('3.22.1');
    expect(() => verifyLane(Buffer.from(JSON.stringify({ ...lane, sequence: 999999 })), signature, keys)).toThrow(/signature/);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => verifyLane(bytes, signature, [{ keyId: 'automagik-2026-10', publicKey: other }])).toThrow(/signature/);
  });
});
