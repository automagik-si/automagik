# The "From another tool" screenshot set

`capture.mjs` draws the step's every state from the same pure view the step uses
(`src/client/migrate.js`), with fixed fixtures and no Hermes, DSH or React: esbuild bundles the
view, a small recorder turns the elements into static HTML, and Chromium photographs it with the
real clay styles and the brand's Fredoka and DM Sans.

```sh
bun install                                  # at the repository root, for playwright-core
node apps/welcome-dsh/dev/screenshots/capture.mjs [--out DIR]
```

`playwright-core` uses its own Chromium by default; set `SHOT_CHROME` to a Chrome or Chromium
binary to use that one. The PNGs go to `--out` (default `.tools/welcome-migrate-shots` at the
repository root), never into the plugin's shipped files. The fixtures are neutral: no person's
bot, host or account appears in a picture.
