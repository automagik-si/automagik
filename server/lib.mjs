// What the server image's entrypoint and its build share: the profile's name, the web port,
// the data-dir preflight, the token redaction every log line goes through, the private-key-file
// rule, and the pnpm store pinning that keeps a profile built under /build usable under /data.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { cp } from 'node:fs/promises'
import { markSeed } from './profile-state.mjs'

export const PROFILE = 'automagik-web'
export const PORT = 3081
export const GATE_VIEW = 'gate-view'
export const GATE_VIEW_MOUNT = '/dsh-view'
/** The DSH volume's mount point in the image; compose.gate.yml mounts its gate-view subpath. */
export const DSH_VOLUME = '/data'

/**
 * The folder DSH publishes the gate's view into: always the volume's own gate-view, the exact
 * subpath compose.gate.yml mounts, whatever AUTOMAGIK_HOME says. Only where no /data exists (a
 * test on a developer host) does it follow the home.
 */
export function gateViewDir(home, { volume = DSH_VOLUME, exists = existsSync } = {}) {
  return exists(volume) ? join(volume, GATE_VIEW) : join(resolve(home), GATE_VIEW)
}
/** The store pnpm uses for its major version, as the desktop app records it (`v10` for pnpm 10). */
export const STORE_LAYOUT = 'v10'

/** The proxy's advertised HTTPS root and the exact authority dsh must accept. */
export function publicUrlArgs(value) {
  if (value === undefined) return []
  const invalid = () => new Error('AUTOMAGIK_PUBLIC_URL must be an absolute https:// URL with a host and no credentials, query, fragment, whitespace or backslashes')
  if (!/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)) throw invalid()
  let url
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  const authority = value.slice(value.indexOf('://') + 3).split('/')[0]
  if (!authority || authority.includes('@') || !url.hostname || url.hostname.includes('*')) throw invalid()
  return ['--public-url', value, '--trusted-host', url.host]
}

// The errors that mean "this directory is not ours to write", so the entrypoint leaves it and
// the preflight refuses with the uid message. EBUSY is one: removing an empty workspace that is
// itself a mount point fails that way.
const UNWRITABLE = ['EACCES', 'EPERM', 'EROFS', 'EBUSY']
const unwritable = (error) => UNWRITABLE.includes(error?.code)

/**
 * Make each data directory and prove this process can write it. A mkdir on an existing
 * root-owned directory succeeds, so the probe write is the check that matters: an Incus volume
 * or bind mount created for another uid fails here, before dsh starts.
 */
