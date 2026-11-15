# RFC 0021 deliveries 7 and 8: evidence from the build host

Evidence for [RFC 0021](../rfcs/0021-meter-attribution.md), deliveries 7 (reaching machines) and
8 (the backfill), taken on the build host on 2026-11-10. Aggregate numbers only: no bot names,
sessions or prompt text. Token counts are raw counts; times are UTC.

| Delivery | Check (the RFC's words) | Conclusion |
|---|---|---|
| 7 | a machine that took the pack release runs a meter whose `query --by bot` answers (the wording when this was taken) | **Met**: the owner accepted the reading in "How the meter reached this machine" on 2026-11-12, and the RFC's Check now names the signed meter lane |
| 8 | `actor_unattributed` falls for the backfilled hours; rows before the ledger stay unknown | **Not met**: both halves of the Check hold, but the backfill changed the store's rollup totals by 0.70% (reported in #1114; cause fixed by #1127); open until #1126 explains and repairs the loss on this store |

## How the meter reached this machine

When this evidence was taken, the RFC's exit line for delivery 7 was "a machine that took the
pack release". What happened here, plainly:

- The pack is **not installed** on the build host. `am update --check --json` reports the pack as
  `not-installed` before and after, so there is no installed `am-sidebar/VERSION` to record.
- The meter reached this machine through the **signed meter lane**, by way of am: `am update`
  took am from 3.108.21 to 3.117.2 (from the signed am-lane), and
  `automagik-herdr meter install --local` installed usagemeter from the signed `meter-lane`
  pointer, checksum verified. It did not arrive inside a pack install.
- Whether that counts as "took the pack release" was for the owner. The owner accepted this on
  2026-11-12 at 07:32Z, by choosing "Yes, accept it" in a question put to him by the main bot. It
  covers delivery 7 only, not delivery 8. The RFC's Check is amended in the same pull request to
  name the signed meter lane.

## Versions

| When | `usagemeter --version` | sha256 of `~/.local/bin/usagemeter` | Matches |
|---|---|---|---|
| Start | 3.108.19 | `fc354798…5f283bf9` | `usagemeter-linux-x86_64` in v3.108.19's `usagemeter.SHA256SUMS` |
| After the update | 3.116.0 | `4ab2820f…0cf492fa` | the `linux-x86_64` entry of the `meter-lane` pointer (v3.116.0, sequence 1160000) |
| At the backfill and after | 3.118.1 | `3864d44c…f4d59653` | `usagemeter-linux-x86_64` in v3.118.1's `usagemeter.SHA256SUMS` |

Every build is a released one (v3.116.0 and v3.118.1 are later than v3.114.1, the first release
carrying the query); none is a local cargo build. The binary moved from 3.116.0 to 3.118.1
through the meter lane between the "before" and the backfill, so the before/after below spans two
meter versions. The pointer has moved on since (3.123.3 when the "after" was taken).

## Delivery 7

On 3.108.19, before the update, neither command existed:

```
usagemeter query --by bot --json                 exit 2, unknown option "--by" for query
usagemeter sync --evidence-backfill --help       exit 2, unknown option "--evidence-backfill" for sync
```

On 3.116.0, before any sync, the store was still schema 2:

```
usagemeter query --repo github.com/automagik-dev/automagik --by bot --json
    exit 13, status outdated_store (store schema 2, supported 3)
```

**Migration first.** Only `usagemeter sync` migrates the store, so one plain sync
(`usagemeter sync --force --no-publish`) ran before any `--by bot` answer existed. Delivery 8's
"before" is therefore taken on the migrated schema 3 store, not on the 3.108.19 store.

After that sync, `query --by bot` answers (exit 0, status `ok`, contract 1, windows d1, d7, d30):

| When | Meter | `evidence_from` | Bot rows d1 / d7 / d30 | Tokens in bot rows (d30) |
|---|---|---|---|---|
| Before the backfill (as of 14:49Z) | 3.116.0 | 2026-11-10T15:00Z | 0 / 0 / 0 | 0 |
| After the backfill (as of 19:06Z) | 3.118.1 | 2026-11-07T00:00Z | 18 / 26 / 26 | 2,341,809,916 |

The rows after the backfill are seats and workers on Claude Code and dsh-tui, all in state
`measured`. Before it the answer was well formed but empty: every token of the window was
`before_evidence`.

**Conclusion: met**, on a released meter that came through the signed meter lane by way of am,
with no pack install; accepted by the owner on 2026-11-12.

## Delivery 8

### The command

The oldest ledger row in the store is 2026-11-07T17:03Z. The backfill starts at the start of the
day N−1 days ago, so on 2026-11-10 `--days 4` starts at 2026-11-07T00:00Z; `--days 3` would miss
the ledger's first hours. 4 is inside the retention bound (the help says 1 to 90; the meter
refuses more).

```
usagemeter sync --evidence-backfill --days 4 --budget-secs 300 --no-publish
```

It ran once, on 3.118.1: exit 0, empty stderr, nothing left to resume. Its report:

```
meter: read 1.8 MB from 94 of 1630 files in 14.8s; 24 new usage events, 19 duplicates dropped, 0 skipped lines
meter: attribution: 5 launch and 10 link rows changed, 0 calls moved
meter: evidence backfill from 2026-11-07T00:00:00Z: 49952 calls given their evidence, 7233 left as they were (no row before evidence held them as logged); done, attribution queued for recompute
meter: summary (65.3 KB) not published (--no-publish)
```

