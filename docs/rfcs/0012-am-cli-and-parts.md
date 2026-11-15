# RFC 0012: am, one CLI and parts

| Field | Value |
|---|---|
| Status | In delivery (deliveries 1-2: #254, #258, #263; 3-10 not found; owner's answers in: D35) |
| Milestone | none (ships outside the five milestones) |
| Lanes | am (3.N.P, D35), herdr (3.N.P), plugin (3.N.P), pocket (3.N.P), desktop (3.N) |
| Created | 2026-11-03 |

## Summary

Automagik gets one command, `am`, for everything it installs. Bot verbs stay at the top level,
as in `automagik-herdr` today, and every other part gets its own noun group (D22). `am` is its
own small signed part, attached to every Automagik release, so every machine has it, work-only
ones included, and it updates apart from the herdr pack (D35). Every part (a DSH plugin, a herdr
mod, the pack, the layout, herdr-app, usagemeter, the desktop app) carries a `part.json` and can
be installed, checked, rolled back and uninstalled on its own, as a set (`code`, `work`) or all
together, on macOS, Linux and Windows (D27, D28). Parts depend on versioned capabilities, not on
each other's ids, so anyone can fork a part and swap it in. RFC 0013's "One install" (delivery 7)
runs through it.

## Motivation

The owner wants one Automagik that "delivers each relevant part individually too", where anyone
builds their own (owner direction 2026-11-03 (2), via t22n). Today each part has its own
installer and its own record: `herdr/install.sh` and the pack marker, DSH's plugin lane in the
desktop app, usagemeter's binary, Pocket's APK. There is no single command that says what is
installed on a machine, whether it works, and how to undo it. RFC 0013's switch needs that
answer ("Set up", "Update due"), and so does fleet work over Herdr's machines.

Sources: `pocket-into-automagik-monorepo.md` ("One `am` CLI", "Parts", the eight rules revised
after t22n's review); `bot-system-unification.md` (D22, D25, D27, D28, and D35);
`herdr-parts-questions-t2zx.md` and `herdr-parts-for-rfc-0012.md` (t2zx, branch
`feat/herdr-parts`); RFCs 0010, 0011, 0013 and 0014.

## Decided and proposed

Decided (the log):
- D22: one `am`, Bot verbs on top, noun groups, `am update` for every part, `automagik-herdr`
  kept as a byte-identical alias for at least one bridge cycle.
- D25: plugins update on their own. D28: the supported targets.
- D27: one install sets up DSH, herdr-app and the pack, on all three OSes at once; herdr-app is
  installed from herdrdev's feed and kept latest (RFC 0013, Decided 1 to 3).
- The handoff's eight rules, and t259 and t22n's rules (a) and (b) below. Rules (a) and (b)
  settle t2zx's questions 1 and 2.
- D35 (the owner, 2026-11-03; first logged as a second D34): `am` is its own small signed part,
  attached to every Automagik release, out of the herdr pack, so work-only machines get it.
  `--trust` is accepted only through a dialog in the Automagik window or a prompt outside any
  Herdr terminal; signed release parts need no confirmation. herdr-app is a part, and all three
  OSes are prerequisites of "Set up".
- D35 additions (the owner, 2026-11-03, the rest of this RFC's questions):
  - am's home: a top-level `am/` folder, its own lane kind `am` (a 3.N.P patch for an am-only
    merge), and its own rolling `am-lane` pointer signed with its own rotatable key.
  - Bootstrap: the `install.sh` one-liner and the desktop app's "Set up", both verifying the
    pointer; Node is the pack's floor (22.7) until RFC 0010's question 2 is answered.
  - `os` stays OS-only; am applies D28's targets (with their architectures) to every part.
  - Pack members record the pack tarball's one sha256; no per-member hash.
  - A path source is refused with `--machine`; a git source works instead.
  - parts.json is keyed by hc's machine name.

Proposed here: everything else, including t2zx's defaults 3 to 5 as built on
`feat/herdr-parts` (t22n accepted them over hc; the log does not record them). Where a sentence
below proposes rather than records, it says "proposed".

## Design

### The command

`am` is one Node entry. Its shape is D22's:

- Top level, one-to-one with `automagik-herdr`: `ls show create edit rm start attach detach
  whois brief worker category`. They act on the shared Bot registry (RFC 0014).
- Parts, top level: `am install`, `am uninstall`, `am update`, `am doctor`. Proposed:
  `am rollback <id>` and `am parts` (what is installed, per machine), since `am ls` is taken by
  Bots.
- Noun groups: `am herdr …` (mods, layouts, restart, doctor), `am meter …`, `am pets bake|ls …`,
  `am pocket pair|link …`, `am desktop open|logs …`. A future clash between a top-level verb and
  a part goes to the part's group, never to the top level.
- Every command takes `--json` and prints one JSON value or JSON lines. Exit codes: 0 done or
  healthy, 1 failed or broken, 2 not applicable (proposed for the shell; the doctor's are
  decided, below).

`automagik-herdr` stays an alias whose output is byte-identical to `am`'s for the same verb: the
briefing hook in 62 settings files, Bots' instructions, workers' briefs and Brain's frozen
`whois --json` depend on it. The alias is retired only after a bridge cycle, by its own RFC
change.

### The am part (D35)

`am` is a part like any other, with one difference: every release carries it.

- Proposed id `automagik.am`, kind `binary`, `set: ["code", "work"]`. It provides `bots.cli@1`,
  `bots.attach-ledger@1` and `bots.whois-json@1`, and owns the `am` and `automagik-herdr` links.
  Rule 8 ("the CLI is its own part", swapped apart from the sidebar) now holds through it.
  While am is not installed, the pack's installer, its updater and any start of the pack's CLI
  create a missing `am` command link to the pack's own CLI copy, never over a file or a link that is
  not theirs and only for a pack the install record lists (a pack with no record gets none); a link
  the person removed comes back at the next start, by design, since the pack owns it while am is
  absent; once am is installed, am owns the link (am takes it from the pack, and hands it back on
  uninstall).
- Every `vX.Y.Z` release attaches `automagik-am-<v>.tgz`, whatever its lane kind. This amends
  RFC 0011, where a release attaches only the parts whose paths changed: am is the one part every
  release carries, and delivery 1 changes `release.yml` and `lane.ts` to match. Its code is the
  top-level `am/` folder, and an am-only merge is an `am` patch (3.N.P) (D35). A rolling
  `am-lane` release holds `am.json` and `am.json.sig`, signed with a key of am's own (D35), as
  `herdr-lane` is (RFC 0011): the same two-slot rotation, the same refusal of a lower sequence,
  never Latest, never a `v*` tag. Never `PLUGIN_LANE_KEY` or the pack's key.
- It carries the Bot verbs that today live in `herdr/mods/am-sidebar/bin/` and every module they
  import from the sidebar (`model.js`, `launchArgs.js`, `attach.js`, `workers.js`, `models.js`,
  `briefing.mjs` and the rest). Proposed: the pack stays the source, and am ships byte-equal
  copies a test keeps equal, the pattern D33 set for the live chat module. At run time am reads
  nothing from the pack's folders, so switching a pack member off cannot break it.
- It carries every lane's trust anchors: its own public keys, and copies of `pack-keys.json` and
  the plugin lane's keys, kept equal to the originals by a test (as `install.sh`'s
  `TRUSTED_KEYS` is). That makes am's key the most valuable one: whoever signs an am can ship
  one that trusts any key. When a pack is installed, am verifies pack parts against the
  installed `pack-keys.json`, as the pack's updater does; its own copy serves only a machine
  with no pack yet.
- `am-lane` has `herdr-lane`'s guards (RFC 0011, #210). `check-key` runs before the tag on every
  release kind, since every release signs `am-lane`: a missing secret, or one whose public key
  am's key list does not hold, stops the release before it tags. The post fails closed: an
  unreadable or unverifiable posted pointer stops the run unless it is dispatched with
  `replace_unverified_am_pointer`, and a lower sequence is never posted. A test key override is
  honoured only for a `file://` pointer, never a GitHub URL.
- `am update` updates am first: it verifies the new tarball against `am-lane`, stages it beside
  the installed copy, swaps by rename, and keeps the previous one for `am rollback automagik.am`.
  It updates apart from the pack: a pack release does not wait for am, nor the reverse.
- **As built in delivery 1** (t30j, agreed with t22n and t259, 2026-11-03):
  - The secret is `AM_LANE_KEY` (rotation slot `AM_LANE_KEY_NEXT`, picked by the variable
    `AM_LANE_SIGNER`), the public keys `am/am-keys.json`, made by `bun scripts/am-lane.ts
    keygen`. Amending the bullet above: while `am-keys.json` lists no key, or the secret is not
    set, a release attaches am, posts no `am-lane` and says so in a `::warning::` (the key is
    the owner's to add; a release never fails over its absence, nor in the window between
    keygen and its `am-keys.json` reaching dev). Once keys are listed, a secret that is none of
    them stops the release before the tag, as written. The post is a job of its own (`am-lane`,
    after the cut), so its fail-closed refusals stop neither the plugin lane nor any other job
    (t259's review).
  - Until a release ships a key, an installed am cannot update itself; so the briefing entry
    runs am's copy first only when its `VERSION` is at least the installed sidebar's, and a
    stale am never shadows a newer pack's briefing (t259's review). A self install records its
    version's sequence, so an older signed pointer is refused after it; one install, update,
    rollback or uninstall runs at a time (`parts/automagik.am/.lock`); a reinstall of the
    linked version goes into a fresh folder, so `current` never names a missing one.
  - am reads `am-lane` with its installed `am-keys.json`. For tests only, `AM_RELEASE_URL` (a
    `file://` folder) and, with a `file://` one only, `AM_TRUSTED_KEYS`.
  - Links: am creates `~/.local/bin/am`, and takes `~/.local/bin/automagik-herdr` only when it is
    missing, am's, or one of the pack's own links (`mods/am-sidebar/bin/automagik-herdr[.mjs]`,
    or the old `spaces-agents` folder's). The pack already leaves a link that points elsewhere
    alone (`relinkCli`, `install.sh`), so it never takes it back. `am self uninstall` hands
    `automagik-herdr` back to the pack's entry when a pack is installed. Both links go through
    `parts/automagik.am/current/`, so an update or rollback needs no relink.
  - The briefing entry point: am replaces the pack's plain copy with a link,
    `<app home>/automagik-herdr/briefing.mjs` -> `$AM_HOME/parts/automagik.am/current/
    briefingEntry.mjs`, so it resolves into am's parts store (the sidebar guard's test) and an
    update or rollback needs no relink. The pack's placement leaves such a link alone; `am self
    uninstall` puts the pack's copy back. `briefingEntry.mjs` takes the app home from the path the
    hook ran (`argv[1]`: node resolves the link for the module itself), runs am's copy first,
    telling it the app home, then the sidebar's, then `spaces-agents`'s. A copy that is missing,
    or whose import throws, is passed over: a broken am never silences a briefing (t22n). Each
    attempt gets the hook's whole stdin, read once and replayed, and its output is printed only
    when it succeeds; a session is joined in the ledger once, however many attempts or turns.
  - The copies are the import closure of the CLI, `briefing.mjs` and `briefingEntry.mjs`, plus
    the CLI's wrapper, `run.sh`, `pack-keys.json` and the plugin lane's `keys.json`
    (`plugin-lane-keys.json`). `scripts/am-copies.mjs --check` runs in herdr's gate too, so a
    herdr pull request that drifts fails in its own CI; `--write` resyncs them.
  - `am` runs every verb but its own (`update`, `rollback`, `self`, `help`) through the CLI
    copy in its own process, and `automagik-herdr` runs the copy directly: both print the pack's
    bytes. A pack verb run from am's copy (`automagik-herdr update`) checks the pack pointer
    against am's copy of `pack-keys.json`, equal to the pack's at the same release.
  - Windows (links, the launcher) waits for delivery 6; delivery 1 runs on macOS and Linux.
- The pack's CLI verbs that act on the pack itself (update, rollback) become `am update` and
  `am rollback` of `herdr.pack`, through its entries.
- The briefing (`brief`, D22) moves with them. Today the hooks' fixed entry point,
  `$HERDR_APP_HOME/automagik-herdr/briefing.mjs`, runs `mods/am-sidebar/briefing.mjs` and prints
  nothing when that folder is gone (`briefingEntry.mjs:14-15`), so a switched-off sidebar would
  silently stop every Bot's briefing. Proposed: the entry point keeps its path (the hooks in
  every project already name it) and runs am's copy, falling back to the sidebar's while an
  older pack is installed. am owns the entry point, the hooks journal and the per-project hooks.

### Parts and `part.json`

A part is a folder with a `part.json` at its root, beside the part's own manifest (a DSH
`package.json`, a herdr `mod.json`), which it never repeats. Fields (Contracts has the example):

| Field | Meaning |
|---|---|
| `id` | Public contract, like plugin ids: never renamed. A fork takes a new id. |
| `title` | What `am parts` and the desktop show. |
| `kind` | `dsh-plugin`, `herdr-mod`, `herdr-layout`, `binary`, `android-app`, `desktop-app`. |
| `paths` | Repository globs that rebuild it. `scripts/lane.ts` derives lane kinds from them. |
| `provides` | Capabilities it offers, `name@major`. |
| `requires` | Capabilities it needs, `{cap, major}`. |
| `os` | `macos`, `linux`, `windows`. |
| `targets` | `local`, or `fleet` (every connected machine, under the part's own consent). |
| `artifact` | Release asset name, `{version}` filled by the release. |
| `select` | Subpath inside a shared artifact. |
| `entry` | `install`, `uninstall`, `doctor`, optional `rollback`: argv arrays. |
| `replaces` | Optional: ids this part stands in for (a fork names the part it swaps out). |
| `writes` | Paths and globs it writes outside its folder; `#` names a key inside a file. |
| `set` | Bundles that include it by default: `code`, `work`. |

No version field: a part's version is the release's `vX.Y.Z`, stamped into the artifact by the
release (the one-version rule); a manifest with `version` is refused.

### The herdr parts

As built on `feat/herdr-parts` (t2zx, `6b5dbba5`, WIP), with the changes D35 and the review
need. All are `targets: local`, `set: ["code"]`, artifact `automagik-herdr-pack-{version}.tgz`.

- One `herdr-mod` part per pack mod: `herdr.am-sidebar`, `herdr.am-automations`,
  `herdr.am-footer`, `herdr.am-markdown`, `herdr.am-mods`, `herdr.am-new-menu`, `herdr.am-quota`,
  `herdr.am-status`, `herdr.am-tabs`. `part.json` ships inside each mod folder of the tarball.
  `select` is the tarball's real layout (`am-sidebar/`, `am-footer/`), which has no `mods/`.
- **`herdr.pack`, its own part (proposed; was folded into `herdr.am-sidebar`).** It provides
  `herdr.pack@1`: the updater, the record and the kept set. Its manifest and
  the shared entry script sit in `am-sidebar/pack/` (`part.json`, `part.mjs`, moved from
  `am-sidebar/bin/`), `select` `am-sidebar/pack/`. `herdr.am-sidebar` then provides only
  `bots.sidebar@1`, requires `herdr.pack@1` like every other member, and is switched off like
  them. Entries run from the extracted tarball (rule (a)), never from the installed folder, so a
  switched-off sidebar does not stop the pack's install, update or uninstall. `herdr.pack`'s and
  `herdr.layout`'s entries act on the app home (the marker, `mods/`, `mods-disabled/`,
  `layouts/`), never on their own folder, so they work whether or not `am-sidebar/` is switched
  off; switching `herdr.am-sidebar` off moves the whole folder, as Herdr's mod manager does
  (t22n, 2026-11-03). Only the sidebar's
  own in-app update offer goes quiet; `am update` still updates the pack.
