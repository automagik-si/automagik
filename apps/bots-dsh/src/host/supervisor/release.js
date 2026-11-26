import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { compareVersions, satisfies, verifyLane } from '../lane-verify.js'
import { boundedGet } from '../bounded-get.js'
import { isLaneVersion, PLUGINS, reinstallIntent } from './reinstall-intent.js'
import { regularBytes } from './store.js'

export const LANE_URL = 'https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json'
export const ROLE_KEYS = Object.freeze(JSON.parse(readFileSync(new URL('../role-keys.json', import.meta.url), 'utf8')).keys.map(Object.freeze))
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
export const FETCH_TIMEOUT_MS = 8000
export { isLaneVersion, PLUGINS }
const MAX_TARBALL = 64 * 1024 * 1024
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function installedPlugins(profileDir) {
  const dependencies = readJson(join(profileDir, 'package.json')).dependencies ?? {}
  if (typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('Invalid profile dependencies')
  const installed = new Map()
  for (const name of PLUGINS) {
    if (!Object.hasOwn(dependencies, name)) continue
    // The dependency spec can be a file, URL or range. Read what pnpm actually installed.
    const { version } = readJson(join(profileDir, 'node_modules', name, 'package.json'))
    if (!isLaneVersion(version)) throw new Error('Invalid installed plugin version')
    installed.set(name, version)
  }
  return installed
}

export function registryOnlyNpmrc(profileDir) {
  const npmrc = regularBytes(join(profileDir, '.npmrc'), { optional: true })?.toString() ?? ''
  const settings = npmrc.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[#;]/.test(line))
  if (settings.some(line => !/^registry\s*=/.test(line))) {
    throw Object.assign(new Error('Only registry= is supported in the profile .npmrc'), { reason: 'profile-npmrc' })
  }
  return settings
}

export function profileRegistry(profileDir, env = process.env) {
  const settings = registryOnlyNpmrc(profileDir)
  const override = env.npm_config_registry || env.NPM_CONFIG_REGISTRY
  if (override) return override
  const setting = settings.at(-1)?.replace(/^registry\s*=\s*/, '').split(/[ \t]+[;#]/, 1)[0].trim().replace(/^(['"])(.*)\1$/, '$2')
  let missing = false
  const expanded = setting?.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const value = env[name]
    if (value === undefined) missing = true
    return value ?? ''
  })
  return missing || !expanded ? OFFICIAL_REGISTRY : expanded
}

function registryPing(registry) {
  const url = new URL(registry)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid package registry URL')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/-/ping`
  return url.href
}

function githubTarball(value) {
  if (typeof value !== 'string' || !value.startsWith('https://github.com/')) return undefined
  const url = URL.parse(value)
  if (url?.origin === 'https://github.com' && !url.username && !url.password) return url.href
}

export function releaseSource(lane = LANE_URL, keys) {
  const laneUrl = URL.parse(lane)
  const isFile = laneUrl?.protocol === 'file:' && !laneUrl.host && !laneUrl.search && !laneUrl.hash
  if (!isFile && (laneUrl?.href !== LANE_URL || keys !== undefined)) return null
  return { laneUrl, keys: isFile ? keys ?? ROLE_KEYS : ROLE_KEYS }
}

async function verifyTarballs(plugins, saveTarball, fetch, requireAccess, signal, onPhase) {
  for (const [index, plugin] of plugins.entries()) {
    requireAccess()
    const url = githubTarball(plugin.url)
    if (!url || !Number.isSafeInteger(plugin.size) || plugin.size < 1 || plugin.size > MAX_TARBALL) return 'download-failed'
    let bytes
    try {
      bytes = await boundedGet(fetch, url, { label: 'Plugin package', limit: plugin.size, signal: deadline(signal, 60_000) })
    } catch {
      return 'download-failed'
    }
    requireAccess()
    const sha256 = typeof plugin.sha256 === 'string' ? plugin.sha256.toLowerCase() : null
    const last = index === plugins.length - 1
    if (last) onPhase('verifying')
    if (bytes.length !== plugin.size
      || createHash('sha256').update(bytes).digest('hex') !== sha256
      || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== plugin.integrity) {
      if (!last) onPhase('verifying')
      return 'hash-mismatch'
    }
    saveTarball(plugin, bytes)
  }
  return null
}

const deadline = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

export async function inspectRelease({
  profileDir, current, view, getDshVersion, fetch, source, registry, saveTarball, signal, allowEqual = false, expectedReinstall,
  requireAccess = () => {}, onPhase = () => {},
}) {
  const result = (state, reason) => ({ state, reason })
  const { laneUrl, keys } = source
  const laneFetch = laneUrl.protocol === 'file:'
    ? (url, { signal }) => new Response(Readable.toWeb(createReadStream(new URL(url), { signal })))
    : fetch
  let bytes, signature
  try {
    const laneSignal = deadline(signal, 15_000)
    bytes = await boundedGet(laneFetch, laneUrl.href, { label: 'lane.json', limit: 256 * 1024, signal: laneSignal })
    requireAccess()
    signature = await boundedGet(laneFetch, `${laneUrl.href}.sig`, { label: 'lane.json.sig', limit: 1024, signal: laneSignal })
  } catch {
    return result('refused', 'download-failed')
  }
  let lane
  try {
    lane = verifyLane(bytes, signature.toString('utf8'), keys)
  } catch {
    return result('refused', 'signature-invalid')
  }
  if (!isLaneVersion(lane.version) || !Number.isSafeInteger(lane.sequence) || lane.sequence < 0 || !Array.isArray(lane.plugins)) {
    return result('refused', 'lane-invalid')
  }
  view.laneVersion = lane.version
  view.sequence = lane.sequence
  if (lane.sequence < (current?.lastSequence ?? 0)) return result('refused', 'sequence-lower')

  let installed
  try {
    installed = installedPlugins(profileDir)
  } catch {
    return result('refused', 'profile-invalid')
  }
  const plugins = lane.plugins.filter(plugin => installed.has(plugin?.name))
  if (plugins.length !== installed.size || new Set(plugins.map(plugin => plugin.name)).size !== installed.size
    || plugins.some(plugin => plugin.version !== lane.version)) {
    return result('refused', expectedReinstall ? 'release-changed' : 'lane-invalid')
  }
  view.plugins = plugins.map(({ name, version }) => ({ name, from: installed.get(name), to: version }))
  const versions = view.plugins.map(({ from, to }) => compareVersions(to, from))
  const reinstall = allowEqual === true && plugins.length > 0 && view.plugins.every(({ from, to }) => from === to)
  const selected = reinstall ? view.plugins.map((plugin, i) => ({ ...plugin, sha256: plugins[i].sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name)) : null
  if (expectedReinstall) {
    const intent = reinstall && reinstallIntent({
      version: 2, state: 'available', reinstall: true, laneVersion: lane.version, sequence: lane.sequence, plugins: selected,
    }, { saved: true })
    if (!isDeepStrictEqual(intent, expectedReinstall)) return result('refused', 'release-changed')
  }
  const newer = versions.some(order => order > 0)
  if ((allowEqual === true || newer) && versions.some(order => order < 0)) {
    return result('refused', 'not-newer')
  }
  if (!reinstall && !newer) return result('current', 'not-newer')

  let dshVersion
  try { dshVersion = await getDshVersion() } catch { return result('refused', 'engines-dsh') }
  if (plugins.some(plugin => !satisfies(dshVersion, plugin.engines?.dsh))) return result('refused', 'engines-dsh')

  onPhase('downloading')
  const tarballFailure = await verifyTarballs(plugins, saveTarball, fetch, requireAccess, signal, onPhase)
  if (tarballFailure !== null) return result('refused', tarballFailure)
  let registryUrl
  try {
    requireAccess()
    registryUrl = await registry(profileDir)
    const url = registryPing(registryUrl)
    requireAccess()
    const response = await fetch(url, { redirect: 'manual', signal: deadline(signal, FETCH_TIMEOUT_MS) })
    void response.body?.cancel().catch(() => {})
    if (response.status >= 500) return result('refused', 'registry-unreachable')
  } catch (error) {
    return result('refused', error?.reason === 'profile-npmrc' ? error.reason : 'registry-unreachable')
  }
  if (reinstall) view.plugins = selected
  return { ...result('available', null), plugins, registry: registryUrl, ...(reinstall ? { reinstall: true } : {}) }
}
