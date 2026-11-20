// RFC 0040 through the phone wire and the DSH socket, both in memory.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatConnection, chatWriter, CLOSE, CREDIT, DATA, frame, MANAGE_METHODS, MAX_IN_FLIGHT, MAX_SUBSCRIPTIONS } from './chat.mjs'
import { ANSWER_ON_COMPUTER, DshSource, withDsh, WRITES_PER_MINUTE } from './dsh-source.mjs'

const TEAM = '/team/pocket/chat.sock'
const OTHER_TEAM = '/other-team/pocket/chat.sock'
const BOT = 'dsh:worker'
const ROOM = 'dsh:room:r1'
const ROOM2 = 'dsh:room:r2'
const PHONE = 'paired-key'
const NAME = 'Test phone'
const botRow = { terminal: BOT, agent: 'dsh' }
const roomRow = { terminal: ROOM, agent: 'dsh', chat: 'group', members: [{ name: 'A', registryId: null }], approvals: 1 }
const terminalRow = { terminal: 't1', agent: 'claude' }
const groups = { groups: 1 }
const gone = (reason = 'unavailable') => ({ type: 'gone', reason })
const refused = (reason, extra) => ({ ok: false, state: 'refused', reason, ...extra })
const result = (value) => ({ result: value })
const rpc = (id, method, params) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
const socketMethod = (method) => method.replace('.', '-')
const manageMethods = MANAGE_METHODS.map(socketMethod)
const attachMethods = ['upload-begin', 'upload-chunk', 'upload-finish', 'upload-cancel', 'attachment-read']
const png = 'image/png'
const txt = 'text/plain'
const chunkBytes = 24_576
const fileBytes = 8 * 1024 * 1024
const image = { mediaType: png, width: 1, height: 1, bytes: 1, stored: 2 }
const documents = { mediaTypes: [txt, 'application/pdf'], limits: { fileBytes } }
const backfillRows = [{ id: 'row-1', kind: 'text', text: 'Earlier line' }]

async function until(check, message) {
  const deadline = Date.now() + 2000
  for (;;) {
    const value = check()
    if (value) return value
    assert.ok(Date.now() < deadline, message)
    await delay(1)
  }
}

function helloResult({ groups = true, writable = true, offers = manageMethods, attachments, documents: files, hello }, params) {
  const methods = ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill']
  const offerGroups = hello ? hello(params) : groups
  const groupOffer = params.groups === 1 && offerGroups ? { groups: 1 } : {}
  if (!writable) return { protocol: 1, readOnly: true, methods, ...groupOffer }
  const attach = attachments && params.attachments === 1
  return {
    protocol: 1, readOnly: false, write: 1,
    methods: [...methods, 'send', 'interrupt', 'answer', ...(attach ? attachMethods : [])],
    ...groupOffer,
    ...(params.manage === 1 && offers.length ? { manage: 1, manageMethods: ['manage-open', 'manage-close', ...offers] } : {}),
    ...(attach ? {
      attachments: {
        version: 1, methods: attachMethods, mediaTypes: [png],
        ...(files && params.documents === 1 ? { documents } : {}),
        limits: { fileBytes, files: 4, messageBytes: 2 * fileBytes, deviceOutstanding: 4 * fileBytes,
          deviceDailyBytes: 32 * fileBytes, deviceDailyCount: 128, chunkBytes, maxPixels: 40_000_000,
          maxDimension: 65_535, thumbnail: { edge: 512, bytes: 131_072 } },
      },
    } : {}),
  }
}

class FakeSocket extends EventEmitter {
  constructor(host) {
    super()
    this.host = host
    this.requests = []
    this.grants = new Map()
    this.uploads = new Map()
    this.destroyed = false
    queueMicrotask(() => { if (!this.destroyed) this.emit('connect') })
  }

  setEncoding(enc) { assert.equal(enc, 'utf8') }

  write(line, flushed) {
    assert.equal(this.destroyed, false)
    const request = JSON.parse(line)
    this.requests.push(request)
    queueMicrotask(flushed)
    const answer = this.host.reply?.(request)
    if (answer !== null) this.reply(request, answer ?? result(this.defaultReply(request)))
  }

