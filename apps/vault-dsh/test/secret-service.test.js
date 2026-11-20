import assert from 'node:assert/strict'
import { createCipheriv, createDiffieHellman, hkdfSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'
import { createSecretService } from '../src/secret-service/adapter.js'
import { bus, busPath, connectBus, encodeMessage, Frames, serviceName } from '../src/secret-service/dbus.js'
import { algorithm } from '../src/secret-service/crypto.js'
import { attributeDigest, itemParts, provider, root } from '../src/secret-service/parse.js'
import { fakeToken } from './fixtures/bws.mjs'
const OAKLEY2 = 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74'
  + '020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437'
  + '4fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed'
  + 'ee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff'

const collectionPath = root + '/collection/fixture'
const lockedPath = root + '/collection/locked'
const itemPath = collectionPath + '/1'
const secondPath = collectionPath + '/2'
const sessionPath = root + '/session/fixture'
const created = 18446744073709551598n
const iface = kind => 'org.freedesktop.Secret.' + kind
const props = 'org.freedesktop.DBus.Properties'
const secretError = name => iface('Error.' + name)
const busError = name => bus + '.Error.' + name
const refused = code => ({ ok: false, code })
const same = (a, b, why) => assert.equal(JSON.stringify(a) === JSON.stringify(b), true, why)
const privateText = () => randomBytes(24).toString('hex')

async function fakeKeyring(t, { guid = 'a'.repeat(32), id = 'b'.repeat(32) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ss-peer-'))
  const path = join(home, 'bus')
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path + ',guid=' + guid }
  const sockets = new Set()
  const monitors = new Set()
  const calls = []
  const itemLabel = privateText()
  const collectionLabel = privateText()
  const lockedLabel = privateText()
  const attr = privateText()
  const value = privateText()
  let serial = 1000
  const state = {
    owner: ':1.40', present: true, locked: false, itemLocked: false,
    attributes: [['z', attr], ['a', 'value']], value: Buffer.from('\ufeff ' + value + '\n'),
    mime: 'text/plain', activations: 0, connections: 0, opens: 0, reads: 0,
    closes: 0, items: [itemPath, secondPath], errors: [], sockets,
  }

  const server = createServer(socket => {
    state.connections++
    sockets.add(socket)
    socket.once('error', () => socket.destroy())
    let key
    socket.once('close', () => {
      sockets.delete(socket)
      monitors.delete(socket)
      key?.fill(0)
    })

    function send(request, signature, body, extra = {}) {
      const { sender = request.headers.destination, reply = request.serial, error } = extra
      socket.write(encodeMessage({
        type: error === undefined ? 2 : 3, serial: ++serial,
        headers: { sender, reply, ...(error === undefined ? {} : { error }) }, signature, body,
      }))
    }

    function receive(request) {
      const { destination, path, interface: kind, member } = request.headers
      if (destination === serviceName) state.activations++
      assert.equal(request.flags & 2, 2, 'NO_AUTO_START is required on every call')
      assert.equal(destination === bus || destination.startsWith(':'), true, 'well-known name was used as a destination')
      const property = member === 'Get' ? request.body[1] : undefined
      calls.push({ destination, interface: kind, member, property, requestedInterface: member === 'Get' ? request.body[0] : undefined, path })
      const reply = (signature, body, extra) => send(request, signature, body, extra)
      const error = (name, sender = destination) => reply('s', [value], { error: name, sender })
      if (state.hook?.({ request, reply, error, property, socket })) return
      if (destination === bus) {
        assert.equal(path === busPath && kind === bus, true)
        switch (member) {
          case 'Hello': return reply('s', [':1.88'])
          case 'GetId': return reply('s', [id])
          case 'AddMatch':
            assert.equal(request.body[0].includes("arg0='org.freedesktop.secrets'"), true)
            monitors.add(socket)
            return reply('', [])
          case 'GetNameOwner':
            assert.deepEqual(request.body, [serviceName])
            return state.present ? reply('s', [state.owner]) : error(busError('NameHasNoOwner'))
          case 'GetConnectionUnixProcessID':
            if (request.body[0] !== state.owner || !state.present) return error(busError('NameHasNoOwner'))
            return reply('u', [process.pid])
          default: assert.fail('unexpected bus method')
        }
      }
      if (destination !== state.owner || !state.present) return error(busError('ServiceUnknown'), bus)
      if (kind === props && member === 'Get') {
        const [wanted, name] = request.body
        const item = path === itemPath || path === secondPath
        const collection = path === collectionPath || path === lockedPath
        const variant = (signature, value) => reply('v', [{ signature, value }])
        switch (wanted + ':' + name) {
          case iface('Service') + ':Collections':
            assert.equal(path, root)
            return variant('ao', [collectionPath, lockedPath, root + '/aliases/default'])
          case iface('Collection') + ':Locked': assert.equal(collection, true); return variant('b', path === lockedPath || state.locked)
          case iface('Collection') + ':Label': assert.equal(collection, true); return variant('s', path === lockedPath ? lockedLabel : collectionLabel)
          case iface('Collection') + ':Items': assert.equal(path, collectionPath); return variant('ao', state.items)
          case iface('Item') + ':Locked': assert.equal(item, true); return variant('b', state.itemLocked)
          case iface('Item') + ':Label': assert.equal(item, true); return variant('s', state.renamed ?? itemLabel)
          case iface('Item') + ':Created': assert.equal(item, true); return variant('t', path === itemPath ? created : created - 1n)
          case iface('Item') + ':Attributes': assert.equal(item, true); return variant('a{ss}', state.attributes)
          default: assert.fail('unexpected property')
        }
      }
      switch (kind + ':' + member) {
        case iface('Service') + ':OpenSession': {
          state.opens++
          const [alg, publicKey] = request.body
          assert.equal(alg === algorithm && publicKey.signature === 'ay' && path === root, true)
          // The peer's own copy of RFC 2409's second Oakley group: Electron has no named modp2 group.
          const dh = createDiffieHellman(OAKLEY2, 'hex', 2)
          const own = dh.generateKeys()
          const shared = dh.computeSecret(publicKey.value)
          key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 16))
          shared.fill(0)
          return reply('vo', [{ signature: 'ay', value: own }, state.session ?? sessionPath])
        }
        case iface('Item') + ':GetSecret': {
          state.reads++
          assert.equal(path === itemPath && request.body[0] === sessionPath && key !== undefined, true)
          if (state.readError !== undefined) {
            state.onRead?.()
            return error(state.readError)
          }
          const iv = randomBytes(16)
          const cipher = createCipheriv('aes-128-cbc', key, iv)
          const encrypted = Buffer.concat([cipher.update(state.value), cipher.final()])
          state.onRead?.()
          return reply('(oayays)', [[state.returnedSession ?? sessionPath, iv, encrypted, state.mime]])
        }
        case iface('Session') + ':Close':
          state.closes++
          assert.equal(path, sessionPath)
          return state.closeError ? error(secretError('NoSession')) : reply('', [])
        default: assert.fail('unexpected method')
      }
    }

    const frames = new Frames()
    let handshake = Buffer.alloc(0)
    let step = 0
    socket.on('data', chunk => {
      try {
        if (step < 2) {
          handshake = Buffer.concat([handshake, chunk])
          while (step < 2) {
            const newline = handshake.indexOf(10)
            if (newline === -1) return
            const line = handshake.subarray(0, newline + 1).toString()
            handshake = handshake.subarray(newline + 1)
            if (step++ === 0) {
              assert.equal(line, '\0AUTH EXTERNAL ' + Buffer.from(String(process.getuid())).toString('hex') + '\r\n')
              if (state.authReply !== undefined) {
                socket.write(state.authReply)
                return
              }
              socket.write('OK ' + guid.slice(0, 12))
              socket.write(guid.slice(12) + '\r\n')
            } else {
              assert.equal(line, 'BEGIN\r\n', 'Unix FD negotiation must not be attempted')
            }
          }
          chunk = handshake
          handshake = undefined
        }
        frames.push(chunk, receive)
      } catch (error) {
        state.errors.push(error)
        socket.destroy()
      }
    })
  })

  t.after(async () => {
    try {
      for (const socket of sockets) socket.destroy()
      if (server.listening) {
        const closed = once(server, 'close')
        server.close()
        await closed
      }
      assert.equal(state.errors.length, 0, 'the peer observed an unexpected request')
      assert.equal(state.activations, 0)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  await once(server.listen(path), 'listening')
  const adapter = options => {
    const instance = createSecretService(options?.config, { env, platform: 'linux', verifyProcess: async (pid, confirm) => pid === await confirm(), ...options })
    t.after(() => instance.prepareQuit())
    return instance
  }
  const signal = (from = bus, name = serviceName) => {
    const frame = encodeMessage({
      type: 4, serial: ++serial, headers: { sender: from, path: busPath, interface: bus, member: 'NameOwnerChanged' },
      signature: 'sss', body: [name, state.owner, ':1.41'],
    })
    for (const socket of monitors) socket.write(frame)
  }
  return { state, env, calls, adapter, signal, itemLabel, collectionLabel, lockedLabel, attr, value, itemPath }
}

async function mapped(h, adapter) {
  const listed = await adapter.listItems()
  assert.equal(listed.ok, true)
  const mapped = await adapter.resolveHandle({ handle: listed.items[0].handle })
  assert.equal(mapped.ok, true)
  return { provider, field: 'secret', item: mapped.item }
}

test('pins owner, lists opaque handles without exposing attributes, and reads only the selected field', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(adapter.status(), { state: 'locked' })
  assert.deepEqual(await adapter.listItems(), refused('locked'))
  assert.equal(h.state.connections, 0)
  assert.deepEqual(await adapter.unlock(), { ok: true })
  assert.equal(Object.isFrozen(adapter.binding), true)
  const gate = adapter.binding
  assert.deepEqual(h.calls.slice(0, 4).map(call => call.member), ['Hello', 'AddMatch', 'GetId', 'GetNameOwner'])
  const { items } = await adapter.listItems()
  assert.equal(items.length, 3)
  assert.equal(items[0].name === h.itemLabel && items[0].collection === h.collectionLabel, true)
  assert.equal(items[0].field, 'secret')
  assert.equal(items[0].created, created.toString())
  assert.equal(items[1].created, (created - 1n).toString())
  same(items[2], { collection: h.lockedLabel, locked: true })
  assert.equal(h.calls.some(call => call.path === root + '/aliases/default'), false)
  assert.equal(h.calls.filter(call => call.property === 'Attributes').length, 2)
  const old = items[0].handle
  const listed = await adapter.listItems()
  assert.notEqual(listed.items[0].handle, old)
  assert.deepEqual(await adapter.resolveHandle({ handle: old }), refused('revoked'))
  const { item } = await adapter.resolveHandle({ handle: listed.items[0].handle })
  same(itemParts(item), [itemPath, created.toString(), attributeDigest(h.state.attributes)])
  assert.equal(h.calls.filter(call => call.property === 'Attributes').length, 5)
  const ref = { provider, item, field: 'secret' }
  h.state.renamed = privateText()
  assert.deepEqual(await adapter.resolveHandle({ handle: listed.items[0].handle }), refused('revoked'))
  same(await adapter.detail(ref), { ok: true, name: h.state.renamed, collection: h.collectionLabel, created: created.toString() })
  h.state.attributes.reverse()
  h.state.closeError = true
  same(await adapter.read(ref), { ok: true, value: h.state.value.toString() }, 'BOM and whitespace are preserved')
  assert.equal(h.state.reads, 1)
  assert.equal(h.state.closes, 1)
  assert.equal(h.calls.every(call => call.destination === bus || call.destination === h.state.owner), true)
  assert.equal(adapter.binding, gate)
})

test('the GNOME picker, handle resolution and read refuse reserved Automagik credential records', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  const credential = [['automagik-vault-item', 'automagik-vault:v1:' + privateText().slice(0, 32)]]
  h.state.value = Buffer.from(Buffer.from(JSON.stringify({ v: 1, token: fakeToken(), server: 'us' })).toString('base64'))
  let reserved = true
  h.state.hook = ({ request, reply, property }) => {
    if (request.headers.path !== itemPath) return false
    if (property === 'Attributes' && reserved) reply('v', [{ signature: 'a{ss}', value: credential }])
    else if (property === 'Label') reply('v', [{ signature: 's', value: 'Automagik Vault' }])
    else return false
    return true
  }
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const listing = await adapter.listItems()
  assert.equal(listing.ok, true)
  assert.equal(listing.items.filter(row => !row.locked).length, 1)
  const ordinary = await adapter.resolveHandle({ handle: listing.items[0].handle })
  assert.equal(ordinary.ok && itemParts(ordinary.item)[0] === secondPath, true)
  reserved = false
  const prior = await adapter.listItems()
  const handle = prior.items.find(row => row.name === 'Automagik Vault').handle
  reserved = true
  assert.deepEqual(await adapter.resolveHandle({ handle }), refused('refused'))
  const item = JSON.stringify([itemPath, created.toString(), attributeDigest(credential)])
  assert.deepEqual(await adapter.read({ provider, item, field: 'secret' }), refused('refused'))
  assert.equal(h.state.reads, 0)
})

