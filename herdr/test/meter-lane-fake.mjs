// A fake meter lane for the tests: a file:// release folder laid out as the Automagik repository's
// releases are (<root>/download/meter-lane/meter.json and .sig, <root>/download/v<version>/<asset>),
// its pointer shaped as scripts/meter-lane.ts writes it and signed by a key made for this run only.
// Each asset is a script that answers `usagemeter <reports>`. No real key, build or network.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { METER_REPOSITORY, METER_TARGETS, meterSequenceOf } from "../mods/am-sidebar/meterLane.mjs";

/** A throwaway ed25519 pair: `keys` is a meter-keys.json listing its public half as `keyId`. */
export function meterKey(keyId = "meter-test") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { keyId, privateKey, pub, keys: JSON.stringify({ keys: [{ keyId, publicKey: pub }] }) };
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Publishes v`version` into the release folder `root` and points the lane at it. `reports`: what
 * the fake binaries print; `edit(pointer)`: changes the pointer before it is signed; `signer`: the
 * key that signs (default `key`); `sig: false` leaves meter.json.sig out; `sums`: also write a
 * usagemeter.SHA256SUMS with these lines (`(name, realSha) => line`); `script(name)`: a build's
 * whole text instead (its sha256 is still the one the pointer names). Returns the pointer object.
 */
export function publishMeter(root, key, { version, reports = version, edit = null, signer = key, sig = true, sums = null, script = null } = {}) {
  const dir = join(root, "download", `v${version}`);
  mkdirSync(dir, { recursive: true });
  const assets = {};
  for (const [target, name] of Object.entries(METER_TARGETS)) {
    const body = script ? script(name) : `#!/bin/sh\n[ "$1" = --version ] && echo "usagemeter ${reports}"\n# ${name} ${version}\nexit 0\n`;
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
    assets[target] = { name, url: `${METER_REPOSITORY}/releases/download/v${version}/${name}`, sha256: sha(body), size: Buffer.byteLength(body) };
  }
  if (sums) writeFileSync(join(dir, "usagemeter.SHA256SUMS"), Object.values(assets).map((a) => `${sums(a.name, a.sha256)}\n`).join(""));
  const pointer = {
    schemaVersion: 1, publisher: "automagik", part: "automagik.usagemeter", keyId: key.keyId,
    sequence: meterSequenceOf(version), issuedAt: "2026-11-09T00:00:00Z", repository: "https://github.com/automagik-dev/automagik",
    version, tag: `v${version}`, commit: "a".repeat(40), assets,
  };
  if (edit) edit(pointer);
  writePointer(root, pointer, { signer, sig });
  return pointer;
}

/** Writes `pointer` as the lane's meter.json, signed by `signer` (or no .sig with `sig: false`; a string: that .sig text). */
export function writePointer(root, pointer, { signer, sig = true } = {}) {
  const lane = join(root, "download", "meter-lane");
  mkdirSync(lane, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
  writeFileSync(join(lane, "meter.json"), bytes);
  if (typeof sig === "string") writeFileSync(join(lane, "meter.json.sig"), sig);
  else if (sig) writeFileSync(join(lane, "meter.json.sig"), sign(null, bytes, signer.privateKey).toString("base64"));
  else rmSync(join(lane, "meter.json.sig"), { force: true });
  return bytes;
}

/** The bytes of the asset the lane names for `target` in the release folder `root`. */
export const assetBytes = (root, pointer, target) => readFileSync(join(root, "download", pointer.tag, pointer.assets[target].name));
