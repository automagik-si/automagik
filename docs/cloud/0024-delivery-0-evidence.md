# RFC 0024 delivery 0: the evidence record

| Field | Value |
|---|---|
| Issue | #903 (C0.2) |
| RFC | [0024](../rfcs/0024-automagik-cloud.md), delivery 0 |
| Written | 2026-11-10 |
| Target | 2026-11-12 |
| Lane | docs (no release) |
| Status | All six questions answered; Pocket ID's API keys split by release |

This is the public half of delivery 0's evidence. It answers the six questions in #903 for DSH
0.2.2-rc.1 and for Pocket ID as published at v2.19.2. The DSH answers restate the DSH squad's
2026-11-10 research in this record's own words; every claim below carries a public source:
a path in this repository, a published DSH package, an upstream specification, or Pocket ID's
docs and source. No private note, private host name, address or account is reproduced here.

*Note: [RFC 0032](../rfcs/0032-automagik-id.md) replaces Pocket ID with Automagik ID as Cloud's
identity provider. Section 6 and the Pocket ID points elsewhere are kept as the record; they no
longer drive a delivery. Automagik ID's tokens carry no `groups` claim.*

Each section gives the answer, the evidence, the unknown with what it blocks, and what the
answer changes for the deliveries filed as #905-#912. "Unknown" is used only where a fact is
not established.

## 1. Does DSH's web server offer an authentication hook?

**Answer.** No. DSH 0.2.2-rc.1 has no server-wide authentication middleware and no pluggable
authenticator. Its web server is a route registry: a handler owns the whole response, and the
route owner enforces its own request policy. The browser authentication that exists is private
to `dsh-client-connection`, and the one request hook (`connection/request`) runs only after a
request has already been admitted. A plugin can protect a route it registers itself, or veto
or wrap authenticated `/api` traffic, but it cannot wrap the index, the static assets, or the
API and WebSocket authentication.

**Evidence.**

