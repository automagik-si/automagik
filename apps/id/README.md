# Automagik ID

One identity for Automagik products, implemented with Better Auth 1.7.21 (MIT),
its matching passkey and OAuth provider plugins, and a Cloudflare Worker with D1.
This service deploys independently; repository releases never package it.

Passkey registration creates an account without a prior session. The authenticator
must support a discoverable credential and user verification. Authentication uses
discoverable credential options without requiring a username. The pages start the
authenticator from an explicit passkey action. No email, password, social login
or public OAuth client registration is exposed. There is no account management or recovery UI in
this delivery. The service does not provide a passkey recovery mechanism.

Better Auth's user schema requires a unique email. Accounts receive a random
address under the reserved `.invalid` domain solely for that database field.
It is never mailed or returned by this service, and the provider offers no email
scope. The JWT plugin's session response header is disabled. Public WebAuthn
options use the display name instead.

WhatsApp sign-in starts in the browser and requires the person to send the
prefilled message first. The service never sends a code or contacts Omni.
`WHATSAPP_RECEIVING_NUMBER` and the Worker secret `OMNI_INBOUND_TOKEN` enable
this flow together; without either, all three inbound-proof routes return 404.
The old outbound phone-code routes are permanently absent.

A six-character challenge lives for five minutes. D1 stores its hash and a hash
of a separate random browser cookie; the cookie is Secure, HttpOnly, SameSite=Lax
and host-only. The browser receives a WhatsApp link, the code and the expiry.
Omni pushes the received event to `/api/omni/inbound`, authenticated with the
shared bearer secret. Only numeric sender IDs or numeric phone JIDs are accepted;
privacy IDs and other identifiers produce no reply. Message timestamps must be
inside the challenge life and no later than receipt time. A message sent during
that life but delivered after expiry can receive the expiry reply; out-of-window
messages receive no reply.

One D1 batch deduplicates both event IDs, enforces ten events per sender per
minute and three per challenge per five minutes, and consumes the challenge.
The browser can claim the verified proof once. Better Auth creates the session
for the account owning the verified number, or creates a separate phone account.
The browser's existing passkey account is never selected or modified. The
receiving number, sender, code and secret are never logged.

Sessions, WebAuthn and WhatsApp challenges, OAuth codes, grants, signing keys,
and rate limits live in D1. There is no secondary storage or session cookie cache.
Only Cloudflare's replaced `cf-connecting-ip` header supplies the limiter's IP.
The default limit is 60 requests per rolling minute per IP and path; Better Auth
plugins apply tighter limits to sensitive endpoints. D1's conditional updates
keep rate-limit counters shared between isolates.

`clients.json` is the reviewed client allowlist. Desktop is a native public
client, Cloud is a confidential web client, and the other products remain
disabled. Before a real Cloud login, replace its example callback in a reviewed
change. All seeded clients require S256 PKCE, including confidential clients.
The provider's native redirect matcher permits a new port on the registered
IP loopback URI while preserving its scheme, host, path and query. No origin
wildcard is configured. Consent is skipped only on the two first-party entries;
future third-party entries must keep `skipConsent: false`.

## Token lifetimes

These are the contract Desktop and Cloud sessions build on, set as named constants in
`src/auth.ts`:

| Token | Lifetime | Why |
| --- | --- | --- |
| Access token | 15 minutes | Bearer-usable until it expires; a JWT cannot be recalled |
| ID token | 15 minutes | Proves one sign-in to the client, not a standing credential |
| Refresh token | 30 days | Keeps Desktop and Cloud signed in through a month of inactivity |

A refresh token is issued only when the authorization asked for `offline_access`.
It is bound to the client it was issued to, and a confidential client must
authenticate to use it. Every use rotates it: the response carries a new refresh
token and the old one fails. There is no reuse grace window. Presenting a rotated
refresh token again is treated as replay: the provider deletes every refresh token
that person holds for that client, with the access tokens issued from them, so every
sign-in of that client must start over. Tokens of other clients survive. Revoking a
refresh token at `/oauth2/revoke` ends it; another client's revocation request has
no effect. Each refresh starts a fresh 30-day lifetime for the new token.

