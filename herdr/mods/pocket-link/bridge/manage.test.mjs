// The phone wire and bot socket, with the real ChatConnection, DshSource and writer.
// In-memory sockets let a test hold a hello, grant ack or reply without running Herdr.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatConnection, chatWriter, DATA, frame, MAX_IN_FLIGHT, MAX_REQUEST } from './chat.mjs'
import { DshSource, withDsh, WRITES_PER_MINUTE } from './dsh-source.mjs'
import { endRemoved } from './guard.mjs'

const TEAM = '/team/pocket/chat.sock'
const OTHER_TEAM = '/other-team/pocket/chat.sock'
const methods = ['memory.read', 'memory.edit', 'memory.add']
const socketMethods = ['memory-read', 'memory-edit', 'memory-add']
const terminal = 'dsh:worker'
const target = { terminal }
const edit = { terminal, id: 'a_1-b', rev: '0123456789abcdef', text: 'entry' }
const add = { terminal, text: 'entry' }
const memory = { terminal, entries: [], size: 0, limit: 8000, truncated: false }
const read = { ok: true, state: 'read', memory }
const saved = { ok: true, state: 'saved', entry: null, memory: null }
const refused = (reason) => ({ ok: false, state: 'refused', reason })
const unknown = { ok: false, state: 'unknown', reason: 'offline' }
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
const requestFrame = (id, method, params) => frame(0, DATA, Buffer.from(rpc(id, method, params)))

async function until(check, message) {
  const deadline = Date.now() + 2000
  for (;;) {
    const value = check()
    if (value) return value
    assert.ok(Date.now() < deadline, message)
    await delay(1)
  }
}

function helloResult({ writable = true, offers = socketMethods } = {}, params) {
  const methods = ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill']
  if (!writable) return { protocol: 1, readOnly: true, methods }
  return {
    protocol: 1, readOnly: false, write: 1, methods: [...methods, 'send', 'interrupt', 'answer'],
    ...(params.manage === 1 && offers.length ? { manage: 1, manageMethods: ['manage-open', 'manage-close', ...offers] } : {}),
  }
}

class FakeSocket extends EventEmitter {
  constructor(host) {
    super()
    this.host = host
    this.requests = []
    this.grants = new Map()
    this.destroyed = false
    queueMicrotask(() => { if (!this.destroyed) this.emit('connect') })
  }

  setEncoding(enc) { assert.equal(enc, 'utf8') }

  write(line) {
    const request = JSON.parse(line)
    if (this.host.unwritten?.(request)) throw new Error('write failed')
    assert.equal(this.destroyed, false)
    this.requests.push(request)
    const { method, params } = request
    // Like the host, apply the grant change even if the test holds back its ack.
    if (method === 'hello') this.grants.clear()
    if (method === 'manage-open') this.grants.set(params.grant, params.phone)
    if (method === 'manage-close') this.grants.delete(params.grant)
    const answer = this.host.reply?.(request, this)
    if (answer === null) return
    this.reply(request, answer ?? this.defaultReply(request))
  }

  defaultReply({ method, params }) {
    switch (method) {
      case 'hello': return { result: helloResult(this.host, params) }
      case 'manage-open': return { result: { grant: params.grant } }
      case 'memory-read':
      case 'memory-edit':
      case 'memory-add':
        assert.ok(this.grants.has(params.grant))
        return { result: method === 'memory-read' ? read : saved }
      case 'list': return { result: { terminals: [{ terminal, agent: 'dsh' }] } }
      case 'subscribe': return { result: { channel: params.channel } }
      case 'send': return { result: { state: 'sent', id: params.id } }
      default: return { result: {} }
    }
  }

  reply(request, answer = { result: { grant: request.params.grant } }) {
    queueMicrotask(() => this.emit('data', JSON.stringify({ id: request.id, ...answer }) + '\n'))
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.grants.clear()
    if (!this.holdClose) queueMicrotask(() => this.emit('close'))
  }

  calls(method) { return this.requests.filter((m) => m.method === method) }
}

