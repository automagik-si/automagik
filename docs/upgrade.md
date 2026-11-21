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
The owner starts an update from Settings > About with **Update now**, once in-app updates are turned on
(below).

### One-time host setup

As the service user, run `install-copy` with the unit's Node executable and DSH home. For example:

```sh
/usr/bin/node $HOME/.automagik/web/dsh/profiles/web/node_modules/@automagik/bots-dsh/src/host/supervisor/main.js \
  install-copy --dsh-home $HOME/.automagik/web/dsh --profile web
```

Use the launcher path printed by `install-copy`. With your usual host administration tools, edit
the unit's `ExecStart` to run the launcher with the same DSH home and profile. Put the unit's
existing DSH command and every argument after `--`. In the example, `%h` is systemd's specifier
for the service user's home folder. Keep the unit's existing environment, user, working directory
and stop timeout. Apply the unit edit and restart it with your usual tools.

```ini
ExecStart=%h/.automagik/web/dsh/update/web/supervisor/launcher.sh --dsh-home %h/.automagik/web/dsh --profile web -- /usr/bin/node %h/prod/automagik/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 8080
```

The launcher runs the original DSH command under the first copy that passes its self-check,
trying `current` before `kept`. If both checks fail, it can start DSH directly when the store has
no `state.json` or the state records a completed verdict with a valid journal in the expected direction.
The launcher redacts launch tokens from both output streams during direct startup.
An unreadable state, unfinished update or `manualRecovery` verdict stops startup and points to
`state.json`. Direct startup runs without the update capability.

### Turn on in-app updates

In-app updates are off by default. To offer **Update now**, set `selfUpdate: true` in the Bots plugin's
config through the profile's own `cordis.patch.yml` (see "Configuration layers" below), then restart the
service with your usual tools. A patch replaces the entry's whole `config`, so repeat the keys the
plugin's own patch sets (today `updateCheck: false`):

```yaml
- id: omni-ui
  config:
    updateCheck: false
    selfUpdate: true
```

**Update now** appears in Settings > About only when all of these hold: the setting is on, the
instance runs under the supervisor, a check from the last 10 minutes found a signed, checked update,
and the team lives at the home the service's environment names (`$AUTOMAGIK_BOTS_HOME`, else
`$AUTOMAGIK_HOME/bots`), because the supervisor snapshots that team file. Only the window that holds
the team can start it; it is not a Bot tool.

**Force update** runs a fresh signed check. With a capable supervisor, it can reinstall the same
signed version to replace missing or damaged files inside installed plugin trees whose manifests,
owner route and update contract still load. The check binds the confirmation to the selected signed
tarballs. A fresh capable install can reinstall after its first supervisor start. An existing
installation with an older copy needs two healthy updates that ship capable supervisor copies,
then a service restart. The executing copy, `current` and any `kept` copy must support reinstall.
If an already-open older page shows “Cannot update: the update check could not be completed.”
after Stop and update, reload the page and check again.

What the click does, in order:

1. New work is held: every step of every agent waits before its next model call or tool, and the
   composer says an update is running. A message sent meanwhile waits and is not lost.
2. The team's running turns (Bot chats and groups, tasks, DSH bots, automation runs) are noted as
   stopped by an update and stopped at once. A tool call already running finishes its current step.
3. The plugin writes `request.json` in the store. The supervisor takes it within a second.
4. The held work goes on after the supervisor's verdict: on `healthy` in the new version, on
   `rolledBack` in the restored version, and `notUpdated` in the unchanged one (in the same DSH
   process when the child was never stopped). The
   stopped turns are picked up with a note that an update stopped them, and an update's stop does not
   count toward the daily limit of restart resumes. On `manualRecovery` the work stays held and its
   notes stay on disk until the instance is recovered.

The hold also opens, with a warning in the log, when the supervisor does not answer the request
within about a minute (`request-unanswered`). If a running phase records no progress for 20 minutes,
the plugin warns and keeps work held. Restart the service to recover a supervisor that has stopped
progressing. A fresh boot with no live run of its own can pick up the saved work.

### Store and state

The store is `$DSH_HOME/update/web/`, beside the live profile at `$DSH_HOME/profiles/web/`.
Both directories need to be on the same filesystem. A profile `.npmrc` can name the package
registry with `registry=`. Additional settings in that file make the update check refuse the
profile. The supervisor reads the pnpm configuration before any package-manager probe and
runs the registry and write-path probes in staging. The check refuses a different effective
registry reported by the DSH plugin manager. The lockfile, modules and virtual store must stay
inside staging, and a shared store must be outside the live profile. The check rejects pnpm
configuration dependencies, configured hooks and a global virtual store. Staging and relinking
skip pnpm hooks and lifecycle scripts, and relinking and its compatibility repair run offline.
If the DSH profile lock times out, confirm its writer has exited before removing `package.json.lock`.

