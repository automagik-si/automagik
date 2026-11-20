# RFC 0038: Cloud multiuser safeguard: the caller principal, and no Bot can forge it

| Field | Value |
|---|---|
| Status | In delivery (approved by the owner's delegate on 2026-11-20, with the amendment below: the gate reroutes `/api`; Q1 answered as amended, Q2-Q8 with this RFC's recommendations; delivery 5 specified by the amendment of the same day, approved by the owner's delegate on 2026-11-20 with its Q1-Q4 recommendations; merged: delivery 1, #1892; the amendment's 5b-5d open; narrowed the same day by the owner's delegate: member and guest prompting moves to 5e) |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P); the gate and the server image |
| Created | 2026-11-20 |

> Refs #1372, #1373, #1374, #1389, #1426. Builds on [RFC 0024](0024-automagik-cloud.md) (b), (c), (f),
> Decided 21 and Decided 26. Amends nothing.

> Approved by the owner's delegate on 2026-11-20 (Guga's delegation while the owner is away), with
> the amendment "The gate reroutes `/api`" below; the owner may amend on return. The amendment
> "Delivery 5 specified" (#1373) was approved by the owner's delegate the same day, with every
> recommended option.

## Summary

Inside one Automagik Cloud workspace, the gate identifies each person, DSH and its plugins learn
which member or guest made each call from a principal the gate authenticates and signs, and no
Bot will act as that person or as the owner. Owners and admins keep DSH's owner interface. A Bot
gets its own principal, `bot:<id>`, with its own scope and no owner rights; the owner's own
interface stays `owner`. The read fence #1389 delivered for members is kept as the
file rule for members and extended to the new Bot scope. The member's shell keeps its member OS
identity as the runner's contract (delivery 4).

The RFC decides three things: where the principal is made and how it reaches the Automagik
adapter inside DSH; what replaces a Bot's inherited `owner`; and how each piece fails closed when
the principal is absent. The stable instance id is RFC 0024's, and #1426's per-vendor reservation
record is named and left to its own RFC.

## Motivation

Today one workspace is one hosted DSH with one owner identity. The gate signs people in and knows
their roles; DSH does not. `server/gate-cloud.mjs:173-178` admits only `owner` and `admin`
(`:42-45`), so the missing principal is hidden behind owner-only admission. The gate forwards
`x-automagik-principal` on every request of its ordinary browser proxy
(`server/gate-upstream.mjs:49-57`; the agent MCP route omits it, `:65-74`), but no code
in this repository or in the DSH floor this repository pins (`0.2.2-rc.2`) authenticates a caller
from its value (bots-dsh only checks its presence, to refuse a remote vault unlock,
`apps/bots-dsh/src/host/channel.js:1434-1437`). The gate
mints DSH's owner cookie from DSH's launch token (`server/gate-upstream.mjs:33-44`), so every
person arrives at DSH as its owner.

The probe on #1374's branch shows the consequence in five steps: a member is fenced by #1389's
read rule, but the probe's Bot session is recorded owner, and the wall honours an explicit
`owner` entry (`apps/bots-dsh/src/host/member-wall/principals.js:42-49`, a reader that otherwise
fails closed), so DSH's real `read` tool returns the
launch file, `DshCredentials.mint()` trades it for the owner cookie, and `/api/private` answers
200. A command of DSH's OS user reads the same file, and the wall never sees a command:
`apps/bots-dsh/README.md:474` says so plainly. Four of the five steps reproduce the hole; the
fifth, the member read refusal, is the fence that must keep working.

Who has the problem: every owner who wants to invite a member or guest into a Cloud workspace.
RFC 0024 (f) says no member or guest joins until three safeguards hold: an unforgeable principal
channel, role-filtered DSH routes, and the launch token out of the Bots' reach. #1372 is the
first, #1373 the second, #1374 the third. This RFC decides the contract all three share.

Owner direction (2026-11-15, on #1372 and #1373): build this on the Automagik side, as an adapter
over DSH's own native pieces, with multitenancy kept in Automagik; it no longer waits on a change
in DSH.

### What exists today, hop by hop

| Hop | Authentication today | What the next hop knows |
|---|---|---|
| browser → gate | Cloud workspace token (or the local claim and a passkey) | the gate knows `{issuer, subject, roles, workspace}` |
| gate → DSH | DSH's launch token exchanged for DSH's owner cookie | DSH knows only "the owner"; the unsigned `x-automagik-principal`'s value does not authenticate the caller |
| DSH core / plugins | one shared browser Peer with owner principal | every call is the owner's |
| Bot session, in process | a session-id record; the #1374 probe supplies an explicit `owner` entry for its Bot session | the wall's owner branch lets it read anywhere (`paths.js:153-156`) |
| Bot command | DSH's OS user (`server/Dockerfile:214`) | the file and the wall are outside its view |

Three facts complete the picture:

- **The gate's principal is real but stops at the gate.** `server/gate-cloud.mjs:208-227` verifies
  issuer, audience, subject, roles, workspace and expiry; `gate-store.mjs` keeps it per session;
  `server/gate.mjs:288,312` proxies with it and sets the header. The vault handler checks the
  header's presence; no downstream code authenticates its value.
- **DSH's native identity is owner-only for browsers.** DSH 0.2.2-rc.2, the floor this repository
  pins, has a merge-extensible `PrincipalMap`, in-process Peers with a fixed principal,
  remote-access policies, and a caller `principal` on `session/prompt` for non-owner callers
  ([RFC 0015](0015-live-chat-projection.md):742-745). But the browser Web carrier admits one
  shared owner Peer; no browser request reaches DSH with a non-owner principal today.
- **The wall's record has no writer.** #1389 reads `{version, sessions}` from a `0600` file
  owned by DSH's user (`principals.js:17-49`); the only writer named is "the owner's side", and
  no production code writes it. Unknown, malformed, open or missing records already fail closed
  to a member with no area. A Bot is the exception only where an explicit `owner` entry names its
  session, as the #1374 probe supplies.

So the answer to "where does the principal come from today" is: it is made in the gate (the Cloud
service or the local claim), authenticated there, and goes no further. DSH and the Automagik host
have no channel. That is the gap #1372 names.

## Design

### 1. The gate signs one assertion; the adapter inside DSH trusts only that

The gate stays the only authenticator. It keeps the principal v1
`{issuer, subject, roles, workspace}` exactly as RFC 0024 (b) froze it; this RFC adds no field to
that value and changes no existing route or plugin id. For every request it forwards to the
adapter's carrier (amendment, 2026-11-20), the gate also sends a **caller assertion**: a compact
signed statement

```text
{ version: 1, kid, aud, principal, session?, method, path, iat, exp, nonce }
```

signed with Ed25519 by the gate's assertion key named by `kid`, with `aud` the instance id, both
inside the signed bytes, a lifetime of at most 60 seconds, and a binding to one request's method and
path plus a single-use nonce the adapter remembers for that lifetime. The private key lives in the
gate's own store, on the gate's own
volume; DSH never mounts that volume
(`server/compose.gate.yml:8-9, 35-45`). The public key is public, and a Bot reading it gains
nothing, but the adapter's trust in it is not taken from any assertion: the adapter is provisioned
with an
authenticated gate key source and the expected instance id, independently of incoming
assertions (the pattern of the Cloud verifier's own configured key source, cache expiry and
bounded refresh, `server/gate-cloud.mjs:63-65, 80-83, 180-193`). It requires `aud` and the
principal's `workspace` to equal that id, bounds its key cache's lifetime and its unknown-key
refreshes, and rejects a removed key once the refresh deadline passes.

Inside DSH, an Automagik host adapter (`@automagik/multiuser-dsh`; § "Deliveries") does four
things:

1. **Admits.** The adapter admits on a private carrier route of its own; it does not own
   `/api`, which DSH keeps. With multiuser on, the gate reroutes a member's or guest's `/api`
   requests and the app's index and frontend resources to that route and never sends DSH's owner
   cookie with them, so the owner cookie is not a member path (amendment "The gate reroutes
   `/api`", 2026-11-20). The adapter verifies the assertion before anything reaches DSH, then
   dispatches with the caller's Peer by the amendment's dispatch rules (`/api` to DSH's shared
   Fetch handler, the frontend by route kind). A WebSocket's principal is fixed at admission and a
   frame cannot change it; until the adapter carries the remote stream WebSocket for a member or
   guest, the gate refuses that upgrade to them.
   Missing, invalid, expired, replayed, wrong-audience or wrong-method/path assertions are refused
   401 when multiuser is on. The assertion travels in `x-automagik-caller`, which the gate builds
   after discarding the browser's credentials and identity assertions and copying only allowlisted
   transport headers (`server/gate-upstream.mjs:47-57`); a bare `x-automagik-principal` is never
   authority and the header stays a debugging hint.
2. **Creates the caller's DSH Peer.** It declares one additive DSH principal kind,
   `{ kind: 'automagik', instance, person: {issuer, subject, roles, workspace}, bot? }`, and
   dispatches the request with a DSH Peer created for that principal through DSH's own
   `createPeer` / shared Fetch handler. DSH's native remote-access policies then see a non-owner
   caller, and, once delivery 5 registers the `automagik` kind's resource and role policy, they
   answer by that principal's role. `session/prompt` records the caller in the Session log where
   DSH already supports it. The owner's own interface keeps the owner principal and reads as
   before: owners and admins use DSH's shared owner Peer, so DSH sees them as one owner; the gate
   keeps their person-level attribution, and the assertion and per-person DSH attribution apply
   to what the carrier handles.
3. **Scopes the work.** It puts the caller into the member wall's per-turn scope (the same
   `AsyncLocalStorage` pattern as `apps/bots-dsh/src/host/member-wall/fs.js:62-63,105-111` and
   `principals.js:16`), so every file read, search, skill load, ACP call and terminal in that turn
   is checked against the caller and the Bot, not against a file record alone.
4. **Records.** It writes the principal record the wall reads (v2 below) from what it verified;
   the record is a cache for restarts and for work with no request, never the authority for a
   person's turn.

The Automagik host (`bots-dsh`) reads the resolved caller from the adapter rather than from the
record, so its tools and the wall see one principal for one turn.

The channel property is the point: the assertion is not a token a workspace process can use. A
Bot cannot mint one (the key is the gate's), cannot replay one outside its request and lifetime,
and cannot name a different person or a broader role. The gate's URL-level role filter (#1373)
stays in front as a second fence; the adapter's Peer and DSH's native remote-access policies do
the method-level work.

**Why an adapter and not a wait for DSH.** The owner's 2026-11-15 direction. DSH 0.2.2-rc.2
already provides the pieces the adapter composes: a merge-extensible principal map, in-process
Peers with a fixed principal, a web server a plugin registers routes on, and remote-access
policies. If DSH later ships an
authentication hook (RFC 0024 Decided 21), the adapter moves behind it and the assertion contract
stays.

### 2. A Bot is `bot:<id>`, never the owner

Every Bot session is created with a **Bot principal**, `{kind: 'bot', id}`, derived from the Bot
registry id (RFC 0014), not from the person who created the Bot and not from the session's owner.
The adapter records it before the session's first turn. A Bot session that has no recorded Bot
principal is not owner: it fails closed as a member with no area.

The Bot's session kind comes from the Bot registry, not from the principal record. The wall
receives the adapter's set of Bot sessions (or one session-kind resolver), so an `owner` entry
for a known Bot session is ignored (and logged), never trusted. That is the invariant the #1374
probe attacks: a Bot cannot be promoted by a file, a header, a session id or a name.

The effective principal of a Bot turn is the intersection of two scopes:

- **The Bot, `bot:<id>`.** Its own directory `<bots root>/<id>`, the shared read roots the owner
  granted **to that Bot**, and nothing else: no DSH data home, no launch file, no gate store, no
  member area, no another Bot's directory. Writes stay in its own directory.
- **The caller, when a person started the turn.** The person's
  `{issuer, subject, roles, workspace}`: from the assertion on a private-carrier call (member or
  guest); an ordinary owner or admin call uses the shared owner Peer. A shared-chat post that
  needs named authorship (RFC 0024 (f)) carries a verified author for every role, owner and
  admin included. The Bot's own scope still caps the turn.

An admin is owner-equivalent, as RFC 0024 (f) has it; the principal's role list is the only source
of that. A permission is allowed only when every principal in scope allows it. A Bot cannot read a
member's denied root "for" the member, and a member cannot read the owner's root through the Bot.
An owner talking to a Bot does not elevate it: the Bot is not a person, and the owner has their
own interface for owner actions. A turn with no caller (a schedule, a job, an autonomous wake-up) is
`bot:<id>` alone, with only the Bot's scope.

This is the replacement for the inherited owner. In the code this RFC builds on:

- `principals.js` gains the `bot` kind and its record entry; `readRecord` keeps its `0600`/uid and
  fail-closed checks; `principalOf` never returns `owner` for a Bot or for a record it cannot
  trust.
- `paths.js`'s `mayUse` keeps its rule "every principal in scope must allow" (`:153-156`) and adds
  the Bot branch: an owner-equivalent role (owner or admin) always; member by #1389's `memberMay`;
  Bot by its own directory and granted shared roots, with denied roots winning. Several
  principals means every one of them.
- `fs.js` keeps refusing as "not found" what a member may not read; it refuses the same way to a
  Bot, so a Bot learns nothing of the owner's files.
- DSH's data home and the launch file are in every Bot's denied roots by default. The owner cannot
  grant them to a Bot. That is the in-process half of #1374.

### 3. A Bot's process is not DSH's OS user

The in-process fence cannot see a shell, an ACP agent, a browser process or a terminal. The second
half of #1374 is the OS boundary:

- a Bot's commands run under a **Bot OS identity**: one uid per Bot in a Cloud workspace,
  provisioned by the image and Arca; a single-owner desktop may keep its owner uid and its
  documented limit, because it has no member to cross. The same boundary covers every child a
  Bot starts (shell, ACP agent, browser, terminal); a child that cannot be bound to the Bot
  identity is refused, not run as DSH's user;
- that identity owns its HOME, XDG directories, TMPDIR, working directory and one delegated
  systemd scope; the environment is the runner's fixed allowlist, with no DSH variable;
- the command path is the member runner's (#1406): one JSON request per connection, the uid switch
  after the proof, `no_new_privs`, refusals `125`, exit codes passed through. It carries a **Bot**
  identity instead of a member identity;
- DSH's data home becomes `0700` (it is not today), owned by DSH's user; the launch file stays
  `0600` in it and the gate reads it read-only, as today, but a Bot uid cannot open it, nor any
  other DSH credential. Member admission requires this OS boundary: every Bot child is denied
  DSH's credentials and the gate's store. Moving the launch token alone (to a gate-only mount or a
  peer-credential-checked socket) does not deny a same-uid Bot DSH's other credentials, so such a
  workspace stays owner-only.

If the runner cannot switch to the Bot uid, it refuses (`125`) rather than falling back to DSH's
uid. That is what makes the OS half fail closed.

A Bot's commands and its file tools use two disjoint trees (amendment "A Bot's files and its commands
live in two trees", 2026-11-20).

### 4. What the member keeps

The member's file rule is #1389's, unchanged: own area plus shared roots, denied roots win, the
decision is on the real target and on the walk, a search root is checked before ripgrep runs, and
an unknown, missing, malformed or open record is a member with no area. The difference is only the
writer of the record and the added Bot branch. The member's commands keep the member runner's
(#1406) contract, which delivery 4 wires as the `bots-dsh` shell row. A terminal or Code grant is
per Bot, owner-granted (RFC 0024 (f)), and, when granted, runs under the member's uid through the
same runner.

The #1389 tests stay the acceptance floor: `member-wall-read.test.js` and
`member-wall-spelling.test.js` pass unchanged; a member read of the launch file stays refused;
`members: false` stays DSH's sandboxed filesystem, unchanged. This RFC adds Bot cases; it does not
weaken a member case.

### 5. Where the shared records live

Two records have two jobs, and this RFC keeps them apart.

- **The caller registry (new).** The authority is the gate's session store, keyed by instance id
  and session id, holding the principal, roles and expiry. Cloud caller sessions and their
  workspace proofs stay in the gate's memory and end on a restart, as today
  (`server/gate-entrypoint.mjs:24-28`, `server/gate-store.mjs:88-101`,
  `docs/cloud/contracts-v2.md:135`); only the assertion signing key persists, on the gate's own
  volume. The adapter enforces single-use nonces for the assertion lifetime. DSH never writes
  the store; a Bot never reaches it. The Automagik
  adapter keeps a derived **principal record** under DSH's data home (`0600`, DSH's uid) as the
  wall's input; it
  is rebuilt from verified assertions and never grants owner on its own. Once the OS half
  (delivery 3) is on, a Bot cannot write either: the gate's volume is outside its mount, and the
  DSH record is DSH-uid `0600`, outside a Bot uid. Before that half, a known Bot session is still
  never owner, whatever the file says; the file is not the Bot's authority.
- **The ACP CLI generation registry (existing).** `apps/acp-dsh/src/host/cli-generations.js` keeps
  the per-vendor generation pointer and `current/generation.json` under one Automagik home
  (`apps/acp-dsh/src/host/clis.js:100`), with its own per-process instance id
  `${pid}-${uuid}` (`apps/acp-dsh/src/host/cli-homes.js:36-40`). It is a per-harness account
  record, not a caller identity. This RFC does not move it and does not key a principal on its
  per-process instance. #1426 may extend it with a reservation row; it must not be reused as the
  caller registry.

## Contracts introduced

- **Caller assertion v1** (new, gate → DSH hop). It travels in `x-automagik-caller`. Version 1;
  the fields above; Ed25519 with a key id; `aud` the instance id; at most 60 seconds; the signature
  covers method and path, and a single-use nonce makes one request one use. Compatibility: DSH
  core ignores it; an adapter that does not know it sees no caller and fails closed. A changed
  field or meaning is a new version. A browser's value for the header is never forwarded.
- **The gate's assertion key pair** (new). The private key stays in the gate's store on the gate's
  own volume; the public key is published to the adapter and rotates in two slots, the pattern
  RFC 0024 sets for the Cloud keys. A key id the adapter does not know triggers one refetch of the
  public key set.
- **Automagik principal kind** (additive to DSH's `PrincipalMap`). One kind,
  `{kind: 'automagik', instance, person: {issuer, subject, roles, workspace}, bot?}`. It is
  persisted in Session logs, carries no credential, and is safe for DSH to store. A missing
  `bot` means a person's own call; a present `bot` means a Bot turn.
- **Principal record v2** (the wall's file). Its shape is
  `{ "version": 2, "instance": "<id>", "sessions": { "<id>": "owner" | "member:<name>" | "bot:<id>" } }`.
  Version 2 adds `bot:<id>` entries and the instance id; v1 records still read as today; a wall
  that only knows v1 fails closed to member on a v2 record, never to owner; a malformed, open or
  missing record is a member with no area. The file stays `0600`, DSH's uid.
- **Bot scope**. `bot:<id>`, own directory `<bots root>/<id>`; the id is the Bot registry id
  (RFC 0014). No new storage prefix.
- **Instance id**. RFC 0024's 2026-11-20 amendment, (l): the owner record's `instance_id`. Desktop
  and host launchers hand it to DSH as `AUTOMAGIK_INSTANCE_ID`; in the gated server image the id
  stays in the gate's store, the adapter is provisioned with it (§ 1), and a plugin offers no
  reservation until it has a verified instance id (RFC 0024 (l)); for a Cloud workspace, it is
  the workspace id. Random, made once, never derived from a host,
  home or machine name. This RFC creates no second id.
- **No change** to the RFC 0024 principal v1, to the meaning of `x-automagik-principal` (it stays
  an untrusted hint; the assertion is what is trusted), or to any route path, plugin id or storage
  prefix that exists today. `/api` keeps its path for the browser and DSH keeps its `/api` route;
  the gate chooses which upstream answers (amendment, 2026-11-20).
- **The adapter's carrier route** (new, private; amendment, 2026-11-20). A prefix route,
  `/_automagik/caller`, that the adapter registers on DSH's web server. Only the gate reaches it
  for a person, on loopback; the gate refuses, on HTTP and upgrade, a browser path that is or
  normalizes to `/_automagik` or below. Every request on it needs a valid assertion, whoever
  sends it.

## The stable instance/project id, and #1426

#1426 asks for a non-secret record that a subscription account is shared, or reserved to one
instance or project. That record is **out of scope here**: it is a vendor-account reservation, not
a caller identity, and it does not need a second id. RFC 0024's amendment for #1426, accepted by
the owner's delegate on 2026-11-20, owns it: (l) the instance id, (m) the account evidence and its
matching, (n) the record and its storage. This RFC relies on (l)'s instance id and adds nothing to
the rest. (The draft of this RFC sketched an evidence shape of its own; RFC 0024 (m) replaces it.)

## Migration and rollout

- **Default off.** `members: false` stays the default, and owner-only admission
  (`server/gate-cloud.mjs:42-45,173-178`) stays. Existing instances keep DSH's owner behavior and
  the limit RFC 0024 (c) already states: sign-in protects the instance from the network, not from
  its own Bots.
- **Turning it on.** A workspace enables multiuser only after the three safeguards and the
  isolation review; the adapter then requires assertions, creates `bot` sessions, and refuses a
  request with no valid assertion. A self-hosted owner may enable the file/Bot half behind its own
  setting, with the same fail-closed rule.
- **Live sessions at the switch.** A Bot session that existed as owner is ended and recreated as
  `bot:<id>`; it is never rewritten in place while live, because tools already running in it hold
  the old scope. Before members are enabled on an installation where Bots shared DSH's uid: old Bot
  processes are retired; the executable DSH profile is verified or rebuilt from trusted inputs
  (the server can keep an existing profile and launch it); every DSH credential they could have
  read is invalidated (DSH credentials survive a gate revocation,
  `docs/cloud/0024-isolation-review.md:583-587`); and agent grants whose provenance cannot be
  verified are revoked or reissued; every Bot's `people` field is reset to owner-only and its
  earlier chat parts stay owner-only, because a Bot could write both (amendment "Delivery 5
  specified"). The workspace stays owner-only until those checks pass. A
  person's browser session is re-established by the gate on the next request; an owner or admin
  goes to DSH's owner interface, a member or guest to the carrier with its own assertion.
- **Missing principal.** A missing, unreadable, malformed or open record, or a session with no
  entry, is a member with no area, never owner. On the private carrier, a missing or invalid
  assertion is `401` before dispatch, so before any tool, file read, search, skill or route. An
  adapter that is off while multiuser is on is a configuration error: the composition refuses to
  start, rather than falling back to owner
  silently.
- **Rollback.** Turning multiuser off returns DSH to its owner behavior and owner-only admission.
  Before the reroute is disabled, member and guest admission stops, their sessions are revoked and
  their sockets closed: a live session is checked against the store and its expiry, not the role
  rule (`server/gate-store.mjs:104-132`). The ordinary browser proxy also requires an active owner
  or admin before it uses the owner cookie, on every HTTP request and upgrade, in either mode, and
  an unavailable adapter means a refusal, never the owner proxy. Before owner Bot sessions are
  restored or the uid boundary is
  reverted, Bot work is drained: Bot dispatch stops, active turns finish or are cancelled under
  their existing scope, and queued or scheduled work accepted while multiuser was on (armed
  schedules survive a restart, `apps/bots-dsh/src/host/schedules.js:496`) is quarantined and
  resumes only under its original restrictions. It cannot undo a file a Bot already read while the
  mode was on, and it does not change the image's OS identities. A Bot's `bot` record remains, and a
  later
  re-enable reuses it.

## Threat model

- **Who can reach it.** A person reaches DSH only through the gate, after Cloud sign-in or the
  local claim; the gate admits owner/admin today and, after #1373's role filter and delivery 6,
  members and guests by role. A Bot reaches its own tools and commands inside the workspace; it
  never reaches the gate's store, the assertion key or another Bot's identity.
- **What it can do by design.** A Bot reads its own directory and the shared roots the owner
  granted it, writes only its own directory, and acts only as `bot:<id>` intersected with its
  caller's role. A member reads its own area and shared roots; a guest has no area of its own, no
  terminals and no Code mode.
- **How it is authenticated.** The gate verifies the Cloud or local identity and signs the
  assertion with a key DSH never holds. The adapter verifies the signature, the audience, the
  lifetime, the nonce and the request binding before it resolves a principal. The launch token is
  not a principal channel, and it is out of a Bot's reach once the OS half is on.
- **What it cannot do.** A Bot cannot forge a person, become the owner, read the launch file
  through DSH's tools or a command, read another Bot's directory, read the gate's store, or replay
  an assertion outside its request and lifetime. A member cannot reach the owner's files, the
  launch token, a terminal or Code mode without a per-Bot owner grant, and cannot use a Bot as a
  proxy for any of them. A guest cannot be treated as a member by spelling a member path.
- **Undo.** Revoke the gate session (the person is signed out and the assertion expires within a
  minute), remove the Bot from the workspace (its registry id and directory become unreachable),
  turn multiuser off. Reverting a release restores DSH's owner behavior and reopens the documented
  owner-only limit; it does not retract a read or a command that already happened.

## Deliveries

Each delivery is one lane, per [RFC 0011](0011-monorepo-parts-and-releases.md). "Unlocked by" names
what must exist first; a delivery that depends on Cloud is not promised before that service
exists.

0. **Docs only** (none). This RFC and its index row. *Check:* the index row matches the file;
   every commit is `docs(rfcs):`; `git diff --check` clean. *Rollback:* revert the docs.
1. **The caller assertion and the admission adapter** (plugin, 3.N.P). The gate signs the
   assertion on the DSH hop and keeps its key on its own volume; `@automagik/multiuser-dsh`
   registers its private carrier route, verifies the assertion there, creates the caller's DSH
   Peer and puts the caller into the turn scope. With multiuser on, the gate reroutes a member's
   or guest's `/api` requests and the app's index and frontend resources to that route without
   DSH's owner cookie, and refuses their `/api/remote.mux` upgrade until the adapter carries it,
   so DSH's owner path never answers a member. The ordinary browser proxy requires an active owner
   or admin before it uses the owner cookie, on every request and upgrade. No Bot or role
   behavior yet; non-owner DSH calls stay default-deny until delivery 5 registers their policy.
   *Unlocked by:* RFC 0024 (c)'s gate and DSH 0.2.2-rc.2's web server route API,
   `PrincipalMap`, `createPeer` and `createSharedFetchHandler`; no Cloud service needed.
   *Check:* a valid assertion admits and attributes the caller; missing, expired, replayed,
   wrong-audience and reused-nonce assertions are 401; a valid private rewrite matching the signed
   method, public path and query dispatches as the caller, and a mismatched method, suffix or
   query is 401; a rerouted request carries no DSH cookie or API token; a
   browser path to the carrier route, in any spelling, on HTTP or upgrade, is refused by the
   gate; without an owner cookie, a member's index, a client bundle, the app manifest and its icon
   load through the carrier as that member, the rerouted SVG icon with its security headers; an
   oversized buffered request is 413 with or without `Content-Length`; in multiuser mode the
   agent MCP route is refused before the gate obtains a DSH credential, and the direct listener
   refuses agent requests; a member's or guest's
   upgrade is refused (delivery 5's 5b carries it); the owner's own interface is unchanged; a
   forged bare `x-automagik-principal` is ignored; with multiuser off nothing is rerouted; a
   signed-in member is refused the owner proxy after the reroute is disabled.
   *Rollback:* stop member and guest admission and revoke their sessions, then remove the adapter
   and the reroute; the gate keeps only the header, which DSH ignores.
2. **Bot principal and the file fence** (plugin, 3.N.P). `bot:<id>` sessions, the v2 record, the
   Bot branch in `paths.js`, and DSH's data home and the launch file denied to Bots by default.
   *Unlocked by:* delivery 1 and the Bot registry. *Check:* the #1374 probe, with its Bot session
   declared a Bot as the adapter declares it, flips `bot-read` to CLOSED while `member-read`
   stays FENCED; the three OS steps (`bot-shell`, `gate-credential`, `bot-owner-rights`) wait for
   delivery 3. A known Bot session is never owner whatever its record says; the adapter is the
   record's writer, and delivery 3 adds the OS boundary that stops a Bot writing it; the #1389
   member tests are unchanged. *Rollback:* on an enabled workspace, first the member rollback in
   "Migration and rollout" (stop admission, revoke member and guest sessions, close their
   sockets), then the Bot drain below; only then turn the setting off, and Bot sessions return
   to today's owner behavior.
3. **Bot OS identity and command path** (plugin and server image, 3.N.P). One uid per Bot in a
   Cloud workspace, its HOME/XDG/TMPDIR, the runner's Bot identity, DSH's data home `0700`. The
   launch file and DSH's credential store stay DSH-uid `0600`, out of every Bot uid's reach; where
   uids cannot be provisioned, the workspace stays owner-only. *Unlocked by:* the image and Arca's
   per-Bot uid provisioning, the member runner's (#1406) template and the server image split (RFC
   0024 (g)); no Cloud
   application code. *Check:* the probe's `bot-shell`, `gate-credential` and `bot-owner-rights`
   flip to CLOSED; a Bot command cannot open the launch file, the gate store or another Bot's
   directory; the runner refuses `125` rather than fall back. *Rollback:* on an enabled
   workspace, first the member rollback and the Bot drain in "Migration and rollout"; only then
   revert the image, and the owner-only limit returns.
4. **Member and guest commands** (plugin, 3.N.P). Members use the member runner (4c, the
   `bots-dsh` shell row); a terminal or Code grant is per Bot, owner-granted, and runs under the
   member's uid. *Unlocked by:* delivery 3 and #1406. *Check:* a member's command runs as the
   member uid and cannot read the owner's data; a guest is refused a terminal and Code mode;
   #1389's read fence is unchanged; a positive grant works only with delivery 5's policy, a
   caller-aware Code route and the current per-Bot grant together (amendment "Delivery 5
   specified"), and the Code stream's own desktop-window check stays. *Rollback:* turn the grant
   off; the member keeps file tools only.
5. **Role-filtered DSH routes** (#1373) (plugin, 3.N.P). The gate refuses URL-level routes by
   role, and the adapter's Peer plus DSH's native remote-access policies answer method-level calls
   by the caller's role: guests only allowlisted Bots and never terminals, Code mode or settings;
   members terminals or Code only when granted per Bot; stop and cancel owner-only. *Unlocked
   by:* delivery 1 including the gate's `/api` reroute, a working per-caller carrier for
   `/api/remote.mux` on the pinned runtime (the adapter's; a missing DSH capability is recorded as
   a specific upstream dependency in RFC 0023's form), and Cloud's role table. DSH answers 403 to
   every non-owner Peer on an exact Fetch route before any policy runs
   (`dsh-client-connection/lib/index.js:826-836`), and the Bot UI's `POST /api/omni-ui` is one
   (`apps/bots-dsh/src/host/constants.js:22`; registered at `channel.js:1410-1461`, its
   endpoints dispatched from `:536`), so this delivery exposes
   each member-facing Bot operation through a caller-aware handler or a policy-checked Typert
   method; owner-only exact routes keep their refusal. #1373 stays open if only the assertion
   ships. *Check:* the role table; a guest lists an allowed Bot and not an ungranted one; every
   route and WebSocket without a session is refused (401, or 403 where the gate refuses before
   authentication, as the agent route in multiuser mode), except the gate's sign-in routes and
   separately authenticated endpoints (the signed Cloud revocation,
   `server/gate.mjs:176-199, 225-228`); a member's forged URL cannot reach a terminal;
   a guest cannot reach settings. *Rollback:* revert to owner-only admission; members stay off.
   *Specified* by the amendment "Delivery 5 specified" below: the role table, the stream carrier,
   the one `automagik` policy, the Bot UI's caller routes and the `people` field, in four steps
   (5a-5d, with member and guest prompting specified there as 5e). Delivery 5 is complete with 5d.
   The refusal of terminals and Code mode ships with it. The positive per-Bot grant takes effect
   with delivery 4.
6. **Cloud enablement** (Cloud service, outside this repository). Members and guests are admitted
   only after deliveries 1-5 and the isolation review pass; the workspace switches from
   owner-only to the role table. *Unlocked by:* the Cloud service's workspace token, role
   database and revocation (RFC 0024 (e), (g)), the Arca per-workspace VM, and the isolation
   review gate; none of it is in this repository. *Check:* a member signs in end to end, sees only
   its Bots, and cannot reach the owner's files, terminal or Code mode; a guest sees only
   allowlisted Bots; revocation ends the session. *Rollback:* the gate returns to owner-only
   admission and revokes every member and guest session, closing their sockets and feeds; no data
   moves.

## Amendment (2026-11-20): the gate reroutes `/api`

*Status: approved by the owner's delegate on 2026-11-20, with the RFC. It changes § 1's "Admits",
§ 3's launch-token fallback, § 5's caller registry, "Contracts introduced", the #1426 section,
"Migration and rollout", deliveries 1, 3 and 5, and Q1 and Q5's answers. The adversarial review
of the takeover (2026-11-20) found the index, exact-route, agent-route, credential and rollback
cases this list covers.*

**Why.** The draft had the adapter own `/api` and admit with DSH's `connection/request` hook.
On the DSH this repository pins (0.2.2-rc.2) neither holds:

- **DSH holds `/api`.** `dsh-client-connection` registers the `/api` prefix route unconditionally
  (`lib/index.js:1044-1058`), and `dsh-api-gateway` registers the `/api/remote.mux` upgrade
  (`lib/index.js:800-841`). The host web server throws on a duplicate kind and path, or upgrade
  (`dsh-host-webserver/lib/index.js:375-378, 390`). A plugin cannot register a second `/api`
  prefix.
- **The hook runs after the cookie admission.** `connection/request` is a waterfall called only
  after `connection.admit(req)` (`dsh-client-connection/lib/index.js:1049-1055`). `admit` answers
  401 to a request with neither DSH's browser cookie nor an API token; the browser cookie selects
  the shared owner Peer and an API cookie its live owner Peer, both with the owner principal
  (`:714, 742-749, 781-789`). A hook there can refuse a request, never admit one by
  assertion, and every request it sees is already the owner's. The upgrade has no such hook.
- **What does work from a plugin:** registering routes on DSH's web server (bots-dsh does,
  `apps/bots-dsh/src/host/app-manifest.js:127`), the `PrincipalMap` merge
  (`dsh-typert-protocol/lib/types/types.d.ts:359-370`), `createPeer` and
  `createSharedFetchHandler('/api')` (`dsh-client-connection` `lib/types/rpc.d.ts:178, 197`).

**What changes.** The gate is already the only public listener (DSH binds 127.0.0.1,
`server/entrypoint.mjs:6`) and proxies to DSH itself (`server/gate.mjs:288, 312`), so it chooses
the upstream for the requests it forwards. "Member or guest" below means any admitted person whose
roles are neither owner nor admin:

- **Owner and admin** (owner-equivalent, RFC 0024 (f)): as today, DSH's `/api` with the owner
  cookie the gate mints; DSH sees them as its one owner, and the gate keeps who they are. The
  owner's interface does not change. The ordinary browser proxy requires an active owner or admin
  before it uses the owner cookie, on every HTTP request and upgrade, in either mode.
- **A member or guest, with multiuser on:** the gate reroutes `/api` (on a segment boundary) and
  every path below it, and the app's index and frontend resources, to the adapter's carrier
  route, `/_automagik/caller`, with the caller assertion and with no DSH cookie or API token.
  The assertion binds the browser's own method and one canonical public target (path and query,
  built the same way at both ends). The adapter derives the public target from the private
  prefix and the received suffix, compares it and the actual method with the signed values, then
  dispatches that target, always with the caller's Peer: `/api` to DSH's shared Fetch handler,
  keeping what DSH's own HTTP bridge does (`dsh-client-connection/lib/index.js:40, 1055`): the
  request-body mode, the configured buffered-body limit (413 with or without `Content-Length`)
  and cancellation on disconnect; the
  index and static assets from the pinned web app distribution, the index rendered with the
  caller's Peer and a missing file a 404, never DSH's replaceable fallback (as delivery 1 does,
  #1892, `apps/multiuser-dsh/src/frontend-static.js:26-40`), with plugin bundles through
  `clientModules.fetchBundle` (LiveShare's bundle branch, `lib/index.js:7777-7792`; its other
  branch, the web server's `readResource(request, peer)`, can reach a replaceable fallback).
  `readResource` answers 404 for a
  `handler` route (`dsh-host-webserver/lib/index.js:413-434`), and the app manifest and icon are
  such routes (`apps/bots-dsh/src/host/app-manifest.js:99-104`), so the adapter serves them
  itself, or bots-dsh exposes them as GET/HEAD resources; either way GET/HEAD behavior, content
  types and the icon's security headers (`nosniff`, `Content-Security-Policy: default-src
  'none'`, `apps/bots-dsh/test/app-manifest.test.js:154`) stay as they are. Their requests never
  carry DSH's owner cookie on any path.
- **The remote stream WebSocket for a member or guest:** refused by the gate until the adapter
  carries it. DSH owns the public `/api/remote.mux` upgrade, and its mux instance is private. A
  plugin has the primitives for a carrier of its own: `registerUpgrade`, the `./stream-protocol`
  export, and the gateway service's `wireStream.open(..., peer, signal)`
  (`dsh-api-gateway/package.json:31-36`, `lib/types/types.d.ts:83-105`). The mux server itself,
  `RemoteStreamMuxServer` with `handleUpgrade(req, socket, head, peer)`, ships only as TypeScript
  under `./src/*` (`src/stream-server.ts:55, 94-105`), which Node does not strip inside
  `node_modules`, and as an unexported compiled file; so a carrier means rebuilding that server
  over the public pieces. Delivery 1 refuses the upgrade; delivery 5 (5b in the amendment
  "Delivery 5 specified") builds that carrier and verifies it with a fixed caller Peer, including
  cancellation, stream limits and disconnect, and records the upstream ask in RFC 0023's form.
  Delivery 5 needs a working carrier. Members do not join before then (Q8).
- **The carrier route is private.** Before authentication, on HTTP and upgrade, the gate refuses
  the literal private namespace (`/_automagik` and below) and every alias that normalizes to it.
  (`/_gate`'s alias rule, `server/gate.mjs:30-54`, lets the canonical path through on purpose, so
  this is a rule of its own.) `/connect` and token-bearing browser URLs stay refused
  (`server/gate.mjs:267-269, 283-285`), as does HTTP `CONNECT` (`:301`); the WebSocket checks
  (`:302-312`) allowlist no upgrade path today; delivery 1 refuses every member or guest
  upgrade, and delivery 5 (5b) allows one exact path, `/api/remote.mux`. A process inside the
  workspace can reach the route on loopback, but every request on it needs a valid assertion,
  which only the gate signs.
- **Agent access is refused in multiuser mode.** `/api/omni-mcp` is the sole agent route the gate
  proxies to DSH; it is separately authenticated by the agent bearer, outside the ordinary browser
  proxy (`server/gate.mjs:231-260`, `server/gate-upstream.mjs:65-74`), and the plugin's direct
  MCP listener serves the same handler. An agent grant carries no member or Bot scope today. In
  multiuser mode both the gate's MCP route (refused before the gate obtains a DSH credential) and
  the direct listener refuse agent requests until an amendment specifies one scoped agent policy
  and enforces it on both (delivery 5 specifies none: amendment "Delivery 5 specified").
  Owner-only mode keeps the separately authenticated MCP route as it is.
- **Multiuser off** (the default): the gate reroutes nothing, and the adapter's route refuses
  every request with 401. No behavior changes.

**Rejected.** Waiting for a DSH authentication carrier: the owner's 2026-11-15 direction says not
to wait on DSH. Replacing the request inside the `connection/request` waterfall: every request
there is already admitted as the owner, the owner cookie still crosses the hop, and the
WebSocket upgrade has no hook.

**What stays.** Caller assertion v1, the gate's key pair, the `automagik` principal kind, principal
record v2 and every other contract. `/api` keeps its path for the browser. If DSH later ships an
authentication hook (RFC 0024 Decided 21), the adapter may move behind it and the reroute goes;
the assertion contract stays.

## Amendment (2026-11-20): delivery 5 specified, the role-filtered DSH routes

*Status: approved by the owner's delegate on 2026-11-20, with every recommended option; its
questions are answered below. In delivery: none of its deliveries has merged. Issue #1373 (Refs).
It specifies delivery 5, changes the earlier amendment's agent-access and upgrade lines, and adds
contracts, a migration step, threat-model lines and a rollback. It builds on delivery 1 (#1892),
merged the same day. Repository files are cited from `dev` at 487ab5d41, delivery 1's included
(marked "delivery 1 (#1892)"); the sections above this amendment cite the tree before that merge.
Every `dsh-*` file is the pinned DSH's (0.2.2-rc.2), under `node_modules/@deepseek-ai/`.*

**Why it is here.** Delivery 5 names the outcome (a role table, the gate's URL filter, DSH's
native policies), but four things it needs are contracts, not details: what a member or guest may
call, how their streams reach DSH, who registers the one policy DSH allows for the `automagik`
kind, and where a Bot says who may talk to it. Delivery 1 (#1892) is the starting point:

- the gate sends an owner or admin through DSH's owner cookie and every other admitted person to
  the carrier with an assertion (`server/gate.mjs:317-335`), and refuses their WebSocket upgrades
  (`:369`);
- the carrier makes the caller's Peer `{kind: 'automagik', instance, person}` with
  `interactions: 'none'` and dispatches `/api` through DSH's shared Fetch handler inside the turn
  scope (`apps/multiuser-dsh/src/carrier.js:81, 111, 117, 123, 138`); the adapter provides
  `automagikCaller` version 1, `{version, multiuser, current}` (`apps/multiuser-dsh/index.js:66`),
  which bots-dsh reads only at version 1 (`apps/bots-dsh/src/host/multiuser.js:6-8`);
- no policy is registered, so DSH denies every business call of a non-owner Peer; it still allows
  `remoteAccess/follow`, a Peer's own access snapshot
  (`dsh-api-remote-access/lib/index.js:222-226`).

On the pinned DSH that leaves a member or guest with nothing to use:

- **Exact Fetch routes answer 403 to every non-owner Peer**, before any policy runs
  (`dsh-client-connection/lib/index.js:826-831`). Every Bot UI endpoint is one: `/api/omni-ui`
  (`apps/bots-dsh/src/host/channel.js:1421-1474`), its feed (`feed.js:110`), generated images and
  pets (`channel.js:1325, 1341, 1351`), gen-UI media (`genui.js:404`), the Code routes
  (`code-side.js:385-395`) and the agent route (`channel.js:1367`).
- **Unary Typert methods work over HTTP with the caller's Peer.** The gateway intercepts `/api`
  RPC (`dsh-api-gateway/lib/index.js:790`) and decides each non-owner call, with its validated
  arguments, by the policy of the principal's kind (`:1206-1220`); its public `invoke` takes the
  Peer explicitly (`lib/types/types.d.ts:9-26, 138`).
- **Streams need the WebSocket.** The Bot UI's chat is DSH's conversation view over DSH sessions
  (`apps/bots-dsh/src/client/index.js:319, 981-1019`), and DSH serves streams only on
  `/api/remote.mux`, whose mux server is private to the gateway
  (`dsh-api-gateway/lib/index.js:792-841`). Forwarded Remote events (`$events`) need a Peer
  with `interactions: 'answer'` (`:1011-1016, 1484-1486`); only an owner Peer receives pending
  ones or answers (`:996, 1042-1045`), and any other client gets an event only when the policy
  allows `event:<name>` on its resources (`:1077-1088`).
- **DSH keeps one policy per principal kind**: `registerPolicy` throws on a second
  (`dsh-api-remote-access/lib/index.js:175-177`), which protects whichever plugin registered first.
- **An authorised follow is not decided again.** DSH's `invalidate()` wakes access-snapshot
  followers (`dsh-api-remote-access/lib/index.js:201-205`); a `session/follow` already open keeps
  yielding frames without a new decision, so a revocation has to end it from outside.

### The role table

The roles come from contracts-v1 (`docs/cloud/contracts-v1.md` § 1). The per-Bot author gate in
5e follows RFC 0024 (f). A person's **effective role** is the strongest of their roles: owner or
admin, then member, then guest (so `guest` with `member` is a member). An owner or admin never reaches the
carrier (the gate sends them to DSH's owner interface), so a carrier call whose principal lists
owner or admin, or no known role, is refused before dispatch.

A **visible Bot** is, for a member, a Bot in "anyone in the workspace" mode (never a main Bot) or
one whose allowlist names them; for a guest, only a Bot whose allowlist names them. A main Bot is
visible only through its allowlist. An owner-only Bot (the default) and a Bot whose `people`
field cannot be read are visible to neither. Visibility is decided on every call, from the field
and the current assertion's role.

| What | Owner, admin | Member | Guest |
|---|---|---|---|
| List a Bot and open its chat | every Bot | visible Bots | visible Bots |
| Read the Bot's own chat | yes | visible Bots, from the part the share opened | visible Bots, from the part the share opened |
| Send in the Bot's chat | yes | from 5e: visible Bots, authored | from 5e: visible Bots, authored |
| Answer or dismiss a question or a view card | yes | from 5e: cards of their own turns | from 5e: cards of their own turns |
| Answer an approval | yes | no (Q2) | no (Q2) |
| Stop, cancel, steer, retry, fork, rename, edit the queue | yes | never | never |
| Settings, credentials, Bot admin, schedules, jobs, workspace writes | yes | never | never |
| Rooms, side conversations (btw, side), Bot-to-Bot exchanges | yes | no (Q3) | no (Q3) |
| Generated images, gen-UI media, pets | yes | not in delivery 5 | not in delivery 5 |
| Terminals and Code mode | yes | refused; per-Bot grant with delivery 4 | never |
| Agent access (MCP) in multiuser mode | refused | refused | refused |

**Authored** (from delivery 5e) is RFC 0024 (f)'s provenance and § 2's rule: every message in a shared chat carries
its author's verified principal, in the durable message, in the chat and feed projections and in
what the Bot is told (as data). A **shared Bot** is one visible to anyone but owners. For members
and guests the author is the carrier's verified caller. Owners and admins share DSH's owner Peer:
the gateway skips the policy for it and DSH records no person on its prompts
(`dsh-api-gateway/lib/index.js:1206`, `dsh-api-session-controller/lib/index.js:4150-4155`). So
with multiuser on, every input to a shared Bot's session needs a verified human author, whatever
its path (the Bot UI, DSH's native composer, a card reply, another client). Trusted autonomous
work (a schedule, a job, a wake-up) is not a person's input: it runs as `bot:<id>` alone (§ 2).
Context the host adds to a turn (the clock, runtime context) is not an input and takes the
turn's restrictions. An input of no known class is refused. Two pieces enforce it:

- the owner's client posts to a shared Bot through `/api/omni-ui`, where the gate also signs a
  caller assertion for an owner or admin and bots-dsh records the author the adapter verifies
  (`automagikCaller` version 2, `verify`, which accepts owner and admin on that entry only; the
  private carrier still refuses them);
- a check on DSH's `agent/pre-step` hook, run before queued input enters a model step, reads the
  author from each message's own source, as LiveShare's reader check does
  (`dsh-experimental-liveshare/src/host/share-host.ts:478-493`), and asks the gate, at the step, for its
  signed decision on the input's own session family (a renewal carries it to the renewed family
  with the rechecked roles and a revocation ends it), and reads the Bot's current `people`. DSH
  keeps the admission roles with the prompt and uses the step-time roles to decide access. An input with no verified author is refused; one
  with no current decision (the person left, was revoked or demoted, or DSH restarted) is
  quarantined. It never runs on its own, and its person can see it and send it again.

History written before is marked unattributed, never given an author. Until 5e no member or
guest input exists. Every human input to a Bot's chat is an owner's or an admin's, shown without
an author.

**The Bot's shared chat** (Q1): a visible Bot's own chat, the owner's turns included, is visible
only to the people the owner allows on that Bot. Members read it from the part that opened
when the Bot was shared in the current DSH start. Earlier parts, a part a Bot-to-Bot message
entered, and card answers stay the owner's. From 5e, a **card** (a question or a view the Bot raised)
keeps its id, its originating turn, the verified person whose turn raised it and its Bot, across
part moves. Creation, replacement, reply, dismissal and implicit supersession check the exact card
and the current grant when they happen: only that person (or an owner) answers or dismisses it,
and a message or a card of anyone else's neither closes nor overwrites it. Today a session holds
one question and one view slot (`apps/bots-dsh/src/host/tools.js:878, 915`), a dismissal names
only the session, and any user message supersedes the open card
(`apps/bots-dsh/src/host/turns.js:1016-1030`); 5e changes that for multiuser mode. A card with no
recorded person is the owner's.

**What the model sees** (from 5e). DSH builds a turn's model request from the whole session
(`dsh-agent-loop/src/agent.ts:734, 744`), and a part's handoff note carries it forward
(`apps/bots-dsh/src/host/parts.js:532`), so content the Bot chat hides (a Bot-to-Bot exchange's
turns) is still in the model's context, and the Bot can repeat it. A member or guest therefore
prompts only on a chat part whose whole model context (history, tool history, handoff note) is
visible to them; a part that holds hidden content takes no member or guest prompt, and the owner
can start a fresh part. What the Bot itself knows (its memory, its folder) is the Bot's scope,
which the owner shares by allowing people on the Bot.

**A turn a member or guest started** (from 5e). The Bot works with § 2's intersection, so its tools are
checked against the initiating person as well as the Bot, at each tool's execution. A tool that
acts beyond the Bot's own chat is refused to such a turn in 5e: stopping a turn
(`stop_bot`, `apps/bots-dsh/src/host/tools.js:393`), reading a room (`read_group_chat`,
`groups.js:1701`), relaying to another Bot, and Bot administration. Work the turn delegates keeps
the restriction. A main Bot visible through its allowlist is the case that matters most.

### The stream carrier

The adapter carries a member's or guest's `/api/remote.mux` itself, by rebuilding DSH's mux server
over DSH's public pieces: an exact private upgrade route, `/_automagik/caller/api/remote.mux`,
through the web server's `registerUpgrade`; the frame format from the `./stream-protocol` export;
and, for every logical stream, the gateway's
`wireStream.open(endpoint, payload, uplink, peer, signal)` (`dsh-api-gateway/package.json:33-36`,
`lib/types/types.d.ts:83-105`). The template is DSH's own `src/stream-server.ts` (497 lines,
MIT); the WebSocket library is `ws` at the version bots-dsh pins (8.18.3).

- **Gate.** The gate signs an assertion for the upgrade's `GET` and its canonical target, as for
  HTTP, and forwards a member's or guest's upgrade only for the exact path `/api/remote.mux`;
  every other upgrade of theirs stays refused. The forwarded handshake carries a caller-specific
  header allowlist (the WebSocket handshake fields and the assertion) and no DSH credential;
  delivery 1's owner upgrade headers, which carry the owner cookie, are never used for it.
- **Exclusive route.** DSH dispatches an upgrade straight from its upgrade table
  (`dsh-host-webserver/lib/index.js:520-535`), and delivery 1's collision guard covers HTTP
  dispatch only (delivery 1 (#1892), `apps/multiuser-dsh/index.js:39-45`). 5b guards the upgrade
  dispatch of the private namespace the same way: with a route there at startup, a private
  handshake is destroyed and never reaches that handler. Every failed handshake disposes its
  provisional Peer and releases its quota. The adapter's loss while multiuser is on closes
  admission: on disposal it leaves the private namespace held by a refusing handler, on HTTP and
  upgrade, until DSH restarts, so no later handler receives a member's connection. Across a
  restart, the gate forwards a member's request only on a loopback connection whose adapter has
  just answered its readiness probe, so a handshake during a DSH restart never reaches a
  mistaken handler registered before the adapter's reservation.
- **Admission.** The same assertion checks as HTTP. The caller's Peer is made at admission, fixed
  for the socket's life and released on close. It has `interactions: 'answer'`, so DSH lets it
  open `$events`; DSH still gives pending events and answers only to owner Peers, and forwards
  another event only when the policy allows it. The `$events` ready frame (with DSH's host facts)
  reaches it with no policy decision; it is the one notification the policy does not filter.
  Each stream's whole pump (open, iteration and cleanup) runs in the caller's turn scope.
- **Limits.** The uplink inbox per stream is DSH's default, 262144 bytes
  (`dsh-api-gateway/lib/index.js:718`); at most 64 open streams per socket, 4 sockets per person
  and 1 MiB per reassembled message, fragments included; a malformed frame or a duplicate stream
  id closes the socket with 1008, as DSH does (`src/stream-server.ts:196, 241`); a ping every 2
  seconds, and the socket is closed after 2 missed (`lib/index.js:301, 717`). DSH's own downlink
  queue for forwarded events is unbounded (`lib/index.js:1438-1446`) and fills before the carrier
  sees a frame, so the carrier drains every stream into a bounded queue per caller, independently
  of socket writes, bounds unsent bytes and write delay, and on overflow aborts DSH's iterator and
  closes the reader. A stream whose backlog cannot be bounded that way is not carried.
- **Cancellation.** A client's cancel ends only its logical stream, as DSH's does
  (`src/stream-server.ts:227-229`). A socket close, the Peer's release or the end of the person's
  gate session ends every stream on the socket. The gate keeps the socket in its table and
  destroys it when its session family is revoked or expires (delivery 1 (#1892),
  `server/gate.mjs:118, 375-377, 408-410`). That table holds upgrades only, and an HTTP response
  is piped apart (`:337-347`), so the gate also tracks its caller HTTP proxies, the SSE feed
  included, and aborts them on revocation, renewal, expiry and rollback. Feeds are bounded per
  person too, across gate families: at most 4 at once and one budget of pending bytes, released
  on disconnect (today each feed queues up to 512 events of its own,
  `apps/bots-dsh/src/host/feed.js:20`).
- **Withdrawn Bots.** From 5d the caller routes track each open feed by gate session family and the
  Bots it was allowed for. When a Bot or part stops being readable, the affected feeds end and
  their queued frames are dropped. The feed checks access before each event it sends.
  Bound native streams follow the same withdrawal rule in 5e. The mux passes `resourceKey` to
  both the frame projection and the stream withdrawal predicate.
  For `session/follow` it is the Session ID from the DSH open's `args.request.address`, using
  `childSessionId` for a subagent address. The carrier requires a nonempty string of at most
  512 UTF-8 bytes, and DSH authorizes the same open arguments before the projection sees a
  frame. The person's byte budget covers the key until the stream settles and its last frame
  is released. Global streams such as `workspace/follow` have an undefined key and carry
  resource IDs in their frames.
- **What it loses.** The public `wireStream.open` takes no control handle and no uplink window
  (`lib/types/types.d.ts:95`), so the carrier has no per-stream uplink backpressure beyond its
  inbox. That matters for terminal input only, which delivery 5 refuses.
- **Parity.** A test drives the rebuilt carrier with DSH's own Node client
  (`dsh-api-gateway/client`) on the calls the member view makes, and compares the frames with
  DSH's mux on the same calls.

*Rejected:* importing the gateway's compiled mux server (`RemoteStreamMuxServer`,
`lib/index.js:303`), which no export names, so any DSH patch can break it silently; and waiting
for DSH, against the owner's 2026-11-15 direction.

**The upstream ask, in RFC 0023's form.** One export from `dsh-api-gateway`: its mux server as a
public entry point (a `./stream-server` export of `RemoteStreamMuxServer`, with
`handleUpgrade(req, socket, head, peer)` and its options), or a
`wireStream.serve(req, socket, head, peer)` that runs DSH's own mux on a plugin's upgrade route.
Names are suggestions for DSH's maintainers. *What we remove when it lands:* the rebuilt carrier
and its parity test; the limits above stay as options. It is a dependency to ask for, not a
blocker: delivery 5 ships with the rebuilt carrier.

### One `automagik` policy, owned by multiuser-dsh

multiuser-dsh registers the only policy for the `automagik` kind, resolves the effective role, and
owns every role's action list and condition. It registers an empty policy (no bindings) in 5b,
before it dispatches any caller HTTP or stream traffic, and keeps it for its life: a failed
registration (another plugin's policy came first) or a lost one closes member admission and their
open streams. Through 5d the policy stays empty (the owner's delegate, 2026-11-20). No native
method, stream or forwarded event is bound for members or guests, who read through the Bot UI's
caller routes in 5d. 5e binds `am:bot-session-prompt`. A native read is bound only once its fields,
cost and withdrawal are proven safe.

bots-dsh is the designated provider. In 5c and 5d it supplies only Bot visibility facts through
`automagikCaller` version 2. The adapter checks the facts, builds no native bindings and returns
an empty visibility set if the provider throws. Session and workspace ownership facts take
effect with delivery 5e. The adapter builds any native bindings from those facts.

Session ownership needs provenance. During a period when Bots ran as DSH's uid,
both the team file's record of a Bot's parts (`bot.segments`, indexed at
`apps/bots-dsh/src/host/store.js:765`) and DSH's own Session files were writable by Bots, so neither
vouches for the other. Parts from such a period stay owner-only, and a Bot shared with members
starts a clean part once the isolation holds; members see its chat from that part on. A later loss
of isolation applies the same rule again. Until delivery 3 attests the isolation, the host
trusts no record from before the current DSH start. Every start resets `people`, readable
parts are kept in host memory for that start only, and every share begins with a new part that
the host creates. Real members are admitted only with delivery 6. In 5e, a provider that
throws makes the native policy decision `policy-failed`, a denial
(`dsh-api-remote-access/lib/index.js:228, 233`). Plugins run in the same process and are
trusted code the owner installed; this interface keeps a mistake in one from widening a role, not a
hostile plugin from patching another. The roles follow LiveShare's non-owner policy, the template
for a second principal kind (`dsh-experimental-liveshare/lib/index.js:6760-6850, 7038`, registered
at `:8000`):

- `am:global` (global, delivery 5e): `session/control` and `workspace/follow`. Native `session/list` is a
  unary read whose rows carry each session's summary projections (its pending inbox, permission
  and model values included). The stream filter below cannot filter a unary result, so the
  method stays unbound. The caller routes serve a visible Bot's readable parts. A unary native
  read can be bound only when every field it returns is safe for the caller.
- `am:bot-session-read` (session, delivery 5e): on a visible Bot's own chat sessions, only the
  native methods, arguments, event names and result fields listed and verified in 5e, including
  the actions above (DSH checks them per session too, `dsh-api-session-controller/lib/index.js:3988-3992, 4271-4291`,
  and `dsh-api-workspace-controller/src/index.ts:207-210`), and `session/follow` never with
  `activate: true` (it starts the Agent, `src/web/controller.ts:62`). A native result can carry
  fields the caller may not see (`session/control` sends each visible session's whole projection
  block, `src/control.ts:62-66`, with its permission value and model selection) or come to carry
  hidden content later (a Bot-to-Bot exchange's turns, which the chat projection drops,
  `apps/bots-dsh/src/host/parts.js:2131-2132`, arriving in a followed session). So the carrier
  passes every frame of a bound stream, the opening snapshot included, through bots-dsh's caller
  projection before the socket; a method whose output cannot be filtered that way is not bound
  and its content comes through the caller routes. Never bound: a room's, an aside's or a side
  conversation's session, and a session whose hidden-turn record is incomplete (it keeps the last
  400 turns, `apps/bots-dsh/src/host/turns.js:447`).
- `am:bot-session-prompt` (session, delivery 5e): `session/prompt`, with a condition on its arguments: a
  nonempty, queued prompt to the visible Bot's current chat session, of text and images the
  caller staged; steering (`mode: 'steer'`), an empty retry or continuation, a write to an older
  part and a file receipt not verified as the caller's and that Bot's are refused
  (`dsh-api-session-controller/lib/index.js:892-900, 924-933`; receipts resolve against the
  Agent, `:906`). The condition and the staged-image limits apply to every invocation, RPC
  included. DSH records the caller's principal on the prompt (`:4150-4155`); the pre-step check
  above checks it again before the turn runs. The grant stays unbound until 5e.
- `am:bot-workspace` (workspace, delivery 5e): `workspace/follow` on a workspace holding a visible Bot's
  session.
- `am:terminal`: a reserved name, bound by no one in delivery 5.

Never bound: cancel, fork, rename and queue edits, `job/*`, `settings/*`, credentials and every
workspace write. bots-dsh signals the adapter to invalidate on every team save that changes a
Bot's `people`, its sessions, its main flag or its existence.

The native session and workspace reads specified for 5e return a Bot's working folder path
(the session header's `cwd` or the workspace's `path`). A member allowed on a Bot sees that path.
Its files stay behind the member wall (§ 4).

### The Bot UI's routes for a caller: `automagikCallerRoutes`

From 5d, bots-dsh provides `automagikCallerRoutes` version 1:
`{version: 1, match(path, method)}`, where `match` returns `handler(request, principal, peer)` or
nothing. The carrier asks it only for the method and path pairs in the role-path fixture below,
before `api.fetch`: a match runs the caller-aware handler with the verified principal and the
caller's Peer; anything else goes to DSH, where an exact route stays 403 for a non-owner. With
the service absent, the carrier behaves as delivery 1. On `POST /api/omni-ui`, a member or guest
may call, by endpoint:

- `whoami` (new): the caller's display identity and effective role;
- `list-bots`, `get-bot`: visible Bots only, in a reduced view (no instructions, model,
  permission or `people`);
- the team state, built per caller from visible Bots (never the owner's full state, nor its side
  cards, side conversations, rooms or notices, `channel.js:205-211`);
- `chat`, `earlier`: the readable parts of a visible Bot's own chat, its users' and its own
  messages only. Card answers, cards, tool calls, side cards and hidden exchange turns stay
  private. The host reads the page without resuming a Session;
- from 5e, `stage-image`, `send`: on a visible Bot. A staged image is bound to its caller and Bot, bounded
  in count and bytes per person, and checked again on send (today staged images sit in one map
  for the process, `channel.js:98-99, 990-1006`). The prompt goes through the gateway's `invoke`
  of `session/prompt` with the caller's Peer, so the policy decides and the Session log records
  the author;
- from 5e, `answer-question`, `view-reply`, `dismiss-question`, `dismiss-view`: only on a card whose
  recorded person is the caller.

Every other endpoint is refused to them. Until 5e the six writes (`stage-image`, `send`,
`answer-question`, `view-reply`, `dismiss-question`, `dismiss-view`) are refused too, and so is
`thinking`. The feed (`GET /api/omni-ui/feed`) is filtered per
caller: the hello without the notice cursor (`feed.js:120`), content-free revision and live
signals, and the message and stream events of visible Bots' readable parts. Generated images, gen-UI
media, pets and the Code routes stay owner-only, and `/api/omni-mcp` is refused to every role in
multiuser mode. In front, the gate keeps a URL-level role filter as the second fence: a member or
guest reaches only the paths in one fixture, `server/test/fixtures/caller-role-paths.json`, that
the gate's, the carrier's and bots-dsh's tests share (as delivery 1's
`caller-frontend-paths.json`). With multiuser on, the gate sends `Cache-Control: no-store` on every
response that is not a static frontend file, so a browser shared by two people never replays
owner-only media (cached a day or an hour today, `channel.js:1334, 1348`) or another caller's
content without a new decision. What a browser kept from before is cleared too: when a different
person signs in on a browser, and at the first sign-in after multiuser is enabled, the gate
answers with `Clear-Site-Data: "cache", "storage"`, which also drops composer drafts (DSH keeps
them in the browser's storage under the session id alone,
`dsh-client-ui-conversation/src/client/stores.ts:43`).

### Who may talk to a Bot: the `people` field

One optional field on a Bot's record in the team's `state.json`:

```text
people: { mode: 'owners' | 'allowlist' | 'workspace', allow: [{ issuer, subject, role }] }
```

- A missing or unreadable field is `owners` (fail closed). `workspace` is refused for a main Bot.
- `allow` names people by `(issuer, subject)` among those the gate has admitted to this instance
  (Q4). The owner's editor offers the identities the adapter has verified since it started
  (`automagikCaller` version 2, `seen()`, read by the owner only, kept in memory, never written)
  and those already on the list; before delivery 6 admits real people, fixtures supply verified
  identities. `role` records the role they were added under, for display; the authority is
  always the role in the current assertion, so a guest stays a guest.
- The per-Bot terminal and Code grants are not in this field yet: delivery 4 specifies their
  entries (identity, target Bot, the current-member check and revocation). A positive grant needs
  both delivery 4's member runner and delivery 5's policy and a caller-aware Code route; until
  both exist, terminals and Code mode stay refused to members.
- Only the owner sets it, through `update-bot`. A Bot actor is refused, as for its browser grants,
  deny list, shell and privacy (`apps/bots-dsh/src/host/roster.js:648-661`), and it is not one of
  the agent route's Bot fields (`agent-access.js:15`).
- It lives in the team's existing file: no new storage prefix, the format stays version 2
  (`store.js:11`), and a build that does not know the field keeps it as it reads the file
  (`store.js:224`).
- Before delivery 3 a Bot's shell runs as DSH's user and can write that file. So every time DSH starts with
  multiuser on, until delivery 3 attests the boundary, every `people` field is reset to `owners`
  with an empty list and earlier parts stay owner-only (above), and the owner grants again once
  the boundary holds (a step of "Migration and rollout"'s checks before members are
  enabled).

### Agent access stays refused in multiuser mode

The earlier amendment refused agent access in multiuser mode until delivery 5 specified a scoped
agent policy. Delivery 5 specifies none: in multiuser mode the gate's MCP route refuses agents on
HTTP and upgrade (delivery 1 (#1892), `server/gate.mjs:269, 367`), and so does the plugin's
direct listener, which calls the same refusing handler (delivery 1 (#1892),
`apps/bots-dsh/src/host/agent-access.js:367, 383-386`). A scoped
agent policy needs its own amendment. Owner-only mode keeps its agent route.

### What delivery 5 leaves out, and what stays outside this repository

Left out, each refused rather than half-offered: member and guest prompting, card answers and
staged images (5e). The positive terminal and Code grant (the
refusal ships now; the grant takes effect with delivery 4, #1406's member runner), so #1373's
terminal and Code clause waits for delivery 4; approvals (Q2); rooms, side conversations and
Bot-to-Bot exchanges (Q3); stop, cancel and steering (RFC 0024 (f)); generated images, gen-UI
media and pets, which a member's chat shows as unavailable; Bot admin, settings, credentials and
schedules; agent access.

Outside this repository: real member and guest sign-in, delivery 6 (the Cloud admission still
admits only owner and admin, `server/gate-cloud.mjs:45, 177`); Cloud's people directory (RFC 0024
(e) and its delivery 5), which can later fill the same `allow` entries; the isolation review.

### Contracts this amendment introduces

All additive; no route, plugin id or storage prefix that exists today is renamed or moved.

- **The `automagik` policy**, registered by multiuser-dsh alone, with the role names above.
- **`automagikCaller` version 2**: version 1's fields, plus `roleOf(principal)`, `visibleBotIds(principal)`, the
  Bot visibility provider hook, `invalidate(principal?)` and `seen()` (owner only).
  `verify(request)` (an owner-path author) follows in 5e.
  bots-dsh reads `current()` at version 1 or 2; what needs version 2 refuses on version 1.
- **`automagikCallerRoutes` version 1**, provided by bots-dsh: `match(path, method)`.
- **The private stream route** `/_automagik/caller/api/remote.mux`, under the carrier's existing
  private namespace, and the gate's one member upgrade path, `/api/remote.mux`.
- **The `people` field** on a Bot's record, version 2 of the team file kept.
- **A card's recorded person** (from 5e), on the question and view cards bots-dsh already saves.
- **The `whoami` endpoint** on `/api/omni-ui`, and the reduced Bot view for a caller.
- **The role-path fixture**, `server/test/fixtures/caller-role-paths.json`.

### Deliveries for this amendment, in order

5b-5d are each one pull request on the plugin lane (the gate ships in the server image), in this
order; each refuses what the next one has not delivered. Each is verified on fixtures; a workspace
accepts members only after delivery 1's image follow-up installs and verifies the adapter, its key
mount and its body limit (until then the server image refuses to start with multiuser on,
`server/profile-multiuser.mjs:6-12`, `server/entrypoint.mjs:118-127`). Delivery 4's positive grant
needs all of delivery 4's runner, this policy, a caller-aware Code route and the current per-Bot
grant.

*Narrowed by the owner's delegate on 2026-11-20 (option B).* 5c ships the read model and every
refusal. 5d exposes the reads to members and guests. Their prompting is 5e, which starts from a
DSH capability asked in RFC 0023's form or one certified route.

- **5a. This amendment** (docs). *Check:* the index row matches; `git diff --check` clean.
  *Rollback:* revert the docs.
- **5b. The stream carrier** (multiuser-dsh and the gate). *Unlocked by:* delivery 1. *Check:* a
  member's socket opens only on the exact path and with a valid assertion, and its upstream
  handshake carries no DSH credential; a pre-registered private upgrade path refuses; the parity
  test passes against DSH's Node client; a client cancel ends only its stream, while a socket close,
  a revocation and an expiry end every stream; the 65th stream, the 5th socket, an oversized message
  and a duplicate stream id are refused; a slow reader is closed; a member's `$events` gets no
  pending event and cannot answer; with no policy yet, no business call or policy-filtered
  notification succeeds (the access snapshot and the ready frame are the exceptions); a policy
  registered first by another plugin, or lost, closes member admission; a sign-out with an open feed
  ends the feed; after the adapter unloads, a handler registered on its path receives no member
  connection. *Rollback:* stop member and guest admission, revoke their sessions and close their
  sockets and feeds, then remove the route; the gate refuses member upgrades again, as delivery 1.
- **5c. The policy, the `people` field and the member read model** (multiuser-dsh and bots-dsh). *Check:* the role
  table on fixtures of each role and of mixed roles (`guest` with `member` is a member; `owner` with `member` takes
  the gate's owner path and is refused at the carrier); a guest sees an allowlisted Bot and not an ungranted one,
  also while another family of the same person is a member; a member sees a "workspace" Bot, and a main Bot only
  through its allowlist; an unreadable `people` is owner-only; a Bot actor's, the agent route's, a create's or a
  duplicate's `people` is refused; every start resets a planted grant and no Session from before it is readable;
  sharing refuses a Bot with queued input, an open card, an active goal or running work, and opens a fresh part
  that carries nothing; members read only from it on, without card answers, cards, tool calls or hidden exchange
  turns, and never a part a Bot-to-Bot message entered; a read never resumes a Session; an outside edit of the team
  file only narrows; every installed DSH method and forwarded event is denied to a member and a guest, the access
  snapshot grants nothing and `$events` sends only its ready frame; every Bot UI exact route answers them 403, and
  every Bot UI endpoint but the six reads is refused by name (settings, credentials, Bot admin, approvals, stop and
  cancel, rooms, side conversations, agent access, sending, cards, staged images); both mixed versions of
  `automagikCaller` and bots-dsh fail closed; with multiuser off nothing changes. *Rollback:* stop member and guest
  admission and close their streams and feeds, then revert; the `people` field stays, unread with multiuser off.
- **5d. The member view, the filter and the people row** (bots-dsh and the gate). `automagikCallerRoutes` serving
  5c's reads, the caller-aware `/api/omni-ui` reads and feed, the gate's URL filter, the read-only member and guest
  client mode, and the owner's "who may talk to this Bot" row (multiuser only); `client.js` rebuilt. *Check:* a
  guest lists an allowed Bot and not an ungranted one; a member's forged URL reaches no terminal, Code route or
  setting; a member's send, card answer, staged image and every other write is refused before any handler runs;
  the feed, `earlier` and the state carry no card answer, side card, room, notice or content of an invisible Bot
  or an unreadable part; a feed open when its Bot is withdrawn or its part closes sends nothing more; a fifth feed of
  one person is refused; an owner-only image URL is not served from the browser cache after the account changes; a
  different person's sign-in on a browser clears the owner's unsent draft; with multiuser off the Bot UI and the
  owner's composer are unchanged. *Rollback:* stop member and guest admission, revoke their sessions and close their
  streams and feeds first, keeping the gate's deny rules; then remove the service and the row. Delivery 5 is
  complete with 5d, which completes #1373; the positive terminal and Code grant takes effect with delivery 4.
- **5e. Member and guest prompting** (a later delivery; the owner's delegate, 2026-11-20). *Scope:* a member or
  guest sends in a visible Bot's chat (`am:bot-session-prompt`, the caller routes' `send` and `stage-image`) and
  answers or dismisses the cards of their own turns, and every human input to a shared Bot carries a verified
  author, the owner's included, under the rules marked "from 5e" above: **Authored** and the pre-step check with
  its quarantine, **What the model sees**, **A turn a member or guest started**, the card's recorded person and the
  drain in "Rollback"; questions 5-8 below take effect with it. *Unlocked by:* 5d and either a DSH capability asked
  in RFC 0023's form (DSH itself enforces each input's author and a caller-scoped guard over each turn's tools,
  model route, compaction and recovery) or one certified route whose whole turn a test proves caller-safe, every
  other route refusing member prompts. *Check:* specified with it; at least a demoted, revoked or withdrawn member's
  queued or continuing work never reaches a model step or a tool; a member-started turn's model request holds no
  hidden content, MEMORY.md or recall; two admins' posts in a shared chat carry two authors and an owner's post
  without one never reaches a model step; a card answers only to its person; the rollback drains member-started
  work with a turn running and a prompt queued. *Rollback:* stop member and guest admission and drain
  member-started work, then revert; members read as with 5d.

### Threat model additions

- **A member reads a Bot they were not given.** Visibility is computed per call from the `people`
  field and the current assertion's role. The caller routes and feed apply that rule in 5d, and
  the native bindings apply it in 5e. An unreadable field is owner-only. Withdrawing a Bot ends
  its open feeds and, from 5e, its bound streams.
- **A member reads the owner's history on a shared Bot.** By design (Q1), only on a Bot the owner
  allowed them on; the owner decides per Bot. Rooms, asides and exchanges with other Bots stay
  out.
- **A member reaches hidden content through the model** (from 5e). A part whose model context holds content
  the chat hides takes no member or guest prompt; unary native reads are bound only when every
  field is safe.
- **A member acts in someone else's turn.** Steering, retries, stop and cancel are refused. From 5e, cards
  answer only to the person whose turn raised them.
- **A stale grant.** A `people` save invalidates access and ends affected feeds and, from 5e,
  bound streams. Revocation or expiry closes the session's sockets and feeds. From 5e, queued
  input runs only on the gate's decision for its own session family, asked at the step.
- **Stream exhaustion.** The per-stream inbox, the stream, socket and message limits, the
  downlink and heartbeat bound one person's load. Feeds and, from 5e, staged images also have
  per-person bounds.
- **A plugin widens the policy.** Only multiuser-dsh owns the role lists; bots-dsh supplies
  facts, which the adapter checks; a foreign policy for the kind closes member admission.
- **A Bot grants itself to people.** `people` is refused from a Bot actor and from the agent
  route. The reset withdraws grants saved before the boundary. Sessions from before this start
  stay owner-only, and outside edits can only narrow access. Delivery 3 takes the file out of a
  Bot's reach.
- **A member's turn reaches past its chat** (from 5e). The Bot's tools check the initiating person: no
  stopping other turns, no rooms, no relays, no Bot administration from such a turn.
- **A forged author** (from 5e). An author is a verified principal, from the carrier's or the owner path's
  assertion; a post to a shared Bot without one is refused.

### Rollback

Each delivery reverts alone, in reverse order, and each revert refuses more, never less: before any
of them is reverted, member and guest admission stops, their sessions are revoked and their sockets,
streams and feeds close, and the gate's deny rules stay; and, from 5e, before a prompt, authorship or tool
guard is removed, Bot dispatch stops, member- and guest-started work that is running finishes or is
cancelled under its existing restrictions, and its queued and delegated work is quarantined, across
a restart too (the RFC's Bot drain, applied to that work). Then without 5d members see nothing,
without 5c DSH answers no member business call (the empty policy stays), and without 5b the gate
refuses member upgrades. The `people` field stays in the team file, unread with multiuser off.
Turning multiuser off is the RFC's rollback ("Migration and rollout").

### Questions for the owner

Answered by the owner's delegate on 2026-11-20, each with the recommended option.

1. **The chat: the Bot's shared chat (recommended) or a chat per person?** Shared: RFC 0024 (f)
   already gives per-message authorship, and a per-person chat would split a Bot's context and
   memory per person. *Answered: the Bot's shared chat; the owner's readable history is visible only to the
   people the owner allows. Authorship per message starts in 5e (RFC 0024 (f)).*
2. **Approvals: owner-only in delivery 5 (recommended), or members answer their own turns'?**
   Owner-only: an approval lets the Bot act with its scope, which a member does not hold, and DSH
   gives pending events only to owner Peers. *Answered: approvals stay owner-only in this
   delivery.*
3. **Rooms and side conversations: owner-only in delivery 5 (recommended)?** They span Bots and
   carry other chats' context; their visibility needs its own rule. *Answered: rooms and the side
   conversations (btw, side) stay owner-only.*
4. **The allowlist: people by `(issuer, subject)` among those the gate admitted (recommended), or
   wait for Cloud's directory?** Now: it needs no new service and the pair is the principal's own
   identity; the directory can later fill the same entries. *Answered: by `(issuer, subject)`
   among those the gate already admitted, without waiting for Cloud's directory.*

5. **The Bot's MEMORY.md on a turn a member or guest started?** An entry from a hidden Bot-to-Bot
   exchange could reach the model request through memory. *Answered by the owner's delegate on
   2026-11-20: It stays out of every such turn. The owner keeps it. Takes effect with delivery 5e.*
6. **Automatic recall on a shared Bot's part?** Recall can add history that members cannot read.
   *Answered by the owner's delegate on 2026-11-20: The owner keeps recall. When it fires on a
   shared part, that part stops taking member or guest prompts and the owner opens a fresh part.
   Takes effect with delivery 5e.*
7. **Queued input whose author lost the Bot?** Replay needs a release callback, a destination after
   sharing again, card handling and idempotency across a restart. *Answered by the owner's delegate
   on 2026-11-20: It is quarantined. It never runs on its own, and its person can see it and send
   it again. Takes effect with delivery 5e.*
8. **The owner's composer on a shared Bot?** DSH's composer submits through `session.prompt` with
   no author. The shared composer gives up file attachments, `@`-references and steering.
   *Answered by the owner's delegate on 2026-11-20: The Bot UI's composer replaces DSH's on a
   shared Bot so every owner post has a verified author. Owner-only Bots keep DSH's composer.
   Takes effect with delivery 5e.*
9. **Member and guest prompting in delivery 5?** Reviews of a plugin-side design identified DSH
   paths the plugin does not own, including model routes with their own tools, compaction and
   fallback turns, inbox edits and forwards, continuing turns, renewals and the drain.
   *Answered by the owner's delegate on 2026-11-20: 5c and 5d give read access and every refusal.
   Prompting is 5e, which starts from a DSH capability asked in RFC 0023's form or one certified
   route.*

## Amendment (2026-11-20): a Bot's files and its commands live in two trees

Decided by the owner's delegate on 2026-11-20, as the first safe step; the owner may revise it.

Delivery 3 meets delivery 2 at a Bot's folder, and their ownership rules differ. The member wall
(delivery 2, #1906) gives a Bot's file tools, which run in DSH's process, one own folder `<bots
root>/<id>`: a real `0700` folder owned by DSH's uid. The member runner (#1406, Bot identity in
#1903) gives a Bot's commands a work area `<workRoot>/.bots/<id>`: a `0700` folder owned by the
Bot's own uid. One folder cannot be both.

**Decision: two disjoint trees.** A Bot's file tools work in `<bots root>/<id>` as DSH's uid, under
the wall; its commands run in the runner's area as the Bot's uid. Files do not cross between them:
what a Bot's command writes is not visible to its file tools, and the reverse. The image refuses
multiuser mode when the wall's bots root and the runner's work root are the same tree or either
holds the other (delivery 3's server part). The trade-off is usability, not safety: neither tree
gives a Bot a path to DSH's credentials or another Bot's files.

**Possible evolution, for the owner (not in this delivery).** One tree shared by group: each Bot's
area owned by the Bot's uid with a per-Bot group that DSH's uid belongs to (`2770`), and the wall
accepting that owner and group pair for the Bot's own folder. A Bot's commands and file tools would
then see the same files. It needs the runner to provision the group, the wall's own-folder rule to
change, and its own review of what DSH's group membership exposes.

## Open questions

Answered by the owner's delegate on 2026-11-20: Q1 as amended above, Q2-Q8 with the
recommendations.

1. **Where does the adapter live, and does it own `/api`?** **Recommendation (as amended
   2026-11-20):** a new `@automagik/multiuser-dsh` plugin beside `bots-dsh`, with a small
   `bots-dsh` row that reads the resolved caller; it admits on its own private carrier route, and
   the gate reroutes a member's or guest's `/api` to it, because DSH holds `/api` and its
   connection hook runs after the cookie admission. **Why:** the principal
   contract is shared by the Bot team, the file fence and the route filter; burying it in one
   plugin makes the next consumer wait on that plugin's release. Without the carrier, the gate
   sees only URLs, not the RPC methods inside `/api/remote.mux`, and #1373 cannot be met. The
   owner's 2026-11-15 direction already puts the work in Automagik. *Answered, as amended: the
   adapter lives in `@automagik/multiuser-dsh` and admits on its private route; DSH owns `/api`,
   and the gate reroutes to the adapter.*
2. **One uid per Bot, or one uid for a workspace's Bots?** **Recommendation:** one uid per Bot in
   Cloud, bounded by the plan; one uid for all Bots only on a single-owner desktop, where the OS
   user is already the documented limit. **Why:** a shared Bot uid lets one Bot read another
   Bot's files and vendor homes; per-person Bots do not exist, because a Bot has autonomous
   turns. This is the owner's call because it sets the Cloud plan's uid budget. *Answered: one uid
   per Bot in Cloud.*
3. **Does an owner talking to a Bot elevate it?** **Recommendation:** no; the Bot's scope caps
   every turn, and the owner's own interface is where owner actions happen. **Why:** the first
   exception reopens "a Bot obtains the owner's rights" for the owner's own Bot, which is the
   exact path the #1374 probe reproduces. If the owner wants a Bot to work on an owner-only root,
   the owner grants that root to that Bot explicitly. *Answered: no elevation.*
4. **May a Bot read a member's own area?** **Recommendation:** never; a member's turn adds the
   member's scope, but the intersection still gives the Bot no member area. **Why:** #1389's fence
   is per person; a Bot reading a member's area would make every shared Bot a reader of every
   member's files. The member moves a file to the Bot's workspace to share it. *Answered:
   never.*
5. **Does the launch file move, or do Bots get their own uid?** **Recommendation:** give Bots
   their own uid and keep the file where it is; if a platform cannot provision uids, the
   workspace stays owner-only (as amended 2026-11-20: moving the token alone does not admit
   members).
   **Why:** the uid change also bounds a Bot's command from another Bot and from the gate's
   store; the token move alone leaves a same-uid Bot able to read DSH's other secrets. This is
   the owner's call for Arca's per-Bot uid provision. *Answered: Bots get their own uid; as
   amended, a token move alone keeps the workspace owner-only, because a same-uid Bot still reads
   DSH's other credentials.*
6. **What happens to an owner-only install that turns the Bot principal on?**
   **Recommendation:** a one-time migration that makes each existing Bot's current workspace its
   own directory and asks the owner to grant any shared root it needs; no Bot starts as owner
   after the switch. **Why:** silently keeping owner for existing Bots would leave the hole open
   for exactly the Bots people already have. The owner decides when to run it, per instance.
   *Answered: the one-time migration, run by the owner per instance.*
7. **Is the stable instance id enough for #1426, or does it need a project id?**
   **Recommendation:** enough; #1426 keys reservations on the instance id, which is the workspace
   id in Cloud; a reservation's project is a display label only (RFC 0024 (n)); a self-hosted or
   desktop instance uses RFC 0024's instance id. #1426's reservation
   record and its cross-machine sharing are out of scope here. **Why:** a second "project id"
   would need its own contract and would drift from the workspace id the token already carries.
   This is the owner's call if Cloud's project and workspace ever differ. *Answered: enough;
   RFC 0024's 2026-11-20 amendment, (l), fixes the id.*
8. **When does a member join?** **Recommendation:** only after deliveries 1-5 and the isolation
   review pass, with #1373's role filter and #1374's probe both green. **Why:** RFC 0024 (f) and
   Decided 26 say owner-only until all three safeguards hold, and one open path (a terminal, an
   ACP agent, a Bot shell) makes a member owner-equivalent. This is the owner's scheduling call.
   *Answered: only after deliveries 1-5 and the isolation review.*

## Links

- #1372, #1373, #1374: the three safeguards. #1374's probe and diagnosis are on its branch, not
  in this repository.
- #1389: the member wall's read fence; its tests are the acceptance floor.
- #1406: the member runner; deliveries 3 and 4 extend its identity to a Bot.
- #1426: the per-vendor shared/reserved account record; out of scope here, settled by RFC 0024's
  2026-11-20 amendment and keyed on its instance id.
- [RFC 0024](0024-automagik-cloud.md): (b) the principal, (c) the gate and the launch token,
  (d) the desktop, (f) the three safeguards, (g) hosting; Decided 21 and Decided 26.
- [RFC 0015](0015-live-chat-projection.md): the caller `principal` in the Session log.
- [RFC 0014](0014-shared-bot-registry.md): the Bot registry id `bot:<id>` uses.
- [RFC 0011](0011-monorepo-parts-and-releases.md): lanes.
- [The isolation review](../cloud/0024-isolation-review.md): the same-uid finding this RFC closes
  for Bots.
- [The 0024 evidence record](../cloud/0024-delivery-0-evidence.md): what the gate and DSH do
  today.
