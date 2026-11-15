# Vendored from DeepSeek-Bot

- Upstream: https://github.com/Fei2411/DS-Bot (`ds-bot/` directory; it was DeepSeek-Bot)
- Upstream commit: 4a7b55069ad300eae8be42a74f31bc170b40ead7 (main on 2026-10-27: release 0.2.3), merged over
  1bebe826f74e9a72cabafd3b80602b05af867b38 (0.2.1, merged 2026-10-23), itself over
  e13bc3419d2695a509520d850a07e63f05c34e07, the commit first vendored (0.1.7)
- License: Apache-2.0 (see `LICENSE`; upstream `NOTICE` kept alongside)
- Modified: this directory is the Omni UI for DeepSeek Harness, rebranded and reshaped from DS Bot.
  Upstream names, logos and palette are replaced.

## How upstream comes in

The directory was copied, not linked, so a merge is built: a commit with upstream's `ds-bot/` at the
vendored commit placed at `apps/bots-dsh` (the merge base), a commit on it with upstream's current
`ds-bot/` there, and a real merge of that commit into Omni. Upstream's changes then merge as git
merges them, and every conflict is resolved by hand in the merge commit.

## Merged from upstream on 2026-10-28 (0.2.2 and 0.2.3)

Built as before: a101558 puts upstream's `ds-bot/` at 4a7b550 at `apps/bots-dsh` over a08fb11, whose
`apps/bots-dsh` is 1bebe826f's `ds-bot/` tree for tree.

Taken: Side chat (asides with follow-ups in the side panel; `/btw` stays a way in), the Bot browser plugins
(refs, script, task) with their approvals, site grants, holds, handoff card and screenshot repair, the avatar
library's store, memory saves that recover and failures that show, parts archived after their schedules move,
earlier parts readable without their agent, role and instruction change notices, the DSH default thinking level
for a new Bot, `list_bot_models`, `request_id` on `message_bot`, whole handoff results across restarts, replies
settled from the Session log after a reload, the group fixes (missed lines after a failed delivery, corrections
steered to busy members, the admin-passed notice, replies kept through compaction), "Not read yet" on steered
messages, the reinstall over an already-installed bundle, and the fold, composer, typography, focus and
scrollbar fixes.

Changed here: the browser is on by default, driven through `playwright-core` and the Chrome-family browser
already installed (`browser-default.js`), with its holds in the team view for windows without the panel; the
panel and `read_browser` are on only where a window has the bridge (dsh Desktop). The avatar library is the
"Yours" section of the character select, not upstream's tabbed editor.

Kept as ours: the restart pass in `resume.js` and its contract for other plugins (upstream's reconcile runs
inside it; a turn DSH closes as interrupted while reopening is still resumed), the account menu and the
channels footer seat (upstream removed its Connect button there), and the About row of the Automagik app
(upstream's own app bridge, `dsBotApp` updates, is not taken).

## The in-app Bot browser (2026-10-28)

Ported, not merged: upstream app's Bot views and CDP relay (`app/src/bot-views.mjs`, `app/src/bot-browser.mjs`
at 4a7b550) became the Automagik app's `apps/desktop/src/bot-views.js` and `bot-relay.js` (see the root
`NOTICE`). Of upstream's app bridge, only `dsBotApp.browser` (`views`, `forget`) is taken; its updates, data
location and cookie imports still are not.

Changed here: `browser.js` turns the panel on for the Automagik app (`AUTOMAGIK_APP_BROWSER`, constants.js)
without `read_browser`, and `browser-plugins.js` connects there through the app's relay as it does in
upstream's app (`DS_BOT_APP`). `session.js` and `mount.js` keep each Bot's tabs in its
`browser-profiles/<botId>` (`browser/tabs.js`, ours), bring them back when the browser opens with none, and
open a browser again after it went away (a killed Chrome, a dropped relay, a crashed page). In the app,
`bot-browsers.js` lists those tabs (`browserTabs` in the team view, channel.js) instead of saving tabs to or
restoring them from its own store, and `settings.js` calls `dsBotApp`'s data location and team workspace
only where the app offers them.

## Merged from upstream on 2026-10-23

Taken: side questions (`/btw`), group memory, the message layout settings (bubble width, flat
layout, thinking hidden by default), the running Bot's preview in the sidebar, the relay limit that
pauses a group instead of dropping calls, the editable purpose of a saved key, one right panel at a
time, phone and touch layouts, `show_view` views (charts, calculators, sandboxed views), the
`providers`, `thinking` and `feed` host modules, and the fixes for unreadable memory and secrets
files, inherited names such as `__proto__`, a stale `state.lock`, a Bot's photo path, and input
kept through a handoff.

Kept as Omni's: the package (`@automagik/bots-dsh`, Automagik's version, Bun, the DSH pin), its home,
route and plugin ids (`/api/omni-ui`, `omni-ui`; its home is now `$AUTOMAGIK_HOME/bots`), the brand (OmniMark, the
octopus, the palette, every "Omni" in the copy and in the Bots' prompts), the extension registry
other Omni plugins use (`extend.js`: tool cards, row badges, header buttons, endpoints), canvases,
the Tasks agent, "New conversation", Connect AI in the model menu, and the channels footer seat.
The desktop app counts as "the app" for updates and the Bot browser through `OMNI_CLIENT_ID`.

## Merged from upstream v0.3.6

This merge incorporates upstream commit `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`.
Automagik names, routes, storage prefixes, service defaults and the `omni-ui:` namespace remain
as documented above; generated client and Office bundles are rebuilt by the lead after assembly.
