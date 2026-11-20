import { constants as bufferLimits } from 'node:buffer'
import { createHash, createPublicKey } from 'node:crypto'
import * as filesystem from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { checkFolderChain, checkProofFolder, checkSocketFile, checkSocketFolder } from '../am/runner/locks.mjs'
import { DEFAULT_MODEL_KEY_FILE, gateViewDir, GATE_VIEW_MOUNT, PROFILE, RUN_SECRETS_DIR, RUN_SECRETS_MODEL_KEY_FILE } from './lib.mjs'
import { packPlugin } from './plugin-payload.mjs'
import { ADAPTER, ADAPTER_SINCE, BOTS_GUARD_SINCE, compareRelease, installedPlugins, validBuild } from './profile-state.mjs'

const BOTS = '@automagik/bots-dsh'
const CONNECTION = '@deepseek-ai/dsh-client-connection'
const WEBSERVER = '@deepseek-ai/dsh-host-webserver'
const WALL = `${BOTS}/member-wall/fs`
const STOCK_FS = '@deepseek-ai/dsh-fs-sandbox'
const WALL_IDS = new Set(['member-wall-fs', 'fs-sandbox'])
const WALL_NAMES = new Set([WALL, STOCK_FS, '@deepseek-ai/dsh-fs-local'])
// Dependencies of the pinned rc.2 sandbox filesystem and sandbox policy.
const WALL_SERVICES = new Map([
  ['sandboxPolicy', ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', ['sessionProjections']]],
  ['sessionProjections', ['session-projection', '@deepseek-ai/dsh-session-projection', []]],
])
const GROUPS = new Set(['cordis:group', '@deepseek-ai/cordis-plugin-group'])
const ADMISSION_IDS = new Set(['multiuser-dsh', 'connection', 'webserver', ...WALL_IDS])
const ADMISSION_NAMES = new Set([ADAPTER, CONNECTION, WEBSERVER, ...WALL_NAMES])
const KEY_FILE = 'caller-keys.json'
const TEMP_KEY = /^caller-keys\.json\.[1-9]\d*\.[a-f0-9]{16}\.tmp$/
const MAX_KEYS_BYTES = 16 * 1024
const DEFAULT_BODY_LIMIT = 314572800
const UNIX_SOCKET_PATH_BYTES = 107
const COMPOSITION_TMP = '/tmp'
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, W_OK, X_OK } = filesystem.constants
const require = createRequire(import.meta.url)

export function multiuserMode(value) {
  if (value === '1') return 'on'
  return value === undefined || value === '' || value === '0' ? 'off' : 'invalid'
}

export function startupDecision(mode, readiness) {
  if (mode === 'off' || (mode === 'on' && readiness?.ready)) return { ok: true }
  if (mode === 'on' && readiness) {
    const codes = readiness.checks.filter(check => !check.ok).map(check => check.code)
    return { ok: false, reason: `multiuser is on, but startup readiness failed: ${codes.join(', ')}` }
  }
  return {
    ok: false,
    reason: mode === 'on'
      ? 'multiuser is on, but this image does not carry the multiuser adapter yet (RFC 0038 delivery 1 image follow-up)'
      : 'invalid AUTOMAGIK_MULTIUSER (expected 1, 0 or unset)',
  }
}

function localEnv(fs, dir) {
  try { return parseEnv(fs.readFileSync(join(dir, '.env'), 'utf8')) }
  catch { return {} }
}

function envFileOverride(fs, env, cwd, home) {
  const unset = ['AUTOMAGIK_INSTANCE_ID', 'AUTOMAGIK_CALLER_KEYS'].filter(name => env[name] === undefined)
  if (!unset.length) return false
  for (const dir of new Set([cwd, home])) {
    const values = localEnv(fs, dir)
    if (unset.some(name => Object.hasOwn(values, name))) return true
  }
  return false
}

function containsAdmissionEntry(rows, ids = ADMISSION_IDS, names = ADMISSION_NAMES) {
  return rows.some(entry => ids.has(entry?.id) || names.has(entry?.name) ||
    (Array.isArray(entry?.config) && containsAdmissionEntry(entry.config, ids, names)))
}

