# RFC 0017: usagemeter in the monorepo

| Field | Value |
|---|---|
| Status | In delivery (deliveries 1, 2, 4, 5 and 6: #751, #783, #822, #834, #836, #838; deliveries 3, 7, 8 and 9 open; answers: Q1-Q6 and Q8, 2026-11-08; question 7 open) |
| Milestone | none (ships outside the five milestones) |
| Lanes | meter (3.N.P), added here; herdr (3.N.P) for the cutover |
| Created | 2026-11-08 |

## Summary

usagemeter, the Rust token meter every machine runs from `~/.local/bin/usagemeter`, moves from
`automagik-dev/usagemeter` into this repository with its history, as `meter/usagemeter/`. It
becomes a `binary` part (RFC 0012) on its own lane: a meter-only merge is a `meter` patch that
builds the meter alone, with no desktop build and no plugins. Its builds are found through a
signed rolling `meter-lane` pointer with a key of its own, the way the pack's and am's are
(RFC 0011, RFC 0012), which proposes an answer to RFC 0012's question 5. This repository also
becomes the keeper of the `herdr-meter` doc the meter writes: its schema and fixtures live here,
and every reader, genie included, tests against them.

## Motivation

The owner decided (2026-11-03) that everything Automagik ships ends up in this monorepo. The
herdr pack and Pocket came in with their history (RFC 0011); usagemeter is the last part still
released from its own repository. Three things follow from where it is today:

- Trust. The pack installs the meter from a pinned GitHub release of another repository: one
  version and four sha256 values in `herdr/mods/am-sidebar/release.js` (`USAGEMETER`), copied
  into `herdr/install.sh` and `am/`. The release's own `SHA256SUMS` proves integrity, not who
  published it. RFC 0012 left this open as question 5.
- Two releases per change. A meter fix reaches a machine only after an upstream release and then
  a herdr patch that moves the pin, its hashes and the copies.
- The doc has no keeper. The `herdr-meter` doc's schema is a README section upstream. Pocket
  reads it (`Spend.kt`, `SpaceFeed.kt`), genie will, and nothing here tests a reader against what
  the meter writes.

The closed draft automagik-dev/automagik#298 planned the import inside RFC 0011 and is the
starting point here. This RFC replaces it: its folder, trust step and schema keeping differ, as
said below.

## Decided

The owner's answers to this RFC's questions 1 to 6 and 8 (2026-11-08):

- Folder: `meter/usagemeter/`.
- History: the whole upstream history is imported, its first nine commits included.
- Upstream's open pull requests automagik-dev/usagemeter#6 and automagik-dev/usagemeter#7 merge
  upstream first; the final import is pinned to upstream `dev`'s last commit, and upstream is
  frozen after it.
- The Intel Mac build stays for good: every meter release ships `usagemeter-darwin-x86_64`, and
  it is not dropped after the cutover. D28 still drops Intel Mac for every other part; the meter
  is the one exception.
- The Intel Mac route (question 8): am runs on an Intel Mac for its meter verbs only (`am meter
  install`, `am meter status`, `am meter uninstall`), and every other part and the code set
  stay refused there.
- The standalone installer is retired for `am meter install`. The upstream bridge release points
  there, and Pocket Link's docs follow.
- The capability is `meter.usage@1`. Its major is not tied to `schema_version`: the doc keeps
  `schema_version` 2. genie's reader moves to `meter.usage@1`, coordinated with genie's design.

From the Meter Captain's brief (2026-11-08); the owner confirms them when scheduling this RFC:

- usagemeter moves into this repository and ships from it as a part of its own.
- This repository keeps the `herdr-meter` output contract: a schema file and fixtures that the
  readers' tests read. genie (genie-rs) is a reader, so any schema change comes through a pull
  request here.
- cargo runs only on the build host, one build at a time behind the host's shared gate lock,
  with `CARGO_BUILD_JOBS` capped. Cross-target release builds and the OS matrix run on CI.
- Ports of genie's metering come later, from genie's specs and acceptance tests, and are built
  under this RFC's contract.

Proposed here: everything else. Where a sentence proposes rather than records, it says so.

## Design

### Where the crate lives

Decided: `meter/usagemeter/`, the crate as it is upstream (`Cargo.toml`, `Cargo.lock`, `src/`,
`tests/` and its `install.sh`), with its own `part.json` at its root. Upstream's `scripts/` held
only `version.sh`, which the import drops: `scripts/version.ts` sets the crate's version instead.

- `meter/` is already Meter's folder: `meter/statusline` (the Claude Code status line and the
  limits logger) sits there, and the Meter Captain owns both. One folder per product keeps
  `meter/` the one place to look, and keeps the lane rule short.
