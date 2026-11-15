# RFC 0027: README, launch film and automagik.si

| Field | Value |
|---|---|
| Status | Accepted; site map and confirmation choices revised by the owner on 2026-11-11. Exact pages, film and deployment still need the owner's preview OK. |
| Goal | A stranger opens the repository, watches the film and reaches automagik.si: the umbrella of Automagik's building blocks, each with its own page. |
| Deadline | 2026-11-16 |
| Lanes | README, RFC and `apps/landing/` ship to no installed app. No release, account change or DNS change is authorized by this RFC. |
| Created | 2026-11-10 |

## Summary

Automagik is the umbrella: open building blocks of superintelligence. The home page introduces
that umbrella, carries the launch film and links to each block's own page. Desktop and Mobile
show their distribution channels. Cloud is coming soon and carries an interest form with email
or inbound-first WhatsApp confirmation. Mykes has a coming-soon page; Arca owns its page in a separate Worker.

The owner's 2026-11-11 decisions replace the original single-page, seven-block site and the
Genie draft's look. The site uses the app's actual default Stage design system: theme tokens,
fonts, surfaces, controls and components. The meter is a component, never a product or page.
No extra product pages are introduced. Nothing goes live before the owner's OKs.

## Owner decisions

- **Q1, hosting:** Cloudflare Pages, from this repository. Root `apps/landing`, build command
  empty, output `.`. The owner connects and configures the account. Preview deployments remain
  unlisted and noindex; production DNS and removing noindex are D4.
- **Q2, film:** the storyboard, HyperFrames, 16:9, under a minute, instrumental only. The
  soundtrack is CC0, with its source and licence. The owner approves the exact cut and music.
- **Q3, reversed on 2026-11-11:** the site is the umbrella, and each building block has its own
  page. Arca and Mykes are included. The approved map below supersedes the original rule
  forbidding additional blocks. The meter has no product page.
- **Q4, distribution:** Desktop leads with Mac, Linux, Windows soon, then Install on Herdr and
  Install on DSH. Mobile leads with Android, then iPhone soon. Only existing channels have
  links. The owner's explicit “soon” wording applies to these unshipped channels, Cloud, Arca
  and Mykes.
- **Q5, sending half decided on 2026-11-11:** email confirmation uses Resend from the verified
  `send.automagik.si` subdomain, with the Pages secret `RESEND_API_KEY`. It sends one
  confirmation, no launch, marketing or other email. WhatsApp is inbound-first through our cx Support Bot:
  the person sends a one-time code, the site confirms the entry, and the support Bot replies once in that
  conversation. The exact final v2 integration contract is in D3b below. No other sending is
  authorized. A future launch email remains a separate owner decision.
- **Visual system:** the real app's current default Stage theme, not the external draft's
  visual direction. `apps/bots-dsh/src/client/stage.js` defines the palettes, typography,
  surfaces and component treatment; `themes.js` adapts them to DSH; the desktop renderer's
  `shell.css` and `frame.js` carry the same table and ink colours. Comparison shots place the
  site and a real app capture side by side at equal width in the same theme.
- **Acceptance:** PR #1078 remains draft until the owner approves the revised preview. One
  reviewed push at the end of this revision; no subsequent push before the Orchestrator replies.

## Approved site map

| Path | What it contains |
|---|---|
| `/` | The Automagik umbrella: open building blocks of superintelligence, the film, one card per page below. |
| `/desktop/` | Automagik Desktop: Download for Mac, Download for Linux, Download for Windows (soon, no link), then Install on Herdr and Install on DSH. Team mode on DSH and Code mode through Herdr are parts of this page. |
| `/mobile/` | Automagik Mobile: Android download, iPhone (soon, no link). Pocket pairs with the person's own machines through Pocket Link. |
| `/omni/` | Omni connects chat apps to Automagik, with channels and canvases in the same window. |
| `/genie/` | A wish becomes a branch, test run and report the person approves; `genie desktop` opens it on the team. |
| `/cloud/` | Coming soon, private and paid, not live. The intent form, confirmation choices, consent, privacy note and removal form. |
| `/arca` and `/arca/*` | Owned and served by Arca’s Worker, not Pages. The home card links to `/arca/` in the same tab. Arca’s page is live since 2026-11-13 and Pages carries no page there; the stand-in it kept until then is removed (see “Arca boundary and root discovery”). |
| `/mykes/` | Coming soon. No invented features, download or licence claim. |

