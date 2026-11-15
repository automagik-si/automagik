# The family drawer: where these files come from

Every file in this folder is a byte copy from one package: **the menu drawer and its button,
issue 12**, written by Arca's designer on 2026-11-12. Issue 11 ("the right names in the
drawer") was approved by the owner that day ("thats better now, approved. coming soon under
mykes"). Issues 11b and 11c are the same piece with answers added, asked from this site: what
the drawer holds when the host is Automagik, who the host is on a page, and which Arca logo
another site uses (all below). Issue 12 fixes faults found with real keys in three browsers
and does not change how the drawer looks (its own words: "the drawer looks exactly as
approved"; see "What issue 12 changed").

- The package's own `SHA256SUMS` has the sha256
  `06741c53a17ee6e3125d6d5eb83bff98f5c6b5c30689cb68649a581dfa08a06f`.
- Earlier lists: issue 11 `6dcfbe6f8e6d0737019320ddb883cb85986abe738a68c726b2104f816844bad8`,
  issue 11b `61c4b94c8ce6c9b21a37ac2c751a2977b57f18c7e7b4172dd86ed9c86f39c8cf`, issue 11c
  `d6bad6bedcad6009aac2b8b91275e1bc93d00496712af3de4d7cadfdf150fb52`. Across 11, 11b and 11c
  no file taken here changed. Issue 12 changed three: `family.html`, `family.css` and
  `family.js`. `header-button.html` and every picture have the digest they had in issue 11.
- `arca-ark-icon.svg` is the one file issue 12 does not carry: it is from the hand-over that
  followed issue 11c (see "The ark alone").
- Nothing here is edited. A change is asked of the piece's author and arrives as a new issue:
  replace the files, put the new digests in this table and in `landing.test.mjs`.
- `scripts/build-pages.mjs` reads `family.html` and `header-button.html` and writes the
  drawer into every page: comments left out, slots filled, this site's own parts put in the
  places the piece gives a host. `styles.css` holds the host's side of the styling.

| File here | File in the package | sha256 |
| --- | --- | --- |
| `family.html` | `piece/family.html` | `5941c2d0abcddc4956d1183aeac2d65d3f8de059c0377a2310423fbbb139b6b7` |
| `header-button.html` | `piece/header-button.html` | `3d502e338a526ce541f3cef809cd0f33d233f660897294bab9c670260ae9eefe` |
| `family.css` | `piece/family.css` | `12c60e79838cda45b0f5c36f87b2b936de46f4c4291c48f41ad058a1562d33e2` |
| `family.js` | `piece/family.js` | `a24cd31a4a967980e0d3dddafd4b7f46d5e95788f45541a67d22637ee1f287ec` |
| `automagik-lockup-three-colours-cream-48.png` | `art/automagik-lockup-three-colours-cream-48.png` | `5518af46313bc1678c77f382b85476638fe15dd99e4dbf275e6e21403bc36b37` |
| `automagik-lockup-three-colours-cream-64.png` | `art/automagik-lockup-three-colours-cream-64.png` | `f4a31554d492a201bd123ad149930b24a3a2f4ccb5ba514d522a652d048d26ef` |
| `automagik-lockup-three-colours-cream-128.png` | `art/automagik-lockup-three-colours-cream-128.png` | `f1113affc7f486217330d7ebc4fbce0c9538d63f84ddea88c40680ec79a87e9a` |
| `automagik-lockup-three-colours-ink-48.png` | `art/automagik-lockup-three-colours-ink-48.png` | `b7f32743404095a1b50e56539dd08be79564db5ace2342a0e2f9375e8162ceaa` |
| `automagik-lockup-three-colours-ink-64.png` | `art/automagik-lockup-three-colours-ink-64.png` | `4a4313b88432dc3187c86cb6b64fe00ebd565a172b243b83fd5fa3a4bf337b19` |
| `automagik-lockup-three-colours-ink-128.png` | `art/automagik-lockup-three-colours-ink-128.png` | `89a274a63cf3812a4ff2ecf832204e33236444118c06ece93d5766b58d595380` |
| `omni-wordmark-cream.svg` | `art/omni-wordmark-cream.svg` | `e930250e3797750d6ad118b8a5f7639e2604db3a78d68645666177f69191b5d2` |
| `omni-wordmark-ink.svg` | `art/omni-wordmark-ink.svg` | `e8c21842b9c280fddacfbf20e8ce998a1ea4be5069b47a43002ebf7db40e8e37` |
| `genie-wordmark-cream.svg` | `art/genie-wordmark-cream.svg` | `4bf79674edd489de7172b76b48d64982cbd973e56679a9575d560044b9b8a317` |
| `genie-wordmark-ink.svg` | `art/genie-wordmark-ink.svg` | `481008dcd0b1281308e22474cebef71a20f78b247e51095896bebec9561d647d` |
| `mykes-wordmark-cream.svg` | `art/mykes-word-night.svg` | `9099d9566ebee75e3cc683987f5b69bfc8c1c41873871f5415654a1efbc12752` |
| `mykes-wordmark-ink.svg` | `art/mykes-word-day.svg` | `28c80ac26bea923146094869fafe032a9397d85c4fd0ad6432a885ceb24219dc` |
| `arca-logo-b.svg` | `art/arca-logo-b.svg` | `ea2cfc8b60be3fe0b064e11b6238b290a1545a654e8fe44a190ebc0a623db116` |
| `arca-ark-icon.svg` | `art/ark-icon/svg/arca-ark-icon.svg` | `165f7bbb1bf0d3ac6a079c2f2b547564f31c5f13dedd275c63816af9fd33ff87` |

## What issue 12 changed

- **A closed drawer fetches nothing.** Every picture of the drawer carries its address in
  `data-src` (the two `<source>` in `data-srcset`), where a browser does not read it, and
  the piece's script gives a picture its address when its layer is shown and the picture
  itself is shown: on a first open, the four for the ground in view (the lockup and the three
  words); the other ground's four only if the drawer is opened on that ground; the large
  lockup when another product's layer first opens. The slots have the same names, in those
  attributes, so the builder fills them as before. With script off the drawer never opens,
  so its pictures are never needed.
- **The six word pictures have a width and a height** (617 by 264 omni, 677 by 264 genie,
  793 by 257 mykes).
- **Two holds on the focus.** Shift+Tab from the first stop goes to Close and Tab from Close
  to the first, also when the focus has left the drawer; and when the keyboard takes the
  focus out of the drawer to nowhere, it goes on to the other end at once. A pointer press
  never triggers the second.
- **The two rules for a host that is Automagik are in `family.css`** (below). They were in
  the package's README only, so this site's stylesheet held them; it no longer does.

## The host is Automagik (issue 11b, "A case of its own")

On Automagik's own pages the "You are here" block and the Automagik row would both show the
Automagik lockup, one under the other. The package's rule, which the builder follows:

- **Automagik appears once**, as the "You are here" block: its lockup (the Automagik row's own
  pictures and classes, inside `.fam-logo`), its line, "You are here".
- **The Automagik row (`.fam-top`) is not in the page.**
- **Desktop and Mobile (`.fam-apps`) stand in that block**, right under the link and above the
  list of pages.
- **Products lists Arca first**, by its own logo: `arca-logo-b.svg`, the ark with its word,
  inline in a `.fam-logo` inside a row with the class `is-logo`; then omni, genie, mykes.
- **Two style rules for this case** are in the piece's `family.css` since issue 12:

  ```css
  .fam-here-block .fam-apps { padding: var(--space-8) var(--space-13) 0; }
  .fam-item.is-logo .fam-words > span:last-child { padding-left: calc(var(--lock) * 321.34 / 264); }
  ```

**Who the host is (issue 11c): whoever's logo stands in that page's header.** Every page of
this site wears Automagik's header, the product pages included, so
Automagik is the host on all of them and each product stays a row in Products. A product
moves to the top block only on a page in its own world, with its own logo in the header.

**Which Arca logo (issue 11c): the ark.** Arca's logo is the ark with "arca", in one colour
(it takes the text colour and is never coloured): `arca-logo-b.svg`. The arch is Arca's
earlier logo, and no other site should use it. The file is Arca's row in the drawer
(`arcaLogo` in `scripts/build-pages.mjs`). It was also the heading of the stand-in page
this site kept at `/arca/`; that page is gone since Arca's own page is live there.

**The ark alone: `arca-ark-icon.svg`.** Handed over after issue 11c for the two places
where this site shows Arca's picture beside its name, the Products menu and the home card
(`arcaArk` in the builder), so that no arch is left on this site. It came in the package's
folder `art/ark-icon/`, which has a checksum list of its own, with the sha256
`fcb0b261ca11121c97265d779b286517d38e19fc28bbf607ae2607eb67e2923d`; issue 11c's own list
does not name that folder, and issue 12 does not carry it (its README points to Arca's page B
package for the ark alone). The file here is that hand-over's, unchanged. Only the file that takes the text colour is taken; the folder's
ink and cream files and its PNGs are not.

The package's picture of this case is a mock on Arca's draft page; its line and section names
are stand-ins. The line here is this site's own ("Open building blocks of
superintelligence."), and the list holds this site's pages with no row of their own.

## The words

- `omni-wordmark-*.svg` and `genie-wordmark-*.svg` are the same bytes as
  `docs/brand/logo/wordmark/` in this repository.
- `mykes-wordmark-*.svg` is the word "mykes" in the same lettering, the file we unfold's live
  deck uses, handed over through the package. Only the two Mykes files are named differently
  here: `-cream` (cream letters, for a dark ground) is the package's `mykes-word-night.svg`,
  and `-ink` (ink letters, for a light ground) is its `mykes-word-day.svg`. The same two files
  are in `docs/brand/logo/wordmark/` under these names.
- No mark is approved for Omni, Genie or Mykes: each shows its word alone. The triskle stands
  in Automagik's lockup and nowhere else in the drawer. Arca's logo is Arca's own: the ark.
  The Genie and Omni lockups, which carry the triskle, are not used here.

## Not taken from the package

- `piece/family-bar-values.css`: Arca's own four colours.
- `art/arca-logo-a.svg`: Arca's other logo, for Arca's own page A.
- `shots/` and the package's `README.md`.
