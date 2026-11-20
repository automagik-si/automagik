# RFC 0038: Cloud multiuser safeguard: the caller principal, and no Bot can forge it

| Field | Value |
|---|---|
| Status | Queued |
| Milestone | none (ships outside the five milestones) |
| Lanes | plugin (3.N.P); the gate and the server image |
| Created | 2026-11-20 |

> Refs #1372, #1373, #1374, #1389, #1426. Builds on [RFC 0024](0024-automagik-cloud.md) (b), (c), (f),
> Decided 21 and Decided 26. Amends nothing.

## Summary

Inside one Automagik Cloud workspace, DSH and its plugins will learn which person made each call,
from a principal the gate authenticates and signs, and no Bot will act as that person or as the
owner. A Bot gets its own principal, `bot:<id>`, with its own scope and no owner rights; the
owner's own interface stays `owner`. The read fence #1389 delivered for members is kept as the
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
`x-automagik-principal` on the browser and WebSocket hops (`server/gate-upstream.mjs:48-55`). The
header has one consumer in this repository, the vault-unlock refusal
(`apps/bots-dsh/src/host/channel.js:1423`): it checks only that the header is present, refuses the
unlock when it is, and neither authenticates the principal nor covers `/api`. The DSH floor this
repository pins (`0.2.2-rc.2`) consumes it nowhere. The gate mints DSH's owner cookie from DSH's
launch token (`server/gate-upstream.mjs:31-41`), so every person arrives at DSH as its owner.

The probe on #1374's branch shows the consequence in five steps: a member is fenced by #1389's
read rule, but a Bot session is recorded owner
(`apps/bots-dsh/src/host/member-wall/principals.js:42-49`), so DSH's real `read` tool returns the
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
| gate → DSH | DSH's launch token exchanged for DSH's owner cookie | DSH knows only "the owner"; the unsigned `x-automagik-principal` is never authority (one refusal checks its presence) |
| DSH core / plugins | one shared browser Peer with owner principal | every call is the owner's |
| Bot session, in process | a session-id record; a Bot session is written `owner` | the wall's owner branch lets it read anywhere (`paths.js:153-156`) |
| Bot command | DSH's OS user (`server/Dockerfile:165`) | the file and the wall are outside its view |

Three facts complete the picture:

- **The gate's principal is real but stops at the gate.** `server/gate-cloud.mjs:208-227` verifies
  issuer, audience, subject, roles, workspace and expiry; `gate-store.mjs` keeps it per session;
  `server/gate.mjs:288,312` proxies with it and sets the header. One downstream reader exists,
  the vault-unlock refusal named above; it checks only the header's presence, never its value,
  and covers no `/api` route, so the principal still stops at the gate.
- **DSH's native identity is owner-only for browsers.** DSH 0.2.2-rc.2, the floor this repository
  pins, has a merge-extensible `PrincipalMap`, in-process Peers with a fixed principal,
  remote-access policies, and a caller `principal` on `session/prompt` for non-owner callers
  ([RFC 0015](0015-live-chat-projection.md):742-745). But the browser Web carrier admits one
  shared owner Peer; no browser request reaches DSH with a non-owner principal today.
- **The wall's record has no writer.** #1389 reads `{version, sessions}` from a `0600` file
  owned by DSH's user (`principals.js:17-49`); the only writer named is "the owner's side", and
  no production code writes it. Unknown, malformed, open or missing records already fail closed
  to a member with no area. A Bot is the exception only because its session is recorded `owner`.

So the answer to "where does the principal come from today" is: it is made in the gate (the Cloud
service or the local claim), authenticated there, and goes no further. DSH and the Automagik host
have no channel. That is the gap #1372 names.

## Design

### 1. The gate signs one assertion; the adapter inside DSH trusts only that

The gate stays the only authenticator. It keeps the principal v1
`{issuer, subject, roles, workspace}` exactly as RFC 0024 (b) froze it; this RFC adds no field to
that value and changes no existing route or plugin id. For every request it forwards to DSH, the
gate also sends a **caller assertion**: a compact signed statement

```text
{ version: 1, principal, session?, instance, method, path, iat, exp, nonce }
```

signed with Ed25519 by the gate's assertion key, with `aud` the instance id, a lifetime of at most
60 seconds, and a binding to one request's method and path plus a single-use nonce the adapter
remembers for that lifetime. The private key lives in the gate's own store, on the gate's own
volume; DSH never mounts that volume
(`server/compose.gate.yml:33-35,8-9`). The public key is public: the adapter fetches it at DSH start
and refetches it when the assertion names a key id it does not have, and a Bot reading it gains
nothing.

