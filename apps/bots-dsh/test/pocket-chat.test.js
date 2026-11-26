// Pocket live chat for the team's own Bots (#517), driven by a fake DSH 0.2.2 Session Controller
// with the rc.1 Host Remote shapes (follow, events, state, observeState). No DSH package is
// loaded: the fake is the controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { createAdapter } from '../src/host/pocket-chat-adapter.js'
import {
  ANSWER_ON_COMPUTER, DshChatSource, KEEP_SENT_IDS, KEEP_SETTLED, PREVIEW_MAX, SEND_TEXT_MAX, cursorOf, hasSessionApi, hasWriteApi, install, ownBots, rowIdOf, rowsOf, statusOf,
} from '../src/host/pocket-chat.js'
import { CLOSE_GRACE_MS, INTERRUPT_EVERY_MS, MAX_LINE, MAX_WRITES_PER_MINUTE, socketPathOf, startPocketSocket } from '../src/host/pocket-socket.js'
import { shownReader } from '../src/host/shown.js'
import { SKILL_ACTIVITY_RECORD } from '../src/shared/skill-activity.js'
import { fakeContext } from './fake-ctx.js'

// ---- the fake Session Controller

/** A push-fed async iterable that ends when its signal aborts. */
function feed(signal) {
  const items = []
  const waiting = []
  let done = false
  const finish = () => { done = true; for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true }) }
  signal?.addEventListener('abort', finish, { once: true })
  return {
    push(value) { if (done) return; const next = waiting.shift(); if (next) next({ value, done: false }); else items.push(value) },
    end: finish,
    [Symbol.asyncIterator]() { return this },
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise(resolve => waiting.push(resolve))
    },
  }
}

const event = (seq, type, data) => ({ type: 'event', event: { type, seq, time: 1_000 + seq, data } })
const text = value => [{ type: 'text', text: value }]
const userAt = (seq, value, source = { kind: 'user' }) => event(seq, 'user/message', { id: `m${seq}`, role: 'user', content: text(value), source })
const assistantAt = (seq, value, extra = {}) => event(seq, 'assistant/message', { turn: 1, step: 0, message: { id: `a${seq}`, role: 'assistant', content: text(value), source: { kind: 'model' } }, stream: [], ...extra })

function fakeController(sessions) {
  const calls = []
  const followers = new Map()
  const observers = new Map()
  const live = id => sessions[id]
  return {
    calls,
    follow({ address }, signal) {
      calls.push(`follow ${address.kind} ${address.sessionId}`)
      const session = live(address.sessionId)
      const stream = feed(signal)
      if (!session) { stream.end(); return stream }
      const window = session.records.slice(-(session.window ?? session.records.length))
      stream.push({ type: 'snapshot', header: { version: 1, id: address.sessionId, createdAt: 0, isSeeded: false, ...session.header }, cursor: session.records.at(-1)?.event.seq ?? -1, records: window, hasMore: window.length < session.records.length, projections: { asOfSeq: -1, values: {} } })
      followers.set(address.sessionId, stream)
      return stream
    },
    async events({ address, beforeSeq, maxMessages }) {
      calls.push(`events ${address.sessionId} before ${beforeSeq} max ${maxMessages}`)
      const older = live(address.sessionId).records.filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
      const records = older.slice(-(maxMessages ?? older.length))
      return { records, hasMore: records.length < older.length, cursor: records.at(-1)?.event.seq ?? -1 }
    },
    async state({ sessionId }) {
      calls.push(`state ${sessionId}`)
      const session = live(sessionId)
      return { cursor: session.records.at(-1)?.event.seq ?? -1, active: true, running: session.running ?? false, queue: [], pendingInput: session.pending ?? [] }
    },
    observeState({ sessionId }, signal) {
      calls.push(`observeState ${sessionId}`)
      const stream = feed(signal)
      observers.set(sessionId, stream)
      return stream
    },
    // Writes: a read-only source never reaches them; a writable one only through a watch handle.
    prompts: [],
    promptGate: null,
    async prompt(request, signal) {
      calls.push('prompt')
      if (this.promptGate) await this.promptGate(signal)
      signal?.throwIfAborted?.()
      this.prompts.push(request)
      return { accepted: true }
    },
    cancel(request) { calls.push('cancel'); this.cancels = [...(this.cancels ?? []), request]; return { accepted: true } },
    // Test helpers.
    append(sessionId, record) { live(sessionId).records.push(record); followers.get(sessionId)?.push(record) },
    observe(sessionId, state) { observers.get(sessionId)?.push(state) },
  }
}

// ---- a team

const settle = () => new Promise(resolve => setImmediate(resolve))
const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} }

function team() {
  const state = {
    bots: {
      omni: { id: 'omni', name: 'Omni', sessionId: 's-omni-2', segments: [{ sessionId: 's-omni-1' }] },
      ada: { id: 'ada', name: 'Ada' },
    },
    rooms: { room1: { id: 'room1', sessions: { omni: 's-group-omni' } } },
  }
  return {
    state,
    load: async () => {},
    botOf: id => state.bots[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
  }
}

function sessions() {
  return {
    's-omni-2': {
      records: [
        event(0, 'turn/start', { turn: 1 }),
        userAt(1, 'hi'),
        userAt(2, 'file changed', { kind: 'tool' }),
        event(3, 'step/start', { turn: 1, step: 0 }),
        assistantAt(4, 'hello', { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } }),
        event(5, 'tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }),
        event(6, 'tool/result', { turn: 1, step: 0, message: { id: 'r1', role: 'tool', toolCallId: 'c1', content: text('a b'), source: { kind: 'tool' } } }),
      ],
    },
    ada: { records: [userAt(0, 'yo')] },
    's-sub': { header: { origin: 'subagent' }, records: [] },
  }
}

const sourceOf = (controller, rt = team()) => new DshChatSource({ adapter: createAdapter(controller), bots: ownBots(rt), timers })
const watcher = () => {
  const events = []
  return { events, listener: e => events.push(e), last: type => events.filter(e => e.type === type).at(-1) }
}

// ---- tests

test('lists only the team\'s own live Bots, each with its own current chat Session', async () => {
  const rt = team()
  assert.deepEqual(await ownBots(rt)(), [
    { id: 'omni', name: 'Omni', sessionId: 's-omni-2', project: null },
    { id: 'ada', name: 'Ada', sessionId: 'ada', project: null },
  ])
  const listed = await sourceOf(fakeController(sessions()), rt).list()
  assert.deepEqual(listed.map(row => [row.terminal, row.agent, row.chat, row.title]), [['dsh:omni', 'dsh', 'session', 'Omni'], ['dsh:ada', 'dsh', 'session', 'Ada']])
  // No group, task or archived segment Session is ever listed.
  assert.ok(!JSON.stringify(listed).includes('s-group-omni') && !JSON.stringify(listed).includes('s-omni-1'))
})

test('a subagent Session is refused', async () => {
  const rt = team()
  rt.state.bots.sub = { id: 'sub', name: 'Sub', sessionId: 's-sub' }
  const result = await sourceOf(fakeController(sessions()), rt).watch('dsh:sub', () => {})
  assert.deepEqual(result, { ok: false, reason: 'subagent' })
})

test('a snapshot maps the log to rows in seq order, with the status, and follows passively', async () => {
  const controller = fakeController(sessions())
  const w = watcher()
  const handle = await sourceOf(controller).watch('dsh:omni', w.listener)
  assert.equal(handle.ok, true)
  const snapshot = w.events[0]
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.reset, false)
  assert.deepEqual(snapshot.screen, [])
  assert.deepEqual(snapshot.held, [])
  assert.equal(snapshot.approval, null)
  assert.deepEqual(snapshot.status, { state: 'idle', kind: null, msg: '', turn: 1 })
  assert.deepEqual(snapshot.rows.map(row => [row.id, row.kind, row.role ?? null, row.source]), [
    ['dsh:s-omni-2:1', 'text', 'user', 'session'],
    ['dsh:s-omni-2:4', 'text', 'assistant', 'session'],
    ['dsh:s-omni-2:4#tokens', 'tokens', null, 'session'],
    ['dsh:s-omni-2:5', 'tool-call', null, 'session'],
    ['dsh:s-omni-2:6', 'tool-result', null, 'session'],
  ])
  assert.deepEqual(snapshot.rows[2], { id: 'dsh:s-omni-2:4#tokens', turn: 1, at: 1004, source: 'session', kind: 'tokens', input: 10, output: 3, cache: 2 })
  assert.equal(snapshot.rows[3].tool, 'bash')
  assert.equal(snapshot.rows[4].call, 'dsh:s-omni-2:5')
  assert.equal(snapshot.rows[4].output, 'a b')
  // An ordinary Session address, a passive follow, and nothing but reads.
  assert.deepEqual(controller.calls, ['follow session s-omni-2', 'state s-omni-2', 'observeState s-omni-2'])
  handle.close()
})