test('checks attributes and membership before and after GetSecret, and confirms ambiguous deletion errors', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  const attributes = h.state.attributes
  h.state.attributes = [['changed', h.attr]]
  assert.deepEqual(await adapter.read(ref), refused('revoked'))
  assert.equal(h.state.reads, 0)
  h.state.attributes = attributes
  h.state.onRead = () => { h.state.attributes = [['replacement', h.attr]] }
  assert.deepEqual(await adapter.read(ref), refused('revoked'))
  assert.equal(h.state.reads, 1)
  h.state.attributes = attributes
  h.state.onRead = () => { h.state.items = [secondPath] }
  assert.deepEqual(await adapter.read(ref), refused('revoked'))
  assert.equal(h.state.reads, 2)
  h.state.items = [itemPath, secondPath]
  for (const error of [busError('UnknownMethod'), secretError('NoSuchObject')]) {
    h.state.readError = error
    h.state.onRead = undefined
    assert.deepEqual(await adapter.read(ref), refused('refused'))
    h.state.onRead = () => { h.state.locked = true }
    assert.deepEqual(await adapter.read(ref), refused('refused'))
    h.state.locked = false
    h.state.onRead = () => { h.state.items = [secondPath] }
    assert.deepEqual(await adapter.read(ref), refused('revoked'))
    h.state.items = [itemPath, secondPath]
  }
  h.state.onRead = undefined
  h.state.readError = undefined
  h.state.locked = true
  assert.deepEqual(await adapter.read(ref), refused('locked'))
  assert.deepEqual(adapter.status(), { state: 'unlocked' })
  h.state.locked = false
  h.state.itemLocked = true
  assert.deepEqual(await adapter.read(ref), refused('locked'))
  h.state.itemLocked = false
  // A restore with the identical tuple is indistinguishable from rotation.
  h.state.value = Buffer.from(privateText())
  same(await adapter.read(ref), { ok: true, value: h.state.value.toString() })
})

