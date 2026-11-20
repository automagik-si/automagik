# Owner-run first deployment

Delivery 1 deploys nothing. Run these steps only when the owner authorizes the
first deployment. Only the owner deploys.

## The public name and the passkey site name

The service's public name is `id.automagik.si` (RFC 0032, Decided 4). It is the
issuer every product stores with a person's subject as `(iss, sub)`, so the first
deployment goes straight to that name: there is no trial name and no later move.

Every Automagik and Arca sign-in uses one passkey site name (WebAuthn's
relying-party ID): `automagik.si`. The service reads it from the `PASSKEY_RP_ID`
setting and refuses to start, answering every request with a plain error, when
its own host (`BETTER_AUTH_URL`) is not `automagik.si` or a subdomain of it. A
browser only lets a site use a passkey site name that is its own host or a parent
of it, so a workers.dev address can never carry the `automagik.si` name. The
Worker has no workers.dev address (`workers_dev = false`); its only address is
`id.automagik.si`, attached by the deploy itself as a Custom Domain.

## Owner steps in Cloudflare

These are the owner's steps, done in the Cloudflare dashboard. Nobody else makes
the token; the deploy reads it only from the secret store.

1. **The name is free.** `id.automagik.si` must have no DNS record in the
   `automagik.si` zone. The deploy creates the record and its certificate.
2. **The deploy token.** Create an API token scoped to the deployment account and
   to the `automagik.si` zone only, and save it straight into the operator's
   secret store:

   | Scope | Permission | Access | Purpose |
   |---|---|---|---|
   | Account | Workers Scripts | Edit | Upload Worker and assets, set secrets |
   | Account | D1 | Edit | Create the database, apply migrations and seed clients |
   | Account | Account Settings | Read | Resolve account metadata |
   | Zone `automagik.si` | Zone | Read | Find the zone that holds the name |
   | Zone `automagik.si` | Workers Routes | Edit | Read the zone's Worker routes; attach the name |
   | Zone `automagik.si` | DNS | Edit | The Custom Domain creates the name's DNS record |

   What the deploy calls, read from Wrangler 4.50.0's own source: for each route it
   looks the zone up by name (`GET /zones?name=…`, so it needs Zone Read on
   `automagik.si`; without it the deploy stops with "Could not find zone"), lists
   that zone's Worker routes (`GET /zones/<zone>/workers/routes`, Workers Routes),
   then attaches the Custom Domain through the Worker's account endpoint
   (`PUT …/workers/scripts/automagik-id/domains/records`), which creates the DNS
   record and certificate. Wrangler's source does not name the permission that last
   call checks; the Workers Routes Edit and DNS Edit rows cover the route and the
   record it writes. If the deploy fails with an authentication error at the Custom
   Domain step, compare the token with Cloudflare's API reference for Workers
   Custom Domains before widening anything.

Supply the account through `CLOUDFLARE_ACCOUNT_ID` and the token through
`CLOUDFLARE_API_TOKEN` from that secret store. Do not put either in shell history or a tracked
file. Do not print environment variables or run commands with shell tracing. No
account, zone or database identifier belongs in a tracked file, and no account or
zone identifier in any file: Wrangler finds the zone from the name.

## Local configuration

From `apps/id/`, install and check locally:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test
```

The following commands use Cloudflare only when the operator runs them:

```sh
bun x --no-install wrangler d1 create automagik-id
```

Set `ID_DATABASE_ID` to that result and `ID_WORKER_ORIGIN` to
`https://id.automagik.si`, through the operator's private environment. Then:

```sh
bun scripts/configure.ts
```

This writes ignored, owner-only `wrangler.local.toml` from the tracked template
and the environment, with a `DB` D1 binding, `BETTER_AUTH_URL`,
`PASSKEY_RP_ID = "automagik.si"` and one Custom Domain route,
`{ pattern = "id.automagik.si", custom_domain = true }`, for the origin's host. It
refuses an origin that is not a bare HTTPS origin (no path, query or port) on
`automagik.si` or a subdomain of it, a workers.dev origin included, and then
writes nothing. No account, database or zone ID is tracked. Omit `WHATSAPP_RECEIVING_NUMBER` and `OMNI_INBOUND_TOKEN` to keep the inbound
WhatsApp flow off. The receiving number is private runtime configuration; do not
put its value into a tracked file. This service has no outbound OTP endpoint.

## Secrets, migration and client seed

Create the auth secret directly into Wrangler's secret input. Do not run the
generator by itself, use command substitution, echo it, or save it in a file:

```sh
openssl rand -base64 48 | bun x --no-install wrangler secret put BETTER_AUTH_SECRET --config wrangler.local.toml
```