test('a pending approval shows a read-only row that says Answer on the computer', async () => {
  const data = sessions()
  const controller = fakeController(data)
  const w = watcher()
  const handle = await sourceOf(controller).watch('dsh:omni', w.listener)
  // A new call: the source re-reads the state, since a pending approval alone wakes nothing.
  data['s-omni-2'].pending = ['approval']
  data['s-omni-2'].running = true
  controller.append('s-omni-2', event(7, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'rm', arguments: '{}' }))
  await settle(); await settle()
  assert.deepEqual(w.last('rows').rows.map(row => row.id), ['dsh:s-omni-2:7'])
  assert.deepEqual(w.last('status').status, { state: 'blocked', kind: 'permission', msg: ANSWER_ON_COMPUTER, turn: 1 })
  const row = w.last('approval').row
  assert.equal(row.kind, 'approval')
  assert.equal(row.summary, 'Answer on the computer')
  assert.equal(row.answerable, false)
  assert.deepEqual(row.choices, [])
  assert.equal(row.open, true)
  // Answered on the computer: observeState carries the change, and the row closes.
  controller.observe('s-omni-2', { cursor: 8, active: true, running: true, queue: [], pendingInput: [] })
  await settle()
  assert.deepEqual(w.last('approval').row.open, false)
  assert.equal(w.last('status').status.state, 'working')
  // A question is the same: read-only, answered on the computer.
  controller.observe('s-omni-2', { cursor: 9, active: true, running: true, queue: [], pendingInput: ['question'] })
  await settle()
  assert.deepEqual([w.last('question').row.kind, w.last('question').row.prompt, w.last('question').row.answerable], ['question', ANSWER_ON_COMPUTER, false])
  assert.ok(!controller.calls.includes('prompt') && !controller.calls.includes('cancel'))
  handle.close()
})

test('reconnect: a cursor in the window gets only what it missed; an older one is paged; another Session\'s resets', async () => {
  const data = sessions()
  data['s-omni-2'].window = 3
  const controller = fakeController(data)
  const source = sourceOf(controller)
  const first = watcher()
  const handle = await source.watch('dsh:omni', first.listener)
  assert.deepEqual(first.events[0].rows.map(row => row.id), ['dsh:s-omni-2:4', 'dsh:s-omni-2:4#tokens', 'dsh:s-omni-2:5', 'dsh:s-omni-2:6'])
  // Missed within the rows kept.
  const again = watcher()
  await source.watch('dsh:omni', again.listener, { after: 'dsh:s-omni-2:5' })
  assert.deepEqual([again.events[0].reset, again.events[0].rows.map(row => row.id)], [false, ['dsh:s-omni-2:6']])
  // Older than the kept rows: one events page fills the gap.
  const older = watcher()
  await source.watch('dsh:omni', older.listener, { after: 'dsh:s-omni-2:1' })
  assert.equal(older.events[0].reset, false)
  assert.deepEqual(older.events[0].rows.map(row => row.id), ['dsh:s-omni-2:4', 'dsh:s-omni-2:4#tokens', 'dsh:s-omni-2:5', 'dsh:s-omni-2:6'])
  assert.ok(controller.calls.includes('events s-omni-2 before 4 max 200'))
  // The Bot moved to a new part since: the old cursor resets to the latest page.
  const moved = watcher()
  await source.watch('dsh:omni', moved.listener, { after: 'dsh:s-omni-1:3' })
  assert.equal(moved.events[0].reset, true)
  assert.deepEqual(moved.events[0].rows.map(row => row.id), ['dsh:s-omni-2:4', 'dsh:s-omni-2:4#tokens', 'dsh:s-omni-2:5', 'dsh:s-omni-2:6'])
  // Older rows on request, from the log.
  assert.deepEqual((await handle.backfill('dsh:s-omni-2:5', 10)).map(row => row.id), ['dsh:s-omni-2:1', 'dsh:s-omni-2:4', 'dsh:s-omni-2:4#tokens'])
  source.close()
})

test('Pocket keeps a single name-only activity row live, on reconnect, and in a cold page', async () => {
  const controller = fakeController(sessions())
  const rt = team()
  const source = sourceOf(controller, rt)
  const first = watcher()
  const handle = await source.watch('dsh:omni', first.listener)
  try {
    controller.append('s-omni-2', event(7, 'tool/call', { turn: 1, step: 0, callId: 'load', name: 'load_skill', arguments: '{"name":"mint"}' }))
    const activity = event(8, SKILL_ACTIVITY_RECORD, { id: 'receipt', name: 'mint', turn: 1, step: 0 })
    activity.event.ignorable = true
    controller.append('s-omni-2', activity)
    await settle(); await settle()
    const row = { id: 'dsh:s-omni-2:8', kind: 'tool-call', turn: 1, at: 1_008, source: 'session', tool: 'Skill', summary: 'mint', input: '', output: '' }
    assert.deepEqual(first.last('rows').rows, [row])
    const next = watcher()
    await source.watch('dsh:omni', next.listener, { after: 'dsh:s-omni-2:6' })
    assert.deepEqual(next.events[0].rows, [row])
    assert.deepEqual(await handle.backfill('dsh:s-omni-2:9', 2), [row])
    rt.state.bots.omni.sessionId = 'new-omni'
    assert.deepEqual(await handle.backfill('dsh:s-omni-2:9', 2), [])
  } finally { source.close() }
})

test('every write is refused and reaches no controller method', async () => {
  const controller = fakeController(sessions())
  const source = sourceOf(controller)
  for (const [name, args] of [['send', ['dsh:omni', { text: 'x', id: 'm1' }]], ['sendHeld', ['dsh:omni', { id: 'm1' }]], ['cancelHeld', ['dsh:omni', { id: 'm1' }]], ['answer', ['dsh:omni', { row: 'r', choice: 'allow' }]], ['interrupt', ['dsh:omni']]]) {
    const answer = source[name](...args)
    assert.equal(answer.state, 'refused', name)
    assert.equal(answer.reason, 'read-only', name)
    assert.equal(answer.message, ANSWER_ON_COMPUTER, name)
  }
  assert.deepEqual(controller.calls, [])
})

test('rows and status helpers keep their contract', () => {
  assert.deepEqual(cursorOf(rowIdOf('s1', 12, 'tokens')), { sessionId: 's1', seq: 12 })
  assert.equal(cursorOf('t3:7'), null)
  assert.deepEqual(rowsOf({ type: 'request/header', seq: 1, data: {} }, { sessionId: 's', turn: 0, calls: new Map() }), [])
  assert.equal(statusOf({ running: true, pendingInput: [] }).state, 'working')
  assert.equal(hasSessionApi({ follow() {} }), false, 'DSH 0.2.1 has follow alone: not enough')
})

// ---- the socket

const tempHome = () => mkdtempSync(join(tmpdir(), 'pchat-'))
/** How long a test waits for one answer or step before it fails (never hangs). */
const STEP_MS = 5000

/** `promise`, or a rejection after `ms`; the timer is cleared either way. */
function within(promise, ms = STEP_MS) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

function client(path) {
  const socket = createConnection(path)
  let buffer = ''
  let ended = false
  const lines = []
  const waiting = []
  const wake = () => { for (const wait of waiting.splice(0)) wait() }
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => { ended = true; wake() })
  socket.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      lines.push(message)
    }
    wake()
  })
  // An answer that does not come fails the test: the socket closed, or STEP_MS went by.
  const until = async (match) => {
    for (;;) {
      const found = lines.find(match)
      if (found) return found
      if (ended) throw new Error('the socket closed before the answer')
      await within(new Promise(resolve => waiting.push(resolve)))
    }
  }
  let next = 1
  return {
    socket, lines, until,
    ask: (method, params) => { const id = next++; socket.write(`${JSON.stringify({ id, method, params })}\n`); return until(line => line.id === id) },
    closed: () => within(new Promise(resolve => (ended ? resolve() : socket.once('close', resolve)))),
  }
}

/**
 * One test's team home. Whatever the test opens through it (hosts, clients, child processes) is
 * closed after the test, passed or failed, and only then is the home removed: no handle outlives
 * a test.
 */
function scope(t) {
  const home = tempHome()
  const opened = []
  t.after(async () => {
    for (const close of opened.reverse()) await close()
    rmSync(home, { recursive: true, force: true })
  })
  return {
    home,
    path: socketPathOf(home),
    /** Run `close` after the test, before the home is removed (last opened, first closed). */
    defer: (close) => { opened.push(close) },
    /** A host on this home; closed after the test even if the test stopped waiting for it. */
    start(options = {}) {
      const started = startPocketSocket({ home, source: sourceOf(fakeController(sessions())), ...options })
      opened.push(async () => { const host = await started.catch(() => null); await host?.close() })
      return started
    },
    client(path = socketPathOf(home), options) {
      const c = options ? null : client(path)
      const socket = c?.socket ?? createConnection({ path, ...options })
      if (!c) socket.on('error', () => {})
      opened.push(() => socket.destroy())
      return c ?? socket
    },
    async hello(path = socketPathOf(home)) {
      const c = this.client(path)
      try { return (await c.ask('hello')).result } finally { c.socket.destroy() }
    },
    /** A socket left by a host that died: a child binds it and is killed (a clean close unlinks it). */
    async staleSocket() {
      mkdirSync(join(home, 'pocket'), { recursive: true, mode: 0o700 })
      const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(process.env.SOCK, () => console.log('ok'))"], { env: { ...process.env, SOCK: socketPathOf(home) }, stdio: ['ignore', 'pipe', 'inherit'] })
      const exited = new Promise(resolve => child.once('exit', resolve))
      const kill = async () => { child.kill('SIGKILL'); await exited; child.stdout.destroy() }
      opened.push(kill)
      try {
        await within(new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('the stale host exited before it bound'))) }))
      } finally {
        await kill()
      }
      return lstatSync(socketPathOf(home))
    },
  }
}