- Not `apps/usagemeter/` (automagik-dev/automagik#298's choice). `apps/` holds the DSH plugins
  and the apps; a folder there that is not a plugin reads as a desktop change in every rule
  written for `apps/`.
- Not `crates/usagemeter/`. There is one crate. A `crates/` folder would suggest a shared Cargo
  workspace for the whole repository, which nothing else needs. If genie's ports add crates,
  they go beside it under `meter/`, and whether `meter/` then gets a workspace is decided with
  them (RFC 0018).

### The import

It lands as a history import, like `herdr/` and `apps/pocket/` (RFC 0011, "Importing a
repository with its history"):

- `scripts/import-usagemeter.sh`, copied from `import-pocket.sh`, clones upstream `dev` into a
  temporary folder, runs `git filter-repo --to-subdirectory-filter meter/usagemeter` there
  (never in this repository) and merges with `--no-ff --allow-unrelated-histories`, without
  tags. It refuses a database, a key or an `.env` anywhere in the history.
- It drops upstream's `.github/` (CI moves to the root workflows) and `.herdr/` (the project's
  bots belong to the repository's own `.herdr/`). It keeps the crate's `LICENSE` only if it
  differs from the root's.
- The pull request merges as a merge commit, never squashed or rebased, so the imported commits
  keep their ids; `commitlint.yml` already skips an import merge's second-parent history.
- Upstream has two open pull requests, automagik-dev/usagemeter#6 (worker-ledger tagging) and
  automagik-dev/usagemeter#7 (the state folder `~/.automagik/meter`). Decided: both merge
  upstream first, the final import is pinned to upstream `dev`'s last commit, and upstream is
  frozen after it.
- No old tags come in: `v0.1.0` to `v0.3.0` are not releases of this repository.

### Version

One version. `scripts/version.ts` learns the crate's two places, `Cargo.toml`'s
`[package] version` and the crate's entry in `Cargo.lock`, and the import sets both to the
current 3.N.P, so `dev` never holds a 0.3.0 crate. The binary keeps printing
`usagemeter <version>` from `CARGO_PKG_VERSION`. The jump from 0.3.0 to 3.N.P is safe: every
installer compares versions field by field as numbers and never downgrades.

Every `chore(release)` commit bumps those two lines. Once the crate ships (delivery 4),
`scripts/lane.ts`'s `versionOnly` must count them as a release's own bump, as it counts the
JSON and plain-text version files today; otherwise each release's bump would look like a meter
change and cut another release.

### The part

Proposed `meter/usagemeter/part.json`:

```json
{
  "id": "automagik.usagemeter",
  "title": "usagemeter, the token meter",
  "kind": "binary",
  "paths": ["meter/usagemeter/**"],
  "provides": ["meter.usage@1"],
  "requires": [],
  "os": ["macos", "linux"],
  "targets": "fleet",
  "artifact": {
    "darwin-arm64": "usagemeter-darwin-arm64",
    "darwin-x86_64": "usagemeter-darwin-x86_64",
    "linux-x86_64": "usagemeter-linux-x86_64",
    "linux-aarch64": "usagemeter-linux-aarch64"
  },
  "entry": {
    "install": ["am", "meter", "install", "--local"],
    "uninstall": ["am", "meter", "uninstall", "--local"],
    "doctor": ["am", "meter", "doctor"]
  },
  "writes": ["~/.local/bin/usagemeter", "~/.automagik/meter/**"],
  "set": ["code"]
}
```

- `id` is permanent once released. `kind: binary`, like `automagik.am`.
- `provides`: the usage data it writes, as the capability `meter.usage@1` (decided). Its major
  is not tied to the doc's `schema_version`, which stays 2 (below). A fork that writes the same
  doc keeps it and names this part in `replaces`.
- `os`: macOS and Linux. Windows runs it inside the WSL container guest (RFC 0016), where am
  sees Linux and the Linux build already works.
- `targets: fleet`: every connected machine, under the part's own consent, as `am meter install`
  asks today (`--local`, `--linked`, `--machine`).
- `artifact`, per target. RFC 0012's `artifact` is one name with `{version}`; a binary has one
  asset per target. Proposed: `artifact` may also be an object from target (`<os>-<arch>`, the
  names `meterFleet.js`'s `PLATFORMS` maps `uname -sm` to) to asset name. Code gap: am's reader
  and `parts.mjs` accept a string only. The names stay today's, because a versioned release
  already holds the version, and the binary installs under one fixed name anyway.
- Intel Mac: `darwin-x86_64` is a target for good (decided). am applies D28's targets to every
  part (RFC 0012), and D28 leaves out Intel Mac; the meter is the one exception, so am takes a
  binary part's targets from its `artifact` keys when it has them. Code gap: am and `parts.mjs`
  know D28's targets only.
- How an Intel Mac gets the meter (decided, question 8): am runs on an Intel Mac for its meter
  verbs only (`am meter install`, `am meter status`, `am meter uninstall`), with every other part
  and the code set still refused there. Code gap: RFC 0012's am refuses an Intel Mac outright,
  its bootstrap included; delivery 7 says how am gets there.
- `entry`: a binary has no folder to run from, so its entries are am's own `meter` verbs.
  Proposed: an entry whose first word is `am` runs the am that is installing. Code gaps: today
  `meter uninstall` takes no `--local`, and there is no `meter doctor`.
- `writes`: the binary, and the state folder automagik-dev/usagemeter#7 moves to. Before it,
  the state is `~/Library/Application Support/automagik/` on macOS and
  `~/.local/state/automagik/` on Linux; that pull request migrates it once. The `herdr-meter`
  doc is written to herdr-core, not to a file, so it is not a `writes` entry; its contract is
  below.
- No `herdr` manifest declares `~/.local/bin/usagemeter` (RFC 0012), so rule 7's overlap check
  passes. `install.sh` and the pack's `meter install` keep writing it until the cutover; after
  it they install through the same pointer this part uses.

### The lane

- `scripts/lane.ts` reads the meter's paths from its `part.json`, as it reads am's (`amPaths`):
  `METER` beside `AM`, `HERDR` and `POCKET`.
- `kindOf` gains `meter`: a release whose shipping changes since the last release are all the
  meter's (with or without am's) is a `meter` patch, 3.N.P, with the meter's assets alone: no
  desktop build, no plugin tarballs, no new plugin lane, no market pin, not Latest.
- The meter's changes never make a release more than it is otherwise, the rule am has: meter
  with herdr is a `herdr` patch, meter with Pocket a `pocket` patch, meter beside plugins a
  `plugins` patch. The meter paths are skipped in the plugin loop as `HERDR`, `POCKET` and `AM`
  are, so they never make a release `full`.
- Whether a release builds the meter is its own question, whatever the kind:
  `bun scripts/lane.ts meter <tag>` (yes or no), as `herdr` and `pocket` are. The tag is
  `meter-since`: the version `meter-lane` names, or the last release when there is no lane yet.
  Pocket's reason applies: a prerelease never moves the pointer, so a meter change that shipped
  only in a prerelease is still ahead of the lane and the next release builds it again.
- `release.yml`: every condition that reads "not herdr and not pocket" today also excludes
  `meter`, with `release-workflows` tests. `desktop-build.yml`'s sweep spares the meter's assets.

### What never ships

`meter/` leaves `NEVER_SHIPPED` as one prefix. The pattern `/^meter\//` becomes:

```
/^meter\/(statusline|schema)\//
```

- `meter/statusline` stays a local tool run from a checkout on the owner's machine. No release
  carries it. Its gate stays `ci.yml`'s `meter` job (`node --check meter/statusline/*.mjs` and
  `node --test 'meter/statusline/test/*.test.mjs'`), whose path filter narrows to
  `meter/statusline/`.
- `meter/schema` (below) is read by tests and by other repositories at a commit, never by an
  install.
- Inside the crate, these never ship either: its top-level `*.md` and its `tests/` (Rust's name,
  which `(^|\/)test\/` does not match):
  `/^meter\/usagemeter\/[^/]+\.md$/`, `/^meter\/usagemeter\/tests\//`.
- The crate ships: a change anywhere else under `meter/usagemeter/` rebuilds it. Its gate is a
  new `usagemeter` job in `ci.yml`, path-gated on `meter/usagemeter/`, `meter/schema/`, the CI
  and release workflows, `scripts/lane.ts` and `scripts/version.ts`: `cargo fmt --check`,
  `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` on Linux and
  macOS, plus the installer's test while the installer exists. Its actions are pinned by SHA, as
  every action here is.
- A file directly under `meter/` that is neither (a future `meter/Cargo.toml`) matches no part
  and would cut a full release. That is on purpose: it is decided with RFC 0018.

### Release and trust

On a release that builds the meter, a CI job builds each of the four targets from the tag (macOS
arm64 and x86_64, Linux x86_64 and aarch64; the Linux builds static, musl, and checked to be
static) and attaches the binaries and `usagemeter.SHA256SUMS` to
`vX.Y.Z`. The checksums file is renamed because a full release's desktop build writes its own
`SHA256SUMS` to the same release. Then a pointer says which build is newest.

Three ways to make that pointer trustworthy:

| | A. `meter-lane`, its own key | B. Reuse a key | C. Hash pinned in the part |
|---|---|---|---|
| How | a signed rolling pointer, `METER_LANE_KEY`, two slots | `herdr-lane` or `am-lane` signs the meter too | `part.json` (or `release.js`, as now) names each build's sha256 |
| Provenance | yes, for any installer that has the keys | yes | yes, through whatever signed thing carries the pin |
| Meter update needs | one meter patch | one release of the other lane too | a meter release, then a second pull request and release to move the pin |
| A key leak reaches | the meter only | the meter and the other lane | the carrier's lane |
| Cost | one secret, one script, one rotation to run | none new | none new, a pin to keep in step |

- **B** is against the rule every lane here follows (AGENTS.md, RFC 0011, RFC 0012): each lane
  has its own key, so a leak of one does not reach another. Reusing `am-lane`'s key would make
  the most valuable key sign more often, and tie the meter's rotation to am's. Reusing the
  pack's would leave machines without a pack (work-only machines, a fleet machine reached by
  `meter install --machine`) with no trust anchor of their own.
