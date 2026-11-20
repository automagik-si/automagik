# RFC 0041: Web self-update in the app

| Field | Value |
|---|---|
| Status | Accepted (owner decisions 2026-11-18: Q2, Q6, Q7; technical decisions named below: Q1, Q3, Q4, Q5; mock approved and repaired in #1546 and landed by its takeover with this RFC (deliveries 1 and 2); layout follow-up #1719; technical amendment 2026-11-20: Q5 re-decided, the version store, the update set, the Arca path, the stop-and-resume order and the verifier's shipping, see "Amendment 2026-11-20"; deliveries 3-8 open) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin only (3.N.P) for deliveries 3-7: `apps/bots-dsh` gains the UI, the host half and the supervisor; delivery 8 changes the server image (`server/`), which reaches Arca through the image workflow; nothing here builds the desktop app |
| Created | 2026-11-18 |
| Renumbered | 2026-11-20: this was RFC 0035 in #1546 (drafted as 0034 before that); 0034 went to the vault plugin, 0035 was also the roles RFC's number in #1572 before it became 0037 (so "RFC 0035" is ambiguous in history), and 0038 and 0040 are held by open pull requests (#1795, #1867), so this RFC takes 0041 |

## Summary

A web instance (a DSH profile served by a service: a system unit on a plain host, a container in
Arca) has no update path inside the app today for the way it is installed: the sidebar's own update
action covers only an instance installed from the registry or a git tag
(`apps/bots-dsh/src/host/update.js:203`), and a web instance installed from release tarballs is
updated by hand — download the release plugins, check them against `PLUGINS.SHA256SUMS`, install them
into the profile, restart the service, check it came back. This RFC designs that path inside the app, in the shape the owner approved
(#1540): a nod at the bottom of the left menu when a newer version exists; a full-screen modal that
says what changes in plain words; then the steps live — download, check the signature, install beside
the current version, restart, health check; a success screen; and an automatic rollback to the
previous version, saying nothing was lost, when health fails.

Step 1, the clickable mock, was reviewed as #1541 and is approved; the repaired mock lands with this
RFC (the takeover of #1546). Its layout follow-up is #1719. Everything below is what the real thing
adds around it, in small deliveries that each land on their own.

## Where the new version and its signature come from

The updater reads **only** the signed lane pointer, never the releases list:

1. **`lane.json` and `lane.json.sig`** from the rolling `plugin-lane` release (a prerelease, moved by
   every release that ships plugins). It is ed25519-signed (`PLUGIN_LANE_KEY`); the public keys ship in
   the plugin (its existing byte-checked copy of `plugin-lane/keys.json`). The updater verifies the
   signature **over the exact bytes** against those keys before trusting any field: `keyId` is read
   only to choose the key, and nothing else is read before the signature passes.
2. **One verifier.** The check the host upgrade uses (`verifyLane`, `scripts/lane.ts:659`, called from
   `scripts/upgrade.ts`) moves to one plain-JS module, `plugin-lane/verify.mjs`, which `scripts/lane.ts`
   re-exports; the Bots plugin carries a byte-equal copy checked by a test, as it already does for its
   role keys. An installed plugin cannot import `scripts/lane.ts` (TypeScript, Bun's
   `import.meta.dir`, outside the package's `files`), and no second ed25519 reader is written.
3. **The update set is every Automagik plugin the profile has, at one version.** From the verified
   pointer the updater takes, for each lane plugin the profile has installed (acp, bots, locale-pt-br,
   vault, welcome; `scripts/lane.ts:91`), its `version`, `url`, `integrity` (sha512), `sha256`, `size`
   and `engines.dsh`. One release for the whole set, as a server image requires it (`server/profile-state.mjs:6`,
   `:24-26`); the owner asked to update "o automagik".
4. It downloads each tarball from GitHub only, checks the **sha256**, the size and the `integrity`
   before unpacking, and refuses anything that does not match.
5. **Refusals, all before the click:** a version not higher than the installed one (an update never
   downgrades); a `sequence` lower than the last one this instance took (recorded in `current.json`, as
   am refuses its own pointer at `am/lib/self.mjs:369`); a plugin whose `engines.dsh` the running DSH
   does not satisfy (as `scripts/upgrade.ts:543-545` and `apps/desktop/src/lane.js:132` check); an
   instance with no supervisor or no writable home; and, where the instance cannot reach the package
   registry the install needs, an install that would fail half-way. The nod is never offered for an
   update that would stop work and then fail.

The keys are never printed, never written into a log, and never returned by a route. A missing key, an
unknown `keyId` or a failed signature stops the update with a sentence the person can read. This is the
same trust chain the pack and the desktop app already use; the web updater adds no new key. A test
key is accepted only from a `file://` lane, as am does for its own tests.

## Who runs the update: the supervisor

A host plugin cannot supervise the restart of the service it runs in: the plain host's
`automagik-web.service` runs with `KillMode=control-group`, and `setsid` does not escape it
(`docs/upgrade.md:121`, `:203`); in a server image the entrypoint forwards termination to DSH and exits
with it (`server/entrypoint.mjs:158-159`). So the **supervisor is the process that starts DSH**:

- **Plain host:** a small wrapper the unit's `ExecStart` runs once the owner switches it on
  (documented in `docs/upgrade.md`, a one-time host change). It starts DSH as its child and restarts
  that child itself, so an update never calls `systemctl` or `sudo`. It runs from its own copy under
  the version store, so an update never replaces the running supervisor. The copy is refreshed only
  after a healthy run, and only when the new code passes a self-check run (it loads every module and
  exits); the previous copy is kept beside it, and the few fixed lines the unit's `ExecStart` runs start
  the current copy and fall back to the kept one when the current one does not start. Its code ships in
  the Bots plugin under an already shipped path (`src/host/`), so adding it does not change the
  package's install fields.
- **Arca (a server image):** the supervisor is the image's own entrypoint (`server/entrypoint.mjs`),
  which already starts DSH and prepares the profile before it (`:117`, `:134`). Arca keeps doing what
  the owner chose (Q2): it restarts the container. The entrypoint records the pending step in the
  version store, stops DSH and exits; Arca's restart brings the container back, and the next
  entrypoint finishes the step (switch, health, or rollback) before and after it starts DSH. The
  store is on the same writable volume, so it survives the container restart.

The host plugin only asks for an update and reads its state. Where no supervisor runs (a DSH started
by hand, the desktop app), it offers no update and says why in Settings; the desktop app keeps its own
updater and never shows this nod.

## Where the previous version is kept

The version store lives **beside** the profile, never in it: `$DSH_HOME/update/<profile>/`, holding
`state.json`, `current.json` and `versions/<version>/`. The image's follow copies and renames the whole
profile directory (`server/profile-follow.mjs:144-174`), which would carry or drop a store inside it.

- **Only installer-owned files move.** The installer owns, in the profile: `node_modules/`, the
  `pnpm-lock.yaml`, the local archives that lockfile names (`vendor/*.tgz` on an image host), and in
  `package.json` only the entries of the selected lane plugins (`@automagik/acp-dsh`, `bots-dsh`,
  `locale-pt-br-dsh`, `vault-dsh`, `welcome-dsh` — never every `@automagik/*` name, which other
  publishers' plugins also use). Everything else in the profile — settings, secrets, model keys, other
  plugins' entries — belongs to the person and is never copied, moved or written by an update or a
  rollback.
- **The install is staged on those files alone.** A staging profile beside the live one gets a copy of
  `package.json` and the lockfile (and the archives the lockfile names) — no settings, no secrets — and
  the new set is installed into it through DSH (`dsh plugin add file:<tgz>` with the verified tarballs),
  under a staging `DSH_HOME` on the same pnpm store, as the image's follow stages its install
  (`server/profile-follow.mjs:144-174`). The live profile is not touched while it runs.
- **The switch happens with DSH stopped, and only if nothing changed meanwhile.** The supervisor
  stops the DSH child, checks that the live `package.json` and lockfile are byte-equal to what was
  staged from (if the person changed a plugin meanwhile, the switch is refused and the pre-switch
  failure path below runs), then: moves the live `node_modules/` and the archives into
  `versions/<previous>/` by rename, renames the staged `node_modules/` in, writes the selected lane
  plugins' entries into the live `package.json` (leaving every other key as it is) and puts the staged
  lockfile in place. It then relinks that tree in place, offline (`dsh plugin install --offline
  --frozen-lockfile` on the live profile: every package is already in the store), so no path written
  under the staging profile survives the move; a relink that fails is a failed candidate and the
  rollback below runs. Plugin installs and removals are refused while an update runs.
- **The previous version is kept whole, so a rollback installs nothing.** `versions/<previous>/` holds
  the previous `node_modules/` (moved aside, not deleted), its lockfile, its lane plugins' entries and
  the archives its lockfile names. A rollback renames them back the same way; it needs no network, no
  registry and no dependency store, so it works on a fresh Arca volume as on a plain host. The store
  and the profile must be on one filesystem for those renames; where they are not, the updater
  refuses before the click. This is the host upgrade's never-half-updated rule
  (`docs/upgrade.md:132-136`) at the profile's scale.
- `current.json` names the live version, the version kept beside it and the last lane `sequence`
  taken. At most two versions are kept; the third is removed only after a healthy run of the new one,
  and never the one a rollback would return to.
- **The data a person cares about — sessions, Bots, memory, settings, secrets and model keys — is not
  part of a version** and is never copied, restored or touched by an update or a rollback. Both move
  only the installer-owned files above; neither restores a whole-profile copy or backup.
  That is what "nothing was lost" means here, and the rollback screen says it in those words.
- **In Arca** the in-app update moves the profile ahead of the image. The image's follow learns that a
  profile a signed in-app update put there, recorded in `current.json`, is followed and healthy: it
  leaves that profile as it is until the image's own release reaches that version, and then follows the
  image as today (delivery 8). The follow's own backup stays the follow's; the in-app rollback uses the
  version store above. If a host offers no writable home, the updater refuses and says why — it never
  installs in place with nothing kept.

## What counts as health

A version is healthy only when the served instance answers as itself again, checked by the
supervisor, not by the page that dropped:

1. the service is up: its own HTTP port answers;
2. every plugin of the set is loaded and reports the **new version** (a small read-only
   `self-update-status` answer on the team's usual route, owner-only; the supervisor signs in with the
   launch URL DSH writes, as the image's gate does, `server/gate-upstream.mjs:32-34`);
3. the team answers: the roster read (the endpoint the left bar already uses) returns without error;
4. one page load succeeds: the app's HTML and its client bundle are served.

Everything with a deadline (60 s for 1 and 2, a further 60 s for 3 and 4 after the restart). A model
call is **not** part of health: it costs money, it depends on a provider, and a provider outage is not
a broken update.

## How the modal continues after the restart that drops the chat

The restart kills the web socket under the open page, so the modal cannot be driven by the page:

- The supervisor does download → verify → install beside → restart → health (or rollback) and writes
  every step to `$DSH_HOME/update/<profile>/state.json`, with its run id and the boot it belongs to.
- The page reads that state on load and on reconnect: if a state file names a run that is not
  finished, the app opens the same full-screen modal at the current step instead of the chat; if the
  run finished healthily, it opens the success screen once; if it rolled back, the rollback screen.
- A state file whose run or boot does not match the live one is ignored (so a stale file never traps a
  person in a modal), and the person can always close it — the state stays readable in Settings.
- The supervisor is the only writer of the state file, and the page never drives the update itself.

## Automatic rollback

- Triggered by any health check failing or timing out, or by the new DSH exiting before health.
- Steps: stop the DSH child, rename the kept version's installer-owned files back (its
  `node_modules/`, lockfile, archives and lane plugins' entries), restart the same way, then run the
  same health checks against the **previous** version.
- If the previous version is healthy, the state records `rolledBack` with both versions, and the modal
  says the previous version came back and nothing was lost.
- If the previous version is also unhealthy, the state records `manualRecovery` with what was tried;
  the instance stops in a state the owner can see, and the message names the kept version and the
  command (or, in Arca, the image) that brings it back. The updater never loops.
- A rollback never re-downloads and never installs: it renames the kept version back.

## When the update fails before the switch

Work stops at the click, before the download (Q6), so a failure before the switch must give it back:
a refused or failed download, a failed check, a staged install that does not converge, a refused
switch, or a supervisor restart before the switch. In each case the supervisor discards the staging
profile, confirms the still-current instance answers the health checks above, records `notUpdated`
with the reason, reopens admission and releases the held work once, through the same resume as after a
healthy update. The modal says the update did not happen, why, and that the work came back.

## Trust, consent and what the updater never does

- Only the owner may start an update: the nod is in the owner's own window, the route is owner-only
  like the rest of the team's routes, and the new endpoints are not agent tools, not runtime calls a
  Bot can make, and not reads a read-only host may run.
- **The limit, named:** on today's hosts a Bot is not kept out of the owner's routes by an unforgeable
  boundary. A Bot that reads the DSH launch credential can act as the owner on loopback
  (`server/README.md:739-745`, RFC 0024's single-human limit), and so could start an update. The
  updater does not claim more than that boundary gives. What such a start can do is bounded: the
  request carries no URL, version or hash, the supervisor fetches and verifies everything itself, so it
  can only update to the newest signed version that passes every check before the click, with the same
  stop, resume and rollback; every start is recorded in the state with the principal DSH reported. The
  gap closes when the caller principal of RFC 0024 reaches DSH's routes; this RFC adds no new way in.
- No update runs while the signature or the hash is unverified, or while there is no writable home to
  keep a version in.
- A failed verification, a refused version or a downgrade stops before touching the profile.
- The updater does not read or write a person's sessions, secrets, settings or Bot memory.

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
  o restart e fornece a pasta". An option choice, as designed in "Who runs the update" (Arca restarts
  the container) and "Where the previous version is kept" (the instance keeps the version, on the
  folder Arca provides).

Decided by the chief of staff on 2026-11-18 — technical, not the owner's:

- **Q1** two versions are kept; the third is removed only after a healthy run of the new one.
- **Q3** health never calls a model. At most it is an option, off by default, and only if a real case
  needs it.
- **Q4** start with 60 s + 60 s, and adjust from a real measurement on the dev instance.
- **Q5** (re-decided 2026-11-20, see the amendment) the supervisor is the process that starts DSH: a
  wrapper on a plain host, the image's entrypoint in Arca. The first answer, a host plugin in the
  profile, cannot outlive the restart it supervises.

## Stopping and resuming work

The owner's decision makes one rule for the update and the same one for the rollback: work that runs
is interrupted at the click, and it comes back by itself once a healthy version is serving. The order:

1. **The click closes admission.** Once the owner confirms, the host starts no new turn: a message that
   arrives waits in its queue, and the composer says an update is running.
2. **Write down what is running, then stop at once.** The Bots plugin already records running turns
   and queued deliveries in its `inflight.json` and treats a shutdown abort as a cut
   (`apps/bots-dsh/src/host/resume.js`). The click marks those records with an "update" reason (so the
   screens say "stopped by an update") and stops the running turns with a short deadline, before the
   download starts. A tool call that cannot be stopped mid-flight is left to finish its current step;
   nothing new starts.
3. **Hold the records through the trial run.** After the restart the resume pass does not run on its
   usual boot timer while the update's state says health is pending: it waits for the supervisor to
   record `healthy`, `rolledBack` with the previous version healthy, or `notUpdated` with the current one healthy. A trial boot that fails health
   therefore never resumes work only to stop it again. Update and rollback restarts do not count
   toward the resume pass's daily limit and do not mark a record as already resumed, so a Bot stopped
   by an update is not left stopped by the "second interruption" guard.
4. **After health, resume.** Each recorded turn is resumed with the existing "check what is done before
   repeating" prompt, and queued turns start in their order. The resume message names the step that
   was in flight, so the person sees what may need a look.
5. **What this cannot promise yet.** Never replaying a completed tool step needs a per-step journal and
   a resume-into-a-turn call that DSH does not have. Until DSH adds them, the Bot is asked to check
   before repeating and the step in flight is named to the person; the success and rollback screens do
   not claim more than that.
6. **When resume is impossible** (the turn's session was deleted meanwhile, or the recorded turn no
   longer exists), the state says so in one line, and the person sees which work could not come back
   rather than a silent loss.

The modal states it before the click: "Work in progress stops when you click Update now, and it comes
back by itself once the update is done. Nothing is lost." The success and rollback screens say that the
stopped work came back.

## What exists already, and what we reuse ("O que já existe e o que reutilizamos")

There are already four update paths, and the owner wants one mechanism per problem, not two. Each
one keeps its problem; 0041 reuses what it can and never adds a second copy.

| exists | what it does | 0041 reuses | 0041 replaces | 0041 retires |
|---|---|---|---|---|
| `scripts/upgrade.ts` + `docs/upgrade.md` | upgrades an **installed host**: latest release or `--to`, verifies the signed lane and `PLUGINS.SHA256SUMS` (`scripts/upgrade.ts:516-545`), backs up, stages `releases/<version>/` and swaps the `runtime` symlink atomically (`docs/upgrade.md:132-136`), re-adds tarballs through `dsh plugin`, smoke-checks, rolls back on failure, prints one `RESULT:` | the lane verifier (moved to `plugin-lane/verify.mjs`), the sha256/integrity and `engines.dsh` checks, the never-half-updated switch, the automatic rollback and the one-line result | the manual "stop, re-add, restart, check" sequence **for plugins only**, from inside the app | nothing — it stays the way a host upgrades its runtime; 0041 never touches `runtime/` |
| `server/profile-follow.mjs` | a server image's profile follows the **image** on start: an offline install from the image's own materialized inputs, under a volume lock (`:46-89`, entered at `server/entrypoint.mjs:117`), with `compareRelease`/`validBuild`/ownership state (`server/profile-state.mjs`) | its staging-and-rename pattern, its volume lock, and the entrypoint as the supervisor in Arca | nothing: it cannot install lane tarballs (it consumes the image's lock and offline store), so the in-app update uses its own staged install and the follow learns to leave a profile a signed update moved ahead | nothing — it keeps updating image-hosted instances when a newer image starts |
| `apps/bots-dsh/src/host/update.js` | updates the Bots plugin of an instance installed from the registry or a git tag; one installed from a local folder or a `file:` tarball, which is how a web instance is installed, is told to update where it was installed (`:47`; `apps/bots-dsh/src/client/about.js:42`) | its place in Settings > About for the check line | nothing | nothing — it stays for registry and git installs; the lane updater serves supervised web instances |
| `apps/desktop/src/lane.js` | the desktop app reads the same signed pointer and takes each installed plugin that is newer and whose `engines.dsh` it satisfies, so it can take a subset (`:129-134`) | the rules: `engines.dsh`, github.com URLs only, the signed pointer as the only source | nothing | nothing — the desktop app keeps its own updater and never shows this nod; the web takes the whole set at one version instead, for the image's one-release rule |

am (`am/lib/lane.mjs`) reads its own pointer (`am-lane`, am's keys), not this one; its sequence refusal
is the reference for the same rule here.

## Amendment 2026-11-20 (technical; no owner decision changed)

A review of this RFC against the code, before delivery 3, found technical choices that cannot work as
first written. The owner's decisions (Q2, Q6, Q7) stand, word for word; these replace technical text,
and the sections above now carry the corrected design:

1. **Q5 re-decided: the supervisor is the process that starts DSH**, not a host plugin, which dies
   with the restart it supervises ("Who runs the update").
2. **Q2 kept as the owner chose it:** in Arca the restart is Arca's container restart; the entrypoint
   records the pending step and finishes it on the next start. On a plain host the wrapper restarts its
   DSH child.
3. **The version store moved beside the profile** (`$DSH_HOME/update/<profile>/`), and it keeps only
   the Automagik pins and the lockfile: a rollback never restores a whole-profile backup, so settings,
   secrets and model keys written after the update survive it.
4. **The update set is every Automagik plugin the profile has, at one version**, instead of "this
   plugin" alone.
5. **The Arca path no longer hands the payload to the image's follow**, which cannot install lane
   tarballs; the in-app update uses one staged install everywhere, and the follow learns to keep a
   profile a signed update moved ahead (delivery 8).
6. **The verifier ships as one plain-JS module with a checked copy**, and `engines.dsh`, the lane
   sequence and the registry's reachability are checked before the click.
7. **Stopping and resuming:** admission closes and work stops at the click, before the download; the
   resume waits for the supervisor's health verdict; update restarts do not use up the resume limit;
   and the RFC no longer promises step-level idempotency that DSH cannot give yet.
8. **Only installer-owned files move, with DSH stopped:** the staging profile carries no owner file,
   the switch is refused if the person changed a plugin meanwhile, and the previous `node_modules/` is
   kept whole, so a rollback renames it back and installs nothing (it works offline on a fresh Arca
   volume). The rollback selector is the selected lane plugins, not every `@automagik/*` name.
9. **A failure before the switch gives the work back** ("When the update fails before the switch").
10. **The owner-only limit is named:** a Bot holding the launch credential can act as the owner today;
    a start it forges is bounded to the newest signed, checked version.
11. **The plain-host wrapper is refreshed only after a self-check**, with the previous copy kept as the
    fallback the unit starts.
12. **Corrections to "What exists already":** the Bots plugin's own updater and the desktop's lane
   reader are listed (the desktop can take a subset; the web takes the whole set); am reads its own pointer; the plugin pointer moves only on releases that ship
   plugins; the supervisor ships under an already shipped path, so the plugin-only lane holds.

## Deliveries (each one PR)

| # | What it adds | Visible to the person |
|---|---|---|
| 1 | The mock (approved; reviewed as #1541, repaired in #1546, lands with this RFC) | the whole flow, with sample data, behind `?mock-1540` |
| 2 | This RFC | no |
| 3 | Host half: the version store, `current.json`, `state.json` and its stale-run rule, the read-only `self-update-status` answer the page and the supervisor use | no (no update yet) |
| 4 | Verified check: `plugin-lane/verify.mjs` and the plugin's checked copy; read `lane.json`, take the set the profile has, download and check every tarball, check `engines.dsh`, the sequence and the registry, and stop — a dry run that writes what it would do | a "check for updates" line in Settings, no install |
| 5 | The supervisor and the plain-host wrapper with its self-check and fallback (documented in `docs/upgrade.md`): the click closes admission and stops work, the staged install of the set on installer-owned files, the switch with DSH stopped, the restart of the DSH child, the pre-switch failure path, the state written at every step | a real update behind a setting, off by default |
| 6 | Health and automatic rollback by renaming the kept version back; the resume held until health | the rollback screen tells the truth |
| 7 | The nod and the full-screen modal wired to the real state instead of the mock's timers; the mock and its flag retire | the approved flow, working |
| 8 | Arca: the entrypoint as the supervisor (record, exit for Arca's restart, finish on the next start), and the follow and the health check keeping a profile a signed update moved ahead; a server image change, documented in `server/README.md` (closes #1540) | an instance in Arca updating itself |

Delivery 4 must not install anything; 5 and 6 are one setting apart from people; 7 is the switch that
retires `?mock-1540`.