  defaultReply({ method, params }) {
    switch (method) {
      case 'hello': return helloResult(this.host, params)
      case 'list': return { terminals: [botRow, roomRow] }
      case 'subscribe': return { channel: params.channel }
      case 'backfill': return { rows: backfillRows }
      case 'send':
        for (const upload of params.uploads ?? []) {
          assert.equal(this.uploads.get(upload)?.admitted, true)
          this.uploads.delete(upload)
        }
        return { ok: true, state: 'sent', id: params.id }
      case 'interrupt': return { ok: true, state: 'sent' }
      case 'answer': return { ok: true, state: 'answered' }
      case 'manage-open':
        this.grants.set(params.grant, params.phone)
        return { grant: params.grant }
      case 'manage-close':
        this.grants.delete(params.grant)
        return {}
      case 'upload-begin':
        this.uploads.set(params.upload, { ...params, received: 0 })
        return { ok: true, state: 'open', upload: params.upload, chunkBytes }
      case 'upload-chunk': {
        const upload = this.uploads.get(params.upload)
        assert.equal(upload.received, params.offset)
        upload.received += Buffer.from(params.data, 'base64').length
        return { ok: true, received: upload.received }
      }
      case 'upload-finish': {
        const upload = this.uploads.get(params.upload)
        assert.equal(upload.received, upload.bytes)
        upload.admitted = true
        const { mediaType, bytes, name } = upload
        return { ok: true, state: 'admitted', upload: params.upload, ...(mediaType === png ? { image } : { file: { mediaType, bytes, name } }) }
      }
      case 'upload-cancel':
        this.uploads.delete(params.upload)
        return { ok: true }
      case 'attachment-read': return refused('not-found')
      default:
        if (!manageMethods.includes(method)) return {}
        assert.ok(this.grants.has(params.grant))
        return { ok: true, state: 'saved' }
    }
  }

  push(channel, event) { this.receive({ channel, event }) }
  reply(request, answer) { this.receive({ id: request.id, ...answer }) }
  receive(message) { queueMicrotask(() => this.emit('data', JSON.stringify(message) + '\n')) }
  calls(method) { return this.requests.filter((request) => request.method === method) }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
  }
}

function world(t, { hosts = { [TEAM]: {} }, options = {} } = {}) {
  const sockets = []
  const eligible = new Set(Object.keys(hosts))
  const dsh = new DshSource({
    paths: [...eligible], requestMs: 4000, groups: true, now: () => 60_000,
    check: (path) => eligible.has(path), realpath: (path) => path,
    connect: (path) => {
      const socket = new FakeSocket(hosts[path])
      sockets.push(socket)
      return socket
    },
    ...options,
  })
  t.after(() => dsh.close())
  const terminalEngine = { ready: async () => {}, list: () => [terminalRow] }
  return { dsh, sockets, eligible, engine: withDsh(terminalEngine, dsh, { by: NAME }) }
}

function phone(t, engine, options = {}) {
  const device = Object.hasOwn(options, 'device') ? options.device : PHONE
  const queued = []
  const submitted = []
  let nextId = 1
  const writer = chatWriter({
    send: (bytes) => {
      if (bytes === null) return hold.promise
      submitted.push(bytes)
    },
    isClosed: () => conn.closed,
    isRevoked: () => false,
    onFail: () => conn.close('write failed'),
  })
  let hold
  const conn = new ChatConnection({
    engine, device, window: options.window, end() {},
    write: (bytes, opts) => {
      queued.push(bytes)
      return writer(bytes, opts)
    },
  })
  t.after(() => {
    hold?.resolve()
    conn.close()
  })
  const frames = (buffers = submitted) => buffers.filter((bytes) => bytes[0] !== 0x7b).map((bytes) => ({
    channel: bytes.readUInt32LE(0), kind: bytes[4], value: bytes.length > 9 ? JSON.parse(bytes.subarray(9)) : null,
  }))
  const reply = (id, buffers) => frames(buffers).find(({ channel, kind, value }) => channel === 0 && kind === DATA && value.id === id)?.value
  const answer = (id) => until(() => reply(id), `phone reply ${id}`)
  const send = (method, params = {}) => {
    const id = nextId++
    conn.feed(frame(0, DATA, rpc(id, method, params)))
    return id
  }
  const call = (method, params) => answer(send(method, params))
  const hello = (extras) => conn.feed(Buffer.concat([rpc(0, 'hello', { generation: 1, framed: true, ...extras }), Buffer.from('\n')]))
  const greeted = async () => JSON.parse(await until(() => submitted[0], 'phone hello')).result
  return {
    conn, queued, submitted, frames, reply, answer, send, call, hello, greeted,
    async connect(extras) {
      hello(extras)
      return greeted()
    },
    async list() { return (await call('chat.list')).result.terminals },
    async watch(terminal) { return (await call('chat.subscribe', { terminal })).result.channel },
    events: (channel) => frames().filter((f) => f.channel === channel && f.kind === DATA).map((f) => f.value),
    credit(channel, n) {
      const bytes = Buffer.alloc(4)
      bytes.writeUInt32LE(n)
      conn.feed(frame(channel, CREDIT, bytes))
    },
    closeChannel: (channel) => conn.feed(frame(channel, CLOSE)),
    holdWriter() {
      hold = Promise.withResolvers()
      writer(null)
      return async () => {
        hold.resolve()
        await writer.done()
      }
    },
  }
}

