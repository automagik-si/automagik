# automagik-pets

Bakes one of the Bot team's 33 characters, in one of its 19 inks, into a Codex v2 pet folder,
with no browser. DSH and Automagik Herdr both run it, from `~/.automagik/bin/automagik-pets`
(the install and the release tarball come in a later slice).

```sh
automagik-pets bake kitty-blue            # prints the folder
automagik-pets bake kitty-blue --json     # last stdout line: {"ok":true,"dir":"..."}
automagik-pets bake kitty-blue --home /path/to/bots
automagik-pets --version
```

The id is `<character>-<colour>`: a key of `CHARACTERS` (apps/bots-dsh/src/client/characters.js)
and a key of `INKS` (inks.js). It matches `[a-z0-9-]` and is the pet's id. With `--json`, the last
stdout line is `{"ok":true,"dir":"..."}` or `{"ok":false,"error":"..."}`. Diagnostics go to
stderr. A failure exits 1 and a wrong command line exits 2.

## Where it bakes

`<bots home>/pets/<character>-<colour>/`. The bots home is `--home`, else what the Bot team's
`teamHomeOf` resolves (apps/bots-dsh/src/host/folders.js): `$AUTOMAGIK_BOTS_HOME`, else
`$AUTOMAGIK_HOME/bots`, else `~/.automagik/bots`. That folder is the Bot team's `team` pet source
(host/pets.js), so DSH lists a baked pet without any change.

The bake writes into a dot-named sibling (`.<id>.<pid>.<random>.tmp`, which the pet list skips)
and renames it into place. A folder already there is moved aside first and removed afterwards,
so a reader sees the old pet or the new one, never a partial one. A failed bake keeps the old pet.

Bakes of the same look may run at the same time, because DSH and Herdr both bake on demand. A
bake whose rename meets another bake's (`ENOENT`, `ENOTEMPTY`) checks the folder in place. If that
folder is a complete pet, the bake succeeds and removes its own temporary folders. Otherwise it
tries the move again. If a moved-aside pet cannot be put back, the error names the `.old` folder
left behind. Each bake first sweeps the `.<id>.<pid>.<random>.tmp` and `.old` folders of earlier
bakes of that look, when their process is gone or they are over ten minutes old. A bake that was
killed midway therefore leaves nothing the next bake keeps.

## What a folder holds

| File | What |
| --- | --- |
| `pet.json` | Codex's fields (`id`, `displayName` such as "Kitty (blue)", `description`, `spriteVersionNumber: 2`, `spritesheetPath`), plus `look`, `cell`, `rows` and `bake` |
| `spritesheet.webp` | the v2 atlas: 11 rows of 192x208 cells, 8 to a row (1536x2288), lossless |
| `sleep.webp` | the DSH sleep strip: 6 cells (1152x208) |
| `frames/<row>-<n>.png` | every cell as its own 192x208 PNG, for players that cannot crop a sprite (Herdr's GPUI) |

`rows` names every group a player can show: the nine animation rows (`idle`, `running-right`,
`running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, `review`), `neutral` (the
front-facing cell after the idle loop), `look` (the 16 directions, rows 9 and 10) and `sleep`.
Each group gives `image`, `frames`, `ms` (ms per frame; `null` for still cells), `cells`
(`[row, column]` in its image) and `files`, so a reader never guesses a count or lists the folder.
Each frame PNG matches its atlas cell pixel for pixel.

## The art

The art comes from the Bot team's own modules, and nothing is copied. `characters.js`
(`bakeMarkup`) draws the body and faces. `inks.js` gives the inks. `pet-poses.js` gives the
cells, rows and poses that the browser bake (`pet-bake.js`) also draws. The browser fills inks
from CSS variables. This bake fills each ink with its light-theme value from `inks.js`, the value
DSH sets on `body`, and computes `color-mix(in srgb, …)` itself. `test/browser-parity.test.js`
bakes one look with `pet-bake.js` in Chromium and checks that the gradient stops and the cell's
pixels match. It needs `CHROME_BIN`, or playwright-core's own Chromium, and skips without either.

Omni's clay art (`OMNI_ATLAS`, clay-art.js) is not baked here.

## Develop

```sh
bun install
bun run test                          # node --test; bakes into temporary homes only
node scripts/bake-all.mjs /tmp/bots   # all 627 looks, with the time and one folder's size
```

sharp renders the SVG cells (librsvg) and encodes the WebP files (libvips). Its prebuilt binaries
cover darwin-arm64, darwin-x64, linux-x64 and linux-arm64.
