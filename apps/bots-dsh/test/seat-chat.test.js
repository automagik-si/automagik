// RFC 0022 delivery 1L: the rendered face of a seat on this computer.
//
// With a fake hc and temp homes (never a live Herdr): the registry's Bots are joined to this
// computer's own terminals and a remote terminal is never listed or opened; a seat's transcript
// rows and their status are read; a blocked question reaches the waiting card; every endpoint is
// a read; and the module serves no write of any kind (delivery 2L's sends are not here).
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Engine } from '../src/host/live-chat/engine.js'
import { createFakeHc } from '../src/host/live-chat/fake-hc.mjs'
import { SEAT_ENDPOINTS, SeatChat, hcAvailable, install, seatStatusOf } from '../src/host/seat-chat.js'
import { aWindowProof } from './fixtures/window-proof.mjs'
import { pipeHcThroughWorker } from './fixtures/fake-core-connection.mjs'
import { coreProbeStandIn } from './fixtures/fake-core-probe.mjs'
import { forgetConfirmations } from '../src/host/bar-registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLAUDE_ROWS = join(HERE, '..', 'src', 'host', 'live-chat', 'fixtures', 'claude.jsonl')
const ONE = 'b-aaaaaaaaaa'
const TWO = 'b-bbbbbbbbbb'
const OFF = 'b-cccccccccc'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// A home with the registry the bar reads, and one Claude transcript inside the agent's own folder
// (the folder rule resolves real paths, so the file exists on disk).
function homeWith(registry = {}) {
  const home = mkdtempSync(join(tmpdir(), 'omni-seat-chat-'))
  const { bots = [], projects = [], shown = [] } = typeof registry === 'function' ? registry(home) : registry
  const folder = join(home, '.claude', 'projects', 'p')
  mkdirSync(folder, { recursive: true })
  const transcript = join(folder, 'session.jsonl')
  copyFileSync(CLAUDE_ROWS, transcript)
  const registryPath = join(home, 'bots', 'bots.json')
  mkdirSync(dirname(registryPath), { recursive: true })
  writeFileSync(registryPath, JSON.stringify({ version: 2, bots, projects, shown }))
  return { home, transcript, registryPath, stop: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

function terminal(address, id, extra = {}) {
  return {
    address, state: 'live', created_ms: Number(address.match(/t(\d+)$/)?.[1]) * 100, title: `seat ${address}`, rows: 40,
    labels: { bot: id, 'agent.transcript': extra.transcript },
    status: { app: 'claude-code', state: 'working', turn: 1 },
    ...extra,
  }
}

const CORE = 'core-test'
function ledgerOf(home, terminals) {
  const folder = join(home, 'automagik-herdr')
  mkdirSync(folder, { recursive: true })
  const rows = terminals.filter(row => !row.address.includes('/')).map(row => ({
    v: 1, event: 'attach', bot: row.labels.bot, project: row.project ?? null, terminal: row.address, core: CORE,
    created_ms: row.created_ms, machine: null, at: '2026-11-20T00:00:00.000Z', by: 'start',
  }))
  writeFileSync(join(folder, 'attach.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 })
}

function seatChat(home, { registryPath, terminals = [], screens = {} }) {
  const hc = createFakeHc({ terminals, screens })
  const engine = new Engine({ hc, home })
  ledgerOf(home, terminals)
  const connect = async () => ({ info: { core: { id: CORE } }, call: async method => method === 'terminal.list' ? { terminals } : null, close() {} })
  const chat = new SeatChat({ engine, registryPath, env: { HOME: home, HERDR_APP_HOME: home, HERDR_HC: process.execPath }, connect })
  return { hc, engine, chat, stop: () => chat.dispose() }
}

test('the listing joins the registry to this computer\'s terminals, never another machine\'s', async (t) => {
  const fixture = homeWith(home => {
    const folder = join(home, 'one')
    mkdirSync(folder)
    return {
      bots: [{ id: ONE, name: 'Orchestrator One', folder }, { id: TWO, name: 'Orchestrator Two' }, { id: OFF, name: 'Not Running' }],
      projects: [{ name: 'Project One', folder }],
      shown: [{ project: folder, bots: [ONE] }],
    }
  })
  t.after(fixture.stop)
  const { chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [
      terminal('t1', ONE, { transcript: fixture.transcript, project: join(fixture.home, 'one') }),
      { ...terminal('box/t9', TWO), status: { app: 'claude-code', state: 'working' } },
    ],
  })
  t.after(stop)
  const seats = await chat.list()
  assert.deepEqual(seats.map(seat => [seat.id, seat.terminal, seat.status, seat.chat]), [
    [ONE, 't1', 'working', 'transcript'],
    // On another computer: not a seat here, and it opens no view.
    [TWO, null, 'off', null],
    [OFF, null, 'off', null],
  ])
  assert.equal(seats[0].project, 'Project One')
  assert.equal(seats[0].agent, 'claude')
  assert.equal(seats[1].project, null)
})

test('a finished terminal is not a live seat pane', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }] })
  t.after(fixture.stop)
  const { chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [{ ...terminal('t1', ONE), state: 'finished' }],
  })
  t.after(stop)
  const seats = await chat.list()
  assert.deepEqual(seats.map(seat => [seat.id, seat.terminal, seat.status]), [[ONE, null, 'off']])
  await assert.rejects(() => chat.open('win-1', 't1'), /not a seat/)
})