function world(t, { hosts = { [TEAM]: {} }, requestMs = 100, now, log } = {}) {
  const sockets = []
  const eligible = new Set(Object.keys(hosts))
  const dsh = new DshSource({
    paths: [...eligible], requestMs, now, log,
    check: path => eligible.has(path),
    connect: path => {
      const socket = new FakeSocket(hosts[path])
      sockets.push(socket)
      return socket
    },
  })
  t.after(() => dsh.close())
  const engine = {
    ready: async () => {},
    list: () => [{ terminal: 't1', agent: 'claude' }],
    watch: () => ({ rows: () => [], screen: () => [], status: () => null, approval: () => null, held: () => [], close() {} }),
    send: (_client, _terminal, { id }) => ({ state: 'sent', id }),
  }
  return { dsh, sockets, eligible, engine: withDsh(engine, dsh) }
}

function phone(engine, { device = 'paired-key', log, send, maxUnsent } = {}) {
  let nextId = 1
  let revoked = false
  const submitted = []
  const queued = []
  const ended = []
  const writer = send && chatWriter({
    send: bytes => { submitted.push(bytes); return send(bytes) },
    isClosed: () => conn.closed,
    isRevoked: () => revoked,
    onFail: () => conn.close('write failed'),
  })
  const conn = new ChatConnection({
    engine, device, log, maxUnsent,
    end: reason => ended.push(reason),
    write: (bytes, opts) => {
      queued.push({ bytes, opts })
      if (writer) return writer(bytes, opts)
      submitted.push(bytes)
    },
  })
  const answer = (id) => until(() => submitted.slice(1)
    .filter(b => b.readUInt32LE(0) === 0 && b.readUInt8(4) === DATA)
    .map(b => JSON.parse(b.subarray(9))).find(m => m.id === id), `phone reply ${id}`)
  return {
    conn, answer, ended, queued, submitted, writer,
    hello(manage) {
      conn.feed(Buffer.from(rpc(0, 'hello', { generation: 1, framed: true, ...(manage === undefined ? {} : { manage }) }) + '\n'))
    },
    async greeted() { return JSON.parse(await until(() => submitted[0], 'phone hello')).result },
    send(method, params = {}) {
      const id = nextId++
      conn.feed(requestFrame(id, method, params))
      return id
    },
    call(method, params) { return answer(this.send(method, params)) },
    revoke() { revoked = true; conn.close('not paired') },
  }
}

test('old phone gets the ordinary synchronous hello on a new host, with no grant', async (t) => {
  const capable = world(t)
  const old = world(t, { hosts: { [TEAM]: { offers: [] } } })
  const socket = await capable.dsh.open()
  await old.dsh.open()
  const p = phone(capable.engine)
  const baseline = phone(old.engine)
  baseline.hello()
  p.hello()
  assert.equal(p.conn.framed, true)
  assert.deepEqual(p.submitted, baseline.submitted)
  assert.deepEqual(socket.requests.map(m => m.params), [{ write: 1 }, { write: 1, manage: 1 }])
  assert.deepEqual((await p.call('memory.read', { terminal: 'dsh:' })).result, refused('read-only'))
  assert.equal(socket.calls('manage-open').length, 0)
})

test('new phone on an old writable host, or with no paired key, gets no memory offer', async (t) => {
  const old = world(t, { hosts: { [TEAM]: { offers: [] } } })
  const capable = world(t)
  for (const [w, device] of [[old, 'key'], [capable, null]]) {
    const socket = await w.dsh.open()
    const p = phone(w.engine, { device })
    p.hello(methods)
    const hello = await p.greeted()
    assert.equal(hello.dshWrite, true)
    assert.equal(hello.manage, undefined)
    assert.deepEqual((await p.call('memory.read', target)).result, refused('read-only'))
    assert.equal(socket.calls('manage-open').length, 0)
  }
})

