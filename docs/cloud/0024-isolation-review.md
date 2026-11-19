# C4.0 review: the isolation review gate

| Field | Value |
|---|---|
| Issue | #911 (C4.0) |
| RFC | [0024](../rfcs/0024-automagik-cloud.md), Decided 12 and (g); delivery 4 |
| Written | 2026-11-19 |
| Reviewed at | `35713af605aa7e62df032d1166b59a153cac8883` (the branch point; this document is the only change) |
| Lane | docs (no release) |
| Scope | Whether one Cloud workspace is isolated from another. Identity, billing and roles inside one workspace are separate reviews. |
| Status | Evidence recorded. **The gate is not passed.** The gate-side boundary is implemented and tested against a fake Cloud service. The VM, volume, network, host and Cloud-service half is **unproven here**. The private record, the probes and the owner's sign-off are outstanding. This document does not close #911. |

This is a desk review of the repository at that commit. It ran no VM, no Incus instance, no real
workspace and no credential. Where a guarantee cannot be shown from this repository, the text says
**unproven here** and names what would prove it. Section 5 defines the probes C4.3 must run; none of
them has been run for this record. Values in `{...}` are placeholders; no real workspace id, host,
key or credential appears here.

**Short answer.** The repository is strong on the gate's own edge. A workspace token is
audience-bound, a gate session is short and origin-bound, an open code is single-use, revocation is
signed and polled, renewal rechecks the role with Cloud, and the tests cover those paths. It is
silent on the boundary that makes those controls meaningful between tenants: one VM per workspace,
its own volume and network, the unreachable list, the host's groups, and per-workspace secrets and
limits. It also contains only the gate's half of the Cloud contract. The Cloud service that mints
codes and tokens, publishes keys, rechecks roles and sends revocations is not built here. The
honest verdict is therefore **no pass yet**: not because a gate check is obviously wrong, but
because the checks this repository cannot make have not been made or recorded where this review
can see them.

## 1. What the product promises, and what can try to break it

RFC 0024 (f) makes the promise flat: one workspace is one hosted instance, its own volume, and
"Nothing in one workspace reads another's" (`docs/rfcs/0024-automagik-cloud.md:579-581`). (g)
fixes the unit and the reachability list:

- one Incus VM per workspace, never a privileged container; an unprivileged system container only
  for the operator's own workspaces (`docs/rfcs/0024-automagik-cloud.md:650-655`; Decided 15 at
  `:137-139`);
- its own volume and network. The internet and the Cloud service's public-key and revocation
  endpoints (and, later, the model gateway) are reachable. The private network, the build host,
  the hosting platform's control socket, the identity service's admin routes and other workspaces
  are not. It is reached only through the Cloud edge, on its own origin
  (`docs/rfcs/0024-automagik-cloud.md:656-662`);
- its own secrets, valid nowhere else (`docs/rfcs/0024-automagik-cloud.md:663`);
- CPU, memory and disk limits from the plan (`docs/rfcs/0024-automagik-cloud.md:664`);
- the workspace node is not the build host, and no agent account on it holds `incus-admin` or a
  group equal to root (`docs/rfcs/0024-automagik-cloud.md:644-648`; delivery 4 acceptance at
  `:1125-1126`).

The threat model is not "a stranger on the internet"; the workspace already runs arbitrary
commands for its people. It is **one tenant's ordinary capability against another tenant's data,
network and credentials**. Concretely:

| Actor | What it can do by design | What it must not achieve |
|---|---|---|
| A person in workspace A, with a browser | hold A's session, open or renew A, use A's Bots | open B, use A's session at B, present A's token to B, read B's browser storage |
| A person in workspace A, with a shell | run as the workspace uid; read A's data and A's DSH launch credential; reach A's loopback | reach B's volume, network or gate; reach the private network, the build host, the control socket or the identity service's admin routes; get a root-equal group |
| A Bot in workspace A | the same as a shell, without a human, and it can be steered by text or a model | the same list; it must not be a bridge to B or to the host |
| The gate in workspace A | read A's DSH view, mint DSH's owner credential, hold A's workspace token | serve B's origin, accept B's token, or become a route from A to B or to the host |
| A Cloud compromise or a Cloud key leak | mint and verify workspace tokens, sign revocations | be contained by this repository; if the signing key is lost, every gate accepts what it signs |
| A person in workspace B | symmetric to A | symmetric to A |

The concrete attempts this review walks:

1. Use A's `__Host-automagik-session` cookie at B's gate.
2. Post A's single-use open code to B's gate.
3. Present a workspace token minted for A to B's gate.
4. Make a cross-site request from a page in A to B.
5. Read B's browser storage under the same storage prefix.
6. From a shell in A, dial B's gate, DSH, volume or private address.
7. From a shell in A, reach the private network, the build host, the hosting platform's control
   socket or the identity service's admin routes.
8. Read A's model key, Omni credential or Bot secret and use it at B or anywhere else.
9. Escape A's container or VM to the node: a privileged container, the Incus control socket, a
   root-equal group.
10. Starve B by exceeding A's CPU, memory or disk allowance.
11. Poison the trust anchor: a Cloud signing-key leak, a key-set substitution, or a token minted
    by a Cloud bug for the wrong person, workspace or role.
12. Read B's data through a shared host path, a shared volume or the host-side measurement view.

This review does **not** call identity takeover, within-workspace authorization, billing isolation,
anonymity, or denial of service between tenants the same question. They meet isolation at the
gate's principal and at the plan limits, and are named where they do.

## 2. The paths that enforce isolation

The repository's cross-workspace controls are all on the gate's edge. The compute, volume and
network controls are outside it. The next sections trace what is here and what each path proves.

### 2.1 The gate session

The open path is `POST /_gate/cloud/open` (`server/gate.mjs:95-125`). It requires the exact path,
`POST`, the exact Host and the configured rail Origin, a form content type, no `Authorization`
header, one field named `code`, and a body of at most 4096 bytes. It trades the code with the
Cloud service server-to-server, then issues its own session and answers `303` to `/` with
`cache-control: no-store` and `referrer-policy: no-referrer`.

The session store in Cloud mode is memory-only (`server/gate-entrypoint.mjs:24-28`,
`server/gate-store.mjs:73-102`). The session's `expires` is a hard end, never renewed
(`server/gate-store.mjs:91-101`); `active` checks it and the 12-hour idle limit
(`server/gate-store.mjs:104-107`); the cookie `Max-Age` is clamped to what is left
(`server/gate-store.mjs:109-112`). The cookie is `__Host-automagik-session`, `Path=/`, `HttpOnly`,
`Secure`, `SameSite=Lax`, no `Domain` (`server/gate-store.mjs:62-71`). A secret is 32 random
bytes; only its sha256 is stored (`server/gate-store.mjs:10-11`, `:98`).

