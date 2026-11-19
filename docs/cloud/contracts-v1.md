# Automagik Cloud public contracts, version 1

| Field | Value |
|---|---|
| Issue | #904 (C0.3) |
| RFCs | [0024](../rfcs/0024-automagik-cloud.md), Contracts introduced, (b), (d), (g); [0025](../rfcs/0025-cloud-economics.md), entitlements and the gateway boundary (g) |
| Depends on | [RFC 0024 delivery 0 evidence](0024-delivery-0-evidence.md) (C0.1) |
| Written | 2026-11-10 |
| Lane | docs (no release) |
| Version | 1 |
| Status | Frozen at merge; later changes are additive only |
| Owner review | Required for the entitlements section: billing-adjacent (RFC 0025, (h)). |

This is the one page every lane builds against: the desktop, the gate, the plugins and the Cloud
service. It pins the principal, the owner record, the OIDC contract the desktop and a remote gate
meet, the workspace token, the single-use open code and its exchange, the revocation call and its
poll fallback, and the entitlements document.

The Cloud service itself starts private; its contracts are public (RFC 0024, open question 16).
This page holds no private value. Values in `{...}` are placeholders: no issuer, client id, host,
domain, address, account or home path appears here, and none appears in a test, a fixture or a
default config. The one concrete address is the loopback redirect below, whose port is the app's
choice at run time.

`Open:` marks a choice the RFCs leave open. It is not decided here, and no lane may depend on an
answer before the RFC or the contract's owner decides it. Everything not marked `Open:` is pinned.

## The freeze rule

This page is frozen at the merge of issue #904's pull request. After that:

- a change is additive only: a new optional field, or a new contract version;
- a new enum value is allowed only where readers are already required to ignore values they do
  not know; otherwise it is a new version;
- no field is renamed, removed, retyped or given a new meaning; a changed meaning is a change to
  RFC 0024 (Contracts introduced);
- a breaking change is a new version with its own RFC and issue, never an edit to this page.

Readers ignore fields they do not know. A writer never relies on an older reader honouring a
field it does not know. Where an unknown or absent field gates an action, the reader fails
closed: no entitlement, no session, no workspace opened.

Each contract is version 1. The version is carried as follows:

| Contract | Version | Carried by |
|---|---|---|
| The principal | 1 | this page; RFC 0024 fixes its shape to four fields, so it has no fifth member |
| The owner record | 1 | the `version` field of the record |
| The OIDC contract | 1 | this page; discovery and the ID token use their standard fields, with no version claim |
| The workspace token | 1 | the `ver` claim of the token |
| The open code and its exchange | 1 | the `version` field of the request and the response |
| The revocation call and poll list | 1 | the `version` field of the call and the list |
| The entitlements document | 1 | the `version` field of the payload |

A version field is a number. A reader that does not know a version refuses it; it never reads it
as version 1.

## 1. The principal

RFC 0024 gives every request a plugin sees one principal, whoever proved it: `{ issuer, subject,
roles, workspace }`, version 1 (RFC 0024, (b) and Contracts introduced). The shape is exactly these
four fields; the version is this page's, not a fifth member.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `issuer` | string | yes | `local:<instance-id>` for a self-hosted instance or the desktop's own DSH; the identity service's issuer for a Cloud workspace or a linked instance. |
| `subject` | string | yes | The person, keyed by `(issuer, subject)`: the owner record's local id, or the person's subject at the identity service. Never an email or a display name. |
| `roles` | array of strings | yes | One or more of `owner`, `admin`, `member`, `guest`, from Cloud's database on a Cloud workspace; `["owner"]` for a self-hosted instance. A token group claim never sets it. |
| `workspace` | string | yes | The workspace id; the instance id for a self-hosted or linked instance. |

A reader must not assume `roles` has exactly one element. The allowed roles, from RFC 0024 (e):

