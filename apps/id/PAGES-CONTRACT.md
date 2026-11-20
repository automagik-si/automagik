# Sign-in and consent page contract

The sign-in and consent pages are `pages/sign-in.html` and `pages/consent.html`,
with supporting assets in that directory. The Worker serves them at `/sign-in`
and `/consent`. An absent page returns plain text `501 page not built yet`.
Scripts and styles are served from the same origin. No third-party scripts,
analytics, external fonts, or tokens in browser storage are needed.

## Security headers

Every response the Worker returns carries these, whatever produced it: the pages,
their files, the API, the well-known metadata, redirects and errors.

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no preload) |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |

The pages also answer with `Cache-Control: no-store`. Status, body, `Location`
and every `Set-Cookie` pass through unchanged. The policy has no `unsafe-inline`
or `unsafe-eval`: the pages keep every script and style in their own files under
`pages/`, never inline, and their own `<meta>` policy may be stricter but never
looser. A page is served only at its own address: `/sign-in.html`,
`/consent.html` and any other direct `.html` path answer 404.

## HTTP conventions

All paths below are relative to the identity service's origin. Use same-origin
fetch with `credentials: "include"`, `Accept: application/json`, and for POST
`Content-Type: application/json`. Cookies are HttpOnly; the page never reads them.
Use the browser's normal `Origin` header; never invent one. Request bodies and
responses are JSON unless stated otherwise. Never log challenges, codes, tokens,
cookies, or the provider's signed query.

Errors from authentication endpoints normally have `{code: string, message: string}`
and an HTTP 4xx status. OAuth errors can use `{error: string, error_description?: string}`.
An authorization decision can instead return HTTP 200 with
`{redirect: true, url: string}` where the URL carries an `error` parameter. Always
inspect both status and body. A 429 means wait before retrying; show the wait from
`X-Retry-After` in seconds. Network failures and unexpected responses need a retry
state. Never display raw HTML returned by a failed API call.

## Provider query and continuation

`loginPage` is `/sign-in`; `consentPage` is `/consent`. The provider redirects to
them with the original authorization parameters and signature metadata:

- `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated).
- `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` when supplied.
- Optional standard parameters such as `prompt`, `max_age`, `login_hint`,
  `resource` (which can repeat), `claims` (JSON), `ui_locales`, and `acr_values`.
- Provider metadata `exp`, `ba_iat`, `sig`, the repeated `ba_param`
  signed-parameter list, and optional `ba_pl` continuation metadata.
  Treat every unknown parameter as opaque and preserve it as received.

Set `oauth_query = window.location.search.slice(1)` once. Preserve the complete
query, including repeated parameters and signature metadata, without editing,
sorting or rebuilding it. The page never verifies a signature itself. Both pages
can request a verified client name with:

`POST /api/auth/oauth2/public-client-prelogin`

```json
{"client_id":"the client_id from the query","oauth_query":"the complete query without ?"}
```

Success is HTTP 200, with `{client_id, client_name?, client_uri?, logo_uri?,
contacts?, tos_uri?, policy_uri?}`. Only `client_id` and configured public metadata
are returned. Use `client_name` as text, falling back to `client_id`. Do not trust
a name or URL provided directly in the page query. Failed, expired or modified
queries must show an error and ask the user to restart from the product. Do not
load an untrusted logo or turn arbitrary metadata into HTML.

For sign-in requests, include `oauth_query` in the passkey verification POST body
or the WhatsApp start body. The provider verifies it and resumes authorization when
the session cookie is set. A successful verification can therefore return
`{redirect: true, url: string}` instead of the ordinary credential/session result.
Navigate to that server-returned URL. This is required for `prompt=login` and
`max_age`: the provider recognizes that the new session satisfied fresh sign-in.

For `prompt=create`, first sign out an existing session, create the account
without `oauth_query` in its verification body, and then call:

`POST /api/auth/oauth2/continue` with `{oauth_query, created: true}`.

To continue an already signed-in session when fresh sign-in is not requested,
use `{oauth_query, selected: true}`. At least one continuation flag is required.

Success is `{redirect: true, url: string}`. Navigate to that URL; the server chooses
the next page or registered product callback. Never navigate directly to a
query's `redirect_uri`. A standalone sign-in without a provider query should show
the signed-in state and no invented destination.

## Sign-in page

On load, call `GET /api/id/config`. Response:
`{phoneEnabled: false, whatsappEnabled: boolean}`. Show the WhatsApp option only
when `whatsappEnabled` is true. The person sends a prefilled message from the
returned link or QR code; the page collects no phone number or code. A config
failure should leave the passkey option usable and the WhatsApp option hidden.

Optionally call `GET /api/auth/get-session`. Response is `null` when signed out,
or `{session: {id, userId, expiresAt, ...}, user: {id, name, ...}}`. No email
is returned. Existing users can continue the provider flow or use
`POST /api/auth/sign-out` with `{}` (response `{success: true}`) to choose another
account. Treat session fields as data; never persist the returned token.

Offer **Use a passkey** and **Create a passkey**. The latter creates an account
through the authenticator, without a sign-up form, email or prior session.

Authentication:

1. `GET /api/auth/passkey/generate-authenticate-options`, with no body. Response
   is WebAuthn `PublicKeyCredentialRequestOptionsJSON`: `{challenge, rpId,
   timeout?, userVerification, allowCredentials?, extensions?}`. With no session,
   `allowCredentials` is omitted or empty, enabling discoverable credentials.
2. Convert the JSON options' base64url byte fields to ArrayBuffers and call
   `navigator.credentials.get({publicKey})` from the explicit passkey action.
   These pages have no username field and do not start conditional mediation.
3. Serialize the credential with `credential.toJSON()` where supported, or the
   equivalent base64url WebAuthn JSON shape. `POST /api/auth/passkey/verify-authentication`
   with `{response: AuthenticationResponseJSON, oauth_query?: string}`. The normal
   response includes `{session: {...}, user: {id, name, ...}}` and sets the session
   cookie. A provider flow can instead return `{redirect: true, url}` as above.
4. Follow the server redirect or use the continuation rules above.

Account creation:

Sign-up is by invitation only. An invitation link carries an admission ticket in
the URL fragment, `#ticket=<ticket>`: either `/sign-in#ticket=…` or a product's
authorization URL with the fragment, which the provider's redirect to `/sign-in`
keeps. On load the sign-in page reads `ticket` from the fragment, keeps it in
memory only and removes the fragment with `history.replaceState`, leaving the
path and the provider query exactly as they were. The ticket is sent only in the
request header `X-Automagik-Admission: <ticket>`, never in a query or a body, and
is forgotten once an account exists. Without a ticket, **Create a passkey** says
that new accounts need an invitation and calls nothing.

**Create a passkey** always creates a fresh account. If a session is active, the
page signs out before requesting registration options. Both registration steps
ignore session identity while retaining the WebAuthn challenge cookie.

1. `GET /api/auth/passkey/generate-register-options`, no body, with the
   `X-Automagik-Admission` header. Optional query
   `authenticatorAttachment=platform` or `cross-platform`; omit for broad support.
   Without a valid, unused ticket the answer is HTTP 403 with
   `{code, message}`, and nothing is stored:
   - `INVITATION_REQUIRED`: no ticket was sent.
   - `INVITATION_INVALID`: the ticket failed a check (signature, issuer, audience,
     expiry, purpose), or the service has no admission key configured.
   - `INVITATION_USED`: the ticket already made an account, or it has started its
     ten ceremonies.
   A retry with the same unused ticket (after a cancelled prompt or a failed
   credential write) starts a fresh ceremony. The verification POST also returns
   `INVITATION_INVALID` if the ticket expires beyond its 30-second clock skew
   before the credential is saved.
   Response is `PublicKeyCredentialCreationOptionsJSON`: `{challenge, rp: {id,
   name}, user: {id, name, displayName}, pubKeyCredParams, timeout?,
   excludeCredentials?, authenticatorSelection, attestation?, extensions?}`.
   Discoverable credentials and user verification are required. Display names
   contain no internal email address.