The session is origin-bound: `authenticate(value, origin)` refuses a family whose `origin` is not
the gate's pinned origin (`server/gate-store.mjs:113-133`). The gate's origin is pinned to an exact
HTTPS origin (or an HTTP loopback origin) and a path is refused (`server/gate.mjs:15-20`). The
tests cover the cookie flags, rotation, replay, idle expiry, origin binding and restart
(`server/test/gate.test.mjs:177-200`), and the Cloud session ending with its token
(`server/test/gate-cloud.test.mjs:395-419`).

**What it proves.** A browser session at A is a random bearer secret held only by that browser and
recognised only by A's gate process. It cannot outlive the workspace token or five minutes after
the open, whichever is shorter. A cookie presented to another gate is not in that gate's store; a
cookie presented on another origin is refused by the origin check. A new open
replaces the browser's previous session (`server/gate.mjs:118-121`). Reusing an old rotated secret
revokes the family (`server/gate-store.mjs:113-133`), and a revoked family closes its open
WebSockets (`server/gate.mjs:347-349`). A person's session list and "sign out everywhere" are
scoped to that person (`server/gate.mjs:221-223`; `server/gate-store.mjs:155-160`; test at
`server/test/gate-cloud.test.mjs:438-454`).

**What it does not prove.** The session is only as private as A's browser and A's host. A local
process on A's machine can receive or replay the cookie; the gate says so in its own notice
(`server/gate-store.mjs:9`, repeated at `server/README.md:724-726`). Cookies are scoped by host,
not by port, so another service on the same host can receive the cookie; `__Host-` adds Secure,
Path and no-Domain, not port isolation. The store is process memory, not encrypted storage: a
process-memory read or a core dump exposes the session hashes and the held workspace token. The
gate session is not DSH's session. Revoking it does not revoke DSH's own cookie or the gate-held
DSH credential, and it does not stop a shell, a reverse tunnel or a job the person left running
(contracts v1: `docs/cloud/contracts-v1.md:530-533`; delivery 0 evidence at
`docs/cloud/0024-delivery-0-evidence.md:134-135`). Finally, one process holds one origin and one
store. The code does not enforce "one gate process per workspace"; a deployment that served two
workspaces from one process would have one store and one origin. The supported topology is one
gate per workspace origin, and that topology is a deployment property, not a code check.

### 2.2 The Cloud principal and the role

The token's claims are checked in `CloudSignIn.claims` (`server/gate-cloud.mjs:198-217`) and the
resulting principal is admitted by `CloudSignIn.accepts` (`server/gate-cloud.mjs:165-170`). The
principal is exactly `{ issuer, subject, roles, workspace }`; `issuer` is the configured identity
issuer, `subject` is the token's `sub`, `workspace` is the token's `workspace`, and `roles` is the
known subset of the token's roles (`server/gate-cloud.mjs:198-217`). `accepts` requires that issuer,
this workspace, at least one known role and one of `owner` or `admin`, and no fifth field
(`server/gate-cloud.mjs:165-170`). Unknown roles are dropped; the token cannot add a role the
gate does not know (`server/gate-cloud.mjs:207-209`). Members and guests are refused while Cloud
workspaces stay owner-only (`server/gate-cloud.mjs:34-37`; test at
`server/test/gate-cloud.test.mjs:422-436`). A local owner principal is refused by a Cloud store and
a Cloud principal is refused by a file-backed self-hosted store (`server/test/gate-cloud.test.mjs:431-435`).

The header that reaches DSH is `X-Automagik-Principal`, and the gate replaces rather than forwards
it (`server/gate-upstream.mjs:44-58`; test at `server/test/gate.test.mjs:123-141`). DSH does not
interpret that header as its caller principal; its routes keep using DSH's owner peer
(`server/README.md:730-736`; delivery 0 evidence at `docs/cloud/0024-delivery-0-evidence.md:57-63`).

**What it proves.** A principal that reaches A's session and A's DSH can only come from a token
signed for A's workspace by A's configured Cloud issuer, with a known role and at least owner or
admin. The four fields are exact; a local principal cannot be smuggled into Cloud mode, and a
Cloud principal cannot be smuggled into self-hosted mode. A role in the token is a role from
Cloud's answer, not one the browser or the request can set.

**What it does not prove.** The identity issuer is a configured value, not a claim in the token.
The gate cannot check that the Cloud service's `(issuer, subject)` binding is genuine; only Cloud's
database can. The role is also Cloud's assertion; the gate can check that the string is a known
role, not that the person holds it. A Cloud bug or a Cloud signing-key compromise can mint
`{ subject: <anyone>, workspace: A, roles: ["owner"] }` and the gate will admit it. The
`workspace` is the configured value, not an attestation of the VM: a gate copied with A's settings
into B's VM would accept A's tokens and label them A. Nothing in the repository ties
`AUTOMAGIK_GATE_CLOUD_WORKSPACE` to the VM the gate runs in. Finally, DSH sees one owner for every
admitted person; the principal header is metadata. Role filtering inside DSH is not implemented,
which is why the current mode is owner-only. That is a within-workspace limit, but it means the
gate's role check is the only role control in the reviewed path.

### 2.3 The workspace token and its `aud`

The token is a JWS compact JWT. The gate accepts only EdDSA over Ed25519, with a `kid` that the
configured published key set names (`server/gate-cloud.mjs:218-241`). The key set is fetched from
the configured HTTPS URL at first use, kept at most five minutes, refetched for an unknown `kid` at
most every 30 seconds, and a failed fetch keeps no key (`server/gate-cloud.mjs:172-187`). The set
must hold one or two usable public OKP/Ed25519 keys (`server/gate-cloud.mjs:117-133`); a private
key, a duplicate `kid`, a `key_ops` that does not include verify, or more than two usable keys
refuses the whole set, and a non-OKP key is skipped (so a set with nothing usable is refused). The
token's `jku`, `jwk` and `x5u` are never followed; the key comes only from the configured set
(`server/gate-cloud.mjs:225-230`).

`claims` (`server/gate-cloud.mjs:198-217`) requires `ver` 1, the exact configured `iss`, an `aud`
string equal to the configured workspace, `workspace` equal to `aud`, a non-empty `sub` of at most
256 characters, at least one role and at most 16, `iat` and `exp` safe integers, `exp > iat`,
`exp - iat` at most 300 seconds, `iat` not more than 30 seconds in the future, `exp` in the
future, and an optional `nbf` not more than 30 seconds in the future. The session's hard end is the
earlier of the token's `exp` and five minutes from now (`server/gate-cloud.mjs:210-216`).

