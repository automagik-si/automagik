// A signed am release in scratch space. The curl stand-in accepts only the documented HTTPS URLs.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASES, REPOSITORY, sequenceOf, tarballName } from "../lib/lane.mjs";

const AM = fileURLToPath(new URL("..", import.meta.url));
const BASE = "https://raw.githubusercontent.com/automagik-si/automagik/main/am/am-keys.json";

export function signedRelease(root) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "am-test";
  const keys = JSON.stringify({ keys: [{ keyId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() }] });
  const releases = join(root, "release"), lane = join(releases, "download", "am-lane");
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(releases, "am-keys.json"), keys);
  const pack = (version, { edit, archiveArgs = [] } = {}) => {
    const dir = join(root, `am-${version}`);
    cpSync(AM, dir, { recursive: true, filter: (p) => !p.startsWith(join(AM, "test")) });
    writeFileSync(join(dir, "am-keys.json"), keys);
    writeFileSync(join(dir, "VERSION"), `${version}\n`);
    edit?.(dir);
    const to = join(releases, "download", `v${version}`);
    mkdirSync(to, { recursive: true });
    const archive = join(to, tarballName(version));
    execFileSync("tar", ["-czf", archive, ...archiveArgs, "-C", dir, ...readdirSync(dir)], { stdio: ["ignore", "ignore", "pipe"] });
    return { dir, archive };
  };
  const post = (version, archive, { edit, sig } = {}) => {
    const body = readFileSync(archive), name = basename(archive);
    const pointer = { schemaVersion: 1, publisher: "automagik", part: "automagik.am", keyId, sequence: sequenceOf(version),
      repository: REPOSITORY, version, tag: `v${version}`, commit: "a".repeat(40),
      tarball: { name, url: `${RELEASES}/download/v${version}/${name}`, sha256: createHash("sha256").update(body).digest("hex"), size: body.length } };
    edit?.(pointer);
    const bytes = Buffer.from(JSON.stringify(pointer));
    const signature = sig ?? sign(null, bytes, privateKey).toString("base64");
    writeFileSync(join(lane, "am.json"), bytes);
    writeFileSync(join(lane, "am.json.sig"), signature);
    return { pointer, bytes, signature };
  };
  const curl = (bin) => {
    const program = join(bin, "curl.mjs");
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`, { mode: 0o755 });
    writeFileSync(program, `import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
const [flags, proto, https, redir, httpsAgain, ...args] = process.argv.slice(2);
assert.deepEqual([proto, https, redir, httpsAgain], ["--proto", "=https", "--proto-redir", "=https"]);
const url = args.at(-1);
assert.ok(url);
assert.deepEqual(args, flags === "-fsSLO" ? [url] : ["-o", args[1], url]);
assert.ok(flags === "-fsSLO" || flags === "-fsSL");
const asset = ${JSON.stringify(RELEASES)};
const path = url === ${JSON.stringify(BASE)} ? "am-keys.json"
  : url.startsWith(asset + "/download/") && /^download\\/(?:am-lane\\/am\\.json(?:\\.sig)?|v3\\.[0-9]+\\.[0-9]+\\/automagik-am-3\\.[0-9]+\\.[0-9]+\\.tgz)$/.test(url.slice(asset.length + 1))
    ? url.slice(asset.length + 1) : null;
assert.ok(path, url);
const from = join(${JSON.stringify(releases)}, path);
if (!existsSync(from)) process.exit(22);
copyFileSync(from, flags === "-fsSLO" ? basename(path) : args[1]);
`);
  };
  return { releases, lane, keys, pack, post, curl };
}
