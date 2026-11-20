import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { inDesktopApp } from './constants.js'
import { currentDsh } from './dsh-update.js'
import { refusal } from './refusal.js'
import { prepareStore, readCheckRecord, REASON_CODES, selfUpdateDetails, supervisorOf, writeJsonAtomic } from './self-update.js'
import { registryPlan } from './update.js'
import { installRegistry } from './supervisor/pnpm.js'
import { inspectRelease, isLaneVersion, PLUGINS, profileRegistry, registryOnlyNpmrc, releaseSource } from './supervisor/release.js'
import { identity, ownerIsDead, readOwner, sameEntry, takeOwnerLock } from './supervisor/store.js'

const REPLY_WAIT_MS = 5000
const LOCK_TTL_MS = 15 * 60_000
const MARKER = 'check.running.json'
export const CHECK_READ_ONLY = 'This window does not hold the team, so it cannot report updates.'
const readOnly = () => refusal(CHECK_READ_ONLY, { code: 'bot/read-only' })
const interrupted = runId => ({ state: 'interrupted', runId })

function reclaimChecks(store, host, requireAccess) {
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.name.startsWith('check-') || !entry.isDirectory()) continue
    const folder = join(store, entry.name)
    const created = identity(folder)
    if (!created?.isDirectory()) continue
    const marker = join(folder, MARKER)
    const owner = readOwner(marker, identity(marker))
    // A replaced container's folder keeps its run marker and verified release tarballs
    // until a check runs on a host with the same name and confirms the owner is dead.
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

function checkResult(runId, env, state, reason) {
  return {
    version: 1, runId, checkedAt: new Date().toISOString(), state, reason,
    laneVersion: null, sequence: null, plugins: [], supervisor: supervisorOf(env) !== null,
  }
}

async function runCheck({
  profileDir, env, inDesktop = inDesktopApp(), readMountInfo,
  ctx, getDshVersion = () => currentDsh(ctx), fetch = globalThis.fetch, source,
  registry = async dir => {
    const manager = ctx?.get?.('pluginManager')
    if (!supervisorOf(env)) return (await registryPlan({}, manager, () => profileRegistry(dir)))[0]
    const effective = await installRegistry(dir)
    let configured
    try { configured = (await manager?.registries?.())?.registry } catch {}
    if (configured && configured.trim().replace(/\/+$/, '') + '/' !== effective) {
      throw new Error('The plugin manager and the supervised install use different registries')
    }
    return effective
  },
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
    lock = takeOwnerLock(join(store, 'check.lock'), owner, LOCK_TTL_MS)
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
        const { state, reason } = await inspectRelease({
          profileDir, current, view, getDshVersion, fetch, source, registry: dir => {
            // A manager-provided registry still cannot make the staging profile reproduce other npmrc settings.
            registryOnlyNpmrc(dir)
            return registry(dir)
          },
          requireAccess,
          saveTarball: (plugin, bytes) => {
            folder.assertIdentity()
            writeFileSync(join(path, `${plugin.name.split('/')[1]}.tgz`), bytes, { flag: 'wx', mode: 0o600 })
          },
        })
        record = result(state, reason)
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
  const source = releaseSource(options.laneUrl ?? undefined, options.keys)
  const refuseLane = () => {
    const runId = randomUUID()
    const unpublished = checkResult(runId, options.env, 'refused', 'signature-invalid')
    return { runId, ownsTeam, unpublished, completed: true, promise: Promise.resolve(unpublished) }
  }
  if (!source) return refuseLane()
  const { laneUrl, keys } = source

  const { profileDir } = options
  const active = running.get(profileDir)
  if (active?.ownsTeam() && active.ownsStore?.() !== false) {
    if (active.lane === laneUrl.href && active.keys === keys) return active
    return refuseLane()
  }

  const run = { runId: randomUUID(), ownsTeam, lane: laneUrl.href, keys }
  const inputs = { ...options, source }
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
    || (laneVersion !== null && !isLaneVersion(laneVersion))
    || (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0))
    || typeof supervisor !== 'boolean' || !Array.isArray(plugins) || plugins.length > PLUGINS.length
    || plugins.some(plugin => !PLUGINS.includes(plugin?.name) || !isLaneVersion(plugin.from) || !isLaneVersion(plugin.to))) return null
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
