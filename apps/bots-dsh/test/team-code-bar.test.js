import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { forgetConfirmations } from '../src/host/bar-registry.js'
import { install as installChannel } from '../src/host/channel.js'
import { CODE_STREAM_ROUTE, install as installCode, openPaneStream } from '../src/host/code-side.js'
import { connectCore } from '../src/host/code-core.js'
import { readCodeTree, resolvePane, startTarget, statusWord } from '../src/host/code-tree.js'
import { revokeWindowProof } from '../src/host/desktop-window.js'
import { install as installHooks, isWindowEndpoint } from '../src/host/extend.js'
import { Engine } from '../src/host/live-chat/engine.js'
import { install as installSeats, SeatChat } from '../src/host/seat-chat.js'
import { attachPath } from '../src/shared/attach-record.js'
import { HOME_PATH, REPO_PATH } from '../src/shared/registry.js'
import { workersPath } from '../src/shared/workers-journal.js'
import { fakeContext } from './fake-ctx.js'
import { pipeHcThroughWorker } from './fixtures/fake-core-connection.mjs'
import { coreProbeStandIn } from './fixtures/fake-core-probe.mjs'
import { aWindowProof } from './fixtures/window-proof.mjs'

const ONE = 'b-aaaaaaaaaa'
const TWO = 'b-bbbbbbbbbb'
const CORE = 'core-test'
const SECRET = 'ab'.repeat(32)
const DIGEST = createHash('sha256').update(SECRET, 'ascii').digest('hex')
const PLAIN = fileURLToPath(new URL('./fixtures/fake-hc-plain.mjs', import.meta.url))
const FRAMED = fileURLToPath(new URL('./fixtures/fake-hc-core.mjs', import.meta.url))
const SESSION = 'session-12345678-1234-1234-1234-123456789abc'
const at = '2026-11-20T00:00:00Z'

function terminal(address, created_ms, state = 'idle', fields = {}) {
  return { address, created_ms, state: 'live', cols: 100, rows: 36, status: { state }, ...fields }
}

function binding(bot, terminal = 't7', created_ms = 700, core = CORE) {
  return { v: 1, event: 'attach', bot, project: null, terminal, core, created_ms, machine: null, at, by: 'start' }
}

const writeRows = (path, rows) => writeFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 })
const rowsAt = (path) => fs.existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-code-bar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(forgetConfirmations)
  const registryPath = join(root, HOME_PATH)
  const ledger = attachPath(root)
  for (const path of [registryPath, ledger]) mkdirSync(dirname(path), { recursive: true })
  const env = {
    ...process.env, HOME: root, AUTOMAGIK_HOME: root, HERDR_APP_HOME: root,
    AUTOMAGIK_HERDR_TEST_ROOTS: root, AUTOMAGIK_HERDR_CORE_SOCKET: join(root, 'core.sock'),
    HC_SESSION: 'team-code-bar', HC_SOCKET: '', AUTOMAGIK_APP_BROWSER: '1', AUTOMAGIK_WINDOW_DIGEST: DIGEST,
    HERDR_HC: FRAMED, FAKE_CORE_TERMINALS: join(root, 'framed.json'), FAKE_CORE_LOG: join(root, 'framed.log'),
    OMNI_SEAT_CHAT_HC: PLAIN, FAKE_HC_STATE: join(root, 'plain.json'), FAKE_HC_LOG: join(root, 'plain.log'),
  }
  const registry = (bots = [{ id: ONE, name: 'Atlas' }, { id: TWO, name: 'Builder' }], fields = {}) =>
    writeFileSync(registryPath, JSON.stringify({ version: 2, bots, ...fields }))
  const attach = (...rows) => writeRows(ledger, rows)
  const workers = (...rows) => writeRows(workersPath(root), rows)
  const worker = (botId, terminal, created_ms) => ({ event: 'start', kind: 'worker', botId, terminal, core: CORE, created_ms, at })
  const useEnv = () => {
    const keys = [
      'HOME', 'AUTOMAGIK_HOME', 'HERDR_APP_HOME', 'AUTOMAGIK_HERDR_TEST_ROOTS', 'AUTOMAGIK_HERDR_CORE_SOCKET',
      'HC_SESSION', 'HC_SOCKET', 'AUTOMAGIK_APP_BROWSER', 'AUTOMAGIK_WINDOW_DIGEST',
      'HERDR_HC', 'FAKE_CORE_TERMINALS', 'FAKE_CORE_LOG', 'FAKE_CORE_RESIZE_TO', 'FAKE_CORE_KEEP_OPEN', 'OMNI_SEAT_CHAT_HC', 'FAKE_HC_STATE', 'FAKE_HC_LOG',
    ]
    for (const key of keys) {
      const before = process.env[key]
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]
      t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
    }
  }
  registry()
  return { root, registryPath, env, registry, attach, workers, worker, useEnv }
}

function connection(terminals, core = CORE) {
  return {
    info: { core: { id: core } },
    call: async (method, params) => method === 'terminal.list' ? { terminals } : terminals.find(row => row.address === params.terminal),
    close() {},
  }
}

