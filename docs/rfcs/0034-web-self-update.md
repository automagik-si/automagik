# RFC 0034: Web self-update in the app

| Field | Value |
|---|---|
| Status | Proposed (mock approved by the owner 2026-11-18, #1541; plan drafted 2026-11-18; no delivery merged; Q1-Q7 open) |
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

Step 1, the clickable mock, is #1541 and is approved. Everything below is what the real thing adds
around it, in small deliveries that each land on their own.

## Where the new version and its signature come from

The updater reads **only** the signed lane pointer, never the releases list:

1. **`lane.json` and `lane.json.sig`** from the rolling `plugin-lane` release (a prerelease, moved
   every release). It is ed25519-signed (`PLUGIN_LANE_KEY`); the public keys ship in the plugin
   (`plugin-lane/keys.json`, copied into the package). The updater verifies the signature **over the
   exact bytes** against those keys **before reading any field**, exactly as the desktop app's own
   lane reader does (`apps/desktop/src/lane.js`).
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

- **Plain host**: `<profile>/update/versions/<version>/` holds a copy of what the profile has for this
  plugin (the files the release tarball contains) together with the installed `package.json`, so the
  rollback is a directory switch and never a re-download. A small pointer file,
  `<profile>/update/current.json`, names the version that is live and the one kept beside it. At most
  two versions are kept; the third is removed only after a healthy run of the new one.
- **Where the instance lives in Arca**: Arca supplies the container and its writable home, nothing
  about plugin versions. So the same layout is used **inside** the instance's Arca home, and Arca adds
  two things the updater relies on: the restart of the instance is a container restart (the updater
  asks Arca to restart the instance, it does not kill the process itself), and the state file survives
  it because it is in the same writable home. If a host offers no writable home, the updater refuses
  and says why — it never falls back to installing in place with nothing kept.
- The data a person cares about — sessions, Bots, memory, secrets — is **not** part of a version and
  is never touched by an update or a rollback. That is what "nothing was lost" means here, and the
  rollback screen says it in those words.

Open: Q1 (who removes an old kept version, and when), Q2 (whether Arca should own the version store
instead of the instance's home).

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

Open: Q3 (whether a quick model round-trip should be opt-in), Q4 (the exact deadlines).

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

Open: Q5 (where the supervisor lives: a DSH host plugin in this profile, or a small launcher the
service starts).

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

## Deliveries (each one PR, plugin lane)

| # | What it adds | Visible to the person |
|---|---|---|
| 1 | The mock (#1541, approved) | the whole flow, with sample data, behind `?mock-1540` |
| 2 | This RFC | no |
| 3 | Host half: version store, `current.json`, `update-status`, and the "did the last run finish" read the page uses | no (no update yet) |
| 4 | Verified fetch: read `lane.json`, check its signature, take this plugin's `version`/`sha256`, download the tarball, check it, and stop — a dry run that writes what it would do | a "check for updates" line in Settings, no install |
| 5 | Install beside and switch: unpack into `versions/<version>`, write the state, restart through the supervisor | a real update behind a setting, off by default |
| 6 | Health and automatic rollback, as above | the rollback screen tells the truth |
| 7 | The nod and the full-screen modal wired to the real state instead of the mock's timers; the mock retires | the approved flow, working |
| 8 | Arca hand-over: the restart call and the home it uses, documented for the owner | an instance in Arca updating itself |

Delivery 4 must not install anything; 5 and 6 are one setting apart from people; 7 is the switch that
retires `?mock-1540`.

## Open questions

- **Q1** Who removes an old kept version, and when? (Two kept; the third removed after a healthy run?)
- **Q2** Does Arca own the version store, or the instance's home does, as designed here?
- **Q3** Should health include one small model round-trip, opt-in?
- **Q4** Are 60 s + 60 s the right deadlines on the owner's hardware?
- **Q5** Where does the supervisor live — a host plugin in this profile, or a launcher the service
  starts?
- **Q6** Does an update wait for turns that are running, or does the click end them? (The owner's
  click is consent to restart; what happens to a running turn is a product decision.)
- **Q7** Which releases may be updated to: every plugin patch, or only stable tags? (A prerelease
  never moves `plugin-lane`, so the pointer already answers most of this.)