function* entries(rows, ancestors = [], ancestorsEnabled = true, ancestorsMayEnable = true) {
  // EntryGroup.update() indexes each group's siblings by ID, with unnamed rows kept separate.
  const last = new Map(rows.flatMap((entry, index) => entry.id == null ? [] : [[String(entry.id), index]]))
  for (const [index, entry] of rows.entries()) {
    const shadowed = entry.id != null && last.get(String(entry.id)) !== index
    const active = ancestorsEnabled && (Boolean(entry.group) || (!entry.disabled && ancestors.every(parent => !parent.disabled)))
    const mayEnable = ancestorsMayEnable && (Boolean(entry.group) ||
      (entry.disabled !== true && ancestors.every(parent => parent.disabled !== true)))
    const children = Array.isArray(entry.config) ? entry.config : undefined
    const group = GROUPS.has(entry.name)
    yield { entry, ancestors, active, mayEnable, shadowed, ambiguous: !group && children && containsAdmissionEntry(children) }
    if (!shadowed && group && children) yield* entries(children, [...ancestors, entry], active, mayEnable)
  }
}

function bodyLimit(config) {
  if (config === undefined) return DEFAULT_BODY_LIMIT
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.hasOwn(config, '__jsExpr')) return null
  const value = config.maxRequestBodyBytes
  return value === undefined ? DEFAULT_BODY_LIMIT : value
}

function withFd(fs, path, flags, fn) {
  const fd = fs.openSync(path, flags)
  try { return fn(fd) }
  finally { fs.closeSync(fd) }
}

const mountId = (fs, fd) => /^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
const fdPath = (fs, fd) => fs.readlinkSync(`/proc/self/fd/${fd}`)