**What it proves.** A token minted for A and signed by a published key is refused by B's gate on
`aud` and `workspace`, even when its signature is valid; the test builds two gates with two
workspace settings and the same signer and checks both directions (`server/test/gate-cloud.test.mjs:229-256`).
A token for another issuer, an expired token, an over-five-minute token, a future token, a token
with a missing or array `aud`, a wrong key, an unknown `kid`, `alg: none`, `alg: RS256` and a
header-supplied key are all refused (`server/test/gate-cloud.test.mjs:229-295`). Two key slots
work across a rotation; more than two keys, a private key and a duplicate `kid` fail closed
(`server/test/gate-cloud.test.mjs:367-392`). The token is never in a URL, a query string, a
fragment, a log or the gate store; it stays in the gate's memory and is sent only to Cloud as the
renewal proof (`server/gate-cloud.mjs:236-239`; `server/gate-store.mjs:17-23`; test at
`server/test/gate-cloud.test.mjs:206-226` and `:879-903`).

**What it does not prove.** The token is a bearer credential. Version 1 has no `jti`
(`server/gate-cloud.mjs:236-238`; contracts v1 leave it open at
`docs/cloud/contracts-v1.md:398-403`), so a token obtained by anyone who can reach A's gate or
read the gate's memory is usable at A for up to five minutes. It is not bound to the browser, the
session or the VM; its only binding is the workspace id in `aud`/`workspace`. It is not bound to
the instance, so a token for a destroyed workspace whose id is reused would be accepted by the
new VM if the same key and id were used. The key set's authenticity rests on the configured HTTPS
URL and the platform's CA/DNS trust; the repository does not pin the key, the certificate or the
key's custody. A Cloud signing-key leak mints a token for every gate; nothing here would detect it.
The contract leaves the signing algorithm, the key type, the JWKS endpoint and its refresh
interval, the key ids and the rotation overlap open (`docs/cloud/contracts-v1.md:398-403`); the
gate's EdDSA/Ed25519, 30-second skew, five-minute key-set cache and 30-second unknown-`kid`
refetch are implementation choices the Cloud service must match. It does pin the two key slots
(`docs/cloud/contracts-v1.md:372-379`), the five-minute token life (`:355`, `:391`) and the
five-minute session bound (`docs/cloud/contracts-v2.md:147-149`). The token's `sub` and `roles`
are Cloud's claims; the gate cannot prove them. And the token is held in process memory for
renewal; a memory read on the gate's host is outside the gate's own defense.

### 2.4 The single-use open code

The rail posts one `code` as a form to A's gate (`server/gate.mjs:95-125`). The gate checks the
form shape, remembers the code's hash for 15 minutes and refuses a replay before calling Cloud
(`server/gate-cloud.mjs:188-197`, `:242-256`), caps in-flight exchanges at eight
(`server/gate-cloud.mjs:29`, `:244`), and sends only `{ version: 1, code, workspace }` to the
configured exchange URL. It requires the reply to be version 1, a token string and
`expires_in` from 1 to 300, then verifies the token as in section 2.3 (`server/gate-cloud.mjs:242-256`).
The browser never sees the code or token after the exchange, and the open response is a 303 with no
token (`server/gate.mjs:118-125`).

**What it proves.** The code is single-use at the gate and is expected to be single-use at Cloud.
A replay at the gate is refused before Cloud; a replay after a gate restart is refused by Cloud
(the test models a restart) (`server/test/gate-cloud.test.mjs:298-314`). A code for A posted to B
is refused by B's configured workspace and by Cloud's code record (`server/test/gate-cloud.test.mjs:242-256`).
A code or token in a URL, a token in an `Authorization` header, a token in the form and a duplicate
code are refused (`server/test/gate-cloud.test.mjs:317-335`). A failed or malformed exchange
issues no session (`server/test/gate-cloud.test.mjs:456-475`), and more than eight in-flight
exchanges get `429` without consuming their code (`server/test/gate-cloud.test.mjs:477-492`).
The response sets `cache-control: no-store` and `referrer-policy: no-referrer`; the gate logs only
a status and a generated request id (`server/gate.mjs:98-101`, `:122-124`; test at
`server/test/gate-cloud.test.mjs:239`).

**What it does not prove.** The exchange endpoint is a configured URL and the contract leaves open
how Cloud authenticates the gate on it (`docs/cloud/contracts-v1.md:475-483`). The code is a
bearer for one exchange; anyone who obtains it before the exchange and can reach the gate can use
it. The rail Origin check is a browser marker, not authentication: a non-browser client can set the
header. The code's 15-minute gate memory is not a contract value; a gate restart loses it, which is
safe only because Cloud is expected to enforce single use, and that is the Cloud side this
repository does not build. A code leaked by the rail, a browser extension or a proxy is outside
the gate's control. The gate does not prove that the code was issued to *this* VM, only that Cloud
accepts this workspace id; the workspace id is the binding.

### 2.5 Revocation

Cloud's signed call is `POST /_gate/cloud/revocation` (`server/gate.mjs:173-200`). The route
requires the exact path, `POST`, the exact Host, `application/json`, no `Authorization` header and
the `x-automagik-signature` header. It reads the body as raw bytes, caps it at 4096 bytes, and
verifies a detached JWS over the exact bytes with a key from the same published set
(`server/gate.mjs:191-195`; `server/gate-cloud.mjs:301-322`). The call must be version 1,
`event: session.revoke`, this workspace, a non-empty subject, and `removed` or `role_lowered`
(`server/gate-cloud.mjs:323-340`). A `removed` entry blocks a new open at or after its effective
time (`server/gate-cloud.mjs:287-290`); a `role_lowered` entry drops only sessions created at or
before that time (`server/gate-cloud.mjs:294-300`, `:331-339`). After a valid call the gate revokes
every family `drops` selects and answers `204` (`server/gate.mjs:195-199`).

The poll fallback runs every 60 seconds while sessions exist or a removal is pending
(`server/gate.mjs:350-360`). It fetches the list, verifies a detached JWS over the exact body
against the same key set, and applies only a version 1 list for this workspace with a live
`issued_at`/`expires_at` window, at most 1024 entries, and valid subjects and reasons
(`server/gate-cloud.mjs:341-404`). A list for another workspace, a malformed or expired list and
an unsigned or wrongly signed list change nothing (`server/test/gate-cloud.test.mjs:692-719`). A
newer list that omits a removed subject lifts the removal; an older list is ignored
(`server/gate-cloud.mjs:361-392`; tests at `server/test/gate-cloud.test.mjs:721-828`).

**What it proves.** A valid, correctly signed call drops the selected gate sessions before the
gate answers, and open WebSockets close with the family (`server/gate.mjs:347-349`; test at
`server/test/gate-cloud.test.mjs:588-607`). An unsigned or wrongly signed call, a call with an
`Authorization` header, a foreign workspace, a bad version, event, subject or reason changes
nothing (`server/test/gate-cloud.test.mjs:610-658`). A `role_lowered` call drops the sessions that
existed at its effective time and lets the person sign in with the new roles
(`server/test/gate-cloud.test.mjs:661-675`). The poll applies a signed list and ignores a stale,
foreign, malformed or unsigned one (`server/test/gate-cloud.test.mjs:678-828`). A removed subject
cannot open again until a newer list omits them (`server/gate-cloud.mjs:254`, `:361-392`). The
five-minute bound does not actually depend on the poll: a gate session also ends at its token's
`exp`, so a lost call and a lost poll still end the session within five minutes
(`server/gate-store.mjs:104-107`).

