// Install am on one linked machine through hc exec. The probe never runs the target's am.
import { readFileSync } from "node:fs";
import { machineList } from "./accountsRows.js";
import { classify, installState, liveInstallLock, packEntries, PENDING, recordAt, recordSequence, recordSlot, sameRealPath, sequenceOf, storeProblem, VERSION } from "./amInstallState.js";
import { MACHINE_NAME } from "./meterFleet.js";
import { REMOTE_TEXT_MAX } from "./remoteFile.js";

// Kept verbatim in the manual install block. Keep the pointer checks aligned with am/lib/lane.mjs.
export const VERIFY_JS = String.raw`
const { readFileSync } = require("node:fs");
const { createPublicKey, verify } = require("node:crypto");
const fail = (why) => { console.error("am lane: " + why); process.exit(1); };
const [pointer, signature, keyFile] = process.argv.slice(1);
const bytes = readFileSync(pointer);
let p;
try { p = JSON.parse(bytes); } catch { fail("the pointer is not JSON"); }
const keys = JSON.parse(readFileSync(keyFile, "utf8")).keys;
const key = keys.find((k) => k.keyId === p?.keyId);
if (!key) fail("unknown key " + p?.keyId + "; update the pack or am on this computer first");
let valid = false;
try {
  valid = verify(null, bytes, createPublicKey(key.publicKey),
    Buffer.from(readFileSync(signature, "utf8").trim(), "base64"));
} catch {}
if (!valid) fail("the signature does not match");
const repository = "https://github.com/automagik-dev/automagik";
const version = typeof p.version === "string" && /^3\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(p.version);
const t = p.tarball ?? {};
if (p.schemaVersion !== 1 || p.publisher !== "automagik" || p.part !== "automagik.am"
    || p.repository !== repository || !version || p.tag !== "v" + p.version) fail("invalid am pointer");
if (!Number.isSafeInteger(p.sequence) || p.sequence !== Number(version[1]) * 10000 + Number(version[2])) fail("invalid sequence");
if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit)) fail("invalid commit");
if (t.name !== "automagik-am-" + p.version + ".tgz"
    || t.url !== repository + "/releases/download/" + p.tag + "/" + t.name
    || typeof t.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(t.sha256)
    || !Number.isSafeInteger(t.size) || t.size <= 0) fail("invalid am tarball in the pointer");
console.log(p.version, t.url, t.sha256, t.size, p.sequence);
`;

export const PROBE_JS = `const VERSION = ${VERSION}, PENDING = ${JSON.stringify(PENDING)};\n`
  + [sequenceOf, packEntries, recordSequence, recordSlot, recordAt, storeProblem, sameRealPath, installState, liveInstallLock].join("\n") + String.raw`
const fs = require("node:fs"), paths = require("node:path");
const { HOME: home, AM_HOME, HERDR_APP_HOME } = process.env;
if (!paths.isAbsolute(home ?? "")) throw new Error("the exec user gave no absolute HOME");
const amHome = paths.resolve(AM_HOME || paths.join(home, ".automagik"));
const appHome = paths.resolve(HERDR_APP_HOME || paths.join(home, ".config", "herdr-app"));
const state = installState({ home, amHome, appHome }, fs, paths);
delete state.record.text;
const lock = paths.join(amHome, "parts", "automagik.am", ".lock");
let busy = null;
if (!state.unsafeStore) try {
  const { mtimeMs } = fs.lstatSync(lock);
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch {}
  busy = liveInstallLock(owner, mtimeMs);
} catch {}
let auto = true;
if (!state.unsafeStore) try { auto = fs.readFileSync(paths.join(amHome, "linked-update"), "utf8").split("\n")[0].trim() !== "off"; } catch {}
const [uname, node, bun, curl, tar, sha] = process.argv.slice(1);
console.log(JSON.stringify({ uid: process.getuid(), home, amHome, appHome, uname, node,
  bun: Boolean(bun), curl: Boolean(curl), tar: Boolean(tar), sha: Boolean(sha), auto, busy, ...state }));
`;