test('the socket is a Unix socket under the team home, mode 0600 in a 0700 folder', async (t) => {
  const s = scope(t)
  const server = await s.start()
  assert.equal(server.path, socketPathOf(s.home))
  assert.ok(!relative(s.home, server.path).startsWith('..'), 'under the team home')
  assert.ok(lstatSync(server.path).isSocket())
  assert.equal(statSync(server.path).mode & 0o777, 0o600)
  assert.equal(statSync(join(s.home, 'pocket')).mode & 0o777, 0o700)
  await server.close()
})

test('over the socket: list and subscribe read; every other method is answered read-only', async (t) => {
  const s = scope(t)
  const controller = fakeController(sessions())
  const server = await s.start({ source: sourceOf(controller) })
  const c = s.client(server.path)
  assert.deepEqual((await c.ask('hello')).result, { protocol: 1, readOnly: true, methods: ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill'] })
  assert.deepEqual((await c.ask('list')).result.terminals.map(row => row.terminal), ['dsh:omni', 'dsh:ada'])
  assert.deepEqual((await c.ask('subscribe', { terminal: 'dsh:omni', channel: 3 })).result, { channel: 3 })
  const snapshot = await c.until(line => line.channel === 3 && line.event.type === 'snapshot')
  assert.equal(snapshot.event.rows.length, 5)
  for (const method of ['send', 'sendHeld', 'cancelHeld', 'answer', 'interrupt', 'prompt', '$events']) {
    assert.equal((await c.ask(method, { terminal: 'dsh:omni' })).error.kind, 'read-only', method)
  }
  assert.ok(!controller.calls.includes('prompt') && !controller.calls.includes('cancel'))
  // A line past the limit ends the connection.
  const gone = c.closed()
  c.socket.write('x'.repeat(MAX_LINE + 2))
  await gone
})

// ---- the socket's start and stop (#548)

/**
 * Which file is at a path: the same tuple the stale check compares. An inode alone proves
 * nothing, since Linux hands a freed one to the next file at once (#301).
 */
const identityOf = s => ({ dev: s.dev, ino: s.ino, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs })
const identity = path => identityOf(lstatSync(path))

test('start refuses something that is not a socket at the path, and keeps it', async (t) => {
  const s = scope(t)
  mkdirSync(join(s.home, 'pocket'), { mode: 0o700 })
  writeFileSync(s.path, 'keep me')
  await assert.rejects(s.start(), /not a socket/)
  assert.equal(readFileSync(s.path, 'utf8'), 'keep me')
})

test('start refuses while another host serves the team, and leaves that host serving', async (t) => {
  const s = scope(t)
  const first = await s.start()
  const before = identity(first.path)
  await assert.rejects(s.start(), /another host already serves/)
  assert.deepEqual(identity(first.path), before, 'the live socket is kept')
  assert.equal((await s.hello()).readOnly, true)
})

test('start removes a dead host\'s stale socket and serves in its place', async (t) => {
  const s = scope(t)
  const stale = await s.staleSocket()
  assert.ok(stale.isSocket())
  const server = await s.start()
  assert.notDeepEqual(identity(server.path), identityOf(stale), 'another file than the stale one')
  assert.equal(statSync(server.path).mode & 0o777, 0o600)
  // The stale host is dead, so an answer can only come from the new one.
  assert.equal((await s.hello()).readOnly, true)
  await server.close()
  assert.equal(existsSync(server.path), false, 'a clean stop leaves no socket')
})

test('start tightens a folder others could open back to 0700', async (t) => {
  const s = scope(t)
  mkdirSync(join(s.home, 'pocket'))
  chmodSync(join(s.home, 'pocket'), 0o777)
  const server = await s.start()
  assert.equal(statSync(join(s.home, 'pocket')).mode & 0o777, 0o700)
  assert.equal(statSync(server.path).mode & 0o777, 0o600)
})

test('two starts at once: one serves, the other is refused, and the one serving keeps its socket', async (t) => {
  const s = scope(t)
  await s.staleSocket()
  const results = await Promise.allSettled([s.start(), s.start()])
  const won = results.filter(r => r.status === 'fulfilled').map(r => r.value)
  const lost = results.filter(r => r.status === 'rejected').map(r => r.reason.message)
  assert.equal(won.length, 1)
  assert.deepEqual(lost, ['another host already serves this team to Pocket'])
  assert.equal((await s.hello()).readOnly, true, 'the bound socket was not unlinked')
})

test('a stop cuts a reader that never ends its side, and the next start goes ahead', async (t) => {
  const s = scope(t)
  const first = await s.start()
  // A half-open reader: it keeps its side open after the host ends its own.
  const stuck = s.client(first.path, { allowHalfOpen: true })
  stuck.setEncoding('utf8')
  const answered = new Promise(resolve => stuck.once('data', resolve))
  stuck.write(`${JSON.stringify({ id: 1, method: 'hello' })}\n`)
  await within(answered)
  await within(first.close(), CLOSE_GRACE_MS + 2000)
  await within(s.start())
  assert.equal((await s.hello()).readOnly, true)
})

/** lstat with one field changed, as if the file at the path had been made again. */
const remade = field => (path) => {
  const s = lstatSync(path)
  return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { [field]: s[field] + 1 })
}

for (const field of ['ctimeMs', 'birthtimeMs']) {
  test(`a stale socket made again in its place (an inode reused) is not removed: ${field}`, async (t) => {
    const s = scope(t)
    const stale = await s.staleSocket()
    await assert.rejects(s.start({ lstat: remade(field) }), /another host already serves/)
    assert.deepEqual(identity(s.path), identityOf(stale), 'the file is kept')
  })
}

test('a bind that loses the race (EADDRINUSE) is refused like a live host', async (t) => {
  const s = scope(t)
  const stale = await s.staleSocket()
  // The re-check finds the path gone, as if another host had taken it: nothing is removed and
  // the bind meets the file still there.
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
  await assert.rejects(s.start({ lstat: gone }), { message: 'another host already serves this team to Pocket' })
  assert.deepEqual(identity(s.path), identityOf(stale), 'the file is kept')
})

test('a stop and a start at once: the stop finishes first and the new host keeps its socket', async (t) => {
  const s = scope(t)
  const old = await s.start()
  const [, fresh] = await within(Promise.all([old.close(), s.start()]))
  assert.equal((await s.hello()).readOnly, true)
  await old.close()
  assert.equal((await s.hello()).readOnly, true, 'closing the old host again removes nothing')
  await fresh.close()
  assert.equal(existsSync(fresh.path), false)
})

// ---- install

// The registry home's bots.json under the temp home, never the person's ~/.automagik.
const rtFor = (ctx, home) => ({ ...team(), ctx, home, registryPath: join(home, 'registry', 'bots.json'), warn() {} })

test('without DSH 0.2.2\'s Session API, install registers nothing and opens no socket', async (t) => {
  const s = scope(t)
  for (const services of [{}, { sessionController: { follow() {} } }]) {
    const ctx = fakeContext({ services })
    install(rtFor(ctx, s.home))
    assert.deepEqual(ctx.calls, [])
  }
  assert.throws(() => lstatSync(s.path), { code: 'ENOENT' })
})

test('with the Session API, install loads the adapter lazily and serves the socket until disposed', async (t) => {
  const s = scope(t)
  const ctx = fakeContext({ services: { sessionController: fakeController(sessions()) } })
  // Disposed after the test whatever happens (a second dispose is a no-op), before the home goes.
  s.defer(() => ctx.dispose())
  install(rtFor(ctx, s.home))
  // The answerer listeners (writes) and the effect: no tool, route, service or command.
  assert.deepEqual(ctx.calls, ['on approval/request (prepend)', 'on user-questions/request (prepend)', 'effect ds-bot: pocket chat'])
  let found = null
  for (let i = 0; i < 200 && !found; i++) {
    try { found = lstatSync(s.path) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  assert.ok(found?.isSocket(), 'the socket appears')
  const c = s.client()
  assert.deepEqual((await c.ask('list')).result.terminals.map(row => row.terminal), ['dsh:omni', 'dsh:ada'])
  c.socket.destroy()
  await within(ctx.dispose())
  assert.throws(() => lstatSync(s.path), { code: 'ENOENT' })
})

// ---- writes on DSH chats (RFC 0015, Amendments, 2026-11-07)

const OWNERS = { 's-omni-2': 'omni', ada: 'ada' }
/** A source that takes writes: what install wires when DSH has prompt and cancel. */
const writableOf = (controller, rt = team(), options = {}) => new DshChatSource({
  adapter: createAdapter(controller), bots: ownBots(rt), timers, writable: true, chatOwner: sessionId => OWNERS[sessionId], ...options,
})
const agentOf = sessionId => ({ id: `agent-${sessionId}`, session: { id: sessionId } })

/**
 * The chain below this plugin's listener: the computer's dialog. Like DSH's gateway it reads the
 * request's signal when the request reaches it, holds the request until the computer answers,
 * and withdraws its dialog (DSH's `cancel`) when that signal aborts.
 */
function computer() {
  const dialogs = []
  const next = request => () => new Promise((resolve, reject) => {
    const dialog = { request, answer: resolve, withdrawn: false }
    dialogs.push(dialog)
    const signal = request.signal
    const withdraw = () => { dialog.withdrawn = true; reject(new Error('cancelled')) }
    if (signal?.aborted) withdraw()
    else signal?.addEventListener('abort', withdraw, { once: true })
  })
  return { dialogs, next }
}

function askApproval(source, pc, { sessionId = 's-omni-2', callId = 'c1', toolName = 'bash', signal } = {}) {
  const request = { agent: agentOf(sessionId), toolName, callId, reason: `run ${toolName}`, ...(signal ? { signal } : {}) }
  return { request, outcome: source.raceApproval(request, pc.next(request)) }
}

function askQuestion(source, pc, question, { sessionId = 's-omni-2', callId = 'q1' } = {}) {
  const request = { agent: agentOf(sessionId), questions: [question], wait: { callId } }
  return { request, answer: source.raceQuestion(request, pc.next(request)) }
}

async function watching(source, terminal = 'dsh:omni') {
  const w = watcher()
  const handle = await source.watch(terminal, w.listener)
  assert.equal(handle.ok, true)
  return { ...w, handle }
}

const openRow = (w, kind) => w.events.filter(e => e.type === kind && e.row.open !== false).at(-1)?.row

test('writes: never callable by terminal name, as a DSH tool or by an automation; install registers no tool, route or service', async (t) => {
  const controller = fakeController(sessions())
  assert.equal(hasWriteApi(controller), true)
  const source = writableOf(controller)
  for (const [name, args] of [['send', ['dsh:omni', { text: 'x', id: 'm1' }]], ['answer', ['dsh:omni', { row: 'r', choice: 'allow' }]], ['interrupt', ['dsh:omni']]]) {
    assert.equal(source[name](...args).reason, 'read-only', name)
  }
  assert.deepEqual(controller.calls, [])
  // Only a watch handle (a subscribed channel) carries the writes.
  const w = await watching(source)
  assert.equal(typeof w.handle.send, 'function')
  w.handle.close()
  const s = scope(t)
  const ctx = fakeContext({ services: { sessionController: fakeController(sessions()) } })
  s.defer(() => ctx.dispose())
  const rt = rtFor(ctx, s.home)
  install(rt)
  assert.ok(!ctx.calls.some(call => /^(tool|route|provide|prompt|command) /.test(call)), ctx.calls.join(', '))
  assert.equal(ctx.registeredTools.size, 0)
  assert.ok(!Object.keys(rt).some(key => /send|interrupt|answer/i.test(key)))
})

test('writes: a read-only source (no prompt or cancel) gives handles no writes', async () => {
  const { prompt, cancel, ...reads } = fakeController(sessions())
  assert.equal(hasWriteApi(reads), false)
  const source = new DshChatSource({ adapter: createAdapter(reads), bots: ownBots(team()), timers, writable: true })
  assert.equal(source.writable, false)
  const handle = await source.watch('dsh:omni', () => {})
  assert.equal(handle.send, undefined)
  handle.close()
})

test('writes: send prompts the Bot\'s current chat Session, queued, with a pocket- request id; sent idle, queued while a turn runs', async () => {
  const all = sessions()
  const controller = fakeController(all)
  const w = await watching(writableOf(controller))
  assert.deepEqual(await w.handle.send({ text: 'hello\r\nthere', id: 'p1' }), { ok: true, state: 'sent', id: 'p1' })
  assert.deepEqual(controller.prompts[0], { requestId: 'pocket-p1', sessionId: 's-omni-2', mode: 'queue', content: [{ type: 'text', text: 'hello\nthere' }] })
  all['s-omni-2'].running = true
  assert.deepEqual(await w.handle.send({ text: 'next', id: 'pocket-p2' }), { ok: true, state: 'queued', id: 'pocket-p2' })
  assert.equal(controller.prompts[1].requestId, 'pocket-p2')
  assert.ok(controller.prompts.every(prompt => prompt.mode === 'queue'))
  w.handle.close()
})

test('writes: a pasted sign-in code is refused before DSH\'s prompt, so the Session never records it', async () => {
  const controller = fakeController(sessions())
  const logged = []
  const w = await watching(writableOf(controller, team(), { carriesSignInCode: text => text.includes('#shown-state'), log: (...args) => logged.push(args.join(' ')) }))
  assert.deepEqual(await w.handle.send({ text: 'code-1234#shown-state', id: 'c1' }), { ok: false, state: 'refused', reason: 'invalid', id: 'c1', message: 'sign-in-code' })
  assert.equal(controller.prompts.length, 0, 'nothing reaches the controller')
  assert.ok(logged.every(line => !line.includes('shown-state')), 'the log names the kind only')
  // A guard that fails lets the send through (acp-dsh's own check stays the authority).
  const broken = await watching(writableOf(controller, team(), { carriesSignInCode: () => { throw new Error('down') } }))
  assert.equal((await broken.handle.send({ text: 'plain text', id: 'c2' })).ok, true)
  w.handle.close()
  broken.handle.close()
})

test('writes: send cleans the text; empty after cleaning is refused empty, over 32 KiB too-long, a bad id invalid', async () => {
  const controller = fakeController(sessions())
  const w = await watching(writableOf(controller))
  assert.equal((await w.handle.send({ text: '\u001b[31m \u0007', id: 'e1' })).reason, 'empty')
  assert.equal((await w.handle.send({ text: 'é'.repeat(SEND_TEXT_MAX / 2 + 1), id: 'e2' })).reason, 'too-long')
  assert.equal((await w.handle.send({ text: 'ok', id: 'bad id!' })).reason, 'invalid')
  assert.equal((await w.handle.send({ text: 'a\u001b[200~b\u0000c', id: 'e3' })).state, 'sent')
  assert.equal(controller.prompts.length, 1)
  assert.equal(controller.prompts[0].content[0].text, 'abc')
  w.handle.close()
})

test('writes: a Retry with a known id prompts nothing (64 ids kept per Session, and the ids the Session log holds)', async () => {
  const all = sessions()
  all['s-omni-2'].records.push(userAt(7, 'from before a restart', { kind: 'user', rpcId: 'pocket-old' }))
  const retry = userAt(8, '', { kind: 'retry', rpcId: 'pocket-retry-before' })
  all['s-omni-2'].records.push(retry)
  assert.deepEqual(rowsOf(retry.event, { sessionId: 's-omni-2', turn: 1 }), [], 'empty continuation control has no Pocket chat bubble')
  const controller = fakeController(all)
  const w = await watching(writableOf(controller))
  assert.deepEqual(await w.handle.send({ text: 'again', id: 'old' }), { ok: true, state: 'sent', id: 'old', repeat: true })
  assert.deepEqual(await w.handle.send({ text: 'again', id: 'retry-before' }), { ok: true, state: 'sent', id: 'retry-before', repeat: true })
  assert.equal(controller.prompts.length, 0)
  await w.handle.send({ text: 'once', id: 'r1' })
  assert.equal((await w.handle.send({ text: 'once', id: 'r1' })).repeat, true)
  assert.equal(controller.prompts.length, 1)
  for (let i = 0; i < KEEP_SENT_IDS; i++) await w.handle.send({ text: `n${i}`, id: `n${i}` })
  // r1 is past the 64 kept; DSH's own request-id check is what stops that one now.
  assert.equal((await w.handle.send({ text: 'once', id: 'r1' })).repeat, undefined)
  w.handle.close()
})

test('writes: interrupt cancels a running turn; with none running it answers sent and calls nothing', async () => {
  const all = sessions()
  const controller = fakeController(all)
  const w = await watching(writableOf(controller))
  assert.deepEqual(await w.handle.interrupt(), { ok: true, state: 'sent' })
  assert.ok(!controller.calls.includes('cancel'))
  all['s-omni-2'].running = true
  assert.deepEqual(await w.handle.interrupt(), { ok: true, state: 'sent' })
  assert.deepEqual(controller.cancels, [{ sessionId: 's-omni-2' }])
  w.handle.close()
})

test('writes: a project Bot without its yes is listed shown:false; subscribe and every write get not-shown; global Bots need no yes', async () => {
  const rt = team()
  rt.state.bots.ada.project = '/repo/a'
  let yes = false
  const source = writableOf(fakeController(sessions()), rt, { shown: bot => bot.project == null || yes })
  const listed = await source.list()
  assert.deepEqual(listed.map(row => [row.terminal, row.shown]), [['dsh:omni', true], ['dsh:ada', false]])
  assert.deepEqual(await source.watch('dsh:ada', () => {}), { ok: false, reason: 'not-shown' })
  yes = true
  const w = await watching(source, 'dsh:ada')
  yes = false
  assert.equal((await w.handle.send({ text: 'x', id: 'a1' })).reason, 'not-shown')
  assert.equal((await w.handle.interrupt()).reason, 'not-shown')
  assert.equal((await w.handle.answer({ row: rowIdOf('ada', 0, 'approval-c1'), choice: 'allow' })).reason, 'not-shown')
  w.handle.close()
})

const PIXEL = 'key-pixel-1'
const OTHER_PHONE = 'key-other-2'

/** A socket host with a writable source and a clock the test moves. */
async function writeHost(s, controller = fakeController(sessions()), rt = team()) {
  const clock = { at: 1_000_000 }
  const source = writableOf(controller, rt)
  const server = await s.start({ source, now: () => clock.at })
  const c = s.client(server.path)
  const hello = (await c.ask('hello', { write: 1 })).result
  return { controller, source, server, c, clock, hello }
}

test('writes: hello {write:1} gets readOnly:false with the write methods; a hello without it gets today\'s answer and no writes', async (t) => {
  const s = scope(t)
  const { server, hello } = await writeHost(s)
  assert.deepEqual(hello, { protocol: 1, readOnly: false, write: 1, methods: ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill', 'send', 'interrupt', 'answer'], dedupe: 'log' })
  const old = s.client(server.path)
  assert.deepEqual((await old.ask('hello')).result, { protocol: 1, readOnly: true, methods: ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill'] })
  await old.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  for (const method of ['send', 'interrupt', 'answer', 'sendHeld', 'cancelHeld']) {
    assert.equal((await old.ask(method, { channel: 1, text: 'x', id: 'o1', row: 'r', choice: 'allow' })).error.kind, 'read-only', method)
  }
  // A read-only source answers a write hello as read only too.
  const s2 = scope(t)
  const ro = await s2.start({ source: sourceOf(fakeController(sessions())) })
  const c2 = s2.client(ro.path)
  assert.equal((await c2.ask('hello', { write: 1 })).result.readOnly, true)
})

test('writes: a write from an unwatched chat (no subscription on this connection) is refused not-watching and reaches no controller method', async (t) => {
  const s = scope(t)
  const { controller, server, c } = await writeHost(s)
  assert.deepEqual((await c.ask('send', { channel: 9, phone: PIXEL, text: 'x', id: 'u1' })).result, { ok: false, state: 'refused', reason: 'not-watching', id: 'u1' })
  assert.equal((await c.ask('interrupt', { channel: 9, phone: PIXEL })).result.reason, 'not-watching')
  assert.equal((await c.ask('answer', { channel: 9, phone: PIXEL, row: 'r', choice: 'allow' })).result.reason, 'not-watching')
  // Another connection's channel is not this one's.
  const other = s.client(server.path)
  await other.ask('hello', { write: 1 })
  await other.ask('subscribe', { terminal: 'dsh:omni', channel: 4 })
  assert.equal((await c.ask('send', { channel: 4, phone: PIXEL, text: 'x', id: 'u2' })).result.reason, 'not-watching')
  assert.ok(!controller.calls.includes('prompt') && !controller.calls.includes('cancel'))
})

test('writes: the Main Bot (a global Bot) takes writes under the same limits, with no project yes', async (t) => {
  const s = scope(t)
  const rt = team()
  rt.state.bots.omni.main = true
  const { controller, c } = await writeHost(s, fakeController(sessions()), rt)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'hi main', id: 'g1', by: 'Pixel' })).result.state, 'sent')
  assert.equal(controller.prompts[0].sessionId, 's-omni-2')
  for (let i = 1; i < MAX_WRITES_PER_MINUTE; i++) await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: `g${i + 1}`, by: 'Pixel' })
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'g21', by: 'Pixel' })).result.reason, 'rate')
})

