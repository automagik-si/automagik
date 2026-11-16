# RFC 0032: Automagik ID

| Field | Value |
|---|---|
| Status | In delivery (delivery 1 authorized by the owner and merged: #1094, #1118, #1377; deliveries 2-5 open; questions (a)-(g) open, owner decision pending; replaces RFC 0024's identity-provider choice) |
| Milestone | none (independent Worker deployment) |
| Lanes | none: `apps/id/` deploys on its own and no release carries it |
| Created | 2026-11-11 |

## Summary

Automagik ID is one sign-in service for every Automagik product. It proves who a
person is and nothing more. Products key on the `(issuer, sub)` pair it returns and
keep their own roles, organisations and entitlements.

It is one Cloudflare Worker with one D1 database, built on Better Auth under its MIT
license. Passkeys are the sign-in method. There is no email, password, social sign-in
or sign-up form. Products connect through OpenID Connect with a code flow and S256
PKCE. Clients come from a reviewed seed list in the repository.

This RFC records what is built (delivery 1), the contracts products may rely on, the
threat model, and the deliveries that remain before real people use it.

## Motivation

RFC 0024 chose a self-hosted Pocket ID as Cloud's identity service. Its delivery 0
evidence showed the limits: flat groups, unscoped admin API keys, outbound SCIM only,
and invitations that the provider cannot hold. Cloud had to hold every invitation and
role itself anyway.

A small service of our own gives:

- one passkey site name, `automagik.si`, shared by every Automagik and Arca sign-in;
- no admin API key that reaches every account;
- code we review, with tests that run without Cloudflare;
- room for the inbound WhatsApp proof the owner asked for.

## Decided

1. **Better Auth in one Worker with D1** (owner). No other provider, no secondary store.
2. **Passkeys first.** Account creation works without a prior session. No email,
   password, social sign-in or sign-up form.
3. **Passkey site name `automagik.si`** (owner, 2026-11-11), read from a setting. The
   service refuses to start on a host outside it.
4. **First deployment on a test name under `automagik.si`** (owner, 2026-11-15).
   No public-name move happens until the owner directs it.
5. **Phone proof is inbound only.** The person sends a browser-issued challenge
   message through WhatsApp; the service never sends first. It is off by default.
6. **Identity only.** Product roles and entitlements stay in each product.
7. **No automatic migration** from another provider's principals.

## Design

### Architecture as built

- **One Worker.** `apps/id/src/index.ts` is the only entry. It serves the pages
  through an assets binding (`PAGES`) and everything else through Better Auth.
  `wrangler.toml` turns off the workers.dev address and preview URLs. Account,
  database and zone identifiers never sit in tracked files; `scripts/configure.ts`
  writes an ignored local config from the operator's environment.
- **One D1 database.** Users, passkeys, sessions, WebAuthn challenges, OAuth codes,
  grants, consents, refresh tokens, signing keys, rate-limit counters and WhatsApp
  challenges all live in D1. The session cookie cache is off. There is no other store.
- **Better Auth 1.7.21, pinned exactly**, with its passkey plugin, its OAuth provider
  plugin and its JWT plugin, all at 1.7.21. Upgrades are reviewed changes.
- **OIDC code flow.** Scopes `openid`, `profile` and `offline_access`. Grants
  `authorization_code` and `refresh_token`. S256 PKCE is required for every client,
  confidential ones included; discovery offers only S256. Dynamic client
  registration is off.
- **Native clients use loopback redirects** (RFC 8252). A registered
  `http://127.0.0.1` or `http://[::1]` redirect may come back on another port, with
  the same scheme, host, path and query. Any other `http:` redirect must match
  exactly. There are no wildcards.
- **Reviewed client seed list.** `apps/id/clients.json` is the only client source.
  `scripts/seed-clients.ts` writes it to D1. Only `automagik-desktop` and
  `automagik-cloud` skip consent; the seed forces `skipConsent` off for any other id.
- **Route allowlist.** Only listed auth and protocol routes answer; everything else
  under `/api/auth/` is 404. There is no client-management API, no account list and
  no admin route on the public surface.
- **Rate limit in D1.** Better Auth's limiter stores counters in D1, keyed on
  Cloudflare's `cf-connecting-ip`: 60 requests per minute per IP and path by default,
  tighter on sensitive routes (WhatsApp start: 5 per minute). Isolates share the
  counters.
- **Passkeys.** The relying-party ID comes from `PASSKEY_RP_ID` (`automagik.si`). The
  service host (`BETTER_AUTH_URL`) must be that name or a subdomain of it, or every
  request gets a plain configuration error. Credentials are discoverable and require
  user verification. Registration routes ignore any session cookie, so a passkey
  always creates a new account and never joins the current one.
- **Optional phone sign-in.** When `WHATSAPP_RECEIVING_NUMBER` and the secret
  `OMNI_INBOUND_TOKEN` are both set, the browser gets a six-character challenge and a
  prefilled WhatsApp link. Omni forwards the received message to `/api/omni/inbound`
  with a bearer secret. A verified number signs in to its own phone account, or
  creates one. It never selects or changes the browser's passkey account, so a phone
  identity is a separate identity. Without both settings, the phone routes are 404.
  The older outbound phone-code path is gone.
- **The placeholder email.** Better Auth needs a unique email per user, so each
  account gets a random `<uuid>@id.invalid`. It is never mailed. The Worker strips
  `email` and `emailVerified` from every JSON response and replaces any `@id.invalid`
  string with the display name. No email scope exists.
- **Never in a release.** `apps/id/` is deployed by the owner's workflow
  (`apps/id/DEPLOY.md`). No release lane builds or attaches it.

### The pages

`apps/id/pages/` holds `sign-in.html` and `consent.html`, one stylesheet, one script
and local assets. They follow `apps/id/PAGES-CONTRACT.md`. The Worker serves them only
at `/sign-in` and `/consent`, adding `referrer-policy: no-referrer`,
`cache-control: no-store` and `x-frame-options: DENY`. A direct `.html` path is 404.
The pages load nothing from another origin and carry a same-origin meta
Content-Security-Policy. Without the `PAGES` binding both routes answer 501.

## Contracts introduced

- **Issuer.** The `issuer` value in the discovery document. Today it is the service
  origin followed by `/api/auth`. Clients read it once from discovery and then pin it.
  It changes if the host changes (question (d)).
- **Discovery and keys.** `/.well-known/openid-configuration` (also under
  `/api/auth/`), `/.well-known/oauth-authorization-server/api/auth`, and the
  `jwks_uri` they name. ID tokens are signed with keys from the JWKS.
- **The principal.** `(iss, sub)`. `sub` is the Better Auth user id, stable for the
  life of the database. Products key every record on this pair, never on a name, a
  phone number or an email. A passkey account and a phone account of the same person
  are two principals until linking exists (question (f)).
- **Claims.** ID token: `iss`, `sub`, `aud`, `exp`, `iat`, `nonce` when sent, and the
  `profile` claims, whose `name` is the placeholder "Automagik user". No email, no
  phone number, no groups, no roles. Userinfo returns the same subject and no email.
- **The client seed list.** `apps/id/clients.json`: client id, name, type, token
  endpoint auth method, exact redirect URIs, `skipConsent`, `disabled`. Adding or
  changing a client is a reviewed change to that file. Cloud's callback is still an
  example and must change before a real Cloud sign-in. Arca, Omni and Brain are
  present and disabled.
- **The pages contract.** `apps/id/PAGES-CONTRACT.md`: the endpoints the pages call,
  the opaque `oauth_query` they carry, and the error shapes.
- **Token lifetimes.** Delivery 2 pins them in config (#1512) and tests each one, so a
  library upgrade cannot change them silently:

  | Item | Lifetime | Where it is set |
  |---|---|---|
  | Authorization code | 10 minutes, single use | library default |
  | Access token | 15 minutes | config (#1512) |
  | ID token | 15 minutes | config (#1512); the library default was 10 hours |
  | Refresh token | 30 days; each refresh starts a new 30 days | config (#1512) |
  | Refresh rotation | a new token on every use, reuse window 0 | config (#1512) |
  | Browser session | 7 days, renewed daily | library default; no absolute maximum |
  | Signing key | no rotation | gap: delivery 2 ops plan |
  | WhatsApp challenge | 5 minutes | set in code |

  Until #1512 merges, the library defaults apply (access 1 hour, ID token 10 hours).

## Threat model

### Assets

- **Passkeys.** The private keys stay on people's authenticators. D1 holds public keys
  and counters, bound to `automagik.si`.
- **Sessions and refresh tokens.** Bearer secrets in D1 and in cookies or clients.
- **Signing keys.** The JWKS private keys in D1, encrypted with `BETTER_AUTH_SECRET`.
- **`BETTER_AUTH_SECRET`, the root of trust.** It encrypts the signing keys and signs
  cookies and the provider's signed query. Whoever holds it and the database can mint
  tokens for any `sub`. It lives only in the Worker's secret store.
- **`OMNI_INBOUND_TOKEN`.** Whoever holds it can claim any phone number while a
  challenge is open. Shared only with Omni's private environment.
- **The Cloud client secret.** Held by Cloud's backend; D1 keeps only its hash.

### Attackers and mitigations

- **Phishing.** A look-alike site cannot use a passkey for `automagik.si`; browsers
  bind the ceremony to the RP ID. A tested check refuses a look-alike host.
- **Authorization code interception.** Mandatory S256 PKCE for every client; codes
  live 10 minutes and are single use.
- **Open redirect.** Redirect URIs match the seed list exactly, apart from RFC 8252's
  port on IP loopback. Pages never navigate to a query's `redirect_uri`; they follow
  the URL the server returns.
- **CSRF on auth routes.** Better Auth checks the `Origin` against the service origin.
  The WhatsApp status route refuses a foreign `Origin` and `sec-fetch-site: cross-site`.
  The phone challenge cookie is `__Host-`, HttpOnly, Secure, SameSite=Lax.
- **Clickjacking on pages.** `x-frame-options: DENY` on both pages. Pages answer only
  at their routes, so the header is never skipped.
- **Joining someone else's account.** Registration routes strip session cookies and
  the `authorization` header, so a passkey cannot be enrolled into the signed-in
  account. A phone proof never selects the browser's current account.
- **Forged inbound phone events.** Bearer secret compared in constant time; numeric
  sender only; message time inside the challenge life; one D1 batch deduplicates the
  event and enforces 10 events per sender per minute and 3 per challenge.
- **Account-creation abuse.** A bare GET to
  `/api/auth/passkey/generate-register-options` writes a user row before any passkey
  exists. A script can fill D1 with orphan users, limited only by the 60 per minute
  per IP limit, which a spread of addresses avoids.
- **Rate-limit cost.** Every limited request writes a D1 row. A flood costs D1 writes
  even when it is refused.

### Residual risks

- Orphan users from abandoned or abusive registrations, until delivery 2's cleanup.
- One passkey per account and no recovery: a lost authenticator loses the account.
- No session list or revoke for the person; sign-out ends only the current session.
- No security headers on API responses, no HSTS and no header CSP yet (delivery 2).
- No signing-key rotation, and no written plan to rotate `BETTER_AUTH_SECRET`.
- The free Workers plan, no named D1 region, no backup routine and no alerting.
- Leaking `BETTER_AUTH_SECRET` with a D1 copy lets an attacker sign tokens for anyone.
- Presenting an already-rotated refresh token makes the library revoke every refresh
  token that person holds for that client, and the access tokens issued from them, not
  only one rotation family. A replay therefore also ends the person's other sessions on
  the same client; other clients are unaffected. This fails safe, is pinned by a test
  (#1512) and is accepted.
- `offline_access` is granted to the two first-party clients without a consent prompt,
  although OpenID Connect expects `prompt=consent` for it, because those clients skip
  consent by decision. This is accepted for first-party clients only: a third-party
  client must never skip consent.

## Deliveries

Each is one pull request (or a short set) with an independent review. 2 before any
real account; 3 and 4 after 2; 5 after 3.

1. **The service (done).** #1094 (Worker, passkeys, OIDC, D1, seed list), #1118
   (pages and inbound WhatsApp proof), #1377 (passkey site name from a setting).
   *Check:* `bun run test` in `apps/id`: passkey account creation and sign-in, the
   native S256 code flow, JWKS and ID token checks, strict redirects, the phone
   proof, the cross-runtime limiter; the page tests in a real Chromium; each
   mutation in `scripts/mutations.mjs` fails its test.
   *Rollback:* remove the custom domain or the Worker; keep D1 and the secret.
2. **Ready for real accounts.**
   - the custom domain name the owner picks (question (d));
   - the sign-in and consent pages on it, with the contract's states;
   - security headers on every response (HSTS, header CSP, `nosniff`,
     `frame-ancestors 'none'`);
   - a second passkey on an existing account, behind a fresh sign-in;
   - a session list and revoke, for the person's own sessions;
   - refresh-token tests: rotation, reuse of an old token, revoke, expiry;
   - orphan cleanup: users with no passkey and no phone after a short window;
   - token lifetimes pinned in config (#1512);
   - ops: the paid Workers plan, a named D1 location, Time Travel restore tested,
     alerting on errors and 429 spikes, and a written rotation plan for the signing
     keys, `BETTER_AUTH_SECRET` and `OMNI_INBOUND_TOKEN`.
   *Check:* tests for each item; a Time Travel restore drill on a copy; header tests
   on API and page responses; a second passkey signs in to the same `sub`.
   *Rollback:* revert the Worker; D1 migrations only add, so the old Worker still runs.
3. **First client: Cloud web (confidential).** Cloud's real callback in
   `clients.json`; Cloud checks issuer, audience, nonce and PKCE and keys on
   `(iss, sub)`.
   *Check:* a sign-in on the trial name end to end; a wrong issuer, audience or nonce
   is refused by Cloud.
   *Rollback:* set the client `disabled: true` and reseed.
4. **Desktop client** (RFC 8252). Secure token storage comes first (RFC 0024 (d);
   the open pull request for #906). Then the desktop signs in through the system
   browser and a loopback redirect.
   *Check:* tokens never written in plain text; a stolen code without the verifier
   fails; sign-out revokes the refresh token.
   *Rollback:* the setting stays off by default.
5. **Hand-off to RFC 0024 (e) multi-user.** Organisations, roles and invitations in
   Cloud, keyed on `(iss, sub)`. Members join a workspace only once RFC 0024 (f)'s
   three preconditions hold: an unforgeable principal channel into DSH, role-filtered
   DSH routes, and the launch token out of the Bots' reach.
   *Check:* RFC 0024's own checks for (e) and (f).
   *Rollback:* workspaces stay owner-only.

## Open questions

Each has a recommendation; the owner's decision is pending.

- **(a) Is the free or self-hosted product one human per instance?** Recommended: yes,
  as RFC 0024's Decided 2 says. Automagik ID serves Cloud and the desktop; a
  self-hosted instance keeps its local claim.
- **(b) Open sign-up or invite-only?** Recommended: open, with the rate limit and
  delivery 2's orphan cleanup. Invitations stay Cloud records. RFC 0024's one-use
  signup links from an operator job are superseded: there is no admin key to mint them.
- **(c) What does recovery look like?** Recommended: a second passkey now (delivery 2),
  recovery codes later. No email reset.
- **(d) What is the public name?** Recommended: `id.automagik.si`, chosen before the
  first real account. Passkeys are bound to `automagik.si`, so a host move keeps them
  if the D1 database is kept. The issuer string changes with the host, and with it
  every product's `(iss, sub)`, so the move must happen before products store
  principals.
- **(e) A device-code grant for headless clients?** Recommended: not now. Add it when
  a headless client exists, with its own review.
- **(f) Linking a phone identity to a passkey identity?** Recommended: not now. When
  added, it needs a signed-in passkey session plus a fresh phone proof, and products
  must handle two subjects becoming one.
- **(g) Account deletion and export (EU).** Recommended: a self-service delete that
  removes passkeys, sessions and grants and tells products by a signed event; an
  export of the little the service holds. Needed before the service is opened widely.

## Superseded text

RFC 0024's identity-provider choice (Pocket ID), its hosting and admin assumptions,
its account provisioning and its signup links are replaced by this RFC. Pointer notes
sit in RFC 0024, RFC 0008 and the RFC 0024 delivery 0 evidence record. RFC 0024's
workspace isolation, product authorization, principal binding, credential protection
and desktop sign-in safeguards still apply.

## Tracking

- #1094, #1118, #1377: delivery 1.
- #906 and its open pull request: secure token storage and system-browser sign-in.

## Links

- [RFC 0024: Automagik Cloud](0024-automagik-cloud.md)
- [RFC 0024 delivery 0 evidence](../cloud/0024-delivery-0-evidence.md)
- [RFC 0008: Platform and web instances](0008-platform-and-web-instances.md)
- `apps/id/README.md`, `apps/id/DEPLOY.md`, `apps/id/PAGES-CONTRACT.md`
- [Better Auth passkeys](https://www.better-auth.com/docs/plugins/passkey),
  [OAuth provider](https://www.better-auth.com/docs/plugins/oauth-provider)
