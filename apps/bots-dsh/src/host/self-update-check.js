import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inDesktopApp } from './constants.js'
import { currentDsh } from './dsh-update.js'
import { compareVersions, satisfies, verifyLane } from './lane-verify.js'
import { boundedGet, ROLE_KEYS } from './role-catalog.js'
import { prepareStore, selfUpdateDetails, supervisorOf, writeJsonAtomic } from './self-update.js'
import { FETCH_TIMEOUT_MS, OFFICIAL_REGISTRY } from './update.js'

const LANE_URL = 'https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json'
const PLUGINS = ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh'].map(name => `@automagik/${name}`)
const MAX_TARBALL = 64 * 1024 * 1024
const isVersion = value => typeof value === 'string' && value.trim() === value && compareVersions(value, value) === 0
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function installedPlugins(profileDir) {
  const dependencies = readJson(join(profileDir, 'package.json')).dependencies ?? {}
  if (typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('Invalid profile dependencies')
  const installed = new Map()
  for (const name of PLUGINS) {
    if (!Object.hasOwn(dependencies, name)) continue
    // The dependency spec can be a file, URL or range. Read what pnpm actually installed.
    const { version } = readJson(join(profileDir, 'node_modules', name, 'package.json'))
    if (!isVersion(version)) throw new Error('Invalid installed plugin version')
    installed.set(name, version)
  }
  return installed
}

function profileRegistry(profileDir) {
  let npmrc
  try {
    npmrc = readFileSync(join(profileDir, '.npmrc'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return OFFICIAL_REGISTRY
    throw error
  }
  const entries = [...npmrc.matchAll(/^[ \t]*registry[ \t]*=[ \t]*([^\r\n]*)/gm)]
  return entries.at(-1)?.[1].split(/[ \t]+[;#]/, 1)[0].trim().replace(/^(['"])(.*)\1$/, '$2') || OFFICIAL_REGISTRY
}

function registryPing(registry) {
  const url = new URL(registry)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
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

async function verifyTarballs(plugins, store, fetch) {
  let temp
  try {
    temp = mkdtempSync(join(store, 'check-'))
    for (const plugin of plugins) {
      const url = githubTarball(plugin.url)
      if (!url || !Number.isSafeInteger(plugin.size) || plugin.size < 1 || plugin.size > MAX_TARBALL) return 'download-failed'
      let bytes
      try {
        bytes = await boundedGet(fetch, url, { label: 'Plugin package', limit: plugin.size, signal: AbortSignal.timeout(60_000) })
      } catch {
        return 'download-failed'
      }
      writeFileSync(join(temp, `${plugin.name.split('/')[1]}.tgz`), bytes, { flag: 'wx', mode: 0o600 })
      const sha256 = typeof plugin.sha256 === 'string' ? plugin.sha256.toLowerCase() : null
      if (bytes.length !== plugin.size
        || createHash('sha256').update(bytes).digest('hex') !== sha256
        || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== plugin.integrity) return 'hash-mismatch'
    }
    return null
  } finally {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  }
}

async function runCheck({
  profileDir, env = process.env, inDesktop = inDesktopApp(), readMountInfo,
  ctx, getDshVersion = () => currentDsh(ctx), fetch = globalThis.fetch, keys = ROLE_KEYS, registry = profileRegistry,
}) {
  const view = { laneVersion: null, sequence: null, plugins: [], supervisor: supervisorOf(env) !== null }
  const result = (state, reason) => ({ version: 1, checkedAt: new Date().toISOString(), state, reason, ...view })
  if (inDesktop) return result('unavailable', 'desktop-app')

  const { storeDir, current, currentInvalid, supervisor } = selfUpdateDetails(profileDir, env, readMountInfo)
  view.supervisor = supervisor !== null
  if (storeDir === undefined) return result('unavailable', 'no-store')
  const finish = (state, reason) => {
    const record = result(state, reason)
    try {
      writeJsonAtomic(join(storeDir, 'check.json'), record, { profileDir, readMountInfo })
      return record
    } catch {
      return result('unavailable', 'no-store')
    }
  }
  if (currentInvalid) return finish('unavailable', 'store-invalid')

  let bytes, signature
  try {
    const signal = AbortSignal.timeout(15_000)
    bytes = await boundedGet(fetch, LANE_URL, { label: 'lane.json', limit: 256 * 1024, signal })
    signature = await boundedGet(fetch, `${LANE_URL}.sig`, { label: 'lane.json.sig', limit: 1024, signal })
  } catch {
    return finish('refused', 'download-failed')
  }
  let lane
  try {
    lane = verifyLane(bytes, signature.toString('utf8'), keys)
  } catch {
    return finish('refused', 'signature-invalid')
  }
  if (!isVersion(lane.version) || !Number.isSafeInteger(lane.sequence) || lane.sequence < 0 || !Array.isArray(lane.plugins)) {
    return finish('refused', 'lane-invalid')
  }
  view.laneVersion = lane.version
  view.sequence = lane.sequence
  if (lane.sequence < (current?.lastSequence ?? 0)) return finish('refused', 'sequence-lower')

  let installed
  try {
    installed = installedPlugins(profileDir)
  } catch {
    return finish('refused', 'profile-invalid')
  }
  const plugins = lane.plugins.filter(plugin => installed.has(plugin?.name))
  if (plugins.length !== installed.size || new Set(plugins.map(plugin => plugin.name)).size !== installed.size
    || plugins.some(plugin => plugin.version !== lane.version)) return finish('refused', 'lane-invalid')
  view.plugins = plugins.map(({ name, version }) => ({ name, from: installed.get(name), to: version }))
  const versions = view.plugins.map(({ from, to }) => compareVersions(to, from))
  if (!versions.some(order => order > 0)) return finish('current', 'not-newer')
  if (versions.some(order => order < 0)) return finish('refused', 'not-newer')

  let dshVersion
  try { dshVersion = await getDshVersion() } catch { return finish('refused', 'engines-dsh') }
  if (plugins.some(plugin => !satisfies(dshVersion, plugin.engines?.dsh))) return finish('refused', 'engines-dsh')

  let tarballFailure
  try {
    tarballFailure = await verifyTarballs(plugins, prepareStore(profileDir, readMountInfo), fetch)
  } catch {
    return finish('unavailable', 'no-store')
  }
  if (tarballFailure !== null) return finish('refused', tarballFailure)
  try {
    const url = registryPing(await registry(profileDir))
    await boundedGet(fetch, url, { label: 'Package registry', limit: 1024, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), allowEmpty: true })
  } catch {
    return finish('refused', 'registry-unreachable')
  }
  return finish('available', null)
}

let running
export function selfUpdateCheck(options) {
  running ??= Promise.resolve().then(() => runCheck(options)).finally(() => { running = undefined })
  return running
}

export function install(rt) {
  rt.selfUpdateCheck = () => selfUpdateCheck({ profileDir: rt.ctx.get?.('profileContext')?.dir, ctx: rt.ctx })
}