function host(t, f, { engine, connect } = {}) {
  const savedSend = process.send
  process.send = () => true
  t.after(() => { if (savedSend === undefined) delete process.send; else process.send = savedSend })
  const service = { fetchRoutes: new Map(), interceptors: new Map() }
  const ctx = fakeContext({ services: { connection: service } })
  ctx.connection.fetch.register = options => HostConnectionService.prototype.registerFetchRoute.call(service, { effect: setup => setup() }, options)
  const rt = {
    ctx, state: { bots: {} }, home: f.root, registryPath: f.registryPath,
    load: async () => {}, refresh: async () => {}, readOnly: () => undefined, warn() {},
  }
  t.after(() => ctx.dispose())
  installHooks(rt)
  installSeats(rt, { engine })
  if (connect) t.after(installCode(rt, { env: f.env, connect, desktop: true }))
  installChannel(rt)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(service, '/api')
  const request = (path, { secret = SECRET, body, principal = { kind: 'owner' } } = {}) => {
    const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' })
    if (secret) headers.set('x-automagik-window', secret)
    return handler.fetch(new Request('http://127.0.0.1' + path, {
      method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
    }), { principal })
  }
  const call = async (endpoint, { secret, payload } = {}) => (await request('/api/omni-ui', { secret, body: { endpoint, payload } })).json()
  return { rt, request, call }
}

test('seat-chat-list needs the dispatcher proof before reading the registry, probing or creating the engine', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  f.useEnv()
  const ready = t.mock.method(Engine.prototype, 'ready', () => assert.fail('listing does not start the engine'))
  const { rt, call, request } = host(t, f)
  const reads = t.mock.method(fs, 'openSync', (path, ...args) => openSyncOriginal(path, ...args))
  syncBuiltinESMExports()
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports() })
  const socket = t.mock.method(Socket.prototype, 'connect', () => assert.fail('no core probe for this request'))
  const homeReads = () => reads.mock.calls.filter(({ arguments: [path] }) => path === f.registryPath).length
  for (const secret of [null, 'cd'.repeat(32), DIGEST]) {
    assert.deepEqual(await call('seat-chat-list', { secret }), { ok: false, error: { code: 'bot/refused', message: 'desktop-only', details: {} } })
  }
  const agent = await request('/api/omni-ui', {
    body: { endpoint: 'seat-chat-list' }, principal: { kind: 'agent', sessionId: SESSION },
  })
  assert.equal(agent.status, 403, 'a valid window header does not authorize an agent')
  const entry = rt.extended.endpointOf('seat-chat-list')
  assert.equal(isWindowEndpoint(entry), true)
  const revoked = aWindowProof()
  revokeWindowProof(revoked)
  for (const proof of [true, false, {}, revoked]) {
    await assert.rejects(() => entry.fn({}, undefined, proof), { code: 'bot/refused', message: 'desktop-only' })
  }
  assert.equal(homeReads(), 0)
  assert.equal(socket.mock.callCount(), 0)
  assert.equal(ready.mock.callCount(), 0)
  assert.deepEqual(rowsAt(f.env.FAKE_HC_LOG), [])
  f.attach()
  assert.equal((await call('seat-chat-list')).value.seats[0].id, ONE)
  assert.equal(homeReads(), 1, 'one registry read for the whole answer')
  assert.equal((await entry.fn({}, undefined, aWindowProof())).seats.length, 2)
  assert.equal(homeReads(), 2)
  assert.deepEqual(rowsAt(f.env.FAKE_HC_LOG), [], 'a valid list also leaves the chat engine alone')
})
const openSyncOriginal = fs.openSync

test('seat confirmation refuses a different core and a disconnected engine cache', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  const labelled = terminal('t7', 700, 'working', { labels: { bot: ONE } })
  const all = t.mock.fn(() => [labelled])
  const ready = t.mock.fn()
  const chat = new SeatChat({ ...f, engine: { ready, hub: { all } }, connect: async () => connection([labelled], 'other-core') })
  assert.deepEqual((await chat.list()).map(seat => [seat.terminal, seat.status]), [[null, 'off'], [null, 'off']])
  forgetConfirmations()
  chat.connect = async () => { throw new Error('no-core') }
  assert.equal((await chat.list())[0].terminal, null)
  assert.equal(all.mock.callCount(), 0)
  assert.equal(ready.mock.callCount(), 0)
})

test('confirmation shares one in-flight read, applies it to the current ledger, and drops reused addresses', async (t) => {
  const f = fixture(t)
  let terminals = [terminal('t1', 100, 'working', { labels: { bot: ONE } }), terminal('t7', 700)]
  const connect = t.mock.fn(async () => connection(terminals))
  const chat = new SeatChat({ ...f, engine: null, connect })
  assert.deepEqual((await chat.list()).map(seat => seat.terminal), [null, null], 'labels grant no binding')
  assert.equal(connect.mock.callCount(), 0)
  f.attach(binding(ONE))
  const [first, second] = await Promise.all([chat.list(), chat.list()])
  assert.deepEqual(first, second)
  assert.equal(first[0].terminal, 't7')
  assert.equal(connect.mock.callCount(), 1)
  const tree = await readCodeTree({ env: f.env, connect })
  assert.equal(tree.tree.projects[0].bots[0].terminal.id, first[0].terminal)
  assert.equal(connect.mock.callCount(), 2)

  f.attach(binding(ONE), binding(TWO, 't7', 900))
  assert.deepEqual((await chat.list()).map(seat => seat.terminal), ['t7', null], 'the core must first confirm the new creation time')
  terminals = [terminal('t7', 900)]
  forgetConfirmations()
  assert.deepEqual((await chat.list()).map(seat => seat.terminal), [null, 't7'])
  assert.equal(connect.mock.callCount(), 3)
})

