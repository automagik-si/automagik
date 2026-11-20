# Upgrading an installed Automagik host

`scripts/upgrade.ts` upgrades an **installed** Automagik instance to a published release, with
one command, without hand-editing a version or copying steps out of a stale runbook. It is
version-agnostic: the target is whatever `releases/latest` says today (or `--to <tag>`).

This document is the repeatable form of the one-off `3.41.0 -> 3.48.0` runbook. It targets a
host laid out like `cadu` (the production instance): the DSH runtime under
`~/prod/automagik/releases/<version>/runtime`, the `runtime` symlink beside it, the `web` DSH
profile under `~/.automagik/web/dsh/profiles/web`, and the `automagik-web.service` system unit.

> An upgrade is a **host** change, not a repository change. Updating this checkout does nothing
> to an installed instance: the instance consumes release artifacts only.

## TL;DR

```sh
# from an SSH shell on the host, as the service user
cd ~/workspace/repos/automagik
bun scripts/upgrade.ts --check      # read-only: current vs latest, signature, tarballs, engines
bun scripts/upgrade.ts --dry-run    # print every step and command; change nothing
bun scripts/upgrade.ts              # upgrade to the latest release
```

The last command stops `automagik-web.service`, backfills `releases/<version>/`, re-adds the
release tarballs through `dsh plugin`, restarts the unit and smoke-checks it. It prints exactly
one final `RESULT:` line and rolls back automatically on any failure.

```sh
bun scripts/upgrade.ts --to v3.49.0   # an explicit release (still verifies everything)
```

## Why a Bun/TypeScript script, not a shell script

`scripts/` is TypeScript run by Bun (`AGENTS.md`: "Bun for the repository's tooling (`scripts/`,
`bun test`)"). `scripts/upgrade.ts` sits beside `lane.ts`, `version.ts` and `release-plugins.ts`
and is covered by `bun test scripts` (`scripts/upgrade.test.ts`). Keeping it in TypeScript reuses
the repository's lane verification (`plugin-lane/keys.json`, the same keys `bun scripts/lane.ts
verify` uses) and lets the hand-edit checks be unit-tested instead of re-implementing ed25519 and
YAML in shell. The host has Bun 1.3.x; the script needs Bun >= 1.2.21 (`Bun.YAML`,
`Bun.semver`), `node`, `gh` and passwordless `sudo`.

## What an upgrade is

A release carries plugin tarballs and their manifests, not a full host image:

| Piece | Where it lives | What this script does |
|---|---|---|
| DSH runtime | `releases/<version>/runtime`, symlinked from `runtime` | stages it and swaps the symlink atomically |
| Signed lane | `lane.json` + `lane.json.sig` on the release | verifies the ed25519 signature with `plugin-lane/keys.json` |
| Plugin tarballs | `automagik-*-<version>.tgz` on the release | verifies them, re-adds the ones this profile installs |
| Digests | `PLUGINS.SHA256SUMS`, `plugins.json` | checks every downloaded tarball and the lane's `sha256`/`integrity` |
| Plugin pins/config | `profiles/web/package.json`, `pnpm-lock.yaml`, `cordis.patch.yml` | backs them up, mutates them only through DSH, and preserves hand edits |

The `cordis.yml` composition is DSH's: it is regenerated from the bundles and
`cordis.patch.yml` on every boot. Hand edits belong in `cordis.patch.yml` (the user layer), never
in `cordis.yml`. See [Configuration layers](#configuration-layers-and-cordisyml) below.

## Prerequisites

- Run as the service user, from an SSH shell — **not** from an agent inside the Web
  GUI. Restarting `automagik-web` stops the whole unit cgroup, including GUI sessions and agent
  jobs running inside it.
- `gh` authenticated (`gh auth status`), `node`, `curl`, `tar`, `systemctl`, passwordless `sudo`.
- At least 2 GiB free under `~/prod/automagik` (a runtime + profile backup is written).
- The checkout has `plugin-lane/keys.json` (always committed); `bun install` is only needed for
  `bun test`, not for `bun scripts/upgrade.ts --check` / the upgrade itself.
- `DSH_HOME` for this host is `~/.automagik/web/dsh` (the unit sets it).

All paths can be overridden with `AUTOMAGIK_UPGRADE_*` environment variables (`HOME`, `DSH_HOME`,
`PROFILE`, `SERVICE`, `PUBLIC_URL`, `HEALTH_URL`, `BACKUP_ROOT`); the defaults are the host
layout above. The prefix is `AUTOMAGIK_UPGRADE_*` on purpose: the unit already sets
`AUTOMAGIK_HOME=$HOME/.automagik` for the app, which is a different directory.

## What the script does

### 1. Resolve the target

The latest release comes from the GitHub API, never a hardcoded version:

```sh
gh api repos/automagik-si/automagik/releases/latest --jq .tag_name
```

`--to <tag>` (with or without the `v`) overrides it. A prerelease target is refused.

### 2. Verify the release before touching the host

- The lane's ed25519 signature over the exact `lane.json` bytes, against
  `plugin-lane/keys.json` (the same check as `bun scripts/lane.ts verify`).
- Every downloaded tarball against its line in `PLUGINS.SHA256SUMS`.
- The lane's per-plugin `sha256` and `sha512` `integrity` against the download, and against
  `plugins.json`.
- `engines.dsh` against the installed DSH version (`Bun.semver`). A release that needs a newer
  DSH fails loudly here instead of booting a broken profile.

### 3. Back up before touching anything

A timestamped, root-owned directory under `~/prod/automagik/backups/`:

```
upgrade-<version>-<UTC timestamp>/
  profile/                       package.json, pnpm-lock.yaml, cordis.patch.yml, cordis.yml
  profile-before-<from>.tgz      the whole profile minus node_modules
  runtime-before-<from>.tgz      the live runtime tree
  installation-receipt.json      when present
  upgrade-receipt-before.json    when present
  baseline.txt                   hashes, versions, symlink target, MainPID, dependencies, bundles
  cordis-after-regeneration.yml  the composed tree that regeneration produced (on success)