- **`herdr.cli` is retired before it ships.** Agreed by t30j and t22n (2026-11-03): in delivery 1
  nothing leaves the pack; am ships byte-equal copies. In delivery 2 exactly three files leave
  `am-sidebar/bin/` for the am part, which becomes their source: `automagik-herdr`,
  `automagik-herdr.mjs` and `state.mjs`. `bin/run.sh` stays in the pack (`launch.js`,
  `launchArgs.js`, `agentPath.mjs`, `formModel.js` and am-mods' `core.js` run it), and so do
  `briefing.mjs`, `briefingText.mjs`, `briefingEntry.mjs` and the modules they import, until the
  bridge ends; am keeps copies of them. The capabilities go with the CLI. The pack stops linking
  `automagik-herdr` in the first release after am ships, so the alias never disappears. No herdr
  manifest declares `~/.local/bin/am` or `automagik-herdr`: only am's does. The pack's
  installer hands the link over by leaving one that points at am, and am takes one that points
  into the pack.
- Until am's own CLI and briefing copies are installed on the machine (delivery 1 released and
  `automagik.am` installed), `am uninstall herdr.am-sidebar` refuses and says why: switching
  the sidebar off would leave `automagik-herdr` pointing at nothing and stop every briefing
  (t2zx). The guard reads what is installed: it lifts only once the briefing entry point
  resolves into `$AM_HOME/parts/` (am places a link there, never a copy), `automagik-herdr` no
  longer resolves into the sidebar, and no project hook calls the sidebar's `briefing.mjs` or
  starts through its `bin/run.sh` (the pack's own hook command does, so the guard holds until
  am runs the hooks, delivery 3).
