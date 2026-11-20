// Typing into a watched pane (RFC 0030 delivery 2's first half): owner only, one viewer per
// pane, keystrokes never recorded, and no start, stop, resize or kill. Every core here is the
// test's own fake (fixtures/fake-hc-core.mjs), never a live Herdr and never a real pane.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createTypingService, typingRoutes } from '../src/host/code-typing.js'
import { verifiedWindow } from '../src/host/desktop-window.js'
import { connectCore } from '../src/host/code-core.js'
import { coreProbeFixture } from './fixtures/fake-core-probe.mjs'

const WINDOW = 'ab'.repeat(32)
const DIGEST = createHash('sha256').update(WINDOW, 'ascii').digest('hex')
const WINDOW_HEADERS = { 'x-automagik-window': WINDOW }

const FAKE = fileURLToPath(new URL('./fixtures/fake-hc-core.mjs', import.meta.url))
const LEAD = 'b-aaaaaaaaaa'
const DEV = 'b-bbbbbbbbbb'
const CORE = 'core-test'
const TERMINALS = [
  { address: 't7', created_ms: 700, state: 'live', cols: 120, rows: 40, status: 'idle' },
  { address: 't8', created_ms: 800, state: 'live', cols: 100, rows: 30, status: 'working' },
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-code-typing-'))
  // A plugin's own writes can still be in flight when the test ends: retry the tree removal.
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const automagikHome = join(root, 'automagik')
  const appHome = join(root, 'herdr-app')
  const ledgerDir = join(appHome, 'automagik-herdr')
  mkdirSync(join(automagikHome, 'bots'), { recursive: true })
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(automagikHome, 'bots', 'bots.json'), JSON.stringify({
    version: 2,
    projects: [{ folder: project }],
    shown: [{ project, bots: [LEAD, DEV] }],
    bots: [
      { id: LEAD, name: 'Atlas', main: true, folder: project },
      { id: DEV, name: 'Dev', folder: project },
    ],
  }))
  const at = '2026-11-15T00:00:00.000Z'
  writeFileSync(join(ledgerDir, 'attach.jsonl'), [
    { v: 1, event: 'attach', bot: LEAD, project, terminal: 't7', core: CORE, created_ms: 700, machine: null, at, by: 'start' },
    { v: 1, event: 'attach', bot: DEV, project, terminal: 't8', core: CORE, created_ms: 800, machine: null, at, by: 'start' },
  ].map(row => `${JSON.stringify(row)}\n`).join(''))
  writeFileSync(join(ledgerDir, 'workers.jsonl'), '')
  const terminalsFile = join(root, 'terminals.json')
  writeFileSync(terminalsFile, JSON.stringify(TERMINALS))
  const log = join(root, 'core.log')
  const recordPath = join(root, 'typing.jsonl')
  const probeEnv = coreProbeFixture(t, root)
  const env = {
    ...process.env,
    ...probeEnv,
    AUTOMAGIK_WINDOW_DIGEST: DIGEST,
    HOME: root,
    AUTOMAGIK_HOME: automagikHome,
    HERDR_APP_HOME: appHome,
    HERDR_HC: FAKE,
    FAKE_CORE_LOG: log,
    FAKE_CORE_TERMINALS: terminalsFile,
    FAKE_CORE_KEEP_OPEN: '1',
  }
  return { root, project, env, probeEnv, log, recordPath }
}

const readLog = (path) => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}
const wait = async (check, ms = 5000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}
const service = (f, { admit = () => ({}), ...more } = {}) => createTypingService({ env: f.env, admit, recordPath: f.recordPath, warn: () => {}, ...more })
const request = () => ({ headers: new Headers({ 'content-type': 'application/json', host: '127.0.0.1' }) })

test('take, type one batch, release: the keys reach the core and appear in no record', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(taken.status, 200)
  assert.equal(taken.body.mode, 'typing')
  const attachCall = readLog(f.log).find(row => row.type === 'call' && row.method === 'terminal.attach')
  assert.equal(attachCall?.params?.observe, false, 'the typing attach is not a watcher')
  const answer = await typing.input({ request: request(), session: taken.body.session, data: Buffer.from('hello', 'utf8').toString('base64') })
  assert.equal(answer.status, 204)
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 0 && Buffer.from(row.payload, 'base64').toString() === 'hello')), 'the batch reaches the core as DATA, byte for byte')
  const frames = readLog(f.log).filter(row => row.type === 'frame' && row.channel === 7)
  assert.equal(frames.filter(row => row.kind === 0).length, 1, 'one batch, no Enter pressed by itself')
  assert.equal(frames.filter(row => row.kind === 3).length, 0, 'no resize ever leaves the app')
  const record = readFileSync(f.recordPath, 'utf8')
  assert.match(record, /"event":"take"/)
  assert.doesNotMatch(record, /hello/, 'keystrokes are never written to the record')
  assert.doesNotMatch(record, /aGVsbG8/, 'not even their base64')
  assert.equal((await typing.release({ request: request(), session: taken.body.session })).status, 200)
  assert.match(readFileSync(f.recordPath, 'utf8'), /"event":"release"/)
})

