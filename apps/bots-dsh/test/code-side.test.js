// The Code side's host half (RFC 0030 delivery 1): the tree from the registry and the two
// ledgers, the framed core bridge, and one owner-only pane stream that watches this
// computer's own terminal. Every core here is the test's own fake (`fixtures/fake-hc-core.mjs`):
// no live herdr, no real pane, no real team.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import * as plugin from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { foldAttach, readAttach } from '../src/shared/attach-record.js'
import { HOME_PATH, REPO_PATH } from '../src/shared/registry.js'
import { foldWorkers, readWorkers } from '../src/shared/workers-journal.js'
import { buildCodeTree, readCodeTree, readRegistryTree, resolvePane, statusWord } from '../src/host/code-tree.js'
import { connectCore } from '../src/host/code-core.js'
import { CODE_STREAM_ROUTE, CODE_TREE_ENDPOINT, install, openPaneStream, streamAdmission, streamTarget } from '../src/host/code-side.js'
import { CODE_INPUT_ROUTE, CODE_RELEASE_ROUTE, CODE_TAKE_ROUTE } from '../src/host/code-typing.js'
import { install as installHooks } from '../src/host/extend.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-hc-core.mjs', import.meta.url))
const LEAD = 'b-aaaaaaaaaa'
const DEV = 'b-bbbbbbbbbb'
const ELSEWHERE = 'b-cccccccccc'
const CORE = 'core-test'

const TERMINALS = [
  { address: 't7', created_ms: 700, state: 'live', cols: 120, rows: 40, status: 'idle', agent: 'claude-code' },
  { address: 't8', created_ms: 800, state: 'live', cols: 100, rows: 30, status: 'working', agent: 'claude-code' },
  { address: 't9', created_ms: 900, state: 'live', cols: 90, rows: 25, status: 'blocked', agent: 'claude-code' },
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-code-side-'))
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
    bots: [
      { id: LEAD, name: 'Atlas', role: 'lead', agent: 'claude', main: true, folder: project },
      { id: DEV, name: 'Dev', role: 'dev', agent: 'claude', folder: project },
      { id: ELSEWHERE, name: 'Remote', role: 'dev', agent: 'claude', folder: '/srv/remote', machine: 'lab' },
    ],
  }))
  const at = '2026-11-15T00:00:00.000Z'
  const attachRows = [
    { v: 1, event: 'attach', bot: LEAD, project, terminal: 't7', core: CORE, created_ms: 700, machine: null, at, by: 'start' },
    { v: 1, event: 'attach', bot: DEV, project, terminal: 't8', core: CORE, created_ms: 800, machine: null, at, by: 'start' },
  ]
  writeFileSync(join(ledgerDir, 'attach.jsonl'), attachRows.map(row => `${JSON.stringify(row)}\n`).join(''))
  writeFileSync(join(ledgerDir, 'workers.jsonl'), [
    { event: 'start', kind: 'worker', terminal: 't9', botId: LEAD, lead: LEAD, role: 'reviewer', agent: 'claude', model: null, branch: 'feat/one', project, worktree: project, core: CORE, created_ms: 900, at },
    { event: 'start', kind: 'worker', terminal: 't8', botId: DEV, lead: LEAD, role: 'dev', agent: 'claude', model: null, branch: 'feat/other', project, worktree: project, core: CORE, created_ms: 800, at },
    { event: 'start', kind: 'worker', terminal: 't6', botId: LEAD, lead: LEAD, role: 'dev', agent: 'claude', model: null, branch: 'feat/gone', project, worktree: project, core: CORE, created_ms: 600, at },
    { event: 'end', kind: 'worker', terminal: 't6', core: CORE, created_ms: 600, reason: 'finished', at },
  ].map(row => `${JSON.stringify(row)}\n`).join(''))
  const terminalsFile = join(root, 'terminals.json')
  writeFileSync(terminalsFile, JSON.stringify(TERMINALS))
  const log = join(root, 'core.log')
  const env = {
    ...process.env,
    HOME: root,
    AUTOMAGIK_HOME: automagikHome,
    HERDR_APP_HOME: appHome,
    HERDR_HC: FAKE,
    FAKE_CORE_LOG: log,
    FAKE_CORE_TERMINALS: terminalsFile,
  }
  return { root, project, automagikHome, appHome, ledgerDir, env, log, terminalsFile }
}