**What it does not prove.** A `role_lowered` call drops only sessions created at or before
`issued_at`; a `removed` call drops every session. The contract says a valid call "drops every
session for that subject" (`docs/cloud/contracts-v1.md:525-527`). A session created after a
`role_lowered` call's `issued_at` (for example by an exchange already in flight when the role was
lowered) survives the call. It still ends by its own five-minute bound, and a renewal rechecks
with Cloud, so the worst case is five minutes; but the `role_lowered` call path is weaker than the
contract's literal "every session", and the call has no `effective_at` while the list does. The
test makes this choice explicit by expecting the later session to survive
(`server/test/gate-cloud.test.mjs:661-675`). If the contract's "every" is meant literally, the
`role_lowered` call path needs a fix or the contract needs a sentence. Second, the Cloud sender is
not here. The contract leaves the endpoint, the envelope, the algorithm, the signed bytes and the
key choice open (`docs/cloud/contracts-v1.md:581-586`). The gate has chosen a detached JWS, EdDSA,
`x-automagik-signature`, and the same two-slot key set as the workspace token. The Cloud service
must match that choice; a mismatch is a silent loss of revocation, not a gate test failure. Third,
the same signing key that mints tokens can forge revocations. A key leak is both an access and a
denial-of-service event. Fourth, revocation is the gate's session only: DSH's cookie, the gate-held
DSH credential, a running shell, a reverse tunnel or a copied secret survive it
(`docs/cloud/contracts-v1.md:530-533`; `server/README.md:928-943`). Within A that is the stated
limit. Across A and B it is the VM boundary that must stop a copied credential, not revocation.

### 2.6 Renewal

The browser renewal is `POST /_gate/cloud/renew` with exactly
`{ version: 2, renew: true, workspace }`, the current session cookie, the exact Host and Origin,
and no `Authorization` header (`server/gate.mjs:129-172`). The gate refuses a v1 body, any extra
field, another version, another workspace, a missing or expired session, a missing held token, or a
held token whose `aud` is not the configured workspace, all before Cloud is called
(`server/gate.mjs:146-160`). It sends the exact workspace token it verified at open, server to
server, as the proof; no browser cookie, code or query string leaves the gate
(`server/gate.mjs:161-163`; `server/gate-cloud.mjs:263-285`). Cloud's answer must be version 2, a
token string and `expires_in` from 1 to 300; the gate verifies the new token, requires the same
subject, and refuses a removed subject (`server/gate-cloud.mjs:279-284`). It then revokes the old
family and issues the new session with the rechecked roles (`server/gate.mjs:165-171`).

**What it proves.** A renewal cannot lengthen a session or raise a role from the request; an
unknown field is refused whole (`server/test/gate-cloud.test.mjs:830-877`). The proof is the exact
token the gate verified, not a browser credential (`server/test/gate-cloud.test.mjs:879-903`). A
held token past its `exp` refuses with no grace and never reaches Cloud
(`server/test/gate-cloud.test.mjs:905-922`). A request for another workspace, or a held token whose
`aud` differs, refuses before Cloud (`server/test/gate-cloud.test.mjs:924-946`). A session without
the held token cannot renew (`server/test/gate-cloud.test.mjs:948-958`). A Cloud refusal or a role
that grants no access refuses the renewal and issues no session; a revoked session cannot renew
(`server/test/gate-cloud.test.mjs:960-1002`). Version 1 opens and version 2 renewals never accept
each other's bodies (`server/test/gate-cloud.test.mjs:1004-1045`). The plain
`POST /_gate/session/renew` rotates the cookie but does not extend the Cloud session's hard end
(`server/gate.mjs:273-275`; test at `server/test/gate-cloud.test.mjs:395-419`).

**What it does not prove.** The Cloud side of the recheck. The gate verifies Cloud's answer; it
cannot prove that Cloud verified the token and rechecked the role. The repository's fake Cloud
does what the contract says (`server/test/gate-cloud.test.mjs:111-136`); the real Cloud service is
not built here (`server/README.md:855-857`). A Cloud bug that answers with the same subject and
owner keeps a removed person until the revocation path catches up. A stolen held token is a
stolen renewal proof; the gate's memory read is the same exposure as section 2.3. The renewal is
also a new session every time, so a person who can keep passing Cloud's recheck stays signed in;
that is intended, not isolation.

### 2.7 The DSH hop and the non-browser MCP entries

Every ordinary request and WebSocket goes through the gate to a loopback DSH listener. The upstream
headers are an allowlist: accept, content type and length, conditional and range headers, the
WebSocket handshake, the gate-held DSH cookie, the loopback Host and Origin, and the generated
principal. Browser cookies, `Authorization`, forwarding and identity headers never cross the hop
(`server/gate-upstream.mjs:44-58`). DSH's `Set-Cookie` is stripped on the way back
(`server/gate-upstream.mjs:60-63`). The gate re-mints DSH's credential from its launch file after a
DSH restart and never replays a mutating body (`server/gate-upstream.mjs:15-42`;
`server/gate.mjs:286-298`; tests at `server/test/gate.test.mjs:123-141` and `:220-254`).

There are two non-browser entries. The gate's is `/api/omni-mcp` (`server/gate.mjs:231-259`). It
is reached before the gate session, checks the exact Host, the Origin if present and
`sec-fetch-site`, then forwards the caller's Bearer and the gate-held DSH cookie to DSH's
`/api/omni-mcp`. The gate does not create a session and does not check the Bearer; the plugin at
the upstream route does (`server/README.md:1002-1015`; tests at `server/test/gate-mcp.test.mjs:60-99`).

The plugin's own entry is a separate HTTP MCP listener that `createAgentAccess` starts on
`agentAccessHost`/`agentAccessPort` (`apps/bots-dsh/src/host/agent-access.js:373-410`), loopback
by default (`:108-115`). It admits loopback, private, carrier-grade-NAT, unique-local and
link-local addresses and refuses a public or wildcard bind
(`apps/bots-dsh/test/agent-access.test.js:479`), and it advertises its URL in the owner view
(`apps/bots-dsh/src/host/agent-access.js:416-419`). It requires a valid agent Bearer on every call
(`:212-239`); its origin check is an optional allowlist that also admits a request with no
`Origin` (`:99-105`, `:221-245`). It is not behind the gate, so the gate's Host and Origin checks
do not apply to it.

**What it proves.** A browser cannot smuggle a cookie, Authorization header, forwarded host or
principal to DSH; the gate replaces the principal and strips DSH's cookie from responses. The MCP
route is exact-path, refuses a browser cookie or a wrong Bearer at the plugin, and does not create
a gate session (`server/test/gate-mcp.test.mjs:60-87`). The plugin's own listener refuses a
missing, wrong or revoked token before dispatch, and persists the revocation across a restart
(`apps/bots-dsh/test/agent-access.test.js:83`, `:245`).

