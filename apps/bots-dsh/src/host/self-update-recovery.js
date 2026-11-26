// The Bots plugin owns this record. The supervisor's verdict and rollback files stay independent.
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isId } from './supervisor/records.js'
import { readJson, usableStore, writeJsonAtomic } from './supervisor/store.js'

const canResume = new Set(['healthy', 'rolledBack', 'notUpdated'])
const kinds = new Set(['turn', 'delivery', 'input'])
const states = new Set(['pending', 'resumed', 'failed'])
const countStates = [...states, 'unconfirmed']
const maxItems = 100
const maxBytes = 60 * 1024
const text = value => typeof value === 'string' && value.length > 0
const fileOf = run => `work-recovery-${run.runId}.json`
const validRun = run => isId(run?.runId) && isId(run.requestId) && canResume.has(run.phase)

function recordOf(profileDir, run) {
  if (!validRun(run)) return null
  const store = () => usableStore(profileDir)
  const record = readJson(store, store(), fileOf(run))
  if (record?.version !== 1 || record.runId !== run.runId || record.requestId !== run.requestId
    || (record.inventoryUnconfirmed !== undefined && record.inventoryUnconfirmed !== true)
    || typeof record.complete !== 'boolean' || !Array.isArray(record.items)
    || !record.items.every(item => kinds.has(item?.kind) && text(item.id) && text(item.sessionId)
      && text(item.name) && states.has(item.state) && !(record.complete && item.state === 'pending'))) return null
  const { omitted } = record
  if (omitted !== undefined && (!omitted || !countStates.every(state => Number.isSafeInteger(omitted[state])
    && omitted[state] >= 0) || (record.complete && omitted.pending !== 0))) return null
  return record
}

export function readUpdateRecovery(profileDir, run) {
  const record = recordOf(profileDir, run)
  if (!record) return null
  const { runId, requestId, complete, items, omitted, inventoryUnconfirmed } = record
  return { runId, requestId, complete, items: items.map(({ kind, sessionId, name, state }) => ({ kind, sessionId, name, state })),
    ...(inventoryUnconfirmed ? { inventoryUnconfirmed } : {}),
    ...(omitted ? { omitted: Object.fromEntries(countStates.map(state => [state, omitted[state]])) } : {}) }
}

const keyOf = (kind, id) => `${kind}:${id}`

export function startUpdateRecovery({ profileDir, run, items, inventoryReadable = true, ownsTeam, currentRun, warn }) {
  const canWrite = () => {
    if (!ownsTeam()) return false
    const current = currentRun()
    return validRun(current) && current.runId === run.runId && current.requestId === run.requestId
  }
  if (!validRun(run) || !canWrite()) return null
  const store = usableStore(profileDir)
  if (store === undefined) return null
  const file = fileOf(run)
  const path = join(store, file)
  let warned = false
  const warnOnce = error => {
    if (!warned) warn('ds-bot: saving the update work summary failed: %s', error?.message ?? error)
    warned = true
  }
  const prune = () => {
    if (!canWrite()) return
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      const id = /^work-recovery-(.+)\.json$/.exec(entry.name)?.[1]
      if (entry.name !== file && entry.isFile() && isId(id)) unlinkSync(join(store, entry.name))
    }
  }
  const previous = recordOf(profileDir, run)
  // The next boot may read notes rewritten by a boot that could not read the original inventory.
  const inventoryUnconfirmed = previous?.inventoryUnconfirmed === true || !inventoryReadable
  const notedKeys = new Set(items.map(({ kind, id }) => keyOf(kind, id)))
  const work = new Map()
  for (const { kind, id, sessionId, name, state = 'pending' } of previous?.items ?? items) {
    if (kinds.has(kind) && text(id) && text(sessionId) && text(name)) {
      const key = keyOf(kind, id)
      const retry = state === 'failed' && notedKeys.has(key)
      work.set(key, { kind, id, sessionId, name, state: retry ? 'pending' : state })
    }
  }
  if (previous?.complete && Boolean(previous.inventoryUnconfirmed) === inventoryUnconfirmed
    && ![...work.values()].some(item => item.state === 'pending')) {
    try { prune() } catch (error) { warnOnce(error) }
    return null
  }
  const listed = []
  const header = { version: 1, runId: run.runId, requestId: run.requestId,
    ...(inventoryUnconfirmed ? { inventoryUnconfirmed } : {}) }
  const omitted = Object.fromEntries(countStates.map(state => [state, previous?.omitted?.[state] ?? 0]))
  let unboundPending = omitted.pending
  // Reserve bytes for the largest count and state encodings, including JSON escaping.
  let bytes = Buffer.byteLength(JSON.stringify({ ...header, complete: false, items: [],
    omitted: Object.fromEntries(countStates.map(state => [state, Number.MAX_SAFE_INTEGER])),
  }))
  for (const [key, item] of work) {
    const size = Buffer.byteLength(JSON.stringify({ ...item, state: 'pending' })) + 1
    if (listed.length < maxItems && bytes + size <= maxBytes) {
      bytes += size
      listed.push(item)
    } else {
      omitted[item.state] += 1
      work.set(key, { state: item.state })
    }
  }
  const resolve = (item, state) => {
    if (!item.id) {
      omitted.pending -= 1
      omitted[state] += 1
    }
    item.state = state
  }

  let saved = previous !== null
  let pruned = false
  const save = complete => {
    if (!canWrite() || (saved && !existsSync(path))) return
    try {
      writeJsonAtomic(path, {
        ...header, complete, items: listed,
        ...(Object.values(omitted).some(Boolean) ? { omitted } : {}),
      }, { profileDir, durable: true })
      saved = true
      if (!pruned) {
        prune()
        pruned = true
      }
    } catch (error) {
      if (error?.renamed) saved = true
      warnOnce(error)
    }
  }
  save(false)
  return {
    resumed(kind, id) {
      const item = work.get(keyOf(kind, id))
      if (item?.state !== 'pending') return
      resolve(item, 'resumed')
      save(false)
    },
    finish() {
      let complete = true
      for (const [key, item] of work) {
        if (item.state !== 'pending') continue
        if (inventoryUnconfirmed && !notedKeys.has(key)) complete = false
        else resolve(item, 'failed')
      }
      // The previous process persisted counts for omitted work without its identities.
      // Its pending items cannot be matched to receipts after a second restart.
      omitted.pending -= unboundPending
      omitted.unconfirmed += unboundPending
      unboundPending = 0
      save(complete)
    },
  }
}
