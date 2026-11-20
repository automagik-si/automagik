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
const scheduleOffers = ['schedule-list', 'schedule-pause', 'schedule-resume', 'schedule-rename']
const settingsMethods = ['settings.read', 'settings.name', 'settings.model']
const settingsOffers = ['settings-read', 'settings-name', 'settings-model']
const allOffers = [...memoryOffers, ...scheduleOffers, ...settingsOffers]
const terminal = 'dsh:b-aaaaaaaaaa'
const target = { terminal }
const rev = '3f9c0a1b2c3d4e5f'
const name = '  Worker  '
const model = 'deepseek/v5'
const rename = { terminal, rev, name }
const changeModel = { terminal, rev, model }
const settings = {
  terminal, rev, name: 'Worker',
  model: { saved: 'deepseek/v4', label: 'V4', applied: 'deepseek/v4', running: 'deepseek/v4', effort: null, runningEffort: null },
  level: { saved: 'workspace-write', inherited: false, auto: true },
  editable: { name: true, model: true },
}
const models = {
  entries: [
    { id: 'deepseek/v4', label: 'V4', provider: 'DeepSeek' },
    { id: 'deepseek/v5', label: 'V5', provider: 'DeepSeek' },
  ],
  truncated: false,
}
const read = { ok: true, state: 'read', settings, models }
const saved = { ...read, state: 'saved' }
const memoryRead = { ok: true, state: 'read', memory: { terminal, entries: [], size: 0, limit: 8000, truncated: false } }
const scheduleList = { ok: true, state: 'read', schedules: { terminal, tasks: [], truncated: false } }
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
        return { result: method === 'memory-read' ? memoryRead : { ok: true, state: 'saved' } }
      case 'schedule-list':
        assert.ok(this.grants.has(params.grant))
        return { result: scheduleList }
      case 'settings-read':
      case 'settings-name':
      case 'settings-model':
        assert.ok(this.grants.has(params.grant))
        return { result: method === 'settings-read' ? read : saved }
      case 'subscribe': return { result: { channel: params.channel } }
      case 'send': return { result: { state: 'sent', id: params.id } }
      default: return { result: {} }
    }
  }

  reply(request, answer = { result: { grant: request.params.grant } }) {
    const line = JSON.stringify({ id: request.id, ...answer }) + '\n'
    this.deliver(line)
  }

  deliver(line) { queueMicrotask(() => this.emit('data', line)) }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.grants.clear()
    queueMicrotask(() => this.emit('close'))
  }

  calls(method) { return this.requests.filter((m) => m.method === method) }
}