test('remote-only and offline registries list without connecting or making the chat engine', async (t) => {
  const f = fixture(t)
  const project = join(f.root, 'remote')
  const remote = { id: TWO, name: 'Remote', folder: project, machine: 'box', main: true }
  const shown = [{ project, machine: 'box', bots: [TWO] }]
  const front = { project, machine: 'box', bot: TWO }
  f.registry([remote], { shown, front })
  const connect = t.mock.fn()
  assert.deepEqual(await new SeatChat({ ...f, engine: null, connect }).list(), [])
  assert.equal(connect.mock.callCount(), 0)
  f.registry([{ id: ONE, name: 'Offline' }, remote], { shown, front })
  f.useEnv()
  const listed = (await host(t, f).call('seat-chat-list')).value
  assert.deepEqual(listed.front, front)
  assert.deepEqual(listed.seats.map(({ key, status, terminal, front }) => [key, status, terminal, front]),
    [[ONE, 'off', null, false], [TWO + '@box', 'off', null, true]])
  assert.deepEqual(rowsAt(f.env.FAKE_HC_LOG), [])
  assert.deepEqual(rowsAt(f.env.FAKE_CORE_LOG), [])
})

test('Team and Code map structured statuses and omit finished, unpicked, duplicate-seat and label-only workers', async (t) => {
  const f = fixture(t)
  const states = ['working', 'blocked', 'error', 'done', 'idle']
  const ids = [ONE, TWO, 'b-cccccccccc', 'b-dddddddddd', 'b-eeeeeeeeee']
  const unpicked = 'b-ffffffffff'
  const project = join(f.root, 'unpicked')
  f.registry([...ids.map(id => ({ id, name: id })), { id: unpicked, name: 'Hidden', folder: project }])
  f.attach(...ids.map((id, index) => binding(id, 't' + index, 100 + index)), binding(unpicked, 't6', 600))
  f.workers(f.worker(ONE, 't0', 100), f.worker(ONE, 't6', 600), f.worker(ONE, 't1', 101), f.worker(ONE, 't4', 104), f.worker(ONE, 't7', 700), f.worker(unpicked, 't8', 800))
  const terminals = states.map((state, index) => terminal('t' + index, 100 + index, state, index === 4 ? { state: 'finished' } : {}))
  terminals.push(terminal('t6', 600), terminal('t7', 700), terminal('t8', 800), terminal('t9', 900, 'idle', { labels: { 'automagik.bot': ONE, 'automagik.worker': 'dev' } }))
  const connect = t.mock.fn(async () => connection(terminals))
  const chat = new SeatChat({ ...f, engine: null, connect })
  assert.deepEqual((await chat.list()).map(seat => seat.status), ['working', 'needs', 'error', 'idle', 'off'])
  assert.deepEqual(terminals.slice(0, 5).map(statusWord), ['working', 'needs-you', 'needs-you', 'idle', 'not-running'])
  const { tree } = await readCodeTree({ env: f.env, connect })
  assert.deepEqual(tree.projects[0].bots.flatMap(bot => bot.workers.map(worker => [bot.id, worker.terminal])), [[ONE, 't7']])
  assert.equal((await resolvePane({ botId: ONE, worker: 't0', env: f.env, connect }))?.terminal, 't0', 'the own-seat worker alias still opens')
  assert.equal(await resolvePane({ botId: ONE, worker: 't6', env: f.env, connect }), null, 'a hidden Bot owns this seat')
  const stream = await openPaneStream({ url: 'http://x/code/stream?bot=' + ONE + '&worker=t6', env: f.env, connect })
  assert.deepEqual(await stream.json(), { error: 'no-pane' })
  const calls = connect.mock.callCount()
  assert.equal(await resolvePane({ botId: unpicked, worker: 't8', env: f.env, connect }), null)
  assert.equal(connect.mock.callCount(), calls)
})

test('a withdrawn pick refuses the previously listed seat and its worker', async (t) => {
  const f = fixture(t)
  const project = join(f.root, 'project')
  mkdirSync(project)
  const bots = [{ id: ONE, name: 'Atlas', folder: project }]
  f.registry(bots, { shown: [{ project, bots: [ONE] }] })
  f.attach({ ...binding(ONE), project })
  f.workers(f.worker(ONE, 't9', 900))
  const connect = t.mock.fn(async () => connection([terminal('t7', 700)]))
  const chat = new SeatChat({ ...f, engine: null, connect })
  assert.equal((await chat.list())[0].terminal, 't7')
  f.registry(bots)
  await assert.rejects(() => chat.seatOf('t7'), /not a seat/)
  assert.equal(await resolvePane({ botId: ONE, worker: 't9', env: f.env, connect }), null)
  assert.equal(connect.mock.callCount(), 1)
})