There is no meter page or meter product card. A page that uses usagemeter may describe it
briefly as a component, grounded in RFCs 0017 and 0018. Herdr and DSH are installation channels
on Desktop, not separate product blocks. No additional product page is part of this delivery.
The shared footer scopes Apache-2.0 to this repository, Genie and Omni; it never calls the
entire umbrella free or open source. Cloud is a private, paid service with public contracts.

## Design and copy

- Use the real app's Stage palette: cream by day, plum at night, the cyan/lilac/pink stage,
  paper cards, hairline dividers, flat controls and the app's lift, radii and focus treatment.
  The landing's `theme.css` is generated from the app source; a test detects drift.
- DM Sans and Manrope are bundled with their OFL files. Only Automagik's own marks and art
  appear as brand accents. Brand assets keep their licence notes.
- Screens are real captures with source, scenario and SHA-256 in
  `assets/screens/manifest.json` and `assets/CAPTURES.md`. No invented UI or recoloured screen.
  A fixture may use fictional data, clearly identified. No private profile or real chat is
  captured. The pack's original share capture is provenance-backed but is not used as a
  separate product block in the revised site.
- No unverified numbers, vanity metrics, customer marks, testimonials or status chips.
  Technical platform requirements and the explicit “soon” choices above are stated plainly.
- Every claim is grounded in the repository or the owner's words. No claim is taken from the
  previous domain. Do not claim the app download sets up Code mode: it needs Herdr and the
  Automagik pack. The app's switch still says Work for Team mode.
- Secrets are entered in the app's own card and are not shown to Bots. Approval copy names
  its exceptions: Main and Omni Bots read chats and post to groups, WhatsApp channels and
  the person's own chat without asking; other Bots request chat access, and an Always grant
  permits subsequent posts there. The source citations are in README PR #956.
- Native HTML and CSS, no client JavaScript, embedded third-party player, tracking or cookies.
  The only server work is the confirmation/removal flow. Motion respects reduced motion.

## Files and distribution

The static source is `apps/landing/`: committed `index.html` files at the routes above,
`styles.css`, generated `theme.css`, `assets/{brand,screens,film}` and `_headers`.
`scripts/build-pages.mjs` generates shared page markup, including the Cloud form, from public
copy. `scripts/sync-theme.mjs` derives the app's tokens. Pages needs no build step.

Mac and Linux links use this repository's desktop release aliases. Android links to the APK
URL in the Pocket release lane's `latest.json`, recorded with its version, digest and check
date in `assets/releases.json`. Refresh it before go-live; do not invent a stable APK alias.
Windows and iPhone are plain soon text, without a link or disabled download button.