test('wire reply and remote error policy fails closed without echoing error bodies', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  for (const mime of ['', 'text/plain; charset=UTF-8', 'application/octet-stream']) {
    h.state.mime = mime
    assert.deepEqual(await adapter.read(ref), refused('field'))
  }
  h.state.mime = 'text/plain'
  for (const value of [Buffer.from([0xff]), Buffer.from('text\0')]) {
    h.state.value = value
    assert.deepEqual(await adapter.read(ref), refused('field'))
  }
  h.state.returnedSession = root + '/session/other'
  assert.deepEqual(await adapter.read(ref), refused('refused'))
  h.state.returnedSession = undefined
  for (const [error, code] of [[secretError('IsLocked'), 'locked'], [secretError('NoSession'), 'refused'],
    [busError('ServiceUnknown'), 'unavailable'], [busError('NameHasNoOwner'), 'unavailable'], [busError('AccessDenied'), 'refused']]) {
    h.state.readError = error
    assert.deepEqual(await adapter.read(ref), refused(code))
  }
  h.state.readError = undefined
  h.state.hook = ({ request, reply }) => {
    if (request.headers.member !== 'GetSecret') return false
    reply('(oayay)', [[sessionPath, Buffer.alloc(16), Buffer.alloc(16)]])
    return true
  }
  assert.deepEqual(await adapter.read(ref), refused('refused'))
  h.state.hook = undefined
  h.state.session = '/'
  assert.deepEqual(await adapter.read(ref), refused('refused'))
  h.state.session = undefined
  h.state.hook = ({ request, reply, error, property }) => {
    if (request.headers.member === 'OpenSession') {
      error(busError('NotSupported'))
      return true
    }
    if (property !== 'Label') return false
    reply('v', [{ signature: 's', value: h.itemLabel }], { reply: request.serial + 1 })
    reply('v', [{ signature: 's', value: h.itemLabel }], { sender: ':1.99' })
    return true
  }
  assert.deepEqual(await adapter.read(ref), refused('refused'))
  assert.deepEqual(await adapter.detail(ref), refused('refused'))
})

