#!/usr/bin/env bun
/**
 * The herdr lane: a signed pointer to the newest herdr pack, as the plugin lane (scripts/lane.ts)
 * is for the plugins (docs/rfcs/0011-monorepo-parts-and-releases.md). A release carries the pack
 * only when herdr/ changed, so the pack's updater and installer do not search the releases: they
 * read two files from the rolling `herdr-lane` release, which holds nothing else:
 *
 *   https://github.com/automagik-si/automagik/releases/download/herdr-lane/pack.json
 *   https://github.com/automagik-si/automagik/releases/download/herdr-lane/pack.json.sig
 *
 * pack.json names the newest pack release and its tarball's URL, sha256 and size; pack.json.sig is
 * ed25519 over its exact bytes, detached, base64, made with the HERDR_PACK_KEY Actions secret (the
 * pack's own key, never PLUGIN_LANE_KEY). The public keys are herdr/mods/am-sidebar/pack-keys.json,
 * which ships inside the pack (the installed copy is the trust anchor), and the same list is
 * embedded in herdr/install.sh (a test keeps them equal).
 *
 *   bun scripts/herdr-lane.ts manifest <tgz> <version> <commit> <issuedAt>   print pack.json, its keyId
 *       the pack-keys.json entry whose public key is HERDR_PACK_KEY's
 *   bun scripts/herdr-lane.ts sign <pack.json>        print its signature (HERDR_PACK_KEY, PEM)
 *   bun scripts/herdr-lane.ts verify <pack.json> <sig>  check it against pack-keys.json
 *   bun scripts/herdr-lane.ts posted <pack.json> <dir>  refuse to post it when <dir> holds the posted
 *       pointer (pack.json, pack.json.sig), it verifies, and its sequence is higher; or when <dir>
 *       holds a posted pointer that does not verify, unless HERDR_LANE_REPLACE_UNVERIFIED=true (the
 *       release's replace_unverified_herdr_pointer input)
 *   bun scripts/herdr-lane.ts check-key               validate HERDR_PACK_SIGNER and its selected key
 *       against pack-keys.json, then print the slot and keyId
 *   bun scripts/herdr-lane.ts keygen [--repo <owner/repo>] [--key-id <id>]
 *       make a key: an ed25519 pair generated in memory; the private key goes straight to `gh secret
 *       set` on its stdin (never printed, never written to disk), and only then is the public key
 *       added to pack-keys.json and install.sh. The first key goes to HERDR_PACK_KEY. A rotation is
 *       two phases (RFC 0011): keygen puts the new key in the secret slot that is NOT signing (the
 *       HERDR_PACK_SIGNER variable names the one that is; HERDR_PACK_KEY when unset), so releases
 *       keep signing with the old key while a pack carrying the new public key ships; later, once
 *       installs have that pack, `gh variable set HERDR_PACK_SIGNER --body <the new slot>` switches.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as verifyBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT, sequenceOf, signLane } from './lane';

export const LANE_RELEASE = 'herdr-lane';
export const SCHEMA_VERSION = 1;
export const KEY_ID = 'herdr-pack-2026-11';
/** The two secret slots a rotation alternates between; release.yml signs with the one HERDR_PACK_SIGNER names. */
export const SLOTS = ['HERDR_PACK_KEY', 'HERDR_PACK_KEY_NEXT'] as const;
export const KEYS_FILE = join(ROOT, 'herdr', 'mods', 'am-sidebar', 'pack-keys.json');
export const INSTALL_SH = join(ROOT, 'herdr', 'install.sh');
const REPOSITORY = 'https://github.com/automagik-si/automagik';
const DOWNLOADS = `${REPOSITORY}/releases/download/`;

export interface PackKey { keyId: string; publicKey: string }
export interface PackPointer {
  schemaVersion: number;
  publisher: 'automagik';
  part: 'herdr';
  keyId: string;
  /** Monotonic across releases (3.N.P as N·10000 + P): a consumer can refuse an older pointer. */
  sequence: number;
  issuedAt: string;
  repository: string;
  version: string;
  tag: string;
  commit: string;
  tarball: { name: string; url: string; sha256: string; size: number };
}

/** pack.json for the pack tarball at `tgz`, released as v`version` from `commit`. */
export function pointer(tgz: string, { version, commit, issuedAt, keyId = KEY_ID }: { version: string; commit: string; issuedAt: string; keyId?: string }): PackPointer {
  const name = `automagik-herdr-pack-${version}.tgz`;
  if (basename(tgz) !== name) throw new Error(`${tgz} is not ${name}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  const bytes = readFileSync(tgz);
  return {
    schemaVersion: SCHEMA_VERSION,
    publisher: 'automagik',
    part: 'herdr',
    keyId,
    sequence: sequenceOf(version),
    issuedAt,
    repository: REPOSITORY,
    version,
    tag: `v${version}`,
    commit,
    tarball: { name, url: `${DOWNLOADS}v${version}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength },
  };
}

export const signPointer = signLane;

