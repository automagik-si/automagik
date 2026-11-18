# Where the landing page's screens come from

Every image in `screens/` is a screenshot of the Automagik app's own interface, rendered by
`apps/landing/capture/capture.mjs` from the released plugins. None is drawn, mocked up or
edited afterwards. `screens/manifest.json` records the checkout, the runtime, each plugin's
pinned source and the SHA-256 of every image; `landing.test.mjs` fails if an image no longer
matches its digest.

## What rendered them

| Part | Version | Source |
|---|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | 0.2.2-rc.2 | The runtime the Bot team's harness declares (`apps/bots-dsh/dev/harness`), which the desktop app ships too (`apps/desktop/runtime`) |
| `@automagik/bots-dsh` (the Bot team) | 3.135.0 | This repository at release commit `aabe26a1`; the script refuses to run if any shipped file differs from it |
| `@automagik/welcome-dsh` (the welcome) | 3.135.0 | Same release commit, same check |
| `@automagik/genie-dsh` (Genie) | 0.1.4 | `automagik-si/genie` at `39402fb1`, `plugins/genie-dsh`: the commit `marketplace/automagik.json` pins, exported with `git archive` |

Omni's plugins are not part of the capture (see *Left out*). The manifest records the exact
versions, commits and trees of the run that made the committed images.

## What is real and what is made up

- **Real:** the app and its plugins, every screen and control, the welcome's steps, Pip
  messaging Genie, Genie's `grant_wish` tool, the wish's own copy of the project and its
  `wish/csv-export` branch, every shell command the thread ran and its output, the commit, the
  tests passing, the files in the review pane, the branch coming back to the project, and the
  app's own permission card, which the person saves at its Workspace level in each chat.
- **Made up:** the person, the project and the words. Northwind is a fictional company, after
  Microsoft's classic Northwind sample database, whose customer names the three invented
  orders borrow. The commits are signed `Northwind Demo
  <demo@northwind.invalid>`. The AI is `capture/scripted-model.mjs`, a loopback stand-in
  for the AI provider: it gives every reply and chooses every tool call from a fixed English
  script, so no AI provider was called. The app labels the model `DeepSeek-V4.1-Flash`
  because the capture connects it as DeepSeek, the provider the welcome found. The thread's
  report states the test counts the real `npm test` printed, and the script checks them
  again in a fresh clone of the branch.

## How it runs

```sh
bun install && (cd apps/bots-dsh && bun install && bun run harness) && (cd apps/welcome-dsh && bun install)
node apps/landing/capture/capture.mjs --run    # from the checkout root; GENIE_REPO=<genie clone> if it is not beside the main checkout
```

`LANDING_CHROME` names the Chrome binary where it is not the macOS default, and
`LANDING_FIXTURE_BASE` a scratch folder outside the checkout where `/tmp` is too small.
The run is cut off from the person's own setup:

- Its own folder under `/tmp` or `LANDING_FIXTURE_BASE` (outside the checkout, so no
  repository `AGENTS.md` reaches the Bots).
- Relocated `HOME`, `DSH_HOME`, `AUTOMAGIK_HOME` and every cache.
- An allowlisted environment.
- Sockets fenced to loopback and to the runtime's own ports (`apps/bots-dsh/dev/advanced-fixture/loopback-only.mjs`).
- A fresh headless Chrome profile that blocks every other origin.

It never touches an installed Automagik app, its profile or a live DSH.

It asserts every step before it takes a picture:

- the welcome's team state;
- Pip's hand-off to Genie;
- one commit on the wish branch, adding the four files;
- the branch's tests passing in a fresh clone;
- the project still on `dev`, so nothing was merged;
- Genie's report;
- the test output in the thread;
- the diff in the review pane;
- no host path, token or e-mail address in each captured view, and no real home folder anywhere on the page;
- a dark picture whose page background differs from the light one;
- no browser request outside the runtime.

## The screens

Every view is pictured twice from the same page, without a reload: `name.png` in the app's
light theme and `name-dark.png` in its dark theme, which the app picks from the system
appearance. All are @2x. The chat window is 1100 px wide, close to the width the site shows
it at, so its text stays readable; each chat is pictured again at phone width.