test('only known requested methods in the host offer are negotiated, without duplicates', async (t) => {
  for (const [offers, requested, expected] of [
    [socketMethods, ['memory.read'], ['memory.read']],
    [['memory-read', 'memory-add', 'memory-unlisted'], [...methods, 'memory.add', 'memory.unlisted', 'manage-open'], ['memory.read', 'memory.add']],
  ]) {
    const { dsh, engine } = world(t, { hosts: { [TEAM]: { offers } } })
    const socket = await dsh.open()
    const p = phone(engine)
    p.hello(requested)
    assert.deepEqual((await p.greeted()).manage, expected)
    assert.deepEqual((await p.call('memory.edit', edit)).result, refused('read-only'))
    assert.deepEqual((await p.call('memory.read', target)).result, read)
    assert.equal(socket.calls('manage-open').length, 1)
    assert.equal(socket.calls('memory-edit').length, 0)
  }
})

test('open refusal closes the grant attempt and keeps terminal chat and subscribed DSH writes working', async (t) => {
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-open' ? { error: { kind: 'too_many', message: 'full' } } : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  assert.equal((await p.greeted()).manage, undefined)
  assert.deepEqual(socket.calls('manage-close').map(m => m.params), [{ grant: 'g1' }])
  assert.deepEqual((await p.call('memory.add', add)).result, refused('read-only'))
  assert.deepEqual((await p.call('chat.list')).result.terminals.map(row => row.terminal), ['t1', terminal])
  for (const watched of ['t1', terminal]) {
    assert.ok((await p.call('chat.subscribe', { terminal: watched })).result.channel)
    assert.deepEqual((await p.call('chat.send', { terminal: watched, text: 'hi', id: 'chat-1' })).result, { state: 'sent', id: 'chat-1' })
  }
  assert.equal(socket.calls('send').length, 1)
})

test('pipelined frames across feeds wait for the grant, and a blocked hello write stays first', async (t) => {
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-open' ? null : undefined,
  } } })
  const socket = await dsh.open()
  const helloWrite = Promise.withResolvers()
  const p = phone(engine, { send: () => helloWrite.promise })
  t.after(helloWrite.resolve)
  const first = requestFrame(1, 'memory.read', target)
  p.conn.feed(Buffer.concat([Buffer.from(rpc(0, 'hello', { generation: 1, framed: true, manage: methods }) + '\n'), first.subarray(0, 7)]))
  p.conn.feed(first.subarray(7))
  p.conn.feed(requestFrame(2, 'chat.list', {}))
  await tick()
  assert.deepEqual(socket.requests.map(m => m.method), ['hello', 'hello', 'manage-open'])
  assert.equal(p.queued.length, 0)
  socket.reply(socket.calls('manage-open')[0])
  await until(() => p.queued.length === 3, 'hello and both replies queued')
  assert.deepEqual((await p.greeted()).manage, methods)
  assert.equal(p.submitted.length, 1)
  assert.equal(socket.calls('memory-read').length, 1)
  assert.equal(socket.calls('list').length, 1)
  helloWrite.resolve()
  assert.deepEqual((await p.answer(1)).result, read)
  assert.ok((await p.answer(2)).result.terminals.length)
  assert.equal(p.submitted.length, 3)
})

test('buffered negotiating input is capped and overflow closes the opening grant', async (t) => {
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-open' ? null : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  p.conn.feed(Buffer.alloc(MAX_REQUEST))
  assert.equal(p.conn.closed, false)
  p.conn.feed(Buffer.alloc(1))
  assert.deepEqual(p.ended, ['hello too long'])
  assert.equal(p.submitted.length, 0)
  assert.deepEqual(socket.calls('manage-close').map(m => m.params), [{ grant: 'g1' }])
})

test('disconnect while grant open ack is held closes on that socket, and a late ack does nothing', async (t) => {
  const { dsh, engine, sockets } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-open' ? null : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  p.send('memory.read', target)
  const [opening] = socket.calls('manage-open')
  p.conn.close('hung up')
  assert.deepEqual(socket.calls('manage-close').map(m => m.params), [{ grant: opening.params.grant }])
  socket.reply(opening)
  await tick()
  assert.equal(p.submitted.length, 0)
  assert.equal(socket.calls('memory-read').length, 0)
  assert.equal(sockets.length, 1)
  assert.equal(socket.grants.size, 0)
})