test('writes: the limits count per paired phone key: two connections of one phone share one cap of 20 a minute', async (t) => {
  const s = scope(t)
  const { server, c, clock } = await writeHost(s)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  await c.ask('subscribe', { terminal: 'dsh:ada', channel: 2 })
  const c2 = s.client(server.path)
  await c2.ask('hello', { write: 1 })
  await c2.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  for (let i = 0; i < MAX_WRITES_PER_MINUTE; i++) {
    const [via, channel] = i % 2 ? [c, 2] : [c2, 1]
    assert.equal((await via.ask('send', { channel, phone: PIXEL, text: 'x', id: `w${i}`, by: 'Pixel' })).result.state, 'sent', `write ${i + 1}`)
  }
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'w21', by: 'Pixel' })).result.reason, 'rate')
  assert.equal((await c2.ask('interrupt', { channel: 1, phone: PIXEL })).result.reason, 'rate', 'interrupts count in the 20')
  clock.at += 60_000
  assert.equal((await c2.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'w22', by: 'Pixel' })).result.state, 'sent')
})

test('writes: two phones have independent caps, 20 a minute and one interrupt per chat every 5 s each', async (t) => {
  const s = scope(t)
  const { c, clock } = await writeHost(s)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  await c.ask('subscribe', { terminal: 'dsh:ada', channel: 2 })
  assert.equal((await c.ask('interrupt', { channel: 1, phone: PIXEL })).result.state, 'sent')
  assert.equal((await c.ask('interrupt', { channel: 1, phone: OTHER_PHONE })).result.state, 'sent', 'the other phone has its own 5 s')
  clock.at += INTERRUPT_EVERY_MS - 1
  assert.equal((await c.ask('interrupt', { channel: 1, phone: PIXEL })).result.reason, 'rate')
  assert.equal((await c.ask('interrupt', { channel: 1, phone: OTHER_PHONE })).result.reason, 'rate')
  assert.equal((await c.ask('interrupt', { channel: 2, phone: PIXEL })).result.state, 'sent', 'another chat has its own 5 s')
  clock.at += 1
  assert.equal((await c.ask('interrupt', { channel: 1, phone: PIXEL })).result.state, 'sent')
  // A refused write counts nothing: Pixel has 3 so far, the other phone 1.
  for (let i = 3; i < MAX_WRITES_PER_MINUTE; i++) assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: `p${i}` })).result.state, 'sent')
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'p20' })).result.reason, 'rate')
  for (let i = 1; i < MAX_WRITES_PER_MINUTE; i++) assert.equal((await c.ask('send', { channel: 2, phone: OTHER_PHONE, text: 'x', id: `o${i}` })).result.state, 'sent', `other ${i + 1}`)
  assert.equal((await c.ask('send', { channel: 2, phone: OTHER_PHONE, text: 'x', id: 'o20' })).result.reason, 'rate')
})