- **C** is what runs today, and its weakness is structural: a build's sha256 exists only after CI
  builds the commit, so a pin can never be in the commit it pins. Every meter change becomes two
  releases, and the pin always trails. It also needs the carrier (the pack, or am) to release
  for the meter to move.
- **A** costs one more secret and one more rotation, and gives the meter what every other lane
  has: one release per change, provenance on every machine, and a blast radius of one.

**Recommended: A.** A rolling `meter-lane` release, made like `herdr-lane` and `am-lane`:

- It holds only `meter.json` and `meter.json.sig`. `meter.json` names the newest meter build:
  `schemaVersion`, `publisher`, `part` (`automagik.usagemeter`), `keyId`, `sequence` (3.N.P as
  N·10000 + P), `issuedAt`, `repository`, `version`, `tag`, `commit`, and per target the asset's
  name, URL, sha256 and size. The signature is ed25519 over its exact bytes, detached, base64.
- The key is `METER_LANE_KEY`, the meter's own, never `PLUGIN_LANE_KEY`, `HERDR_PACK_KEY` or
  `AM_LANE_KEY`. Two slots, `METER_LANE_KEY` and `METER_LANE_KEY_NEXT`; the variable
  `METER_LANE_SIGNER` names the one releases sign with. The workflow uses only the selected
  slot, even when its secret is empty. `bun scripts/meter-lane.ts keygen`
  generates the pair in memory and pipes the private key straight to `gh secret set`: never
  printed, never on disk. Only then does it add the public key to
  `meter/usagemeter/meter-keys.json`. A rotation is RFC 0011's two phases: keygen fills the slot
  that is not signing, a release ships the new public key, and only later does
  `METER_LANE_SIGNER` switch.