| Files | Size | What it shows |
|---|---|---|
| `team-step.png`, `team-step-dark.png` | 1440×900 | The welcome's **Grow your team** step after the person made their companion, Pip (an orange bunny). Pip says: *Pip here! Omni is asleep. Click its power button to bring it along.* The step reads *Pip leads. Who comes along?* Omni's card shows a sleeping octopus with its power button off. Its *Powered off* label is for screen readers only, and the capture asserts it. Genie's card says *Ready for a wish* and *On your team*: its plugin is installed. |
| `pip-delegates.png`, `pip-delegates-dark.png` | 1100×720 | Pip's chat. The person asks for a CSV export of the Northwind orders report. Pip says it passes the request on, sends Genie a message (*Messaged Genie*), and, after *Message from Genie*, says the wish is running on `wish/csv-export`. In the sidebar, Genie's finished thread **CSV export** is marked *Done*. |
| `pip-delegates-phone.png`, `pip-delegates-phone-dark.png` | 390 px wide, cropped below the chat's floating header | The same chat at phone width. |
| `genie-report.png`, `genie-report-dark.png` | 1100×720 | Genie's chat. Genie's greeting, the folded exchange with Pip, *Task finished · Wish: CSV export*, and Genie's report: the branch is back in Northwind with one commit, the tests pass, nothing was pushed or merged. |
| `genie-report-phone.png`, `genie-report-phone-dark.png` | 390 px wide, cropped like the other phone chat | The same report at phone width. |
| `wish-checks.png`, `wish-checks-dark.png` | 1100×692 (bottom status row cropped) | The wish thread **Wish: CSV export**. Its steps are listed, and the test step is open: the command, two passing tests, `pass 2`, `fail 0`, and the CSV that `npm run export` printed. |
| `wish-checks-phone.png`, `wish-checks-phone-dark.png` | 390×816 (bottom status row cropped) | The same test step at phone width. |
| `wish-diff.png`, `wish-diff-dark.png` | 1280×774 (bottom status row cropped) | The thread's **Report** and its *Edited 4 files* card (package.json, src/csv.js, src/export.js, test/csv.test.js), with the review pane showing the new `src/csv.js`. |

The wish-thread captures leave out the status row under the composer. Its throughput figure
comes from the scripted model's instant replies and says nothing about a real model.

## Left out, and why

- **Omni at work** (its channels, reminders or approvals). Turning Omni on in the welcome
  installs Omni's plugins and then looks for an Omni server to link. Its chats come from real
  WhatsApp, Telegram or Slack accounts. Neither works offline without a real channel or a
  running service, so Omni appears only as the welcome shows it here: asleep, with its power button off.
- **The desktop window frame.** The captures are the app's web interface in Chrome: the
  interface the desktop app shows inside its window, without the Electron title bar. The
  desktop app also loads Omni's plugins and the AI-subscription add-ons, which add controls
  of their own that these screens do not have.
- **The market's one-click install.** No verified link exists, so the page's button is off
  and marked TODO.

## RFC 0027 D3 additions, 2026-11-11

`code-sidebar.png` (722×668) is a byte-for-byte copy of the pack's own share image,
`herdr/mods/am-sidebar/preview.png`. Commit `6e116024aa760694bfc6af81111eb99c2fa1428a`
introduced it at `herdr/mods/spaces-agents/preview.png`; the folder later moved to
`am-sidebar`. That commit records a **herdr-app shot of a scratch demo project**, cropped to
its bot tree. It also records that the overlay scrollbar was painted out of the original
share image. D3 makes no further edits. RFC 0027 explicitly permits the pack's own captured
share image. The page identifies the crop and the original retouch, rather than presenting
it as a new full-window recording. It shows demo-shop, Main Bot Ada, build and quality
categories and a planned Bot. It does not show an active coding run or the Work/Code switch.
Its source and digest are recorded under `additionalCaptures` and `images` in the manifest.

No Omni channel, meter or Cloud screen is fabricated to illustrate the other blocks.

### The film slot

D2 has not supplied the committed encode or poster at D3's implementation. The single film
figure shows a crop of `team-step.png` (`assets/art/team-step.webp`, see below; the dark
theme gets the same crop of `team-step-dark.png`) as a small, clearly described still and
says **A short film is coming.** It is not a rendered film, play
control or new capture, and it is smaller than the page's other pictures. D2 replaces that one figure with
the approved poster/player and records the film's provenance and music licence. There is no
second film element and no off-site player.

### Brand

The draft's fonts, marks and existing app character art are copied selectively into
`brand/`, with the font licences and `brand/LICENSES.md`. No private draft document is
copied. The marks and octopus are brand accents. Every product image still comes from the
recorded capture manifest.

The earlier *market one-click install* note describes the old developer page. The new site
links to this repository's desktop release; the developer commands are in the landing README.

## App theme comparison, D3 revision

`app-stage-light-1440.png`, `app-stage-light-390.png`, `app-stage-dark-1440.png` and
`app-stage-dark-390.png` are new, unedited captures of the real Bot plugin on its declared
DSH runtime, using `capture/theme.mjs --run`. `manifest.json` records the release source,
the runtime, viewport and digest of each. Pip, Rowan and Sage are fictional Bots created
through the plugin's supported API in a fresh fixture. No model is connected; the app
shows its own connection prompt. There is no synthetic model reply, fabricated chat or
injected DOM/style. Light and dark are selected through the browser's system appearance,
and the runner asserts the app's `--bt-main` matches its Stage palette before each shot.
The image is the app's web interface, without the Electron title bar. Each desktop capture
is 1440×900 @2x, each phone-width capture 390×900 @2x.

