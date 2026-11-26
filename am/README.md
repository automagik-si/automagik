# am

`am` is Automagik's one command ([RFC 0012](../docs/rfcs/0012-am-cli-and-parts.md)).
This guide installs am alone on a macOS or Linux host without the Herdr app (standalone,
or headless). It covers updates, rollback, uninstall, the agent skill and reporting a problem.

Requirements: macOS or Linux; Node 22.7 or later for the verification below; `curl`, `tar`, and `sha256sum`
or `shasum -a 256`. Once installed, the `am` command runs on Node 22.7+ or Bun (`bin/run.sh`).

## Install and verify

The am-lane pointer is `am.json` with `am.json.sig`: an Ed25519 signature over the exact bytes,
encoded as base64. Fetch the public keys in `am/am-keys.json` from the official repository's
`main` branch over HTTPS. `main` is the release branch: a key reaches it with the release that
ships it. Herdr's install line uses the same branch. Never fetch keys from the pointer's commit
or tag, which is not verified yet. Do not copy a key into notes: keys rotate in two phases
([RFC 0011](../docs/rfcs/0011-monorepo-parts-and-releases.md)).
The repository moved to automagik-si, and the block downloads from there. The signed pointer still
names https://github.com/automagik-dev/automagik as its `repository` and in its tarball URL (every
installed am checks that exact name), so the check below compares against it.

Paste the whole block into a shell. It works in a new empty folder and runs in a subshell, so it
stops at the first check that fails and leaves your shell as it was.

```sh
(
set -eu
work=$(mktemp -d) && cd "$work"
curl -fsSLO --proto =https --proto-redir =https https://github.com/automagik-si/automagik/releases/download/am-lane/am.json
curl -fsSLO --proto =https --proto-redir =https https://github.com/automagik-si/automagik/releases/download/am-lane/am.json.sig
curl -fsSL --proto =https --proto-redir =https -o am-keys.json https://raw.githubusercontent.com/automagik-si/automagik/main/am/am-keys.json
node -e '
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
' am.json am.json.sig am-keys.json > verified.txt
read -r V URL SHA SIZE SEQ < verified.txt
curl -fsSLO --proto =https --proto-redir =https "https://github.com/automagik-si/automagik/releases/download/v$V/automagik-am-$V.tgz"
archive="automagik-am-$V.tgz"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" > checksum.txt
else
  shasum -a 256 "$archive" > checksum.txt
fi
read -r actual rest < checksum.txt
test "$actual" = "$SHA" || { echo "sha256 does not match the pointer" >&2; exit 1; }
test "$(wc -c < "$archive" | tr -d "[:space:]")" = "$SIZE" || { echo "size does not match the pointer" >&2; exit 1; }
tar -tzf "$archive" > names.txt
tar -tvzf "$archive" > entries.txt
node -e '
const { readFileSync } = require("node:fs");
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const names = lines("names.txt"), entries = lines("entries.txt");
if (!names.length || names.length !== entries.length || names.some((name, i) =>
    name.startsWith("/") || name.split("/").includes("..")
    || !/^[d-]/.test(entries[i]) || entries[i].includes(" link to ")
    || entries[i].includes(" -> "))) {
  console.error("unsafe tarball entries"); process.exit(1);
}
'
mkdir "am-$V"
tar -xzf "$archive" -C "am-$V"
test "$(cat "am-$V/VERSION")" = "$V" || { echo "VERSION is not $V" >&2; exit 1; }
sh "am-$V/bin/am" self install
)
```

Put `~/.local/bin` on PATH. Run `am --version`, then `am self doctor` (required).
An `am` or `automagik-herdr` already in `~/.local/bin` that is a file or someone else's link
is left as it was, and self install still exits 0. Doctor reports it as `FAIL` with the fix.
Doctor also reports the briefing hook of the folder it runs in.

## What self install does

It copies the folder into `~/.automagik/parts/automagik.am/<version>/` (`AM_HOME` overrides
`~/.automagik`), links `current`, records it, and links `~/.local/bin/am` and
`~/.local/bin/automagik-herdr` (the old name, kept as an alias). On a host with Herdr's app home
(`~/.config/herdr-app` or `HERDR_APP_HOME`), it also links the briefing entry; otherwise it writes
nothing there. It installs, starts and restarts nothing else: no Herdr app, no herdr-core, no pane.