const readLog = (path) => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch { return [] }
}

const wait = async (check, ms = 5000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

test('the attach ledger is a byte-equal copy of the pack source, never a rewrite', () => {
  const source = readFileSync(new URL('../../../herdr/mods/am-sidebar/attach.js', import.meta.url))
  const copy = readFileSync(new URL('../src/shared/attach-record.js', import.meta.url))
  assert.ok(source.equals(copy), 'src/shared/attach-record.js must stay byte-equal to herdr/mods/am-sidebar/attach.js')
})

test('the workers ledger folds a start, a session and an end; workers of a Bot are its own', () => {
  const at = '2026-11-15T00:00:00.000Z'
  const { rows } = readWorkers([
    { event: 'start', kind: 'seat', terminal: 't7', botId: LEAD, core: CORE, created_ms: 700, at },
    { event: 'start', kind: 'worker', terminal: 't9', botId: LEAD, role: 'dev', core: CORE, created_ms: 900, at },
    { event: 'session', terminal: 't9', session: 'sess-1', at },
    { event: 'start', kind: 'worker', terminal: 't6', botId: LEAD, role: 'dev', core: CORE, created_ms: 600, at },
    { event: 'end', kind: 'worker', terminal: 't6', core: CORE, created_ms: 600, reason: 'finished', at },
    'not json',
  ].map(row => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n'))
  const open = foldWorkers(rows)
  assert.equal(open.size, 1, 'only the worker with no end row is open, never a seat')
  const worker = [...open.values()][0]
  assert.equal(worker.terminal, 't9')
  assert.equal(worker.role, 'dev')
  assert.equal(worker.session, 'sess-1')
})

test('the tree: projects, the main Bot first, workers under their Bot, this computer only', async (t) => {
  const f = fixture(t)
  const attachRows = readAttach(readFileSync(join(f.ledgerDir, 'attach.jsonl'), 'utf8')).rows
  const { rows: workerRows } = readWorkers(readFileSync(join(f.ledgerDir, 'workers.jsonl'), 'utf8'))
  const terminals = new Map(TERMINALS.map(terminal => [terminal.address, terminal]))
  const registry = {
    bots: [
      { id: LEAD, name: 'Atlas', role: 'lead', agent: 'claude', main: true, folder: f.project },
      { id: DEV, name: 'Dev', role: 'dev', agent: 'claude', folder: f.project },
    ],
    projects: [{ folder: f.project }],
  }
  const read = readRegistryTree({ env: f.env })
  assert.equal(read.bots.some(bot => bot.id === ELSEWHERE), false, 'a Bot on a linked machine is never this computer')
  const tree = buildCodeTree({ ...registry, attach: { rows: attachRows, fold: foldAttach(attachRows) }, workers: foldWorkers(workerRows), terminals, core: { id: CORE, name: 'test-machine' } })
  assert.equal(tree.machine.core, CORE)
  assert.equal(tree.projects.length, 1)
  const project = tree.projects[0]
  assert.equal(project.folder, f.project)
  assert.equal(project.bots[0].id, LEAD, 'the main Bot comes first')
  assert.equal(project.bots[0].terminal.id, 't7')
  assert.equal(project.bots[0].status, 'idle')
  assert.deepEqual(project.bots[0].workers.map(worker => [worker.terminal, worker.status, worker.role]), [['t9', 'needs-you', 'reviewer']])
  assert.equal(project.bots[1].id, DEV)
  assert.equal(project.bots[1].terminal.id, 't8')
  assert.equal(project.bots[1].status, 'working')
  // A binding another core wrote is not this computer's pane, even when its terminal id exists.
  const foreign = foldAttach([{ v: 1, event: 'attach', bot: DEV, project: f.project, terminal: 't8', core: 'other-core', created_ms: 800, machine: null, at: new Date().toISOString(), by: 'start' }])
  const other = buildCodeTree({ ...registry, attach: { rows: [], fold: foreign }, workers: new Map(), terminals, core: { id: CORE, name: 'test-machine' } })
  assert.equal(other.projects[0].bots.find(bot => bot.id === DEV).terminal, null)
  assert.equal(other.projects[0].bots.find(bot => bot.id === DEV).status, 'not-running')
})

test('a project on a linked machine never reads the repo registry at its local path', (t) => {
  const f = fixture(t)
  const homePath = join(f.automagikHome, HOME_PATH)
  const remoteFolder = join(f.root, 'remote-project')
  const remoteRegistry = join(remoteFolder, REPO_PATH)
  const home = JSON.parse(readFileSync(homePath, 'utf8'))
  home.projects.push({ folder: remoteFolder, machine: 'lab' })
  writeFileSync(homePath, JSON.stringify(home))
  mkdirSync(dirname(remoteRegistry), { recursive: true })
  writeFileSync(remoteRegistry, JSON.stringify({ version: 2, bots: [{ id: ELSEWHERE, name: 'Remote project Bot' }] }))

  const readFile = t.mock.fn(readFileSync)
  const { projects, bots } = readRegistryTree({ env: f.env, readFile })
  assert.deepEqual(projects, [{ folder: f.project }])
  assert.equal(bots.some(bot => bot.id === ELSEWHERE), false)
  assert.equal(readFile.mock.calls.some(({ arguments: [path] }) => path === remoteRegistry), false)
})

test('a global Bot with no folder is a seat: the tree lists it and its pane resolves', async (t) => {
  const f = fixture(t)
  const GLOBAL = 'b-dddddddddd'
  const at = '2026-11-16T00:00:00.000Z'
  writeFileSync(join(f.automagikHome, 'bots', 'bots.json'), JSON.stringify({
    version: 2,
    projects: [{ folder: f.project }],
    bots: [
      { id: LEAD, name: 'Atlas', role: 'lead', agent: 'claude', main: true, folder: f.project },
      // RFC 0014: a home-file Bot with no folder. RFC 0022 lists it as a seat.
      { id: GLOBAL, name: 'General Orchestrator', role: 'lead', agent: 'claude' },
    ],
  }))
  writeFileSync(join(f.ledgerDir, 'attach.jsonl'), [
    { v: 1, event: 'attach', bot: LEAD, project: f.project, terminal: 't7', core: CORE, created_ms: 700, machine: null, at, by: 'start' },
    { v: 1, event: 'attach', bot: GLOBAL, project: null, terminal: 't10', core: CORE, created_ms: 1000, machine: null, at, by: 'start' },
  ].map(row => `${JSON.stringify(row)}\n`).join(''))
  writeFileSync(f.terminalsFile, JSON.stringify([...TERMINALS, { address: 't10', created_ms: 1000, state: 'live', cols: 110, rows: 34, status: 'working', agent: 'claude-code' }]))
  const read = readRegistryTree({ env: f.env })
  assert.equal(read.bots.find(bot => bot.id === GLOBAL)?.folder, undefined, 'the home file keeps a global Bot folderless')
  const answer = await readCodeTree({ env: f.env })
  assert.ok(answer.tree, 'the tree reads a registry with a global Bot')
  const group = answer.tree.projects.find(project => project.global === true)
  assert.ok(group, 'global Bots have a project-less group of their own')
  assert.deepEqual(group.bots.map(bot => [bot.id, bot.status, bot.terminal?.id]), [[GLOBAL, 'working', 't10']])
  const pane = await resolvePane({ botId: GLOBAL, env: f.env })
  assert.deepEqual(pane && { terminal: pane.terminal, core: pane.core }, { terminal: 't10', core: CORE }, 'the stream resolves the global seat by Bot id')
})

test('the tree words: a blocked or failed terminal needs the person, a missing one is not running', () => {
  assert.equal(statusWord({ status: 'blocked' }), 'needs-you')
  assert.equal(statusWord({ status: 'error' }), 'needs-you')
  assert.equal(statusWord({ status: 'working' }), 'working')
  assert.equal(statusWord({ status: 'done' }), 'idle')
  assert.equal(statusWord(null), 'not-running')
})

test('a pane request names a Bot (or its worker), never a terminal to attach as given', () => {
  assert.deepEqual(streamTarget(`http://x/api/omni-ui/code/stream?bot=${LEAD}`), { bot: LEAD, worker: null, viewer: null })
  assert.deepEqual(streamTarget(`http://x/api/omni-ui/code/stream?bot=${LEAD}&worker=t9`), { bot: LEAD, worker: 't9', viewer: null })
  assert.deepEqual(streamTarget(`http://x/api/omni-ui/code/stream?bot=${LEAD}&viewer=viewer-1`), { bot: LEAD, worker: null, viewer: 'viewer-1' })
  assert.equal(streamTarget(`http://x/api/omni-ui/code/stream?bot=${LEAD}&viewer=x`).error, 'no-viewer')
  assert.equal(streamTarget('http://x/api/omni-ui/code/stream?terminal=t7').error, 'unknown-parameter')
  assert.equal(streamTarget('http://x/api/omni-ui/code/stream?bot=nope').error, 'no-bot')
  assert.equal(streamTarget('http://x/api/omni-ui/code/stream').error, 'no-bot')
  assert.equal(streamTarget(`http://x/api/omni-ui/code/stream?bot=${LEAD}&worker=a&worker=b`).error, 'no-worker')
})

test('a pane request is same-origin and asks for an event stream; a cross-site one is refused', () => {
  const request = (headers) => new Request('http://127.0.0.1/api/omni-ui/code/stream?bot=b-aaaaaaaaaa', { headers })
  assert.equal(streamAdmission(request({ accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' })), null)
  assert.deepEqual(streamAdmission(request({ accept: 'text/event-stream', 'sec-fetch-site': 'cross-site' })), { error: 'cross-site', status: 403 })
  assert.deepEqual(streamAdmission(request({ accept: '*/*' })), { error: 'not-an-event-stream', status: 406 })
})

test('the core bridge speaks the framed protocol, attaches as a watcher and credits what it took', async (t) => {
  const f = fixture(t)
  const core = await connectCore({ env: f.env })
  t.after(() => core.close())
  assert.equal(core.info.core.id, CORE)
  const list = await core.call('terminal.list')
  assert.equal(list.terminals.length, 3)
  const chunks = []
  let closed = null
  const { channel } = await core.attach({ terminal: 't7', cols: 120, rows: 40 })
  core.watch(channel, { onData: bytes => { chunks.push(bytes.toString('utf8')); core.credit(channel, bytes.length) }, onClose: reason => { closed = reason } })
  await wait(() => closed !== null)
  assert.match(chunks.join(''), /fake-pane/)
  assert.equal(closed, 'ended')
  const log = readLog(f.log).filter(row => row.dir === 'in')
  const attach = log.find(row => row.type === 'call' && row.method === 'terminal.attach')
  assert.equal(attach.params.observe, true, 'the pane watches: the core itself refuses input and resize')
  assert.equal(attach.params.cols, 120, 'the attach uses the terminal own size, never the view size')
  assert.equal(attach.params.rows, 40)
  // Credits leave as the pane takes bytes; never a key (DATA on the stream) or a resize.
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 1)), 'the host credited what it took')
  const frames = readLog(f.log).filter(row => row.type === 'frame' && row.channel === 7)
  assert.equal(frames.filter(row => row.kind === 0 || row.kind === 3).length, 0, 'no input (0) and no resize (3) ever leave the watching pane')
})

test('resolvePane confirms the row against the core and refuses everything else', async (t) => {
  const f = fixture(t)
  const lead = await resolvePane({ botId: LEAD, env: f.env })
  assert.deepEqual(lead && { terminal: lead.terminal, cols: lead.cols, rows: lead.rows, core: lead.core }, { terminal: 't7', cols: 120, rows: 40, core: CORE })
  const worker = await resolvePane({ botId: LEAD, worker: 't9', env: f.env })
  assert.equal(worker?.terminal, 't9')
  assert.equal(await resolvePane({ botId: ELSEWHERE, env: f.env }), null, 'a Bot on a linked machine is not this computer')
  assert.equal(await resolvePane({ botId: LEAD, worker: 't7', env: f.env }), null, 'a Bot seat is not one of its worker terminals')
  assert.equal(await resolvePane({ botId: 'b-dddddddddd', env: f.env }), null)
  assert.equal(await resolvePane({ botId: LEAD, worker: 't8', env: f.env }), null, 'another Bot worker is not this Bot pane, even in the same project')
  assert.equal((await resolvePane({ botId: DEV, worker: 't8', env: f.env }))?.terminal, 't8', 'the other Bot may be watched by its own id')
})

test('the pane stream: open, the terminal bytes, and a close, all from the fake core', async (t) => {
  const f = fixture(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await openPaneStream({ url: `http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`, signal: controller.signal, env: f.env })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('event: close')) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  assert.match(text, /event: pane/)
  assert.match(text, /"terminal":"t7"/)
  const data = [...text.matchAll(/event: data\ndata: ([^\n]+)/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8')).join('')
  assert.match(data, /fake-pane/)
  assert.match(data, /second-line/)
  assert.match(text, /event: close/)
  const frames = readLog(f.log).filter(row => row.dir === 'in' && row.type === 'frame' && row.channel === 7)
  assert.ok(frames.length > 0, 'the pane credited the bytes it took')
  assert.equal(frames.filter(row => row.kind === 0 || row.kind === 3).length, 0, 'only credits (and a detach) leave the watching pane: never input or resize')
})

test('a stream ends when its reader goes, detaching the terminal and leaving it running', async (t) => {
  const f = fixture(t)
  const env = { ...f.env, FAKE_CORE_KEEP_OPEN: '1' }
  const controller = new AbortController()
  const response = await openPaneStream({ url: `http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`, signal: controller.signal, env })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the abort closes the stream on the core (CLOSE), never an input or resize frame')
  await reader.cancel().catch(() => {})
})

test('owner only: the exact stream route refuses a share viewer, and an unauthenticated request never reaches it', async (t) => {
  const f = fixture(t)
  let route = null
  const endpoints = new Map()
  const ctx = {
    effect: fn => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    connection: { fetch: { register: options => { route = options; return () => { route = null } } } },
  }
  const rt = { ctx, hooks: { endpoint: (name, fn, options) => { endpoints.set(name, { fn, options }); return () => {} } }, warn: () => {} }
  install(rt, { env: f.env, desktop: true })
  t.after(() => { route = null })
  assert.ok(endpoints.has('code-tree'), 'the tree is a read-only team endpoint')
  assert.equal(endpoints.get('code-tree').options.read, true)
  assert.equal(endpoints.has('code-stream'), false, 'the pane is never an endpoint a Bot tool can call')
  assert.equal(route?.path, '/api/omni-ui/code/stream')
  assert.deepEqual(route.methods, ['GET'])

  // DSH's own shared /api Fetch handler, as the web server mounts it: our exact route in it.
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, route)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = () => new Request('http://127.0.0.1/api/omni-ui/code/stream?bot=b-aaaaaaaaaa', { headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', host: '127.0.0.1' } })
  const viewer = { principal: { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } } }
  // A Bot's own tool call speaks for its Session, never for the owner's window.
  const botSession = { principal: { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' } }
  const owner = { principal: { kind: 'owner' } }
  const refused = await handler.fetch(request(), viewer)
  assert.equal(refused.status, 403)
  assert.equal((await handler.fetch(request(), botSession)).status, 403)
  assert.equal(readLog(f.log).filter(row => row.type === 'call' && row.method === 'terminal.attach').length, 0, 'a Bot or viewer principal never attached anything')
  const allowed = await handler.fetch(request(), owner)
  assert.equal(allowed.status, 200)
  await allowed.body.cancel()

  // The HTTP carrier's own admission: a request with no browser cookie and no API peer is 401.
  const admission = {
    isTrusted: () => true,
    disposed: false,
    browserAuth: { isAuthenticated: () => false, authenticateApi: () => undefined },
    browserPeer: owner,
    owner: { get: () => undefined },
    peers: new Map(),
  }
  assert.equal(HostConnectionService.prototype.admit.call(admission, request()).rejection, 401)
})


/** The stream route as install registers it, with a fake ctx whose Connection can be stopped. */
function startHost(t, env = process.env) {
  let route = null
  let connectionLive = true
  const disposers = []
  const connection = { fetch: { register: (options) => { route = options; return () => { route = null } } } }
  const ctx = {
    effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); return () => {} },
    connection,
    get: name => (name === 'connection' ? (connectionLive ? connection : undefined) : undefined),
  }
  const rt = { ctx, hooks: { endpoint: () => () => {} }, warn: () => {}, home: process.cwd() }
  const off = install(rt, { env, desktop: true })
  t.after(() => { off(); for (const dispose of disposers) { try { dispose() } catch { /* gone */ } } })
  const request = bot => new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${bot}`, { headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } })
  return { request, get route() { return route }, off, stopConnection: () => { connectionLive = false } }
}

const streamAsk = bot => new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${bot}`, { headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } })

test('a refused open frees its stream slot, so refusals never spend the pane budget', async (t) => {
  const f = fixture(t)
  const host = startHost(t, f.env)
  assert.equal((await host.route.fetch(streamAsk('b-dddddddddd'))).status, 404)
  assert.equal((await host.route.fetch(streamAsk('b-dddddddddd'))).status, 404, 'a refused open must not leave its tag behind (409)')
  assert.equal((await host.route.fetch(streamAsk('b-eeeeeeeeee'))).status, 404)
  const live = await host.route.fetch(streamAsk(LEAD))
  assert.equal(live.status, 200, 'two refusals must not keep a real pane from opening (429)')
  await live.body.cancel()
})

test('the plugin stopping closes open streams and lets their terminals go', async (t) => {
  const f = fixture(t)
  const host = startHost(t, { ...f.env, FAKE_CORE_KEEP_OPEN: '1' })
  const response = await host.route.fetch(host.request(LEAD))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  host.off()
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2)), 'the plugin stop sends CLOSE to the core')
  let ended = false
  const until = Date.now() + 2000
  while (Date.now() < until) {
    const next = await reader.read().catch(() => ({ done: true }))
    if (next.done) { ended = true; break }
  }
  assert.equal(ended, true, 'and the response stream ends')
})

test('the Connection stopping closes open streams too', async (t) => {
  const f = fixture(t)
  const host = startHost(t, { ...f.env, FAKE_CORE_KEEP_OPEN: '1' })
  const response = await host.route.fetch(host.request(LEAD))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  host.stopConnection()
  assert.ok(await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2), 3000), 'a stopped Connection closes the stream on the core')
  await reader.cancel().catch(() => {})
})

