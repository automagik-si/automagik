import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { inDesktopApp } from './constants.js'
import { currentDsh } from './dsh-update.js'
import { compareVersions, satisfies, verifyLane } from './lane-verify.js'
import { boundedGet, ROLE_KEYS } from './role-catalog.js'
import { refusal } from './refusal.js'
import { prepareStore, readCheckRecord, REASON_CODES, selfUpdateDetails, supervisorOf, writeJsonAtomic } from './self-update.js'
import { FETCH_TIMEOUT_MS, OFFICIAL_REGISTRY, registryPlan } from './update.js'

const LANE_URL = 'https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json'
const PLUGINS = ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh'].map(name => `@automagik/${name}`)
const MAX_TARBALL = 64 * 1024 * 1024
const REPLY_WAIT_MS = 5000
const LOCK_TTL_MS = 15 * 60_000
const MARKER = 'check.running.json'
export const CHECK_READ_ONLY = 'This window does not hold the team, so it cannot report updates.'
const readOnly = () => refusal(CHECK_READ_ONLY, { code: 'bot/read-only' })
const isVersion = value => typeof value === 'string' && value.trim() === value && compareVersions(value, value) === 0
const interrupted = runId => ({ state: 'interrupted', runId })
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
  const override = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
  if (override) return override
  let npmrc
  try {
    npmrc = readFileSync(join(profileDir, '.npmrc'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return OFFICIAL_REGISTRY
    throw error
  }
  const entries = [...npmrc.matchAll(/^[ \t]*registry[ \t]*=[ \t]*([^\r\n]*)/gm)]
  const setting = entries.at(-1)?.[1].split(/[ \t]+[;#]/, 1)[0].trim().replace(/^(['"])(.*)\1$/, '$2')
  let missing = false
  const expanded = setting?.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const value = process.env[name]
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

const identity = path => lstatSync(path, { bigint: true, throwIfNoEntry: false })
const sameEntry = (a, b) => a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino

function readOwner(path, entry) {
  if (!entry?.isFile()) return null
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!sameEntry(fstatSync(fd, { bigint: true }), entry)) return null
      const bytes = Buffer.alloc(1025)
      const length = readSync(fd, bytes, 0, bytes.length, null)
      if (length === bytes.length) return null
      return JSON.parse(bytes.toString('utf8', 0, length))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function ownerIsDead(owner, host) {
  if (owner?.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function takeCheckLock(store, owner) {
  const path = join(store, 'check.lock')
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const entry = identity(path)
      if (entry === undefined) continue
      if (!entry.isFile()) throw new Error('Invalid check lock')
      const holder = readOwner(path, entry)
      const startedAt = typeof holder?.startedAt === 'number' ? holder.startedAt : Date.parse(holder?.startedAt)
      // A contender can see the file before its owner has finished writing it.
      const age = Date.now() - (Number.isFinite(startedAt) ? startedAt : Number(entry.mtimeNs / 1_000_000n))
      if (age <= LOCK_TTL_MS && !ownerIsDead(holder, owner.host)) return null
      const current = identity(path)
      if (sameEntry(current, entry) && current.ctimeNs === entry.ctimeNs) rmSync(path, { force: true })
      continue
    }

    const created = fstatSync(fd, { bigint: true })
    const owns = () => sameEntry(identity(path), created)
    const release = () => {
      try {
        if (owns()) rmSync(path, { force: true })
      } finally {
        closeSync(fd)
      }
    }
    try {
      writeFileSync(fd, JSON.stringify(owner))
    } catch (error) {
      release()
      throw error
    }
    return { owns, release }
  }
  return null
}

function reclaimChecks(store, host, requireAccess) {
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.name.startsWith('check-') || !entry.isDirectory()) continue
    const folder = join(store, entry.name)
    const created = identity(folder)
    if (!created?.isDirectory()) continue
    const marker = join(folder, MARKER)
    const owner = readOwner(marker, identity(marker))
    if (owner?.version !== 1 || `check-${owner.runId}` !== entry.name || !ownerIsDead(owner, host)) continue
    requireAccess()
    if (sameEntry(identity(folder), created)) rmSync(folder, { recursive: true, force: true })
  }
}

function checkFolder(folder) {
  mkdirSync(folder, { mode: 0o700 })
  const created = identity(folder)
  if (!created?.isDirectory()) throw new Error('Invalid check directory')
  return () => {
    const entry = identity(folder)
    if (!entry?.isDirectory() || !sameEntry(entry, created)) throw new Error('Check directory changed')
  }
}

async function verifyTarballs(plugins, folder, fetch, requireAccess) {
  for (const plugin of plugins) {
    requireAccess()
    const url = githubTarball(plugin.url)
    if (!url || !Number.isSafeInteger(plugin.size) || plugin.size < 1 || plugin.size > MAX_TARBALL) return 'download-failed'
    let bytes
    try {
      bytes = await boundedGet(fetch, url, { label: 'Plugin package', limit: plugin.size, signal: AbortSignal.timeout(60_000) })
    } catch {
      return 'download-failed'
    }
    requireAccess()
    folder.assertIdentity()
    writeFileSync(join(folder.path, `${plugin.name.split('/')[1]}.tgz`), bytes, { flag: 'wx', mode: 0o600 })
    const sha256 = typeof plugin.sha256 === 'string' ? plugin.sha256.toLowerCase() : null
    if (bytes.length !== plugin.size
      || createHash('sha256').update(bytes).digest('hex') !== sha256
      || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== plugin.integrity) return 'hash-mismatch'
  }
  return null
}

async function inspectRelease({
  profileDir, current, view, result, getDshVersion, fetch, laneUrl, keys, registry, folder, requireAccess,
}) {
  const laneFetch = laneUrl.protocol === 'file:'
    ? (url, { signal }) => new Response(Readable.toWeb(createReadStream(new URL(url), { signal })))
    : fetch
  let bytes, signature
  try {
    const signal = AbortSignal.timeout(15_000)
    bytes = await boundedGet(laneFetch, laneUrl.href, { label: 'lane.json', limit: 256 * 1024, signal })
    requireAccess()
    signature = await boundedGet(laneFetch, `${laneUrl.href}.sig`, { label: 'lane.json.sig', limit: 1024, signal })
  } catch {
    return result('refused', 'download-failed')
  }
  let lane
  try {
    lane = verifyLane(bytes, signature.toString('utf8'), keys)
  } catch {
    return result('refused', 'signature-invalid')
  }
  if (!isVersion(lane.version) || !Number.isSafeInteger(lane.sequence) || lane.sequence < 0 || !Array.isArray(lane.plugins)) {
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
    || plugins.some(plugin => plugin.version !== lane.version)) return result('refused', 'lane-invalid')
  view.plugins = plugins.map(({ name, version }) => ({ name, from: installed.get(name), to: version }))
  const versions = view.plugins.map(({ from, to }) => compareVersions(to, from))
  if (!versions.some(order => order > 0)) return result('current', 'not-newer')
  if (versions.some(order => order < 0)) return result('refused', 'not-newer')

  let dshVersion
  try { dshVersion = await getDshVersion() } catch { return result('refused', 'engines-dsh') }
  if (plugins.some(plugin => !satisfies(dshVersion, plugin.engines?.dsh))) return result('refused', 'engines-dsh')

  const tarballFailure = await verifyTarballs(plugins, folder, fetch, requireAccess)
  if (tarballFailure !== null) return result('refused', tarballFailure)
  try {
    requireAccess()
    const url = registryPing(await registry(profileDir))
    requireAccess()
    await boundedGet(fetch, url, { label: 'Package registry', limit: 1024, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), allowEmpty: true })
  } catch {
    return result('refused', 'registry-unreachable')
  }
  return result('available', null)
}

function checkResult(runId, env, state, reason) {
  return {
    version: 1, runId, checkedAt: new Date().toISOString(), state, reason,
    laneVersion: null, sequence: null, plugins: [], supervisor: supervisorOf(env) !== null,
  }
}

async function runCheck({
  profileDir, env, inDesktop = inDesktopApp(), readMountInfo,
  ctx, getDshVersion = () => currentDsh(ctx), fetch = globalThis.fetch, laneUrl, keys,
  registry = async dir => (await registryPlan({}, ctx?.get?.('pluginManager'), () => profileRegistry(dir)))[0],
}, run) {
  const { runId, ownsTeam } = run
  const requireTeam = () => { if (!ownsTeam()) throw readOnly() }
  requireTeam()
  const unavailable = reason => (run.unpublished = checkResult(runId, env, 'unavailable', reason))
  if (inDesktop) return unavailable('desktop-app')

  const owner = { pid: process.pid, host: hostname(), startedAt: Date.now() }
  const storeOptions = { profileDir, readMountInfo }
  let store, lock
  try {
    store = prepareStore(profileDir, readMountInfo)
    lock = takeCheckLock(store, owner)
  } catch {
    return unavailable('no-store')
  }
  if (lock === null) return { state: 'checking' }
  run.ownsStore = lock.owns

  const requireAccess = () => {
    requireTeam()
    if (!lock.owns()) throw new Error('Check lock changed')
  }
  try {
    const { current, currentInvalid, supervisor } = selfUpdateDetails(profileDir, env, readMountInfo)
    const view = { laneVersion: null, sequence: null, plugins: [], supervisor: supervisor !== null }
    const result = (state, reason) => ({
      version: 1, runId, checkedAt: new Date().toISOString(), state, reason, ...view,
    })
    let record = result('unavailable', 'store-invalid')
    let folder
    try {
      requireAccess()
      reclaimChecks(store, owner.host, requireAccess)
      if (!currentInvalid) {
        const path = join(store, `check-${runId}`)
        requireAccess()
        folder = { path, assertIdentity: checkFolder(path) }
        folder.assertIdentity()
        writeFileSync(join(path, MARKER), JSON.stringify({ version: 1, runId, ...owner }), { flag: 'wx', mode: 0o600 })
        record = await inspectRelease({ profileDir, current, view, result, getDshVersion, fetch, laneUrl, keys, registry, folder, requireAccess })
      }
    } catch {
      record = result('unavailable', 'no-store')
    } finally {
      try {
        if (folder && lock.owns()) {
          folder.assertIdentity()
          rmSync(folder.path, { recursive: true, force: true })
        }
      } catch {
        record = result('unavailable', 'no-store')
      }
    }
    requireTeam()
    if (!lock.owns()) return interrupted(runId)
    try {
      writeJsonAtomic(join(store, 'check.json'), record, storeOptions)
      return record
    } catch {
      return unavailable('no-store')
    }
  } finally {
    run.ownsStore = undefined
    lock.release()
  }
}

const running = new Map()

function startCheck(options, ownsTeam = () => true) {
  const laneUrl = URL.parse(options.laneUrl ?? LANE_URL)
  const isFile = laneUrl?.protocol === 'file:' && !laneUrl.host && !laneUrl.search && !laneUrl.hash
  const refuseLane = () => {
    const runId = randomUUID()
    const unpublished = checkResult(runId, options.env, 'refused', 'signature-invalid')
    return { runId, ownsTeam, unpublished, completed: true, promise: Promise.resolve(unpublished) }
  }
  if (!isFile && (laneUrl?.href !== LANE_URL || options.keys !== undefined)) return refuseLane()

  const { profileDir } = options
  const keys = isFile ? options.keys ?? ROLE_KEYS : ROLE_KEYS
  const active = running.get(profileDir)
  if (active?.ownsTeam() && active.ownsStore?.() !== false) {
    if (active.lane === laneUrl.href && active.keys === keys) return active
    return refuseLane()
  }

  const run = { runId: randomUUID(), ownsTeam, lane: laneUrl.href, keys }
  const inputs = { ...options, laneUrl, keys }
  run.promise = Promise.resolve().then(async () => {
    try {
      const result = await runCheck(inputs, run)
      run.completed = true
      return result
    } finally {
      if (running.get(profileDir) === run) running.delete(profileDir)
    }
  })
  running.set(profileDir, run)
  return run
}

export function selfUpdateCheck(options) {
  return startCheck(options).promise
}

function savedResult(profileDir) {
  const record = readCheckRecord(profileDir)
  if (record?.version !== 1) return null
  const { runId, checkedAt, state, reason, laneVersion, sequence, supervisor, plugins } = record
  if (typeof runId !== 'string' || runId === '' || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))
    || new Date(checkedAt).toISOString() !== checkedAt
    || !['available', 'current', 'refused', 'unavailable'].includes(state)
    || (reason !== null && !REASON_CODES.includes(reason))
    || (laneVersion !== null && !isVersion(laneVersion))
    || (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0))
    || typeof supervisor !== 'boolean' || !Array.isArray(plugins) || plugins.length > PLUGINS.length
    || plugins.some(plugin => !PLUGINS.includes(plugin?.name) || !isVersion(plugin.from) || !isVersion(plugin.to))) return null
  return {
    version: 1, runId, checkedAt, state, reason, laneVersion, sequence, supervisor,
    plugins: plugins.map(({ name, from, to }) => ({ name, from, to })),
  }
}

