# The interactive backfill card — design mock

A static page wearing the Bot team's own sheets, so the K2 card of #1326 can be settled
before it ships. It is not shipped: no package entry imports it, and it has no network code.
Every chat, date and count is sample data; the page calls no Omni route.

```sh
node dev/mock/genui-backfill/build-css.mjs
open dev/mock/genui-backfill/index.html?mock=backfill
```

`?mock=backfill` is required, since the page is a design preview and not a route any product
serves. Add `&theme=dark` to start in the dark theme; the button switches either way.
`&state=proposal`, `&state=starting` or `&state=runs` opens one state directly.

## What it shows

The three states a person sees in the real card, driven by the tabs:

1. **Choose chats and dates.** The Bot's proposal: its range, the chats it may read (with
   their channel), pre-ticked only the chats it named, and the two date fields. **Start** is
   off until at least one chat and both dates are chosen; a range that starts after it ends
   says so and stays off. Nothing is sent while the person changes the ticks or the dates.
2. **The approval goes out.** Pressing Start shows **Sending your approval…**, then **Your
   approval was sent. One backfill is starting for each chat you chose.** One Start is one
   approval: the mock never sends one request per chat.
3. **Live runs, with a stop.** The run's range, its chats and how each one moves: waiting,
   fetching with its counts, then done, failed or stopped. A chat that is still running offers
   **Stop**; an ended chat does not. The tab's sample run starts with two running, one done
   and one failed so all three states are visible; the started run moves on its own and one
   chat fails and one finishes.

The card is drawn with the kit's own classes and tokens (`.bt-q`, `.bt-genui-*`) from this
checkout's `GENUI_CSS`; the frame around it is the mock's own.

## The sheets

`build-css.mjs` bundles this checkout's `styles.js` (`SHELL_CSS`), `genui.js` (`GENUI_CSS`) and
`themes.js`, and writes `mock.css` with the Automagik theme in its light and dark values. The
file is generated and ignored, because it is a snapshot of the checkout: the clay art atlases
are left out (about 900 KB of data URLs), so the mock draws no pet and no clay figure.

`mock.js` is the page's own state: no `fetch`, no XMLHttpRequest, no Omni URL. It exists to
settle the screen, not to be wired into the app.
