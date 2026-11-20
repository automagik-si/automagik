// The Code side's host half (RFC 0030 delivery 1): the tree from the registry and the two
// ledgers, the framed core bridge, and one owner-only pane stream that watches this
// computer's own terminal. Every core here is the test's own fake (`fixtures/fake-hc-core.mjs`):
// no live herdr, no real pane, no real team.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { coreProbeFixture } from './fixtures/fake-core-probe.mjs'
import { connectFakeCore } from './fixtures/fake-core-connection.mjs'
import { aWindowProof } from './fixtures/window-proof.mjs'
import { CODE_STREAM_ROUTE, CODE_TREE_ENDPOINT, MAX_QUEUED_BYTES, install, openPaneStream, streamAdmission, streamTarget, streamTargets } from '../src/host/code-side.js'
import { CODE_INPUT_ROUTE, CODE_RELEASE_ROUTE, CODE_TAKE_ROUTE } from '../src/host/code-typing.js'
import { install as installChannel } from '../src/host/channel.js'
import { install as installSeats } from '../src/host/seat-chat.js'
import { install as installHooks, windowEndpoint } from '../src/host/extend.js'
import { fromWindow } from '../src/host/desktop-window.js'

const WINDOW = 'ab'.repeat(32)
const DIGEST = createHash('sha256').update(WINDOW, 'ascii').digest('hex')
const WINDOW_HEADERS = { 'x-automagik-window': WINDOW }

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