- **Every herdr manifest sits inside an existing pack mod folder** (t259 and t22n, 2026-11-03).
  An installed pack's `update.mjs`, old ones included, refuses a tarball with any `layouts/`
  file but `automagik.json` and any top-level folder that is not a pack mod, so a manifest
  anywhere else would make every installed pack refuse the release. `herdr.layout`'s manifest
  ships as `am-sidebar/layout/part.json`, `select` `am-sidebar/layout/` (in the repository it is
  `herdr-layout/part.json`: `herdr/scripts/pack.mjs` puts it there in the tarball), and
  `herdr.pack`'s is `am-sidebar/pack/part.json`, `select` `am-sidebar/pack/`. The layout itself
  is `layouts/automagik.json` in the tarball (`herdr-layout/layouts/automagik.json` in the
  repository). One function, `repoPathOf` in `herdr/scripts/parts.mjs`, maps tarball paths to
  the repository's.
- Entries: `["node", "part.mjs", "<verb>", "herdr.pack"]` for the pack, `["node",
  "pack/part.mjs", …]` for the sidebar, `["node", "../am-sidebar/pack/part.mjs", …]` for the
  other mods and the layout. The relative path works because the whole tarball is extracted. No
  rollback entry.
- `writes` (`~/` is the home, `**/` any project): `herdr.pack` the marker and `.prev/**` (in
  `$HERDR_APP_HOME/automagik-herdr/`); am-mods `$HERDR_APP_HOME/keys.json#global.cmd-shift-m`;
  `herdr.layout` `$HERDR_APP_HOME/layouts/automagik.json`. `automagik.am` takes the briefing's:
  `briefing.mjs` and `hooks-journal.json` there, and
  `**/.claude/settings.local.json#hooks.UserPromptSubmit`,
  plus its links in `~/.local/bin`. Proposed: a `writes` path may start with
  `$HERDR_APP_HOME/`, which am resolves (else `~/.config/herdr-app`). Code gap: the gate accepts
  only `~/` and `**/`, and the manifests spell `~/.config/herdr-app/` out.