**What it does not prove.** The MCP Bearer is a second authentication path with its own scope. The
gate route's only request checks are Host, Origin and `sec-fetch-site`; a non-browser client can
set Origin. The plugin does issue and revoke these tokens itself: `agent-token-create` stores only
the token's sha256 in the workspace's own `agent-tokens.json`, and `agent-token-revoke` writes a
tombstone (`apps/bots-dsh/src/host/agent-access.js:422-437`), tested at
`apps/bots-dsh/test/agent-access.test.js:83` and `:245` and documented at
`server/README.md:1004-1012`. What is not here is the cross-workspace case: no test puts a token
issued in A's home in front of B's listener and requires a refusal, and the direct listener admits
a request with no `Origin`, so the VM and network boundary is what keeps B away. The gate-held DSH
credential is one owner credential for the whole workspace; it is held by the gate, but a Bot with
a shell can read the launch file and mint its own. That is the within-workspace limit at
`server/README.md:730-736`, not a cross-workspace path, as long as the VM boundary holds.

### 2.8 File modes

The gate's own store is private by mode. The store directory is created `0700`
(`server/gate-store.mjs:81`; the claim store does the same at `server/gate-claim.mjs:77`). Session
and owner files are written atomically through a `0600` temporary and renamed
(`server/gate-store.mjs:33-38`, `:54-57`); the claim code file is `0600`
(`server/gate-claim.mjs:35-36`, `:97`); the control socket is `0600`
(`server/gate-control.mjs:47`). The tests assert `sessions.json` and `owner.json` are `0600`
(`server/test/gate.test.mjs:184`, `:209`). The launch URL is `0600`
(`server/entrypoint.mjs:52-60`). A model key file must be `0400` or `0600`
(`server/entrypoint.mjs:40-48`; `server/lib.mjs:117-118`). The image creates `/data/secrets` as
`0700` (`server/Dockerfile:68`, `:82-83`) and runs as uid 1000 (`server/Dockerfile:153`).

**What it proves.** The gate store is readable only by the gate's own uid; no raw session secret is
written; the owner record, claim code and control socket are private; a model key file with a
group- or world-readable mode stops the start. Cloud sessions never touch a file
(`server/gate-store.mjs:73-102`), so there is no Cloud session file to protect.

**What it does not prove.** File modes separate uid 1000 from root, not a Bot from its own
workspace. Every Bot in the workspace runs as the same uid and can read the launch URL and the
model key; the image itself says a Bot that reads the launch credential can impersonate the owner
on loopback (`server/README.md:730-736`). The data directories are created by `ensureDataDirs`
without a mode (`server/lib.mjs:53-75`). On a fresh Incus volume the image's `0700` on
`/data/secrets` is hidden by the mounted volume; the first start creates the directory with the
process umask, and the test that exercises this path says it does not cover a real Incus volume
(`server/test/data-preflight.test.mjs:8-12`; `server/test/workdir.test.mjs:1-8`). The key file
itself is still `0400`/`0600`, but the same uid can read it. None of these modes is a
cross-workspace control. They matter only if two workspaces share a host, a uid or a volume, which
is exactly the VM/volume boundary this review cannot see.

### 2.9 Storage prefix and volume

The only storage prefix in the reviewed path is the existing browser prefix in the Bot team's
client, `omni-ui:` (`apps/bots-dsh/src/client/storage.js:1-14`). Cloud adds no plugin id, route
prefix or storage prefix to existing plugins (`docs/rfcs/0024-automagik-cloud.md:827`). Browser
storage is scoped by origin, so A's `omni-ui:` values are separated from B's only if the two
workspaces have different origins. That is a Cloud-edge property; the gate's `pinOrigin` validates
one origin, it does not create or compare two.

On the server, the data volume is one `/data` with `dsh/`, `bots/`, `workspace/`, `secrets/` and
the launch URL (`server/README.md:201-207`). The gate has its own `/data` in the Compose topology
and reads DSH's volume read-only at `/dsh` (`server/compose.gate.yml:31-36`;
`server/README.md:223-227`, `:688-692`). The gate's store is not in the DSH volume in that
topology. There is no per-workspace server storage prefix in this repository: the workspace id is a
configuration value and a token claim, not a directory name. The host-side measurement view is one
path per workspace (`server/README.md:238-242`), checked one view at a time by
`server/measurement-check.mjs`; it is an operator read path, not tenant storage, and a shared
measurement account can read every workspace it is granted. It is outside the tenant
boundary but it is a real cross-workspace read path on the host and belongs in the private record.

**What it proves.** The reviewed code adds no new browser storage namespace and keeps the gate's
store out of DSH's volume in the Compose topology. **What it does not prove.** That each workspace
has a distinct origin, volume and host path; that a volume is never attached to two workspaces;
that the gate's `/data` is separate in the production VM; that the measurement account is
per-workspace. All of those are the hosting layer, unproven here.

### 2.10 The image and the compute layer

The repository builds one server image, records its digest in the release record and documents
pinning a workspace by that digest (`server/README.md:63-80`, `:671-680`). The image runs as uid
1000 (`server/Dockerfile:153`) and its Compose gate has its own volume, `read_only: true`,
`cap_drop: [ALL]` and `no-new-privileges` (`server/compose.gate.yml:31-36`). Those are container
hardening and provenance, not per-workspace compute isolation. The repository contains no Incus VM
template, no network policy, no per-workspace volume creation, no CPU/memory/disk limit and no
probe from inside a VM. The issue places the VM template in C4.1 and the probes in C4.3; the RFC
fixes the shape (`docs/rfcs/0024-automagik-cloud.md:650-664`) and delivery 4's check
(`:1114-1127`). Neither is in this tree. The only
Incus material is the volume-ownership note (`server/README.md:427-448`) and tests that explicitly
say they do not touch a real Incus volume or instance
(`server/test/data-preflight.test.mjs:8-12`; `server/test/workdir.test.mjs:1-8`).

**What the tests actually instantiate.** The cross-workspace test starts two `CloudSignIn` objects
and two `createGate` servers in one Node process, both pointing at one fake Cloud HTTP server on
loopback (`server/test/gate-cloud.test.mjs:78-204`). That is a strong test of the verifier and the
session code. It is not two VMs, two kernels, two volumes or two networks, and it does not test a
network ACL, a host group, a secret's reach or a disk quota.

## 3. Where isolation rests on something unverified

Each item is a place the current guarantee depends on a value, a stub, an assumption or a check
that only Cloud or the host can make. "Unproven here" means this repository cannot show it.

### U1. The per-workspace VM, volume and network (blocking)