function within(root, path) {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

function physical(fs, path) {
  try { return fs.realpathSync(path) }
  catch (error) {
    if (error.code !== 'ENOENT' || path === dirname(path) || fs.lstatSync(path, { throwIfNoEntry: false })) throw error
    return join(physical(fs, dirname(path)), basename(path))
  }
}

const absolutePath = path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')
const normalizedPath = path => absolutePath(path) && resolve(path) === path
const numericId = value => typeof value === 'string' && /^\d+$/.test(value) && Number(value) < 0xffffffff
const excludedRoots = (home, dshHome, cwd) => ['/data', home, dshHome, cwd, gateViewDir(home), GATE_VIEW_MOUNT]

function runnerConfigured(fs, env, { dshHome, cwd, uid, gid }) {
  const { AUTOMAGIK_BOT_RUNNER_SOCKET: socket, AUTOMAGIK_BOT_RUNNER_PROOFS: proofs,
    AUTOMAGIK_BOT_RUNNER_UID: runnerUid, AUTOMAGIK_BOT_RUNNER_GID: runnerGid } = env
  if (![socket, proofs].every(normalizedPath) || ![runnerUid, runnerGid].every(numericId) ||
      Buffer.byteLength(socket) > UNIX_SOCKET_PATH_BYTES || Number(runnerUid) === 0 ||
      Number(runnerUid) === uid || Number(runnerGid) === gid) return false
  const excluded = excludedRoots(resolve(env.AUTOMAGIK_HOME || '/data'), dshHome, cwd)
  return [socket, proofs].every(path => {
    if (excluded.some(root => within(root, path))) return false
    try {
      const location = physical(fs, path)
      return excluded.every(root => !within(physical(fs, root), location))
    } catch {
      // A missing, inaccessible or malformed socket path is diagnosed by the metadata check.
      return true
    }
  })
}

function runnerUsable(fs, env, groups) {
  const socket = env.AUTOMAGIK_BOT_RUNNER_SOCKET
  const proofs = env.AUTOMAGIK_BOT_RUNNER_PROOFS
  const uid = Number(env.AUTOMAGIK_BOT_RUNNER_UID), gid = Number(env.AUTOMAGIK_BOT_RUNNER_GID)
  if (!groups.includes(gid)) return false
  const socketDir = dirname(socket)
  try {
    checkFolderChain(fs, socketDir)
    checkSocketFolder(fs, socketDir, uid, gid)
    checkSocketFile(fs, socket, uid, gid)
    checkFolderChain(fs, dirname(proofs))
    checkProofFolder(fs, proofs, uid, gid)
    // access checks ACLs and a read-only proof mount without creating anything.
    fs.accessSync(socketDir, X_OK)
    fs.accessSync(socket, W_OK)
    fs.accessSync(proofs, W_OK | X_OK)
    return true
  } catch { return false }
}

function loadWallPaths(imageProfile) {
  // Only load the pure path checks from the immutable image profile, without applying the plugin.
  const file = require.resolve(WALL, { paths: [imageProfile] })
  return require(join(dirname(file), 'paths.js'))
}

const plainObject = value => value != null && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function sandboxPolicyValid(config = {}, { fs, env, cwd, dshHome }) {
  if (!plainObject(config) || Object.hasOwn(config, '__jsExpr')) return false
  let { mode = 'read-only', workspaceRoot = cwd } = config
  const { additionalWritableRoots = [] } = config
  // Resolve the two stock rc.2 expressions without evaluating profile-supplied code.
  if (mode?.__jsExpr === "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'") {
    mode = env.DSH_PERMISSION_MODE ?? localEnv(fs, cwd).DSH_PERMISSION_MODE ??
      localEnv(fs, dshHome).DSH_PERMISSION_MODE ?? 'workspace-write'
  }
  if (workspaceRoot?.__jsExpr === 'process.cwd()') workspaceRoot = cwd
  return ['read-only', 'workspace-write', 'danger-full-access'].includes(mode) &&
    absolutePath(workspaceRoot) &&
    Array.isArray(additionalWritableRoots) && additionalWritableRoots.every(absolutePath)
}

function scopeAllows(row, required, serviceAvailable) {
  return [...row.ancestors, row.entry].every(({ isolate, inject }) => {
    if (isolate != null && (!plainObject(isolate) || Object.hasOwn(isolate, '__jsExpr') ||
        ['fs', ...WALL_SERVICES.keys()].some(name => isolate[name] != null))) return false
    if (inject != null && !Array.isArray(inject) && !plainObject(inject)) return false
    const names = Array.isArray(inject) ? inject : Object.keys(inject ?? {})
    return [...required, ...names].every(serviceAvailable)
  })
}

function activeWall(composed, runtime) {
  if (composed.some(({ entry, mayEnable, ambiguous }) =>
    (mayEnable && (entry.id === 'fs-sandbox' || (entry.name !== WALL && WALL_NAMES.has(entry.name)))) ||
    (ambiguous && containsAdmissionEntry(entry.config, WALL_IDS, WALL_NAMES)))) return undefined
  const candidates = composed.filter(({ entry, mayEnable }) => mayEnable && (entry.id === 'member-wall-fs' || entry.name === WALL))
  const [row] = candidates
  if (candidates.length !== 1 || !row.active || row.entry.id !== 'member-wall-fs' || row.entry.name !== WALL) return undefined
  // A tool in an isolated fs realm cannot see the wall either.
  if (composed.some(({ entry, mayEnable }) => mayEnable && entry.isolate?.fs != null)) return undefined
  const available = (service, visiting = []) => {
    const definition = WALL_SERVICES.get(service)
    if (!definition || visiting.includes(service)) return false
    const [id, name, required] = definition
    const providers = composed.filter(({ entry, mayEnable }) => mayEnable && (entry.id === id || entry.name === name))
    const [provider] = providers
    return providers.length === 1 && provider.active && provider.entry.id === id && provider.entry.name === name &&
      (service !== 'sandboxPolicy' || sandboxPolicyValid(provider.entry.config, runtime)) &&
      scopeAllows(provider, required, dependency => available(dependency, [...visiting, service]))
  }
  if (scopeAllows(row, ['sandboxPolicy'], name => available(name))) return row.entry.config
}

function wallValid(config, { fs, env, dshHome, cwd: workspace, imageProfile, wallPaths }) {
  if (!plainObject(config) || Object.hasOwn(config, '__jsExpr') || config.members !== true || config.bots !== true ||
      !absolutePath(config.membersRoot) || config.principalsFile !== join(dshHome, 'multiuser-dsh', 'principals.json') ||
      (config.instanceId !== undefined && config.instanceId !== '' && config.instanceId !== env.AUTOMAGIK_INSTANCE_ID)) return false
  // Match the LocalFileSystem schema and constructor in dsh 0.2.2-rc.2.
  const { cwd, diffBasisMaxBytes } = config
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) return false
  if (diffBasisMaxBytes !== undefined && (!Number.isSafeInteger(diffBasisMaxBytes) || diffBasisMaxBytes <= 0 ||
      diffBasisMaxBytes > Math.min(bufferLimits.MAX_LENGTH, bufferLimits.MAX_STRING_LENGTH))) return false
  const { sharedReadRoots = [], denyReadRoots = [], botDenyRoots = [], botReadRoots = {} } = config
  if (![sharedReadRoots, denyReadRoots, botDenyRoots].every(roots => Array.isArray(roots) && roots.every(absolutePath)) ||
      !plainObject(botReadRoots) || Object.values(botReadRoots).some(roots => !Array.isArray(roots) || !roots.every(absolutePath))) return false
  try {
    const { checkBotConfig, physical: wallLocation, within: sameTree } = wallPaths ?? loadWallPaths(imageProfile)
    const home = resolve(env.AUTOMAGIK_HOME || '/data')
    const protectedRoots = [dshHome, dirname(DEFAULT_MODEL_KEY_FILE), join(home, 'secrets'), gateViewDir(home),
      RUN_SECRETS_DIR, DEFAULT_MODEL_KEY_FILE, RUN_SECRETS_MODEL_KEY_FILE]
    const key = env.DEEPSEEK_API_KEY_FILE
    if (key) protectedRoots.push(isAbsolute(key) ? key : `${workspace}/${key}`)
    const protectedLocations = [...new Set(protectedRoots.map(root => wallLocation(root)))]
    // Require a deny covering the whole protected tree even if a member is granted '/'.
    // Physical containment covers a protected path that has not been created yet.
    const covered = root => denyReadRoots.some(denied => {
      if (sameTree(root, denied)) return true
      const deniedLocation = wallLocation(denied)
      return deniedLocation !== undefined && !fs.lstatSync(root, { throwIfNoEntry: false }) && within(deniedLocation, root)
    })
    if (protectedLocations.some(root => root === undefined || !covered(root))) return false
    const mounts = readMounts(fs)
    const protectedTrees = protectedLocations.flatMap(root => backingTrees(mounts, root))
    if (![config.membersRoot, ...sharedReadRoots].every(root => {
      const location = wallLocation(root)
      return location !== undefined && backingTrees(mounts, location).every(grant => protectedTrees.every(tree => {
        const alias = reachableAlias(mounts, grant, tree)
        return alias === undefined || covered(alias)
      }))
    })) return false
    checkBotConfig({ ...config, botReadRoots, botDenyRoots: [...botDenyRoots, '/data', gateViewDir(home), GATE_VIEW_MOUNT], denyReadRoots },
      { ...env, DSH_HOME: dshHome, AUTOMAGIK_HOME: home })
    return true
  } catch { return false }
}