test('lost open ack times out to the ordinary hello and closes the opening grant', async (t) => {
  const { dsh, engine } = world(t, { requestMs: 35, hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-open' ? null : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  assert.equal((await p.greeted()).manage, undefined)
  assert.deepEqual(socket.calls('manage-close').map(m => m.params), [{ grant: 'g1' }])
  assert.equal(socket.grants.size, 0)
  assert.equal(socket.destroyed, false)
})

test('a bad grant echo or socket loss during open falls back to the ordinary hello', async (t) => {
  for (const loseSocket of [false, true]) {
    const { dsh, engine } = world(t, { hosts: { [TEAM]: {
      reply: ({ method }, socket) => {
        if (method !== 'manage-open') return
        if (!loseSocket) return { result: { grant: 'wrong' } }
        socket.destroy()
        return null
      },
    } } })
    const socket = await dsh.open()
    const p = phone(engine)
    p.hello(methods)
    assert.equal((await p.greeted()).manage, undefined)
    assert.deepEqual((await p.call('memory.read', target)).result, refused('read-only'))
    assert.equal(socket.grants.size, 0)
    assert.equal(socket.calls('manage-close').length, loseSocket ? 0 : 1)
  }
})

test('two phones and two connections of one phone get separate grants, and forget closes all of that key', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const a = phone(engine), b = phone(engine), c = phone(engine, { device: 'other-key' })
  for (const p of [a, b, c]) { p.hello(methods); await p.greeted() }
  assert.deepEqual(socket.calls('manage-open').map(m => m.params), [
    { grant: 'g1', phone: 'paired-key' }, { grant: 'g2', phone: 'paired-key' }, { grant: 'g3', phone: 'other-key' },
  ])
  a.conn.close()
  assert.deepEqual([...socket.grants.keys()], ['g2', 'g3'])
  assert.deepEqual((await b.call('memory.read', target)).result, read)
  const d = phone(engine)
  d.hello(methods)
  await d.greeted()
  const live = new Set([b, c, d].map(p => ({ phone: p.conn.client.device, end: p.revoke })))
  assert.equal(endRemoved(live, new Set(['other-key'])), 2)
  assert.deepEqual(socket.calls('manage-close').map(m => m.params.grant), ['g1', 'g2', 'g4'])
  assert.deepEqual((await c.call('memory.read', target)).result, read)
  assert.equal(socket.destroyed, false)
})

test('a missing matching empty close ack destroys the socket at the 500 ms deadline', async (t) => {
  const { dsh, engine } = world(t, { requestMs: 45, hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-close' ? { result: { bad: true } } : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  p.conn.close()
  const [close] = socket.calls('manage-close')
  socket.reply(close, { id: close.id + 1, result: {} })
  t.mock.timers.tick(499)
  await tick()
  assert.equal(socket.destroyed, false)
  t.mock.timers.tick(1)
  await tick()
  assert.equal(socket.destroyed, true)
  assert.equal(dsh.socket, null)
})

test('a close write error destroys the grant socket immediately', async (t) => {
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    unwritten: ({ method }) => method === 'manage-close',
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  p.conn.close()
  await tick()
  assert.equal(socket.destroyed, true)
})

test('an old close timer and late close event leave replacement requests and grants alone', async (t) => {
  const { dsh, engine, sockets } = world(t, { requestMs: 1500, hosts: { [TEAM]: {
    reply: ({ method }) => method === 'manage-close' || method === 'memory-read' ? null : undefined,
  } } })
  const old = await dsh.open()
  const p = phone(engine), kept = phone(engine, { device: 'kept-key' })
  p.hello(methods)
  kept.hello(methods)
  await Promise.all([p.greeted(), kept.greeted()])
  p.conn.close()
  old.holdClose = true
  old.destroy()
  const id = kept.send('memory.read', target)
  const call = await until(() => sockets[1]?.calls('memory-read')[0], 'read on replacement')
  const replacement = sockets[1]
  await delay(525)
  assert.equal(replacement.destroyed, false)
  old.emit('close')
  // A reply with the same request id from the old socket is ignored.
  old.reply(call, { result: { stale: true } })
  replacement.reply(call, { result: read })
  assert.deepEqual((await kept.answer(id)).result, read)
  assert.deepEqual(replacement.calls('manage-open').map(m => m.params), [{ grant: 'g3', phone: 'kept-key' }])
})

test('same-home reconnect intersects the fixed phone offer with the replacement host offer', async (t) => {
  const host = { offers: ['memory-read', 'memory-edit'] }
  const { dsh, engine, sockets } = world(t, { hosts: { [TEAM]: host } })
  const old = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  assert.deepEqual((await p.greeted()).manage, ['memory.read', 'memory.edit'])
  host.offers = ['memory-read', 'memory-add']
  old.destroy()
  assert.deepEqual((await p.call('memory.edit', { terminal: 'dsh:' })).result, refused('read-only'))
  assert.deepEqual((await p.call('memory.add', add)).result, refused('read-only'))
  assert.equal(sockets[1].calls('manage-open').length, 0)
  assert.deepEqual((await p.call('memory.read', target)).result, read)
  assert.deepEqual(sockets[1].requests.map(m => m.method), ['hello', 'hello', 'manage-open', 'memory-read'])
})

test('the same Bot id in another eligible team home requires a fresh phone hello', async (t) => {
  const { dsh, engine, eligible, sockets } = world(t, { hosts: { [TEAM]: {}, [OTHER_TEAM]: {} } })
  const old = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  eligible.delete(TEAM)
  old.destroy()
  assert.deepEqual((await p.call('memory.read', target)).result, refused('read-only'))
  assert.deepEqual((await p.call('memory.edit', edit)).result, refused('read-only'))
  assert.deepEqual((await p.call('memory.add', add)).result, refused('read-only'))
  assert.equal(dsh.path, OTHER_TEAM)
  assert.deepEqual(sockets[1].requests.map(m => m.method), ['hello', 'hello'])
  const fresh = phone(engine)
  fresh.hello(methods)
  assert.deepEqual((await fresh.greeted()).manage, methods)
  assert.deepEqual((await fresh.call('memory.read', target)).result, read)
  sockets[1].destroy()
  eligible.add(TEAM)
  await dsh.open()
  assert.equal(dsh.path, TEAM)
  assert.deepEqual((await p.call('memory.read', target)).result, refused('read-only'))
  assert.equal(sockets[2].calls('manage-open').length, 0)
})

test('closing the phone during a replacement socket hello prevents a grant and memory request', async (t) => {
  const host = {}
  const { dsh, engine, sockets } = world(t, { hosts: { [TEAM]: host } })
  const old = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  host.reply = ({ method, params }) => method === 'hello' && params.manage ? null : undefined
  old.destroy()
  p.send('memory.read', target)
  const hello = await until(() => sockets[1]?.calls('hello')[1], 'replacement management hello')
  p.conn.close('hung up')
  sockets[1].reply(hello, { result: helloResult(host, hello.params) })
  await dsh.open()
  await tick()
  assert.deepEqual(sockets[1].requests.map(m => m.method), ['hello', 'hello'])
  assert.equal(p.submitted.length, 1)
})

test('stop between the socket hellos destroys the opening socket and never publishes it', async (t) => {
  const host = { reply: ({ method, params }) => method === 'hello' && params.manage ? null : undefined }
  const { dsh, sockets } = world(t, { hosts: { [TEAM]: host } })
  const opening = dsh.open()
  const second = await until(() => sockets[0]?.calls('hello')[1], 'second socket hello')
  assert.equal(dsh.open(), opening)
  assert.equal(dsh.socket, null)
  assert.equal(dsh.writable(), false)
  assert.equal(dsh.manages.size, 0)
  dsh.close()
  assert.equal(sockets[0].destroyed, true)
  sockets[0].reply(second, { result: helloResult(host, second.params) })
  assert.equal(await opening, null)
  assert.equal(await dsh.open(), null)
  assert.equal(dsh.writable(), false)
  assert.equal(dsh.manages.size, 0)
  assert.equal(sockets.length, 1)
})

test('a read-only or broken first hello gets no second hello, and a broken second hello stays unpublished', async (t) => {
  for (const [host, expectedHellos, usable] of [
    [{ writable: false }, 1, true],
    [{ reply: () => ({ result: { protocol: 1, readOnly: false } }) }, 1, false],
    [{ reply: ({ params }) => params.manage ? { result: { protocol: 0 } } : undefined }, 2, false],
  ]) {
    const { dsh, sockets } = world(t, { hosts: { [TEAM]: host } })
    assert.equal(Boolean(await dsh.open()), usable)
    assert.equal(sockets[0].calls('hello').length, expectedHellos)
    assert.equal(dsh.writable(), false)
    assert.equal(dsh.manages.size, 0)
  }
})

test('phone grant methods are unknown and only allowlisted memory fields reach the socket', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  const injection = { grant: 'wrong-grant', phone: 'wrong-key', extra: 'ignored' }
  for (const method of ['manage-open', 'manage-close']) {
    assert.equal((await p.call(method, injection)).error.data.kind, 'unknown_method')
  }
  for (const [method, params, expected] of [['memory.read', target, read], ['memory.edit', edit, saved], ['memory.add', add, saved]]) {
    assert.deepEqual((await p.call(method, { ...params, ...injection })).result, expected)
  }
  assert.deepEqual(socket.requests.slice(2).map(m => [m.method, m.params]), [
    ['manage-open', { grant: 'g1', phone: 'paired-key' }],
    ['memory-read', { grant: 'g1', ...target }],
    ['memory-edit', { grant: 'g1', ...edit }],
    ['memory-add', { grant: 'g1', ...add }],
  ])
})

test('bad fields are invalid even while memory is busy, and a memory call does not block chat send', async (t) => {
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }) => method === 'memory-read' ? null : undefined,
  } } })
  const socket = await dsh.open()
  const a = phone(engine), b = phone(engine)
  for (const p of [a, b]) { p.hello(methods); await p.greeted() }
  await b.call('chat.subscribe', target)
  const id = a.send('memory.read', target)
  const pending = await until(() => socket.calls('memory-read')[0], 'held read')
  for (const [method, params] of [
    ['memory.read', { terminal: 'dsh:' }],
    ['memory.read', { terminal: 't1' }],
    ['memory.read', { terminal: 'dsh:' + 'x'.repeat(125) }],
    ['memory.edit', { ...edit, id: 'x'.repeat(33) }],
    ['memory.edit', { ...edit, id: 'a.b' }],
    ['memory.edit', { ...edit, rev: '0123456789ABCDEf' }],
    ['memory.edit', { ...edit, rev: 5 }],
    ['memory.add', { ...add, text: 123 }],
  ]) {
    assert.deepEqual((await b.call(method, params)).result, refused('invalid'), method)
  }
  assert.deepEqual((await b.call('memory.edit', edit)).result, refused('busy'))
  assert.deepEqual((await b.call('chat.send', { ...target, text: 'hi', id: 'chat-1' })).result, { state: 'sent', id: 'chat-1' })
  assert.equal(socket.calls('memory-edit').length, 0)
  socket.reply(pending, { result: read })
  assert.deepEqual((await a.answer(id)).result, read)
})