function world(t, { host = {}, realpath, requestMs = 100, settingsWriteMs = 100, log } = {}) {
  const sockets = []
  const dsh = new DshSource({
    path: TEAM, requestMs, settingsWriteMs, realpath, log, now: () => 0,
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
  const writer = send && chatWriter({
    send: bytes => { submitted.push(bytes); return send(bytes) },
    isClosed: () => conn.closed,
    isRevoked: () => revoked,
    onFail: () => conn.close('write failed'),
  })
  const conn = new ChatConnection({
    engine, device, log,
    end: () => {},
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
    conn, answer, queued, submitted, writer,
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

async function greet(engine, methods = settingsMethods, options) {
  const p = phone(engine, options)
  p.hello(methods)
  return { ...p, offer: (await p.greeted()).manage }
}

// S1: the phone, bridge and host intersect methods in canonical order using one grant.
test('settings and memory negotiate together without duplicate or unknown methods', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = await greet(engine, ['settings.model', 'settings.read', 'memory.read', 'settings.read', 'settings.name', 'settings.extra', 'unknown'])
  assert.deepEqual(p.offer, ['memory.read', ...settingsMethods])
  assert.deepEqual((await p.call('settings.read', target)).result, read)
  assert.deepEqual(calls(socket).slice(2), [
    ['manage-open', { grant: 'g1', phone: 'paired-key' }],
    ['settings-read', { grant: 'g1', terminal }],
  ])
})

// S2: a read-only settings offer cannot authorize either write.
test('a phone can opt into settings read alone', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = await greet(engine, ['settings.read'])
  assert.deepEqual(p.offer, ['settings.read'])
  assert.deepEqual((await p.call('settings.name', rename)).result, refused('read-only'))
  assert.deepEqual((await p.call('settings.model', changeModel)).result, refused('read-only'))
  assert.equal(socket.calls('settings-name').length, 0)
  assert.equal(socket.calls('settings-model').length, 0)
})

// S3: a phone must request settings read to get a settings write.
test('write-only settings requests do not negotiate or open a grant', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = await greet(engine, ['settings.name', 'settings.model'])
  assert.equal(p.offer, undefined)
  assert.equal(socket.calls('manage-open').length, 0)
  assert.deepEqual((await p.call('settings.name', rename)).result, refused('read-only'))
  assert.deepEqual((await p.call('settings.model', changeModel)).result, refused('read-only'))
  const mixed = await greet(engine, ['memory.read', 'settings.model'])
  assert.deepEqual(mixed.offer, ['memory.read'])
  assert.deepEqual((await mixed.call('settings.model', changeModel)).result, refused('read-only'))
  const writer = await greet(engine, ['settings.read', 'settings.model'])
  assert.deepEqual(writer.offer, ['settings.read', 'settings.model'])
  assert.deepEqual((await writer.call('settings.model', changeModel)).result, saved)
})

// S4: a write-only host offer opens no settings grant.
test('the host must offer settings read to negotiate a write', async (t) => {
  const host = { offers: ['settings-name', 'settings-model'] }
  const { dsh, engine } = world(t, { host })
  const socket = await dsh.open()
  const p = await greet(engine)
  assert.equal(p.offer, undefined)
  assert.equal(socket.calls('manage-open').length, 0)
  assert.deepEqual((await p.call('settings.name', rename)).result, refused('read-only'))
  assert.deepEqual((await p.call('settings.model', changeModel)).result, refused('read-only'))

  host.offers = ['settings-read']
  socket.destroy()
  assert.ok(await dsh.open())
  const reader = await greet(engine)
  assert.deepEqual(reader.offer, ['settings.read'])
  assert.deepEqual((await reader.call('settings.read', target)).result, read)
})

// S5: old and read-only hosts keep their management offers and refuse settings.
test('settings are unavailable with an older plugin, a read-only host or no DSH source', async (t) => {
  const offers = [...memoryOffers, ...scheduleOffers]
  for (const writable of [true, false]) {
    const { dsh, engine } = world(t, { host: { offers, writable } })
    const socket = await dsh.open()
    const p = await greet(engine, [...settingsMethods, ...scheduleMethods, 'memory.read', 'memory.edit', 'memory.add'])
    assert.deepEqual(p.offer, writable ? offers.map(method => method.replace('-', '.')) : undefined)
    assert.deepEqual((await p.call('settings.read', target)).result, refused('read-only'))
    assert.equal(socket.calls('settings-read').length, 0)
  }
  const p = await greet({})
  assert.deepEqual((await p.call('settings.read', target)).result, refused('read-only'))
})

// S6: an older phone keeps its schedule support without gaining settings.
test('previous phone hellos do not opt into settings', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const old = phone(engine)
  old.hello()
  assert.equal((await old.greeted()).manage, undefined)
  assert.deepEqual((await old.call('settings.read', target)).result, refused('read-only'))
  const scheduled = await greet(engine, ['schedule.list'])
  assert.deepEqual(scheduled.offer, ['schedule.list'])
  assert.deepEqual((await scheduled.call('settings.read', target)).result, refused('read-only'))
  assert.deepEqual((await scheduled.call('schedule.list', target)).result, scheduleList)
  assert.equal(socket.calls('settings-read').length, 0)
})

// S7: each method forwards just its fields and the bridge chooses the grant.
test('only the method fields reach the host and the name is untrimmed', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = await greet(engine)
  const injected = { grant: 'wrong', phone: 'x', level: 'danger-full-access', effort: 'high', role: 'r', permission: 'p', id: 'i', title: 't', write: 1 }
  assert.deepEqual((await p.call('settings.read', { ...injected, ...rename, model })).result, read)
  assert.deepEqual((await p.call('settings.name', { ...injected, ...rename, model })).result, saved)
  assert.deepEqual((await p.call('settings.model', { ...injected, ...changeModel, name })).result, saved)
  assert.deepEqual(calls(socket).slice(3), [
    ['settings-read', { grant: 'g1', terminal }],
    ['settings-name', { grant: 'g1', terminal, rev, name }],
    ['settings-model', { grant: 'g1', terminal, rev, model }],
  ])
})

