import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { ADAPTER, LEGACY_PLUGINS, PLUGINS, compareRelease, readJson, releaseVersion } from './profile-state.mjs'

export const LAUNCH_FILE = 'launch-url'
const PROFILE_STATE_FILE = 'profile-state.json'
const VIEW_FILES = new Set([LAUNCH_FILE, PROFILE_STATE_FILE])
const TEMP_FILE = new RegExp(
  String.raw`^(launch-url|profile-state\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-` +
  String.raw`4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$`,
)
const MAX_AGE = 5 * 60_000
const MAX_CLOCK_SKEW = 60_000
const STATE_KEYS = ['schemaVersion', 'at', 'plugins', 'followsImage', 'ownerManaged', 'reason']
const REASONS = new Set([
  'invalid-profile', 'unsupported-seed-marker', 'owner-managed', 'invalid-image-metadata',
  'matching-image', 'update-rolled-back', 'missing-plugins', 'newer-than-image',
  'update-required', 'invalid-profile-state', 'signed-update-ahead', 'self-update-unfinished',
])

// Resolve existing symlinks even when the private directory is yet to be created.
export function realLocation(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || lstatSync(path, { throwIfNoEntry: false })) throw error
    return join(realLocation(dirname(path)), basename(path))
  }
}

function contains(parent, path) {
  const child = relative(parent, path)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

export function prepareGateView(view, volumeRoot, privateDirs, { uid = process.getuid?.() ?? 1000, checkOnly = false } = {}) {
  const current = lstatSync(view, { throwIfNoEntry: false })
  // Owned by the uid DSH runs as (1000 in the image), never another account's folder.
  if (current && (!current.isDirectory() || current.uid !== uid)) {
    throw new Error(`gate-view must be a real directory owned by uid ${uid}`)
  }

  const location = realLocation(view)
  // A custom home that does not exist yet resolves like any other missing path.
  const volume = realLocation(volumeRoot)
  for (const [name, dir] of Object.entries(privateDirs)) {
    const home = realLocation(dir)
    if (contains(location, home) || ((name === 'DSH_HOME' || home !== volume) && contains(home, location))) {
      throw new Error(`gate-view overlaps ${name}`)
    }
  }
  if (checkOnly) return
  if (!current) mkdirSync(view, { recursive: true, mode: 0o700 })
  const info = lstatSync(view)
  if (!info.isDirectory() || info.uid !== uid || realpathSync.native(view) !== location) {
    throw new Error(`gate-view must be a real directory owned by uid ${uid}`)
  }
  if ((info.mode & 0o7777) !== 0o700) chmodSync(view, 0o700)

  for (const name of readdirSync(view)) {
    const temp = TEMP_FILE.test(name)
    if (!temp && !VIEW_FILES.has(name)) {
      throw new Error(`unexpected entry in gate-view: ${JSON.stringify(name)}`)
    }
    const file = join(view, name)
    if (!lstatSync(file).isFile()) {
      throw new Error(`gate-view entry must be a regular file: ${JSON.stringify(name)}`)
    }
    if (temp) unlinkSync(file)
  }
}

export function writePrivateFile(target, bytes) {
  const fresh = `${target}.${randomUUID()}.tmp`
  const fd = openSync(fresh, 'wx', 0o600)
  try {
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    renameSync(fresh, target)
  } finally {
    rmSync(fresh, { force: true })
  }
}

export function writeProfileState(view, { plugins, followsImage, ownerManaged, reason }) {
  const versions = Object.fromEntries(PLUGINS.map(name => [name, plugins?.[name] ?? null]))
  const state = {
    schemaVersion: 1, at: new Date().toISOString(), plugins: versions,
    followsImage, ownerManaged, reason,
  }
  writePrivateFile(join(view, PROFILE_STATE_FILE), `${JSON.stringify(state)}\n`)
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isTimestamp(value) {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function isProfileState(state, build) {
  if (!hasKeys(state, STATE_KEYS) || state.schemaVersion !== 1 || !isTimestamp(state.at) ||
      !hasKeys(state.plugins, PLUGINS) || typeof state.followsImage !== 'boolean' ||
      typeof state.ownerManaged !== 'boolean' || !REASONS.has(state.reason)) return false
  const versions = PLUGINS.map(name => state.plugins[name])
  if (state.followsImage) {
    // profileState: followsImage only when the profile is image-managed and every plugin is the
    // image's own version.
    return !state.ownerManaged && state.reason === 'matching-image' &&
      PLUGINS.every(name => releaseVersion(state.plugins[name]) && state.plugins[name] === build?.plugins?.[name])
  }
  // profileState: ownerManaged only with reason owner-managed.
  if (state.ownerManaged && state.reason !== 'owner-managed') return false
  if (!versions.every(version => version === null || releaseVersion(version))) return false
  if (state.reason === 'signed-update-ahead') {
    const laneVersion = state.plugins[LEGACY_PLUGINS[0]]
    const adapter = state.plugins[ADAPTER]
    return releaseVersion(build?.automagik) && laneVersion !== null &&
      LEGACY_PLUGINS.every(name => state.plugins[name] === laneVersion) &&
      compareRelease(laneVersion, build.automagik) > 0 &&
      (adapter === null || compareRelease(adapter, build.automagik) <= 0)
  }
  return true
}

function unavailableProfileState(reason) {
  return {
    plugins: Object.fromEntries(PLUGINS.map(name => [name, null])),
    followsImage: false,
    ownerManaged: false,
    reason,
  }
}

export function readProfileState(view, build, { keepRollback = false } = {}) {
  const state = readJson(join(view, PROFILE_STATE_FILE))
  if (!isProfileState(state, build)) return unavailableProfileState('no-profile-state')
  const age = Date.now() - Date.parse(state.at)
  if ((age > MAX_AGE && !(keepRollback && state.reason === 'update-rolled-back')) || age < -MAX_CLOCK_SKEW) {
    return unavailableProfileState('stale-profile-state')
  }
  return state
}
