// am-lane: the signed pointer to the newest am (RFC 0012, "The am part"). Every release attaches
// automagik-am-<v>.tgz, and the rolling `am-lane` release holds only am.json, which names the
// newest am's release and its tarball's sha256, and am.json.sig, ed25519 over its exact bytes
// (detached, base64), made with am's own key (AM_LANE_KEY; never PLUGIN_LANE_KEY or the pack's).
// am trusts the public keys in its own am-keys.json. This file is the one check of a pointer's
// shape and signature: am's updater and the release (scripts/am-lane.ts) both use it. Plain
// JavaScript, Node 22.7+ or bun, no dependencies. Apache-2.0.

import { createPublicKey, verify } from "node:crypto";
import { VERSION, sequenceOf } from "../amInstallState.js";

export { VERSION, sequenceOf };

export const REPO = "automagik-dev/automagik";
export const REPOSITORY = `https://github.com/${REPO}`;
export const RELEASES = `${REPOSITORY}/releases`;
export const LANE_RELEASE = "am-lane";
export const POINTER = "am.json";
export const SIGNATURE = "am.json.sig";
export const SCHEMA_VERSION = 1;
export const PART = "automagik.am";

export const tarballName = (version) => `automagik-am-${version}.tgz`;

const fail = (why) => { throw new Error(`am lane: ${why}`); };

/** Throws unless `p` is an am pointer whose fields agree with each other; returns it. */
export function checkPointer(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("the pointer is not a JSON object");
  if (p.schemaVersion !== SCHEMA_VERSION || p.part !== PART) fail(`not an am pointer (schema ${p.schemaVersion}, part ${p.part})`);
  if (p.publisher !== "automagik" || p.repository !== REPOSITORY) fail("the pointer is not Automagik's");
  if (typeof p.version !== "string" || !VERSION.test(p.version)) fail(`the pointer's version is not a release version: ${p.version}`);
  if (p.tag !== `v${p.version}`) fail(`the pointer's tag ${p.tag} is not v${p.version}`);
  if (!Number.isSafeInteger(p.sequence) || p.sequence !== sequenceOf(p.version)) fail(`the pointer's sequence ${p.sequence} is not ${p.version}'s`);
  if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit)) fail("the pointer names no commit");
  const t = p.tarball ?? {};
  if (t.name !== tarballName(p.version)) fail(`the pointer's tarball ${t.name} is not ${tarballName(p.version)}`);
  if (t.url !== `${RELEASES}/download/${p.tag}/${t.name}`) fail(`the pointer's tarball URL ${t.url} is not on ${p.tag}`);
  if (typeof t.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(t.sha256)) fail("the pointer names no sha256");
  if (!Number.isSafeInteger(t.size) || t.size <= 0) fail("the pointer names no size");
  return p;
}

/**
 * The pointer in `bytes` (am.json's exact bytes) when `signature` (base64) verifies against the key
 * it names among `keys` ({ keyId, publicKey (PEM) }[]) and its fields are an am pointer's; throws
 * otherwise, with a message that starts "am lane: ".
 */
export function verifyPointer(bytes, signature, keys) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { fail("the pointer is not JSON"); }
  const key = (keys ?? []).find((k) => k.keyId === parsed?.keyId);
  if (!key) fail(`the pointer is signed by ${parsed?.keyId}, a key this am does not trust`);
  let ok = false;
  try { ok = verify(null, Buffer.from(bytes), createPublicKey(key.publicKey), Buffer.from(String(signature ?? "").trim(), "base64")); } catch { /* not a key */ }
  if (!ok) fail("the signature does not match");
  return checkPointer(parsed);
}
