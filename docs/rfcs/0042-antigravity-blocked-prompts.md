# RFC 0042: Antigravity's blocked prompts

| Field | Value |
|---|---|
| Status | Accepted, in delivery (2026-11-20, approved by the owner's delegate: Q1-Q5 answered with this RFC's recommendations, see Decided; delivery 0, the capture, waits for a person with the laptop; none merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | herdr (am's byte copies ride along, as every herdr patch carries am) |
| Created | 2026-11-20 |

> Approved by the owner's delegate on 2026-11-20 while the owner is away; the owner may amend on return.

## Summary

An Antigravity (`agy`) pane stopped at its folder-trust question or at its "File access:
outside workspace" question keeps the last status its hooks reported, because agy fires no hook
while it waits for a person. Herdr draws it as working (or idle) and nobody is told. This RFC
proposes that the sidebar read the screen of a live Antigravity terminal, match only prompt
shapes captured from a measured agy release, and draw the terminal as **Needs you**, with the
prompt's line as the message, once two reads of the same terminal show the same frozen prompt.
It is Hermes's screen status (`herdr/mods/am-sidebar/main.js:945-965`) extended to agy. As an
option for the owner, the hc wrapper's send guard makes its own fresh check, so a message is not
typed into one of these prompts. The pack never answers either prompt. Nothing is written to
herdr-core, and restart, the scheduler and the other surfaces are unchanged.

## Motivation

#917 (lane herdr, agent status): agy's hooks (`PreInvocation`, `PostInvocation`, `PostToolUse`,
`Stop`) report working and done accurately, but nothing fires while agy waits at either prompt,
so herdr-core keeps whatever was reported last: `working` mid-turn, and possibly `idle`, `done`
or nothing at all for a prompt shown before any hook ran. At the reviewed checkout
(2835b2a09):

- **The sidebar draws herdr-core's status.** A bot's pose maps `blocked` to needs-you
  (`herdr/mods/am-sidebar/rows.js:209-224`; a bot's `error` draws the blocked chip with a failed
  pose, `main.js:809`); the chip words are `rows.js:227-229`. An agent with no report has no row
  at all (`main.js:393-399`), except Hermes.
- **The one screen-made status is Hermes's**, for a program that reports nothing: every 2.5 s
  the sidebar reads each Hermes terminal that `agents()` leaves out and draws `blocked` on its
  clarify footer (`main.js:209-211`, `:404-418`, `:945-965`).
- **The Question chip is label-only:** it "never scans a pane's screen" (`rows.js:231-234`).
- **The send guard (#1414) skips the screen of a working pane** (`hcGuard.mjs:440-457`), so a
  wrapper send to an agy pane stopped at a prompt while reporting `working` is forwarded and
  typed into the prompt. Its refusal names the pane and never the dialog's text, a folder or a
  host (`hcGuard.mjs:459-468`).
- **`pendingDialog` matches agy's trust question** ("Do you trust the contents of this
  project?", `dialog.js:13`) for any agent. Whether it matches the file-access question is
  unknown: that screen is not captured anywhere in this repository.
- **When the prompts appear is not established.** A launch on a valid non-home folder lists it in
  `trustedWorkspaces` (#953, `herdr/README.md:1868-1881`). A launch at the home folder leaves
  the key out (`herdr/test/cli.test.mjs:1082-1089`), so agy's own saved trust list decides; a
  launch with no settings file has `--dangerously-skip-permissions` taken out
  (`herdr/README.md:1578-1588`). The README measures, on agy 1.5.4, that flag as removing every
  permission prompt; the issue reports the file-access prompt anyway. Which launch forms show
  either prompt is delivery 0's to measure.
- **The scheduler is left alone.** Its hc backend already fails a run early on some recognized
  pre-work dialogs, read twice (`herdr/scheduler/internal/host/hc.go:236-250`); whether that
  covers agy's prompts is not established, and #917 does not change scheduler outcomes.

## Design

### 1. The match: `agyPromptOf(screenText)`

A pure function in a new `herdr/mods/am-sidebar/agyPrompt.js`, importing only `isPromptLine`
and `screenLines` from `dialog.js` (itself pure), so the idle-prompt rule has one
implementation: given a screen, it returns `{ kind: "folder-trust" | "file-access", question,
block }` or null.

- It matches only the shapes captured in delivery 0, kept as sanitized fixtures under
  `herdr/test/fixtures/agy-prompts/<agy version>/`: the question and the choice or footer lines
  that belong to it, anchored at the bottom of the screen (after trailing blank lines are
  trimmed, ANSI stripped), with no idle prompt line (`isPromptLine`) below it. Wrapped question
  lines are joined. `block` is the whole matched block, normalized (spaces collapsed), never
  truncated; `question` is the question line cut to 200 characters for display only.
- A shape it does not know is null, never a guess. It does not check agy's version: identical
  wording on another release matches, and a changed wording draws nothing until a new fixture
  folder is added.
- **`pendingDialog` is unchanged:** its signature, its `{ question, who }` return and its
  answers for every agent. `agyPromptOf` is called only for a terminal known to be Antigravity
  (section 2). Delivery 1 records, for each capture, what `pendingDialog` already answers.

### 2. Which terminals: identity, and where they are drawn

**Identity.** One pure function, `agyCandidate(record)`, over a core terminal record: the
sidebar's joined `terminals()` record (`report.app`, `status`) or the guard's `hc get` record
(`status.app`, `status.state`); both carry `address`, `created_ms`, `state` and, when the core
has one, `foreground.argv`.

| Evidence on the live record | Result |
|---|---|
| Foreground argv present; `agentKeyOfArgv(unwrapKeep(argv))` (`models.js:118`, `launchArgs.js:85-102`) is `antigravity` | Antigravity |
| Foreground argv present, anything else (a shell after the agent exited, another agent, a wrapper left on) | Not Antigravity, whatever the report says |
| No foreground argv; the report's app is one of the literal names delivery 0 records for agy | Antigravity |
| No foreground argv and no such report; or a report naming a retired alias (`gemini`, `retired.js:11`, a launch preference, not evidence); or no full address or `created_ms` | Unknown: not read |

The launch argv is never evidence: a kept terminal outlives its agent with the same argv and
lifetime. Losing candidacy clears the terminal's observation even when its address and
lifetime stay. A finished terminal is never a candidate.

**Enumeration.** The candidates are enumerated once per tick from the live core terminal
records (`this.all`, which `terminals()`, `kids()` and the bot tree are built from), each with
its core address (what is read) and its display alias (what is drawn) kept apart; an alias
that resolves to two terminals is not read (`main.js:327-339`). The observation, keyed by core
address and lifetime, is then applied to whatever row shows that terminal: a bot row, an agent
row, a sub-agent or worker row (`kidStatus`), or, for a candidate no row shows, a new extra row
like Hermes's (`main.js:404-418`). A child with no tab of its own counts toward its parent's
displayed space, for the space indicator and the compact rail alike.

**Hermes's scanner is kept to Hermes.** `scanHermes` (`main.js:945-965`) reads every extra row
today; it gets an explicit Hermes filter, so an agy extra row is read only by this scan and
its budget.

### 3. When a terminal is held

- **Read:** any candidate whose herdr-core status is `working`, `idle`, `done` or absent.
  Native `blocked` and `error` are drawn as today and not read.
- **Held:** two completed reads in a row of the same terminal lifetime (`created_ms`) whose last
  40 lines are identical, and that both match. A real agy prompt holds the screen still while it
  waits (checked in delivery 0 by two reads seconds apart); output still printing above a quoted
  prompt between the two samples changes the screen and is not held.
- **Cleared:** at once on a read with no match or a changed screen, a status of `blocked` or
  `error`, loss of candidacy, a new lifetime or the terminal leaving the snapshot. A read that
  fails or times out changes nothing; two failed or timed-out reads in a row of that terminal
  clear the held state (counted in visits, not seconds, so a large host's rotation never clears
  a healthy prompt).
- **Drawn:** the row's status is `blocked`: the Needs you chip and pose, its space's indicator,
  the compact rail, and a sub-agent or worker row through `kidStatus`. The chip's tooltip is the
  prompt's `question`. A space showing a Question chip as well draws Needs you first; the
  Question chip stays label-only.
- **Residual false positive:** two sampled tails that are identical and end with the exact
  captured block, with no idle prompt below it, draw as held, even if output changed between
  or outside the samples. The tests pin it as a known case (Q2).

### 4. Reading cost

The scan runs on its own 2.5 s timer, apart from Hermes's, with one scan in flight:

- the scanner keeps its own persistent gates, built with `discover.js`'s `machineGate(limit,
  ms)` (`discover.js:52`): 4 reads at once on this computer and 2 per remote machine, each
  read `hc read <address> --lines 40` with a 2,000 ms deadline on the sidebar's timer. As in
  discovery, a read that times out stays charged to its machine until it settles, and a machine
  whose slots are all stuck gets no new read, so a stalled remote never takes a local slot;
- at most 8 candidates are visited per tick, round-robin, and each machine's results are
  applied as they arrive, not after the slowest;
- before a result is applied, the terminal's lifetime and candidacy are checked again.

Detection takes two completed visits of the terminal: about 5 s with up to 8 candidates whose
reads answer; with 40 candidates a rotation takes about 12.5 s, so about 25 s.

### 5. Sends (Q3)

With Q3 a, `heldTarget` (`hcGuard.mjs:447`) also reads the screen of a resolved target that
`agyCandidate` calls Antigravity (from the `hc get` it already makes) and that reports
`working`, `idle`, `done` or nothing, and refuses when `agyPromptOf` matches; for the states
it already covers, the existing `pendingDialog` check stays as it is. One fresh read per send
attempt: every attempt whose read matches is refused, even while output above a quoted block is
changing, and the caller keeps the message and decides to route or retry; nothing is typed or
queued. The refusal is #1414's, unchanged: the same JSON line, the pane's address, the generic
reason, exit 9; never the prompt's text, a folder or a host. It is best effort: a prompt that
appears between the check and the forward, an unreadable screen, or a sender that bypasses the
wrapper (`hc` by absolute path, the proxy's `terminal.send`, a raw socket) is not covered. The
pack's own senders (the rollback notifier, `am revive`'s report, the handoff failure report)
are unchanged.

### 6. Shared files

`dialog.js` and `hcGuard.mjs` have byte copies in `am/` (`am/copies.json`, generated from the
import graph by `scripts/am-copies.mjs`) and in the sandbox's stable files (`dshTui.mjs`
`STABLE_FILES`, an explicit list). The delivery that makes `hcGuard.mjs` import `agyPrompt.js`
(and through it `dialog.js`, and `launchArgs.js` for `unwrapKeep`, already listed) adds every new
transitive dependency to `STABLE_FILES`, runs `node scripts/am-copies.mjs --write` and
`--check`, and runs the copied wrapper from the stable folder in a test, so a missing file fails
the test, not the installed guard at load. Delivery 1 touches only the sidebar and needs neither.

### What does not change

The pack never answers either prompt, never presses a key and never widens agy's access to
avoid one; trust stays `trustedWorkspaces` (#953). No label, no herdr-core status, no agy
settings change, no new service. The tabs, the status bar, `am show`/`am ls`, a lead's briefing,
herdr-core's typed note to a lead, restart and the scheduler keep reading herdr-core's status
(Q1, Q4).

## Tests

Every test and smoke runs with fake `hc`, `herdr-core` and `systemctl` first on `PATH`.

- **Match (pure):** each capture matches with its kind, block and question, at the widths
  captured; the same lines above an idle prompt, quoted mid-output or cut halfway do not; two
  file-access questions differing after character 200 have different blocks; the other agents'
  dialogs keep `pendingDialog`'s answers, and an unrelated pane's text is never passed in.
- **Identity:** each row of the table in section 2, with the joined `terminals()` record and the
  `hc get` record; agy under hc's keep wrapper, then the shell it leaves behind; a `gemini`
  report; a stale Antigravity report under a shell foreground; a script, an hc template and a
  helper by their live evidence; a unique remote alias, an ambiguous alias and two machines with
  the same local id.
- **Sidebar (fake hook stream, fake `hc read`, the existing snapshot stub):** startup with no
  report, an `agy` foreground and the trust prompt (an extra row, then Needs you); a stale `idle` or `done` with the
  file-access prompt; `working` with each prompt; held on the second identical read, not the
  first; changing output above a quoted prompt is not held; trust then file-access is not held;
  answered between reads clears; a frozen full quotation is the documented residual case; native
  `blocked` is drawn as today; a finished terminal is never read; two failed reads in a row clear it;
  40 healthy candidates plus two permanently stalled reads on one remote machine do not delay a
  local prompt; a mixed Hermes and agy host counts each terminal's reads (Hermes's scanner never
  reads an agy row); a tabless held child shows in its parent's space and compact rail; every
  render path in section 3 draws it, with the tooltip.
- **Sends (with Q3 a):** both wrappers, a linked target and `--force`: a target at either prompt
  is refused with #1414's exact JSON shape and exit 9, and a distinctive folder from the prompt
  appears nowhere in stdout or stderr; a second send against the same block is refused again;
  changing output above a quoted block leaves the sidebar unheld while the guard refuses; a
  mid-turn agy pane is forwarded; a working Claude or
  Codex pane is still not read; the stable folder's installed guard does the same.

## Deliveries

0. **Capture** (a person, not code; Q5): for each agy version and platform the owner names,
   record the launch form and its effective flags, whether the settings file has
   `trustedWorkspaces`, the terminal width, the sidebar row and the `hc get` record (status,
   report, foreground) before, during and after each prompt, and two sanitized screens
   (`hc read --lines 40`) seconds apart while it waits. Include an ordinary pack launch as a
   control and one reproducing launch per prompt. If a prompt never appears in any pack launch,
   the RFC returns to the owner before delivery 3. Blocks delivery 3 only.
1. **Identity and sidebar** (herdr patch, Refs #917): `agyCandidate`, the scan, its budget,
   the held rule, the rows and Hermes's filter (sections 2-4), with `agyPromptOf(screenText,
   shapes = AGY_SHAPES)` shipping an empty `AGY_SHAPES`, so nothing is drawn yet; the tests pass
   synthetic shapes. Does not wait for delivery 0.
2. **Sends** (herdr patch, Refs #917): section 5 and section 6's copies, over the same empty
   table. Does not wait for delivery 0.
3. **Captured shapes** (herdr patch, Closes #917): delivery 0's fixtures, the shapes in
   `AGY_SHAPES`, the tests on the real captures and the README's Antigravity section. Waits for
   delivery 0.

## Out of scope

- Any surface but the sidebar (Q1), restart (Q4), the scheduler and herdr-core's typed note to a
  lead. An upstream ask (an agy hook before input, or a status the pack may report to
  herdr-core) is the lasting fix for all of them and is filed separately; nothing here waits
  for it.
- Any other agent's prompts, and any change to `pendingDialog`'s answers.
- Answering, skipping or preventing either prompt.

## Questions for the owner

**Q1. Which surfaces show the held state.**
- (a) **Recommended:** the sidebar only, as Hermes's status today. The tabs, the status bar,
  `am show`/`am ls` and a lead's briefing keep herdr-core's word (working, say) until upstream
  reports `blocked`. It meets #917's acceptance with no new contract.
- (b) Every pack surface, through a pack-written pane label. Not designed here: a label needs an
  expiry tied to its writer and the terminal's lifetime, reconciliation across windows, and the
  key reserved for set and clear in both the guard and the proxy (a guarded bot can label its
  own workers today, `hcProxy.mjs:498-511`). It would be its own RFC.
- (c) Nothing pack-side: wait for agy or herdr-core upstream.

**Q2. The residual false positive.** Two identical sampled tails ending with the exact captured
block draw as held in the sidebar; with Q3 a, every send attempt whose one fresh read shows the
block is refused, even while output above it changes.
- (a) **Recommended:** accept both: a wrong Needs you clears at the next change on screen, and a
  refused sender keeps its message and routes or retries; nothing is typed or lost.
- (b) Accept it for drawing only, and take Q3 b.

**Q3. Sends to an Antigravity pane at a prompt.**
- (a) **Recommended:** the hc wrapper's guard makes the one fresh check of section 5, with
  #1414's refusal unchanged; best effort, never a guarantee, and the pack's own senders
  unchanged.
- (b) Leave sends as they are; the sidebar only shows the state.

**Q4. Restart.**
- (a) **Recommended:** unchanged. Local restart keeps its existing status and generic-dialog
  checks (`pendingDialog`); delivery 0 records whether the captured file-access screen matches
  them. Ordinary linked restart keeps its existing status and helper checks and gets no agy
  screen protection from this RFC.
- (b) Protect restart too: the local queue, its reason, list and fire, the Restart --tree helper
  and the linked preflight and recheck all need `agyCandidate` and `agyPromptOf`; a delivery of
  its own.

**Q5. Who captures the prompts, and on what.**
- (a) **Recommended:** the owner's engineer, on the laptop, with a scratch folder, on the agy
  release the pack measures against (1.5.4), Linux and macOS.
- (b) The owner, same scope.
- (c) Linux first, macOS after its own capture.

## Decided

Approved by the owner's delegate on 2026-11-20 (the note under the table), with every
recommendation above. The options not taken are listed with each question; taking one needs a
later amendment.

1. **Q1, surfaces:** the sidebar only, as Hermes's screen status. The tabs, the status bar,
   `am show`/`am ls` and a lead's briefing keep herdr-core's word. Not taken: a pack-written
   label for every surface (its own RFC), or nothing pack-side.
2. **Q2, the residual false positive:** accepted for drawing and for refusing a send; a refused
   sender keeps its message. Not taken: drawing only.
3. **Q3, sends:** the hc wrapper's guard makes the one fresh check of section 5, with #1414's
   refusal unchanged; best effort, and the pack's own senders unchanged. Not taken: sends left
   as they are.
4. **Q4, restart:** unchanged. Not taken: restart protection as a delivery of its own.
5. **Q5, capture:** the owner's engineer, on the laptop, with a scratch folder, on agy 1.5.4,
   Linux and macOS (delivery 0). Not taken: the owner; Linux first.

Order: deliveries 1 and 2 do not depend on the captured text and land first, over a matcher
that knows no shape yet and so never matches; delivery 3 adds the captured shapes after
delivery 0 and closes #917.
