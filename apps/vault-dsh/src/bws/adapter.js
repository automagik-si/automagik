import { createLifecycle, untilAbort } from '../lifecycle.js'
import { createKeychain, validBlob } from '../keychain/index.js'
import { tracing } from '../bw/run.js'
import { classify, supportedVersion } from './classify.js'
import { normalizeServer, runBws } from './run.js'

const provider = 'bitwarden-secrets'
const uuidPart = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const uuid = new RegExp('^' + uuidPart + '$', 'i')
const tokenPattern = new RegExp('^0\\.' + uuidPart + '\\.[A-Za-z0-9_+/-]+={0,2}:([A-Za-z0-9+/]+={0,2})$', 'i')
function validToken(token) {
  if (typeof token !== 'string' || token.length > 2048 || /\s/.test(token)) return false
  const key = tokenPattern.exec(token)?.[1]
  if (key === undefined) return false
  const decoded = Buffer.from(key, 'base64')
  if (decoded.length !== 16) return false
  const canonical = decoded.toString('base64')
  return key === canonical || key === canonical.slice(0, -2)
}
const validConnection = label => typeof label === 'string' && label.length > 0 && label.length <= 512
function setRecord(input) {
  const { token, connection, server } = input ?? {}
  const normalized = normalizeServer(server)
  if (!validConnection(connection) || !validToken(token) || normalized === undefined) return undefined
  const credential = { token, server: normalized }
  const blob = Buffer.from(JSON.stringify({ v: 1, ...credential })).toString('base64')
  if (validBlob(blob)) return { credential, blob }
}
export const checkSetToken = input => setRecord(input) !== undefined

const validId = id => typeof id === 'string' && id.length === 36 && uuid.test(id)
const timeouts = { version: 4500, list: 10000, read: 10000 }
const fail = code => ({ ok: false, code })
const passed = { ok: true }
const cloudProfile = () => Boolean(process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim())