test('writes: a rename or a spoofed by changes no count: by is for receipts only', async (t) => {
  const s = scope(t)
  const { c } = await writeHost(s)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  // One phone under many names: one bucket.
  for (let i = 0; i < MAX_WRITES_PER_MINUTE; i++) {
    assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: `n${i}`, by: `Pixel ${i}` })).result.state, 'sent')
  }
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'n20', by: 'Renamed' })).result.reason, 'rate')
  // A by that names the other phone neither escapes this cap nor spends the other one's.
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'n21', by: 'Other' })).result.reason, 'rate')
  assert.equal((await c.ask('send', { channel: 1, phone: OTHER_PHONE, text: 'x', id: 'o1', by: 'Pixel' })).result.state, 'sent')
  // The name still reaches the receipt.
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const { outcome } = askApproval(source, pc)
  await settle()
  await w.handle.answer({ row: openRow(w, 'approval').id, choice: 'allow', by: 'Renamed' })
  await outcome
  assert.equal(w.events.filter(e => e.type === 'approval').at(-1).row.receipt.name, 'Renamed')
  w.handle.close()
})

test('writes: a write without a paired phone key is refused read-only, never counted per connection', async (t) => {
  const s = scope(t)
  const { controller, c } = await writeHost(s)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  for (const phone of [undefined, '', 7, 'has space', 'x'.repeat(257)]) {
    for (const [method, params] of [['send', { text: 'x', id: 'a1', by: 'Pixel' }], ['interrupt', { by: 'Pixel' }], ['answer', { row: 'r', choice: 'allow' }]]) {
      const answer = (await c.ask(method, { channel: 1, ...params, ...(phone === undefined ? {} : { phone }) })).result
      assert.equal(answer.reason, 'read-only', `${method} ${String(phone).slice(0, 20)}`)
    }
  }
  assert.ok(!controller.calls.includes('prompt') && !controller.calls.includes('cancel'))
  // None of those counted: a keyed phone still has its whole 20.
  for (let i = 0; i < MAX_WRITES_PER_MINUTE; i++) assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: `k${i}` })).result.state, 'sent')
})

test('writes: one write in flight per phone and chat; a second gets busy', async (t) => {
  const s = scope(t)
  const controller = fakeController(sessions())
  let release
  controller.promptGate = () => new Promise(resolve => { release = resolve })
  const { c } = await writeHost(s, controller)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  const first = c.ask('send', { channel: 1, phone: PIXEL, text: 'slow', id: 'b1', by: 'Pixel' })
  for (let i = 0; i < 50 && !release; i++) await settle()
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'b2', by: 'Pixel' })).result.reason, 'busy')
  controller.promptGate = null
  release()
  assert.equal((await first).result.state, 'sent')
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'x', id: 'b3', by: 'Pixel' })).result.state, 'sent')
})

test('writes: a removed phone\'s writes end within 2 s: unsubscribe aborts the write in flight and refuses the next at once', async (t) => {
  const s = scope(t)
  const controller = fakeController(sessions())
  let aborted = null
  controller.promptGate = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = Date.now(); reject(signal.reason) }, { once: true })
  })
  const { c } = await writeHost(s, controller)
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  const pending = c.ask('send', { channel: 1, phone: PIXEL, text: 'held', id: 'x1' })
  for (let i = 0; i < 50 && !controller.calls.includes('prompt'); i++) await settle()
  const removed = Date.now()
  await c.ask('unsubscribe', { channel: 1 })
  assert.equal((await pending).result.reason, 'not-watching')
  assert.ok(aborted !== null && aborted - removed < 2000)
  assert.equal((await c.ask('send', { channel: 1, phone: PIXEL, text: 'later', id: 'x2' })).result.reason, 'not-watching')
  assert.equal(controller.prompts.length, 0)
})

