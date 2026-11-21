# RFC 0044: Sandboxed Bots: the rest of the hc boundary, and what herdr-core must add

| Field | Value |
|---|---|
| Status | Proposed |
| Milestone | none (ships outside the five milestones) |
| Lanes | none for this RFC (docs only). Deliveries: herdr (3.N.P), with am's byte copies when a shared file changes; `apps/dsh-sandbox/` ships only through its byte-equal copy in the pack, never alone (`scripts/lane.ts:148-151`); herdr-core for the upstream request; owner steps for enablement |
| Created | 2026-11-20 |

## Summary

#631 (mask the core socket and `~/.ssh` in sandboxed panes, behind a per-pane filtering hc proxy)
and #628 (scope `hc send`, `keys` and `attach` from a sandboxed Bot to its own team) have their
Linux first cut merged, with every switch off. This RFC defines what is left:

1. **Before any opt-in (this repository):** the proxy speaks the core that serves the pane; a
   sandboxed pane can no longer `send --force` into a blocked terminal; the owner approves the exact
   roster bytes after seeing all of them; the local mask residuals the owner chooses are closed.
2. **Enablement (the owner):** one canary Bot the owner names, by the existing runbook; expansion is
   a separate decision after checks, never after elapsed time.
3. **The herdr-core request**, in RFC 0023's form, refining herdrdev/herdr-core#171: a caller bound
   to its own endpoint, a sandbox mark, a default-deny per-method grant set only by a trusted host,
   a restricted host credential (RFC 0028), checks serialized with every write to the terminal, and
   routed enforcement negotiated by the sending core.
4. **What we adopt when each upstream piece lands:** team-scoped `keys`, team Bots on linked
   machines, identity from the bound endpoint. `attach` stays refused for sandboxed panes (Q5).
5. **macOS** as a feasibility study on DSH's Seatbelt backend; **Windows** only through the Linux
   mask inside RFC 0016's WSL container, once proven there.

Until enablement, the risk the owner accepted on #624 stays as it is.

## Motivation