test('a seat opens as its transcript rows, read only, and a remote or unknown terminal is refused', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }] })
  t.after(fixture.stop)
  const { hc, chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [terminal('t1', ONE, { transcript: fixture.transcript })],
  })
  t.after(stop)
  await assert.rejects(() => chat.open('win-1', 'box/t1'), error => error.code === 'bot/refused' && /another computer/.test(error.message))
  await assert.rejects(() => chat.open('win-1', 't9'), error => error.code === 'bot/refused' && /not a seat/.test(error.message))
  await assert.rejects(() => chat.read('win-1', 't1', null), error => error.code === 'bot/refused' && /not open/.test(error.message))

  const opened = await chat.open('win-1', 't1')
  assert.equal(opened.seat.id, ONE)
  await delay(150)
  const face = await chat.read('win-1', 't1', null)
  assert.ok(face.rows.length > 0)
  assert.ok(face.rows.some(row => row.kind === 'text' && /List the files in src/.test(row.text)))
  assert.equal(face.reset, false)
  // A poll after the last row adds nothing; an unknown cursor resets the face to all rows.
  const last = face.rows.at(-1).id
  assert.deepEqual((await chat.read('win-1', 't1', last)).rows, [])
  const reset = await chat.read('win-1', 't1', 'gone:cursor')
  assert.equal(reset.reset, true)
  assert.equal(reset.rows.length, face.rows.length)
  chat.close('win-1', 't1')
  await assert.rejects(() => chat.read('win-1', 't1', null), /not open/)

  // No write of any kind: the fake records every call, and none is send, keys, interrupt or answer.
  const methods = new Set(hc.calls.map(call => call.method))
  for (const method of ['terminal.send', 'terminal.keys', 'terminal.interrupt']) assert.equal(methods.has(method), false, method)
  // And nothing names a machine or an `on`: a seat here is read from here.
  for (const { method, params } of hc.calls) {
    assert.equal(params.on, undefined, method)
    assert.equal(params.machine, undefined, method)
    assert.equal(String(params.terminal ?? '').includes('/'), false, method)
  }
})

test('a linked machine\'s Bot is never a seat here (S3)', async (t) => {
  const fixture = homeWith({
    bots: [{ id: ONE, name: 'Orchestrator One' }, { id: TWO, name: 'On Another Computer', folder: '/srv/two', machine: 'mac' }],
  })
  t.after(fixture.stop)
  const { chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [terminal('t1', ONE, { transcript: fixture.transcript }), terminal('t2', TWO, { transcript: fixture.transcript })],
  })
  t.after(stop)
  assert.deepEqual((await chat.list()).map(seat => seat.id), [ONE], 'a Bot with a machine is not a seat on this computer')
  await assert.rejects(() => chat.open('win-1', 't2'), error => error.code === 'bot/refused' && /not a seat/.test(error.message))
})

test('the window id is checked before the watch (S6)', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }] })
  t.after(fixture.stop)
  const { hc, chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [terminal('t1', ONE, { transcript: fixture.transcript })],
  })
  t.after(stop)
  for (const client of ['', ' bad', 'x'.repeat(65), 'bad/id', undefined, 42]) {
    await assert.rejects(() => chat.open(client, 't1'), error => error.code === 'bot/refused' && /window cannot open/.test(error.message), `open ${String(client)}`)
    await assert.rejects(() => chat.read(client, 't1', null), error => error.code === 'bot/refused' && /window cannot open/.test(error.message), `read ${String(client)}`)
  }
  // A well-formed window that never opened the seat still cannot read it.
  await assert.rejects(() => chat.read('win-1', 't1', null), /not open/)
  assert.equal(hc.calls.some(call => call.method === 'terminal.read'), false, 'a refused read reaches no terminal')
})