test('approvals: the phone answers first: the tool gets allowed-once, the computer\'s dialog is withdrawn, the receipt names the phone', async () => {
  const source = writableOf(fakeController(sessions()), team(), { now: () => 42 })
  const w = await watching(source)
  const pc = computer()
  const turn = new AbortController()
  const { request, outcome } = askApproval(source, pc, { signal: turn.signal })
  await settle()
  assert.equal(pc.dialogs.length, 1, 'passed on at once: the computer has it too')
  const row = openRow(w, 'approval')
  assert.equal(row.answerable, true)
  assert.deepEqual(row.choices, ['allow', 'deny'])
  assert.equal(row.tool, 'bash')
  assert.equal(row.input, '{"cmd":"ls"}')
  assert.deepEqual(await w.handle.answer({ row: row.id, choice: 'allow', by: 'Pixel' }), { ok: true, state: 'sent' })
  assert.equal(await outcome, 'allowed-once')
  await settle()
  assert.equal(pc.dialogs[0].withdrawn, true)
  assert.equal(request.signal, turn.signal, 'the request\'s own signal is back')
  assert.equal(turn.signal.aborted, false, 'the turn goes on')
  const closed = w.events.filter(e => e.type === 'approval').at(-1).row
  assert.equal(closed.open, false)
  assert.deepEqual(closed.receipt, { id: row.id, by: 'phone', name: 'Pixel', outcome: 'allow', at: 42 })
  // A second answer is refused settled, with the same receipt.
  assert.deepEqual(await w.handle.answer({ row: row.id, choice: 'deny' }), { ok: false, state: 'refused', reason: 'settled', receipt: closed.receipt })
  w.handle.close()
})

test('approvals: answered on the computer first: the phone\'s card closes with its receipt, a phone answer that comes second gets settled', async () => {
  const source = writableOf(fakeController(sessions()), team(), { now: () => 7 })
  const w = await watching(source)
  const pc = computer()
  const { outcome } = askApproval(source, pc)
  await settle()
  const row = openRow(w, 'approval')
  pc.dialogs[0].answer('rejected')
  assert.equal(await outcome, 'rejected')
  const closed = w.events.filter(e => e.type === 'approval').at(-1).row
  assert.deepEqual(closed.receipt, { id: row.id, by: 'computer', outcome: 'deny', at: 7 })
  const late = await w.handle.answer({ row: row.id, choice: 'allow' })
  assert.equal(late.reason, 'settled')
  assert.deepEqual(late.receipt, closed.receipt)
  w.handle.close()
})

test('approvals: one-call answers only: allow for session or any other choice is invalid, text on an approval is text-on-approval', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const { outcome } = askApproval(source, pc)
  await settle()
  const row = openRow(w, 'approval')
  assert.ok(!row.choices.some(choice => /session|always/.test(choice)))
  for (const choice of ['allow-session', 'allow-always', 'allowed-once', 'yes']) {
    assert.equal((await w.handle.answer({ row: row.id, choice })).reason, 'invalid', choice)
  }
  assert.equal((await w.handle.answer({ row: row.id, choice: 'allow', text: 'sure' })).reason, 'text-on-approval')
  assert.equal(openRow(w, 'approval').id, row.id, 'still open')
  assert.equal((await w.handle.answer({ row: row.id, choice: 'deny' })).ok, true)
  assert.equal(await outcome, 'rejected')
  w.handle.close()
})

test('approvals: an answer is bound to the request open at answer time: replaced gets changed, another Session\'s row not-watching', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const first = new AbortController()
  const one = askApproval(source, pc, { callId: 'c1', signal: first.signal })
  await settle()
  const old = openRow(w, 'approval')
  // DSH withdraws it (the turn was interrupted) and asks again: the old row is no longer the open one.
  first.abort()
  await one.outcome.catch(() => {})
  assert.equal(w.events.filter(e => e.type === 'approval').at(-1).row.receipt.outcome, 'withdrawn')
  const two = askApproval(source, pc, { callId: 'c2' })
  await settle()
  const now = openRow(w, 'approval')
  assert.notEqual(now.id, old.id)
  assert.equal((await w.handle.answer({ row: old.id, choice: 'allow' })).reason, 'changed')
  assert.equal((await w.handle.answer({ row: rowIdOf('ada', 0, 'approval-c9'), choice: 'allow' })).reason, 'not-watching')
  assert.equal((await w.handle.answer({ row: now.id, choice: 'allow' })).ok, true)
  assert.equal(await two.outcome, 'allowed-once')
  w.handle.close()
})

test('approvals: the listeners pass every request on at once and never answer on their own; lookups and other Sessions skip the phone', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  // A group or task Session (not a Bot's own chat) and the team's own lookups go straight on.
  const group = { agent: agentOf('s-group-omni'), toolName: 'bash', callId: 'g1' }
  void source.raceApproval(group, pc.next(group))
  const lookup = { agent: agentOf('s-omni-2'), toolName: 'mcp__dsh__list_bots', callId: 'l1' }
  void source.raceApproval(lookup, pc.next(lookup))
  assert.equal(pc.dialogs.length, 2, 'passed on synchronously')
  assert.equal(w.events.filter(e => e.type === 'approval').length, 0)
  // An own-chat request waits for someone; nothing answers it by itself.
  const { outcome } = askApproval(source, pc)
  let done = false
  void outcome.then(() => { done = true })
  for (let i = 0; i < 20; i++) await settle()
  assert.equal(done, false)
  pc.dialogs[2].answer('allowed-once')
  assert.equal(await outcome, 'allowed-once')
  w.handle.close()
})

test('approvals: a new channel\'s snapshot re-sends the open rows and the settled receipts, 16 kept per Session', async () => {
  const source = writableOf(fakeController(sessions()))
  const keepOpen = await watching(source)
  const pc = computer()
  for (let i = 0; i < KEEP_SETTLED + 2; i++) {
    const { outcome } = askApproval(source, pc, { callId: `s${i}` })
    await settle()
    pc.dialogs.at(-1).answer('allowed-once')
    await outcome
  }
  const { outcome } = askApproval(source, pc, { callId: 'open1' })
  await settle()
  const late = await watching(source)
  const snapshot = late.last('snapshot')
  assert.equal(snapshot.approval.call, 'open1')
  assert.equal(snapshot.approval.answerable, true)
  assert.equal(snapshot.settled.length, KEEP_SETTLED)
  assert.ok(snapshot.settled.every(item => item.by === 'computer' && item.outcome === 'allow'))
  assert.ok(!snapshot.settled.some(item => item.id.includes('approval-s0')), 'the oldest are dropped')
  assert.equal((await late.handle.answer({ row: snapshot.approval.id, choice: 'deny' })).ok, true)
  assert.equal(await outcome, 'rejected')
  keepOpen.handle.close()
  late.handle.close()
})

test('Pocket keeps the full Hermes grant on open, reconnect and close; incomplete grants stay on the computer', async () => {
  const source = writableOf(fakeController(sessions()))
  const phone = await watching(source)
  const pc = computer()
  const allow = 'Allow until sandbox is off'
  const title = 'Allow Remote Hermes to read this folder until its sandbox is turned off?'
  const target = '/work/Relatórios  2026\nRetain {name}'
  const boundary = 'x'.repeat(PREVIEW_MAX - Buffer.byteLength(title + '\n'))
  for (const [index, [detail, fits]] of [[target, true], [boundary, true], [boundary.slice(1) + 'é', false], ['', false]].entries()) {
    const question = { id: 'scope', question: title, detail, intent: { kind: 'approval', approve: allow, reject: 'Deny' }, options: [{ label: allow }, { label: 'Deny' }] }
    const { answer } = askQuestion(source, pc, question, { callId: 'grant-' + index })
    await settle()
    const row = openRow(phone, 'question')
    const expected = fits ? title + '\n' + detail : ANSWER_ON_COMPUTER
    assert.equal(row.prompt, expected)
    assert.equal(row.answerable, fits)
    assert.deepEqual(row.options, fits ? [allow, 'Deny'] : [])
    const reconnected = await watching(source)
    assert.deepEqual(openRow(reconnected, 'question'), row)
    assert.equal((await reconnected.handle.answer({ row: row.id, choice: 'other', text: allow })).reason, 'invalid')
    const choice = await reconnected.handle.answer({ row: row.id, choice: '1' })
    if (fits) {
      assert.equal(choice.ok, true)
      assert.deepEqual(await answer, { answers: [{ id: 'scope', selected: [allow] }] })
    } else {
      assert.equal(choice.reason, 'invalid')
      const dialog = pc.dialogs.at(-1)
      assert.equal(dialog.withdrawn, false)
      assert.equal(dialog.request.questions[0].detail, detail)
      dialog.answer({ answers: [{ id: 'scope', selected: ['Deny'] }] })
      assert.deepEqual(await answer, { answers: [{ id: 'scope', selected: ['Deny'] }] })
    }
    assert.equal(phone.last('question').row.prompt, expected)
    assert.equal(phone.last('question').row.receipt.by, fits ? 'phone' : 'computer')
    reconnected.handle.close()
  }
  phone.handle.close()
})

test('questions: a single-select "other" text reaches DSH byte-for-byte as that question\'s answer; a Retry with the same text gets settled', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const { answer } = askQuestion(source, pc, { id: 'which', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] })
  await settle()
  const row = openRow(w, 'question')
  assert.deepEqual([row.prompt, row.options, row.multi, row.answerable], ['Which one?', ['A', 'B'], false, true])
  const text = '  naïve — "C", tab\there  '
  assert.deepEqual(await w.handle.answer({ row: row.id, choice: 'other', text }), { ok: true, state: 'sent' })
  assert.deepEqual(await answer, { answers: [{ id: 'which', selected: [], custom: text }] })
  assert.equal(pc.dialogs[0].withdrawn, true)
  const retry = await w.handle.answer({ row: row.id, choice: 'other', text })
  assert.equal(retry.reason, 'settled')
  assert.equal(retry.receipt.outcome, 'other')
  w.handle.close()
})