export function ensureDataDirs(dirs, { uid = process.getuid?.() ?? 1000 } = {}) {
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.automagik-write-probe-${process.pid}`)
      try {
        writeFileSync(probe, '')
      } finally {
        rmSync(probe, { force: true })
      }
    } catch (error) {
      if (unwritable(error)) {
        throw new Error(
          `${dir} is not writable by uid ${uid}: create the /data volume with ` +
            `initial.uid=${uid} initial.gid=${uid}, or chown the volume to ${uid}:${uid} ` +
            'on the host; the image cannot chown',
        )
      }
      throw error
    }
  }
  return dirs
}

/**
 * Prepare the workspace before the data-dir preflight. An Incus instance pre-creates the
 * image WorkingDir on the mounted data volume as root, so /data/workspace can be a root-owned
 * 0755 directory uid 1000 cannot write. An empty one is removed without recursion (the
 * writable parent owns the entry) and recreated by this process, which lets ensureDataDirs
 * pass; a non-empty one is left for ensureDataDirs to refuse with its uid 1000 message. This
 * never chowns, never runs as root and never deletes recursively. Returns true if repaired.
 */
export function prepareWorkspace(dir, { uid = process.getuid?.() ?? 1000 } = {}) {
  if (!existsSync(dir)) return false
  try {
    accessSync(dir, constants.W_OK)
    return false
  } catch (error) {
    if (!unwritable(error)) throw error
  }
  let entries
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if (!unwritable(error)) throw error
    return false
  }
  if (entries.length > 0) return false
  try {
    rmdirSync(dir)
  } catch (error) {
    if (!unwritable(error)) throw error
    return false
  }
  ensureDataDirs([dir], { uid })
  return true
}

/** One log line with any `token=` credential replaced. Everything else is kept verbatim. */
export const redactTokens = (text) => String(text).replace(/(?<![A-Za-z0-9_])token=[^\s&"'<>]+/g, 'token=<redacted>')

/** The launch URL (with dsh's per-launch token) in a line of dsh's output, or null. */
export const launchUrlOf = (text) => /dsh web: (https?:\/\/\S*token=\S+)/.exec(String(text))?.[1] ?? null

/** A key file must be 0400 or 0600: owner-only and not executable. */
export const privateMode = (mode) => mode === 0o400 || mode === 0o600

/** The profiles dsh reads under `$DSH_HOME/profiles`. */
export const profileDirOf = (dshHome) => join(dshHome, 'profiles', PROFILE)

/**
 * Put the shipped profile in place under `$DSH_HOME/profiles/automagik-web`, first start only.
 * The copy lands beside its place and is renamed in whole, so an interrupted first start never
 * leaves a profile that looks installed. An existing profile is the user's and is never touched.
 */
export async function seedProfile({ dshHome, source, release = readVersion(source) }) {
  const target = profileDirOf(dshHome)
  if (existsSync(target)) return { target, seeded: false }
  mkdirSync(join(dshHome, 'profiles'), { recursive: true })
  const fresh = mkdtempSync(`${target}.installing-`)
  try {
    await cp(source, fresh, { recursive: true, verbatimSymlinks: true })
    markSeed(fresh, release)
    if (existsSync(target)) return { target, seeded: false }
    try { renameSync(fresh, target) }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && existsSync(target)) return { target, seeded: false }
      throw error
    }
    return { target, seeded: true }
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
}

function readVersion(source) {
  try {
    return JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function workspaceFileStat(workspace) {
  const stat = lstatSync(workspace, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) {
    throw Object.assign(new Error('Image profile pnpm-workspace.yaml must be a regular file'), { code: 'UNSUPPORTED_PROFILE_WORKSPACE' })
  }
  return stat
}

/**
 * pnpm refuses to touch a profile whose node_modules were linked from another store
 * (`ERR_PNPM_UNEXPECTED_STORE`). The image builds the profile under /build with the builder's
 * store; this names the runtime's store in the profile's pnpm-workspace.yaml, which wins over a
 * user's pnpm config, and records it where pnpm reads node_modules' origin. The counterpart of
 * the desktop's `pinProfileStore` (apps/desktop/src/dsh.js).
 */
export function pinStore(profileDir, dshHome) {
  const store = join(dshHome, 'pnpm-store')
  const workspace = join(profileDir, 'pnpm-workspace.yaml')
  const stat = workspaceFileStat(workspace)
  const text = stat ? readFileSync(workspace, 'utf8') : ''
  const line = `storeDir: ${JSON.stringify(store)}`
  const next = /^storeDir:.*$/m.test(text) ? text.replace(/^storeDir:.*$/m, line) : `${text.replace(/\s*$/, '')}${text.trim() ? '\n' : ''}${line}\n`
  if (next !== text) {
    if (stat?.nlink === 1) {
      // A single-file bind mount can be written in place.
      const fd = openSync(workspace, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
      try {
        writeFileSync(fd, next)
        fsyncSync(fd)
      } finally { closeSync(fd) }
    } else {
      const fresh = `${workspace}.${randomUUID()}.tmp`
      const fd = openSync(fresh, 'wx', stat ? stat.mode & 0o777 : 0o666)
      try {
        try {
          writeFileSync(fd, next)
          if (stat) fchmodSync(fd, stat.mode & 0o777)
          fsyncSync(fd)
        } finally { closeSync(fd) }
        renameSync(fresh, workspace)
      } finally { rmSync(fresh, { force: true }) }
    }
  }
  const modules = join(profileDir, 'node_modules', '.modules.yaml')
  if (existsSync(modules)) {
    const raw = readFileSync(modules, 'utf8')
    const recorded = join(store, STORE_LAYOUT)
    let fixed = raw
    try {
      const state = JSON.parse(raw)
      if (state.storeDir !== recorded) fixed = `${JSON.stringify({ ...state, storeDir: recorded }, null, 2)}\n`
    } catch {
      fixed = raw.replace(/^(\s*storeDir:\s*).*$/m, `$1${JSON.stringify(recorded)}`)
    }
    if (fixed !== raw) writeFileSync(modules, fixed)
  }
  // pnpm's cache of the build machine's paths; pnpm rebuilds it on its next install.
  rmSync(join(profileDir, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true })
  return store
}