test('the bridge asks groups: 1 in both socket hellos and the final reply decides', async (t) => {
  const first = { write: 1, groups: 1 }
  const second = { ...first, manage: 1 }
  for (const [host, options, expected, helloParams] of [
    [{}, {}, true, [first, second]],
    [{ hello: (p) => !p.manage }, {}, undefined, [first, second]],
    [{ hello: (p) => p.manage === 1 }, {}, true, [first, second]],
    [{ writable: false }, {}, undefined, [first]],
    [{}, { groups: false }, undefined, [{ write: 1 }, { write: 1, manage: 1 }]],
  ]) {
    const { dsh, engine } = world(t, { hosts: { [TEAM]: host }, options })
    const socket = await dsh.open()
    const p = phone(t, engine)
    assert.equal((await p.connect(groups)).groups, expected)
    assert.deepEqual(socket.calls('hello').map((m) => m.params), helloParams)
  }
})

test('two phones with opposite hello results get their own list and grant', async (t) => {
  const { dsh, engine } = world(t)
  const baseline = world(t, { options: { groups: false } })
  const socket = await dsh.open()
  await baseline.dsh.open()
  const a = phone(t, engine)
  const b = phone(t, engine, { device: 'second-phone' })
  const old = phone(t, baseline.engine)
  assert.equal((await a.connect(groups)).groups, true)
  await b.connect()
  await old.connect()
  assert.deepEqual(b.submitted[0], old.submitted[0])
  assert.deepEqual(await a.list(), [terminalRow, botRow, roomRow])
  assert.deepEqual(await b.list(), [terminalRow, botRow])
  const channel = await a.watch(ROOM)
  assert.deepEqual(socket.calls('subscribe').map((m) => m.params), [{ terminal: ROOM, channel }])
})

test("an older phone's direct subscribe on a room is not_found, listed first or not", async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const a = phone(t, engine)
  const b = phone(t, engine, { device: 'second-phone' })
  await a.connect(groups)
  await b.connect()
  const subscribeError = async (p, terminal, kind) => assert.equal((await p.call('chat.subscribe', { terminal })).error.data.kind, kind)
  await subscribeError(b, ROOM, 'not_found')
  await b.list()
  await subscribeError(b, ROOM, 'not_found')
  for (const p of [a, b]) {
    await subscribeError(p, 'dsh:room:', 'not_found')
    await subscribeError(p, ROOM.padEnd(129, 'a'), 'invalid_params')
  }
  for (const [method, params] of [
    ['send', { id: 's', text: 'Hello' }], ['answer', { row: 'a', choice: 'deny' }], ['interrupt', {}],
  ]) {
    assert.equal((await b.call(`chat.${method}`, { terminal: ROOM, ...params })).result.reason, 'not-watching')
    assert.deepEqual(socket.calls(method), [])
  }
  assert.equal((await b.call('chat.backfill', { terminal: ROOM, before: 'r1' })).error.data.kind, 'not_watching')
  assert.deepEqual(socket.calls('subscribe'), [])
  assert.deepEqual(socket.calls('backfill'), [])
})

test('the phone grant is strict: only groups 1 on a paired key with a live offer', async (t) => {
  for (const [host, device, extras] of [
    [{}, PHONE, { groups: true }], [{}, undefined, groups], [{}, 'invalid key', groups], [{ groups: false }, PHONE, groups],
  ]) {
    const { dsh, engine } = world(t, { hosts: { [TEAM]: host } })
    await dsh.open()
    const p = phone(t, engine, { device })
    assert.equal(Object.hasOwn(await p.connect(extras), 'groups'), false)
    assert.deepEqual(await p.list(), [terminalRow, botRow])
  }
})

test('a mixed old/new socket: a replacement host without groups drops the grant and room rows', async (t) => {
  const host = { groups: true }
  const { dsh, engine, sockets } = world(t, { hosts: { [TEAM]: host } })
  const first = await dsh.open()
  const a = phone(t, engine)
  assert.equal((await a.connect(groups)).groups, true)
  const room = await a.watch(ROOM)
  const bot = await a.watch(BOT)
  host.groups = false
  first.destroy()
  await tick()
  assert.deepEqual(a.events(room), [gone()])
  assert.deepEqual(a.events(bot), [gone()])
  assert.deepEqual(await a.list(), [terminalRow, botRow])
  const second = sockets[1]
  assert.equal((await a.call('chat.subscribe', { terminal: ROOM })).error.data.kind, 'not_found')
  a.closeChannel(bot)
  const replacement = await a.watch(BOT)
  assert.notEqual(bot, replacement)
  const [{ params }] = second.calls('subscribe')
  assert.equal(params.terminal, BOT)
  const snapshot = { type: 'snapshot', rows: [] }
  second.push(params.channel, snapshot)
  await tick()
  assert.deepEqual(a.events(replacement), [snapshot])
  assert.equal((await phone(t, engine).connect(groups)).groups, undefined)
})