const decodeMountPath = path => path.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)))

function readMounts(fs) {
  return fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(row => {
    const [, , device, root, at] = row.split(' ')
    return { device, root: decodeMountPath(root), at: decodeMountPath(at) }
  })
}

function backingTree(mounts, path) {
  const covering = mounts.filter(mount => within(mount.at, path)).sort((a, b) => b.at.length - a.at.length)
  const [mount, next] = covering
  if (!mount || mount.at === next?.at) throw new Error('mount backing is ambiguous')
  return { device: mount.device, root: join(mount.root, relative(mount.at, path)), at: path }
}

function backingTrees(mounts, path) {
  return [backingTree(mounts, path), ...mounts.filter(child => child.at !== path && within(path, child.at))]
}

const overlap = (a, b) => within(a, b) || within(b, a)
const backingOverlap = (a, b) => a.device === b.device && overlap(a.root, b.root)

// Convert intersecting backing trees to a spelling under the granted root. A submount may
// hide that spelling, so verify both coordinates through the mount that actually covers them.
function reachableAlias(mounts, grant, tree) {
  if (!backingOverlap(grant, tree)) return undefined
  const root = within(grant.root, tree.root) ? tree.root : grant.root
  const location = ({ at, root: base }) => join(at, relative(base, root))
  const grantPath = location(grant), protectedPath = location(tree)
  for (const path of [grantPath, protectedPath]) {
    const backing = backingTree(mounts, path)
    if (backing.device !== grant.device || backing.root !== root) return undefined
  }
  return grantPath
}

