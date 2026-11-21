// The meter lane, as the pack's CLI (and am's copy) reads it: the signed pointer to the newest
// usagemeter build (RFC 0017, "How meterFleet moves to the pointer"). meter.json and its detached
// ed25519 signature, meter.json.sig (base64), sit on the rolling `meter-lane` release of the
// Automagik repository; the keys it may be signed with are meter-keys.json beside this file, a copy
// of meter/usagemeter/meter-keys.json (scripts/meter-lane.ts keygen writes both, and install.sh's
// METER_KEYS, kept equal by tests). The pointer is read on the computer running the command, checked
// here, and only then is any machine asked for anything: meterFleet.js passes each machine the
// sha256 this pointer names for its build.
//
// Fails closed: the signature is checked over the exact bytes against every listed key before any
// field is read, and anything else wrong (the key id it names, the part, the repository, the tag,
// the sequence, the four targets, a URL off the tag) refuses the whole pointer with one line. A
// pointer whose sequence is lower than the one this install already took is refused too, so a
// re-posted older pointer never downgrades. Node only (crypto, fs): the sidebar never loads it.
// Apache-2.0.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { USAGEMETER } from "./release.js";

export const METER_KEYS_FILE = "meter-keys.json";
/**
 * The repository the signed pointer names, and its assets' URLs: still the pre-transfer name, which
 * scripts/meter-lane.ts writes and every installed pack and am compare exactly. Only where the
 * pointer and the builds are downloaded from (USAGEMETER.repo) moved to the new name.
 */
export const METER_REPOSITORY = "https://github.com/automagik-dev/automagik";
/** A release's download folder is `${METER_DOWNLOADS}/<tag>`. */
export const METER_DOWNLOADS = `https://github.com/${USAGEMETER.repo}/releases/download`;
export const METER_POINTER_URL = `${METER_DOWNLOADS}/${USAGEMETER.lane}/meter.json`;
/** Target (`<os>-<arch>`) to asset name: the four every meter release carries (meter/usagemeter/part.json `artifact`). */
export const METER_TARGETS = Object.freeze({
  "darwin-arm64": "usagemeter-darwin-arm64", "darwin-x86_64": "usagemeter-darwin-x86_64",
  "linux-x86_64": "usagemeter-linux-x86_64", "linux-aarch64": "usagemeter-linux-aarch64",
});
/** Test keys, as a keys file's text; honoured for a file:// release folder only. */
export const TEST_KEYS_ENV = "AUTOMAGIK_HERDR_METER_KEYS";

const RELEASE_VERSION = /^3\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
/** scripts/lane.ts sequenceOf: 3.N.P as N·10000 + P, or null for anything that is not a release version. */
export function meterSequenceOf(version) {
  const m = RELEASE_VERSION.exec(String(version ?? ""));
  return m ? Number(m[1]) * 10_000 + Number(m[2]) : null;
}

/** The keys this pack trusts for the pointer: meter-keys.json beside this file (none: nothing verifies). */
export const meterKeys = (dir = dirname(fileURLToPath(import.meta.url))) => {
  try { return JSON.parse(readFileSync(join(dir, METER_KEYS_FILE), "utf8"))?.keys ?? []; } catch { return []; }
};

const refuse = (why) => { throw new Error(`the meter-lane pointer ${why}: nothing was installed`); };

/**
 * meter.json's exact `bytes` and its base64 `signature`, checked against `keys`: the pointer when
 * every check passes, else throws one line. The signature is checked first, against each key in
 * turn, with nothing parsed yet; then the key id the pointer names must be that key's.
 */
