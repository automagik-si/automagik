# Wall-clock sweep: herdr and am test suites

Date: 2026-11-19
Wish: a wall clock must not decide a suite
Branch: `wish/tests-a-wall-clock-must-not-decide-a-sui` (the wish copy's fixed branch, from
`98971f54a`; the request's `test/no-wall-clock-asserts` name is not used because this copy has
no push route and the working instructions pin the branch and commit).
Commit: one test-only commit; see `git log -1` on the branch.
Refs #939.

## Result

Twelve `herdr/test/` files and one `am/test/` file changed. Nine assertions that decided
pass/fail only by elapsed wall time were converted to state/event proofs; one 0.4 s scenario wait
that let load decide a restart row was raised to a documented 10 s net; three sleeps used as
synchronisation were replaced by the state they were guessing at; the remaining timing waits are
documented nets that only stop an unbounded hang. No product file changed.

The row that went red on `dev` at `de50a6ad1` (`herdr/test/install.test.mjs`'s #939
`--uninstall` row, `took < 10_000`) is converted here too, not just the rows around it.

## Inventory and verdicts

### Unsafe, converted

| File:line | What it was | Verdict |
|---|---|---|
| `herdr/test/install.test.mjs:3060-3076` | `took = Date.now() - started; assert.ok(took < 10_000)` on a whole `--uninstall` whose hung status command must be killed at 3 s | **unsafe; converted.** The fake now writes an `answered` marker only after its 30 s sleep; the marker's absence proves the probe ended the command before it answered. The old budget decided on machine load (the red was 13,210 ms). |
| `herdr/test/install.test.mjs:2247-2254` | `assert.ok(Date.now() - began < 20_000)` around a fake `herdr-app status` that sleeps 30 s | **unsafe; converted.** Same shape: the fake writes `answered` only when its 30 s answer completes; absence proves the 1 s watchdog killed it first. |
| `herdr/test/hooks.test.mjs:379` (former) | `assert.ok(run.ms < 2000)` on the v0.2.0-hook acceptance run | **unsafe; converted.** The test now proves the block came back whole (full `<herdr-bot>` text, empty stderr, `spawnSync` timeout 10 s as a net). A guard cut at 2.4 s exits before printing; the 2 s budget itself is a product constant asserted in `briefing.test.mjs:697-703`. |
| `herdr/test/hooks.test.mjs:582` (former) | `assert.ok(run.ms < 2000)` after the folder rename | **unsafe; converted.** Same proof: the briefing text is complete, so the hook's own guard did not cut it. |
| `herdr/test/discover.test.mjs:85-93` | `updates[2].at < 60`, an elapsed-time ordering claim | **unsafe; converted.** The third update is asserted to hold no remote key, and `io.done` shows every local call finished before the first remote answer: event order, not a clock. |
| `herdr/test/discover.test.mjs:140-146` | `assert.ok(took < 400)` with a never-answering machine (`latency: Infinity`) | **unsafe (tiny budget); converted.** The row can only return if the dead machine's own timeout ended the call; the proof is the one dead call, the returned rows and their last-good files. A documented 10 s net stops an unbounded hang. |
| `herdr/test/coreSocket.test.mjs:131-141` | `Date.now() - start < 1500` for an 80 ms deadline | **unsafe (tight net); converted.** `timeoutMs: 0` returns `timed out` without opening a connection; the 80 ms silent socket gets exactly one connection, so the given deadline and no-retry are proven causally. |
| `herdr/test/worker.test.mjs:1045-1052` | `assert.ok(took >= 60_000)` on the #1262 `hc run` wait | **unsafe (lower bound); converted.** The fake writes `run-answered` only when its own 61 s wait reaches the answer; its presence proves the CLI did not kill the call at the old 15 s. |
| `am/test/runner-spawn.test.mjs:204-212` | `assert.ok(Date.now() - started < 3000)` for a 150 ms timeout | **unsafe; converted.** `timedOut: true`, `code: null`, `SIGKILL`, client 124 are the timeout's own report; an ignored deadline would exit 0 from the 5 s sleep. |
| `herdr/test/cli.test.mjs:3869-3877` | a 0.4 s `AUTOMAGIK_HERDR_RESTART_WAIT_MS` scenario: the bot's own new pane had to show its agent in front within 400 ms, or the product ended it instead of the bare-shell helper | **unsafe scenario wait; converted.** Raised to 10 s and the expected message updated to `within 10s`; the proof is still the helper's bare-shell state and the report line. This row failed only under the 31-process load, not unloaded. |