- Trust anchors: `meter-keys.json` ships with the meter's installers. am carries a copy, as it
  carries `pack-keys.json` and the plugin lane's keys, kept equal by `scripts/am-copies.mjs`. The
  pack carries one beside `meterFleet.js`, and `herdr/install.sh` embeds it, kept equal by a test.
- `meter-lane.ts check-key` runs before the tag when the release builds the meter, which the lane
  allows only once a key is listed (below): a secret that is missing or none of the listed keys
  stops the release there. `meter-lane.ts posted`
  never posts a lower sequence than a posted pointer that verifies. It fails closed: an
  unreadable or unverifiable posted pointer stops the post unless the release is dispatched with
  `replace_unverified_meter_pointer`. The post is a job of its own (`meter-lane`, after the build),
  so its refusals stop no other lane.
- The key comes first (decided by Chat, 2026-11-09: no public unsigned meter binary). While
  `meter-keys.json` lists no key, the meter lane is held: no release builds, attaches or signs the
  meter, and the crate's changes ship nothing (`lane.ts` `meterHeld`, which also holds it until RFC
  0021 delivery 2's contract is in). Every meter build a release attaches carries its signed
  `meter.json` and `meter.json.sig` on `vX.Y.Z`, a prerelease's included. Installers keep the pin
  (below) until then.
