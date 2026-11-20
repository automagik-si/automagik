import { tracing } from '../bw/run.js'
import { createLifecycle, untilAbort } from '../lifecycle.js'
import { endpointOf, fail, fieldMap, itemParts, json, mountVersion, provider, supportedVersion, validField, validItem, validMount, validToken } from './parse.js'
import { runVault } from './run.js'

const mounts = 'sys/internal/ui/mounts'
const timeouts = { version: 5000, api: 10000 }
export const cloudProfile = () => Boolean(process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim())
// Vault trims the whole CLI path before removing a trailing slash.
const cliPath = path => /[\s\u0085]$/u.test(path) ? path + '/' : path

export function createHashicorpVault({ idleLockMinutes = 5 } = {}, { run = runVault, timers = globalThis } = {}) {
  const state = createLifecycle({ idleLockMinutes, timers, run, timeouts })
  const { child, invalidate, lifecycle, lock, reads } = state
  const api = (verb, path, signal, credential) => child([verb, '-format=json', '--', cliPath(path)], 'api', signal, { credential })
    .then(result => json(result, verb, path))

  async function version(signal) {
    if (tracing()) return fail('refused')
    const result = await child(['version'], 'version', signal)
    if (result.failure === 'unavailable') return fail('unavailable')
    if (result.failure !== undefined || result.code !== 0 || result.stderr !== '') return fail('refused')
    return supportedVersion(result.stdout) ? { ok: true } : fail('version')
  }

  async function preflight(mount, signal, credential) {
    const result = await api('read', mounts + '/' + mount, signal, credential)
    if (!result.ok) return result.code === 'missing' ? fail('revoked') : result
    const engine = mountVersion(result.data, mount)
    return engine === undefined ? fail('refused') : { ok: true, engine }
  }

  function status() {
    if (cloudProfile()) throw Object.assign(new Error('HashiCorp Vault is unavailable in Automagik Cloud.'), { code: 'cloud' })
    return { state: state.credential === undefined ? 'locked' : 'unlocked' }
  }

  function unlock({ token, address, namespace, mount, signal: caller } = {}) {
    if (cloudProfile()) return Promise.resolve(fail('cloud'))
    const endpoint = endpointOf(address, namespace)
    if (endpoint === undefined || !validToken(token) || (mount !== undefined && !validMount(mount))) {
      return Promise.resolve(fail('refused'))
    }
    if (caller?.aborted || state.disposed) return Promise.resolve(fail('locked'))
    const closing = invalidate()
    const signal = caller === undefined ? state.signal : AbortSignal.any([caller, state.signal])
    let credential = { ...endpoint, token }
    return lifecycle(async () => {
      await closing
      if (signal.aborted) return fail('locked')
      const checked = await version(signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) return checked
      const result = mount === undefined
        ? await api('read', mounts, signal, credential)
        : await preflight(mount, signal, credential)
      if (signal.aborted) return fail('locked')
      if (!result.ok && !(mount === undefined && result.code === 'denied')) {
        return result.code === 'missing' ? fail('revoked') : result
      }
      state.set(credential, endpoint.connection)
      return { ok: true }
    }).finally(() => { credential = undefined })
  }

  async function authenticated(connection, mount, caller, operation, renew = false) {
    if (cloudProfile()) return fail('cloud')
    const credential = state.credential
    if (credential === undefined) return fail('locked')
    if (connection !== state.connection) return fail('connection')
    const current = state.signal
    const signal = caller === undefined ? current : AbortSignal.any([caller, current])
    const job = reads(async () => {
      if (signal.aborted) return fail('locked')
      const checked = await version(signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) {
        void lock()
        return checked
      }
      const mounted = await preflight(mount, signal, credential)
      if (signal.aborted) return fail('locked')
      const result = mounted.ok ? await operation(mounted.engine, signal, credential) : mounted
      if (signal.aborted) return fail('locked')
      if (result.code === 'auth') void lock()
      if (result.ok && renew) state.renewIdle()
      return result
    })
    // The operation can cause its own lock while keeping its specific refusal code.
    return caller === undefined ? job : untilAbort(job, caller, fail('locked'))
  }

  async function item(mount, path, engine, signal, credential) {
    const result = await api('read', engine === '2' ? mount + '/data/' + path : mount + '/' + path, signal, credential)
    if (result.ok) return fieldMap(result.data, engine)
    return result.code === 'missing' ? fail('revoked') : result
  }

  function read(ref, { signal } = {}) {
    const parts = itemParts(ref?.item)
    const { connection, field } = ref ?? {}
    if (ref?.provider !== provider || parts === undefined || !validField(field)) return Promise.resolve(fail('refused'))
    const [mount, path] = parts
    return authenticated(connection, mount, signal, async (engine, control, credential) => {
      const result = await item(mount, path, engine, control, credential)
      if (!result.ok) return result.code === 'denied' ? { ...fail('revoked'), audit: 'refused' } : result
      if (!Object.hasOwn(result.data, field) || typeof result.data[field] !== 'string') return fail('field')
      return { ok: true, value: result.data[field] }
    }, true)
  }

  function listItems({ connection, mount, folder = '', signal } = {}) {
    if (!validMount(mount) || (folder !== '' && !validItem(mount, folder))) return Promise.resolve(fail('refused'))
    return authenticated(connection, mount, signal, async (engine, control, credential) => {
      const base = engine === '2' ? mount + '/metadata' : mount
      const result = await api('list', folder === '' ? base : base + '/' + folder, control, credential)
      if (!result.ok) return result.code === 'missing' ? { ok: true, items: [] } : result
      if (!Array.isArray(result.data) || !result.data.every(key => typeof key === 'string')) return fail('refused')
      const rows = new Map()
      for (const key of result.data) {
        const folderRow = key.endsWith('/')
        const segment = folderRow ? key.slice(0, -1) : key
        const id = folder === '' ? segment : folder + '/' + segment
        if (segment.includes('/') || !validItem(mount, id)) continue
        rows.set(key, { id, name: key, folder: folderRow })
        if (rows.size === 50) break
      }
      return { ok: true, items: [...rows.values()] }
    })
  }

  function listFields({ connection, mount, path, signal } = {}) {
    if (!validItem(mount, path)) return Promise.resolve(fail('refused'))
    return authenticated(connection, mount, signal, async (engine, control, credential) => {
      const result = await item(mount, path, engine, control, credential)
      if (!result.ok) return result
      return { ok: true, fields: Object.keys(result.data).filter(validField).slice(0, 50) }
    })
  }

  return {
    get connection() { return state.connection },
    status, unlock, read, listItems, listFields, retire: lock, prepareQuit: state.dispose,
  }
}