### Sleeps used as synchronisation, converted

| File:line | What it was | Verdict |
|---|---|---|
| `herdr/test/cli.test.mjs:2648-2653` | a fixed 300 ms sleep, then count polls `<= 10` | **unsafe wait; converted.** The count is taken over the whole run after `await running`; a 1 ms poll would have made hundreds of calls before the 1000 ms max. |
| `herdr/test/hc-proxy.test.mjs:955-960` | a 50 ms sleep before opening the connection over the cap | **unsafe wait; converted.** Every held client first completes a `terminal.list` call, so each session is registered; no sleep guesses when the proxy accepted it. |
| `herdr/test/am-quota-panel.test.mjs:1304-1312` | a 5 ms sleep and `asks() === 2` while a round is held | **unsafe wait; converted.** The held round is released and settled; `asks() === 4` proves one queued round ran after it, never beside it. |

### Timing waits raised and kept as documented nets

These were `waitFor` polls whose real evidence is a state or event; their ceilings were too tight
for a loaded machine. The ceiling only stops an unbounded hang.

| File:line | Change | Verdict |
|---|---|---|
| `herdr/test/cli.test.mjs:2676` | 10 s -> 30 s | acceptable net: waits for `reads() === 1`. |
| `herdr/test/cli.test.mjs:2736` | 10 s -> 30 s | acceptable net: waits for two `hc get t5` calls. |
| `herdr/test/cli.test.mjs:5141` | 10 s -> 30 s | acceptable net: waits for the watcher's `hc wait t5`. |
| `herdr/test/launch.test.mjs:522-523` | 2 s -> 10 s | acceptable net: the recorded `space.close` event is the proof. |
| `herdr/test/create.test.mjs:273-274` | 5 s -> 10 s | acceptable net: waits for the `agy models` call. |
| `herdr/test/cli-doc.test.mjs:157` | 3 s -> 10 s | acceptable net: `process.kill(pid, 0)` -> `ESRCH` is the proof. |
| `herdr/test/core-readonly.test.mjs:68` | 5 s -> 10 s | acceptable net: the fake core's `ready` file is the proof. |
| `herdr/test/core-readonly.test.mjs:163` | 5 s -> 10 s | acceptable net: the herdr-core pid is gone. |
| `herdr/test/am-quota-panel.test.mjs:1304` | 5 s -> 10 s | acceptable net: waits for two login asks. |
| `herdr/test/hc-proxy.test.mjs:237` | 4 s -> 10 s default | acceptable net: socket/state predicates. |
| `herdr/test/hc-proxy.test.mjs:968,971` | 2 s -> 10 s | acceptable net: idle/partial-line connection closed. |
| `am/test/runner-spawn.test.mjs:313-315` | 2 s loop -> 10 s deadline, plus an explicit "the first run started" assert | acceptable net: the `BUSY` answer is the proof. |

### Acceptable nets left as they were