- No downgrade, on the installing side: an installer refuses a pointer whose version is older than
  the installed binary's `usagemeter --version` or whose sequence is lower than the one it
  recorded, and keeps the shared-binary rule that a newer or unversioned binary is left alone.
  `--version <v>` installs a named release, checked against that release's
  `usagemeter.SHA256SUMS` alone, recorded unsigned, and confirmed as RFC 0012 asks.
- The rolling release is created once with `--prerelease --latest=false`, never edited, never
  Latest, never a `v*` tag, and written only by its job with `gh release upload --clobber`.

### How meterFleet moves to the pointer

Today `meterFleet.js` (the pack's, and am's byte-equal copy) installs `USAGEMETER.version` from
`automagik-dev/usagemeter`: each machine downloads its asset and the release's `SHA256SUMS`,
checks both against the pinned sha256, and renames into place. The move, in order:

1. The owner runs `meter-lane.ts keygen`, and `meter-keys.json` merges. The key comes first
   (Chat, 2026-11-09): that merge opens the meter lane, so the first release here that carries the
   meter's assets is already signed and posts `meter-lane`. The copies of `meter-keys.json` in am
   and the pack follow.
2. The pin moves to that release in a herdr patch: `USAGEMETER.repo` becomes this repository,
   `version` and `sha256` that release's, the checksums file `usagemeter.SHA256SUMS`, and
   `install.sh`, `usagemeter-pin.mjs` and the tests follow. This is the bridge until step 3.
3. `meterFleet.js` reads the pointer on the machine running it, verifies it with its
   `meter-keys.json`, and picks each machine's asset by `uname -sm`. The far side keeps its fixed
   script: it downloads the asset from `vX.Y.Z` and checks it against the sha256 passed as an
   argument, now taken from the verified pointer instead of `release.js`. `install.sh` does the
   same. `USAGEMETER` keeps only the repository and the lane's name; its version, hashes and
   `usagemeter-pin.mjs` are retired.
4. upstream cuts one bridge release whose README points to `am meter install` (its standalone
   installer is retired, as question 5 decided), an install is seen updating from this
   repository, and upstream is archived, never deleted.

### The `herdr-meter` doc

`usagemeter sync` writes one doc per machine, named `herdr-meter`, to that machine's herdr-core;
readers fetch it with `doc.get`. It stays under 64 KiB. Today Pocket is the only reader in this
repository (`Spend.kt` for the numbers, `SpaceFeed.kt` for the `space` block); the herdr sidebar
only runs `usagemeter sync` and never reads the doc.

Version 2, top level. "Read" marks what a reader here uses today:

| Field | Read | Meaning |
|---|---|---|
| `kind` | yes | always `herdr-meter` |
| `schema_version` | yes | 2 |
| `generatedAt` | yes | when the doc was written, UTC, RFC 3339 |
| `machine` | yes | herdr-core's core id, so a machine reached twice counts once |
| `complete` | yes | `false` while a first import runs |
| `prices` | `date` | the price table's `date`, `source`, `label` |
| `windows` | yes | start of `d1`, `d7`, `d30`, each ending at `generatedAt`'s hour |
| `projects[]` | yes | per repo: `repo` (`host/owner/repo` or null), `tasks`, `hours`, `usd_per_task`, `d1`/`d7`/`d30`; also `last`, `untasked` |
| `projects_other` | yes | the repos cut to fit, summed; absent when none were |
| `tasks[]` | yes | per task (repo and branch): `repo`, `branch`, `agents[]`, `hours`, `d1`/`d7`/`d30`; also `first`, `last`, `bots` |
| `tasks_other` | presence | the tasks cut to fit; absent when none were |
| `hourly` | yes | `from` and `series[]` per harness of `in`, `cr`, `cw`, `out`, `usd` arrays, value `i` at hour `from + i`; also `hours` |
| `truncated[]` | yes | what was cut to fit, in order |
| `sources` | `status` | per harness: `status` (`ok`, `degraded`, `unsupported`, `absent`) and its counters |
| `space` | yes | optional, with its own `version` (1): the Space Row feed per project path |
| `rows_schema`, `meter_version`, `counted_from`, `pending`, `models[]`, `daily` | no | written, not read here yet |