export const PROBE_SH = `
node_ok() {
  [ -x "$1" ] || return 1
  v=$("$1" --version </dev/null 2>/dev/null) || return 1
  v=\${v#v}; major=\${v%%.*}; v=\${v#*.}; minor=\${v%%.*}; patch=\${v#*.}; patch=\${patch%%[!0-9]*}
  case $major in ''|*[!0-9]*) return 1 ;; esac
  case $minor in ''|*[!0-9]*) return 1 ;; esac
  patch=\${patch:-0}
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 7 ]; }
}
node=
c=$(command -v node) && node_ok "$c" && node=$c
if [ -z "$node" ]; then
  for c in "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do
    node_ok "$c" || continue
    if [ -z "$node" ] || [ "$major" -gt "$best_major" ] || { [ "$major" -eq "$best_major" ] &&
      { [ "$minor" -gt "$best_minor" ] || { [ "$minor" -eq "$best_minor" ] && [ "$patch" -gt "$best_patch" ]; }; }; }; then
      node=$c best_major=$major best_minor=$minor best_patch=$patch
    fi
  done
fi
if [ -z "$node" ]; then
  rest=$1
  while [ -n "$rest" ]; do
    dir=\${rest%%:*}
    case $rest in *:*) rest=\${rest#*:} ;; *) rest= ;; esac
    if [ -n "$dir" ] && node_ok "$dir/node"; then node=$dir/node; break; fi
  done
fi
bun=
for c in "$(command -v bun)" "$HOME/.bun/bin/bun"; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" --version </dev/null >/dev/null 2>&1; then bun=$c; break; fi
done
if [ -z "$node" ]; then
  if [ -n "$bun" ]; then echo '{"refuse":"bun-only"}'; else echo '{"refuse":"no-node"}'; fi
  exit 0
fi
case $node in /*) ;; *) node=$PWD/$node ;; esac
uname=$(uname -sm) || exit 1
exec "$node" -e "$2" "$uname" "$node" "$bun" "$(command -v curl)" "$(command -v tar)" "$(command -v sha256sum || command -v shasum)"
`;

const ARCHIVE_JS = String.raw`
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const [archive, sha, size, namesFile, entriesFile] = process.argv.slice(1);
const bytes = fs.readFileSync(archive);
const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const fail = (why) => { console.error(why); process.exit(1); };
if (createHash("sha256").update(bytes).digest("hex") !== sha) fail("sha256 does not match the pointer");
if (bytes.length !== Number(size)) fail("size does not match the pointer");
if (namesFile) {
  const names = lines(namesFile), entries = lines(entriesFile);
  if (!names.length || names.length !== entries.length || names.some((name, i) => name.startsWith("/")
      || name.split("/").includes("..") || !/^[d-]/.test(entries[i])
      || entries[i].includes(" link to ") || entries[i].includes(" -> "))) fail("unsafe tarball entries");
}
`;

export const BOOTSTRAP_SH = `set -eu
umask 077
node=$1
base=https://github.com/automagik-dev/automagik/releases/download/am-lane
fetch() { curl -fsSL --proto =https --proto-redir =https -o "$1" "$2"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
fetch "$tmp/am.json" "$base/am.json" || { echo 'am-lane pointer is missing or could not be fetched' >&2; exit 20; }
fetch "$tmp/am.json.sig" "$base/am.json.sig" || { echo 'am-lane signature is missing or could not be fetched' >&2; exit 20; }
printf '%s' "$3" > "$tmp/keys.json"
"$node" -e "$2" "$tmp/am.json" "$tmp/am.json.sig" "$tmp/keys.json" > "$tmp/verified" || exit 20
read -r version url sha size sequence < "$tmp/verified"
if [ "$5" = compare ]; then printf '{"ok":true,"offered":"%s"}\\n' "$version"; exit 0; fi
if [ "$4" != - ] && [ "$sequence" -lt "$4" ]; then
  echo "am-lane sequence $sequence is older than the newest this machine took ($4)" >&2; exit 20
fi
archive=$tmp/automagik-am-$version.tgz
fetch "$archive" "$url" || exit 20
"$node" -e '${ARCHIVE_JS}' "$archive" "$sha" "$size" || exit 20
tar -tzf "$archive" > "$tmp/names" || exit 20
tar -tvzf "$archive" > "$tmp/entries" || exit 20
"$node" -e '${ARCHIVE_JS}' "$archive" "$sha" "$size" "$tmp/names" "$tmp/entries" || exit 20
mkdir "$tmp/extract"
tar -xzf "$archive" -C "$tmp/extract" || exit 20
[ "$(cat "$tmp/extract/VERSION")" = "$version" ] || { echo 'archive VERSION disagrees with am-lane' >&2; exit 20; }
export PATH="\${node%/*}:$PATH"
status=0
"$node" "$tmp/extract/bin/am.mjs" self install --signed "$tmp" --json || status=$?
if [ "$status" = 2 ]; then
  echo "am-lane names am $version; the minimum required is a release with am self install --signed (RFC 0012 delivery 9a)" >&2
  exit 20
fi
exit "$status"
`;