test('the terminal limit is 128 characters and both mutations cap text at 4096 UTF-8 bytes', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  const text = '😀'.repeat(1024)
  for (const [method, params] of [['memory.edit', edit], ['memory.add', add]]) {
    assert.deepEqual((await p.call(method, { ...params, text })).result, saved)
    assert.deepEqual((await p.call(method, { ...params, text: text + 'x' })).result, refused('invalid'))
  }
  assert.deepEqual((await p.call('memory.read', { terminal: 'dsh:' + 'x'.repeat(124) })).result, read)
  assert.equal(socket.calls('memory-edit').length, 1)
  assert.equal(socket.calls('memory-add').length, 1)
})

test('the 61st read is rate limited across phone and socket reconnects', async (t) => {
  let now = 0
  const { dsh, engine, sockets } = world(t, { now: () => now, requestMs: 3000, hosts: { [TEAM]: {
    reply: ({ method }) => method === 'send' ? null : undefined,
  } } })
  const old = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  await p.call('chat.subscribe', target)
  const id = p.send('chat.send', { ...target, text: 'hi', id: 'chat-1' })
  const send = await until(() => old.calls('send')[0], 'held chat send')
  now = 59_999
  for (let i = 0; i < 59; i++) assert.deepEqual((await p.call('memory.read', target)).result, read)
  now += 1
  // Finish the chat write after its window expires, with the reads still in their window.
  old.reply(send, { result: { state: 'sent', id: 'chat-1' } })
  assert.equal((await p.answer(id)).result.state, 'sent')
  p.conn.close()
  old.destroy()
  await dsh.open()
  const q = phone(engine)
  q.hello(methods)
  await q.greeted()
  assert.deepEqual((await q.call('memory.read', target)).result, read)
  assert.deepEqual((await q.call('memory.read', target)).result, refused('rate'))
  assert.equal(old.calls('memory-read').length, 59)
  assert.equal(sockets[1].calls('memory-read').length, 1)
  now += 60_000
  assert.deepEqual((await q.call('memory.read', target)).result, read)
})

