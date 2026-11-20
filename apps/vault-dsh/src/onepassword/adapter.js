import { runOp, tracing } from '../bw/run.js'
import { createLifecycle, untilAbort } from '../lifecycle.js'

const id = /^[a-z0-9]{26}$/
const itemId = /^[a-z0-9]{26}\/[a-z0-9]{26}$/
const fieldPart = /^[A-Za-z0-9_-]{1,128}$/
const fieldId = /^(?:[A-Za-z0-9_-]{1,128}\/)?[A-Za-z0-9_-]{1,128}$/
const timeouts = { version: 4500, list: 10000, read: 10000 }
const fail = code => ({ ok: false, code })
const validConnection = label => typeof label === 'string' && label.length > 0
const validToken = token => typeof token === 'string' && token.length > 0 && !/[\s\0]/.test(token)
const success = result => result.failure === undefined && result.code === 0 && result.stderr === ''

function classify(result) {
  if (result.failure === 'refused') return 'refused'
  if (result.failure !== undefined || result.code === 0) return 'unavailable'
  const message = result.stderr.replace(/^\[ERROR\] \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, '').trimEnd()
  const cause = message.replace(/"(?:[^"\\]|\\[\s\S])*"/g, ' ')
  if (/\((?:429|5\d\d)\)/.test(cause)) return 'unavailable'
  if (/\(401\) Unauthorized\b|\b(?:invalid (?:service account )?token|authentication required)\b/i.test(cause)) return 'auth'
  if (/^(?:item|vault) (?:not found|is not accessible)\.?$/.test(message)
    || /^"(?:[a-z0-9]{26})" isn't an item in the .+ vault\. Specify the item with its UUID, name, or domain\.$/.test(message)
    || /^"(?:[a-z0-9]{26})" isn't a vault in this account\. Specify the vault with its UUID or name\.$/.test(message)) return 'revoked'
  if (/^(?:field not found|item does not have a field with ID or label "[A-Za-z0-9_-]+")\.?$/.test(message)) return 'field'
  return 'unavailable'
}

function json(result) {
  if (!success(result)) return fail(classify(result))
  try { return { ok: true, value: JSON.parse(result.stdout) } }
  catch { return fail('unavailable') }
}

function fieldsOf({ fields, sections }) {
  const selected = new Map()
  if (!Array.isArray(fields)) return []
  const sectionLabels = new Map()
  for (const section of Array.isArray(sections) ? sections : []) {
    if (typeof section?.id === 'string' && typeof section.label === 'string' && section.label) {
      sectionLabels.set(section.id, section.label)
    }
  }
  for (const field of fields) {
    if (typeof field?.id !== 'string' || !fieldPart.test(field.id)
      || typeof field.label !== 'string' || field.label === '') continue
    const section = field.section
    if (section != null && (typeof section.id !== 'string' || !fieldPart.test(section.id))) continue
    const selector = section == null ? field.id : section.id + '/' + field.id
    selected.set(selector, {
      id: selector, label: field.label,
      ...(section == null ? {} : {
        section: sectionLabels.get(section.id) ?? (typeof section.label === 'string' && section.label ? section.label : section.id),
      }),
    })
  }
  return [...selected.values()]
}

function byId(row) {
  return typeof row?.id === 'string' && id.test(row.id)
}

// The server gate requires this workspace setting to enable Cloud mode.
const cloudProfile = () => Boolean(process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim())