export function install(rt) {
  const profileOf = () => rt.ctx.get?.('profileContext')?.dir
  let lastRun
  rt.selfUpdateCheck = async () => {
    const profileDir = profileOf()
    const generation = rt.teamGeneration()
    const run = startCheck({ profileDir, ctx: rt.ctx }, () => rt.sameTeam(generation))
    lastRun = { profileDir, run }
    const { promise, runId } = run
    let timer
    try {
      const pending = new Promise(resolve => {
        timer = setTimeout(() => resolve({ state: 'checking', runId }), REPLY_WAIT_MS)
      })
      const reply = await Promise.race([promise, pending])
      if (!run.ownsTeam() || !rt.sameTeam(generation)) throw readOnly()
      return reply
    } finally {
      clearTimeout(timer)
    }
  }
  rt.selfUpdateCheckResult = runId => {
    const profileDir = profileOf()
    const active = running.get(profileDir)
    if (active) {
      if (active.runId !== runId || active.ownsStore?.() === false) return interrupted(runId)
      if (!active.ownsTeam()) throw readOnly()
      return { state: 'checking', runId }
    }
    const previous = lastRun?.profileDir === profileDir ? lastRun.run : undefined
    if (previous?.runId === runId) {
      if (!previous.ownsTeam() && !previous.completed) throw readOnly()
      if (previous.unpublished) return previous.unpublished
    }
    const saved = savedResult(profileDir)
    return saved?.runId === runId ? saved : interrupted(runId)
  }
}