test('a replacement team that also offers groups needs a fresh phone hello', async (t) => {
  const { dsh, engine, eligible, sockets } = world(t, { hosts: { [TEAM]: {}, [OTHER_TEAM]: {} } })
  const first = await dsh.open()
  const a = phone(t, engine)
  assert.equal((await a.connect(groups)).groups, true)
  let room = await a.watch(ROOM)
  eligible.delete(TEAM)
  first.destroy()
  await tick()
  assert.deepEqual(a.events(room), [gone()])
  assert.deepEqual(await a.list(), [terminalRow, botRow])
  const second = sockets[1]
  assert.equal(dsh.path, OTHER_TEAM)
  assert.equal((await a.call('chat.subscribe', { terminal: ROOM })).error.data.kind, 'not_found')
  assert.equal((await a.call('chat.send', { terminal: ROOM, text: 'Hello', id: 's' })).result.reason, 'not-watching')
  assert.deepEqual(second.calls('subscribe'), [])
  assert.deepEqual(second.calls('send'), [])

  const b = phone(t, engine)
  assert.equal((await b.connect(groups)).groups, true)
  assert.deepEqual(await b.list(), [terminalRow, botRow, roomRow])
  room = await b.watch(ROOM)
  second.destroy()
  await tick()
  assert.deepEqual(b.events(room), [gone()])
  assert.deepEqual(await b.list(), [terminalRow, botRow])
  assert.equal((await b.call('chat.subscribe', { terminal: ROOM })).error.data.kind, 'not_found')
  assert.equal(dsh.path, OTHER_TEAM)

  eligible.add(TEAM)
  sockets[2].destroy()
  await tick()
  assert.deepEqual(await a.list(), [terminalRow, botRow])
  assert.equal(dsh.path, TEAM)
  assert.equal((await a.call('chat.subscribe', { terminal: ROOM })).error.data.kind, 'not_found')
})

