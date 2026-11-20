import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { extendsImage, readJson, releaseVersion } from './profile-state.mjs'

const LIMIT = 64 * 1024
// scripts/lane.ts PLUGINS. The server's multiuser adapter is outside the lane.
const LANE = ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh'].map(name => `@automagik/${name}`)
const PIN = /^file:vendor\/automagik-update\/[0-9a-f]{64}\.tgz$/
// The supervisor's version-1 records allow a v prefix and build metadata on kept versions.
const RECORD_VERSION = /^(?:v?\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const stat = path => lstatSync(path, { throwIfNoEntry: false })

export const updateStoreOf = profile => join(dirname(dirname(profile)), 'update', basename(profile))

export function readStoreJson(store, name) {
  try {
    for (const path of [dirname(store), store]) {
      const entry = stat(path)
      if (!entry) return { absent: true }
      if (!entry.isDirectory()) return { invalid: true }
    }
    const path = join(store, name)
    const entry = stat(path)
    if (!entry) return { absent: true }
    if (!entry.isFile() || entry.size > LIMIT) return { invalid: true }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const file = fstatSync(fd)
      if (!file.isFile() || file.size > LIMIT || file.dev !== entry.dev || file.ino !== entry.ino) return { invalid: true }
      const bytes = Buffer.alloc(LIMIT + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > LIMIT) return { invalid: true }
      return { value: JSON.parse(bytes.toString('utf8', 0, length)) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { invalid: true }
  }
}

export function updateRecovery(profile, store = updateStoreOf(profile)) {
  const { absent, value: state } = readStoreJson(store, 'state.json')
  if (absent) return 'absent'
  if (state?.version !== 1 || !['healthy', 'rolledBack', 'notUpdated'].includes(state.phase)) return 'recover'

  // Mirror the fixed plain-host launcher, which never changes after bootstrap.
  const j = state.journal
  if (j != null) {
    const tail = ['keep-lockfile', 'install-lockfile', 'install-entries', 'install-modules']
    const steps = j.steps
    const forward = state.phase === 'healthy'
    if (j.op !== 'switch' || j.pending !== null || !Array.isArray(steps) || !Array.isArray(j.done) ||
      steps[0] !== 'keep-modules' || new Set(steps).size !== steps.length ||
      !tail.every((step, i) => steps.at(i - tail.length) === step) ||
      !steps.slice(1, -tail.length).every(step => typeof step === 'string' && /^keep-archive:[0-9a-f]{64}\.tgz$/.test(step)) ||
      (forward
        ? j.undo !== undefined || (j.commitCurrent !== undefined && j.commitCurrent !== true) ||
          j.done.length !== steps.length || j.done.some((step, i) => step !== steps[i])
        : j.undo !== true || j.done.length !== 0 || j.commitCurrent !== undefined)) return 'recover'
  }
  return 'done'
}

export function signedUpdate(profile, baseline, store, { value } = readStoreJson(store, 'current.json')) {
  const { version, live, kept, lastSequence, entries, base } = value ?? {}
  if (version !== 1 || !releaseVersion(live?.version) || !Number.isSafeInteger(live.sequence) ||
    live.sequence < 0 || !Number.isSafeInteger(lastSequence) || lastSequence < live.sequence) return null
  if (kept !== null && (typeof kept?.version !== 'string' || kept.version.trim() !== kept.version ||
    !RECORD_VERSION.test(kept.version))) return null
  const plain = object => object != null && Object.getPrototypeOf(object) === Object.prototype
  if (!plain(entries) || !plain(base)) return null
  const names = Object.keys(entries)
  if (!names.length || names.length > LANE.length || names.length !== Object.keys(base).length ||
    !names.every(name => LANE.includes(name) && Object.hasOwn(base, name) &&
      typeof entries[name] === 'string' && PIN.test(entries[name]) &&
      typeof base[name] === 'string' && base[name].length > 0 && base[name].length <= 512)) return null

  const pkg = readJson(join(profile, 'package.json'))
  if (!plain(pkg?.dependencies) || LANE.some(name => Object.hasOwn(pkg.dependencies, name) && !Object.hasOwn(entries, name))) return null
  try {
    for (const name of names) {
      const pin = entries[name]
      if (pkg.dependencies[name] !== pin ||
        readJson(join(profile, 'node_modules', name, 'package.json'))?.version !== live.version ||
        !stat(join(profile, pin.slice('file:'.length)))?.isFile()) return null
    }
  } catch {
    return null
  }
  const original = { ...pkg, dependencies: { ...pkg.dependencies, ...base } }
  return extendsImage(original, baseline) ? live.version : null
}