function parse(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

export function createBitwardenSecrets({ idleLockMinutes = 5 } = {}, {
  identity, keychain = createKeychain(), run = runBws, timers = globalThis,
} = {}) {
  const state = createLifecycle({ idleLockMinutes, timers, run, timeouts })
  const { child, invalidate, lifecycle, lock, reads } = state
  const configured = () => identity !== undefined && keychain.available
  const availability = () => cloudProfile() ? 'cloud' : !configured() ? 'keychain' : undefined
  let activationId
  let keychainUnavailable = false
  let picker

  async function version(signal) {
    const result = await child(['--version'], 'version', signal)
    const value = supportedVersion(result)
    return value === undefined
      ? fail(result.code === 0 && !result.stderr ? 'version' : 'unavailable')
      : { ok: true, value, launch: result.launch }
  }

  async function status() {
    const deny = code => { throw Object.assign(new Error('The vault did not answer.'), { code }) }
    const code = availability()
    if (code !== undefined) deny(code)
    if (keychainUnavailable) deny('keychain')
    const signal = state.signal
    const checked = await version(signal)
    if (state.disposed || signal.aborted || !checked.ok) deny(checked.code ?? 'unavailable')
    return { state: state.credential === undefined ? 'locked' : 'unlocked' }
  }

  async function request(args, signal, credential, checked, kind = 'list') {
    const result = await child(args, kind, signal, { ...credential, launch: checked.launch })
    if (result.failure !== undefined || result.code !== 0 || result.stderr !== '') return fail(classify(checked.value, result))
    return { ok: true, value: parse(result.stdout) }
  }

  async function projects(signal, credential, checked) {
    const result = await request(['project', 'list'], signal, credential, checked)
    if (!result.ok) return result
    if (!Array.isArray(result.value)
      || !result.value.every(row => validId(row?.id) && typeof row.name === 'string')) return fail('unavailable')
    return { ok: true, projects: result.value.map(({ id, name }) => ({ id, name })) }
  }

  function activate({ token, connection, server, signal: caller } = {}, store = false) {
    const code = availability()
    if (code !== undefined) return Promise.resolve(fail(code))
    const record = store ? setRecord({ token, connection, server }) : undefined
    if (store && record === undefined) return Promise.resolve(fail('refused'))
    if (connection === undefined) connection = state.connection ?? provider
    if (!validConnection(connection) || tracing()) return Promise.resolve(fail('refused'))
    if (caller?.aborted) return Promise.resolve(fail('locked'))
    const closing = invalidate()
    const signal = caller === undefined ? state.signal : AbortSignal.any([caller, state.signal])
    return lifecycle(async () => {
      await closing
      if (state.disposed || signal.aborted) return fail('locked')
      const checked = await version(signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) return checked
      if (!store) {
        const saved = await keychain.lookup(identity.item(connection), signal)
        if (signal.aborted) return fail('locked')
        keychainUnavailable = !saved.ok
        if (!saved.ok) return saved
        const savedRecord = saved.blob === undefined ? undefined : parse(Buffer.from(saved.blob, 'base64').toString('utf8'))
        if (savedRecord?.v !== 1 || !validToken(savedRecord.token) || typeof savedRecord.server !== 'string'
          || normalizeServer(savedRecord.server) !== savedRecord.server) return fail('locked')
        token = savedRecord.token
        server = savedRecord.server
      }
      const credential = record?.credential ?? { token, server }
      const verified = await projects(signal, credential, checked)
      if (signal.aborted) return fail('locked')
      if (!verified.ok) return verified
      if (store) {
        // A committed write finishes in this queue even if lock/clear has
        // invalidated the activation. Clear then sees and deletes that write.
        const id = identity.item(connection)
        const stored = await keychain.store(id, record.blob)
        keychainUnavailable = stored.code === 'keychain'
        if (!stored.ok) return stored
        // A separate process can clear or replace the item while the store helper exits.
        let confirmed
        if (!signal.aborted) {
          try { confirmed = await stored.confirm(signal) } catch {}
        }
        if (signal.aborted) return { ...fail('locked'), committed: true }
        if (confirmed?.ok !== true || confirmed.blob !== record.blob) return { ...fail('set'), committed: true }
      }
      activationId = Symbol()
      state.set(credential, connection)
      return passed
    }).finally(() => { token = undefined })
  }

  function clearToken({ connection = state.connection ?? provider } = {}) {
    if (state.disposed) return Promise.resolve(fail('locked'))
    if (!validConnection(connection)) return Promise.resolve(fail('refused'))
    const closing = invalidate()
    return lifecycle(async () => {
      await closing
      const code = availability()
      if (code !== undefined) return fail(code)
      let attempted = false
      const removed = await keychain.clear(identity.item(connection), undefined, () => { attempted = true })
      if (removed.ok) keychainUnavailable = false
      return !removed.ok && attempted ? { ...removed, attempted: true } : removed
    })
  }

  async function authenticated(connection, caller, operation, renew = false) {
    if (cloudProfile()) return fail('cloud')
    if (state.credential === undefined) return fail('locked')
    if (connection !== state.connection) return fail('refused')
    const current = state.signal
    const signal = caller === undefined ? current : AbortSignal.any([caller, current])
    const cancelled = () => fail(current.aborted ? 'locked' : 'unavailable')
    const job = reads(async () => {
      if (signal.aborted) return cancelled()
      const checked = await version(signal)
      if (signal.aborted) return cancelled()
      if (!checked.ok) return checked
      const result = await operation(signal, state.credential, checked)
      if (signal.aborted) return cancelled()
      if (result.code === 'auth') await lock()
      if (result.ok && renew) state.renewIdle()
      return result
    })
    const answer = await (caller === undefined ? job : untilAbort(job, caller, undefined))
    return answer === undefined || (answer.ok && signal.aborted) ? cancelled() : answer
  }

  function read(ref, { signal } = {}) {
    if (ref?.provider !== provider || !validId(ref.item)) return fail('refused')
    if (ref.field !== 'value') return fail('field')
    return authenticated(ref.connection, signal, async (childSignal, credential, checked) => {
      const result = await request(['secret', 'get', ref.item], childSignal, credential, checked, 'read')
      if (!result.ok) return result
      const { value } = result
      return validId(value?.id) && value.id.toLowerCase() === ref.item.toLowerCase() && typeof value.value === 'string'
        ? { ok: true, value: value.value } : fail('unavailable')
    }, true)
  }

  async function listItems({ connection, search = '', project } = {}) {
    if (typeof search !== 'string' || (project !== undefined && !validId(project))) return fail('refused')
    const deadline = new AbortController()
    const timer = timers.setTimeout(() => deadline.abort(), timeouts.list)
    try {
      return await authenticated(connection, deadline.signal, async (signal, credential, checked) => {
        if (project === undefined) {
          const available = await projects(signal, credential, checked)
          if (!available.ok || signal.aborted) return available
          if (picker === undefined) state.signal.addEventListener('abort', () => { picker = undefined }, { once: true })
          picker = new Map(available.projects.map(row => [row.id, row]))
          return { ...available, items: [] }
        }
        const selected = picker?.get(project)
        if (selected === undefined) return fail('unavailable')
        const listed = await request(['secret', 'list', selected.id], signal, credential, checked)
        if (!listed.ok) return listed
        if (!Array.isArray(listed.value) || !listed.value.every(row =>
          validId(row?.id) && typeof row.key === 'string' && row.projectId === selected.id)) return fail('unavailable')
        const query = search.toLowerCase()
        const items = listed.value.filter(row => row.key.toLowerCase().includes(query)).slice(0, 50)
          .map(({ id, key }) => ({ id, name: key, vault: selected.name, fields: [{ id: 'value', label: 'Value' }] }))
        return { ok: true, items }
      })
    } finally { timers.clearTimeout(timer) }
  }

  return {
    availability, status, unlock: activate, setToken: options => activate(options, true), clearToken,
    lock, retire: lock, read, listItems, prepareQuit: state.dispose,
    get connection() { return state.connection },
    get activationId() { return state.credential === undefined ? undefined : activationId },
  }
}