test('Code opens a Session Bot and honors a folder grant even when Team has no Bot pick', async (t) => {
  const f = fixture(t)
  const project = join(f.root, 'project')
  const repoPath = join(project, REPO_PATH)
  mkdirSync(dirname(repoPath), { recursive: true })
  writeFileSync(repoPath, JSON.stringify({ version: 2, bots: [{ id: ONE, name: 'Atlas' }] }))
  mkdirSync(join(project, '.herdr'))
  writeFileSync(join(project, '.herdr', 'bots.json'), JSON.stringify({ version: 1, bots: [{ id: ONE, name: 'Atlas', kind: 'main' }] }))
  f.registry([{ id: SESSION, name: 'Session', folder: project }], {
    projects: [{ folder: project }], shown: [{ project, bots: [SESSION] }],
  })
  f.attach({ ...binding(SESSION), project })
  const connect = async () => connection([terminal('t7', 700)])
  const opts = { env: f.env, connect }
  const { tree } = await readCodeTree(opts)
  assert.deepEqual(tree.projects[0].bots.map(bot => [bot.id, bot.terminal?.id]), [[SESSION, 't7'], [ONE, undefined]])
  assert.equal((await resolvePane({ ...opts, botId: SESSION })).created_ms, 700)
  assert.deepEqual(await startTarget(ONE, opts), { folder: project, key: project, blocked: null })
  assert.deepEqual(await new SeatChat({ ...f, connect }).list(), [])
})

test('Team refuses a writable ledger after a successful list and never probes through an unshown project', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  const folder = join(f.root, 'hidden')
  f.registry([{ id: ONE, name: 'Atlas' }, { id: TWO, name: 'Hidden', folder }])
  const connect = t.mock.fn(async () => connection([terminal('t7', 700)]))
  const chat = new SeatChat({ ...f, connect })
  assert.equal((await chat.list())[0].terminal, 't7')
  assert.equal(connect.mock.calls[0].arguments[0].bin, FRAMED)
  chmodSync(attachPath(f.root), 0o666)
  assert.equal((await chat.list())[0].terminal, null)
  await assert.rejects(() => chat.open('win', 't7'), /not a seat/)
  chmodSync(attachPath(f.root), 0o600)
  const untrusted = new SeatChat({ ...f, env: { ...f.env, HERDR_HC: join(folder, 'hc') }, connect })
  assert.equal((await untrusted.list())[0].terminal, null)
  assert.equal(connect.mock.callCount(), 1)
})

