# RFC 0043: Accounts across linked machines

| Field | Value |
|---|---|
| Status | Accepted, in delivery (2026-11-20, approved by the owner's delegate: Q1-Q11 answered with this RFC's recommendations, see Decided; delivery 0a found no qualified transport, so the linked trial and 3a are blocked (Delivery 0a's findings); on 2026-11-20 the owner's side left the trial and 3a to the owner and kept Codex on this computer only, Q4's fallback; deliveries 1 and 2 under way, none merged) |
| Milestone | none (ships outside the five milestones) |
| Lanes | herdr patches (the pack: am-quota and the sidebar's CLI), each carrying am's generated copies of the CLI |
| Created | 2026-11-20 |

> Approved by the owner's delegate on 2026-11-20, with every recommendation (Q1-Q11). The
> owner may amend on return.

## Summary

The Accounts panel (am-quota) chooses the Claude Code and Codex account of this computer only.
This RFC extends it to the machines linked into the same Herdr: an approved plan per tool that
keeps every machine on one account, pins one machine to another, or spreads the accounts evenly
(#438), and a switch that reaches every linked machine with an outcome per machine (#424). Each
machine is read back before it is called switched; one that is away or failed is named with a
fixed reason and retried. Nothing moves without a person's press. Claude only moves between
logins already signed in on each machine (#453: nothing is copied). Codex copying is decided by
the owner's trial (delivery 0), which tests whether one Codex grant survives three holders.
Delivery 0a found no transport that qualifies, so that trial and Codex copying wait (Delivery
0a's findings).

## Motivation

#424 asks that a switch reach every linked machine through the OAuth saved in CLIProxyAPI, with
a visible outcome per machine and retries, never a silent success. #438 asks for three ways to
assign accounts: one account everywhere (the default), a per-machine override, and an even
spread, with deterministic fixture tests. The owner gated both on a 48-hour test on two linked
machines, which has not run (#424 and #438 comments, 2026-11-19).

### What the code does today

- A Codex switch writes this computer's `$CODEX_HOME/auth.json` only: the panel downloads the
  credential (`herdr/mods/am-quota/switch.js:38-43`), makes a private folder
  (`herdr/mods/am-quota/write.js:37-40`), writes a `0600` payload, and `installScript` backs up,
  copies and renames it into place (`write.js:57-81`, `switch.js:51-80`). What was installed is
  recorded in `data/am-quota/active.json` with a 32-bit FNV-1a fingerprint
  (`herdr/mods/am-quota/translate.js:127-151`, `herdr/mods/am-quota/DESIGN.md:79-91`): of the
  account id, or of the refresh token when the file has no account id (`translate.js:150`). The
  panel reads the management key from `$CLIPROXY_MGMT_KEY` in Herdr's environment or from
  `~/.config/cliproxyapi/mgmt.key` (`DESIGN.md:18-21`).
- A Claude switch writes only `<app home>/claude-logins.json`'s `use`: which local login new
  Claude launches get (`herdr/mods/am-sidebar/logins.js:8`, `:74-89`;
  `herdr/mods/am-sidebar/bin/automagik-herdr.mjs:271-281`, `:4725-4726`). No Claude credential
  is downloaded or written (#453, `herdr/mods/am-quota/docs/local-logins.md`). The panel writes
  that file through Herdr's own file writer (`herdr/mods/am-quota/logins.js:177-185`).
- Launches on a linked machine take two paths:
  - `am start --machine` and a plain `am restart --machine` build the argv on this computer in
    `seatOnMachine`, with no login words (`automagik-herdr.mjs:4131-4133`), so the pane gets
    whatever the target core's environment holds;
  - `am restart --machine --tree` runs the target's own CLI there with the project's app home
    (`automagik-herdr.mjs:4221-4255`), and that CLI's local launch reads the target's
    `claude-logins.json` (`:4725-4726`), including `-u CLAUDE_CONFIG_DIR` for the default login.

  The design note's "launches on linked machines never get the login words"
  (`local-logins.md:152`) is true of the first path only.
- The pack already acts on linked machines with an outcome each: `hc exec --on`
  (`herdr/mods/am-sidebar/meterFleet.js:159`, `:167-182`), and the hourly machines cycle with its
  lock and record (`herdr/mods/am-sidebar/machineUpdates.js:1-30`, `:51`). Linked machines are
  known by core id across renames (`herdr/mods/am-sidebar/attach.js:141-150`).
- Every CLI command but `main` repairs the CLI's links before it runs
  (`automagik-herdr.mjs:10494-10496`), so even an unknown command is not side-effect free.
- A mod's `exec` has no stdin (`automagik-herdr.mjs:1944`); `docGet.mjs` is a CLI helper that
  writes one JSON-RPC request to `hc connect`'s stdin (`herdr/mods/am-sidebar/docGet.mjs:26-30`,
  `:88`). herdr-core's whole-file write to a path the caller picks, `file.write`, does not qualify
  for a secret, nor do its other writes (Delivery 0a's findings); in this repository `file.edit`
  and `file.write` appear only in the hc-proxy test that refuses them
  (`herdr/test/hc-proxy.test.mjs:240-244`), and `hc file edit` takes its text in `argv`
  (`herdr/mods/am-sidebar/remoteFile.js:9`).
- The panel's Restart runs the CLI in an hc terminal that starts in herdr-core's environment,
  with a fixed list of Herdr's variables passed in its argv (`herdr/mods/am-quota/main.js:72-79`,
  `:643-659`); neither the management key nor `CODEX_HOME` is on that list.
- The switch policy: "one active account per client; a switch is a handoff, never balancing"
  (`herdr/mods/am-quota/policy.js:4-10`). A switch is always a person's press.

### What the owner already decided

- 2026-11-05 (#424): setup tokens are dropped; the switch uses the OAuth saved in CLIProxyAPI;
  each machine keeps its own state; failures show per machine and are retried; no credential
  travels outside the existing hc machine link.
- 2026-11-06 (#424, #453): the Claude copy test is dropped. Claude reaches a machine only through
  that machine's own sign-in, one per account; a Claude login is never copied from the proxy,
  which keeps its Claude logins for quota reading only; no two places hold the same grant. Codex
  is unchanged and separate. Mapping: one Claude account per host, the main host keeps a backup
  login, two hosts swapped accounts to spread load, a second login on the Mac only.
- 2026-11-19: #424 and #438 stay blocked until the trial runs.

## Design

### Delivery 0a: qualify the transport (no secret)

The trial on two linked machines and any later Codex copy need one way to put a file on a linked
machine that the owner's rule allows: through the existing hc link, with the body in no `argv`.
Before any secret moves, delivery 0a establishes, from herdr-core's own versioned protocol
documentation (read, never by running a core) and with fakes:

- a method that writes a file on a linked machine with its body inside the request, sent on
  `hc connect`'s stdin, and its size limit, file mode, replies and errors;
- that the request is delivered only to the expected **core id**, checked by the transport
  before any byte of the body is released. A name checked before and after the write is not
  enough: a name rebound in between would already have the body;
- that neither end traces or logs the request body.

Tests send a synthetic canary body through a fake link and assert it appears in no recorded
`argv`, log or error, and that a core replacing the expected one under the same name receives
zero bytes. A synthetic canary key goes on the controller's proxy request and is asserted never to
enter an hc request. If the documentation shows no such method, or no core-id binding, 0a records
that, the linked trial and 3a are blocked, and the owner is told.

#### Delivery 0a's findings (2026-11-20)

Read, never run: herdr-core's protocol schema (`schema/hc.openrpc.json`, `info.version` 0.1.21)
and its `docs/machines.md` and `docs/security.md`, at herdr-core commit `c7517808` (2026-11-16);
its source (`crates/herdr-core/src/remote.rs` and `files.rs`) at the tag `v0.1.21` and at that
commit, the same in every part cited here; the herdr-core binary on the checking computer,
searched as text, whose method descriptions match the schema word for word; and this
repository's uses of hc. The schema and the docs are the contract; the source only shows what
one version does.

| Needed | Found |
|---|---|
| A method that writes a file on a linked machine, the body inside the request | Yes: `file.write` (`path`, `data`, `cwd`, `on`), the whole-file write to a path the caller picks. `data` is "Its new content, base64, at most 8 MB raw"; sent on `hc connect`'s stdin, the body is in no `argv`. "Swapped in whole: a reader sees old or new, never half." It makes missing folders. |
| The other methods that write request bytes to a file | `terminal.put` (and its pieces `terminal.put_begin`, `terminal.put_chunk`, `terminal.put_finish`) writes base64 bytes beside a live terminal, on that terminal's machine, for its program to read: it is addressed by terminal, not by machine, and the caller names the file but not its folder. `file.edit` carries replacement text, takes `on` like `file.write` and changes an existing text file, "Written like file.write". Neither documents a destination bound to a core id or what is logged, so neither qualifies either. |
| Its size limit | 8 MiB raw (8,388,608 bytes in the source; the schema says 8 MB), sent as base64. |
| Its file mode | Not documented for a new file, and no method takes a mode: "An existing file keeps its mode; a symlink is followed." In the source, a new file and the folders it makes get the core's default (0666 and 0777 less its umask, commonly readable by every user there), so it cannot make a private folder either; `0600` is asked only while an existing file's mode is carried over. A symlink is followed even to a target not there yet. A `0600` file on this computer says nothing about the file there. |
| Its replies and errors | `{ path, bytes }`; errors `invalid_params`, `io`, `machine_unknown`, `unavailable`, `needs_update`, with no descriptions. `unavailable` is also what a link dropped mid-call answers, so a lost answer may have written. |
| Delivery only to the expected core id, checked before any byte is released | **Not in the protocol.** The schema describes `on` as "On another machine (see `hc machine ls`)", the docs address machines by name only, and no parameter names an expected destination core id (`hello`'s `core` is the caller's). In the source, `on` is first matched against this core's own id and name (the write then stays here), then against each machine's name or core id in one test, the first machine in the list that matches either winning; a link carries calls only after the core that answered gave the id the selected machine record holds ("a different core answers there"). That check proves the line reaches the record the match picked, not the core id the caller meant: an id string that is also this core's name, or an earlier machine's name, picks another record, whose own check passes. It is also undocumented and unversioned, and runs when the link dials rather than on each call. |
| Neither end traces or logs the body | **Not documented** either way. The docs name `core.log` and `holder.log` in each core's state folder and call that folder private and unencrypted. The two source files read log no request data and read no trace setting; the rest of the source (request dispatch, `hc` itself, the holder) was not read. |

**Result: no route qualifies.** Neither the binding nor the logging is part of herdr-core's
protocol, nor is the mode of a created file; and a helper that checks a name's core id and then
writes by name is the check-then-send this delivery rules out, so no helper is built. As the
delivery says, the linked trial (Q3) and 3a are blocked, and the owner decides what comes next
(below). Deliveries 1 and 2 move no credential and are not affected (Q2); 3a also keeps Q4's
hold.

**What would unblock it**, each read again from herdr-core's own versioned documentation, never
by running a core:

- the destination named by core id alone (an `on` that takes a core id and matches no name, or a
  parameter naming the expected core id), refused by the sending core unless the link's checked
  identity matches, before any part of the request is forwarded, on every call and after every
  reconnect;
- a statement of what each core and `hc` log or trace, with no request parameters among it;
- the mode of a file the write creates, `0600` or set by a mode parameter, documented.

Then 0a runs again against that version: the CLI helper (the body read from a `0600` file, sent
on `hc connect`'s stdin, never in `argv`) and its fake-link tests: a canary body, raw and in
base64, in no `argv`, log, notification, shared state, error or record, with canaries also put in
failure answers and stderr; the controller's synthetic management key in no hc request; and a
core replacing the expected one under the same name receiving zero bytes. The source's behaviour
today would not do instead: its id check binds the record the name-or-id match picked, not the id
the caller meant. Writing into a private staging folder in place of a documented mode is no
fallback either: `file.write` makes folders with the default mode, and a file keeps its mode when
moved, so staging would need its own amendment that makes the file private before it is moved
into place. Such an amendment, a route outside the hc link (for example a separate
`ssh <target> hc connect`, which the owner's rule of 2026-11-05 keeps credentials out of), or
Q3's (b) (both test homes on this computer, a preliminary result that cannot open 3a) is the
owner's decision. Until the owner takes it, Codex stays on this computer only, Q4's fallback
(decided 2026-11-20, see Decided, Q4).

### Delivery 0b: the Codex grant trial (the owner runs it)

The one piece of evidence is Claude's: the proxy renewed a grant the panel had copied, and the
copy's login ended that minute (`DESIGN.md:34-39`). Whether a Codex grant survives several
holders is not known, and nothing here documents how its refresh tokens behave. The trial
answers one question: **do three holders of one Codex grant keep working through each other's
renewals?**

- **Holders.** The proxy, plus two Codex homes that are nobody's working login: test folders
  given to Codex as `CODEX_HOME`, so no real `auth.json` is touched. Where the homes live is Q3:
  one on this computer and one on a linked machine (the owner's setup, seeded through 0a's
  route) (blocked while 0a finds no qualified route), or both on this computer (a preliminary
  result only).
- **Grant.** A Codex account no bot depends on, downloaded **once** from the proxy and placed in
  both homes, so both hold exactly the proxy's grant. The management key stays on this computer.
  Both test homes are set to keep credentials in `auth.json`, not the OS keyring (Codex has both,
  `docs/rfcs/0003-model-routes-and-acp.md:885-893`), and that is checked before the start; a pass
  covers only that storage.
- **Using each holder.** Right after seeding, one attributable request through each holder (each
  home's `codex exec` with its `CODEX_HOME`, and one request the proxy serves **with that
  credential**). Then the same every 30 minutes. If the proxy cannot be made to serve a request
  with exactly that credential, the proxy holder is not exercised and the trial can only be
  inconclusive.
- **Renewal signal, no token read.** Codex keeps `last_refresh` in `auth.json`, metadata the
  panel already handles (`translate.js:25-39`), not a token; the proxy reports each account's
  `last_refresh` and `status` (`DESIGN.md:11-16`). What this field means is not established
  here: seeding can write it (`translate.js` fills it when the proxy gives none). So the trial's
  first step **qualifies the signal** for the Codex and proxy versions under test, from their own
  documentation or source, as "written when that holder renewed". Without that, renewals are not
  counted and the trial is inconclusive. The value right after seeding is the baseline. Each
  sample records the time, each holder's `last_refresh`, the proxy's status, and each request's
  result (success, sign-in failure, other failure). No output text is kept.
- **Order.** What matters is a holder renewing *after another holder already renewed*. That is
  read from the `last_refresh` times. Times from different clocks (each host, and the proxy's)
  are compared only when those clocks were checked against each other at the start and the end;
  an order that the clock check or the sample gaps cannot settle is inconclusive.
- **Outcomes.**
  - **Pass:** at least 48 hours; every holder served an attributable request at the start;
    every holder renewed at least once after another holder's renewal; every holder then served
    at least one successful attributable request; no holder ever needed a new sign-in.
  - **Fail:** any holder signed out. The record names which holder renewed last before it.
  - **Inconclusive:** too few renewals, an unsettled order, a holder not exercised, a gap in the
    samples around a failure, or a failure with another cause (the network, the proxy down). The
    owner extends the trial or stops it.
- **Safety.** The trial stops at the first sign-in failure. Afterwards both test homes are
  deleted and the test account is signed in again on the proxy; whether the old grant then stops
  working is not known, so the test account is not used for anything else. The record keeps the
  Codex CLI version, the proxy version, where the homes lived and the number of holders; no
  email, machine name or token.

The outcome is reviewed by the coordinator and written into this RFC (Decided) before 3a starts
(Q4).

### The plan

**One executor for linked machines.** Every write on a linked machine is done by one CLI command
on the computer that runs Herdr, `am accounts apply`, under one lock,
`<app home>/automagik-herdr/accounts.lock`. `local` is applied by the panel instead (below). The panel starts it in an hc terminal of its own, as
its Restart does, so Herdr's 30-second cap on a mod's `exec` does not end it. The sidebar's hourly
machines cycle starts the same command for retries, only while am-quota is switched on (not in
`mods-disabled/`); while the sidebar is stopped there are no hourly retries. The cycle's
`linked-update off` concerns software updates and does not stop account retries. **This
computer's own switch stays in the panel**, as today, with Herdr's environment (`CODEX_HOME`,
the key): the executor never handles `local`, so no key or `CODEX_HOME` has to travel through a
terminal's `argv`. The executor needs the key only for a Codex copy (3a), and then reads it from
the key file; a setup with the key only in Herdr's environment reads "copying to other machines
needs the key file" and copies nothing.

The plan logic lives in the CLI's copy closure (the sidebar folder, byte-copied into `am/` by
`scripts/am-copies.mjs`); the panel asks the CLI for previews, so there is one copy of it.

**One approved record.** `<app home>/accounts-plan.json`, mode `0600`, written **only** by the
executor, under the lock. Both callers resolve the app home the same way (`HERDR_APP_HOME`, else
`~/.config/herdr-app`):

```json
{ "v": 1, "rev": 7,
  "codex":  { "mode": "one", "account": "<key>", "pin": { "<core id>": "<key>" },
              "machines": ["<core id>"], "assign": { "<core id>": "<key>" } },
  "claude": { "mode": "pinned", "pin": { "local": "<key>", "<core id>": "<key>" },
              "assign": { "local": "<key>", "<core id>": "<key>" } } }
```

- **A change is a preview, then a commit.** The panel asks the CLI for a preview (built from the
  plan and the latest reads) and shows exactly which machines would move and how. The preview is
  kept in a private file on this computer; only its opaque id travels in `argv`. The person's
  press commits it: `am accounts plan --commit <preview id> --expect-rev <n>`, under the lock. A
  preview made from an older `rev` is refused, so two panels cannot both commit. The commit
  stores, per machine that moves, the intended result in `assign` **and the target state the
  person saw** (the Codex generation or Claude snapshot, and the resolved home). `apply` writes
  only while the machine still shows that state; a machine that changed since reads **changed on
  the machine** and needs a fresh preview. Retries apply `assign`; they never recompute it.
- **The plan also holds each machine's progress**: `pending` (with the attempt it last started,
  so a lost answer is read before anything is repeated), `done`, or `suspended` (Q10). So losing
  `fleet.json` (below, observations only) loses neither an approval nor an outstanding attempt.
- **No approval, no writes.** A missing, corrupt or unknown-version plan authorizes no write on
  any machine.
- **`local`** is applied by the panel, in Herdr's environment, as today's switch: when the panel
  next draws, it sees a `pending` for `local`, applies it once under its own switch lock, reads it
  back and asks the CLI to record the result. While the panel is closed, `local` shows as pending
  in the CLI's and the panel's views.
- A **machine** is `local` (this computer) or a linked machine's **core id** from
  `hc machine ls`. Its current name is for display and routing only. A write first checks that
  the name still resolves to that core id (and 0a's route binds the core id itself); a pin whose
  core is gone is suspended and shown until the person rebinds it to another core or forgets it,
  and a new core under an old name never inherits it. A `hc machine ls` that fails or does not parse
  changes nothing: it is never read as "every machine unlinked". Temporary machines are left out,
  as everywhere in the pack (`meterFleet.js:53-58`). A linked machine joins the plan only by a
  press.
- **Modes**: `one` (every machine in the plan on `account`), `spread` (below), `pinned` (every
  machine on its own pin and nothing else). `pin` overrides one machine in any mode.
- **Which machines receive Codex** (`codex.machines`): a list the person sets, empty by default.
  A linked machine receives a Codex credential only while it is on that list (Q6).
- An **account key** is provider-scoped: for Codex, the proxy credential's name; for Claude, the
  login's email, lowercased.
- Before each machine's write, `apply` reads the plan and the switch-on state again and stops if
  either changed.

**Upgrading writes nothing.** No plan means delivery 1's read-only rows. The first plan comes
from **Manage across machines**: the preview pins every machine where it is **only where that is
proven**: a Claude slot read on that machine, or, for Codex, `local` only, from the panel's
`active.json` and its own read. A Codex file on a linked machine was never placed by this panel,
so it is observed and unmanaged, as is anything with no account id, an alias, a login made
outside this panel, an unreadable file, or a machine that cannot be read; none gets a pin.
`active.json`'s name and 32-bit fingerprint are an observation, not a proof of which grant is
there. Committing it moves
no machine. Unmanaged machines join only by a later press, which for Codex means placing a fresh
download there. Linked Claude launches change only for machines in the plan's `claude` section
(see Claude, below).

**A change made on a machine itself** (someone switches there, by hand or on its own panel) is
seen at the next read. The machine's row says **changed on the machine**; its assignment is
suspended (no retry overwrites it) until a press either adopts the new state into the plan or
re-applies the plan (Q10). Before a plan exists, this computer's Use and Switch work exactly as
today.

**Suggestions stay suggestions.** An account projected to run dry (`policy.js` `choose`) or no
longer eligible produces a preview of which machines would move; pinned machines are listed and
stay unless the person includes them. Quota numbers alone never move a machine.

### Spread (#438)

Pinned machines are never moved by spread, and they count toward each account's total.

1. **Eligible.** An account is eligible on a machine when it can be used there: for Codex, the
   proxy reports it usable (`policy.js:80-86`) and the machine is `local` or on `codex.machines`;
   for Claude, a slot on that machine is signed in as that email with no override and no
   ambiguity (the probe below). Proxy quota is not needed for Claude: a login with no quota match
   is usable today and reads "usage not tracked". A machine with nothing eligible stays where it
   is and says so.
2. **Placing one machine** (in a preview: a machine added to the plan, or one whose account is no
   longer eligible): it goes to the eligible account with the fewest machines, ties by account
   key in code-point order. No other machine moves. Several machines placed in one preview are
   placed one at a time in machine order (`local`, then core ids in code-point order), so the
   input order never changes the result.
3. **Rebalancing** (in a preview from **Spread again**): among all assignments that respect
   eligibility and pins, the one whose account counts, sorted from largest to smallest, are the
   smallest list (compared in order); then the one that moves the fewest machines; then the one
   whose accounts, listed in machine order (`local`, then core ids in code-point order), are the
   smallest list by account key. Fleets here are a handful of machines, so it is computed exactly.
4. Machines that are away keep their assignment and take it when they come back.

A pin change in `spread` moves that machine only (#438: "an override applies to exactly that
machine"); the others wait for **Spread again** (Q7).

Fixtures (machines in order `L` = local, `m1`, `m2`, …; accounts `A < B < C`), each an exact
expected map in the delivery's tests, with shuffled input giving the same map:

| Case | Input | Expected |
|---|---|---|
| one | `one A`, all eligible | `L:A m1:A m2:A` |
| one pin | `one A`, pin `m2:B` | `L:A m1:A m2:B` |
| 3 over 2 | `spread`, all placed one by one, none current | `L:A m1:B m2:A` |
| 4 over 3 | as above, four machines | `L:A m1:B m2:C m3:A` |
| 2/2/0 | current `L:A m1:A m2:B m3:B`, C eligible everywhere, Spread again | `L:A m1:A m2:B m3:C` |
| constrained | current `L:A m1:A m2:A m3:B m4:B m5:C`; `m2` may use A or B, `m4` B or C, the rest only their current; Spread again | `L:A m1:A m2:B m3:B m4:C m5:C` |
| invalid pin | pin `m1:C`, C not eligible on `m1` | `m1` keeps its current account, flagged |
| nothing eligible | no account eligible on `m2` | `m2` keeps its current, flagged |
| away | `m2` away during Spread again | `m2` keeps its assignment, marked away |

### Reading each machine (`am accounts here --json`)

A new read-only command (sidebar CLI, byte-copied into `am/`), run on each linked machine through
`hc exec --on`. **Read-only means no write of any kind there:** `here` skips the link repair every
other command runs (`automagik-herdr.mjs:10494-10496`), and before running anything the executor
finds the target's `automagik-herdr` and `am`, reads each one's version from its `VERSION` file
without running it, and runs the newest one at or above the version that has `here`. None:
`no-cli` or `old-cli`, and nothing is run. Bounded to 20 seconds. Its answer is one small
versioned JSON object:

- **Codex:** which home (`$CODEX_HOME`, else `~/.codex`, as the core's environment gives it);
  whether `auth.json` is there and readable; its account-id fingerprint, or `no-account-id` (the
  refresh-token fallback is never used here); its `last_refresh`; and its **generation**, a
  SHA-256 of the whole file computed there, to detect any change, a refresh included. Never a
  token.
- **Claude:** the checks the panel makes for this computer's logins (`am-quota/logins.js`: the
  folder form, `claude auth status` with the words a launch would get, the auth method,
  overriding variables), run on the target with the same login words a managed launch there
  would get (below), so credentials and raw status output stay there. Per slot, the default
  included: its id, its email lowercased, and `eligible` or a reason (`override`,
  `not-signed-in`, `bad-folder`, `ambiguous` when two slots share an email, `timeout`). Then the
  selected slot, the email a new launch would actually get, and the file's **snapshot**, a SHA-256
  of `claude-logins.json`'s text. That probe moves into the CLI's copy closure so the panel and
  the CLI use one copy.
- **Reasons** are fixed codes, never raw output: `no-cli`, `old-cli`, `unreachable`, `timeout`,
  `bad-answer`, `failed`. A project whose `.herdr/pane-env` names another `HERDR_APP_HOME`
  (`herdr/mods/am-sidebar/agentPath.mjs:343-355`) launches with another app home; those projects
  are listed under the machine as "uses its own app home: not managed", and no claim is made for
  them.

**Codex identity, provenance and generation.** An account-id fingerprint says which account,
not which grant: it is the same after a refresh, for a sign-in made outside this panel, and for
two proxy credentials of one account. So a row reports two things apart: **which account** (the
fingerprint) and **whose grant** (placement). The plan keeps, per machine, what the executor
placed there: the proxy (`cliproxy.json`'s URL), the credential name, its account fingerprint and
the generation it wrote. Exactly the placed generation is **on <account>, placed here**. The same
account with another generation reads **on <account>, grant origin unknown**: Codex may have
refreshed the placed grant, or someone signed in to that account on the machine, and nothing
non-secret tells the two apart. That state needs no retry (the account is the wanted one), and
**Remove from machine** there asks the person to confirm that the file may be their own sign-in.
Another account is **changed on the machine** (Q10). No account id is **unknown**. A row says
the credential is in place, never that it works (`DESIGN.md:62-64`).

**Each machine's row** says what the machine read, not what was asked: **on <account>**, **still
on <old account>**, **switching**, **away** (not connected), **changed on the machine**,
**failed: <code>**, **unknown: <code>**, or **no login of <account> here** (Claude). Nothing reads
**on** until the read-back matches `assign`.

**The outcome record** is `<app home>/data/am-quota/fleet.json`, `0600`, observations only: per
machine and tool the last read (fingerprint, generation, slot, snapshot), the placement record,
the state, the reason code and the time. No free text. A machine that is behind its `assign` and
not suspended is retried by `apply` on the panel's poll (at most once per machine every 5 minutes
while the panel is open) and on the hourly cycle. After a lost answer, the machine is read again
before anything is written.

**Retention.** When a machine is unlinked, `fleet.json` drops its observations at once. The plan
keeps that machine's entry, its pins included, suspended, until the person rebinds it to another
core or presses **Forget**, which deletes it; and, while a Codex credential may remain there
(placed, staged or backed up, see 3a), one exposure line (core id, "may hold a Codex credential
since <date>") that only a confirmed clean-up or the person's own dismissal removes.

### Bots still on the old account

Under each machine's row: the bots on **confirmed bindings** of the controller's attach ledger for
that machine (its core id, terminal and `created_ms`), checked with `hc get` on their address. A
Claude bot is matched by its launch argv's login words, by value, as this computer's are
(`local-logins.md` section 3). A Codex bot is matched by its pane's start time against the switch
time the target's write reported on the target's own clock; when the write's answer was lost, or
any running bot of that tool has no start time, the split is not trusted and every running bot of
that tool there is listed, as today (`herdr/mods/am-quota/view.js:325-336`). **Restart** asks for
the second press, as today, then runs `am restart <bot> --machine <name> --project <folder>` with
the binding it showed; the restart refuses when the pane is no longer that binding (another
terminal or `created_ms`), and keeps its busy and helper refusals. A tree restart is not offered.
Bots the controller has no binding for are not listed, and the row says so.

### Claude on linked machines

- **One writer on each machine.** Every change to a machine's `claude-logins.json` (`use`, and the
  slot list its own panel edits) goes through one CLI command there, `am accounts set-login`,
  which holds a lock on that machine across its compare and its rename: it refuses when the
  file's snapshot is not the one it was given, then writes a `0600` temp file and renames it.
  The panel's own edits move to the same command **where that command is present**, so the race
  RFC 0014 describes between Herdr's writer and a Node writer
  (`docs/rfcs/0014-shared-bot-registry.md:166-181`) cannot happen there. A stale snapshot is a
  conflict that keeps the other edit, read again at the next retry. No credential crosses the
  link, and nothing is signed in or out.
- **Mixed installs keep working locally.** The panel works without the sidebar, and the pack and
  a standalone am can be installed side by side at different versions
  (`am/lib/self.mjs:13-20`, `herdr/mods/am-quota/main.js:119-126`). So the probe reports the
  pack's version and the standalone am's version apart, and whether the panel that edits that app
  home is switched on and at a version that writes through `set-login`. A home where the writer
  and that panel are not both qualified keeps today's local edits through Herdr's writer and is
  **not eligible for fleet writes** ("update this machine first"); the fleet never writes a file
  another writer may be writing without the lock.
- **A machine with no login of the wanted account** stays on its own and reads **no login of
  <account> here**; it is not retried until a read shows such a login. Only where the owner allows
  a second login (today: the Mac) does the row add the folder-qualified sign-in of
  `local-logins.md` (section 1's slot rule, section 7, "The second sign-in"):
  `CLAUDE_CONFIG_DIR=<next slot> claude auth login`, never a bare `claude auth login`, which would
  change the default login.
- **`one` for Claude** means the account each machine uses where it has a login of it; a machine
  without one is an accepted exception, shown (Q8). The owner's hosts have one account each today,
  so their Claude plan starts `pinned`.
- **Today's launches differ by route.** On a machine outside the plan, `seatOnMachine` passes no
  login words (the pane inherits the core's environment), while the delegated tree restart
  applies the target's own record, `-u CLAUDE_CONFIG_DIR` for the default included. With an
  inherited `CLAUDE_CONFIG_DIR` and `use: "default"`, the two can already start different logins.
  Delivery 1's row says so: it shows what each route would start now, from the probe run once
  with no words and once with the record's words, and says when they differ.
- **Managed launches.** A machine is managed for Claude for **one core id and one resolved app
  home**: the home `launchHomeOn` resolves for it (`automagik-herdr.mjs:3873-3895`: a project's
  `HERDR_APP_HOME`, else that machine's `~/.config/herdr-app`). For a project launching with that
  home, every route uses the target's record with the same words a local launch gets,
  `-u CLAUDE_CONFIG_DIR` for the default included: `seatOnMachine` (start, plain restart, and its
  second seat after a failed resume) reads that home's `claude-logins.json` and checks the slot
  folder on the target (`test -d` and the form rule there, never this computer's `realpath`); the
  delegated tree restart already does so. A project launching with another home, or where the
  home, the executable or the environment cannot be resolved, is listed as an exception and keeps
  today's behaviour on each route. So does every machine outside the plan. The existing guards on
  adopted and recovered panes stay. The preview that adds a machine says which login its next
  launch will use on each route, from the probe. This replaces `local-logins.md:152`'s
  out-of-scope line. Fixtures: an inherited slot 2 with `use: "default"`, an alternate home, start,
  plain restart, its second seat and the tree restart, managed and not.

### Codex on linked machines (delivery 3, after the trial)

**3a, on a pass (the owner's #424 design).** Built only after 0a found a qualified route, the
trial passed, and Q4 chose it. A pass covers what was tested: at most as many linked machines
hold the grant at once as the trial had linked holders; more needs a trial with that number or
the owner's explicit decision.

- **Exposure is recorded first.** Before any byte is sent, the plan records that the machine
  may hold this grant from now on. Every place a copy can be (the current file, a stage, the
  backup, an unreachable machine) counts toward the tested holder limit, and the record stays
  until a clean-up on that machine is confirmed.
- **The handoff.** The executor downloads the credential **afresh for each attempt** (never a
  cached body) into the private payload folder, and a CLI helper reads it and sends it over 0a's
  route. The body is in no `argv`, log, notify, shared state, error or record.
- **On the target**, a fixed script: an exclusive per-attempt stage folder (`mktemp -d`,
  `0700`); the body lands there; the script checks the whole payload (Codex's `auth.json` shape,
  the expected account fingerprint) and that the destination's generation is still the one the
  approved preview saw (else "changed on the machine", nothing written).
- **No refresh may be lost.** Codex takes no lock on `auth.json`, and a compare followed by a
  rename loses a write that lands in between (RFC 0014's lesson), and the read afterwards cannot
  see it: it returns the new file. So an **existing** file is replaced only while no Codex
  process of that user runs on the machine, checked by the script right before the rename; with
  one running, the machine reads **waiting: Codex is running there** and is retried. A Codex
  started inside that last step is the residual, and the owner decides whether to accept it (Q11);
  without that, 3a only places a credential where no `auth.json` exists. A missing file is created
  exclusively, never over one that appeared meanwhile. The same rule holds for removal and for
  putting a backup back.
- **The backup.** Before the first placement on a machine, the file there (if any) is kept once,
  `0600`, as the **original** (it may be the person's own sign-in); later placements replace each
  other and keep no further copy (Q9). The script answers with the new generation and its own
  commit time.
- **Clean-up** of this attempt's stage is part of the same script; older stages are removed by
  the next `apply` there or by **Remove from machine**, never by `here`. After a lost answer, the
  target is read before any retry.
- **Remove from machine** (while reachable, confirmed): the machine leaves `codex.machines` and
  its retries are cancelled first; then, under the rule above, its stages are removed; the current
  file is removed only if its generation is still the one placed (with the same account but
  another generation, only after the person confirms it may be their own sign-in); and the
  original is put back where the current file was removed. A file with another account is kept and
  named. An unreachable machine keeps its exposure line, as does an unverified revocation.
- Tests use a fake link that records every `argv` and asserts the canary body never appears; they
  disconnect after the stage, after the body and after the rename; a running Codex holds the
  replacement; a refresh injected after the last check (in the fake) survives or the write is
  refused; a refresh with an unchanged account id; a sign-in made outside the panel with the same
  account; a removal after an interrupted delivery cleans its stage.

**On a fail or an inconclusive result**, Codex stays as it is today (this computer only), and a
Codex design for linked machines is a new owner decision. One candidate is Claude's rule for
Codex: an own sign-in per account per machine, one `CODEX_HOME` per login, chosen for new
launches. A separate `CODEX_HOME` also separates Codex's config and conversation history.

## Contracts introduced

| Contract | Rule for existing installs |
|---|---|
| `<app home>/accounts-plan.json` (v1, `0600`, executor-written) | New. No file, a corrupt one or an unknown version: no write on any machine. |
| `<app home>/data/am-quota/fleet.json` (`0600`) | New, written from delivery 1, observations only. Missing or corrupt: machines read "unknown" until read again. |
| `<app home>/automagik-herdr/accounts.lock` | New. One executor run, or one commit, at a time. |
| Private preview files on this computer | New; only an opaque id in `argv`; removed once committed or stale. |
| `am accounts here`, `apply`, `plan --commit`, `set-login` | New, both CLI entry points. `here` writes nothing and skips link repair. A target with an older CLI reads `old-cli` and is not run. |
| The panel's Claude slot edits go through `set-login` | From delivery 2, where that command is present; otherwise Herdr's writer, as today, and that home takes no fleet writes. The file's format is unchanged. |
| Linked launches add the target's login words | Only for a machine in the plan's `claude` section and projects launching with its managed app home; everything else keeps each route's behaviour today. |
| A Codex `auth.json` on a linked machine (3a only) | Only on machines in `codex.machines`; one backup there. |
| `policy.js`'s "never balancing" | Unchanged for `one` and `pinned`; `spread` is the person's explicit choice. |

am-quota ships switched off; none of this reaches an install that has not turned it on.

## Threat model

- **The management key** stays on the computer that runs Herdr: no machine is given it, and it is
  never in a terminal's `argv`. The executor reads it from the key file, only for 3a.
- **Codex grants on other machines (3a).** A linked machine that receives a Codex credential holds
  a reusable grant, and a compromised machine can keep it after it is unlinked. The panel shows,
  per machine, how many Codex credentials it holds (current and backup). It cannot promise
  revocation: nothing here shows that signing in again on the proxy ends the old grant. An
  unlinked or unreachable machine that may still hold one is shown as an open exposure.
- **Shell reach is not new**: every linked machine already runs commands through `hc exec --on`.
  What 3a adds is a grant at rest on that machine.
- **Claude** is never copied; a remote write changes only a slot id, through that machine's own
  writer.
- **Records and errors.** The plan and outcome records stay in the app home (`0600`), never in
  git, a test or public text. A Claude email crosses the link only in `am accounts here`'s answer,
  between the person's own machines. Reasons are fixed codes; raw stdout, stderr, RPC and provider
  messages are dropped on every credential path. The tests put a canary in failure answers and
  check it is absent from `argv`, logs, notifications, shared state, errors and both records.
- **Undo.** Switch am-quota off: no `apply` runs. Each machine keeps its last account and its
  files; nothing is removed except by **Remove from machine**.

## Deliveries

0. **0a, the transport qualification** (no secret; done 2026-11-20: no route qualified, see its
   findings), and **0b, the owner's trial**.
1. **Read-only view.** `am accounts here`, the per-machine rows and bots, and `fleet.json` (a
   record on this computer only; nothing is written or repaired on any machine). Lane: herdr
   patch with am's copies. Acceptance: a fake `hc` with `local`, one machine away, one with an old
   CLI, one with two CLIs of different versions and one reading another account gives exact rows
   through both entry points, and the fake records zero writes and zero CLI runs on the old one.
   Rollback: the rows go; `fleet.json` stays, unused.
2. **The plan, and Claude across machines.** `accounts-plan.json`, previews and commits, `apply`,
   the lock, `one`, `pinned` and `spread`, `set-login` on every machine with the panel moved onto
   it, managed linked launches, retries. Acceptance: the fixtures above; a stale preview refused;
   a machine with no login of the account (never retried in a loop); a conflict keeping the other
   edit; a lost answer read before a retry; two `apply` runs at once; a newer `rev` mid-run;
   am-quota switched off mid-run; a change made on the machine suspending its assignment; managed
   and unmanaged launches through start, plain restart, its second seat and the tree restart;
   partial success across machines. Rollback: linked starts get no login words again; each
   target keeps its last `use`; the panel's slot edits go back to Herdr's writer.
3. **Codex across machines**, 3a only, after 0a, a pass, Q4 and Q11. Acceptance: the tests
   above, a machine off `codex.machines` never written, the holder limit counting stages, backups
   and unreachable machines, **Remove from machine** with a placed file, a same-account file of
   unknown origin, a changed file and an unreachable machine. Rollback: each machine keeps its last `auth.json` and
   backup.

Deliveries 1 and 2 copy no credential; they start before the trial (Q2).

## Decided

Approved by the owner's delegate on 2026-11-20 (the note under the table), with every
recommendation. The options not taken stay listed with each question below; taking one needs a
later amendment.

1. **Q1.** The RFC's shape stands: one approved plan, read-back before "on", Claude per machine
   without copies, Codex copying only after a qualified route and a pass.
2. **Q2.** Deliveries 0a, 1 and 2 may start before the trial.
3. **Q3.** The trial runs with one test home on this computer and one on a linked machine, seeded
   through 0a's route; a single-host run would only be preliminary. Blocked for now: delivery
   0a found no qualified route (Delivery 0a's findings); the trial waits for one, or for the
   owner to choose another option by an amendment.
4. **Q4.** A pass opens 3a, limited to what was tested; a fail or an inconclusive result keeps
   Codex on this computer only. In addition, the delegate holds 3a: the trial is prepared with a
   test home, and its result goes to the coordinator for review before any real credential is
   copied. No delivery reads or copies a real Codex or Claude home. Since 2026-11-20 (after
   0a's findings) the trial and 3a are left to the owner, and until the owner decides, Codex
   stays on this computer only, as after a fail; the deliveries go on with 1 and 2.
5. **Q5.** This computer is `local` in the plan, first in order; its switch stays the panel's.
6. **Q6.** A Codex credential goes only to machines the person adds to the list; none by default.
7. **Q7.** A pin change in `spread` moves that machine only; the rest waits for **Spread again**.
8. **Q8.** A host with no login of the account is an accepted exception under `one`; the sign-in
   hint appears only where the owner allows a second login (today the Mac).
9. **Q9.** One Codex backup on a linked machine: the original file, put back by **Remove from
   machine**.
10. **Q10.** A switch made on a managed machine suspends its assignment until a press adopts it
    or re-applies the plan.
11. **Q11.** An existing Codex file is replaced only while no Codex process of that user runs
    there; the residual is accepted.

## Open questions

None open. The questions as put to the owner, with the options not taken:

1. **Q1. Does this RFC's shape stand?** (a, recommended) Yes: one approved plan, read-back before
   "on", Claude per machine without copies, Codex copying only after a qualified route and a
   pass. (b) Split it: #438's plan now, #424's Codex part in its own RFC after the trial.
2. **Q2. What may start before the trial?** (a, recommended) 0a, 1 and 2: none of them moves a
   credential, and the trial is about sharing a Codex grant. (b) 0a and 1 only (no write on any
   machine). (c) 0a and the trial only: the gate stays for every delivery that changes a
   machine, and 1 and 2 wait for the outcome. (d) Nothing: the gate stays as set on 2026-11-19,
   the trial included, until the owner runs it by other means.
3. **Q3. Where the trial's holders live.** (a, recommended) One home here and one on a linked
   machine, seeded through 0a's route: the setup the owner asked for, and the only result that
   can open 3a. If 0a finds no route, the linked trial is blocked. (b) Both homes on this
   computer: no credential crosses a link, but the result is preliminary and does not open 3a.
4. **Q4. After the trial.** (a, recommended) A pass: build 3a, limited to what was tested (the
   holder count and the file-backed storage). A fail or an inconclusive result: Codex stays on
   this computer only. (b) Keep Codex on this computer only even after a pass. Any other Codex
   design for linked machines (for example Claude's rule, an own sign-in per account per machine)
   is a separate design decision, not part of this RFC.
5. **Q5. Does this computer count as a machine in the plan?** (a, recommended) Yes, `local`,
   first in order; its switch stays the panel's own. (b) No: the plan covers linked machines only.
6. **Q6. Which machines may receive a Codex credential (3a)?** (a, recommended) Only those the
   person adds to the list, one by one; none by default. (b) Every linked machine in the plan.
7. **Q7. A pin change in `spread`.** (a, recommended) Moves that machine only; the rest waits for
   **Spread again**. (b) Rebalances the others at once.
8. **Q8. A host with no login of the account under `one`.** (a, recommended) An accepted
   exception: it stays on its own login, shown, and the sign-in hint appears only where the owner
   allows a second login (today the Mac). (b) `one` cannot be chosen while any host in the plan
   lacks a login of that account. (c) Claude takes no part in the plan.
9. **Q9. Codex backups on linked machines (3a).** (a, recommended) One: the file found before
   the first placement is kept once as the original (it may be the person's own sign-in) and put
   back by **Remove from machine**; later placements keep no further copy. (b) None: no step back,
   and the original is lost. (c) Three, as on this computer, each one more copy of a grant.
10. **Q10. A switch made on a managed machine itself.** (a, recommended) Its assignment is
    suspended and shown until a press adopts it or re-applies the plan. (b) The next retry puts
    the plan's account back.
11. **Q11. Replacing an existing Codex file on a linked machine (3a).** (a, recommended) Only
    while no Codex process of that user runs there, checked right before the rename; a Codex
    started inside that last step can still lose one refresh, and that residual is accepted.
    (b) Never: 3a places a credential only where no `auth.json` exists, and replacing one stays a
    person's job on that machine.

## Links

- Issues: #424 (switch across linked machines), #438 (one, per machine, spread); #453 (Claude
  logins per machine, built); #413 (Accounts restart); #436 (`start` and `restart --machine`).
- Code: `herdr/mods/am-quota/` (`DESIGN.md`, `RECIPE.md`, `docs/local-logins.md`, `switch.js`,
  `write.js`, `policy.js`, `translate.js`, `logins.js`, `main.js`, `view.js`);
  `herdr/mods/am-sidebar/` (`logins.js`, `attach.js`, `agentPath.mjs`, `meterFleet.js`,
  `machineUpdates.js`, `remoteFile.js`, `docGet.mjs`, `bin/automagik-herdr.mjs`);
  `scripts/am-copies.mjs`.
- RFCs: [0011](0011-monorepo-parts-and-releases.md) (lanes), [0012](0012-am-cli-and-parts.md)
  (am), [0014](0014-shared-bot-registry.md) (two writers on one file).
