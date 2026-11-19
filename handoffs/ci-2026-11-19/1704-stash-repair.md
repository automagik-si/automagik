# #1704 repair 3: a stash is work too

- Date: 2026-11-19 (UTC)
- PR: [automagik-si/automagik#1704](https://github.com/automagik-si/automagik/pull/1704)
- Branch: `feat/wish-copy-reaper`, base `dev` (`0a5efdb9e6936d49a1780bb14399edb7d30559bf`)
- Previous head: `da8560d10442c3fd5f7cf38febae6f818f319ed0`
- **New repair head: `fe7768c5b096b6175dee3d5879307af763332ccc`** — pushed non-forced
  (`da8560d10..fe7768c5b`), confirmed on `refs/heads/feat/wish-copy-reaper` and as the PR's
  `headRefOid`; PR OPEN, not a draft, base `dev`. This report is carried by a docs commit on top
  of the repair; the PR body names the branch head at final verification.
- Worktree: `/home/namastex/.automagik/bots/workspace/wishes/automagik/1704-repair-3-a-stash-is-work-too`

## The two blocking findings

1. `localRefs` listed only `refs/heads/*`, `refs/tags/*` and `HEAD`, so a clean copy of an
   advertised `dev` whose only unpublished work was a `git stash` (or a `refs/notes/commits`
   entry) was decided `remove/head-on-remote` and `rm -rf`'d, exiting 0.
2. A read failure during inspection or the pre-removal recheck was a `keep` with no error, so it
   read as success: a `status` that failed only on the recheck printed
   `keep … inspection-failed (recheck: git status failed)` and exited 0; an EACCES `scandir` on
   `handoffs/`/`docs/` did the same during inspection.

Both are repaired in `scripts/wish-reap.mjs`; no other project code changed.

## Every local ref is inspected

`localRefs` now runs `git for-each-ref --format='%(refname) %(objectname)' refs/` and keeps every
ref that resolves to a commit:

| Ref namespace | Inspected | Why |
| --- | --- | --- |
| `refs/heads/*` | yes | a local branch may be ahead of the remote |
| `refs/tags/*` | yes | a local tag may name an unpublished commit |
| `refs/stash` | yes | the stash commits are saved product work that no other ref reaches |
| `refs/notes/*` | yes | note commits are local objects; `refs/notes/commits` names them |
| `refs/replace/*` | yes | a replacement object can exist only locally |
| any other ref under `refs/` (e.g. `refs/bisect/*`, `refs/rewritten/*`) | yes | the rule is the namespace, not a list |
| `HEAD` | yes | covers a detached HEAD, and is added separately |
| `refs/remotes/*` | **no** | it is this clone's cached copy of an answer the remote gave earlier, not the remote's current advertisement. Trusting one as "published" could hide a commit the remote no longer has (the existing stale-`origin/feature` fixture), and it can never hold work that exists only here, so treating one as local work would only keep copies for old cache. |

The advertisement side is still the remote's own answer: `git ls-remote <url>` with no patterns, so
every ref the remote advertises counts — branch heads, tags and peeled tag entries, pull-request
heads, and notes or replace refs when the remote carries them. No forge API and no local
remote-tracking ref is consulted. That is why a note the remote advertises is published and the
copy goes (new fixture), while a note only the copy has keeps it.

### Stash and note decision: kept, not preserved

Both are **kept**, with the decision visible in the human line and the JSON:

- a stash: `keep <copy> unpublished (ref refs/stash carries local-only merge <sha>)`,
  `lostWork: true`, exit 1, copy and stash still present;
- a local note: `keep <copy> unpublished (ref refs/notes/commits carries unpublished product change
  <sha>:<note-path>)`, `lostWork: true`, exit 1, note still present.

Keeping is the faithful choice the wish allows: a stash is a merge of a working-tree commit and an
index commit (and may be partial), so replaying it as a patch into `--preserve` is not provably
faithful, and a note commit is a git object tree, not a product file. The copy stays whole and the
reason names the ref.

## Read failures: kept and exit 3, never success

`keepUnreadable()` marks an entry `error: true` and `readFailure: true`, keeps the copy, and the
run exits **3**. It does not count as `keptForLostWork`. Cases:

- inspection: git dir unresolvable, HEAD unresolvable, `scandir` on `handoffs/`/`docs/` failing
  (EACCES), `git status` failing, `scanCopy` failing, local refs or local-only commits not
  listable, a commit diff not readable, `git ls-remote` failing, preserve classification failing;
- the pre-removal recheck: the same full scan (below) failing in any of those ways, with
  `recheck: ` prefixed to the detail;
- preserve, removal and prune failures (unchanged).

Exit-code contract:

- `0` — clean; everything removable was removed (or would be, in a dry run);
- `1` — a copy was kept for lost work: dirty, unpublished product change, local-only merge, an
  unpreservable kind, a same-path tie, or a removal-time dirty copy;
- `2` — invalid usage;
- `3` — a copy could not be read, preserved, removed or pruned; exit 3 wins over exit 1.

JSON shows the distinction: `summary.keptForLostWork` (exit 1) vs `summary.readErrors` (exit 3)
vs `summary.removalErrors` (exit 3, preserve/remove), and each copy carries `readFailure: true`
when its state could not be read. The human summary appends `, N unreadable` when any read failed.

## The pre-removal recheck repeats the whole scan

`recheck()` now calls `inspect()` again instead of re-running only the cheap gates. The fresh
decision covers the same ref scan (stash, notes, replace, every ref), locks, idle, dirty state,
advertisement and preserve classification. If the fresh decision is no longer `remove`, the copy
is kept with that reason (and exit 3 if it was a read failure); otherwise the fresh preserve set,
sha, size and removal method replace the inspection's. A stash created between the decision and
the removal therefore keeps the copy — proven by a `git` shim that stashes on the recheck's
`status` call.

## Same-path rule: newest wins, tie keeps the copy

When commits on two local refs change the same `handoffs/`/`docs/` path, `preservedWinner()`
compares the blobs at that path and takes the **newest committer time** (`git show -s --format=%ct`).
If the times are equal and the bytes differ, it keeps the copy with reason `preserve-conflict`
(lost work, exit 1) instead of silently choosing one. The fixture uses fixed commit dates
(`2026-01-01` on `a-older`, `2026-06-01` on `z-newer`); the old last-visited code preserved
`older`, the repair preserves `newest`.

## Tests, red first

The seven new fixtures fail at `da8560d1` and pass now:

1. a git stash holding a product change keeps the copy and names `refs/stash`;
2. a `refs/notes/commits` entry keeps the copy and names the ref;
3. a stash created between the decision and the removal keeps the copy (shim);
4. a `git status` failure on the pre-removal recheck keeps the copy and exits 3;
5. an unreadable `handoffs/` during inspection keeps the copy and exits 3;
6. an unreadable `docs/` during inspection is not counted as kept lost work and exits 3;
7. two local refs, one docs path: the newest ref wins (`newest\n`, not `older\n`).

Two more regression fixtures guard the boundaries the wish asked to keep: a note the remote
advertises is published and the copy goes (kills a heads/tags/pull-only `ls-remote`), and a stale
`refs/remotes/origin/gone` ref is cache, not local work, so it does not keep a copy whose only refs
are advertised (kills counting refs/remotes as local work).

- Red at `da8560d1`: **18 pass / 7 fail**, 179 `expect()` calls, 25 tests (the two regression
  fixtures already pass there).
- Green: **27 pass / 0 fail**, 219 `expect()` calls, 27 tests.
- Both PR test files (reaper + worktree helper): **30 pass / 0 fail**, 262 `expect()` calls,
  30 tests.
- Every existing fixture stays green: dirty, locks, recent, pull-ref, tags, branches, symlinks,
  FIFO, empty dir, worktree removal, failed removal exit 3.

## Gates

- `scripts/capped-run -- bun test scripts/wish-reap.test.ts`
- `scripts/capped-run -- bun test scripts/wish-reap.test.ts scripts/wish-worktree.test.ts`
- `scripts/capped-run --lock -- bun run check` (the repo's script gate): **513 pass, 17 skip,
  0 fail**, 9196 `expect()` calls, 530 tests across 36 files; `marketplace: 6 plugins ok`.
  The first attempt failed 14 `server-checkout-cli` tests only because this copy had no
  `node_modules` (`Cannot find module '@deepseek-ai/dsh-plugin-market-index'`); after
  `bun install --frozen-lockfile` the gate is green. No capped run was reported as a test failure.
- `shellcheck -s sh scripts/wish-worktree.sh`: clean.
- `node --check scripts/wish-reap.mjs`: clean.
- `git diff --check`: clean.

## Mutations (all killed)

Each mutant was applied to `scripts/wish-reap.mjs`, the reaper test file was run through
`scripts/capped-run`, and the file restored.

| Mutant | Result | Killer(s) |
| --- | --- | --- |
| M16 `localRefs` back to heads/tags only | 24 pass / 3 fail | stash, notes, stash-between fixtures |
| M17 read failure kept but not exit 3 (`keepUnreadable` → `keep`) | 24 pass / 3 fail | recheck-status, `handoffs/` EACCES, `docs/` EACCES |
| M18 recheck skips the full scan | 25 pass / 2 fail | stash-between, recheck-status |
| M19 last-visited ref wins the same path | 26 pass / 1 fail | newest-ref fixture |
| M20 `refs/remotes/*` counted as local work | 26 pass / 1 fail | stale remote-tracking fixture |
| M21 remote queried only heads/tags/pull | 26 pass / 1 fail | published-note fixture |

## Kept as it was

The remote advertisement rule, every-ref inspection, the recursive `*.lock` scan, kind-based
preserve (symlinks as links; FIFO/socket/device keeps the copy), the exit 1 vs 3 distinction,
dry-run by default, and never passing `--force`. No Reviewer, Tester or Fixer verdict comment was
posted; nothing was merged, force-pushed, or pushed to another branch.