```

Backups and old `releases/<version>/` directories are **never deleted** by this or any later
upgrade.

### 4. Stop the unit

```sh
sudo systemctl stop automagik-web
```

`KillMode=control-group` and `TimeoutStopSec=45`: everything in the unit's cgroup (GUI sessions,
agent jobs) stops. This is the start of the downtime.

### 5. Stage the runtime and swap the symlink atomically

- If `releases/<version>/runtime` already exists and is a valid DSH tree, it is reused.
- If the release ships a runtime asset (`*runtime*.tgz`, `*.tar.gz`, `*.tar.zst`), it is
  downloaded, checked against `SHA256SUMS` when present, and extracted.
- Otherwise the live runtime is carried forward unchanged into `releases/<version>/runtime` —
  which is how a plugin-only release like `3.49.0` is installed.
- The new tree is checked to be a real `node_modules/@deepseek-ai/dsh` runtime.
- `runtime` is repointed with a fresh temp symlink and `mv -T`, so it is never half-updated:

  ```sh
  ln -s .../releases/<version>/runtime .../.runtime-next-<stamp>
  sudo mv -T .../.runtime-next-<stamp> .../runtime
  ```

A DSH version bump (a runtime artifact the release does not carry) is out of scope today: the
engines check refuses a release the installed DSH cannot run.

### 6. Re-add every release tarball this profile installs

```sh
DSH_HOME=~/.automagik/web/dsh node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile web add file:.../releases/<version>/dist/<tarball>.tgz
```

One `dsh plugin … add` per release tarball the profile already depends on, then the script
verifies each installed `node_modules/<package>/package.json` version and the `package.json`
pin. Tarballs for plugins this profile does **not** install (the Unfold plugins, for example)
are left alone, as are git-pinned plugins (`genie-dsh`, `omni-*`,
`dsh-subscriptions`) and local `link:` checkouts. Nothing is installed "just because the
release has it".

### 7. Regenerate `cordis.yml` and prove no hand edit was lost

`cordis.yml` is regenerated with DSH's own composition:

```sh
node <runtime>/.../bin.js --profile web --dump-config > .../profiles/web/cordis.yml
```

The result is parsed and compared, field by field, against every entry in `cordis.patch.yml`.
Any lost entry, changed value, dropped `insert`, or reordered array fails the upgrade loudly
before the service is allowed back up. The script also names the hand edit this host depends on:
`- id: dsh-subscriptions` / `disabled: true` must still be in `cordis.patch.yml` and must still
be disabled in the composed tree. DSH resets `cordis.yml` to its canonical empty-root stub on
every boot; the durable hand edits are the bytes of `cordis.patch.yml`, which the script records
before and re-checks after (it must be byte-identical).

### 8. Start and smoke-check

The script restarts the unit and fails the upgrade unless:

- `systemctl is-active automagik-web` is `active` and the `MainPID` changed;
- `http://127.0.0.1:8080/` answers (the auth fence: `401` unauthenticated, `200` with a browser
  cookie — both count as healthy; `000`/5xx/exception does not);