- `@deepseek-ai/dsh-host-webserver` 0.2.2-rc.1, `README.md`, "Known limitations and deferred
  work": there is no server-wide authentication or origin policy; route owners such as
  `dsh-client-connection` enforce their own policy, and binding a non-loopback address still
  exposes unprotected routes and static assets.
  [README](https://unpkg.com/@deepseek-ai/dsh-host-webserver@0.2.2-rc.1/README.md)
- `@deepseek-ai/dsh-client-connection` 0.2.2-rc.1, `README.md`, "Browser authentication and
  request trust": the launch token is accepted at the root exchange and at `/connect`; the
  root mints the browser cookie and `/connect` mints an owner API cookie, while static assets
  stay public and the HTTP carrier accepts no `Authorization` header.
  [README](https://unpkg.com/@deepseek-ai/dsh-client-connection@0.2.2-rc.1/README.md)
- The `connection/request` waterfall admits or wraps an **authenticated** shared API request.
  It is post-admission, so it cannot authenticate a request that arrived without a cookie.
- In this repository, the fixture `apps/desktop/test/fixtures/client-connection-cookie-lax/index.js`
  is the unmodified `lib/index.js` of that package; its header says so at
  `apps/desktop/test/client-connection-cookie-lax.test.js:1-9`. The cookie and admission code
  can therefore be read from this repository without a DSH checkout.
- RFC 0024 already assumes a gate in front and keeps the fallback as Decided 21:
  `docs/rfcs/0024-automagik-cloud.md:270-277`.

**What a plugin can and cannot do.** It can register an exact or prefix route and call
`ctx.connection.admit(request)` to reuse DSH's cookie check, and it can listen on
`connection/request` to refuse or wrap already-authenticated `/api` calls. It cannot replace
the browser authenticator, add SSO, MFA or passkeys, add a login or logout route, change the
cookie lifetime beyond `cookieMaxAgeDays`, authenticate the `/api/remote.mux` upgrade with its
own logic, or make DSH accept a gate assertion on its own routes. The browser principal is
always the owner, so a plugin cannot invent a per-person principal either.

**Unknown, and what it blocks.** Whether a later DSH ships a hook is unknown. It does not
block this delivery: the architecture is a gate in front, and a future hook is its own change
(RFC 0024, Decided 21). It does block any plan that promises role-filtered DSH routes or
in-DSH SSO before that hook exists.

**What it means for the deliveries.**

- #907 must put the gate in front of loopback DSH and cover **every** route, including static
  assets, and every WebSocket upgrade: the root exchange, `/connect` and `/api`.
- #908's passkey claim belongs to the gate; DSH never sees a person.
- #909's Cloud mode keeps DSH at the owner principal; role filtering has to happen in the gate
  or in Cloud's own layer.
- #911's isolation review should test gate coverage as a boundary, not assume DSH enforces it.
- #905 and #906 are unaffected: the desktop starts its own DSH and trusts the OS user.
- #910's image smoke can keep answering `401` at the gate; that is healthy, not a failure.
- #912's end-to-end test must include an unauthenticated request to every route and WebSocket,
  including `/connect`.

## 2. Can DSH's multi-day session cookie stay behind the gate?

**Answer.** Yes, and the cleaner mode is for the gate to hold the DSH cookie itself. DSH's
cookie is a stateless signed credential, not a server-side session: host-only, `Path=/`,
`HttpOnly`, `SameSite=Strict`, absolute for 30 days by default (`cookieMaxAgeDays`, minimum 1),
and `Secure` only when the DSH listener itself serves TLS. A gate can pass it through
(transparent mode) or mint it upstream and replay it (gate-held mode). Gate-held is the
recommendation: the browser then holds only the gate's session cookie, so `SameSite`, port and
`Secure` rules stop constraining the design. DSH issues the credential at two points: the
root exchange mints the browser cookie, and `GET /connect` mints a signed owner API cookie for
the API and WebSocket carrier. A gate that covers every route has to handle both.

**Evidence.**

- Cookie attributes: `apps/desktop/test/fixtures/client-connection-cookie-lax/index.js:348-349`.
  The `cookieMaxAgeDays` default of 30 and its minimum of 1 are at `:1017`; the plain `401`
  body is at `:576`.
- The second exchange: `authorizeConnect` at
  `apps/desktop/test/fixtures/client-connection-cookie-lax/index.js:505-536` mints the API
  cookie; its route is registered at `:1061-1065`.
- The fixture header at `apps/desktop/test/client-connection-cookie-lax.test.js:1-9` records
  that it is the unmodified upstream package file, pinned to DSH 0.2.2-rc.1.
- `@deepseek-ai/dsh-client-connection` 0.2.2-rc.1, `README.md`, "Browser authentication and
  request trust": the cookie is host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`, carries
  `Secure` only for a TLS listener, and has no logout; deleting the credential record and
  restarting DSH revokes every session.
  [README](https://unpkg.com/@deepseek-ai/dsh-client-connection@0.2.2-rc.1/README.md)
- RFC 0024 already has the gate holding the launch token
  (`docs/rfcs/0024-automagik-cloud.md:233-238`) and lists the DSH cookie as open question 6
  (`:836-838`).

**Transparent mode has sharp edges.** Preserve the exact `Host` spelling and the `Origin`;
strip any path prefix before DSH sees `/`; forward `Set-Cookie` and the WebSocket upgrade
headers unchanged; and align lifetimes. A TLS-terminating gate leaves DSH on HTTP, so DSH
mints a non-`Secure` cookie even though the browser leg is HTTPS. `SameSite=Strict` also
suppresses the cookie on the first cross-site navigation back from an identity provider, so a
redirect can produce a `401` until a same-site reload. Gate-held mode avoids all of these.

**Unknowns, and what they block.** Transparent versus gate-held is a design choice, not a DSH
fact; this record recommends gate-held. The cross-site first-navigation behavior is specified
but was not exercised here, so no one should claim a transparent identity-provider redirect
"just works". A gate that terminates TLS cannot make DSH mint a `Secure` cookie; requiring one
means TLS at DSH or a pass-through proxy. A DSH restart changes the launch token, so the gate
must be able to re-read it; if it cannot, it cannot mint new sessions. These block the gate's
storage and container topology (#907), not the answer.

**What it means for the deliveries.**

- #907 should store DSH's browser and API cookies server-side and replay them, including on
  the WebSocket handshake, and strip DSH's `Set-Cookie` from browser responses.
- #907 must re-mint on `401` and re-read the launch token after a DSH restart.
- #909's gate session and workspace tokens are separate from DSH's cookie: revoking a gate
  session does not revoke DSH's cookie, and "sign out everywhere" covers only the gate.
- #912 should test the `401` path, `/connect`, the WebSocket path and a DSH restart.

## 3. What does `safeStorage` do on each OS, and what happens with no Linux secret store?

**Answer.** Electron 44.5.0 uses the platform store where it has one: Keychain on macOS,
DPAPI on Windows, KWallet or GNOME libsecret on Linux. On Linux with no recognised secret
store it falls back to the `basic_text` backend, which encrypts with a hardcoded plaintext
password. Electron's docs call that unprotected: it is obfuscation, not encryption. The app
must detect that backend, never opt into it, keep the refresh token in memory only, and ask
for a sign-in at each launch. The app uses no `safeStorage` today: its cookies are
unencrypted and its credentials are `0600` files readable by same-UID processes, Bots included.

**Evidence.**

- Electron pin: `apps/desktop/package.json:27` (`"electron": "44.5.0"`).
- Electron v44.5.0 `docs/api/safe-storage.md`:
  [docs](https://github.com/electron/electron/blob/v44.5.0/docs/api/safe-storage.md). It names
  the three stores, says a `basic_text` host stores items "unprotected" with a hardcoded
  plaintext password, and exposes `getSelectedStorageBackend()` to detect it.
- Electron v44.5.0 `shell/browser/api/electron_api_safe_storage.cc`: on Linux,
  `isEncryptionAvailable()` counts the `basic_text` fallback only after the app opts in,
  so availability alone is not the safety signal. The Linux rule is both: a backend name
  that is a real store, and `isEncryptionAvailable()` answering true.
- Electron's own Linux spec forces the opt-in and still expects `basic_text`:
  [spec](https://github.com/electron/electron/blob/v44.5.0/spec/api-safe-storage.spec.ts).
- The app's own statement that it uses no `safeStorage`:
  `apps/desktop/docs/DEVELOPMENT.md:22`.
- The chosen behavior is already in RFC 0024:
  `docs/rfcs/0024-automagik-cloud.md:322-325`.

**What the implementation must do.**

- After `ready`, on Linux, read `getSelectedStorageBackend()`; treat `basic_text` and
  `unknown` as no secure store, and a named store whose `isEncryptionAvailable()` is not
  true (a locked keyring) as no store for that launch. Do not call
  `setUsePlainTextEncryption(true)`.
- With a store, use the async API, handle `shouldReEncrypt`, and treat
  `isTemporarilyUnavailable` without losing the token. Without one, write nothing: keep the
  refresh token in memory and sign in per launch, with the reason in the UI.
- Treat a decrypt failure (locked keyring, changed backend) as signed out and re-authenticate.
- Store only the refresh token, rotate it on every use, and clear it on sign-out.
- Do not treat Keychain, DPAPI or the Secret Service as a boundary against the user's own
  Bots: a same-user process can reach the store or the app's data folder, and a prompt is not
  a policy boundary.

**Unknowns, and what they block.** The async Linux fallback does not document a detection
method: the docs name a fallback provider without saying whether `isAsyncEncryptionAvailable()`
or `getSelectedStorageBackend()` reflects it. That blocks a claim that moving to the async API
is automatically safe; use the sync backend check or a round-trip canary on Linux. Whether
ciphertext written under `basic_text` survives a restart is ambiguous; do not rely on it
either way. The Linux desktops the target users run are unknown, so the "no secret store,
nothing written" acceptance test needs a representative host. The Cloud token format is not in
this repository yet, which blocks the test fixture, not the policy.

**What it means for the deliveries.**

- #905 implements the detection, the no-write path, the async handling and the UI reason; its
  gate test must run on a host with no secret store.
- #906's system-browser flow stores only the refresh token, behind this storage; with no store
  it must degrade to a sign-in per launch.
- #911's isolation review must not treat `safeStorage` as separation from Bots.
- #912 should not assume a persisted desktop Cloud session on Linux.

## 4. Do passkeys work on `localhost`, and which platform authenticators exist?

**Answer.** WebAuthn permits `http://localhost` on any port as a secure origin and as a
relying-party ID. It refuses IP origins: `127.0.0.1` cannot run a passkey ceremony even though
it is a secure context. A `*.localhost` name cannot claim the RP ID `localhost`; use the exact
host. Ports are not part of the RP ID, so every port on `localhost` shares it. DSH's own
desktop page is an IP origin, so passkeys must run at the gate or at Pocket ID, on a
`localhost` or DNS-name origin; DSH can stay on the IP behind the gate.

**Evidence.**

- W3C WebAuthn 3, "Relying Party Identifier":
  [spec](https://www.w3.org/TR/webauthn-3/#relying-party-identifier), and the create
  algorithm's valid-domain rule:
  [spec](https://www.w3.org/TR/webauthn-3/#sctn-createCredential).
- W3C Secure Contexts: `localhost` and loopback addresses are potentially trustworthy:
  [spec](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy).
- Chromium's validator tests in
  `components/webauthn/core/browser/webauthn_security_utils_unittest.cc`: `http://localhost`
  can claim `localhost`, `http://foo.localhost` cannot, and `127.0.0.1` origins are rejected.
- DSH's launch URL is `http://127.0.0.1:<port>/...`:
  `apps/desktop/src/dsh.js:733-738` and `:840`.
- Pocket ID requires `APP_URL` to be a domain over HTTPS, or `http://localhost` for a trial:
  [environment variables](https://pocket-id.org/docs/configuration/environment-variables),
  [reverse proxy](https://pocket-id.org/docs/setup/reverse-proxy),
  [installation](https://pocket-id.org/docs/setup/installation).
- Pocket ID callback URLs match exactly unless wildcarded; a loopback URL registered without
  a port matches any port, and non-loopback `http://` works only while
  `ALLOW_INSECURE_CALLBACK_URLS` is true:
  [callback URLs](https://pocket-id.org/docs/advanced/callback-url-wildcards).

**Platform authenticators.** macOS uses iCloud Keychain passkeys with Touch ID or Face ID
([Apple](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)).
Windows uses Windows Hello
([Microsoft](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/)).
Android 9 and later uses Google Password Manager or Credential Manager
([Google](https://developers.google.com/identity/passkeys/supported-environments)). Linux has
no OS-level biometric equivalent in the desktop app: Chrome can use Google Password Manager,
and otherwise the fallback is a security key or a phone. The exact per-browser chooser depends
on browser, version and account state, so test it rather than promising it.

**Unknowns, and what they block.** The per-browser Linux matrix is unknown; that blocks a
blanket "passkeys work on Linux" statement, not the design. Whether C0.2's gate or Pocket ID
is the relying party is a design choice; either works, but the RP ID and callback URLs differ,
which blocks a final URL scheme until chosen. An IP `APP_URL` is not documented as supported,
and WebAuthn would reject the ceremony anyway; do not plan on it.

**What it means for the deliveries.**

- #906's desktop flow uses the system browser with a loopback redirect
  (`http://127.0.0.1:<port>/callback`), which Pocket ID accepts without a port; the passkey
  ceremony happens at Pocket ID's own origin, not at DSH's.
- #908's gate must serve passkeys from `localhost` or a stable HTTPS name and refuse an IP
  origin with a reason; the claim and recovery screens inherit that origin.
- #909's Cloud issuer needs HTTPS and exact callbacks; no plain HTTP outside localhost.
- #912 should drive a virtual WebAuthn authenticator and include a wrong-origin case.

## 5. What does a per-OS delivery-H-style mask need?

**The word first.** In this record, "delivery-H mask" means RFC 0022's delivery-H security
mask: the per-OS sandbox over DSH Bots' commands. It does **not** mean the window frame or
title bar. The frame is a separate visual workstream: its macOS and Linux shapes are in
`apps/desktop/src/frame.js` and `apps/desktop/src/shell.css`, and no Windows build is supported.

**Answer.** The mask must keep a Bot's shell from reading the OS secret store, the session
bus, the app's data folder, hc's core socket and link credential, and SSH keys or config.
No OS has that widened mask for desktop Bots today. Linux has a bwrap runner to extend
(#631, still open): its first cut is for pack-started dsh-tui Bots and masks hc, the core
socket and SSH material, not the secret store, the session bus or the app's data. macOS has
no read mask: DSH's own per-call fence applies on both OSes and governs writes, not reads.
Windows is not a supported build and has no mask; DPAPI is per user anyway. Desktop Cloud
sign-in stays off on an OS until the widened mask exists there, or the owner accepts the
risk in writing.

**Evidence.**

- RFC 0022 delivery H defines the mask and puts it before phase 1:
  `docs/rfcs/0022-desktop-chat-view.md:508-528`, with the Linux-only note at `:519-520` for
  that narrower mask.
- RFC 0024's desktop section makes desktop Cloud sign-in conditional on a delivery-H-style
  mask: `docs/rfcs/0024-automagik-cloud.md:326-336`, and open question 17 at `:875-878`.
- The widened mask is not built. RFC 0022's mask covers hc, the core socket, the link
  credential and SSH material, and its bwrap runner is #631, still open:
  `docs/rfcs/0022-desktop-chat-view.md:424-427` and `:519-520`.
- The app's own per-call fence, on both OSes, governs writes only and leaves reads open:
  `docs/rfcs/0010-desktop-sandbox.md:64`. It is not the delivery-H mask.
- The window-frame facts, for disambiguation only: `apps/desktop/src/frame.js:13-17,31-47`;
  `apps/desktop/src/shell.css:35-36,50-71`; Windows is unsupported:
  `apps/desktop/README.md:16` and `apps/desktop/docs/DEVELOPMENT.md:26`.

**Per OS.**

- **Linux:** extend the bwrap runner (#631) to mask the Secret Service socket, the session
  bus, the app's data folder, hc's socket and credential, and SSH material. The runner exists;
  the widened mask does not.
- **macOS:** build a read mask; a Seatbelt profile or a separate helper user are the two
  shapes, and they differ in prompts and file access. The app data folder is readable by
  same-user processes, and a Keychain prompt is not a Bot boundary; the mask must cover both.
- **Windows:** not a supported app build. A mask would need an AppContainer or restricted
  token plus ACLs, and DPAPI does not separate same-user processes. Do not treat a caption
  band or a `dist:win` script as Windows support.

**Unknowns, and what they block.** The word "mask" is the first unknown; this record fixes it
as the security sandbox, which unblocks scoping. No OS has the widened mask, so the Linux,
macOS and Windows work and the per-OS switch in #906 remain blocked on building it. The macOS
mechanism is not chosen, which blocks an estimate. Windows support is a product decision, not
evidence from the frame code; until it is decided, no Windows mask exists and no Windows
Cloud sign-in may be promised.

**What it means for the deliveries.**

- #905's secure storage is necessary but not sufficient; the mask is a separate condition.
- #906 must keep desktop Cloud sign-in off per OS until the widened mask exists, or the
  owner's written acceptance is recorded.
- #911's isolation review should treat same-UID Bots on desktop Linux and macOS as able to
  read the app's data and the OS store, and should check the mask, not the title bar.
- #912's end-to-end test cannot claim desktop Cloud safety on any OS until the widened mask
  lands.

## 6. What can Pocket ID do?

*Superseded: Cloud uses Automagik ID ([RFC 0032](../rfcs/0032-automagik-id.md)), not Pocket ID.
This section is kept as the record.*

**Answer at a glance.** Pocket ID v2.19.2, the current release (2026-11-02), has flat user
groups, not organisations. Its API keys are not scoped: a key acts as the admin who made it.
Signup links are bearer tokens, not bound to an email address, though a login code can be
emailed to an existing user. It does not federate to an upstream OIDC or SAML provider; LDAP
sync is a one-way import. Its SCIM support is outbound: Pocket ID pushes users and groups to
an app that exposes a SCIM endpoint. The public source on `main` at `8b57842` has per-key
scopes; the v2.19.2 release does not, and that change is unreleased as of 2026-11-10.

**Version checked.** v2.19.2 is the current release and what the public docs describe. This
record also checks `main` at commit `8b57842` (2026-11-09), which is ahead of the release.
Where the two differ, the item says so.

### Organisations or groups

**Groups, not organisations.** The data model has users, user groups, OIDC clients, API keys
and SCIM service providers. Its group record has no parent or tenant, and there is no
organisation object. A group has a friendly name, a token name, optional custom claims and a
list of OIDC clients it may sign in to. Groups are flat and are the only grouping the token
carries. Cloud's organisation and role model therefore stays in Cloud's database, and the
token's `groups` claim is a coarse signal at best.

- *Evidence:* `backend/internal/model/user_group.go` (v2.19.2); the docs' "Groups" section at
  [user management](https://pocket-id.org/docs/setup/user-management#groups);
  [allowed groups](https://pocket-id.org/docs/configuration/allowed-groups).
- *Unknown and what it blocks:* nothing here is unknown. It blocks any plan to model Cloud
  organisations in Pocket ID.
- *Deliveries:* #909 keeps organisations and roles in Cloud; #912 can assert that a group
  claim does not create an organisation.

### Scoped API keys

**No in v2.19.2; present on `main`.** In v2.19.2 an `ApiKey` record has a name, description,
expiry, last-used time and owner, but no scopes. Authentication builds the principal's scopes
from the owning user's role, so a key created by an admin holds every admin scope. The docs
say it plainly: "A key acts with the rights of the admin who created it." On `main` (not in
v2.19.2) the record has a `Scopes` field, key creation and update require at least one scope,
and the service grants only scopes the caller may grant. Creating or deleting a signup token
requires `users:write`, so a scoped key could create signup links without holding every admin
scope. The published docs have not caught up.

- *Evidence:* v2.19.2 `backend/internal/apikey/models.go` and
  `backend/internal/middleware/authenticator.go:137-150`; the docs'
  [REST API](https://pocket-id.org/docs/api). Main at `8b57842`:
  `backend/internal/apikey/models.go`, `dto.go`, `service.go:58-144`, and
  `backend/internal/usersignup/module.go` (`users:write`).
- *Risk for C3.3:* until a release with scoped keys is deployed, the narrow signup-link job
  must wrap the full admin key on the operator's side. Record that; do not block on it. The
  job should still be written to ask for the smallest key it can, so it improves without a
  rewrite when the identity service is upgraded.
- *Unknown and what it blocks:* when that release ships is unknown. It blocks relying on
  scoped keys for the first Cloud delivery, not the delivery itself.
- *Deliveries:* #909 must assume the v2.19.2 behavior for the first cut; #912 can exercise
  invitation creation with the key the operator actually holds.

### Email-bound invitations or signup links

**Signup links are bearer tokens, not email-bound.** A signup token has a lifetime, a usage
limit and optional groups; it has no email field and is not tied to any address. The signup
form's email is optional, and it is verified only if the instance enables verification. Anyone
who holds the link may create an account until it expires or hits its limit. A login code is
closer: an admin creates it for an existing user and can have Pocket ID email it, and an email
login code can also be requested by the user when SMTP is configured. Neither binds an
invitation to an address; both are bearer credentials, and the docs warn that a login code is
as good as a passkey until it expires.

- *Evidence:* `backend/internal/usersignup/dto.go` (v2.19.2: `ttl`, `usageLimit`,
  `userGroupIds`; no email); docs
  [user management](https://pocket-id.org/docs/setup/user-management#signup-links) and
  [sign-in methods](https://pocket-id.org/docs/guides/sign-in-methods#login-code-by-email).
- *Unknown and what it blocks:* no email binding exists, so Cloud cannot delegate "only this
  mailbox may accept" to Pocket ID. Cloud must issue and track invitations itself and bind
  acceptance to the `(issuer, subject)` that signs in, which RFC 0024 delivery 3 already
  requires.
- *Deliveries:* #909 keeps invitations in Cloud; #912 should not use a signup link as a
  per-person invite.

### Federation

**No upstream OIDC or SAML federation.** Pocket ID is the OIDC provider; it does not consume
an upstream OIDC or SAML identity provider for person sign-in. LDAP is the only directory
integration, and it is a read-only sync: Pocket ID imports users and groups, users still sign
in with passkeys, and it does not serve LDAP to other apps. SAML is not a protocol Pocket ID
serves; an app without OIDC support can sit behind an authentication proxy that speaks OIDC
to Pocket ID. "Federated client credentials" is a different feature: it lets an OIDC client
prove itself to Pocket ID with a platform-issued JWT instead of a client secret; it does not
federate people.

- *Evidence:* docs [LDAP](https://pocket-id.org/docs/configuration/ldap),
  [proxy services](https://pocket-id.org/docs/guides/proxy-services), and
  [OIDC client authentication](https://pocket-id.org/docs/guides/oidc-client-authentication);
  source `backend/internal/ldapsync/` (v2.19.2) and `backend/internal/model/oidc.go:97,160-183`
  (federated client identities).
- *Unknown and what it blocks:* no upstream federation exists, so a company that requires
  Google, Entra or SAML sign-in cannot be served by this identity service as it stands. RFC
  0024 Q14 must be decided before the first company customer; adding federation later or
  moving the issuer re-binds every person keyed by `(issuer, subject)`.
- *Deliveries:* #909's Cloud mode assumes one issuer; #911 should not approve a company-tenant
  promise without this decision.

### SCIM

**SCIM is outbound.** Pocket ID is the SCIM client, not a SCIM server. For an OIDC client you
give Pocket ID the app's SCIM endpoint and token; Pocket ID then creates, updates and removes
that app's users and groups, five minutes after a change, hourly, or on demand. A client
restricted to groups syncs the members of those groups. It does not accept SCIM from an
upstream directory, so a customer's directory cannot provision Pocket ID over SCIM.

- *Evidence:* docs [SCIM provisioning](https://pocket-id.org/docs/configuration/scim); source
  `backend/internal/scimsync/module.go` (v2.19.2, SCIM service-provider endpoints configured
  per OIDC client).
- *Unknown and what it blocks:* nothing about the direction is unknown. It blocks a plan that
  expects Pocket ID to be the SCIM target for a customer's directory; Cloud would need its own
  SCIM endpoint and a mapping to `(issuer, subject)`.
- *Deliveries:* #909 keeps provisioning in Cloud; #912 does not need a SCIM path.

**What this means for the deliveries.** #909's Cloud mode can rely on Pocket ID for
authentication, groups in the token, and a single issuer; it must keep organisations, roles,
invitations and provisioning in Cloud, and must not assume scoped keys before the identity
service is upgraded. #910 is unaffected. #911 should record the federation gap before any
company customer. #912 can test one issuer, one group claim and the operator-held key.

## Decisions this informs

- **RFC Q6, session lifetimes.** Keep the DSH cookie server-side and give the gate its own
  short, sliding session. DSH's cookie is absolute (30 days by default), so the gate must
  re-mint on `401` and re-read the launch token after a DSH restart. A transparent cookie is
  possible but inherits `SameSite`, port and non-`Secure` problems. This supports the RFC's
  recommended 12-hour idle gate session and 5-minute workspace token.
- **RFC 0024, Decided 21, the gate now.** DSH 0.2.2-rc.1 has no hook, so the gate fronts every
  route and WebSocket; the upstream hook is a later change, not a dependency. The RFC's assumption
  stands.
- **RFC Q14, federation.** No upstream OIDC or SAML federation and no SCIM target exist today.
  Decide before the first company customer; a later issuer move re-binds every person.
- **RFC Q17, the desktop mask.** "Delivery-H mask" here means the security sandbox, not the
  window frame. Linux has one, macOS needs a read mask, Windows is unsupported. Desktop Cloud
  sign-in stays off per OS until the mask exists or the owner accepts the risk in writing.