2. Convert byte fields and call `navigator.credentials.create({publicKey})`.
3. `POST /api/auth/passkey/verify-registration` with
   `{response: RegistrationResponseJSON, createSession: true, name?: string,
   oauth_query?: string}`. Omit `oauth_query` for `prompt=create` as described above.
   It needs no ticket header: the ceremony is bound to its ticket. If another
   ceremony on the same ticket finished first, the answer is HTTP 403
   `{code: "INVITATION_USED", message}`.
   Success includes the stored passkey's `{id, name?, credentialID, ...}`, plus
   `{session: {...}, user: {id, name, ...}}`; a session cookie is set. Never display
   or store the stored public key, session token or internal technical fields.
   A provider flow can instead return `{redirect: true, url}`.
4. Resume the provider query as described above. A cancelled or failed ceremony requires new
   options; challenges are single use. Starting registration with a ticket creates
   one internal user row before successful verification, and every retry on that
   ticket reuses it; there is no signed-in session yet.

For browsers without the WebAuthn JSON conversion helpers, use the matching
Better Auth passkey client or a WebAuthn JSON adapter. Do not send a raw
`PublicKeyCredential` to JSON.stringify; its binary fields will be lost.

WhatsApp inbound proof, only when `whatsappEnabled` is true:

1. `POST /api/auth/whatsapp/start` with `{oauth_query?: string}`. Preserve the
   signed provider query exactly as described above. No phone number or linking
   flag is accepted from the browser. When the page holds an invitation's ticket,
   send it in the `X-Automagik-Admission` header: it is used only if the number
   has no account yet. A ticket that fails a check answers HTTP 403
   `{code: "INVITATION_INVALID", message}`; an already recorded one,
   `{code: "INVITATION_USED", message}`. Without the header, start works as before. Success: `{url: string, code: string,
   expiresAt: number}`. The expiry is Unix time in milliseconds, five minutes
   after creation. A new Secure, HttpOnly, host-only SameSite=Lax challenge cookie
   binds this request to the browser. The URL is a WhatsApp link with the message
   prefilled. Show the code and an open-WhatsApp action; on desktop the designer
   can also show a QR code for the exact returned URL. The person must send the
   message themselves; no code is sent to them.
   For `prompt=create`, omit `oauth_query` here and call the documented
   `{created: true, oauth_query}` continuation after status becomes verified.
2. Poll `GET /api/auth/whatsapp/status` every two seconds, with credentials and
   no body or query parameters. Before proof, success is `{status: "pending"}`.
   After expiry, a missing cookie or an already used proof: `{status: "expired"}`.
   Stop polling on expiry, navigation away, or completion. A restart requires
   another start request and a new message; do not reuse an old link or code.
3. On proof, a standalone sign-in returns `{status: "verified", user: {id, name}}`
   and sets Better Auth's session cookie. With a signed provider query it normally
   returns `{redirect: true, url: string}` through the same provider hooks as
   passkey sign-in. Navigate only to this server-returned URL. The browser never
   receives a phone number to choose or an account-linking option. The verified
   sender determines the account, regardless of any existing browser session.
   A number with no account gets one only if the start request carried a valid,
   unused ticket. Otherwise the proof is spent, the challenge cookie is cleared,
   nothing is created and status answers `{status: "invitation_required"}` (no
   ticket was sent) or `{status: "invitation_used"}` (the ticket was used
   meanwhile). If the ticket has expired beyond its 30-second clock skew when
   the account is written, status answers 403 with `INVITATION_INVALID`. Stop
   polling and display the corresponding invitation message. A temporary user
   write failure leaves a live ticket available to start a fresh proof.
4. Treat 429 as a wait state, 403 as an invalid/cross-site request, and a signed
   query error as a request to restart from the product. A direct POST to status
   is not public and returns 404. Do not call `/api/omni/inbound` from a page;
   it is the authenticated server-to-server proof receiver.

