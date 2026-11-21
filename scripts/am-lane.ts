#!/usr/bin/env bun
/**
 * The am lane: a signed pointer to the newest am (RFC 0012, "The am part"), as the herdr lane
 * (scripts/herdr-lane.ts) is for the pack. Every release attaches automagik-am-<v>.tgz, and am's
 * updater reads only two files from the rolling `am-lane` release, which holds nothing else:
 *
 *   https://github.com/automagik-si/automagik/releases/download/am-lane/am.json
 *   https://github.com/automagik-si/automagik/releases/download/am-lane/am.json.sig
 *
 * am.json names the newest am's release and its tarball's URL, sha256 and size; am.json.sig is
 * ed25519 over its exact bytes, detached, base64, made with the AM_LANE_KEY Actions secret, am's
 * own key (never PLUGIN_LANE_KEY or HERDR_PACK_KEY). The public keys are am/am-keys.json, which
 * ships inside am (the installed copy is the trust anchor). The pointer's shape and signature are
 * checked by am/lib/lane.mjs, the same code am runs.
 *
 *   bun scripts/am-lane.ts manifest <tgz> <version> <commit> <issuedAt>   print am.json, its keyId
 *       the am-keys.json entry whose public key is AM_LANE_KEY's
 *   bun scripts/am-lane.ts sign <am.json>             print its signature (AM_LANE_KEY, PEM)
 *   bun scripts/am-lane.ts verify <am.json> <sig>     check it against am-keys.json
 *   bun scripts/am-lane.ts posted <am.json> <dir>     refuse to post it when <dir> holds the posted
 *       pointer (am.json, am.json.sig), it verifies, and its sequence is higher; or when <dir> holds
 *       a posted pointer that does not verify, unless AM_LANE_REPLACE_UNVERIFIED=true (the
 *       release's replace_unverified_am_pointer input). A half-written pointer (one of the two
 *       files, left by an upload that failed) is never read as nothing posted: am.json alone that
 *       names this same am is this release's own post and is finished; any other half is refused
 *       with the command that removes the orphan (--repo comes from GITHUB_REPOSITORY)
 *   bun scripts/am-lane.ts check-key                  before the tag, on every release: while
 *       am-keys.json lists no key, or AM_LANE_KEY is unset, a ::warning:: and `sign=no` (the
 *       release attaches am but posts no am-lane: the key is the owner's to add, and the window
 *       between keygen and its am-keys.json reaching dev stops nothing); a key that is set but is
 *       none of the listed ones fails; a listed one is `sign=yes`. `sign=` goes to $GITHUB_OUTPUT.
 *   bun scripts/am-lane.ts keygen [--repo <owner/repo>] [--key-id <id>]
 *       make a key: an ed25519 pair generated in memory; the private key goes straight to `gh secret
 *       set` on its stdin (never printed, never written to disk), and only then is the public key
 *       added to am/am-keys.json and the pack copy. The first key goes to AM_LANE_KEY. A rotation is two
 *       phases (RFC 0011): keygen puts the new key in the slot that is NOT signing (the
 *       AM_LANE_SIGNER variable names the one that is; AM_LANE_KEY when unset), so releases keep
 *       signing with the old key while an am carrying the new public key ships; later
 *       `gh variable set AM_LANE_SIGNER --body <the new slot>` switches.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
// @ts-expect-error am's plain JavaScript, no types
import { LANE_RELEASE, PART, REPO, REPOSITORY, RELEASES, SCHEMA_VERSION, sequenceOf, tarballName, verifyPointer } from '../am/lib/lane.mjs';
// The pointer's repository and tarball URL come from am/lib/lane.mjs (am's part): they move with it.
import { keyIdOf, publicOf } from './herdr-lane';
import { ROOT, signLane } from './lane';

export { LANE_RELEASE };
export const KEY_ID = 'am-2026-11';
/** The two secret slots a rotation alternates between; release.yml signs with the one AM_LANE_SIGNER names. */
export const SLOTS = ['AM_LANE_KEY', 'AM_LANE_KEY_NEXT'] as const;
export const KEYS_FILE = join(ROOT, 'am', 'am-keys.json');
const PACK_KEYS_FILE = join(ROOT, 'herdr', 'mods', 'am-sidebar', 'am-keys.json');

export function writeKeyFiles(keys: AmKey[], paths: string[]) {
  const text = `${JSON.stringify({ keys }, null, 2)}\n`;
  for (const path of paths) writeFileSync(path, text);
}

export interface AmKey { keyId: string; publicKey: string }
export interface AmPointer {
  schemaVersion: number;
  publisher: 'automagik';
  part: 'automagik.am';
  keyId: string;
  /** Monotonic across releases (3.N.P as N·10000 + P): am refuses a pointer older than one it took. */
  sequence: number;
  issuedAt: string;
  repository: string;
  version: string;
  tag: string;
  commit: string;
  tarball: { name: string; url: string; sha256: string; size: number };
}