| Role | What it may do |
|---|---|
| `owner` | everything, billing and plan included; delete or transfer the organisation; manage admins; at least one per organisation |
| `admin` | people and roles below owner, workspaces, Omni channels, model keys; no billing, no deleting the organisation |
| `member` | the workspaces they are added to, the Bots the gate allows, their own work |
| `guest` | one workspace, allowlisted Bots only; no terminals, Code mode or settings |

The principal's source is the table in RFC 0024 (b):

| Where | `issuer` | `subject` | `roles` | `workspace` |
|---|---|---|---|---|
| Desktop, its own local DSH | `local:<instance-id>` | the owner record's local id | `owner` | the instance id |
| Self-hosted web instance, claimed | `local:<instance-id>` | the owner record's local id | `owner` | the instance id |
| Cloud workspace | the identity service's issuer | the person's subject there | from Cloud's database | the workspace id |
| Self-hosted instance linked to Cloud | the identity service's issuer | the owner's Cloud subject | `owner` | the instance id |

Rules:

- The gate, or the desktop's shell for its own local DSH, is the only place a principal is made.
  DSH and the plugins receive it from there, over a channel a browser cannot set; it is never read
  from a request header.
- Plugins read the principal and never branch on how it was proved: OS user, passkey or OIDC.
  A check that needs "is this the owner" asks the roles.
- Cloud authorisation is Cloud's database, checked on every request. The identity token's group
  claims are never authorisation (RFC 0024, (e)).
- The instance id is random, made once and never derived from the host, so two instances never
  share an issuer (RFC 0024, Contracts introduced).
- A new principal field is additive. A changed meaning is a change to RFC 0024.

Example, a self-hosted owner:

```json
{
  "issuer": "local:{instance-id}",
  "subject": "{owner-local-id}",
  "roles": ["owner"],
  "workspace": "{instance-id}"
}
```

Example, a Cloud member:

```json
{
  "issuer": "{identity-service-issuer}",
  "subject": "{person-subject}",
  "roles": ["member"],
  "workspace": "{workspace-id}"
}
```

**Open:** the process-boundary transport and encoding. The field names and types above are the
contract; the gate's and the shell's own channel is outside this page, and the examples are JSON.

*Source:* RFC 0024 lines 197-227 and 633-635.

## 2. The owner record

The owner record is the gate's own record of the instance's owner, in the gate's store; on the
desktop it is in the app's own home. It is outside every Bot's folder. It holds a stable local id
and an optional linked Cloud identity (RFC 0024, (b), (j) and Contracts introduced).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `local_id` | string | yes | The owner's stable local id, made at the claim or the desktop's first run. It is the principal's `subject` for a self-hosted instance. |
| `instance_id` | string | yes | The random id made once for this instance; the value in `local:<instance-id>`. It is the principal's `workspace` for a self-hosted or linked instance. |
| `linked` | object | no | Absent until the owner links the instance to Cloud ((j)); it never rewrites `local_id` or `instance_id`. |
| `linked.issuer` | string | yes, if `linked` | The identity service's issuer. |
| `linked.subject` | string | yes, if `linked` | The owner's Cloud subject. |

Example, unlinked:

```json
{
  "version": 1,
  "local_id": "{owner-local-id}",
  "instance_id": "{instance-id}"
}
```

Example, linked:

```json
{
  "version": 1,
  "local_id": "{owner-local-id}",
  "instance_id": "{instance-id}",
  "linked": {
    "issuer": "{identity-service-issuer}",
    "subject": "{person-subject}"
  }
}
```

Rules:

- The owner record's holder is `owner`; the record carries no role field, because a self-hosted
  instance has one human and that human is its owner.
- A record written by a newer build never reads as unclaimed in an older one. An older reader
  ignores fields it does not know, treats a record with a valid `local_id` and `instance_id` as
  claimed, and never starts a new claim over it. A record whose `version` is greater than the
  reader's is claimed, not unclaimed; the reader refuses to reset it (RFC 0024, (b)).