The legacy `/api/auth/phone-number/send-otp`, `/api/auth/phone-number/verify` and
`/api/auth/sign-in/phone-number` endpoints always return 404. There is no phone
number input, code-to-browser delivery, resend-code action or linking flag in the
new flow. The pages use `whatsappEnabled`; `phoneEnabled` remains false for
compatibility with the retired outbound flow.

WhatsApp states: unavailable/hidden, starting, link and code ready, waiting for the
person's message, pending proof, expiry with restart, verified, redirecting,
rate-limited, invalid provider request and service/network error. Never promise
that opening WhatsApp or scanning a QR code completes sign-in: sending the
message is required. An invalid or unrecognized sender identifier gets no reply
and cannot complete proof.

Required visible states: loading/config, passkey offered, authenticator prompt
pending, passkey cancelled, sign-up needs an invitation, invitation used,
invitation not valid or expired, WhatsApp number needs an invitation,
passkey unavailable, passkey failed with retry, account created, signed in,
continuing to product, WhatsApp offered only when enabled, waiting for a message,
expired proof, restart wait, rate limited, service/network error,
invalid or expired provider request. No email field or social/password buttons.

## Session management

A signed-in person can see their own sessions and sign out of one or all of them.
All three routes need the session cookie; without one they return 401. A page
never receives a session token here: sessions are named by `id`.

`GET /api/auth/list-sessions` returns the caller's active sessions only:
`[{id, userId, expiresAt, createdAt, updatedAt, ipAddress?, userAgent?}, ...]`.
There is no `token` field. Compare `id` with `session.id` from
`GET /api/auth/get-session` to mark the current one. Listing needs a recent
sign-in: a session older than a day returns 403 with code `SESSION_NOT_FRESH`;
ask the person to sign in again.

`POST /api/auth/revoke-session` with `{id: string}` signs out that one session.
Success is `{status: true}`. A body without a string `id` returns 400 with code
`INVALID_SESSION_ID`; any other field, a `token` included, is ignored. The caller
is authenticated before the id is looked up, and the lookup is scoped to the
caller's sessions, so a signed-out request reads no session row. A session of
another person, or an unknown id, is left untouched and still answers
`{status: true}`, so the answer reveals nothing about other sessions.

`POST /api/auth/revoke-sessions` with `{}` signs out every session of the caller,
the current one included. Success is `{status: true}`; the page then shows the
signed-out state.

Signing out of other sessions while keeping the current one is not offered as a
separate route: revoke each listed session that is not the current one.

## Consent page

Require a session through `GET /api/auth/get-session`. If absent, show session
expired and a restart action; do not post consent automatically. Verify client
metadata using `public-client-prelogin` with the signed query before displaying
the client name and requested permissions. Show the space-separated `scope`
entries as individual permissions: `openid` identifies the person, `profile`
shares the display profile, `offline_access` requests continued access. Unknown
scopes must be shown as text, not silently hidden. If `claims` requests UserInfo
claims, show the requested claim names as well; this delivery offers no email scope.

Buttons **Allow** and **Deny** call `POST /api/auth/oauth2/consent`:

```json
{"accept":true,"oauth_query":"complete query without ?"}
```

For denial, set `accept: false`. Optional `scope` is a space-separated accepted
subset; omission accepts all requested scopes. Optional `claims` selects accepted
claims; omit it when accepting all shown claims. Success for both decisions is
`{redirect: true, url: string}`. Navigate to the server-returned URL. Consent-page
queries in this version contain the signed authorization request, not an issued
authorization code. Never invent a `code` body field from an older plugin example.

First-party clients can bypass this page because their seeded `skipConsent`
flag is true. Third-party clients keep it false; explicit `prompt=consent` can
also cause a prompt. Required states: validating request/session, client name and
scopes ready, allow/deny pending, continued, session expired, signature/expiry
failure, permission error, rate limit and network error. Never consent on load.
