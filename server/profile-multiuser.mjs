import { createHash, createPublicKey } from 'node:crypto'
import * as filesystem from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { gateViewDir, GATE_VIEW_MOUNT, PROFILE } from './lib.mjs'
import { packPlugin } from './plugin-payload.mjs'
import { ADAPTER, ADAPTER_SINCE, BOTS_GUARD_SINCE, compareRelease, installedPlugins, validBuild } from './profile-state.mjs'

const BOTS = '@automagik/bots-dsh'
const CONNECTION = '@deepseek-ai/dsh-client-connection'
const WEBSERVER = '@deepseek-ai/dsh-host-webserver'
const GROUPS = new Set(['cordis:group', '@deepseek-ai/cordis-plugin-group'])
const ADMISSION_IDS = new Set(['multiuser-dsh', 'connection', 'webserver'])
const ADMISSION_NAMES = new Set([ADAPTER, CONNECTION, WEBSERVER])
const KEY_FILE = 'caller-keys.json'
const TEMP_KEY = /^caller-keys\.json\.[1-9]\d*\.[a-f0-9]{16}\.tmp$/
const MAX_KEYS_BYTES = 16 * 1024
const DEFAULT_BODY_LIMIT = 314572800
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = filesystem.constants

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

function envFileOverride(fs, env, cwd, home) {
  const unset = ['AUTOMAGIK_INSTANCE_ID', 'AUTOMAGIK_CALLER_KEYS'].filter(name => env[name] === undefined)
  if (!unset.length) return false
  for (const dir of new Set([cwd, home])) {
    let text
    try { text = fs.readFileSync(join(dir, '.env'), 'utf8') }
    catch { continue }
    const values = parseEnv(text)
    if (unset.some(name => Object.hasOwn(values, name))) return true
  }
  return false
}

const enabled = entry => entry.disabled === undefined || entry.disabled === false

function containsAdmissionEntry(rows) {
  return rows.some(entry => ADMISSION_IDS.has(entry?.id) || ADMISSION_NAMES.has(entry?.name) ||
    (Array.isArray(entry?.config) && containsAdmissionEntry(entry.config)))
}

function* entries(rows, ancestorsEnabled = true) {
  for (const entry of rows) {
    const active = ancestorsEnabled && enabled(entry)
    const children = Array.isArray(entry.config) ? entry.config : undefined
    const group = GROUPS.has(entry.name)
    yield { entry, active, ambiguous: !group && children && containsAdmissionEntry(children) }
    if (group && children) yield* entries(children, active)
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
    if (error.code !== 'ENOENT' || path === dirname(path)) throw error
    return join(physical(fs, dirname(path)), basename(path))
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
  const excluded = ['/data', home, dshHome, cwd, gateViewDir(home), GATE_VIEW_MOUNT]
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

export function multiuserConfigChecks(env, { fs = filesystem, cwd, dshHome }) {
  const file = env.AUTOMAGIK_CALLER_KEYS
  return [
    { code: 'caller-keys-config', ok: typeof file === 'string' && isAbsolute(file) && resolve(file) === file && basename(file) === KEY_FILE },
    { code: 'instance-config', ok: env.AUTOMAGIK_INSTANCE_ID !== '' },
    { code: 'env-file-override', ok: !envFileOverride(fs, env, cwd, dshHome) },
  ]
}

export function multiuserReadiness({
  env, dshHome, profile, imageProfile, build, installAnchor, appBoot, fs = filesystem,
  uid = process.getuid?.() ?? 1000, cwd = resolve(env.AUTOMAGIK_WORKSPACE || process.cwd()),
}) {
  const checks = multiuserConfigChecks(env, { fs, cwd, dshHome }), warnings = []
  const add = (code, ok, note) => checks.push({ code, ok, ...(note ? { note } : {}) })

  let composed
  try {
    const loaded = appBoot.loadProfile('dsh', PROFILE, installAnchor, dshHome)
    const context = {
      name: PROFILE, dir: loaded.dir, patchPath: loaded.patchPath, installAnchor,
      startedBundles: loaded.layers.map(layer => layer.packageName), cwd, home: dshHome,
      overlays: [], telemetryDisabledEnv: env.DSH_TELEMETRY_DISABLED,
    }
    const patches = appBoot.readProfilePatches('dsh', context, loaded)
    composed = [...entries(appBoot.composeEntries([patches]))]
  } catch {}
  add('composition', composed !== undefined)
  if (composed) {
    if (composed.some(row => row.ambiguous)) add('ambiguous-ancestry', false)
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
    if (composed.some(({ entry }) => entry.name === BOTS && entry.config?.appManifest === false)) warnings.push('app-manifest')
  }

  const versions = installedPlugins(profile)
  add('adapter-version', atLeast(versions[ADAPTER], ADAPTER_SINCE))
  add('bots-guard', atLeast(versions[BOTS], BOTS_GUARD_SINCE))

  if (checks[0].ok) {
    let mount = { ok: false }
    try { mount = checkMount(fs, env.AUTOMAGIK_CALLER_KEYS, { env, dshHome, cwd, uid }) } catch {}
    add('caller-keys-mount', mount.ok, mount.note)
  }

  let integrity = false
  try {
    integrity = validBuild(build) && [ADAPTER, BOTS].every(name => versions[name] === build.plugins[name] &&
      digest(profile, name) === digest(imageProfile, name))
  } catch {}
  add('image-integrity', integrity)
  return { ready: checks.every(check => check.ok), checks, warnings }
}
