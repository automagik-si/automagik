# Automagik Cloud public contracts, version 2: Cloud session renewal

| Field | Value |
|---|---|
| RFCs | [0024](../rfcs/0024-automagik-cloud.md), (g), delivery 4 acceptance |
| Depends on | [Contracts version 1](contracts-v1.md): the principal, the workspace token, the open code and its exchange, revocation |
| Written | 2026-11-18 |
| Lane | server (one server release) |
| Version | 2 |
| Status | Additive to version 1; version 1 stays valid as written |

This page adds one contract: a Cloud workspace session renews without a single-use open code.
The gate rechecks the person's role with the Cloud service on every renewal and issues a session
of at most 5 minutes. Nothing in [version 1](contracts-v1.md) changes: the open code and its
exchange, the workspace token, the principal and the revocation call and list stay valid exactly
as version 1 pins them.

Values in `{...}` are placeholders. No issuer, host, domain, workspace id or token appears here.

## The freeze rule, for version 2

Version 2 is additive:

- a version 1 reader keeps reading version 1 requests, tokens and documents exactly as before;
- a version 2 request is distinguishable from a version 1 request by one field, `version`, and a
  reader refuses a version it does not know instead of reading it as another version;
- neither version weakens the other. A version 1 open never becomes a renewal, and a version 2
  renewal never skips the role recheck or the 5-minute bound;
- a new field is additive only where this page says so; a change to an existing meaning is a new
  contract version, never an edit to this page.

The workspace token is still version 1. Version 2 is the renewal exchange, not a new token.

## 1. The renewal request

A browser that already holds a gate session asks the gate to renew it. The browser request
carries no single-use code and no token. The gate proves the renewal with the workspace token it
verified at open, server to server, as section 2 pins.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `2`. |
| `renew` | boolean | yes | `true`. |
| `workspace` | string | yes | The workspace id: the same value as version 1's `aud`, the workspace the gate is configured with. It is never a host. |

Example:

```json
{
  "version": 2,
  "renew": true,
  "workspace": "{workspace-id}"
}
```

The call:

- method and path: `POST /_gate/cloud/renew` on the workspace's own gate origin;
- media type: `application/json`, a JSON object with exactly the three fields above;
- authentication: the gate's current `__Host-automagik-session` cookie, on that same origin;
  there is no `Authorization` header, no code, no token and no query string;
- the session must still be valid: unexpired and unrevoked. An expired or revoked session is
  refused and the person presses Open as in version 1.

Rules:

- The gate refuses `version` other than `2`, `renew` other than `true`, another workspace, an
  unknown field, a non-object body, another media type, another method or another origin. A
  refused request issues no session and changes nothing.
- `workspace` is version 1's `aud`, never a host. The gate refuses a request whose `workspace` is
  not its configured workspace id, and a held token whose `aud` differs from it, before it calls
  the Cloud service.
- A role, an expiry, a subject or a workspace claim in the request is never read: an unknown
  field is refused whole, so a caller cannot ask for a longer session or a higher role.
- The request is not a version 1 open. It never carries an open code, and the version 1 open
  path never accepts it.

## 2. The role recheck and the renewal proof

On every renewal the gate rechecks the person's role with the Cloud service, server to server,
as RFC 0024 already requires. The proof is the current workspace token the gate holds for that
session: the exact token it verified at open.

The recheck call, to the configured exchange URL (contracts v1, section 5):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `2`. |
| `renew` | boolean | yes | `true`. |
| `workspace` | string | yes | The workspace id: version 1's `aud`, and the same value as the token's `aud`. |
| `token` | string | yes | The workspace token the gate verified for the session. It is held server-side, never sent to the browser. |

The answer:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | `2`. |
| `token` | string | yes | A workspace token, version 1 (contracts v1, section 4). |
| `expires_in` | integer | yes | The token's remaining lifetime in seconds, from 1 to 300. |

Example recheck and answer:

```json
{
  "version": 2,
  "renew": true,
  "workspace": "{workspace-id}",
  "token": "{workspace-token}"
}
```

```json
{
  "version": 2,
  "token": "{workspace-token}",
  "expires_in": 300
}
```

Rules:

- The Cloud service verifies the token's own signature, `aud` and `exp`, and then rechecks the
  person's role against its own database. Only after that does it mint a workspace token. An
  invalid signature, another `aud`, a token past `exp`, a removed person, a role that no longer
  grants access, or an unknown subject is refused and mints no token.
- The Cloud service refuses the request when `workspace` differs from the token's `aud`.
- The token is the same version 1 workspace token, signed the same way and verified by the gate
  exactly as contracts v1 section 4 says. Its `roles` are Cloud's current answer; the renewal
  request never supplies them.
- The configured exchange URL distinguishes the two calls by `version` before it reads any
  field. A version 1 parser refuses a version 2 body; a version 2 parser refuses a version 1
  body. Neither falls through to the other.
- The recheck is server to server. The browser cookie never leaves the gate: no browser cookie,
  open code or query string is ever forwarded. Version 2 adds no new gate credential; the
  workspace token is the only proof and stays in the gate's memory for the session's life.

## 3. The renewed session

The renewal answers `200` with a new `__Host-automagik-session` cookie and an empty JSON object.

- If the token the gate holds is missing or has passed its `exp`, the renewal is refused with no
  grace: the gate calls no Cloud service and issues no session, and the person presses Open as
  in version 1.
- The gate replaces the session: the secret presented by the browser is rotated out and no
  longer authenticates, and the new session carries the principal's subject and the roles from
  the rechecked token.
- The new session ends at the earlier of the token's `exp` and 5 minutes from the renewal. The
  token itself is at most 5 minutes, so no renewal mints a longer one, and a Cloud answer over
  5 minutes is refused whole rather than clipped.
- The cookie's `Max-Age` is therefore at most `300` seconds. The request cannot lengthen it: it
  has no field for a lifetime, and an unknown field is refused.
- A renewal may lower a role, because Cloud's answer is authoritative. It can never raise one
  beyond that answer: the principal is rebuilt from the verified token, never from the session
  or the request.
- The old secret is not accepted after the replacement; reusing it revokes the family, as every
  other gate session rotation does.

The five-minute bound therefore holds across renewals: a person's session ends at most 5 minutes
after the last open or renewal. A removal or a lowered role takes effect at once through the
version 1 revocation call or its list, and at most 5 minutes later through this bound otherwise.

## 4. Refusals

A renewal is refused with no new session and no cookie:

| Case | Status |
|---|---|
| no session, an expired session, a revoked session, or a session Cloud already dropped | `401` |
| a version 1 body, another version, `renew` not `true`, another workspace, an unknown field | `401` |
| a missing held token, a held token past its `exp`, or a request `workspace` that differs from the token's `aud` | `401` |
| the Cloud recheck refuses the token, or the rechecked role grants no access | `401` |
| the recheck answer's `expires_in` or token life is over 300 seconds, or the token is invalid | `401` |
| an `Authorization` header | `401` |
| another origin or a cross-site request | `403` |
| another media type | `415` |
| another method | `405` |
| a body over the gate's bound | `413` |
| too many rechecks in flight | `429` |

A refusal changes nothing: no session, no token and no role. A refused request is logged only
with a status and a generated request id, never with a token, a code or a subject.

## 5. Version 1 stays valid

- The version 1 open code and its exchange are unchanged: a form post of one `code` to
  `POST /_gate/cloud/open`, the server-side exchange, and the workspace token.
- The version 1 workspace token is unchanged: `ver` is `1`, and this page mints no other.
- The version 1 revocation call and poll list are unchanged.
- The gate's `POST /_gate/session/renew` route still rotates the cookie without extending a
  Cloud session's hard end, as it did before version 2. It is not a Cloud renewal; a Cloud
  session that has reached its end needs the version 2 renewal above or a new open.
- A version 1 client that does not renew still works exactly as it did: it opens from the rail
  again every 5 minutes.

The version 1 open path never accepts `renew` or a version 2 body, and the version 2 renewal
path never accepts a `code` or a version 1 body.

## 6. What this page does not pin

- The Cloud service's internals, its database and its exchange path beyond the configured URL.
- The workspace token's signing details, which stay contracts v1 section 4.
- The gate session's internal format and the rest of its route surface, which are the gate's,
  not this public contract's.

*Source:* RFC 0024 lines 490-500 and 1117-1124; [contracts v1](contracts-v1.md), sections 1, 4,
5 and 6; the ratified renewal answer of 2026-11-18.
