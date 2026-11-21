import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { reinstallIntent } from './reinstall-intent.js'
import { isId, isTimestamp } from './records.js'
import { identity, sameEntry } from './store.js'

const REQUEST_KEYS = ['version', 'requestId', 'bootId', 'requestedAt']
const REQUEST_TTL_MS = 60_000

export function requestOf(value, bootId, now = Date.now()) {
  if (value?.version !== 1 || !isId(bootId) || value.bootId !== bootId
    || !isId(value.requestId) || value.requestId.includes(bootId)
    || !isTimestamp(value.requestedAt)
    || !REQUEST_KEYS.every(key => Object.hasOwn(value, key))) return null
  const age = now - Date.parse(value.requestedAt)
  if (age < 0 || age >= REQUEST_TTL_MS) return null
  const count = Object.keys(value).length
  if (count === REQUEST_KEYS.length) return value
  const reinstall = count === REQUEST_KEYS.length + 1 && Object.hasOwn(value, 'reinstall') && reinstallIntent(value.reinstall)
  return reinstall ? { ...value, reinstall } : null
}

// Use the file we inspected. A new atomic publish can be picked up on the next poll.
export function takeRequest(store, read, bootId, active, seen) {
  const path = join(store, 'request.json')
  const entry = identity(path)
  if (!entry || entry.isDirectory()) return null
  const request = requestOf(read('request.json'), bootId)
  if (!sameEntry(entry, identity(path))) return null
  try { unlinkSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (request === null || seen.has(request.requestId)) return null
  seen.add(request.requestId)
  return active ? null : request
}
