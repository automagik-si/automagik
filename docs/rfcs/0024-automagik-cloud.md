# RFC 0024: Automagik Cloud

| Field | Value |
|---|---|
| Status | Accepted (2026-11-10, by the owner; council review 2026-11-09: proceed with conditions, folded in; owner's answers: identity and billing, 2026-11-09; isolation, identity stand-up, hosting, the goal and Q18, 2026-11-10; Chat: Decided 19-25, 2026-11-09; amends RFC 0008; amended 2026-11-09 by [RFC 0025][25]; (f)'s machine-link rule: amendment proposed by [RFC 0022][22]'s (l), Q17, 2026-11-10; Invitations by project accepted by the owner, 2026-11-12, Decided 27; instance id, account evidence and reservations (#1426): amendment approved by the owner's delegate on 2026-11-20, questions 1-5 answered with its recommendations) |
| Goal | First goal (owner, 2026-11-10): by 23 Nov, the owner signs in and opens one hosted workspace in test mode, with no real charges: RFC 0024 deliveries 0-4 and RFC 0025 phase A. |
| Milestone | none (ships outside the five milestones) |
| Lanes | none here (docs); desktop (3.N) for secure storage, sign-in and the rail; the server image and plugin (3.N.P) for the self-hosted gate and the web rail; the Cloud service in its own private repository in the owner's organisation (its contracts stay public here) |
| Created | 2026-11-09 |

## Summary

Automagik has two identity models, and plugins see one principal from either.

- **Self-hosted** (open source, free): one instance, one human. A web instance or the server
  image is claimed by its owner on first run, with a one-time code shown only on the host, and
  then signed in with passkeys that an Automagik gate in front of a loopback DSH checks itself.
  No account and no outside service. The desktop app's own local DSH keeps the trust it has
  today (the OS user and a per-launch token on loopback) and asks for no passkey. Nothing
  self-hosted calls Cloud.
- **Automagik Cloud**: our sign-in for customers, companies with people or individuals who
  invite others. A single new identity service (a self-hosted Pocket ID, an OpenID Connect
  provider with passkeys) serves Cloud and only authenticates; Tactu may move to it later, while
  Arca keeps its own sign-in. Cloud's own database holds organisations, members, roles,
  invitations and the workspace rail, keyed by issuer and subject, never by email. Each workspace
  is a hosted instance with its own Bots,
  people, Omni channels, data and terminals; a rail lists them and its `+` creates one, on the
  web and on the desktop. Until three safeguards exist ((f), "Before anyone but an owner
  joins"), a Cloud workspace is for its owners only.

This RFC decides the principal contract, the claim and its recovery, the origin rules, the
desktop's sign-ins (RFC 8252, with secure token storage first), Cloud's organisations and
invitations, the rail by entitlement rather than a fork, which Bots each person may talk to,
where workspaces run, how Cloud users reach the identity service, what is paid, how a
self-hosted instance may be linked to Cloud, and the phases. It amends RFC 0008 (its web sign-in,
its desktop client, its questions 2, 6 and 7 and its threat model). The owner answered two
questions on 2026-11-09: the identity service is one new instance for Cloud, which Tactu may join
later (Decided 13, corrected 2026-11-10: Arca keeps its own sign-in), and billing is Stripe
directly, agentic payments included (Decided 14). On 2026-11-10 the owner decided the isolation
unit, the identity instance's stand-up, where Cloud runs, the first goal and the owner-only line
(Decided 15 to 18 and 26); Automagik Chat settled the low-stakes questions (Decided 19 to 25).

## Motivation

Owner direction (2026-11-09, verbatim): "now we need to brainstorm about automagik cloud, which
will allow creating new projects workspace, and even having the left bar. the open source will
not have it multi instance this way, its free for one instance. web or desktop, as is... how
would we do it? first of all human authentication, i want to use the same id system im using for
tactu and arca", then: "cloud login system is on ssh server > tactu project and arca", then:
"i want to do 2 things out of this. 1. each self hosted automagik is claimed and authenticated
on self hosted instance, for one human, and the automagik cloud is out authentication system for
our customers, which will be companies with people, or individual who might also invite other
humans".

Today:

- **A self-hosted web instance has a bearer link, not an owner.** The server image (`server/`,
  `server-image.yml`) runs the `automagik-web` profile bound to loopback inside its container,
  behind DSH's token fence, and writes the launch URL, token included, to a `0600` file on the
  volume. Whoever holds that URL is in: no person, no passkey, no way to end one session.
- **The desktop app trusts its OS user.** It starts a local DSH and opens it with the launch URL
  DSH prints. Any process of the same user can already read that token and the window's cookies,
  as RFC 0022's threat model records. A passkey there would add a prompt and no protection.
- **RFC 0008 ("Platform and web instances", Queued)** recommended any standard OIDC provider the
  instance owner configures (its question 2), and one instance at a time, never local and remote
  together (questions 6 and 7). The two models here change all three; this RFC amends it.
- **The left bar mockup (v7, private, not in the repository)** puts a rail of workspaces at the
  far left: only workspaces, "Add workspace" and the person; the bar beside it has four modes
  (Pulse, Team, Channels, Routines). Nothing draws a rail today.
- **Other people are out of scope so far.** RFC 0022 left "other people in the view (teams of
  humans, an instance rail)" to its own RFC (its Decided 7), with Buzz's author gate as the
  model. This is that RFC for people and the rail.
- **Tactu already signs people in** through the identity service it uses today, as a plain OIDC
  relying party: authorization code with PKCE, `state` and `nonce`, a person keyed by issuer and
  subject, sliding sessions with rotation and reuse detection, and a setup code that only the
  host's command line can mint. Its notes also show the limits of the deployed Pocket ID: flat
  groups, signup links that are bearer links not tied to an email, and one full-admin API key
  with no narrower scope. Its waitlist work decided how outsiders reach the identity service (a
  public edge, below).

## Decided

From the owner (2026-11-09, above):

1. **Two identity models.** A self-hosted instance is claimed by its one human and authenticated
   on the instance. Automagik Cloud is the authentication system for customers: companies with
   people, or individuals who may invite other people.
2. **The open-source product is one instance, free**, on the web or the desktop, as it is. Cloud
   is where many workspaces, creating one, and the rail live.
3. **Cloud uses the same identity system Tactu uses, Pocket ID, on a new instance of its own**;
   Arca keeps its own passkey approvals (corrected 2026-11-10). See Decided 13 and 16.
   *Superseded for identity by [RFC 0032](0032-automagik-id.md): Automagik ID, not Pocket ID.*

From the council review (2026-11-09; five lenses, proceed with conditions; relayed by the
Automagik Orchestrator). Nine conditions, numbered 4 to 12:

4. **RFC 0008 is amended here, not bypassed**: its questions 2, 6 and 7, and its threat
   model's Authentication line (Amendments to RFC 0008).
5. **The claim covers web instances and the server image only.** The desktop's local DSH stays on
   OS-user trust with its per-launch token on loopback, with no claim and no passkey.
6. **Pocket ID only authenticates.** Cloud's database holds organisations, members, roles,
   invitations and the rail, keyed by `(issuer, sub)`, never by email. Authorization is checked
   on every request, never taken from group claims in a token.
7. **One principal contract**, `{ issuer, subject, roles, workspace }`, everywhere. Plugins never
   branch on which provider signed the person in.
8. **Authentication lives in an Automagik gate in front of a loopback DSH**, covering every route
   and WebSocket. No DSH runtime patch.
9. **Origins: `localhost`, or a stable HTTPS name.** IP origins are refused, with the reason.
10. **Recovery is out of the Bots' reach**, or the RFC says plainly that local sign-in does not
    guard against the instance's own Bots. It says both ((c), "What it does not guard").
11. **Desktop OIDC per RFC 8252, with secure token storage, ships first**, as its own delivery.
12. **Tenant compute isolation is its own review gate**, separate from identity.

From the owner's answers (2026-11-09, asked by the Automagik Orchestrator):