test('one phone with groups, documents and management, a Bot and a room open: each operation on both targets', async (t) => {
  const { dsh, engine } = world(t, {
    hosts: { [TEAM]: { attachments: true, documents: true } },
    options: { attachments: true, documents: true },
  })
  const socket = await dsh.open()
  const p = phone(t, engine)
  const hello = await p.connect({ ...groups, attachments: 1, documents: 1, manage: MANAGE_METHODS })
  assert.equal(hello.groups, true)
  assert.deepEqual(hello.attachments.documents, documents)
  assert.deepEqual(hello.manage, MANAGE_METHODS)
  await p.watch(BOT)
  await p.watch(ROOM)
  const [bot, room] = socket.calls('subscribe').map((m) => m.params)
  assert.deepEqual(bot, { terminal: BOT, channel: bot.channel, attachments: 1, documents: 1 })
  assert.deepEqual(room, { terminal: ROOM, channel: room.channel })

  const call = async (method, terminal, fields) => (await p.call(method, { terminal, ...fields })).result
  const relayed = async (method, to, fields, expected, wireFields) => {
    const count = socket.requests.length
    assert.deepEqual(await call(`chat.${method}`, to.terminal, fields), expected, `${method} on ${to.terminal}`)
    const [request] = socket.requests.slice(count)
    assert.equal(socket.requests.length, count + 1)
    assert.equal(request.method, method)
    assert.deepEqual(request.params, { channel: to.channel, ...wireFields })
  }
  const byPhone = { by: NAME, phone: PHONE }
  for (const to of [bot, room]) {
    for (const [id, retry] of [['first-send'], ['retry-send', true], ['retry-false', false]]) {
      const text = 'Hello'
      const fields = { text, id, ...(retry === undefined ? {} : { retry }) }
      const wire = to === room ? fields : { text, id }
      await relayed('send', to, fields, { ok: true, state: 'sent', id }, { ...wire, ...byPhone })
    }
    const choice = { row: 'approval-1', choice: 'deny' }
    await relayed('answer', to, choice, { ok: true, state: 'answered' }, { ...choice, ...byPhone })
    await relayed('interrupt', to, {}, { ok: true, state: 'sent' }, byPhone)
    const afterInterrupt = socket.requests.length
    assert.deepEqual(await call('chat.interrupt', to.terminal), refused('rate'))
    assert.equal(socket.requests.length, afterInterrupt)
    const page = { before: 'row-2', limit: 10 }
    await relayed('backfill', to, page, { rows: backfillRows }, page)
    for (const method of ['chat.sendHeld', 'chat.cancelHeld']) {
      assert.deepEqual(await call(method, to.terminal, { id: 'held' }), refused('read-only', { id: 'held', message: ANSWER_ON_COMPUTER }))
    }
  }

  const rev = '0123456789abcdef'
  const schedule = { id: 'schedule-00000000-0000-0000-0000-000000000001', rev }
  for (const [method, fields] of [
    ['memory.read'], ['memory.edit', { id: 'note', rev, text: 'Changed note' }], ['memory.add', { text: 'New note' }],
    ['schedule.list'], ['schedule.pause', schedule], ['schedule.resume', schedule], ['schedule.rename', { ...schedule, title: 'New task' }],
    ['settings.read'], ['settings.name', { rev, name: 'A Bot' }], ['settings.model', { rev, model: 'vendor/model' }],
  ]) {
    const count = socket.requests.length
    assert.deepEqual(await call(method, BOT, fields), { ok: true, state: 'saved' }, method)
    const [request] = socket.requests.slice(count)
    assert.equal(request.method, socketMethod(method))
    assert.deepEqual(request.params, { grant: socket.calls('manage-open')[0].params.grant, terminal: BOT, ...fields })
    assert.deepEqual(await call(method, ROOM, fields), refused('invalid'), method)
    assert.equal(socket.requests.length, count + 1)
  }

  const upload = 'bot-image'
  const begin = { upload, mediaType: png, bytes: 1 }
  const chunk = { upload, offset: 0, data: 'YQ==' }
  const read = { row: 'image-row', block: 0 }
  const send = { id: 'image-message', uploads: [upload] }
  const document = { upload: 'bot-document', mediaType: txt, bytes: 1, name: 'note.txt' }
  assert.deepEqual(await call('chat.attach', BOT, begin), { ok: true, state: 'open', upload, chunkBytes })
  assert.deepEqual(await call('chat.attachChunk', BOT, chunk), { ok: true, received: 1 })
  assert.deepEqual(await call('chat.attachmentRead', BOT, read), refused('not-found'))
  assert.equal(socket.calls('attachment-read').at(-1).params.channel, bot.channel)
  const count = socket.requests.length
  for (const [method, fields] of [
    ['chat.attach', begin], ['chat.attach', document],
    ['chat.attachChunk', chunk], ['chat.attachFinish', { upload }], ['chat.attachCancel', { upload }],
    ['chat.attachmentRead', read], ['chat.send', send],
  ]) {
    assert.deepEqual(await call(method, ROOM, fields), refused('unsupported'), method)
  }
  assert.equal(socket.requests.length, count)
  assert.equal(socket.uploads.get(upload).received, 1)
  assert.deepEqual(await call('chat.attachFinish', BOT, { upload }), { ok: true, state: 'admitted', upload, image })
  assert.deepEqual(await call('chat.send', BOT, send), { ok: true, state: 'sent', id: send.id })
  assert.deepEqual(socket.calls('send').at(-1).params.uploads, send.uploads)
  assert.equal(socket.uploads.has(upload), false)

  assert.deepEqual(await call('chat.attach', BOT, document), { ok: true, state: 'open', upload: document.upload, chunkBytes })
  await tick()
  const slots = () => [p.conn.attachmentInFlight, p.conn.cancelInFlight, p.conn.inFlight]
  const before = slots()
  const release = p.holdWriter()
  const beforeRoom = socket.requests.length
  const roomReplies = [
    ['chat.attach', { ...document, name: 'blocked.txt' }],
    ['chat.attachChunk', { ...chunk, upload: document.upload }],
    ['chat.attachCancel', { upload: document.upload }],
    ['chat.attachmentRead', read],
    ['chat.send', { id: 'blocked-send', uploads: [document.upload] }],
  ].map(([method, fields]) => p.send(method, { terminal: ROOM, ...fields }))
  await tick()
  assert.deepEqual(slots(), before)
  assert.equal(socket.requests.length, beforeRoom)
  const botChunk = p.send('chat.attachChunk', { terminal: BOT, ...chunk, upload: document.upload })
  await tick()
  const botCancel = p.send('chat.attachCancel', { terminal: BOT, upload: document.upload })
  await tick()
  assert.deepEqual(socket.requests.slice(beforeRoom).map((m) => [m.method, m.params.channel]), [
    ['upload-chunk', bot.channel], ['upload-cancel', bot.channel],
  ])
  await release()
  for (const id of roomReplies) assert.deepEqual((await p.answer(id)).result, refused('unsupported'))
  assert.deepEqual((await p.answer(botChunk)).result, { ok: true, received: 1 })
  assert.deepEqual((await p.answer(botCancel)).result, { ok: true })
})

