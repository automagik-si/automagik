import { classifySync, envelope, isAuthFailure, supportedVersion } from './classify.js'
import { guid, itemFields } from './fields.js'
import { runBw, tracing } from './run.js'
import { createLifecycle, untilAbort } from '../lifecycle.js'

const fail = code => ({ ok: false, code })
const unavailable = () => new Error('The vault did not answer.')
const validConnection = value => typeof value === 'string' && value.length > 0
const validField = field => ['login.username', 'login.password', 'notes'].includes(field)
  || (typeof field === 'string' && field.startsWith('field:') && field.length > 6 && field.length <= 512)
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const timeouts = { version: 5000, status: 5000, sync: 10000, get: 10000, list: 10000, unlock: 30000, lock: 5000 }

function raw(result) {
  if (result.failure === undefined && result.code === 0 && result.stderr === '') return result.stdout.replace(/\r?\n$/, '')
}

function sessionKey(result) {
  const key = raw(result)
  if (key === undefined || !/^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{86}==)$/.test(key)) return undefined
  if (Buffer.from(key, 'base64').toString('base64') === key) return key
}

export function createVault({ idleLockMinutes = 5 } = {}, { run = runBw, timers = globalThis } = {}) {
  let needsLock = false
  const lifetime = createLifecycle({ idleLockMinutes, timers, run, timeouts, cleanup })
  const { child, invalidate, finish, lock: lockSession, lifecycle, reads, renewIdle } = lifetime

  async function cleanup() {
    if (!needsLock) return true
    const result = await run(['lock'], { timeout: timeouts.lock })
    if (result.failure !== undefined || result.code !== 0) return false
    needsLock = false
    return true
  }

  async function version(signal) {
    const result = await child(['--version'], 'version', signal, { response: false })
    if (result.failure !== undefined) return fail(result.failure)
    const value = raw(result)
    return supportedVersion(value) ? { ok: true, value } : fail('version')
  }

  async function cliStatus(signal) {
    const result = await child(['status'], 'status', signal, { session: lifetime.credential })
    if (result.failure !== undefined) return fail(result.failure)
    const answer = envelope(result)
    if (isAuthFailure(answer)) return fail('auth')
    const data = answer?.data?.template
    const state = data?.status
    if (!['unlocked', 'locked', 'unauthenticated'].includes(state)) return fail('unavailable')
    const lastSync = typeof data.lastSync === 'string' && isoDate.test(data.lastSync) ? Date.parse(data.lastSync) : NaN
    return {
      ok: true, state: state === 'unlocked' && lifetime.credential === undefined ? 'locked' : state,
      ...(Number.isFinite(lastSync) ? { lastSync } : {}),
    }
  }

  async function status() {
    const deadline = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, deadline.signal])
    const timer = timers.setTimeout(() => deadline.abort(), 4500)
    const probe = async () => {
      if (lifetime.disposed) return undefined
      const checked = await version(signal)
      if (signal.aborted) return undefined
      if (!checked.ok) {
        if (checked.code === 'version') void lockSession()
        return undefined
      }
      const result = await cliStatus(signal)
      if (signal.aborted) return undefined
      if (!result.ok) {
        if (result.code === 'auth') void lockSession()
        return undefined
      }
      const { ok, ...answer } = result
      if (answer.state !== 'unlocked' && lifetime.credential !== undefined) void lockSession()
      return answer
    }
    try {
      const answer = await untilAbort(probe(), deadline.signal, undefined)
      if (answer === undefined) throw unavailable()
      return answer
    } finally {
      timers.clearTimeout(timer)
    }
  }

  function unlock({ password, connection: label, signal: caller } = {}) {
    if (!validConnection(label) || typeof password !== 'string' || password.length === 0 || password.includes('\0')) {
      return Promise.resolve(fail('refused'))
    }
    const withCaller = signal => caller === undefined ? signal : AbortSignal.any([signal, caller])
    const requested = lifetime.signal
    return lifecycle(async () => {
      let current = requested
      let signal = withCaller(current)
      if (lifetime.disposed || signal.aborted) return fail('locked')
      if (tracing()) return fail('refused')
      const checked = await version(signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) {
        await finish(invalidate())
        return fail(checked.code === 'version' ? 'version' : 'unavailable')
      }
      if (needsLock) {
        const switchConnection = label !== lifetime.connection
        const closing = invalidate()
        current = lifetime.signal
        signal = withCaller(current)
        if (switchConnection && !await finish(closing)) return fail('unlock')
        await closing
        if (signal.aborted) return fail('locked')
      }
      if (tracing()) return fail('refused')
      needsLock = true
      const result = await child(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'], 'unlock', signal, { password, response: false })
      password = undefined
      if (signal.aborted) {
        if (!current.aborted) await finish(invalidate())
        return fail('locked')
      }
      const key = sessionKey(result)
      if (key === undefined) {
        await finish(invalidate())
        return fail(result.failure === 'refused' ? 'refused' : 'unlock')
      }
      lifetime.set(key, label)
      return { ok: true }
    }).finally(() => { password = undefined })
  }

  const failedChild = result => fail(result.failure === 'refused' ? 'refused' : 'unavailable')
  async function read(ref, { signal: caller } = {}) {
    if (ref?.provider !== 'bitwarden' || !validConnection(ref.connection) || !guid(ref.item)) return fail('refused')
    if (lifetime.credential === undefined) return fail('locked')
    if (ref.connection !== lifetime.connection) return fail('refused')
    if (!validField(ref.field)) return fail('field')
    const id = ref.item.toLowerCase()
    const selector = ref.field
    const current = lifetime.signal
    const signal = caller === undefined ? current : AbortSignal.any([current, caller])
    const cancelled = () => fail(current.aborted ? 'locked' : 'refused')
    const work = async () => {
      if (signal.aborted) return cancelled()
      const checked = await version(signal)
      if (signal.aborted) return cancelled()
      if (!checked.ok) {
        await lockSession()
        return fail(checked.code === 'version' ? 'version' : 'unavailable')
      }
      const before = await cliStatus(signal)
      if (signal.aborted) return cancelled()
      if (before.code === 'auth') {
        await lockSession()
        return fail('auth')
      }
      if (!before.ok) return failedChild({ failure: before.code })
      if (before.state !== 'unlocked') {
        await lockSession()
        return fail('locked')
      }
      const sync = await child(['sync', '--force'], 'sync', signal, { session: lifetime.credential })
      if (signal.aborted) return cancelled()
      const freshness = classifySync(checked.value, sync)
      if (freshness !== 'ok' && freshness !== 'stale-network') {
        await lockSession()
        return fail(freshness === 'auth' ? 'auth' : 'refused')
      }
      const got = await child(['get', 'item', id], 'get', signal, { session: lifetime.credential })
      if (signal.aborted) return cancelled()
      const result = envelope(got)
      if (isAuthFailure(result)) {
        await lockSession()
        return fail('auth')
      }
      if (result?.message === 'Not found.') return fail('revoked')
      const item = result?.data
      if (!guid(item?.id) || item.id.toLowerCase() !== id) return failedChild(got)
      if (item.deletedDate != null) return fail('revoked')
      const value = itemFields(item).get(selector)
      if (value === undefined) return fail('field')
      return freshness === 'stale-network' ? { ok: true, value, stale: true } : { ok: true, value }
    }
    // Race the user's cancellation only. A refusal that itself locks the session
    // still reports its original reason after the lock finishes.
    const job = reads(work)
    const answer = await (caller === undefined ? job : untilAbort(job, caller, undefined))
    if (answer === undefined || (answer.ok && signal.aborted)) return cancelled()
    if (answer.ok) renewIdle()
    return answer
  }

  async function listItems({ connection: label, search = '' } = {}) {
    if (lifetime.credential === undefined) return fail('locked')
    if (label !== lifetime.connection || typeof search !== 'string' || search.includes('\0')) return fail('refused')
    const signal = lifetime.signal
    const checked = await version(signal)
    if (signal.aborted) return fail('locked')
    if (!checked.ok) {
      await lockSession()
      return fail(checked.code === 'version' ? 'version' : 'unavailable')
    }
    const args = ['list', 'items', ...(search ? ['--search=' + search] : [])]
    const result = await child(args, 'list', signal, { session: lifetime.credential })
    if (signal.aborted) return fail('locked')
    const answer = envelope(result)
    if (isAuthFailure(answer)) {
      await lockSession()
      return fail('auth')
    }
    const list = answer?.data
    if (list?.object !== 'list' || !Array.isArray(list.data)) return failedChild(result)
    const items = []
    for (const item of list.data) {
      if (!guid(item?.id) || item.deletedDate != null || typeof item.name !== 'string' || item.name === '') continue
      const fields = [...itemFields(item).keys()]
      if (fields.length === 0) continue
      items.push({ id: item.id.toLowerCase(), name: item.name, fields })
      if (items.length === 50) break
    }
    return { ok: true, items }
  }

  return {
    version: 1, status, unlock, async lock() { await lockSession() }, read, listItems,
    retire: lockSession, get connection() { return lifetime.connection },
    prepareQuit: lifetime.dispose, dispose: lifetime.dispose,
  }
}