| File:line | What | Verdict |
|---|---|---|
| `herdr/test/meterFleet.test.mjs:413-415` | 40 s ceiling around a fake `sleep 60` smoke run | acceptable net: the "nothing" output, the kept 0.3.0 binary and the empty leftovers are the proof. |
| `herdr/test/discover.test.mjs:146` | new 10 s net around the never-answering machine | acceptable net: the dead call and returned rows are the proof. |
| `herdr/test/worker.test.mjs:2168,2177` | 30 s watchdogs that fail on a missing wait notice | acceptable net: the notice/state is the proof. |
| `herdr/test/worker.test.mjs:2195,2293-2296` | scenario timers (3 s hc answer, 4 s lock hold, C at +2 s) | not a pass/fail timing assert: the assertions are one run, one refusal, no worktree. |
| `herdr/test/cli.test.mjs:2746` | 8 s hang promise around a queued watcher | acceptable net: `replaced: t5` is the proof. |
| `herdr/test/cli.test.mjs:5743-5746` | `waitUntil` helper, 15 s | acceptable net: used only after a state predicate; throws on the net. |
| `herdr/test/hc-proxy.test.mjs:847,853` | `waitFor` socket exists/removed, 10 s | acceptable net: the path state is the proof. |
| `herdr/test/am-markdown-faces.test.mjs:64-76` | `until` 20 s; `quiesce` races a never-resolving folder watch with 2 s | acceptable net: documented as a bound for work that never resolves. |
| `herdr/test/briefing.test.mjs:353,522` | a fake `HANG_MS` and a 600 ms busy-wait that make a call slow | not pass/fail: they are fixture behaviour; the assertions are output text. |
| `herdr/test/launch.test.mjs:634-639` | a `before`/`after` window around a computed `AUTOMAGIK_HERDR_DEADLINE` value | not an elapsed assert: it proves the deadline is call time + `SHORT_EXEC_MS`, not how long the call took. |
| `herdr/test/fleetCoverage.test.mjs:109`, `herdr/test/updateCheck.test.mjs:63`, `herdr/test/meter.test.mjs:37-60`, `herdr/test/bots.test.mjs:171-331`, `herdr/test/am-quota-panel.test.mjs:662` | injected fake sleep/clock or mocked timers | not wall-clock: the clock is the fixture's. |

### Not timing asserts (fixture dates, ages, IDs, product inputs)