function treesDisjoint(fs, wall, work, runnerUid, imageProfile, wallPaths) {
  if (!normalizedPath(work)) return false
  try {
    checkFolderChain(fs, work)
    const info = fs.lstatSync(work)
    if (info.uid !== Number(runnerUid) || (info.mode & 0o7777) !== 0o711) return false
    fs.accessSync(work, X_OK)
    const { physical: wallLocation, rootsOverlap } = wallPaths ?? loadWallPaths(imageProfile)
    const mounts = readMounts(fs), commandTrees = backingTrees(mounts, fs.realpathSync(work))
    const roots = [wall.botsRoot, ...Object.values(wall.botReadRoots ?? {}).flat()]
    return roots.every(root => {
      const location = wallLocation(root)
      return location !== undefined && !overlap(root, work) && !rootsOverlap(root, work) &&
        backingTrees(mounts, location).every(left => commandTrees.every(right => !backingOverlap(left, right)))
    })
  } catch { return false }
}

const LEGACY_PROJECTION = '.dsh-module-fallback'

// rc.2 can rewrite the manifest and unlink projected packages. Give it disposable directory
// entries, while reading bundle/dependency contents in place. Only a legacy profile needs
// individual node_modules entries, to let rc.2 remove its projection from the copy.
function copyProfileModules(profile, copy) {
  const modules = join(profile, 'node_modules'), target = join(copy, 'node_modules')
  if (!filesystem.existsSync(modules)) return
  const legacy = join(profile, LEGACY_PROJECTION)
  if (!filesystem.existsSync(legacy)) {
    filesystem.symlinkSync(modules, target)
    return
  }
  filesystem.symlinkSync(legacy, join(copy, LEGACY_PROJECTION))
  const copyLinks = (from, to, scoped) => {
    filesystem.mkdirSync(to)
    for (const entry of filesystem.readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name), destination = join(to, entry.name)
      if (!scoped && entry.name.startsWith('@') && entry.isDirectory()) copyLinks(source, destination, true)
      else filesystem.symlinkSync(entry.isSymbolicLink() ? resolve(from, filesystem.readlinkSync(source)) : source, destination)
    }
  }
  copyLinks(modules, target, false)
}

function copyProfileLookup(profile, copy, scratch) {
  const search = dir => createRequire(join(dir, 'package.json')).resolve.paths('dsh-profile-bundle')
  const original = new Set(search(profile))
  for (const target of search(copy)) {
    if (target === join(copy, 'node_modules')) continue
    if (!within(scratch, target)) {
      // The scratch directory adds its own ancestors to Node's lookup. Refuse an extra
      // lookup tree rather than allowing a bundle the real profile could not resolve.
      if (!original.has(target) && filesystem.existsSync(target)) throw new Error('unexpected scratch module lookup')
      continue
    }
    const source = join(sep, relative(scratch, target))
    if (original.has(source) && filesystem.existsSync(source)) filesystem.symlinkSync(source, target)
  }
}

function checkCompositionLocation(fs, env, cwd, dshHome) {
  const home = resolve(env.AUTOMAGIK_HOME || '/data')
  const socket = env.AUTOMAGIK_BOT_RUNNER_SOCKET
  const protectedDirs = [dshHome, gateViewDir(home), GATE_VIEW_MOUNT, absolutePath(socket) ? dirname(socket) : undefined,
    env.AUTOMAGIK_BOT_RUNNER_PROOFS, env.AUTOMAGIK_BOT_RUNNER_WORK_ROOT].filter(absolutePath)
  const mounts = readMounts(fs)
  const fixed = physical(fs, COMPOSITION_TMP)
  const supplied = env.TMPDIR ? physical(fs, resolve(cwd, env.TMPDIR)) : undefined
  const fixedTree = backingTree(mounts, fixed)
  const suppliedTrees = supplied === undefined ? [] : backingTrees(mounts, supplied)
  for (const dir of protectedDirs) {
    const location = physical(fs, dir)
    if (within(location, fixed) || (supplied !== undefined && overlap(location, supplied)) ||
        backingTrees(mounts, location).some(tree =>
          (tree.device === fixedTree.device && within(tree.root, fixedTree.root)) ||
          suppliedTrees.some(candidate => backingOverlap(tree, candidate)))) {
      throw new Error('composition temporary directory overlaps a protected path')
    }
  }
}