The promise is one Incus VM per workspace, its own volume and its own network (RFC 0024 (g);
Decided 15). No template, creation script, network policy or test exists in this repository. The
Compose file is a two-container topology, not an Incus VM, and it shares DSH's network namespace
(`server/compose.gate.yml:13`). **What would prove it:** the C4.1 template at a pinned image, a
record of one VM and one volume per workspace, and a test that two workspaces are two instances
with no shared disk or network. The private record may name the hosts; this document must not.

### U2. The unreachable list (blocking)

The private network, the build host, the hosting platform's control socket, the identity service's
admin routes and other workspaces are said to be unreachable, while the internet, the Cloud key and
revocation endpoints and the model gateway are said to be reachable (RFC 0024 (g)). There is no
probe, no network policy file and no firewall test in the repository. **What would prove it:** the
C4.3 probes in section 5, run from inside a test VM A against a test VM B and the host, with the
commands and results recorded. A probe that only checks from the host or the edge is not enough.

### U3. The node is not the build host; no root-equal group (blocking)

No code checks the VM's node, the agent account's groups, the `incus-admin` group or a root-equal
capability. The RFC states the rule (`docs/rfcs/0024-automagik-cloud.md:644-648`) and delivery 4
makes it acceptance (`:1125-1126`), but the evidence is a private host record, not a repository
file. **What would prove it:** a signed inventory of the workspace node and its accounts, with
`id`, groups and capabilities; a negative check that `incus` and the control socket are absent or
refused from the workspace. This cannot be proved from inside the VM alone: "this node is not the
build host" needs the host identity, compared in the private record.

### U4. Own secrets (blocking)

The gate holds no Cloud credential; the code and the README say so (`server/gate-cloud.mjs:1-4`;
`server/README.md:871-875`). The workspace still holds a model key, Omni credentials and Bot
secrets, and the repository does not provision them per workspace or prove they are valid nowhere
else. `DEEPSEEK_API_KEY` is one key at the image level (`server/README.md:197-207`), not a
per-workspace issuance. **What would prove it:** a per-workspace secret record, a canary that A's
model key and Omni credential fail at B, and a rotation on removal. The private record can hold
the identifiers; the public record should hold only the canary result.

### U5. The plan limits (blocking)

CPU, memory and disk limits from the plan are promised (RFC 0024 (g)) and absent from the
repository. The image has no cgroup or disk quota setting; the Compose file has no `mem_limit`,
`cpus` or storage quota. **What would prove it:** the VM template's limits, a mapping from plan to
limits, and a stress probe from inside A that reaches the limit without affecting B.

### U6. The Cloud service's half (blocking)

The gate is built and tested against a fake Cloud service; the real service's minting, key
publication, open-code single use, role recheck and revocation sender are "not built yet"
(`server/README.md:855-857`). The contract leaves the exchange path, the code lifetime and format,
the gate authentication on the exchange and the revocation envelope open
(`docs/cloud/contracts-v1.md:475-483`, `:581-586`). **What would prove it:** the Cloud service's
own tests and a joint test against this gate, including one real (test-mode) open, one renewal, one
revocation call and one poll; a mismatch in the envelope or key choice fails the joint test. A fake
with the same shape as the gate's parser cannot prove interoperability.

### U7. The key trust anchor (blocking for a customer promise)

The gate trusts the configured key URL and the platform's TLS/DNS (section 2.3). There is no key
pinning, no transparency log, no proof that the Cloud signing key is held only by Cloud or that it
is not on the build host or a workspace node. The contract leaves the algorithm, key type, key ids
and rotation overlap open. **What would prove it:** a key-custody record (two slots, who can sign,
where the private key lives, rotation and revocation), a key-set signature or pin if the threat
model includes a compromised DNS/CA, and a test that a retired key stops verifying after the
overlap. A private key on the build host would invalidate the promise no matter how good the
gate's verifier is.

### U8. The workspace id is configuration, not an attestation (high)

`AUTOMAGIK_GATE_CLOUD_WORKSPACE` is an environment value checked against the token's `aud` and
`workspace` (`server/gate-cloud.mjs:13`, `:62-78`, `:198-217`). Nothing binds it to the VM, the
volume or the Cloud's workspace record. A gate started with A's settings on B's VM would accept
A's tokens and label them A. A workspace id reused for a new VM would be accepted by the old
token if the key and id match. **What would prove it:** Cloud or the hosting platform writes the
gate's workspace id from the workspace record at VM creation; the gate attests the instance (for
example a Cloud-issued instance identity or a signed config) instead of trusting a text variable;
a test that a copied config fails.

### U9. The token and code are bearer credentials (high)

A token has no `jti`; a code is a bearer until its single exchange. The gate holds the token in
memory for renewal and never binds it to a browser fingerprint, a session or an instance. The
five-minute life is the bound. **What would prove it:** the Cloud side's replay and issuance rules,
a gate-side `jti` memory if the contract adds one, and a test that a token captured from A's gate
memory or a code captured from the rail cannot be used at B. The current tests prove A's token is
refused at B on `aud`; they do not prove a captured A token cannot be used at A.

### U10. The revocation call's "every session" (medium)

A `role_lowered` call drops only sessions created at or before `issued_at`; a `removed` call drops
every session. The contract says a valid call "drops every session" for that subject
(`docs/cloud/contracts-v1.md:525-527`), while the list uses `effective_at`. A session created after
a `role_lowered` call's `issued_at` survives that call until its own five-minute end or a renewal.
**What would prove it:** a contract sentence that the call's effective time is `issued_at`, or a
gate change that drops every session for the subject and a test for a session created during the
call; a Cloud sender that does not mint an old-role token after a role change.

### U11. Revocation ends a gate session, not a person (medium)

DSH's cookie, the gate-held DSH credential, a running shell, a reverse tunnel and a copied secret
survive revocation (`docs/cloud/contracts-v1.md:530-533`). The contract says secrets are rotated and
processes reviewed, or the workspace is restored; those are operational steps, not code in this
repository. **What would prove it:** a runbook that actually rotates the workspace's secrets and
reviews its processes on removal, and a test that an old model key or Omni credential fails after
rotation. Across workspaces, the VM boundary must stop the copied secret; that is U1/U2.

### U12. File modes and the shared uid (medium)

The gate store is private; the workspace's Bots are the same uid as the workspace and read the
launch URL and model key (section 2.8). `ensureDataDirs` does not set modes
(`server/lib.mjs:53-75`), and the image's `0700` on `/data/secrets` is not tested on an Incus
volume. **What would prove it:** a file-mode test on a fresh Incus volume, a secrets directory that
is `0700` after first start, and a statement of which secrets are expected to be readable by the
workspace's own Bots. Cross-workspace still needs the volume boundary.

### U13. Distinct origins and browser storage (medium)