- `https://ia.escoladofluxo.com/` answers through Caddy (`200`/`401`; TLS and the reverse proxy
  are up);
- every re-added package reports the target version on disk and in the profile pin;
- every installed plugin that exposes a client bundle has one and is enabled in the composed
  tree (the CLI proxy for "its settings section registers");
- the composed tree still disables `dsh-subscriptions`.

The **visual** check — the Bot team renders, the Settings sidebar lists its sections, About DS
Bot shows the new version, one chat turn works — still needs the owner's browser session. The
CLI cannot authenticate, and the script does not mint a login URL.

### 9. Record the upgrade

`releases/<version>/upgrade-receipt.json` is written in the same shape as the earlier receipts:
`target`, `from`, `dsh_target`, `source_release`, `release_dir`, `backup_dir`, `app_pid_before`,
`app_pid_after`, `verification`, `upgraded_at`.

## Downtime

- `stop` → `start` is the only downtime: roughly **1–3 minutes** on this host (plugin `pnpm add`
  plus the restart). The GUI shows a connection error until the unit is active again.
- A restart ends every session inside the unit's cgroup and generates a fresh first-login URL;
  existing signed browser cookies survive, so the owner's browser does not need a new login.
- Run the script from an SSH shell. A detachment trick does not save an in-GUI agent: the unit
  kills its whole cgroup, and `setsid` does not escape it. If you must drive it from a script,
  run that script from a transient unit outside `automagik-web.service`.

## In-app updates: the supervisor

The supervisor starts the web profile as its child. On an update request it verifies the signed
plugin lane, stages the installed Automagik plugin set through DSH, and switches the profile's
installer files with the child stopped. It then starts the child with the same DSH command.
Delivery 5a provides the supervisor. The setting and the “Update now” action arrive in 5b.

### One-time host setup

As the service user, run `install-copy` with the unit's Node executable and DSH home. For example,
on a host whose service user is `automagik`:

```sh
/usr/bin/node /home/automagik/.automagik/web/dsh/profiles/web/node_modules/@automagik/bots-dsh/src/host/supervisor/main.js \
  install-copy --dsh-home /home/automagik/.automagik/web/dsh --profile web
```

Use the launcher path printed by `install-copy`. With your usual host administration tools, edit
the unit's `ExecStart` to run the launcher with the same DSH home and profile. Put the unit's
existing DSH command and every argument after `--`. Keep the unit's existing environment, user,
working directory and stop timeout. Apply the unit edit and restart it with your usual tools.

```ini
ExecStart=/home/automagik/.automagik/web/dsh/update/web/supervisor/launcher.sh --dsh-home /home/automagik/.automagik/web/dsh --profile web -- /usr/bin/node /home/automagik/prod/automagik/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 8080
```

The launcher loads and self-checks `current` and then tries `kept` if the check fails. If both
copies fail, it runs the original DSH command directly and the update capability is unavailable.

### Store and state

The store is `$DSH_HOME/update/web/`, beside the live profile at `$DSH_HOME/profiles/web/`.
Both directories need to be on the same filesystem. A profile `.npmrc` can name the package
registry with `registry=`. Additional settings in that file make the update check refuse the
profile.

| Path in the store | Contents |
|---|---|
| `supervisor/launcher.sh`, `supervisor/current/`, `supervisor/kept/` | The fixed launcher and the two self-checked code copies |
| `update.lock`, `supervisor.json` | Supervisor ownership, the current boot ID and the current or most recent run ID |
| `request.json`, `check.json` | A pending one-use request and the most recent Settings check |
| `state.json`, `current.json` | Update progress and verdict, and the live version, kept version and last accepted lane sequence |
| `stage-<runId>/`, `versions/<version>/` | Temporary install and source files, and the previous installer files and data snapshot |

Read `state.json` with `jq . "$DSH_HOME/update/web/state.json"` or a text viewer. Its
`phase`, `reason`, `from`, `to` and `updatedAt` show the last step and verdict.
`requestId` identifies the request, and `runId` and `bootId` link the verdict to
`supervisor.json`. During a switch, `journal.keep` identifies the recovery directory,
`journal.done` lists completed steps and `journal.pending` names the step that may have been
interrupted. `healthy` means the new child's HTTP port responded and the installed versions
matched. `notUpdated` means the previous installation is serving or was left running.