test('questions: text refusals: multi-select, another choice or other without text invalid; a line break or cleaner change invalid; blank empty; over 32 KiB too-long', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const single = askQuestion(source, pc, { id: 'q', question: 'Pick', options: [{ label: 'A' }] }, { callId: 'q1' })
  await settle()
  const row = openRow(w, 'question')
  const cases = [
    [{ choice: '1', text: 'x' }, 'invalid'],
    [{ choice: 'other' }, 'invalid'],
    [{ choice: 'other', text: 'two\nlines' }, 'invalid'],
    [{ choice: 'other', text: 'cr\ronly' }, 'invalid'],
    [{ choice: 'other', text: 'bell\u0007' }, 'invalid'],
    [{ choice: 'other', text: 'esc\u001b[31m' }, 'invalid'],
    [{ choice: 'other', text: '' }, 'empty'],
    [{ choice: 'other', text: '   \t ' }, 'empty'],
    [{ choice: 'other', text: 'x'.repeat(SEND_TEXT_MAX + 1) }, 'too-long'],
  ]
  for (const [message, reason] of cases) assert.equal((await w.handle.answer({ row: row.id, ...message })).reason, reason, JSON.stringify(message).slice(0, 60))
  assert.equal(openRow(w, 'question').id, row.id, 'still open after every refusal')
  assert.equal((await w.handle.answer({ row: row.id, choice: 'other', text: 'x'.repeat(SEND_TEXT_MAX) })).ok, true, '32 KiB exactly is taken')
  await single.answer
  const multi = askQuestion(source, pc, { id: 'm', question: 'Pick some', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }, { callId: 'q2' })
  await settle()
  const many = openRow(w, 'question')
  assert.equal((await w.handle.answer({ row: many.id, choice: 'other', text: 'free' })).reason, 'invalid')
  assert.equal((await w.handle.answer({ row: many.id, choice: '1', text: 'free' })).reason, 'invalid')
  assert.equal((await w.handle.answer({ row: many.id, choice: '1,1' })).reason, 'invalid')
  assert.equal((await w.handle.answer({ row: many.id, choice: '3' })).reason, 'invalid')
  assert.equal((await w.handle.answer({ row: many.id, choice: '2,1' })).ok, true)
  assert.deepEqual(await multi.answer, { answers: [{ id: 'm', selected: ['B', 'A'] }] })
  w.handle.close()
})

test('questions: answered on the computer first closes the phone\'s card with the picked labels; a question DSH withdraws closes as withdrawn', async () => {
  const source = writableOf(fakeController(sessions()))
  const w = await watching(source)
  const pc = computer()
  const { answer } = askQuestion(source, pc, { id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] })
  await settle()
  const row = openRow(w, 'question')
  pc.dialogs[0].answer({ answers: [{ id: 'q', selected: ['B'], custom: 'not shown on the receipt' }] })
  await answer
  const closed = w.events.filter(e => e.type === 'question').at(-1).row
  assert.equal(closed.receipt.by, 'computer')
  assert.equal(closed.receipt.outcome, 'B')
  assert.ok(!JSON.stringify(closed.receipt).includes('not shown'))
  assert.equal((await w.handle.answer({ row: row.id, choice: '1' })).reason, 'settled')
  w.handle.close()
})

// ---- list: a Bot no phone watches is read from DSH, so its question reaches Home (#752)

test('list: an unwatched Bot waiting on a question is blocked with its kind and the question in msg, on a writable bridge', async () => {
  const data = sessions()
  const controller = fakeController(data)
  const source = writableOf(controller)
  const pc = computer()
  const { answer } = askQuestion(source, pc, { id: 'which', question: 'Which branch?', options: [{ label: 'main' }] })
  await settle()
  data['s-omni-2'].pending = ['question']
  const listed = await source.list()
  // The row keeps the shape Pocket knows; the open request's text is its line, with the question's kind.
  assert.deepEqual(listed.find(row => row.terminal === 'dsh:omni'), {
    terminal: 'dsh:omni', machine: null, agent: 'dsh', title: 'Omni',
    status: { state: 'blocked', kind: 'question', msg: 'Which branch?', turn: 0 },
    chat: 'session', shown: true, registryId: null,
  })
  // Listing is not watching: no entry was made, and the other Bot is listed beside it.
  assert.equal(source.entries.size, 0)
  assert.deepEqual(listed.map(row => row.terminal), ['dsh:omni', 'dsh:ada'])
  // Answered on the computer: the request is gone, and the next listing is idle with no text.
  pc.dialogs[0].answer({ answers: [{ id: 'which', selected: ['main'] }] })
  await answer
  data['s-omni-2'].pending = []
  assert.deepEqual((await source.list()).find(row => row.terminal === 'dsh:omni').status, statusOf(null))
  // An approval's summary is the line, with the permission kind.
  const { outcome } = askApproval(source, pc, { callId: 'c9', toolName: 'bash' })
  await settle()
  data['s-omni-2'].pending = ['approval']
  assert.deepEqual((await source.list()).find(row => row.terminal === 'dsh:omni').status, { state: 'blocked', kind: 'permission', msg: 'run bash', turn: 0 })
  pc.dialogs[1].answer('allowed-once')
  await outcome
})

test('list: on a read-only bridge the unwatched chat is blocked and says Answer on the computer', async () => {
  const data = sessions()
  data['s-omni-2'].pending = ['question']
  const row = (await sourceOf(fakeController(data)).list()).find(item => item.terminal === 'dsh:omni')
  assert.equal(row.status.state, 'blocked')
  assert.equal(row.status.kind, 'question')
  assert.equal(row.status.msg, ANSWER_ON_COMPUTER)
})

test('list: a watched Bot keeps its entry and is not read again; an unwatched one is', async () => {
  const data = sessions()
  const controller = fakeController(data)
  const source = writableOf(controller)
  const w = await watching(source)
  controller.observe('s-omni-2', { cursor: 8, active: true, running: true, queue: [], pendingInput: [] })
  await settle()
  // DSH now waits on a question, but the listing serves the watch's word and asks the controller nothing.
  data['s-omni-2'].pending = ['question']
  controller.calls.length = 0
  const listed = await source.list()
  assert.equal(listed.find(row => row.terminal === 'dsh:omni').status.state, 'working')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('state ')), ['state ada'])
  w.handle.close()
})

test('list: a state read that fails or is too slow still lists every Bot (idle fallback) and is logged', async () => {
  // Failing: Omni's read throws, Ada's answers working, so the listing is whole and the other row is live.
  const data = sessions()
  data.ada.running = true
  const failing = fakeController(data)
  const state = failing.state
  failing.state = async (params) => {
    failing.calls.push(`state ${params.sessionId}`)
    if (params.sessionId === 's-omni-2') throw new Error('the Session is unreachable')
    return state(params)
  }
  const logs = []
  const listed = await new DshChatSource({ adapter: createAdapter(failing), bots: ownBots(team()), timers, log: (...args) => logs.push(args) }).list()
  assert.deepEqual(listed.map(row => [row.terminal, row.status.state]), [['dsh:omni', 'idle'], ['dsh:ada', 'working']])
  assert.deepEqual(logs, [['pocket chat: could not read %s for the listing: %s', 'omni', 'the Session is unreachable']])
  // Timing out: a state that never answers keeps that row idle; list itself never waits past listMs.
  const slow = fakeController(sessions())
  slow.state = ({ sessionId }) => {
    slow.calls.push(`state ${sessionId}`)
    return sessionId === 's-omni-2' ? new Promise(() => {}) : Promise.resolve({ cursor: -1, active: true, running: true, queue: [], pendingInput: [] })
  }
  const quickly = await within(new DshChatSource({ adapter: createAdapter(slow), bots: ownBots(team()), timers, listMs: 20 }).list(), 1000)
  assert.deepEqual(quickly.map(row => [row.terminal, row.status.state]), [['dsh:omni', 'idle'], ['dsh:ada', 'working']])
})

// ---- shown[]: the person's picks in the home file (shown.js)

const REG = 'b-abcdefghij'
/** A team with one registry Bot (REG, on Ada's Session) beside the state-only Bots. */
function registryTeam() {
  const rt = team()
  rt.state.bots[REG] = { id: REG, name: 'Reg', sessionId: 'ada' }
  delete rt.state.bots.ada
  return rt
}
const homeFile = (dir, { bots = [{ id: REG, name: 'Reg', folder: '/repo/a' }], shown = [] } = {}) => {
  const path = join(dir, 'bots.json')
  writeFileSync(path, JSON.stringify({ version: 2, bots, projects: [], shown }))
  return path
}
const pickedSource = (rt, reader) => writableOf(fakeController(sessions()), rt, {
  bots: ownBots(rt, reader), shown: reader.shown, chatOwner: sessionId => (sessionId === 'ada' ? REG : OWNERS[sessionId]),
})

test('shown: a project Bot without its entry is shown:false and not-shown on subscribe and every write; a global Bot needs none', async (t) => {
  const dir = tempHome()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = homeFile(dir)
  const rt = registryTeam()
  const source = pickedSource(rt, shownReader({ path }))
  assert.deepEqual((await source.list()).map(row => [row.terminal, row.shown]), [['dsh:omni', true], [`dsh:${REG}`, false]])
  assert.deepEqual(await source.watch(`dsh:${REG}`, () => {}), { ok: false, reason: 'not-shown' })
  // The global Bot (no home-file entry) is watched with no shown[] at all.
  const global = await watching(source, 'dsh:omni')
  global.handle.close()
  homeFile(dir, { shown: [{ project: '/repo/a', bots: [REG] }] })
  const w = await watching(source, `dsh:${REG}`)
  // The yes taken back: every write on the open chat is refused.
  homeFile(dir)
  assert.equal((await w.handle.send({ text: 'x', id: 'r1' })).reason, 'not-shown')
  assert.equal((await w.handle.interrupt()).reason, 'not-shown')
  assert.equal((await w.handle.answer({ row: rowIdOf('ada', 0, 'approval-c1'), choice: 'allow' })).reason, 'not-shown')
  w.handle.close()
})