test('trusted signals, preflight owner loss, changed bus identity and disconnect invalidate the gate', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const gate = adapter.binding
  h.signal(':1.73')
  h.signal(bus, 'other.service')
  await adapter.listItems()
  assert.equal(adapter.binding, gate)
  h.signal()
  for (let at = 0; adapter.binding === gate && at < 20; at++) await tick()
  assert.notEqual(adapter.binding, gate)
  assert.deepEqual(adapter.status(), { state: 'locked' })
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  h.state.hook = ({ request, error }) => {
    if (request.headers.member !== 'OpenSession') return false
    h.state.present = false
    error(busError('ServiceUnknown'), bus)
    h.signal()
    return true
  }
  const answer = await adapter.read(ref)
  assert.equal(!answer.ok && ['locked', 'unavailable'].includes(answer.code), true)
  assert.equal(h.state.reads, 0)
  h.state.hook = undefined
  h.state.present = true
  await adapter.retire()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const alternate = await fakeKeyring(t, { id: 'c'.repeat(32) })
  h.env.DBUS_SESSION_BUS_ADDRESS = alternate.env.DBUS_SESSION_BUS_ADDRESS
  assert.deepEqual(await adapter.listItems(), refused('locked'))
  assert.deepEqual(adapter.status(), { state: 'locked' })
  assert.equal(alternate.calls.some(call => call.property !== undefined), false)
  h.env.DBUS_SESSION_BUS_ADDRESS = h.env.DBUS_SESSION_BUS_ADDRESS.replace(/ss-peer-[^/]+/, 'missing')
  assert.deepEqual(await adapter.unlock(), refused('unavailable'))
})

