import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tracing } from '../bw/run.js'
import { createLifecycle, untilAbort } from '../lifecycle.js'
import { classify, fail, FIELDS, json, pickerFields, protonPass, selectField, success, validConnection, validId, validToken } from './parse.js'
import { runPass } from './run.js'

const timeouts = { version: 5000, login: 15000, list: 10000, read: 10000, logout: 3000 }
const sessionMs = 110 * 60 * 1000
const retirementMs = 4000
const prefix = 'automagik-proton-pass-'
const versionPattern = /^Proton Pass CLI 2\.7\.1 \([^)\n]*\)\r?\n?$/
const loginSuccess = 'Personal access token session created successfully'
export const cloudProfile = () => Boolean(process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim())

function sweep(root) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const match = /^automagik-proton-pass-([1-9]\d*)-[A-Za-z0-9]+$/.exec(entry.name)
    if (!entry.isDirectory() || !match) continue
    try { process.kill(Number(match[1]), 0) }
    catch (error) {
      if (error.code !== 'ESRCH') continue
      const dir = join(root, entry.name)
      try {
        const info = lstatSync(dir)
        if (info.isDirectory() && (process.getuid === undefined || info.uid === process.getuid())) {
          rmSync(dir, { recursive: true, force: true })
        }
      } catch {}
    }
  }
}

