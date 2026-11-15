// Typing into a watched pane (RFC 0030 delivery 2's first half): owner only, one viewer per
// pane, keystrokes never recorded, and no start, stop, resize or kill. Every core here is the
// test's own fake (fixtures/fake-hc-core.mjs), never a live Herdr and never a real pane.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createTypingService, typingRoutes } from '../src/host/code-typing.js'

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
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
  const env = {
    ...process.env,
    HOME: root,
    AUTOMAGIK_HOME: automagikHome,
    HERDR_APP_HOME: appHome,
    HERDR_HC: FAKE,
    FAKE_CORE_LOG: log,
    FAKE_CORE_TERMINALS: terminalsFile,
    FAKE_CORE_KEEP_OPEN: '1',
  }
  return { root, project, env, log, recordPath }
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
const service = (f, { admit = () => ({}) } = {}) => createTypingService({ env: f.env, admit, recordPath: f.recordPath, warn: () => {} })
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
  const routes = typingRoutes(typing)
  assert.deepEqual(routes.map(([path]) => path), ['/api/omni-ui/code/take', '/api/omni-ui/code/input', '/api/omni-ui/code/release'])
  const take = routes[0][1]
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, { path: '/api/omni-ui/code/take', methods: ['POST'], requestBody: 'buffered', fetch: take })
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = () => new Request('http://127.0.0.1/api/omni-ui/code/take', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bot: LEAD, viewer: 'viewer-1' }) })
  const viewer = { principal: { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } } }
  const botSession = { principal: { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' } }
  assert.equal((await handler.fetch(request(), viewer)).status, 403)
  assert.equal((await handler.fetch(request(), botSession)).status, 403)
  assert.equal((await typing.take({ request: request(), bot: LEAD, viewer: 'viewer-1' })).status, 200, 'the owner reaches it')
})
