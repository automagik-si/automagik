import { randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function readWatermark(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (Number.isSafeInteger(value) && value >= 0) return value
  } catch {}
  return 0
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

export function createNonces({ capacity = 65_536, startedAtSec = 0, file } = {}) {
  const startupSecond = Math.max(startedAtSec, file ? readWatermark(file) : 0)
  let nowSec = startupSecond
  const entries = new Set()
  const expiries = []

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
    startupSecond,
    verificationSecond(wallSecond) {
      if (wallSecond > nowSec) {
        // Record time before verification can admit an assertion or prune a nonce.
        if (file) writeWatermark(file, wallSecond)
        nowSec = wallSecond
      }
      return nowSec
    },
    consume(nonce, exp) {
      while (expiries[0]?.exp <= nowSec) removeEarliest()
      if (entries.has(nonce)) return 'replay'
      if (entries.size >= capacity) return 'full'
      entries.add(nonce)
      insert({ nonce, exp })
      return 'ok'
    },
  }
}
