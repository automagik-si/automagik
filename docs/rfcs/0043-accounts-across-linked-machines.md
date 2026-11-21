# RFC 0043: Accounts across linked machines

| Field | Value |
|---|---|
| Status | In delivery (2026-11-20, approved by the owner's delegate: Q1-Q11 answered with this RFC's recommendations, see Decided; delivery 0a found no qualified transport, so the linked trial and 3a are blocked (Delivery 0a's findings); on 2026-11-20 the owner's side left the trial and 3a to the owner and kept Codex on this computer only, Q4's fallback; deliveries 1 (#1901) and 2 (#1914) merged; amendment proposed 2026-11-21 (RFC 0030 Q19, Q23): Q12-Q17 for the owner) |
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

## Amendment (2026-11-21): this computer's Codex switch and the plan without the pack

**Status. Proposed, for the owner.** Q12–Q17 are open. Deliveries 4 and 5 describe the
recommended answers and wait for the owner's decision.

### What is already decided

- [RFC 0030 Q19, Answers (2026-11-20)](0030-code-mode-in-the-app.md#answers-2026-11-20)
  requires “apply and retries moved off the pack.” The Accounts page carries the per-machine
  view, preview, approval, apply and retries. A plan must apply from the page on a fresh install
  with no pack, and a failed machine must be retried. This is part of the condition for the
  pack's last release. Installed panels keep working.
  [The pack after the move](0030-code-mode-in-the-app.md#the-pack-after-the-move)
- [RFC 0030 Q23, Answers (2026-11-20)](0030-code-mode-in-the-app.md#answers-2026-11-20)
  calls for “one locked CLI writer that gets the same `CODEX_HOME` and proxy key as the panel,”
  with an older panel refused during the move. The switch stays in the panel and 5c's page
  reads only until cutover. [The `am-quota` row](0030-code-mode-in-the-app.md#mod-by-mod)
- Q23 supersedes Q5's writer clause, “its switch stays the panel's.” This computer remains
  `local` in the plan and first in order. Q1–Q4 and Q6–Q11 stand. Under Q4, Codex stays on this
  computer. The linked trial and delivery 3a remain held.

### 1. Today, corrected

Delivery 1 (#1901) and delivery 2 (#1914) merged.
[RFC 0030, What moves now, 4](0030-code-mode-in-the-app.md#what-moves-now)

Line numbers for the text being corrected refer to the accepted text above. `CLI` in the source
citations means `herdr/mods/am-sidebar/bin/automagik-herdr.mjs`.

- **What the code does today, lines 36–44.** Manual Use/Switch takes an in-memory lock on the
  panel view and calls its shell installer (`herdr/mods/am-quota/main.js:1202-1241`,
  `herdr/mods/am-quota/lock.js:12-22`, `herdr/mods/am-quota/DESIGN.md:256-262`). The panel reads
  `CODEX_HOME` and `CLIPROXY_MGMT_KEY` from Herdr's environment with `printenv`. The key file
  `~/.config/cliproxyapi/mgmt.key` is the fallback when the variable is empty. The proxy base
  comes from `<app home>/cliproxy.json` (`herdr/mods/am-quota/main.js:42-43,232-241,318-342`).
  The panel downloads through `credentials/download` (`herdr/mods/am-quota/switch.js:38-44`,
  `herdr/mods/am-quota/proxy.js:250-261`). It stages `data/am-quota/codex-<stamp>.json` at
  `0600`. The installer backs up, renames and keeps three backups
  (`herdr/mods/am-quota/write.js:25-29,57-81`, `herdr/mods/am-quota/switch.js:51-82`).
  `data/am-quota/active.json` records the name and 32-bit fingerprint of `account_id`, with a
  refresh-token fallback on the manual path (`herdr/mods/am-quota/main.js:44,1221-1224,1405-1427`,
  `herdr/mods/am-quota/translate.js:127-151`).
- **What the code does today, lines 45–49 and 73–75.** The Claude panel uses `set-login` when
  its writer is present. It falls back to Herdr's snapshot writer when the writer is absent
  (`herdr/mods/am-quota/main.js:1247-1260`, `herdr/mods/am-quota/logins.js:26-34`). Local and
  linked `set-login` mutations take `claude-logins.json.lock` (`herdr/mods/am-sidebar/logins.js:9-14`,
  `CLI:13189-13218`). The write path checks writer qualification only with `--expect-core`
  (`herdr/mods/am-sidebar/accountsWrite.js:88-91,109-119`, `CLI:13238-13253,13427-13430`). The panel
  writes `v`, `setLogin` and `version` to `writer.json`. The capability reader requires
  that exact shape (`herdr/mods/am-quota/main.js:402-419`,
  `herdr/mods/am-sidebar/accountsWrite.js:12,21-53`). Restart starts its own terminal and
  forwards a fixed list of environment values in `argv`. The list omits the key and
  `CODEX_HOME` (`herdr/mods/am-quota/main.js:101-108,1487-1494`).
- **The plan, lines 220–231, 236 and 262–265, and Contracts introduced, lines 524, 526 and 528.**
  `apply` skips `local`. The panel drives `local` on reload, including due work
  (`herdr/mods/am-sidebar/accountsApply.js:47-65,89-92`,
  `herdr/mods/am-sidebar/accountsPlanRecord.js:351-356`,
  `herdr/mods/am-quota/main.js:394-396,561-567,605-625`). For managed Codex, the panel supplies
  the home from Herdr's `CODEX_HOME` in a private request. It downloads and stages the payload.
  The CLI records the fence and renames the staged file under `accounts.lock`. The panel reads
  back and asks the CLI to settle the attempt
  (`herdr/mods/am-quota/main.js:433-455,474-487,680-686,723-775`,
  `CLI:13087-13111,13281-13334,13353-13375`). The accounts CLI reads the staged payload and
  uses no proxy key (`CLI:13289-13334,13461-13485,13523-13539`). Commits,
  local plan verbs and `apply` can all write the plan through the CLI under the app home's
  directory lock (`CLI:278,12961-12975,13032-13061,13461-13485`,
  `herdr/mods/am-sidebar/accountsPlanRecord.js:2-6`). `quotaOn()` requires a `mods/am-quota`
  directory for `apply`, `--write-local` and `--install-local`. Preview, commit, start, fence
  and record have no such gate. `set-login` uses the separate check described above
  (`herdr/mods/am-sidebar/accountsApply.js:47-51,74-80`, `CLI:13167,13243,13267-13321,13461-13485`).
- **The plan and The outcome record, retry paragraphs.** The sidebar starts a detached
  `apply --retry` only when its hourly machines cycle starts and both `mods/am-quota/mod.json`
  and the plan exist (`herdr/mods/am-sidebar/main.js:694-708`,
  `herdr/mods/am-sidebar/machineUpdates.js:52,135-154,360-366`). The panel checks for due linked
  work during its 60-second poll and throttles retry starts to five minutes
  (`herdr/mods/am-quota/main.js:38,305,345-356,394-396,561-589`,
  `herdr/mods/am-sidebar/accountsPlanRecord.js:8`).
- **The app and standalone `am`.** The 5c page calls only `accounts-codex`. This endpoint
  reads `auth.json` under `AUTOMAGIK_ACCOUNTS_CODEX_HOME` or the default `~/.codex` and reports
  the proxy as unknown. It reads no key and calls no `am accounts` verb
  (`apps/bots-dsh/src/client/accounts-page.js:18-43`, `apps/bots-dsh/src/host/accounts.js:8-12,32-74`).
  Standalone `am` has the CLI through byte copies. The copy script rejects imports outside
  the sidebar source, including `am-quota` (`am/copies.json:64-74`, `scripts/am-copies.mjs:23-28,47-59`).
- **The plan format.** The version 1 reader rebuilds the record from known fields. An extra
  stop field in version 1 would be lost on a write by that reader
  (`herdr/mods/am-sidebar/accountsPlanRecord.js:3,272-302`).

### 2. One writer per Codex home

**Call the writer.** On a press, `am accounts codex-use` consumes the private preview id and the
chosen credential from the picker. It returns `changed` for a stale id. It is local only and
refuses `--machine`. Hold the destination lock through the write, read-back and active record
update. A plan operation already holding `accounts.lock` calls the internal writer without
taking `accounts.lock` again. The order is `accounts.lock` when needed, then the destination
lock, then `claude-logins.json.lock` if needed. Use the plan lock's stale-owner rule for the
destination lock (`CLI:12904-12950`).

**Bind one destination and controller.** Under Q12 (a), the `0600` binding and destination lock
live under `<passwd home>/.local/state/automagik/accounts/`, a per-user `0700` directory. Every
entry point resolves it through `getpwuid`, regardless of `XDG_STATE_HOME` or `$HOME`. Key both
by the SHA-256 of the verified canonical Codex home. Establish the binding under the destination
lock. It names one controller app home. A writer from another app home returns `other-controller`.
Before creating anything for a destination, verify its path, owner and mode and check that no
parent is foreign-writable. Reject symlinked parents and use no-follow reads of `auth.json`.
For a missing home, verify its parents and bind the intended canonical path before creating
the home at `0700`. Revalidate at installation under the lock. Use the verified path for reads,
backup and rename. Return `changed` if it changed since approval. Bind the approval to the home,
proxy base and generation. Two empty homes can have the same `none` generation.

**Qualify the running panel.** Under Q16 (a), the panel writes `data/am-quota/codex-writer.json`
on load and reload. It records `v: 1`, `version`, `home`, `keySource`, `loadedAt` and the key file's
identity (device, inode, size and mtime). The record never contains a hash of the key. Claude's
`writer.json` keeps its exact three fields. An enabled panel's record must belong to its current
load, proved against a load stamp the CLI can read. A record from an earlier load of the same
version is insufficient (`herdr/mods/am-quota/DESIGN.md:172-180` describes that case).
The writer returns `update-first` while any older panel is installed, enabled or disabled, or the
panel state is unknown. A disabled panel at the required version must be stopped and drained.
An absent panel qualifies once no old writer is still running. Refuse if an older or unknown
writer from any other app home can still reach the destination. Verify reload or drain before
admission, including across enable and rollback. Recheck under the lock just before rename.
From delivery 4, the pack's installer
and updater take the same per-user accounts lock for the destination while replacing or enabling
the `am-quota` folder. This serializes a panel swap with a new switch. A manual rollback with an
older `install.sh` that predates the lock can still overlap a switch.

**Use the binding for every caller.** Under Q12 (a) and Q16 (a), the page read, previews,
Use/Switch, local apply and retries use the same binding. The plugin replaces
`AUTOMAGIK_ACCOUNTS_CODEX_HOME` with it. Every writer, including the page, timer and terminal,
checks the installed panel's real home and key source against the binding. Accept `file`, or
`env` with the panel's confirmation that its value equals the file key. Renew the capability
record when the key file's identity changes, including the equality check for `env`. A stale
identity, mismatch or ambiguous binding returns `binding-differs`. Refuse a chosen-home worker
at mutating dispatch. Today the guard is on `here` and `fleet` (`CLI:13503-13515,13523-13539`).

**Send the key only to the approved proxy.** Under Q12 (a), the binding approves its origin
and path. A changed base in `cliproxy.json` yields `proxy-changed` until a new press. Check
before inventory and download, including the panel's automatic inventory request
(`herdr/mods/am-quota/main.js:358-373`, `herdr/mods/am-quota/proxy.js:215-221,250-261`). Refuse
redirects and read the user's `0600` key file without following symlinks. Keep the existing
gates on legacy staged verbs. Refuse a staged Codex write once the destination has a binding,
including `--install-local` with a payload already staged.

**Verify the write.** Download afresh for a new attempt, run `problems` and compare the approved
generation. Keep one `.bak-<stamp>` per replacement, three in all. Use atomic rename and read
back before updating `active.json`. Managed placement requires the fenced generation, matching
proxy and an account-id fingerprint. Return `no-account-id` when the credential lacks an account
id. Manual Use can use the panel's current fingerprint rule (§1). Use fixed reason codes. Key
and grant canaries must stay out of `argv`, child environments, output, logs, notifications,
shared state, previews and records. Q15 covers running Codex clients. The destination lock
only serializes Automagik writers.

**Give the page a picker.** `am accounts codex-list --json` returns credential names, account-id
fingerprints, eligibility, the bound home and the approved proxy base. It also returns a private
preview id bound to the displayed destination, proxy base, generation and the list shown. It
returns no tokens. The base excludes user info and query data.

### 3. The plan without the pack

**Build a preview from fresh reads.** First, `am accounts plan --request-new` reads the intended
edit on stdin, creates the missing app home (`HERDR_APP_HOME`, else `~/.config/herdr-app`) and
its `automagik-herdr/` at `0700`, creates the private `0600` request and returns its opaque id.
Today fleet does not keep a record without an app home, and preview reads fleet evidence from
disk (`CLI:12653-12657,12752-12757,12819-12829,12888-12890,13461-13470`). The page uses the returned
id in the existing request flow (`herdr/mods/am-quota/main.js:433-455`). The CLI takes a fresh
fleet observation internally and derives eligibility, proxy inventory and identity, the active
record and complete Claude slot evidence bound to the controller home. The caller supplies
only the edit. Show the preview's moves and flags, get approval, then run
`plan --commit <id> --expect-rev <n>`, apply and read back. Fresh Manage keeps Codex unmanaged
until the person explicitly places it.

**Apply here first.** The executor runs approved `local` assignments for both tools. Under
Q17 (a), it runs them before and independently of linked discovery. A failed or unreadable `hc machine ls`
leaves linked membership and assignments alone. Under Q16 (a), the panel is absent or qualified,
and its own `local` driver retires when the executor takes over. Local Claude shares the
`set-login` operation and checks qualification at the mutation even without `--expect-core`.
Local Codex goes through §2. After a lost reply or crash, read first and settle the recorded
attempt before repeating a download or write. Verify Claude's effective slot and account after
a write. Verify the fenced Codex placement and repair `active.json` if the credential landed
but the record did not. Recheck the placement before repair. If the read shows a manual change,
suspend the assignment under Q10. Report success only after matching read-back.

**Stop and resume.** Under Q14 (a), a stop press with `--expect-rev` first passes the version
checks below, then atomically records `<app home>/automagik-herdr/accounts.stop` without waiting
for `accounts.lock`. The executor checks it and the plan before each machine. An operation
already past its check may finish.
The next lock holder folds the marker into the version 2 plan's `stopped` field. Resume takes
the lock and clears the durable stop only after a press. `mods-disabled/am-quota` stops apply
and retry while it exists. An unknown panel state blocks them. A version 1 plan found without
a panel is treated as stopped, including after removal of a disabled panel. A press to resume
that plan migrates it. The page shows the effective state, including stopped, panel off or
running. Manual Use stays available while the plan is stopped, subject to §2.

**Stage the format change.** Ship version 2 readers for the controller's launches, panel and
both CLI entry points in a delivery before any writer emits version 2. Before recording a Stop
or writing version 2, verify that each installed CLI entry point reads v2. Check the pack's
sidebar `VERSION` and standalone `am/VERSION` when installed. The `accounts.lock` owner record
gains `version`. Verify that any lock owner is a compatible executor. An owner record without a
version fails the check. If these checks fail, return `update-first` and write no `accounts.stop`
marker. Keep version 1 until the first stop press, the explicit resume of a version 1 plan treated
as stopped because the panel is absent, or retry handover to the app under Q13 (a). Preserve
outstanding attempts through migration and rollback. Delivery-2 readers classify version 2 as `newer`
even with `stopped: false`. Apply refuses and the panel cannot show or edit the plan. A linked
Claude start that reaches the managed login path gets no login words and can use another account
(`herdr/mods/am-sidebar/accountsPlanRecord.js:3,272-279`,
`herdr/mods/am-quota/plan.js:94-101`, `herdr/mods/am-sidebar/accountsApply.js:47-51`,
`CLI:4709-4714,4948-4953,4996-5004`).

**Retry.** Under Q13 (a), the app host starts `am accounts apply --retry` every five minutes
on a pack-free install while a plan exists and can run. The page says automatic retry pauses
when the app closes. On an existing pack, keep the sidebar's hourly trigger and panel's due
checks, including local-only work. Delivery 5 moves both to the common executor. An explicit
press on the page hands retry over to the app. Under Q14 (a), it writes `retries: "app"` in the
v2 plan, migrating v1 if needed, with the same version checks as Stop. Under Q14 (b), it records
the handover in `<app home>/automagik-herdr/accounts-retries.json`. From delivery 5, both pack
triggers honor the applicable record and stop calling apply for that plan. An older pack can
ignore the separate record under Q14 (b). Require compatible plan writers and retry callers
before handing over. Apply and retry take `accounts.lock` with zero wait. Contention returns `busy`.

### 4. Proposed deliveries

**4. This computer's Codex writer.** Herdr lane with `am`'s generated copies. Under Q12 (a) and
Q16 (a), ship §2 in the sidebar source and delegate the existing panel actions after
qualification. Keep the panel as the local plan driver until delivery 5, with its managed
Codex writes going through the shared writer. The panel gets no new controls or text. The pack
is fix-only under [RFC 0030](0030-code-mode-in-the-app.md#the-pack-after-the-move). Under Q14 (a),
ship compatible plan readers here before delivery 5 can emit version 2. The terminal binding
works for file-backed setups before the plugin update. An environment-only setup needs a
matching private key file or a move to file-backed setup before cutover. Keep the legacy path
available until the replacement is ready. Verify reload or drain before activating the binding
and enabling the replacement. Admit only one writer at a time.

- **Acceptance.** Use temp homes and a fake proxy. Exercise manual Use and managed `local`
  through one writer. Try both upgrade orders and rollback with standalone `am` and the pack
  CLI. Refuse old enabled and disabled panels, stale load stamps, stale key-file identities,
  mismatched bindings, chosen-home workers, changed proxy base before inventory and a staged
  write after binding. Attempt to enable an old panel mid-switch and resume one after rollback.
  The mid-switch case has no overlapping credential or active-record writes. Concurrent callers
  on the same canonical destination serialize. With two app homes, different `XDG_STATE_HOME`
  and `HOME` values and one Codex destination, exactly one controller binds and locks it for
  writing. Exercise stale picker ids, symlink, unsafe parent and changed-home refusals, private
  creation and canaries. Under Q15 (a), cover running-client deferral and exclusive creation,
  and require confirmation for manual Use in the terminal and on the page in the plugin.
- **Rollback.** Keep the last credential, backups, binding and plan. Withdraw the new writer
  and drain its writes before loading a legacy panel. A partial rollback with an older or
  unqualified panel beside a new CLI returns `update-first`.

**5. The plan without the pack.** Herdr lane with `am`'s generated copies
(`scripts/lane.ts:50-55`). Under Q12 (a), Q13 (a), Q14 (a), Q16 (a) and Q17 (a), ship §3's
request producer, executor, retry and stop contracts. Retire the panel's own local driver in the
same cutover that enables the executor's. Keep the shared CLI in the sidebar source until RFC 0030
delivery 8. The Accounts page, controls and app-host timer ship after the CLI in RFC 0030 delivery
5's plugin remainder. Ship the two lanes in separate PRs (`docs/rfcs/0030-code-mode-in-the-app.md:540`).

- **CLI acceptance.** With the temp app-home path absent and no panel or sidebar, start with
  `plan --request-new`, commit a CLI-derived preview, resume if needed, and apply both local
  tools and a fake linked Claude assignment.
  Retry a failure to verified success. Test failed discovery with linked assignments untouched. Cover a lost
  reply, a crash after rename, a failed active-record write, a missing account id and manual
  drift between attempts. Test stop during apply, panel disable and removal, old panel refusal,
  version 1 migration with an outstanding attempt and a delivery-2 linked start with a version
  2 plan. With an old retry already running, Stop returns `update-first` and writes no marker
  until the retry ends and both installed CLI versions qualify. Close the desktop with local-only
  work pending on both a pack-free install and an installed pack. Check retry before and after
  the installed pack's handover, including its migration to version 2 under Q14 (a).
- **RFC 0030 Q19 page check.** From a marked desktop window with standalone `am` and no panel
  or sidebar, show the per-machine view and preview, press approval, then apply the plan from
  the page. If the new plan is version 1, first press Resume as in §3. Fail a fake linked Claude
  target once and check automatic retry and verified read-back. Refuse an unmarked window. Run
  this check in addition to the CLI fixture.
- **Rollback.** Stop the app timer before handing retry back to an installed pack. Preserve the
  plan, outstanding attempts and each machine's last account. Preserve an outstanding
  `accounts.stop` marker. While the plan is stopped, rollback to readers older than v2 is
  unsupported. Resume first before considering that rollback. A plan still at version 1 stays
  readable by delivery 2. Stop, explicit Resume of a v1 plan treated as stopped, and retry
  handover under Q14 (a) can all migrate the plan to v2. After version 2 is written, roll back
  execution only to a release with compatible readers. Reverting to delivery 2 then loses plan
  viewing, editing and the managed linked Claude launch behavior described in §3.

### What each answer changes above

Under the recommended answers, the following rules replace the affected Contracts introduced rows.

| Contract | Rule for existing installs |
|---|---|
| Codex binding and lock, Q12 (a) | Bind one verified home and controller before use. |
| `accounts-plan.json` and `accounts.stop`, Q14 (a) | Keep v1 until §3's transition. Preserve the stop. |
| Linked Claude launches, Q14 (a) | Deploy v2 readers first. Delivery 2 loses managed login words on v2. |
| `accounts.lock`, Q14 (a) | Commits and runs take it. The owner record gains `version`. See §3 for Stop. |
| Panel and CLI, Q16 (a) | Qualify the running panel before delegation. Keep Claude's record format. |

- **Q12.** Replace the local path's dependence on Herdr's environment in The plan. Add the
  binding, destination lock and Codex verbs to Contracts introduced. Extend the management
  key rule in Threat model to local Codex under §2's approved proxy.
- **Q13.** Replace the retry paragraphs in The plan and The outcome record with the chosen
  trigger and handover. Contracts introduced and Undo say who can retry after app exit.
- **Q14.** Replace the plan version and writer rows in Contracts introduced under (a). Replace
  the rule below that table that requires an enabled panel for all apply. Undo becomes a durable
  stop that preserves accounts and files. A later panel change cannot clear the stop.
- **Q15.** Add the local refresh rule to The plan and Threat model. Undo keeps the last local
  credential and backups. Restoring a local backup uses the same destination and refresh checks.
- **Q16.** Replace the panel's local write and apply paths in The plan and Contracts introduced
  at the chosen cutover. Undo specifies the order for rolling back the panel and CLI.
- **Q17.** Under (a), The plan's “changes nothing” on failed discovery continues to cover linked
  membership and assignments. An approved, independently verified `local` assignment can run.
  Under (b), the discovery guard also stops `local`.

### Questions for the owner

**Q12. Which record binds the Codex home, proxy base, key source and controller?**

- **(a) Recommended.** Keep `codex-binding.json` and the lock in the private per-user state
  directory, keyed by the verified destination as in §2. Bind one controller and support
  user-owned homes with safe parents. Set the binding by a press in page setup or through
  `am accounts codex-bind` in a terminal. Keep the key in `~/.config/cliproxyapi/mgmt.key`.
  Without a binding, the new writer returns `not-bound`. Page setup offers `~/.codex` and the
  configured proxy base.
- **(b)** Keep the destination lock and resolve `CODEX_HOME` from the writer's environment with
  `~/.codex` as the default and the key from the file. Agreement by convention leaves parity
  and proxy approval unproved. Q23's single-writer rule blocks every new writer, including the
  page, terminal and timer, until home and key parity and proxy approval are proved.
- **(c)** Let the app hold the key in a private store. This needs a design for the same binding
  and writer checks in the panel, terminal and timer, plus migration for file and environment
  setups.

**Q13. Who retries, and does retry continue when the app closes?**

- **(a) Recommended.** Use the app host's five-minute timer on a pack-free install. Keep the
  installed pack's hourly and due triggers until an explicit handover to the app. Under Q14 (a),
  handover records `retries: "app"` in the v2 plan and migrates v1 after §3's version checks.
  Under Q14 (b), both pack triggers honor `accounts-retries.json` from delivery 5 as in §3.
  Pack-free and handed-over plans get no new automatic runs while the app is closed.
- **(b)** Have `am` install a user timer that runs while the app is closed. Include install,
  update and removal on a fresh install and handover from any existing pack triggers.
- **(c)** Use a person-owned scheduler automation. Q19's fresh-install check then needs a
  provisioning step for that automation.

**Q14. What does stopping the plan do?**

- **(a) Recommended.** Use §3's durable stop through `plan --stop|--resume --expect-rev <n>`.
  It survives installing, enabling or removing the panel and stops at the next per-machine
  check. A manual Use press stays available. Ship compatible readers first. Check both installed
  CLI versions and the lock owner before Stop and before any v2 write, including Q13 (a)'s retry
  handover, which also migrates v1 to v2. A delivery-2 panel loses plan viewing and editing for
  version 2, and a linked Claude start on that reader can proceed with no managed login words.
- **(b)** Keep switching the panel off as the only stop. On a pack-free install, stopping
  means deleting the plan, including its approvals and pending attempts. Keep the plan at v1.
  Record Q13 (a)'s handover in `<app home>/automagik-herdr/accounts-retries.json`. Both pack
  triggers honor it from delivery 5. An older pack can ignore it.

**Q15. May a write replace an existing local credential while Codex is running?**

- **(a) Recommended.** Check just before a managed replacement. If a Codex process of this user
  is running, defer and retry later. For manual Use while Codex runs, terminal
  `am accounts codex-use` refuses unless `--confirm-running` is given. The page asks for the same
  confirmation. The panel keeps its single press under Q16 (a). Create a missing file exclusively.
  A refresh can still land between the last check and rename if a client starts in that interval
  or the person confirms a manual replacement while one runs.
- **(b)** Keep today's replacement policy (§1). A client refresh can overwrite the switch or
  be lost to it.

**Q16. How do installed panels move to the shared writer?**

- **(a) Recommended.** Qualify the replacement, then delegate the existing Use/Switch and
  managed `local` actions. Retire the panel's local driver when delivery 5 enables the
  executor's. This is a breakage fix for the race the panel design accepts today
  (`herdr/mods/am-quota/DESIGN.md:256-262`).
- **(b) A migration hold.** The panel keeps its installer. Every new writer, including the page,
  terminal and timer, stays refused until cutover. The hold ends only when (a)'s conditions
  hold, including §2's proof of home and key parity and refusal of any older installed panel,
  enabled or disabled. Q23's single-writer rule holds throughout.

**Q17. May an approved local assignment run when linked discovery fails?**

- **(a) Recommended.** Apply an independently verified `local` assignment first. Keep linked
  membership, assignments and pending work as they were on failed discovery.
- **(b)** Require successful linked discovery before running `local` too. A discovery failure
  then leaves both local and linked assignments pending.

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
