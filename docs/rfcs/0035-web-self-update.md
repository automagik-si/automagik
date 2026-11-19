# RFC 0035: Web self-update in the app

| Field | Value |
|---|---|
| Status | Accepted (owner decisions 2026-11-18: Q2, Q6, Q7; technical decisions named below: Q1, Q3, Q4, Q5; mock approved and repaired in #1546; layout follow-up #1719; no delivery merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin only (3.N.P): `apps/bots-dsh` gains the UI and the host half; nothing here builds the desktop app |
| Created | 2026-11-18 |

## Summary

A web instance (a DSH profile served by a user service) has no update path inside the app today: each
update is done by hand — download the release plugins, check them against `PLUGINS.SHA256SUMS`, install
them into the profile, restart the service, check it came back. This RFC designs that path inside the
app, in the shape the owner approved (#1540): a nod at the bottom of the left menu when a newer
version exists; a full-screen modal that says what changes in plain words; then the steps live —
download, check the signature, install beside the current version, restart, health check; a success
screen; and an automatic rollback to the previous version, saying nothing was lost, when health fails.

Step 1, the clickable mock, was reviewed as #1541 and is approved; the repaired mock lands in #1546. Its layout follow-up is #1719. Everything below is what the real thing adds
around it, in small deliveries that each land on their own.

## Where the new version and its signature come from

The updater reads **only** the signed lane pointer, never the releases list:

1. **`lane.json` and `lane.json.sig`** from the rolling `plugin-lane` release (a prerelease, moved
   every release). It is ed25519-signed (`PLUGIN_LANE_KEY`); the public keys ship in the plugin
   (`plugin-lane/keys.json`, copied into the package). The updater verifies the signature **over the
   exact bytes** against those keys **before reading any field**. The verifier is the one the host
   upgrade already uses: `verifyLane` in `scripts/lane.ts`, called from `scripts/upgrade.ts:50,519-540`
   with `plugin-lane/keys.json`; the desktop app reads the same pointer (`apps/desktop/src/lane.js`).
   The web updater calls that module, never a second copy of the ed25519 code.
2. From the verified pointer it takes the entry for this plugin: `version`, `integrity` (sha512) and
   `sha256`, plus the release that carries the tarball (`automagik-bots-dsh-<version>.tgz` on that
   release).
3. It downloads the tarball from that release, checks the **sha256** (and, when available, the
   `integrity`) before unpacking, and refuses anything that does not match or that came unsigned.
4. It refuses a version that is **not higher** than the installed one: an update never downgrades, and
   a pointer that claims a lower version is a refusal, not a rollback.

The keys are never printed, never written into a log, and never returned by a route. A missing key, an
unknown `keyId` or a failed signature stops the update with a sentence the person can read. This is the
same trust chain the pack and the desktop app already use; the web updater adds no new key.

## Where the previous version is kept

The instance's plugins live in its DSH profile (`<profile>/node_modules/@automagik/...`, installed by
DSH). Before switching, the updater stores the version that is running:

- **Plain host**: the layout is the one the host upgrade proved (`scripts/upgrade.ts:9-17`,
  `docs/upgrade.md:28-46`): every version beside the running one — `releases/<version>/` with the
  `runtime` symlink as the pointer — but at the profile's scale: `<profile>/update/versions/<version>/`
  holds what the profile has for this plugin together with the installed `package.json`, and
  `<profile>/update/current.json` names the live version and the one kept beside it. The switch is the
  same atomic move (`temp symlink + mv -T`, `scripts/upgrade.ts:13`), so the rollback is a directory
  switch and never a re-download. At most two versions are kept; the third is removed only after a
  healthy run of the new one.
- **Where the instance lives in Arca (a server image)**: the image already follows the lane on start,
  offline and under a volume lock: `followImage`/`installOffline`/`reuseInstalledIndexes` in
  `server/profile-follow.mjs:33-76`, entered from `server/entrypoint.mjs:21`. So in that case the
  updater does **not** write a second installer: it materializes the payload the same way the image
  does and hands it to that path (the follow installs beside/over the profile under
  `server/volume-lock.mjs`), then asks Arca to restart the instance. On a plain host — the layout
  `docs/upgrade.md:6-8` describes — the profile-level store above is used instead. Arca adds two things
  the updater relies on: the restart is a container restart (the updater asks Arca, it does not kill
  the process itself), and the state file survives it because it is in the same writable home. If a host offers no writable home, the updater refuses
  and says why — it never falls back to installing in place with nothing kept.
- The data a person cares about — sessions, Bots, memory, secrets — is **not** part of a version and
  is never touched by an update or a rollback. That is what "nothing was lost" means here, and the
  rollback screen says it in those words.

## What counts as health

A version is healthy only when the served instance answers as itself again, checked from the updater,
not from the page that dropped:

1. the service is up: its own HTTP port answers;
2. the plugin is loaded and reports the **new version** (a small read-only `update-status` answer on
   the team's usual route, owner-only);
3. the team answers: the roster read (the endpoint the left bar already uses) returns without error;
4. one page load succeeds: the app's HTML and its client bundle are served.

Everything with a deadline (60 s for 1 and 2, a further 60 s for 3 and 4 after the restart). A model
call is **not** part of health: it costs money, it depends on a provider, and a provider outage is not
a broken update.

## How the modal continues after the restart that drops the chat

The restart kills the web socket under the open page, so the modal cannot be driven by the page:

- The update runs in a **supervisor** that outlives the restart: a small process started by the
  host half (or by the service's own restart wrapper), which does download → verify → install beside
  → restart → health (or rollback) and writes every step to `<profile>/update/state.json`.
- The page reads that state on load and on reconnect: if a state file names a run that is not
  finished, the app opens the same full-screen modal at the current step instead of the chat; if the
  run finished healthily, it opens the success screen once; if it rolled back, the rollback screen.
- A state file older than the run that is live is ignored (so a stale file never traps a person in a
  modal), and the person can always close it — the state stays readable in Settings.
- The supervisor is the only writer of the state file, and the page never drives the update itself.

## Automatic rollback

- Triggered by any health check failing or timing out, or by the supervisor dying before health.
- Steps: point `current.json` back at the kept version, restore its files into the profile, restart
  the same way, then run the same health checks against the **previous** version.
- If the previous version is healthy, the state records `rolledBack` with both versions, and the modal
  says the previous version came back and nothing was lost.
- If the previous version is also unhealthy, the state records `manualRecovery` with what was tried;
  the instance stops in a state the owner can see, and the message names the kept version and the
  command/hand-over Arca gives to bring it back. The updater never loops.
- A rollback never re-downloads: it restores from the kept directory.

## Trust, consent and what the updater never does

- Only the owner may start an update (the nod is in the owner's own window; the route is owner-only,
  like the rest of the team's routes), and a Bot, automation or tool can never call it.
- No update runs while the signature or the hash is unverified, or while there is no writable home to
  keep a version in.
- A failed verification or a downgrade stops before touching the profile.
- The updater does not read or write a person's sessions, secrets or Bot memory.

## Decided

The owner answered on 2026-11-18, on a card in Automagik's chat; the page here carries his words where
they are his, and marks the card options as choices, not sentences.

- **Q6 — a Bot in the middle of a task when the update is clicked.** The owner chose **"Para tudo na
  hora"** (his exact words). The click is already the permission, and running work is interrupted at
  once. He added, exact words: **"automagik reinicia os bots parados ao reinicio"** — after the restart,
  with the new version healthy, Automagik resumes by itself the Bots and the work that were stopped. The
  same holds after a rollback. The mechanics are in "Stopping and resuming work" below, and the modal
  says it in plain words before the click.
- **Q7 — which versions are offered.** The owner chose the card option **"Toda release assinada do
  canal (Recomendado)"**, described as "Cada 3.x.y que o canal de plugins publica, como já chega
  hoje". This is an option choice, not a sentence of his.
- **Q2 — who keeps the previous version.** The owner chose the card option **"A instância, e o Arca
  reinicia (Recomendado)"**, described as "Funciona igual no Arca e numa máquina comum; o Arca só faz
  o restart e fornece a pasta". An option choice, as designed in "Where the previous version is kept".

Decided by the chief of staff on 2026-11-18 — technical, not the owner's:

- **Q1** two versions are kept; the third is removed only after a healthy run of the new one.
- **Q3** health never calls a model. At most it is an option, off by default, and only if a real case
  needs it.
- **Q4** start with 60 s + 60 s, and adjust from a real measurement on the dev instance.
- **Q5** the supervisor is a **host plugin in this profile**: it already runs with the team, shares the
  profile's paths and secrets, starts and stops with the service, and survives a restart of the served
  app. A separate launcher would be a second thing to install, keep current and log, with no gain here.

## Stopping and resuming work

The owner's decision makes one new rule for the update and one for the rollback: work that runs is
interrupted at the click, and it comes back by itself once a healthy version is serving. The plan:

1. **Before stopping, write down what is running.** The supervisor writes `update/inflight.json`: each
   running turn (its session, its turn id, the Bot or agent it runs on, the last completed step and the
   step in flight), the queued turns in the same sessions, and the moment. This file is the record, not
   a guess: it is written before anything is stopped.
2. **Stop at once.** The host stops running turns with a short deadline (they are marked "stopped by
   an update", so the screens say why), then the restart proceeds. A tool call that cannot be stopped
   mid-flight is left to finish its current step before the restart; nothing new starts.
3. **After health, resume.** Once the new version is healthy, the supervisor resumes each recorded
   turn from its recorded step: a turn whose step was completed is not replayed, and a turn whose step
   was in flight is retried only when its effect is not known (the record says which). Queued turns
   start in their order.
4. **No repeated actions.** Resume is idempotent by construction: the record names the last completed
   action per turn, resuming continues after it, and a step whose completion cannot be proven is
   reported to the person instead of being run twice.
5. **After a rollback, the same path.** The previous version comes back, health passes, and the same
   `inflight.json` is resumed, so a rollback does not turn an interrupted task into a lost one.
6. **When resume is impossible** (the turn's session was deleted meanwhile, or the recorded turn no
   longer exists), the state says so in one line, and the person sees which work could not come back
   rather than a silent loss.

The modal states it before the click: "Work in progress stops when you click Update now, and it comes
back by itself once the update is done. Nothing is lost." The success and rollback screens say that the
stopped work came back.

## What exists already, and what we reuse ("O que já existe e o que reutilizamos")

There are already three update paths, and the owner wants one mechanism per problem, not two. Each
one keeps its problem; 0035 reuses what it can and never adds a second copy.

| exists | what it does | 0035 reuses | 0035 replaces | 0035 retires |
|---|---|---|---|---|
| `scripts/upgrade.ts` + `docs/upgrade.md` | upgrades an **installed host**: latest release or `--to`, verifies the signed lane and `PLUGINS.SHA256SUMS` (`scripts/upgrade.ts:516-540`, `verifyLane` from `scripts/lane.ts` at `:50`), backs up, stages `releases/<version>/` and swaps the `runtime` symlink atomically (`:9-17`), re-adds tarballs through `dsh plugin`, smoke-checks, rolls back on failure, prints one `RESULT:` (`docs/upgrade.md:28-46`) | the lane verifier (`verifyLane`, `plugin-lane/keys.json`), the integrity check of a tarball (`scripts/upgrade.ts:316`), the beside-the-running-version layout and the atomic switch, the automatic rollback and the one-line result | the manual "stop, backfill, re-add, restart, check" sequence **for plugins only**, from inside the app | nothing — it stays the way a host upgrades its runtime; 0035 never touches `runtime/` or the service unit |
| `server/profile-follow.mjs` | a server image's profile follows the lane on start: offline install from materialized archives, under a volume lock (`:33-76`, entered at `server/entrypoint.mjs:21`), with `compareRelease`/`validBuild`/ownership state (`server/profile-state.mjs`) | `followImage`/`installOffline`/`reuseInstalledIndexes` as **the** installer when the instance runs from a server image (Arca), its volume lock, and its state checks | 0035's own install step on that kind of host — the plan now hands the payload to this path instead of keeping a second installer (delivery 5, delivery 8) | nothing — it keeps updating image-hosted instances on start; 0035 only adds the in-app trigger and the visible state |
| the signed lane + `am` as loaders (`docs/rfcs/0011-*`, `0012-*`; `am/lib/lane.mjs`) | the lane is the signed pointer (`lane.json` + `lane.json.sig`, `plugin-lane/keys.json`); `am` is the one command that reads it and loads the parts | the lane as the only source of a version and its signature, and am's lane reader (`am/lib/lane.mjs`: `LANE_RELEASE`, the sequence and no-downgrade refusal) as the reference for the same rules | the manual download of release tarballs, checking them by hand against `PLUGINS.SHA256SUMS` | the instruction "update by hand" as the normal path on a web instance; am keeps loading a host, and 0035 adds the in-app trigger that uses the same lane |

The plan changes that follow from this comparison, all inside the deliveries table below:

- **Delivery 4 reuses the verifier**: it calls `scripts/lane.ts`'s `verifyLane` (as
  `scripts/upgrade.ts` does) and the same sha256/integrity check, instead of a new reader.
- **Delivery 5 reuses the installer on an image host**: on Arca it materializes the payload and calls
  `installOffline`/`followImage` (`server/profile-follow.mjs`); on a plain host it uses the
  profile-level store, which copies the upgrade's beside-the-version layout and atomic switch.
- **Delivery 6 reuses the rollback lesson**: the same trigger and the same automatic return that
  `scripts/upgrade.ts` proves (switch back to the kept version, restart, re-check, one result line).
- **Delivery 8 becomes smaller**: the Arca hand-over is just "materialize, follow, restart", because the
  installer already exists there.

## Deliveries (each one PR, plugin lane)

| # | What it adds | Visible to the person |
|---|---|---|
| 1 | The mock (approved; reviewed as #1541, lands in #1546) | the whole flow, with sample data, behind `?mock-1540` |
| 2 | This RFC | no |
| 3 | Host half: version store, `current.json`, `update-status`, and the "did the last run finish" read the page uses | no (no update yet) |
| 4 | Verified fetch: read `lane.json` through `verifyLane` (`scripts/lane.ts`, as `scripts/upgrade.ts:50` does), take this plugin's `version`/`sha256`, download the tarball, check it, and stop — a dry run that writes what it would do | a "check for updates" line in Settings, no install |
| 5 | Install beside and switch: on an image host hand the payload to `installOffline`/`followImage` (`server/profile-follow.mjs:47,76`); on a plain host unpack into `versions/<version>` and switch atomically as `scripts/upgrade.ts:13` does; write the state, restart through the supervisor | a real update behind a setting, off by default |
| 6 | Health and automatic rollback, as above | the rollback screen tells the truth |
| 7 | The nod and the full-screen modal wired to the real state instead of the mock's timers; the mock retires | the approved flow, working |
| 8 | Arca hand-over: materialize, follow (`server/profile-follow.mjs`), and the restart call and the home it uses, documented for the owner | an instance in Arca updating itself |

Delivery 4 must not install anything; 5 and 6 are one setting apart from people; 7 is the switch that
retires `?mock-1540`.