/** am.json for the am tarball at `tgz`, released as v`version` from `commit`. */
export function pointer(tgz: string, { version, commit, issuedAt, keyId = KEY_ID }: { version: string; commit: string; issuedAt: string; keyId?: string }): AmPointer {
  const name = tarballName(version);
  if (basename(tgz) !== name) throw new Error(`${tgz} is not ${name}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  const bytes = readFileSync(tgz);
  return {
    schemaVersion: SCHEMA_VERSION,
    publisher: 'automagik',
    part: PART,
    keyId,
    sequence: sequenceOf(version),
    issuedAt,
    repository: REPOSITORY,
    version,
    tag: `v${version}`,
    commit,
    tarball: { name, url: `${RELEASES}/download/v${version}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength },
  };
}

export const signPointer = signLane;
export const verify = (bytes: Buffer, signature: string, keys: AmKey[]): AmPointer => verifyPointer(bytes, signature, keys);

/**
 * What check-key decides: `sign` when AM_LANE_KEY is a key am-keys.json lists; `skip` (with the
 * warning to show) while am-keys.json lists no key or the secret is unset, since am-lane's key is
 * the owner's to add and a release never fails over its absence (nor in the window between keygen
 * and its am-keys.json reaching dev); `fail` (with why) once keys are listed and the secret, set,
 * is none of them.
 */
export function keyVerdict(privatePem: string | undefined, keys: AmKey[]): { verdict: 'sign' | 'skip' | 'fail'; message: string } {
  if (keys.length === 0) {
    return { verdict: 'skip', message: 'am/am-keys.json lists no key yet: this release attaches automagik-am-<v>.tgz but posts no am-lane pointer, so installed ams do not update to it. Make the key and commit am-keys.json (bun scripts/am-lane.ts keygen; RFC 0012)' };
  }
  if (!privatePem) {
    return { verdict: 'skip', message: 'AM_LANE_KEY is not set: this release attaches automagik-am-<v>.tgz but posts no am-lane pointer, so installed ams do not update to it. Add the key (bun scripts/am-lane.ts keygen; RFC 0012)' };
  }
  try { publicOf(privatePem); } catch { return { verdict: 'fail', message: 'AM_LANE_KEY is not a private key (PEM)' }; }
  const keyId = keyIdOf(privatePem, keys);
  return keyId
    ? { verdict: 'sign', message: `AM_LANE_KEY is ${keyId}, listed in am/am-keys.json` }
    : { verdict: 'fail', message: 'AM_LANE_KEY\'s public key is not in am/am-keys.json' };
}

/**
 * Whether a posted am.json with no signature is this release's own half-written post: the upload
 * of am.json went through and its signature's did not (#768). It names the same am as `next` in
 * every field but issuedAt, which a re-run of the job sets anew, so posting `next` over it changes
 * nothing a reader acts on and cannot lower the sequence.
 */
export function ownHalfPost(next: Buffer, posted: Buffer | null, postedSig: string | null): boolean {
  if (!posted || postedSig !== null) return false;
  const named = (bytes: Buffer) => JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), issuedAt: null });
  try { return named(posted) === named(next); } catch { return false; }
}

/**
 * Why `next` (am.json's bytes) must not replace the posted pointer, or null when it may: as
 * herdr-lane's postedProblem. Nothing posted yet is no reason to stop; a posted pointer that
 * verifies with a higher sequence always stops it; one that does not verify stops it too, unless
 * `replaceUnverified` (the release's replace_unverified_am_pointer input). One of the two files
 * alone is a half-written pointer, never nothing posted: this release's own (ownHalfPost) is
 * finished; any other is refused like an unverifiable one, and the reason names the command that
 * removes the orphan on `repo` (a dispatch cannot repair it: with nothing to cut, the job is skipped).
 */
export function postedProblem(next: Buffer, posted: Buffer | null, postedSig: string | null, keys: AmKey[], { replaceUnverified = false, repo = REPO as string } = {}): string | null {
  if (!posted && postedSig === null) return null;
  if (ownHalfPost(next, posted, postedSig)) return null;
  let current: AmPointer;
  try {
    if (!posted) throw new Error('am.json is missing');
    if (postedSig === null) throw new Error('am.json.sig is missing');
    current = verify(posted, postedSig, keys);
  } catch (error) {
    if (replaceUnverified) return null;
    const why = (error as Error).message.replace(/^am lane: /, '');
    const orphan = !posted ? 'am.json.sig' : postedSig === null ? 'am.json' : null;
    if (orphan) {
      return `the posted am-lane pointer is half-written (${why}: only ${orphan} is posted, left by an upload that failed), so it does not verify and its sequence is unknown: refusing to replace it. Once you have checked that no newer am was released, remove the orphan and re-run this job: gh release delete-asset ${LANE_RELEASE} ${orphan} --repo ${repo} --yes`;
    }
    return `the posted am-lane pointer does not verify (${why}), so its sequence is unknown: refusing to replace it. Dispatch the release with replace_unverified_am_pointer=true once you have checked it is not newer`;
  }
  const mine = JSON.parse(next.toString('utf8')) as AmPointer;
  return current.sequence > mine.sequence
    ? `the posted am-lane pointer names ${current.version} (sequence ${current.sequence}), newer than ${mine.version} (sequence ${mine.sequence}): refusing to post an older one`
    : null;
}

