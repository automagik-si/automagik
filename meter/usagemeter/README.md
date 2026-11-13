# usagemeter

`usagemeter` counts the tokens coding agents use on one machine (Claude Code, Codex, omp,
dsh-tui and Antigravity `agy`) and publishes a small summary to that machine's herdr-core.
It is shared by two Automagik products:
Automagik Herdr on the desktop, and the Automagik Pocket phone app through its Pocket Link mod,
which install it with `install.sh` and run it on the machines they
reach. Rows follow `ae/1` (agent event envelope, revision 3, owned by automagik-herdr). Design:
[RFC 0005](https://github.com/automagik-si/automagik-pocket/blob/dev/docs/rfcs/0005-usage-meter.md).

It runs once and exits. It has no daemon, no listener and makes no network calls; the only process
it talks to is the local `hc`.

This project used to live in the `meter/` folder of
[automagik-pocket](https://github.com/automagik-si/automagik-pocket), where it was built as
`automagik-meter`; it moved here with its history. Its store, summary doc and environment
variables did not change, so an existing install keeps its data. Since 0.5.0 the store lives in
`~/.automagik/meter/` and the first `sync` moves it there (see [What it stores](#what-it-stores)).

## Privacy

usagemeter records how many tokens were used, never what was said. It stores no prompt text,
responses, titles or file contents: hourly token counts per harness, model, repo and branch, and,
for a bounded time, each call's token counts with its time, folder and keyed hashes of its session
and request ids, never the raw ids (see [What it stores](#what-it-stores)). Repo URLs are stripped of credentials.
The store stays on the machine (0600); the only thing that leaves it is the summary doc, written
to the local herdr-core. The binary itself opens no network connection.

## Install

The Automagik Herdr pack installs it, on this computer and on every connected linked machine:

```sh
am meter install
```

(`herdr/install.sh` does the same on a new machine; `automagik-herdr` still works as an alias for `am`.) It reads the signed `meter-lane` pointer on
the Automagik repository's releases (`meter.json` and its ed25519 signature, checked against the
meter's public keys, `meter-keys.json`), takes the build it names for each machine's OS and CPU,
checks it against the sha256 the pointer names, and installs it to `~/.local/bin/usagemeter`
atomically. It never downgrades: a binary of that version or a newer one stays, and a pointer
older than one it already took is refused. Before the swap the new binary must answer
`usagemeter --version` with exactly its version, or nothing changes. The binary it replaced is kept
as `~/.local/bin/usagemeter.prev` until the next swap; to go back to it:

```sh
mv ~/.local/bin/usagemeter.prev ~/.local/bin/usagemeter
```

Each meter release carries `usagemeter-darwin-arm64`, `usagemeter-darwin-x86_64`,
`usagemeter-linux-x86_64` and `usagemeter-linux-aarch64` (the Linux builds static, musl), with
`usagemeter.SHA256SUMS`, `meter.json` and `meter.json.sig`, on its `vX.Y.Z` release. By hand, the
build the pointer names (check its signature with `bun scripts/meter-lane.ts verify` from a
checkout):

```sh
base=https://github.com/automagik-si/automagik/releases/download
curl -fLO "$base/meter-lane/meter.json" -fLO "$base/meter-lane/meter.json.sig"
v=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' meter.json)
curl -fLO "$base/v$v/usagemeter-linux-x86_64" -fLO "$base/v$v/usagemeter.SHA256SUMS"
sha256sum --check --ignore-missing usagemeter.SHA256SUMS
install -m 755 usagemeter-linux-x86_64 ~/.local/bin/usagemeter
```

The standalone `install.sh` in this folder still installs from the old upstream releases until it
is retired (RFC 0017 delivery 9); use the commands above instead.

Releases: every merge to `dev` that brings a shipping commit (anything but `chore(release)`,
`ci`, `docs` or `test`) cuts the next `0.N.0`, tags it and publishes the binaries.

## Shared binary

Several tools on a machine install and run the same usagemeter. They rely on this contract:

- **One install path:** `~/.local/bin/usagemeter`, written only by `install.sh` (atomically).
- **Version output:** `usagemeter --version` prints exactly `usagemeter <version>` (for example
  `usagemeter 0.2.0`) and exits 0.
- **Never downgrade:** when the installed binary reports a version at least the one requested
  (pinned) or published (latest), compared field by field as numbers (`0.10.0` is newer than
  `0.9.0`), `install.sh` changes nothing, prints why and exits 0. An older binary is replaced.
- **Concurrent syncs are safe:** `sync` takes a non-blocking exclusive lock on `meter.lock` in the
  state dir (see [What it stores](#what-it-stores)). A second run while one holds it skips: it
  prints `another sync is running; nothing to do` and exits 0.
- **Exit status of `sync`:** 0 when it ran or had nothing to do, 2 on an error, 3 when the state
  move blocks it (files in the new dir must be resolved by hand; one stderr line says which), 4
  when a rebuild, backfill or migration needs more free space than there is (twice the store's
  size plus what the logs still to import may add; nothing was changed) or ran out of room
  part-way (the store put back as it was), 12 when the store was written by a newer meter (nothing was read or written).
- **`query`:** genie's read-only, fork-and-exit answer, contract 1 under `meter.usage@1` (RFC
  0018 in automagik, schema and examples in `meter/schema/query/v1/`). See [Query](#query).
- **Release assets:** every release carries `usagemeter-darwin-arm64`, `usagemeter-darwin-x86_64`,
  `usagemeter-linux-x86_64` and `usagemeter-linux-aarch64`, plus `SHA256SUMS` and `install.sh`.

## What it reads

| Harness | Files | Notes |
|---|---|---|
| omp | `~/.omp/agent/sessions/**/*.jsonl` | Assistant messages and side calls (`model_usage`). omp's own `cost.total` is kept as reported $. No branch is recorded. |
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`) | Includes `<session>/subagents/*.jsonl`, rolled up to the parent session. Repeated lines are deduplicated by `message.id` + `requestId`. Advisor calls (`usage.iterations[]`, `type: advisor_message`) count under the advisor's model. 5-minute and 1-hour cache writes are kept apart. |
| dsh-tui | `~/.dsh/sessions/<cwd key>/<session>/session.v4.jsonl.zstd`, or `session.v4.jsonl` with compression off (or `$DSH_HOME/sessions`) | Append-only, multi-frame zstd; only whole frames are read, so a frame still being written waits for the next run, and bytes that are not a frame are skipped (counted) up to the next frame. Assistant messages (`assistant/message`) and compaction summaries (`compaction/summary`, a call of its own, counted once and never against the messages it summarises), deduplicated by the call's own id, so a forked session's copy of its parent's calls counts once in any read order. A session whose newest file is another format generation is not read, and the source then reports `unsupported`. No cost, no reasoning split (reasoning is unknown, never 0) and no branch are recorded. |
| Antigravity (`agy`) | `~/.gemini/antigravity-cli/conversations/<conversation>.db` (or `$AGY_HOME/conversations`) | One SQLite database per conversation, opened read-only. `gen_metadata` carries the provider's token counts: input, cache read and write, output, and the thinking part of output; `trajectory_metadata_blob` carries the folder, repository and branch. Each generation is counted once by conversation, generation index and the time of its first step. An unknown schema or row shape makes the source `unsupported` with a named reason; it is never counted as zero. No cost and no cache-write TTL are recorded, so cache writes count as 5-minute writes. Gemini models have no bundled price row: their tokens are visible as unpriced instead of a guessed $. The read-only open may create or update the `-wal` and `-shm` sidecars; it does not rewrite the database. |
| Codex | `~/.codex/state_<N>.sqlite` (highest N) and the rollouts it names under `~/.codex/sessions` or `~/.codex/archived_sessions` (or `$CODEX_HOME`) | See below. |

Antigravity:

- A refused or incomplete generation holds the cursor before itself. Rows after it are still read
  and counted, and the source reports `unsupported` or `degraded` until the row becomes readable.
  One permanently bad row therefore keeps the source visibly not counted rather than hiding later
  usage or vouching a zero.
- An input-only generation counts what it holds once its database and WAL have been quiet for 30
  minutes; output written after that is not added, because the cursor is already past the row.
- A new call that reuses an index and the previous call's first step time keeps the old dedupe
  key and is not counted. That includes a same-index retry that keeps the old step; the format
  writes a new call's steps with new times, so this is a stated limit, not a path the reader
  expects.

Codex:

- The state database is opened read-only (`mode=ro`, busy timeout 2 s) for one indexed query on
  `threads` changed since the last run (`updated_at_ms`, minus 10 minutes of slack), plus the
  spawn edges, then closed. Its columns are checked first; if one the meter reads is missing,
  Codex shows `unsupported` and nothing from it is counted; a database that cannot be opened or
  read this time shows `degraded` and is tried again next run. Codex's other databases (thread
  history, logs, memories) are never opened. A read-only open of a database in WAL mode may still
  create its `-shm` file if Codex is not running; it never writes data.
- A rollout's `token_count` events carry the thread's running total (`total_token_usage`), with
  cached input inside input and reasoning inside output. The meter keeps the highest total per
  thread id (not per path: rollouts move to `archived_sessions`) and counts the difference, at the
  event's own hour: `input_uncached = input − cached`, `cache_read = cached`. `last_token_usage`
  is not used: Codex repeats events, and summing it counts them again. A total that goes down is
  counted as 0 and shown as `degraded`.
- The first read of a rollout goes through the whole file (in chunks, within the time budget,
  resumable); later runs read only what was appended. A renamed rollout keeps its offset; one
  read again from the start (rewritten or copied) adds nothing already counted.
- A thread whose rollout is missing, or has no readable total (once idle for an hour), is
  counted from `threads.tokens_used` as `total_only`: the growth since the last run, at the hour
  of `updated_at_ms`, with no split and no $. A `token_count` line of an unknown shape makes the
  source `degraded` and its thread falls back to `tokens_used`.
- Sub-agent threads are counted on their own (a parent's total does not include its children's);
  the parent is kept as `parent_session`.
- The repo comes from `threads.git_origin_url` (credentials stripped), else from the cwd; the
  branch from `git_branch`, the model from `model`.

Logs are read incrementally from a saved byte offset, in 8 MB chunks. A line still being written
waits for the next run. A file whose inode, size or first 4 KB changed is read again from the start,
and the dedupe set absorbs what was already counted: it keeps every key in the import window, so
this holds however long the history is. Symlinks are never followed. Lines over 16 MB are
skipped and counted. Antigravity conversations are the exception: each database is opened
read-only every run and read from its saved generation index, because SQLite's size and mtime
do not track rows added to its write-ahead log.

## What it stores

One SQLite file (WAL) per machine, in the state dir:

- `~/.automagik/meter/meter.db` on every OS.
- `$AM_HOME/meter/meter.db` when `AM_HOME` is set to an absolute path.
- `METER_STATE_DIR` overrides both, and wins over everything.

The directory is 0700 and the file 0600.

Before 0.5.0 the state dir was `~/Library/Application Support/automagik/` on macOS and
`$XDG_STATE_HOME/automagik/` (else `~/.local/state/automagik/`) elsewhere. On a case-insensitive
macOS volume that is the same folder as the Automagik desktop app's own data, so clearing the
app's data deleted the store. The first `sync` of 0.5.0 or later moves the meter's own files out of
that old default, once: `meter.db` (with `meter.db-wal` and `meter.db-shm`),
`meter.lock`, `claude-limits.jsonl` and `claude-limits.last.json`. Nothing else in the old folder
is opened, and the folder itself stays.

- It runs under the new dir's `meter.lock` and the old dir's `meter.lock` (created empty if
  missing). An older meter that starts mid-move finds the old lock held and exits at once, as it
  does beside any running sync; it does not wait, and runs again on its next trigger. The move
  skips (exit 0, retried next run) while another run holds either lock. The old `meter.lock` is
  removed last; it stays only beside files that were left behind.
- It never replaces a file. `meter.db`, `meter.db-wal` and `meter.db-shm` are always copied,
  fsynced and compared, so the two dirs never share a file and an older meter writing to the old
  dir cannot change the new copy (the move needs free space for one more copy of the store). The
  `claude-limits.*` files are hard-linked on one filesystem, else copied the same way. Modes are
  kept. No old name is removed before its new entry is fsynced, including an entry an interrupted
  run already made; a failed fsync before that point stops `sync` with an error and the old file
  stays. A copy that fails (a full disk, a source that changed) removes its temporary
  `.<name>.part` file. A copy is placed with a hard link inside the new dir, which fails rather
  than replace a file there, so the new dir must be on a filesystem with hard links (APFS, ext4,
  and the like); on one without, the move stops and nothing is replaced.
- The database moves with its sidecars as one unit. First a `.meter-migrating` marker in the new
  dir records the length and SHA-256 of each of `meter.db`, `meter.db-wal` and `meter.db-shm`;
  then all of them are copied into the new dir and fsynced, and the marker is renamed
  `.meter-moved`. The next run finishes an interrupted move only if every file is still exactly
  what the marker recorded.
- The old `meter.db*` stay in the old dir as the recoverable generation (RFC 0018 (d)) until the
  next sync that succeeds: not the run that copied them, nor a run that fails, stops at its time
  budget or finds the last sync recent. That sync removes them, under the old `meter.lock`, only if
  they are still exactly what `.meter-moved` recorded, then removes the marker and prints one
  stderr line. If an older meter synced into them in the meantime, they are a store of its own:
  they stay, are never merged, and each later `sync` names them on stderr. While the old lock is
  held they stay until a later successful sync. The move therefore needs free space for one more
  copy of the store until then.
- An interrupted move whose old files changed since (an older meter wrote to them), or whose
  marker cannot be read, leaves two stores that may each hold rows the other lacks. The meter
  cannot merge them (rows are hourly rollups whose counts add up, so one row can have grown
  differently in each) and never decides which one is complete. Nothing is moved, overwritten or
  deleted, neither store is used, and each `sync` prints one line to stderr, syncs nothing and
  exits 3.
  To go on:
  1. Stop every meter, then copy both stores with `cp` (not `mv`) into folders of your own: the
     old dir's `meter.db*`, and the new dir's `meter.db*` and `.meter-migrating`. Opening a store
     in place replays and removes its WAL, so read the copies, not the originals.
  2. Compare the copies and choose the store to go on with. Remove the other one's `meter.db*`,
     and `.meter-migrating` from the new dir. The next `sync` moves the old store, or uses the
     new one.
  3. Keep the copy of the store you did not choose: the rows only it has are there and nowhere
     else. `sync --backfill` rebuilds every row from the logs still on disk, counting each event
     once whichever store had it, but it drops the rows whose logs are gone.

  A build of this move before the copy-only fix hard-linked `meter.db`. If `ls -i` shows the
  same number for the two `meter.db` names, the older meter's writes went into the new dir's copy
  too: it no longer matches its WAL and may not open ("database disk image is malformed"). Only
  the old store still reads back. Save both anyway (step 1), go on with the old store (step 2),
  then run `sync --backfill` to bring back, from the logs still on disk, the rows only the new
  dir's WAL held; rows whose logs are gone are lost from the active store either way.
- If the new dir already has a `meter.db` this move did not put there (even a byte-identical
  copy), the old files all stay and `sync` uses the new dir's store, printing one stderr line. If
  it has a `meter.db-wal` or `meter.db-shm` but no `meter.db`, nothing is created, moved or
  deleted, and each `sync` prints one line, syncs nothing and exits 3 until they are moved away.
- A `claude-limits.*` file the new dir already has a different copy of stays in the old dir, with
  the same one line.
- A `.meter-migrating` marker whose old files are all gone (removed by hand) is cleared when the
  new dir holds exactly the generation it recorded. Otherwise the new dir may hold half a store:
  `sync` exits 3 and syncs nothing until it is saved and the marker removed (see "An interrupted
  move" above). A `.meter-moved` marker with no old files left is removed.
- An empty `meter.db` (no bytes, no sidecars) in the old dir holds nothing: an older meter creates
  one before it takes its lock. The next `sync` removes it.
- If the new dir is the old dir under another name (a symlink), nothing moves.
- With `METER_STATE_DIR` set nothing is moved and `~/.automagik/meter` is not created.
- `status` and `query` open the store read-only (`SQLITE_OPEN_READ_ONLY`): they never take
  `meter.lock`, change the schema or checkpoint the WAL, and the database's content never changes.
  SQLite itself may add the store's `-wal` and `-shm` companions, so the folder is not always
  byte-identical afterwards; no other file is made. In a folder they cannot write, they read the
  store only when those companions already exist, and otherwise refuse by name
  (`read_only_folder`: `query` exits 1, `status` exits 2). They read the new dir, else the old dir
  before the first `sync` after an upgrade, and say which (`location`). While a sync runs they
  still read. While a move into the new dir has not finished they open nothing (`status` exits 2,
  `query` exits 1) with the reason. An old dir that holds usage the new store never counts (an older meter wrote to
  the kept copies, or a store of its own is there) is reported, never folded in: `status` says so
  in `legacy_store`, and `query` lists a `legacy-store` source.
- `prices.json` (below) is not moved; the run that moves the store says so on stderr. Copy an
  override from the old dir by hand. Rows are hourly `agent.usage` rollups keyed by (bot, role,
harness, model, machine, repo, branch, hour, precision); the row id (`idempotency_key`) hashes all
of it, so an hour has at most one `exact` row and one `total_only` row per key. The `ae_usage` view
renders each row as an `ae/1` envelope:

- `exact`: `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output` and
  `reasoning` (part of output), and no `unsplit`.
- `total_only`: `unsplit` (tokens known only as a total, never priced), and none of the split
  fields.

A store written by a meter older than schema 2 (row ids without precision) is rebuilt once from
the logs on the next `sync`: the old rows are dropped in the same transaction that resets the
offsets, so the doc never counts a token twice. Until the rebuild finishes, it is published with
`complete: false`. A schema 2 store is migrated to schema 3 in place, every row kept (below). No
prompt text, titles or file contents are stored, and no $ except omp's reported cost.

**Per-call evidence and links (schema 3, RFC 0021 delivery 5).** Beside the rollups the store keeps,
per counted call (RFC 0018 (b)): its time in ms, harness, model, machine, repo and branch as
logged, every token kind and the precision, the reported $, the folder it ran in and the one its
session started in, and its session, parent session and request ids as keyed 128-bit hashes (an
HMAC with a random key kept in the store; the raw ids are never written there). Its bot, kind,
role, squad, task and basis are derived from the `launch` and `link` tables, never typed in.
`launch` holds one row per Herdr launch (its start row's fields, its validity interval and what
ended it: an end row, a newer terminal, hc showing it finished, a detach, or `gone`, when a sync
no longer sees a terminal an earlier sync saw, with `gone_after` the last sync that saw it);
`link` one row per session in a launch (`session`, `label` or `worktree`), a changed one kept and
marked superseded. They follow RFC 0018 (b)'s rules without extending its session-to-task
contract. Each sync reads Herdr's ledgers whole (each at most 16 MiB, counted in the run's
budget; size, modification time and first bytes tell an unchanged set apart, so its diff is
skipped), writes what changed, and queues the sessions and start folders whose launches or links
changed: their calls' attribution is recomputed under the read budget, and a call whose
attribution changed moves its tokens from the old rollup row to the new one in the same
transaction (a run stopped by the budget resumes the queue). A schema 3 rollup keys on its squad,
`kind`, `basis`, `branch_basis` and `actor_state`; rows from before schema 3 keep their bot and
role for the doc but have no state: they are frozen and never counted as attributed, nor is any
hour before `evidence_from`. Retention (RFC 0018, proposed): evidence for 90 days or 1 GiB,
whichever comes first, oldest whole day first (`evidence_from` moves past it); closed launches and
links for 400 days. The rollups stay as they are.

**Recorded failures and pull requests (still schema 3, issues 899 and 1026).** For
[`usagemeter outcomes`](#outcomes), `sync` adds in place, the first time it runs: `ev_error`, one
row per tool failure (`tool_error`) or model-call failure (`api_error`) a harness flagged (its
time, kind, source, the harness, repo and branch as logged, its launch tag, the folders, and its
session and its own id as keyed hashes: no tool name, argument, output, error status or error
text), kept and pruned with the evidence; `pr`, one row per pull
request Herdr recorded (project, branch, number, repo, state and its times; no title, author or
address), kept 400 days; and on `launch` how its terminal ended (`end_reason`, `exit_code`,
`signal`, `end_source`, `ended_ms`). An older meter reads and writes such a store as before. It
does not record failures, so every sync stamps how far they go (`errors_through_ms`,
`api_errors_through_ms` and the log offsets, in `meta`): when another sync ran in between,
`errors_from_ms` or `api_errors_from_ms` moves to now. It stamps
the store's window too (`errors_counted_from_ms`): a reset by an older meter changes that window
and empties the tables the failures point into, so the next sync drops the failures kept.

- `repo` is `host/owner/repo` from the cwd's git remote, without credentials, port, query or
  fragment; worktrees resolve to their repository. No remote: null.
- `branch` is the session's `gitBranch` (Claude Code), or a Codex thread's (`branch_basis: log`,
  never replaced). omp and dsh-tui log none: a call of theirs that resolves to a worker launch
  takes that worker's start-row branch (`branch_basis: ledger`); any other stays null
  (`branch_basis: none`). Never from git or today's checkout.
- `bot`, `role`, `squad` come from the start row of the Herdr launch the call belongs to (RFC
  0021, `src/ledger.rs`): read from the global app home's `workers.jsonl` and `attach.jsonl`,
  `$HERDR_WORKERS_LEDGER`, and each project's `.herdr/app-home` above the call's cwd. The launch
  is found by a Herdr row naming the session, else an `agent.session` or `revive.session` label
  hc shows at the sync, else (workers only) the call's cwd being the worker's worktree. A
  dsh-tui session is also found by the terminal its own header names (RFC 0026 (d)): the launch
  on that address, on this machine, that was running when the session started; two such
  launches name none, and the call is ambiguous. A call
  with no claimant, or claimants that differ, stays null: a bot is never guessed. That holds
  only for logged launches: a terminal started by hand that ended before any sync saw it is
  invisible to the ledgers, so the worktree path could still name the worker beside it. The
  worktree names only a session that started there (a Claude sub-agent: where its parent
  started). A ledger anyone but its owner can write is not read: the sync says so on stderr and
  in every counting source's reason, and usage synced meanwhile stays untagged.
- `machine` is herdr-core's core id, or a random id kept in the store when hc is absent.

## Run

```sh
usagemeter sync                 # the normal run: at most 20 s, then publish
usagemeter sync --no-publish    # update the store only
usagemeter sync --backfill      # import the full history instead of 30 days (resumes across runs)
usagemeter sync --evidence-backfill --days 90   # per-call evidence for the last 90 days, re-tagged
usagemeter status               # what the store holds, as JSON
usagemeter coverage             # the store's bot-tag coverage, per window, repo and bot
usagemeter outcomes             # recorded failures and time to pull request, per window
usagemeter --version
```

`sync` options: `--force` (ignore the 10-minute freshness check), `--days N` (import window;
widening it re-imports), `--budget-secs N` (default 20), `--no-publish`, `--doc NAME` (default
`herdr-meter`).

- The first run imports 30 days, what the summary doc shows. A store that holds less (one first
  filled when the default was 14 days) is re-imported once to 30 days by the next plain `sync`.
- One run per machine: a second `usagemeter sync` while one runs exits 0 at once.
- A sync within 10 minutes of a complete one does nothing unless `--force`.
- When the budget runs out, progress so far is committed and the rest waits for the next run. A
  killed run loses at most the chunk it was on and never counts anything twice.
- A missing `hc` is not an error: the summary is just not published.
- `--evidence-backfill --days N` (RFC 0021 (c), run by the operator, never on its own): N is 1 to
  90, the evidence's retention, whatever the oldest ledger row says. For the hours before
  `evidence_from`, it re-reads the omp, Claude Code and dsh-tui logs still on disk and moves each
  call out of the rollup that counted it, with its evidence, to the row its attribution names
  now; totals never change. Then `evidence_from` moves back, and every call from then is queued
  to have its attribution recomputed from today's ledgers and labels. It runs under the budget,
  one transaction per chunk, and later syncs go on with it until it is done. Codex threads, usage
  whose logs are gone, and rows written before schema 3 keep their hours before evidence.
- A store a newer meter wrote is refused (exit 12) before anything is opened for writing.
- A write to an existing store's schema (a reset, the schema 3 migration, or the query's index on
  an older store) needs twice the store's size free (else exit 4, nothing changed). Before a reset
  drops a store's rows (an outdated store rebuilt, or a widened re-import) and before the schema 3
  migration, `sync` also keeps a generation: `meter.db.gen-<schema>-<utc>` (mode 0600), a copy of
  the store made with `VACUUM INTO`, reopened and checked table by table against the store's row
  counts. Only one is kept; the next sync that succeeds on the migrated store removes it, never
  the run that made it. The migration itself is one transaction that refuses to commit if any
  table would lose a row; `query` and `status` never migrate (a schema 2 store gives `query` exit
  13 until `sync` runs). For a reset, a backfill or the migration, the room needed also counts
  what the logs still to import may add, so a disk that would fill mid-run refuses up front: their
  bytes (every log in the window for a reset, else what lies past each log's stored offset)
  divided by 8, far above the measured ratio (about 1/137). A run that still runs out of room part-way (or meets
  a file-size limit) stops with exit 4: the generation it kept is put back (its wal and shm
  removed first), or, with no rebuild under way, the store keeps every chunk it committed and
  its old watermark. It is never reported as complete and fresh.

## Query

```sh
usagemeter query --repo example.com/acme/widgets --branch feat/x --branch fix/y --json
```

One call per project: one `--repo` (`host/owner/repo` as the meter normalizes a remote), up to 500
`--branch` names (64 KiB together, 255 bytes each), `--json` required. `--window d1|d7|d30`
(default `d30`), `--contract 1`, `--stale-after SECONDS` (default 7200). It prints one envelope
(`meter/schema/query/v1/envelope.schema.json`) on stdout for every exit: 0 answered, 1 error, 2
bad request, 10 no store, 11 no consistent snapshot within 2 s, 12 store from a newer meter, 13
store only `sync` can migrate, 14 contract not served, 15 the answer would pass 448 KiB (refused
whole, with how many rows would fit; it never pages or truncates). Each branch named gets one row:
`measured`, `zero` only when the meter can vouch for it, else `missing`, `stale` or `unsupported`
with the reason. Unknown is never 0: an unpriced amount, the reasoning of a harness that logs
none (dsh-tui) and the backlog while a reset's re-import is unfinished are null. The query never
syncs: only `sync` refreshes the store.
`sync` keeps an index on (repo, branch, hour), made by its first run after an upgrade (no row
changes, no new `schema_version`); a query reads the repo's rows in its window through it.
With `--since` and `--until`, an exact-date answer also counts the hourly-only tokens of its whole hours as before-evidence.

```sh
usagemeter query --repo example.com/acme/widgets --by bot [--branch feat/x ...] --json
```

Actors (RFC 0021 (d)): every answer says who its tokens belong to.
- Each row with tokens carries `attribution.actor`: `tokens_attributed`, `tokens_ambiguous`,
  `tokens_unlinked` and `tokens_before_evidence` add up to `tokens.total`; `tokens_by_basis`
  (`session`, `label`, `worktree`) to the attributed part; `tokens_by_branch_basis` (`log`,
  `ledger`, `none`) to the total. Usage before `evidence_from`, all of it while that is null, and
  rollups written before schema 3 are before evidence: never attributed, whatever bot they name.
- `actor_unattributed` holds the repo's usage in the window given to no bot, one part per reason
  (`claimants_differ`, `no_record`, `dsh_tui_seat`, `other_machine`, `before_evidence`).
- `--by bot` answers one row per (bot, kind, role, squad, unrecorded, harness) of attributed
  usage, the branches named (none needed) a filter. A bot with no row is 0 only when
  `actor_unattributed.absent_bot_is_zero` is true; otherwise it is unknown.

```sh
usagemeter query --repo example.com/acme/widgets --by task [--branch feat/x ...] --json
```

Tasks (RFC 0018 M3, RFC 0021 D4): one row per task id with task-labelled usage in the repo and
window, at `attribution.precision: task_interval`; the branches named (none needed) are a filter.
The row's `task` is Genie's short id, and its `actors` names every launch tag that did the work
(bot, kind `worker`, role, squad, unrecorded, harness), ordered like a bot row's key: a task
answered by several bots or roles names them all, never a guessed single one. The actor list is
bounded with the row; keys past the bound are counted in `actors_omitted`, never cut. A task id
the meter ties to more than one checkout of the repo is never summed: its row is `missing` with
`reason: task_ambiguous`, and the meter never prints a checkout path. Its numbers are
evidence-backed, so the branch row stays the total. A window with no task labels is an `ok`
answer with `rows: []` and the branch answer unchanged: a reader falls back to it.

## Fleet roll-ups

```sh
usagemeter fleet usage --json machine-a1b2c3.json machine-d4e5f6.json
usagemeter fleet outcomes --json --missing machine-z9y8x7:unreachable:ssh_timeout machine-a1b2c3.json
```

The fleet reducer reads local per-machine query or outcomes JSON files. Collection belongs to
its caller. It opens no store and makes no network calls. Missing machines make the answer
partial, unknown counters and prices stay null, and overlapping PR details are counted once.
The [fleet v1 contracts](../schema/fleet/v1/README.md) document compatibility checks, merge
rules, list caps and synthetic examples. Exit codes: 0 ok or partial, 2 bad request, 1 error.

## Coverage

```sh
usagemeter coverage                                   # text: d1, d7 and d30, every repo
usagemeter coverage --window d7 --window d30          # only those windows
usagemeter coverage --repo example.com/acme/widgets   # narrow the rows (repeatable)
usagemeter coverage --json                            # one record, for a fleet step
```

The store's bot-tag coverage (RFC 0026 (a)), over the same rows a `--by bot` answer counts: every
row of `usage` whose repo is in scope and whose hour is in the window, with tokens above zero.
They split into `attributed`, `ambiguous` (`claimants_differ`), `unlinked` (`no_record`,
`dsh_tui_seat`, `other_machine`) and `before_evidence`; the four counts are the total.
`bot_coverage` is attributed over total, four decimals, null (never 0) when nothing is counted;
`inspected` is attributed over the usage not before evidence, and is always printed beside it as
the diagnostic. The unit is tokens, never rows or cost. Usage with no repo is outside the
denominator and printed as `no_repo` store-wide, even with `--repo` (it belongs to no query
answer); `before_evidence_tagged` is the old definition's frozen tag, never in the numerator.
Each repo gets its four counts and ratio, each bot its attributed tokens, share and tie mix, with
the contract's `unrecorded` fields left visible: at most 50 repos and 50 bots are shown, the rest
are counted (`repos_omitted`, `bots_omitted`) and summed into an `other` line, so every total
includes every repo and bot, and `truncated` says when a list was capped. A zero class share or a
repo with no usage is a vouched 0 only when every source is `ok` or `absent` and no old folder's
store is degraded; otherwise it is `unknown` (a null share / `state: unknown`), and the record
names the unreadable sources (`incomplete_sources`, `all_vouch`). Ratios are always over counted
usage, never a bound; only token totals are lower bounds while ingestion is incomplete, stale or
the window is clipped. It opens the store read-only as `status` does and creates nothing (SQLite
may add an empty `-wal` and a `-shm` beside the store, as for the query): exit 0 reported, 1
error, 2 bad request, 10 no store, 11 no snapshot in time, 12 store from a newer meter, 13 store
only `sync` can migrate. The 64 KiB output ceiling is the RFC 0018 reference-workload bound; the
record itself is capped by the 50/50 lists, and delivery 5's per-machine entry bound cuts it
further.

## Outcomes

```sh
usagemeter outcomes                                   # text: d1, d7 and d30, every repo
usagemeter outcomes --window d7                       # only that window (repeatable)
usagemeter outcomes --repo example.com/acme/widgets   # only that repo (repeatable)
usagemeter outcomes --json                            # one record (`v: 1`)
```

Recorded failures and time to pull request (issues 899 and 1026), per window. Like `coverage` it
is local and read-only, and it is not contract 1: nothing here is in the query envelope.

**Failures are raw counts of facts something else recorded.** They are counts of harness-flagged
failures, including expected ones (a red test run while working test-first, a grep with no
match) and usage-limit stops (written after a harness's own retries, so a count of model calls
that failed for the session, not each retried attempt): they are not a quality verdict on their
own. The report prints integers per bot, kind, role, squad, harness, error kind and source, plus
the unattributed by reason. It prints no rate, ratio, threshold, label or score; scoring
behaviour stays in genie (RFC 0018 (c)).

| `error_kind` | `source` | What counts |
|---|---|---|
| `tool_error` | `harness_log` | A tool result the harness itself flagged as failed. **Claude Code:** a `tool_result` block with `is_error: true`, once per `tool_use_id`. **Codex:** an `event_msg` whose payload is `item_completed` and whose item has `status: "failed"` or an `exit_code` that is a non-zero integer, once per item `id` in its thread. |
| `api_error` | `harness_log` | A model call the harness itself flagged as failed after its own retries (model calls that failed for the session, not each retried attempt, including usage-limit stops). **Claude Code:** a `type: "assistant"` line with top-level `isApiErrorMessage: true` (the JSON boolean), once per top-level line `uuid` (a `<synthetic>` line, which usage already ignores; never counted as a `tool_error`). **Codex:** `unsupported` (rollout JSONL records no model-call failure marker). |
| `run_failed` | `hc_snapshot` or `workers_ledger` | A launch whose terminal ended on its own with a non-zero exit status or on a signal: `hc_snapshot` from hc's list of finished terminals, `workers_ledger` from an `end` row that copied them once hc no longer lists the terminal. A window's total names the sources its failed runs came from (`hc_snapshot,workers_ledger` for both); with no failed run, the sources of the ends it read. `killed` and `stopped_by_restart` are counted as ends (`run_ends`), never as errors. |

The markers are pinned by fixtures in `tests/fixtures/tool-errors/` (with the expected ids in
`expected.json`), and none is reinterpreted. A harness-flagged failure resolves to its launch
through the same session, label and worktree links as a call, and moves with it when a later
ledger row links its session.

**Unknown is never 0.**

- A harness with no pinned marker for a failure kind (omp, dsh-tui, Antigravity for `tool_error`;
  Codex, omp, dsh-tui, Antigravity for `api_error`) is listed as `unsupported`: its failures of
  that kind are unknown, and no row gives it a count.
- `errors_from` and `api_errors_from` are where the recorded `tool_error` and `api_error` counts
  start: the first sync of a meter that records each kind (logs read before it had those failures
  skipped), or the start of the window on a new store. A window that starts before a kind's start
  is `partial` for that kind, its count a lower bound. A sync by an older meter (after a
  rollback) reads logs without recording that kind, so the next sync moves its start to its own
  time: the gap is unknown.
- A reset by that older meter (a wider `--days`, `--backfill`) empties the tables a failure's
  bot, harness and repo are read from and leaves the failures. They are never read against
  those tables again: `tool_error` and `api_error` are `not_recorded` until the next sync, which
  drops them and starts `errors_from` and `api_errors_from` at its own time.
- A launch whose end hc no longer listed when a sync next looked is `unknown` in `run_ends`, and
  `run_failed` is then `partial`.
- A store no sync of this meter has prepared is `not_recorded` (the report creates nothing), and
  a window in which nothing ran, failed or opened is `no_data`: its counts and percentiles are
  null.

**Time to pull request** comes from `pr` rows Herdr appends to its `workers.jsonl` when it sees a
branch's pull request open, merge or close: `{event: "pr", project, branch, task, pr, state,
first_commit_at, opened_at, merged_at, closed_at, core, at}`. The meter asks no forge and reads
no title, author or address from a row; the repo is derived from `project`, as a call's is from
its folder. Per pull request the newest row (by `at`) gives the state, and a time it leaves out
keeps the one an earlier row gave. Two clocks, in whole seconds:

- from the branch's first commit: `to_open_s`, `to_merge_s`;
- from the branch's first worker launch before that moment: `launch_to_open_s`,
  `launch_to_merge_s`.

Each branch gets a row (`pr`, `state`, the four durations). A branch with worker launches in the
window and no pull request is `state: no_pr`, its durations null: it is counted in
`branches_no_pr` and is in no percentile. p50 and p90 are nearest-rank, with their sample count
`n` and null at `n = 0`, over the pull requests opened (the `to_open` clocks) or merged (the
`to_merge` clocks) in the window: for all of them, per repo, and per (bot, role) that launched a
worker on the branch before that moment. A branch several (bot, role) pairs worked on counts in
each (`n_shared` says how many of `n`), so those groups are views, not a partition. A pull
request with no such launch, or one whose launch recorded no role, is counted under
`unattributed`, and `attribution` is then `partial`. `no_first_commit` and `no_launch` count the
pull requests a clock has no sample for.

The output holds repos, branches, pull request numbers, bots, roles, squads, harnesses, counts
and seconds: never a tool name, argument, output, error text, session, folder or terminal. At
most 50 failure rows, 50 bots, 50 repos and 200 branches are shown per window and the whole
output stays under 64 KiB; what is cut is counted (`*_omitted`), and `truncated` says so. Exit
codes are `coverage`'s.

## The summary doc

`usagemeter sync` writes one doc per machine, `herdr-meter`, with `doc.get` then `doc.set` on the
version (retrying on `conflict`). It is a projection of the store for the phone, and stays under
64 KiB (see [Summary doc schema](#summary-doc-schema)).

$ is computed when the doc is written, never stored: omp's reported $ wins; otherwise a bundled,
dated list-price table (plus an optional `prices.json` next to the database) prices the tokens.
Every $ is an API-equivalent estimate, not an amount billed. Tokens of a model with no price, and
tokens known only as a total (`total_only`), are never priced: they are counted in `unpriced`.

## Summary doc schema

This is the contract the phone reads. Any change to it bumps `schema_version` and is listed under
[Schema history](#schema-history).

A synthetic example (`schema_version` 2, numbers made up, arrays shortened):

```json
{
  "schema_version": 2,
  "kind": "herdr-meter",
  "rows_schema": "ae/1 agent.usage",
  "meter_version": "0.2.0",
  "generatedAt": "2026-01-15T12:04:00Z",
  "machine": "core-1",
  "counted_from": "2025-12-17T00:00:00Z",
  "complete": true,
  "pending": {"bytes": 0, "files": 0},
  "prices": {"date": "2026-10-06", "source": "bundled",
             "label": "API-equivalent estimate at list price, not an amount billed"},
  "sources": {
    "omp": {"status": "ok", "last_success": "2026-01-15T12:04:00Z", "usage_lines": 40,
            "events": 40, "duplicates": 0, "skipped_lines": 0, "rewrites": 0, "unknown_models": []},
    "claude-code": {"status": "ok", "last_success": "2026-01-15T12:04:00Z", "usage_lines": 900,
                    "events": 450, "duplicates": 450, "skipped_lines": 0, "rewrites": 0,
                    "unknown_models": []},
    "codex": {"status": "degraded",
              "reason": "3 token_count lines in an unknown format; their threads count as total_only",
              "last_success": "2026-01-15T12:04:00Z", "usage_lines": 120, "events": 118,
              "duplicates": 0, "skipped_lines": 0, "rewrites": 0, "unknown_models": ["model-x"],
              "threads": {"exact": 30, "total_only": 2}}
  },
  "windows": {"d1": "2026-01-14T13:00:00Z", "d7": "2026-01-08T13:00:00Z",
              "d30": "2025-12-17T00:00:00Z"},
  "models": [
    {"harness": "claude-code", "model": "model-a",
     "d1": {"in": 120, "cr": 90000, "cw": 4000, "out": 2100, "usd": 1.2345},
     "d7": {"in": 800, "cr": 610000, "cw": 30000, "out": 15000, "usd": 8.5},
     "d30": {"in": 2500, "cr": 2400000, "cw": 110000, "out": 52000, "usd": 31.02}},
    {"harness": "codex", "model": "model-x", "priced": false,
     "d30": {"in": 5000, "cr": 400000, "out": 9000, "rs": 3000, "un": 70000, "unpriced": 484000}}
  ],
  "projects": [
    {"repo": "github.com/acme/app", "tasks": 3, "hours": 41, "usd_per_task": 9.1,
     "last": "2026-01-15T11:00:00Z",
     "d1": {"in": 120, "cr": 90000, "cw": 4000, "out": 2100, "usd": 1.2345},
     "d7": {"in": 800, "cr": 610000, "cw": 30000, "out": 15000, "usd": 8.5},
     "d30": {"in": 2500, "cr": 2400000, "cw": 110000, "out": 52000, "usd": 31.02},
     "untasked": {"in": 100, "cr": 50000, "out": 900, "usd": 3.72}},
    {"repo": null, "tasks": 0, "hours": 5, "last": "2026-01-14T20:00:00Z",
     "d30": {"in": 10, "cr": 2000, "out": 300, "usd": 0.05, "usd_rep": 0.05},
     "untasked": {"in": 10, "cr": 2000, "out": 300, "usd": 0.05, "usd_rep": 0.05}}
  ],
  "projects_other": {"count": 12, "tasks": 9, "d30": {"in": 40, "cr": 9000, "out": 700, "usd": 0.4}},
  "tasks": [
    {"repo": "github.com/acme/app", "branch": "feat/login", "agents": ["claude-code", "codex"],
     "first": "2026-01-13T09:00:00Z", "last": "2026-01-15T11:00:00Z", "hours": 12,
     "d1": {"in": 60, "cr": 40000, "cw": 2000, "out": 1000, "usd": 0.61},
     "d7": {"in": 400, "cr": 300000, "cw": 15000, "out": 8000, "usd": 4.4},
     "d30": {"in": 400, "cr": 300000, "cw": 15000, "out": 8000, "usd": 4.4}}
  ],
  "tasks_other": {"count": 40, "d30": {"in": 900, "cr": 80000, "out": 4000, "usd": 2.2}},
  "hourly": {"from": "2026-01-13T13:00:00Z", "hours": 48, "series": [
    {"harness": "claude-code", "in": [0, 12, 30], "cr": [0, 9000, 20000], "cw": [0, 400, 800],
     "out": [0, 210, 500], "usd": [0, 0.12, 0.3]}]},
  "daily": {"from": "2025-12-17", "days": 30, "series": [
    {"harness": "claude-code", "in": [100, 90], "cr": [80000, 70000], "cw": [3000, 2000],
     "out": [1500, 1200], "usd": [1.1, 0.9]}]},
  "truncated": []
}
```

Top-level fields:

| Field | Meaning |
|---|---|
| `schema_version` | 2. A reader that does not know the version should show nothing rather than guess. |
| `generatedAt` | When the doc was written (UTC, RFC 3339). |
| `machine` | herdr-core's core id (stable, not the hostname). |
| `counted_from` | Start of what the store holds. A window that starts before it is cut to it. |
| `complete`, `pending` | `false` while a first import is still running; bytes and files left. |
| `prices` | Date and source of the price table that produced every `usd`. |
| `sources` | Per harness (`omp`, `claude-code`, `codex`, `dsh-tui`, `agy`): `status` is `ok`, `degraded` (some usage could not be split or read; `reason` says why), `unsupported` (the harness's format is not one the meter knows; nothing from it is counted), or `absent` (not installed). A non-`ok` status is shown, never hidden behind zeros. `unknown_models` are models with no price. `codex.threads` counts threads by precision. |
| `windows` | Start of each rolling window, ending at `generatedAt`'s hour: `d1` = the last 24 hours, `d7` = the last 7 days, `d30` = the last 30 days (never before `counted_from`). |
| `models` | Every (harness, model) with usage in `d30`, never cut. `priced: false` when the model has no price. |
| `projects` | One entry per repo, biggest `d30` $ first (then tokens). `repo` is `host/owner/repo` from the git remote, without credentials or port; `null` is work outside any repo (or a repo without a remote). |
| `projects_other` | The repos cut from `projects` to fit, summed. Absent when nothing was cut. |
| `tasks` | One entry per (repo, branch) that is a task, most recently active first. |
| `tasks_other` | The tasks cut from `tasks` to fit, summed. Absent when nothing was cut. |
| `hourly` | Per-harness series for the last 48 hours: value `i` is the hour `from + i` hours. The phone can sum it to its own local "today". |
| `daily` | Per-harness series per UTC day for the last 30 days: value `i` is the day `from + i`. |
| `truncated` | What was cut to fit 64 KiB, in order. Empty when nothing was. |

Token object (`d1`, `d7`, `d30`, `untasked`, `*_other`): a field that is zero is left out, and a
window with no usage is left out.

| Key | Meaning |
|---|---|
| `in` | Input tokens not read from cache. |
| `cr` | Cache reads. |
| `cw` | Cache writes (5-minute and 1-hour together). |
| `out` | Output tokens, reasoning included. |
| `rs` | Reasoning tokens, already inside `out`: never add it to a total. |
| `un` | Tokens known only as a total, with no split (`total_only`, e.g. a Codex thread without its rollout file). Never priced. |
| `usd` | $ of the priced part: list-price estimate plus any $ the harness reported. |
| `usd_rep` | The part of `usd` the harness reported itself (omp). |
| `unpriced` | Tokens not covered by `usd`: unknown models plus `un`. When every token is unpriced, `usd` is absent. |

Total tokens = `in + cr + cw + out + un`.

Projects and tasks:

| Key | Meaning |
|---|---|
| `branch` | The git branch the agent recorded. omp and dsh-tui record none. |
| task | A (repo, branch) whose branch is not `main`, `master`, `dev`, `develop`, `trunk`, `HEAD` or missing. Work on those goes to the project's `untasked` bucket instead. |
| `untasked` | The project's untasked work over the `d30` window. |
| `tasks` (on a project) | Number of tasks with usage in `d30`. |
| `usd_per_task` | The project's tasked `d30` $ (excluding `untasked`) divided by `tasks`. Absent with no tasks or no $. |
| `hours` | Distinct hours with usage in `d30`: a rough measure of time spent. |
| `first`, `last` | First and last hour with usage in `d30`. |
| `agents` | Harnesses that worked on the task. `bots` lists hc bot labels when known. |

Fitting in 64 KiB: the doc first keeps every project and task. If it is too big it cuts, in
order, the number of tasks, then the number of projects (the rest go to `*_other`), then the hourly
window; each step is listed in `truncated`. Entries that stay always keep their repo and branch.
`models`, `windows` and the totals in `daily` are never cut.

### Schema history

0.5.0 moved the state dir to `~/.automagik/meter/` (see [What it stores](#what-it-stores)). That is
a path change, not a schema change: `schema_version` stays 2 and the `ae/1` rows are the same.

- 2 — per-project, per-task and per-model windows (`d1`/`d7`/`d30`), hourly and daily series per
  harness, `un`/`unpriced`, `sources.*.status`. Replaces version 1's `totals`, `hourly` and `daily`
  rows.
- 1 — hourly rows for 48 hours and daily rows before that, keyed by harness, model, repo and branch.

`prices.json` format, USD per million tokens:

```json
{"date": "2026-01-01", "models": {"some-model": {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_write_5m": 1.25, "cache_write_1h": 2.0}}}
```

## Develop

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Tests use synthetic fixtures only. In the Automagik monorepo, the root `.github/workflows/ci.yml`
(its `usagemeter` job) runs the same on Linux and macOS, then `tests/install.sh`, which installs
the binary it built with `install.sh` from a release laid out on disk. The version is the
repository's one version: the root `scripts/version.ts` writes it to `Cargo.toml` and
`Cargo.lock`. Releases come from here, on the meter lane (RFC 0017 in the repository's
`docs/rfcs/`), and installers take them through the signed `meter-lane` pointer (see Install).

Some names still say "meter" because existing installs and readers depend on them: the state
files `meter.db` and `meter.lock`, the variables `METER_STATE_DIR`, `METER_HC` and `METER_TRACE`,
the doc name `herdr-meter` (also its `kind`), the doc key `meter_version`, the `meter:` prefix of
the log lines, and the library crate name `meter`.

## `usagemeter repair` (issue 1126)

Tops up rollup totals a store lost, from an oracle: a second state directory the operator built
from the frozen logs with the existing commands (`METER_STATE_DIR` on a scratch folder, then
`usagemeter sync --force --days N --no-publish`, one harness at a time). The repair never reads
a log.

```
usagemeter repair --store STORE_DIR --against ORACLE_DIR [--from DAY] [--until DAY] [--json]
usagemeter repair --store STORE_DIR --against ORACLE_DIR --apply --copy FILE --confirm-copy SHA256
```

- `--store` is always given: the repair never defaults to the state directory, so it never
  opens a store no flag named. Without it the command is a usage error (exit 2). The plan's
  first line names the store.
- The range is 2026-11-07..2026-11-10 unless `--from` / `--until` change it (a date or an hour bound, below). A short cell
  outside it is reported, never repaired.
- The default is a dry run over two read-only opens: nothing is written. It prints, per harness,
  day and column, the tokens before, after and the change, with events; a TOTAL; `unresolved`
  (hours with rows and no oracle rows, and short groups whose rows are all attributed, left
  alone and listed with their reason); `kept` (cells where the store holds more than
  the oracle: never subtracted); and `conservation: PASS` or `FAIL` with its reasons. `--json`
  prints the same as one record.
- `--coarse` matches on (harness, hour, model, precision) only, the store's rows summed across
  machine, repo and branch: an oracle built from frozen logs in a scratch home carries another
  machine id and fills repo and branch differently, so the exact key matches nothing. Without
  the option the exact key stays; nothing switches by itself. With it, a short group never
  changes an existing row: its per-column shortfall (`max(0, oracle - store)`) becomes ONE NEW
  row with the group's harness, hour, model and precision, machine empty, branch empty, events 0,
  no actor state and no bot (before evidence), and only the added tokens. Its repo is the one
  repo that is short in the group (per repo, oracle minus store over the seven columns: exactly
  one above 0 and none below) in the store's naming; otherwise it is empty.
  `--repo-alias OLD=NEW` (repeatable, `--coarse` only; OLD ending in `/` is a prefix) makes two
  names one repo (the oracle's `host/org-a/x` and the store's `host/org-b/x`); aliases are
  printed in the plan header. The new row is stored with `machine = ''` (the column is `NOT
  NULL`, and sync always writes a machine, so no sync row can collide with it), `repo` and
  `branch` NULL where empty, and an id starting `repair1126:` (sync ids are 32 hex digits). A
  later sync never matches it: adoption and re-keying look rows up by a full key with a machine,
  and `freeze_unbacked` only reads rows that have an actor state. A rerun finds nothing to do
  (exit 3): the new rows are in the group sums. The plan header and JSON name the match used and
  the row counts; every top-up lists its labels (a new row: machine empty, its repo or none,
  branch empty, precision), the tokens per column and its group's store row count; the per-
  harness, per-day added tokens, the new rows created and the existing rows changed (0) are
  printed.
- `--from` and `--until` take a date (`--until` counts the whole day) or an RFC 3339 UTC time
  exactly on the hour (`2026-11-10T14:00:00Z`); the end is excluded. A time not on the hour is a
  usage error. Hours past the bound are left out of every write and every check; the plan header
  and JSON print the exact bounds.
- Per group (hour, model, machine, repo, branch, precision, summed over actor state),
  `after = max(before, oracle)` per column. Events never change: a group whose events differ
  fails the run. The top-up goes to the group's evidence-free row (before evidence), so no
  hour's evidence sum passes its rollup and no token is attributed without a call behind it; a
  short group with no evidence-free row is left alone and listed as unresolved. Every total
  (TOTAL, unresolved, kept, outside) adds the six counted columns: `reasoning` is part of
  `output`, repaired in its own column but never added to a total. A gap in `reasoning` alone
  is still a change: it is printed, exits 0 and is applied (so the store ends equal to the oracle
  in every column), with a counted total of 0. Codex and Antigravity must change by 0.
- Exit: 0 a plan (or applied), 1 conservation failed, 2 usage or unreadable store, 3 nothing to
  repair, 12 the store is from a newer meter.
- `--apply` is refused without a copy. Take the sync lock's quiet moment, make the copy with
  `sqlite3 meter.db "VACUUM INTO 'copy.db'"` (or any consistent copy), `sha256sum` it, and pass
  `--copy copy.db --confirm-copy <that sha256>`. The copy must be a separate file: a symbolic
  link, a hard link or any spelling of the store itself is refused. Every refusal that needs no
  lock (the copy, its sha256, its counts, the schema) comes before the lock is taken and creates
  nothing in the store's folder; the lock file, once created, is never removed. The command checks the file's sha256, its
  `quick_check`, and that it holds as many rollup rows and tokens as the store (after a partly
  done run, the store may hold more). It then takes the sync lock, refuses a newer schema, and
  writes one transaction per day. Each day checks its own conservation inside the transaction and
  rolls back and stops on a failure; the `meta` key `repair_1126_done` records the last day
  done, and decides nothing. The plan is rebuilt from the live rows on every run, so a day done
  earlier (also by a run narrowed to one day) plans 0 and a day not done still plans. An apply
  that commits fewer days than the plan has exits 1; a run with nothing left exits 3 and writes
  nothing. The applied days are printed.
