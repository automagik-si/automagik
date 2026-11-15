# RFC 0018: the meter query contract

| Field | Value |
|---|---|
| Status | In delivery (M0-M1: #764, #806, #814; M2, M4 and M5 not merged; M3's evidence table landed with RFC 0021's #875) |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs and fixtures cut nothing); meter (3.N.P, RFC 0017) for M1 to M5 |
| Created | 2026-11-08 |

## Summary

genie reads usage, cost and time from the meter through one command the meter owns:
`usagemeter query`, versioned, read-only and fork-and-exit, under the capability
`meter.usage@1` (RFC 0017). This RFC is M0 of genie's meter design (rev 2): it writes down,
before any meter code, the query's v1 contract, the per-call evidence the meter must keep before
anything can be called task cost, who owns each of genie's metering calculations once they move
to Rust, how old and new versions of both sides meet, and the hardware ceilings each step must
stay under. The query's JSON Schema and example responses land with it in
`meter/schema/query/v1/`, so the crate and genie test against the same files. RFC 0017 leaves
its question 7 open, to be answered here; this RFC proposes that answer.

## Motivation

The owner decided (2026-11-08) that all metering lives in the Rust meter inside this repository:
genie's usage, cost and time calculations move into it, genie-rs consumes the result, and none
of it may burn hardware. Folding task linking (the "untracked" cards) into the same plan was
also the owner's choice. genie's design for this (rev 2, reviewed by a council of three
independent lenses) splits the work into meter slices M0 to M5, built here, and genie slices S0,
S1 and R, built in genie. M0 comes first because the council's main finding was that the
boundary and the evidence must be defined before anything is projected onto a card.

What the design found, and what this RFC answers:

- **The board shows "–" on every card.** genie's Herdr board waits for a `space` block in the
  `herdr-meter` doc that the meter never wrote (automagik-dev/usagemeter#8).
- **The doc cannot be the source.** It keeps 127 of about 1,100 task rows to stay under 64 KiB,
  so a branch missing from it is not "no usage", and `complete: true` holds while rows are cut.
- **The store cannot answer task questions.** usagemeter keeps usage as hourly rollups keyed by
  bot, role, harness, model, machine, repo, branch, hour and precision (`store.rs`, the `usage`
  table), with no session key. No per-session or per-call task split, and no long-prompt tier
  price, can be recovered from it later. This is why the evidence contract (below) comes before
  any storage change.
- **Some usage has no branch.** OMP and dsh-tui log none (`omp.rs`, `dsh_tui.rs`), so their
  usage reaches the store with the repo known (from the session's working folder) and the branch
  null. While a repo has such
  usage, a branch with no rows of its own is not proof of zero.
- **Branch totals are not task cost.** The doc's `tasks[]` rows are rolling d1, d7 and d30
  windows per repo and branch: never lifetime spend, and two cards on one branch share one total.
  `hours` counts distinct hours with usage, not elapsed time.
- **The join key differs.** The meter keys work by `host/owner/repo` and branch; genie keys
  projects by absolute checkout path. The mapping has to be explicit.
- **Today's read path writes.** `usagemeter status` opens the store through `Store::open`, which
  sets the journal mode, recreates a view, may add columns and may write `schema_version`. `sync`
  resets a store of an older version in place, deleting its rows with no copy kept, and does not
  refuse a store written by a newer version.

## Decided

From the owner (2026-11-08): the meter is built in Rust in this repository; all of genie's
metering moves into it; genie-rs consumes it; nothing burns hardware; task linking is part of the
plan. From the owner's answers in RFC 0017: the capability is `meter.usage@1`, and the doc keeps
`schema_version` 2.

From genie's meter design (rev 2) and its council record; the owner confirms them when
scheduling this RFC:

- The boundary is one meter-owned, versioned, read-only, fork-and-exit query, batched per
  project, with an envelope rather than bare rows (below).
- A branch-window number is never shown as task cost. Task cost waits for M3.
- Everything that computes usage, cost or time moves to the meter: normalization, pricing,
  aggregation, attribution. Behaviour that is not metering stays with its owner: in-flight budget
  enforcement in the executing runtime, benchmark quality judgments, and the operators' telemetry
  delivery. No calculation is excluded.
- genie keeps the opt-in capture switch and its ledger until M5 names their Rust owner.
- A contract change is a pull request here that genie reviews.

From RFC 0017 (#751, merged): the crate is `meter/usagemeter/`, the doc's keeper is
`meter/schema/`, and cargo runs only on the build host, one build at a time, with
`CARGO_BUILD_JOBS` capped.

Proposed here: everything else. Numbers marked "proposed" are starting points the owner may
change.

## Design

### (a) The query, contract version 1

```
usagemeter query --repo <host/owner/repo> --branch <b> [--branch <b> ...] --json
                 [--window d1|d7|d30] [--contract 1] [--stale-after <s>]
```

- **One call per project.** One `--repo`, every branch the project's cards need, at most 500 per
  call and within the byte budget below (proposed). More is a usage error, never a silent cut.
  `--window` defaults to `d30`. `--json` is required: v1 has no text output. v1 does not page.
  `--since` and `--until` ask for an exact interval instead; it also counts the hourly tokens with no per-call record in its whole hours, as before-evidence actor tokens (RFC 0021 (d)).
- **Fork and exit.** The process reads, prints one JSON document on stdout and exits. No daemon,
  no listener, no background child.
- **Branches match exactly**, case-sensitive, against the branch the meter recorded from the log
  or the Codex thread, or, for a harness that logs none (dsh-tui, OMP), from the start row of the
  worker launch the call resolves to (`branch_basis: ledger`, amended by RFC 0021), never against
  today's checkout. `--repo` is the meter's normalized form of
  a git remote: credential-free, host lower-cased, no port, no `.git`, path case kept.
  `repo-normalization.json` holds the shared cases. genie owns the mapping from an absolute
  checkout to that string. The meter never sees checkout paths in a query.
- **A branch named twice** (two cards on one branch) is answered once, with `requested: 2` and
  `attribution.shared: true`. Its total belongs to neither card alone. genie shows both cards as
  unknown. Collapsing the duplicate without saying so would be a silent drop.
- **The caller names the contract it reads.** `--contract` defaults to 1. A meter that does not
  serve the asked version exits 14 and lists the versions it does serve. Once contract 2 exists,
  the meter keeps serving contract 1 for at least one compatibility release.
- **Rows by bot** (RFC 0021 (d)). `--by bot` answers one row per bot key, with
  `attribution.precision: actor_interval`, the branches named becoming an optional filter;
  without it, rows are by branch, as above.
- **Rows by task** (M3, RFC 0021 D4). `--by task` answers one row per task id with task-labelled
  usage in the repo and window, with `attribution.precision: task_interval`; the branches named
  are an optional filter, as for bots. The row's `task` is the start row's task id, and its
  `actors` names every launch tag (bot, kind, role, squad, unrecorded, harness) that did the work,
  one entry per key, ordered like a bot row's key: a task answered by several bots or roles names
  them all, never a guessed single one. A task id the meter ties to more than one checkout of the
  repo (two genie projects of one remote, each minting short ids) is never summed: its row is
  `missing` with `reason: task_ambiguous`, and the meter never prints a checkout path. The row's
  numbers are evidence-backed, so the branch row stays the total. A window with no task labels is
  an `ok` answer with `rows: []`, and the branch answer is unchanged, so a reader falls back to
  it. The actor list is bounded with the row: keys past the bound are counted in
  `actors_omitted`, never cut short.

#### The envelope

Every exit the contract defines prints an envelope on stdout, refusals included, so a reader
never has to tell a v1 refusal from an old meter's error by stderr text. The schema is
`meter/schema/query/v1/envelope.schema.json` (JSON Schema 2020-12).

| Field | Meaning |
|---|---|
| `contract`, `contract_version`, `capability` | `usagemeter.query`, 1, `meter.usage@1` |
| `meter_version` | the binary's version (`usagemeter --version`) |
| `status`, `error` | the outcome (table below); `error` is null only when `status` is `ok` |
| `generated_at` | when this call ran, UTC |
| `as_of` | the moment every `ok` or `degraded` source is counted up to: the oldest of their last successes |
| `machine` | `id` (herdr-core's core id, or the store's stored id) and `scope`, always `local` in v1 |
| `store` | the store's `schema_version`, and `location`: `current`, `legacy` (the state folder before automagik-dev/usagemeter#7) or `override` (`METER_STATE_DIR`). Never the path. |
| `ingestion` | `watermark` (when the last successful sync finished; null while a reset's re-import has not finished a run), `counted_from`, `evidence_from` (start of per-call evidence, null until M3), `complete`, `backlog` (`bytes`, `files`; each null when unknown, and then `complete` is false), `stale` and the `stale_after_s` used (proposed default 7200) |
| `window` | `name`, `requested_start` (`end` less the window's days), the effective `start` (clipped to `counted_from`), `end` (the end of the hour holding the watermark; while the watermark is null, the end of the hour holding `generated_at`), `clipped` |
| `sources[]` | per harness: `status` (`ok`, `degraded`, `unsupported`, `absent`; `absent` when the harness's log folder is not on this machine), `reason`, `last_success`, `stale`. dsh-tui is `degraded` when a usage line or frame could not be read (a call with no readable total, a frame whose checksum does not match) or when bytes at the end of a session that stopped growing are not a whole frame, and `unsupported` while a session is in a format the meter does not read. Then, when the folder before the state move holds usage this store never counts (an older meter wrote there after the move, or a store of its own is there), one more entry, `legacy-store`, `degraded`, with the reason: that usage is reported, never folded in |
| `unattributed` | usage in this repo and window with no branch, neither logged nor filled from the start row of the worker launch it resolves to (RFC 0021): `tokens_total` and `harnesses` (OMP's and dsh-tui's, whose logs carry none). Zero when there is none. |
| `actor_unattributed` | RFC 0021 (d): the repo's usage in the window given to no bot (ambiguous, unlinked, before `evidence_from`), each part with its reason and harnesses. Present exactly when the meter reports actors; null on a refusal |
| `pricing` | the table's `origin` (`bundled`, `override`, later `fetched`), `date`, `source`, `label`, `sha256` (of an override's bytes, null for the bundled table); `reported_wins` (always true); `long_prompt_tiers` (false until M4) |
| `query` | the request echoed back: `repo`, `window`, `by` (present for `--by bot` or `--by task`, absent for branch rows), `branch_count` (duplicates counted), `branches` as given (duplicates kept), `branches_complete`, and `request_sha256` (the sha256 of the UTF-8 of `repo`, `window`, the line `by <by>` for a non-branch query, and each branch in order, each followed by a line feed). A refusal caps the echo (below), and a repo past its 512 bytes is echoed cut at a whole character with `repo_complete: false`; `query` is null only when the arguments do not parse. |
| `rows[]` | one per distinct branch named (below); for `--by bot`, bot rows instead (RFC 0021 (d)); for `--by task`, task rows instead, one per task id with usage under the filter (M3) |

On a refusal, `rows` and `sources` are empty and `as_of`, `ingestion`, `window`, `unattributed`,
`actor_unattributed` when present, and `pricing` are null, whatever the meter read before it
refused. Only two fields carry what the store said: `store` once its `schema_version` was read
(exit 12, 13 and 15, and exit 1 when the failure came after that read), and `machine` on exit 15
alone. Both are null on exit 2, 10, 11 and
14. `query` is null only on an exit 2 whose arguments do not parse; every other refusal echoes the
request, capped (below). The schema enforces each of these, and the crate's contract test checks
them on every example and on the meter's own refusals.

A row:

| Field | Meaning |
|---|---|
| `branch`, `requested` | the branch, and how many times the call named it |
| `state` | `measured`, `zero`, `missing`, `stale` or `unsupported` (next table) |
| `reason` | why a row is not `measured` or `zero`: `repo_not_seen`, `window_before_counted_from`, `backlog`, `source_incomplete`, `branch_unattributed`, `ingestion_stale`, `source_unsupported`, and on a task row `task_ambiguous` (M3) |
| `tokens` | `input`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning` (inside `output`, never added; null when a harness that counted toward the row logs no reasoning split, dsh-tui today), `unsplit` (known only as a total), `total`. Every field is present, zeros included. Null when nothing was measured. |
| `cost` | `state` (`priced`, `partial`, `unpriced`, `zero`); `usd` (the known part), `usd_reported` (what the harness reported), `usd_estimated` (from the table); `tokens_priced`, `tokens_reported`, `tokens_unpriced`, which add up to `tokens.total`; `unpriced_models`, and `unpriced_models_omitted`, how many the list leaves out past its 8 (always present, 0 when none is left out; above 0, the list holds all 8) |
| `token_precision` | `exact`, `mixed` or `total_only` (Codex threads with no split) |
| `attribution` | `precision`: `branch_window` on a branch row, the repo and branch total over the window (`actor_interval` is a bot row's, and `task_interval` a task row's, RFC 0021); `exclusive`: always false in v1; `shared`; `coverage`: `complete`, or `partial` while `unattributed` is above zero; `actor`, when the meter reports actors (RFC 0021 (d)) |
| `activity` | `first_hour`, `last_hour`, `hours` (distinct hours with usage, not elapsed time), `harnesses` |
| `incomplete_sources` | harnesses whose health means this row may undercount |

#### Missing, stale, unsupported, partial, unattributed and zero stay apart

| Row state | When | Numbers | A reader shows |
|---|---|---|---|
| `measured` | usage found in the window | tokens and cost, a lower bound while `coverage` is `partial` or `ingestion.complete` is false (a budget-stopped backlog, even with a fresh watermark) | the numbers, with `cost.state`; "at least" when `coverage` is `partial` or `complete` is false |
| `zero` | nothing found, and the meter can vouch for it: the window is not clipped, the backlog is empty, ingestion is fresh, every source is `ok` or `absent`, the repo has usage somewhere in this store, and none of the repo's usage in the window lacks a branch | all zero, `cost.state: zero` | a real 0 |
| `missing` | nothing found, but one of those conditions fails (`reason` says which; `branch_unattributed` for the last). A task row is also `missing` with `task_ambiguous` when the meter ties its task id to more than one checkout of the repo (M3) | null | unknown |
| `stale` | ingestion is older than `stale_after_s`, or has no watermark (a reset's re-import has not finished a run); this state comes before every other, except that a task row's ambiguity (below) wins over it | what the store holds for the branch: the numbers as of the last sync, which are a lower bound while `ingestion.complete` is false (a re-import in progress); `tokens`, `cost`, `token_precision` and `activity` all null when it holds nothing for the branch | unknown, or the numbers labelled with their age ("at least" while `complete` is false) |
| `unsupported` | nothing found while a source on this machine is `unsupported` | null | unknown ("update needed") |

A task row is the one exception to `stale` coming first: a task id the meter ties to more than
one checkout of the repo is `missing` with `task_ambiguous` whatever the window's age, because
the identity, not the freshness, is what cannot be known; its numbers are never shown as a stale
lower bound. A task row that is not ambiguous is `stale` with its store-held numbers, like any
other row (M3).

Cost: `priced` when no token is unpriced; `partial` when some are, and `usd` is then a lower
bound; `unpriced` when none is priced, and `usd`, `usd_reported` and `usd_estimated` are then
null, never 0; `zero` only on a zero row. Amounts are rounded to four decimals, except that an
amount above 0 that would round to 0 keeps its exact value: a 0 is shown only when the cost truly
is zero. Null or unknown never becomes 0, in the meter or in a reader.

**Usage with no branch.** OMP and dsh-tui log no branch, so their usage reaches the store with
its repo known and its branch null, and it could belong to any branch of that repo. While the
repo has any such usage in the window (`unattributed.tokens_total` above zero):

- no row of that call is `zero`: a branch with nothing of its own is `missing` with
  `branch_unattributed`;
- every row's `attribution.coverage` is `partial`, so a measured row is a lower bound. A mixed
  Claude and OMP session shows its Claude subset, priced, marked partial. A bot row of a
  `--by bot` query that names no branch is the exception: it counts that usage itself, so it is
  `complete` (RFC 0021 (d));
- the meter never assigns the usage to a branch: not from today's checkout, not from another
  harness's session at the same hour. Only durable evidence may attribute it later: a worker
  launch's start row, which fills the branch with `branch_basis: ledger` (RFC 0021), or M3's
  validity intervals, at `task_interval` precision.

Three questions stay apart on every row: is a source healthy (`incomplete_sources`), is every
token priced (`cost.state`), and is all of the repo's usage attributed (`attribution.coverage`).
None of them stands in for another. Usage with no repo at all (a folder that is not a checkout
with a remote) belongs to no `--repo` and is not counted here.

#### Exit codes

| Exit | `status` | When | Reads rows | Writes |
|---|---|---|---|---|
| 0 | `ok` | answered; rows may be `missing`, `stale`, `unsupported` or `zero` | yes | nothing |
| 2 | `usage` | bad arguments, no `--json`, or a request past the request bound: more than 500 branches (`error.code` `too_many_branches`), or too many bytes (`request_too_large`, which always carries `error.limit_bytes` and `error.needed_bytes`) | no | nothing |
| 10 | `absent_store` | no store at the state folder: never synced on this machine | no | nothing; the folder is not created |
| 11 | `locked` | no consistent snapshot within the busy budget (proposed 2 s); `error.retry_after_s` | no | nothing |
| 12 | `newer_schema` | the store's `schema_version` is newer than this binary knows | no | nothing |
| 13 | `outdated_store` | the store needs a migration only `sync` runs | no | nothing |
| 14 | `unsupported_contract` | `--contract` names a version this meter does not serve; `error.supported_contracts` | no | nothing |
| 15 | `too_large` | the full answer would pass the output cap; `error.limit_bytes`, `error.needed_bytes`, and `error.rows_fit` (how many rows, in request order, would have fit) | read, not returned | nothing |
| 1 | `error` | anything else: an unreadable or corrupt store, an I/O error, or a state folder the meter cannot read without writing (`error.code` `read_only_folder`, below) | no | nothing |

A meter older than v1 has no `query` verb. Today's binary prints `meter: unknown command` on
stderr, nothing on stdout, and exits 2. A reader that gets no envelope on stdout treats the meter
as too old.

#### No match is silently dropped, and v1 does not page

Every branch named gets exactly one row in one answer, or the call fails with a refusal whose
`rows` is empty, so every cost in it is unknown. v1 has no pagination: a page token across
processes would need a stable order, a token bound to the request and to a data generation,
prices and bounds frozen between pages, and a refusal when a sync lands in between (open
question 8). When the full answer would pass the output cap, the meter refuses it whole (exit
15) and says how many rows would have fit. The reader may then split its branches over several
calls. Each answer is then its own snapshot, with its own `as_of`, and a reader never adds one
answer's rows to another's. The meter never truncates the way the doc does.

#### The byte budget

Every number here is proposed. The meter checks all of them before it opens the store, apart from
the output cap, which it checks before it prints:

| Part | Bound |
|---|---|
| Output | the whole envelope, as written to stdout, is at most 448 KiB (458,752 bytes); genie's stdout cap is 512 KiB |
| Encoding | compact JSON in UTF-8 (the examples are pretty-printed for reading). Only what JSON requires is escaped. Git and the meter refuse a branch holding a space, a backslash or a control character, so `"` is the only character escaping can grow, and an echoed name takes at most twice its bytes plus 3 |
| Request | at most 500 branches, each at most 255 bytes of UTF-8, at most 64 KiB (65,536 bytes) for all names together, and a `--repo` of at most 512 bytes. Past any of these: exit 2 |
| Echo | at most 2 × 64 KiB of names, plus 3 bytes per name and the repo: about 134 KiB |
| Metadata | everything outside `query.branches` and `rows` is at most 16 KiB. Its strings are bounded (`error.message` 1,000 characters; source, label and reason 200) and the source list is short |
| A row | at most 2.25 KiB (2,304 bytes): its escaped branch name, its fixed fields, its `attribution.actor` block with every count at the largest the meter prints, and `unpriced_models`, which keeps at most 8 names (the models with the most unpriced tokens). A name takes at most 40 bytes as JSON, its two quotes and any escapes included; a cut name ends with `…` (3 bytes), inside those 40. `tokens_unpriced` still counts every unpriced token, and `unpriced_models_omitted` says how many models were left out. A bot row (RFC 0021) has no branch name and its bot, role and squad are at most 64 characters each, so it is smaller. A task row (M3) has no branch name either; it keeps the actor keys that fit its bound and counts the rest in `actors_omitted`, so a task with many workers stays within it too, and its task id is at most 64 characters. Amended by RFC 0021 delivery 6 (PR 875): the bound was 2 KiB before the actor block; the crate's budget test fills every actor count at 19 digits beside a 255-byte quoted branch and measures 2,104 bytes |
| A refusal | at most 8 KiB. Its echo keeps the leading names that fit in 4 KiB, cut at a whole name, with `branches_complete: false`, `branch_count` and `request_sha256`, so the reader can match the refusal to its request without a full echo |

The echo and the metadata together stay under 150 KiB, so any request within the request bound
leaves room for at least 132 rows (298 KiB of 2.25 KiB rows; 149 while a row was at most 2 KiB,
before RFC 0021 delivery 6). A request whose echo alone could crowd out every row is past
the request bound, and gets the bounded exit 2. A valid request whose rows overflow gets the
bounded exit 15. The examples hold one of each: `request-too-large.json` (500 names of about 200
bytes) and `too-large.json`.

#### A true read-only open

The query opens an existing store and nothing else:

- SQLite opened read-only (`SQLITE_OPEN_READ_ONLY`), one read transaction for a consistent
  snapshot, a bounded busy timeout. No DDL, no `PRAGMA` writes, no `meta` writes. It never takes
  `meter.lock`.
- No creation (a missing store or folder is exit 10, and nothing is made), no migration (exit 12
  or 13), no sync, no price fetch, no doc publish, no `hc` call or start, no git call, no network.
- The only files it may cause are SQLite's own `-wal` and `-shm` companions, which a reader of a
  WAL store can need: the database's content never changes, but the folder is not byte-identical
  when they appear. A test checks that `meter.db`'s bytes and every other file in the state
  folder are unchanged after a query, and that an existing `-wal` keeps its bytes.
- In a state folder the reader cannot write, SQLite reads the store only when its `-wal` and
  `-shm` already exist; then the query reads it as usual. Without them it refuses by name: exit
  1, `error.code` `read_only_folder`. It never opens the store `immutable`, because a sync
  elsewhere (outside a sandbox that binds the folder read-only, say) may be writing.
- M1 moves `usagemeter status` onto the same read-only open, because today it writes.

#### Who refreshes the store

The query never syncs. Only `usagemeter sync` refreshes the store, and today one thing runs it:

- **The Automagik Herdr pack's sidebar** (`herdr/mods/am-sidebar/meter.js`). It syncs 30 s after
  it loads, then at most every 10 minutes while Herdr is open, one run at a time. Each run covers
  this computer, then each connected linked machine the person agreed to. Installing the pack
  installs the meter and turns this timer on. There is no LaunchAgent and no daemon.
- **Otherwise, the operator.** On a machine where Herdr is not open (one reached only over SSH,
  or the build host with no desktop), nothing syncs on its own: the operator runs
  `usagemeter sync`, by hand or from a scheduler of their own. am has `meter install` and
  `meter uninstall` but no sync command today. If one is added, it runs the same
  `usagemeter sync`.

This RFC adds no trigger. genie's board refresh never syncs, and no slice adds a daemon or a
timer. What the reader tells the person, by outcome:

| Outcome | The reader's recovery instruction |
|---|---|
| exit 10, or `ingestion.stale` | "not synced yet" or "synced N hours ago": open Herdr, or run `usagemeter sync` |
| exit 11 | retry after `error.retry_after_s`, at most once per refresh |
| exit 12, or no envelope at all | update the meter (`am meter install`, or the pack's update) |
| exit 13 | run `usagemeter sync`, which migrates and keeps a generation first |
| exit 14 | update whichever side is older |
| exit 15 | split the branches over smaller calls, within `error.rows_fit` |
| exit 1, `error.code` `read_only_folder` | make the state folder writable, or read where its `-wal` and `-shm` already exist (a reader that could write leaves them) |
| exit 1 with any other code, or exit 2 | report it: genie sent a bad request, or the store is damaged |

#### The caller's side (genie-rs)

genie-rs bounds every call: a wall-clock timeout (proposed 3 s), after which it kills the child
and reaps it; a stdout cap (proposed 512 KiB) and a stderr cap (16 KiB), past which it kills the
child too; one call per project per refresh, never one per card; an answer reused for up to 60
s per project (proposed). A meter failure of any kind (absent binary, an exit code, a timeout, a
bad envelope) never breaks `genie-rs list`: the list prints, and each card's cost is unknown with
the reason. Which labels genie shows is genie's S1.

#### Rejected alternatives

- **The capped doc as the source.** It is cut to 64 KiB (127 of about 1,100 task rows on one
  machine), it says `complete` while rows are missing, it carries d-windows only, and it can be
  hours old with no per-row freshness. It stays only as a fallback S1 labels with its age.
- **Reading `meter.db` directly.** The store is private: hourly rollups whose row ids, precision
  rules and reset behaviour change with its schema (version 2 rebuilt every row). Prices are
  applied when a summary is built, not stored, so genie would have to keep a second pricing
  calculation, which is the opposite of moving metering into one place. It would also put WAL,
  locking and the read-only guarantee in two codebases.
- **Linking the crate into genie-rs.** Two binaries on one machine would each carry their own
  idea of the store's schema, so an older linked copy could meet a newer store, or migrate it.
  genie's build would take on the meter's dependencies and targets (the meter ships Intel Mac;
  genie-rs does not). The meter is its own part with its own key (RFC 0017), and a process
  boundary gives the timeout, output cap and crash containment for free.

### (b) The evidence-retention contract

Before M3 changes storage, the meter must keep, per call, at least:

| Evidence | Why |
|---|---|
| timestamp (ms) | half-open interval matching (`start <= at < end`) |
| machine-local session id, and its parent session | session to task joins; parent-child dedupe |
| request or delta identity: Claude `message.id` with `requestId`; Codex thread id with the cumulative-total step; OMP entry or side-call id | dedupe across copies, subagent files and rereads |
| harness, and the model as logged (requested model too, when the log has it) | pricing; requested versus actual |
| every token kind: input, cache read, cache write 5m and 1h, output, reasoning (inside output), unsplit | pricing and totals without double counting |
| prompt size (the whole prompt's tokens) | long-prompt tier prices (M4); lost forever once rolled up |
| precision (`exact`, `total_only`) | never invent a split |
| price provenance: reported USD and its source, if any | reported wins; an estimate is computed at read time with the table named in the envelope, and never stored as if reported |
| parent-child dedupe: whether a parent record is a rollup of children that carry the bill | count once |
| repo and branch, as attributed today | branch-window rows keep working |

No prompt text, answer text, tool arguments, file contents or credentials. The identity is kept
as a keyed hash per harness (128 bits, proposed), enough to dedupe and to match genie's capture
ledger, without copying raw log ids around.

**Session to task validity intervals.** A durable table of `(machine, harness, session, project,
task, valid_from, valid_to)`, half-open, with the evidence for each: a worker started with
`--task`, an explicit `link` or `unlink` event, a proven task writer, or a time window. Intervals
come from genie's exported records (`tasks.jsonl` v1, its link and supersede events, and the
capture ledger), never from a PR number or digits in a branch name. Two tasks valid for one
session at once make that span shared: its calls are ambiguous, never split. A superseded link
keeps its row, marked, so a rebuild replays the same answer.

**Bounded retention (proposed).** Per-call evidence is kept for 90 days or 1 GiB, whichever
comes first, pruned oldest whole day first; the query reports the start as `evidence_from`.
Validity intervals are small and kept 400 days. Hourly rollups are kept as today. Before
`evidence_from`, a row's attribution falls back to `branch_window`, and says so.

**Bounded reimport.** Evidence starts empty when M3 lands. An explicit
`usagemeter sync --evidence-backfill --days <n>` (n up to the retention bound) rereads the
native logs still on disk, under the same read budget, cursors and chunked commits as a normal
sync; it is never automatic past the default window. What stays unknown, for good:

- calls whose logs were deleted or rotated (Claude Code removes old transcripts on its own
  schedule);
- the split of Codex threads known only as totals;
- OMP branches (OMP does not log one), except where a worker launch's start row fills one (RFC
  0021);
- the task of any session before linking existed (S0), unless a link event names it: those
  calls stay unattributed, never guessed from a branch name;
- anonymous OMP sessions with no unique proof;
- mikro offload before M5;
- anything on a machine whose store is gone.

For those hours the branch-window total is still there, labelled as such.

**Session ids stay machine-local.** They live only in the meter's state folder (mode 0600) and
genie's machine-local capture ledger. They never enter git-tracked state, the `herdr-meter` doc,
a query envelope (v1 rows are per branch, per bot or, M3, per task; a task row counts calls,
it never names a session), or any telemetry target unless an operator names one.

### (c) The ownership map

Every row of the inventory's gap table (genie's metering against usagemeter v0.3.0). "Meter"
means a module of the crate in `meter/usagemeter/`; "adapter" is what remains on the producer
or consumer side once the calculation has moved.

| Capability | Calculation owner | Adapter that remains, or why it stays | Slice |
|---|---|---|---|
| Opt-in lifecycle observer | meter reads its ledger | genie writes the capture line inside the task-event transaction (producer) until M5 names a Rust owner | M3, M5 |
| capture switch: enable, disable, status | stays in genie | operator switch beside the producer; an env var only disables; disabling keeps history | M5 decides |
| Canonical task-DB filtering | meter (lifecycle) | none; applied when the ledger is read | M3 |
| Verified task-event join (db, task, event, kind, at) | meter (lifecycle) | genie exports the events it verifies against; the meter never opens genie's DB | M2, M3 |
| Runtime id and nested-marker ambiguity | meter keeps the `ambiguous` meaning on read | genie detects markers at capture time (only the runtime's environment can) | M3 |
| Claude usage parsing | meter (exists) | genie's reader retires through R | M3 |
| Codex usage parsing | meter (exists: cumulative deltas, archives, children, `total_only`) | genie's reader retires through R; summing cumulative deltas is an intended change | M3 |
| Generic pi source | meter (new source) | none | M3 |
| OMP assistant and side-call usage | meter (exists) | genie's reader retires; counting side calls is an intended change | M3 |
| Anonymous OMP writer matching (proven, mention, ambiguous) | meter (attribution) | none | M3 |
| Fine lifecycle interval timing | meter (lifecycle) | none | M2, M3 |
| Shared-session overlap flag | meter (attribution) | none | M3 |
| Transition p50, p90 and usage coverage | meter (lifecycle) | none | M5 |
| Interval JSONL and the text and JSON CLI | meter computes the rows | `genie metrics export` stays as the front door that calls the meter and keeps its stdout shape | M5 |
| mikro attempts, retries, failure bucket | meter (new mikro source) | mikro's `call.ts` keeps writing its ledger (producer) | M5 |
| mikro cross-card ambiguity | meter (attribution) | none | M5 |
| Price fetch, import, status provenance | meter (prices): explicit `usagemeter prices update` and `status` | genie's `metrics prices` becomes an alias, then retires | M4 |
| Reported USD precedence, 5m and 1h cache | meter (exists) | none | M4 |
| Generic model lookup, prompt tiers | meter (prices), from retained prompt size | none | M4 |
| Calls, priced calls, cost source | meter (prices); in the query's coverage | none | M4 |
| Phoenix lifecycle projection | meter computes intervals and their deterministic ids | delivery stays: genie's operator export posts, reads back, and never has a default target | M5 |
| mikro Phoenix attempt projection | meter computes attempt numbers | delivery stays with mikro; a missing value is null, not 0, once it reads the meter's | M5 |
| Wish workflow v3 record and ledger | meter reads the ledger | `genie wish report` keeps finding, validating and appending records (it knows workflow formats) | M5 |
| Wish outcome and variant summaries | meter (runs): means, fractions, partial counts, offload totals | outcome judgments stay with the workflow; the meter never infers a verdict | M5 |
| Forge lifecycle and exclusions | meter reads `tasks.jsonl` | genie-forge stays the producer | M2 |
| Forge cursor and cache quota bound | stays in genie | no forge poller in the meter; the bounded first pass and monotonic cursor are genie's | none |
| Task branch identity | stays in genie (S0: `start` mints ids, `link` and `unlink` events) | the meter consumes link events and never mints an id | M2 |
| `tasks.jsonl` lifecycle import | meter (lifecycle) | none | M2 |
| Herdr `space.projects` feed | meter writes the `space` block for Pocket (RFC 0017's keeper) | genie's board reads cards from `genie-rs list` and query v1, not from the doc; the checkout to repo mapping stays in genie | M1, S1 |
| Card cost, work, lead, start | cost: meter (query v1, task cost at M3); time: meter (M2) | genie computes the S0 time fields until M2 removes them; the board formats | M1 to M3 |
| Card ETA | meter (lifecycle): comparable merged samples, with the basis | genie's S0 formula until M2; the board presents it | M2 |
| Bots and lead association | meter (attribution) for bot per session, from durable evidence | the lead stays on genie's task record; unknown stays unknown | M3 |
| Observability annotations and waste | meter: token counts, context size, `waste_usd`, `total_usd` and their price table; raw counts of recorded run failures and harness-flagged tool and model-call failures (`usagemeter outcomes`, not contract 1) | behaviour scores (tool-error rate and labels, interrupts, rework, polling, compactions) stay in genie: they are not usage, cost or time; delivery stays | M5; counts: #899, #1026 |
| Benchmark economics | meter: normalized cost, coverage, root and child dedupe, cost per accepted result | quality judgments stay with the bench | M5 |
| Runtime budget and depth controls | meter: the price math, exported as a frozen table the runtime reads | enforcement stays in the executing runtime; a scanner cannot stop a run | M4 |
| mikro usage across session files, PG, Langfuse | meter (mikro source) reads one canonical record and counts it once | the other copies are projections; their delivery stays with mikro | M5 |
| Provider Keeper usage | meter, as a reconciliation source reading a sanitized snapshot | fetching it stays in mikro: the meter never holds provider credentials or cookies | after M5, question 6 |
| Efficient resumable native scan | meter (exists) | none; a board refresh never scans | M1 |
| Rust library and binary delivery | meter part (RFC 0017) | genie consumes the binary through the query and does not link the crate | M1 |

Beyond the gap table, the inventory's other families map the same way: the DSH workflow loader's
journal is a producer M5 reads beside the wish ledger; mikro's facts, egress and status counters
are attempt provenance, not a bill, and stay with mikro; mikro's batch, benchmark and output
totals are projections of usage that is counted once at its source; the board's and the DSH
board's formatting are presentation and stay.

**Recorded failures are counted by the meter; scoring them stays in genie (amended for #899 and
#1026, acknowledged by genie).** `usagemeter outcomes` is a local, read-only verb like `coverage`.
It is not contract 1, and it adds no field to the query envelope. It prints three raw counts, each
a fact something else recorded, per launch tag (bot, kind, role, squad), harness, error kind,
source and window, plus the unattributed by reason:

- `tool_error` (source `harness_log`): harness-flagged tool failures, including expected ones. One
  marker per harness, each pinned by a fixture in `meter/usagemeter/tests/fixtures/tool-errors/`
  that genie's annotation test can read too:
  - Claude Code: a `tool_result` block with `is_error: true`, counted once per `tool_use_id`.
  - Codex: an `event_msg` whose payload is `item_completed` and whose item has
    `status: "failed"` or an `exit_code` that is a non-zero integer, counted once per item `id`
    in its thread (an item that holds both counts once).
- `api_error` (source `harness_log`): harness-flagged model-call failures after the harness's own
  retries (so it counts model calls that failed for the session, not each retried attempt,
  including usage-limit stops), pinned in the same fixture folder:
  - Claude Code: a top-level `type: "assistant"` line whose top-level `isApiErrorMessage` is the
    JSON boolean `true`, counted once per top-level line `uuid`, and adds 0 tokens to usage
    (a `<synthetic>` line, which `claude.rs` already ignores; never counted as a `tool_error`).
  - Codex: `unsupported` until a rollout JSONL marker is pinned (rollouts currently persist no
    error-type `event_msg`).
- `run_failed` (source `hc_snapshot` or `workers_ledger`): a launch whose terminal ended on its
  own with a non-zero exit status or on a signal. `hc_snapshot` when hc's list of finished
  terminals records it; `workers_ledger` when hc no longer lists the terminal and an `end` row
  of Herdr's workers ledger copied its reason, exit status and signal. A window's total names
  the sources its failed runs came from. `killed` and `stopped_by_restart` are printed as end
  counts, never as errors.

The conditions it holds to:

1. Counts only: integers. No rate, ratio, threshold, label, score or per-session figure.
2. One marker definition per harness and failure kind, the ones above, never reinterpreted by a
   reader.
3. It is named as a fact wherever it is printed (`--help`, the README, the record's `note`): the
   count includes expected failures (a red test run while working test-first, a grep with no
   match) and usage-limit stops (written after a harness's own retries, so a count of model calls
   that failed for the session, not each retried attempt) and is not a quality verdict on its own.
4. Unknown is never 0: a harness with no pinned marker for a kind (omp, dsh-tui, Antigravity for
   `tool_error`; Codex, omp, dsh-tui, Antigravity for `api_error`) is `unsupported`; a window
   that starts before `errors_from` or `api_errors_from`, or one after a sync that recorded no
   failures of that kind (an older meter, after a rollback), is `partial`; a store no sync has
   prepared is `not_recorded`. Failures left behind by an older meter's reset are dropped by the
   next sync, never counted: until then `tool_error` and `api_error` are `not_recorded`.
5. No tool name, argument, output, error status or error text is stored or printed. The meter
   stores no text of a failure: its session as a keyed hash and its folders as references to the
   evidence's own folder rows, for re-attribution, kept for the evidence's retention; prints none
   of them. A session and a folder are stored only as the evidence store already keeps them under
   (b): the session and its parent as keyed hashes, the folders as ids of the folder rows interned
   in `ev_cwd`, all pruned with the evidence (90 days or 1 GiB). They are there so a failure
   follows its session when a later record links it, and no session, folder or terminal is ever
   printed. Beside those a failure is kept as its time, harness, launch tag and a kind-prefixed
   keyed hash of its id.
6. It is not in the query envelope. A reader that wants a tool-error rate, a label or a score
   computes it in genie, from these counts or from its own annotations.

The same verb prints time to pull request on two clocks (the branch's first commit, and its
first worker launch, to the pull request opened and merged), from `pr` rows Herdr appends to its
workers ledger; that is elapsed time the meter reads, like a launch's start and end, and the
lifecycle fields of M2 (`pr_lead_min`, `pr_open_min`) stay where this RFC puts them.

### (d) Upgrade, downgrade and the state-path move

"Old genie" reads only the doc. "Old meter" has no `query` verb (0.3.0, or a 3.N build before
M1).

| | Old meter | New meter (query v1) | No meter |
|---|---|---|---|
| **Old genie** | cards "–", as today | unchanged: the doc stays `schema_version` 2 and `query` is additive | cards "–" |
| **New genie** | `query` exits 2 with no envelope: "meter update needed", cost unknown, the doc fallback labelled with its age; `list` works | query v1 | binary missing: "no meter", cost unknown; binary but no store: exit 10, "not synced yet"; `list` works |

And the cases across time:

- **A newer meter, an older genie.** The meter serves contract 1 for at least one compatibility
  release after contract 2 ships. Past that, exit 14 tells genie which versions remain.
- **A meter binary older than its store** (a rollback): `query` exits 12. M1 makes `sync`
  refuse a newer store too, exit 12, writing nothing: it reads the version before the state move
  runs and before it opens the store for writing, under the state folder's lock (or, with no lock
  file there at all, only if none appears while it reads, since every meter makes its lock file
  before it writes), so no companion file is made.
- **The state-path move** (automagik-dev/usagemeter#7, to `~/.automagik/meter`). Only `sync`
  moves state, under the new folder's lock. It copies the database unit (`meter.db` and its
  `-wal` and `-shm` files), checks and fsyncs each copy, and never renames it; the old `meter.db*`
  files stay in the old folder as the recoverable generation. A later sync that succeeds with its
  backlog caught up removes them, under the old folder's lock, and only if each one's length and
  SHA-256 still match the snapshot taken when the move started. `query` never moves anything: it
  reads the current path, then the legacy path, read-only, and says which in `store.location`.
  `METER_STATE_DIR` is honoured by both and never moved.
- **An old meter after the move** still finds its store at its old path while the generation is
  kept, and writes into it; once a caught-up sync has removed the generation, it finds no store
  there and starts a fresh one. Nothing is lost, because the new path is untouched. When the newer
  meter returns, the current path wins: an old store that changed after the move, or one started
  fresh at the old path, is kept and reported by `sync`, never merged or deleted on its own. The
  query and `status` report it too, as the `legacy-store` source (a), so its usage is never
  silently missing from an answer: no row is `zero` beside it.

**Migration safety.**

- Before any destructive migration (a reset, a table rebuild, a schema bump that changes row
  ids, the evidence table's first creation over a full store), `sync` writes a recoverable
  generation: an online backup to `meter.db.gen-<schema>-<utc>` in the state folder, mode 0600,
  opened and row-counted before the migration starts.
- It migrates only with at least twice the store's size free (proposed); otherwise it refuses
  (exit 4), says why, and keeps the old store working, changing nothing. The same rule covers
  every write to an existing store's schema, such as the index M1 adds for the query, and the
  generation is guarded by whether the store holds any row, not by its recorded window. A reset,
  backfill or migration needs twice the store plus its projected growth: the log bytes still to
  import (each log in the window whole for a reset, else past its stored offset) divided by 8
  (Decided by Chat, 2026-11-09).
- A reset commits on its own, and the re-import after it commits chunk by chunk: until a run over
  the new window ends, the store has no watermark and an unknown backlog. A reader then reports
  the answer incomplete and every row `stale`, never a partial count as complete and fresh.
- The migration runs in one write transaction, and there is no `migrating` marker. Until it
  commits, a reader of the WAL store is served the old snapshot, consistent and with its old
  `schema_version`. After the commit, the reader sees the new store, or exits 12 if it is an older
  binary. A reader gets exit 11 only when no snapshot can be had within the busy budget.
- One generation is kept (proposed), deleted only after a later sync succeeds on the migrated
  store. An interrupted migration leaves the old store or the generation intact, never neither.
- Nothing migrates on a read: not `query`, not `status`, not a doc publish.

M1 delivers all of these rules (the generation, the free-space refusal, the single transaction and
keeping one generation). Today's `sync` already resets an outdated store, so the rules are needed
before the first destructive migration in M3 (the evidence table) as well.

### (e) Hardware acceptance ceilings

Written before anything is measured. All numbers are proposed. They hold on both of these:

- the build host, with a binary it built under RFC 0017's build rule;
- an Apple Silicon laptop running a CI-built binary, never one built there.

The reference workload is synthetic, generated by the M1 tests:

- a 30-day native-log corpus of 2 GiB holding 1,000,000 calls across three harnesses, 40 repos
  and 1,500 branches;
- for the query cases, a store with 90 days of evidence.

| Case | Wall | CPU | RSS | Bytes | State growth | Child processes |
|---|---|---|---|---|---|---|
| Cold import (first sync, default window) | ≤ 25 s per run (20 s read budget); done within 15 min of runs | one core per run; ≤ 6 min in total | ≤ 160 MiB | each log byte read once (≤ 1.05 × corpus) | ≤ 300 MiB in total, ≤ 200 B per call of evidence | ≤ 1 alive; git ≤ 1 per new cwd (cached 7 days); hc ≤ 2 per run |
| Warm query (1 project, 20 branches) | ≤ 150 ms p95 | ≤ 120 ms | ≤ 40 MiB | ≤ 16 MiB read; stdout ≤ 32 KiB | 0 | meter 0; genie 1 |
| Many-branch list (1 project, 500 branches) | ≤ 1 s p95 | ≤ 0.8 s | ≤ 64 MiB | stdout ≤ 448 KiB, else exit 15 (since RFC 0021 delivery 6 the reference case exits 15; see the notes below) | 0 | meter 0; genie 1 |
| Incremental append (sync after 10 min, about 5 MiB new) | ≤ 2 s | ≤ 1.5 s | ≤ 100 MiB | ≤ 1.1 × the new bytes, plus a stat per known file; no rescan | ≤ 250 B per new call; WAL checkpointed under 64 MiB | hc ≤ 2 |
| Interrupted backfill (SIGKILL mid-chunk, then rerun) | the rerun recovers within one run (≤ 25 s) | as cold import | as cold import | rereads ≤ one 8 MiB chunk per file in flight | no call counted twice; `PRAGMA integrity_check` passes | as cold import |
| Rebuild (explicit reimport, or a destructive migration) | as cold import, plus ≤ 30 s per GiB of store for the generation | one core | ≤ 200 MiB | one copy of the store | peak disk, sampled during the rebuild with the WAL included, ≤ 2.2 × the larger of the store before and after (Decided by Chat, 2026-11-09); one generation kept | as cold import |
| Concurrent board refreshes (4 boards × 10 projects, a sync running) | each query ≤ 500 ms p95; a full refresh ≤ 3 s | ≤ 2 cores in total, for ≤ 3 s | ≤ 160 MiB in total | as warm query, each | 0 from queries | ≤ 4 meter processes alive at once, all reaped; exit 11 on ≤ 1 % of calls |
| Idle, between refreshes | n/a | 0 | 0 | 0 | 0 | 0 meter processes |

How they are checked:

- Each slice's pull request records its measured values beside these: `/usr/bin/time -v` on
  Linux, `-l` on macOS, and a count of child processes.
- A ceiling that fails blocks the slice.
- Changing a ceiling amends this RFC.
- Measurement runs on the build host behind its gate lock, one run at a time, and never as a
  load or repeat grid.

Recorded figures:

- Many-branch list, RFC 0021 delivery 6 (PR 875, accepted by genie and re-measured by the
  Reviewer). On the reference store, the 500-branch answer:
  - needs 476,918 bytes, past the 448 KiB cap (458,752 bytes), so it exits 15 with `rows_fit` 480;
  - of those, the 500 `attribution.actor` blocks take 118,500 bytes (237 a row) and
    `actor_unattributed` 248;
  - without both it would be 358,169 bytes (M1, PR 806, measured 358,152 and exit 0).

  Exit 15 is within this ceiling, and the reader splits the branches by `rows_fit`. The cap,
  the request bound (500 branches) and the examples are unchanged.

### Invariants (every slice, both sides)

- No daemon and no resident poller: fork and exit.
- Null or unknown is never shown as 0.
- No fabricated ids: no task id from a PR number or digits in a branch name, and no invented
  token splits.
- No default telemetry target.
- Session ids stay machine-local and never enter git-tracked state.
- A board refresh never scans history and never runs one subprocess per card: one query per
  project.
- The forge quota bound stays in genie.
- A read never writes, creates or migrates.

### The slices

Each is its own later pull request with an independent review. M1 onward is Rust in
`meter/usagemeter/`, after RFC 0017's import (its delivery 2), on the meter lane, built under
RFC 0017's build rule.

1. **M0, this RFC** (docs and fixtures; cuts nothing).
2. **M1, the query.** `usagemeter query` per contract 1; the read-only open, which `status`
   moves to; `sync` refusing a newer store; and the migration-safety rules of (d). *Check:*
   - the crate's contract test (below) passes on every fixture;
   - a query leaves `meter.db` and every other file in the state folder unchanged (SQLite's
     `-wal` and `-shm` companions aside, (a));
   - `usagemeter status` does the same;
   - `sync` on a store with a newer `schema_version` exits 12 and writes nothing (the folder is
     byte-identical after it);
   - before `sync` resets an outdated store, a generation is written, and its row counts match
     the old store's;
   - `sync` with less than twice the store's size free refuses and changes nothing;
   - the warm-query, many-branch and concurrent-refresh ceilings hold.

   *Rollback:* revert; genie falls back to "meter update needed".
3. **M2, lifecycle.**
   - Read genie's `tasks.jsonl` v1 with its link and supersede events.
   - Own the lifecycle time formulas genie's S0 adds (`age_min`, `pr_lead_min`, `pr_open_min`,
     ETA from comparable merged samples), with S0's fixtures: restart, absent open, reversed
     timestamps, terminal states.
   - Additive fields in the envelope.
   - M2's pull request names the S0 code genie removes.
4. **M3, attribution.**
   - The evidence table and validity intervals per (b).
   - The pi source, anonymous OMP matching, and the shared-session flag.
   - Task rows behind `--by task`, with `attribution.precision: task_interval`; branch rows are
     unchanged.
   - Only now may a card show "task cost". *Check:* the interrupted-backfill and rebuild ceilings
     hold.
5. **M4, prices.** Explicit fetch with provenance, long-prompt tiers from retained prompt size,
   per-call priced coverage, and the frozen table runtimes read.
6. **M5, the rest** (several pull requests).
   - Lifecycle interval export.
   - The wish-runs ledger and its summaries.
   - mikro offload and its sources.
   - The shared arithmetic of bench, mikro and observability, per the ownership map.
   - Each pull request names whether capture production and its switch move, and to whom.

genie's side of the boundary, built in genie and named here only so the order is clear:

- **S0**: time fields from genie's own events, and task linking. Independent of the meter.
- **S1**: the card's cost from query v1, shown as "branch, last 30d, est.", partial or unknown as
  the envelope says, never as task cost. Needs M1 released.
- **R**: a TypeScript path retires only on frozen shared-input fixtures, with one compatibility
  release and a rollback drill.

### The fixtures

`meter/schema/query/v1/`:

- `envelope.schema.json`, the contract.
- `repo-normalization.json`, the remote-to-`--repo` cases.
- `examples/`, one envelope per case. RFC 0021's delivery 2 adds nine, listed there, and M3 adds
  three task examples (`task-rows.json`, `task-ambiguous.json`, `task-no-labels.json`); the crate
  now compares every one of them with the meter's own answer, so they are no longer schema-only.

| Example | Case | Exit |
|---|---|---|
| `priced.json` | two measured rows from Claude and Codex, which record a branch | 0 |
| `partial-priced.json` | an unknown model and `total_only` tokens: `cost.state: partial` | 0 |
| `missing-branch.json` | a window clipped by `counted_from`: one row `missing` | 0 |
| `stale-source.json` | ingestion 30 hours old, Codex degraded for three days: rows `stale`, with the last known numbers, or all null for a branch with nothing found | 0 |
| `ambiguous-branch.json` | one branch named by two cards: `requested: 2`, `shared: true` | 0 |
| `task-rows.json` | `--by task`: two tasks, one worked by a dev and a reviewer, each row naming its actors | 0 |
| `task-ambiguous.json` | `--by task`: one task id tied to two checkouts of the repo, `missing` with `task_ambiguous`, no checkout path | 0 |
| `task-no-labels.json` | `--by task` with no task-labelled usage: `ok` with `rows: []`, the branch row a reader falls back to unchanged | 0 |
| `zero-usage.json` | a vouched zero | 0 |
| `unsupported-source.json` | an unreadable Codex schema: no zero can be vouched for | 0 |
| `unattributed-branch.json` | healthy OMP usage in the repo with no branch: a partial Claude subset, and `missing` (`branch_unattributed`) instead of 0 | 0 |
| `unpriced-cost.json` | a row whose only model has no price: `cost.state: unpriced`, every amount null | 0 |
| `legacy-store.json` | the folder before the state move holds a store of its own: the `legacy-store` source, a measured row that lists it, and `missing` (`source_incomplete`) instead of 0 | 0 |
| `usage.json` | no `--json`: the arguments do not parse, so `query` is null | 2 |
| `request-too-large.json` | 500 names of about 200 bytes, past the request bound: echo capped at 4 KiB, with count and hash | 2 |
| `absent-store.json` | no store | 10 |
| `locked.json` | no snapshot within the busy budget | 11 |
| `newer-schema.json` | a store from a newer meter | 12 |
| `outdated-store.json` | a store only `sync` can migrate | 13 |
| `unsupported-contract.json` | `--contract 2` asked of a meter that serves 1 | 14 |
| `too-large.json` | an answer past the output cap: refused whole, with `rows_fit` and a capped echo | 15 |
| `error.json` | a damaged store | 1 |
| `read-only-folder.json` | a state folder the reader cannot write, and no `-wal` or `-shm` beside the store: `read_only_folder`, `store` null | 1 |

The data is synthetic: `example.com` repos, made-up branches, no session ids. Who reads them:

- **The crate's contract test (M1).** It validates every example against the schema. It builds
  each example's store from synthetic logs, runs the query, and compares the output with the
  example (timestamps aside). It also checks `repo-normalization.json` against the meter's
  remote normalization.
- **genie's reader tests**, at a pinned commit of this repository. They parse every example and
  check the card each one gives: a number, a partial number, or unknown with its reason. They
  check genie's checkout-to-repo mapping against the same normalization cases.
- CI runs the crate's test when `meter/schema/` changes (RFC 0017's `usagemeter` job).

**Versioning.**

- **Additive changes keep contract 1.** These are a new optional field, a new `reason`, or a new
  source. A new `--by` value, with its row kind and its reasons, is additive too. They change the
  schema and the examples in the same pull request. Readers ignore
  fields they do not know and never validate at runtime.
- **Breaking changes make contract 2.** These are a removed or renamed field, a changed meaning
  or unit, a new row `state`, or a new `cost.state`. Readers learn it first; a reader that meets
  a version it does not know shows "update needed", never a guess.
- **Widening a type is breaking once contract 1 ships.** Until a release that ships the meter
  carries contract 1, its types may still change in place, as M1 widened `tokens.reasoning` and
  `ingestion.backlog`'s `bytes` and `files` from integer to integer or null, and as its follow-up
  made `unpriced_models_omitted` required. After that release, widening a field's type (a new `null`,
  a number where an integer was, a string where an enum was) is a changed meaning and makes
  contract 2: a reader written against the narrower type may fail on it. A new `reason` or
  source stays additive, as above.
- **The capability.** A breaking change that a `meter.usage@1` reader cannot read also bumps the
  capability's major, as RFC 0017 says for the doc.

### RFC 0017's question 7 (open there, answered here)

RFC 0017 leaves its question 7 open, to be answered by this RFC. The proposed answer:

- **What is ported:** every row of (c).
- **Where it lives:** proposed, as modules of the one crate in `meter/usagemeter/`: `query`,
  `lifecycle`, `attribution`, `evidence`, `prices`, `runs`, and new sources for pi and mikro.
  There is no workspace until a second binary is needed. A future `meter/Cargo.toml` is decided
  then.
- **Which genie specs and tests come with it:** each slice names the genie source files it ports
  (from the inventory) and brings the frozen shared-input fixtures R needs. Those are pinned
  revisions with expected ids, nulls and provenance, and with intended differences reviewed and
  listed.
- **Who reviews:** a contract change (`meter/schema/query/`, the evidence contract, the map) is
  reviewed by genie as well as here.

## Contracts introduced

- The command `usagemeter query`, its flags, contract version 1, its byte budget, its exit codes
  0, 1, 2 and 10 to 15, and its envelope (`meter/schema/query/v1/envelope.schema.json`), under
  `meter.usage@1`. New, so no install changes. Permanent once a release ships it.
- `meter/schema/query/v1/` and its examples, owned here, read by the crate's tests and genie's.
- The evidence contract (b): what M3 must retain, the validity intervals, the retention bounds
  (proposed) and what stays unknown.
- Migration rules: a recoverable generation before a destructive migration, and no migration on
  a read. These change `sync`'s behaviour on an outdated store, not its data.
- Unchanged: the `herdr-meter` doc (`schema_version` 2), `meter.db`, `meter.lock`, the state
  folder and the `METER_*` variables.

## Threat model

- **What the query reveals.** Token counts and estimated cost per branch of one repo, on the
  machine it runs on, to a local caller that could already read the store's folder. No session
  ids, no paths, no content. Nothing leaves the machine.
- **A hostile caller** can pass up to 500 branches within the request bound; past it, the call
  is refused before the store is opened, with a refusal of at most 8 KiB. The call stays
  read-only and bounded by the ceilings. It cannot make the meter write, fetch, publish or start
  anything.
- **A hostile store** (a corrupt or crafted `meter.db`) gives exit 1 or 12, or rows the schema
  bounds; genie's timeout and output caps contain a meter that hangs or floods.
- **Undo.** Every slice reverts on its own. A generation is kept before any destructive
  migration.

## Open questions

1. **A branch named twice.** Recommended: answer once with `requested` and `shared`, as above.
   The alternative is for genie to dedupe before calling and mark both cards itself.
2. **Staleness.** Recommended: 2 hours by default, with `--stale-after` for callers that know
   better. The alternative ties it to the sync trigger's period.
3. **Fleet scope.** Recommended: v1 answers for the local machine only. Other machines reach the
   board through their doc, labelled, until a fleet query over hc is designed.
4. **Retention.** Recommended: 90 days or 1 GiB of evidence, whichever comes first, and 400 days
   of validity intervals.
5. **Evidence identity.** Recommended: a keyed 128-bit hash per harness, not raw log ids.
6. **Provider Keeper usage.** Recommended: a reconciliation source after M5 that reads a
   sanitized snapshot mikro writes; the meter never holds the credentials.
7. **Where ported code lives.** Recommended: modules of the one crate, no workspace yet (the
   proposed answer to RFC 0017's question 7, above).
8. **Pagination.** Recommended: none in contract 1, which refuses past the output cap (exit 15)
   and leaves splitting to the reader. A later contract version may page. It would need:
   - a fixed traversal order;
   - a token bound to the request and to a data generation that changes on every commit that
     touches the answer;
   - the window bounds and the price table frozen across pages;
   - a refusal when the generation moves between pages, and a defined last page;
   - fixtures for a two-page answer and for a sync landing between pages.
9. **The sync trigger outside Herdr.** Recommended: the operator runs `usagemeter sync` (or a
   future am command that runs it) where Herdr is not open, and no daemon is added. The
   alternative is a scheduled job that am installs, which would need its own RFC.

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Open issues: #897, #899.
- Merged changes that cite this RFC: #764, #783, #788, #802, #806, #814, #817, #822, #825, #875 (last merged 2026-11-10).

## Links

- RFCs:
  - [0011](0011-monorepo-parts-and-releases.md) parts and lanes;
  - [0012](0012-am-cli-and-parts.md) parts and capabilities;
  - [0017](0017-usagemeter-crate.md) the crate, the doc's keeper, `meter.usage@1` and the build
    rule. Its question 7 is open there, to be answered here.
- Fixtures: `meter/schema/query/v1/`.
- Upstream: `automagik-dev/usagemeter` at v0.3.0 (`src/store.rs`, `src/sync.rs`, `src/main.rs`,
  `src/repo.rs`, `src/sources/omp.rs`); automagik-dev/usagemeter#7 (the state folder) and
  automagik-dev/usagemeter#8 (the `space` feed).
- genie: its meter design (rev 2) and its metering inventory against usagemeter v0.3.0, kept
  with genie's design; genie-rs (`list`, `tasks.jsonl` v1, genie-forge).
- Code here: `scripts/lane.ts` (`NEVER_SHIPPED`), `herdr/mods/am-sidebar/meter.js` (the sync
  timer), `herdr/mods/am-sidebar/meterFleet.js`.
