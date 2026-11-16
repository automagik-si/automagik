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

/** herdr-core's supported release channel, pinned to the version and sha256 its manifest names. */
export const HERDR_CORE_VERSION = '0.1.18'
export const HERDR_CORE_SHA256 = '5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7'
export const HERDR_CORE_TARBALL = 'herdr-core-linux-x86_64.tar.gz'
export const HERDR_CORE_URL = `https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/${HERDR_CORE_TARBALL}`

/** The reviewed session-absorption skill, byte-pinned; its two files are the whole payload. */
export const SKILL_NAME = 'session-absorption'
export const SKILL_ROOT = '/opt/automagik/skills'
export const SKILL_SHA256 = Object.freeze({
  'SKILL.md': '6cc6df78cc23711a7b208f7ac599be3e1ec05be212ece4c2cb03679c9956b5b5',
  'references/packet.md': 'edd34e81fbb2a9f1f185a491290c838426c4b076245c450cdf3f509e7ccd6268',
})

/** The v2 registry seed #1424 ships; this is the interface the pending caller assumes. */
export const REGISTRY_SEED_RELATIVE = 'node_modules/@automagik/bots-dsh/src/shared/registry-seed.js'
/** The shipped ACP CLI store, read from the seeded profile; no part of it is baked into /opt. */
export const CLI_STORE_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/clis.js'
export const AGENTS_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/agents.js'