/** The secret slot keygen writes: AM_LANE_KEY for the first key, else the slot that is not `signer`. */
export const slotFor = (keys: AmKey[], signer: string | null) =>
  keys.length === 0 ? SLOTS[0] : (signer === SLOTS[1] ? SLOTS[0] : SLOTS[1]);

const readKeys = (): AmKey[] => JSON.parse(readFileSync(KEYS_FILE, 'utf8')).keys ?? [];

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  if (command === 'manifest' && args.length === 4) {
    const [tgz, version, commit, issuedAt] = args;
    const keyId = process.env.AM_LANE_KEY ? keyIdOf(process.env.AM_LANE_KEY, readKeys()) : null;
    if (!keyId) throw new Error(`am lane: ${keyVerdict(process.env.AM_LANE_KEY, readKeys()).message}`);
    console.log(JSON.stringify(pointer(tgz, { version, commit, issuedAt, keyId }), null, 2));
  } else if (command === 'sign' && args.length === 1) {
    const key = process.env.AM_LANE_KEY;
    if (!key) throw new Error('AM_LANE_KEY is not set');
    console.log(signPointer(readFileSync(args[0]), key));
  } else if (command === 'verify' && args.length === 2) {
    const found = verify(readFileSync(args[0]), readFileSync(args[1], 'utf8'), readKeys());
    console.log(`am lane ${found.version} (sequence ${found.sequence}) is signed by ${found.keyId}`);
  } else if (command === 'posted' && args.length === 2) {
    const [file, dir] = args;
    const read = (name: string) => { try { return readFileSync(join(dir, name)); } catch { return null; } };
    const posted = read('am.json');
    const sig = read('am.json.sig');
    const next = readFileSync(file);
    const postedSig = sig === null ? null : sig.toString('utf8');
    const repo = process.env.GITHUB_REPOSITORY || REPO;
    const problem = postedProblem(next, posted, postedSig, readKeys(), { repo });
    const replaceUnverified = process.env.AM_LANE_REPLACE_UNVERIFIED === 'true';
    if (problem && replaceUnverified && postedProblem(next, posted, postedSig, readKeys(), { replaceUnverified, repo }) === null) {
      console.log(`::warning::am lane: ${problem.split(': refusing')[0]}; replacing it (replace_unverified_am_pointer)`);
    } else if (problem) {
      console.error(`am lane: ${problem}`);
      process.exit(1);
    } else if (ownHalfPost(next, posted, postedSig)) {
      console.log('::warning::am lane: the posted pointer is half-written (am.json without am.json.sig) and names this same am: finishing this release\'s own post');
    } else {
      console.log(posted || sig ? 'am lane: the posted pointer is not newer' : 'am lane: no pointer posted yet');
    }
  } else if (command === 'check-key' && args.length === 0) {
    const { verdict, message } = keyVerdict(process.env.AM_LANE_KEY, readKeys());
    if (verdict === 'fail') { console.error(`am lane: ${message} (bun scripts/am-lane.ts keygen makes it; RFC 0012)`); process.exit(1); }
    console.log(verdict === 'skip' ? `::warning::am lane: ${message}` : `am lane: ${message}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sign=${verdict === 'sign' ? 'yes' : 'no'}\n`);
  } else if (command === 'keygen') {
    const repo = flag('--repo', 'automagik-si/automagik');
    const keyId = flag('--key-id', KEY_ID);
    const keys = readKeys();
    if (keys.some(entry => entry.keyId === keyId)) throw new Error(`am-keys.json already lists ${keyId}: pick a new --key-id to rotate`);
    // Never the slot releases sign with: a rotation's new key waits in the other one (phase 1).
    const signer = keys.length === 0 ? null : spawnSync('gh', ['variable', 'get', 'AM_LANE_SIGNER', '--repo', repo], { encoding: 'utf8' });
    const slot = slotFor(keys, signer && signer.status === 0 ? signer.stdout.trim() : null);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const secret = spawnSync('gh', ['secret', 'set', slot, '--repo', repo], { input: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), stdio: ['pipe', 'inherit', 'inherit'] });
    if (secret.status !== 0) { console.error('am lane: gh secret set failed; nothing was written'); process.exit(1); }
    const next = [...keys, { keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
    writeKeyFiles(next, [KEYS_FILE, PACK_KEYS_FILE]);
    console.log(`am lane: ${slot} set on ${repo}; ${keyId} added to both am-keys.json files. Commit them.`);
    if (keys.length > 0) console.log(`Phase 2, only after a release has shipped this am-keys.json and installs have taken it: gh variable set AM_LANE_SIGNER --body ${slot} --repo ${repo}`);
  } else {
    console.error('usage: bun scripts/am-lane.ts manifest <tgz> <version> <commit> <issuedAt> | sign <am.json> | verify <am.json> <sig> | posted <am.json> <dir> | check-key | keygen [--repo <owner/repo>] [--key-id <id>]');
    process.exit(2);
  }
}