test('group watches keep approvals by id, each watch its own; a Bot watch keeps its single approval', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = phone(t, engine)
  await p.connect(groups)
  const first = await p.watch(ROOM)
  const second = await p.watch(ROOM2)
  const bot = await p.watch(BOT)
  const [firstSocket, secondSocket, botSocket] = socket.calls('subscribe').map((m) => m.params.channel)
  const handle = (channel) => p.conn.subs.get(channel).handle
  const card = (id) => ({ id, kind: 'approval', open: true, choices: ['allow', 'deny'] })
  const close = (row) => ({ ...row, open: false, receipt: { by: 'computer', outcome: 'deny' } })
  const approval = (row) => ({ type: 'approval', row })
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(card)
  const initial = { type: 'snapshot', rows: [], approvals: [a, b], status: { state: 'blocked' }, settled: [] }
  socket.push(firstSocket, initial)
  await tick()
  assert.deepEqual(handle(first).approvals(), [a, b])
  assert.equal(handle(first).approval(), null)
  socket.push(firstSocket, approval(close(a)))
  await tick()
  assert.deepEqual(handle(first).approvals(), [b])
  socket.push(firstSocket, approval(c))
  await tick()
  assert.deepEqual(handle(first).approvals(), [b, c])
  const other = { type: 'snapshot', rows: [], approvals: [d] }
  socket.push(secondSocket, other)
  await tick()
  assert.deepEqual(handle(second).approvals(), [d])
  socket.push(secondSocket, approval(close(d)))
  await tick()
  assert.deepEqual(handle(second).approvals(), [])
  assert.deepEqual(handle(first).approvals(), [b, c])
  assert.deepEqual(p.events(first), [initial, approval(close(a)), approval(c)])
  assert.deepEqual(p.events(second), [other, approval(close(d))])
  const botInitial = { type: 'snapshot', rows: [], approval: a }
  socket.push(botSocket, botInitial)
  socket.push(botSocket, approval(b))
  await tick()
  assert.deepEqual(handle(bot).approval(), b)
  socket.push(botSocket, approval(close(b)))
  await tick()
  assert.equal(handle(bot).approval(), null)
  assert.deepEqual(p.events(bot), [botInitial, approval(b), approval(close(b))])
})

async function creditWatch(t, terminal) {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const window = 128
  const p = phone(t, engine, { window })
  await p.connect(groups)
  const channel = await p.watch(terminal)
  const [watch] = socket.calls('subscribe')
  const push = (event) => socket.push(watch.params.channel, event)
  const snapshot = { type: 'snapshot', rows: [{ id: 'big-row', text: 'x'.repeat(window) }] }
  const rows = { type: 'rows', rows: [{ id: 'next-row', text: 'More' }] }
  const ended = gone('not-shown')
  return { window, p, channel, push, snapshot, rows, ended }
}

test('a group gone drops a snapshot still in the writer and frees the slot', async (t) => {
  const { p, channel, push, snapshot, rows, ended } = await creditWatch(t, ROOM)
  const release = p.holdWriter()
  push(snapshot)
  push(rows)
  await tick()
  const sub = p.conn.subs.get(channel)
  assert.ok(sub.credit <= 0)
  assert.equal(sub.queue.length, 1)
  assert.deepEqual(p.frames(p.queued).filter((f) => f.channel === channel).map((f) => f.value), [snapshot])
  assert.deepEqual(p.events(channel), [])
  push(ended)
  await tick()
  assert.equal(p.conn.subs.has(channel), false)
  assert.equal(sub.queue.length, 0)
  await release()
  assert.deepEqual(p.events(channel), [ended])
  assert.notEqual(await p.watch(ROOM), channel)
  for (let i = 1; i < MAX_SUBSCRIPTIONS; i++) assert.ok(await p.watch(`dsh:room:extra-${i}`))
  assert.equal(p.conn.subs.size, MAX_SUBSCRIPTIONS)
})

test('a group gone after a delivered snapshot is sent at once', async (t) => {
  const { window, p, channel, push, snapshot, rows, ended } = await creditWatch(t, ROOM)
  push(snapshot)
  push(rows)
  await tick()
  assert.deepEqual(p.events(channel), [snapshot])
  assert.ok(p.conn.subs.get(channel).credit <= 0)
  assert.equal(p.conn.subs.get(channel).queue.length, 1)
  push(ended)
  await tick()
  assert.deepEqual(p.events(channel), [snapshot, ended])
  assert.equal(p.conn.subs.size, 0)
  const count = p.submitted.length
  p.credit(channel, 2 * window)
  await tick()
  assert.equal(p.submitted.length, count)
  assert.equal(p.conn.closed, false)
})

test('a Bot gone still waits for credit and drains', async (t) => {
  const { window, p, channel, push, snapshot, rows, ended } = await creditWatch(t, BOT)
  push(snapshot)
  push(rows)
  await tick()
  assert.deepEqual(p.events(channel), [snapshot])
  push(ended)
  await tick()
  assert.deepEqual(p.events(channel), [snapshot])
  p.credit(channel, 2 * window)
  await tick()
  assert.deepEqual(p.events(channel), [snapshot, rows, ended])
})