Inside DSH, an Automagik host adapter (`@automagik/multiuser-dsh`; § "Deliveries") does four
things:

1. **Admits.** The adapter owns `/api` as the composition's carrier: the gate keeps its `/api`
   route, the adapter admits and dispatches to DSH's shared Fetch handler, and DSH's default
   browser carrier does not also claim `/api`. The owner cookie alone is not a member path. The
   adapter verifies the assertion at admission (its `/api` route and the WebSocket upgrade),
   using DSH's native `connection/request` hook where the composition keeps it. A WebSocket's
   principal is fixed at admission and a frame cannot change it.
   Missing, invalid, expired, replayed, wrong-audience or wrong-method/path assertions are refused
   401 when multiuser is on. The assertion travels in `x-automagik-caller`, which the gate builds
   after it has stripped every browser header; a bare `x-automagik-principal` is never authority
   and the header stays a debugging hint.
2. **Creates the caller's DSH Peer.** It declares one additive DSH principal kind,
   `{ kind: 'automagik', instance, person: {issuer, subject, roles, workspace}, bot? }`, and
   dispatches the request with a DSH Peer created for that principal through DSH's own
   `createPeer` / shared Fetch handler. DSH's native remote-access policies then see a non-owner
   caller, and, once delivery 5 registers the `automagik` kind's resource and role policy, they
   answer by that principal's role. `session/prompt` records the caller in the Session log where
   DSH already supports it. The owner's own interface keeps the owner principal and reads as
   before.
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
Peers with a fixed principal, a request hook, and remote-access policies. If DSH later ships an
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
  `{issuer, subject, roles, workspace}` from the assertion: owner, admin, member or guest.

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
  `0600` in it and the gate reads it read-only, as today, but a Bot uid cannot open it. If a
  platform cannot provision per-Bot uids, the token moves to a gate-only mount or a
  peer-credential-checked socket before members are admitted; that closes the same step without
  also bounding one Bot from another.

If the runner cannot switch to the Bot uid, it refuses (`125`) rather than falling back to DSH's
uid. That is what makes the OS half fail closed.

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

- **The caller registry (new).** The authority is the gate's session store, on the gate's own
  volume, keyed by instance id and session id, holding the principal, roles and expiry, with its
  own memory of assertion nonces. DSH never writes it; a Bot never mounts it. The Automagik
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
- **Instance id**. For a self-hosted or desktop instance, RFC 0024's random local id in the owner
  record; for a Cloud workspace, the workspace id. Random, made once, never derived from a host,
  home or machine name. This RFC creates no second id.
- **No change** to the RFC 0024 principal v1, to the meaning of `x-automagik-principal` (it stays
  an untrusted hint; the assertion is what is trusted), or to any route path, plugin id or storage
  prefix that exists today. `/api` keeps its path; the adapter becomes its carrier.

## The stable instance/project id, and #1426

#1426 asks for a non-secret record that a subscription account is shared, or reserved to one
instance or project. That record is **out of scope here**: it is a vendor-account reservation, not
a caller identity, and it does not need a second id. It must key on the instance id above and on
**per-vendor evidence**:

```text
{ vendor, account, organisation?, generation, instance, updatedAt }
```

