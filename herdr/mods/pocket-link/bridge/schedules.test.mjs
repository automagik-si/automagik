// The phone wire and Bot socket, with in-memory sockets and the real chat route.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatConnection, chatWriter, DATA, frame, MAX_IN_FLIGHT } from './chat.mjs'
import { DshSource, withDsh } from './dsh-source.mjs'

const TEAM = '/team/pocket/chat.sock'
const scheduleMethods = ['schedule.list', 'schedule.pause', 'schedule.resume', 'schedule.rename']
const memoryOffers = ['memory-read', 'memory-edit', 'memory-add']
const allOffers = [...memoryOffers, 'schedule-list', 'schedule-pause', 'schedule-resume', 'schedule-rename']
const terminal = 'dsh:worker'
const target = { terminal }
const id = 'schedule-12345678-abcd-0123-ef45-123456789abc'
const alias = 'x0123456789abcdef'
const rev = '0123456789abcdef'
const selected = { terminal, id }
const write = { ...selected, rev }
const rename = { ...write, title: '  New name  ' }
const task = { id, rev, title: 'Task', state: 'scheduled', timing: { kind: 'every', at: '2026-11-19T12:00:00Z', everySeconds: 3600 } }
const listed = { ok: true, state: 'read', schedules: { terminal, tasks: [task], truncated: false } }
const read = { ok: true, state: 'read', memory: { terminal, entries: [], size: 0, limit: 8000, truncated: false } }
const saved = { ok: true, state: 'saved', entry: null, memory: null }
const refused = (reason) => ({ ok: false, state: 'refused', reason })
const unknown = { ok: false, state: 'unknown', reason: 'offline' }
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
const requestFrame = (id, method, params) => frame(0, DATA, Buffer.from(rpc(id, method, params)))
const calls = (socket) => socket.requests.map(({ method, params }) => [method, params])

async function until(check, message) {
  const deadline = Date.now() + 2000
  for (;;) {
    const value = check()
    if (value) return value
    assert.ok(Date.now() < deadline, message)
    await delay(1)
  }
}

function helloResult({ writable = true, offers = allOffers } = {}, params) {
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
      case 'memory-add':
        assert.ok(this.grants.has(params.grant))
        return { result: method === 'memory-read' ? read : saved }
      case 'schedule-list':
        assert.ok(this.grants.has(params.grant))
        return { result: listed }
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
    queueMicrotask(() => this.emit('close'))
  }

  calls(method) { return this.requests.filter((m) => m.method === method) }
}

function world(t, { host = {}, realpath, requestMs = 100, log } = {}) {
  const sockets = []
  const dsh = new DshSource({
    path: TEAM, requestMs, realpath, log, now: () => 0,
    check: path => path === TEAM,
    connect: path => {
      assert.equal(path, TEAM)
      const socket = new FakeSocket(host)
      sockets.push(socket)
      return socket
    },
  })
  t.after(() => dsh.close())
  const engine = { ready: async () => {}, list: () => [] }
  return { dsh, sockets, engine: withDsh(engine, dsh) }
}