/** The pointer in `bytes` when `signature` verifies against the key it names among `keys`; throws otherwise. */
export function verifyPointer(bytes: Buffer, signature: string, keys: PackKey[]): PackPointer {
  const parsed = JSON.parse(bytes.toString('utf8')) as PackPointer;
  const key = keys.find(entry => entry.keyId === parsed.keyId);
  if (!key) throw new Error(`herdr lane: no key ${parsed.keyId}`);
  if (!verifyBytes(null, bytes, createPublicKey(key.publicKey), Buffer.from(signature.trim(), 'base64'))) throw new Error('herdr lane: the signature does not match');
  if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.part !== 'herdr') throw new Error(`herdr lane: not a pack pointer (schema ${parsed.schemaVersion}, part ${parsed.part})`);
  return parsed;
}

/** The public key (SPKI PEM) of a private key (PEM). */
export const publicOf = (privatePem: string) => createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();

const samePublic = (a: string, b: string) => { try { return createPublicKey(a).export({ type: 'spki', format: 'pem' }).toString() === b; } catch { return false; } };

/** The keyId pack-keys.json gives the public half of `privatePem`, or null when it lists no such key. */
export function keyIdOf(privatePem: string, keys: PackKey[]): string | null {
  let pub: string;
  try { pub = publicOf(privatePem); } catch { return null; }
  return keys.find(entry => samePublic(entry.publicKey, pub))?.keyId ?? null;
}

/** Why `privatePem` cannot sign pointers this pack trusts, or null when it can (pack-keys.json lists its public key). */
export function keyProblem(privatePem: string | undefined, keys: PackKey[]): string | null {
  if (!privatePem) return 'HERDR_PACK_KEY is not set';
  try { publicOf(privatePem); } catch { return 'HERDR_PACK_KEY is not a private key (PEM)'; }
  return keyIdOf(privatePem, keys) ? null : 'HERDR_PACK_KEY\'s public key is not in pack-keys.json';
}

/**
 * Why `next` (pack.json's bytes) must not replace the posted pointer, or null when it may. Nothing
 * posted yet (neither file) is no reason to stop. A posted pointer that verifies against `keys` and
 * names a higher sequence always stops it. One that does not verify (another key, a key since
 * removed from pack-keys.json, a bad signature, or only one of the two files) stops it too, since
 * its sequence cannot be trusted, unless `replaceUnverified` is set: the release's
 * replace_unverified_herdr_pointer input, for an operator who has checked the posted pointer.
 */
export function postedProblem(next: Buffer, posted: Buffer | null, postedSig: string | null, keys: PackKey[], { replaceUnverified = false } = {}): string | null {
  if (!posted && postedSig === null) return null;
  let current: PackPointer;
  try {
    if (!posted) throw new Error('pack.json is missing');
    if (postedSig === null) throw new Error('pack.json.sig is missing');
    current = verifyPointer(posted, postedSig, keys);
  } catch (error) {
    if (replaceUnverified) return null;
    const why = (error as Error).message.replace(/^herdr lane: /, '');
    return `the posted herdr-lane pointer does not verify (${why}), so its sequence is unknown: refusing to replace it. Dispatch the release with replace_unverified_herdr_pointer=true once you have checked it is not newer`;
  }
  const mine = JSON.parse(next.toString('utf8')) as PackPointer;
  return current.sequence > mine.sequence
    ? `the posted herdr-lane pointer names ${current.version} (sequence ${current.sequence}), newer than ${mine.version} (sequence ${mine.sequence}): refusing to post an older one`
    : null;
}

/** The secret slot keygen writes: HERDR_PACK_KEY for the first key, else the slot that is not `signer`. */
export const slotFor = (keys: PackKey[], signer: string | null) =>
  keys.length === 0 ? SLOTS[0] : (signer === SLOTS[1] ? SLOTS[0] : SLOTS[1]);

/** The signing slot named by HERDR_PACK_SIGNER, or a problem when the name is unknown. */
export function signerSlot(signer?: string) {
  if (!signer) return SLOTS[0];
  const slot = SLOTS.find(slot => slot === signer);
  return slot ?? { problem: `HERDR_PACK_SIGNER names an unknown slot ${JSON.stringify(signer)}` };
}

/** install.sh's embedded copy of pack-keys.json: its `TRUSTED_KEYS='…'` line, parsed. */
export const installKeys = (text: string): PackKey[] => JSON.parse(/^\s*TRUSTED_KEYS='([^']*)'$/m.exec(text)?.[1] ?? 'null')?.keys;

/** `text` (install.sh) with its TRUSTED_KEYS line set to `keys`. */
export const withInstallKeys = (text: string, keys: PackKey[]) => {
  if (!/^\s*TRUSTED_KEYS='[^']*'$/m.test(text)) throw new Error('install.sh has no TRUSTED_KEYS line');
  return text.replace(/^(\s*)TRUSTED_KEYS='[^']*'$/m, (_, indent: string) => `${indent}TRUSTED_KEYS='${JSON.stringify({ keys })}'`);
};