export function createOnePassword({ idleLockMinutes = 5 } = {}, { run = runOp, timers = globalThis } = {}) {
  const state = createLifecycle({ idleLockMinutes, timers, run, timeouts })
  const { child, invalidate, lock, reads, lifecycle } = state

  async function version(signal) {
    const result = await child(['--version'], 'version', signal)
    if (!success(result)) return fail('unavailable')
    const match = /^2\.(0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[\w.-]+)?$/.exec(result.stdout.replace(/\r?\n$/, ''))
    return match && Number(match[1]) >= 39 ? { ok: true } : fail('version')
  }

  async function status() {
    const signal = state.signal
    if (cloudProfile()) throw Object.assign(new Error('1Password is unavailable in Automagik Cloud.'), { code: 'cloud' })
    if (!state.disposed && (await version(signal)).ok && !signal.aborted) {
      return { state: state.credential === undefined ? 'locked' : 'unlocked' }
    }
    throw new Error('The vault did not answer.')
  }

  const vaults = (signal, token) => child(['vault', 'list', '--format', 'json'], 'list', signal, { token }).then(json)

  function unlock({ token, connection, signal: caller } = {}) {
    if (cloudProfile()) return Promise.resolve(fail('cloud'))
    if (!validConnection(connection) || !validToken(token) || tracing()) return Promise.resolve(fail('refused'))
    if (caller?.aborted) return Promise.resolve(fail('locked'))
    const closing = invalidate()
    const signal = caller === undefined ? state.signal : AbortSignal.any([caller, state.signal])
    return lifecycle(async () => {
      await closing
      if (state.disposed || signal.aborted) return fail('locked')
      const checked = await version(signal)
      if (signal.aborted) return fail('locked')
      if (!checked.ok) return checked
      const result = await vaults(signal, token)
      if (signal.aborted) return fail('locked')
      if (!result.ok) return result
      if (!Array.isArray(result.value)) return fail('unavailable')
      state.set(token, connection)
      return { ok: true }
    }).finally(() => { token = undefined })
  }

  async function authenticated(connection, caller, operation, { renew = false } = {}) {
    if (cloudProfile()) return fail('cloud')
    if (state.credential === undefined) return fail('locked')
    if (connection !== state.connection) return fail('refused')
    const current = state.signal
    const signal = caller === undefined ? current : AbortSignal.any([caller, current])
    const cancelled = () => fail(current.aborted ? 'locked' : 'refused')
    const job = reads(async () => {
      if (signal.aborted) return cancelled()
      const checked = await version(signal)
      if (signal.aborted) return cancelled()
      if (!checked.ok) return checked
      const result = await operation(signal, state.credential)
      if (signal.aborted) return cancelled()
      if (result.code === 'auth') await lock()
      if (result.ok && renew) state.renewIdle()
      return result
    })
    const answer = await (caller === undefined ? job : untilAbort(job, caller, undefined))
    return answer === undefined || (answer.ok && signal.aborted) ? cancelled() : answer
  }

  function read(ref, { signal } = {}) {
    const { provider, item, field, connection } = ref ?? {}
    if (provider !== 'onepassword' || typeof item !== 'string' || !itemId.test(item)) return fail('refused')
    if (typeof field !== 'string' || !fieldId.test(field)) return fail('field')
    const uri = 'op://' + item + '/' + field
    return authenticated(connection, signal, async (childSignal, token) => {
      const result = await child(['read', '--no-newline', uri], 'read', childSignal, { token })
      return success(result) ? { ok: true, value: result.stdout } : fail(classify(result))
    }, { renew: true })
  }

  async function listItems({ connection, search = '' } = {}) {
    if (typeof search !== 'string' || search.includes('\0')) return fail('refused')
    const query = search.toLowerCase()
    const deadline = new AbortController()
    const timer = timers.setTimeout(() => deadline.abort(), timeouts.list)
    try {
      const result = await authenticated(connection, deadline.signal, async (signal, token) => {
        const available = await vaults(signal, token)
        if (!available.ok) return available
        if (!Array.isArray(available.value)) return fail('unavailable')
        const items = []
        for (const vault of available.value) {
          if (signal.aborted) return fail('unavailable')
          if (!byId(vault) || typeof vault.name !== 'string') continue
          const options = ['--vault', vault.id, '--format', 'json']
          const listed = json(await child(['item', 'list', ...options], 'list', signal, { token }))
          if (!listed.ok) return listed
          if (!Array.isArray(listed.value)) return fail('unavailable')
          for (const item of listed.value) {
            if (!byId(item) || typeof item.title !== 'string' || !item.title.toLowerCase().includes(query)) continue
            const detail = json(await child(['item', 'get', item.id, ...options], 'list', signal, { token }))
            if (!detail.ok) return detail
            if (detail.value?.id !== item.id || detail.value?.vault?.id !== vault.id) return fail('unavailable')
            const fields = fieldsOf(detail.value)
            if (fields.length === 0) continue
            items.push({ id: vault.id + '/' + item.id, name: item.title, vault: vault.name, fields })
            if (items.length === 50) return { ok: true, items }
          }
        }
        return { ok: true, items }
      })
      return deadline.signal.aborted ? fail('unavailable') : result
    } finally {
      timers.clearTimeout(timer)
    }
  }

  return {
    status, unlock, lock, retire: lock, read, listItems, prepareQuit: state.dispose,
    get connection() { return state.connection },
  }
}