function phone(engine, { device = 'paired-key', log, send } = {}) {
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
    engine, device, log,
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

async function greet(engine, methods = scheduleMethods, options) {
  const p = phone(engine, options)
  p.hello(methods)
  return { ...p, offer: (await p.greeted()).manage }
}

// The phone, bridge and host intersect method offers, using one grant for both families.
test('schedule negotiation is canonical and compatible with old phones and hosts', async (t) => {
  const requested = ['schedule.rename', 'memory.read', 'schedule.list', 'memory.read', 'schedule.list', 'schedule.extra', 'unknown']
  for (const [offers, expected] of [
    [['schedule-list', 'schedule-extra'], ['schedule.list']],
    [allOffers, ['memory.read', 'schedule.list', 'schedule.rename']],
    [memoryOffers, ['memory.read']],
  ]) {
    const { dsh, engine } = world(t, { host: { offers } })
    const socket = await dsh.open()
    const old = phone(engine)
    old.hello()
    assert.equal((await old.greeted()).manage, undefined)
    assert.deepEqual((await old.call('schedule.list', target)).result, refused('read-only'))
    assert.equal(socket.calls('manage-open').length, 0)

    const p = await greet(engine, requested)
    assert.deepEqual(p.offer, expected)
    if (expected.includes('memory.read')) assert.deepEqual((await p.call('memory.read', target)).result, read)
    if (expected.includes('schedule.list')) assert.deepEqual((await p.call('schedule.list', target)).result, listed)
    else assert.deepEqual((await p.call('schedule.list', target)).result, refused('read-only'))
    assert.deepEqual(calls(socket).slice(2), [
      ['manage-open', { grant: 'g1', phone: 'paired-key' }],
      ...(expected.includes('memory.read') ? [['memory-read', { grant: 'g1', terminal }]] : []),
      ...(expected.includes('schedule.list') ? [['schedule-list', { grant: 'g1', terminal }]] : []),
    ])
  }
  const withoutDsh = await greet({})
  assert.deepEqual((await withoutDsh.call('schedule.list', target)).result, refused('read-only'))
})

// Each method sends only its allowed fields and returns the whole host result.
test('all schedule methods forward exact params and preserve their results', async (t) => {
  const withTask = { ...listed, schedules: { ...listed.schedules, tasks: [{ ...task, id: alias }], truncated: true }, task }
  const withNull = { ...listed, task: null }
  const outcomes = new Map([
    ['schedule-list', [listed, withTask, withNull]],
    ['schedule-pause', [id, alias].map(id => ({ ok: true, state: 'saved', task: { ...task, id, state: 'paused' } }))],
    ['schedule-resume', [id, alias].map(id => ({ ok: true, state: 'unchanged', task: { ...task, id } }))],
    ['schedule-rename', [id, alias].map(id => ({ ok: true, state: 'saved', task: { ...task, id, title: 'New name' } }))],
  ])
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => outcomes.has(method) ? { result: outcomes.get(method).shift() } : undefined,
  } })
  const socket = await dsh.open()
  const p = await greet(engine)
  assert.deepEqual(p.offer, scheduleMethods)
  const injection = { grant: 'wrong-grant', phone: 'wrong-key', prompt: 'prompt', timing: 'timing', extra: 'extra' }
  const expectedCalls = []
  for (const [method, parameters] of [
    ['schedule.list', [target, selected, { terminal, id: alias }]],
    ['schedule.pause', [write, { ...write, id: alias }]],
    ['schedule.resume', [write, { ...write, id: alias }]],
    ['schedule.rename', [rename, { ...rename, id: alias }]],
  ]) {
    const socketMethod = method.replace('.', '-')
    const expected = [...outcomes.get(socketMethod)]
    for (const [index, params] of parameters.entries()) {
      const extras = method === 'schedule.list' ? { title: 'extra title', rev } :
        method === 'schedule.rename' ? {} : { title: 'extra title' }
      assert.deepEqual((await p.call(method, { ...injection, ...extras, ...params })).result, expected[index])
      expectedCalls.push([socketMethod, { grant: 'g1', ...params }])
    }
  }
  assert.deepEqual(calls(socket).slice(3), expectedCalls)
})