### `actor_unattributed` from the query

The "after" windows end five hours later than the "before" ones, so these are indicative; the
fixed-cut table below is the exact comparison.

| Window | Before: total (all `before_evidence`) | After: total | After: `before_evidence` | After: unlinked | After: ambiguous |
|---|---|---|---|---|---|
| d1 | 5,337,658,037 | 2,699,832,759 | 1,621,115,616 | 1,065,511,357 | 13,205,786 |
| d7 | 14,197,446,887 | 12,016,126,933 | 7,558,075,942 | 4,305,383,898 | 152,667,093 |
| d30 | 16,185,555,593 | 14,004,235,639 | 9,546,184,648 | 4,305,383,898 | 152,667,093 |

After, the unlinked part splits into `dsh_tui_seat` (3,247,457,079 in d30) and `no_record`
(1,057,926,819); the ambiguous part is `claimants_differ`.

### Fixed cut: the store's hourly rollups

Read straight from the store, read-only, with one script before and after: every rollup row of
an hour before 2026-11-10T14:00Z, tokens summed over all token columns. "No state" means the row
carries no actor state (it is before the evidence).

| Day | Tokens before | Tokens after | Change | After: attributed | After: ambiguous | After: unlinked | After: no state |
|---|---|---|---|---|---|---|---|
| The 18 days with rows from 2026-10-16 to 2026-11-06 | 9,143,847,675 | 9,143,847,675 | 0 | 0 | 0 | 0 | 9,143,847,675 |
| 2026-11-07 | 963,326,332 | 914,972,347 | -48,353,985 | 131,288,134 | 4,795,814 | 217,876,348 | 561,012,051 |
| 2026-11-08 | 3,518,848,033 | 3,494,853,202 | -23,994,831 | 359,007,538 | 3,551,385 | 948,441,348 | 2,183,852,931 |
| 2026-11-09 | 7,887,412,393 | 7,805,835,819 | -81,576,574 | 1,304,679,876 | 131,294,703 | 2,481,169,643 | 3,888,691,597 |
| 2026-11-10 (to 14:00Z) | 2,595,775,482 | 2,581,854,349 | -13,921,133 | 589,987,782 | 13,205,786 | 681,622,911 | 1,297,037,870 |
| **All** | **24,109,209,915** | **23,941,363,392** | **-167,846,523 (-0.70%)** | 2,384,963,330 | 152,847,688 | 4,329,110,250 | 17,074,442,124 |

Before the backfill the only rows with a state were Antigravity's (218,603,721 tokens,
`unlinked` / `no_record`); everything else had none.

| Harness | Tokens before | Tokens after | Change | Events before | Events after |
|---|---|---|---|---|---|
| Claude Code | 14,318,106,296 | 14,303,759,370 | -14,346,926 | 54,596 | 54,596 |
| dsh-tui | 9,133,972,625 | 8,980,473,028 | -153,499,597 | 36,935 | 36,935 |
| Codex | 438,527,273 | 438,527,273 | 0 | 2,502 | 2,502 |
| Antigravity | 218,603,721 | 218,603,721 | 0 | 1,614 | 1,614 |
| **All** | **24,109,209,915** | **23,941,363,392** | **-167,846,523** | **95,647** | **95,647** |

### What holds

- **`actor_unattributed` falls for the backfilled hours.** In the four backfilled days,
  2,384,963,330 tokens moved to bot rows, and the tokens with no evidence fell from
  14,746,758,519 (all of the four days' 14,965,362,240 but Antigravity's 218,603,721, which
  already carried a state) to 7,930,594,449.
- **Rows before the ledger stay unknown.** Every hour before 2026-11-07 is unchanged, to the
  token, and none of it is attributed. This half is shown per day only: the oldest ledger row is
  2026-11-07T17:03Z, and the table does not split that day's 131,288,134 attributed tokens at
  that hour, so it does not show that none of them fall before it.
- **The retention bound.** `--days 4`; the 3.118.1 help states 1 to 90 for `--evidence-backfill`.
  The refusal above 90 was not exercised here.

### What fails

- **"Totals never change" did not hold in the rollups.** The store's hourly rollup total fell by
  167,846,523 tokens (0.70%), only in the four backfilled days and only for the two harnesses
  whose logs the backfill re-reads (dsh-tui and Claude Code). Event counts did not move.
- For dsh-tui the per-call evidence of those hours sums to 9,044,309,914 tokens over 36,040 calls
  while the rollup rows of the same hours sum to 8,890,810,317: the difference is the same
  153,499,597. The tokens are in the evidence and missing from the rollups.
- Limits of this measurement: the "before" kept summed totals only, so the Claude Code difference
  cannot be split by token column; the binary changed from 3.116.0 to 3.118.1 between the
  "before" and the backfill, so this run alone does not say which of the two (the backfill or the
  newer meter's sync) moved the total. Nothing was rerun.

**Conclusion: not met.** The Check's two halves hold, but the backfill's own guarantee, that no
total changes, failed on this machine. Reported in issue #1114, since closed into #1126. #1127
(merged 2026-11-12) fixed the cause, so a backfill on a later meter loses nothing new; it does not
explain or repair the 0.70% already lost on this store. Delivery 8 waits on #1126 for that.