test('one typing viewer per pane: a second window is refused while the first holds it', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  assert.equal((await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })).status, 200)
  const second = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-2' })
  assert.equal(second.status, 409)
  assert.equal(second.body.error, 'typing-elsewhere')
})

test('a window that takes another Bot lets the first go', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  const first = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal((await typing.take({ request: request(), bot: DEV, viewer: 'viewer-1' })).status, 200)
  assert.equal(typing.sessions().length, 1)
  assert.equal((await typing.input({ request: request(), session: first.body.session, data: 'aA==' })).status, 409, 'the old pane is no longer taking input')
})

test('input needs a live session, a known viewer and a real batch', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  assert.equal((await typing.input({ request: request(), session: 'nope', data: 'aA==' })).status, 409)
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal((await typing.input({ request: request(), session: 'nope', data: 'aA==' })).status, 409)
  assert.equal((await typing.input({ request: request(), session: taken.body.session, data: '' })).status, 400)
  assert.equal((await typing.input({ request: request(), session: taken.body.session, data: 'not base64!' })).status, 400)
  assert.equal((await typing.input({ request: request(), session: taken.body.session, data: Buffer.alloc(20 * 1024, 65).toString('base64') })).status, 413)
})

test('an expired or signed-out session is refused at the next batch and the attach closes', async (t) => {
  const f = fixture(t)
  let live = true
  const typing = service(f, { admit: () => (live ? {} : { rejection: 401 }) })
  t.after(() => typing.dispose())
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(taken.status, 200)
  live = false
  assert.equal((await typing.input({ request: request(), session: taken.body.session, data: 'aA==' })).status, 401)
  assert.equal(typing.sessions().length, 0, 'the typing attach is let go at once')
  assert.equal((await typing.input({ request: request(), session: taken.body.session, data: 'aA==' })).status, 401)
})

test('disposing the typing service lets every attach go', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(taken.status, 200)
  await typing.dispose()
  assert.equal(typing.sessions().length, 0)
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the core gets its CLOSE when the host lets go')
})

test('the same refusals as the watch route: a foreign worker, an unregistered Bot, no viewer', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  assert.equal((await typing.take({ request: request(), bot: LEAD, worker: 't8', viewer: 'viewer-1' })).status, 404, 'another Bot worker is not this Bot pane')
  assert.equal((await typing.take({ request: request(), bot: 'b-dddddddddd', viewer: 'viewer-1' })).status, 404)
  assert.equal((await typing.take({ request: request(), bot: LEAD, viewer: '' })).status, 400)
})

test('owner only: the take route is an exact Fetch route DSH answers only for the owner Peer', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  const routes = typingRoutes(typing, req => verifiedWindow(req, f.env))
  assert.deepEqual(routes.map(([path]) => path), ['/api/omni-ui/code/take', '/api/omni-ui/code/input', '/api/omni-ui/code/release'])
  const take = routes[0][1]
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, { path: '/api/omni-ui/code/take', methods: ['POST'], requestBody: 'buffered', fetch: take })
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = () => new Request('http://127.0.0.1/api/omni-ui/code/take', { method: 'POST', headers: { ...WINDOW_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ bot: LEAD, viewer: 'viewer-1' }) })
  const viewer = { principal: { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } } }
  const botSession = { principal: { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' } }
  assert.equal((await handler.fetch(request(), viewer)).status, 403)
  assert.equal((await handler.fetch(request(), botSession)).status, 403)
  assert.equal((await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })).status, 200, 'the owner reaches it')
})

test('releaseViewer lets a viewer\'s attach go when its watch stream ends', async (t) => {
  const f = fixture(t)
  const typing = service(f)
  t.after(() => typing.dispose())
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(taken.status, 200)
  assert.deepEqual(await typing.releaseViewer('viewer-1'), { released: true })
  assert.equal(typing.sessions().length, 0)
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the core gets its CLOSE when the viewer goes')
  assert.deepEqual(await typing.releaseViewer('viewer-1'), { released: false })
})

