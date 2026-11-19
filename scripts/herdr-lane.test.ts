import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { POINTER_REPOSITORIES } from '../herdr/mods/am-sidebar/release.js';
import { INSTALL_SH, KEY_ID, KEYS_FILE, SLOTS, installKeys, keyIdOf, keyProblem, pointer, postedProblem, signPointer, signerSlot, slotFor, verifyPointer, withInstallKeys } from './herdr-lane';

const LANE = join(import.meta.dir, 'herdr-lane.ts');
/** check-key run with exactly `env`'s signer and key (no inherited secret): its exit code and output. */
const checkKey = (env: Record<string, string>) => {
  const run = spawnSync(process.execPath, [LANE, 'check-key'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

// A throwaway key, made for this run only: no private key is ever committed.
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};

describe('the herdr lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-lane-'));
  const tgz = join(dir, 'automagik-herdr-pack-3.57.1.tgz');
  writeFileSync(tgz, 'the pack');
  const commit = 'a'.repeat(40);

  test('pack.json names the release, the tarball\'s URL, sha256 and size, and a monotonic sequence', () => {
    const p = pointer(tgz, { version: '3.57.1', commit, issuedAt: '2026-11-03T00:00:00Z' });
    expect(p).toMatchObject({ schemaVersion: 1, publisher: 'automagik', part: 'herdr', keyId: KEY_ID, sequence: 570001, version: '3.57.1', tag: 'v3.57.1', commit });
    expect(p.tarball).toEqual({
      name: 'automagik-herdr-pack-3.57.1.tgz',
      url: 'https://github.com/automagik-si/automagik/releases/download/v3.57.1/automagik-herdr-pack-3.57.1.tgz',
      sha256: createHash('sha256').update('the pack').digest('hex'),
      size: 8,
    });
    const newer = join(dir, 'automagik-herdr-pack-3.58.0.tgz');
    writeFileSync(newer, 'a newer pack');
    expect(pointer(newer, { version: '3.58.0', commit, issuedAt: 'x' }).sequence).toBeGreaterThan(p.sequence);
    expect(() => pointer(tgz, { version: '3.57.2', commit, issuedAt: 'x' })).toThrow(/is not automagik-herdr-pack-3\.57\.2\.tgz/);
    expect(() => pointer(tgz, { version: '3.57.1', commit: 'HEAD', issuedAt: 'x' })).toThrow(/not a commit/);
  });

  test('a good signature verifies; another key, a tampered byte or an unknown key id is refused', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const bytes = Buffer.from(JSON.stringify(pointer(tgz, { version: '3.57.1', commit, issuedAt: 'x' })));
    const sig = signPointer(bytes, key.priv);
    expect(verifyPointer(bytes, sig, keys).version).toBe('3.57.1');
    expect(() => verifyPointer(bytes, signPointer(bytes, pair().priv), keys)).toThrow(/signature does not match/);
    expect(() => verifyPointer(Buffer.from(bytes.toString().replace('3.57.1', '3.57.9')), sig, keys)).toThrow(/signature does not match/);
    expect(() => verifyPointer(bytes, sig, [{ keyId: 'another', publicKey: key.pub }])).toThrow(/no key herdr-pack/);
  });

  test('check-key and the keyId: the secret\'s public key picks the pack-keys.json entry', () => {
    const old = pair();
    const next = pair();
    const keys = [{ keyId: KEY_ID, publicKey: old.pub }, { keyId: 'herdr-pack-2027-05', publicKey: next.pub }];
    expect(keyProblem(undefined, keys)).toBe('HERDR_PACK_KEY is not set');
    expect(keyProblem('not a pem', keys)).toMatch(/not a private key/);
    expect(keyProblem(pair().priv, keys)).toMatch(/public key is not in pack-keys\.json/);
    expect(keyProblem(old.priv, keys)).toBeNull();
    expect(keyProblem(next.priv, keys)).toBeNull();
    // Rotation: either listed key signs, under its own id; no constant pins it.
    expect(keyIdOf(old.priv, keys)).toBe(KEY_ID);
    expect(keyIdOf(next.priv, keys)).toBe('herdr-pack-2027-05');
    expect(keyIdOf(pair().priv, keys)).toBeNull();
    const bytes = Buffer.from(JSON.stringify(pointer(tgz, { version: '3.57.1', commit, issuedAt: 'x', keyId: 'herdr-pack-2027-05' })));
    expect(verifyPointer(bytes, signPointer(bytes, next.priv), keys).keyId).toBe('herdr-pack-2027-05');
  });

  test('signerSlot: unset or empty is HERDR_PACK_KEY, each slot names itself, anything else is a problem', () => {
    expect(signerSlot(undefined)).toBe('HERDR_PACK_KEY');
    expect(signerSlot('')).toBe('HERDR_PACK_KEY');
    expect(signerSlot('HERDR_PACK_KEY')).toBe('HERDR_PACK_KEY');
    expect(signerSlot('HERDR_PACK_KEY_NEXT')).toBe('HERDR_PACK_KEY_NEXT');
    for (const bogus of ['bogus', 'herdr_pack_key_next', 'HERDR_PACK_KEY ', 'AM_LANE_KEY']) {
      expect(signerSlot(bogus)).toEqual({ problem: `HERDR_PACK_SIGNER names an unknown slot ${JSON.stringify(bogus)}` });
    }
  });

  test('check-key stops on an unknown selector, and on NEXT selected with its slot empty', () => {
    const bogus = checkKey({ HERDR_PACK_SIGNER: 'bogus', HERDR_PACK_KEY: pair().priv });
    expect(bogus.status).toBe(1);
    expect(bogus.out).toContain('HERDR_PACK_SIGNER names an unknown slot "bogus"');
    // The workflow hands an empty HERDR_PACK_KEY when NEXT is selected and unset; never the primary.
    const empty = checkKey({ HERDR_PACK_SIGNER: 'HERDR_PACK_KEY_NEXT', HERDR_PACK_KEY: '' });
    expect(empty.status).toBe(1);
    expect(empty.out).toContain('HERDR_PACK_KEY is not set (HERDR_PACK_KEY_NEXT selected)');
    const unlisted = checkKey({ HERDR_PACK_KEY: pair().priv });
    expect(unlisted.status).toBe(1);
    expect(unlisted.out).toContain('(HERDR_PACK_KEY selected)');
    for (const run of [bogus, empty, unlisted]) expect(run.out).not.toContain('PRIVATE KEY');
  });

  test('the signer\'s repository is one the pack\'s updater accepts', () => {
    expect(POINTER_REPOSITORIES).toContain(pointer(tgz, { version: '3.57.1', commit, issuedAt: 'x' }).repository);
  });

  test('keygen never writes the slot releases sign with: the first key to HERDR_PACK_KEY, a rotation to the other', () => {
    const listed = [{ keyId: KEY_ID, publicKey: pair().pub }];
    expect(SLOTS).toEqual(['HERDR_PACK_KEY', 'HERDR_PACK_KEY_NEXT']);
    expect(slotFor([], null)).toBe('HERDR_PACK_KEY');
    expect(slotFor(listed, null)).toBe('HERDR_PACK_KEY_NEXT');
    expect(slotFor(listed, 'HERDR_PACK_KEY')).toBe('HERDR_PACK_KEY_NEXT');
    expect(slotFor(listed, 'HERDR_PACK_KEY_NEXT')).toBe('HERDR_PACK_KEY');
  });

  test('posted: the signer refuses to post a lower sequence than the posted pointer\'s', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const at = (version: string) => {
      const file = join(dir, `automagik-herdr-pack-${version}.tgz`);
      writeFileSync(file, version);
      const bytes = Buffer.from(JSON.stringify(pointer(file, { version, commit, issuedAt: 'x' })));
      return { bytes, sig: signPointer(bytes, key.priv) };
    };
    const newer = at('3.60.0');
    const older = at('3.58.0');
    expect(postedProblem(older.bytes, null, null, keys)).toBeNull();
    expect(postedProblem(older.bytes, newer.bytes, newer.sig, keys)).toMatch(/names 3\.60\.0 \(sequence 600000\), newer than 3\.58\.0 \(sequence 580000\): refusing to post an older one/);
    expect(postedProblem(newer.bytes, older.bytes, older.sig, keys)).toBeNull();
    expect(postedProblem(newer.bytes, newer.bytes, newer.sig, keys)).toBeNull();
  });

  test('posted: an unverifiable posted pointer is refused unless the release says to replace it', () => {
    const key = pair();
    const keys = [{ keyId: KEY_ID, publicKey: key.pub }];
    const at = (version: string) => {
      const file = join(dir, `automagik-herdr-pack-${version}.tgz`);
      writeFileSync(file, version);
      const bytes = Buffer.from(JSON.stringify(pointer(file, { version, commit, issuedAt: 'x' })));
      return { bytes, sig: signPointer(bytes, key.priv) };
    };
    const newer = at('3.60.0');
    const older = at('3.58.0');
    const replace = { replaceUnverified: true };
    const refused = /does not verify \((.+)\), so its sequence is unknown: refusing to replace it/;
    // Signed by a key pack-keys.json no longer lists (an old key removed, an old release re-run).
    const removedKey = postedProblem(older.bytes, newer.bytes, newer.sig, []);
    expect(removedKey).toMatch(refused);
    expect(removedKey).toContain(`no key ${KEY_ID}`);
    expect(removedKey).toContain('replace_unverified_herdr_pointer=true');
    // Another key's signature, a signature alone, a pointer alone, a pointer that is not JSON.
    expect(postedProblem(older.bytes, newer.bytes, signPointer(newer.bytes, pair().priv), keys)).toMatch(/the signature does not match/);
    expect(postedProblem(older.bytes, newer.bytes, null, keys)).toMatch(/pack\.json\.sig is missing/);
    expect(postedProblem(older.bytes, null, newer.sig, keys)).toMatch(/pack\.json is missing/);
    expect(postedProblem(older.bytes, Buffer.from('<html>'), newer.sig, keys)).toMatch(refused);
    // The override replaces only what does not verify: a verified higher sequence still stops it.
    expect(postedProblem(older.bytes, newer.bytes, newer.sig, [], replace)).toBeNull();
    expect(postedProblem(older.bytes, newer.bytes, null, keys, replace)).toBeNull();
    expect(postedProblem(older.bytes, newer.bytes, newer.sig, keys, replace)).toMatch(/refusing to post an older one/);
    expect(postedProblem(older.bytes, null, null, keys, replace)).toBeNull();
  });

  test('install.sh embeds the same keys pack-keys.json lists, and keygen rewrites both alike', () => {
    const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys;
    const script = readFileSync(INSTALL_SH, 'utf8');
    expect(installKeys(script)).toEqual(keys);
    const next = [{ keyId: KEY_ID, publicKey: pair().pub }];
    expect(installKeys(withInstallKeys(script, next))).toEqual(next);
    // The private half never appears in either file.
    expect(readFileSync(KEYS_FILE, 'utf8')).not.toContain('PRIVATE KEY');
    expect(script).not.toContain('PRIVATE KEY');
  });
});
