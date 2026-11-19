# PR #1674: merge `dev` before its verdicts

Prepared at 2026-11-19, wave C. PR https://github.com/automagik-si/automagik/pull/1674,
branch `wish/wave-c-1556-restart-at-a-threshold`, base `dev`.

## Result

- **New head:** `67202bbcae45f090ef6edf54e0714c8ffa1f1444`
  (`chore(merge): bring dev into the #1556 restart branch`).
- **Merge parents:** `84583dddf0a170aa6e1da40cfb51f91ebb4df64e` (the branch head the wish
  named) and `26b233361359cbe2f4b883d396f09962b0f92e8b` (`dev`: `feat(bots-dsh): a Bot's
  channels and chats under its new left-bar row (#1402)`). Merge base `db07dd8fc`.
- Pushed non-forced (`84583ddd..67202bbca`). No other branch was touched, no force-push, no
  rebase, and the PR was not merged.
- The remote branch ref and the PR's `headRefOid` both read `67202bbca`; the PR is **OPEN**,
  not a draft, base `dev`, and GitHub reports **`MERGEABLE`** (`mergeStateStatus: UNSTABLE`,
  checks pending) where it had reported `CONFLICTING`/`DIRTY` at `84583ddd`.
- CI had **started**: the push queued the `CI` workflow at `67202bbca` (run `44505565538`);
  `Commit messages` already succeeded. No run was started or stopped by hand, and no CI result
  is claimed.

## How the merge was made

`dev` was fetched at the start and read `3955a09a9ac4`. While the five conflicts were being
resolved, `dev` moved to `26b233361`; the merge was rebuilt on the new head (reset to the
branch head, then a real two-parent merge of `26b233361`, not a rebase). The branch was
re-fetched immediately before the commit and before the push and never moved from `84583ddd`.
After the gates, `dev` moved again to `de50a6ad1` (release `v3.157.13` plus the `apps/id`
security headers); it touches none of the conflicted files, so the verified merge was pushed
and GitHub still reports it mergeable.

## Conflicts and how each was resolved

All five were independent insertions on both sides, so the resolution is "keep both" in each
case.

