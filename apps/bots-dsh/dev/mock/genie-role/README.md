# Roles as products — the agents bazaar (design mock)

A static page wearing the Bot team's own sheets, so the shop and the Role picker can be
settled before any feature code lands. It is not shipped: no package entry imports it, and
there is no install logic.

```sh
node dev/mock/genie-role/build-css.mjs
open dev/mock/genie-role/index.html?mock=bazaar
```

`?mock=bazaar` is required, since the page is a design preview and not a route any product
serves (`?mock=roles` is accepted for the step-1 link). Add `&theme=dark` to start in the
dark theme; the button switches either way. `&view=writer`, `&role=voice-mouth`,
`&voice=installed` and `&detail=voice-mouth` open a state directly.

## What it shows

- **Shop** (the default). The Apps page's shape: Automagik's official rows first, a **Roles**
  section next, the upstream catalog below. The `Roles` section lists Genie (installed),
  Voice / Mouth (Install) and Standup Summaries (a community role, Install off with the P5
  reason). Official roles come first and community roles carry a Community tag. Clicking a
  role opens its package card: publisher, version, sha256, what it adds, the grants it asks
  for, and what it may not change.
- **Writer**. An ordinary Bot's settings. Its **Role** picker lists installed roles only, so
  Voice / Mouth appears there after Install. Attaching it adds the role tag beside Writer and
  in the team rail, the role's name to the role line, the **Voice / Mouth** card (voice,
  speed, the `audio-out` grant, "Try it"), and `speak` to the tools line. Attaching Genie
  still adds the wish rows. Detach removes them; Uninstall is off while the role is attached.
- **Clickable.** Tabs, category chips, Install, the role detail, the picker, detach,
  uninstall, the theme switch. The only persistence is the page's own state.

Everything is sample data. The page settles the screen, not the install API.

## The sheets

`build-css.mjs` bundles this checkout's `styles.js`, `sidebar.js`, `left-bar-css.js`,
`bot-settings.js`, `connectors-page.js` and `voice-settings.js` sheets, and writes `mock.css`
with the Automagik theme in its light and dark values. The file is generated and ignored,
because it is a snapshot of the checkout: the clay art atlases are left out (about 900 KB of
data URLs), so the mock draws no pet and no clay figure, and it uses small token-coloured
discs in the team list instead. Product surfaces use the team's `bt-*` classes and `--bt-*`
tokens only; the frame around them is the mock's own.