test('Team never confirms through the hc link in a discarded duplicate home placement', async (t) => {
  const f = fixture(t)
  const folder = join(f.root, 'duplicate')
  mkdirSync(folder)
  writeFileSync(join(folder, 'candidate'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const bin = join(folder, 'hc')
  symlinkSync('candidate', bin)
  f.registry([{ id: ONE, name: 'Atlas' }, { id: TWO, name: 'Builder' }, { id: TWO, name: 'Duplicate', folder }])
  f.attach(binding(ONE))
  const connect = t.mock.fn(async () => connection([terminal('t7', 700)]))
  const chat = new SeatChat({ ...f, env: { ...f.env, HERDR_HC: bin }, connect })
  assert.deepEqual((await chat.list()).map(seat => [seat.id, seat.terminal]), [[ONE, null]])
  assert.equal(connect.mock.callCount(), 0)
})

test('Team binds a worktree seat only to its main checkout and a global seat only without a project', async (t) => {
  const f = fixture(t)
  const main = join(f.root, 'main')
  const linked = join(f.root, 'linked')
  const git = join(main, '.git')
  const worktree = join(git, 'worktrees', 'linked')
  for (const dir of [linked, worktree, join(git, 'objects'), join(git, 'refs')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(linked, '.git'), `gitdir: ${worktree}\n`)
  writeFileSync(join(worktree, 'HEAD'), 'ref: refs/heads/test\n')
  writeFileSync(join(worktree, 'commondir'), '../..\n')
  writeFileSync(join(worktree, 'gitdir'), join(linked, '.git') + '\n')
  f.registry([{ id: ONE, name: 'Atlas', folder: linked }, { id: TWO, name: 'Global' }], {
    shown: [{ project: linked, bots: [ONE] }],
  })
  const connect = async () => connection([terminal('t7', 700), terminal('t8', 800)])
  const chat = new SeatChat({ ...f, connect })
  f.attach({ ...binding(ONE), project: linked }, { ...binding(TWO, 't8', 800), project: main })
  assert.deepEqual((await chat.list()).map(seat => seat.terminal), [null, null])
  await assert.rejects(() => chat.seatOf('t7'), /not a seat/)
  for (const project of [null, undefined]) {
    f.attach({ ...binding(ONE), project: main }, { ...binding(TWO, 't8', 800), project })
    assert.deepEqual((await chat.list()).map(seat => seat.terminal), ['t7', 't8'])
  }
})

function chatIdentity(t, f) {
  let framed = terminal('t7', 700)
  let plain = framed
  let projected
  let pause
  let coreId = CORE
  const handles = []
  const engine = {
    hub: { current: () => plain },
    drop: t.mock.fn(() => { projected = undefined }),
    watch: t.mock.fn(() => {
      projected ??= plain.created_ms
      const handle = {
        rows: () => [projected], close: t.mock.fn(), screen: () => [], status: () => null,
        approval: () => null, question: () => null,
      }
      handles.push(handle)
      return handle
    }),
  }
  f.attach(binding(ONE))
  const chat = new SeatChat({ ...f, engine, connect: async () => {
    const core = connection(framed ? [framed] : [], coreId)
    await pause
    return core
  } })
  return {
    chat, engine, handles,
    projectRows: rows => { projected = rows },
    framed: next => { framed = next }, plain: next => { plain = next }, pause: until => { pause = until }, core: next => { coreId = next },
  }
}

test('Team opens a global Bot from the pack’s workspace start row', async (t) => {
  const f = fixture(t)
  const teamHome = join(f.root, 'team-home')
  const workspace = join(teamHome, 'workspace')
  mkdirSync(workspace, { recursive: true })
  f.env.AUTOMAGIK_BOTS_HOME = teamHome
  const c = chatIdentity(t, f)
  f.attach({ ...binding(ONE), project: workspace })
  assert.equal((await c.chat.open('one', 't7')).seat.id, ONE)
  f.attach({ ...binding(ONE), project: teamHome })
  await assert.rejects(c.chat.read('one', 't7'), /not a seat/)
})

test('Team confirms a global Bot in the configured and subsequently selected team folders', async (t) => {
  const f = fixture(t)
  const configured = join(f.root, 'configured-folder')
  const selected = join(f.root, 'selected-folder')
  mkdirSync(configured)
  mkdirSync(selected)
  coreProbeStandIn(t, f.root)
  pipeHcThroughWorker(t, FRAMED)
  f.useEnv()
  writeFileSync(f.env.FAKE_CORE_TERMINALS, JSON.stringify([terminal('t7', 700)]))
  const { rt, call } = host(t, f)
  let current
  rt.teamFolder = () => current
  rt.defaultTeamFolder = () => configured
  const listedTerminal = async () => (await call('seat-chat-list')).value.seats[0].terminal

  f.attach({ ...binding(ONE), project: configured })
  assert.equal(await listedTerminal(), 't7')
  current = selected
  assert.equal(await listedTerminal(), null, 'the old workspace is no longer eligible')
  f.attach({ ...binding(ONE), project: selected })
  assert.equal(await listedTerminal(), 't7')
})

test('Team keeps the watch and projection through unavailable core confirmation', async (t) => {
  const c = chatIdentity(t, fixture(t))
  const connect = c.chat.connect
  assert.deepEqual((await c.chat.open('one', 't7')).rows, [700])
  for (const unavailable of [
    async () => null,
    async () => { throw new Error('connect failed') },
    async () => ({ ...connection([]), call: async () => undefined }),
    async () => ({ ...connection([]), call: async () => { throw new Error('terminal.list timed out') } }),
  ]) {
    c.chat.connect = unavailable
    await assert.rejects(c.chat.read('one', 't7'), { code: 'bot/unavailable', message: 'The terminal could not be reached' })
    assert.equal(c.engine.drop.mock.callCount(), 0)
    assert.equal(c.handles[0].close.mock.callCount(), 0)
    c.chat.connect = connect
    assert.deepEqual((await c.chat.read('one', 't7')).rows, [700])
  }
  assert.equal(c.engine.watch.mock.callCount(), 1)
})

test('Team discards the projection when a pane is reassigned away and back between reads', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  const initial = { ...binding(ONE), by: 'attach' }
  f.attach(initial)
  assert.deepEqual((await c.chat.open('one', 't7')).rows, [700])
  assert.deepEqual((await c.chat.read('one', 't7')).rows, [700])
  c.projectRows('another Bot’s rows')
  f.attach(initial, { ...binding(TWO), at: '2026-11-20T00:00:01Z', by: 'attach' },
    { ...initial, at: '2026-11-20T00:00:02Z' })
  await assert.rejects(c.chat.read('one', 't7'), /not running/)
  assert.equal(c.handles[0].close.mock.callCount(), 1)
  assert.equal(c.engine.drop.mock.callCount(), 1)
  assert.deepEqual((await c.chat.open('one', 't7')).rows, [700])
})

test('a delayed close from an earlier face preserves the replacement Team open and read', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  const first = await c.chat.open('one', 't7')
  const confirmation = Promise.withResolvers()
  c.pause(confirmation.promise)
  const reopening = c.chat.open('one', 't7')
  c.chat.close('one', 't7', first.generation)
  confirmation.resolve()
  const second = await reopening
  assert.notEqual(second.generation, first.generation)
  c.chat.close('one', 't7', first.generation)
  assert.deepEqual((await c.chat.read('one', 't7')).rows, [700])
  assert.equal(c.handles[1].close.mock.callCount(), 0)
  c.chat.close('one', 't7', second.generation)
  await assert.rejects(c.chat.read('one', 't7'), /not open/)
})

test('concurrent Team opens on the same attach event retain independent watches', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  const confirmation = Promise.withResolvers()
  c.pause(confirmation.promise)
  const opening = Promise.all([c.chat.open('one', 't7'), c.chat.open('two', 't7')])
  confirmation.resolve()
  const [first, second] = await opening
  assert.equal(first.seat.id, ONE)
  assert.equal(second.seat.id, ONE)
  c.chat.close('one', 't7', first.generation)
  await assert.rejects(c.chat.read('one', 't7'), /not open/)
  assert.deepEqual((await c.chat.read('two', 't7')).rows, [700])
  assert.equal(c.engine.watch.mock.callCount(), 2)
  assert.equal(c.handles[0].close.mock.callCount(), 1)
  assert.equal(c.handles[1].close.mock.callCount(), 0)
})

test('a fresh Team open and read refuse a replacement before the list memo expires', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  assert.equal((await c.chat.list())[0].terminal, 't7')
  c.framed(terminal('t7', 701))
  await assert.rejects(() => c.chat.open('one', 't7'), /not a seat/)
  assert.equal(c.engine.watch.mock.callCount(), 0)
  c.framed(terminal('t7', 700))
  await c.chat.open('one', 't7')
  c.framed(null)
  assert.equal((await c.chat.list())[0].terminal, 't7', 'the bar may still use its memo')
  await assert.rejects(() => c.chat.read('one', 't7'), /not a seat/)
  assert.equal(c.handles[0].close.mock.callCount(), 1)
  assert.equal(c.engine.drop.mock.callCount(), 1)
})