function fixture(t, { probe = true } = {}) {
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
    shown: [{ project, bots: [LEAD, DEV] }],
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
  const probeEnv = probe ? coreProbeFixture(t, root) : {}
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
  }
  return { root, project, automagikHome, appHome, ledgerDir, env, probeEnv, log, terminalsFile }
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
    shown: [{ project: f.project, bots: [LEAD] }],
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
  const request = () => new Request('http://127.0.0.1/api/omni-ui/code/stream?bot=b-aaaaaaaaaa', { headers: { ...WINDOW_HEADERS, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', host: '127.0.0.1' } })
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
function startHost(t, env = process.env, connect) {
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
  const off = install(rt, { env, desktop: true, connect })
  t.after(() => { off(); for (const dispose of disposers) { try { dispose() } catch { /* gone */ } } })
  const request = bot => new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${bot}`, { headers: { ...WINDOW_HEADERS, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } })
  return { request, get route() { return route }, off, stopConnection: () => { connectionLive = false } }
}

const streamAsk = bot => new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${bot}`, { headers: { ...WINDOW_HEADERS, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } })

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
  const rt = { ctx, hooks: { endpoint: (name, fn) => { endpoint = () => fn(undefined, undefined, aWindowProof()); return () => {} } }, warn: () => {}, home: f.root }
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
    ...f.probeEnv,
    AUTOMAGIK_WINDOW_DIGEST: DIGEST,
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
  const response = await route.fetch(new Request(`http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`, { headers: { ...WINDOW_HEADERS, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' } }))
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

test('the Code tree and pane resolver skip projects without a local shown entry', async (t) => {
  const f = fixture(t)
  const hidden = join(f.root, 'hidden')
  const id = 'b-dddddddddd'
  const homePath = join(f.automagikHome, HOME_PATH)
  const home = JSON.parse(readFileSync(homePath, 'utf8'))
  home.projects.push({ folder: hidden })
  home.bots.push({ id, name: 'Hidden Bot', folder: hidden })
  home.shown.push({ project: hidden, machine: 'lab', bots: [id] })
  writeFileSync(homePath, JSON.stringify(home))
  const ledger = join(f.ledgerDir, 'attach.jsonl')
  writeFileSync(ledger, readFileSync(ledger, 'utf8') + JSON.stringify({
    v: 1, event: 'attach', bot: id, project: hidden, terminal: 't7', core: CORE, created_ms: 700,
    machine: null, at: '2026-11-15T00:00:00.000Z', by: 'start',
  }) + '\n')
  const connect = t.mock.fn(connectCore)
  const { tree } = await readCodeTree({ env: f.env, connect })
  assert.deepEqual(tree.projects.map(project => project.folder), [f.project])
  connect.mock.resetCalls()
  assert.equal(await resolvePane({ botId: id, env: f.env, connect }), null)
  assert.equal(connect.mock.callCount(), 0, 'resolvePane refuses the project before talking to a core')
})

test('the real owner dispatcher requires the window marker for the tree and seat screen', async (t) => {
  const f = fixture(t)
  const ctx = fakeContext()
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  ctx.connection.fetch.register = options => HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, options)
  const rt = {
    ctx, state: { bots: {} }, home: f.root, registryPath: join(f.automagikHome, HOME_PATH),
    load: async () => {}, refresh: async () => {}, readOnly: () => undefined, warn: () => {},
  }
  t.after(() => ctx.dispose())
  const saved = process.send
  process.send = () => true
  t.after(() => {
    if (saved === undefined) delete process.send
    else process.send = saved
  })
  const was = { flag: process.env.AUTOMAGIK_APP_BROWSER, digest: process.env.AUTOMAGIK_WINDOW_DIGEST }
  process.env.AUTOMAGIK_APP_BROWSER = '1'
  process.env.AUTOMAGIK_WINDOW_DIGEST = DIGEST
  t.after(() => {
    if (was.flag === undefined) delete process.env.AUTOMAGIK_APP_BROWSER
    else process.env.AUTOMAGIK_APP_BROWSER = was.flag
    if (was.digest === undefined) delete process.env.AUTOMAGIK_WINDOW_DIGEST
    else process.env.AUTOMAGIK_WINDOW_DIGEST = was.digest
  })

  installHooks(rt)
  t.after(install(rt, { env: f.env, desktop: true }))
  const screen = ['fixture screen']
  const watch = t.mock.fn(() => ({
    rows: () => [], screen: () => screen, status: () => null,
    approval: () => null, question: () => null, close() {},
  }))
  installSeats(rt, { engine: {
    ready: async () => {}, hub: { all: () => [{ address: 't7', labels: { bot: LEAD } }] }, watch, close() {},
  } })
  installChannel(rt)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const owner = { principal: { kind: 'owner' } }
  const request = (path, { marker, method = 'POST', body } = {}) => {
    const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' })
    if (marker) headers.set('x-automagik-window', marker)
    const init = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }
    return handler.fetch(new Request(`http://127.0.0.1${path}`, init), owner)
  }
  const seat = { client: 'seat-window', terminal: 't7' }
  const call = async (endpoint, marker, payload) => (await request('/api/omni-ui', { marker, body: { endpoint, payload } })).json()
  for (const marker of [undefined, 'cd'.repeat(32), DIGEST]) {
    assert.deepEqual(await call('code-tree', marker), { ok: true, value: DESKTOP_ONLY })
    for (const endpoint of ['seat-chat-open', 'seat-chat-read']) {
      const answer = await call(endpoint, marker, seat)
      assert.deepEqual(answer, { ok: false, error: { code: 'bot/refused', message: 'desktop-only', details: {} } })
      assert.equal(JSON.stringify(answer).includes('screen'), false)
    }
    for (const path of DESKTOP_ROUTES) {
      const response = await request(path, { marker, method: path === CODE_STREAM_ROUTE ? 'GET' : 'POST' })
      assert.equal(response.status, 403)
      assert.deepEqual(await response.json(), { error: 'desktop-only' })
    }
  }
  assert.equal(watch.mock.callCount(), 0)
  assert.equal(readLog(f.log).length, 0)
  assert.equal((await call('code-tree', WINDOW)).value.machine.core, CORE)
  assert.deepEqual((await call('seat-chat-open', WINDOW, seat)).value.screen, screen)
  assert.deepEqual((await call('seat-chat-read', WINDOW, seat)).value.screen, screen)
  assert.equal((await call('seat-chat-read', undefined, seat)).error.message, 'desktop-only')
  // An unmarked close is refused and leaves the watch; the window's own close releases it.
  assert.equal((await call('seat-chat-close', undefined, seat)).error.message, 'desktop-only')
  assert.deepEqual((await call('seat-chat-read', WINDOW, seat)).value.screen, screen)
  assert.deepEqual((await call('seat-chat-close', WINDOW, seat)).value, { closed: true })
  assert.match((await call('seat-chat-read', WINDOW, seat)).error.message, /not open/)
  // Another plugin's endpoint, called by the window itself, gets no proof to keep.
  const seen = []
  const off = rt.hooks.endpoint('another-plugin-endpoint', async (_body, _signal, windowSeen) => { seen.push(windowSeen); return 'ok' }, { read: true })
  assert.deepEqual(await call('another-plugin-endpoint', WINDOW, {}), { ok: true, value: 'ok' })
  off()
  assert.deepEqual(seen, [false])
  // A window-only endpoint gets the proof for its request, and the route revokes it when the request ends.
  let kept
  const offWindow = windowEndpoint(rt, 'test-window-endpoint', async (_body, _signal, windowSeen) => { kept = windowSeen; return fromWindow(windowSeen) }, { read: true })
  assert.deepEqual(await call('test-window-endpoint', WINDOW, {}), { ok: true, value: true })
  offWindow()
  assert.equal(fromWindow(kept), false, 'a proof kept after its request opens nothing')
  delete process.env.AUTOMAGIK_WINDOW_DIGEST
  assert.deepEqual((await call('code-tree', WINDOW)).value, DESKTOP_ONLY)
})

test('the stream distinguishes a failed pane resolution from a failed second connect', async (t) => {
  const f = fixture(t)
  const url = `http://127.0.0.1${CODE_STREAM_ROUTE}?bot=${LEAD}`
  const unavailable = () => { throw new Error('fixture core has stopped') }
  const noPane = await openPaneStream({ url, env: f.env, connect: unavailable })
  assert.equal(noPane.status, 404)
  assert.deepEqual(await noPane.json(), { error: 'no-pane' })
  const connect = t.mock.fn(unavailable)
  connect.mock.mockImplementationOnce(async () => ({
    info: { core: { id: CORE } }, call: async () => TERMINALS[0], close() {},
  }))
  const noCore = await openPaneStream({ url, env: f.env, connect })
  assert.equal(noCore.status, 503)
  assert.deepEqual(await noCore.json(), { error: 'no-core' })
})

async function paneEvent(reader) {
  const { value } = await reader.read()
  const [, event, data] = /^event: (\w+)\ndata: (.*)\n\n$/.exec(new TextDecoder().decode(value)) ?? []
  assert.ok(event, 'one SSE event per chunk')
  return { event, data: event === 'data' ? Buffer.from(data, 'base64').toString() : JSON.parse(data) }
}

for (const [resizeTo, event] of [['92x28', 'reset'], ['0x28', 'close'], ['5000x28', 'close']]) {
  test(`an observer resize hint to ${resizeTo} yields ${event} after the old paint`, { timeout: 5000 }, async (t) => {
    const f = fixture(t, { probe: false })
    const abort = new AbortController()
    t.after(() => abort.abort())
    const response = await openPaneStream({
      url: `http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`,
      env: { ...f.env, FAKE_CORE_KEEP_OPEN: '1', FAKE_CORE_RESIZE_TO: resizeTo }, signal: abort.signal, connect: connectFakeCore,
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    assert.deepEqual(await paneEvent(reader), { event: 'pane', data: { bot: LEAD, terminal: 't7', cols: 120, rows: 40, name: 'Atlas' } })
    const old = await paneEvent(reader)
    assert.equal(old.event, 'data')
    assert.match(old.data, /fake-pane/)
    if (event === 'reset') {
      assert.deepEqual(await paneEvent(reader), { event: 'reset', data: { cols: 92, rows: 28 } })
      const paint = 'resized-paint\r\n'
      assert.deepEqual(await paneEvent(reader), { event: 'data', data: paint })
      const credits = () => readLog(f.log).filter(row => row.type === 'frame' && row.kind === 1)
      assert.ok(await wait(() => credits().length === 2))
      assert.deepEqual(credits().map(row => [row.channel, Buffer.from(row.payload, 'base64').readInt32LE()]),
        [[7, Buffer.byteLength(old.data)], [8, Buffer.byteLength(paint)]])
    } else {
      assert.deepEqual(await paneEvent(reader), { event: 'close', data: { reason: 'resize' } })
      assert.equal((await reader.read()).done, true)
    }
    const trace = readLog(f.log)
    const attaches = trace.filter(row => row.type === 'call' && row.method === 'terminal.attach')
    assert.equal(attaches.length, 2)
    assert.ok(attaches.every(row => row.params.observe === true && row.params.history === 1000))
    assert.ok(trace.some(row => row.type === 'detached' && row.channel === 7))
    assert.equal(trace.some(row => row.type === 'frame' && row.kind === 3), false)
    await reader.cancel()
  })
}

test('a slow reader sees only the newest queued reset and its paint, after the old bytes', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const abort = new AbortController()
  t.after(() => abort.abort())
  let attachCount = 0
  const watcher = new Map()
  const credits = []
  const detached = []
  const core = {
    async attach() {
      const channel = ++attachCount
      return { channel, terminal: { cols: 80 + channel, rows: 24 } }
    },
    detach: channel => detached.push(channel),
    close() {},
    credit: (channel, bytes) => credits.push([channel, bytes]),
    watch(channel, handlers) {
      watcher.set(channel, handlers)
      handlers.onData(Buffer.from(`paint-${channel}`))
      if (channel < 3) handlers.onResize()
    },
  }
  let connections = 0
  const response = await openPaneStream({
    url: `http://127.0.0.1/api/omni-ui/code/stream?bot=${LEAD}`, env: f.env, signal: abort.signal,
    connect: options => (++connections === 1 ? connectFakeCore(options) : core),
  })
  const reader = response.body.getReader()
  assert.deepEqual(credits, [])
  assert.ok(await wait(() => watcher.has(3)))
  assert.deepEqual(detached, [1, 2])
  watcher.get(1).onData(Buffer.from('late-old'))
  assert.deepEqual(credits, [])
  assert.deepEqual(await paneEvent(reader), { event: 'pane', data: { bot: LEAD, terminal: 't7', cols: 81, rows: 24, name: 'Atlas' } })
  assert.deepEqual(await paneEvent(reader), { event: 'data', data: 'paint-1' })
  assert.deepEqual(await paneEvent(reader), { event: 'reset', data: { cols: 83, rows: 24 } })
  assert.deepEqual(await paneEvent(reader), { event: 'data', data: 'paint-3' })
  assert.deepEqual(credits, [[3, 7]])
  await reader.cancel()
})

test('the registered route admits six distinct live streams and reuses a closed slot', async (t) => {
  const f = fixture(t, { probe: false })
  const workers = [10, 11, 12, 13, 14, 15].map(n => ({ address: `t${n}`, created_ms: n * 100, state: 'live', cols: 80, rows: 24 }))
  writeFileSync(f.terminalsFile, JSON.stringify([...TERMINALS, ...workers]))
  for (const terminal of workers) {
    writeFileSync(join(f.ledgerDir, 'workers.jsonl'), JSON.stringify({
      event: 'start', kind: 'worker', terminal: terminal.address, created_ms: terminal.created_ms, botId: LEAD,
      lead: LEAD, role: 'dev', project: f.project, worktree: f.project, core: CORE, at: '2026-11-15T00:00:00.000Z',
    }) + '\n', { flag: 'a' })
  }
  const host = startHost(t, { ...f.env, FAKE_CORE_KEEP_OPEN: '1' }, connectFakeCore)
  const workerAsk = terminal => new Request(`${streamAsk(LEAD).url}&worker=${terminal}`, { headers: streamAsk(LEAD).headers })
  const requests = [streamAsk(LEAD), streamAsk(DEV), ...['t9', 't10', 't11', 't12', 't13'].map(workerAsk)]
  const live = []
  for (const request of requests.slice(0, 6)) {
    const response = await host.route.fetch(request)
    assert.equal(response.status, 200)
    live.push(response)
  }
  // Keep the six original opens, then fill the two slots added for a second Code view.
  for (const terminal of ['t14', 't15']) {
    const response = await host.route.fetch(workerAsk(terminal))
    assert.equal(response.status, 200)
    live.push(response)
  }
  assert.equal((await host.route.fetch(requests[0])).status, 409)
  assert.equal((await host.route.fetch(requests[6])).status, 429)
  await live.pop().body.cancel()
  const reused = await host.route.fetch(requests[6])
  assert.equal(reused.status, 200)
  await Promise.all([...live, reused].map(response => response.body.cancel()))
})

const multiTargets = targets => targets.map(([bot, worker, viewer]) => ({ bot, worker, viewer }))
const streamUrl = (targets, multi = targets.length > 1) => {
  const params = new URLSearchParams()
  for (const { bot, worker, viewer } of targets) {
    params.append('bot', bot)
    if (multi || worker) params.append('worker', worker ?? '')
    if (viewer) params.append('viewer', viewer)
  }
  return `http://127.0.0.1${CODE_STREAM_ROUTE}?${params}`
}

test('multiplexed queries align the seat and worker tags and refuse malformed sets', () => {
  const targets = multiTargets([[LEAD, null, 'viewer-1'], [LEAD, 't9', 'viewer-2']])
  assert.deepEqual(streamTargets(streamUrl(targets)), targets)
  assert.equal(streamTargets(streamUrl([...targets, { bot: DEV, worker: null, viewer: 'viewer-3' }])).length, 3)
  const url = streamUrl(targets)
  const [first, second] = targets
  for (const [query, error] of [
    [streamUrl([first], true), 'no-bot'],
    [streamUrl([first, { ...second, bot: 'bad' }]), 'no-bot'],
    [url.replace('&worker=t9', ''), 'no-worker'],
    [url + '&worker=', 'no-worker'],
    [url.replace('t9', 'a%20b'), 'no-worker'],
    [url.replace('&viewer=viewer-2', ''), 'no-viewer'],
    [url + '&viewer=viewer-3', 'no-viewer'],
    [url.replace('viewer-2', 'short'), 'no-viewer'],
    [url.replace('viewer-2', 'viewer-1'), 'no-viewer'],
    [url.replace('t9', ''), 'duplicate-pane'],
    [url + '&terminal=t9', 'unknown-parameter'],
    [streamUrl([first, second, first, second, first]), 'too-many-panes'],
  ]) assert.deepEqual(streamTargets(query), { error }, query)
})

function multiHost(t, f, connect) {
  const { rt, routes } = codeRuntime(t)
  rt.home = f.root
  rt.ctx.connection.admit = () => ({})
  t.after(install(rt, { env: f.env, desktop: true, connect }))
  const request = (targets, { signal, headers } = {}) => new Request(streamUrl(targets), {
    signal, headers: { ...WINDOW_HEADERS, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', ...headers },
  })
  return {
    request,
    open: request => routes.get(CODE_STREAM_ROUTE).fetch(request),
    post: (route, body) => routes.get(route).fetch(new Request(`http://127.0.0.1${route}`, {
      method: 'POST', headers: { ...WINDOW_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })),
  }
}

async function taggedEvent(reader) {
  const { value } = await reader.read()
  const [, event, data] = /^event: (\w+)\ndata: (.*)\n\n$/.exec(new TextDecoder().decode(value)) ?? []
  assert.ok(event, 'one tagged SSE event per chunk')
  return { event, data: JSON.parse(data) }
}

function controlledCore(f, { attachGrid, refuseAttach } = {}) {
  const terminals = JSON.parse(readFileSync(f.terminalsFile, 'utf8'))
  const attaches = []
  const credits = []
  const connect = async () => {
    let channel = 0
    const channels = new Map()
    return {
      info: { core: { id: CORE } },
      call: async (_method, { terminal }) => terminals.find(row => row.address === terminal),
      async attach(params) {
        if (params.terminal === refuseAttach) throw new Error('fixture refused the attach')
        channel += 1
        const attachment = { ...params, channel }
        attaches.push(attachment)
        channels.set(channel, attachment)
        return { channel, terminal: attachGrid?.(channel) ?? { cols: params.cols, rows: params.rows } }
      },
      watch(channel, handlers) {
        const attachment = channels.get(channel)
        attachment.handlers = handlers
        if (!attachment.observe) handlers.onData(Buffer.from('typing-ready'))
      },
      credit(channel, bytes) { credits.push([channels.get(channel).terminal, channel, bytes]) },
      detach(channel) { channels.get(channel).detached = true },
      writeFrame() {},
      close() { for (const attachment of channels.values()) attachment.closed = true },
    }
  }
  return { connect, attaches, credits, watching: (terminal, channel = 1) => attaches.find(a => a.terminal === terminal && a.channel === channel && a.observe)?.handlers }
}

const dataEvent = (p, text) => ({ event: 'data', data: { p, d: Buffer.from(text).toString('base64') } })
const closeEvent = (p, reason) => ({ event: 'close', data: { p, reason } })

test('the registered multi stream isolates a terminal close, failed resolution and refused attach', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const core = controlledCore(f, { refuseAttach: 't9' })
  const host = multiHost(t, f, core.connect)
  const targets = multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-2'],
    [ELSEWHERE, null, 'viewer-3'], [LEAD, 't9', 'viewer-4']])
  const response = await host.open(host.request(targets))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const opening = await Promise.all(Array.from({ length: 4 }, () => taggedEvent(reader)))
  assert.deepEqual(opening.sort((a, b) => a.data.p - b.data.p), [
    { event: 'pane', data: { p: 0, bot: LEAD, terminal: 't7', cols: 120, rows: 40, name: 'Atlas' } },
    { event: 'pane', data: { p: 1, bot: DEV, terminal: 't8', cols: 100, rows: 30, name: 'Dev' } },
    closeEvent(2, 'no-pane'),
    closeEvent(3, 'attach-refused'),
  ])
  const a = core.watching('t7')
  const b = core.watching('t8')
  a.onData(Buffer.from('atlas'))
  b.onData(Buffer.from('dev'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(0, 'atlas'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(1, 'dev'))
  a.onClose('terminal-ended')
  b.onData(Buffer.from('still watching'))
  assert.deepEqual(await taggedEvent(reader), closeEvent(0, 'terminal-ended'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(1, 'still watching'))
  b.onClose('ended')
  assert.deepEqual(await taggedEvent(reader), closeEvent(1, 'ended'))
  assert.equal((await reader.read()).done, true)
  assert.deepEqual(core.credits, [['t7', 1, 5], ['t8', 1, 3], ['t8', 1, 14]])
  assert.ok(core.attaches.every(a => a.closed && a.observe && a.history === 1000))
})

test('the registered 2-pane form reports a failed observer connection and still serves the other core', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const core = controlledCore(f)
  let connects = 0
  const host = multiHost(t, f, async () => {
    if (++connects === 3) throw new Error('fixture connection failed')
    return core.connect()
  })
  const response = await host.open(host.request(multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-2']])))
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal(response.status, 200)
  const events = await Promise.all([taggedEvent(reader), taggedEvent(reader)])
  assert.deepEqual(events.find(item => item.event === 'close'), closeEvent(0, 'no-core'))
  assert.equal(events.find(item => item.event === 'pane').data.p, 1)
  core.watching('t8').onData(Buffer.from('other core'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(1, 'other core'))
})

test('an unread reset replaces only its pane paint and credits only current attachments', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const core = controlledCore(f, { attachGrid: channel => ({ cols: 80 + channel, rows: 24 }) })
  const host = multiHost(t, f, core.connect)
  const response = await host.open(host.request(multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-2']])))
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.ok(await wait(() => core.watching('t7') && core.watching('t8')))
  core.watching('t7').onData(Buffer.from('old A'))
  core.watching('t7').onResize()
  assert.ok(await wait(() => core.watching('t7', 2)))
  core.watching('t7', 2).onData(Buffer.from('superseded A'))
  core.watching('t8').onData(Buffer.from('live B'))
  core.watching('t7', 2).onResize()
  core.watching('t8').onData(Buffer.from('last B'))
  core.watching('t8').onClose('ended')
  assert.ok(await wait(() => core.watching('t7', 3)))
  core.watching('t7', 3).onData(Buffer.from('new A'))
  assert.deepEqual(core.credits, [])
  const panes = await Promise.all([taggedEvent(reader), taggedEvent(reader)])
  assert.deepEqual(panes.map(pane => pane.data.p).sort(), [0, 1])
  assert.deepEqual(await taggedEvent(reader), dataEvent(0, 'old A'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(1, 'live B'))
  assert.deepEqual(await taggedEvent(reader), dataEvent(1, 'last B'))
  assert.deepEqual(await taggedEvent(reader), closeEvent(1, 'ended'))
  assert.deepEqual(await taggedEvent(reader), { event: 'reset', data: { p: 0, cols: 83, rows: 24 } })
  assert.deepEqual(await taggedEvent(reader), dataEvent(0, 'new A'))
  assert.deepEqual(core.credits, [['t7', 3, 5]])
})

test('the byte cap is shared across pane queues and ends the response', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const core = controlledCore(f)
  const host = multiHost(t, f, core.connect)
  const response = await host.open(host.request(multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-2']])))
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.ok(await wait(() => core.watching('t7') && core.watching('t8')))
  core.watching('t7').onData(Buffer.alloc(MAX_QUEUED_BYTES / 2))
  core.watching('t8').onData(Buffer.alloc(MAX_QUEUED_BYTES / 2 + 1))
  const hello = await taggedEvent(reader)
  assert.equal(hello.event, 'pane')
  assert.deepEqual(await taggedEvent(reader), closeEvent(0, 'slow'))
  assert.deepEqual(await taggedEvent(reader), closeEvent(1, 'slow'))
  assert.equal((await reader.read()).done, true)
  assert.deepEqual(core.credits, [])
})

test('eight pane slots are atomic across views and abort frees tags before the replacement opens', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const workers = [10, 11, 12, 13, 14].map(n => ({ address: `t${n}`, created_ms: n * 100, state: 'live', cols: 80, rows: 24 }))
  writeFileSync(f.terminalsFile, JSON.stringify([...TERMINALS, ...workers]))
  for (const terminal of workers) {
    writeFileSync(join(f.ledgerDir, 'workers.jsonl'), JSON.stringify({
      event: 'start', kind: 'worker', terminal: terminal.address, created_ms: terminal.created_ms, botId: LEAD,
      lead: LEAD, role: 'dev', project: f.project, worktree: f.project, core: CORE, at: '2026-11-15T00:00:00.000Z',
    }) + '\n', { flag: 'a' })
  }
  const core = controlledCore(f)
  const host = multiHost(t, f, core.connect)
  const first = multiTargets([[LEAD, null, 'viewer.a.1'], [LEAD, 't9', 'viewer.a.2'],
    [LEAD, 't10', 'viewer.a.3'], [LEAD, 't11', 'viewer.a.4']])
  const second = multiTargets([[DEV, null, 'viewer.b.1'], [LEAD, 't12', 'viewer.b.2'],
    [LEAD, 't13', 'viewer.b.3'], [LEAD, 't14', 'viewer.b.4']])
  const extra = { bot: DEV, worker: 't8', viewer: 'viewer.a.9' }
  const abort = new AbortController()
  const firstRequest = host.request(first, { signal: abort.signal })
  let reopening
  // Enter the route after the signal changes, before the older handler's abort listener.
  firstRequest.signal.addEventListener('abort', () => { reopening = host.open(host.request(first)) })
  const a = host.open(firstRequest)
  const collision = await host.open(host.request([extra, first[0]]))
  assert.equal(collision.status, 409, 'all four tags are reserved before the first attach awaits')
  assert.deepEqual(await collision.json(), { error: 'already-open' })
  const b = host.open(host.request(second))
  const full = await host.open(host.request([extra]))
  assert.equal(full.status, 429, 'a viewer prefix cannot evict a live stream')
  assert.deepEqual(await full.json(), { error: 'busy' })
  const overlapAtCapacity = await host.open(host.request([extra, first[0]]))
  assert.equal(overlapAtCapacity.status, 409)
  const firstResponse = await a
  const secondResponse = await b
  assert.equal(firstResponse.status, 200)
  assert.equal(secondResponse.status, 200)
  const firstReader = firstResponse.body.getReader()
  assert.ok(await wait(() => core.attaches.length === 8 && core.attaches.every(a => a.handlers)))
  abort.abort()
  assert.equal(core.attaches.filter(a => a.detached).length, 4, 'abort detaches only its panes')
  const replacement = await reopening
  assert.equal(replacement.status, 200)
  assert.equal((await host.open(host.request([extra]))).status, 429)
  await firstReader.read()
  assert.equal((await firstReader.read()).done, true)
  // One pane ending or failing frees its slot without ending the shared response.
  core.watching('t12').onClose('ended')
  const spare = await host.open(host.request([extra]))
  assert.equal(spare.status, 200)
  await Promise.all([replacement, secondResponse, spare].map(res => res.body.cancel()))
})

test('pane ends release typing per viewer and older observers cannot release a newer take', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  const core = controlledCore(f)
  const host = multiHost(t, f, core.connect)
  const first = multiTargets([[LEAD, null, 'viewer-shared'], [DEV, null, 'viewer-other']])
  const response = await host.open(host.request(first))
  t.after(() => response.body.cancel())
  assert.ok(await wait(() => core.watching('t7') && core.watching('t8')))
  const take = async (target) => {
    const result = await host.post(CODE_TAKE_ROUTE, target)
    assert.equal(result.status, 200)
    return (await result.json()).session
  }
  const batch = session => host.post(CODE_INPUT_ROUTE, { session, data: 'eA==' })
  const a = await take(first[0])
  const b = await take(first[1])
  core.watching('t7').onClose('ended')
  assert.equal((await batch(a)).status, 409)
  assert.equal((await batch(b)).status, 204)
  // Reuse the still-live pane's viewer on a different tag. The old close cannot cancel this take.
  const next = { bot: LEAD, worker: 't9', viewer: first[1].viewer }
  const newer = await host.open(host.request([next]))
  assert.equal(newer.status, 200)
  t.after(() => newer.body.cancel())
  const moved = await take(next)
  core.watching('t8').onClose('ended')
  assert.equal((await batch(moved)).status, 204)
  await newer.body.cancel()
  assert.equal((await batch(moved)).status, 409)
})

test('multi admission requires the window marker, then SSE admission, then target validation', async (t) => {
  const f = fixture(t, { probe: false })
  const connect = t.mock.fn(() => { throw new Error('must refuse without connecting') })
  const host = multiHost(t, f, connect)
  const duplicateViewers = multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-1']])
  for (const [headers, status, error] of [
    [{ 'x-automagik-window': 'invalid', accept: '*/*', 'sec-fetch-site': 'cross-site' }, 403, 'desktop-only'],
    [{ 'sec-fetch-site': 'cross-site' }, 403, 'cross-site'],
    [{ accept: '*/*' }, 406, 'not-an-event-stream'],
    [{}, 404, 'no-viewer'],
  ]) {
    const response = await host.open(host.request(duplicateViewers, { headers }))
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error })
  }
  const tooMany = Array(5).fill(duplicateViewers[0])
  const response = await host.open(host.request(tooMany))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'too-many-panes' })
  assert.equal(connect.mock.callCount(), 0)
})

test('the framed fake serves legacy SSE bytes and two independently tagged pane sequences', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { probe: false })
  Object.assign(f.env, { FAKE_CORE_KEEP_OPEN: '0', FAKE_CORE_OUTPUT: 'fixture first\n', FAKE_CORE_RESIZE_TO: '' })
  const host = multiHost(t, f, connectFakeCore)
  const legacy = await host.open(host.request([{ bot: LEAD }]))
  assert.equal(legacy.status, 200)
  const first = 'fixture first\r\n'
  const second = 'second-line\r\n'
  assert.equal(await legacy.text(), [
    'event: pane\ndata: {"bot":"b-aaaaaaaaaa","terminal":"t7","cols":120,"rows":40,"name":"Atlas"}\n\n',
    `event: data\ndata: ${Buffer.from(first).toString('base64')}\n\n`,
    `event: data\ndata: ${Buffer.from(second).toString('base64')}\n\n`,
    'event: close\ndata: {"reason":"ended"}\n\n',
  ].join(''))

  const response = await host.open(host.request(multiTargets([[LEAD, null, 'viewer-1'], [DEV, null, 'viewer-2']])))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const panes = [[], []]
  for (let i = 0; i < 8; i += 1) {
    const event = await taggedEvent(reader)
    panes[event.data.p].push(event)
  }
  assert.deepEqual(panes, [
    [{ event: 'pane', data: { p: 0, bot: LEAD, terminal: 't7', cols: 120, rows: 40, name: 'Atlas' } },
      dataEvent(0, first), dataEvent(0, second), closeEvent(0, 'ended')],
    [{ event: 'pane', data: { p: 1, bot: DEV, terminal: 't8', cols: 100, rows: 30, name: 'Dev' } },
      dataEvent(1, first), dataEvent(1, second), closeEvent(1, 'ended')],
  ])
  assert.equal((await reader.read()).done, true)
})