test('the 21st mixed chat or memory write across two connections is rate limited', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const a = phone(engine), b = phone(engine)
  for (const p of [a, b]) { p.hello(methods); await p.greeted() }
  await a.call('chat.subscribe', target)
  for (let i = 0; i < WRITES_PER_MINUTE / 2; i++) {
    assert.equal((await a.call('chat.send', { ...target, text: 'hi', id: `chat-${i}` })).result.state, 'sent')
    assert.deepEqual((await b.call('memory.add', add)).result, saved)
  }
  assert.deepEqual((await b.call('memory.edit', edit)).result, refused('rate'))
  assert.equal((await a.call('chat.send', { ...target, text: 'hi', id: 'over' })).result.reason, 'rate')
  assert.deepEqual((await b.call('memory.read', target)).result, read)
  assert.equal(socket.calls('send').length + socket.calls('memory-add').length, WRITES_PER_MINUTE)
  assert.equal(socket.calls('memory-edit').length, 0)
})

test('written mutation timeout is unknown with no replay or follow-up read, and a read timeout is offline', async (t) => {
  const { dsh, engine, sockets } = world(t, { requestMs: 35, hosts: { [TEAM]: {
    reply: ({ method }) => method.startsWith('memory-') ? null : undefined,
  } } })
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  assert.deepEqual((await p.call('memory.edit', edit)).result, unknown)
  assert.deepEqual(socket.requests.slice(3).map(m => m.method), ['memory-edit'])
  assert.equal(sockets.length, 1)
  assert.deepEqual((await p.call('memory.read', target)).result, refused('offline'))
  assert.deepEqual(socket.requests.slice(3).map(m => m.method), ['memory-edit', 'memory-read'])
})

