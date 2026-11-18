#!/usr/bin/env node
// The Automations panel and install.sh install our scheduler release and pin its four binaries by
// sha256 (mods/am-automations/scheduler.js, SCHEDULER: two darwin, two Linux). This check downloads
// that release's checksums.txt and fails unless every pin is exactly its hash, so a release built from a different tree
// cannot leave the panel handing out a repair command that 404s or fails its shasum.
//
// The public download gets 15 seconds for the small checksums.txt file. On a 5xx, a timeout or
// a network error the REST API asset route gets its full timeout (release-assets.mjs).
// The pinned hashes are checked the same way wherever the bytes came from.
//
//   node herdr/scripts/scheduler-pin.mjs
//
// Prints a line per pinned asset; exits 1 on any difference, 2 when neither route can serve it (the
// release not cut yet is a 404, which is the same "not there").
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCHEDULER } from "../mods/am-automations/scheduler.js";
import { releaseAssets } from "./release-assets.mjs";

const RELEASE = `herdr-automations-v${SCHEDULER.version}`;
const BASE = `https://github.com/${SCHEDULER.repo}/releases/download/${RELEASE}`;
const API = `https://api.github.com/repos/${SCHEDULER.repo}`;
const CHECKSUMS_PUBLIC_TIMEOUT = 15_000;
const ASSETS = {
  arm64: "herdr-automations_darwin_arm64", amd64: "herdr-automations_darwin_amd64",
  linux_arm64: "herdr-automations_linux_arm64", linux_amd64: "herdr-automations_linux_amd64",
};
const PINNED = { ...SCHEDULER.sha256, linux_arm64: SCHEDULER.linux.arm64, linux_amd64: SCHEDULER.linux.amd64 };

/**
 * Check the release's checksums against the pins. `pinned` and `assets` are injectable so the
 * tests can serve their own hashes; the CLI runs with scheduler.js's map. Returns the exit code:
 * 0 when every pin matches, 1 on any difference, 2 when neither route serves checksums.txt.
 */
export async function check({
  fetch: fetchImpl = globalThis.fetch,
  base = BASE,
  api = API,
  tag = RELEASE,
  token = process.env.GITHUB_TOKEN,
  pinned = PINNED,
  assets = ASSETS,
  log = console.log,
  error = console.error,
} = {}) {
  const source = releaseAssets({ base, api, tag, token, fetch: fetchImpl, log });
  const problems = [];
  let sums;
  try {
    sums = (await source.get("checksums.txt", { publicTimeout: CHECKSUMS_PUBLIC_TIMEOUT })).toString("utf8");
  } catch (e) {
    error(`scheduler-pin: ${e.message}`);
    return 2;
  }
  const listed = Object.fromEntries([...sums.matchAll(/^([0-9a-f]{64}) [ *](\S+)$/gm)].map((m) => [m[2], m[1]]));
  for (const [arch, asset] of Object.entries(assets)) {
    const pin = pinned[arch];
    if (/^[0-9a-f]{64}$/.test(pin) && listed[asset] === pin) log(`${asset}: ${pin} ok`);
    else problems.push(`${asset}: checksums.txt says ${listed[asset] ?? "nothing"}, the panel pins ${pin}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) error(`scheduler-pin: ${problem}`);
    return 1;
  }
  log(`scheduler-pin: ${tag} matches every pin (${Object.keys(assets).length})`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await check();