// Invalid fields never reach the host or use a rate slot, and the exact size limits pass.
test('schedule validation checks types, formats and size before forwarding', async (t) => {
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => method === 'schedule-rename' ? { result: { ok: true, state: 'saved', task } } : undefined,
  } })
  const socket = await dsh.open()
  const p = await greet(engine)
  const boundary = { terminal: 'dsh:' + 'x'.repeat(124) }
  const title = 'é'.repeat(2048)
  for (const badId of [null, '', id.toUpperCase(), 'schedule-1234', 'x0123456789abcdeg', alias + '0', 1234567890123456, [id], [alias]]) {
    assert.deepEqual((await p.call('schedule.list', { terminal, id: badId })).result, refused('invalid'))
    assert.deepEqual((await p.call('schedule.pause', { ...write, id: badId })).result, refused('invalid'))
  }
  for (const [method, params] of [
    ['schedule.pause', { terminal, rev }],
    ['schedule.resume', { terminal, rev }],
    ['schedule.rename', { terminal, rev, title }],
    ...[undefined, null, '0123456789ABCDEF', rev + '0', 1234567890123456, [rev]].map(rev => ['schedule.resume', { ...write, rev }]),
    ['schedule.rename', { ...write, title: 42 }],
    ['schedule.rename', { ...write, title: title + 'a' }],
    ['schedule.list', { terminal: 'dsh:' }],
    ['schedule.list', { terminal: 'worker' }],
    ['schedule.list', { terminal: boundary.terminal + 'x' }],
  ]) {
    assert.deepEqual((await p.call(method, params)).result, refused('invalid'), method)
  }
  assert.equal(socket.requests.length, 3)
  assert.equal(dsh.phones.size, 0)
  assert.deepEqual((await p.call('schedule.list', boundary)).result, listed)
  assert.deepEqual((await p.call('schedule.rename', { ...rename, title })).result, { ok: true, state: 'saved', task })
  assert.deepEqual(calls(socket).slice(3), [
    ['schedule-list', { grant: 'g1', ...boundary }],
    ['schedule-rename', { grant: 'g1', ...rename, title }],
  ])
})

// Two connections with one key have distinct offers but share the memory and schedule slot.
test('schedule authority and validation precede the per-phone management busy slot', async (t) => {
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => ['schedule-list', 'memory-read'].includes(method) ? null : undefined,
  } })
  const socket = await dsh.open()
  const a = await greet(engine, ['schedule.list'])
  const b = await greet(engine, ['schedule.pause', 'memory.read'])
  assert.deepEqual(a.offer, ['schedule.list'])
  assert.deepEqual(b.offer, ['memory.read', 'schedule.pause'])
  const listId = a.send('schedule.list', target)
  const list = await until(() => socket.calls('schedule-list')[0], 'held schedule list')
  assert.deepEqual((await b.call('schedule.list', { terminal: 'dsh:' })).result, refused('read-only'))
  assert.deepEqual((await b.call('schedule.pause', { ...write, id: null })).result, refused('invalid'))
  assert.deepEqual((await b.call('schedule.pause', write)).result, refused('busy'))
  assert.deepEqual((await b.call('memory.read', target)).result, refused('busy'))
  assert.equal(socket.requests.length, 5)
  socket.reply(list, { result: listed })
  assert.deepEqual((await a.answer(listId)).result, listed)

  const readId = b.send('memory.read', target)
  const memory = await until(() => socket.calls('memory-read')[0], 'held memory read')
  assert.deepEqual((await a.call('schedule.list', target)).result, refused('busy'))
  assert.equal(socket.requests.length, 6)
  socket.reply(memory, { result: read })
  assert.deepEqual((await b.answer(readId)).result, read)
})

// Schedules share the 60-read memory limit and the 20-write chat and memory limit.
test('schedule reads and writes use the shared per-phone rates', async (t) => {
  const paused = { ok: true, state: 'saved', task: { ...task, state: 'paused' } }
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => method === 'schedule-pause' ? { result: paused } : undefined,
  } })
  const socket = await dsh.open()
  const p = await greet(engine, [...scheduleMethods, 'memory.read', 'memory.add'])
  for (let i = 0; i < 30; i++) {
    assert.deepEqual((await p.call('memory.read', target)).result, read)
    assert.deepEqual((await p.call('schedule.list', target)).result, listed)
  }
  assert.deepEqual((await p.call('schedule.list', target)).result, refused('rate'))
  assert.equal(socket.calls('memory-read').length, 30)
  assert.equal(socket.calls('schedule-list').length, 30)

  assert.ok((await p.call('chat.subscribe', target)).result.channel)
  for (let i = 0; i < 10; i++) {
    const id = `chat-${i}`
    assert.deepEqual((await p.call('chat.send', { terminal, id, text: 'hi' })).result, { state: 'sent', id })
  }
  for (let i = 0; i < 9; i++) assert.deepEqual((await p.call('memory.add', { terminal, text: 'entry' })).result, saved)
  assert.deepEqual((await p.call('schedule.pause', write)).result, paused)
  assert.deepEqual((await p.call('schedule.pause', write)).result, refused('rate'))
  assert.equal(socket.calls('send').length, 10)
  assert.equal(socket.calls('memory-add').length, 9)
  assert.equal(socket.calls('schedule-pause').length, 1)
})