- Linking adds `linked` and keeps the local claim and passkeys as break-glass. Unlinking removes
  only `linked`; it does not rewrite the local identity. Linking never merges accounts by email.
- The record is keyed by the local id; `(linked.issuer, linked.subject)` keys the Cloud principal,
  never an email.

**Open:** the store's file name, path and mode. Version 1 keeps `instance_id` in this record, so
`local:<instance-id>` resolves from one record; the RFC names the id and the record, not a second
store. The record is JSON.

*Source:* RFC 0024 lines 223-226 and 636-639.

## 3. The OIDC contract: the desktop and a remote gate

The desktop is a native app: a public OIDC client with no secret, using the authorization code
flow with PKCE (S256), `state` and `nonce`, and an exact loopback redirect (RFC 0024, (d)). The
Cloud service and a remote self-hosted gate publish the same contract, so one desktop flow meets
both (RFC 0024, delivery 1 acceptance).

| Sign-in | Authorization server | ID token issuer | Audience |
|---|---|---|---|
| Cloud | the Cloud service | the Cloud service | `{desktop-client-id}` |
| Remote self-hosted instance | the gate | the gate | `{gate-client-id}` |

The identity service is not the desktop's authorization server. The Cloud service is the identity
service's only relying party and its one confidential client (RFC 0024, Words and (e)): the Cloud
service runs the code exchange with the identity service server-side. The identity service is not
the Cloud service's relying party. The browser may be redirected to the identity service for the
passkey ceremony, but the ID token the desktop receives is the Cloud service's. The Cloud
service's issuer is `{cloud-issuer}`, not the identity service's issuer; a remote gate's issuer is
`{gate-issuer}`, the stable HTTPS name it serves (RFC 0024, (c) origins). The identity service's
issuer is the principal's issuer inside a Cloud workspace (section 1); the OIDC issuer the
desktop checks is the Cloud service's. They are different strings and are never compared.

### Discovery

Both servers publish OpenID Connect Discovery 1.0 at
`{issuer}/.well-known/openid-configuration`, where `{issuer}` is the authorization server's
issuer. The document's `issuer` must equal `{issuer}` exactly, with no trailing-slash
normalisation and no redirect to another issuer.

| Metadata | Required | Use |
|---|---|---|
| `issuer` | yes | the exact issuer the desktop checks against its configuration |
| `authorization_endpoint` | yes | where the system browser starts the flow |
| `token_endpoint` | yes | where the desktop trades the code and verifier for tokens |
| `jwks_uri` | yes | the keys that verify the ID token |
| `response_types_supported` | yes | must include `code` |
| `grant_types_supported` | yes | must include `authorization_code` |
| `code_challenge_methods_supported` | yes | must include `S256` |
| `token_endpoint_auth_methods_supported` | yes | must include `none` for the public desktop client |
| `scopes_supported` | yes | must include `openid` |

**Open:** whether the servers also publish the OAuth 2.0 authorization server metadata document
(RFC 8414). Version 1 uses the OIDC discovery document above.

### Issuer and audience

- The desktop is configured with the expected issuer for the sign-in it starts, and checks the
  discovery document's `issuer` and the ID token's `iss` against it. It never takes the issuer
  from the redirect or from an unverified token.
- The audience is the desktop's client id at that authorization server: `{desktop-client-id}` for
  Cloud, `{gate-client-id}` for a remote gate. The ID token's `aud` is that id, or an array whose
  only element is that id. The desktop checks it.
- The desktop is a public client: no client secret is stored, sent or required. PKCE is the proof.

**Open:** how a remote gate learns the desktop's client id (a configured registration or dynamic
registration); the RFC does not choose. **Open:** whether the desktop requests `profile` or `email`
beyond `openid`; if present, those claims are display-only.

### The flow

1. The app binds a loopback port, then opens the system browser at the authorization endpoint
   with the parameters below. It never shows the sign-in page in its own window and never embeds
   a browser.