test('socket loss after a memory request is written reports unknown for writes and offline for reads', async (t) => {
  const { dsh, engine, sockets } = world(t, { hosts: { [TEAM]: {
    reply: ({ method }, socket) => {
      if (!method.startsWith('memory-')) return
      socket.destroy()
      return null
    },
  } } })
  const old = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  assert.deepEqual((await p.call('memory.add', add)).result, unknown)
  assert.deepEqual(old.requests.slice(3).map(m => m.method), ['memory-add'])
  assert.equal(sockets.length, 1)
  assert.deepEqual((await p.call('memory.read', target)).result, refused('offline'))
  assert.deepEqual(sockets[1].requests.slice(3).map(m => m.method), ['memory-read'])
})

test('an unwritten mutation is definitely refused, and host results pass through unchanged', async (t) => {
  const outcomes = [
    { ok: false, state: 'unknown', reason: 'pending' },
    { ...refused('revoked'), applied: true },
    { ...refused('stale'), memory },
    saved,
  ]
  let unwritten = true
  const { dsh, engine } = world(t, { hosts: { [TEAM]: {
    unwritten: ({ method }) => unwritten && method === 'memory-edit',
    reply: ({ method }) => method === 'memory-edit' ? { result: outcomes.shift() } : undefined,
  } } })
  const expected = [...outcomes]
  const socket = await dsh.open()
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  assert.deepEqual((await p.call('memory.edit', edit)).result, refused('offline'))
  assert.equal(socket.calls('memory-edit').length, 0)
  unwritten = false
  for (const result of expected) assert.deepEqual((await p.call('memory.edit', edit)).result, result)
  assert.equal(socket.calls('memory-read').length, 0)
})