function composeProfile(appBoot, { fs, profile, dshHome, cwd, installAnchor, env }) {
  checkCompositionLocation(fs, env, cwd, dshHome)
  const scratch = filesystem.mkdtempSync(join(COMPOSITION_TMP, 'automagik-composition-'))
  try {
    const copy = join(scratch, profile)
    filesystem.mkdirSync(copy, { recursive: true })
    filesystem.copyFileSync(join(profile, 'package.json'), join(copy, 'package.json'))
    for (const name of ['cordis.patch.yml', 'compatibility.json']) {
      const source = join(profile, name)
      if (filesystem.existsSync(source)) filesystem.copyFileSync(source, join(copy, name))
    }
    copyProfileModules(profile, copy)
    copyProfileLookup(profile, copy, scratch)
    const loaded = appBoot.loadProfile('dsh', PROFILE, installAnchor, dirname(dirname(copy)))
    const context = {
      name: PROFILE, dir: loaded.dir, patchPath: loaded.patchPath, installAnchor,
      startedBundles: loaded.layers.map(layer => layer.packageName), cwd, home: dshHome,
      overlays: [], telemetryDisabledEnv: env.DSH_TELEMETRY_DISABLED,
    }
    return [...entries(appBoot.composeEntries([appBoot.readProfilePatches('dsh', context, loaded)]))]
  } finally {
    filesystem.rmSync(scratch, { recursive: true, force: true })
  }
}

function publicKeysValid(fs, fd, expected) {
  const bytes = Buffer.alloc(MAX_KEYS_BYTES + 1)
  let size = 0
  while (size < bytes.length) {
    const count = fs.readSync(fd, bytes, size, bytes.length - size, null)
    if (!count) break
    size += count
  }
  if (size > MAX_KEYS_BYTES) return false
  let hasPrivate = false
  const { version, instance, keys } = JSON.parse(bytes.subarray(0, size), (key, value) => {
    if (key === 'd') hasPrivate = true
    return value
  })
  if (hasPrivate || version !== 1 || typeof instance !== 'string' || !instance ||
      (expected !== undefined && expected !== instance) || !Array.isArray(keys) ||
      keys.length < 1 || keys.length > 2) return false
  const seen = new Set()
  for (const { x, kid, alg, crv } of keys) {
    if (typeof x !== 'string' || alg !== 'EdDSA' || crv !== 'Ed25519') return false
    const raw = Buffer.from(x, 'base64url')
    const derived = createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url')
    if (raw.length !== 32 || raw.toString('base64url') !== x || derived !== kid || seen.has(kid)) return false
    createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' })
    seen.add(kid)
  }
  return true
}

function checkMount(fs, file, { env, dshHome, cwd, uid }) {
  const dir = dirname(file)
  const home = resolve(env.AUTOMAGIK_HOME || '/data')
  const excluded = excludedRoots(home, dshHome, cwd)
  if ((process.getuid?.() ?? 1000) !== uid || !fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir ||
      excluded.some(path => within(path, dir) || within(physical(fs, path), dir))) return { ok: false }
  const flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  return withFd(fs, dir, flags, fd => {
    const id = mountId(fs, fd)
    const parent = withFd(fs, dirname(dir), flags, parentFd => mountId(fs, parentFd))
    const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(row => row.startsWith(`${id} `))
    if (!id || !parent || id === parent || fdPath(fs, fd) !== dir ||
        !mount?.split(' ')[5]?.split(',').includes('ro')) return { ok: false }
    if (fs.readdirSync(`/proc/self/fd/${fd}`).some(name => name !== KEY_FILE && !TEMP_KEY.test(name))) return { ok: false }
    // The gate publishes by rename, so an open descriptor can briefly name the old file.
    for (let retries = 0; retries <= 3; retries++) {
      let keyFd
      try { keyFd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) }
      catch (error) {
        if (error.code === 'ENOENT') return { ok: true, note: 'keys-not-published-yet' }
        throw error
      }
      try {
        if (fdPath(fs, keyFd) !== file) continue
        const stat = fs.fstatSync(keyFd)
        return { ok: stat.isFile() && stat.size <= MAX_KEYS_BYTES && mountId(fs, keyFd) === id &&
          publicKeysValid(fs, keyFd, env.AUTOMAGIK_INSTANCE_ID) }
      } finally {
        fs.closeSync(keyFd)
      }
    }
    return { ok: false }
  })
}

const digest = (profile, name) => createHash('sha512').update(packPlugin(join(profile, 'node_modules', name))).digest('hex')
const atLeast = (version, floor) => version !== null && compareRelease(version, floor) >= 0