for (const method of ['open', 'read']) {
  test(`Team ${method} refuses a Bot reassignment during framed confirmation`, async (t) => {
    const f = fixture(t)
    const c = chatIdentity(t, f)
    if (method === 'read') await c.chat.open('one', 't7')
    const confirmation = Promise.withResolvers()
    c.pause(confirmation.promise)
    const reply = c.chat[method]('one', 't7')
    f.attach(binding(TWO))
    confirmation.resolve()
    await assert.rejects(reply, /not running on this computer/)
    assert.equal(c.chat.watchOf('one', 't7'), null)
    assert.equal(c.engine.watch.mock.callCount(), method === 'read' ? 1 : 0)
    if (method === 'read') assert.equal(c.handles[0].close.mock.callCount(), 1)
  })
}

test('Team open refuses a withdrawn pick after the plain hub finishes waiting', async (t) => {
  const f = fixture(t)
  const project = join(f.root, 'project')
  mkdirSync(project)
  const bots = [{ id: ONE, name: 'Atlas', folder: project }]
  f.registry(bots, { shown: [{ project, bots: [ONE] }] })
  const c = chatIdentity(t, f)
  f.attach({ ...binding(ONE), project })
  c.plain(null)
  c.engine.hub.ready = async () => {
    await Promise.resolve()
    f.registry(bots)
    c.plain(terminal('t7', 700))
  }
  await assert.rejects(c.chat.open('one', 't7'), /not running on this computer/)
  assert.equal(c.engine.watch.mock.callCount(), 0)
})

test('Team read refuses a binding whose project moves during confirmation', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  await c.chat.open('one', 't7')
  const confirmation = Promise.withResolvers()
  c.pause(confirmation.promise)
  const reading = c.chat.read('one', 't7')
  f.attach({ ...binding(ONE), project: join(f.root, 'different-project') })
  confirmation.resolve()
  await assert.rejects(reading, /not running on this computer/)
  assert.equal(c.handles[0].close.mock.callCount(), 1)
})

test('closing during the first Team open cancels the pending watch', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  const confirmation = Promise.withResolvers()
  c.pause(confirmation.promise)
  const opening = c.chat.open('one', 't7')
  c.chat.close('one', 't7')
  confirmation.resolve()
  await assert.rejects(opening, /not open in this window/)
  assert.equal(c.chat.watchOf('one', 't7'), null)
  assert.equal(c.engine.watch.mock.callCount(), 0)
  await c.chat.open('one', 't7')
  assert.equal(c.engine.watch.mock.callCount(), 1, 'a later open still works')
})

test('Team drops a lingering projection on address reuse and closes every watch on Bot reassignment', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  assert.deepEqual((await c.chat.open('one', 't7')).rows, [700])
  c.chat.close('one', 't7')
  const replacement = terminal('t7', 701)
  c.framed(replacement)
  c.plain(replacement)
  f.attach(binding(ONE, 't7', 701))
  assert.deepEqual((await c.chat.open('one', 't7')).rows, [701])
  await c.chat.open('two', 't7')
  f.attach(binding(TWO, 't7', 701))
  await assert.rejects(() => c.chat.read('one', 't7'), /not running/)
  assert.equal(c.handles[1].close.mock.callCount(), 1)
  assert.equal(c.handles[2].close.mock.callCount(), 1)
  assert.equal(c.engine.drop.mock.callCount(), 2)
  const opened = await c.chat.open('two', 't7')
  assert.equal(opened.seat.id, TWO)
})

test('a different framed core invalidates Team watches even with the same Bot, address and creation time', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  await c.chat.open('one', 't7')
  c.core('replacement-core')
  f.attach(binding(ONE, 't7', 700, 'replacement-core'))
  await assert.rejects(() => c.chat.read('one', 't7'), /not running/)
  assert.equal(c.handles[0].close.mock.callCount(), 1)
  assert.equal(c.engine.drop.mock.callCount(), 1)
})

test('Team refuses a mismatched or finished plain hub pane and never reads a closed handle', async (t) => {
  const f = fixture(t)
  const c = chatIdentity(t, f)
  c.plain(terminal('t7', 701))
  await assert.rejects(() => c.chat.open('one', 't7'), /not running/)
  assert.equal(c.engine.watch.mock.callCount(), 0)
  c.plain(terminal('t7', 700))
  await c.chat.open('one', 't7')
  c.plain(terminal('t7', 700, 'done', { state: 'finished' }))
  await assert.rejects(() => c.chat.read('one', 't7'), /not running/)
  c.plain(terminal('t7', 700))
  await c.chat.open('one', 't7')
  for (const method of ['read', 'open']) {
    const pending = Promise.withResolvers()
    c.pause(pending.promise)
    const reply = c.chat[method]('one', 't7')
    c.chat.close('one', 't7')
    pending.resolve()
    await assert.rejects(reply, /not open/)
    c.pause(undefined)
    await c.chat.open('one', 't7')
  }
})