13. **One new identity service for Cloud.** A single new identity service (a
    self-hosted Pocket ID): Cloud uses it, and Tactu may move to it later, as its own project's
    decision. It is a new instance, not the one Tactu uses today. Isolation between products
    comes from a separate OIDC client and separate groups per product, and from Cloud's own
    database for organisations and roles. The owner gave the separate OK on 2026-11-10: it is
    stood up now, private at first with only the owner (Decided 16). Moving Tactu to it is its
    own work, later, and not a delivery of this RFC.
    *Corrected 2026-11-10 (Arca's orchestrator, via Automagik Chat):* Arca keeps its own sign-in
    (its own passkey approvals) and does not move to the new identity service.
    *Superseded for identity by [RFC 0032](0032-automagik-id.md): the identity service is
    Automagik ID, not a self-hosted Pocket ID.*
14. **Billing is Stripe, directly** (was open question 9), "including support to agentic payments"
    (the owner, verbatim). Cloud uses Stripe Billing itself, a subscription per workspace, and
    Stripe's signed webhooks update Cloud's entitlements; no other billing app. Agentic payments
    are a direction, to be detailed by a follow-up RFC ((i)).
    *Amended by [RFC 0025][25] (2026-11-09):* "being paid" is deferred; the inbound direction,
    Bots paying Cloud for Cloud's own resources, comes first, and outbound payments to
    third-party merchants wait for a legal review and their own RFC (0025, (j)).

From the owner (2026-11-10):

15. **Isolation unit: one Incus VM per workspace** (was open question 3). Never a privileged
    container; an unprivileged container only for the operator's own workspaces. The isolation
    review gate ((g)) reviews how it is built.
16. **The identity instance is stood up now**, private at first with only the owner, behind the
    owner's passkey (was open question 1). Its address, client ids and group names stay out of
    this repository.
17. **Cloud home: workspace VMs run on Arca's hosting, not on the build host; the Cloud service
    lives in a new private repository in the owner's organisation.**
18. **First goal by 2026-11-23: one workspace you can sign in to.** The owner signs in and opens
    one hosted workspace in test mode, with no real charges: RFC 0024 deliveries 0-4 plus RFC
    0025 phase A.

From Automagik Chat (2026-11-09; recorded 2026-11-10):

19. **IP-only LAN installs: no passkeys** (was open question 7). Use an SSH tunnel to loopback or
    pair a device from a session that is already signed in; no TOTP fallback without its own
    review ((c)).
20. **Moving a self-hosted instance into Cloud is a later, separate decision** (was
    open question 10); linking moves no data ((j)).
21. **DSH's authentication hook: the gate now** (was open question 11); propose an upstream hook
    later and move to it only once DSH ships one.
22. **Omni keeps its own sign-in outside** (was open question 12); behind the gate it takes the
    gate's principal with its own sign-in off ((k)).
23. **No external OIDC provider for self-hosters** (was open question 13); the principal
    contract leaves room for one later.
24. **Pocket is unchanged** (was open question 15): it pairs through Pocket Link's own keys,
    outside the gate; any phone sign-in to a web instance is a passkey of the same owner.
25. **The contracts are public; the service is private** (was open question 16). The base answer
    said the service starts private; the decision is now that it is private. The principal, the
    workspace token, the entitlements document and the rail's API are public here; the Cloud
    service is private.

From the owner (2026-11-10, Q18):

26. **Cloud workspaces stay owner-only until all three safeguards hold** (was open question 18):
    an unforgeable principal channel, role-filtered DSH routes and the launch token out of the
    Bots' reach ((f)). The narrower alternative, members and guests limited to Bots with no shell
    or file tools in the meantime, is not adopted: a Bot's tools change over time, and one
    mistake makes a member owner-equivalent.

From the owner (2026-11-12):

27. **Invitations are by project, in Cloud.** One invite system serves Automagik, Arca and
    later products. Staff mint and revoke; the owner hands over the link. Each invite works
    once and expires. Its record decides the project, never the link or message. Website
    sign-in and WhatsApp use the same redeem call. No code means no reply and no requests
    queue. Build this as Cloud's first service delivery, then add the WhatsApp consumer.
    This shares admission, not identity providers: Arca keeps its own sign-in (Decided 13).

Carried, not new:

- From RFC 0022: Decided 7 (other people follow Buzz's gate: owner-only by default, an allowlist,
  never "anyone" for the main bot, stop and cancel owner-only), kept as it is, stop and cancel
  included; its provenance rule; its threat model's same-user reach; delivery H's mask, which
  this RFC asks for on the desktop too ((d)).
- From RFC 0019: Arca's GitLab on the build host, and the root-equivalent risk recorded there.
- From RFC 0011: one version, lanes, two-slot key rotation.
- From Tactu's login and waitlist decisions (read-only): the host-only setup code; one-use
  invitations minted by the product; no general admin key of the identity service in a tenant's
  reach; a dedicated, allowlisted public ingress for the identity service.

Proposed here: everything else.

## Design

### Words

- **Instance**: one DSH runtime with Automagik's plugins and its own data.
- **Self-hosted**: an instance a person runs themselves: the desktop app's local DSH, or a web
  instance (the server image, or a host install). One human.
- **The owner** (self-hosted): the one human who claimed the instance, or, on the desktop, the OS
  user running it.
- **The gate**: Automagik's authentication front, in front of a DSH bound to loopback. It is the
  only thing a browser talks to.
- **Workspace**: one hosted instance in Cloud, with its own Bots, people, Omni channels, data and
  terminals; one tile on the rail. (RFC 0005's "workspace" is a folder inside an instance, shown
  as the repos base; the two never meet in the interface.)
- **Organisation**: a Cloud customer with people. **Personal account**: one Cloud person, who may
  still invite others into their workspaces. Every workspace belongs to exactly one of the two.
- **The Cloud service**: the control plane: accounts, organisations, memberships, invitations,
  entitlements and the rail; the only relying party of the identity service; mints workspace
  tokens. It runs no Bot.
- **The identity service**: the single new Pocket ID that Cloud signs people in with (Decided 13;
  corrected 2026-11-10: Tactu may move to it later, Arca keeps its own sign-in). Its address,
  client ids and group names are not written in this repository.
- **Principal**: who is acting, as plugins see it ((b)). Not DSH's own `principal` caller field
  (RFC 0015), which DSH writes only for a caller other than its owner; (b) says how they meet.

### (a) The product split: one codebase, the rail by entitlement

**Self-hosted is the product as it is, plus an owner on the web.** One instance, one human, every
plugin, the Herdr pack, am and Pocket. No account, no call to Cloud, no rail. In one plain
sentence, shown where a self-hosted owner looks for "invite": *one human per instance; to invite
people, use Cloud.* There is no hidden multi-user path in the free edition.

**Cloud is the same app, signed in.** No fork, no second build, no closed module in the client.

| State | What the person sees |
|---|---|
| Not signed in to Cloud (the default) | today's app, no rail; one "Sign in to Automagik Cloud" entry in settings that calls nothing until used |
| Signed in, no workspace entitlement | the same, plus the account and a "Get workspaces" link |
| Signed in, entitled | the rail: one tile per workspace, grouped by organisation; on the desktop a "This computer" tile first; `+`; the person's avatar |

**The rail is a view of the Cloud service's answer, not a gate.** Anyone can force the open client
to draw it, and that buys nothing: tiles come from the Cloud service, `+` is a request it grants or
refuses, and a workspace accepts only tokens minted for it. Every limit is enforced on the server.

**Where the rail is drawn.** On the desktop, by the shell, beside the bar: a tile switches the
window between this computer's local DSH and a workspace's origin (RFC 0008's "the desktop app as
a client", with the rail as its switcher). On the web, by the bots-dsh client inside each
workspace; a tile is a top-level move to that workspace's origin, which the Cloud session turns
into a silent sign-in. One renderer serves both, after mockup v7.

**This computer beside Cloud workspaces.** One tile is active, its name is in the window's header,
and nothing runs in two places at once; that keeps RFC 0008's concern (the person always knows
where the work runs) while changing its answer (Amendments to RFC 0008).

### (b) One principal contract

Every request a plugin sees carries one principal, whoever proved it:

```text
{ issuer, subject, roles, workspace }
```

| Where | `issuer` | `subject` | `roles` | `workspace` |
|---|---|---|---|---|
| Desktop, its own local DSH | `local:<instance-id>` | the owner record's local id | `owner` | the instance id |
| Self-hosted web instance, claimed | `local:<instance-id>` | the owner record's local id | `owner` | the instance id |
| Cloud workspace | the identity service's issuer | the person's subject there | from Cloud's database: `owner`, `admin`, `member` or `guest` | the workspace id |
| Self-hosted instance linked to Cloud ((j)) | the identity service's issuer | the owner's Cloud subject | `owner` | the instance id |

- A person is keyed by `(issuer, subject)`, never by email or display name.
- Plugins read the principal and never branch on how it was proved (OS user, passkey, OIDC). A
  check that needs "is this the owner" asks the roles.
- The gate (or, on the desktop, the shell) is the only place a principal is made. DSH and the
  plugins receive it from the gate, never from a header a browser can set.
- **The channel matters.** Today the gate can only reach DSH as DSH's owner, through DSH's launch
  token, so DSH and its own routes would see every person as the owner, and any Bot shell that
  reads that token is owner-equivalent. For one human (self-hosted) that is the documented limit
  of (c). For anyone else it is not enough: (f)'s precondition asks for a channel no Bot can
  forge, carrying the principal into DSH's own caller field (`principal`, RFC 0015) or an
  equivalent that DSH's routes filter on.
- **The owner record** holds a stable local id, made at the claim (or at the desktop's first
  run), plus an optional linked `(issuer, subject)` ((j)). Linking later rewrites nothing. A
  record written by a newer build never reads as "unclaimed" in an older one: a downgrade test
  pins it, because a downgrade that forgot the owner would reopen the claim.

### (c) Self-hosted web instances: the gate, the claim and passkeys

**Scope.** Web instances and the server image: anything a browser reaches over a network. Not the
desktop's own local DSH ((d)).

**The gate, not a DSH patch.** An Automagik-owned process in front of a DSH bound to loopback,
the shape `server/entrypoint.mjs` and Omni's UI front already have. It covers every route and
every WebSocket; a request without a session gets `401`, and `401` stays the healthy answer for
the image's smoke and health check. DSH and its token fence stay as they are, behind it. The gate
holds DSH's launch token on the server side; once the instance is claimed, the bearer launch URL
is no longer a sign-in path for a browser, a QR code or a file reader. If DSH upstream later
offers an authentication hook, moving to it is its own change (Decided 21). The gate checks
passkeys itself (WebAuthn, through a maintained server library such as SimpleWebAuthn, MIT,
pinned exact).

**The claim fails closed.**

1. Until claimed, the main gate binds only loopback and listens on its published address only
   after the claim. A same-namespace connector can still forward remote browsers to loopback,
   so `AUTOMAGIK_GATE_CLAIM` decides the actual claim boundary. `local` (default) serves the
   claim page/API only on a separate loopback bootstrap listener, default `127.0.0.1:3083`,
   configurable through `AUTOMAGIK_GATE_BOOTSTRAP_PORT`, never the main connector port 3082.
   Operators must never forward bootstrap through a public or tailnet connector; only host
   access or an operator's private SSH tunnel reaches it. Main-port claims return `404` even
   with a correct code. `remote` serves claims on the main listener for operators who deliver
   the code to the authenticated owner out of band: the 128-bit code is then the barrier.
   Wrong remote codes share at most 64 pending per-attempt delays outside the state queue;
   excess wrong attempts get `429` immediately without a timer, and disconnects cancel and
   release their delay. Check the code first: correct codes bypass the penalty limit and delay.
   Wrong attempts cannot drain a bucket that blocks the correct code. Log a count, never the code.
   Other unauthenticated workspace routes answer `401`. Host reset remains a `0600` local
   socket operation in both modes and restores the configured claim boundary, including when
   a connector continues forwarding the main listener after reset.
2. On first start the gate makes a claim code: 128 bits, single use, valid 15 minutes, kept only
   as a hash, compared in constant time, rate-limited. It is shown on the host console when the
   gate runs in an interactive terminal, else only written to a `0600` file in the gate's own
   store; in the image, with no terminal, stdout is the container's log, so the file is the only
   place. It is **never logged**, never sent over the network, never in a URL, and no page can
   read it. A code that expires is replaced only from the host side: the next start, or the host
   command of "Recovery", makes a new one.
3. The claim page takes the code (posted, never in a URL) and registers a passkey. The first
   claim wins atomically and cannot be replayed; a test pins that two concurrent claims leave
   exactly one owner. Every unauthenticated claim, sign-in and recovery ceremony is bound to
   a short-lived server-side pre-authentication session, carried by an `HttpOnly`, `Secure`,
   host-only cookie. Verification requires that same browser's session; challenges remain
   single-use and expire. Another browser cannot finish a copied ceremony id or response.
4. The claim offers a second passkey at once, and shows one-time recovery codes, stored as slow
   hashes.

**Signing in afterwards.** A passkey on the instance's own origin. The owner adds and removes
passkeys from settings. One human, several devices: a phone and a second computer are more
passkeys of the same owner, not more people.

**Origins.** Passkeys bind to a host name, and the browser allows them only in a secure context:

- **Loopback**: served as `localhost` (a valid passkey host; `127.0.0.1` is not).
- **LAN or remote**: a stable HTTPS host name.
- **An IP origin is refused** for enrolment and sign-in, with the reason on the page. There is no
  bearer-link fallback for IP-only installs. The supported paths are an SSH tunnel to loopback
  (RFC 0008's) or pairing a new device from a session that is already signed in. A TOTP-style
  fallback is not offered; it would need its own review.
- The gate pins the passkey host (RP ID) and checks the exact origin, port included. It records
  the host the passkeys are bound to and, when the host name changes, offers re-enrolment through
  a recovery code or the host reset.

**Sessions.** `__Host-` cookies, `HttpOnly`, `Secure` under TLS, `SameSite=Lax`, no `Domain`,
bound on the server to the origin they were made for. Short-lived and sliding, rotated on
renewal, a reused old secret revoking the family, a session list and "sign out everywhere".
**Every passkey change and every recovery revokes every session.** One limit, said plainly:
loopback cookies ignore the port, so a cookie can leak to any other loopback service (a dev
server a Bot started included), and a local process that holds it can replay it with any
`Origin` it likes; the origin binding does not stop that. On loopback, local processes are
inside the host's trust, as on the desktop.

**Recovery for a lost passkey.** No email reset (there is no email and no outside service).

- **A recovery code**: one use, logged, rate-limited like the claim, then straight to adding a
  passkey.
- **A host reset**: a command run by the host's operator. It talks to the gate only through a
  local socket or file, never HTTP; it removes every passkey and session and starts a fresh claim,
  with the gate back on loopback only until that claim.

**What it does not guard: the instance's own Bots.** The gate guards the instance against the
network. Bots run commands on the same host, and in today's server image as the same user as DSH
(the image has one `USER 1000:1000`).
A Bot led by a page or a prompt could read DSH's launch token and call DSH on loopback as the
owner, or read the gate's store and the reset command, and so register its own passkey. Host-shell
recovery proves ownership only where the Bots cannot reach it. So:

- the gate runs apart from DSH: in the server image, as its own container sharing only the network
  namespace, with its store on its own volume that the DSH container never mounts (the gate reads
  DSH's volume read-only, for the launch token), and the reset command run in the gate's container
  by the host operator; on a host install, as a separate OS user; on other systems, behind a
  delivery-H-style mask (RFC 0022) once one exists there;
- DSH's own token stays reachable by its Bots until DSH or the sandbox (RFC 0010) masks it; that is
  outside this RFC.

Until both hold on a given platform, the gate's settings say it plainly: *sign-in protects this
instance from the network, not from its own Bots.*

### (d) The desktop: OS-user trust, secure storage and RFC 8252

**Its own local DSH: no claim, no passkey.** The app starts DSH on loopback with a per-launch
token and opens it, as today. The OS user is the owner: any process of that user can already read
the token and the window's cookies (RFC 0022's threat model), so a passkey would add a prompt and
no protection. The shell makes the principal `{ local:<instance-id>, <owner id>, owner, <instance>
}` and hands it to DSH over the process boundary, never a browser. If a launch token must reach a
window at all, it goes over IPC to the app's own host process, never as a URL a browser or QR code
can carry.

**Secure token storage, first.** Nothing in the app stores a secret securely today. Delivery 1
adds it through Electron's `safeStorage`: the Keychain on macOS, DPAPI on Windows, the Secret
Service on Linux. Where Linux has no secret store, `safeStorage` falls back to a fixed key; the app
detects that, keeps refresh tokens in memory only, asks for a sign-in at each launch and says why.

**Secure storage is not out of the Bots' reach.** It keeps tokens off plain files, not away from
the user's own processes. The desktop's DSH Bots run commands as the same user: on Linux, the
Secret Service and the `safeStorage` key answer any process of that user; on every OS, a
workspace's cookies sit in the app's own data folder. A local Bot led by a page could take the
person's Cloud session, with owner or admin power over every workspace. So **desktop Cloud sign-in
is off on an OS until a delivery-H-style mask exists there** (RFC 0022's delivery H, widened): DSH
Bots' commands run with the secret store, the session bus and the app's data folder masked, as H
masks hc and `~/.ssh`. Recommended: build the mask. The alternative, an explicit written owner
acceptance of the risk per OS, is recorded only if the owner chooses it (open question 17). The
same applies to a remote self-hosted instance's session held by the desktop.

**Sign-ins to anything remote: RFC 8252.** For Cloud and for a remote self-hosted instance, the
app never shows a sign-in page in its own window and never embeds a browser for it:

- it opens the system browser with the authorization code flow, PKCE (S256), `state` and `nonce`,
  and an exact loopback redirect, `http://127.0.0.1:<port>/callback`, on a port the app bound
  before opening the browser and closes after one request or a few minutes;
- it checks `state`, `nonce`, issuer and audience, and trades the code and verifier for tokens;
- a short access token stays in the main process's memory; the refresh token, rotated on each use
  (a rotated one presented again revokes the family), goes to secure storage; the page never holds
  either;
- against a remote self-hosted instance, the gate implements only this code exchange for its own
  owner, after a passkey sign-in in the browser;
- both servers (the Cloud service and a remote gate) accept any loopback port, as RFC 8252 (7.3)
  requires, and publish the same contract: discovery, the issuer, the audience, and who issues the
  ID token.

**The deep link was weighed and is not used for it.**

| | Loopback redirect (chosen) | Deep link (`automagik://`) |
|---|---|---|
| Who can catch the code | only a process that bound that exact port first | any app that registers the scheme; on Linux the last desktop entry wins |
| With PKCE | a caught code is useless without the verifier | the same, but a hijacked scheme still breaks sign-in |
| The link contract | unchanged | broken: `deeplink.js` says an `automagik://` link "only ever opens", because any page can fire it |
| Works where | every OS, no registration | packaged builds only |

`automagik://` stays open-only and never carries an authorization code.

### (e) Cloud identity: organisations, people and sign-in

*Note: the identity provider in this section is replaced by [RFC 0032](0032-automagik-id.md),
Automagik ID. Read "Pocket ID" and "the identity service" as Automagik ID. It has no admin
key and no groups, so the signup-link job and Cloud's groups below do not apply. Cloud's
authorization, roles and invitations stand as written.*

**Pocket ID authenticates; Cloud authorizes.** The identity service proves who the person is
(passkeys) and returns an ID token. The Cloud service is its one confidential client (its secret in
a `0600` file or a secret store), with PKCE, `state`, `nonce`, issuer and audience checks. From the
token Cloud takes `(issuer, sub)` and nothing else it trusts: an email the token carries is
self-asserted, so it is shown, never used as a key. Group claims are not used for authorization.
Organisations, members, roles, invitations, workspaces and the rail live in Cloud's own database,
and every request and every workspace session is checked against it.

**Organisations and personal accounts.** Every Cloud person has a personal account and may create
an organisation or be invited into one. A workspace belongs to one organisation or one personal
account and moves only by an owner's transfer.

| Role | What it may do |
|---|---|
| Owner | everything: billing and plan, delete or transfer the organisation and its workspaces, manage admins; at least one per organisation |
| Admin | people and roles below owner, create and delete workspaces, connect Omni channels, set model keys; no billing, no deleting the organisation |
| Member | the workspaces they are added to: the Bots the gate allows, their own work, the team |
| Guest | one workspace; only the Bots allowlisted for guests; no terminals, Code mode or settings |

Owners and admins see every workspace of the organisation; members and guests see the ones they
are added to. Someone an individual invites joins that personal account's workspace as a member
or a guest, never as its owner.

**Invitations are Cloud records.** Single use, with an expiry, revocable, and checked on the
server when accepted. Decided 27 and "Invitations by project" below define project admission.
An email may address an invitation, but membership binds to the `(issuer, sub)` of the person
who accepts it, never to the email. A WhatsApp redemption may precede sign-in; it grants no
workspace membership until identity is joined and the workspace's safeguards hold. For Cloud
sign-in, a person without an identity account needs one first. The identity service is Cloud's
(Decided 13), and Tactu may join it later, so its admin key reaches Cloud's accounts and, if
Tactu moves, Tactu's too; Arca keeps its own sign-in, outside it. Cloud's web tier never holds
it. A one-use signup link comes from a narrow, audited backend job in the operator's control,
which takes only "one
link, one use, Cloud's group, this expiry" and is never reachable from a workspace or a page.
Cloud's client and groups are Cloud's own, separate from Tactu's and Arca's, so an account made
for Cloud gets nothing in another product.

The organisation shows each member with the invitation they used, and an owner or admin can remove
them at once.

**On the web.** The Cloud service's pages sign the person in and keep a server-side session behind
a `__Host-` cookie on the Cloud origin, under the session rules of (c). Opening a workspace goes
through the Cloud service, which mints a workspace token for that one workspace ((g)).

**On the desktop.** RFC 8252, as (d) describes, against the Cloud service.

**Revocation is bounded for sign-in, not for what a shell left behind.** Workspace tokens live 5
minutes at most; refresh tokens rotate; the gate's own session lasts no longer than a workspace
token, or rechecks the role with the Cloud service when it renews. The Cloud service tells a
workspace to drop a person's sessions at once when they are removed or their role is lowered (a
signed call, with a poll of a revocation list as the fallback). So a removed person can no longer
**sign in** to any workspace within 5 minutes at worst, and at once when the call lands. That is
not the end of their reach if they had a shell: through a Bot with shell tools they could have
left a reverse tunnel over the workspace's internet access, a scheduled job or a copied secret.
Removing someone who had a shell is followed by rotating the workspace's secrets and reviewing its
processes, or by a restore from before they joined. "Sign out everywhere", and the identity
service's own end-session where its discovery document offers one; the Cloud session is revoked
either way.

### Invitations by project

Amendment accepted by the owner, 2026-11-12 (Decided 27). These are planned contracts;
this docs change deploys no service. Cloud owns the records for every product. Automagik ID
only proves identity. The cx WhatsApp receiver keeps no second invite database.

**Record.** Cloud stores `id`, `project`, `issuer` (the staff actor), `created_at`,
`expires_at`, nullable `used_at`, `used_by` (channel and verified sender or identity id),
`revoked_at`, and `code_sha256`. `used_by` and `revoked_at` start null. Times are UTC.
Only the canonical code's SHA-256 is stored, never the code or link. `project` is a fixed product key, initially `automagik` or `arca`;
staff may mint only for a registered project. Later, staff attach `workspace_id` for the
person's own compute and the verified `(issuer, subject)` identity binding. A workspace
must belong to that project. Neither field changes the original sender or project.

**Code and link.** Every product uses `INV-` plus eight random Crockford base32 characters
and one check character. The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Eight characters
give 2^40 possibilities; the check adds no entropy. Use a cryptographic random source and a
unique hash constraint. Upper-case and map O to 0 and I or L to 1 before checking and hashing.
The check is Luhn mod 32: from the rightmost data character, alternate factors 2 and 1,
sum each product's quotient and remainder on division by 32, then choose the alphabet index
`(32 - sum % 32) % 32`. `INV-7K2QX9MD4` passes; `INV-7KQQX9MD4` and `INV-K72QX9MD4` fail.
The normalized shape is `^INV-[0-9A-HJKMNP-TV-Z]{9}$`.

The link is `https://automagik.si/invite/arca#INV-7K2QX9MD4`. Its path labels the page for
the person. The fragment keeps the code out of an HTTP URL; the page sends it only in the
redeem POST, never in analytics, logs or a query. Opening the link does not consume it.
Cloud reads the project from the record alone. A changed path or product name in a message
cannot grant another project. The page uses the returned project for the next step.

**Three calls, owned by Cloud.**

- **Mint**, `POST /v1/invitations`: staff authentication, a registered `project`; a 201
  returns `invite_id`, `project`, `expires_at`, `code` and `link`, the last two shown once.
  The expiry is 14 days after creation. A member, guest, tenant Bot or public page cannot mint.
- **Revoke**, `POST /v1/invitations/{invite_id}/revoke`: staff authentication; 204, including
  a retry. It sets `revoked_at`. A used invite never becomes unused. Revoking an invite
  blocks redemption and its receipts; removing access already granted is a separate action
  through the product's access rules and Cloud's session revocation.
- **Redeem**, `POST /v1/invitations/redeem`: code, channel and who, with the channel's message
  or submission id. It returns the stored project or a refusal. The detailed contract is
  below. Cloud atomically consumes the code and stores the receipt; retries cannot consume
  it again. Mint and revoke credentials never reach the receiver or a browser.

**Identity after WhatsApp.** `payload.from` is an opaque sender id, including an `@lid` when
that is what the support instance supplies. Keep it exactly, scoped to the configured
instance; do not infer a phone number. At first sign-in, Cloud joins this admission to the
authenticated `(issuer, subject)` only after a short-lived, single-use linking challenge
proves control of that same WhatsApp sender. The signed-in session starts this Cloud-owned
proof flow; an authenticated callback verifies the sender's response. This attaches a Cloud
admission to one principal; it neither merges identity accounts nor enables phone sign-in.
An invite code, email, display name or typed sender id alone cannot attach an admission. A conflicting existing binding is
refused. Arca's own sign-in must prove its principal through a trusted product integration;
this does not move Arca to Automagik ID or widen another product's access.

**Admission and service.** A redeem admits the person to its project. It creates no workspace,
billing entitlement or member role. The owner provisions each person's compute and links it
later. Until the person's answer routing and file access are provisioned, admission gives
no answers from another person's compute. Existing hand-kept admissions need no new code.
Workspace membership still obeys (f), including the owner-only line in Decided 26.

**WhatsApp consumer, later.** An automation on the support instance matches an `INV-` code
in a `message.received` event and calls the cx receiver. The receiver checks the event, calls
Cloud redeem, and only on success writes the sender's allow rule. It records the rule by
`invite_id`, so a retry after an interrupted write makes no second rule. Only after the rule
exists does it return the retained welcome text as `{reply}`. The automation alone sends it,
with `send_message` content exactly `{{r.reply}}`; no other reply path exists. A refusal,
timeout or failed write gives no reply. The admission event is excluded from answer mode.

No code means no admission reply, no staff follow-up and no requests queue. It stores no
request for later admission. The support instance stays default-deny. The guard's revoke
command must delete only its hand-kept allow rules, never rules marked `invite:<invite_id>`.
The receiver has only the access-rule permissions it needs, never a Cloud staff key.

### (f) Workspaces, people and Bots

**One workspace is one hosted instance**: its own DSH, plugins, Bots and Bot registry, Omni and
channels, volume, terminals and herdr-core. Not a shared multi-tenant runtime. Nothing in one
workspace reads another's. A Cloud workspace never holds hc machine links to a member's own
computers (RFC 0014's "Other machines"); reaching a person's machines from a Cloud workspace is
out of scope. A self-hosted instance is not a workspace: it may hold its one owner's links to his
own computers, under RFC 0022's (l) (gated first, one human, delivery H's masks and scope, never
carried to Cloud). Amended 2026-11-10 by RFC 0022's revision (Proposed there, Q17; in force
once the owner approves it).

**Before anyone but an owner joins.** Inside a workspace, DSH sees whoever the gate sends as DSH's
owner, because the gate reaches it with DSH's launch token ((b)). Universal Bots have shell tools
by default, so a member or guest allowed to talk to one could have it read that token and call DSH
directly, as the owner: past the role table, past "no terminals" for guests. No member or guest
joins a workspace until all three hold:

1. **An unforgeable principal channel.** The principal reaches DSH and the plugins on a channel no
   Bot can forge (not the launch token on loopback).
2. **Role-filtered DSH routes.** DSH's own routes are filtered by role, at the gate or through a DSH
   hook (Decided 21).
3. **The launch token out of the Bots' reach.** DSH's token is masked from Bot commands.

**Until all three exist, Cloud workspaces are owner-only** (Decided 26): only the organisation's
owners and admins (or the individual of a personal account), who are owner-equivalent inside DSH
anyway. The roles, invitations and Buzz's gate below are built and tested behind that line, and
switched on for members and guests only when the three hold.

**Which Bots a person may talk to.** Buzz's author gate (RFC 0022), per Bot. In a workspace,
"owners" means the organisation's owners and admins, or the individual of a personal account:

- **Owner-only**: the default for every Bot, and for the main bot unless an owner widens it to an
  allowlist.
- **Allowlist**: owners plus named members or guests.
- **Anyone in the workspace**: every member; guests still need the allowlist. Never offered for the
  main bot (RFC 0022, Decided 7).
- **Fail closed**: a Bot whose gate cannot be read answers owners only.
- **Stop and cancel are owner-only**, whatever the mode, as RFC 0022's Decided 7 has it; a member
  cannot stop even a turn they started.
- **Provenance**: every message in a shared chat carries its author's principal (RFC 0022's rule,
  widened to named people); a Bot is told who wrote it, as data.