test('pending replies of an ended group watch are dropped, a live unknown passes through', async (t) => {
  const host = {}
  const { dsh, engine } = world(t, { hosts: { [TEAM]: host } })
  const socket = await dsh.open()
  const p = phone(t, engine)
  await p.connect(groups)
  let channel = await p.watch(ROOM)
  const send = { terminal: ROOM, text: 'Retry this', id: 'message', retry: true }
  const answer = { terminal: ROOM, row: 'approval-1', choice: 'deny' }
  const unknown = { ok: false, state: 'unknown', id: send.id }
  for (const [method, params] of [['send', send], ['answer', answer], ['interrupt', { terminal: ROOM }]]) {
    const watching = socket.calls('subscribe').at(-1).params.channel
    host.reply = (request) => request.method === method || request.method === 'backfill' ? null : undefined
    const id = p.send(`chat.${method}`, params)
    const held = socket.calls(method).at(-1)
    assert.equal(held?.params.channel, watching)
    let backfillId
    let heldBackfill
    if (method === 'send') {
      backfillId = p.send('chat.backfill', { terminal: ROOM, before: 'r2' })
      heldBackfill = socket.calls('backfill').at(-1)
      assert.equal(heldBackfill?.params.channel, watching)
    }
    const release = method === 'answer' ? p.holdWriter() : undefined
    const ended = gone('not-shown')
    socket.push(watching, ended)
    await tick()
    const oldChannel = channel
    const resubscribe = p.send('chat.subscribe', { terminal: ROOM })
    await tick()
    const replacement = socket.calls('subscribe').at(-1).params.channel
    assert.notEqual(replacement, watching)
    socket.reply(held, result(method === 'send' ? unknown : { ok: true, state: 'sent' }))
    if (heldBackfill) socket.reply(heldBackfill, { error: { kind: 'not-shown' } })
    await tick()
    if (release) await release()
    channel = (await p.answer(resubscribe)).result.channel
    assert.notEqual(channel, oldChannel)
    assert.deepEqual(p.events(oldChannel), [ended])
    assert.equal(p.reply(id), undefined)
    if (heldBackfill) assert.equal(p.reply(backfillId), undefined)
    assert.equal(p.conn.inFlight, 0)
  }

  const watching = socket.calls('subscribe').at(-1).params.channel
  host.reply = ({ method }) => method === 'answer' ? null : undefined
  const release = p.holdWriter()
  const id = p.send('chat.answer', answer)
  const held = socket.calls('answer').at(-1)
  assert.equal(held?.params.channel, watching)
  const answered = { ok: true, state: 'answered', receipt: { id: answer.row, by: 'phone', outcome: 'deny' } }
  socket.reply(held, result(answered))
  await tick()
  assert.deepEqual(p.reply(id, p.queued).result, answered)
  socket.push(watching, gone('deleted'))
  await tick()
  await release()
  assert.equal(p.reply(id), undefined)
  assert.deepEqual(p.events(channel), [gone('deleted')])

  host.reply = ({ method }) => method === 'send' ? result(unknown) : undefined
  await p.watch(ROOM)
  assert.deepEqual((await p.call('chat.send', send)).result, unknown)
  assert.equal(socket.calls('send').at(-1).params.retry, true)
})

test('a list reply queued behind a held writer loses its room rows if the grant ends first', async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = phone(t, engine)
  await p.connect(groups)
  const release = p.holdWriter()
  const id = p.send('chat.list')
  await tick()
  assert.deepEqual(p.reply(id, p.queued).result.terminals, [terminalRow, botRow, roomRow])
  socket.destroy()
  await tick()
  await release()
  assert.deepEqual((await p.answer(id)).result.terminals, [terminalRow, botRow])
})

test('a hello queued behind a held writer drops groups if the grant ends first; a subscribe reply comes before its gone', async (t) => {
  const { dsh, engine } = world(t)
  const first = await dsh.open()
  const a = phone(t, engine)
  const releaseHello = a.holdWriter()
  a.hello(groups)
  assert.equal(JSON.parse(a.queued[0]).result.groups, true)
  first.destroy()
  await tick()
  await releaseHello()
  assert.equal(Object.hasOwn(await a.greeted(), 'groups'), false)

  for (const repeated of [false, true]) {
    const socket = await dsh.open()
    const b = phone(t, engine)
    assert.equal((await b.connect(groups)).groups, true)
    const announced = repeated ? await b.watch(ROOM) : undefined
    const release = b.holdWriter()
    const id = b.send('chat.subscribe', { terminal: ROOM })
    socket.destroy()
    await tick()
    await release()
    const { channel } = (await b.answer(id)).result
    if (repeated) assert.equal(channel, announced)
    const related = b.frames().filter((f) => f.channel === channel || f.value?.id === id)
    assert.deepEqual(related, [
      { channel: 0, kind: DATA, value: { jsonrpc: '2.0', id, result: { channel } } },
      { channel, kind: DATA, value: gone() },
    ])
    assert.equal(socket.calls('subscribe').length, 1)
  }
})