`account` is the opaque identifier the vendor's own CLI reports; an email may be a display label,
never the key or a credential. `organisation` is present only where the vendor reports it;
`generation` is the ACP generation id
(`cli-generations.js:136-159`); `instance` is the id above. Claude may omit an organisation and
Codex does not distinguish a personal from a team workspace (the #1426 comment records both);
that is evidence quality, not a new identity. The reservation record, its shared location and its
sign-in refusal belong to #1426's own RFC. This RFC fixes only the id and the evidence shape that
RFC may rely on.

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
  the old scope. A person's browser session is re-established by the gate on the next request; an
  owner is signed as owner, a member as member.
- **Missing principal.** A missing, unreadable, malformed or open record, or a session with no
  entry, is a member with no area, never owner. A missing or invalid assertion is `401` before any
  tool, file read, search, skill or route. An adapter that is off while multiuser is on is a
  configuration error: the composition refuses to start, rather than falling back to owner
  silently.
- **Rollback.** Turning multiuser off returns DSH to its owner behavior and owner-only admission.
  It cannot undo a file a Bot already read while the mode was on, and it does not change the
  image's OS identities. A Bot's `bot` record remains, and a later re-enable reuses it.

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
   verifies it, creates the caller's DSH Peer and puts the caller into the turn scope. It also
   becomes the composition's `/api` carrier, so DSH's default browser carrier does not answer a
   member directly. No Bot or role behavior yet; non-owner DSH calls stay default-deny until
   delivery 5 registers their policy. *Unlocked by:* RFC 0024 (c)'s gate and DSH
   0.2.2-rc.2's `connection/request`, `PrincipalMap`, Peer API and shell-owned carrier; no Cloud
   service needed. *Check:* a valid assertion admits and attributes the caller; missing, expired,
   replayed, wrong-audience and reused-nonce assertions are 401; the owner's own interface is
   unchanged; a forged bare `x-automagik-principal` is ignored. *Rollback:* remove the adapter;
   the gate keeps only the header, which no code treats as authority.
2. **Bot principal and the file fence** (plugin, 3.N.P). `bot:<id>` sessions, the v2 record, the
   Bot branch in `paths.js`, and DSH's data home and the launch file denied to Bots by default.
   *Unlocked by:* delivery 1 and the Bot registry. *Check:* the #1374 probe, with its Bot session
   declared a Bot as the adapter declares it, flips `bot-read` to CLOSED while `member-read`
   stays FENCED; the three OS steps (`bot-shell`, `gate-credential`, `bot-owner-rights`) wait for
   delivery 3. A known Bot session is never owner whatever its record says; the adapter is the
   record's writer, and delivery 3 adds the OS boundary that stops a Bot writing it; the #1389
   member tests are unchanged. *Rollback:* turn the setting off; Bot sessions return to today's
   owner behavior.
3. **Bot OS identity and command path** (plugin and server image, 3.N.P). One uid per Bot in a
   Cloud workspace, its HOME/XDG/TMPDIR, the runner's Bot identity, DSH's data home `0700`. The
   launch file stays DSH-uid `0600`, or moves to a gate-only mount or a peer-credential socket if
   uids cannot be provisioned. *Unlocked by:* the image and Arca's per-Bot uid provisioning, the
   member runner's (#1406) template and the server image split (RFC 0024 (g)); no Cloud
   application code. *Check:* the probe's `bot-shell`, `gate-credential` and `bot-owner-rights`
   flip to CLOSED; a Bot command cannot open the launch file, the gate store or another Bot's
   directory; the runner refuses `125` rather than fall back. *Rollback:* revert the image; the
   owner-only limit returns.
4. **Member and guest commands** (plugin, 3.N.P). Members use the member runner (4c, the
   `bots-dsh` shell row); a terminal or Code grant is per Bot, owner-granted, and runs under the
   member's uid. *Unlocked by:* delivery 3 and #1406. *Check:* a member's command runs as the
   member uid and cannot read the owner's data; a guest is refused a terminal and Code mode;
   #1389's read fence is unchanged. *Rollback:* turn the grant off; the member keeps file tools
   only.
5. **Role-filtered DSH routes** (#1373) (plugin, 3.N.P). The gate refuses URL-level routes by
   role, and the adapter's Peer plus DSH's native remote-access policies answer method-level calls
   by the caller's role: guests only allowlisted Bots and never terminals, Code mode or settings;
   members terminals or Code only when granted per Bot; stop and cancel owner-only. *Unlocked
   by:* delivery 1 including the adapter's `/api` carrier, and Cloud's role table. #1373 stays
   open if only the assertion ships. *Check:* the role table; every route and WebSocket
   without a session is 401; a member's forged URL cannot reach a terminal; a guest cannot reach
   settings. *Rollback:* revert to owner-only admission; members stay off.
6. **Cloud enablement** (Cloud service, outside this repository). Members and guests are admitted
   only after deliveries 1-5 and the isolation review pass; the workspace switches from
   owner-only to the role table. *Unlocked by:* the Cloud service's workspace token, role
   database and revocation (RFC 0024 (e), (g)), the Arca per-workspace VM, and the isolation
   review gate; none of it is in this repository. *Check:* a member signs in end to end, sees only
   its Bots, and cannot reach the owner's files, terminal or Code mode; a guest sees only
   allowlisted Bots; revocation ends the session. *Rollback:* the gate returns to owner-only
   admission; no data moves.

## Open questions

1. **Where does the adapter live, and does it own `/api`?** **Recommendation:** a new
   `@automagik/multiuser-dsh` plugin beside `bots-dsh`, with a small `bots-dsh` row that reads
   the resolved caller; it owns `/api` as the composition's shell carrier. **Why:** the principal
   contract is shared by the Bot team, the file fence and the route filter; burying it in one
   plugin makes the next consumer wait on that plugin's release. Without the carrier, the gate
   sees only URLs, not the RPC methods inside `/api/remote.mux`, and #1373 cannot be met. The
   owner's 2026-11-15 direction already puts the work in Automagik.
2. **One uid per Bot, or one uid for a workspace's Bots?** **Recommendation:** one uid per Bot in
   Cloud, bounded by the plan; one uid for all Bots only on a single-owner desktop, where the OS
   user is already the documented limit. **Why:** a shared Bot uid lets one Bot read another
   Bot's files and vendor homes; per-person Bots do not exist, because a Bot has autonomous
   turns. This is the owner's call because it sets the Cloud plan's uid budget.
3. **Does an owner talking to a Bot elevate it?** **Recommendation:** no; the Bot's scope caps
   every turn, and the owner's own interface is where owner actions happen. **Why:** the first
   exception reopens "a Bot obtains the owner's rights" for the owner's own Bot, which is the
   exact path the #1374 probe reproduces. If the owner wants a Bot to work on an owner-only root,
   the owner grants that root to that Bot explicitly.
4. **May a Bot read a member's own area?** **Recommendation:** never; a member's turn adds the
   member's scope, but the intersection still gives the Bot no member area. **Why:** #1389's fence
   is per person; a Bot reading a member's area would make every shared Bot a reader of every
   member's files. The member moves a file to the Bot's workspace to share it.
5. **Does the launch file move, or do Bots get their own uid?** **Recommendation:** give Bots
   their own uid and keep the file where it is; if a platform cannot provision uids, move the
   token to a gate-only mount or a peer-credential-checked socket before enabling members.
   **Why:** the uid change also bounds a Bot's command from another Bot and from the gate's
   store; the token move alone leaves a same-uid Bot able to read DSH's other secrets. This is
   the owner's call for Arca's per-Bot uid provision.
6. **What happens to an owner-only install that turns the Bot principal on?**
   **Recommendation:** a one-time migration that makes each existing Bot's current workspace its
   own directory and asks the owner to grant any shared root it needs; no Bot starts as owner
   after the switch. **Why:** silently keeping owner for existing Bots would leave the hole open
   for exactly the Bots people already have. The owner decides when to run it, per instance.
7. **Is the stable instance id enough for #1426, or does it need a project id?**
   **Recommendation:** enough; a Cloud project is the workspace and the workspace id is the
   project id; a self-hosted or desktop instance uses RFC 0024's instance id. #1426's reservation
   record and its cross-machine sharing are out of scope here. **Why:** a second "project id"
   would need its own contract and would drift from the workspace id the token already carries.
   This is the owner's call if Cloud's project and workspace ever differ.
8. **When does a member join?** **Recommendation:** only after deliveries 1-5 and the isolation
   review pass, with #1373's role filter and #1374's probe both green. **Why:** RFC 0024 (f) and
   Decided 26 say owner-only until all three safeguards hold, and one open path (a terminal, an
   ACP agent, a Bot shell) makes a member owner-equivalent. This is the owner's scheduling call.

## Links

- #1372, #1373, #1374: the three safeguards. #1374's probe and diagnosis are on its branch, not
  in this repository.
- #1389: the member wall's read fence; its tests are the acceptance floor.
- #1406: the member runner; deliveries 3 and 4 extend its identity to a Bot.
- #1426: the per-vendor shared/reserved account record; out of scope, keyed on the instance id.
- [RFC 0024](0024-automagik-cloud.md): (b) the principal, (c) the gate and the launch token,
  (d) the desktop, (f) the three safeguards, (g) hosting; Decided 21 and Decided 26.
- [RFC 0015](0015-live-chat-projection.md): the caller `principal` in the Session log.
- [RFC 0014](0014-shared-bot-registry.md): the Bot registry id `bot:<id>` uses.
- [RFC 0011](0011-monorepo-parts-and-releases.md): lanes.
- [The isolation review](../cloud/0024-isolation-review.md): the same-uid finding this RFC closes
  for Bots.
- [The 0024 evidence record](../cloud/0024-delivery-0-evidence.md): what the gate and DSH do
  today.