test('platform, Cloud, tracing, then backend checks precede metadata and idle renews only on a field read', async t => {
  const h = await fakeKeyring(t)
  const cloud = { ...h.env, AUTOMAGIK_GATE_CLOUD_WORKSPACE: 'fixture' }
  assert.deepEqual(await h.adapter({ env: cloud, platform: 'win32' }).unlock(), refused('platform'))
  assert.deepEqual(await h.adapter({ env: cloud }).unlock(), refused('cloud'))
  assert.deepEqual(await h.adapter({ env: { ...h.env, NODE_DEBUG: '*' } }).unlock(), refused('refused'))
  assert.equal(h.state.connections, 0)
  assert.deepEqual(await h.adapter({ verifyProcess: undefined }).unlock(), refused('unsupported'))
  assert.equal(h.calls.some(call => call.property !== undefined), false)
  let idle
  let renewals = 0
  const adapter = h.adapter({
    config: { idleLockMinutes: 1000 },
    timers: {
      setTimeout(work, ms) {
        assert.equal(ms, 480 * 60000)
        renewals++
        idle = work
        return {}
      },
      clearTimeout() {},
    },
  })
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  assert.equal((await adapter.detail(ref)).ok, true)
  assert.equal(renewals, 1)
  assert.equal((await adapter.read(ref)).ok, true)
  assert.equal(renewals, 2)
  const gate = adapter.binding
  idle()
  assert.deepEqual(adapter.status(), { state: 'locked' })
  assert.notEqual(adapter.binding, gate)
  await adapter.retire()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  for (const socket of h.state.sockets) socket.destroy()
  for (let at = 0; adapter.status().state !== 'locked' && at < 20; at++) await tick()
  assert.deepEqual(adapter.status(), { state: 'locked' })
})

test('lock and quit drain a stalled read and queued detail without releasing data', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  const entered = Promise.withResolvers()
  h.state.hook = ({ request }) => {
    if (request.headers.member !== 'GetSecret') return false
    entered.resolve()
    return true
  }
  const before = h.state.connections
  const read = adapter.read(ref)
  const detail = adapter.detail(ref)
  await entered.promise
  assert.equal(await adapter.retire(), true)
  assert.deepEqual(await read, refused('locked'))
  assert.deepEqual(await detail, refused('locked'))
  assert.equal(h.state.connections, before + 1)
  assert.deepEqual(await adapter.prepareQuit(), { ok: true })
  assert.deepEqual(await adapter.unlock(), refused('locked'))
})

test('auth caps lines, rejects mismatched GUIDs and refuses to fall back to another address', async t => {
  const h = await fakeKeyring(t)
  const opts = { env: h.env, signal: AbortSignal.timeout(2000) }
  const path = h.env.DBUS_SESSION_BUS_ADDRESS
  await assert.rejects(connectBus(path.replace(/a{32}$/, 'c'.repeat(32)), opts), { code: 'refused' })
  await assert.rejects(connectBus(path + ';' + path, opts), { code: 'refused' })
  assert.equal(h.state.connections, 1)
  h.state.authReply = 'X'.repeat(4097)
  await assert.rejects(connectBus(path, opts), { code: 'refused' })
  assert.equal(h.calls.length, 0, 'no Hello before a verified EXTERNAL handshake')
})