export function createProtonPass({ idleLockMinutes = 5 } = {}, {
  run = runPass, timers = globalThis, root = tmpdir(),
} = {}) {
  sweep(root)
  const live = new Set()
  const pending = new Set()
  let disposed = false
  const state = createLifecycle({ idleLockMinutes, timers, run, timeouts, onIdle: lock })
  const { child, invalidate, reads, lifecycle } = state

  async function version(signal, record, limit) {
    const result = await child(['--version'], 'version', signal, { record, limit })
    if (result.failure !== undefined) return fail('unavailable')
    return success(result) && versionPattern.exec(result.stdout)?.[0] === result.stdout ? { ok: true } : fail('version')
  }

  function removeRecord(record) {
    try { rmSync(record.dir, { recursive: true, force: true }) }
    catch { pending.add(record); return false }
    pending.delete(record)
    return true
  }

  function retireRecord(record, closing, start) {
    record.retirement ??= (async () => {
      const remaining = () => retirementMs - (performance.now() - start)
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), Math.max(0, remaining()))
      try {
        await untilAbort(closing, deadline.signal)
        if (!deadline.signal.aborted && remaining() >= 1000 && record.key !== undefined && !tracing() && !cloudProfile()) {
          const checked = await untilAbort(version(deadline.signal, record, remaining() - 500), deadline.signal)
          if (checked?.ok && !deadline.signal.aborted && remaining() >= 1000) {
            await untilAbort(child(['logout'], 'logout', deadline.signal, { record, limit: remaining() - 500 }), deadline.signal)
          }
        }
      } catch {
        // CLI retirement is best effort. Local removal decides the result.
      } finally {
        clearTimeout(timer)
        live.delete(record)
        record.key = undefined
      }
      return removeRecord(record)
    })()
    return record.retirement
  }

  async function retire(closing, start) {
    const retried = [...pending].map(removeRecord)
    const retired = await Promise.all([...live].map(record => retireRecord(record, closing, start)))
    return [...retried, ...retired].every(Boolean)
  }

  function lock() {
    const start = performance.now()
    const retiring = retire(invalidate(), start)
    // Invalidation and the snapshot happen now. A later unlock queues behind removal.
    void lifecycle(() => retiring)
    return retiring
  }

  function currentRecord() {
    const record = state.credential
    if (record !== undefined && Date.now() >= record.expires) {
      void lock()
      return undefined
    }
    return record
  }

  async function status() {
    if (cloudProfile()) throw Object.assign(new Error('Proton Pass is unavailable in Automagik Cloud.'), { code: 'cloud' })
    const record = currentRecord()
    const signal = state.signal
    if (!disposed) {
      const checked = await version(signal, record)
      if (checked.ok && !signal.aborted) return { state: currentRecord() === undefined ? 'locked' : 'unlocked' }
      if (checked.code === 'version' && !signal.aborted && record !== undefined) await lock()
    }
    throw new Error('The vault did not answer.')
  }

  async function vaults(signal, record) {
    const answer = json(await child(['vault', 'list', '--output', 'json'], 'list', signal, { record }))
    if (!answer.ok) return answer
    return Array.isArray(answer.value?.vaults) ? { ok: true, vaults: answer.value.vaults } : fail('refused')
  }

  function unlock({ token, connection, signal: caller } = {}) {
    if (cloudProfile()) return Promise.resolve(fail('cloud'))
    if (!validToken(token) || !validConnection(connection) || tracing()) return Promise.resolve(fail('refused'))
    if (disposed || caller?.aborted) return Promise.resolve(fail('locked'))
    const start = performance.now()
    const closing = invalidate()
    const signal = caller === undefined ? state.signal : AbortSignal.any([caller, state.signal])
    return lifecycle(async () => {
      if (disposed || signal.aborted) return fail('locked')
      if (!await retire(closing, start)) return fail(signal.aborted ? 'locked' : 'unavailable')
      if (signal.aborted) return fail('locked')
      const checked = await untilAbort(version(signal), signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) return checked
      let record, pendingChild
      try {
        const dir = mkdtempSync(join(root, prefix + process.pid + '-'))
        record = { dir, home: join(dir, 'home') }
        live.add(record)
        mkdirSync(record.home, { mode: 0o700 })
        record.id = randomUUID()
        record.key = randomBytes(32).toString('base64url')
        let login
        try {
          record.expires = Date.now() + sessionMs
          pendingChild = child(['login'], 'login', signal, { record, token })
          login = await untilAbort(pendingChild, signal)
        }
        finally { token = undefined }
        if (signal.aborted) return fail('locked')
        if (!success(login)) return fail(classify(login))
        if (!login.stdout.split(/\r?\n/).includes(loginSuccess)) return fail('refused')
        login = undefined
        pendingChild = vaults(signal, record)
        const listed = await untilAbort(pendingChild, signal)
        if (signal.aborted) return fail('locked')
        if (!listed.ok) return listed
        if (Date.now() >= record.expires) return fail('locked')
        state.set(record, protonPass, record.expires - Date.now())
        return { ok: true }
      } catch { return fail('unavailable') }
      finally {
        if (record !== undefined && state.credential !== record) {
          if (record.retirement !== undefined) await record.retirement
          else await retireRecord(record, Promise.allSettled([pendingChild]), performance.now())
        }
      }
    }).finally(() => { token = undefined })
  }

  async function authenticated(connection, caller, operation, renew = false) {
    if (cloudProfile()) return fail('cloud')
    const record = currentRecord()
    if (record === undefined) return fail('locked')
    if (connection !== protonPass || tracing()) return fail('refused')
    const current = state.signal
    const signal = caller === undefined ? current : AbortSignal.any([caller, current])
    const cancelled = () => fail(current.aborted ? 'locked' : 'refused')
    const job = reads(async () => {
      if (signal.aborted || currentRecord() !== record) return cancelled()
      const checked = await version(signal, record)
      if (signal.aborted || currentRecord() !== record) return cancelled()
      if (!checked.ok) {
        if (checked.code === 'version') await lock()
        return checked
      }
      const result = await operation(signal, record)
      if (signal.aborted || currentRecord() !== record) return cancelled()
      if (result.code === 'auth') await lock()
      if (result.ok && renew) state.renewIdle(record.expires - Date.now())
      return result
    })
    const answer = caller === undefined ? await job : await untilAbort(job, caller)
    return answer === undefined || (answer.ok && (signal.aborted || currentRecord() !== record)) ? cancelled() : answer
  }

  function read(ref, { signal } = {}) {
    if (cloudProfile()) return fail('cloud')
    const { provider, connection, item, field } = ref ?? {}
    if (provider !== protonPass || typeof item !== 'string') return fail('refused')
    const [share, id, ...extra] = item.split('/')
    if (extra.length || !validId(share) || !validId(id)) return fail('refused')
    if (!FIELDS.has(field)) return fail('field')
    return authenticated(connection, signal, async (childSignal, record) => {
      const args = ['item', 'view', '--share-id=' + share, '--item-id=' + id, '--output', 'json']
      return selectField(await child(args, 'read', childSignal, { record }), share, id, field)
    }, true)
  }

  async function listItems({ connection, search = '', signal: caller } = {}) {
    if (cloudProfile()) return fail('cloud')
    if (typeof search !== 'string' || search.includes('\0')) return fail('refused')
    const query = search.toLowerCase()
    const deadline = new AbortController()
    const signal = caller === undefined ? deadline.signal : AbortSignal.any([caller, deadline.signal])
    const timer = timers.setTimeout(() => deadline.abort(), timeouts.list)
    try {
      const result = await authenticated(connection, signal, async (childSignal, record) => {
        const available = await vaults(childSignal, record)
        if (!available.ok) return available
        const items = []
        for (const vault of available.vaults) {
          if (childSignal.aborted) return fail('unavailable')
          const share = vault?.share_id
          if (!validId(share) || typeof vault.name !== 'string') continue
          const args = ['item', 'list', '--share-id=' + share, '--filter-state', 'active', '--output', 'json']
          const listed = json(await child(args, 'list', childSignal, { record }))
          if (!listed.ok) return listed
          if (!Array.isArray(listed.value?.items)) return fail('refused')
          for (const row of listed.value.items) {
            if (!validId(row?.id) || row.share_id !== share || typeof row.item_type !== 'string'
              || typeof row.title !== 'string' || !row.title.toLowerCase().includes(query)) continue
            items.push({ id: share + '/' + row.id, name: row.title, vault: vault.name, fields: pickerFields(row.item_type) })
            if (items.length === 50) return { ok: true, items }
          }
        }
        return { ok: true, items }
      })
      return deadline.signal.aborted ? fail('unavailable') : result
    } finally { timers.clearTimeout(timer) }
  }

  return {
    status, unlock, lock, retire: lock, read, listItems,
    async prepareQuit() { disposed = true; return { ok: await lock() } },
    get connection() { return currentRecord() === undefined ? undefined : protonPass },
    get session() { return currentRecord()?.id },
  }
}