test('one window keeps four watches at most; the oldest seat goes (S7)', async (t) => {
  const ids = ['b-aaaaaaaaaa', 'b-bbbbbbbbbb', 'b-cccccccccc', 'b-dddddddddd', 'b-eeeeeeeeee']
  const fixture = homeWith({ bots: ids.map((id, index) => ({ id, name: `Seat ${index + 1}` })) })
  t.after(fixture.stop)
  const { chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: ids.map((id, index) => terminal(`t${index + 1}`, id, { transcript: fixture.transcript })),
  })
  t.after(stop)
  for (const address of ['t1', 't2', 't3', 't4']) await chat.open('win-1', address)
  assert.equal(chat.watches.get('win-1').size, 4)
  await chat.open('win-1', 't5')
  assert.equal(chat.watches.get('win-1').size, 4, 'the cap holds')
  assert.equal(chat.watches.get('win-1').has('t1'), false, 'the oldest watch went for the new one')
  await assert.rejects(() => chat.read('win-1', 't1', null), /not open/)
  assert.equal((await chat.read('win-1', 't5', null)).seat.terminal, 't5')
})

test('no read without the window\'s own open watch (S8)', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }, { id: TWO, name: 'Other' }] })
  t.after(fixture.stop)
  const { hc, chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [terminal('t1', ONE, { transcript: fixture.transcript }), terminal('t2', TWO, { transcript: fixture.transcript })],
  })
  t.after(stop)
  await chat.open('win-1', 't1')
  await assert.rejects(() => chat.read('win-2', 't1', null), /not open/, 'another window cannot read it')
  await assert.rejects(() => chat.read('win-1', 't2', null), /not open/, 'a window cannot read a seat it did not open')
  const reads = () => hc.calls.filter(call => call.method === 'terminal.get').length
  const before = reads()
  await assert.rejects(() => chat.read('win-2', 't1', null), /not open/)
  assert.equal(reads(), before, 'a refused read asks the terminal for nothing')
})

test('a blocked seat asks for the owner, and the bar says "needs you"', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }] })
  t.after(fixture.stop)
  const { engine, chat, stop } = seatChat(fixture.home, {
    registryPath: fixture.registryPath,
    terminals: [terminal('t1', ONE, {
      transcript: fixture.transcript,
      status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'Which deploy should I ship?', turn: 2 },
    })],
  })
  t.after(stop)
  await engine.ready()
  assert.equal(seatStatusOf(engine.hub.all().find(entry => entry.address === 't1')), 'needs')
  await chat.open('win-1', 't1')
  await delay(150)
  const face = await chat.read('win-1', 't1', null)
  assert.equal(seatStatusOf({ status: face.status }), 'needs')
  assert.ok(face.question, 'the waiting card is the question row')
  assert.equal(face.question.kind, 'question')
  assert.equal(face.question.prompt, 'Which deploy should I ship?')
  // Show only: a question with no dialog reader is "answer in the terminal", and no answer path
  // exists on this endpoint set at all.
  assert.equal(face.question.answerable, false)
  assert.equal(face.approval, null)
})

