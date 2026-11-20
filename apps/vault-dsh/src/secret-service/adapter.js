import { randomBytes } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { createLifecycle, untilAbort } from '../lifecycle.js'
import { BusFailure, bus, busPath, connectBus, parseAddress, serviceName, tracing, uniqueName } from './dbus.js'
import { algorithm, decrypt, exchange } from './crypto.js'
import { attributeDigest, collectionOf, collectionPath, itemParts, itemPath, provider, root, validHandle } from './parse.js'

const props = 'org.freedesktop.DBus.Properties'
const iface = prefix => 'org.freedesktop.Secret.' + prefix
const match = "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.secrets'"
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const operationTimeout = 10000
const pickerTimeout = 20000
const fail = code => ({ ok: false, code })
const remoteCode = err => {
  if (!(err instanceof BusFailure)) return 'refused'
  switch (err.remote) {
    case 'org.freedesktop.Secret.Error.IsLocked': return 'locked'
    case 'org.freedesktop.DBus.Error.ServiceUnknown':
    case 'org.freedesktop.DBus.Error.NameHasNoOwner': return 'unavailable'
    default: return err.code
  }
}
const missing = err => err instanceof BusFailure
  && ['org.freedesktop.DBus.Error.UnknownMethod', 'org.freedesktop.Secret.Error.NoSuchObject'].includes(err.remote)
const ensure = (condition, code) => {
  if (!condition) throw new BusFailure(code)
}

