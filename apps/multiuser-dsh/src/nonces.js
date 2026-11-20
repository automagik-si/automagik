import { randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const pendingCutoffs = new Map()
const observations = new Map()

function readWatermark(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (Number.isSafeInteger(value) && value >= 0) return value
  } catch (error) {
    if (error.code === 'ENOENT') return 0
  }
}

function watermarkError() {
  return Object.assign(new Error('caller watermark unavailable'), { code: 'CALLER_WATERMARK' })
}

function writeWatermark(file, second) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, `${second}\n`)
    } finally { closeSync(fd) }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function createNonces({ capacity = 65_536, startedAtSec = 0, anchorSec = startedAtSec, file, monotonicNow = () => performance.now() } = {}) {
  const anchorMono = monotonicNow()
  const inherited = observations.get(file)
  const observation = inherited ?? { lastWall: anchorSec, lastMono: anchorMono }
  const watermark = file ? readWatermark(file) : 0
  const failed = watermark === undefined
  if (failed) console.error(`multiuser-dsh: caller watermark unavailable: ${file}`)
  let persisted = watermark ?? 0
  let cutoff = Math.max(startedAtSec, persisted)
  let pending = pendingCutoffs.get(file)
  let verified = cutoff
  const entries = new Set()
  const expiries = []

  function observe(wall, mono) {
    const projected = observation.lastWall + (mono - observation.lastMono) / 1000
    const sharedPending = pendingCutoffs.get(file)
    if (sharedPending !== undefined) pending = Math.max(pending ?? 0, sharedPending)
    const stepped = wall + 5 < projected
    if (stepped) {
      pending = Math.max(pending ?? 0, cutoff, Math.floor(projected))
      if (file) pendingCutoffs.set(file, pending)
    }
    // Carry the projection until the floored wall catches up or a step is recorded.
    if (stepped || wall >= projected) {
      observation.lastWall = wall
      observation.lastMono = mono
    }
  }

  if (inherited) observe(anchorSec, anchorMono)
  else if (file) observations.set(file, observation)

  function insert(entry) {
    let index = expiries.length
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (expiries[parent].exp <= entry.exp) break
      expiries[index] = expiries[parent]
      index = parent
    }
    expiries[index] = entry
  }

  function removeEarliest() {
    entries.delete(expiries[0].nonce)
    const last = expiries.pop()
    if (!expiries.length) return
    let index = 0
    while (index * 2 + 1 < expiries.length) {
      const left = index * 2 + 1
      const right = left + 1
      const child = right < expiries.length && expiries[right].exp < expiries[left].exp ? right : left
      if (last.exp <= expiries[child].exp) break
      expiries[index] = expiries[child]
      index = child
    }
    expiries[index] = last
  }

  return {
    get startupSecond() { return cutoff },
    verificationSecond(wall) {
      if (failed) throw watermarkError()
      observe(wall, monotonicNow())
      verified = Math.max(verified, wall)
      const target = Math.max(verified, pending ?? 0)
      if (file && target > persisted) {
        try { writeWatermark(file, target) }
        catch { throw watermarkError() }
        persisted = target
      }
      if (pending !== undefined && (!file || persisted >= pending)) {
        cutoff = Math.max(cutoff, pending)
        if (file) pendingCutoffs.delete(file)
        pending = undefined
      }
      return verified
    },
    consume(nonce, exp) {
      while (expiries[0]?.exp <= verified) removeEarliest()
      if (entries.has(nonce)) return 'replay'
      if (entries.size >= capacity) return 'full'
      entries.add(nonce)
      insert({ nonce, exp })
      return 'ok'
    },
  }
}
