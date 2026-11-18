# Agent rules

Short rules for coding agents working on Pocket, the phone app, in the Automagik monorepo. Humans:
the same rules apply. The monorepo's own contract is [AGENTS.md](../../AGENTS.md) at its root.

## Layout

- `android/`: the app (Gradle). Run Gradle from there: `cd apps/pocket/android && ./gradlew …`.
- `docs/`: Pocket's notes, decisions and RFCs (an Obsidian vault).
- Pocket Link, the Herdr desktop mod, is [herdr/mods/pocket-link](../../herdr/mods/pocket-link/README.md),
  beside the pack's mods but Pocket's: the pack never installs, updates or removes it.
- The usage meter lives in its own repository,
  [automagik-si/usagemeter](https://github.com/automagik-si/usagemeter); the Automagik Herdr pack
  installs it. Pocket Link doesn't ([decision](docs/decisions/pocket-link-no-meter-installer.md)).
- The version is the monorepo's one version (the root `package.json`, `bun scripts/version.ts`);
  the app's versionCode comes from it. CI is the root's `.github/workflows/` (`ci.yml`, `release.yml`).

## Working

1. Work in your own git worktree and branch. Don't switch branches, stash or reset in a shared
   checkout.
2. Open pull requests into `dev`. Never push to `dev` or `main` directly.
3. Commit subjects are conventional, `type(scope): description`; CI rejects others. `feat`, `fix`,
   `refactor` and similar cut a release on merge; `docs`, `ci` and `test` don't
   ([releasing](docs/guides/releasing.md)).
4. Before a pull request: `cd apps/pocket/android && ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug`
   (the toolchain line in the root [AGENTS.md](../../AGENTS.md)).
5. Never commit or print the signing key or its password. Never change the app ID, the signing key,
   the `latest.json` format or where phones read it (the `pocket-lane` release) without an RFC
   (the monorepo's [RFC 0011](../../docs/rfcs/0011-monorepo-parts-and-releases.md), "Pocket").
6. Brand: any work on a logo, a colour, type, a UI surface or brand art starts from
   [docs/brand/README.md](../../docs/brand/README.md) and uses its files and tokens. Never redraw a
   mark or invent a colour.

## Docs

- Start at [docs/_index.md](docs/_index.md). Keep it an Obsidian vault: frontmatter on every note,
  relative links.
- A contract, privacy or permission change needs an RFC first
  ([RFC 0000](docs/rfcs/0000-rfc-process.md)). One choice with one reason: a decision note.
- Cite code as `path:line`. Never invent a decision or a reason; put unknowns under Open
  questions.
- A change to what the app collects, sends or asks permission for updates
  [docs/privacy.md](docs/privacy.md) in the same pull request.
- Write action first, short, skimmable. No hostnames, IPs, personal data or private repo links.