test('shown: the home file\'s folder and machine set a Bot\'s project; a Bot it does not list stays global', async (t) => {
  const dir = tempHome()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const rt = registryTeam()
  const path = homeFile(dir, { bots: [{ id: REG, name: 'Reg', folder: '/repo/a', machine: 'box-1' }] })
  assert.deepEqual(await ownBots(rt, shownReader({ path }))(), [
    { id: 'omni', name: 'Omni', sessionId: 's-omni-2', project: null },
    { id: REG, name: 'Reg', sessionId: 'ada', project: '/repo/a', machine: 'box-1' },
  ])
  homeFile(dir, { bots: [{ id: REG, name: 'Reg' }] })
  assert.equal((await ownBots(rt, shownReader({ path }))()).find(bot => bot.id === REG).project, null, 'no folder: global')
})

test('shown: a home file that does not parse, with no good read before it, shows no registry Bot', async (t) => {
  const dir = tempHome()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'bots.json')
  writeFileSync(path, '{ not json')
  const warns = []
  const rt = registryTeam()
  const source = pickedSource(rt, shownReader({ path, warn: (...args) => warns.push(args) }))
  assert.deepEqual((await source.list()).map(row => [row.terminal, row.shown]), [['dsh:omni', true], [`dsh:${REG}`, false]])
  assert.deepEqual(await source.watch(`dsh:${REG}`, () => {}), { ok: false, reason: 'not-shown' })
  assert.equal(warns.length, 1, 'warned once, not on every read')
})

test('install reads shown[] from the registry path it is given', async (t) => {
  const s = scope(t)
  const ctx = fakeContext({ services: { sessionController: fakeController(sessions()) } })
  s.defer(() => ctx.dispose())
  const rt = { ...rtFor(ctx, s.home), ...registryTeam() }
  rt.registryPath = join(s.home, 'reg', 'bots.json')
  mkdirSync(join(s.home, 'reg'))
  writeFileSync(rt.registryPath, JSON.stringify({ version: 2, bots: [{ id: REG, name: 'Reg', folder: '/repo/a' }], shown: [{ project: '/repo/a', bots: [REG] }] }))
  install(rt)
  let found = null
  for (let i = 0; i < 200 && !found; i++) {
    try { found = lstatSync(s.path) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const c = s.client()
  assert.deepEqual((await c.ask('list')).result.terminals.map(row => [row.terminal, row.shown]), [['dsh:omni', true], [`dsh:${REG}`, true]])
  c.socket.destroy()
  await within(ctx.dispose())
})

// ---- the registry id on the listing (#672): each chat keeps dsh:<sessionId> and adds registryId

test('lists registryId beside the unchanged dsh:<sessionId>: an id or null, always present (#672)', async () => {
  const rt = team()
  rt.state.bots['unfold-root'] = { id: 'unfold-root', name: 'Main' }
  const source = new DshChatSource({
    adapter: createAdapter(fakeController(sessions())),
    bots: ownBots(rt),
    timers,
    registryIdOf: bot => (bot.name === 'Ada' ? REG : null),
  })
  const rows = await source.list()
  const byTerminal = new Map(rows.map(row => [row.terminal, row]))
  assert.deepEqual([...byTerminal.keys()], ['dsh:omni', 'dsh:ada', 'dsh:unfold-root'])
  // The registered Bot carries its registry id; the unregistered and host-pinned Bots carry null.
  assert.equal(byTerminal.get('dsh:ada').registryId, REG)
  assert.equal(byTerminal.get('dsh:omni').registryId, null)
  assert.equal(byTerminal.get('dsh:unfold-root').registryId, null)
  // The property is present on every row, even when null.
  for (const row of rows) assert.ok(Object.hasOwn(row, 'registryId'), `${row.terminal} must carry registryId`)
  // The Session id, the chat kind and the watch path are unchanged.
  assert.equal(byTerminal.get('dsh:ada').terminal, 'dsh:ada')
  assert.equal(byTerminal.get('dsh:ada').chat, 'session')
  assert.equal(byTerminal.get('dsh:omni').terminal, 'dsh:omni')
  const handle = await source.watch('dsh:ada', () => {})
  assert.equal(handle.ok, true)
  handle.close()
  // A source built without a registry reader (install's default) still lists the key as null.
  const plain = await sourceOf(fakeController(sessions()), rt).list()
  for (const row of plain) assert.equal(row.registryId, null)
})

test('#674 stays: a project Bot without its yes lists shown:false and still carries its registry id (#672)', async (t) => {
  const dir = tempHome()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = homeFile(dir)
  const rt = registryTeam()
  const reader = shownReader({ path })
  const source = new DshChatSource({
    adapter: createAdapter(fakeController(sessions())),
    bots: ownBots(rt, reader),
    shown: reader.shown,
    registryIdOf: reader.registryIdOf,
    chatOwner: sessionId => (sessionId === 'ada' ? REG : OWNERS[sessionId]),
    timers,
  })
  const rows = await source.list()
  const reg = rows.find(row => row.terminal === `dsh:${REG}`)
  // #674's gate is intact: no yes means shown:false and no watch, and the row still names its Bot.
  assert.equal(reg.shown, false)
  assert.equal(reg.registryId, REG)
  assert.equal(reg.chat, 'session')
  assert.deepEqual(await source.watch(`dsh:${REG}`, () => {}), { ok: false, reason: 'not-shown' })
})

test('a turn end projects a permission stop as an English status hint only when supplied', () => {
  const end = { type: 'turn/end', seq: 4, time: 100, data: { turn: 2 } }
  const scope = { sessionId: 'ada', turn: 1, calls: new Map() }
  assert.deepEqual(rowsOf(end, scope), [])
  const rows = rowsOf(end, { ...scope, stopOf: turn => turn === 2 ? 'A step did not run: the sandbox blocked it' : undefined })
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].kind, rows[0].state, rows[0].msg, rows[0].turn], ['status', 'error', 'A step did not run: the sandbox blocked it', 2])
})

test('a permission stop reaches the phone as a status row: live, from the log, and on a reconnect page', async () => {
  const stopOf = (id, turn) => (id === 's-omni-2' && turn === 1 ? 'x' : undefined)
  const stopRows = rows => rows.filter(row => row.kind === 'status').map(row => [row.id, row.state, row.msg, row.turn])
  const want = [['dsh:s-omni-2:7#stop', 'error', 'x', 1]]
  const controller = fakeController(sessions())
  const source = writableOf(controller, team(), { stopOf })
  const w = watcher()
  const handle = await source.watch('dsh:omni', w.listener)
  assert.deepEqual(stopRows(w.events[0].rows), [])
  controller.append('s-omni-2', event(7, 'turn/end', { turn: 1 }))
  await settle(); await settle()
  assert.deepEqual(stopRows(w.last('rows').rows), want)
  assert.deepEqual(stopRows(await handle.backfill('dsh:s-omni-2:8', 10)), want)
  handle.close()
  source.close()
  const data = sessions()
  data['s-omni-2'].records.push(event(7, 'turn/end', { turn: 1 }), userAt(8, 'someone'), userAt(9, 'someone'))
  data['s-omni-2'].window = 2
  const paged = writableOf(fakeController(data), team(), { stopOf })
  await paged.watch('dsh:omni', () => {})
  const again = watcher()
  await paged.watch('dsh:omni', again.listener, { after: 'dsh:s-omni-2:6' })
  assert.equal(again.events[0].reset, false)
  assert.deepEqual(stopRows(again.events[0].rows), want)
  paged.close()
})

test('install hands the team’s stop lines to the phone', async (t) => {
  const s = scope(t)
  const data = sessions()
  data['s-omni-2'].records.push(event(7, 'turn/end', { turn: 1 }))
  const ctx = fakeContext({ services: { sessionController: fakeController(data) } })
  s.defer(() => ctx.dispose())
  install({ ...rtFor(ctx, s.home), stopLineOfTurn: (id, turn) => (id === 's-omni-2' && turn === 1 ? 'x' : undefined) })
  let found = null
  for (let i = 0; i < 200 && !found; i++) {
    try { found = lstatSync(s.path) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  assert.ok(found?.isSocket(), 'the socket appears')
  const c = s.client()
  await c.ask('subscribe', { terminal: 'dsh:omni', channel: 1 })
  const snapshot = await c.until(line => line.channel === 1 && line.event.type === 'snapshot')
  assert.deepEqual(snapshot.event.rows.filter(row => row.kind === 'status').map(row => [row.id, row.state, row.msg]), [['dsh:s-omni-2:7#stop', 'error', 'x']])
  c.socket.destroy()
})

test('the source offers settings only with writable Sessions and an enabled host', () => {
  const adapter = { prompt() {}, cancel() {} }
  for (const [writable, enabled, expected] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const source = new DshChatSource({ adapter, writable, settings: { enabled: () => enabled } })
    assert.equal(source.managesSettings, expected)
  }
})