export function verifyMeterPointer(bytes, signature, keys) {
  const signed = Buffer.from(bytes ?? []);
  const sig = Buffer.from(String(signature ?? "").trim(), "base64");
  const signer = sig.length === 0 ? null : (Array.isArray(keys) ? keys : []).find((k) => {
    try { return verifySignature(null, signed, createPublicKey(k.publicKey), sig); } catch { return false; }
  });
  if (!signer) refuse("is not signed by a key this pack trusts (meter-keys.json)");
  let p;
  try { p = JSON.parse(signed.toString("utf8")); } catch { refuse("is not JSON"); }
  if (!p || typeof p !== "object" || Array.isArray(p)) refuse("is not a JSON object");
  if (p.keyId !== signer.keyId) refuse(`names the key ${p.keyId}, but ${signer.keyId} signed it`);
  if (p.schemaVersion !== 1 || p.part !== "automagik.usagemeter") refuse(`is not a usagemeter pointer (schema ${p.schemaVersion}, part ${p.part})`);
  if (p.publisher !== "automagik" || p.repository !== METER_REPOSITORY) refuse(`names another repository (${p.repository})`);
  if (meterSequenceOf(p.version) === null) refuse(`names no release version (${p.version})`);
  if (p.tag !== `v${p.version}`) refuse(`names the tag ${p.tag}, not v${p.version}`);
  if (!Number.isSafeInteger(p.sequence) || p.sequence !== meterSequenceOf(p.version)) refuse(`has the sequence ${p.sequence}, not the one ${p.version} has`);
  if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit)) refuse("names no commit");
  const assets = p.assets && typeof p.assets === "object" && !Array.isArray(p.assets) ? p.assets : {};
  if (Object.keys(assets).sort().join() !== Object.keys(METER_TARGETS).sort().join()) refuse(`does not name exactly the targets ${Object.keys(METER_TARGETS).join(", ")}`);
  const checked = {};
  for (const [target, name] of Object.entries(METER_TARGETS)) {
    const a = assets[target] && typeof assets[target] === "object" ? assets[target] : {};
    if (a.name !== name) refuse(`names ${a.name} for ${target}, not ${name}`);
    if (a.url !== `${METER_REPOSITORY}/releases/download/${p.tag}/${name}`) refuse(`has ${name} at ${a.url}, off the tag ${p.tag}`);
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) refuse(`names no sha256 for ${name}`);
    if (!Number.isSafeInteger(a.size) || a.size <= 0) refuse(`names no size for ${name}`);
    checked[target] = Object.freeze({ name, sha256: a.sha256, size: a.size });
  }
  return Object.freeze({ keyId: p.keyId, version: p.version, tag: p.tag, sequence: p.sequence, commit: p.commit, assets: Object.freeze(checked) });
}

/**
 * Where the pointer and the builds come from: the Automagik repository's releases, or, for the
 * tests, a file:// AUTOMAGIK_HERDR_RELEASE_URL folder laid out the same way
 * (`<url>/download/meter-lane/meter.json`, `<url>/download/v<version>/<asset>`), with its own keys
 * in AUTOMAGIK_HERDR_METER_KEYS. Neither hook is honoured for anything but a file:// folder.
 */
export function meterSource(env = {}) {
  const url = env.AUTOMAGIK_HERDR_RELEASE_URL;
  if (typeof url === "string" && url.startsWith("file://") && !url.includes("..") && !url.includes("%")) {
    const root = url.replace(/\/+$/, "");
    return { file: true, pointer: `${root}/download/${USAGEMETER.lane}/meter.json`, base: (tag) => `${root}/download/${tag}`, testKeys: env[TEST_KEYS_ENV] ?? null };
  }
  return { file: false, pointer: METER_POINTER_URL, base: (tag) => `${METER_DOWNLOADS}/${tag}`, testKeys: null };
}

/**
 * Reads and checks the pointer: `{ pointer, base }`, base being the download folder of the release
 * it names. `recorded`: the highest sequence this install took before (the install record's
 * usagemeter-sequence), or null when it took none. Throws one line on any refusal; nothing is
 * changed anywhere before it returns.
 */
export async function readMeterLane({ env = process.env, fetch = globalThis.fetch, keys = meterKeys(), recorded = null, timeoutMs = 15_000 } = {}) {
  const source = meterSource(env);
  let trusted = keys;
  if (source.file && source.testKeys) {
    try { trusted = JSON.parse(source.testKeys)?.keys ?? []; } catch { throw new Error(`${TEST_KEYS_ENV} is not a keys file: nothing was installed`); }
  }
  const get = source.file
    ? async (url) => readFileSync(fileURLToPath(url))
    : async (url) => {
      const response = await fetch(url, { headers: { "user-agent": "automagik-herdr" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
  const why = (e) => String(e?.code === "ENOENT" ? "not found" : e?.message ?? e).split("\n")[0];
  let bytes, signature;
  try { bytes = await get(source.pointer); } catch (e) { throw new Error(`could not read the meter-lane pointer ${source.pointer} (${why(e)}): nothing was installed`); }
  try { signature = (await get(`${source.pointer}.sig`)).toString("utf8"); } catch (e) { refuse(`has no signature (${source.pointer}.sig: ${why(e)})`); }
  const pointer = verifyMeterPointer(bytes, signature, trusted);
  if (Number.isSafeInteger(recorded) && pointer.sequence < recorded) {
    refuse(`names ${pointer.version} (sequence ${pointer.sequence}), older than the sequence ${recorded} this install already took: refusing to downgrade`);
  }
  return { pointer, base: source.base(pointer.tag) };
}