async function startTime(path) {
  const stat = await readFile(path + '/stat', 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

async function gnomeProcess(pid, confirm) {
  const path = '/proc/' + pid
  try {
    if (!Number.isInteger(pid) || pid <= 0) return false
    const start = await startTime(path)
    const comm = await readFile(path + '/comm', 'utf8')
    const exe = path + '/exe'
    return /^[0-9]+$/.test(start ?? '') && comm === 'gnome-keyring-d\n'
      && (await lstat(exe)).isSymbolicLink() && basename(await readlink(exe)) === 'gnome-keyring-daemon'
      && await confirm() === pid && await startTime(path) === start
  } catch (err) {
    if (err instanceof BusFailure) throw err
    return false
  }
}

function keyring(connection, owner, signal) {
  const call = (kind, path, member, signature, body, expected) =>
    connection.call(owner, path, iface(kind), member, signature, body, expected, signal)
  async function get(kind, path, name, signature) {
    const [variant] = await connection.call(owner, path, props, 'Get', 'ss', [iface(kind), name], 'v', signal)
    ensure(variant.signature === signature)
    return variant.value
  }
  return {
    collections: () => get('Service', root, 'Collections', 'ao'),
    collectionLabel: path => get('Collection', path, 'Label', 's'),
    collectionLocked: path => get('Collection', path, 'Locked', 'b'),
    items: path => get('Collection', path, 'Items', 'ao'),
    label: path => get('Item', path, 'Label', 's'),
    created: path => get('Item', path, 'Created', 't'),
    locked: path => get('Item', path, 'Locked', 'b'),
    attributes: path => get('Item', path, 'Attributes', 'a{ss}'),
    open: pub => call('Service', root, 'OpenSession', 'sv', [algorithm, { signature: 'ay', value: pub }], 'vo'),
    secret: (path, session) => call('Item', path, 'GetSecret', 'o', [session], '(oayays)'),
    close: session => call('Session', session, 'Close', '', [], ''),
  }
}

async function collectionItems(api, collection) {
  ensure(!await api.collectionLocked(collection), 'locked')
  return api.items(collection)
}

async function atItem(api, path, work) {
  const collection = collectionOf(path)
  const listed = await collectionItems(api, collection)
  ensure(listed.includes(path), 'revoked')
  try {
    ensure(!await api.locked(path), 'locked')
    return await work(collection)
  } catch (err) {
    if (!missing(err)) throw err
    return confirmDeleted(api, path)
  }
}

async function confirmDeleted(api, path) {
  let remaining
  try { remaining = await collectionItems(api, collectionOf(path)) }
  catch { throw new BusFailure() }
  throw new BusFailure(remaining.includes(path) ? 'refused' : 'revoked')
}

const reserved = attributes => attributes.some(([name]) => name === 'automagik-vault-item')

async function identity(api, path, created = undefined) {
  created ??= (await api.created(path)).toString()
  const attributes = await api.attributes(path)
  ensure(!reserved(attributes))
  const attrs = attributeDigest(attributes)
  ensure(attrs !== undefined)
  return JSON.stringify([path, created, attrs])
}

function withDeadline(signal, timeout) {
  const deadline = AbortSignal.timeout(timeout)
  return AbortSignal.any([signal, deadline])
}

export function createSecretService({ idleLockMinutes = 5 } = {}, {
  platform = process.platform, env = process.env, timers = globalThis, verifyProcess = gnomeProcess,
} = {}) {
  const unavailable = () => platform !== 'linux' ? 'platform'
    : env.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim() ? 'cloud' : undefined
  let monitorDrain
  const state = createLifecycle({
    idleLockMinutes, timers, timeouts: { operation: operationTimeout },
    run: (work, { signal, timeout }) => work(timeout === undefined ? signal : withDeadline(signal, timeout)),
    async cleanup() {
      await monitorDrain
      await state.reads.settled()
      return true
    },
  })
  let generation = 0
  let binding = Object.freeze({ provider, generation })
  let currentListing
  function observeGeneration() {
    state.signal.addEventListener('abort', () => {
      binding = Object.freeze({ provider, generation: ++generation })
      currentListing = undefined
    }, { once: true })
  }
  observeGeneration()

  function invalidate() {
    const monitor = monitorDrain
    const closing = state.invalidate()
    observeGeneration()
    return Promise.all([closing, monitor])
  }
  function retire() {
    const closing = invalidate()
    return state.lifecycle(() => state.finish(closing))
  }
  function currentGate() {
    const gate = state.credential
    const address = env.DBUS_SESSION_BUS_ADDRESS
    if (gate !== undefined && gate.address !== address) {
      let guid
      try { ({ guid } = parseAddress(address)) } catch {}
      if (guid !== undefined && guid !== gate.guid) {
        void retire()
        return undefined
      }
    }
    return gate
  }
  function status() {
    const code = unavailable()
    if (code !== undefined) throw new BusFailure(code)
    return { state: currentGate() === undefined ? 'locked' : 'unlocked' }
  }

  async function discover(connection, control, gate) {
    const call = (member, sig, body, expected) => connection.call(bus, busPath, bus, member, sig, body, expected, control)
    const [id] = await call('GetId', '', [], 's')
    let owner
    try { [owner] = await call('GetNameOwner', 's', [serviceName], 's') }
    catch (err) {
      if (gate !== undefined && remoteCode(err) === 'unavailable') void retire()
      throw err
    }
    ensure(uniqueName(owner) && /^[a-f0-9]{32}$/i.test(id))
    if (gate !== undefined && (gate.guid !== connection.guid || gate.id !== id || gate.owner !== owner)) {
      void retire()
      throw new BusFailure('locked')
    }
    const pid = async () => (await call('GetConnectionUnixProcessID', 's', [owner], 'u'))[0]
    if (!await verifyProcess(await pid(), pid)) throw new BusFailure('unsupported')
    return { owner, id, guid: connection.guid }
  }

  function unlock({ signal: caller } = {}) {
    const code = unavailable()
    if (code !== undefined) return Promise.resolve(fail(code))
    if (caller?.aborted || state.disposed) return Promise.resolve(fail('locked'))
    const closing = invalidate()
    const lifetime = state.signal
    const signal = caller === undefined ? lifetime : AbortSignal.any([lifetime, caller])
    return state.lifecycle(async () => {
      await closing
      if (signal.aborted) return fail('locked')
      return state.child(async control => {
        let connection
        let established = false
        let watched = false
        let lost = false
        const disconnected = () => {
          lost = true
          if (established && !lifetime.aborted) void retire()
        }
        try {
          const address = env.DBUS_SESSION_BUS_ADDRESS
          connection = await connectBus(address, {
            signal: control, lifetime, env, onClose: disconnected,
            onSignal(message) {
              const { sender, path, interface: kind, member } = message.headers
              if (watched && sender === bus && path === busPath && kind === bus && member === 'NameOwnerChanged'
                && message.signature === 'sss' && message.body[0] === serviceName) disconnected()
            },
          })
          monitorDrain = connection.closed
          watched = true
          await connection.call(bus, busPath, bus, 'AddMatch', 's', [match], '', control)
          const gate = await discover(connection, control)
          ensure(!lost && !signal.aborted, 'locked')
          ensure(!control.aborted)
          state.set({ ...gate, address })
          established = true
          return { ok: true }
        } catch (err) {
          return fail(signal.aborted || lost && connection !== undefined ? 'locked'
            : control.aborted ? 'refused' : remoteCode(err))
        } finally {
          if (!established) await connection?.close()
        }
      }, 'operation', signal)
    })
  }

  function operation(caller, work, { picker = false, renew = false } = {}) {
    const code = unavailable()
    if (code !== undefined) return Promise.resolve(fail(code))
    const gate = currentGate()
    if (gate === undefined) return Promise.resolve(fail('locked'))
    const lifetime = state.signal
    const signal = caller === undefined ? lifetime : AbortSignal.any([lifetime, caller])
    // Capture the deadline at submission so a queued operation has the same bound.
    const deadline = withDeadline(signal, picker ? pickerTimeout : operationTimeout)
    const job = state.reads(async () => {
      if (deadline.aborted) return fail(signal.aborted ? 'locked' : 'refused')
      return state.child(async control => {
        let connection
        try {
          const address = env.DBUS_SESSION_BUS_ADDRESS
          if (tracing(env)) throw new BusFailure()
          const { guid } = parseAddress(address)
          if (guid !== undefined && guid !== gate.guid) {
            void retire()
            throw new BusFailure('locked')
          }
          connection = await connectBus(address, { signal: control, env })
          if (connection.guid !== gate.guid) {
            void retire()
            throw new BusFailure('locked')
          }
          const { owner } = await discover(connection, control, gate)
          const result = await work(keyring(connection, owner, control))
          await connection.close()
          if (deadline.aborted) return fail(signal.aborted ? 'locked' : 'refused')
          if (renew && result.ok) state.renewIdle()
          return result
        } catch (err) {
          await connection?.close()
          if (signal.aborted) return fail('locked')
          return fail(deadline.aborted ? 'refused' : remoteCode(err))
        }
      }, 'queued', deadline)
    })
    return untilAbort(job, deadline, undefined).then(result => {
      if (deadline.aborted) return fail(signal.aborted ? 'locked' : 'refused')
      return result
    })
  }

  function read(ref, { signal } = {}) {
    return operation(signal, async api => {
      const parts = itemParts(ref?.item)
      ensure(ref?.provider === provider && ref.field === 'secret' && parts !== undefined)
      const [path] = parts
      await atItem(api, path, () => {})
      const dh = exchange()
      const [peer, session] = await api.open(dh.publicKey)
      ensure(session !== '/' && session.startsWith(root + '/session/') && peer.signature === 'ay')
      let key
      let plain
      try {
        key = dh.key(peer.value)
        await atItem(api, path, async () => ensure(await identity(api, path) === ref.item, 'revoked'))
        const [[returned, iv, encrypted, mime]] = await atSecret(api, path, session)
        ensure(returned === session && iv.length === 16)
        if (mime !== 'text/plain') return fail('field')
        plain = decrypt(key, iv, encrypted)
        await atItem(api, path, async () => ensure(await identity(api, path) === ref.item, 'revoked'))
        let value
        try { value = text.decode(plain) } catch { return fail('field') }
        return value.includes('\0') ? fail('field') : { ok: true, value }
      } finally {
        key?.fill(0)
        plain?.fill(0)
        try { await api.close(session) } catch {}
      }
    }, { renew: true })
  }

  async function atSecret(api, path, session) {
    try { return await api.secret(path, session) }
    catch (err) {
      if (!missing(err)) throw err
      return confirmDeleted(api, path)
    }
  }

  function listItems({ search = '', signal } = {}) {
    const listingGate = binding
    const listing = {}
    currentListing = listing
    return operation(signal, async api => {
      const handles = new Map()
      const items = []
      const labels = new Map()
      const query = typeof search === 'string' ? search.toLowerCase() : ''
      let scanned = 0
      for (const path of await api.collections()) {
        if (!collectionPath(path)) continue
        const collection = await api.collectionLabel(path)
        if (await api.collectionLocked(path)) {
          items.push({ collection, locked: true })
          continue
        }
        for (const item of await api.items(path)) {
          if (scanned === 200) break
          scanned++
          if (!itemPath(item) || collectionOf(item) !== path || await api.locked(item)) continue
          const name = await api.label(item)
          if (query !== '' && !name.toLowerCase().includes(query) && !collection.toLowerCase().includes(query)) continue
          if (reserved(await api.attributes(item))) continue
          const handle = randomBytes(16).toString('hex')
          const created = (await api.created(item)).toString()
          handles.set(handle, { path: item, name, collection, created })
          const row = { handle, name, collection, field: 'secret' }
          const label = JSON.stringify([collection, name])
          if (!labels.has(label)) labels.set(label, [])
          labels.get(label).push(row)
          items.push(row)
        }
        if (scanned >= 200) break
      }
      for (const duplicates of labels.values()) {
        if (duplicates.length < 2) continue
        for (const row of duplicates) row.created = handles.get(row.handle).created
      }
      return { ok: true, items, handles }
    }, { picker: true }).then(result => {
      if (!result.ok) return result
      if (binding !== listingGate || state.credential === undefined || signal?.aborted) return fail('locked')
      if (currentListing !== listing) return fail('revoked')
      listing.handles = result.handles
      return { ok: true, items: result.items }
    })
  }

  function resolveHandle({ handle, signal } = {}) {
    return operation(signal, async api => {
      const listing = currentListing
      const choice = validHandle(handle) ? listing?.handles?.get(handle) : undefined
      ensure(choice !== undefined, 'revoked')
      const { path, name, created, collection } = choice
      return atItem(api, path, async parent => {
        ensure(await api.label(path) === name && await api.collectionLabel(parent) === collection, 'revoked')
        const timestamp = (await api.created(path)).toString()
        ensure(timestamp === created, 'revoked')
        const item = await identity(api, path, timestamp)
        ensure(itemParts(item) !== undefined)
        ensure(currentListing === listing, 'revoked')
        return { ok: true, item }
      })
    })
  }

  function detail({ item, signal } = {}) {
    return operation(signal, async api => {
      const parts = itemParts(item)
      ensure(parts !== undefined)
      const [path, created] = parts
      return atItem(api, path, async collection => {
        const name = await api.label(path)
        const label = await api.collectionLabel(collection)
        ensure(await identity(api, path) === item, 'revoked')
        await atItem(api, path, () => {})
        return { ok: true, name, collection: label, created }
      })
    })
  }

  return {
    availability: unavailable,
    get binding() {
      currentGate()
      return binding
    },
    status, unlock, read, listItems, resolveHandle, detail, retire, prepareQuit: state.dispose,
  }
}
