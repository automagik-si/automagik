// scripts/scheduler-pin.mjs against a fake release host: the public download route can answer 504
// (or serve), the API asset route serves the same checksums.txt (directly or through a redirect),
// and the test pins hashes for its own fixture binaries. No test reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { check } from "../scripts/scheduler-pin.mjs";
import { fakeRelease } from "./fake-release.mjs";

const TAG = "herdr-automations-v0.12.1-am.1";
const ASSETS = { arm64: "herdr-automations_darwin_arm64", amd64: "herdr-automations_darwin_amd64" };
const HASH = {
  arm64: createHash("sha256").update("the arm64 build\n").digest("hex"),
  amd64: createHash("sha256").update("the amd64 build\n").digest("hex"),
};
const SUMS = `${HASH.arm64}  ${ASSETS.arm64}\n${HASH.amd64}  ${ASSETS.amd64}\n`;
const FILES = { "checksums.txt": Buffer.from(SUMS) };

/** Run the check against the fake host and this fixture's pins; collects logs, requests and redirects. */
async function run({ token = "", fetch: fetchImpl, files = FILES, ...hostOptions } = {}) {
  const host = await fakeRelease({ tag: TAG, files, ...hostOptions });
  const logs = [];
  const errors = [];
  try {
    const code = await check({
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      base: `${host.origin}/download/${TAG}`,
      api: `${host.origin}/api`,
      tag: TAG,
      token,
      pinned: HASH,
      assets: ASSETS,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    return { code, logs, errors, requests: host.requests, redirects: host.redirects };
  } finally {
    await host.close();
  }
}

test("a 504 from the public checksums.txt is served by the API asset route", async () => {
  const r = await run({ publicStatus: 504, token: "test-token", assetRedirect: true });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.ok(r.logs.includes("checksums.txt: served by the REST API asset route"), "the API route is named");
  assert.equal(r.logs.filter((line) => line.includes("served by the")).length, 1, "one route line for the one asset");
  for (const [arch, asset] of Object.entries(ASSETS)) assert.ok(r.logs.includes(`${asset}: ${HASH[arch]} ok`), `${asset} matches`);
  const assets = r.requests.filter((request) => request.path.startsWith("/asset/"));
  assert.equal(assets.length, 1, "checksums.txt came from the API");
  assert.ok(assets.every((request) => request.headers.accept === "application/octet-stream"), "the asset url asks for octet-stream");
  assert.ok(assets.every((request) => request.headers.authorization === "Bearer test-token"), "GITHUB_TOKEN is the bearer token");
  const publicRequests = r.requests.filter((request) => request.path.startsWith("/download/"));
  assert.ok(publicRequests.length > 0 && publicRequests.every((request) => request.headers.authorization === undefined), "the token is never sent to the public URL");
  assert.equal(r.redirects.length, 1, "one request reached the redirect origin");
  assert.equal(r.redirects[0].path, "/blob/checksums.txt");
  assert.equal(r.redirects[0].authorization, false, "the redirect does not forward the token");
});

// release-assets.mjs's other fallback (it was usagemeter-pin.mjs's test until RFC 0017 retired that check).
test("a network error from the public download falls back to the API asset route too", async () => {
  const forwarded = globalThis.fetch;
  const offlinePublic = (url, init) => (String(url).includes(`/download/${TAG}/`) ? Promise.reject(new TypeError("fetch failed")) : forwarded(url, init));
  const r = await run({ fetch: offlinePublic });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.ok(r.requests.every((request) => !request.path.startsWith("/download/")), "the public route was unreachable");
  assert.ok(r.logs.includes("checksums.txt: served by the REST API asset route"), "the API served it");

  // A hung public route: only its 15 s allowance is cut to 1 ms of real time; the API keeps its own full one.
  const realTimeout = AbortSignal.timeout;
  const allowances = [];
  const apiSignals = [];
  AbortSignal.timeout = (ms) => (allowances.push(ms), realTimeout.call(AbortSignal, ms === 15_000 ? 1 : ms));
  const hungPublic = (url, init) => {
    if (!String(url).includes(`/download/${TAG}/`)) return apiSignals.push(init.signal.aborted), forwarded(url, init);
    return new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const started = Date.now();
  let hung;
  try { hung = await run({ fetch: hungPublic }); } finally { AbortSignal.timeout = realTimeout; }
  assert.equal(hung.code, 0, hung.errors.join("\n"));
  assert.deepEqual(allowances, [15_000, 120_000, 120_000], "public 15 s; the API release and asset requests each get the full 120 s");
  assert.deepEqual(apiSignals, [false, false], "each API request starts with its own live signal");
  assert.ok(hung.logs.includes("checksums.txt: served by the REST API asset route"), "a public timeout falls back to the API");
  for (const [arch, asset] of Object.entries(ASSETS)) assert.ok(hung.logs.includes(`${asset}: ${HASH[arch]} ok`), `${asset} still checked`);
  assert.ok(Date.now() - started < 5_000, "no real allowance was waited out");
});

test("when both routes fail the check exits 2", async () => {
  const r = await run({ publicStatus: 504, apiStatus: 503 });
  assert.equal(r.code, 2);
  const errors = r.errors.join("\n");
  assert.match(errors, /HTTP 504/, "the public failure is reported");
  assert.match(errors, /the API asset route failed too/, "the fallback failure is reported");
  assert.match(errors, /HTTP 503/, "the API's status is reported");
});

test("wrong bytes from the API asset route still exit 1", async () => {
  const files = { "checksums.txt": Buffer.from(`${"0".repeat(64)}  ${ASSETS.arm64}\n${HASH.amd64}  ${ASSETS.amd64}\n`) };
  const r = await run({ publicStatus: 504, files });
  assert.equal(r.code, 1, "a hash difference, not a route failure");
  assert.ok(r.logs.includes("checksums.txt: served by the REST API asset route"), "the bytes came from the API");
  assert.match(r.errors.join("\n"), new RegExp(`${ASSETS.arm64}: checksums\\.txt says`));
});

test("a 404 is the release really not being there: the API route is not tried", async () => {
  const r = await run({ publicStatus: 404, apiStatus: 200 });
  assert.equal(r.code, 2, "the public route's refusal is final");
  assert.match(r.errors.join("\n"), /HTTP 404/);
  assert.ok(r.requests.every((request) => !request.path.startsWith("/api/") && !request.path.startsWith("/asset/")), "no API fallback on a 4xx");
});

test("a public checksums.txt that serves names the public route", async () => {
  const r = await run({ publicStatus: 200 });
  assert.equal(r.code, 0, r.errors.join("\n"));
  assert.ok(r.logs.includes("checksums.txt: served by the public release download"), "the public route is named");
  assert.ok(r.requests.every((request) => !request.path.startsWith("/asset/")), "the API was not needed");
});