const readKeys = (): PackKey[] => JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys ?? [];

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  if (command === 'manifest' && args.length === 4) {
    const [tgz, version, commit, issuedAt] = args;
    const slot = signerSlot(process.env.HERDR_PACK_SIGNER);
    if (typeof slot !== 'string') throw new Error(`herdr lane: ${slot.problem}`);
    // The workflow puts the selected slot's key in HERDR_PACK_KEY for all signing commands.
    const key = process.env.HERDR_PACK_KEY;
    const keys = readKeys();
    const keyId = key ? keyIdOf(key, keys) : null;
    if (!keyId) throw new Error(`herdr lane: ${keyProblem(key, keys)} (${slot} selected)`);
    console.log(JSON.stringify(pointer(tgz, { version, commit, issuedAt, keyId }), null, 2));
  } else if (command === 'sign' && args.length === 1) {
    const slot = signerSlot(process.env.HERDR_PACK_SIGNER);
    if (typeof slot !== 'string') throw new Error(`herdr lane: ${slot.problem}`);
    const key = process.env.HERDR_PACK_KEY;
    if (!key) throw new Error(`${slot} is not set`);
    console.log(signPointer(readFileSync(args[0]), key));
  } else if (command === 'verify' && args.length === 2) {
    const found = verifyPointer(readFileSync(args[0]), readFileSync(args[1], 'utf8'), readKeys());
    console.log(`herdr lane ${found.version} (sequence ${found.sequence}) is signed by ${found.keyId}`);
  } else if (command === 'posted' && args.length === 2) {
    const [file, dir] = args;
    const read = (name: string) => { try { return readFileSync(join(dir, name)); } catch { return null; } };
    const posted = read('pack.json');
    const sig = read('pack.json.sig');
    const next = readFileSync(file);
    const postedSig = sig === null ? null : sig.toString('utf8');
    const problem = postedProblem(next, posted, postedSig, readKeys());
    const replaceUnverified = process.env.HERDR_LANE_REPLACE_UNVERIFIED === 'true';
    if (problem && replaceUnverified && postedProblem(next, posted, postedSig, readKeys(), { replaceUnverified }) === null) {
      console.log(`::warning::herdr lane: ${problem.split(': refusing')[0]}; replacing it (replace_unverified_herdr_pointer)`);
    } else if (problem) {
      console.error(`herdr lane: ${problem}`);
      process.exit(1);
    } else {
      console.log(posted || sig ? 'herdr lane: the posted pointer is not newer' : 'herdr lane: no pointer posted yet');
    }
  } else if (command === 'check-key' && args.length === 0) {
    const slot = signerSlot(process.env.HERDR_PACK_SIGNER);
    if (typeof slot !== 'string') {
      console.error(`herdr lane: ${slot.problem}`);
      process.exit(1);
    }
    const key = process.env.HERDR_PACK_KEY;
    const keys = readKeys();
    const problem = keyProblem(key, keys);
    if (problem) {
      console.error(`herdr lane: ${problem} (${slot} selected). See RFC 0011 for bun scripts/herdr-lane.ts keygen.`);
      process.exit(1);
    }
    console.log(`herdr lane: ${slot} is ${keyIdOf(key as string, keys)}, listed in pack-keys.json`);
  } else if (command === 'keygen') {
    const repo = flag('--repo', 'automagik-si/automagik');
    const keyId = flag('--key-id', KEY_ID);
    const keys = readKeys();
    if (keys.some(entry => entry.keyId === keyId)) throw new Error(`pack-keys.json already lists ${keyId}: pick a new --key-id to rotate`);
    // Never the slot releases sign with: a rotation's new key waits in the other one (phase 1).
    const signer = keys.length === 0 ? null : spawnSync('gh', ['variable', 'get', 'HERDR_PACK_SIGNER', '--repo', repo], { encoding: 'utf8' });
    const slot = slotFor(keys, signer && signer.status === 0 ? signer.stdout.trim() : null);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const secret = spawnSync('gh', ['secret', 'set', slot, '--repo', repo], { input: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), stdio: ['pipe', 'inherit', 'inherit'] });
    if (secret.status !== 0) { console.error('herdr lane: gh secret set failed; nothing was written'); process.exit(1); }
    const next = [...keys, { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
    writeFileSync(KEYS_FILE, `${JSON.stringify({ keys: next }, null, 2)}\n`);
    writeFileSync(INSTALL_SH, withInstallKeys(readFileSync(INSTALL_SH, 'utf8'), next));
    console.log(`herdr lane: ${slot} set on ${repo}; ${keyId} added to pack-keys.json and install.sh. Commit both.`);
    if (keys.length > 0) console.log(`Phase 2, only after a release has shipped this pack-keys.json and installs have taken it: gh variable set HERDR_PACK_SIGNER --body ${slot} --repo ${repo}`);
  } else {
    console.error('usage: bun scripts/herdr-lane.ts manifest <tgz> <version> <commit> <issuedAt> | sign <pack.json> | verify <pack.json> <sig> | posted <pack.json> <dir> | check-key | keygen [--repo <owner/repo>] [--key-id <id>]');
    process.exit(2);
  }
}