- The gate, `herdr/scripts/parts.mjs --check`, checks every `part.json` under `herdr/` (the
  layout's included, in `am-sidebar/layout/`): the fields, `paths` against tracked files,
  `select` as the part's own folder, entry scripts shipping in the tarball, and `writes` (it
  refuses `shared.json`, `data/`, pocket-link, LaunchAgents). Every `PACK_MODS` folder must have
  one.
- Every herdr part lists only `macos` today, and `part.mjs` exits 2 on any other platform.
  The Linux and Windows ports are deliveries 5 and 6 (D27).
- None declares `~/.local/bin/usagemeter`: that becomes usagemeter's own part (t22b);
  `install.sh` and `am meter` keep handling it until then.
- Pocket Link (`herdr/mods/pocket-link`) is on the herdr lane but is not a pack member (it is
  never in `PACK_MODS`, and the pack never writes it). Proposed: its own part, owned by Pocket.
  Pocket itself (`android-app`) installs nothing on a computer: proposed, its doctor reports 2
  there, and `am pocket pair` is how a phone joins.

### herdr-app as a part (D27)

herdr-app is herdrdev's app, `dev.herdr.app`, installed from its feed
(`https://releases.herdr.dev/app/latest.json`), checked against the feed's sha256, and always
kept at the latest version (RFC 0013, Decided 1 to 3). Proposed: a part `herdr.app` (kind
`desktop-app`, `set: ["code"]`, all three OSes) whose entries ship in the am part, so they are
ours and signed. `herdr.pack` requires the `herdr.app@1` it provides, from delivery 4 on. am
counts a herdr-app it finds installed as providing `herdr.app@1` (adopted), so a pack set up by
`install.sh` or by hand is not reported broken.

- Its install entry reuses RFC 0013 delivery 2's logic, `apps/desktop/src/herdr-update.js`
  (#238): the feed for this OS and architecture, the download from herdrdev's host only, its
  sha256 checked before anything in it runs, installed the way herdrdev's installer does. Proposed:
  `apps/desktop` stays the source, and the part ships a byte-equal copy a test keeps equal.
- Install is "make it present and latest": a herdr-app already installed is adopted, not
  replaced, and updated when the feed is newer. Updates follow 0013: offered, done on yes; `am
  update` counts as the yes. Offline, the installed one stays and doctor says so.
- Uninstall removes only a herdr-app this part installed, never one it adopted; with
  `--purge` it still leaves Herdr's own data.
- Doctor: `present`, `version` against the feed (a newer one is `ok: false`, `fix: am update
  herdr.app`), `control` (`herdr-app status` answers). Proposed: its source line reads "third
  party, feed-checked", since herdrdev's bytes carry no signature of ours.

### Capabilities and replacement

Parts depend on capabilities, never on ids (rule 1). The one version bumps on every merge and
forks have none, so a frozen contract is a capability major. `bots.registry@1` is the registry's
(RFC 0014).

| Part | Provides | Requires |
|---|---|---|
| `automagik.am` | `bots.cli@1`, `bots.attach-ledger@1`, `bots.whois-json@1` (Brain pins it) | nothing |
| `herdr.app` | `herdr.app@1` | nothing |
| `herdr.pack` | `herdr.pack@1` | `herdr.app@1` |
| `herdr.am-sidebar` | `bots.sidebar@1` | `herdr.pack@1` |
| the other mods | `herdr.automations@1`, `herdr.footer@1`, `herdr.markdown@1`, `herdr.mod-manager@1`, `herdr.new-menu@1`, `herdr.quota@1`, `herdr.status-bar@1`, `herdr.tabs@1` | `herdr.pack@1` |
| `herdr.layout` | `herdr.layout@1` | `bots.sidebar`, `herdr.footer`, `herdr.tabs`, `herdr.status-bar`, `herdr.automations`, `herdr.quota`, `herdr.markdown`, each `@1` |

- `am install` resolves `requires` through `provides` and shows a dry run first: what it adds,
  what it replaces, what it removes.
- Two installed parts may not provide one capability. A fork keeps the `provides`, changes the
  `id` (`me.my-sidebar`), and names the part it swaps out in `replaces`. `am install <source>`
  then uninstalls the old part (or switches it off, for a pack member) and installs the new one.
  A fork of the sidebar switches `herdr.am-sidebar` off and leaves the pack and am alone.
- Proposed: `am uninstall` refuses to remove the only provider of a capability another installed
  part requires, and its dry run names those parts. `am uninstall herdr.pack` is the one way to
  remove the pack, and its dry run lists every member it takes with it.

### Sources and trust

| Source | How | Checked against | Recorded |
|---|---|---|---|
| Release (default) | `am install <id>` | the lane's signed pointer | `signed: true`, lane, sequence |
| Release, named version | `am install <id> --version <v>`, confirmed (D35) | that release's own `.sha256` | `signed: false`, no sequence |
| Path | `am install ./path`, confirmed (D35) | nothing; proposed: a hash of the tree at install | `signed: false`, the path |
| Git | `am install git+<url>@<sha>`, confirmed (D35) | the commit (proposed: 40 hex characters only) | `signed: false`, url and sha |

Release parts are verified the way `herdr/install.sh` and the pack's updater already verify
(RFC 0011): the pointer, its signature against am's trust anchor, then the artifact against the
sha256 the pointer names, before anything is written. Each lane has its own key: `am-lane`
(D35), `herdr-lane` (`pack.json`, `HERDR_PACK_KEY`), `plugin-lane` (`lane.json`,
`PLUGIN_LANE_KEY`). `pack.json` names one sha256 for the whole tarball, so every pack member
records the tarball's hash, and no member has a hash of its own (D35; one would need a new
pointer field, and rule 5 says a part's sha256 comes from the pointer, never from the
download). Pocket's `latest.json` is unsigned on purpose (the APK's signer is the check);
usagemeter's trust is t22b's to decide (question 5).