### Rename back after `manualRecovery`

Delivery 6 will automate rollback. Until then, stop the unit with your usual host tools and
confirm the supervisor and DSH have exited. Read `state.json` and use the directory named by
`journal.keep`. If the journal is incomplete, use `done`, `pending` and the files on disk to
locate each original before moving anything. Use the previous host backup if the kept originals
are missing.

1. Set aside the trial's `node_modules/` and `pnpm-lock.yaml` in a new directory beside the
   profile. Rename the kept `node_modules/` and `pnpm-lock.yaml` back into the profile.
2. Rename the kept `vendor/*.tgz` back into the live profile's `vendor/automagik-update/`.
   The old lockfile may also refer to archives that are already in place. Leave those in place.
3. In the live `package.json`, replace only the dependency keys listed in the kept
   `entries.json` under `dependencies`. Write the merged file through a temporary sibling,
   then rename it over the live file.
4. Read the kept `data.json`. If the trial wrote a higher format number at the Bots state
   path recorded there, set that trial file aside and restore a copy of `data/bots-state.json`
   at that path. This can undo a team change made during the trial. A file without a format
   field is format 0.
5. Set `state.json` aside with the trial files so the supervisor can boot again. If
   `current.json` lists the trial as live, set its `live` and `kept` fields to `null` while
   retaining `lastSequence`. Start the unit with your usual host tools and verify that the web
   profile and the previous plugin versions are serving.

A rename-back uses the saved module tree and tarballs, so it needs no dependency install. The
runtime, profile settings, sessions and model credentials stay in their existing locations.

## Rollback

Rollback is automatic. On any failure after the service was stopped the script:

1. stops the unit;
2. repoints `runtime` back to the recorded target with the same temp-symlink + `mv -T` swap;
3. restores `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml` and `cordis.yml` from the backup;
4. best-effort `dsh plugin --profile web install --frozen-lockfile --prod --ignore-scripts`;
5. restarts the unit and confirms it is active and answering;
6. prints `RESULT: FAILED …` with the backup path, or `RESULT: FAILED … rollback=INCOMPLETE`
   with the rollback error if even that failed.

The RESULT line at the end of every run is the single thing to grep:

```
RESULT: OK target=3.49.0 from=3.41.0 dsh=0.2.1-rc.4 backup=... downtime=...
RESULT: FAILED target=3.49.0 error=... rolled_back_to=3.41.0 backup=...
RESULT: FAILED target=3.49.0 error=... rollback=INCOMPLETE rollback_error=... backup=...
```

### Manual fallback (if the script itself cannot run)

The one-off runbook remains the reference; the short form:

```sh
export DSH_HOME="$HOME/.automagik/web/dsh"
export DSH_BIN="$HOME/prod/automagik/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 1. back up
STAMP=$(date -u +%Y%m%d-%H%M%S)
BK="$HOME/prod/automagik/backups/upgrade-<version>-$STAMP"
sudo mkdir -p "$BK"
sudo tar -C "$DSH_HOME" -czf "$BK/dsh-home-before.tgz" --exclude=profiles/web/node_modules .
sudo tar -C "$HOME/prod/automagik/runtime" -czf "$BK/runtime-before.tgz" .

# 2. download and verify
VER=3.49.0
REL="$HOME/prod/automagik/releases/$VER"
mkdir -p "$REL/dist" && cd "$REL/dist"
gh release download "v$VER" -R automagik-si/automagik -D . \
  --pattern 'plugins.json' --pattern 'PLUGINS.SHA256SUMS' \
  --pattern 'lane.json' --pattern 'lane.json.sig' \
  --pattern 'automagik-bots-dsh-*.tgz' --pattern 'automagik-welcome-dsh-*.tgz' \
  --pattern 'automagik-locale-pt-br-dsh-*.tgz'
sha256sum --ignore-missing -c PLUGINS.SHA256SUMS
(cd "$HOME/workspace/repos/automagik" && bun scripts/lane.ts verify "$REL/dist/lane.json" "$REL/dist/lane.json.sig")

# 3. stop, swap, install, regenerate, start
sudo systemctl stop automagik-web
cd "$HOME/workspace"
DSH_HOME=$DSH_HOME node "$DSH_BIN" plugin --profile web add \
  "file:$REL/dist/automagik-bots-dsh-$VER.tgz" \
  "file:$REL/dist/automagik-welcome-dsh-$VER.tgz" \
  "file:$REL/dist/automagik-locale-pt-br-dsh-$VER.tgz"
node "$DSH_BIN" --profile web --dump-config > "$DSH_HOME/profiles/web/cordis.yml"
# diff the composed tree against cordis.patch.yml before starting; the subscriptions disabled
# block must be present
sudo systemctl start automagik-web

# 4. smoke
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
curl -sS -o /dev/null -w '%{http_code}\n' https://ia.escoladofluxo.com/
jq -r '.version' "$DSH_HOME/profiles/web/node_modules/@automagik/bots-dsh/package.json"
```

