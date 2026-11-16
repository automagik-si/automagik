// What the server image carries beside the DSH profile, pinned where more than one build step
// or the in-image smoke must agree. The Dockerfile's ARG defaults and the paths it creates must
// match these values (test/toolchain.test.mjs).
//
// am is not pinned here: it comes from the content release's pinned tarball, whose sha256 is
// verified and recorded at build time (fetch-am.mjs). The vendor CLIs are never here either:
// they are installed into the data volume on first boot (first-boot.mjs).

/** The literal absolute path of the image's pnpm 10, and what AUTOMAGIK_PNPM points at. */
export const PNPM_PATH = '/usr/local/bin/pnpm'
/** The major the CLI store documents; the exact version comes from the runtime lock. */
export const PNPM_MAJOR = 10

/** The minimal init that keeps the app off PID 1; its ownership records need a real pid. */
export const TINI_VERSION = '0.19.0'
export const TINI_SHA256 = 'c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee'
export const TINI_URL = `https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static`
export const TINI_PATH = '/usr/local/bin/tini'

/** herdr-core's supported release channel, pinned to the version and sha256 its manifest names. */
export const HERDR_CORE_VERSION = '0.1.18'
export const HERDR_CORE_SHA256 = '5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7'
export const HERDR_CORE_TARBALL = 'herdr-core-linux-x86_64.tar.gz'
export const HERDR_CORE_URL = `https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/${HERDR_CORE_TARBALL}`

/** The Arca contract's app home and the core runtime, both on the data volume. */
export const HERDR_APP_HOME = '/data/herdr-app'
/** Container-local runtime and session; the in-image smoke overrides the session name. */
export const XDG_RUNTIME_DIR = '/data/run'
export const HC_RUNTIME = '/data/run/herdr-core'
export const HC_SESSION = 'automagik-server'
export const SMOKE_HC_SESSION = 'automagik-server-smoke'
/** herdr-core names its socket after HC_SESSION: one source of truth for wait and announce. */
export const herdrCoreSocket = (session = HC_SESSION, runtime = HC_RUNTIME) => `${runtime}/${session}.sock`
export const HERDR_CORE_SOCKET = herdrCoreSocket()

/** The reviewed session-absorption skill, byte-pinned; its two files are the whole payload. */
export const SKILL_NAME = 'session-absorption'
export const SKILL_ROOT = '/opt/automagik/skills'
export const SKILL_SHA256 = Object.freeze({
  'SKILL.md': '6cc6df78cc23711a7b208f7ac599be3e1ec05be212ece4c2cb03679c9956b5b5',
  'references/packet.md': 'edd34e81fbb2a9f1f185a491290c838426c4b076245c450cdf3f509e7ccd6268',
})

/** The #1424 seed, vendored at the published commit until that PR merges. */
export const REGISTRY_SEED_COMMIT = '92fe5ef7486556cad42e6b5e789aef5d07c08f49'
export const REGISTRY_SEED_VENDOR = '/opt/automagik/registry-seed'
export const REGISTRY_SEED_INSTALLED = 'node_modules/@automagik/bots-dsh/scripts/seed-registry.mjs'
export const REGISTRY_SEED_SHA256 = Object.freeze({
  'scripts/seed-registry.mjs': '6845d0ece5983561f7394ab69b0e254f5f7e3cf8841c55404a36776403ddb3e6',
  'src/host/registry-seed.js': '08ad60001dd721d63ab1ff31ce620420920504e740e666190c851714ac0343fc',
  'src/shared/registry.js': 'b20e91fa9d5d44c6799ab6ab116e90969286803cb156feb58b0890adf18785e6',
})
/** The shipped ACP CLI store, read from the seeded profile; no part of it is baked into /opt. */
export const CLI_STORE_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/clis.js'
export const AGENTS_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/agents.js'