test('through the route, a window lists, opens, reads and closes a local seat, and nothing else', async (t) => {
  const fixture = homeWith({ bots: [{ id: ONE, name: 'Orchestrator One' }] })
  t.after(fixture.stop)
  const terminals = [terminal('t1', ONE, { transcript: fixture.transcript })]
  ledgerOf(fixture.home, terminals)
  const terminalFile = join(fixture.home, 'terminals.json')
  writeFileSync(terminalFile, JSON.stringify(terminals))
  const env = {
    ...coreProbeStandIn(t, fixture.home).env, HOME: fixture.home, HERDR_APP_HOME: fixture.home,
    HERDR_HC: join(HERE, 'fixtures', 'fake-hc-core.mjs'), FAKE_CORE_TERMINALS: terminalFile,
  }
  pipeHcThroughWorker(t, env.HERDR_HC)
  const was = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    forgetConfirmations()
  })
  const hc = createFakeHc({ terminals })
  const engine = new Engine({ hc, home: fixture.home })
  t.after(() => engine.close())
  const registered = new Map()
  const effects = []
  const rt = {
    registryPath: fixture.registryPath,
    ctx: { effect: (body) => { const dispose = body(); effects.push(dispose); return () => dispose?.() } },
    warn: () => {},
    hooks: { endpoint: (name, fn, options) => { registered.set(name, { fn, options }); return () => registered.delete(name) } },
  }
  install(rt, { engine })
  const endpoint = name => body => registered.get(name).fn(body, undefined, aWindowProof())
  const listed = await endpoint('seat-chat-list')({})
  assert.deepEqual(listed.seats.map(seat => [seat.terminal, seat.status]), [['t1', 'working']])
  await assert.rejects(() => endpoint('seat-chat-open')({ client: 'win-1', terminal: 'box/t1' }), /another computer/)
  const opened = await endpoint('seat-chat-open')({ client: 'win-1', terminal: 't1' })
  assert.equal(opened.seat.id, ONE)
  await delay(150)
  const face = await endpoint('seat-chat-read')({ client: 'win-1', terminal: 't1', after: null })
  assert.ok(face.rows.some(row => row.kind === 'text' && /List the files in src/.test(row.text)))
  await endpoint('seat-chat-close')({ client: 'win-1', terminal: 't1', generation: 'earlier-open' })
  assert.equal((await endpoint('seat-chat-read')({ client: 'win-1', terminal: 't1' })).seat.id, ONE)
  assert.deepEqual(await endpoint('seat-chat-close')({ client: 'win-1', terminal: 't1', generation: opened.generation }), { closed: true })
  await assert.rejects(() => endpoint('seat-chat-read')({ client: 'win-1', terminal: 't1', after: null }), /not open/)
})

test('the endpoints are reads, served for the window and never as a tool', () => {
  const seats = new Set(SEAT_ENDPOINTS)
  assert.deepEqual([...seats].sort(), ['seat-chat-close', 'seat-chat-list', 'seat-chat-open', 'seat-chat-read'])
  for (const name of seats) assert.equal(/send|answer|interrupt|keys|write/.test(name), false, name)

  const registered = new Map()
  const effects = []
  const warnings = []
  const rt = {
    registryPath: join(tmpdir(), 'omni-seat-chat-no-registry', 'bots.json'),
    ctx: { effect: (body) => { const dispose = body(); effects.push(dispose); return () => dispose?.() } },
    warn: (...args) => warnings.push(args),
    hooks: {
      endpoint(name, fn, options) {
        registered.set(name, { fn, options })
        return () => registered.delete(name)
      },
    },
  }
  const disposed = install(rt)
  assert.deepEqual([...registered.keys()].sort(), [...SEAT_ENDPOINTS].sort())
  for (const [name, entry] of registered) assert.equal(entry.options.read, true, `${name} reads`)
  assert.equal(rt.teamTools, undefined, 'no tool is registered')
  disposed()
  assert.equal(registered.size, 0)
})

test('the seat Terminal adds no endpoint: it opens the Code side the app already serves', () => {
  assert.deepEqual([...SEAT_ENDPOINTS].sort(), ['seat-chat-close', 'seat-chat-list', 'seat-chat-open', 'seat-chat-read'])
  const client = readFileSync(join(HERE, '..', 'src', 'client', 'seat-chat.js'), 'utf8')
  assert.match(client, /from '\.\/code-side\.js'/, 'the seat reuses the Code side, never a second store')
  assert.doesNotMatch(client, /seat-chat-(?:terminal|tree|stream)|code\/stream/, 'the seat names no route of its own')
  const host = readFileSync(join(HERE, '..', 'src', 'host', 'seat-chat.js'), 'utf8')
  assert.doesNotMatch(host, /code\/stream|code-tree/, 'the seat host serves no Code route')
})

test('a host with no herdr-core spawns no engine and lists no seat', () => {
  assert.equal(hcAvailable('/nonexistent/omni-seat-chat/hc'), false)
  // A program that answers `--version` stands in for one that does, without a live Herdr.
  assert.equal(hcAvailable(process.execPath), true)
})

test('the host module names no write of the engine (delivery 2L is not served here)', () => {
  const source = readFileSync(join(HERE, '..', 'src', 'host', 'seat-chat.js'), 'utf8')
  // The engine's write side: input.js's sends, approve.js/question.js's answers, the interrupts.
  for (const call of ['.send(', '.sendHeld(', '.cancelHeld(', '.answer(', '.answerOnce(', '.answerQuestion(', '.interrupt(']) {
    assert.equal(source.includes(call), false, `seat-chat.js does not call ${call}`)
  }
  assert.equal(source.includes("from './live-chat/input.js'"), false)
})