2. The browser completes the ceremony at the authorization server (for Cloud, through the identity
   service's passkey pages) and returns to the exact loopback redirect.
3. The app checks `state` and `nonce`, refuses a second request, closes the listener after one
   request or a few minutes, and trades the code and verifier at the token endpoint.
4. The app checks the ID token's `iss`, `aud`, `exp`, `iat` and `nonce` before it uses the
   sign-in. A check that fails issues no session and stores nothing.

| Authorization request parameter | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | `{desktop-client-id}` or `{gate-client-id}` |
| `redirect_uri` | `http://127.0.0.1:<port>/callback` |
| `scope` | `openid` |
| `state` | `{state}` |
| `nonce` | `{nonce}` |
| `code_challenge` | `{base64url(sha256(code-verifier))}` |
| `code_challenge_method` | `S256` |

The loopback redirect is exact: the literal `127.0.0.1`, the path `/callback`, and a port the app
bound before opening the browser. The port is the app's choice at run time and is not
pre-registered. Both servers accept any loopback port, as RFC 8252 (7.3) requires: a fixed port,
a port allowlist, or a registration per port is a contract violation. A request for another host,
another path, or a second time is refused, and the listener closes.

**Open:** whether the servers also accept `http://localhost:<port>/callback`. Version 1 uses the
`127.0.0.1` literal; the any-port rule applies to whichever loopback host is registered.

The deep link is not used: `automagik://` stays open-only and never carries an authorization code
or a token (RFC 0024, (d) and Contracts introduced).

### The ID token

| Claim | Type | Required | Meaning |
|---|---|---|---|
| `iss` | string | yes | the authorization server's issuer: `{cloud-issuer}` or `{gate-issuer}` |
| `sub` | string | yes | the person: their subject at the identity service for Cloud, the owner record's local id for a remote gate |
| `aud` | string or array | yes | `{desktop-client-id}` or `{gate-client-id}`; an array has exactly one element |
| `exp` | number | yes | expiry, seconds since the epoch |
| `iat` | number | yes | issued at, seconds since the epoch |
| `nonce` | string | yes | the request's nonce, unchanged |
| `email`, `name` | string | no | display only, self-asserted; never a key and never authorisation |
| `groups` | array of strings | no | a coarse signal only; never authorisation (RFC 0024, (e)) |

The ID token is not a principal. Cloud builds the principal from its own database and the
`(issuer, sub)` it took from the identity service; a group claim, an email or a display name never
sets a role or a workspace. A remote gate builds `local:<instance-id>` with `owner` from its owner
record.

Example ID token payload:

```json
{
  "iss": "{cloud-issuer}",
  "sub": "{person-subject}",
  "aud": "{desktop-client-id}",
  "exp": 0,
  "iat": 0,
  "nonce": "{nonce}"
}
```

### Tokens and storage

- A short access token stays in the main process's memory. The page never holds it.
- The refresh token rotates on every use; a rotated token presented again revokes the family.
  It goes to the OS secure store through Electron's `safeStorage`; where there is no secure store,
  nothing is written and the refresh token stays in memory only, so the person signs in at each
  launch (RFC 0024, (d); delivery 0 evidence, section 3).
- The page never holds an access token, a refresh token, an ID token or an authorization code.
- The Cloud service ends the person's identity-service session where the identity service's
  discovery document offers an end-session endpoint; the Cloud session is revoked either way
  (RFC 0024, (e)).
- Signing out clears the stored refresh token. **Open:** whether the desktop calls its
  authorization server's end-session endpoint when discovery offers one.

**Open:** the access token's format and audience, and what API it calls. **Open:** the accepted
clock skew when checking `exp` and `iat`.

### Refusals

A wrong `state`, a wrong `nonce`, a wrong issuer, a wrong audience, an expired or replayed code, a
missing verifier, a redirect other than the exact loopback rule, or a second loopback request
issues no tokens and stores nothing. The desktop and both servers fail closed; a refusal is
logged without the code, the verifier or a token.

*Source:* RFC 0024 lines 159-161, 338-352, 367-374 and 740-748; delivery 0 evidence, sections 3
and 4.

## 4. The workspace token

The Cloud service mints a workspace token for one workspace and one person. The gate of that
workspace accepts it, checks it and sets its own session on its own origin. A token for one
workspace is refused by every other (RFC 0024, (g) and delivery 4 acceptance).

The token is a JWT in JWS compact serialisation, signed by the Cloud service:

| Claim | Type | Required | Meaning |
|---|---|---|---|
| `ver` | integer | yes | `1`. |
| `iss` | string | yes | the Cloud service's issuer, `{cloud-issuer}`. |
| `aud` | string | yes | exactly one workspace id. |
| `sub` | string | yes | the principal's subject. |
| `roles` | array of strings | yes | one or more of `owner`, `admin`, `member`, `guest`, from Cloud's database. |
| `workspace` | string | yes | the workspace id; it must equal `aud`. |
| `iat` | number | yes | issued at, seconds since the epoch. |
| `exp` | number | yes | expiry, seconds since the epoch; `exp - iat` is at most 300 seconds (5 minutes). |

Example:

```json
{
  "ver": 1,
  "iss": "{cloud-issuer}",
  "aud": "{workspace-id}",
  "sub": "{person-subject}",
  "roles": ["member"],
  "workspace": "{workspace-id}",
  "iat": 0,
  "exp": 300
}
```

Signing and keys:

- The Cloud service signs with its workspace-token key. The public keys are published for the
  gate to fetch; each key has a key id, and the token's header names it.
- There are two key slots, rotated as RFC 0011 rotates lane keys: the new public key ships while
  the old key still signs, the signer switches later, and the old key is retired after the
  overlap. The gate accepts a token signed by either published slot during a rotation and refuses
  a key id it does not know.
- The gate checks `ver`, `iss`, `aud`, `workspace`, `sub`, `roles`, `iat` and `exp` before it sets
  a session. It accepts only its own audience; a token minted for another workspace is refused
  even if the signature is valid.
- The workspace token is not a Cloud API credential and cannot call Cloud's control plane or
  Stripe. It can be used only at its own gate and cannot be exchanged for another workspace's
  token. RFC 0025 (g) separately lets a Cloud workspace hold a scoped, short-lived, revocable
  gateway token and the gate-held control-plane identity that renews it; neither is this token,
  and this page does not pin them.

Lifetime and renewal:

- A token lives at most 5 minutes. The gate's own session lasts no longer than the workspace token,
  or rechecks the person's role with the Cloud service when it renews (RFC 0024, delivery 4
  acceptance).