`herdr/test/install.test.mjs:2556`; `herdr/test/revive.test.mjs:415,439,457,797,807,818,831,842,867,898,980,1001,1018,1034,1051,1070,1077,1107,1251,1278,1296`;
`herdr/test/cli.test.mjs:747,763,1435,1552,1963,4770,4780,4796`;
`herdr/test/am-quota-panel.test.mjs:37,841`; `herdr/test/am-quota-write.test.mjs:114`;
`herdr/test/am-automations-panel.test.mjs:988,1038,1147`;
`herdr/test/update.test.mjs:1688,1725,2105,2214-2220,2310-2329`;
`herdr/test/worker.test.mjs:167,1080,2416-2454,2669,3045-3053,3305,3415,3438`;
`herdr/test/hc-proxy.test.mjs:31,699`; `herdr/test/dsh-tui.test.mjs:26,236,278`;
`herdr/test/approved.test.mjs:207`; `herdr/test/sidebar-parent-mark.test.mjs:28`;
`herdr/test/cli-remote-panes.test.mjs:1162,1170` (deadline values the product is given);
`am/test/runner-main.test.mjs:30`, `am/test/runner-helpers.mjs:205` (the product's injected clock),
`am/test/am.test.mjs:356,363` (lock ages). `herdr/test/create.test.mjs:515,522` is a fake timer
callback, not a real wait.

### Outside the named globs: Pocket Link's own suite

The wish named `herdr/test/`, `herdr/mods/*/test` (absent) and `am/test/`. Pocket Link's separate
CI job (`herdr/mods/pocket-link/{bridge,chat}/*.test.mjs`, `find-node.test.mjs`) also has
wall-clock budgets. They were found by the grep and are listed here rather than silently left;
they are not converted because they sit outside this sweep's named paths and two need their own
per-connection instrumentation:

- `chat/paste.test.mjs:114-118`: `performance.now()` < 500 ms for a linear-time cleaner. A
  complexity guard, not a causal state proof; observed 109 ms unloaded and 231 ms under the same
  load that ran the converted rows.
- `find-node.test.mjs:177`: fast probe < 2000 ms; `:182`: slow probe 2500-5000 ms. The child-pid
  gone check is the causal proof; the elapsed bounds are the load-sensitive part.
- `bridge/devices.test.mjs:154` (`>= 150 ms`, a retry delay) and `:463-465`
  (`< BUSY_RETRIES * BUSY_WAIT`, a 150 ms ceiling: a loaded file read can exceed it).
- `bridge/dsh-source.test.mjs:438-442`: `< 2000 ms` for a revoke tick; the `until(unsubscribe)`
  poll just above is already the event proof.
- `chat/tail.test.mjs:256`: a 100 ms sleep used as synchronisation.

## Converted rows: before/after and why the new proof is causal

1. **`--uninstall` on macOS with a status command that never answers (#939).** Before: elapsed
   < 10 s. After: the fake `sleep 30`s and only then writes `answered`; the test asserts the
   file is absent, the pack and link are gone, the fallback line is printed, and the hung
   command was never told to uninstall. If the installer had waited, the marker would exist;
   the wall clock is irrelevant.
2. **`--uninstall` with a `herdr-app status` that never answers.** Before: elapsed < 20 s
   against a 30 s fake. After: same completion marker, absent because the 1 s watchdog killed
   the fake. The pack leaving is asserted as before.
3. **The v0.2.0 hook acceptance.** Before: `run.ms < 2000`. After: the full briefing text, the
   closing `</herdr-bot>`, empty stderr, and a 10 s `spawnSync` net. The product's own 2.4 s
   guard exits silently before writing, so a complete block is the event that proves the block
   was not cut; the 2 s budget constant is covered by `briefing.test.mjs`.
4. **The folder-rename hook acceptance.** Same proof: complete text and no error line.
5. **Local projects listed before a slow machine answers.** Before: third update < 60 ms. After:
   the third update contains no remote key, and the fake's completion log has every local call
   before the first remote answer. That is the ordering the test claimed, without a race against
   a 60 ms timer.
6. **A machine that never answers holds back only its own projects.** Before: total < 400 ms.
   After: the never-answering promise can only be escaped by its timeout; the test asserts the
   single dead call, the returned rows and their last-good files. The 10 s net only fails a hang.
7. **`coreStatus`'s one deadline.** Before: < 1500 ms. After: `timeoutMs: 0` returns `timed out`
   with zero connections (the deadline is the one given), and the 80 ms silent socket gets
   exactly one connection (no retry).
8. **#1262's `hc run` wait.** Before: `took >= 60_000`. After: the fake writes `run-answered`
   only when its 61 s wait reaches the answer, so the file proves the CLI waited; a kill at 15 s
   cannot write it.
9. **`am`'s run timeout.** Before: elapsed < 3000 ms. After: `timedOut`, `SIGKILL`, client 124.
   An ignored deadline returns the 5 s sleep's plain exit 0.
10. **The `restart --tree` "never up" helper.** Before: a 400 ms product wait for the new bot's
    agent, so a loaded machine ended the bot's pane and the row failed before reaching the
    helper. After: a 10 s wait, with the helper still a bare shell; the assertion is the
    product's own "wasn't run again ... within 10s" line and the helper's ended state.

## Timings (converted rows)

Unloaded = no extra processes. Loaded = 31 busy `yes` processes on a 32-CPU host, with the test
run through `scripts/capped-run` (its `nice -n 10`), so the test is the loaded party.

| Row | Unloaded | Under load |
|---|---|---|
| install `--uninstall` herdr-app status | 2,310 ms | 4,547 ms |
| install #939 hung status | 3,892 ms | 5,539 ms |
| hooks v0.2.0 acceptance | 238 ms | 1,242 ms |
| hooks rename acceptance | 259 ms | 1,214 ms |
| discover ordering | 164 ms | 183 ms |
| discover dead machine | 61 ms | 64 ms |
| coreSocket one deadline | 82 ms | 224 ms |
| worker #1262 wait | 61,716 ms | 65,827 ms |
| am run timeout | 215 ms | 439 ms |
| cli empty poll override | 2,825 ms | 6,843 ms |
| cli helper between checks | 2,502 ms | 8,528 ms |
| cli queued watchers | 5,470 ms | 30,927 ms |
| cli restart --tree (0.4 s -> 10 s scenario) | 30,373 ms | 56,366 ms |
| hc-proxy connection cap | 37 ms | 77 ms |
| hc-proxy idle/partial line | 249 ms | 260 ms |
| launch late space | 518 ms | 2,185 ms |
| create slow refresh | 184 ms | 676 ms |
| am-quota held round | 57 ms | 102 ms |
| core-readonly stale socket | 345 ms | 1,658 ms |
| cli-doc timeout | 98 ms | 191 ms |

Every converted row passed both times. The field red (13,210 ms for #939) is not reproduced by
this load, and most old budgets also survive it; the rows still moved by up to 5.2x between the
two runs, which is exactly why a budget is not a proof. The new assertions read only the marker,
the state, the text or the process signal, so those multipliers cannot decide them.

## Counts and known failures

- Touched herdr files, full, unloaded: **350/350 pass** (9 files, 14.4 s), plus **587 tests /
  585 pass / 2 environment skips / 0 fail** (install, worker, cli; 584.6 s, the final run
  including the 10 s scenario).
- Touched herdr files, full, under load: **350/350 pass** (83.0 s). The full loaded run of the
  big three surfaced exactly one failure in its captured output, the 0.4 s `restart --tree`
  scenario above; after the 10 s fix that row passes under the same 31-process load (56.4 s).
  The converted rows from install, worker and cli passed under load (20/20, plus this row); the
  245-test cli file was not re-run in full after the fix.
- `herdr/test/hooks.test.mjs`, full: **25/25 pass** (4.2 s).
- `am/test/runner-spawn.test.mjs`: **23/23 pass**, unloaded 1.7 s; its two converted rows passed
  under load.
- `node --check` on all 13 changed files: clean. `git diff --check`: clean.
- `node ../scripts/am-copies.mjs --check` from `herdr/`: **48 files match**.
- No shell file changed, so `shellcheck` was not run.

**Environment note, not a wall-clock failure:** on this host's Node 24.18, a scratch copy of the
pack has no `package.json`, so Node prints `MODULE_TYPELESS_PACKAGE_JSON` while reparsing its
`.js` files as ESM. That diagnostic landed in the hook's and update CLI's stderr and made the
hooks stderr assertions fail before the test could see the hook's own output. `hooks.test.mjs`
now passes `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` in those two child environments; the
full hooks suite is **25/25 pass** with the default temp root. No #1658 hooks/update row failed.
The `am` `placeEntry` family is outside `am/test/` and was not run.

## Deliberately left

- Pocket Link's own timing budgets, listed above: outside the named globs and needing their own
  instrumentation to become causal.
- The nets in the "acceptable nets left" table: they are state/event tests whose ceiling only
  stops a hang.
- The product's own 2 s briefing budget is asserted as constants in `briefing.test.mjs:697-703`
  and exercised there with a hung fake; the acceptance rows no longer measure it.

## Not done

This copy has no push route: the commit is local on
`wish/tests-a-wall-clock-must-not-decide-a-sui`, and no PR was opened. The requested branch name
`test/no-wall-clock-asserts` from a freshly fetched `dev` was not created because this wish copy
is pinned to `98971f54a` and its instructions say to commit here and never push, merge or touch
another branch.