| File | Conflict | Resolution |
| --- | --- | --- |
| `herdr/mods/am-sidebar/model.js` (2 hunks) | #1556 `restartAt` normalization/warning vs #1413 `permissionMode` normalization/warning, and `checkBots`' `restartAtProblem` vs `permissionModeProblem` check | Both kept: the `restartAt` warning block and the `permissionMode` warning block, then both checks in `checkBots`. |
| `am/model.js` (2 hunks) | Byte-equal copy of the same two hunks | Resolved from the pack copy by `node scripts/am-copies.mjs --write`; the copy is byte-equal again. |
| `herdr/mods/am-sidebar/bin/automagik-herdr.mjs` (4 hunks) | Imports; the `describe()` object; the option schema; the CLI help | Imports: kept the branch's `restart.js` import (`contextTokensOf`, `claudeTranscriptPath`) and took `dev`'s `revive.js` import (`PLIST_LABEL`, `launchdNotLoaded`, the `plist*` helpers). `describe()`: kept `restartAt`/`pinnedRestartAt`/`context_tokens` and took `dev`'s computed `autoMode`. Options: kept `restart-at`/`no-restart-at`/`due` beside `dev`'s `permission-mode`. Help: kept the `--restart-at`/`--no-restart-at` lines beside `dev`'s `--permission-mode=` line. |
| `am/bin/automagik-herdr.mjs` (4 hunks) | Byte-equal copy of the same four hunks | Resolved from the pack copy by `am-copies --write`; byte-equal. |
| `herdr/test/layout-safe-static.test.mjs` (1 hunk) | Both sides updated the CLI's fs allowlist rows | Kept `dev`'s `unlinkSync(plist)` row (the launchd agent, #939) and the branch's `unlinkSync(tmp)` count 4 and `renameSync(tmp, file)` count 6, after re-checking both counts against the merged CLI (4 and 6 occurrences). No test or row was dropped. |

`node scripts/am-copies.mjs --write` rewrote `am/bin/automagik-herdr.mjs` and `am/model.js`;
`node scripts/am-copies.mjs --check` then reported **48 files match** the pack source.

## Delta proofs

At the merge commit, per-file added/removed lines (`git diff --numstat --no-renames`) were
compared exactly:

- merged tree vs `dev` (`26b233361`): **22 files, +2448/−62** — equal to the branch's own change
  set `db07dd8fc..84583ddd` (22 files, +2448/−62), file by file.
- merged tree vs the branch head (`84583ddd`): **81 files, +13189/−400** — equal to `dev`'s
  change set `db07dd8fc..26b233361` (81 files, +13189/−400), file by file.

Nothing was dropped or added by the resolution. Also clean: no conflict markers in the merged
tree, `node --check` on every changed `.js`/`.mjs` file, `git diff --check`, and
`am-copies --check` 48/48.

## Gates at `67202bbca`

All runs went through the repository's `scripts/capped-run`.

| Run | Result |
| --- | --- |
| Focused `#1556` rows, eight test files that name it (`--test-name-pattern '#1556'`) | **38 tests, 38 pass, 0 fail, 0 skipped, exit 0**, 50 s |
| `test/restart.test.mjs test/cli.test.mjs` | **305 tests, 305 pass, 0 fail, 0 skipped, exit 0**, 471 s |
| `test/layout-safe-static.test.mjs test/permission-mode.test.mjs test/auto-mode.test.mjs` | **39 tests, 38 pass, 1 skipped, 0 fail, exit 0** |
| `test/hooks.test.mjs test/update.test.mjs test/auto-update.test.mjs test/machine-updates.test.mjs test/updateCheck.test.mjs` | 220 tests, 216 pass, **4 fail** (pre-existing, below) |
| `am/test/am.test.mjs` | 14 tests, 10 pass, **4 fail** (pre-existing, below) |

### Pre-existing failures, with evidence from `dev`

These fail identically on `dev` at `26b233361` (and also at the earlier `3955a09a9`), so they are
not caused by the merge:

- `test/hooks.test.mjs` (3) and `test/update.test.mjs` (1): the issue #1658
  `MODULE_TYPELESS_PACKAGE_JSON` warning rows —
  "acceptance: a v0.2.0 hook is moved and backed up; through the new command the block comes
  within 2 s", "the entry point runs am's copy first; a missing or broken am copy falls back to
  the sidebar's", "update.mjs: install across the rename moves the hooks; rollback to v0.3 puts
  them and the CLI link back; pocket-link untouched", and "update.mjs runs from a copy of the pack
  outside the repository (no package.json), without warnings". `dev` result: 220 tests, 216 pass,
  4 fail — the same four names.
- `am/test/am.test.mjs` (4), including the `placeEntry` row "the briefing entry point becomes a
  link into am's parts store: the pack's guard lifts, its placement leaves it". `dev` result:
  14 tests, 10 pass, 4 fail — the same four names.

## PR body

Updated because the merge made it stale: the old "## Merge" section (conflicts with
`fa592ad28`, "head `84583dd` pushed without Actions", "follow-up has to merge `dev`") was
replaced with the new head, parents, resolutions, delta proofs, gate counts and the queued CI
run; the restart/cli count moved from 301 to 305. The body names no machine, hostname, local path
or home directory.

## Left open

- No pull request was opened for this report's branch; this file is the deliverable.
- The PR body keeps its historical "previous head" CI counts at `84f590177`, now explicitly
  historical next to the new-head section.
- `dev` is moving quickly; `de50a6ad1` arrived after the merge and CI will run on the PR merge
  ref against the then-current base. Re-check mergeability and CI at verdict time.