test('a pane row that names another core is refused, even when the terminal is live', async (t) => {
  const f = fixture(t)
  const at = new Date().toISOString()
  writeFileSync(join(f.ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: LEAD, project: f.project, terminal: 't7', core: 'another-core', created_ms: 700, machine: null, at, by: 'start' })}\n`)
  assert.equal(await resolvePane({ botId: LEAD, env: f.env }), null, 'a row from another core is not this computer pane')
})

test('a terminal re-created since its row is refused: the created_ms must match', async (t) => {
  const f = fixture(t)
  const at = new Date().toISOString()
  writeFileSync(join(f.ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: LEAD, project: f.project, terminal: 't7', core: CORE, created_ms: 999, machine: null, at, by: 'start' })}\n`)
  assert.equal(await resolvePane({ botId: LEAD, env: f.env }), null, 'a reused terminal id is not the row terminal')
  writeFileSync(join(f.ledgerDir, 'attach.jsonl'), `${JSON.stringify({ v: 1, event: 'attach', bot: LEAD, project: f.project, terminal: 't7', core: CORE, created_ms: 700, machine: null, at, by: 'start' })}\n`)
  writeFileSync(join(f.ledgerDir, 'workers.jsonl'), `${JSON.stringify({ event: 'start', kind: 'worker', terminal: 't9', botId: LEAD, lead: LEAD, role: 'reviewer', core: CORE, created_ms: 1, at })}\n`)
  assert.equal(await resolvePane({ botId: LEAD, worker: 't9', env: f.env }), null, 'a worker row whose created_ms is not the live terminal is refused')
})