The fixture relocates homes, config and caches, uses an explicit Node/pnpm path, installs
only the Bot plugin through DSH, fences Node sockets to loopback, and blocks browser
requests outside its own runtime. It never reads a live profile or calls an AI provider.
The capture used the matching installed Chromium headless shell on Linux. Raw fixture
logs remain outside the repository. Comparison images are browser-rendered evidence rows:
the site's viewport and the real app capture at the same CSS width and theme. They are
saved in the private report directory, never presented as product captures on the page.

`theme.css` is generated by `scripts/sync-theme.mjs` from the default Stage theme in
`apps/bots-dsh/src/client/stage.js`. This includes its cream/plum light and dark palettes,
stage gradient, paper/raised surfaces, typography, radii, focus ring and component shadows.
The desktop renderer's `shell.css` and `frame.js` use the same table and ink colours.

## Site redesign, 2026-11-11

### Pocket, in its own preview

`pocket-home-light.png`, `pocket-home-dark.png`, `pocket-chat-light.png`,
`pocket-chat-dark.png`, `pocket-code-light.png` and `pocket-code-dark.png` (1179×2556, a
393×852 dp phone at 3x) are the real Automagik Mobile app: its Home tab, the sample Bot chat
waiting on an approval, and its Code tab, recorded by `capture/pocket/PocketDemoShotsTest.kt`. The test launches the app's real
`MainActivity` under Robolectric 4.14.1 with native graphics, calls the app's own
`PocketViewModel.enterDemo()` (what **Explore the interface** on its welcome screen calls),
opens each screen as a tap would (the tab bar's Home and Code, and the sample Bot's chat),
and saves the window through Android's `PixelCopy`, light (`+notnight`) and dark (`+night`).
The data is the app's built-in sample (made-up machines, projects and Bots), and the app
itself labels every screen **Interface preview · sample data**. No machine, network or
account is reached. Robolectric draws no Android status bar; the page's phone frame is plain
CSS around the unchanged picture. Pets show the frame current at capture time.

To record them again, copy `apps/pocket` (and `apps/bots-dsh/src/host/pets/genie-clay`, which
the Genie pet bundling task reads, plus the root `package.json`) into a scratch folder with
`git archive`, put the test in its `app/src/test/java/ai/namastex/automagik/`, give it a
`local.properties` with the SDK path, and set `pocket.updateUrl` in its `gradle.properties` to a
closed loopback address so the updater sends nothing. Then, with `POCKET_SHOTS` naming an
output folder, run `./gradlew --no-daemon :app:testDebugUnitTest --tests
'ai.namastex.automagik.PocketDemoShotsTest'` there. The test never goes into `apps/pocket`.
Checkout, renderer and digests are under `pocketCapture` and `images` in the manifest.

### Derived art

The pages show WebP files from `assets/art/`, made by `scripts/build-art.mjs`. Each is one
rectangle of one source, scaled with Lanczos to 1x and 2x: Automagik's own art (Genie, the Omni octopus, the lamp, the Automagik pet's first frame, the app icon and the
Genie and Omni expression strips), and crops of the unchanged captures above. Nothing is
drawn, recoloured or retouched. Every capture crop has a dark twin, `name-dark`: the same
rectangle of the same view's dark capture, which the page shows to a visitor whose system
is dark. On phone-width screens the home and Desktop pages show the phone-width capture
instead of a shrunken window. `assets/art/manifest.json` records each file's source, the
source's SHA-256, the rectangle and the output's SHA-256; the page test checks all of them,
and that every capture-derived file's source digest matches this manifest.

## Re-capture, 2026-11-12

Every app screen was recorded again, with the same scripts and the same scenario, from
release 3.135.0 on runtime 0.2.2-rc.2, where the app shows the approved full-body Genie
(the `genie-clay` pet) and the approved logo. `capture.mjs` made
the welcome, chat and wish-thread pictures and `theme.mjs` the four `app-stage-*` ones; no
picture changed size, so the crops in `assets/art/` keep their rectangles. The manifest
holds the new checkout, pins and digests.

The six Pocket screens were recorded again from the same checkout, by the steps above. The
app's build bundles the same Genie sheet, which now shows in the sample Bot chat's header.
The two `pocket-code-*` pictures came out byte-for-byte as before. `code-sidebar.png` is the
pack's share image and did not change.
