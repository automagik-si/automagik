# RFC 0032: Automagik ID

- Status: In delivery; delivery 1 authorized by the owner.
- Scope: one identity for all Automagik products.

## Decision

Automagik ID uses Better Auth, under its MIT license, in one Cloudflare Worker
with D1. Passkeys are the first sign-in method, including account creation without
an existing session. There is no email, password, social sign-in or sign-up form.
WhatsApp proof through Omni is disabled by default. Delivery 2 requires the person
to send a browser-issued challenge message first; the service never sends first.

Automagik desktop and Cloud connect through OpenID Connect first. Arca, Omni and
Brain can each gain their own client later. Every client requires S256 PKCE;
native clients use the standard loopback redirect flow. Client registrations
come from a reviewed seed list. Third-party clients require consent; the seeded
first-party clients may skip it. D1 persists sessions, challenges and rate limits.

This replaces RFC 0024's identity-provider choice, its provider hosting and
administration assumptions, and its account provisioning and product-client
arrangements. RFC 0024's workspace isolation, product authorization, principal
binding, credential protection and desktop sign-in safeguards still apply.
Product roles and entitlements remain the product's responsibility.

## Delivery 1

The independently deployed service lives in `apps/id/`. Repository releases do
not carry it. Acceptance requires passkey account creation and sign-in, an OIDC
code flow, verified tokens, strict redirect and PKCE checks, optional phone-code
verification, and shared database rate limits in a local Workers runtime.
Sign-in and consent screens belong to the owner and follow the page contract.
They exist since #1118 (`apps/id/pages/sign-in.html`, `consent.html`).

Every Automagik and Arca sign-in shares one passkey site name, `automagik.si`
(owner, 2026-11-11), read from a setting; the service refuses to start on a host
outside it. A workers.dev address cannot carry that name, so the first deployment
and acceptance trial use a test name under `automagik.si` (owner, 2026-11-15),
and passkeys made there keep working at the public name. No public-name move
occurs until the owner explicitly directs it. This delivery provisions and
deploys nothing. Rollback disables the service; keep its database and signing
material until product sessions have been retired deliberately.

## Trust boundary and later decisions

Only the allowlisted authentication and protocol endpoints are public. There is
no public client management API. Secrets are provisioned through the deployment
tool's secret input, and configuration identifiers stay outside tracked files.
There is no automatic migration from another provider's principals.

Recovery, account linking, additional product clients, phone rollout, and the
eventual public name each need a later owner decision. Enabling phone codes
does not link a number to an existing passkey identity.

## Delivery 2: inbound phone proof

The browser receives a short-lived challenge and a prefilled messaging link.
The person sends that message; Omni forwards the event to an authenticated
inbound endpoint. Hashed challenges, browser binding, event deduplication,
message-time checks and shared rate limits live in D1. A verified sender can
sign in once to its phone account or create a separate one. An existing browser
session never becomes the account selected by the phone proof. Privacy IDs and
other non-phone identifiers cannot verify a number. The outbound phone-code
path is removed. Page controls follow the extended page contract in a separate
delivery; receiving configuration and secret provisioning remain owner actions.