test('picker scans no more than 200 items across the listing', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  h.state.items = Array(201).fill(h.itemPath)
  assert.deepEqual(await adapter.listItems({ search: 'no matching label' }), { ok: true, items: [] })
  assert.equal(h.calls.filter(call => call.path === h.itemPath && call.property === 'Locked').length, 200)
  assert.equal(h.calls.some(call => call.property === 'Attributes'), false)
})

test('picker and queued reads each keep their operation deadline', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const control = new AbortController()
    deadlines.push({ milliseconds, control })
    return control.signal
  })
  const entered = Promise.withResolvers()
  h.state.hook = ({ property }) => {
    if (property !== 'Collections') return false
    entered.resolve()
    return true
  }
  const picker = adapter.listItems()
  await entered.promise
  const read = adapter.read(ref)
  assert.deepEqual(deadlines.map(entry => entry.milliseconds), [20000, 10000])
  deadlines[1].control.abort()
  assert.deepEqual(await read, refused('refused'))
  deadlines[0].control.abort()
  assert.deepEqual(await picker, refused('refused'))
  assert.equal(h.state.reads, 0)
  assert.deepEqual(adapter.status(), { state: 'unlocked' })
  await adapter.retire()
})

test('post-read Created change revokes and zeroes decrypted bytes before returning', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  let afterSecret = false
  const wiped = []
  const fill = Buffer.prototype.fill
  t.mock.method(Buffer.prototype, 'fill', function (...args) {
    if (this.includes(h.state.value)) wiped.push(this)
    return fill.apply(this, args)
  })
  h.state.onRead = () => { afterSecret = true }
  h.state.hook = ({ property, reply }) => {
    if (!afterSecret || property !== 'Created') return false
    reply('v', [{ signature: 't', value: created + 1n }])
    return true
  }
  assert.deepEqual(await adapter.read(ref), refused('revoked'))
  assert.equal(h.state.reads, 1)
  assert.equal(wiped.length, 1, 'the decrypted buffer was wiped')
  assert.equal(wiped[0].every(byte => byte === 0), true)
})

test('wire calls use only the exact allowed methods and properties, never GetAll', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  assert.deepEqual(await adapter.unlock(), { ok: true })
  const ref = await mapped(h, adapter)
  assert.equal((await adapter.detail(ref)).ok, true)
  assert.equal((await adapter.read(ref)).ok, true)
  await adapter.retire()
  const allowed = new Set([
    'org.freedesktop.DBus.Hello', 'org.freedesktop.DBus.AddMatch',
    'org.freedesktop.DBus.GetId', 'org.freedesktop.DBus.GetNameOwner',
    'org.freedesktop.DBus.GetConnectionUnixProcessID',
    'org.freedesktop.Secret.Service.Collections',
    'org.freedesktop.Secret.Collection.Label', 'org.freedesktop.Secret.Collection.Locked',
    'org.freedesktop.Secret.Collection.Items',
    'org.freedesktop.Secret.Item.Label', 'org.freedesktop.Secret.Item.Created',
    'org.freedesktop.Secret.Item.Locked', 'org.freedesktop.Secret.Item.Attributes',
    'org.freedesktop.Secret.Service.OpenSession', 'org.freedesktop.Secret.Item.GetSecret',
    'org.freedesktop.Secret.Session.Close',
  ])
  const actual = h.calls.map(call => call.member === 'Get'
    ? call.requestedInterface + '.' + call.property : call.interface + '.' + call.member)
  assert.deepEqual(new Set(actual), allowed)
  assert.equal(actual.every(call => allowed.has(call)), true)
  assert.equal(h.calls.some(call => call.member === 'GetAll'), false)
})

test('owner change between subscription and discovery closes the gate before metadata', async t => {
  const h = await fakeKeyring(t)
  const adapter = h.adapter()
  h.state.hook = ({ request, reply }) => {
    if (request.headers.member !== 'GetNameOwner') return false
    h.signal()
    reply('s', [h.state.owner])
    return true
  }
  assert.deepEqual(await adapter.unlock(), refused('locked'))
  assert.deepEqual(adapter.status(), { state: 'locked' })
  assert.equal(h.calls.some(call => call.member === 'Get'), false)
  assert.equal(h.state.activations, 0)
})