- A removed person cannot sign in to any workspace after 5 minutes at worst, and at once when the
  revocation call lands (section 6).
- The token is never in a URL, a query string, a fragment, a referrer, a log or an error.

**Open:** the signing algorithm and the key type; the JWKS endpoint and its refresh interval; the
key ids; the length of a rotation's overlap. **Open:** whether the token carries a `jti`; RFC 0024
names none. **Open:** how a gate renews a workspace session after the token expires: a new open
code, or a role recheck; the RFCs do not name the renewal. The RFCs name the RFC 0025 (g)
control-plane identity for gateway-token renewal, not for a workspace session. **Open:** the gate
session's own format and lifetime beyond the bound above.

*Source:* RFC 0024 lines 497-503, 649-650 and 769-782; RFC 0025 lines 129-132 and 569-582;
RFC 0011, "Making a key".

## 5. The single-use open code and its exchange

A rail tile or "open" hands a workspace a single-use open code; the workspace's gate exchanges it
with the Cloud service on the server side for a workspace token. The workspace token is never in
a URL (RFC 0024, (g) and delivery 4 acceptance). The code is not a token and is not a sign-in
credential anywhere else.

The flow:

1. The person opens a workspace from the Cloud rail (web) or from the desktop's rail after Cloud
   sign-in. The Cloud service checks the person's session and role, then mints one open code
   bound to that workspace, that subject and those roles.