If Wrangler asks to create the named Worker before its first upload, accept only
the intended `automagik-id` Worker. That is an operator action, not part of this delivery.
Keep this secret stable: it protects sessions and stored signing keys. Rotate only
with a reviewed session/signing-key plan. For the later authorized WhatsApp
rollout, provision the same existing shared secret into the Worker with
`bun x --no-install wrangler secret put OMNI_INBOUND_TOKEN --config wrangler.local.toml`
and into Omni's private environment through its operator workflow. Pipe the
secret store's value directly; do not print or pass it as an argument. The token
must have at least 32 characters. Configure the receiving number through
`WHATSAPP_RECEIVING_NUMBER`, then rerun `bun scripts/configure.ts`. Remove the
retired outbound OTP configuration and any obsolete outbound credential.

The Omni automation forwards inbound messages to `/api/omni/inbound` with a
Bearer token, `X-Omni-Event-Id`, and the original event envelope. The envelope
contains `payload.content.text`, `payload.from`, `payload.externalId` and a numeric
millisecond `timestamp`. Forward only messages received from other people.
When the Worker returns a `reply`, Omni may send that reply to that sender;
204 means send nothing. The service never initiates a message. The Omni operator
must prevent answer-mode duplication for matched automation messages. Neither
the automation's private values nor its operator notes belong in public source.

The Cloud confidential-client secret belongs
in the Cloud backend's secret store; the identity database receives only its hash.

Apply the checked-in migration before first traffic:

```sh
bun x --no-install wrangler d1 migrations apply DB --remote --config wrangler.local.toml
```

Review `clients.json`, including Cloud's example callback, before seeding. A real
callback change is a reviewed source change. Feed the existing Cloud client secret
from its backend secret store into `bun scripts/seed-clients.ts --remote` over stdin.
The script requires at least 32 characters, computes the pinned provider's SHA-256
base64url hash, writes an owner-readable temporary SQL file, applies it through
Wrangler and removes it. It never prints the raw secret. Do not invoke it without
stdin or include a secret as an argument. `--local` seeds a local Wrangler D1 for
manual trials. The checked-in list is the only client source; no HTTP registration
or client-management endpoint is exposed.

The seed is repeatable: it updates reviewed policy and the supplied Cloud secret
hash for known IDs. It does not delete unknown rows; investigate any row outside
the reviewed list before taking traffic. Disabled product placeholders stay off.
Only desktop and Cloud skip consent; a third-party entry must set it false. All
entries receive `requirePKCE: true` and the supported grant/scope lists.

## Scheduled cleanup

`wrangler.toml` carries one cron trigger (`17 * * * *`, hourly) that the deploy
uploads with the Worker. Each run removes up to 100 users created more than
24 hours ago that have no passkey, no phone number, no OAuth client and no live
session: accounts left by a passkey ceremony that was never finished. Their
sessions, accounts and registration challenges go in the same D1 transaction. A
larger backlog clears over later runs. The trigger needs no extra secret or
permission. To pause it, remove the `[triggers]` table in a reviewed change and
redeploy; the Worker's cron settings in the dashboard show the next run.

## Upload and check

Run the upload yourself, from an interactive terminal. Wrangler asks before it
replaces a DNS record or another Worker's Custom Domain on the name only when it
runs in a terminal; without one it replaces them silently. Answer no to either
question: the name should have been free (step 1).

```sh
bun x --no-install wrangler deploy --config wrangler.local.toml
```

Only run this after the owner supplies the HTML described in PAGES-CONTRACT.md,
or explicitly approves a backend-only first deployment with 501 pages. Wrangler
lists `id.automagik.si (custom domain)` among the Worker's triggers. Then open
`https://id.automagik.si/.well-known/openid-configuration` and check its `issuer`
is exactly `https://id.automagik.si/api/auth` (Better Auth's base URL with its
`/api/auth` path; ID tokens carry the same `iss`). That string is what products
store; it does not change later.

Test a real passkey, desktop loopback sign-in with S256 and Cloud confidential
sign-in on `https://id.automagik.si`. Confirm D1 migrations and seed records, secure cookies, correct
issuer/audience/nonce checks in each client, and WhatsApp-disabled behavior. Apply both migrations, including
`0002_whatsapp.sql`, before enabling the new configuration. Existing phone-account
fields remain intact; the service does not migrate or link identities automatically. Never
share operational identifiers or current deployment details in public evidence.

To roll back, remove the Custom Domain (which removes its DNS record) or the
Worker through the operator's deployment workflow. Preserve the database and auth secret
until issued sessions have been deliberately retired. Do not drop D1 as a routine
rollback. A later deploy from the same `wrangler.local.toml` attaches the name
again. This delivery does not change a product's identity settings.