| Path in the store | Contents |
|---|---|
| `supervisor/launcher.sh`, `supervisor/current/`, `supervisor/kept/` | The fixed launcher and the two self-checked code copies. If a rotation displaces the executing copy, it stays in `supervisor/running/` until that supervisor exits. |
| `update.lock`, `supervisor.json` | Supervisor ownership, the current boot ID and the current or most recent run ID |
| `listener.json` | The current boot's listener eligibility, unknown until DSH announces and the supervisor verifies it |
| `request.json`, `check.json` | A pending one-use request and the most recent Settings check |
| `state.json`, `current.json` | Update progress and verdict, and the live version, kept version and last accepted lane sequence |
| `reinstall-refusal.json` | The precise cause of a reinstall refusal before staging, matched to its run |
| `stage-<runId>/`, `versions/<version>/` | Temporary install and source files, and the previous installer files and data snapshot |
| `reinstall/<runId>/`, `reinstall-trash/<runId>/` | Same-version recovery files and backups moved aside for removal after a durable verdict |
| `rollback-data/<runId>/` | The kept team snapshot and any trial team replaced by rollback |

Read `state.json` with `jq . "$DSH_HOME/update/web/state.json"` or a text viewer. Its
`phase`, `reason`, `from`, `to` and `updatedAt` show the last step and verdict.
`requestId` identifies the request, and `runId` and `bootId` link the verdict to
`supervisor.json`. During a switch, `journal.keep` identifies the recovery directory,
`journal.done` lists completed steps and `journal.pending` names the step that may have been
interrupted. `journal.commitCurrent` records that the candidate passed health and recovery can
finish committing `current.json`. `healthy` means the child passed these checks while work was held.

1. The child announces its listener and local sign-in returns a browser session cookie. The
   supervisor exchanges the in-memory launch token over direct HTTP and uses the cookie for the
   remaining checks. It uses the local listener's host and port, never follows redirects, and
   records only failure codes. With no public URL, the announcement must match the command. With
   `--public-url`, the supervisor needs a fixed port and the local listener must return DSH's
   unauthenticated response before it receives credentials. The response identifies DSH, while the
   port still comes from the command. `--tls-cert` and `--port 0 --public-url` give
   `listener-unknown` before the click.
2. The owner's status route confirms the expected plugin versions are active and admission is
   closed for this run. The version comes from the manifest resolved by the loader entry when it
   first reports active. Avoid changing plugins through DSH's own plugin manager during the trial.
3. The roster's health form checks the saved team without bootstrapping a new Bot, opening a
   Session or making a model call. If a team was snapshotted, the file on disk must have an integer
   revision at least as high as the snapshot's. The normal startup migration may update the team
   format and retitle existing Sessions.
4. The authenticated page contains the frontend mount element and inline module loader. Health
   checks the frontend module, the blocking bootstrap scripts listed in the DSH boot graph, and
   the application batch containing Bots. The JavaScript responses must complete and contain data.

The supervisor allows up to 60 seconds for sign-in and plugin status, then a further 60 seconds
for the roster and page. The previous version also passes health before it releases stopped work
after a failed relink or a refused switch. An older live Bots release without the update contract
gives work back with `notUpdated` and `profile-invalid` before any download. Upgrade that release
once by hand. A verdict that cannot be written durably makes the supervisor exit with an error.
The service manager stops and restarts the unit, and the next supervised start uses the last
durable state. If the directory fsync fails immediately after the verdict file is renamed, a
power loss can erase a verdict that the child already saw. The next start resumes from the journal.

### Automatic rollback

If the candidate fails health, the supervisor records `rollingBack` and stops the trial. It checks
every reverse move before touching the profile. If a candidate commit was interrupted, it restores
the previous `current.json`, then reverses the journaled renames and verifies the restored profile.
It uses the kept module tree, lockfile and archives. This needs no external connection, registry or
dependency store. If the service stops during trial health, the next start checks the candidate
again using the already linked profile if its saved team and installer inputs match. The supervisor
checks installer inputs again before committing. With a legacy journal missing the original plugin
versions, the supervisor verifies the manifest and lockfile by content and checks the active
plugins without version pins. A previous version without the update contract cannot be started
for rollback health.