test('installing the Code side reads no tree: the read starts with the first Terminal press', async (t) => {
  const f = fixture(t)
  let connects = 0
  let endpoint = null
  const disposers = []
  const ctx = {
    effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); return () => {} },
    connection: { fetch: { register: () => () => {} } },
  }
  const rt = { ctx, hooks: { endpoint: (name, fn) => { endpoint = fn; return () => {} } }, warn: () => {}, home: f.root }
  const off = install(rt, { env: f.env, desktop: true, connect: (...args) => { connects += 1; return connectCore(...args) } })
  t.after(() => { off(); for (const dispose of disposers) { try { dispose() } catch { /* gone */ } } })
  assert.equal(typeof endpoint, 'function', 'the tree endpoint is served')
  assert.equal(connects, 0, 'install must not read the tree at install time')
  const tree = await endpoint()
  assert.equal(tree.machine.core, CORE)
  assert.ok(connects > 0, 'the first endpoint call is what reads the tree')
})

const DESKTOP_ONLY = { v: 1, machine: null, projects: [], reason: 'desktop-only' }
const DESKTOP_ROUTES = [CODE_TAKE_ROUTE, CODE_INPUT_ROUTE, CODE_RELEASE_ROUTE, CODE_STREAM_ROUTE]

function codeRuntime(t) {
  const routes = new Map()
  const register = t.mock.fn((route) => {
    assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  })
  const ctx = { effect: setup => setup(), connection: { fetch: { register } } }
  const rt = { ctx }
  installHooks(rt)
  return { rt, routes, register, endpoint: () => rt.extended.endpointOf(CODE_TREE_ENDPOINT) }
}