test('a real Cordis plugin stop lets the typing attach go', async (t) => {
  const f = fixture(t)
  const team = join(f.root, 'team')
  mkdirSync(team, { recursive: true })
  const saved = {}
  const env = {
    ...f.probeEnv,
    AUTOMAGIK_WINDOW_DIGEST: DIGEST,
    HOME: f.root,
    AUTOMAGIK_HOME: join(f.root, 'automagik'),
    AUTOMAGIK_BOTS_HOME: team,
    AUTOMAGIK_APP_BROWSER: '1',
    HERDR_APP_HOME: join(f.root, 'herdr-app'),
    HERDR_HC: FAKE,
    FAKE_CORE_TERMINALS: join(f.root, 'terminals.json'),
    FAKE_CORE_LOG: f.log,
    FAKE_CORE_KEEP_OPEN: '1',
  }
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value }
  const send = process.send
  process.send = () => true
  t.after(() => {
    if (send === undefined) delete process.send
    else process.send = send
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  // The plugin is applied for real: a real Cordis Context, its inject list satisfied with
  // stand-ins for DSH's services only, and the plugin loaded as a plugin.
  const { Context } = await import('@deepseek-ai/cordis')
  const plugin = await import('../index.js')
  const { fakeContext } = await import('./fake-ctx.js')
  const stub = fakeContext({})
  const root = new Context()
  const services = {
    tools: stub.tools,
    systemPrompt: stub.systemPrompt,
    llm: stub.llm,
    connection: Object.assign(stub.connection, { admit: () => ({}) }),
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, flush: async () => {} },
    sessionController: {},
    sessionTitle: {},
    workspaceRegistry: { list: () => [] },
  }
  for (const [name, value] of Object.entries(services)) root.provide(name, value)
  let takeRoute = null
  let releaseRoute = null
  const register = stub.connection.fetch.register
  stub.connection.fetch.register = (options) => {
    if (options.path === '/api/omni-ui/code/take') takeRoute = options
    if (options.path === '/api/omni-ui/code/release') releaseRoute = options
    return register(options)
  }
  const fork = root.plugin(plugin, { home: team, browserPlugin: false })
  await fork
  assert.ok(takeRoute, 'the take route is registered in the real plugin scope')
  const response = await takeRoute.fetch(new Request('http://127.0.0.1/api/omni-ui/code/take', {
    method: 'POST',
    headers: { ...WINDOW_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ bot: LEAD, viewer: 'viewer-1' }),
  }))
  assert.equal(response.status, 200)
  const taken = await response.json()
  await fork.dispose()
  const closed = await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2))
  // A scope that does not stop its typing attach would leave an open core; let it go before
  // failing with the reason.
  if (!closed && releaseRoute) await releaseRoute.fetch(new Request('http://127.0.0.1/api/omni-ui/code/release', { method: 'POST', headers: { ...WINDOW_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ session: taken.session }) })).catch(() => {})
  assert.ok(closed, 'stopping the real plugin scope sends CLOSE for the typing attach')
  await new Promise(resolve => setTimeout(resolve, 100))
})

test('two takes racing for one pane: exactly one wins, one 409, one attach', async (t) => {
  const f = fixture(t)
  // A slow connect holds both takes between the one-typer check and the reservation, the
  // window the reviewer used to get two winners.
  const typing = service(f, { connect: async (options) => { await new Promise(resolve => setTimeout(resolve, 60)); return connectCore(options) } })
  t.after(() => typing.dispose())
  const takes = await Promise.all([
    typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' }),
    typing.take({ request: request(), bot: LEAD, viewer: 'viewer-2' }),
  ])
  assert.deepEqual(takes.map(taken => taken.status).sort(), [200, 409], 'one take wins, the other is refused')
  assert.equal(takes.filter(taken => taken.status === 200).length, 1)
  assert.equal(readLog(f.log).filter(row => row.type === 'call' && row.method === 'terminal.attach').length, 1, 'the core gets one typing attach')
})

test('a quiet window lets its typing attach go on its own (idle lease)', async (t) => {
  const f = fixture(t)
  const typing = service(f, { idleMs: 150 })
  t.after(() => typing.dispose())
  const taken = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(taken.status, 200)
  // DSH's own admission refuses a request with no owner cookie before the plugin's route
  // runs; that request never reaches the service. The lease alone must let the attach go.
  const receiver = Object.create(HostConnectionService.prototype)
  receiver.trustedHosts = []
  receiver.disposed = false
  receiver.owner = { get: () => ({ host: '127.0.0.1', protocol: 'http:' }) }
  receiver.browserAuth = { isAuthenticated: () => false, authenticateApi: () => undefined }
  receiver.browserPeer = { id: 'owner' }
  receiver.peers = new Map()
  assert.equal(HostConnectionService.prototype.admit.call(receiver, { headers: { host: '127.0.0.1' } }).rejection, 401, 'the real admit refuses a batch with no owner cookie')
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the idle lease sends the core its CLOSE')
  assert.equal(typing.sessions().length, 0)
  const after = await typing.input({ request: request(), session: taken.body.session, data: Buffer.from('x', 'utf8').toString('base64') })
  assert.equal(after.status, 409, 'a later owner batch no longer types')
})

test('after the idle lease ends typing, the same viewer takes it again in place', async (t) => {
  const f = fixture(t)
  const typing = service(f, { idleMs: 120 })
  t.after(() => typing.dispose())
  const first = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(first.status, 200)
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the lease ends the first attach')
  const stale = await typing.input({ request: request(), session: first.body.session, data: Buffer.from('x', 'utf8').toString('base64') })
  assert.equal(stale.status, 409, 'the old session no longer types')
  const again = await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })
  assert.equal(again.status, 200, 'the same watch takes the pane again')
  const answer = await typing.input({ request: request(), session: again.body.session, data: Buffer.from('hello', 'utf8').toString('base64') })
  assert.equal(answer.status, 204)
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 0 && Buffer.from(row.payload, 'base64').toString() === 'hello')), 'the next key lands in the new attach')
})