Without Herdr, am's own commands work, including `pocket`, `update`, `rollback`, `self`, `help` and `--version`.
Bot and worker commands need Herdr (its `hc` and herdr-core).
[Install Herdr and the pack](https://github.com/automagik-si/automagik/blob/dev/herdr/README.md#install).

## Install on one linked machine

Run `am machines install --machine M` to install am and its command links as the user
`hc exec` runs as on that machine. Use `--check` to read the machine’s install state.
The bootstrap needs Node 22.7 or later, curl, tar and a SHA-256 tool on M. It uses the
public keys shipped with the am or pack on this computer.

For a headless machine, `am machines install --machine M --project DIR --app-home`
creates the project’s app home. The parent must already exist. Start and Attach can then
write the Claude briefing hook in the project. The install records that it writes no stable
briefing entry. Updates and rollbacks keep that setting. If you roll back to an am from
before RFC 0012 delivery 9a, the next update through that older am drops the setting.

## Update and roll back

`am update --check automagik.am` checks for an update. `am update automagik.am` installs it:
am checks the signed pointer with its own `am-keys.json`, then the tarball's sha256 and size.
It refuses a pointer older than the newest this machine took and keeps the replaced copy.
`am update` alone also updates the herdr pack where one is installed.

`am rollback automagik.am` swaps back to the kept previous copy. With none, it says so and
exits 1. `am update` moves forward again. The bootstrap above is for a first install:
use `am update` to move an installed am. A hand-run self install or a rollback is not checked
against older versions.

## am pocket

Run `am pocket pair` in an interactive terminal on the computer your phone will connect to.
It installs `pocket.link`, starts its login service and shows a QR code and a link. Open
Automagik Pocket and scan the code, or paste the link. The code lasts 10 minutes by default
(`--minutes N` accepts 1–60). Ctrl-C cancels that code or reports when it will expire if
cancellation fails. The first install downloads about 25 MB from npm. Pocket Link needs Node.js
20.3 or newer and access to herdr-core on macOS or Linux.

If Herdr's Pocket Link dialog is running the bridge, turn it off there first. Update or remove
an older copy of the dialog before installing with am. Your computer's key and phone pairings live
in the state directory. To choose an existing directory on first install, use
`am pocket pair --state /absolute/path`.

| Command | What it does |
| --- | --- |
| `am pocket link status [--json]` | Shows the bridge and paired phones. |
| `am pocket link on` / `am pocket link off` | Starts or stops the login service. |
| `am pocket link forget ID` | Removes one phone. |
| `am pocket link reset` | Asks before changing this computer's key and unpairing every phone. |
| `am install pocket.link` / `am pocket link install` | Installs and starts the service without issuing a code. |
| `am doctor pocket.link` / `am pocket link doctor` | Checks the runtime, packages, service, state and dialog. |
| `am uninstall pocket.link` / `am pocket link uninstall` | Removes the service and managed files and keeps pairings. |
| `am pocket link uninstall --purge` | Removes the known bridge state files too. Purge cannot be undone. |

`am update` and `am rollback automagik.am` sync an installed Pocket Link from the selected am
release. An older am without Pocket Link keeps the installed copy. If Pocket Link fails to
update, am reports the two results independently and exits 1. The retained slot in
`${AM_HOME:-~/.automagik}/parts/pocket.link/current` carries the local part entries.

## Uninstall

`am self uninstall` hands the links back to the pack's CLI when the pack is installed,
otherwise removes them. The store stays. `am self uninstall --purge` also deletes
`~/.automagik/parts/automagik.am` (under `AM_HOME` if set).

## The agent skill

[The am skill](https://github.com/automagik-si/automagik/blob/dev/skills/am/SKILL.md) teaches a code agent the commands.
For Claude Code and Codex, run `npx skills add automagik-si/automagik --skill am -a claude-code -a codex`.
Add `-g` for every project. It reads the repository's default branch; the skills CLI needs Node 22.20+.
Codex reads `.agents/skills/am` (global `~/.agents/skills/am`); Claude Code reads
`.claude/skills/am` (global `~/.claude/skills/am`). Or copy `SKILL.md` by hand into one of those
folders. No release installs it. `npx skills update` refreshes it.

## Report a problem

If am does not support an operation or refuses unexpectedly, [open an issue](https://github.com/automagik-si/automagik/issues)
with the command, its output, `am --version` and `am self doctor --json`.