The sign-in and consent pages live in `pages/` and follow [PAGES-CONTRACT.md](PAGES-CONTRACT.md):
`sign-in.html`, `consent.html`, one stylesheet (`id.css`), one script (`id.js`) and
`assets/` (fonts, wordmark, Genie and Omni face artwork, the app icon and licences).
They are plain files with no build step; nothing is loaded from another origin,
and a meta Content-Security-Policy allows same-origin files only. Passkey is the
main action. When enabled, WhatsApp lets the person send the prefilled message
from a link or QR code; the page has no phone-number or code-entry fields. Copy
is English only, in one table in `id.js`.

The Worker serves a page only at `/sign-in` and `/consent`, with
`cache-control: no-store`. Any direct `.html` path answers 404, so there is one
address per page. Every answer the Worker gives, pages, files, API, well-known
metadata and errors alike, carries the security headers `PAGES-CONTRACT.md`
lists: a strict Content-Security-Policy, `x-content-type-options: nosniff`,
`strict-transport-security`, `referrer-policy: no-referrer` and
`x-frame-options: DENY`. A Worker running without the `PAGES` binding answers
plain text `501 page not built yet` on both routes.

From this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test
node scripts/mutations.mjs
```

Tests bundle the actual Worker and exercise it inside Miniflare/workerd, using
local persistent D1 and a software WebAuthn authenticator. Outbound requests are
denied except for local dispatch of the provider's own
JWKS lookup for logout verification. No Cloudflare credentials are needed.
The cross-runtime limiter test uses two independent workerd runtimes sharing D1.

`test/pages.test.ts` covers the pages in three layers. The files: only the
contract's endpoints, nothing stored or logged, no inline code. A real Chromium
on the real Worker with a virtual authenticator: create a passkey, sign in,
allow and cancel. Then every state of both pages with the service's
answers scripted, checked for its words, console errors, the calls it made and
sideways overflow at 390 and 320 wide. The browser layers need a Chromium
(`node node_modules/playwright-core/cli.js install chromium`, or `ID_PAGES_CHROME`
naming one) and skip without it; CI sets `ID_PAGES_BROWSER=required`, which makes
a missing browser a failure. `ID_PAGES_SHOTS=<folder> bun run test -- pages` also
writes a picture of every state (1440 and 390 wide, light and dark; 320 light)
with an `INDEX.md`.

Mutation checks drop inbound authentication or timestamp checks, permit proof
reuse, select the current session account, restore the session JWT header, disable
PKCE, relax redirects, enable public registration, move rate limits to memory,
serve a page file directly as `.html`, take the passkey site name from the host,
start on (or configure) a host outside it, accept a look-alike host, let CI
skip the page browser tests, drop the Content-Security-Policy or nosniff, let
inline script run, send files and API answers without the security headers, let
a direct `.html` path through, rebuild the headers losing Better Auth's cookies,
lengthen a token lifetime and allow rotated refresh-token replay, one at a time.
Further checks edit the pinned OAuth provider's own bundle in `node_modules`
(replaced, never rewritten in place, since it may be a hard link into the package
cache) so a version bump that drops one of its refresh checks fails a test:
issuing a refresh token without `offline_access`, keeping a rotated token alive,
accepting an expired one, dropping its client binding and ignoring its revocation.
Each must fail its targeted test; source files are restored
afterward. Announcements and results are printed to stdout.
`bun scripts/generate-migration.ts` regenerates the initial schema for review;
never replace an already applied migration when upgrading a deployed database.

The passkey site name comes from the `PASSKEY_RP_ID` setting, `automagik.si` for
real use, shared by every Automagik and Arca sign-in. The service refuses to start
when its own host (`BETTER_AUTH_URL`) is not that name or a subdomain of it, so it
never runs on workers.dev. See [DEPLOY.md](DEPLOY.md) for the owner's first
deployment on a test name under `automagik.si`. This delivery does not deploy,
provision infrastructure, or choose a public domain.

Pinned API references: [passkeys](https://www.better-auth.com/docs/plugins/passkey),
[OAuth provider](https://www.better-auth.com/docs/plugins/oauth-provider).