2. The gate receives the code. It does not trust a browser with the exchange: it sends the code to
   the Cloud service itself, server to server.
3. The Cloud service checks the code is unused, unexpired and issued for this workspace, marks it
   used, and returns a workspace token for this workspace and this principal.
4. The gate verifies the workspace token (section 4) before it sets a session on its own origin.

The exchange request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `code` | string | yes | the opaque open code. |
| `workspace` | string | yes | the gate's workspace id; the Cloud service checks the code was issued for it. |

The exchange response:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `token` | string | yes | the workspace token; its own `ver` is 1. |
| `expires_in` | integer | yes | the token's remaining lifetime in seconds, at most 300. |

Example request and response, with placeholders:

```json
{
  "version": 1,
  "code": "{open-code}",
  "workspace": "{workspace-id}"
}
```

```json
{
  "version": 1,
  "token": "{workspace-token}",
  "expires_in": 300
}
```

Rules:

- The code is single use. The Cloud service marks it used before it issues a token; a replay, an
  expired code, a code for another workspace and a code presented by another workspace are
  refused. A refusal issues no token and echoes no code.
- A gate's own replay memory is bounded at 4096 unexpired codes. At the bound the gate refuses a
  new open before the exchange and keeps every code it already remembers; it never forgets one to
  make room, so a flood cannot make a replayed code pass the gate's own single-use record. A
  code's expiry frees its slot, and Cloud's single use remains the backstop.
- The exchange is server-side. The browser never calls the Cloud service's exchange, and the
  workspace never holds the code after the exchange.
- The code is not a workspace token, an access token or a refresh token. It grants nothing outside
  its one exchange.
- The workspace token appears only in the exchange response body and in the gate's own session
  setup. No token appears in a URL, a query string, a fragment, a referrer, a log or an error.
  `automagik://` stays open-only.
- The Cloud service is the only issuer of workspace tokens. The gate never mints one.
- The code is never logged and is not kept after the exchange.

**Open:** the exchange endpoint's path and method details, and the code's lifetime, length and
encoding; the RFC says single use, not a number or a format. **Open:** how the Cloud service
authenticates the gate on the exchange (the code alone, a gate credential, or the workspace's
attested identity); RFC 0024 says only that the exchange is server-side, and RFC 0025 (g)'s
control-plane identity is a candidate gate credential, not a decided one. **Open:** the error body
and its codes; version 1 requires one refusal that issues no token. **Open:** how the code reaches
the gate (a POST body, or a one-time value the gate reads); the invariant is the server-side
exchange and no workspace token in a URL. **Open:** how a lost exchange response is recovered; a
replay is refused, so version 1 starts a new open.

*Source:* RFC 0024 lines 501-503, 769-782 and 183-185; RFC 0025 lines 129-132.

## 6. Revocation and its poll fallback

When a person is removed from a workspace or their role is lowered, the Cloud service tells the
workspace to drop that person's gate sessions at once: a signed call, with a poll of a revocation
list as the fallback. A removed person cannot sign in after 5 minutes at worst, and at once when
the call lands. A lowered role drops sessions too (RFC 0024, (e) and threat model, Removal).

### The call

The Cloud service sends a signed call to the gate's revocation endpoint. The call is JSON:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `event` | string | yes | `session.revoke`. |
| `workspace` | string | yes | the workspace id. |
| `subject` | string | yes | the person whose gate sessions are dropped. |
| `reason` | string | yes | `removed` or `role_lowered`. |
| `issued_at` | string | yes | the Cloud service's time, RFC 3339. |

Example:

```json
{
  "version": 1,
  "event": "session.revoke",
  "workspace": "{workspace-id}",
  "subject": "{person-subject}",
  "reason": "removed",
  "issued_at": "2026-11-10T00:00:00Z"
}
```

Rules:

- The gate verifies the signature before it acts; an unsigned or wrongly signed call is refused
  and changes nothing. The call is signed by the Cloud service, not by the person and not by the
  workspace.
- On a valid call the gate drops every session for that `subject` in that `workspace` before it
  answers. A `removed` subject is also refused a new open exchange until Cloud says otherwise; a
  `role_lowered` subject may sign in again with the new roles.
- The call is idempotent: a repeat for an already-dropped subject is accepted and changes nothing.
  **Open:** whether version 1 carries an event id for deduplication; the RFC names none.
- The unit is the gate's session. DSH's own cookie behind the gate is a separate credential and is
  not revoked by this call (delivery 0 evidence, section 2). What a person with a shell left
  running is not ended by revocation; the workspace's secrets are rotated and its processes
  reviewed, or it is restored from before they joined (RFC 0024, (e)).

### The poll fallback

If the call does not land, the gate polls a revocation list for its workspace. The list is JSON:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `workspace` | string | yes | the workspace id. |
| `issued_at` | string | yes | the Cloud service's time, RFC 3339. |
| `expires_at` | string | yes | the list's expiry, RFC 3339. |
| `revoked` | array of objects | yes | the entries; it may be empty. |
| `revoked[].subject` | string | yes | the person whose gate sessions are dropped. |
| `revoked[].reason` | string | yes | `removed` or `role_lowered`. |
| `revoked[].effective_at` | string | yes | when the drop takes effect, RFC 3339. |

Example:

```json
{
  "version": 1,
  "workspace": "{workspace-id}",
  "issued_at": "2026-11-10T00:00:00Z",
  "expires_at": "2026-11-10T00:05:00Z",
  "revoked": [
    {
      "subject": "{person-subject}",
      "reason": "removed",
      "effective_at": "2026-11-10T00:00:00Z"
    }
  ]
}
```

Rules:

- The gate polls at least every 5 minutes while it holds sessions, so the 5-minute bound holds
  even when the call is lost.
- A list entry is applied by subject and workspace; an entry for another workspace is ignored.
  A `removed` entry is sticky; a `role_lowered` entry drops the sessions that existed at
  `effective_at` and the person may sign in again with the new roles.
- A list past `expires_at` is not applied; the gate fetches a current one. A missing or
  unverifiable list is a failure, not an empty list.
- The gate applies a list only while it is current: `issued_at` may be at most 30 seconds after
  the gate's clock and at most 5 minutes before it. A future-dated list is refused and does not
  move the gate's applied-list watermark, so it cannot hold a later removal or role cut out of
  effect; a list older than the bound is a stale feed, and a stale feed is a failure that changes
  nothing.
- The gate applies only a list it can authenticate; an unverifiable list changes nothing.
  **Open:** whether the list is signed, and with which key, or authenticated by the gate's fetch
  channel.

**Open:** the revocation endpoint's and the list's paths and methods. **Open:** the signature
envelope, the algorithm and what bytes it covers, for the call, and for the list if it is signed.
**Open:** whether the call and the list use the same key as the workspace token or a separate key.
**Open:** the list's lifetime. **Open:** the poll interval below the 5-minute ceiling, and what
the gate does when both the call and the poll fail; the 5-minute bound assumes the poll is
reachable.

*Source:* RFC 0024 lines 410-421 and 704-707; delivery 0 evidence, section 2.

## 7. The entitlements document, version 1

The Cloud service owns entitlements; the app only reads them. A plan sets an organisation's or a
personal account's workspaces, seats and host size. The Cloud service refuses `+` and invitations
past the limits and returns the entitlements signed and short-lived, so the app can draw the rail
and explain a greyed `+`. Every limit is enforced on the server; the document grants nothing
(RFC 0024, (i); RFC 0025, Phase A).

The document is not the rail's workspace list: tiles come from the Cloud service's rail answer.
The document explains the limits behind the rail and the greyed `+`. This section is
billing-adjacent: the platform owner is a required reviewer (RFC 0025, (h)). This page records the
requirement, not an approval.