Terminals and Code mode are owners' by default; an owner may grant them to a member per Bot,
because Code mode is the raw terminal. Guests never get them.

### (g) Hosting: where workspaces run

**On Arca**, the Incus-based kernel the team runs (RFC 0010), on Arca's hosting, **not the
build host**, from the server image the release already builds, scans and smokes
(`server-image.yml`), with the gate of (c) in its Cloud mode: it accepts workspace tokens instead
of a claim. One image, no second one for Cloud. Each workspace pins the image by the digest the
release itself recorded, never `:latest` (RFC 0019 notes the published image is not signed), and
the Cloud service rolls releases one workspace first. The Cloud service itself lives in a new
private repository in the owner's organisation (Decided 17); only its contracts stay public here
(Decided 25).

**Interim sign-in for the first Cloud workspace.** Until delivery C2.3 (#909) provides
workspace tokens, an explicitly configured gate may verify Cloudflare Access application JWTs
and exchange them for its normal owner session. The operator first puts an Access policy for
the owner's exact e-mail on the public name, then adds the tunnel route to the gate. This is
owner-only access, with the existing gate session and DSH owner limitations, not Cloud roles or
membership. It is off without its team domain, audience and exact e-mail allowlist. Workspace
tokens supersede this interim mode; the private values remain on the host. See
[the server settings](../../server/README.md#interim-cloudflare-access-sign-in).

**The identity service and the first test workspace VMs** run in a restricted Incus project on
Arca's own hosting, operated by Arca; no host name is written in this repository.

**Builds stay where RFC 0019 put them** (GitHub Actions for the image; Arca's GitLab, on the build
host, for the Linux gates). The build host runs no workspace and holds no Cloud key and no
identity-service admin key: team agents run there, with the root-equivalent reach RFC 0019
records. On a workspace node, no agent account holds `incus-admin` or any group equal to root.

**Isolation is its own review gate** (Decided 12), before any outside person joins. The unit is
decided (Decided 15: one Incus VM per workspace); the gate reviews this shape:

- one Incus virtual machine per workspace, not a shared kernel, since each runs arbitrary commands
  for people other than the operator (Tactu's rule: any non-owner is a tenant, paying or not); an
  unprivileged system container only for the operator's own workspaces; never a privileged one;
- its own volume and network; the internet and the Cloud service's public key and revocation
  endpoints are reachable, the private network, the build host, Arca's control socket, the
  identity service's admin routes and other workspaces are not; reached only through the Cloud
  edge, on its own origin;
  *Amended by [RFC 0025][25] (2026-11-09):* the model gateway, including its quote route, is
  also reachable as a named Cloud route; the workspace's gateway token can call only that
  gateway (0025, (i)).
- its own secrets (model keys, Omni credentials, Bot secrets), valid nowhere else;
- CPU, memory and disk limits from its plan.

**Workspace tokens.** Issuer the Cloud service, audience one workspace id, the principal's
subject, roles and workspace, 5 minutes at most, signed with the Cloud service's key (two slots,
rotated as RFC 0011 rotates lane keys). The gate accepts only its own audience, checks the Cloud
service's published public keys, and sets its own session on its own origin. A token for one
workspace is refused by every other; the workspace holds no Cloud credential. A rail tile hands the
workspace a single-use code that the gate exchanges with the Cloud service on the server side,
never a token in a URL.
*Amended by [RFC 0025][25] (2026-11-09):* a Cloud workspace may also hold a scoped, short-lived,
revocable gateway token, minted per workspace or per Bot, and the control-plane identity that
renews it, held by the gate outside DSH's routes. The token can call only the model gateway,
never Stripe or Cloud's control plane. A per-Bot token is a budget and an attribution label, not
isolation inside the VM; the workspace's total grants and caps are the bound (0025, (i)).

**Backups.** Per workspace: scheduled snapshots of the volume, an encrypted copy off the host
under a per-workspace key the workspace never holds; a restore makes a new instance and keeps the
old one stopped until an owner confirms; a restore drill before the first outside person and then
on a schedule; deletion stops at once and destroys everything after a retention window shown to
the owner (recommended 30 days). The identity service and Cloud's database get the same: backups,
a restore drill, a documented break-glass admin.

### (h) Reach: the identity service off the private network

Today's identity service, the one Tactu uses, answers only on a private network. The new one
(Decided 13) is built for customers from the start, on the pattern Tactu's waitlist decided for
its outside adopters:

- **a dedicated ingress for the identity service only**, through its own tunnel, with an exact
  allowlist of host name, paths and methods (sign-in pages, signup-link pages and the OIDC
  endpoints a relying party needs); admin routes denied there and reached only from the private
  network;
- **never routed into a reverse proxy shared with other sites**;
- Cloud's own pages and the workspace origins on a public edge of their own; the Cloud service
  reaches the token endpoint over the private path.

Standing the new instance up, its ingress included, has the owner's OK (2026-11-10): it starts
private at first, with only the owner (Decided 16). Tactu's current instance stays as it is
until Tactu moves.

### (i) Billing and entitlements

**Free**: the self-hosted product, complete, one instance, one human; a Cloud personal account
with no workspace. **Paid**: hosted workspaces. Recommended: per workspace per month, seats
included up to a limit, model usage on the workspace's own keys at first (open question 8).
*Amended by [RFC 0025][25] (2026-11-09):* model access is free on the customer's own keys or
plan sign-in; managed tokens are an opt-in through Cloud's gateway at a published margin;
compute is metered from the host lifecycle (0025, (a) and (c)).

**Entitlements are the Cloud service's; the app only reads them.** A plan sets an organisation's or
a personal account's workspaces, seats and host size. The Cloud service refuses `+` and invitations
past the limits, returns the entitlements signed and short-lived so the app can draw the rail and
explain a greyed `+`, and stops a workspace whose plan ended only after a notice and a grace
period, keeping its data for the retention window.

**Stripe, directly** (Decided 14). Cloud uses Stripe Billing itself: a subscription per workspace,
seats as quantities. Stripe's signed webhooks, checked by the Cloud service, update Cloud's
entitlements; no other billing app sits between them, and no app or workspace talks to Stripe.
Card details stay with Stripe's own pages.

**Agentic payments: a direction, to be detailed by a follow-up RFC.** The owner asked for "support
to agentic payments": Bots paying, or being paid, on a customer's behalf through Stripe's
agent-payment features, within limits the human sets. A follow-up brainstorm on the economics
(from the owner's Tactu economic system) comes first. What this RFC fixes now: a Bot never holds a
Stripe secret key or a stored card; every limit (amount, merchant, period) is set by an owner and
enforced by the Cloud service, never by the Bot; every payment is recorded with the Bot and the
human who set its limit.
*Amended by [RFC 0025][25] (2026-11-09):* inbound first; outbound to third-party merchants is
deferred to phase E, after a legal review and its own RFC; the ledger, grants, caps and go-live
gates are in 0025.

### (j) How the two meet

**An unlinked self-hosted instance never calls Cloud**: no sign-in, licence check, telemetry,
heartbeat or entitlement fetch. Updates come from the release lanes (RFC 0011), which are not
Cloud. A test pins that neither the server image nor the desktop, unlinked and not signed in,
opens a connection to the Cloud service.

**Linking is the owner's explicit step** (a late phase, optional). From the instance's settings,
signed in with the local passkey (or, on the desktop, as the OS user) and then to Cloud, the owner
confirms. The instance then:

- accepts exactly one more principal: the owner's own Cloud `(issuer, sub)`, with the role
  `owner`; this is the only reason it ever talks to Cloud (to fetch the public keys that check
  that principal);
- keeps the local claim and passkeys as break-glass;
- gives no one else access: organisation members get nothing on it, its shell least of all
  (RFC 0022, Decided 7); sharing it later goes through Buzz's gate, owner-only by default;
- appears on the owner's Cloud rail as a "Self-hosted" tile that opens its own address.

Unlinking removes that principal and the tile and restores local-only sign-in. Linking never merges
accounts by email. **Identity does not move data**: importing a self-hosted instance into a Cloud
workspace is a separate step with its own decision (Decided 20).

### (k) Omni's own sign-in

Omni has its own: a passkey or a WhatsApp code on Omni's page, and one-time grants that
`omni://connect` carries (`deeplink.js`). With this RFC the product would have three sign-ins.
Boundary (Decided 22; Automagik Chat, 2026-11-09): Omni's sign-in stays Omni's,
for an Omni a person connects to from outside; inside a Cloud workspace or behind a self-hosted
gate, Omni's UI sits behind the gate and takes the gate's principal, with its own sign-in off, so
one person signs in once per instance.

## Amendments to RFC 0008

This RFC amends RFC 0008 (Queued); each amended line is marked there.

- **Summary, and Web instances (its two sign-in bullets).** Was: web instances sign in with OIDC.
  Now: a self-hosted web instance stays on loopback until claimed, then the gate signs its owner in
  with passkeys; OIDC is Cloud's ((c), (e)).
- **The desktop app as a client.** Was: a remote instance replaces the local DSH. Now: the local
  DSH stays, as "This computer", beside remote instances (question 7 below); remote sign-in is RFC
  8252 ((d)).
- **Contracts.** Was: an OIDC client registration for web instances. Now: none for self-hosted;
  Cloud's one client.
- **Threat model, Undo.** Was: revoke the OIDC client. Now: the gate's host reset, or a release
  without the gate, for self-hosted; revoking the client is Cloud's undo.

- **Question 2 (which sign-in provider).** Was: any standard OIDC provider the instance owner
  configures. Now: a self-hosted web instance signs its owner in with the local claim and passkeys
  through the gate ((c)); Cloud signs people in through Pocket ID ((e)). An optional external OIDC
  provider for self-hosters stays possible later through the principal contract, but is not
  planned (Decided 23).
- **Question 6 (several instances).** Was: one at a time, a switcher later. Now: the Cloud rail is
  that switcher, for a signed-in, entitled person ((a)).
- **Question 7 (local and remote together).** Was: no. Now: yes on the desktop, with "This computer"
  as the first tile and one tile active at a time ((a)).
- **Threat model, Authentication.** Was: "OIDC as above". Now: the gate in front of a loopback DSH
  on every route and WebSocket, with a passkey session after the claim, or a Cloud workspace token;
  the desktop's own local DSH on OS-user trust.

What stands in RFC 0008: `install.sh`, Windows builds, shell-like relays off until sign-in is
reviewed, tokens in the OS's secure storage, and TLS in front of anything off the machine (now in
front of the gate).

## Contracts introduced

All new; nothing existing is renamed or moved.

- **The principal** `{ issuer, subject, roles, workspace }`, version 1; `issuer` is
  `local:<instance-id>` or the identity service's issuer. A new field is additive; a changed
  meaning is a change to this RFC.
- **The owner record**: a stable local id and an optional linked `(issuer, subject)`, in the gate's
  own store (on the desktop, the app's own home), outside every Bot's folder. A newer record never
  reads as unclaimed in an older build. The instance id in `local:<instance-id>` is random, made
  once, never derived from the host, so two instances never share an issuer.
- **The gate** (server image and host installs): the claim page, passkey routes, session routes,
  the claim code's `0600` file, the host reset's local socket or file, its Cloud mode.
  Compatibility: an existing server-image deployment keeps its launch URL until its first start with
  the gate, which then stays on loopback until claimed. The image's health contract (only `401` is
  healthy) holds. DSH's token fence stays behind it, unchanged.
- **Desktop secure storage**: items under the app's name, one per Cloud account or remote
  instance. A downgrade leaves them unused; the Cloud service can revoke its own.
- **The loopback redirect** `http://127.0.0.1:<ephemeral port>/callback`, per sign-in.
- **`automagik://`** keeps its open-only contract; no authorization code is ever carried on it.
- **The workspace token**: issuer the Cloud service, audience one workspace, the principal, 5
  minutes at most; the Cloud service's public keys in two slots. Version 1.
- **The entitlements document**: signed, short-lived, version 1, additive.
- **The Cloud client** in the identity service: one confidential client and Cloud's own groups,
  separate from every other product's. Their ids, the secret and the group names are not in this
  repository; tests and default configs use placeholders.
- **Stripe**: Cloud's webhook endpoint and its signing secret, in the Cloud service only.
- **The desktop rail's state**: the active tile and order, in the app's own home.
- No new plugin id, route prefix or storage prefix in existing plugins.
- **The version 1 page**: [docs/cloud/contracts-v1.md](../cloud/contracts-v1.md) pins the
  principal, the owner record, the OIDC contract, the workspace token, the open code and its
  exchange, revocation and the entitlements document. Frozen at merge; later changes are additive
  only, with a version on each contract.

### Project invitation redeem, version 1

These additive contracts belong to Cloud and its cx consumer. They do not change the frozen
workspace contracts or [RFC 0027 D3b](0027-automagik-site-and-readme.md)'s waitlist endpoint.

**Cloud redeem.** HTTPS `POST /v1/invitations/redeem`, JSON only. Trusted consumers use
`Authorization: Bearer <INVITE_REDEEM_SECRET>`, compared in constant time. Each consumer has
its own rotatable credential, scoped to its channel and sender namespace; none can mint or
revoke. Website sign-in calls through its authenticated backend, with origin/CSRF checks;
the browser cannot assert who signed in or hold this credential.

```json
{
  "code": "INV-7K2QX9MD4",
  "channel": "whatsapp",
  "who": { "id": "<opaque sender id>" },
  "message_id": "<external message id>",
  "event_id": "<stable event id>",
  "received_at": 1794441600000,
  "message_at": 1794441600000
}
```

`channel` is `whatsapp` or `sign-in`. For WhatsApp, `who.id` is the exact `payload.from`;
the credential supplies its instance namespace. For sign-in, `who` is
`{"issuer":"<verified issuer>","subject":"<verified subject>"}` from the verified session,
`message_id` is a backend-issued submission id kept across retries, and `received_at` is
the backend's receive time. `event_id` and `message_at` are required for WhatsApp and absent
for sign-in. `message_at` is the parsed original message time in Unix milliseconds.
`project` is not a request field. The caller cannot select a different project for a code.

`received_at` is a finite integer in Unix milliseconds. As in RFC 0027 D3b, missing or
invalid time, or a time more than 120 seconds ahead, is 400. Accept only
`created_at <= received_at <= expires_at` and processing at or before
`expires_at + 180 days`, inclusive to the millisecond. Revocation always wins. The WhatsApp
receiver adds the stricter live-message guard below; the shared backlog rule does not admit
old WhatsApp messages. A sign-in backend stamps a new submission with the current time.

Cloud checks and reserves rate limits per caller, sender and code hash before a consume.
The single-use update and receipt are one transaction. Receipt keys are the authenticated
consumer namespace, channel and `message_id`, with `event_id` as a second WhatsApp key.
A receipt binds the normalized code hash, exact `who` and both original times. A changed
binding under either key is 409. A new message id for a used code is also 409. Concurrent
consumers cannot both win. Receipts contain no raw code, link, text or envelope. Keep them
through the processing window; expiry, revocation and timing checks apply to retries too.
An eligible identical retry returns the stored status and body, including a business refusal;
429 and 503 are transient and do not consume a code or reserve a final receipt. Refusal
receipts with no matching invite expire 180 days after the request's server receive time.

| Status | Body and meaning |
|---|---|
| 200 | `{"invite_id":"<id>","project":"arca"}`; first use or an identical eligible retry. |
| 400 | `{"status":"invalid_request"}`; malformed JSON, fields, code check or timestamp. |
| 401 | Empty body; missing or wrong Bearer. |
| 404 | `{"status":"unknown_or_expired"}`; absent, expired, revoked or outside the time window. |
| 409 | `{"status":"already_used"}`; used by a new message or a conflicting receipt binding. |
| 429 | `{"status":"rate_limited"}`; no consume. |
| 503 | `{"status":"unavailable"}`; missing configuration or store unavailable; no success. |

Wrong method is 405; wrong media type is 415. A failed checksum reveals no record state.
No response echoes the code, sender or identity. A project mismatch never silently becomes
access to the product named by the caller; the consumer must support the returned project
before granting that project's access.

**cx WhatsApp receiver.** HTTPS `POST /api/invitations/whatsapp-redeem`, JSON only (else 415).
Reuse RFC 0027 D3b's event envelope, headers, Bearer comparison and message-id replay rules:

1. `Authorization: Bearer <INVITE_RECEIVER_SECRET>` authenticates the automation. It is
   separate from the Cloud redeem credential and the waitlist secret. Missing or wrong is
   401 with an empty body. No per-event signature is added; the authenticated caller's
   receive time is trusted, as in D3b.
2. The body is Omni's unchanged envelope:

   ```json
   {
     "id": "<event id>",
     "type": "message.received",
     "timestamp": 1794441600000,
     "metadata": {},
     "payload": {
       "externalId": "<message id>",
       "chatId": "<chat id>",
       "from": "<opaque sender id>",
       "senderName": "<display name>",
       "content": { "text": "My invite: INV-7K2QX9MD4" }
     }
   }
   ```

   It also carries the original `rawPayload` age fields from Omni. Headers are
   `X-Omni-Event-Id` (stable across retries), `X-Omni-Delivery-Id` and Authorization.
   Require the event header to match `id`. A wrong type, malformed JSON, missing text,
   sender, message id or event id is 400. Take `received_at` from envelope `timestamp`,
   `message_id` from `payload.externalId`, and `event_id` from `X-Omni-Event-Id`.
   Delivery id never determines single use. The receiver accepts only its configured
   support instance. Unlike the waitlist's contact normalization, retain `from` exactly
   for the allow rule and identity binding; it may be an opaque `@lid`.
3. Extract one code anywhere in the text, case-insensitively; normalize and check it as
   above. No code is 204, no reply and no queue. More than one code is 400. The automation
   matches `[Ii][Nn][Vv]-[0-9A-Za-z]{9}`; the receiver does the authoritative shape and
   check-character validation. Neither the message's product name nor a URL path is trusted.
4. Before calling Cloud or returning a replay, drop with 204 and no reply when
   `metadata.ingestMode` is `history-sync`, `rawPayload.isHistorySync` is true,
   `rawPayload.key.fromMe` is true, or, on Baileys, `rawPayload.upsertType` is not `notify`.
   Require `rawPayload.messageTimestamp`; parse seconds, milliseconds or a protobuf Long.
   Missing or invalid message time is 400. Drop when either the message time or envelope
   receive time is older than ten minutes; more than 120 seconds ahead is 400. Both must
   be at or after the invite's creation. Cloud checks receive time; the receiver passes
   the parsed original message time as `message_at` on WhatsApp redeems so Cloud can also
   check it against `created_at`. Invalid `message_at` is 400; before creation is 404.
   This is the invite plan's age guard on top of D3b's timing contract, not a change to D3b.
5. After Cloud success and the allow-rule write, return 200 `{"reply":"<welcome text>"}`.
   An eligible identical retry returns that same retained text. Pass through Cloud's
   400/401/404/409/429/503 refusals without a reply field; an allow-rule failure is 503.
   Only a 2xx body with a nonempty `reply` permits the automation to send. A 204, non-2xx
   or timeout sends nothing. Check an existing invite receipt before the already-allowed
   shortcut, so an eligible retry still gets its original reply. A sender already admitted
   by another message or a hand-kept rule consumes no code and gets no new admission reply.
   The receiver itself sends no WhatsApp message.
6. Store only the admission/receipt fields, allow-rule id and retained reply needed for
   retries. Text, sender name, chat id, raw payload and metadata are read in memory and
   discarded. Disable request-body logging throughout both services, including errors;
   logs may contain only status and request id. Never log credentials, codes or links.

## Threat model

**Self-hosted web instance.**

- **Reach.** Loopback until claimed; then its published `localhost` or HTTPS name. Nothing without a
  session, on every route and WebSocket.
- **Claiming someone else's instance.** The code is shown only on the host, never logged, single
  use, 15 minutes, constant-time, rate-limited; the gate is loopback-only until claimed; the first
  claim wins atomically.
- **The bearer link.** Retired as a browser sign-in once claimed; DSH's token stays server-side.
- **Lost passkey.** A recovery code (one use, logged) or the host reset; every change revokes every
  session. No email reset.
- **Stolen session.** `__Host-` cookies bound to the origin on the server, short, rotated, reuse
  detection, "sign out everywhere".
- **The instance's own Bots.** Not guarded until the gate's store and reset are out of their reach
  on that platform and DSH's token is masked; said plainly in settings ((c)).
- **A cookie leaked on loopback.** Replayable by a local process with any `Origin`; local processes
  are inside the host's trust ((c), "Sessions").
- **Calls out.** None to Cloud unless linked; a test fails otherwise.

**Desktop.** Its own local DSH: the OS user, as today; same-user processes are inside that trust.
Remote sign-ins: RFC 8252, a loopback port bound first, PKCE, `state`, `nonce`, issuer and audience
checked; refresh tokens in secure storage or in memory only; the page holds no token. **Local Bots
can read the Cloud credential**: secure storage and the app's data folder answer any process of the
same user, so a Bot led by a page could take the person's Cloud session, with owner or admin power
over every workspace. Desktop Cloud sign-in stays off on an OS until the mask of (d) exists there,
or the owner accepts the risk in writing for that OS.

**Cloud.**

- **Reach.** The Cloud service's pages and the identity service's allowlisted sign-in routes are
  public. A workspace is reached only with a session from a token minted for it. Admin routes of the
  identity service, Arca's control socket, the build host and any admin-key job are unreachable from
  the internet and from every workspace.
- **Authorization.** Cloud's database, checked on every request; never email, never group claims.
- **Account takeover.** Passkeys only. An admin of the identity service can mint a login code for
  any account in it, Cloud's and, if Tactu moves, Tactu's (Decided 13): one admin, the owner, with
  its audit log reviewed; the admin key only in the operator's narrow, audited signup job.
- **One workspace against another.** Its own review gate ((g)): a VM each, one-audience tokens, no
  shared volume, network or credential.
- **A member against an owner.** Inside DSH, every person the gate lets through is the owner, and a
  Bot shell that reads DSH's token is owner-equivalent ((b), (f)). So no member or guest joins until
  the three safeguards of (f) hold; until then workspaces are owner-only. After that: roles from
  Cloud's database in the token; Buzz's gate per Bot, fail closed; stop and cancel owner-only;
  terminals and Code mode owners' unless granted; authorship from the principal.
- **Removal.** Sign-in ends within 5 minutes at worst, at once on the revocation call, and on a
  lowered role too. What a person with a shell left running (a reverse tunnel, a job, a copied
  secret) is not ended by that: secrets are rotated and processes reviewed, or the workspace is
  restored.
- **Payments.** Bots hold no Stripe key or card; limits are an owner's and enforced by the Cloud
  service; details in [RFC 0025][25] ((i)).
- **The Cloud service.** Holds the client secret and token keys, never on the build host, in two
  slots; any admin key of the identity service only in a narrow, audited backend job.

**Project invitations.**

| Threat | Boundary |
|---|---|
| Guessing | 2^40 random codes; the check character adds no entropy. Rate limits per caller, sender and code hash; generic refusals. A database copy holds only hashes, but offline search is possible in this finite space. |
| Replay | Atomic single use and message-id receipts bound to code and sender. Changed bindings or a new message for a used code get 409. Expiry, revocation, the backlog bound and the live-message age guard apply on retries. |
| A leaked link | It is a bearer invitation: its holder may win first use until expiry or revocation. The fragment avoids HTTP URL logs, not copying or screenshots. Staff revoke and reissue; no automatic workspace or identity grant. |
| A staff key leak | It can mint or revoke within its scope. Staff-only, audited calls, narrow scopes and rotation; never put a staff key in a consumer, page or workspace. Review invites minted with the key and revoke unused ones; review granted access separately. |
| Project confusion | Only the stored project decides. Editing the path, message or client state grants no other product. The consumer grants access only for the returned project. |
| A consumer key leak | Bearer proves the integration, not the sender. A stolen key can forge receive times and sender claims. Separate receiver/redeem keys, channel scopes, rate limits and rotation bound this accepted D3b cost; no staff power. |
| A false identity join | Require the signed-in principal and control of the recorded WhatsApp sender. A code or typed contact alone never attaches an admission to an account. |

**Undo.** Self-hosted: the host reset, or an image without the gate (DSH's fence is still behind
it). Cloud: turn off Cloud sign-in (apps fall back to not signed in), revoke sessions, stop
workspaces, remove the client, close the ingress. No Cloud step touches a self-hosted instance.

## Deliveries

Each phase is one PR per lane; a PR never mixes lanes. The Cloud service and Arca's setup are
outside this repository. **The test bar for every identity delivery**: sign-in end to end under a
virtual WebAuthn authenticator in CI; negative tests for a wrong origin or port, a replayed or
expired code, a second claimer, and every route and WebSocket without a session; OIDC negative tests
(bad `state`, `nonce`, issuer or audience, a missing verifier) against a throwaway provider; no real
host name, issuer or client id in a test or a default config.

0. **This RFC and its evidence gaps** (docs; no release). Answer before acceptance: whether DSH's
   web server offers an authentication hook; Pocket ID's capabilities beyond the version Tactu used
   (organisations, scoped API keys, email-bound invitations, federation, SCIM); passkeys on
   `localhost` and platform authenticators per OS and browser; `safeStorage` without a Linux secret
   store; what a desktop mask needs per OS ((d)). *Check:* a written record, private where it names
   hosts. *Record:* [the public evidence record](../cloud/0024-delivery-0-evidence.md).
   *Rollback:* none needed.
1. **Desktop secure storage and RFC 8252 sign-in** (desktop, 3.N; first, Decided 11; behind a
   setting, with no Cloud yet). `safeStorage` with the Linux fallback detected; the system-browser
   flow with PKCE, `state`, `nonce`, issuer and audience checks and the exact loopback redirect.
   *Check:* against a throwaway provider, a sign-in completes; each OIDC negative case is refused; a
   second loopback request is refused and the port closes; with no secret store nothing is written;
   `automagik://` still only opens. *Rollback:* a desktop release without the setting; stored items
   go unused.
   *Acceptance (from review):*
   - the contract the desktop meets is pinned, for the Cloud service and for a remote gate's code
     exchange alike: discovery, the issuer, the audience and who issues the ID token;
   - both servers accept any loopback port (RFC 8252, 7.3);
   - the setting is off by default.
2. **The self-hosted gate** (server image; plugin lane if the gate ships as a module). The gate in
   front of loopback DSH, the claim, passkeys, origins, sessions, recovery codes, the host reset,
   the owner record and the principal, the gate as its own container with its own volume.
   *Check:* the test bar; loopback-only until claimed; the code in no log and no response; two
   concurrent claims leave one owner; an IP origin is refused with its reason; the launch URL signs
   no browser in after the claim; every passkey or recovery change revokes every session; a newer
   owner record is not "unclaimed" to the older build; the DSH container cannot read the gate's
   volume; the smoke still sees `401`; no request leaves for Cloud. *Rollback:* an image without the
   gate; DSH's fence is in front again, as today.
   *Acceptance (from review):*
   - an expired claim code is replaced only from the host side (a restart, or the host command);
   - in the image, with no terminal, the code goes to the `0600` file only, never to stdout;
   - the recovery-code route is rate-limited;
   - after a host reset, the gate is loopback-only again until claimed;
   - the instance id is random, never derived from the host;
   - the gate reads DSH's volume read-only, and DSH never mounts the gate's;
   - the settings and the RFC say that a cookie leaked on loopback can be replayed by a local
     process, or the session is bound to something besides the cookie.
3. **The Cloud service** (outside this repository). Split into the deliveries below, keeping
   the existing delivery numbers stable. Invitations come first among Cloud-service work;
   desktop secure storage remains first for the desktop (Decided 11).

   **3a. Invitations by project, first.** The Cloud invite table, staff-only mint/revoke,
   redeem and receipts, rate limits and audit records. The website backend and WhatsApp
   receiver use the public contract above; no cx-side code store. *Check:* mint for two
   projects; changing the link or message never changes the returned project; the checksum
   vectors pass; only hashes persist; non-staff mint/revoke is refused. Concurrent redeems
   have one winner; the same message retries identically, a changed sender or new message
   cannot reuse it. Prove expiry, revoke, receive-time and processing-window boundaries,
   before-creation rejection, rate limits, store failure, and no body/code logging. No
   admission grants workspace access. *Rollback:* disable mint/redeem and revoke unused
   invites; retain used records and receipts so a restart cannot reuse them. Disable any
   consumer first. Existing access is reviewed separately, never erased by deleting codes.

   **3b. Web sign-in and identity binding.** After 3a: personal accounts, organisations,
   roles, sessions and revocation; the identity service and ingress under Decided 13 and 16.
   The website redeems through its backend. A separate Cloud proof flow attaches a prior
   WhatsApp admission to the verified principal, without merging identity accounts or
   changing the invite-message trigger. *Check:* an invitation binds to the accepting
   `(issuer, sub)`, not email; a typed sender or stolen invite alone cannot claim an existing
   admission; a conflicting binding is refused; a reused rotated secret revokes the family;
   a request after removal is refused. *Rollback:* turn off web sign-in and linking, revoke
   sessions and close the ingress; keep the admission records for safe recovery.

   **3c. cx WhatsApp redeem consumer, later.** Only after 3a's Cloud redeem and Omni's
   answer-intake denial-cache fix exist. A freshly admitted sender's next message must not
   hit a cached denial. Try the receiver and automation first on a second test phone.
   Keep the age guard, default deny, reply only from the automation, idempotent rule writes,
   and the guard's revoke limited to hand-kept rules. Provision answer routing and file
   access per person before serving them; an allow rule alone is not working compute.
   *Check:* one code admits to its recorded project; a retry returns the same reply and
   creates one allow rule; interrupt between consume and rule write, then recover by retry.
   No code, old/history/self-sent messages, bad Bearer, refusals, failed writes and timeouts
   send nothing and create no queue. The first allowed follow-up reaches only that person's
   compute, once provisioned; answer mode never duplicates the automation's welcome. Prove
   the guard preserves invite-created rules and existing hand-kept admissions still work.
   *Rollback:* disable the automation and receiver, rotate their credentials, remove only
   the test's invite-created access rules, and retain Cloud's spent-code receipts. Do not
   restore a guard command that could delete other people's invite rules.
4. **One workspace, made by the operator** (server image Cloud mode; Arca outside), after the
   isolation review gate passes (Decided 12). Owner-only ((f)). Workspace tokens, the VM, volume,
   network, limits, backups and a restore drill. *Check:* workspace A's token is refused by B; a
   removed person cannot sign in after 5 minutes, and at once on the call; a restore opens with the
   same Bots and chats; the private network, the build host and other workspaces are unreachable
   from inside. *Rollback:* stop the workspace; the image without Cloud mode is a self-hosted
   instance.
   *Record:* [the public delivery 4 evidence](../cloud/0024-delivery-4-evidence.md).
   *Acceptance (from review):*
   - the gate's session lasts no longer than a workspace token, or rechecks the role; a lowered
     role drops sessions as a removal does;
   - a rail tile hands over a single-use code exchanged on the server, never a token in a URL;
   - the workspace node is not the build host, and no agent account on it holds `incus-admin` or a
     group equal to root;
   - the image digest comes from the release's own record.
5. **The rail, `+` and people** (desktop, 3.N; plugin, 3.N.P, for the web rail; Stripe billing
   outside). Desktop Cloud sign-in is switched on per OS only where the mask of (d) exists, or the
   owner accepted the risk in writing for that OS. Members and guests are switched on only when the
   three safeguards of (f) hold; until then the people features ship behind that line.
   *Check:* no rail when not signed in or not entitled; tiles by organisation and "This computer"
   first; `+` refused past the limit with the reason; an admin cannot reach billing; a Stripe
   webhook with a bad signature changes nothing; with members switched on, a guest sees only
   allowlisted Bots, the main bot is never "anyone", and stop and cancel are refused to every
   member and guest. *Rollback:* a release without the rail; workspaces stay reachable by their
   origins.
   *Acceptance (from review):*
   - a workspace origin opened in the desktop window gets none of the shell's privileged preload
     or IPC, and a partition separate from the local DSH;
   - who sets per-person choices in a shared workspace is decided (RFC 0014's `shown[]`, RFC
     0022's `front`).
6. **Linking a self-hosted instance** (later, optional; desktop and server image). *Check:* linking
   needs the local passkey (or the OS user on the desktop) and adds exactly one principal; members
   get nothing; unlinking restores local-only; an unlinked instance opens no connection to Cloud.
   *Rollback:* a release without linking; the instance drops the linked principal.

No outside person joins a workspace before the isolation review has passed and a restore has worked
once, and no member or guest before the three safeguards of (f) hold.

**Later, outside this RFC's deliveries:** Tactu may move to the new identity service (Decided 13),
as its own project's decision: a new client and groups there, and its people re-bound, since
principals are keyed by `(issuer, sub)`. Arca keeps its own sign-in (its own passkey approvals).

## Amendment (2026-11-20): instance id, account evidence and reservations

*Status: accepted, approved by the owner's delegate on 2026-11-20 (proposed 2026-11-19), with
every recommended option; its questions are answered below. Issue #1426 (Refs, not Closes).*

**Why it is here.** #1426 asks for a record of which subscription account (per vendor) belongs to
which instance or project. The owner's policy (2026-11-16, on #1426): accounts are a **shared
pool** by default; an account **can be reserved** to one instance or project; **only a reserved
account refuses another instance**, and a shared account used by several instances is allowed.
Identifiers only, never a credential; no credential moves between homes or machines; private
homes and OS users stay as they are. (The owner's temporary priority rule, one named project first
on a clash until 2026-11-23, is an operating rule and is not encoded.) A plan for #1426 stopped
before code because three things it needs are contracts, not details: who a reservation is for,
which account it names, and where a record lives that another instance can read. This amendment
fixes all three and orders the work.

Words used here: an **instance** is (Words) one DSH runtime with its own data, which is one
Automagik home; two DSH processes that share one home are one instance. A **reservation** says
"this vendor account is for instance X"; with none, the account is **shared**. The **check** is
the read, at sign-in and at each fresh account read, that refuses a reserved account to every
other instance.

### (l) The instance id

**What exists.** The self-hosted gate already makes the instance id this RFC specifies: a random
`instance_id` in its owner record at the claim (`server/gate-store.mjs:55`, schema in
[contracts-v1, section 2](../cloud/contracts-v1.md)). The desktop has none: the only name a plugin
sees is the DSH profile name, which the app fixes to `omni` for every installation
(`apps/desktop/src/dsh.js:26`), may be absent, and is free text.

**Recommended (L-A): the owner record's `instance_id`, delivered on the desktop first.**

- **Minted** once by the desktop shell at the first run of an Automagik home, as the owner record
  version 1 of contracts-v1 (`version`, `local_id`, `instance_id`), both ids random (a UUID v4 or
  128 random bits), never derived from the host, the OS user, the home's path or the profile name.
- **Stored** at `<Automagik home>/desktop/owner.json` (the app's own home, `appHome` in
  `apps/desktop/src/dsh.js`), created exclusively (`wx`), mode `0600`, outside every Bot's folder.
  This settles contracts-v1's open file name and path for the desktop only; the gate keeps its
  own store.
- **Kept**: never rewritten or reset by the app. A record with a higher `version` or unknown
  fields is left byte-equal, and its `instance_id` is used when it is a valid string; a record
  that cannot be read stops reservations (with the reason on the card), never the app, and is
  never overwritten. A team launch with its own `AUTOMAGIK_HOME` is its own instance with its own
  id.
- **Handed to DSH** by whoever launches it, as `AUTOMAGIK_INSTANCE_ID` in DSH's environment (the
  desktop's `dsh.js`; a host install's launcher). It is not secret and grants nothing: knowing an
  id lets no one act as that instance. Bots can read it, as they can read the home.
- **The server image** has the id in the gate's store, which DSH cannot read by design ((c)). It
  reaches plugins through the principal's `workspace` once (f)'s principal channel exists; until
  then a server-image instance offers no reservation, and its card says so.
- **A copied home** (a restore on a second machine, a cloned VM) copies the id: both copies are
  one instance to the check. A restore is a move; running both copies is the owner's choice.
- **A project** is a label the owner gives the reservation (shown, never compared). One instance
  per project is the owner's setup; a project id across instances is not defined here.

| Option | For | Against |
|---|---|---|
| **L-A, the owner record's id (recommended)** | the id this RFC already named and the gate already makes; one store, as contracts-v1 says | the server image waits for (f)'s channel |
| L-B, a separate `instance.json` written by the plugins in each home | works everywhere at once | a second store contracts-v1 rules out; in a Bot-writable folder; two records to keep in step once the owner record lands |
| L-C, derived from the host, OS user or home path | no file | two homes collide or one home changes id when moved; this RFC forbids host-derived ids |
| L-D, the DSH profile name | exists today | `omni` everywhere on the desktop, optional, free text |

### (m) The account evidence a reservation binds to

**Rule.** The evidence is only what each vendor's CLI says about itself through the reads acp-dsh
already makes (`apps/acp-dsh/src/host/account.js`: Claude Code's `auth status --json`, Codex's
app-server `account/read`). Never a token, a key, a credential file, a keychain item or a cookie;
no new read of any credential store is introduced. Today an account is named by vendor,
organisation id and email (`account.js:44`, `:67`), and the consent record compares those facets
tolerantly on purpose (`consent.js`: a facet only one side has says nothing), so a CLI release
never loses a person's consent. An exclusivity claim needs the opposite direction: when in doubt,
the reservation wins.

**Recommended (M-A): per-vendor evidence, refuse when ambiguous.**

| Vendor and sign-in | Evidence | Reservable |
|---|---|---|
| Claude, a person's sign-in with an email and an `orgId` | `claude`, the `orgId`, the email lowercased | yes |
| Claude, an email with no `orgId` | none | no; the card says why (an older CLI, update it) |
| Claude, an API key, a subscription token in the environment, Bedrock or Vertex | none | no; no subscription person is named. Never refused |
| Codex, a ChatGPT sign-in | `codex`, the email lowercased, the plan class: `personal` (free, plus, pro and the other personal plans) or `workspace` (team, business, enterprise, edu and their variants); the full lists are in [R0's record](../cloud/0024-reservations-evidence.md), section 2 | yes |
| Codex, a ChatGPT sign-in whose `planType` is absent or unknown | none | no; at the check it matches either class |
| Codex, an API key | none | no; never refused |

- **The plan class, not the plan**: upgrading Plus to Pro is the same account.
- **A Codex workspace reservation covers every workspace that email belongs to.** `account/read`
  names no workspace today; a person in two ChatGPT workspaces cannot reserve one of them. If Codex
  later names the workspace, it becomes one more evidence field (additive); the account id inside
  Codex's own auth file is a credential store and is never read.
- **Matching at the check.** Exact (every evidence field equal): refused. Ambiguous (same vendor and
  email, and a field missing or unknown on the read being checked): refused too, with the reason and
  the fix (update the CLI, or ask the reservation's owner to make it shared). Another `orgId` or
  another plan class: another account, allowed.
- **A comparable identifier.** Today's digests are keyed per home (`consent.js`, `digest`), so two
  homes cannot compare them. The record ((n)) keeps two HMAC-SHA256 digests under the record's own
  random key: `exact` over the canonical evidence, and `loose` over vendor and email only (for the
  ambiguous match). No email, organisation name, plan or token is written. The key keeps the
  digests meaningless to anyone without it (a backup, a log, a screenshot); it does not protect
  them from a member of the record's group, who could test a guessed email. Said plainly in the
  card's help.

| Option | For | Against |
|---|---|---|
| **M-A, per-vendor evidence, refuse when ambiguous (recommended)** | a reservation never quietly misses its account | an old Claude CLI cannot reserve; two Codex workspaces of one email are one reservation |
| M-B, today's facets with the consent rule's tolerance | no new rule | a missing `orgId` reads as "not another account", so two organisations with one email collide in both directions |
| M-C, warn instead of refuse when ambiguous | no false refusal | the reservation the owner asked for becomes advice |
| M-D, the account id from the CLI's credential files | exact | reads a credential store: refused by policy |

### (n) The reservation record and the check at sign-in

**Recommended (N-A): a machine directory with group permissions now; Cloud later for several
machines.**

- **Where.** `/var/lib/automagik/reservations` on Linux, and on macOS `Automagik/reservations` in the
  system's shared folder for all users; `AUTOMAGIK_RESERVATIONS_DIR` overrides it. Made once by the machine's administrator (a
  documented command; no Automagik process asks for root): group `automagik`, mode `3770`
  (set-group-id, so every file keeps the group; sticky, so only a file's owner or root removes or
  renames it). Each OS user that runs an instance joins the group. Windows: not offered until a
  design with ACLs; the card says so.
- **What is in it.** `key`: 32 random bytes, made by the setup command, mode `0640`. One file per
  reservation, `<vendor>-<exact digest>.json`, mode `0640`:

  ```json
  {
    "version": 1,
    "vendor": "claude",
    "exact": "{hmac of the evidence}",
    "loose": "{hmac of vendor and email}",
    "class": "workspace",
    "instance": "{instance-id}",
    "label": "{the owner's project label}",
    "at": "2026-11-19T12:00:00Z"
  }
  ```

  `class` is present for Codex only. `label` is one cleaned line of at most 60 characters. The
  file's OS owner is who made it, and the card shows it.
- **Reserving** (an owner-only route in the instance's app): the instance must have an id ((l)),
  be signed in to that account now (a fresh read), and the evidence must be reservable ((m)). The
  file is created exclusively (`wx`): two instances reserving at once leave exactly one winner and
  need no lock. An existing file for another instance is refused with its label; for this
  instance, only the label changes (its own file, replaced by rename). With no directory, the
  reservation is kept in this instance's own home only and the card says it holds here alone.
- **Making it shared**: the reserving OS user removes its own file. No other group member can
  remove or replace it (the sticky bit); the administrator can, for an instance that no longer
  exists.
- **The check**: in bots-dsh's host, after acp-dsh reports a signed-in read of a Bot's vendor, and
  at every fresh read after it (a start, the card, a new Bot session), never mid-turn:
  1. a read that names no subscription person (a key, a token, another provider, an unreadable
     account): allowed. A subscription read that is only *not reservable* (Claude without `orgId`,
     Codex of an unknown class) is not allowed here: it is ambiguous and goes to step 2 (clarified
     2026-11-20 with R0, to match (m));
  2. the `exact` file, else any `<vendor>-*.json` whose `loose` matches and whose evidence is
     ambiguous against this read: found for another instance means **refused**, even when the same
     email also has a reservation for this instance; for this instance only, allowed and shown as
     "reserved for this instance". A complete read whose `exact` differs (another `orgId` or class)
     is another account, allowed even when `loose` matches;
  3. refused, in an isolated Bot home: the app signs that vendor out of the Bot's own home (never
     the terminal's sign-in) and the card shows "Reserved for {label} on another instance. Sign in
     with another account, or ask its owner to make it shared." In consent mode (the Bot uses the
     terminal's sign-in), the Bot does not use the account and the terminal is never touched;
  4. no directory, or one this OS user cannot read: no reservation applies, and the card says
     reservations are not checked here (fail open: a missing setup must not stop every sign-in);
  5. an `exact` file that exists and cannot be read or parsed: refused, with that reason (the
     reserver's claim stands).
- An instance already signed in when another reserves the account is refused at its next fresh
  read, not mid-turn.

| Option | For | Against |
|---|---|---|
| **N-A, machine directory with group permissions (recommended now)** | the owner's instances run as separate OS users on one machine; no network, no Cloud; atomic without a lock | one machine only; needs one administrator step |
| N-B, Cloud's workspace or the Cloud service as the registry | several machines | nothing self-hosted calls Cloud unless linked (delivery 6); needs every instance linked and Cloud up for a sign-in |
| N-C, a herdr-core broker | already per machine | not every instance runs herdr; a live core becomes a dependency of a sign-in |
| N-D, each home's own record only | no setup | no refusal across instances: what #1426 asks for is missing |

**Limits, said plainly.** The reservation is a guard between the owner's own cooperating
instances, not a boundary against a hostile one. A Bot runs as its instance's OS user (RFC 0022's
same-user reach), so it can remove that instance's reservation or write a file for an account it
can name; a group member can squat a reservation on an account it can name, which the
administrator removes (the file's OS owner shows who). The same account on two machines is not
seen until the Cloud registry (delivery R5). A copied home shares its id ((l)).

### Contracts this amendment introduces

All new and additive; nothing existing is renamed or moved.

- **The desktop owner record**: contracts-v1's owner record, version 1, at
  `<Automagik home>/desktop/owner.json`, `0600`.
- **`AUTOMAGIK_INSTANCE_ID`**: the instance id in DSH's environment, set only by its launcher;
  non-secret, never authority.
- **The reservation directory and record**, version 1: the layout, modes, `key` and file of (n).
  A newer version is additive; a reader skips a file whose `version` it does not know, except
  that an `exact` match it cannot read is refused ((n), step 5).
- **The evidence rules** of (m): which reads are reservable and how the two digests are made.
- **One owner-only route in bots-dsh** for reserving and making shared, beside the account card's
  existing routes; no plugin id, route prefix or storage prefix renamed.

### Deliveries for this amendment, in order

Each is one PR per lane, in this order.

- **R0. This amendment and its evidence** (docs). Answer before R2: whether the current Claude Code
  prints `orgId` for a personal (Pro, Max) and a Team or Enterprise sign-in; Codex's `account/read`
  fields and its `planType` values, and whether it names a workspace; set-group-id and sticky
  semantics for the directory on Linux and macOS. *Check:* a written record. *Rollback:* none.
  *Record:* [the R0 evidence record](../cloud/0024-reservations-evidence.md) (2026-11-20; no real
  sign-in and no credential store read): Claude Code prints `orgId` beside the email for every
  `claude.ai` sign-in that has one; Codex names a workspace only by display name, so (m) stands, with
  the full `planType` lists; `mkdir -m 3770` drops set-group-id, so R4's setup sets the mode after
  creating the folder, and writers set each file's mode on its descriptor.
- **R1. The desktop instance id** (desktop lane). *Acceptance:* the first run writes the owner
  record version 1 with random `local_id` and `instance_id`, `0600`, exclusively; a restart keeps
  both; two Automagik homes on one machine and one OS user get different ids; a record with a higher
  `version` or unknown fields stays byte-equal and its id is used; an unreadable record is never
  overwritten and stops only reservations; DSH starts with `AUTOMAGIK_INSTANCE_ID`; nothing derives
  the id from the host. *Rollback:* a release without it; the file stays, unused.
- **R2. The account evidence** (plugin lane, acp-dsh). acp-dsh hands its owner-only host API, per
  vendor, whether the read is reservable, the Codex plan class and the two digests under a key the
  caller passes; the email stays where it already goes. *Acceptance:* every row of (m)'s table on
  fixtures of both CLIs' outputs; Plus and Pro are one class, Team and Plus are not; an unknown
  `planType` is not reservable; only the existing status reads are spawned (no file under a CLI's
  credential folder is opened). *Rollback:* a release without the fields; nothing reads them.
- **R3. The per-instance record and the card** (plugin lane, bots-dsh). The account card shows
  shared or reserved per vendor and lets the owner reserve (with a project label) or make shared,
  keyed on the instance id; with no machine directory the reservation holds in this instance only
  and says so. *Acceptance:* shared by default; reserving refuses without an instance id, signed
  out or not reservable; no email, organisation or token in the file's bytes; copy in English and
  pt-BR; bundles rebuilt. *Rollback:* a release without it; the file is ignored.
- **R4. The machine record and the check** (plugin lane, plus the documented administrator setup).
  *Acceptance:* two concurrent reservations leave one file; another OS user in the group cannot
  remove or replace it (a two-user test where CI can make users, else a recorded manual run); a
  shared account is never refused; a reserved account is refused in another instance, at sign-in
  and at the next fresh read, with the reason; the terminal's sign-in is never touched; an
  ambiguous read is refused; no directory or an unreadable one allows with the notice; an
  unreadable `exact` file refuses. *Rollback:* a release without the check; the directory stays
  and is ignored.
- **R5. The Cloud registry** (later, after delivery 6). The same record version 1 served by the
  Cloud service per organisation, with a key per organisation, so a reservation holds across the
  owner's machines. Its own amendment when delivery 6 is planned.

### Questions for the owner

Answered by the owner's delegate on 2026-11-20, each with the recommended option.

1. **The instance id**: L-A, the owner record's `instance_id`, minted by the desktop first, handed
   to DSH as `AUTOMAGIK_INSTANCE_ID`? *Answered: yes, L-A.*
2. **Ambiguous reads**: refuse (M-A) or only warn (M-C)? *Answered: refuse, M-A.*
3. **Codex workspaces**: accept that a workspace reservation covers every workspace of one email
   until Codex names the workspace? *Answered: yes.*
4. **The record's home**: the machine directory with group `automagik` now and Cloud later (N-A),
   or wait for Cloud (N-B)? *Answered: N-A, the machine directory now, Cloud later (R5).*
5. **A refused isolated Bot home**: sign that vendor out of the Bot's home, or keep it signed in
   and unusable? *Answered: sign that vendor out of the Bot's home (never the terminal's).*

## Open questions

Answered questions point to their Decided items; the numbers stay as they were, so references
keep their meaning.

1. **Which identity service.** Answered in Decided 13 and 16.
2. **Where Cloud roles live.** Answered in Decided 6.
3. **Isolation unit.** Answered in Decided 15.
4. **Who may invite.** Project invitations: staff only, answered in Decided 27. Organisation
   owners and admins still manage membership under (e); that role alone cannot mint a project
   invitation. Workspace access remains subject to (f).
5. **Recovery.** Recommended: a second passkey at the claim, plus recovery codes as slow hashes,
   plus the host reset out of the Bots' reach; no email reset ((c)).
6. **Session lifetimes.** Recommended: self-hosted sessions sliding with a 12-hour idle limit;
   Cloud workspace tokens 5 minutes; whether DSH's own multi-day cookie can stay behind the gate
   unchanged is an evidence gap for delivery 0.
7. **IP-only LAN installs.** Answered in Decided 19.
8. **What is paid.** Recommended: hosted workspaces, per workspace per month, seats up to a limit,
   model usage on the workspace's keys at first; personal accounts free; self-hosted free and
   complete for one instance ((i)).
   *Amended by [RFC 0025][25] (2026-11-09):* BYO model access is free; managed tokens are an
   opt-in through Cloud's gateway at a published margin; compute is metered from the host
   lifecycle. The workspace subscription and seats stand; 0025's Open questions carry the
   included seats and host shape under RFC 0024 Q8.
9. **The billing system.** Answered in Decided 14.
10. **Moving a self-hosted instance into Cloud.** Answered in Decided 20.
11. **DSH's authentication hook.** Answered in Decided 21.
12. **Omni's sign-in.** Answered in Decided 22.
13. **An optional external OIDC provider for self-hosters** (RFC 0008's old question 2).
    Answered in Decided 23.
14. **Federation for company customers** (Google or Entra sign-in, SAML, SCIM). The council's
    dissent expects customers to ask; Pocket ID's support is unverified. Recommended: delivery 0
    checks it; if it is missing, decide before the first company customer, since a later issuer move
    re-binds every person.
15. **Pocket and Pocket Link with a claimed instance.** Answered in Decided 24.
16. **Is the Cloud service open source?** Answered in Decided 25.
17. **The desktop's Cloud credential and local Bots.** Recommended: build a delivery-H-style mask
    per OS (the secret store, the session bus, the app's data folder) and keep desktop Cloud sign-in
    off on an OS until it exists there. The alternative is the owner's written acceptance of the
    risk for that OS ((d)).
18. **Until the three safeguards hold.** Answered in Decided 26.
19. **The Cloud rail on another site than its workspaces.** Browser acceptance on
    `a8d663c1e` (#1373, 2026-11-20) saw the rail's direct 303 land on a cross-site 401. In
    multiuser mode, RFC 0038 delivery 5d now returns a 200 workspace document from
    `POST /_gate/cloud/open`. Its same-origin POST to `/_gate/cloud/open/finish` can carry the
    previous Lax cookie, retire that family, and issue the new cookie with a 303 to `/`.
    Verify the final cross-site landing in a browser before Cloud ships. The two options
    remain to serve the rail on the same site as the workspaces or add a signed exception
    in `trustedRequest` for the Cloud landing, like the Access exception (#1082).

## Tracking

Ledger pass (2026-11-10): the board links this RFC from its file.

- Contracts: [docs/cloud/contracts-v1.md](../cloud/contracts-v1.md), version 1 (issue #904),
  frozen at merge; later changes are additive only.
- Open issues: #902, #903, #904, #905, #906, #907, #908, #909, #910, #911, #912.
- Amendment approved by the owner's delegate 2026-11-20: #1426, instance id, account evidence and
  reservations (deliveries R0-R5).
- Merged changes that cite this RFC: #866, #888, #913 (last merged 2026-11-10).

## Links

- RFCs: [0008](0008-platform-and-web-instances.md) (amended here: its web sign-in, the desktop
  client, contracts, questions 2, 6, 7, the threat model); [0022](0022-desktop-chat-view.md)
  (Decided 7, Buzz's gate, provenance, delivery H, the same-user reach, `front`; amendment proposed
  by 0022's (l), Q17: machine links on a self-hosted instance);
  [0014](0014-shared-bot-registry.md) (each workspace's Bot registry, `shown[]`, "Other
  machines"); [0015](0015-live-chat-projection.md) (DSH's `principal` caller field);
  [0019](0019-gitlab-mirror.md) (Arca's GitLab, the build host); [0010](0010-desktop-sandbox.md)
  (Arca, masks); [0011](0011-monorepo-parts-and-releases.md) (lanes, key rotation);
  [0023](0023-dsh-upstream-agent-context-and-chat-rows.md) (proposals to DSH);
  [0005](0005-workspace-and-genie-projects.md) (the repos base, a different "workspace");
  [0025](0025-cloud-economics.md) (amends open question 8, Decided 14's "being paid", and the
  workspace credential in (g)).
- Code: `server/` (`Dockerfile`, `entrypoint.mjs`, `README.md`),
  `.github/workflows/server-image.yml`; `apps/desktop/src/dsh.js` (the launch URL, loopback),
  `apps/desktop/src/deeplink.js`, `apps/desktop/src/identity.js`.
- Outside, read-only and summarised: Tactu's login and waitlist decisions; Arca's owner note; Buzz's
  author gate (Apache-2.0, read, not copied); SimpleWebAuthn (MIT, an example, not chosen); Stripe
  Billing and its agent-payment features (a direction, detailed later); the left-bar mockup v7
  (private); the council report on this split (private). Concrete addresses, client ids and group
  names are kept in a private note, not here.

[22]: 0022-desktop-chat-view.md
[25]: 0025-cloud-economics.md
