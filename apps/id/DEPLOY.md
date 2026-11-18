# Owner-run first deployment

Delivery 1 deploys nothing. Run these steps only when the owner authorizes the
first trial.

## The passkey site name

Every Automagik and Arca sign-in uses one passkey site name (WebAuthn's
relying-party ID): `automagik.si`. The service reads it from the `PASSKEY_RP_ID`
setting and refuses to start, answering every request with a plain error, when
its own host (`BETTER_AUTH_URL`) is not `automagik.si` or a subdomain of it.

A browser only lets a site use a passkey site name that is its own host or a
parent of it. A workers.dev address can therefore never carry the `automagik.si`
name, so the trial does not run on workers.dev: it runs on a test name under
`automagik.si`, written here as `<test-name>.automagik.si`. Passkeys made during
the trial are bound to `automagik.si`, not to the test name, so they keep working
when the service later moves to its public name (for example `id.automagik.si`),
provided the move keeps the same D1 database, which holds the passkey records.
The move itself is a separate owner decision. The Worker has no workers.dev
address (`workers_dev = false`); its only address is the test name.

## Owner steps in Cloudflare

These are the owner's steps, done in the Cloudflare dashboard. Nobody else
creates the DNS entry or makes the token; the deploy reads the token only from
the secret store.

1. **The deploy token.** Create an API token scoped to the deployment account,
   with these account permissions, and save it straight into the operator's
   secret store:

   | Permission | Access | Purpose |
   |---|---|---|
   | Workers Scripts | Edit | Upload Worker and assets, set secrets |
   | D1 | Edit | Create the database, apply migrations and seed clients |
   | Account Settings | Read | Resolve account metadata |

   The token needs no zone permission: the DNS entry is the owner's own step below.
2. **The test name's DNS entry**, after the first upload (below), when the Worker
   exists: in the Worker's settings, under Domains & Routes, add a Custom Domain
   `<test-name>.automagik.si`. Cloudflare creates the DNS entry and its certificate
   in the `automagik.si` zone. The name must not already have a DNS record. After
   each later upload, confirm the custom domain is still listed.

Supply the account through `CLOUDFLARE_ACCOUNT_ID` and the token through
`CLOUDFLARE_API_TOKEN` from that secret store. Do not put either in shell history or a tracked
file. Do not print environment variables or run commands with shell tracing. No
account, zone or database identifier belongs in a tracked file.

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
`https://<test-name>.automagik.si`, through the operator's private environment.
Then:

```sh
bun scripts/configure.ts
```

This writes ignored `wrangler.local.toml` from the tracked template and the
environment, with a `DB` D1 binding, `BETTER_AUTH_URL` and
`PASSKEY_RP_ID = "automagik.si"`. It refuses an origin that is not HTTPS on
`automagik.si` or a subdomain of it, a workers.dev origin included. No account,
database or zone ID is tracked. Omit `WHATSAPP_RECEIVING_NUMBER` and `OMNI_INBOUND_TOKEN` to keep the inbound
WhatsApp flow off. The receiving number is private runtime configuration; do not
put its value into a tracked file. This service has no outbound OTP endpoint.

## Secrets, migration and client seed

Create the auth secret directly into Wrangler's secret input. Do not run the
generator by itself, use command substitution, echo it, or save it in a file:

```sh
openssl rand -base64 48 | bun x --no-install wrangler secret put BETTER_AUTH_SECRET --config wrangler.local.toml
```

If Wrangler asks to create the named Worker before its first upload, accept only
the intended trial Worker. That is an operator action, not part of this delivery.
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

## Upload and trial

```sh
bun x --no-install wrangler deploy --config wrangler.local.toml
```

Only run this after the owner supplies the HTML described in PAGES-CONTRACT.md,
or explicitly approves a backend-only trial with 501 pages. Then the owner adds
the custom domain `<test-name>.automagik.si` (step 2 above). Test discovery, a real
passkey, desktop loopback sign-in with S256 and Cloud confidential sign-in on the
trial origin. Confirm D1 migrations and seed records, secure cookies, correct
issuer/audience/nonce checks in each client, and WhatsApp-disabled behavior. Apply every migration, including
`0002_whatsapp.sql` and `0004_session_sign_in_method.sql`, before enabling the new configuration.
Sessions issued before `0004` carry no sign-in method, so they can never add or delete a passkey;
a new passkey sign-in can. Existing phone-account
fields remain intact; the service does not migrate or link identities automatically. Never
share operational identifiers or current deployment details in public evidence.

To undo a trial, remove the custom domain (which removes its DNS entry) or the
trial Worker through the operator's deployment workflow. Preserve the database and auth secret
until issued sessions have been deliberately retired. Do not drop D1 as a routine
rollback. This delivery neither changes a product's identity settings nor moves
the public name.