A named version is checked only against the `.sha256` beside it, which comes from the same
download: integrity, not who published it. So am records it as unsigned and asks for the same
confirmation as a path or git source.

**Confirmation (D35).** A signed release part needs none. Anything recorded `signed: false`
needs the person's yes, given in one of two places: a dialog in the Automagik window, or a
prompt am shows when it runs outside any Herdr terminal. am treats Automagik's own DSH like a
Herdr terminal: a Bot's tool call there is agent-run too. Inside a Herdr terminal or under
DSH's process tree, am asks the Automagik window and waits; with no window, it refuses. The yes is
recorded per id and source, and `am doctor` keeps listing the part as "unsigned, from <source>"
for as long as it is installed.

**Rule (a), agreed by t259 and t22n.** For a release source, am verifies the pack tarball against
the signed pointer's sha256, extracts the whole tarball to a staging folder, and runs each entry
with `AM_PART_DIR=<extracted>/<select>` and `AM_ARTIFACT=<verified tgz path>`. The herdr entry
prefers `AM_ARTIFACT` and installs the pack through the tarball's own `update.mjs install
--setup` (unless the marker already names `AM_VERSION`), with `stagePack`'s checks unchanged.
Without it, `AM_PART_DIR` may also be a checkout's folder (a path source).

### Downgrades and rollback

- am refuses a pointer whose sequence is lower than the one installed (rule 4), the rule
  `install.sh` and the release already apply. During the bridge the herdr parts' sequence is the
  marker's `sequence=`.
- An on-purpose downgrade is `am install <id> --version <v>` (above): unsigned, confirmed,
  recorded with no sequence, and said so.
- am keeps the previous artifact of every part. When install fails, or the doctor run after it
  exits 1, am rolls back: `entry.rollback` when the part has one, else the install entry run
  again on the kept artifact. The herdr parts have no rollback entry, so am restores the kept
  tarball; the pack's own `.prev/` stays the updater's kept set. `am rollback <id>` does the same
  by hand.
- A shared artifact is one unit. The pack installs and updates as a whole (`stagePack` accepts
  only exactly `PACK_MODS`), so installing or updating any member installs or updates the pack,
  and all members carry one version.

### One member of a shared pack

**Rule (b), agreed by t259 and t22n.** Uninstalling one member of the pack (an am-* mod, the
sidebar included) switches it off: the folder moves to `<app home>/mods-disabled/`, as the mod
manager does, and parts.json records it as `disabled`. Its doctor reports it as not applicable
(exit 2). A pack update keeps it off (t2zx's change to `update.mjs`, which also fixes today's bug
where an update puts a second copy of a mod the manager switched off back into `mods/`).
`am install <id>` switches it back on, and installs the pack first when none is installed. The
marker's `mods=` stays as it is.

Uninstalling the whole pack part, `herdr.pack`, removes the pack for real with `install.sh
--uninstall`'s logic: the folders, on or off, go to the kept set `.prev` (deleted with
`--purge`), adopted folders come back, and the pack's keys, the layout it added and the marker
are removed. It never touches am, nor the briefing: the hooks, their entry point and journal
are am's, and with no pack the entry point runs am's copy, so a pack uninstall cannot silence a
briefing. Only `am uninstall automagik.am` removes the hooks (each file backed up as
`.am-backup`).
Uninstalling `herdr.layout` removes the layout while it is byte-equal to the pack's copy and
records `layout=removed`, so no update or repair puts it back.

### The entry contract

- Entries are argv arrays, never bare paths: Windows runs no shebangs. Proposed: am runs them
  with the part's folder as the working directory, resolves a relative argv path against it, and
  runs `node` as the Node am itself runs on.
- am sets `AM_HOME` (`$AUTOMAGIK_HOME`, else `~/.automagik`), `AM_PART_DIR`, `AM_ARTIFACT`
  (release sources), `AM_VERSION`, `AM_MACHINE` and `AM_JSON=1`. am appends `--purge` to the
  uninstall argv when asked.
- For a release source verified through a signed pointer, am also sets `AM_SEQUENCE`, the
  pointer's sequence; a named version (`--version`) gets none. The herdr entry forwards it to
  `update.mjs install --sequence`, so the marker records `sequence=` on every am install and
  `install.sh`'s replay guard stays on (t2zx).
- install and uninstall are idempotent. Uninstall keeps user data unless `--purge`. They log to
  stderr and print one stdout line, `{part, ok, changed, detail}` with `AM_JSON=1`, else the
  detail.
- doctor is read-only and finishes in under 30 s (Herdr's exec cap). The herdr doctors run no
  program and no network and take milliseconds.
- Exit 0 healthy, 1 broken, 2 not applicable (a switched-off member, an OS the part does not
  list).

### Doctor

A doctor prints JSON lines `{part, check, ok, detail, fix}`; am fills `part` when an entry leaves
it out, and adds `machine` when it runs across machines (proposed). `fix` is the exact command,
or null when no command fixes it. The herdr checks: every part `record` (the marker exists) and
`version`; the mods `listed`, `folder`, `files`; the pack `pack-version`, `pack-mods`; am-mods
`keys`; the layout `layout`, `layout-json`. am's own: `command`, `am`, `path` (its link folder on
PATH), `node` (22.7 or later), `briefing-entry`. Their `fix` is `am install <id>`, the
bootstrap one-liner for a missing pack folder, or the PATH or package-manager command.

am adds checks per part (proposed names): `am.source` (signed, or "unsigned, from <source>"),
`am.sequence`, `am.artifact` (the kept artifact still matches its sha256), `am.writes` (each
declared literal path present; a glob is the part's own doctor's to check), `am.capabilities`
(no unmet `requires`, no two providers). `am doctor` exits 1 when any part is broken, else 0.
RFC 0013's switch reads it to show "Set up".

### The install record

`~/.automagik/parts.json` (`$AUTOMAGIK_HOME/parts.json`), written only by am, keyed by machine
(rule 3). For each part: id, version, source (release, path or git), sha256, signed, and
(proposed) state (`installed` or `disabled`), lane and sequence, provides, the kept artifact's
path, who confirmed an unsigned source and where, and when. Proposed: writes go through one lock
file (an exclusive create, as RFC 0014's registry does) and an atomic rename.

**The parts store** (t22n and t259, 2026-11-03). am keeps the whole verified extract of each
installed artifact, not only its manifest, at `~/.automagik/parts/<id>/<version>/` (a pack's
members share `herdr.pack`'s: one tarball, kept once), with `current` and `previous` links
swapped by one rename, and prunes every other version, so the store holds exactly what rollback
needs. Every later `uninstall`, `doctor` and `rollback` entry runs from that stored copy and
its stored `part.json`, never from the live mods folder: am never re-reads a manifest from a mod
folder after the install, so a switched-off or edited folder cannot change what am runs. am's
own part is the first in the store (delivery 1): `parts/automagik.am/` with a `record.json`
(the current and previous versions, each with its sequence, source, sha256 and `part.json`, and
the highest sequence taken) that delivery 3 folds into parts.json.

**One install authority at a time (rule 2).** During the bridge cycle the pack marker,
`<app home>/automagik-herdr/installed-by-install.sh` (version, mods, sequence, usagemeter
machines and scope, the rollback set), stays the record for herdr parts. am reads it and never
writes it; parts.json only points to it. The herdr entries write it, through `update.mjs`, as
`install.sh` does today. After the bridge, am migrates the marker once, the herdr entries stop
writing it, and parts.json becomes the only record.

### Machines and fleet installs

`targets: fleet` means every connected Herdr machine, under the part's own consent (local,
everywhere, none), as am-quota and usagemeter ask today. `am install <id> --machine M` installs
on one machine. Decided (D35): a path source is refused with `--machine`, and parts.json is
keyed by hc's machine name. Proposed:

- am runs the far side as `hc exec --on M am install <id> --json`. For a release part the far am
  fetches from its own pointer and verifies with its own trust anchor.
- When the far side has no am (`hc exec` reports the command missing), am offers to bootstrap
  it there with the bootstrap one-liner (D35), which verifies `am-lane` itself, and goes on
  only on the person's yes.
- An unsigned source over `--machine`: the person confirms here (D35). am sends the far side the
  source and the pinned commit, never a "trusted" flag. The far am fetches that exact commit,
  refuses it unless the commit id matches, and records `signed: false`, confirmed on this
  machine. A path source is refused with `--machine` (D35: whose path would it be?).
- `am doctor --machine all` runs each machine's doctor in parallel with a timeout per machine; a
  machine that does not answer is one line, `ok: false`, with its error.
- parts.json is keyed by hc's machine name (D35). This machine writes its own entry; a remote's
  entry here is only its last report, marked with when it came.

### Operating systems

Supported targets are D28's: macOS arm64, Linux x86_64 and aarch64, and Windows x86_64 via WSLC
(amended by [RFC 0016](0016-windows-wslc.md), D38 and D39), all three at once (D27). Intel Macs
and Windows on ARM are not supported: the code set is refused there, and RFC 0013's switch never
shows. am refuses a part whose `os` does not list this one, and its doctor reports 2. The herdr
parts list only `macos` today; deliveries 5 (Linux) and 6 (Windows via WSLC) port them, and "Set
up" ships only when `am install code` passes on all three. Argv entries and running `node` by
am's own path keep entries portable.

On Windows, `am` and every part whose `os` lists `linux` run inside the WSL container guest,
where am sees Linux; `os` stays OS-only (D35). Only the desktop app, herdr-app and the pack's mod
files (loaded by herdr-app) live on Windows; the desktop app installs those and reports them
into the guest's parts.json. `~/.automagik` is the guest's (`/home/automagik/.automagik`). There
are no `.cmd` shims and no Windows PATH entry.

### The sandbox

D27's one install is "sandboxed"; RFC 0013 (Decided 2) puts herdr-app on now and the fence later.
Proposed, after RFC 0010's supervision design (0010 is Queued): entries get an allowlisted
environment (the `AM_*` variables, `HOME`, `PATH`, `USER`, `LANG`, `TMPDIR`, `HERDR_APP_HOME`,
and Windows' system variables), never a spread of am's own. Entries run outside the DSH server
fence, as RFC 0013's launch does, because they write outside any instance home. `writes` is the
list a later fence enforces; for now doctor checks it and the part's own uninstall removes it.

Rule 7: am and the gate refuse a manifest whose `writes` names anything Herdr owns
(`shared.json`, `data/`), or overlaps another part's `writes` (the same path, a glob that matches
it, or the same `file#key`), unless the manifest `replaces` that part. Code gap: `parts.mjs`
refuses the fixed list (`REFUSED_WRITES`) but checks no overlap between parts; the check will
scan every tracked `part.json` in the repository, `am/` included (t2zx). A glob such as
`**/.claude/settings.local.json` is removed only by the part's own uninstall entry, from the
files it recorded (the hooks journal), never by am expanding the glob.