export const APP_HOME_SH = `set -eu
fail() { printf '%s\\n' "$* (checked as the hc exec user)" >&2; exit 20; }
uid=$(id -u)
printf '%s\\n%s\\n' "$uid" "$HOME"
case $1 in /*) ;; *) fail "No absolute app home: $1" ;; esac
rest=\${1#/}
path=
while [ -n "$rest" ]; do
  part=\${rest%%/*}
  case $rest in */*) rest=\${rest#*/} ;; *) rest= ;; esac
  case $part in ''|.) continue ;; ..) fail "App home contains ..: $1" ;; esac
  path=$path/$part
  [ ! -L "$path" ] || fail "$path is a link"
  if [ -n "$rest" ]; then
    [ -d "$path" ] && [ -x "$path" ] || fail "$path is not a searchable folder"
  fi
done
[ -n "$path" ] || fail "No usable app home: $1"
state=there
if [ ! -d "$path" ]; then
  [ ! -e "$path" ] || fail "$path is not a folder"
  mkdir -m 700 "$path" || fail "Could not make $path"
  state=made
fi
owner=$(stat -c %u "$path" 2>/dev/null || stat -f %u "$path")
[ "$owner" = "$uid" ] || fail "$path belongs to uid $owner, expected $uid"
[ -w "$path" ] && [ -x "$path" ] || fail "$path is not writable and searchable"
printf '%s %s\\n' "$state" "$path"
`;

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const last = (text) => String(text ?? "").trim().split("\n").pop();
const notSent = new Set(["machine_unknown", "needs_update", "invalid_params"]);
const reason = (r) => json(r.stderr)?.error?.message || String(r.stderr ?? "").trim().split("\n")[0] || last(r.stdout) || `exit ${r.code}`;
const connectionLost = (r) => r.code === -1 && !notSent.has(json(r.stderr)?.error?.kind);
const failureStates = new Set(["broken", "busy", "refused"]);
const refuse = (why) => { throw Object.assign(new Error(why), { state: "refused" }); };

export async function selectMachine(list, name, expected) {
  if (!MACHINE_NAME.test(name)) refuse(`invalid machine name ${name}`);
  const r = await list();
  const rows = json(r.stdout)?.machines;
  const parsed = machineList(r, MACHINE_NAME);
  if (!Array.isArray(rows) || !parsed) {
    const lost = r.killed || json(r.stderr)?.error?.kind === "unavailable";
    throw Object.assign(new Error("could not read hc machine ls"), { connectionLost: lost });
  }
  const named = rows.filter((m) => m?.name === name);
  if (named.length > 1) refuse("the machine name is ambiguous");
  if (!named.length) refuse("no such linked machine");
  if (named[0].temporary === true) refuse("the machine is temporary");
  const found = parsed.list.find((m) => m.name === name);
  if (!found) throw new Error("hc machine ls did not give a valid core id and connection state");
  if (expected !== undefined && found.id !== expected) refuse(`core changed from ${expected} to ${found.id}`);
  if (!found.connected) throw Object.assign(new Error("the machine is disconnected"), { core: found.id, connectionLost: true });
  return found.id;
}

