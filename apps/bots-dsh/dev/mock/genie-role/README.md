# Genie as a role — step 1 design mock

A static page wearing the Bot team's own sheets, so the screen a role changes can be settled
before any feature code lands. It is not shipped: no package entry imports it.

```sh
node dev/mock/genie-role/build-css.mjs
open dev/mock/genie-role/index.html?mock=roles
```

`?mock=roles` is required, since the page is a design preview and not a route any product
serves. Add `&theme=dark` to start in the dark theme; the button switches either way.

## What it shows

- **Writer**, an ordinary Bot, in its settings. A **Role** picker (None / Genie) sits under the
  Bot's existing role line, which the mock labels **Role line** so the two words do not collide.
- Attaching the Genie role adds a tag beside the Bot's name and the role's name to the line
  under it (the Bot's own role line is kept), one line naming what the role adds, and the
  **wish rows under Writer's row** in the team list: the same rows genie-dsh draws under a
  Genie today, through `botChildren`, the team's own outlet.
- The second card, **Common to every Bot**, shows what the role does not touch: model,
  permissions, capabilities (MCP servers and skills), and the team's tools.

Everything is sample data. The page exists to settle the screen, not to be wired into the app.

## The sheets

`build-css.mjs` bundles this checkout's `styles.js`, `sidebar.js`, `left-bar-css.js` and
`themes.js`, and writes `mock.css` with the Automagik theme in its light and dark values. The
file is generated and ignored, because it is a snapshot of the checkout: the clay art atlases
are left out (about 900 KB of data URLs), so the mock draws no pet and no clay figure, and it
uses small token-coloured discs in the team list instead.