The gate validates one exact origin; the browser storage prefix is per origin. The repository does
not create or compare workspace origins, and cookies are scoped by host, not port. **What would
prove it:** the Cloud edge's origin allocation, a browser test that A's cookie at B is refused and
that A's `localStorage` is not visible at B, and a statement that no two workspaces share a host
(and, if they share a host, that the cookie's host scope is acceptable).

### U14. The non-browser MCP Bearer and its missing cross-workspace test (medium)

`/api/omni-mcp` bypasses the gate session and authenticates with a Bearer at the plugin
(`server/gate.mjs:231-259`; `server/test/gate-mcp.test.mjs:60-99`). The gate checks Host and
Origin; a non-browser can set Origin. The plugin also starts its own HTTP MCP listener, which is
not behind the gate and admits a no-`Origin` request
(`apps/bots-dsh/src/host/agent-access.js:99-115`, `:373-410`, `:221-245`). The token's issuance
and revocation are in this repository: `agent-token-create` keeps only the sha256 in the
workspace's own home and `agent-token-revoke` writes a tombstone (`:422-437`), tested at
`apps/bots-dsh/test/agent-access.test.js:83` and `:245`, and documented at
`server/README.md:1004-1012`. What is missing is the cross-workspace refusal: no test issues a
token in A's home and presents it to B's listener. **What would prove it:** a two-home test (two
`createAgentAccess` fixtures with separate homes) in which A's token gets `401` at B's listener,
and the P5/P14 probes from inside a test VM A against B's address.

### U15. No per-workspace storage prefix on the server (low)

There is no per-workspace server storage prefix; `omni-ui:` is a browser prefix. The volume and
host path carry the workspace identity, and the host-side measurement view is a shared read path
(section 2.9). The per-workspace view and its ACL procedure are documented
(`server/README.md:238-290`), and `server/measurement-check.mjs` checks one workspace's read-only
view as the measurement identity: the exposed roots are readable and not writable, a credential
or settings file that is readable fails, and a stale view fails. Its tests are
`server/test/measurement-check.test.mjs`. **What would prove it:** the private host record that
every workspace has its own `/srv/automagik/measure/<workspace>` view, a run of the checker
against each, and a grant for the shared measurement account that covers only those paths.

### U16. Hard-coded choices the Cloud side must match (low)

The gate hard-codes values the contract partly pins and partly leaves open
(`server/gate-cloud.mjs:19-45`, `:137-170`). Pinned, and so not open questions: the token's
`exp - iat` at most 300 seconds and its five-minute life (`docs/cloud/contracts-v1.md:355`,
`:391`), the five-minute session bound (`docs/cloud/contracts-v2.md:147-149`), two key slots
(`docs/cloud/contracts-v1.md:372-379`), the four roles (`:352`) and a poll at least every five
minutes (`:570`). Still the gate's own choices, which the contract leaves open: EdDSA/Ed25519
(the algorithm and key type, `:398`), the five-minute key-set cache and 30-second unknown-`kid`
refetch (the JWKS endpoint and refresh interval, `:398`), 30 seconds of clock skew (no accepted
skew is named at `:398-403`), the 60-second poll below the five-minute ceiling (`:584`), eight
in-flight exchanges, 1024 revocation entries, the 15-minute code memory, the 64 KiB response
bound and the `x-automagik-signature` detached-JWS envelope (`:581-586`). The Cloud service must
match these for interoperability. **What would prove it:** those open values in the Cloud service's
contract or configuration, a joint test, and a note in the contract or the RFC that they are now
the chosen values.

## 4. What must be true before this gate can be called done

These are the checkable pass conditions. "Test" means a test in this repository; "contract" means
a pinned document or RFC; "nothing" means no artifact in this repository shows it. A test in this
repository is not a VM probe; the "Covered today by" column says which.

| ID | Condition | Covered today by | Status |
|---|---|---|---|
| I1 | Each workspace is one Incus VM from the pinned template; no two workspaces share a kernel, volume or network. | Contract only: RFC 0024 (g), Decided 15. No code or test. | Unproven here |
| I2 | The unreachable list and the reachable list are true from inside a test VM, with a probe per line. | Nothing. C4.3 owns the probes; section 5 defines them. | Unproven here |
| I3 | The workspace node is not the build host; no agent account holds `incus-admin` or a root-equal group. | Contract only: delivery 4 acceptance; the proof is a private host record. | Unproven here |
| I4 | Each workspace's secrets (model keys, Omni credentials, Bot secrets) are issued for it and valid nowhere else. | Nothing for per-workspace issuance. The gate holds no Cloud credential (code + README). | Partly; issuance unproven here |
| I5 | CPU, memory and disk limits from the plan are enforced. | Nothing. | Unproven here |
| I6 | Each workspace has its own origin; A's session and browser storage are not usable at B. | Contract: RFC 0024 (g) "its own origin". Gate test: origin-bound store (`server/test/gate.test.mjs:177-200`). No two-origin browser test. | Partly |
| I7 | A's workspace token is refused by B even with a valid signature. | Test: `server/test/gate-cloud.test.mjs:229-256`; contract: v1 section 4. In-process, not a VM probe. | Covered by a test |
| I8 | A's gate session ends at the token's expiry and in at most five minutes; it is origin-bound; a new open replaces it; revocation closes it and its sockets. | Tests: `server/test/gate-cloud.test.mjs:395-419`, `server/test/gate.test.mjs:177-200`; contract: v1 section 4. | Covered by a test |
| I9 | Only a Cloud principal for this workspace and identity issuer, with a known role and owner/admin, is admitted; a lowered role drops old sessions and a role that no longer grants access is refused. | Tests: `server/test/gate-cloud.test.mjs:422-436`, `:661-675`, `:830-1002`; contract: v2. The Cloud recheck is a fake. | Gate side covered; Cloud side unproven |
| I10 | A valid revocation call drops the intended gate sessions at once; the poll applies within five minutes; a stale, foreign, unsigned or malformed call/list changes nothing; a removed subject cannot open until a newer list. | Tests: `server/test/gate-cloud.test.mjs:588-828`; contract: v1 section 6. The Cloud sender and the envelope are not built or pinned. | Gate side covered; Cloud side unproven |
| I11 | The open code is single-use at the gate and at Cloud; no token or code is in a URL, a browser, a log or the gate store; the exchange is server-to-server. | Tests: `server/test/gate-cloud.test.mjs:206-226`, `:298-335`, `:456-492`; contract: v1 section 5. Cloud's single use is faked. | Gate side covered; Cloud side unproven |
| I12 | Only an EdDSA/Ed25519 token with a published `kid`, two key slots, no private key and no header-supplied key is accepted; rotation works and an unknown key id fails. | Tests: `server/test/gate-cloud.test.mjs:271-295`, `:367-392`; contract: v1 section 4. Key publication is Cloud's, not here. | Gate side covered; key custody unproven |
| I13 | The gate store is private to the gate; Cloud sessions are memory-only; no raw session secret is written; the workspace's own data is not the gate's store. | Tests: `server/test/gate.test.mjs:184`, `:209`; code. No fresh-Incus `/data/secrets` test; no same-uid Bot test. | Covered for the gate store; workspace modes unproven |
| I14 | The gate's workspace id is bound to the VM and its Cloud record, not copied text; a reused workspace id does not revive an old token. | Nothing. | Unproven here |
| I15 | The non-browser MCP Bearer is scoped to one workspace and refused at another's origin. | Gate route test: `server/test/gate-mcp.test.mjs:60-99`; plugin issuance and revocation tests: `apps/bots-dsh/test/agent-access.test.js:83`, `:245`. No two-home A/B refusal test. | Partly |
| I16 | The image a workspace runs is the release's recorded digest, not `:latest` or another tag. | Contract/docs: `server/README.md:63-80`; record code. No workspace-side check here. | Contract only |

The pass list is not met. An owner sign-off could record an accepted risk for some of these; it
would not make I1-I5, I14 or the Cloud half true. This document records the evidence, not the
acceptance.

## 5. The probes C4.3 must run

Each unreachable line needs a probe from inside a test VM A, with a second test VM B where the line
compares workspaces. The private record may name the hosts and addresses; this page uses
placeholders. A probe is not a screenshot of a policy; it is a command, its exit status and its
output, run on the image digest the workspace will use.

| Probe | From | Target | Expected | Evidence to keep |
|---|---|---|---|---|
| P1 private network | A | a private-network test endpoint, `{private-address}:{port}` | no route, timeout or refusal; no DNS answer for a private name | command, exit status, timing, the route table |
| P2 build host | A | the build host's private name/address, `{build-host}` | no route, timeout or refusal | command, exit status, `getent hosts` result |
| P3 control socket | A | the hosting platform's control socket path, `{control-socket}` | the path is absent or the connection is refused; no mount of the socket | `ls`, `ss`, `stat`, mount table |
| P4 identity admin | A | the identity service's admin origin/path, `{identity-admin-url}` | 403/404/timeout; no admin token; public sign-in endpoints may answer | HTTP status, TLS result, no credential |
| P5 other workspace | A | B's private address, volume or network, `{workspace-b}` | no route, no volume, no shared mount | command, exit status, mount table, `ip route` |
| P6 volume | A | a sentinel file on B's volume and a host-side path | the sentinel is unreadable; no B volume is mounted | `findmnt`, `ls`, exit status, the private path hashed or redacted |
| P7 internet | A | a public HTTPS endpoint | success | status, certificate check, timing |
| P8 Cloud keys and revocation | A | the configured key and revocation URLs | 200 and valid JSON; no credential sent | status, content type, response size |
| P9 model gateway | A | the gateway route with A's gateway token | success with A's token; 401 without it | status, token scope, no token printed |
| P10 limits | A | the VM's cgroup and disk limits | the plan's numbers; a stress run reaches the limit and B is unaffected | `memory.max`, `cpu.max`, disk quota, stress result |
| P11 no root-equal group | A | `id`, groups, capabilities, `incus` | no `incus-admin`, no root-equal group, no control socket, `incus` refused | command output, capability set |
| P12 own secrets | A | A's model key and Omni credential at B | both fail at B; A's works | canary status only; no secret printed |
| P13 browser origin | a browser at A | B's origin | 401 without a B session; A's cookie is not accepted; A's `localStorage` is not visible | browser test, cookie jar, storage dump redacted |
| P14 MCP Bearer | A | B's MCP route with A's Bearer | 401 | status; no Bearer printed |

The node-identity line (I3) is a host record, not a probe from inside A: from inside A one can
show that the build host is unreachable, not that the node is a different machine. The private
record must compare a host fingerprint with the build host's. That is a gap in the acceptance text,
not in the gate code.

## 6. Smaller findings, not isolation blockers

- **`role_lowered` map is never pruned.** `applyList` adds every lowered entry and no newer list
  removes one (`server/gate-cloud.mjs:385-391`). It only affects sessions created before the
  entry's time, so a stale entry cannot drop a new session; but the map grows for the life of the
  gate. A bounded or time-pruned map would be safer.
- **A future-dated revocation is accepted.** `instant` checks RFC 3339, not "not in the future"
  (`server/gate-cloud.mjs:44-51`, `:323-340`). A trusted signer can schedule a removal or a role
  cut far ahead. The signer is Cloud, so this is a Cloud-bug robustness issue, not a tenant path.
- **`ensureDataDirs` does not set modes.** On a fresh Incus volume, `/data/secrets` relies on the
  process umask, not the image's `0700` (`server/lib.mjs:53-75`; `server/Dockerfile:82-83`). The
  key file itself is checked; the directory is not.
- **The session store has no family cap.** A browser without a cookie can create many Cloud
  sessions until each expires; `MAX_EXCHANGES` caps concurrent exchanges, not stored families.
  This is a within-workspace memory-growth issue, not a cross-workspace one.
- **The non-browser MCP entries leave Origin a browser marker.** A non-browser can set it on the
  gate's `/api/omni-mcp`, and the plugin's direct listener admits a request with no `Origin` at
  all; the Bearer is the real authentication. The tests are honest about this, but the README
  should not read as if the gate authenticates that route.

## 7. What this record does not do

- It does not run a VM, a container, an Incus instance, a production service or a real workspace.
- It does not print a token, a key, a cookie, a workspace id, a host name, a host-local path or a
  home directory. The private record named by the issue is where host names and addresses belong.
- It does not sign off the gate. The issue asks for a reviewer's verdict and the owner's sign-off;
  this is the public evidence record that a reviewer and the owner can sign against. The verdict
  this record supports is **not passed** until the conditions in section 4 hold and the probes in
  section 5 are recorded.
- It does not close #911. The issue's acceptance is a recorded verdict, the owner's sign-off and a
  probe per unreachable line; a document alone is not that.

**Evidence commands run for this record** (on the reviewed tree, no code changed; all through
`scripts/capped-run`):

| Command | Result |
|---|---|
| `node herdr/scripts/privacy-check.mjs` (through `scripts/capped-run`) | clean; two folders still pending #795 |
| `node server/secrecy.mjs --repo .` (through `scripts/capped-run`) | clean: 2956 tracked text files, no Stripe key, price or account id |
| `node --test server/test/gate-cloud.test.mjs` | 37 tests, 37 passed, 0 failed |
| `node --test server/test/gate.test.mjs` | 19 tests, 19 passed, 0 failed |
| `node --test server/test/gate-mcp.test.mjs` | 3 tests, 3 passed, 0 failed |
| `node --test server/test/gate-compose.test.mjs` | 1 test, 1 passed, 0 failed |
| `node --test server/test/workdir.test.mjs server/test/data-preflight.test.mjs` | 7 tests, 7 passed, 0 failed |

The gate tests are in-process with fakes; the Compose test parses the topology; the volume tests
spawn a child but do not touch a real Incus volume or instance. None is a VM probe; they prove the
gate code, not the compute boundary.