### Updates

`am update` updates am first, then every installed part from its own pointer (D22). It never
becomes a second writer where a part already updates itself: DSH plugins install only through
DSH (`dsh plugin`) and apply their updates on their own (D25), and the desktop app keeps its
feed. For those, `am update` asks the owner (the desktop app) and reports.

## Contracts introduced

- **`part.json`** at each part's root. Its `id` is permanent. Example (a pack member):

  ```json
  {
    "id": "herdr.am-footer",
    "title": "Footer",
    "kind": "herdr-mod",
    "paths": ["herdr/mods/am-footer/**"],
    "provides": ["herdr.footer@1"],
    "requires": [{ "cap": "herdr.pack", "major": 1 }],
    "os": ["macos", "linux", "windows"],
    "targets": "local",
    "artifact": "automagik-herdr-pack-{version}.tgz",
    "select": "am-footer/",
    "entry": {
      "install": ["node", "../am-sidebar/pack/part.mjs", "install", "herdr.am-footer"],
      "uninstall": ["node", "../am-sidebar/pack/part.mjs", "uninstall", "herdr.am-footer"],
      "doctor": ["node", "../am-sidebar/pack/part.mjs", "doctor", "herdr.am-footer"]
    },
    "writes": [],
    "set": ["code"]
  }
  ```
  (`os` as it reads after deliveries 5 and 6; today `["macos"]`.)