Rollback manually: `sudo systemctl stop automagik-web`, restore the `runtime` symlink to the old
`releases/<from>/runtime`, untar the profile backup, run
`dsh plugin --profile web install --frozen-lockfile --prod --ignore-scripts`, start.

## Configuration layers and `cordis.yml`

At boot DSH composes, in order: each bundle in `package.json`'s `dsh.profile.bundles`, then
`profiles/web/cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays; and
it **always rewrites `cordis.yml` to its empty-root stub**. So:

- `cordis.patch.yml` is the hand-maintained user layer and the only durable place for an
  override (the `dsh-subscriptions` disable lives there).
- `cordis.yml` is generated. The upgrade regenerates it from the patched source and validates
  it, then DSH resets it again on the next boot. Do not hand-edit it.

## The disabled Subscriptions addon

`@goodandready/dsh-subscriptions` (`0.7.21-omni.1`) is installed in the `web` profile but
deliberately disabled: `cordis.patch.yml` has

```yaml
- id: dsh-subscriptions
  disabled: true
```

so its client module is never served and no `Subscriptions` item appears in the settings
sidebar. The reason recorded on 2026-10-26 was a 403 from its own same-origin fence for
authenticated remote browsers.

The upgrade **preserves this block verbatim** (it is one of the hand edits checked in step 7).
Do not remove it to "get the menu back" without fixing the fence first: on `3.49.0` the plugin is
still disabled for the same reason. Its `/dsh-subscriptions/status` and
`/dsh-subscriptions/analytics` routes are not mounted while disabled (they answer `404`), and if
the block were removed the plugin's fail-closed same-origin check would reject the browser
request again (`403`). The check reads `DSH_TRUSTED_HOSTS` (unset on this host) and
`ctx.webServer.url`, while DSH `0.2.1-rc.4` exposes `ctx.webServer.getOrigin()`, not `.url`; a
loopback proxy peer presenting the public `Host` therefore fails the checks before the
authenticated native cookie is considered.

What would actually make it loadable:

1. **Deployment fix:** add `Environment=DSH_TRUSTED_HOSTS=ia.escoladofluxo.com` to
   `automagik-web.service` (or set it in the unit's drop-in), restart, then remove the
   `dsh-subscriptions` disable block and restart again. The plugin's host check then passes and
   hands the request to DSH's own authenticated fence, which already trusts the authority via
   `--trusted-host`.
2. **Plugin fix (upstream):** read `ctx.webServer.getOrigin()` instead of `.url` and treat a
   `requestRejection` challenge/`401` distinctly from a policy `403`, then bump the
   `github:automagik-genie/dsh-subscriptions#…` pin to the fixed commit.
3. **A newer vetted plugin version:** none exists at the time of writing; the pinned
   `2eff034e…` is the tip of its Omni branch.

Any of the above is an explicit owner decision and is deliberately **not** part of this upgrade.

## What stays manual / unverified

- The authenticated browser smoke (Bot team renders, settings sections appear, one chat turn).
  The script checks the server side only; it never mints a login token.
- The Omni server pairing (`omni-sandbox.service`) is independent and never touched by this
  script. Updating the `omni-*` plugins is a separate decision.
- A DSH runtime version bump: the release does not ship a runtime artifact today, so the script
  carries the live runtime forward and refuses incompatible releases rather than inventing one.
- Re-enabling `dsh-subscriptions` (see above).

## Tests

`scripts/upgrade.test.ts` covers the pure logic: version/tag/backup naming, `PLUGINS.SHA256SUMS`
parsing, release-tarball selection, `deepSubset`, hand-edit loss detection (including the exact
`dsh-subscriptions` block), and the RESULT line. Run it with the repository gate:

```sh
bun install && bun run check     # versions, release tooling, market index, and scripts/*
```
