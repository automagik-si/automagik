// What the server image's entrypoint and its build share: the profile's name, the web port,
// the data-dir preflight, the token redaction every log line goes through, the private-key-file
// rule, and the pnpm store pinning that keeps a profile built under /build usable under /data.
import {
  accessSync,
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { cp } from 'node:fs/promises'
import { markSeed, readJson, releaseVersion, SEED_MARKER } from './profile-state.mjs'

export const PROFILE = 'automagik-web'
export const PORT = 3081
export const GATE_VIEW = 'gate-view'
export const GATE_VIEW_MOUNT = '/dsh-view'
/** The DSH volume's mount point in the image; compose.gate.yml mounts its gate-view subpath. */
export const DSH_VOLUME = '/data'
export const DEFAULT_MODEL_KEY_FILE = '/data/secrets/deepseek-api-key'
export const RUN_SECRETS_DIR = '/run/secrets'
export const RUN_SECRETS_MODEL_KEY_FILE = `${RUN_SECRETS_DIR}/deepseek_api_key`
export const MEASUREMENT_DIR = '.automagik-measurement'
export const MEASUREMENT_MARKER = `${MEASUREMENT_DIR}/.automagik-server-profile`

export const omniRoot = (env = process.env) => resolve(env.OMNI_HOME || join(homedir(), '.omni'))

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
const fdPath = fd => `/proc/self/fd/${fd}`
// Linux's O_PATH pins a directory without needing read permission on ancestors.
const O_PATH = 0o10000000
const DIRECTORY = constants.O_DIRECTORY | constants.O_NOFOLLOW

/** Create or tighten DSH's own home before any write probe or profile work. */
export function prepareDshHome(dir, { uid = process.geteuid?.() ?? 1000, prepareStore = false } = {}) {
  const invalid = () => new Error(`${JSON.stringify(dir)} must be a real DSH home directory with no symbolic links in its path`)
  const foreign = () => new Error(`${JSON.stringify(dir)} is not owned by DSH uid ${uid}. Chown the DSH home to ${uid} on the host.`)
  if (dir === sep || resolve(dir) !== dir) throw invalid()
  const parts = dir.slice(1).split(sep)
  let fd = openSync(sep, O_PATH | DIRECTORY)
  try {
    for (const [index, part] of parts.entries()) {
      const child = join(fdPath(fd), part)
      let next
      try { next = openSync(child, O_PATH | DIRECTORY) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        try { mkdirSync(child, { mode: index === parts.length - 1 ? 0o700 : 0o777 }) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
        next = openSync(child, O_PATH | DIRECTORY)
      }
      closeSync(fd)
      fd = next
    }
    const info = fstatSync(fd)
    if (info.uid !== uid) throw foreign()
    if (readlinkSync(fdPath(fd)) !== dir) throw invalid()
    // fchmod cannot use an O_PATH descriptor. The procfs link addresses that pinned inode.
    if ((info.mode & 0o7777) !== 0o700) chmodSync(fdPath(fd), 0o700)
    if ((fstatSync(fd).mode & 0o7777) !== 0o700) throw new Error(`${JSON.stringify(dir)} must have mode 0700`)
    if (prepareStore) {
      const pinned = fdPath(fd)
      const verifyPath = () => {
        const current = statSync(dir, { throwIfNoEntry: false })
        if (readlinkSync(pinned) !== dir || current?.dev !== info.dev || current?.ino !== info.ino) throw invalid()
      }
      verifyPath()
      checkWritable(dir, uid, () => probeWrite(pinned))
      const store = join(pinned, 'pnpm-store')
      checkWritable(join(dir, 'pnpm-store'), uid, () => {
        mkdirSync(store, { recursive: true })
        probeWrite(store)
      })
      verifyPath()
    }
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw invalid()
    throw error
  } finally { closeSync(fd) }
}

/** Publish just the freshness fields of the private seed record on the measurement volume. */
export function writeMeasurementMarker(volume, profile) {
  const dir = join(volume, MEASUREMENT_DIR)
  let created = false
  try { mkdirSync(dir, { mode: 0o755 }); created = true }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const folder = openSync(dir, O_PATH | DIRECTORY)
  try {
    const info = fstatSync(folder)
    if (info.uid !== (process.geteuid?.() ?? 1000) || (info.mode & 0o022) !== 0) {
      throw new Error('the measurement directory must be owned by DSH and writable only by its owner')
    }
    // Preserve an operator's access and default ACLs on later publications.
    if (created) chmodSync(fdPath(folder), 0o755)
    publishMeasurementMarker(join(fdPath(folder), basename(MEASUREMENT_MARKER)), profile)
  } finally { closeSync(folder) }
}

function publishMeasurementMarker(target, profile) {
  const seed = readJson(join(profile, SEED_MARKER))
  if (seed?.version !== 1 || !releaseVersion(seed.release) || typeof seed.packageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(seed.packageSha256)) {
    rmSync(target, { force: true })
    return
  }
  const { version, release, packageSha256 } = seed
  const fresh = `${target}.${randomUUID()}.tmp`
  const fd = openSync(fresh, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ version, release, packageSha256 })}\n`)
      fchmodSync(fd, 0o644)
    } finally { closeSync(fd) }
    renameSync(fresh, target)
  } finally { rmSync(fresh, { force: true }) }
}

function probeWrite(dir) {
  const probe = join(dir, `.automagik-write-probe-${randomUUID()}`)
  const fd = openSync(probe, 'wx', 0o600)
  try { closeSync(fd) }
  finally { rmSync(probe) }
}

function checkWritable(dir, uid, check) {
  try { check() }
  catch (error) {
    if (!unwritable(error)) throw error
    throw new Error(
      `${dir} is not writable by uid ${uid}: create the /data volume with ` +
        `initial.uid=${uid} initial.gid=${uid}, or chown the volume to ${uid}:${uid} ` +
        'on the host; the image cannot chown',
    )
  }
}

/**
 * Make each data directory and prove this process can write it. A mkdir on an existing
 * root-owned directory succeeds, so the probe write is the check that matters: an Incus volume
 * or bind mount created for another uid fails here, before dsh starts.
 */
export function ensureDataDirs(dirs, { uid = process.getuid?.() ?? 1000 } = {}) {
  for (const dir of dirs) {
    checkWritable(dir, uid, () => {
      mkdirSync(dir, { recursive: true })
      probeWrite(dir)
    })
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

const SECRET_FIELD = String.raw`(?:api[_-]?key|authorization|x-api-key|x-auth-token|x-amz-security-token|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token|_authToken|_auth|_password)`
const SECRET_PREFIX = String.raw`(?:[a-z0-9]+[-_.])*`
export const SECRET_NAME = `${SECRET_PREFIX}${SECRET_FIELD}`
const QUOTED_SECRET = new RegExp(
  String.raw`((?<![\w.\-])["']?${SECRET_NAME}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`, 'gi',
)
const SIMPLE_SECRET = new RegExp(
  String.raw`((?<![\w.\-])(?:token|${SECRET_PREFIX}(?:api[_-]?key|authorization|password|secret|npm_token|auth_token|_authToken|_auth|_password))\s*[=:]\s*)[^\s&"'<>]+`, 'gi',
)
const UNQUOTED_SECRET = new RegExp(
  String.raw`((?<![\w.\-])${SECRET_NAME}\s*[:=]\s*)[^\s&"'<>]{6,}`, 'gi',
)
const CREDENTIAL_SHAPES = [
  /\bsk-[A-Za-z0-9_*.-]{6,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{12,}/g,
  /\bhf_[A-Za-z0-9]{16,}/g,
  /\bgl(?:pat|oas|rt)-[A-Za-z0-9_-]{12,}/g,
  /\bgsk_[A-Za-z0-9_-]{16,}/g,
  /\br8_[A-Za-z0-9]{16,}/g,
  /\bdop_v1_[a-f0-9]{24,}/gi,
  /\bshp(?:at|ca|pa|ss)_[a-f0-9]{24,}/gi,
  /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g,
  /\bya29\.[A-Za-z0-9_-]{16,}/g,
  /\bnfp_[A-Za-z0-9]{16,}/g,
  /\bvercel_[A-Za-z0-9_]{16,}/g,
  /\bsbp_[a-f0-9]{24,}/gi,
  /\bATBB[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{8,}/g,
]

/** Mask credentials in DSH and Omni diagnostics, including installer and proxy output. */
export function redactTokens(text) {
  let safe = String(text)
    .replace(/(\bhttps?:\/\/)[^/\s"'<>]+@/gi, '$1<redacted>@')
    .replace(/([?&#](?:token|access[_-]?token|api[_-]?key|key|secret|password|passwd|auth|authorization|client[_-]?secret|x-api-key|signature|sig|code|ticket)=)[^&#\s"'<>]+/gi, '$1<redacted>')
    .replace(QUOTED_SECRET, (match, key) => `${key}${match[key.length]}<redacted>${match.at(-1)}`)
    .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=*-]+/gi, '$1 <redacted>')
    .replace(SIMPLE_SECRET, '$1<redacted>')
    .replace(UNQUOTED_SECRET, '$1<redacted>')
  for (const pattern of CREDENTIAL_SHAPES) safe = safe.replace(pattern, '<redacted>')
  return safe
}

const SAFE_LINE_MAX = 4096
export const safeDshLine = (line) => {
  const redacted = redactTokens(line)
  return redacted.length > SAFE_LINE_MAX ? `${redacted.slice(0, SAFE_LINE_MAX)}…` : redacted
}

export function pipeRedacted(stream, into, onLine, onRawLine, maxPending = Infinity) {
  let pending = ''
  let overlong = false
  stream.setEncoding('utf8')
  const emit = (line) => {
    const complete = !overlong && Buffer.byteLength(line) <= maxPending
    const safe = complete ? safeDshLine(line) : '[overlong line omitted]'
    overlong = false
    onLine?.(safe)
    if (complete) onRawLine?.(line)
    into.write(`${safe}\n`)
  }
  stream.on('data', (chunk) => {
    pending += chunk
    let end = pending.indexOf('\n')
    while (end !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      emit(line)
      end = pending.indexOf('\n')
    }
    if (Buffer.byteLength(pending) > maxPending) {
      pending = ''
      overlong = true
    }
  })
  stream.on('end', () => {
    if (pending || overlong) emit(pending)
  })
}

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