test('a standalone host only serves a read-only desktop denial, without reading files or connecting', async (t) => {
  const f = fixture(t)
  const { rt, register, endpoint } = codeRuntime(t)
  const readFile = t.mock.fn(readFileSync)
  const connect = t.mock.fn(connectCore)
  t.after(install(rt, { env: f.env, desktop: false, connect, readFile }))
  assert.equal(endpoint().read, true)
  assert.deepEqual(await endpoint().fn(), DESKTOP_ONLY)
  assert.equal(readFile.mock.callCount(), 0)
  assert.equal(connect.mock.callCount(), 0)
  assert.equal(register.mock.callCount(), 0)
})

test('the default requires both the desktop flag and the process IPC channel', async (t) => {
  const { rt, routes, endpoint } = codeRuntime(t)
  const flag = process.env.AUTOMAGIK_APP_BROWSER
  const send = process.send
  t.after(() => {
    if (flag === undefined) delete process.env.AUTOMAGIK_APP_BROWSER
    else process.env.AUTOMAGIK_APP_BROWSER = flag
    if (send === undefined) delete process.send
    else process.send = send
  })

  delete process.env.AUTOMAGIK_APP_BROWSER
  process.send = () => true
  const offWithoutFlag = install(rt)
  assert.deepEqual(await endpoint().fn(), DESKTOP_ONLY)
  assert.equal(routes.size, 0)
  offWithoutFlag()

  process.env.AUTOMAGIK_APP_BROWSER = '1'
  delete process.send
  const offWithoutIpc = install(rt)
  assert.deepEqual(await endpoint().fn(), DESKTOP_ONLY)
  assert.equal(routes.size, 0)
  offWithoutIpc()

  process.send = () => true
  t.after(install(rt))
  assert.deepEqual([...routes.keys()], DESKTOP_ROUTES)
})