const event = async reader => {
  const { value } = await reader.read()
  const [, name, data] = /^event: (\w+)\ndata: (.*)\n\n$/.exec(new TextDecoder().decode(value)) ?? []
  assert.ok(name, 'one SSE item per chunk')
  return { name, data: name === 'data' ? Buffer.from(data, 'base64').toString() : JSON.parse(data) }
}

test('stream admission refuses a replacement on the attach connection, on the same or a different core', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  for (const [core, created] of [[CORE, 701], ['other-core', 700]]) {
    const attach = t.mock.fn()
    let calls = 0
    const connect = async () => (++calls === 1
      ? { ...connection([]), call: async () => terminal('t7', 700) }
      : { ...connection([], core), call: async () => terminal('t7', created), attach })
    const response = await openPaneStream({ url: 'http://x/code/stream?bot=' + ONE, env: f.env, connect })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'no-pane' })
    assert.equal(attach.mock.callCount(), 0)
  }
})

test('resize rechecks the binding on the existing stream and refuses a replacement before reattaching', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  let created = 700
  let watching
  const attach = t.mock.fn(async () => ({ channel: 7, terminal: terminal('t7', created) }))
  const connect = async () => ({
    ...connection([]), call: async () => terminal('t7', created), attach,
    watch(_channel, handlers) { watching = handlers }, detach() {}, credit() {},
  })
  const response = await openPaneStream({ url: 'http://x/code/stream?bot=' + ONE, env: f.env, connect })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal((await event(reader)).name, 'pane')
  watching.onData(Buffer.from('paint'))
  assert.deepEqual(await event(reader), { name: 'data', data: 'paint' })
  created = 701
  f.attach(binding(ONE, 't7', created))
  watching.onResize()
  // A real observer's debounce timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => clearTimeout(keepAlive))
  assert.deepEqual(await event(reader), { name: 'close', data: { reason: 'no-pane' } })
  assert.equal(attach.mock.callCount(), 1)
})

test('the observer discards early frames for an absent, incomplete or mismatched attach identity', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  const pane = terminal('t7', 700)
  for (const reply of [null, { address: 't7' }, terminal('t8', 700), terminal('t7', 701)]) {
    const watch = t.mock.fn((_channel, handlers) => handlers.onData(Buffer.from('foreign bytes')))
    const detach = t.mock.fn()
    const connect = async () => ({ ...connection([pane]), watch, detach, attach: async () => ({ channel: 7, terminal: reply }) })
    const response = await openPaneStream({ url: 'http://x/code/stream?bot=' + ONE, env: f.env, connect })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'no-pane' })
    assert.equal(watch.mock.callCount(), 0)
    assert.deepEqual(detach.mock.calls.map(call => call.arguments), [[7]])
  }
})

test('the observer forwards no data if its worker becomes another Bot’s seat during attach', async (t) => {
  const f = fixture(t)
  f.workers(f.worker(ONE, 't7', 700))
  const pane = terminal('t7', 700)
  const watch = t.mock.fn((_channel, handlers) => handlers.onData(Buffer.from('foreign bytes')))
  const detach = t.mock.fn()
  const connect = async () => ({
    ...connection([pane]), watch, detach, credit() {},
    async attach() {
      await Promise.resolve()
      f.attach(binding(TWO))
      return { channel: 7, terminal: pane }
    },
  })
  const response = await openPaneStream({ url: `http://x/code/stream?bot=${ONE}&worker=t7`, env: f.env, connect })
  if (response.status === 200) t.after(() => response.body.cancel())
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'no-pane' })
  assert.equal(watch.mock.callCount(), 0)
  assert.deepEqual(detach.mock.calls.map(call => call.arguments), [[7]])
})

test('the observer rechecks ownership when its delayed first paint arrives', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  const pane = terminal('t7', 700)
  let paint
  const connect = async () => ({
    ...connection([pane]), detach() {}, credit() {},
    attach: async () => ({ channel: 7, terminal: pane }),
    watch: (_channel, handlers) => { paint = handlers.onData },
  })
  const response = await openPaneStream({ url: `http://x/code/stream?bot=${ONE}`, env: f.env, connect })
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal((await event(reader)).name, 'pane')
  f.attach(binding(TWO))
  paint(Buffer.from('foreign bytes'))
  assert.deepEqual(await event(reader), { name: 'close', data: { reason: 'no-pane' } })
  assert.equal((await reader.read()).done, true)
})

test('the observer reuses an unchanged ledger and stops before forwarding a reassigned worker’s later frame', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE, 't8', 800))
  f.workers(f.worker(ONE, 't7', 700))
  const pane = terminal('t7', 700)
  let paint
  const detach = t.mock.fn()
  const readFile = t.mock.fn(readFileSync)
  const ledgerReads = () => readFile.mock.calls.filter(call => call.arguments[0] === attachPath(f.root)).length
  const connect = async () => ({
    ...connection([pane]), detach, credit() {},
    attach: async () => ({ channel: 7, terminal: pane }),
    watch: (_channel, handlers) => { paint = handlers.onData },
  })
  const response = await openPaneStream({ url: `http://x/code/stream?bot=${ONE}&worker=t7`, env: f.env, connect, readFile })
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal((await event(reader)).name, 'pane')
  const beforePaint = ledgerReads()
  paint(Buffer.from('original bytes'))
  assert.deepEqual(await event(reader), { name: 'data', data: 'original bytes' })
  assert.equal(ledgerReads(), beforePaint)
  f.attach(binding(ONE, 't8', 800), binding(TWO))
  paint(Buffer.from('foreign bytes'))
  assert.deepEqual(await event(reader), { name: 'close', data: { reason: 'no-pane' } })
  assert.equal((await reader.read()).done, true)
  assert.equal(ledgerReads(), beforePaint + 1)
  assert.deepEqual(detach.mock.calls.map(call => call.arguments), [[7]])
})