export function multiuserConfigChecks(env, {
  fs = filesystem, cwd, dshHome, uid = process.geteuid?.() ?? 1000, gid = process.getegid?.() ?? 1000,
}) {
  const file = env.AUTOMAGIK_CALLER_KEYS
  return [
    { code: 'caller-keys-config', ok: normalizedPath(file) && basename(file) === KEY_FILE },
    { code: 'instance-config', ok: typeof env.AUTOMAGIK_INSTANCE_ID === 'string' && !!env.AUTOMAGIK_INSTANCE_ID.trim() },
    { code: 'env-file-override', ok: !envFileOverride(fs, env, cwd, dshHome) },
    { code: 'bot-runner-config', ok: runnerConfigured(fs, env, { dshHome, cwd, uid, gid }) },
  ]
}

export function multiuserReadiness({
  env, dshHome, profile, imageProfile, build, installAnchor, appBoot, fs = filesystem,
  uid = process.geteuid?.() ?? 1000, gid = process.getegid?.() ?? 1000, groups = process.getgroups?.() ?? [],
  cwd = resolve(env.AUTOMAGIK_WORKSPACE || process.cwd()), wallPaths,
}) {
  const checks = multiuserConfigChecks(env, { fs, cwd, dshHome, uid, gid }), warnings = []
  const runnerConfigOk = checks.find(check => check.code === 'bot-runner-config').ok
  const add = (code, ok, note) => checks.push({ code, ok, ...(note ? { note } : {}) })

  let composed
  try {
    composed = composeProfile(appBoot, { fs, profile, dshHome, cwd, installAnchor, env })
  } catch {}
  add('composition', composed !== undefined)
  if (composed) {
    const effective = composed.filter(row => !row.shadowed)
    if (effective.some(row => row.ambiguous)) add('ambiguous-ancestry', false)
    // Keep the stricter adapter/transport collision checks, including shadowed declarations.
    const adapters = composed.filter(({ entry }) => entry.id === 'multiuser-dsh' || entry.name === ADAPTER)
    const adapter = adapters.find(({ entry }) => entry.id === 'multiuser-dsh' && entry.name === ADAPTER)
    if (adapters.length && (adapters.length > 1 || !adapter)) add('adapter-collision', false)
    add('adapter-enabled', adapter?.active === true)
    const provider = (id, name) => {
      const candidates = composed.filter(({ entry, active }) => entry.id === id || (name === WEBSERVER && active && entry.name === name))
      if (candidates.length > 1) {
        if (!checks.some(check => check.code === 'provider-collision')) add('provider-collision', false)
      } else if (!candidates[0]?.active || candidates[0].entry.id !== id || candidates[0].entry.name !== name) add(`${id}-missing`, false)
      else return candidates[0].entry
    }
    const connection = provider('connection', CONNECTION)
    provider('webserver', WEBSERVER)
    if (connection && adapter) {
      const limit = bodyLimit(adapter.entry.config)
      add('body-limit', Number.isSafeInteger(limit) && limit > 0 && limit === bodyLimit(connection.config))
    }
    if (effective.some(({ entry }) => entry.name === BOTS && entry.config?.appManifest === false)) warnings.push('app-manifest')
    const runtime = { fs, env, dshHome, cwd, imageProfile, wallPaths }
    const wall = activeWall(effective, runtime)
    const valid = wallValid(wall, runtime)
    add('member-wall-row', valid)
    if (valid && runnerConfigOk) add('bot-trees-disjoint', treesDisjoint(fs, wall, env.AUTOMAGIK_BOT_RUNNER_WORK_ROOT,
      env.AUTOMAGIK_BOT_RUNNER_UID, imageProfile, wallPaths))
  }

  const versions = installedPlugins(profile)
  add('adapter-version', atLeast(versions[ADAPTER], ADAPTER_SINCE))
  add('bots-guard', atLeast(versions[BOTS], BOTS_GUARD_SINCE))

  if (checks[0].ok) {
    let mount = { ok: false }
    try { mount = checkMount(fs, env.AUTOMAGIK_CALLER_KEYS, { env, dshHome, cwd, uid }) } catch {}
    add('caller-keys-mount', mount.ok, mount.note)
  }
  if (runnerConfigOk) add('bot-runner-socket', runnerUsable(fs, env, groups))

  let integrity = false
  try {
    integrity = validBuild(build) && [ADAPTER, BOTS].every(name => versions[name] === build.plugins[name] &&
      digest(profile, name) === digest(imageProfile, name))
  } catch {}
  add('image-integrity', integrity)
  return { ready: checks.every(check => check.ok), checks, warnings }
}