The payload:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `1`. |
| `tenant` | string | yes | the paying organisation or personal account id. |
| `plan` | string | yes | the plan's opaque id. |
| `workspaces` | object | yes | the workspace limit and use. |
| `workspaces.limit` | integer | yes | the plan's workspaces. |
| `workspaces.used` | integer | yes | the workspaces that count against the limit. |
| `seats` | object | yes | the seat limit and use. |
| `seats.limit` | integer | yes | the plan's seats. |
| `seats.used` | integer | yes | the seats that count against the limit. |
| `host_size` | string | yes | the plan's host size for a workspace. |
| `issued_at` | string | yes | the Cloud service's time, RFC 3339. |
| `expires_at` | string | yes | the document's expiry, RFC 3339; short-lived. |

`workspaces.limit` and `seats.limit` are integers in version 1: a plan with no limit is not
expressible, and a reader must not infer one. An unlimited plan is a new field or a new version,
not a `null` in these fields.

Example:

```json
{
  "version": 1,
  "tenant": "{tenant-id}",
  "plan": "{plan-id}",
  "workspaces": { "limit": 3, "used": 1 },
  "seats": { "limit": 5, "used": 2 },
  "host_size": "{host-size}",
  "issued_at": "{issued-at}",
  "expires_at": "{expires-at}"
}
```

Rules:

- The document is signed by the Cloud service; the app verifies the signature before it reads any
  field. It is short-lived: an app must not use a document past `expires_at`; it fetches a current
  one or treats the limits as unknown, never as entitled.
- The document is additive. A new field is additive; an older reader ignores it. A changed meaning
  is a change to RFC 0024. An absent additive field means the feature is not granted; a reader
  never defaults it on. A host size or plan value a reader does not know is refused, not guessed.
- The document carries no Stripe customer, subscription, price or account id, no card data and no
  secret. Prices and account details are private (RFC 0025, (h)).
- Billing is owner-only; an admin never reaches it. Reading the document is not permission to
  bill, to invite past a limit or to create a workspace. The Cloud service refuses each of those
  on the request, from its own database (RFC 0024, (i); RFC 0025, (h)).
- RFC 0025 adds fields for managed tokens, compute and grants. They are not in version 1's
  payload; each arrives additively with its phase, and older readers ignore it.

**Open:** the signature envelope, the algorithm and what bytes it covers. **Open:** the document's
lifetime; RFC 0024 says short-lived, not a number. **Open:** the allowed `host_size` values.
**Open:** the field names and shapes of the managed-token, compute and grant additions from RFC
0025; it names the concepts, not their fields. **Open:** whether the document uses the workspace
token's key or a separate entitlements key.

*Source:* RFC 0024 lines 183-185, 543-552 and 651; RFC 0025 lines 551-555, 674-707 and 847-858.

## What this page does not pin

- The Cloud service's internals, its API paths and its database. Its contracts are here; the
  service starts private (RFC 0024, open question 16).
- The identity service's address, client ids and group names. They are private and are not in
  this repository (RFC 0024, Words and Contracts introduced).
- The self-hosted gate's claim, passkey and session contracts. They are RFC 0024 (c), not Cloud's
  public contract, except where this page meets them: the principal, the owner record and the
  loopback redirect.
- Stripe's objects, prices and secrets. Billing routes are the Cloud service's, owner-only
  (RFC 0024, (i); RFC 0025, (g)).
- The gateway token and the workspace control-plane identity (RFC 0025, (g) and (i)): the gateway
  token is scoped to the gateway, minutes long, revocable, minted per workspace or Bot, and cannot
  call Stripe or Cloud's control plane. The control-plane identity is minted at VM start and held
  by the gate on its own volume, outside DSH's routes and Bot commands. This page pins only the
  workspace token.
- The rail's API. It is named in RFC 0024 Q16 as public; it is not one of the contracts this issue
  pins.