// S8: terminals obey the bridge's 128-character limit; write fields match host validation.
test('settings validation runs before shared rate accounting and accepts byte boundaries', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = await greet(engine)
  const invalidFields = [
    ...['dsh:', 'worker', 'dsh:' + 'a'.repeat(125)].map(terminal => ['settings.read', { terminal }]),
    ...[undefined, null, rev.toUpperCase(), rev.slice(1), rev + '0', 123, [rev]]
      .map(rev => ['settings.name', { ...rename, rev }]),
    ...[1, 'é'.repeat(2048) + 'a'].map(name => ['settings.name', { ...rename, name }]),
    ...['ab', 'abc', '/ab', 'ab/', '/', 'a\u0000/b', 'a/b\u001f', 'a/b\u007f', 'p/' + 'm'.repeat(511), 1, [model]]
      .map(model => ['settings.model', { ...changeModel, model }]),
  ]
  for (const [method, params] of invalidFields) {
    assert.deepEqual((await p.call(method, params)).result, refused('invalid'), JSON.stringify({ method, params }))
  }
  assert.equal(socket.requests.length, 3)
  assert.equal(dsh.phones.size, 0)

  const boundary = { terminal: 'dsh:' + 'a'.repeat(124) }
  const longName = { ...rename, name: 'é'.repeat(2048) }
  assert.deepEqual((await p.call('settings.read', boundary)).result, read)
  assert.deepEqual((await p.call('settings.name', longName)).result, saved)
  const refs = ['a/b', 'a//', 'a/b/c', 'é/é', 'p/' + 'm'.repeat(510)]
  for (const model of refs) {
    assert.deepEqual((await p.call('settings.model', { ...changeModel, model })).result, saved)
  }
  assert.deepEqual(calls(socket).slice(3), [
    ['settings-read', { grant: 'g1', ...boundary }],
    ['settings-name', { grant: 'g1', ...longName }],
    ...refs.map(model => ['settings-model', { grant: 'g1', terminal, rev, model }]),
  ])
})

// S9: authority and field validation precede the shared per-phone, per-terminal slot.
test('settings share management busy slots across connections and families', async (t) => {
  const { dsh, engine } = world(t, { requestMs: 1000, host: {
    reply: ({ method, params }) => params.terminal === terminal && ['settings-read', 'memory-read'].includes(method) ? null : undefined,
  } })
  const socket = await dsh.open()
  const a = await greet(engine, ['settings.read'])
  const b = await greet(engine, ['settings.read', 'settings.name', 'memory.read', 'schedule.list'])
  const readId = a.send('settings.read', target)
  const heldRead = await until(() => socket.calls('settings-read')[0], 'held settings read')
  assert.deepEqual((await b.call('settings.model', changeModel)).result, refused('read-only'))
  assert.deepEqual((await b.call('settings.name', { ...rename, rev: null })).result, refused('invalid'))
  assert.deepEqual((await b.call('settings.name', rename)).result, refused('busy'))
  assert.deepEqual((await b.call('memory.read', target)).result, refused('busy'))
  assert.deepEqual((await b.call('schedule.list', target)).result, refused('busy'))
  assert.equal(socket.requests.length, 5)
  assert.deepEqual((await b.call('settings.read', { terminal: 'dsh:b-bbbbbbbbbb' })).result, read)
  socket.reply(heldRead, { result: read })
  assert.deepEqual((await a.answer(readId)).result, read)

  const memoryId = b.send('memory.read', target)
  const heldMemory = await until(() => socket.calls('memory-read')[0], 'held memory read')
  assert.deepEqual((await a.call('settings.read', target)).result, refused('busy'))
  assert.equal(socket.calls('settings-read').length, 2)
  socket.reply(heldMemory, { result: memoryRead })
  assert.deepEqual((await b.answer(memoryId)).result, memoryRead)
})

