# automagik.si

RFC 0027, revised by the owner on 2026-11-11: the umbrella home plus Desktop, Mobile,
Omni, Genie, Cloud and Mykes pages. Arca's page at `/arca/` is Arca's own, served by Arca's
Worker: this site links to it and builds no page there. The app's current default Stage theme supplies
the colours, type and component treatment. Every product screen is a provenance-backed
capture; brand/font licences are in `assets/brand/LICENSES.md`.

Each block has its own visual: the home's stage with Genie and Omni behind the real app's
window; a bento of blocks (the app's review view, Pocket on a phone, the octopus, Genie on
plum, Cloud on the stage); the real Pocket app in its own preview; the three-step wish flow
from real captures. Light and dark both follow the visitor's system, and every app picture
has a dark capture of the same view for the dark theme. Pages show WebP art from `assets/art/`, built at 1x and 2x
by `scripts/build-art.mjs` from Automagik's own art and crops of the captures, each recorded
with its source digest in `assets/art/manifest.json`.

The committed HTML needs no Pages build step. A page carries one script, the family drawer's
own (see "The family drawer"); nothing else on a page runs script. The home
has one small film slot: a real still with one quiet line until the film exists. Cloud is coming soon and carries intent, consent and removal
forms, with email confirmation; inbound-first WhatsApp confirmation is paused
(`WHATSAPP_SIGNUPS_OPEN`, see `waitlist/README.md`). No launch or marketing email.
The meter is not a product or page. Herdr and DSH are Desktop installation channels.
Pages carries no Arca page: no file at `/arca/` and nothing under it. Arca's own page is
live at that address since 2026-11-13, and the stand-in this site kept there until then is
removed, as RFC 0027 says. The deploy uploads this folder as it is, so a file at `arca/`
would be published beside Arca's page: `landing.test.mjs` holds that there is none. The
installer's address answers with a shell script, so no link points at it; Get Arca on the
home page and in the menus opens `/arca/`.

## Navigation

It is a website, not one landing page. The header starts with the family's menu button, at
the window's left edge, then the logo, three menus (Products, Resources, Company) and one
button. Each menu entry has a one-line description and its character, mark or glyph. The
menus need no script: each menu button opens its panel through the browser's popover: click,
Enter or Space open it, Escape or a click outside close it and return the focus, and the
browser keeps the button's expanded state for assistive technology (so the HTML carries no
`aria-expanded` of its own). Hover opens the same panel in CSS, in the same place. Below
860 px the three menus fold away and the family drawer is the one menu: it carries the
site's other pages under its top block. A browser without popovers opens the panels on
hover or focus. The footer is the sitemap with the same groups. Every product page shows where it is (the header's Products button and a breadcrumb
back to all products) and links to the previous and next product. Products keep one order
everywhere; it is the `products` list in `scripts/build-pages.mjs`. The previous and next links walk
the pages this site builds, so they pass Arca by: its page is Arca's own and has no link back
into the round.

## The family drawer

The menu button and the drawer it opens are the product family's shared piece: Arca's
drawer package, issue 11, approved by the owner on 2026-11-12, as issue 12 gives it (the
same look, with the case where the host is Automagik answered and two faults found with
real keys fixed). `assets/family/` holds the
piece as it was given (`family.html`, `header-button.html`, `family.css`, `family.js`) and
its art, all byte copies; `assets/family/SOURCE.md` lists each file's source and SHA-256,
and `landing.test.mjs` pins them. Never edit a copy: a change is asked of the piece's
author and arrives as a new issue, which is a file swap with new digests.

- **What it shows**, top to bottom: where you are (Automagik, with its lockup and line),
  with Desktop and Mobile right under it; then Products: Arca by its own logo, and Omni,
  Genie and Mykes, each as its word in the lettering with no mark, "Coming soon." under
  Mykes; Support and Close. No pet, no Genie head, and the triskle beside nothing but
  Automagik.