// The transport rejects an excess schedule request before dispatch, with a live-only reply.
test('schedule requests count toward the chat transport limit', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const pending = Promise.withResolvers()
  t.after(pending.resolve)
  engine.ready = () => pending.promise
  const p = await greet(engine, ['schedule.list'])
  for (let i = 0; i < MAX_IN_FLIGHT; i++) p.send('chat.list')
  const answer = await p.call('schedule.list', { terminal: 'dsh:' })
  assert.deepEqual(answer.error, { code: -32000, message: 'at most 16 requests at once', data: { kind: 'busy' } })
  assert.equal(answer.result, undefined)
  assert.deepEqual(p.queued[1].opts, { liveOnly: true })
  assert.equal(socket.calls('schedule-list').length, 0)
  pending.resolve()
  await p.answer(MAX_IN_FLIGHT)
})

// Only a phone-requested list on a new connection can reconcile the lost write-only reply.
test('lost schedule replies reflect whether the request was written and never trigger a retry', async (t) => {
  const found = { ...listed, task }
  const reads = [{ result: refused('busy') }, { result: found }, null]
  let unwritten = true
  const { dsh, engine, sockets } = world(t, { requestMs: 40, host: {
    unwritten: ({ method }) => unwritten && method === 'schedule-pause',
    reply: ({ method }) => {
      if (method === 'schedule-list') return reads.shift()
      if (method === 'schedule-rename' || method === 'schedule-pause') return null
    },
  } })
  const socket = await dsh.open()
  const writer = await greet(engine, ['schedule.rename', 'schedule.pause'])
  assert.deepEqual(writer.offer, ['schedule.pause', 'schedule.rename'])
  assert.deepEqual((await writer.call('schedule.rename', rename)).result, unknown)
  assert.deepEqual((await writer.call('schedule.list', selected)).result, refused('read-only'))
  assert.deepEqual(calls(socket).slice(3), [['schedule-rename', { grant: 'g1', ...rename }]])

  const reader = await greet(engine, ['schedule.list'])
  assert.deepEqual(reader.offer, ['schedule.list'])
  assert.deepEqual((await reader.call('schedule.list', selected)).result, refused('busy'))
  assert.deepEqual((await reader.call('schedule.list', selected)).result, found)
  assert.deepEqual((await reader.call('schedule.list', selected)).result, refused('offline'))

  assert.deepEqual((await writer.call('schedule.pause', write)).result, refused('offline'))
  unwritten = false
  const pause = writer.send('schedule.pause', write)
  await until(() => socket.calls('schedule-pause')[0], 'written schedule pause')
  socket.destroy()
  assert.deepEqual((await writer.answer(pause)).result, unknown)
  assert.equal(sockets.length, 1)
  assert.deepEqual(calls(socket).slice(2), [
    ['manage-open', { grant: 'g1', phone: 'paired-key' }],
    ['schedule-rename', { grant: 'g1', ...rename }],
    ['manage-open', { grant: 'g2', phone: 'paired-key' }],
    ['schedule-list', { grant: 'g2', ...selected }],
    ['schedule-list', { grant: 'g2', ...selected }],
    ['schedule-list', { grant: 'g2', ...selected }],
    ['schedule-pause', { grant: 'g1', ...write }],
  ])
})

