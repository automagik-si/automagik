import { userInfo } from 'node:os'
import { posix } from 'node:path'
import { createLifecycle, untilAbort } from '../lifecycle.js'
import { connection, itemOf, loginKeychain, parseLookup, provider } from './parse.js'
import { keychainDirectory, ownedKeychain, runSecurity, validKeychainPath } from './run.js'

const fail = code => ({ ok: false, code })
const cloud = () => Boolean(process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim())

export function createMacosKeychain({ idleLockMinutes = 5 } = {}, {
  platform = process.platform, passwd = userInfo, keychainPath, run = runSecurity, timers = globalThis,
  timeouts = { metadata: 10_000, read: 30_000 }, isCloud = cloud,
} = {}) {
  const state = createLifecycle({
    idleLockMinutes, timers, timeouts,
    run: (args, { home, ...limits }) => run(args, limits, { platform, home, keychainPath }),
  })
  const availability = () => platform !== 'darwin' ? 'platform' : isCloud() ? 'cloud' : undefined
  const validUnlock = options => (options.connection === undefined || options.connection === connection)
    && options.password === undefined && options.token === undefined
  let bindingKey
  let binding

  function status() {
    const code = availability()
    if (code !== undefined) throw Object.assign(new Error('macOS Keychain is unavailable.'), { code })
    return { state: state.credential === undefined ? 'locked' : 'unlocked' }
  }

  async function unlock(options = {}) {
    const code = availability()
    if (code !== undefined) return fail(code)
    if (!validUnlock(options)) return fail('refused')
    const caller = options.signal
    if (caller?.aborted || state.disposed) return fail('locked')
    const closing = state.invalidate()
    const current = state.signal
    return state.lifecycle(async () => {
      await closing
      if (current.aborted || caller?.aborted) return fail('locked')
      state.set(Symbol(), connection)
      return { ok: true }
    })
  }

  function lookup({ item, service, account, connection: label, signal: caller }, read) {
    const code = availability()
    if (code !== undefined) return fail(code)
    if (state.credential === undefined) return fail('locked')
    if (label !== connection) return fail('refused')
    let home, path
    try {
      home = passwd().homedir
      path = keychainPath ?? posix.join(keychainDirectory(home), loginKeychain)
      if (!validKeychainPath(home, path)) return fail('refused')
      if (read) {
        if (typeof item !== 'string' || item.length > 512) return fail('refused')
        const parts = JSON.parse(item)
        if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== path) return fail('refused')
        service = parts[1]
        account = parts[2]
      }
    } catch { return fail('refused') }
    const id = itemOf(path, service, account)
    if (id === undefined || (read && id !== item)) return fail('refused')
    const signal = caller === undefined ? state.signal : AbortSignal.any([caller, state.signal])
    const job = state.reads(async () => {
      if (signal.aborted || availability() !== undefined) return fail('refused')
      if (!ownedKeychain(path)) return fail('refused')
      const args = ['find-generic-password', '-s', service, '-a', account, ...(read ? ['-g'] : []), path, path]
      try {
        const result = await state.child(args, read ? 'read' : 'metadata', signal, { home })
        if (signal.aborted || availability() !== undefined) return fail('refused')
        const parsed = parseLookup(result, path, read)
        if (read) {
          if (parsed.ok) state.renewIdle()
          return parsed
        }
        if (parsed.ok) return { ok: true, items: [{ id, service, account, fields: ['password'] }] }
        return parsed.code === 'revoked' ? { ok: true, items: [] } : parsed
      } catch { return fail('refused') }
    })
    return untilAbort(job, signal, fail('refused'))
  }

  return {
    get connection() { return state.connection },
    get binding() {
      const key = state.credential ?? state.signal
      if (bindingKey !== key) {
        bindingKey = key
        binding = Symbol()
      }
      return binding
    },
    availability, validUnlock, status, unlock,
    read: (ref, { signal } = {}) => ref?.provider === provider && ref.field === 'password'
      ? lookup({ ...ref, signal }, true) : fail('refused'),
    listItems: (options = {}) => lookup(options, false),
    retire: state.lock, prepareQuit: state.dispose,
  }
}