- **The host is Automagik** (the package's own rule for this case): Automagik appears once,
  as the "You are here" block, never again lower down. So the piece's Automagik row is left
  out, its Desktop and Mobile buttons move into the top block, and Arca, which the piece
  has in the top block on Arca's site, is the first row of Products, by its logo
  (`arca-logo-b.svg`, written into the page so it takes the text colour). The two style
  rules this needs are in the piece's own `family.css`.
- **A closed drawer fetches nothing**: every picture in it carries its address in
  `data-src` or `data-srcset`, and the piece's script gives a picture its address when it
  is shown (on a first open, the lockup and the three words for the ground in view). The
  builder fills the same slots, in those attributes, and writes no `src` there. With script
  off the drawer never opens, so its pictures are never needed.
- **The keyboard stays in it**: Enter or Space opens it, Tab and Shift+Tab go round its
  stops (Shift+Tab from the first goes to Close), Escape closes it and the focus returns to
  the button.
- **How it is built in**: `family(route)` in `scripts/build-pages.mjs` reads the piece's
  file and writes it into every page with its comments left out, its slots filled, and this
  site's own parts in the places the piece gives a host: the top block, the list under it
  (`familyLinks`: Cloud, Get the app, Privacy, the pages with no row of their own; it
  shows below 860 px, where the header's menus fold away), the three moves above,
  addresses written from this site's root, and
  `aria-current="page"` on the page being read. A link to a place on the page being read
  is a bare `#name`, so the piece shuts the drawer before going there. The contract test
  undoes those parts one by one and compares what is left with the piece's file.
- **The page**: everything from the skip link to the footer is inside one wrapper,
  `data-family-page`, which the open drawer pushes aside and puts out of reach (inert, and
  hidden from assistive technology). The drawer, its clear layer and the layer that opens
  another product's world come after the wrapper; the script is the body's last thing.
- **The host's side of the styling** is one block in `styles.css`, and nothing in it
  changes what the piece shows or does. It gives the names the piece reads this site's
  values (colours from the theme's tokens, labels in the title face at its label weight);
  draws the three classes the piece borrows (the label, the quiet link, the small button)
  as this site draws them; says the piece's day values again for a light page, because
  this site sets no `data-theme` and follows the visitor's system; centres the button in
  this header's height; keeps the logo clear of the button with this site's own column;
  and keeps the round button and the pills round under the site's focus ring.
- **Script off**: the button is a plain link to the page's own sitemap, the footer, and
  the drawer stays shut.
- The Cloud form's answer pages (`waitlist/lib/ui.js`) keep their own small header with no
  menu: they are sent with a policy that allows no script.

## we unfold and Open Intelligence

Automagik is part of we unfold. The link and both lines of wording are one constant,
`weUnfold` in `scripts/build-pages.mjs`: change them there and regenerate. They appear in the
Company menu, once on the home page and once in every footer.

Open Intelligence is applied the way Arca's site applies it. The only mark is we unfold's
horizontal tag, `assets/brand/open-intelligence/open-intelligence-tag.svg`, pasted inline as
given (one colour, the text colour around it; its words are live text in IBM Plex Mono
SemiBold, which `styles.css` loads). No round seal anywhere. In every footer the tag is 170
by 32 px, in the footer's text colour, at the right end of the last row (under it, at the
left, on a phone), and it is a link to we unfold that holds nothing but the tag: no words
in the link, no sentence beside it. The tag is never bigger than the logo it sits with, so
the footer's triskle is never under 34 px tall (its word alone then passes 170 px). Never
redraw, stretch, outline, shadow or recolour the tag; its words never change; it never stands in the header,
a hero, the favicon or a share picture. The tag is we unfold's mark: it is not under this
site's Apache-2.0 grant, and nothing here calls it open-licensed.

The official Automagik lockup is the logo with the tag under it, right edges together, the
tag 62% of the logo's width (Arca's proportion): `assets/brand/automagik/` holds it as SVG
and as PNG at 3000 px wide, in ink for light grounds and cream for dark ones.
`node apps/landing/scripts/build-lockup.mjs --png` rebuilds the files from the logo, the tag
and the font. The home page shows it once, in its brand block. Arca's own lockup files are
not cleared for a public repository and are never committed here. The contract test holds
the rules from the we unfold team: Open Intelligence keeps both capitals and is never
shortened; we unfold is lower case in running text; "part of" means the movement, never
ownership; in a sentence the text is the link. The owner approves both lines before the site
goes live.

## Links out

Guides and help link to the docs site, `https://docs.automagik.dev`, with no deep paths
while that site is being redone. GitHub is linked for the downloads and once, quietly, at
the end of the footer. No page links to an RFC or to the capture notes; both stay in the
repository. The projects row on the home links each of its eleven projects to that
project's own site (the list is `used` in `scripts/build-pages.mjs`).

## The projects row

The home shows one row, "Things that made our stack possible", between the hero and the blocks:
DeepSeek Harness, Herdr, Agent Client Protocol, Model Context Protocol, A2A, Hermes Agent, Oh My
Pi, Pi, NATS, iroh and Better Auth, in that order (`used` in `scripts/build-pages.mjs`). It is a
credit: no ranking, and no partnership, sponsorship or endorsement wording.

- One type system: each project's own standalone mark, an unchanged copy of its official file,
  and the name in this site's type. iroh publishes only a wordmark, so that is its item. Marks
  keep their own colours and are drawn at one optical height, never taller than the site's
  own name in the header; a project's dark file is used on a dark page.
- Each item links to the project's own site, in the same tab, and nowhere else.
- One line of credit under the row; the trademark sentence is in the footer's legal line on
  every page, and NATS™ is in its mark's alt text.
- The row drifts only for a visitor who allows motion (slower on a phone, so every name is
  whole on screen for at least 7 s as it passes; the browser gate holds that number), stops
  under the pointer, and is the still, wrapped list with reduced motion or with the keyboard
  in it. The second copy of the list only fills the gap while it drifts and is out of reach
  of the keyboard and of assistive technology.
- Under the row is a pause switch (WCAG 2.2.2, Pause, Stop, Hide), for a touch screen, where
  no pointer can rest on the row: a plain checkbox drawn as a small pill, "Pause" and then
  "Paused", with no script. A tap, a click or the Space key holds the row where it is and
  lets it go again; nothing on the page moves when it does. It is shown only while the row
  drifts, so not with reduced motion.
- `assets/brand/LICENSES.md` lists every file's source, the rule read and its SHA-256, and the
  standing rule: if a project's owner asks, its logo comes down the same day.

## The logo and the browser's icons

The logo is Automagik's logo kit, the approved set: the triskle in three colours with its
seam line, and the lowercase wordmark. The triskle is always shown in colour. Its files are
copied unchanged, and `LICENSES.md` pins each one's SHA-256 (`landing.test.mjs` checks them).

- Header and footer, and the Cloud form's answer pages (`waitlist/lib/ui.js`): the kit's
  lockup for small sizes, `assets/brand/automagik-lockup-three-colours-ink-header.svg`
  (ink letters) on the light page and `-cream-header.svg` (cream letters) on the dark one.
  `styles.css` sizes it by the triskle's height (`--mark`): the file is 264 tall where the
  triskle is 222, and the g's tail hangs under the triskle. The triskle is 32 px tall in the
  header (26 on a phone, 24 at 360 px wide and under) and 40 px in the footer (34 on a phone),
  so the lockup is never under the brand's 28 px floor (24 × 264 / 222 is 28.5).
  The browser gate reads the name's drawn colour in both themes, not only the file's name:
  it must stand clear of the ground the logo itself stands on, the header's or the footer's
  (a contrast of 7 or more), so the two files cannot be swapped unseen. No colour is named
  there.
- Genie, Omni and Mykes each show as their own mark with their name (the brand's rules 9
  and 10): Genie's flat lamp, Omni's tentacle vortex, Mykes's cords, one colour each, with
  the name in the brand's lettering. The files are byte copies of the brand folder's
  (`docs/brand/logo/`), pinned in `assets/brand/LICENSES.md`. The lockup is the heading of
  `/genie/`, `/omni/` and `/mykes/` (`productLogo()` in `scripts/build-pages.mjs`), the ink
  file on the light page and the cream one on the dark page; the image's text is the
  product's name. `styles.css` sizes it by height alone, a share of the window's width that
  fits the heading's column for the widest of the three (Genie's), up to 128 px, so the
  three pages' letters are one size. The lockup also titles Genie's and Omni's cards on the
  home page, 44 px high: Omni's card follows the theme and shows the drawing for small
  sizes (`-header`; under about 56 px the large vortex's suckers turn to specks); Genie's
  card is dark in both themes, so it shows the cream file. The lamp and the cords have one
  drawing each. In the Products menu each of the three stands beside its mark alone
  (`productMark()`), Omni's the vortex drawn for about 32 px.
  The browser gate reads the colour each is drawn in against the ground it stands on (the
  page, Omni's card, the lightest part of Genie's card, every stop of the stage behind
  Mykes's heading, the menu's ground) and measures each lockup at six widths: its own
  proportions, inside its column.
- The official lockup with the tag (above) is built from the kit's large lockup.
- The triskle is Automagik's mark and Automagik's alone (the brand's rule 1). Alone it
  shows for Automagik's own Cloud, the kit's drawing for the size shown:
  `triskle-three-colours-32.svg` beside Cloud in the Products menu,
  `triskle-three-colours.svg` in the Cloud hero. It stands beside no other product's name:
  the Genie and Omni lockups that carried it are retired and gone from the site.
- The picture beside a name in the Products menu is a mark's place, so no character stands
  there (the brand's rule 3): Omni, Genie and Mykes show their own marks and Cloud the
  triskle. The pets stay where they are art: the tiles and the list of more building blocks.
- The drawer's lockup: the brand's floor for a lockup is 28 px, with one exception, 24 px in
  the family drawer's phone layout. Here Automagik is the host, so its lockup stands alone
  in the drawer's top block and is 24 px high down to the narrowest phone; the browser gate
  measures it at 375 and 360 px wide.
- The browser's icons are the kit's favicon set at the site's root, all in three colours:
  `favicon.ico` (16, 32 and 48 px), `favicon.svg` (the drawing for small sizes),
  `apple-touch-icon.png`, and `icon-192.png` and `icon-512.png` (the mark on the ink
  ground) named by `site.webmanifest`.

Never recolour, stretch or redraw a kit file, and never set the word in type. The gradient
capitals and the old clay triskle without its seam line are retired; their files are gone.
A newer kit (a changed wordmark, say) is a file swap: copy its files to the same paths and
put their digests in `LICENSES.md`; no page, style or test names what the files draw.

## Arca's logo

Arca's logo is the ark, in one colour, the text colour, never coloured (the owner's decision,
handed over in the family package's issue 11c). Both files are byte copies from that
package, in `assets/family/`, written into the page as they are so they take the text
colour:

- `arca-logo-b.svg`, the ark with its word: Arca's row in the family drawer.
- `arca-ark-icon.svg`, the ark alone: the picture beside the name "Arca" in the Products
  menu (centred in the menu's own square) and on the home card. The name stands beside it,
  so the picture is hidden from assistive technology.

The arch was Arca's earlier logo. The package says no other site should use it: no page
here shows it, its files are not in this site, and the contract test holds both. This site
never animates Arca's logo, never tints it and never locks it up with the Open Intelligence
tag. Name any retina file `name-2x`, since the privacy check reads the usual at-sign form
as an address.

## Motion

Motion is CSS only and sits in one block of `styles.css`, for visitors who have not asked
for reduced motion: sections and cards rise as they scroll into view, a card's picture
moves a little within it, the home's cast pops up and peeks higher as the page leaves,
pages cross-fade with a character
travelling to its own page, and the menus ease in. The drawer's motion is the piece's own,
on the timings the host block gives it, and it too is still for a visitor who asks for less. It moves only `translate`, `scale`,
`rotate`, `transform` and `opacity`, so the layout never shifts. With reduced motion, or in
a browser without scroll-driven animation, the page is whole and still.

## Source and checks

Edit public page copy in `scripts/build-pages.mjs`; shared Cloud form/response copy in
`waitlist/lib/ui.js`; layout/components in `styles.css`. `theme.css` derives directly from
`apps/bots-dsh/src/client/stage.js` and, for the title face, from `docs/brand`: the family, its
three weights (`--weight-title`, `--weight-strong`, `--weight-label`) and the font file come
from `docs/brand/tokens/tokens.json` and `docs/brand/fonts/`. In `styles.css`, set anything in
the title face with one of those three weights, never a number: a heavier Fredoka is heavier
than the logo. `docs/brand/components/bundle.css` is made from `styles.css`: every change to
`styles.css` must be followed by `node scripts/brand-bundle.mjs`, committed with it (the brand
tests fail until the two agree).
Regenerate and commit the HTML and CSS:

```sh
node apps/landing/scripts/sync-theme.mjs
node apps/landing/scripts/build-art.mjs   # only after an art or capture change; needs ffmpeg with libwebp
node apps/landing/scripts/build-pages.mjs
node scripts/brand-bundle.mjs              # after a change to styles.css
bun install --frozen-lockfile --ignore-scripts
node --test apps/landing/landing.test.mjs apps/landing/waitlist.test.mjs
LANDING_CHROME=/path/to/chrome node apps/landing/verify-browser.mjs
node herdr/scripts/privacy-check.mjs
```

The browser gate checks all pages at 1440, 1024, 390 and 320 px, light and dark. It checks
that no heading word breaks across lines, every image is sized, the film still stays smaller
than the page's main picture and keyboard focus shows. It checks that a dark page shows
the dark captures (and a light page the light ones), that the home's speech bubble stays
off the app window, and that the hero's app capture is shown near its real size. It checks
images/fonts, overflow, failed/external loads and native form 503/200 responses against an
isolated SQLite fixture. It drives the menus with real clicks and keys in both themes: open
and close by click, Enter and Space, Escape with the focus returning to the button, the
expanded state in the accessibility tree, hover in the same place as click, one panel at a
time, the active page, and every menu, drawer and footer link answering. It drives the family
drawer the same way at 1440, 390 and 320 px: the button at the window's edge with its three
lines in this ground's colours, the logo clear of it; a click, Enter or Space opens it, and
it pushes the page aside without widening the window; the page behind is inert and only the
drawer is offered to assistive technology; the lockup, shown once, and the three words are
the files for this ground, at one letter size, and no other picture is fetched; Desktop and
Mobile stand in the top block under its link; Arca is the first product, by its logo, with
its line in the names' column; Tab stays inside;
Escape, Close, a press beside it or on the button shut it and the focus returns to the
button; a product goes to its page, and a place on the page being read shuts the drawer
first. With script off the button leads to the footer's sitemap. Every page run is in reduced motion and checks
that no animation runs and the browser's layout-shift score is 0. A separate run with
motion scrolls every page top to bottom at 1440 and 390: something moves, the layout-shift
score stays 0, nothing widens the page, everything that rises ends fully shown down to the
last section, the page-to-page transition runs to its end and the menu's entrance settles.
It writes full-page images and a JSON report to ignored
`.cache/landing-evidence/`; set `LANDING_EVIDENCE` to another absolute report directory.
At 1440 and 390 it also renders equal-width side-by-side site/app comparisons in each theme.
The `landing` CI job runs the same gates and retains the images/report as an artifact.
No real confirmation is sent by a test. Resend is mocked; WhatsApp rendering/callbacks
make no third-party request. The live account integration is an owner check.

`assets/screens/manifest.json` and `assets/CAPTURES.md` record each capture. New Stage
reference shots come from `capture/theme.mjs --run`, a fresh isolated DSH profile without
an AI model or live chat. Set `LANDING_CHROME` to an installed matching Chrome/headless-shell
binary; install the declared Bot harness/dependencies and the desktop runtime's pinned
pnpm first. The app screens come from `capture/capture.mjs --run` (the Northwind scenario,
each view in light and dark; `LANDING_FIXTURE_BASE` names a scratch folder other than
`/tmp`). The Pocket
screens come from `capture/pocket/PocketDemoShotsTest.kt`, run in a scratch copy of Pocket
(steps in `assets/CAPTURES.md`), never inside `apps/pocket`.

## Downloads and hosting

Desktop uses the repository's release aliases. Mobile links directly to the APK named by
Pocket's rolling release manifest. Its verified URL/digest/date are in `assets/releases.json`;
refresh from that manifest before publishing. Windows and iPhone are soon text without links.

### The download hook

The home's hero has one action: a tray of platforms (`getHook` in `scripts/build-pages.mjs`,
from the one `platforms` table). The Desktop and Mobile pages open with the same tray for
their own platforms. Mac, Linux and Android are live: each is a button that opens that
platform's sheet through the browser's popover, with no script. Windows and iPhone say Soon
and are labels: not a link, not a button, and no file is named for them. A platform moves
from soon to live in `platforms`, with a real file, and never before that file exists.

A sheet says what you get, the exact file, what it needs, how to install it, and carries one
download button for that file and one link to the platform's guide on the docs site. On the
home it also links to the product's page. In a wide window the sheet sits in the middle; on
a phone it rises from the bottom edge and the page behind it does not scroll. The page behind
an open sheet is inert, Escape or the close button shuts it and the focus goes back to the
platform. A browser without popovers gets plain links in the tray instead: to the product
page from the home, to the file from a product page.

Herdr and DSH are two short entries on the Desktop page, each with one link to its guide.
The guide links (`guide` in `scripts/build-pages.mjs`) all point at the docs front page
until the docs site has a page for each; a link moves to its page only once that page is
live, and `landing.test.mjs` lists every destination a page may link to.

Owner's Cloudflare Pages settings: root `apps/landing`, no build, output `.`. The root must
include `functions/` for the confirmation routes to compile. The production site is indexable
(the owner's OK, 2026-11-12): the pages carry no robots meta and `_headers` sends no
`X-Robots-Tag`. Previews stay out of search through Cloudflare Pages' own preview header, not
through anything here; the waitlist API's responses keep their own noindex. Account-level
access control is the owner's. No preview URL, account ID, zone ID, database ID or key belongs
in the repository. No agent changes DNS.

See [waitlist setup](waitlist/README.md) for the exact binding, secrets, plain variables,
schema, EU jurisdiction, Resend sender and the v2 event-envelope contract called by our
cx Support Bot using `WAITLIST_CONFIRM_SECRET`. Missing
configuration fails closed with 503. Preview and production databases/credentials are separate.

## Developer entry points

The old developer landing commands live here:

```sh
curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh | bash
genie desktop
```

The Genie CLI supports Linux x64/arm64 and Apple silicon Macs. `genie desktop` needs Linux
x64 or an Apple silicon Mac; there is no Linux arm64 desktop build. It downloads the matching
Automagik release and checks SHA256SUMS. On Mac, drag the app into Applications. Bring an AI
account or API key; provider terms apply. Code mode needs Herdr and the Automagik pack separately.

## Discovery and Arca routing

`robots.txt`, `sitemap.xml` and `llms.txt` live at this Pages root and are generated with the
HTML. The owner allows all crawlers, including AI training crawlers: `User-agent: *`,
`Allow: /`, and explicit `Allow: /arca`. Search engines and AI crawlers may index every page.

The root sitemap and assistant index include Arca's supplied lines verbatim. The home card,
the Products menu, the drawer's list and the footer link to `/arca/` in the same tab. Arca's own page is live
there (2026-11-13), and Pages carries no file at that address. For Arca's site, the owner configures Worker routes **exactly**
`automagik.si/arca` and `automagik.si/arca/*`. A zone Single Redirect matches hostname equal
to `automagik.si` AND URI path equal to `/arca`, returning 301 to
`https://automagik.si/arca/` with the query preserved. Do not match the path alone:
`arca.automagik.si` is the Arca dashboard. `/arcade` and other paths stay with Pages.
No Worker route, redirect or account setting is changed by this source update.

## WhatsApp timing

New WhatsApp sign-ups are paused (`WHATSAPP_SIGNUPS_OPEN` in `waitlist/lib/shared.js`): the form
offers email only and the endpoint refuses a WhatsApp sign-up. When the switch is on, the form
offers WhatsApp beside email and warns in English and Portuguese that confirmation may take a
little while. Codes issued before the pause confirm as follows. Our support Bot sends the
v2 envelope with the original
message receive time in top-level `timestamp` (Unix milliseconds). The callback accepts a
message received at or before the code's 30-minute expiry, even if processed days later.
More than two minutes ahead of processing time is 400; missing/invalid receive time is 400.
Processing more than 180 days after expiry is 404, including retries after that backlog limit.
Pending WhatsApp rows survive cleanup until that limit; email expiry is unchanged. Single
use, message-ID idempotency and every no-text/no-logging rule remain in force.

The owner-approved Support on WhatsApp section is included verbatim in English, with the
same meaning in Portuguese. Its approved source and translation are in `waitlist/privacy-support.*.md`.


The public-copy contract rejects internal delivery labels and product-team jargon in all
HTML, including image alt text. Browser evidence records each hero headline's box and text
rectangles against its card's padded content bounds, in addition to document overflow.
WhatsApp backlog expiry compares processing and receive times in milliseconds in both the
JavaScript guards and the SQL single-use update. The exact deadline is accepted; deadline
plus one millisecond is rejected on first use and replay.