async function probe(run, machine, runtimeDirs) {
  let r;
  try { r = await run(["sh", "-c", PROBE_SH, "sh", runtimeDirs, PROBE_JS], { on: machine, timeout: 30 }); }
  catch (e) { throw Object.assign(new Error(e.message), { connectionLost: true }); }
  if (r.code !== 0) throw Object.assign(new Error(reason(r)), { connectionLost: connectionLost(r) });
  const p = json(r.stdout);
  if (p?.refuse === "bun-only") refuse("only Bun is available; the bootstrap needs Node 22.7 or later");
  if (p?.refuse === "no-node") refuse("Node 22.7 or later was not found");
  if (!p?.record || !p.node?.startsWith("/") || !Number.isInteger(p.uid)) throw new Error("unexpected am probe answer");
  return p;
}

const supported = new Set(["Linux x86_64", "Linux aarch64", "Darwin arm64"]);
const readKeys = () => readFileSync(new URL("./am-keys.json", import.meta.url), "utf8");

export async function installOn(run, machine, result, { recheck, check, runtimeDirs = "/opt/homebrew/bin:/usr/local/bin" }) {
  const p = await probe(run, machine, runtimeDirs);
  result.user = { uid: p.uid, home: p.home };
  const before = classify(p);
  if (p.auto === false) result.auto = false;
  if (!supported.has(p.uname)) refuse(`${p.uname} is not a supported target`);
  const missing = [["curl", p.curl], ["tar", p.tar], ["sha256sum or shasum", p.sha]].filter(([, found]) => !found);
  if (missing.length) refuse(`missing ${missing.map(([name]) => name).join(", ")}`);
  if (check || before.action === "refuse") return { state: before.state, version: before.version, why: before.why };
  const argv = ["sh", "-c", BOOTSTRAP_SH, "sh", p.node, VERIFY_JS, readKeys(), String(p.record.seen ?? "-"), before.action];
  if (argv.reduce((n, word) => n + Buffer.byteLength(word) + 1, 0) > REMOTE_TEXT_MAX) refuse("the bootstrap exceeds 96 KiB of arguments");
  await recheck();
  let r;
  try { r = await run(argv, { on: machine, timeout: 600 }); }
  catch (e) { return { state: before.action === "install" ? "unknown" : "failed", why: e.message }; }
  if (r.code === -1) {
    return { state: before.action === "install" && connectionLost(r) ? "unknown" : "failed", why: reason(r) };
  }
  if (r.code === 20) return { state: "refused", why: reason(r) };
  const answer = json(r.stdout);
  if (r.code !== 0 || answer?.ok !== true) {
    return { state: failureStates.has(answer?.state) ? answer.state : "failed", why: answer?.detail ?? reason(r) };
  }
  let out;
  if (before.action === "compare") {
    const { offered } = answer;
    if (typeof offered !== "string" || !VERSION.test(offered)) throw new Error("unexpected answer from the am-lane check");
    out = { state: offered === before.version ? "current" : "installed", version: before.version };
  } else {
    if (!["installed", "current"].includes(answer.state) || typeof answer.version !== "string") throw new Error("unexpected signed install answer");
    out = { state: answer.state, version: answer.version, ...(answer.cleanup ? { why: answer.cleanup } : {}) };
  }
  let readBack;
  try {
    await recheck();
    readBack = await probe(run, machine, runtimeDirs);
  } catch (e) {
    if (e.connectionLost) return { state: "unknown", why: e.message };
    throw e;
  }
  const after = classify(readBack);
  if (after.state !== "installed" || after.version !== out.version) throw new Error(`read-back did not find am ${out.version}: ${after.why ?? after.state}`);
  return out;
}

export async function appHomeOn(run, machine, dir, result) {
  const r = await run(["sh", "-c", APP_HOME_SH, "sh", dir], { on: machine, timeout: 30 });
  const [uid, home, answer] = r.stdout.trimEnd().split("\n");
  if (/^\d+$/.test(uid) && home?.startsWith("/")) result.user = { uid: Number(uid), home };
  if (r.code === 20) refuse(reason(r));
  if (r.code !== 0) throw new Error(reason(r));
  const [, state, path] = /^(made|there) (\/[^\n]+)$/.exec(answer) ?? [];
  if (!state) throw new Error("unexpected app home answer");
  return { state, why: path };
}