// S10: quotas span families, and a slot held by read 60 takes precedence over the rate limit.
test('settings use shared rates and return busy before rate', async (t) => {
  let hold = false
  const { dsh, engine } = world(t, { requestMs: 1000, host: {
    reply: ({ method }) => hold && method === 'settings-read' ? null : undefined,
  } })
  const socket = await dsh.open()
  const a = await greet(engine, [...settingsMethods, 'memory.read', 'memory.add'])
  const b = await greet(engine, ['settings.read'])
  for (let i = 0; i < 29; i++) {
    assert.deepEqual((await a.call('memory.read', target)).result, memoryRead)
    assert.deepEqual((await a.call('settings.read', target)).result, read)
  }
  assert.deepEqual((await a.call('memory.read', target)).result, memoryRead)
  hold = true
  const readId = a.send('settings.read', target)
  const held = await until(() => socket.calls('settings-read')[29], 'held read at quota')
  assert.deepEqual((await b.call('settings.read', target)).result, refused('busy'))
  assert.equal(socket.calls('settings-read').length, 30)
  socket.reply(held, { result: read })
  assert.deepEqual((await a.answer(readId)).result, read)
  assert.deepEqual((await b.call('settings.read', target)).result, refused('rate'))
  assert.equal(socket.calls('memory-read').length, 30)
  assert.equal(socket.calls('settings-read').length, 30)

  assert.ok((await a.call('chat.subscribe', target)).result.channel)
  for (let i = 0; i < 10; i++) {
    const id = `chat-${i}`
    assert.deepEqual((await a.call('chat.send', { terminal, id, text: 'hi' })).result, { state: 'sent', id })
  }
  for (let i = 0; i < 9; i++) {
    assert.deepEqual((await a.call('memory.add', { terminal, text: 'entry' })).result, { ok: true, state: 'saved' })
  }
  assert.deepEqual((await a.call('settings.name', rename)).result, saved)
  assert.deepEqual((await a.call('settings.model', changeModel)).result, refused('rate'))
  assert.equal(socket.calls('send').length, 10)
  assert.equal(socket.calls('memory-add').length, 9)
  assert.equal(socket.calls('settings-name').length, 1)
  assert.equal(socket.calls('settings-model').length, 0)
})

// S11: transport busy precedes settings validation, and its reply is live-only too.
test('settings requests share the 16-request transport limit', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const pending = Promise.withResolvers()
  t.after(pending.resolve)
  engine.ready = () => pending.promise
  const p = await greet(engine)
  for (let i = 0; i < MAX_IN_FLIGHT; i++) p.send('chat.list')
  const answer = await p.call('settings.read', { terminal: 'dsh:' })
  assert.deepEqual(answer.error, { code: -32000, message: 'at most 16 requests at once', data: { kind: 'busy' } })
  assert.equal(answer.result, undefined)
  assert.deepEqual(p.queued[1].opts, { liveOnly: true })
  assert.equal(socket.calls('settings-read').length, 0)
  pending.resolve()
  await p.answer(MAX_IN_FLIGHT)
})

// S12: host results retain their fields; host and engine errors withhold private text.
test('settings results pass through, while errors withhold host and engine details', async (t) => {
  const logs = []
  const log = line => logs.push(line)
  const authority = ['revoked', 'not-found', 'not-shown', 'global', 'unavailable']
  const outcomes = [
    read, saved, { ...saved, state: 'unchanged' },
    ...['stale', 'computer', 'changing', 'unknown-model', 'model-not-allowed']
      .map(reason => ({ ...refused(reason), settings, models })),
    { ...refused('invalid'), message: 'Give the Bot a name', settings, models },
    {
      ...refused('not-applied'),
      message: 'The computer could not switch the Bot to that model, so it stays on its current one.',
      settings: { ...settings, level: { ...settings.level, auto: false } }, models,
    },
    { ok: false, state: 'unknown', reason: 'pending', settings, models },
    { ok: false, state: 'unknown', reason: 'pending' },
    ...authority.map(refused),
    ...authority.map(reason => ({ ...refused(reason), applied: true })),
    ...['busy', 'rate', 'too-large'].map(refused),
    {
      ...read, extra: 1, models: { entries: [], truncated: true },
      settings: {
        ...settings,
        level: { ...settings.level, fallback: 'workspace-write', notOffered: true, runs: 'workspace-write' },
        editable: { name: true, model: false, reason: 'shell' },
      },
    },
    { ...read, models: { entries: [], truncated: false } },
  ]
  const remaining = [...outcomes]
  const { dsh, engine } = world(t, { log, host: {
    reply: ({ method }) => {
      if (method === 'settings-read') return { result: remaining.shift() }
      if (method === 'settings-name') return { error: { kind: 'private', message: 'HOST-MARKER', extra: 'HOST-MARKER' } }
    },
  } })
  assert.ok(await dsh.open())
  const p = await greet(engine, settingsMethods, { log })
  for (const expected of outcomes) assert.deepEqual((await p.call('settings.read', target)).result, expected)
  assert.deepEqual((await p.call('settings.name', rename)).result, refused('private'))
  assert.deepEqual(logs, [])
  engine.settings = () => { throw new Error('ENGINE-MARKER') }
  assert.deepEqual((await p.call('settings.model', changeModel)).error, { code: -32000, message: 'failed', data: { kind: 'failed' } })
  assert.deepEqual(logs, ['chat: settings request failed'])
  assert.deepEqual(p.queued.at(-1).opts, { liveOnly: true })
  assert.doesNotMatch(Buffer.concat(p.submitted).toString(), /HOST-MARKER|ENGINE-MARKER/)
})