test("group writes share the phone's limits with Bot chats", async (t) => {
  const host = {}
  const { dsh, engine } = world(t, { hosts: { [TEAM]: host } })
  const socket = await dsh.open()
  const a = phone(t, engine)
  const b = phone(t, engine)
  const c = phone(t, engine, { device: 'second-phone' })
  for (const p of [a, b, c]) await p.connect(groups)
  await a.watch(BOT)
  await a.watch(ROOM)
  await b.watch(ROOM)
  await c.watch(ROOM)
  const fields = (terminal, id) => ({ terminal, text: 'Hello', id })
  host.reply = ({ method }) => method === 'send' ? null : undefined
  const id = a.send('chat.send', fields(ROOM, 'held'))
  const held = socket.calls('send').at(-1)
  assert.equal(held.params.id, 'held')
  assert.deepEqual((await b.call('chat.send', fields(ROOM, 'busy'))).result, refused('busy', { id: 'busy' }))
  assert.equal(socket.calls('send').length, 1)
  socket.reply(held, result({ state: 'sent', id: 'held' }))
  assert.equal((await a.answer(id)).result.state, 'sent')
  host.reply = undefined
  for (let i = 1; i < WRITES_PER_MINUTE; i++) {
    const [p, terminal] = i % 2 ? [a, BOT] : [b, ROOM]
    assert.equal((await p.call('chat.send', fields(terminal, `send-${i}`))).result.state, 'sent')
  }
  assert.deepEqual((await b.call('chat.send', fields(ROOM, 'rate'))).result, refused('rate', { id: 'rate' }))
  assert.equal(socket.calls('send').length, WRITES_PER_MINUTE)
  assert.equal((await c.call('chat.send', fields(ROOM, 'second-phone'))).result.state, 'sent')

  host.reply = ({ method }) => method === 'backfill' ? null : undefined
  const fill = (p) => Array.from({ length: MAX_IN_FLIGHT }, () => p.send('chat.backfill', { terminal: ROOM, before: 'r2' }))
  const aIds = fill(a)
  const extraA = a.send('chat.backfill', { terminal: ROOM, before: 'r2' })
  assert.equal((await a.answer(extraA)).error.data.kind, 'busy')
  const bIds = fill(b)
  const extraB = b.send('chat.backfill', { terminal: ROOM, before: 'r2' })
  assert.equal((await b.answer(extraB)).error.data.kind, 'busy')
  const requests = socket.calls('backfill')
  assert.equal(requests.length, 2 * MAX_IN_FLIGHT)
  for (const m of requests) socket.reply(m, result({ rows: backfillRows }))
  for (const [p, ids] of [[a, aIds], [b, bIds]]) {
    for (const n of ids) assert.deepEqual((await p.answer(n)).result.rows, backfillRows)
  }
})

test('management on a room is refused before any grant or socket call', async (t) => {
  const { dsh, engine } = world(t)
  const first = await dsh.open()
  const p = phone(t, engine)
  assert.deepEqual((await p.connect({ ...groups, manage: ['memory.read'] })).manage, ['memory.read'])
  first.destroy()
  await tick()
  const second = await dsh.open()
  assert.deepEqual((await p.call('memory.read', { terminal: ROOM })).result, refused('invalid'))
  assert.deepEqual((await p.call('settings.read', { terminal: ROOM })).result, refused('read-only'))
  assert.deepEqual(second.requests.map((m) => m.method), ['hello', 'hello'])
  assert.equal((await p.call('memory.read', { terminal: BOT })).result.ok, true)
  assert.deepEqual(second.requests.map((m) => m.method), ['hello', 'hello', 'manage-open', 'memory-read'])
})

test("a closed phone's group grant is forgotten", async (t) => {
  const { dsh, engine } = world(t)
  const socket = await dsh.open()
  const p = phone(t, engine)
  assert.equal((await p.connect(groups)).groups, true)
  await p.watch(ROOM)
  const [watch] = socket.calls('subscribe')
  const { client } = p.conn
  assert.equal(dsh.groupsFor(client), true)
  assert.equal(dsh.groupsAgreed.has(client), true)
  p.conn.close()
  assert.equal(dsh.groupsFor(client), false)
  assert.equal(dsh.groupsAgreed.has(client), false)
  assert.equal(dsh.subs.has(watch.params.channel), false)
  assert.deepEqual(socket.calls('unsubscribe').map((m) => m.params), [{ channel: watch.params.channel }])
})