test('a memory request at the outer in-flight limit gets transport busy before memory refusals', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const pending = Promise.withResolvers()
  engine.ready = () => pending.promise
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  for (let i = 0; i < MAX_IN_FLIGHT; i++) p.send('chat.list')
  const answer = await p.call('memory.edit', { terminal: 'dsh:' })
  assert.equal(answer.error.data.kind, 'busy')
  assert.equal(answer.result, undefined)
  assert.equal(p.queued[1].opts.liveOnly, true)
  assert.equal(socket.calls('memory-edit').length, 0)
  pending.resolve()
  await p.answer(MAX_IN_FLIGHT)
})

test('memory replies queued behind a blocked write are dropped on revoke, hangup, EOF and slow close', async (t) => {
  const { dsh, engine } = world(t)
  await dsh.open()
  for (const reason of ['not paired', 'hung up', 'EOF', 'slow']) {
    const blocked = Promise.withResolvers()
    const p = phone(engine, { send: () => blocked.promise, maxUnsent: 1024 })
    p.hello(methods)
    await p.greeted()
    p.send('memory.read', target)
    await until(() => p.queued.length === 2, 'queued memory reply')
    assert.equal(p.queued[1].opts.liveOnly, true)
    // Queue an ordinary reply too. A hangup flushes it, while a revoke drops the queue.
    p.conn.reply({ id: 2, result: {} })
    if (reason === 'not paired') p.revoke()
    else if (reason === 'slow') p.conn.reply({ id: 3, result: 'x'.repeat(1024) })
    else p.conn.close(reason)
    assert.deepEqual(p.ended, [reason])
    blocked.resolve()
    await p.writer.done()
    assert.equal(p.submitted.length, reason === 'not paired' ? 1 : 2)
    if (p.submitted.length === 2) assert.equal(JSON.parse(p.submitted[1].subarray(9)).id, 2)
  }
})

test('an unsupported hello flushes its ordinary error after close', async () => {
  const p = phone({}, { send: () => {} })
  p.conn.feed(Buffer.from(rpc(0, 'hello', { generation: 1 }) + '\n'))
  assert.deepEqual(p.ended, ['unsupported'])
  await p.writer.done()
  assert.equal(JSON.parse(p.submitted[0]).error.data.kind, 'unsupported')
})

test('close marks the client closed and releases its grant even when a subscription handle throws', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const closeClient = engine.closeClient
  const closed = []
  const watch = engine.watch
  engine.watch = (...args) => {
    const handle = watch(...args)
    handle.close = () => { throw new Error('handle broke') }
    return handle
  }
  engine.closeClient = (client) => { closed.push(client.closed); closeClient(client) }
  const p = phone(engine)
  p.hello(methods)
  await p.greeted()
  await p.call('chat.subscribe', { terminal: 't1' })
  p.conn.close()
  assert.deepEqual(closed, [true])
  assert.equal(p.conn.subs.size, 0)
  assert.deepEqual(p.ended, ['closed'])
  assert.deepEqual(socket.calls('manage-close').map(m => m.params), [{ grant: 'g1' }])
})

test('host and engine memory error messages stay out of replies and logs', async (t) => {
  const logs = []
  const log = line => logs.push(line)
  const { dsh, engine } = world(t, { log, hosts: { [TEAM]: {
    reply: ({ method }) => method === 'memory-read'
      ? { error: { kind: 'private', message: 'HOST-MARKER', extra: 'HOST-MARKER' } }
      : undefined,
  } } })
  await dsh.open()
  const p = phone(engine, { log })
  p.hello(methods)
  await p.greeted()
  assert.deepEqual((await p.call('memory.read', target)).result, refused('private'))
  engine.memory = () => { throw new Error('ENGINE-MARKER') }
  assert.deepEqual((await p.call('memory.edit', edit)).error, { code: -32000, message: 'failed', data: { kind: 'failed' } })
  assert.deepEqual(logs, ['chat: memory request failed'])
  assert.equal(p.queued.at(-1).opts.liveOnly, true)
})