test('the same runtime can dispose and reinstall the Code side with or without desktop routes', async (t) => {
  const { rt, routes, endpoint } = codeRuntime(t)
  const offDesktop = install(rt, { desktop: true })
  t.after(offDesktop)
  assert.deepEqual([...routes.keys()], DESKTOP_ROUTES)
  offDesktop()
  assert.equal(endpoint(), undefined)
  assert.equal(routes.size, 0)

  const offStandalone = install(rt, { desktop: false })
  assert.deepEqual(await endpoint().fn(), DESKTOP_ONLY)
  offStandalone()
  assert.equal(endpoint(), undefined)

  const offReinstalled = install(rt, { desktop: true })
  t.after(offReinstalled)
  assert.deepEqual([...routes.keys()], DESKTOP_ROUTES)
  offReinstalled()

  delete rt.ctx.connection
  const offNoCarrier = install(rt, { desktop: true })
  assert.equal(endpoint().read, true)
  offNoCarrier()
  assert.equal(endpoint(), undefined)
})

test('a real Cordis plugin stop closes an open stream and its core attach', async (t) => {
  const f = fixture(t)
  const team = join(f.root, 'team')
  mkdirSync(team, { recursive: true })
  const saved = {}
  const env = {
    HOME: f.root,
    AUTOMAGIK_HOME: f.automagikHome,
    AUTOMAGIK_BOTS_HOME: team,
    AUTOMAGIK_APP_BROWSER: '1',
    HERDR_APP_HOME: f.appHome,
    HERDR_HC: FAKE,
    FAKE_CORE_TERMINALS: f.terminalsFile,
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
  // stand-ins for DSH's services, and no fake plugin context. Stopping the plugin is a real
  // scope stop.
  const stub = fakeContext({})
  const root = new Context()
  const services = {
    tools: stub.tools,
    systemPrompt: stub.systemPrompt,
    llm: stub.llm,
    connection: stub.connection,
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }, flush: async () => {} },
    sessionController: {},
    sessionTitle: {},
    workspaceRegistry: { list: () => [] },
  }
  for (const [name, value] of Object.entries(services)) root.provide(name, value)
  let route = null
  const register = stub.connection.fetch.register
  stub.connection.fetch.register = (options) => {
    if (options.path === '/api/omni-ui/code/stream') route = options
    return register(options)
  }
  const fork = root.plugin(plugin, { home: team, browserPlugin: false })
  await fork
  assert.ok(route, 'the Code stream route is registered in the real plugin scope')
  const response = await route.fetch(new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`, { headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } }))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  await fork.dispose()
  const closed = await wait(() => readLog(f.log).some(row => row.type === 'frame' && row.channel === 7 && row.kind === 2))
  // A scope that does not stop its stream would leave this test hanging on an open core; let
  // the reader go first, then fail with the reason.
  if (!closed) await reader.cancel().catch(() => {})
  assert.ok(closed, 'stopping the real plugin scope sends CLOSE to the core')
  let ended = false
  const until = Date.now() + 2000
  while (Date.now() < until) {
    const next = await reader.read().catch(() => ({ done: true }))
    if (next.done) { ended = true; break }
  }
  assert.equal(ended, true, 'and the response stream ends')
  await new Promise(resolve => setTimeout(resolve, 100))
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