// S13: lost replies reflect whether the request was written, without any retry or follow-up.
test('a lost settings write is unknown only once written', async (t) => {
  let rejectModelWrite = true
  let unwrittenAttempts = 0
  const { dsh, engine, sockets } = world(t, { requestMs: 40, settingsWriteMs: 80, host: {
    unwritten: ({ method }) => {
      if (method !== 'settings-model' || !rejectModelWrite) return false
      unwrittenAttempts += 1
      return true
    },
    reply: ({ method }) => settingsOffers.includes(method) ? null : undefined,
  } })
  const socket = await dsh.open()
  const p = await greet(engine)
  assert.deepEqual((await p.call('settings.read', target)).result, refused('offline'))
  assert.deepEqual((await p.call('settings.name', rename)).result, unknown)
  assert.deepEqual((await p.call('settings.model', changeModel)).result, refused('offline'))
  assert.equal(unwrittenAttempts, 1)
  assert.equal(socket.calls('settings-model').length, 0)

  rejectModelWrite = false
  const modelId = p.send('settings.model', changeModel)
  await until(() => socket.calls('settings-model')[0], 'written settings model')
  socket.destroy()
  assert.deepEqual((await p.answer(modelId)).result, unknown)
  assert.equal(sockets.length, 1)
  assert.deepEqual(calls(socket).slice(3), [
    ['settings-read', { grant: 'g1', terminal }],
    ['settings-name', { grant: 'g1', ...rename }],
    ['settings-model', { grant: 'g1', ...changeModel }],
  ])
})

// S14: just settings writes use the longer deadline.
test('settings writes wait longer than settings reads and memory writes', async (t) => {
  const { dsh, engine } = world(t, { requestMs: 40, settingsWriteMs: 300, host: {
    reply: (request, socket) => {
      if (![...settingsOffers, 'memory-add'].includes(request.method)) return
      setTimeout(() => socket.reply(request, { result: request.method === 'settings-read' ? read : saved }), 120)
      return null
    },
  } })
  assert.ok(await dsh.open())
  const p = await greet(engine, [...settingsMethods, 'memory.add'])
  assert.deepEqual((await p.call('settings.model', changeModel)).result, saved)
  assert.deepEqual((await p.call('settings.name', rename)).result, saved)
  assert.deepEqual((await p.call('settings.read', target)).result, refused('offline'))
  assert.deepEqual((await p.call('memory.add', { terminal, text: 'entry' })).result, unknown)
})

// S15: the host owns line sizing. A complete 1 MiB host line and its too-large refusal pass through.
test('a full-sized settings socket line and host size refusal pass through unchanged', async (t) => {
  const lineMax = 1024 * 1024
  let boundary
  const { dsh, engine } = world(t, { host: {
    reply: (request, socket) => {
      if (request.method === 'settings-model') return { result: refused('too-large') }
      if (request.method !== 'settings-read') return
      // JSON whitespace fills the line without making individual settings fields exceed their limits.
      boundary = { ...read, models: { ...models, truncated: true } }
      const json = JSON.stringify({ id: request.id, result: boundary })
      const line = json + ' '.repeat(lineMax - Buffer.byteLength(json) - 1) + '\n'
      assert.equal(Buffer.byteLength(line), lineMax)
      socket.deliver(line)
      return null
    },
  } })
  assert.ok(await dsh.open())
  const p = await greet(engine)
  const result = (await p.call('settings.read', target)).result
  assert.ok(boundary)
  assert.deepEqual(result, boundary)
  assert.deepEqual((await p.call('settings.model', changeModel)).result, refused('too-large'))
})