- **Part ids**: `automagik.am` and `herdr.app` (proposed), `herdr.pack` (proposed), the nine
  `herdr.am-*` and `herdr.layout`, and one per `apps/*` part as each owner adds it. `herdr.cli`
  is not released.
- **Capabilities** in the table above. A major is never reused for an incompatible change.
- **`automagik-am-<v>.tgz`** on every release; **`am-lane`** (`am.json`, `am.json.sig`)
  and its key (D35).
- **`~/.automagik/parts.json`** and **`~/.automagik/parts/`**. New. am is the only writer.
- **Entry variables** `AM_HOME`, `AM_PART_DIR`, `AM_ARTIFACT`, `AM_VERSION`, `AM_SEQUENCE`,
  `AM_MACHINE`, `AM_JSON`; `--purge` appended to uninstall. **Entry result**
  `{part, ok, changed, detail}`.
  **Doctor lines** `{part, check, ok, detail, fix}` (proposed: plus `machine`) and exit codes
  0, 1, 2. **`writes`** prefixes `~/`, `**/`, and proposed `$HERDR_APP_HOME/`.
- **`am` verbs** above; `automagik-herdr` unchanged and byte-identical, now linked by am.
- **`<app home>/mods-disabled/`** now also holds pack members switched off by am. Compatible: the
  mod manager already uses it, and `verifyInstall` and `repair` already leave it alone.

## Threat model

- **Who controls what.** Every entry runs as the person, with the person's rights. A Bot running
  as the same user can already run any code it likes; am's checks stop am from being the easy
  path for an injected or mistaken install, and make what was installed visible. They are not a
  wall against code already running as the person.
- **Unsigned sources** (path, git, a named version). They need the person's yes (D35): the
  Automagik window's dialog, or a prompt outside any Herdr terminal and outside DSH. A TTY
  alone proves nothing, since Herdr panes are real terminals. am tells a Herdr terminal or a
  DSH tool call by its environment and parent processes; same-user code can fake those, which
  is the limit above. The window's dialog is the stronger path: it needs a real click in
  another process.
- **am's key.** am updates itself from `am-lane`, so whoever holds its key can ship an am that
  runs any code on every machine that has am, with a pack or without. Preferring an installed
  `pack-keys.json` does not help: the new am is the code doing the checking. It is the most
  valuable key in the release, kept as its own secret, with the same two-slot rotation and
  fail-closed posting as the pack's; a suspected leak is answered by rotating it.
- **Release parts.** As safe as their pointer's key (RFC 0011). A replayed older pointer is
  refused by sequence. Someone who can write release assets but has no key can only deny updates.
  `herdr.app` trusts herdrdev's host for its bytes and sha256, as RFC 0013 already does.
- **Fleet.** `hc exec` runs any command on a connected machine, so whoever controls the hc fleet
  controls its machines; am adds no boundary there. What am adds: the far side verifies a release
  part with its own keys, and an unsigned one only at the commit the person confirmed, so what
  runs is what was approved, not whatever the source serves later.
- **Entries writing outside their folder.** `writes` is declared and checked; rule 7 stops a part
  from claiming Herdr's files or another part's. Not enforced by a fence yet.
- **Undo.** Every install keeps the previous artifact; `am rollback` and `am uninstall` undo it.
  A `--purge` cannot be undone.

## Deliveries

Each delivery is one PR on one lane, with its check and rollback. RFC 0013 delivery 7 ("Set
up") waits on deliveries 1, 3, 4, 5 and 6 and on the bootstrap (D35), and ships only when its
check passes on all three OSes.

1. **The am part** (am lane, D35). The dispatcher, help, `--json`, exit codes, the
   top-level Bot verbs and the briefing, with byte-equal copies of the sidebar modules they
   import; the `automagik-herdr` alias; `automagik-am-<v>.tgz` on every release (`release.yml`,
   amending RFC 0011) and the signed `am-lane`;
   am's self-update and rollback; `scripts/lane.ts` reads part paths (same PR, per the handoff).
   *Check:* every verb's output is byte-identical under `am` and the pack's `automagik-herdr`,
   `whois --json` included; the copies test passes; every lane kind attaches the tarball; on a
   temp home, `am update` moves to a newer `file://` pointer signed by a per-run key, refuses a
   lower sequence, and `am rollback automagik.am` goes back; this on macOS, Linux and Windows.
   *Rollback:* revert. The pack's `automagik-herdr` is still linked and works.
2. **Herdr part manifests** (herdr; t2zx, `feat/herdr-parts`). `part.json` for every member, the
   layout and `herdr.pack`; `pack/part.mjs`; the CLI files leave `am-sidebar/bin/`, and the pack
   stops linking `automagik-herdr` (ships after delivery 1 is released); `$HERDR_APP_HOME/` in
   `writes`; the overlap check in `parts.mjs --check`; switched-off members kept off by updates
   and rollbacks (`0deadda2`).
   *Check:* the pack's gate with `parts.mjs --check`, which fails two manifests that write the
   same path; `herdr-app check`, `catalog.mjs` and `entries.mjs --check` accept the files; each
   doctor prints valid lines and exits 0, 1 or 2; a member in `mods-disabled/` stays there
   across an update and a rollback; after the update, `automagik-herdr` resolves to am's.
   *Rollback:* revert the pack. An older pack relinks its own CLI on install.
3. **Parts, local, release source** (am). Resolver, parts.json, install, uninstall, doctor,
   rollback and update; reads the marker during the bridge. am takes the briefing hooks over
   (t22n, 2026-11-03): their command starts through am's own runner
   (`parts/automagik.am/current/bin/run.sh`) instead of the sidebar's `bin/run.sh`, and am
   migrates every project's hook to it the way `migrateHooks` moves them today (each settings
   file backed up, the journal kept), and back on `am uninstall automagik.am`. The sidebar
   guard's last reason then lifts by itself.
   *Check:* on a temp home with `file://` pointers signed by per-run keys: `am install code` then
   doctor exits 0; after it, no project hook names `mods/am-sidebar/bin/run.sh`; a doctor forced
   to fail rolls back; a lower sequence is refused; `am uninstall
   herdr.am-quota` switches it off, an update keeps it off, `am install` puts it back; `am
   uninstall herdr.am-sidebar` switches the sidebar off while am, the pack and a Bot's briefing
   keep working; `am uninstall herdr.pack` removes the pack, keeps user data and leaves am.
   *Rollback:* revert; `install.sh` and the pack's updater still work, and the marker is intact.