`hc send`, `keys` and `attach` type into any terminal the caller can address, and herdr-core
trusts the caller a client names. A sandboxed Bot that cannot `hc exec` could still type a command
line into a plain shell pane, here or on a linked machine (#628, split from #624). #631's boundary
hides the real core socket from the sandboxed pane and puts a per-pane proxy at its path.

### What is merged (on `dev`, every switch off)

| Part | PRs |
|---|---|
| Deny-by-default hc guard and send roles (a guardrail, not a boundary) | #636, #645, #719, #766 |
| Mask: core and holder sockets, `~/.ssh`, `SSH_AUTH_SOCK`, fixed Docker / Podman (rootless per-uid included) / CRI-O / K3s / containerd / BuildKit sockets, absolute `unix://` `DOCKER_HOST` / `CONTAINER_HOST`; mounted at the canonical runtime folder | #642, #1750 |
| The pane's own network namespace and egress relay (host loopback and LAN out of reach; #743 closed) | #1730 |
| Per-pane proxy: caller rewritten to the pane's terminal, default-deny method table, fail closed | #698, #706 |
| Team scope: reads team-scoped, `rm` own workers only, `put` refused, the proxy's `terminal.list` filtered and machine rows and inventory hidden | #1656 |
| Rollout controls: per-Bot `hcProxy` from the approved roster snapshot, approved workers through the proxy, doctor rows; #747's three lows fixed (off-but-proxy-up warning, malformed-roster row, linked target platform check) and #778's items (#781) | #747, #750, #771, #781 |
| Guard identity from the pane's launch record, not `HERDR_APP_HOME` | #1752 |
| Guard forwards the address it checked | #1766 |

The guard's own `ls` and plain `events` stay cross-pane (`hcGuard.mjs:49-51`): the guard is not a
boundary, and the proxy is where a sandboxed pane's list is filtered and its subscription refused.
This RFC does not change that.

### What is left

Read on `dev` e7de3fde1; herdr-core read at the `v0.1.21` tag (`1b0393f`) and at master
`c7517808` (2026-11-17, still 0.1.21 in `Cargo.toml`); nothing run.

- **The proxy speaks one core version.** `HC_PIN = "0.1.14"` (`herdr/mods/am-sidebar/hcProxy.mjs:45`)
  is checked against `server.status` at start (`hcProxy.mjs:810-814`), with one closed parameter
  table (`hcProxy.mjs:86-100`) and a separate worker-shape check. The 0.1.21 schema adds optional
  `terminal.run` parameters (`size`, `display`), and its CLI sends `wait --children` as `any` or
  `all`, while the proxy handles only `children: true` (`hcProxy.mjs:1175-1179`). The core binary
  installed on the computer this RFC was written on contains the text `0.1.21`: a hint, not proof
  of which core serves a pane. Only the core's own `server.status` answer is.
- **`send --force` reaches a blocked terminal.** The proxy forwards `force`
  (`hcProxy.mjs:93`), and the core's send skips its `blocked` refusal when `force` is set
  (`input.rs`, the send prepare step). A blocked terminal is one waiting at a dialog, an
  approval prompt included, so a sandboxed Bot can answer a teammate's approval, an unsandboxed
  approved worker's among them.
- **Approval writes before the person decides.** `am proxy approve --project <dir>` reads the
  roster, prints a summary and writes the record in the same run (`approved.js:290-295`). The
  summary names bots added or removed and rank, lead, kind and `hcProxy` changes
  (`approved.js:232-259`); it does not show a new Bot's settings, worker template, agent, model,
  effort or `agyMode` changes, or cross-project relations.
- **Four local mask residuals** recorded on #631 (`apps/dsh-sandbox/README.md`): rootless
  containerd and BuildKit per-uid sockets are not masked; `tcp://` and `ssh://` container hosts are
  not masked (the namespace covers host loopback and LAN, the relay carries public destinations); a
  socket created after the pane starts in a visible host folder is visible; bwrap's own error lines
  carry no `hc-socket-mask:` prefix.
- **`keys` cannot be scoped before the call.** `terminal.send` and `terminal.keys` go through
  `type_in` (`crates/herdr-core/src/input.rs:316` on): a quiet wait (`HC_QUIET_MS`, 3000 ms by
  default, `input.rs:267-268`); a prepare step under the state lock that checks liveness and the
  program (`input.rs:345-362`); then, with the lock released, the writes and their pauses (a send is
  a paste, a pause, then Enter). Send's prepare also checks `blocked` and `if`; keys has no
  condition (`api.rs:557-564`, `input.rs:516-530`). A check made before the call can be stale when
  input is written, so `keys` is refused whole (`hcGuard.mjs:46-48`, `69-71`; the proxy's default
  deny).
- **`attach`** needs framed mode; the core only refuses attaching to oneself. The proxy refuses
  `hello`, so framed mode never opens (`hcProxy.mjs:786-791`).
- **Identity is a string.** The CLI sends `HC_TERMINAL_ID` when it is set and
  `HC_TERMINAL_SOCKET` is unset or equals the socket it selected, else `ppid:<pid>` (`cli.rs:657`,
  `client.rs:286-292`); the server reads no peer credential (`server.rs:95-96`). `docs/security.md`
  says the core "is not a sandbox or a permission broker" and has no per-client permission check;
  other programs on the account are inside its trust boundary. The proxy fixes identity only for
  its own pane.
- **Linked machines.** A routed call carries the caller as `<core id>/<caller>`
  (`remote.rs:877-878`); nothing about its sandbox or reach travels. The proxy refuses every machine
  address (`hcProxy.mjs:1183-1187`, `1210-1214`), and a linked start of an opted-in dsh-tui Bot on a
  Linux target is refused (`herdr/mods/am-sidebar/bin/automagik-herdr.mjs:3149-3166`; other agents
  and non-Linux targets return early). A remote mark would not hide the remote computer's holder
  sockets or SSH keys: that needs the remote mask.
- **Other platforms.** The effective gate is Linux-only (`approved.js:189-190`, called from
  `bin/automagik-herdr.mjs:3105`): on macOS an approved-on Bot starts plain, as `hcProxy.md`
  documents ("Non-Linux ignores the switch"). The namespace is Linux-only
  (`apps/dsh-sandbox/bin/hc-socket-mask.mjs:122-126`). DSH 0.2.2's `runnerCommand` replaces its
  built-in backend selection and receives bwrap-compatible arguments, and its built-in Seatbelt
  backend mainly restricts writes (`@deepseek-ai/dsh-sandbox-local` README).

## Design

### A. Before any opt-in (this repository)

**A1. The proxy speaks the core that serves the pane.** `HC_PIN` becomes a closed set of supported
versions, starting with 0.1.14 and 0.1.21. A version joins only with fixtures from that release's
tag: the schema and captured CLI requests for every upstream method the pack forwards, including a
targetless `wait --children any` and `all`; pack-local methods (`proxy.workerTransport`) keep their
own fixtures. With them: the helper start and an approved-worker start succeed; caller and parent
binding hold; the list filter keeps only fields it has reviewed (today it spreads the others); a
malformed reply is an `hc-proxy:` error; a parameter outside the reviewed set (`size`, `display`
until reviewed) is refused. The startup probe closes its connection and later calls open new ones
at the same path, while the core can be replaced in place (its README's update behaviour), so the
proxy checks the serving version on every new upstream connection it uses for a lookup or a
forward, and a changed or unsupported answer fails that call and ends the pane. It answers the
version last verified on a pack-local status method; doctor shows it, or "unavailable" when the
proxy is down. The literal pin
tests (`herdr/test/hc-proxy.test.mjs:1069`, `1090`) and the helper start tests move to the set. The
WSLC image's 0.1.18 pin stays a separate decision.

**A2. No `force` from a sandboxed pane.** The 0.1.21 CLI sends `force: false` on every ordinary
send, so the proxy accepts `force` omitted or `false` and refuses `true` and any other value. No
pack flow from a Bot pane sends with `force`; the deliberate `force: true` callers are the host-side
Chat and Pocket question handlers (`apps/bots-dsh/src/host/live-chat/question.js:151`,
`herdr/mods/pocket-link/chat/question.js:151`), which do not go through a pane's proxy. The core's
`blocked` check then holds for every proxied send at its prepare step; a terminal that becomes
blocked after prepare and before the delayed Enter still gets it (R4 closes that). It is not an
access boundary (`docs/security.md`), and a dialog the agent does not report as blocked still
receives the text (RFC 0042's territory), but a Bot no longer answers a teammate's approval by
choice.

**A3. The person approves exact bytes.** `am proxy approve --project <dir>` prints the whole
candidate against the previous approval (every new Bot's settings, worker template, agent, model,
effort and `agyMode`, cross-project relations) with its digest and writes nothing; a second run with
`--confirm <digest>` writes only if the roster still has those bytes. Tests: a roster changed
between the two runs is refused; a run without `--confirm` writes nothing. This changes what a bare
`approve` does (today it writes, and its JSON reports `approvedAt` and `approvedBy`), so the same
delivery gives preview and commit distinct text and JSON results, exposes the digest, reports
approval metadata only for a committed record, and updates the CLI help, doctor's repair hints and
the runbook (rollout and rollback).

**A4. Local residuals.** The owner chooses (Q2) which of the four residuals are fixed before the
canary, after naming the canary's computer and the privileged socket folders and container
services present on it.

### B. Enablement (the owner)

The runbook in `herdr/mods/am-sidebar/hcProxy.md` ("Rollout and rollback") stays the procedure, with
A3's two-step approval: `am dsh-tui update` and `am dsh-tui doctor`; `am edit <bot> --hc-proxy on`;
`am proxy approve --project <dir>`, review, then the same with `--confirm <digest>`; `am restart
<bot>`, and a restart of every approved pane that must start workers again (a re-approval refuses
their worker starts until then); rollback is the reverse, plus relaunching workers that need it. The
invalid-approval, working-off plain start stays as documented. No agent opts a Bot in. One canary
first (Q3); expansion is a separate owner decision once the canary did normal work, passed
delivery 3's checks and rehearsed a rollback.

### C. `keys` and `attach`

- **`keys`** stays refused until the core checks the grant with every write (R4) and advertises it.
  Then the guard and the proxy allow it together, to the same set as `send`.
- **`attach`** stays refused for sandboxed panes, also after upstream: a Bot reads with `read` and
  types with `send` or `keys`, and a live keyboard stays open past every later check. This changes
  #628's asked outcome, so it is an owner question (Q5).

### D. Linked machines

Opted-in linked starts and machine addresses stay refused until both cores negotiate routed
enforcement (R5) on top of R1-R4. Then the guard and the proxy allow machine addresses together,
with reads kept to the read grant. A **remote launch** of an opted-in Bot also needs the remote
computer's own approval record, helper, profile row and mask verified: a mark cannot hide a remote
holder socket or SSH credential.

### E. Identity and the bound endpoint

With R1 and R6, the pack starts a sandboxed pane's terminal with a bound endpoint. The helper,
outside the sandbox, receives the endpoint's path and passes it to its proxy, which forwards every
pane call through it, so the core binds the caller. The helper keeps the shared socket for trusted
work only: feature negotiation, the version check and its own target lookups, which must not be
narrowed by the pane's grant. The sandboxed child sees only the proxy socket, at the path its
`HC_SOCKET` names; the guard reads its identity from the proxy, which relays the core's answer on the
bound endpoint. Each forwarded call is bound to the verified terminal's lifetime and to the serving
core instance (a value that changes when the core process restarts; `core.id` does not); a changed
instance ends the pane. A pane that is not confined to its endpoint keeps today's guard-only
caveat.

### F. macOS and Windows

- **macOS: feasibility first.** A Seatbelt mask must deny the core's runtime folder except the
  pane's proxy socket and the egress relay, sibling sockets, `~/.ssh`, the agent and container
  sockets, writes to the protected data root, and host loopback and LAN except the relay, and fail
  the start when any rule cannot apply. Because `runnerCommand` replaces DSH's backend and speaks
  bwrap's arguments, the study starts by finding whether DSH can take extra Seatbelt rules; if not,
  that is a DSH request in RFC 0023's form. Until a mask exists, doctor warns for an approved-on Bot
  on macOS, which starts plain.
- **Windows.** No native mode (RFC 0016, D38). The switch is allowed in the WSL container only when
  delivery 3's checks pass there: an unprivileged guest, a supported guest core, working bwrap mount
  and network namespaces. Landlock or the outer VM is not this mask.

## The herdr-core request (RFC 0023 form)

A proposal to herdr-core's maintainers, posted only with the owner's OK (Q6), as a comment on
herdrdev/herdr-core#171 (no reply yet). It keeps #171's stance: the core is not a sandbox, and
hiding its socket stays the sandbox layer's work. Names are suggestions.

**R1. A caller bound to its endpoint.** A trusted (unmarked) caller starts a terminal with a bound
endpoint: the core makes a socket for that terminal and gives its path to the child; every call on
it is that terminal's, whatever `params.caller` says. The endpoint is retired when the terminal
ends. A marked terminal's allowed `terminal.run` (the approved worker start) gets a fresh endpoint
for the child, never the parent's; the child starts with no grant, and its own helper, outside the
sandbox, installs the worker's narrower grant as a trusted caller before the sandboxed program can
call; if binding or installing fails, the start fails. This identifies the terminal only when the
sandbox confines the pane to its own endpoint (the
shared socket, holders and sibling endpoints hidden): same-account processes outside a sandbox stay
inside the trust boundary, as `docs/security.md` says. Peer credentials are weaker here (a process
can leave its session; on macOS a reparented process loses its tree).

**R2. A sandbox mark** (#171 item 1): set only by a trusted caller at `terminal.run`, not a label,
never changed afterwards, inherited by every terminal a marked terminal starts.

**R3. A default-deny grant per method.** A marked caller may call only the methods its grant lists,
each with parameter limits and a target set (explicit terminal ids, the caller's descendants, or
matches on labels only a trusted caller can write); an absent grant grants nothing. `file.read`, the
chunked put methods and `events.subscribe` follow the same rule (#171 left `file.read` open; this
request does not). Subscriptions are filtered to the grant. Only a trusted caller sets or replaces a
grant.

**R3b. A restricted host credential** (for RFC 0028): a credential the trusted host issues to one
process, revocable, carrying its own grant (0028's: forced `automagik.bot=<botId>` on creation,
parent and machine constrained, scoped `interrupt` and `events`, no `force`, no Chat or person's
seat) and no authority to set grants or mint credentials.

**R4. Checks serialized with every write.** For a marked caller or a restricted credential, `send`
and `keys` are checked against the current grant immediately before each write to the terminal,
under the lock a grant replacement also takes. A grant removed mid-call stops the writes not yet
made: a send whose paste was written gets no Enter, a key sequence stops, and the call reports what
was written. `keys` gains `if`. A marked caller may not use `force` and never types into a `blocked`
terminal. Answering an approval is a person's act, or a restricted host's owner-authorized answer
that carries the terminal's lifetime and the prompt revision it observed (`state`, `turn`,
`status_ms`, as herdr-core#122 asks) and is compared atomically at the first write: if prompt B
replaced prompt A, zero bytes are written. Never a standing grant on a terminal.

**R5. Routed enforcement, negotiated by the sender.** A call from a marked caller goes to a linked
core only when that peer negotiated a versioned routed-enforcement feature on the current link;
otherwise the sending core refuses it. The receiver validates the issuing core, the target, the
operation and the current grant at delivery, and R4 applies there. The link renegotiates after a
reconnect. The existing limits on what a machine may reach (`remote.rs`, `afar`) stay.

**R6. Discovery a trusted client can use** (#171 item 5). A minimal identity answer on the bound
endpoint (terminal, core instance), allowed for marked callers; versioned feature negotiation
(`bound_caller`, `sandbox`, `grant`, `host_credential`, `checked_input` for R4, `routed_enforcement`)
on a trusted connection, bound to the core instance. A client repeats it, or refuses service, when
the instance changes. Wire compatibility stays a separate check (A1).

**Compatibility.** Every field defaults to unmarked, unbound and ungranted: existing clients and
terminals behave as today.

**What we remove when each lands.** R1 and R6: identity from the endpoint (the proxy's caller rewrite
stays as a check). R3, R4 and `checked_input`: the `keys` refusal; the proxy's copy of the team graph
only after positive and negative parity tests against the core's grants (the proxy keeps relaying,
fail closed). R5: the machine-address refusal for sends and reads; the remote-launch gate stays (D).

**The pack's side of R3.** The pack computes each sandboxed pane's grant per operation: reads to the
team graph, sends to the team graph plus the shared send rules, kill and rm to own workers, the
owner-question label on itself and labels on own workers, the filtered list, the worker start shape.
A grant records every approval it was computed from (the caller's project and each project a
cross-project lead or member edge comes from: path, digest and approval stamp) and is bound to the
core instance and the terminal's lifetime. `am proxy approve --confirm`, run by the person outside
any sandbox, is the one coordinator: after writing the record it replaces every affected grant on
the local core and on each linked core holding one, and the new approval governs those grants only
once each replacement succeeded. Until then the old grant is withdrawn, not kept: input not yet
written is refused under R4. Confirm names each enforcing core it could not reach; a disconnected
peer must renegotiate and take the current grant before delivery resumes (R5). A grant the pack
cannot recompute (restart, partial update, relink) is refused, never kept. A recomputed grant never re-enables worker starts: a re-approval
still refuses them until the pane restarts, even for identical bytes under a new stamp. Parity
tests before the pack's graph is removed: a removed member, a demoted captain, a worker that
outlives its lead pane, a revoked cross-project edge with input already queued and a peer
disconnected, identical bytes re-approved.

**RFC 0028's grant** (its delivery 0) is R3b with R1-R4's machinery. Its acceptance cases stay
0028's, as does its need for conditional keys for owner approvals. If upstream offers only
terminal-bound endpoints, 0028's delivery 0 stays open. This RFC does not discharge RFC 0022's
delivery H (its own credential, masks and shown-project scope).

**Questions for herdr-core's maintainers.**
1. A socket per terminal, or another binding for R1?
2. Grants as a field of the terminal, or a separate object the trusted host manages?
3. May `keys` share `send`'s checks, with the check repeated before each write, and gain `if`?
4. What does the machine link authenticate today, and what would R5's negotiation need?
5. (Only if the owner chooses Q6 (b).) Would you take a PR from us for R1, R2 and R6 first?

## Contracts introduced

None now. A1 adds a pack-local proxy method (not a public contract). A3 changes `am proxy approve`:
a bare run becomes a preview that writes nothing, and `--confirm <digest>` commits. A script that
relied on a bare run writing the record now gets a preview result with no `approvedAt`, so the
delivery documents the migration in the CLI help, the runbook and its release note. Labels only a trusted caller may write, if herdr-core
chooses that form for R3, become an Automagik contract in the delivery that writes them.

## Threat model

- **Who:** a sandboxed dsh-tui Bot or worker that bypasses its instructions, on the core's account.
- **Today (switch off):** it reaches the core socket and through it any terminal and linked machine.
  The owner accepted this on #624.
- **After enablement (Linux):** the real sockets and `~/.ssh` are hidden; its hc path is its proxy:
  team scope, no exec, keys, attach, machine or `force`. Residuals: those of A4 the owner accepts; a
  team terminal at a dialog it does not report as blocked still receives a send; an approved
  unsandboxed worker runs what the pane wrote in its worktree (`hcProxy.md`, "Known trust
  boundary"); a Bot can ask a teammate to run `am proxy approve`, and the person reviews the bytes.
- **After upstream:** identity, mark and grant are the core's, checked before each write and across
  machines that negotiated it.
- **Undo:** the runbook's rollback per Bot; reverting A1 makes the proxy refuse other versions
  again; every upstream field is opt-in.

## Deliveries

1. **The proxy speaks the served core, without `force`** (herdr; A1, A2). *Check:* tag-derived
   0.1.14 and 0.1.21 fixtures pass the helper start, an approved-worker start, targetless child waits,
   binding, list redaction and malformed replies; an ordinary team send through each tagged CLI
   (`force: false`) is delivered, while `force: true`, an unreviewed parameter and an unsupported
   version are refused; a supported fake core replaced by an unsupported one at the same path fails
   the next call and doctor stops reporting the proxy healthy; doctor shows the verified version or
   "unavailable". *Rollback:* other versions refused again and `force` forwarded again.
2. **Exact-bytes approval and the chosen residuals** (herdr; A3, and A4 as Q2 decides). *Check:* the
   two-step approval tests above; for each residual Q2 says to fix, a fixture proves it (masked
   rootless containerd and BuildKit sockets, a prefixed bwrap failure line). *Rollback:* the previous
   command and mask.
3. **The canary** (owner step). The canary's worker configuration is the dsh-tui helper with no
   chosen worker home, so a helper worker runs masked. *Check:* `am dsh-tui doctor --project <dir>`
   shows it approved on with the verified version; then, through a normal DSH tool call in the
   canary and in one of its helper workers: the core runtime folder holds only the pane's own socket
   and the egress relay; the real core, holder and sibling sockets cannot be reached; the host's
   `~/.ssh` contents cannot be read (an empty mount is expected); `hc exec` is refused with
   `hc guard:` and the real hc by absolute path with `hc-proxy:`; `hc ls` matches its documented list
   grant (its team plus the shared-role recipients); a send to a pane outside that grant is refused.
   A rollback is rehearsed. *Rollback:* the runbook's.
4. **The upstream request** (herdr-core; Q6). *Check:* the outcome Q6 chose: a comment on #171 for
   (a) or (b), a new issue for (d), the draft kept in this RFC for (c).
5. **Identity from the endpoint** (herdr; after R1, R6). *Check:* a confined pane whose
   `HC_TERMINAL_ID` names another terminal is attributed to its own; its sibling endpoints are
   unreachable; the endpoint is gone after the pane ends; a core replaced at the same path ends the
   pane; an opted-in Bot starts a dsh-tui helper worker that identifies as itself (not its parent),
   reports to its lead and cannot start a worker of its own.
6. **`keys` team-scoped** (herdr, guard and proxy together; after R1-R4 and `checked_input`).
   *Check, through the ordinary `hc` command:* keys to a team member are typed; keys to a shared-role
   recipient follow the send set while reads keep the read set; a grant removed after prepare, or
   between two writes, stops the rest; `force` and a blocked target are refused; a core with grants
   but without `checked_input` keeps `keys` refused.
7. **Team Bots on linked machines** (herdr, guard and proxy together; after R1-R6 on both cores).
   *Check, through `hc`:* a send to a team Bot on a linked machine is delivered, another pane there is
   refused by the receiver, a peer without the feature is refused by the sender, a linked read stays
   in the read set; a remote launch fails separately for a missing remote approval, helper, profile
   row or mask.
8. **macOS** (herdr with `apps/dsh-sandbox/`; on a Mac, if Q7 says so). *Check:* F's list, and a start
   that fails when any rule cannot apply. *Rollback:* plain start with the doctor warning.
9. **Windows** (herdr; in the WSL container after RFC 0016 ships it). *Check:* delivery 3's checks in
   the guest, or the switch refused there with the reason recorded.

Order: 1 and 2, then 3; 4 any time; 5-7 follow upstream; 8 and 9 need the hardware.

## Open questions (recommended answer first)

1. **Enable on Linux before upstream?** (a) Yes: after deliveries 1 and 2, one canary by the runbook.
   (b) Wait for herdr-core. (c) Keep it off and keep the accepted risk.
2. **Local residuals before the canary** (answered after the canary's computer is named and its
   privileged socket folders and container services are listed). (a) Fix rootless containerd and
   BuildKit and the bwrap prefix; accept `tcp://`/`ssh://` container hosts only if that computer
   has none reachable through the relay, and late sockets only if no privileged socket folder is
   visible in the pane. (b) Fix all four first. (c) Accept all four.
3. **The canary.** (a) The owner names a member Bot (not a captain, not the main Bot) whose workers
   are the dsh-tui helper with no chosen worker home, so no approved unsandboxed worker runs what it
   writes; expansion is a separate decision after its checks. (b) A Bot with an approved template or
   agent worker, accepting that boundary as its own recorded decision, plus a separate dsh-tui-helper
   canary for delivery 3's worker checks. (c) Every Bot at once.
4. **Default for new Bots.** (a) Stay a per-Bot opt-in. (b) On by default once the owner decides
   expansion.
5. **`attach`** (a change to #628's asked outcome). (a) Refused for sandboxed panes for good.
   (b) Team-scoped once the core checks it. (c) A read-only view.
6. **The upstream request.** (a) Post this request as a comment on #171, without offering a PR.
   (b) Post it and offer a PR for R1, R2 and R6. (c) Hold the draft. (d) A new issue.
7. **macOS.** (a) A feasibility study on a Mac after the Linux canary, ending in a go or a DSH
   request. (b) Only when a Mac runs a sandboxed Bot. (c) Never; Mac Bots stay unmasked.
8. **RFC 0028's grant.** (a) In the same request, as R3b. (b) A separate request.

Linked machines before upstream are not a question: an opted-in linked start stays refused, and the
runbook's answer stays to start that Bot on its own computer (`hcProxy.md`, "Rollout and rollback").

## Links

- Issues: #628, #631, #624 (closed), #743 (closed), #778; herdrdev/herdr-core#171 (and #335, #323).
- RFCs: [0016](0016-windows-wslc.md), [0022](0022-desktop-chat-view.md) ((k), delivery H),
  [0023](0023-dsh-upstream-agent-context-and-chat-rows.md) (the form),
  [0028](0028-code-workers.md) (the grant, delivery 0), [0042](0042-antigravity-blocked-prompts.md)
  (dialogs not reported as blocked).
- Code: `herdr/mods/am-sidebar/hcProxy.md`, `hcProxy.mjs`, `hcGuard.mjs`, `hcPane.mjs`, `approved.js`,
  `apps/dsh-sandbox/`.