Rollback restores a missing team file or a replacement that fails the snapshot revision check.
Malformed data without evidence of loss is left in place. For a team that passes the revision
check, a format newer than the previous version can read can require restoration.
The supervisor takes the team's writer lock and checks recorded hashes before writing. The original snapshot and any
replaced trial team are retained in `rollback-data/<runId>/`, even after a later update. If a team
change was saved during the trial window and the snapshot replaced the team, the trial copy
contains that change. Keep the directory as long as you need those files. Sessions, memory,
settings and keys remain available.

The previous child boots with work held and must pass the same health checks. A successful
`rolledBack` verdict records the failed trial check, trial times and team restore outcome. The
previous version and release sequence remain current. Interrupted launches of the previous child
have a budget of three attempts. An I/O error during a reverse move leaves rollback in progress
for the next supervised start to replay. A second such error or an observed previous-child failure
ends in `manualRecovery`,
with held work still on disk. The supervisor records the last step and the locations of
`node_modules/` and `pnpm-lock.yaml` and stops.

### Recover an unchanged or restored profile after `manualRecovery`

Stop the unit with your usual host tools and confirm the supervisor and DSH have exited.
If there is no journal, no installer-owned files moved. If the journal has `undo: true`, an empty
`done` list and `pending: null`, the original files are already in the live profile. Inspect the
logs and `rollback.previousFailed` in `state.json`. Check the team snapshot and any pending restore
as described below. After correcting the failure, set `state.json` aside, start the unit and verify
the previous profile answers locally.

### Rename back after `manualRecovery`

Stop the unit and confirm DSH and the supervisor have exited before moving files. Read
`state.json` for `rollback.step`, `rollback.location`, and the folders named by `journal.keep` and
`stage-<runId>`. Use `done`, `pending` and the actual files to identify each original if the
journal was interrupted. If the kept originals are missing, use the previous host backup.

```sh
jq '{phase, reason, rollback, keep: .journal.keep, done: .journal.done, pending: .journal.pending}' "$DSH_HOME/update/web/state.json"
```

If rollback stopped at `manifest` with no reverse renames, the candidate tree is still live.
Reconcile the trial-time plugin or installer-input change before restoring the old lockfile and
modules. Use DSH's plugin manager for the plugin change. Compare against `stage-<runId>/source`
for the source manifest and installer inputs before following the steps below.

1. For each of `node_modules/` and `pnpm-lock.yaml`, leave an already restored original in place.
   If the candidate occupies its live path, set that candidate file or tree aside. Rename the kept
   original back into the profile.
2. Rename the kept `vendor/*.tgz` into the live profile's `vendor/automagik-update/`. Leave the
   archives referenced by the original lockfile that are already in place.
3. Use the journaled `stage-<runId>/source/rollback.json` if available and its digest matches the
   rollback record. Otherwise merge only the lane dependency keys in kept `entries.json` and
   verify the result against `stage-<runId>/source/package.json`. Preserve DSH's profile metadata.
   Write the verified manifest through a temporary sibling and rename it into place.
4. If `journal.restore` exists and `journal.restored` is absent, verify that the live team's SHA-256
   equals `trialHash` and the snapshot's SHA-256 equals `snapshotHash`. A null `trialHash` means the
   recorded trial file was absent. Preserve any trial bytes before copying the matching snapshot
   to the recorded team path. If the hashes differ or a restore already completed, leave the
   current team in place and retain the saved copies.
5. If `current.json` names the trial, restore the recorded `priorCurrent` or remove the file if
   the record says it was originally absent. For a same-version reinstall, use the journal's
   `commitCurrent` or rollback's `restoreCurrent` flag because the version can identify both trees. Use the previous backup if the journal lacks this
   information. Set `state.json` aside with the trial files, start the unit and verify the
   previous version locally.

A 5b supervisor copy refuses an in-progress delivery 6 rollback. The fixed launcher allows its
bare fallback after a durable `rolledBack` verdict when both copies are broken. For an unfinished
rollback, restore a working delivery 6 supervisor copy or follow the manual steps above.

An unfinished reinstall needs a reinstall-capable supervisor for automatic recovery. If both
supervisor copies fail self-check, the fixed launcher can start DSH directly after a completed
`healthy`, `rolledBack` or `notUpdated` reinstall. For `switching` or `rollingBack`, restore a working
capable copy and restart. For `manualRecovery`, follow the manual steps above. A backup left in
`reinstall/<runId>/` may be needed for recovery, including when its journal has been set aside.
`reinstall-trash/` holds backups already released by a durable verdict and is cleared on a later
supervised start if cleanup was interrupted.

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
