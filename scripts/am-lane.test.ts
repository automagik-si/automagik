import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_ID, KEYS_FILE, SLOTS, keyVerdict, ownHalfPost, pointer, postedProblem, signPointer, slotFor, verify, writeKeyFiles } from './am-lane';

// A throwaway key, made for this run only: no private key is ever committed.
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
const SCRIPT = join(import.meta.dir, 'am-lane.ts');

describe('the am lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-lane-'));
  const tgz = join(dir, 'automagik-am-3.64.1.tgz');
  writeFileSync(tgz, 'the am');
  const commit = 'a'.repeat(40);

  test('am.json names the release, the tarball\'s URL, sha256 and size, and a monotonic sequence', () => {
    const p = pointer(tgz, { version: '3.64.1', commit, issuedAt: '2026-11-03T00:00:00Z' });
    expect(p).toMatchObject({ schemaVersion: 1, publisher: 'automagik', part: 'automagik.am', keyId: KEY_ID, sequence: 640001, version: '3.64.1', tag: 'v3.64.1', commit });
    expect(p.tarball).toEqual({
      name: 'automagik-am-3.64.1.tgz',
      url: 'https://github.com/automagik-dev/automagik/releases/download/v3.64.1/automagik-am-3.64.1.tgz',
      sha256: createHash('sha256').update('the am').digest('hex'),
      size: 6,
    });
    expect(() => pointer(tgz, { version: '3.64.2', commit, issuedAt: 'x' })).toThrow(/is not automagik-am-3\.64\.2\.tgz/);
    expect(() => pointer(tgz, { version: '3.64.1', commit: 'HEAD', issuedAt: 'x' })).toThrow(/not a commit/);
  });

  test('the signer\'s pointer is one am accepts (am/lib/lane.mjs); another key or a tampered byte is refused', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const bytes = Buffer.from(JSON.stringify(pointer(tgz, { version: '3.64.1', commit, issuedAt: 'x' })));
    const sig = signPointer(bytes, key.priv);
    expect(verify(bytes, sig, keys).version).toBe('3.64.1');
    expect(() => verify(bytes, sig, [{ keyId: KEY_ID, publicKey: pair().pub }])).toThrow(/signature does not match/);
    const tampered = Buffer.from(bytes.toString().replace('3.64.1', '3.64.9'));
    expect(() => verify(tampered, sig, keys)).toThrow(/signature does not match/);
    expect(() => verify(bytes, sig, [])).toThrow(/does not trust/);
  });

  test('check-key: unset is a warning and no signing; a listed key signs; any other key fails before the tag', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    expect(keyVerdict(undefined, keys).verdict).toBe('skip');
    expect(keyVerdict(undefined, keys).message).toMatch(/^AM_LANE_KEY is not set: this release attaches/);
    expect(keyVerdict('', []).verdict).toBe('skip');
    expect(keyVerdict(key.priv, keys)).toEqual({ verdict: 'sign', message: `AM_LANE_KEY is ${KEY_ID}, listed in am/am-keys.json` });
    expect(keyVerdict(pair().priv, keys)).toEqual({ verdict: 'fail', message: 'AM_LANE_KEY\'s public key is not in am/am-keys.json' });
    // No key listed yet (keygen ran, its am-keys.json not merged): skipped, never a failed release.
    expect(keyVerdict(key.priv, []).verdict).toBe('skip');
    expect(keyVerdict(key.priv, []).message).toMatch(/^am\/am-keys\.json lists no key yet/);
    expect(keyVerdict('not a key', []).verdict).toBe('skip');
    expect(keyVerdict('not a key', keys)).toEqual({ verdict: 'fail', message: 'AM_LANE_KEY is not a private key (PEM)' });
  });

  test('check-key as the release runs it: sign=no with a ::warning:: and exit 0 while the secret is absent', () => {
    const out = join(dir, 'github-output');
    writeFileSync(out, '');
    const env = { ...process.env, GITHUB_OUTPUT: out };
    delete (env as Record<string, string | undefined>).AM_LANE_KEY;
    // What the repository's am-keys.json says decides the words: no key listed yet, or the secret not set.
    const listed = JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys.length > 0;
    const absent = spawnSync('bun', [SCRIPT, 'check-key'], { encoding: 'utf8', env });
    expect(absent.status).toBe(0);
    expect(absent.stdout).toMatch(listed
      ? /^::warning::am lane: AM_LANE_KEY is not set: this release attaches automagik-am-<v>\.tgz but posts no am-lane pointer/
      : /^::warning::am lane: am\/am-keys\.json lists no key yet: this release attaches automagik-am-<v>\.tgz but posts no am-lane pointer/);
    expect(readFileSync(out, 'utf8')).toBe('sign=no\n');
    // A secret that is none of the listed keys stops the run once keys are listed; while none is
    // listed (between keygen and its merge) it is still a warning and no post.
    const other = spawnSync('bun', [SCRIPT, 'check-key'], { encoding: 'utf8', env: { ...env, AM_LANE_KEY: pair().priv } });
    if (listed) {
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/AM_LANE_KEY's public key is not in am\/am-keys\.json/);
      expect(readFileSync(out, 'utf8')).toBe('sign=no\n');
    } else {
      expect(other.status).toBe(0);
      expect(other.stdout).toMatch(/^::warning::am lane: am\/am-keys\.json lists no key yet/);
      expect(readFileSync(out, 'utf8')).toBe('sign=no\nsign=no\n');
    }
  });

  test('keygen never writes the slot releases sign with: the first key to AM_LANE_KEY, a rotation to the other', () => {
    expect(slotFor([], null)).toBe('AM_LANE_KEY');
    const one = [{ keyId: KEY_ID, publicKey: 'x' }];
    expect(slotFor(one, null)).toBe('AM_LANE_KEY_NEXT');
    expect(slotFor(one, 'AM_LANE_KEY')).toBe('AM_LANE_KEY_NEXT');
    expect(slotFor(one, 'AM_LANE_KEY_NEXT')).toBe('AM_LANE_KEY');
    expect(SLOTS).toEqual(['AM_LANE_KEY', 'AM_LANE_KEY_NEXT']);
  });

  test('keygen writes the same public keys to am and the pack', () => {
    const files = [join(dir, 'am-keys.json'), join(dir, 'pack-am-keys.json')];
    const keys = [{ keyId: KEY_ID, publicKey: pair().pub }];
    writeKeyFiles(keys, files);
    expect(JSON.parse(readFileSync(files[0], 'utf8'))).toEqual({ keys });
    expect(readFileSync(files[0], 'utf8')).toBe(readFileSync(files[1], 'utf8'));
    const root = join(import.meta.dir, '..');
    expect(readFileSync(KEYS_FILE, 'utf8')).toBe(readFileSync(join(root, 'herdr/mods/am-sidebar/am-keys.json'), 'utf8'));
    const copies = JSON.parse(readFileSync(join(root, 'am/copies.json'), 'utf8'));
    expect(copies.files.some((file: { to: string }) => file.to === 'am/am-keys.json')).toBe(false);
  });

  test('am\'s own key, never the pack\'s or the plugin lane\'s: am-keys.json shares no key with them', () => {
    const am = JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys.map((k: { publicKey: string }) => k.publicKey);
    const others = ['herdr/mods/am-sidebar/pack-keys.json', 'plugin-lane/keys.json']
      .flatMap(file => JSON.parse(readFileSync(join(import.meta.dir, '..', file), 'utf8')).keys.map((k: { publicKey: string }) => k.publicKey));
    expect(am.filter((k: string) => others.includes(k))).toEqual([]);
  });

  const signed = (version: string, key: { priv: string }) => {
    const file = join(dir, `automagik-am-${version}.tgz`);
    writeFileSync(file, `am ${version}`);
    const bytes = Buffer.from(JSON.stringify(pointer(file, { version, commit, issuedAt: 'x' })));
    return { bytes, sig: signPointer(bytes, key.priv) };
  };

  test('posted: the signer refuses to post a lower sequence than the posted pointer\'s', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const older = signed('3.64.1', key);
    const newer = signed('3.65.0', key);
    expect(postedProblem(older.bytes, null, null, keys)).toBeNull();
    expect(postedProblem(newer.bytes, older.bytes, older.sig, keys)).toBeNull();
    expect(postedProblem(newer.bytes, newer.bytes, newer.sig, keys)).toBeNull();
    expect(postedProblem(older.bytes, newer.bytes, newer.sig, keys)).toMatch(/names 3\.65\.0 \(sequence 650000\), newer than 3\.64\.1 \(sequence 640001\): refusing to post an older one/);
    expect(postedProblem(older.bytes, newer.bytes, newer.sig, keys, { replaceUnverified: true })).toMatch(/refusing to post an older one/);
  });

  test('posted: an unverifiable posted pointer is refused unless the release says to replace it', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const mine = signed('3.65.0', key);
    const other = signed('3.64.1', pair());
    for (const [posted, sig] of [[other.bytes, other.sig], [Buffer.from('nope'), mine.sig]] as const) {
      expect(postedProblem(mine.bytes, posted, sig, keys)).toMatch(/does not verify .* replace_unverified_am_pointer=true/);
      expect(postedProblem(mine.bytes, posted, sig, keys, { replaceUnverified: true })).toBeNull();
    }
    expect(postedProblem(mine.bytes, mine.bytes, mine.sig, [])).toMatch(/a key this am does not trust/);
  });

  // #768: an upload that fails between the two files leaves one of them on am-lane.
  test('posted: a half-written pointer is never nothing posted; the refusal names the one-command repair', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const mine = signed('3.65.0', key);
    const older = signed('3.64.1', key);
    const newer = signed('3.66.0', key);
    // Only am.json.sig: a signature without its bytes says nothing, whoever's it is.
    for (const sig of [mine.sig, older.sig, newer.sig]) {
      const problem = postedProblem(mine.bytes, null, sig, keys, { repo: 'owner/repo' });
      expect(problem).toMatch(/half-written \(am\.json is missing: only am\.json\.sig is posted.*sequence is unknown: refusing to replace it/);
      expect(problem).toEndWith('re-run this job: gh release delete-asset am-lane am.json.sig --repo owner/repo --yes');
      expect(postedProblem(mine.bytes, null, sig, keys, { replaceUnverified: true })).toBeNull();
    }
    // Only am.json, naming another am (older or newer, it is unsigned either way).
    for (const posted of [older.bytes, newer.bytes, Buffer.from('nope')]) {
      const problem = postedProblem(mine.bytes, posted, null, keys, { repo: 'owner/repo' });
      expect(problem).toMatch(/half-written \(am\.json\.sig is missing: only am\.json is posted.*refusing to replace it/);
      expect(problem).toEndWith('re-run this job: gh release delete-asset am-lane am.json --repo owner/repo --yes');
      expect(ownHalfPost(mine.bytes, posted, null)).toBe(false);
    }
    // The repository defaults to am's own.
    expect(postedProblem(mine.bytes, null, mine.sig, keys)).toContain('--repo automagik-dev/automagik --yes');
  });

  test('posted: am.json alone that names this same am is this release\'s own half-written post, and is finished', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const mine = signed('3.65.0', key);
    // A re-run of the job: the same am, a later issuedAt.
    const rerun = Buffer.from(JSON.stringify({ ...JSON.parse(mine.bytes.toString('utf8')), issuedAt: 'later' }));
    expect(rerun.equals(mine.bytes)).toBe(false);
    expect(ownHalfPost(rerun, mine.bytes, null)).toBe(true);
    expect(postedProblem(rerun, mine.bytes, null, keys)).toBeNull();
    // Any other field that differs is another am: its commit, its tarball, its key.
    for (const change of [{ commit: 'b'.repeat(40) }, { keyId: 'am-other' }, { sequence: 650001 }, { tarball: { sha256: 'x' } }]) {
      const other = Buffer.from(JSON.stringify({ ...JSON.parse(mine.bytes.toString('utf8')), ...change }));
      expect(ownHalfPost(rerun, other, null)).toBe(false);
      expect(postedProblem(rerun, other, null, keys)).toMatch(/half-written/);
    }
    // With its signature present it is a whole pointer, judged as one.
    expect(ownHalfPost(rerun, mine.bytes, mine.sig)).toBe(false);
  });

  test('posted as the release runs it: a folder with one of the two files stops the job, or is finished out loud', () => {
    const mine = signed('3.65.0', pair());
    const next = join(dir, 'next-am.json');
    writeFileSync(next, mine.bytes);
    const posted = (name: string, files: Record<string, string | Buffer>) => {
      const folder = join(dir, name);
      mkdirSync(folder);
      for (const [file, bytes] of Object.entries(files)) writeFileSync(join(folder, file), bytes);
      const env = { ...process.env, GITHUB_REPOSITORY: 'owner/repo' } as Record<string, string | undefined>;
      delete env.AM_LANE_REPLACE_UNVERIFIED;
      return spawnSync('bun', [SCRIPT, 'posted', next, folder], { encoding: 'utf8', env });
    };
    const sigOnly = posted('sig-only', { 'am.json.sig': mine.sig });
    expect(sigOnly.status).toBe(1);
    expect(sigOnly.stdout).not.toContain('no pointer posted yet');
    expect(sigOnly.stderr).toContain('gh release delete-asset am-lane am.json.sig --repo owner/repo --yes');
    const jsonOnly = posted('json-only', { 'am.json': signed('3.64.1', pair()).bytes });
    expect(jsonOnly.status).toBe(1);
    expect(jsonOnly.stdout).not.toContain('no pointer posted yet');
    expect(jsonOnly.stderr).toContain('gh release delete-asset am-lane am.json --repo owner/repo --yes');
    const own = posted('own', { 'am.json': mine.bytes });
    expect(own.status).toBe(0);
    expect(own.stdout).toContain('::warning::am lane: the posted pointer is half-written (am.json without am.json.sig) and names this same am');
    expect(posted('none', {}).stdout).toContain('am lane: no pointer posted yet');
  });
});