4. **The herdr-app part** (am; after #238). `herdr.app`'s entries on the copy of
   `herdr-update.js`.
   *Check:* with a fake feed: no herdr-app ends on the feed's build, sha256 checked; an older
   one is updated; a mismatched sha256 installs nothing; uninstall leaves an adopted herdr-app;
   on the three OSes, the real feed's build installs and `herdr-app status` answers.
   *Rollback:* revert; herdr-app stays installed, and the switch's own update check still works.
5. **Linux port** (herdr, and am where needed). `os` gains `linux`; `part.mjs` stops refusing
   it; the launcher and `install.sh` (POSIX sh) and every herdr doctor run there.
   *Check:* `am install code` on a fresh Linux x86_64 and aarch64 runner (#191's harness), then
   doctor exits 0 and Herdr opens with the pack.
   *Rollback:* revert; Linux goes back to "not applicable".
6. **Windows via WSLC** (herdr, and am where needed; amended by RFC 0016). The guest runs `am
   install code` as on Linux; the desktop app installs herdr-app and the pack's mods on the
   Windows side and reports them into the guest's parts.json. am-quota reads the guest's Claude
   Code credentials through the machine, not a Windows credential store (0016, Q9).
   The desktop app is the only writer of the pack's mods on Windows; the guest's `am doctor`
   shows its last report for those parts, and a missing or failing report fails them.
   *Check:* on RFC 0016's Windows runner (GitHub's hosted runners have no nested
   virtualization), `am install code` in the guest, then `am doctor` exits 0 and Herdr opens
   with the pack, its spaces on the `linux` machine.
   *Rollback:* revert; Windows goes back to "not applicable".
7. **Unsigned sources** (am, then desktop). Path and git sources, `--version`, `replaces`; the
   confirmation prompt outside Herdr terminals (am), and the Automagik window's dialog (desktop,
   a second PR).
   *Check:* a fork of the sidebar with the same `provides` swaps in and back; two providers are
   refused; doctor lists the fork as unsigned; inside a Herdr terminal with no window, an unsigned
   install is refused; the dialog's yes is recorded.
   *Rollback:* revert; an installed fork stays, listed as unsigned, until it is uninstalled.
8. **The `apps/*` parts** (one PR per owner and lane): Bot team and plugins (plugin, through
   `dsh plugin`), pets and the desktop app (t259's worker), usagemeter (t22b), Pocket and Pocket
   Link (t16r).
   *Check:* each part's doctor in `am doctor`; `am install work` on a fresh machine.
   *Rollback:* revert each; the part's own updater is unchanged.
9. **Fleet** (am). `--machine`, `targets: fleet`, `am doctor --machine all`, the far-side
   bootstrap.
   *Check:* two machines in a test Herdr (the second over `hc machine add` with a command);
   install and doctor on both; a machine with no am is bootstrapped after a yes; a git source
   whose commit differs on the far side is refused; a dead machine is one failed line.
   *Rollback:* revert; local installs are unaffected.
10. **The bridge ends** (herdr and am). am migrates the marker into parts.json once; the herdr
    entries stop writing it.
    *Check:* migration twice gives the same file; an old pack updater still reads a marker left
    in place.
    *Rollback:* the migration leaves the marker where it was, read-only; reverting goes back to
    it.

## Open questions

The owner answered the rest on 2026-11-03 (D35 additions, under Decided). One question is left.

5. **usagemeter's trust** (owner: t22b). Its `SHA256SUMS` proves integrity, not provenance
   (handoff). Recommended: sign a usagemeter pointer as `herdr-lane` does, or pin its hash in
   the part.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #768, #815.
- Merged changes that cite this RFC: #203, #205, #252, #254, #258, #263, #265, #288, #292, #300, #302, #330, #427, #751, #783, #806 (last merged 2026-11-09).

## Links

- Handoffs: `~/.config/herdr-app/handoffs/pocket-into-automagik-monorepo.md` ("One `am` CLI",
  "Parts"); `bot-system-unification.md` (D22, D25, D27, D28, D33, D35);
  `herdr-parts-questions-t2zx.md` and `herdr-parts-for-rfc-0012.md` (t2zx).
- RFCs: [0010](0010-desktop-sandbox.md) sandbox, [0011](0011-monorepo-parts-and-releases.md)
  parts and releases, [0013](0013-work-code-switch.md) the switch (delivery 7),
  [0014](0014-shared-bot-registry.md) the Bot registry, [0016](0016-windows-wslc.md) Windows
  via WSLC (amends the Windows target and delivery 6).
- Code: `herdr/install.sh`, `herdr/mods/am-sidebar/update.mjs` (`stagePack`, `verifyInstall`),
  `release.js` (`PACK_MODS`), `herdr/mods/am-mods/core.js` (`OFF_DIR`), `scripts/herdr-lane.ts`,
  `scripts/lane.ts`; `apps/desktop/src/herdr-update.js` (#238). Branch `feat/herdr-parts` (t2zx,
  `6b5dbba5`: `bin/part.mjs`, `herdr/scripts/parts.mjs`). Cross-OS harness #191.
