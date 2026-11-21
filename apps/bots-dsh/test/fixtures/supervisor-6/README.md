# Frozen delivery 6 supervisor and About client

The installed supervisor copy uses the `supervisor/files.json` closure from
`apps/bots-dsh/src/host` at Automagik commit
`669ebb78a2a8ffdbcf6cbe9020c2d9a1d894e88d`, the merged delivery 6.
The fixed `supervisor/launcher.sh` is the byte-for-byte source used at
installation. It is stored alongside the closure and is not part of it.
These files were extracted with `git archive`. Tests supply the installed
copy's `package.json` and `version.json`.

`self-update-client.cjs.gz` contains the About client and its local imports
from the same commit. It was bundled with esbuild 0.28.2 in CommonJS format
for Node, using `minifyWhitespace` and exporting `AboutPage`, `SelfUpdateRow`
and `teamActions`. React, React DOM and DSH client UI primitives are external,
as in the browser test harness. The bundle uses gzip with a zero timestamp.

The compatibility tests verify the SHA-256 digests in `sha256.json` when they
read the fixtures. The tests also run in shallow checkouts.
