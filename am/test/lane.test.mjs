// am-lane's pointer check (lib/lane.mjs) and where am reads it from (lib/self.mjs sourceOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { RELEASES, REPOSITORY, checkPointer, sequenceOf, verifyPointer } from "../lib/lane.mjs";
import { sourceOf } from "../lib/self.mjs";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const pointer = (version = "3.64.2", extra = {}) => ({
  schemaVersion: 1, publisher: "automagik", part: "automagik.am", keyId: "am-test", sequence: sequenceOf(version),
  issuedAt: "2026-11-03T00:00:00Z", repository: "https://github.com/automagik-dev/automagik", version, tag: `v${version}`,
  commit: "a".repeat(40),
  tarball: { name: `automagik-am-${version}.tgz`, url: `${REPOSITORY}/releases/download/v${version}/automagik-am-${version}.tgz`, sha256: "b".repeat(64), size: 10 },
  ...extra,
});
const signed = (value, key) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, sig: sign(null, bytes, key.privateKey).toString("base64") };
};

test("a pointer signed by a trusted key verifies", () => {
  const key = pair();
  const { bytes, sig } = signed(pointer(), key);
  assert.equal(verifyPointer(bytes, sig, [{ keyId: "am-test", publicKey: key.publicKey }]).version, "3.64.2");
});

test("refused: an untrusted key, another key's signature, a bad signature, garbage", () => {
  const key = pair();
  const other = pair();
  const { bytes, sig } = signed(pointer(), key);
  assert.throws(() => verifyPointer(bytes, sig, []), /a key this am does not trust/);
  assert.throws(() => verifyPointer(bytes, sig, [{ keyId: "am-test", publicKey: other.publicKey }]), /signature does not match/);
  assert.throws(() => verifyPointer(bytes, "AAAA", [{ keyId: "am-test", publicKey: key.publicKey }]), /signature does not match/);
  assert.throws(() => verifyPointer(Buffer.from("not json"), sig, [{ keyId: "am-test", publicKey: key.publicKey }]), /not JSON/);
});

test("refused even when signed: a pointer whose fields disagree", () => {
  const bad = [
    [{ part: "herdr" }, /not an am pointer/],
    [{ tag: "v3.64.1" }, /tag/],
    [{ sequence: 1 }, /sequence/],
    [{ repository: "https://github.com/someone/else" }, /not Automagik's/],
    [{ commit: "main" }, /no commit/],
    [{ tarball: { ...pointer().tarball, name: "automagik-herdr-pack-3.64.2.tgz" } }, /tarball/],
    [{ tarball: { ...pointer().tarball, url: "https://example.com/am.tgz" } }, /URL/],
    [{ tarball: { ...pointer().tarball, sha256: "nope" } }, /sha256/],
  ];
  for (const [extra, why] of bad) assert.throws(() => checkPointer(pointer("3.64.2", extra)), why, JSON.stringify(extra));
});

test("a test's own keys are honoured for a file:// folder only, never a GitHub URL", () => {
  const own = [{ keyId: "own", publicKey: "x" }];
  const test = JSON.stringify({ keys: [{ keyId: "test", publicKey: "y" }] });
  assert.deepEqual(sourceOf({}, own), { releases: RELEASES, keys: own, file: false });
  assert.equal(sourceOf({ AM_RELEASE_URL: "file:///tmp/rel", AM_TRUSTED_KEYS: test }, own).keys[0].keyId, "test");
  const github = sourceOf({ AM_RELEASE_URL: "https://github.com/automagik-si/automagik/releases", AM_TRUSTED_KEYS: test }, own);
  assert.deepEqual(github.keys, own);
  assert.throws(() => sourceOf({ AM_RELEASE_URL: "https://example.com/releases" }, own), /must be a file:\/\/ folder/);
});