// Host results survive unchanged, while error envelopes and thrown handlers keep private text out.
test('schedule results pass through but errors remain private', async (t) => {
  const logs = []
  const log = line => logs.push(line)
  const blank = '  '
  const long = 'x'.repeat(121)
  const renamed = { ok: true, state: 'saved', task: { ...task, title: 'New name' } }
  const outcomes = [
    { ...refused('stale'), task },
    { ...refused('ended'), task: { ...task, state: 'finished' } },
    refused('gone'), refused('not-shown'), refused('global'), refused('unavailable'),
    { ...refused('unavailable'), applied: true },
    { ok: false, state: 'unknown', reason: 'pending' },
  ]
  const remaining = [...outcomes]
  const { dsh, engine } = world(t, { log, host: {
    reply: (request, socket) => {
      const { method, params } = request
      if (method === 'schedule-pause') return { result: remaining.shift() }
      if (method === 'schedule-resume') return { error: { kind: 'private', message: 'HOST-MARKER', extra: 'HOST-MARKER' } }
      if (method === 'schedule-rename' && params.title === blank) {
        return { result: { ...refused('invalid'), message: 'Give the task a name' } }
      }
      if (method === 'schedule-rename' && params.title === long) {
        return { result: { ...refused('invalid'), message: 'Keep the name under 120 characters' } }
      }
      if (method === 'schedule-rename') {
        socket.reply(request, { result: renamed })
        queueMicrotask(() => socket.destroy())
        return null
      }
    },
  } })
  const socket = await dsh.open()
  const p = await greet(engine, scheduleMethods, { log })
  for (const expected of outcomes) {
    assert.deepEqual((await p.call('schedule.pause', write)).result, expected)
    if (expected.reason === 'unavailable') assert.deepEqual((await p.call('schedule.list', target)).result, listed)
  }
  for (const [title, message] of [[blank, 'Give the task a name'], [long, 'Keep the name under 120 characters']]) {
    assert.deepEqual((await p.call('schedule.rename', { ...rename, title })).result, { ...refused('invalid'), message })
  }
  assert.deepEqual(socket.calls('schedule-rename').map(m => m.params.title), [blank, long])
  const errorAnswer = await p.call('schedule.resume', write)
  assert.deepEqual(errorAnswer.result, refused('private'))
  assert.ok(!JSON.stringify(errorAnswer).includes('HOST-MARKER'))
  assert.deepEqual(logs, [])

  // As memory: a reply whose socket is gone before the bridge hands it on is an unknown outcome.
  assert.deepEqual((await p.call('schedule.rename', rename)).result, { ok: false, state: 'unknown', reason: 'offline' })
  assert.equal(socket.destroyed, true)
  engine.schedule = () => { throw new Error('ENGINE-MARKER') }
  assert.deepEqual((await p.call('schedule.rename', rename)).error, { code: -32000, message: 'failed', data: { kind: 'failed' } })
  assert.deepEqual(logs, ['chat: schedule request failed'])
  assert.deepEqual(p.queued.at(-1).opts, { liveOnly: true })
})

// A queued schedule reply drops on hangup or revoke, and an in-flight call loses authority on close.
test('schedule replies only reach a live phone connection', async (t) => {
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => method === 'schedule-pause' ? null : undefined,
  } })
  const socket = await dsh.open()
  for (const reason of ['hung up', 'not paired']) {
    const blocked = Promise.withResolvers()
    const submitted = phone(engine, { send: () => blocked.promise })
    t.after(blocked.resolve)
    submitted.hello(scheduleMethods)
    await submitted.greeted()
    submitted.send('schedule.list', target)
    await until(() => submitted.queued.length === 2, 'queued schedule reply')
    assert.deepEqual(submitted.queued[1].opts, { liveOnly: true })
    submitted.conn.reply({ id: 2, result: {} })
    if (reason === 'not paired') submitted.revoke()
    else submitted.conn.close(reason)
    blocked.resolve()
    await submitted.writer.done()
    assert.deepEqual(submitted.ended, [reason])
    assert.equal(submitted.submitted.length, reason === 'hung up' ? 2 : 1)
    if (reason === 'hung up') assert.equal(JSON.parse(submitted.submitted[1].subarray(9)).id, 2)
  }

  const p = await greet(engine)
  const pending = dsh.schedule(p.conn.client, 'schedule.pause', write)
  const pause = await until(() => socket.calls('schedule-pause')[0], 'in-flight schedule pause')
  p.conn.close()
  socket.reply(pause, { result: { ok: true, state: 'saved', task } })
  assert.deepEqual(await pending, refused('read-only'))
})