// S16: queued replies are dropped on hangup or revoke; a closed client loses an in-flight result.
test('settings replies are delivered only while the phone connection is live', async (t) => {
  const { dsh, engine } = world(t, { host: {
    reply: ({ method }) => method === 'settings-name' ? null : undefined,
  } })
  const socket = await dsh.open()
  for (const reason of ['hung up', 'not paired']) {
    const blocked = Promise.withResolvers()
    const p = phone(engine, { send: () => blocked.promise })
    t.after(blocked.resolve)
    p.hello(settingsMethods)
    await p.greeted()
    p.send('settings.read', target)
    await until(() => p.queued.length === 2, 'queued settings reply')
    assert.deepEqual(p.queued[1].opts, { liveOnly: true })
    p.conn.reply({ id: 2, result: {} })
    if (reason === 'not paired') p.revoke()
    else p.conn.close(reason)
    blocked.resolve()
    await p.writer.done()
    assert.equal(p.submitted.length, reason === 'hung up' ? 2 : 1)
    if (reason === 'hung up') assert.equal(JSON.parse(p.submitted[1].subarray(9)).id, 2)
  }

  const p = await greet(engine)
  const pending = dsh.settings(p.conn.client, 'settings.name', rename)
  const held = await until(() => socket.calls('settings-name')[0], 'in-flight settings name')
  p.conn.close()
  socket.reply(held, { result: saved })
  assert.deepEqual(await pending, refused('read-only'))
})

// S17: offers are fixed per socket; reconnects enforce the read dependency and resolved team home.
test('settings grants follow socket offers and stay tied to the resolved team home', async (t) => {
  let folder = '/real-team/pocket'
  const host = { offers: ['memory-read'] }
  const { dsh, engine, sockets } = world(t, { host, realpath: path => {
    assert.equal(path, '/team/pocket')
    return folder
  } })
  const first = await dsh.open()
  const requested = ['memory.read', ...settingsMethods]
  const a = await greet(engine, requested)
  assert.deepEqual(a.offer, ['memory.read'])
  host.offers = allOffers
  const b = await greet(engine, requested)
  assert.deepEqual(b.offer, ['memory.read'])
  assert.deepEqual(first.calls('hello').map(m => m.params), [{ write: 1 }, { write: 1, manage: 1 }])
  assert.deepEqual((await a.call('settings.read', target)).result, refused('read-only'))

  first.destroy()
  assert.deepEqual((await a.call('memory.read', target)).result, memoryRead)
  assert.deepEqual((await a.call('settings.read', target)).result, refused('read-only'))
  const c = await greet(engine, requested)
  assert.deepEqual(c.offer, requested)
  assert.deepEqual((await c.call('settings.model', changeModel)).result, saved)

  host.offers = ['memory-read', 'settings-name', 'settings-model']
  sockets[1].destroy()
  assert.deepEqual((await c.call('settings.model', changeModel)).result, refused('read-only'))
  assert.deepEqual((await c.call('settings.name', rename)).result, refused('read-only'))
  assert.equal(sockets[2].calls('manage-open').length, 0)
  assert.equal(sockets[2].calls('settings-model').length, 0)
  assert.equal(sockets[2].calls('settings-name').length, 0)
  assert.deepEqual((await c.call('memory.read', target)).result, memoryRead)

  host.offers = allOffers
  folder = '/other-team/pocket'
  sockets[2].destroy()
  assert.deepEqual((await c.call('settings.read', target)).result, refused('read-only'))
  assert.deepEqual(sockets[3].requests.map(m => m.method), ['hello', 'hello'])
  const fresh = await greet(engine, requested)
  assert.deepEqual(fresh.offer, requested)
  assert.deepEqual((await fresh.call('settings.read', target)).result, read)
})