test('resize discards the reattach channel when its reply names a recycled terminal', async (t) => {
  const f = fixture(t)
  f.attach(binding(ONE))
  const pane = terminal('t7', 700)
  let watching
  const detach = t.mock.fn()
  let attaches = 0
  const attach = t.mock.fn(async () => ++attaches === 1
    ? { channel: 7, terminal: pane } : { channel: 8, terminal: terminal('t7', 701) })
  const watch = t.mock.fn((channel, handlers) => {
    watching = handlers
    handlers.onData(Buffer.from(channel === 7 ? 'original paint' : 'foreign paint'))
  })
  const connect = async () => ({ ...connection([pane]), attach, detach, watch, credit() {} })
  const response = await openPaneStream({ url: 'http://x/code/stream?bot=' + ONE, env: f.env, connect })
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal((await event(reader)).name, 'pane')
  assert.deepEqual(await event(reader), { name: 'data', data: 'original paint' })
  watching.onResize()
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => clearTimeout(keepAlive))
  assert.deepEqual(await event(reader), { name: 'close', data: { reason: 'no-pane' } })
  assert.equal(watch.mock.callCount(), 1)
  assert.deepEqual(detach.mock.calls.map(call => call.arguments), [[7], [8]])
})

test('owner list, chat and observer routes do only the allowed reads and paint the requested panes', async (t) => {
  const f = fixture(t)
  const probe = coreProbeStandIn(t, f.root)
  pipeHcThroughWorker(t, FRAMED, PLAIN)
  f.env.FAKE_CORE_RESIZE_TO = '90x30'
  f.env.FAKE_CORE_KEEP_OPEN = '1'
  f.useEnv()
  const main = terminal('t7', 700)
  const worker = terminal('t9', 900)
  f.attach(binding(ONE))
  f.workers(f.worker(ONE, 't9', 900))
  writeFileSync(f.env.FAKE_CORE_TERMINALS, JSON.stringify([main, worker]))
  writeFileSync(f.env.FAKE_HC_STATE, JSON.stringify({ terminals: [main], screens: { t7: 'fixture screen' } }))
  const { call, request } = host(t, f, { connect: connectCore })

  const listed = await call('seat-chat-list')
  assert.equal(listed.value.seats[0].terminal, 't7')
  assert.deepEqual(rowsAt(f.env.FAKE_HC_LOG), [], 'listing never checks or creates the plain engine')
  const payload = { client: 'test-window', terminal: 't7' }
  const opened = (await call('seat-chat-open', { payload })).value
  assert.equal(opened.seat.id, ONE)
  let face
  const painted = value => JSON.stringify(value?.screen ?? []).includes('fixture screen')
  const deadline = Date.now() + 5000
  do {
    face = (await call('seat-chat-read', { payload })).value
    if (painted(face)) break
    await wait(50)
  } while (Date.now() < deadline)
  assert.ok(painted(face), `the read face received data from the fake: ${JSON.stringify(face?.screen)}`)
  assert.deepEqual((await call('seat-chat-close', { payload: { ...payload, generation: opened.generation } })).value, { closed: true })
  for (const args of ['bot=' + ONE, 'bot=' + ONE + '&worker=t9']) {
    const response = await request(CODE_STREAM_ROUTE + '?' + args)
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    assert.equal((await event(reader)).name, 'pane')
    assert.match((await event(reader)).data, /fake-pane/)
    assert.deepEqual(await event(reader), { name: 'reset', data: { cols: 90, rows: 30 } })
    assert.match((await event(reader)).data, /resized-paint/)
    await reader.cancel()
  }

  const plain = rowsAt(f.env.FAKE_HC_LOG)
  assert.equal(plain.filter(row => row.method === '--version').length, 1)
  const methods = plain.filter(row => row.method !== '--version')
  assert.ok(methods.some(row => row.method === 'terminal.read'))
  assert.ok(methods.every(row => ['hello', 'events.subscribe', 'terminal.get', 'terminal.read', 'file.read'].includes(row.method)))
  assert.ok(methods.every(row => !Object.hasOwn(row.params ?? {}, 'on') && (!row.params?.terminal || row.params.terminal === 't7')))

  const framed = rowsAt(f.env.FAKE_CORE_LOG).filter(row => row.dir === 'in')
  assert.ok(probe.requests.length > 0)
  assert.ok(probe.requests.every(row => row.method === 'server.status'))
  const calls = framed.filter(row => row.type === 'call')
  assert.deepEqual(calls.filter(row => row.method === 'terminal.attach').map(row => [row.params.terminal, row.params.observe]), [['t7', true], ['t7', true], ['t9', true], ['t9', true]])
  assert.ok(calls.every(row => !Object.hasOwn(row.params ?? {}, 'on')))
  assert.ok(calls.every(row => ['hello', 'terminal.list', 'terminal.get', 'terminal.attach'].includes(row.method)))
  assert.ok(framed.filter(row => row.type === 'frame').every(row => row.channel === 0 ? row.kind === 0 : [1, 2].includes(row.kind)))
})