// Socket offers stay fixed until reconnect, and a retargeted home needs new phone hellos.
test('schedule offers are per socket and grants stay tied to the team home', async (t) => {
  let folder = '/real-team/pocket'
  const paused = { ok: true, state: 'saved', task: { ...task, state: 'paused' } }
  const host = {
    offers: ['schedule-list'],
    reply: ({ method }) => method === 'schedule-pause' ? { result: paused } : undefined,
  }
  const { dsh, engine, sockets } = world(t, { host, realpath: path => {
    assert.equal(path, '/team/pocket')
    return folder
  } })
  const first = await dsh.open()
  const requested = ['memory.read', ...scheduleMethods]
  const a = await greet(engine, requested)
  assert.deepEqual(a.offer, ['schedule.list'])
  host.offers = allOffers
  const b = await greet(engine, requested, { device: 'second-key' })
  assert.deepEqual(b.offer, ['schedule.list'])
  assert.deepEqual(first.calls('hello').map(m => m.params), [{ write: 1 }, { write: 1, manage: 1 }])
  assert.deepEqual((await a.call('schedule.list', target)).result, listed)
  assert.deepEqual(first.calls('schedule-list').map(m => m.params), [{ grant: 'g1', terminal }])

  first.destroy()
  assert.deepEqual((await a.call('schedule.list', target)).result, listed)
  const c = await greet(engine, requested)
  assert.deepEqual(c.offer, requested)
  assert.deepEqual((await a.call('schedule.pause', write)).result, refused('read-only'))
  assert.equal(sockets[1].calls('schedule-pause').length, 0)
  assert.deepEqual((await c.call('schedule.pause', write)).result, paused)

  host.offers = ['memory-read', 'schedule-list']
  sockets[1].destroy()
  assert.deepEqual((await c.call('schedule.pause', write)).result, refused('read-only'))
  assert.equal(sockets[2].calls('manage-open').length, 0)
  assert.deepEqual((await c.call('schedule.list', target)).result, listed)

  folder = '/other-team/pocket'
  sockets[2].destroy()
  assert.deepEqual((await c.call('memory.read', target)).result, refused('read-only'))
  assert.deepEqual((await c.call('schedule.list', target)).result, refused('read-only'))
  assert.equal(dsh.path, TEAM)
  assert.deepEqual(sockets[3].requests.map(m => m.method), ['hello', 'hello'])
  const fresh = await greet(engine, requested)
  assert.deepEqual(fresh.offer, ['memory.read', 'schedule.list'])
  assert.deepEqual((await fresh.call('memory.read', target)).result, read)
  assert.deepEqual((await fresh.call('schedule.list', target)).result, listed)
})

// A retarget during the socket hellos leaves that socket unpublished and opens no grant.
test('a team home retarget during connection discards the socket', async (t) => {
  let folder = '/real-team/pocket'
  const { dsh, engine, sockets } = world(t, { realpath: () => folder, host: {
    reply: ({ method, params }) => {
      if (method === 'hello' && params.manage === 1) folder = '/other-team/pocket'
    },
  } })
  assert.equal(await dsh.open(), null)
  assert.equal(sockets[0].destroyed, true)
  assert.equal(dsh.socket, null)
  assert.equal(dsh.path, null)
  assert.equal(dsh.team, null)
  const p = await greet(engine, ['memory.read', 'schedule.list'])
  assert.equal(p.offer, undefined)
  assert.deepEqual((await p.call('schedule.list', target)).result, refused('read-only'))
  assert.deepEqual(sockets[0].requests.map(m => m.method), ['hello', 'hello'])
  assert.equal(sockets.length, 1)
})
