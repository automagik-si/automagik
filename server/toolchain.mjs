// Shared paths and pins for the server image's toolchain.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** The literal absolute path of the image's pnpm 10, and what AUTOMAGIK_PNPM points at. */
export const PNPM_PATH = '/usr/local/bin/pnpm'
/** The major the CLI store documents; the exact version comes from the runtime lock. */
export const PNPM_MAJOR = 10

/** The minimal init that keeps the app off PID 1; its ownership records need a real pid. */
export const TINI_VERSION = '0.19.0'
export const TINI_SHA256 = 'c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee'
export const TINI_LICENSE_SHA256 =
  'e5f46bca81266bdd511cf08018d66866870531794569c04f9b45f50dd23c28b0'
export const TINI_URL = `https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static`
export const TINI_PATH = '/usr/local/bin/tini'

/** herdr-core's supported release channel, pinned to the version and sha256 its manifest names. */
export const HERDR_CORE_VERSION = '0.1.18'
export const HERDR_CORE_SHA256 = '5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7'
export const HERDR_CORE_TARBALL = 'herdr-core-linux-x86_64.tar.gz'
export const HERDR_CORE_URL = `https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/${HERDR_CORE_TARBALL}`

/** The persistent app home and the container-private core runtime. */
export const HERDR_APP_HOME = '/data/herdr-app'
/** Container-local runtime and session; the in-image smoke overrides the session name. */
export const XDG_RUNTIME_DIR = '/run/automagik'
export const HC_RUNTIME = '/run/automagik/herdr-core'
export const HC_SESSION = 'automagik-server'
export const SMOKE_HC_SESSION = 'automagik-server-smoke'
/** herdr-core names its socket after HC_SESSION: one source of truth for wait and announce. */
export function herdrCoreSocket(session = HC_SESSION, runtimeDir = XDG_RUNTIME_DIR) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(session)) {
    throw new Error('HC_SESSION must contain 1 to 64 letters, digits, dots, underscores or dashes')
  }
  return join(runtimeDir, 'herdr-core', `${session}.sock`)
}
export const HERDR_CORE_SOCKET = herdrCoreSocket()

/** The shipped ACP CLI store, read from the seeded profile; no part of it is baked into /opt. */
export const CLI_STORE_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/clis.js'
export const AGENTS_RELATIVE = 'node_modules/@automagik/acp-dsh/src/host/agents.js'

const CHILD_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'TZ', 'TMPDIR',
  'HC_RUNTIME', 'HC_SESSION', 'HC_SOCKET', 'HC_TERMINAL_SOCKET',
  'XDG_RUNTIME_DIR', 'HERDR_APP_HOME',
  'AUTOMAGIK_HOME', 'AUTOMAGIK_BOTS_HOME', 'AUTOMAGIK_WORKSPACE', 'DSH_HOME',
  // native-worker-login.mjs's two exports, spelled out: build.mjs imports this file, and a
  // checkout build copies it alone (toolchain.test.mjs keeps the names equal).
  'AUTOMAGIK_BOT_CLI_POINTER', 'AUTOMAGIK_NATIVE_WORKER_LOGIN',
])

/** The core and am installer only need paths, locale and worker login settings. */
export function toolchainChildEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)
    && (CHILD_ENV.has(name) || name.startsWith('LC_') || name.startsWith('AUTOMAGIK_PNPM'))))
}

/** The shared volume the gate mounts read-only; the core runtime must never be on it. */
export const SHARED_VOLUME = '/data'

/**
 * Whether `dir` is on the shared volume, by its spelling and by its physical path: a symlink
 * that resolves into the volume would let the gate reach the core socket (a read-only mount
 * still allows connect()). A part not created yet is resolved from its nearest existing ancestor.
 */
export function onSharedVolume(dir, volume = SHARED_VOLUME) {
  // The physical path of the nearest existing ancestor, plus the part not created yet.
  const real = (path) => {
    let head = resolve(path)
    const rest = []
    for (;;) {
      try { return join(realpathSync(head), ...rest) } catch { /* not there yet */ }
      const up = dirname(head)
      if (up === head) return resolve(path)
      rest.unshift(basename(head))
      head = up
    }
  }
  const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  const roots = [...new Set([resolve(volume), real(volume)])]
  const paths = [...new Set([resolve(dir), real(dir)])]
  return paths.some((path) => roots.some((root) => inside(path, root)))
}