The root README's umbrella-first story and existing developer sections remain D1's work
(PR #956). Any later README adjustment to this revised map is separate from inventing new
product claims. The site's developer commands live in `apps/landing/README.md`.

## The film (D2)

One cut, one film element on the home page. The site's committed paths remain
`assets/film/automagik-launch.mp4` and `automagik-launch-poster.webp`, with `LICENSES.md`.
The film shows the launch team at work, not an invented product dashboard. Until D2 supplies
the approved files, the single poster slot says “A short film is coming” and reuses a labelled
recorded capture. It has no false play control. Other pages contain no film element.

The README plays a GitHub attachment of the same cut, no more than 10 MB, since GitHub's CSP
cannot play a site-hosted film there. D2 records the attachment URL and sha256 and retains the
committed poster fallback. The owner approves the attachment, cut and track before D4.

## D3b: Cloud intent and confirmation

### Human form and stored fields

The Cloud page has one native POST form to `/api/waitlist`, plus a removal form under its
expandable privacy note. The visitor supplies a goal (1–1000 characters), platform (`android`,
`linux` or `both`), optional app/tool names (up to 200 characters), expected result (1–500
characters), confirmation channel (`email` or `whatsapp`), language (`en` or `pt-BR`) and
explicit consent. Email is required only for email confirmation and is trimmed and lowercased,
up to 254 characters. These are bounded, inert text; nothing a visitor enters is fetched,
executed, or interpolated into executable markup.

The consent covers recording and reviewing interest and one confirmation through the chosen
channel. It creates no Cloud account, entitlement, purchase, marketing subscription or
training consent. There is no launch email. The human's answers are written in Automagik's
own words. No private reference material is copied into the public repository.

D1 stores the intent, channel/language, consent version, created/expiry/confirmation times,
email when selected, token/code hash, and the WhatsApp sender ID or number, external message
ID, event time and retained reply when confirmed. It never stores message text, sender name,
raw event/envelope, metadata, an IP or user agent. The reply is retained so an exact retry
returns the same text after a deploy. Only the owner can read/export confirmed entries;
unconfirmed or expired entries are never treated as confirmed.

### Email

`RESEND_API_KEY` is a Pages secret. From is `Automagik <confirm@send.automagik.si>`, on the
owner-verified `send.automagik.si` domain. The endpoint calls only Resend's fixed email API,
with a unique idempotency key and a fixed plain-text confirmation. No visitor-controlled
recipient list, URL, subject or sender is accepted. The one random token is hashed in D1,
valid for a day. Opening its link displays a native confirm form; only its POST confirms, so
an email scanner's GET cannot consume it. Duplicate submissions send no additional email.
A failed or ambiguous delivery consumes its reservation and is never retried inside the
cooldown. The response is 503, never a claim that confirmation succeeded.

### Quotas, retention and failures

One email per normalized address per 24 hours; one pending entry per address; five form joins
per fixed UTC-minute network bucket; ten per network bucket per UTC day; sixty confirmation
emails per UTC day. IPv6 is grouped at /64, IPv4 by address. The client address comes from
Cloudflare's trusted edge header and is transformed in memory into a daily keyed digest;
only short-lived digest counters are stored. D1 triggers check and reserve all counters in
the same INSERT transaction before any send, so concurrent isolates cannot overspend the
budget. The callback has a separate sixty-authenticated-calls-per-minute limit. Missing
configuration, missing client address or failed store access is 503. Invalid input is 400,
wrong method 405, wrong media type 415, and an exhausted quota 429. No endpoint logs bodies,
contact details, text, names or credentials; no cookies are set.

Email entries expire unconfirmed after a day and are deleted on the next human request.
WhatsApp codes cover messages received within thirty minutes, with a 180-day processing
backlog window after expiry; pending WhatsApp rows are retained until that window ends. Quota/cooldown rows
are pruned on requests after expiry. This is opportunistic deletion, not a promised timed
cron. The owner reviews retention every six months and clears the confirmed list at launch
or earlier removal. Confirmed WhatsApp replay receipts stay only while their waitlist row
exists. The original reply can be retried for the same message ID inside the backlog window;
it cannot confirm a new row. A message received after expiry, or processing after the 180-day
window, is 404. Cleanup does not erase a pending WhatsApp row inside that window.

### WhatsApp endpoint contract (v2 envelope, follow-up decisions applied)

WhatsApp confirmation contract (RFC 0027 D3b), v2 envelope updated 2026-11-11: our cx Support Bot calls the endpoint. The existing event-envelope shape is unchanged; the credential and timing rules below supersede the earlier caller/processing-time contract.
1. Endpoint: POST <site origin>/api/waitlist/whatsapp-confirm (production https://automagik.si, preview the pages.dev host). HTTPS, JSON only (else 415).
2. Auth: Authorization: Bearer <WAITLIST_CONFIRM_SECRET> (Pages secret; the cx Support Bot reads it from its server environment). Constant-time compare; missing or wrong 401 with empty body. No body signature or separate authentication timestamp: replay safety rests on the single-use code, authenticated message receive time, 180-day backlog limit and message_id idempotency. The RFC records this as the accepted cost.
3. Body: Omni's standard event envelope (its push contract), always valid JSON: {"id", "type": "message.received", "timestamp": <Unix ms>, "metadata", "payload": {"externalId", "chatId", "from", "senderName", "content": {"text"}, ...}}; headers X-Omni-Event-Id (stable across Omni retries), X-Omni-Delivery-Id, Authorization: Bearer. The site: (a) refuses any type other than message.received with 400; (b) finds the code in payload.content.text with its own regex, case-insensitive (AMG-[0-9A-HJKMNP-TV-Z]{6} with the i flag), upper-cased; no code found: 404; (c) uses payload.externalId as message_id for the replay rule (X-Omni-Event-Id is the same on a retry and may be used as a second key); (d) takes from = payload.from, drops any @ suffix; all digits: a phone number with a leading +; otherwise an opaque sender id (a privacy LID); (e) requires received_at from the envelope timestamp in Unix milliseconds, rejects a missing/invalid time or a time more than 120 seconds in the future with 400, and accepts only received_at <= expires_at plus processing within 180 days after expiry; (f) reads the text and senderName only in memory to find the code and never stores or logs them, nor any part of the request body: no request-body logging anywhere, errors log only a status and a request id. Missing payload.content.text, payload.from or payload.externalId, or malformed JSON: 400.
4. Responses (the support Bot replies only on 2xx, with the reply field's text; nothing on any non-2xx or timeout):
   - 200 {"reply": "<text>"} on first match.
   - 200 {"reply": "<same text>"} when the same message_id arrives again (a support Bot retry).
   - 409 {"status": "already_confirmed"} when the code is already confirmed and the message_id is new (no second reply); also when it was confirmed from a different sender id.
   - 404 {"status": "unknown_or_expired"}; 429 rate-limited; 503 store down.
   The reply is short, in the language used on the form, says the sign-up is confirmed and how to remove it.
5. Code: "AMG-" plus 6 Crockford base32 characters (0-9 A-H J K M N P-T V-Z), random, single use, valid 30 minutes, bound to one waitlist row; shown upper case. Omni's trigger (no flags): [Aa][Mm][Gg]-[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{6} on payload.content.text, only on the instance of the chosen number, only messages not sent by Omni itself. wa.me prefilled text: Confirm my Automagik waitlist: AMG-XXXXXX
6. Storage: channel whatsapp, the phone number OR the opaque sender id (the site may never get a phone number), message_id and confirmed_at; never the message text or the sender name, and nothing of the body is logged. The privacy note says a WhatsApp sign-up stores the sender id or number WhatsApp gives. The site never sends anything outbound.

### Replay and identity cost accepted by the owner

The shared Bearer authenticates the integration, not a person. It has no per-event signature
or freshness timestamp. The single-use code, authenticated receive-time expiry, 180-day processing limit, and
externalId/message_id receipt are the replay boundary. A same-ID retry returns the retained reply only for the same
code and normalized sender. A new ID for a used code, or a different sender, is 409. A stolen
Bearer can submit guessed codes until rate-limited; rotate it in both systems if compromised.
The site does not infer a phone number from an opaque identifier. Our cx Support Bot owns
the instance filter, exclusion of its own messages and the conversation reply; its
configuration is coordinated by the Orchestrator, outside this site.

The raw body is never persisted. Only the explicit extracted confirmation fields listed in
Storage are retained; text, senderName, chatId and metadata are discarded. The callback makes
no third-party request, sends no WhatsApp message and logs nothing, including on errors.
The chosen number comes from the plain variable `WAITLIST_WHATSAPP_NUMBER` (international
digits without +), never from a hard-coded real number. The returned wa.me link and inline
QR are generated locally. No external QR image service is used.

### Privacy and removal

The visible, expandable privacy note names Namastex Labs as controller, privacy@automagik.si
for access/correction, the intent/contact/confirmation fields, consent, retention, Cloudflare
as processor and the D1 EU jurisdiction, international transfers, Resend for email, and
WhatsApp/Meta and Omni for that chosen route. It explains that WhatsApp may supply an opaque
sender ID instead of a phone number. It states no marketing/training consent, no cookies or
analytics, no advertising sharing, owner-only access and the rights to confirmation, access,
correction, deletion, withdrawal, and complaint to ANPD or an EU supervisory authority.

Removal posts an email, WhatsApp number/sender ID or the original confirmation code, deletes
matching waitlist rows and replies identically whether a match existed. It sends nothing.
Short-lived abuse/cooldown hashes keep their original expiry after removal so deletion cannot
reset a mail cap. Removal by contact is unauthenticated, as D3b originally chose: a person who
knows a contact or code can remove that row, but cannot read it. Expired unconfirmed rows
may await the next cleanup request physically; WhatsApp retention and eligibility follow
the received-time/backlog rule above. The owner-approved Support on WhatsApp section is
included verbatim in English and with the same meaning in Portuguese. Support conversations
are retained for the assistant’s memory until the person asks to download or reset them;
this is distinct from the waitlist, which never retains the message text.

### Owner configuration

Preview and production each need a different D1 database, created in the EU jurisdiction,
with `waitlist/schema.sql` applied, bound as `WAITLIST_DB`. Plain variable
`WAITLIST_DATA_JURISDICTION=eu` acknowledges that configuration; the function fails closed
without it. Pages secrets: `RESEND_API_KEY`, `WAITLIST_CONFIRM_SECRET`. Plain variable:
`WAITLIST_WHATSAPP_NUMBER`. There is no account, zone or database identifier in source.
The owner verifies the sending subdomain, creates the privacy address and configures the cx Support Bot.
The setup report lists the same names for both Pages environments. Previews remain
owner-only/noindex and use isolated test contacts. No agent reads the owner's list or secrets.

Before production, the owner adds a WAF rule for the public join path; it is an outer filter,
not the authoritative quota. The function is fail-closed until its required bindings and
channel-specific configuration exist. Nothing here buys a service, changes DNS or accesses
an account.

## Deliveries and acceptance

- **D1, 2026-11-11:** README PR #956, umbrella-first story and corrected desktop claims. The
  original seven-block README copy is historical context for this revision; the owner has
  now chosen the multi-page site map above.
- **D2, 2026-11-13:** approved film, encodes, poster, CC0 licence and attachment provenance.
- **D3, 2026-11-14:** PR #1078, the approved umbrella/pages, real captures, app design system,
  reviewed local/external links, noindex preview and browser evidence. Keep draft until OK.
- **D3b, 2026-11-15:** intent/consent/removal form, D1 schema, email confirmation, final v2
  WhatsApp callback, tests and owner setup instructions in this same PR. The owner configures
  the databases, secrets, plain variables, sending domain and the support Bot.
- **D4, 2026-11-16:** after the owner's page/film/README OKs, attach automagik.si, check HTTPS
  and canonical paths, remove noindex, and redirect the old domain. Confirm each live download
  and block link. Test a real email and inbound WhatsApp once, then remove the test rows.
  No go-live is authorized before those checks and OKs.

## Verification

| Check | Command / evidence |
|---|---|
| Static pages | `node --test apps/landing/landing.test.mjs`: map, one h1 each, one film, reviewed hrefs/actions, source-backed images/digests, exact generated theme, native forms and privacy. |
| Waitlist | `node --test apps/landing/waitlist.test.mjs`: real local SQLite schema/triggers, duplicate/concurrent reservations and caps, one mocked Resend confirmation, ambiguous failure, consent/field bounds, every final WhatsApp status, opaque IDs, no logging/outbound callback, retention and non-enumerating removal. No real message is sent by tests. |
| Browser | `LANDING_CHROME=... node apps/landing/verify-browser.mjs`: all pages at 1440, 1024, 390, 320, light and dark; no horizontal scroll, all images decode/200, local fonts, no third-party loads, native 503/200 form responses. Equal-width side-by-side app comparisons at 1440 and 390. |
| Privacy | `node herdr/scripts/privacy-check.mjs` before every push. Private inputs and preview URL never committed. |
| CI | Landing job installs root playwright-core with Bun, runs page/waitlist/browser gates with the runner's Chrome and saves evidence. Whole-repository privacy runs too. |
| Release | `bun scripts/lane.ts ships origin/dev` for this change: no installed component changes. |
| Preview | Pages check successful; curl each path and function, verify noindex meta/header and exact deployed content. Missing bindings must give 503, not success. |
| Owner / live boundary | Check D1 schema and declared EU jurisdiction in the account, real Resend/Omni integration, quota and WAF configuration, removal and final preview acceptance before production. Local SQLite tests do not claim to prove a configured live D1 or email domain. |

## Rollback

Revert the landing/RFC/CI commits or redeploy the prior preview. Remove function bindings and
secrets and stop the support Bot integration. Delete the dedicated waitlist database to withdraw the
service and its only list. No installed app, plugin ID, storage prefix, version or release
changes. Before D4 there is no production domain to undo; after D4 detach it and restore the
previous deployment/DNS. No launch or marketing email was sent by this flow.

## Sources

README PR #956 and the repository READMEs for Desktop, the Bot team, Pocket and the Herdr
pack; the owner's 2026-11-10 and 2026-11-11 decisions; RFCs 0011 (lanes), 0013 (modes), 0017
and 0018 (meter component), 0024 and 0025 (Cloud); the app's Stage theme and DSH adapter;
`apps/landing/assets/CAPTURES.md`; the final v2 WhatsApp contract recorded above.


## Follow-up decisions, 2026-11-11

### Arca boundary and root discovery

Pages owns `robots.txt`, `sitemap.xml` and `llms.txt`. Arca owns exactly the Worker routes
`automagik.si/arca` and `automagik.si/arca/*`, which the owner configures. The home card links
to `/arca/` in the same tab. Pages carries no `/arca` page or descendants. `/arcade` and other
paths remain with Pages. The owner adds a zone Single Redirect with BOTH hostname equal to
`automagik.si` AND URI path equal to `/arca`: 301 to `https://automagik.si/arca/`, preserving
the query. A path-only redirect is wrong because `arca.automagik.si` is Arca's dashboard.
No account routing or redirect is changed by this delivery.

**Stand-in, 2026-11-12.** Arca's own site is not deployed yet and has no date. Until it is
served at this address, Pages carries exactly one stand-in page at `/arca/` and nothing under
it: Arca's name, the owner's one line for it ("Be your own cloud. Infrastructure for AI
agents."), Get Arca as the install command, shown as text to copy (the installer's address
answers with a shell script, so it is never a link), and the way back to all products. Arca is a product in
the site's menus, the home blocks and the footer. The root `robots.txt`, `sitemap.xml` and
`llms.txt` keep Arca's supplied lines unchanged. When Arca's Worker takes the routes above,
the stand-in page is removed; nothing else changes.

**Removed, 2026-11-13.** Arca's own page is live at this address. The stand-in page is
removed: Pages carries no file at `/arca/` and nothing under it, and its builder no longer
makes one. The Products menu, the home card, the family drawer's row, the footer and the
product pages' links to the next and the earlier product still open `/arca/` in the same tab,
and the root `robots.txt`, `sitemap.xml` and `llms.txt` keep Arca's supplied lines unchanged.

### A website's navigation, and we unfold, 2026-11-12

The owner on the redesign's preview: it is the real website, not a landing page. The header
has Products, Resources and Company menus with a one-line description per entry, a phone
menu with the same groups, the active page in the header, a footer sitemap with the same
groups, and on each product page the way back to all products and the previous and next
product. The pages still carry no client JavaScript: the menus use the browser's popover.

Automagik is part of we unfold, the home of the Open Intelligence movement. The link
(`https://weunfold.ai/`) and both lines of wording live in one constant in
`apps/landing/scripts/build-pages.mjs` and appear in the Company menu and once on the home
page. The owner approves the two lines before the site goes live.

### Stamp, links, logo slot and motion, 2026-11-12

The owner on the next preview. The Open Intelligence line first got a stamp drawn for this
site, then we unfold's round seal; the owner then asked for Open Intelligence applied as on
Arca's site. So the only mark is we unfold's horizontal tag: 170 px wide at the end of every
footer, a link to we unfold that holds nothing but the tag, and under the logo, right edges
together, in the official lockup (`apps/landing/assets/brand/automagik/`), which the home
page shows once in its brand block. No seal, and no words about supporting it. Guides and help link
to `https://docs.automagik.dev`; GitHub is linked for the downloads and once in the footer;
no page links to an RFC. Arca's own logo stands wherever Arca does: the icon from Arca's
logo kit, published here with the owner's and Arca's agreement on 2026-11-12. The public
copy is shortened without changing its meaning; approved copy is untouched. The pages move: scroll-driven reveals, page
transitions and menu entrances, in CSS only, off for reduced motion, with no layout shift.

Arca's supplied sitemap entries are included verbatim:

```xml
<url><loc>https://automagik.si/arca/</loc></url> <url><loc>https://automagik.si/arca/llms.txt</loc></url> <url><loc>https://automagik.si/arca/index.md</loc></url>
```

Arca's supplied assistant-index lines are included verbatim:

```md
- [Automagik Arca, the page](https://automagik.si/arca/)
- [Automagik Arca, for an assistant](https://automagik.si/arca/llms.txt)
```

The owner allows every crawler, AI training crawlers included, across the entire site. The
root robots policy is `User-agent: *`, `Allow: /`, with explicit `Allow: /arca`. This settles
the earlier pending rule for the rest of the site. Since the owner's OK on 2026-11-12 the
production site is indexable: the pages carry no robots meta and the site sends no
`X-Robots-Tag`. Previews stay out of search through Cloudflare Pages' own preview header, and
the waitlist API's responses keep their own noindex. These discovery files do not attach a
domain or alter account settings.

### WhatsApp visibility and delayed processing

WhatsApp stays visible beside email, even before the support assistant is live. Plain copy
near the option says “WhatsApp confirmation may take a little while” and “A confirmação pelo
WhatsApp pode demorar um pouco.” No coming-soon substitute, disabled choice, hidden QR or
suppressed wa.me link replaces the existing confirmation path.

The authenticated caller supplies the original message receive time in the v2 envelope's
`timestamp` (Unix milliseconds). A message received **at or before** the code's `expires_at`
can confirm when processed later, up to **180 days after expiry**, inclusive. More than
120 seconds in the future, missing, non-finite or invalid receive time is 400. A receive time
after expiry or processing beyond the 180-day window is 404. The pending row survives cleanup
inside the backlog window; email cleanup is unchanged. The same limits apply to stored
receipts, while single use, message_id idempotency, sender matching, constant-time Bearer
comparison and every no-text/no-logging rule remain. The owner accepts the receive timestamp
from the authenticated caller; there is no additional event signature.

The four regression tests prove: an on-time message confirms after days of processing delay
(including intervening cleanup); a message received after expiry is 404; a time more than
two minutes ahead is 400; processing after 180 days is 404. The expiry mutant named before
editing, `processing-clock-expiry`, replaces the received-time expiry guard with a processing-
clock guard. The delayed-processing test must kill that mutant.

The integration secret is now `WAITLIST_CONFIRM_SECRET`, in both Pages environments and the
cx Support Bot environment. The old Omni-specific secret name is not used. The v2 envelope
body is retained; this follow-up does not introduce a new body format or an Omni automation.
The owner subsequently approved the Support on WhatsApp privacy text. This follow-up includes
it verbatim in English and with the same meaning in Portuguese. It explains that the support
assistant replies only, people from the team may watch and join, each conversation is sandboxed
and retained for memory without automatic deletion, Omni carries messages to the AI model,
no data is sold or used for advertising/marketing, and people may download/reset their
conversation through the assistant or privacy address. A waitlist code is recorded as confirmed
without the waitlist retaining the message text. Public copies of the approved text and
translation live under `apps/landing/waitlist/privacy-support.*.md`.


### Review repairs: public copy, precise cutoff and headline bounds

Public pages use visitor language: the launch team, an upcoming short film, GitHub downloads
and opening workspaces. The page contract forbids internal delivery labels and team jargon
in text and attributes. The placeholder remains one honest film slot until the cut is ready.

Both receive-time and processing-time backlog guards use millisecond comparisons in
JavaScript and SQL. The exact 180-day deadline is accepted; deadline plus one millisecond
is 404 for first use and replay. Pending-row cleanup observes the same precise cutoff.
Stored second-based timestamps and counter buckets retain their established units.

The responsive gate checks each hero headline's element box and text rectangles against
its card's padded content area, including 390px, instead of relying only on document width.