A token object (`d1`, `d7`, `d30`, `untasked`, `*_other`): `in`, `cr`, `cw`, `out`, `rs`
(already inside `out`), `un` (known only as a total), `usd`, `usd_rep` (the part the harness
reported), `unpriced`. A zero field is left out, and a window with no usage is left out. Total
tokens are `in + cr + cw + out + un`. The `space` block is not written by the meter yet
(automagik-dev/usagemeter#6 builds toward it); Pocket already reads `space.version` 1, so it is
part of the contract from the start, versioned on its own.

**The keeper.** Proposed: `meter/schema/herdr-meter.v2.schema.json` (JSON Schema 2020-12) and
`meter/schema/fixtures/`: a full doc, a cut one (`projects_other`, `tasks_other`, `truncated`),
one with a `space` block, a first-import one (`complete: false`), and refusals (an unknown
`schema_version`, a wrong `kind`). Who reads them:

- the crate's tests check that what `sync` writes validates against the schema;
- Pocket's tests parse every fixture through `Spend.parse` and `SpaceFeed.parse` and check the
  numbers, replacing the private `herdr-meter-space.sample.json`;
- genie's tests read the fixtures at a pinned commit of this repository.

A pull request that changes the doc changes the schema, the fixtures and the history list in the
same pull request, and says whether it bumps the version. CI runs the crate's and Pocket's tests
when `meter/schema/` changes.

**Versioning.** Adding an optional field, a new harness under `sources`, or a new block keeps
`schema_version` 2; readers ignore what they do not know. Removing a field, renaming it, or
changing its type, unit or meaning bumps it to 3. A bump ships readers first: Pocket and genie
learn version 3 before the meter writes it. A reader that meets a version it does not know shows
that machine as "update needed" and never guesses numbers (Pocket's `Unsupported` does this
today). The same rules hold for `space.version` inside the doc.

The capability `meter.usage@1` is not tied to `schema_version` (decided); the doc keeps
`schema_version` 2. Proposed: a `schema_version` bump that breaks a reader also bumps the
capability's major, so a part that requires `meter.usage@1` is never handed a doc it cannot read; an
additive change bumps neither.

### The build rule

- cargo runs on the build host only, one build at a time behind the host's shared gate lock,
  with `CARGO_BUILD_JOBS` capped (proposed: 4, the gate's worker cap).
- Heavy work runs on CI: the cross-target release builds and the Linux and macOS test matrix.
- No cargo build runs on a contributor's laptop as part of a gate. `cargo fmt --check` builds
  nothing and may run anywhere; `clippy`, `test` and `build` run on the build host or on CI.
- A worktree's `target/` goes with the worktree when it is removed.
- AGENTS.md names cargo as the one exception to "Bun for the repository's tooling", for
  `meter/usagemeter/` only, with this rule beside it.

### Ports of genie's metering

Open; the owner answers it through RFC 0018 (#764), the meter query contract, which genie reviews as
the reader. genie (genie-rs) has metering of its own; ports of it come from genie's specs and
acceptance tests. Workers build them under this RFC's contract: the meter lane, the build rule, and
the `herdr-meter` doc's keeper and versioning rules. What is ported, where it lives (modules of this
crate or crates beside it under `meter/`), and which acceptance tests come with it, is RFC 0018's to
say. genie's reader moving to `meter.usage@1` is coordinated there too.

## Contracts introduced

- Part id `automagik.usagemeter` and capability `meter.usage@1`. Permanent once released.
- Lane kind `meter`; `scripts/lane.ts meter` and `meter-since`.
- Assets on `vX.Y.Z`: `usagemeter-darwin-arm64`, `usagemeter-darwin-x86_64`,
  `usagemeter-linux-x86_64`, `usagemeter-linux-aarch64` and `usagemeter.SHA256SUMS`. The Intel
  Mac asset is part of every meter release for good.
- The rolling `meter-lane` release (`meter.json`, `meter.json.sig`), the secrets `METER_LANE_KEY`
  and `METER_LANE_KEY_NEXT`, the variable `METER_LANE_SIGNER`, the dispatch input
  `replace_unverified_meter_pointer`, and `meter/usagemeter/meter-keys.json`.
- `meter/schema/`: the `herdr-meter` schema and fixtures, now owned here. The doc's name, `kind`,
  `schema_version` 2 and every field above are unchanged, so every installed reader keeps working.
- Unchanged for installs: `~/.local/bin/usagemeter`, `usagemeter --version`'s output, the
  never-downgrade rule, the state folder, `meter.db`, `meter.lock` and the `METER_*` variables.
- `part.json`'s `artifact` may be an object per target (amends RFC 0012, proposed).
- am on an Intel Mac, for its meter verbs only (`am meter install`, `am meter status`,
  `am meter uninstall`), its bootstrap included; every other part and the code set stay refused
  there (amends RFC 0012's "Operating systems" and its D28 targets for am; decided, question 8;
  built in delivery 7).

## Threat model

- **The meter's key.** Whoever holds `METER_LANE_KEY` can ship a meter binary that runs as the
  person on every machine that installs through the pointer. It is its own secret, so a leak
  reaches the meter and nothing else, and it is answered by the two-phase rotation.
- **Release assets without the key.** Someone who can write release assets can re-post an older
  signed pointer; installers refuse it by version and sequence, and the post refuses a lower
  one. At worst, updates stop.
- **The bridge window.** Until keys are listed, the pin in the signed pack (and am) is the trust,
  as today.
- **The fleet.** As RFC 0012 says: whoever controls the hc fleet controls its machines. What this
  adds: each far machine checks its binary against a sha256 from a verified pointer.
- **Undo.** Reverting a release leaves installed binaries in place; a newer one is never
  replaced by an older one except by a named `--version` install.

## Deliveries

Each is one pull request with an independent review.

Order: 1 to 5 in turn; 6 after 4 (its pin step) and 5 (its pointer step); 7 after 6, because am
installs the meter through what 6 moves (the pin, then the pointer `meterFleet.js` reads, which am
takes through its copies); 8 when RFC 0018 says; 9 after 6 and 7.

1. **This RFC** (docs; cuts nothing).
   *Check:* `bun scripts/lane.ts ships` on the merge says no.
2. **Import and CI** (ships nothing). The history import into `meter/usagemeter/`; the
   `usagemeter` CI job; `version.ts` writing the crate's version; AGENTS.md. `NEVER_SHIPPED`
   still holds `/^meter\//`, so the merge cuts no release.
   *Check:* the job is green on Linux and macOS; `cargo metadata --locked` agrees with
   `version.ts check`; `lane.ts ships` says no.
   *Rollback:* revert; upstream still releases.
3. **The doc's keeper** (ships nothing). `meter/schema/` with fixtures; the crate's validation
   test; Pocket's tests on the fixtures.
   *Check:* a fixture with a field removed fails the crate's and Pocket's tests; one with an
   extra field passes both.
   *Rollback:* revert; readers are unchanged.
4. **The meter lane** (meter). `part.json`; `METER`, `kindOf`, `meter` and `meter-since` in
   `lane.ts`; `NEVER_SHIPPED` narrowed; `versionOnly` in `lane.ts` treats the crate's version
   lines in `meter/usagemeter/Cargo.toml` and `Cargo.lock` as version-only; the release build
   and assets; the sweep; `meter-lane.ts` and its job, warning while no key is listed.
   AGENTS.md: the Meter bullet says the crate ships on the meter lane while `meter/statusline`
   still never ships, and a meter-lane key rule (`METER_LANE_KEY`, two slots,
   `METER_LANE_SIGNER`) sits beside the herdr and am key rules.
   *Check:* lane tests: a meter-only diff is `meter`, meter with herdr is `herdr` and builds
   both, a statusline-only diff ships nothing, a `chore(release)` bump of the crate's two
   version lines cuts no meter release while a real crate change does;
   `meter-lane.test.ts` with a per-run key refuses a
   lower sequence and an unverified posted pointer; the first meter release carries all four
   assets, `usagemeter-darwin-x86_64` included; and RFC 0021 delivery 2 merged (enum widened)
   before the first meter release: the lane stays held while the query contract's
   `attribution.precision` lacks `actor_interval`, and while `meter-keys.json` lists no key
   (`lane.ts` `meterHeld`), so delivery 5's key comes before the first meter release.
   *Rollback:* revert; installs keep the pin.
5. **Keys** (the owner). `meter-lane.ts keygen`; `meter-keys.json` and its copies in am and the
   pack.
   *Check:* the next meter release posts `meter-lane` and `meter-lane.ts verify` accepts it.
6. **The cutover** (herdr, then am through its copies). The pin moves here, then
   `meterFleet.js` and `install.sh` read the pointer; `usagemeter-pin.mjs` retires; the doc links
   to the old repository are repointed; the upstream bridge release and the archive.
   *Check:* on a temp home, with a `file://` pointer signed by a per-run key, `meter install`
   installs the pointer's build, refuses a lower sequence and leaves a newer binary alone.
   *Rollback:* revert the pack; it installs from the last pin.
7. **The part in am** (am, RFC 0012 delivery 8; after 6). `am install automagik.usagemeter`, the
   object `artifact`, `meter doctor`, and `meter uninstall --local`. On an Intel Mac, am runs for
   its meter verbs only and refuses every other part and the code set.
   How am gets onto an Intel Mac at all: am is plain JavaScript on Node, so the same am tarball
   runs there, and what refuses it is RFC 0012's target check, in am and in its bootstrap
   one-liner alike. This delivery amends both: the bootstrap installs am on an Intel Mac and says
   that only the meter verbs work there, am's own update keeps it current there, and am's target
   check lets `am meter install`, `am meter status` and `am meter uninstall` through while it
   refuses every other part and the code set. An Intel Mac reached from another machine
   (`am meter install --machine`) needs no am of its own: meterFleet's fixed far-side script
   installs the binary there, as it does today.
   *Check:* `am doctor` lists the meter; install, rollback and uninstall on a temp home; with an
   Intel Mac `uname -sm`, `am meter install` works and `am install code` is refused.
8. **Ports of genie's metering.** Waits for Open question 7's answer (RFC 0018, #764).
9. **Retire the standalone installer** (meter; after 6 and 7). Remove
   `meter/usagemeter/install.sh`, its test and the CI job's installer step; repoint any doc that
   still names it to `am meter install`.
   *Check:* `git grep` finds no reference to the crate's `install.sh`; the `usagemeter` job is
   green.
   *Rollback:* revert.

## Open questions

Questions 1 to 6 and 8 were answered by the owner on 2026-11-08 and are in Decided. usagemeter's
first nine commits came from automagik-pocket's `meter/`, already here under `apps/pocket/meter/`
with other ids (deleted since); they are imported anyway, as question 2 decided.

7. **Ports of genie's metering.** Open; the owner answers it through RFC 0018 (#764), which genie
   reviews as the reader: what is ported, where it lives (this crate, or crates beside it under
   `meter/` with a workspace), which genie specs and acceptance tests come with it, and who
   reviews them. Delivery 8 waits for it.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #915.
- Merged changes that cite this RFC: #751, #764, #783, #788, #817, #822, #825, #834, #836, #838 (last merged 2026-11-09).

## Links

- RFCs: [0011](0011-monorepo-parts-and-releases.md) parts, lanes and the signed pointers;
  [0012](0012-am-cli-and-parts.md) `part.json`, "Sources and trust", Open question 5, delivery 8;
  [0016](0016-windows-wslc.md) Windows via WSLC; [0018](0018-meter-query-contract.md), the meter
  query contract (#764).
- Closed draft automagik-dev/automagik#298 (usagemeter's import in RFC 0011).
- Code: `scripts/lane.ts` (`NEVER_SHIPPED`, `kindOf`, `amPaths`), `scripts/herdr-lane.ts`,
  `scripts/am-lane.ts`, `am/part.json`, `herdr/mods/am-sidebar/meterFleet.js` and its copy in
  `am/`, `herdr/mods/am-sidebar/release.js` (`USAGEMETER`), `herdr/install.sh`,
  `herdr/scripts/usagemeter-pin.mjs`, `meter/statusline/`, `.github/workflows/ci.yml` (`meter`).
- Readers: `apps/pocket/android/app/src/main/java/ai/namastex/automagik/Spend.kt` and
  `SpaceFeed.kt`.
- Upstream: `automagik-dev/usagemeter` (README, "Summary doc schema"); pull requests
  automagik-dev/usagemeter#6 and automagik-dev/usagemeter#7.
