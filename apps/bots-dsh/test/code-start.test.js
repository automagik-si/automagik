// New › Start an existing Bot (RFC 0030 delivery 6a): the host endpoint on the real /api
// dispatcher, the tree's start reasons, and the CLI resolver. Every core here is the test's own
// fake (`fixtures/fake-hc-core.mjs` behind a status socket) and every CLI is a stand-in
// (`fixtures/fake-start-cli`) in a scratch home: no live herdr, no real `am`, nothing started.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { install as installChannel } from '../src/host/channel.js'
import { CODE_START_ENDPOINT, FALLBACK_PATH, install as installStart, resolveStartCli, startEnv, startOutcome } from '../src/host/code-start.js'
import { effectiveKey, folderKind, readCodeTree, readRosterAt } from '../src/host/code-tree.js'
import { revokeWindowProof, windowProof } from '../src/host/desktop-window.js'
import { install as installHooks, isWindowEndpoint } from '../src/host/extend.js'
import { HOME_PATH, REPO_PATH } from '../src/shared/registry.js'
import { fakeContext } from './fake-ctx.js'
import { coreProbeFixture } from './fixtures/fake-core-probe.mjs'
import { DIGEST, OWNER, WINDOW } from './fixtures/automations-host.mjs'

const FAKE_HC = fileURLToPath(new URL('./fixtures/fake-hc-core.mjs', import.meta.url))
const STAND_IN = fileURLToPath(new URL('./fixtures/fake-start-cli/', import.meta.url))
const LEAD = 'b-aaaaaaaaaa'
const DEV = 'b-bbbbbbbbbb'
const V2ONLY = 'b-cccccccccc'
const GLOBAL = 'b-dddddddddd'
const CORE = 'core-test'
const SENTINEL = 'private-start-sentinel'
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const repo = (folder) => {
  mkdirSync(folder, { recursive: true })
  git(folder, 'init', '-q')
  git(folder, 'commit', '-q', '--allow-empty', '-m', 'fixture')
}

function fixture(t, { cli = '3.167.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-code-start-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const project = join(root, 'project')
  // A main checkout's root: the CLI's --project names this very folder.
  repo(project)
  mkdirSync(join(project, '.herdr'), { recursive: true })
  // The CLI's own roster: version 1, with the lead and the dev but not the v2-only Bot.
  writeFileSync(join(project, '.herdr', 'bots.json'), JSON.stringify({ version: 1, bots: [
    { id: LEAD, name: 'Atlas', kind: 'main' }, { id: DEV, name: 'Dev', kind: 'member' },
  ] }))
  // A program named like hc in the project, reachable only through a relative PATH entry.
  mkdirSync(join(project, 'bin'), { recursive: true })
  writeFileSync(join(project, 'bin', 'hc'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
  const automagikHome = join(root, 'automagik')
  const appHome = join(root, 'herdr-app')
  const amHome = join(root, 'am-home')
  mkdirSync(join(automagikHome, 'bots'), { recursive: true })
  mkdirSync(join(appHome, 'automagik-herdr'), { recursive: true })
  const registry = {
    version: 2,
    projects: [{ folder: project }],
    shown: [{ project, bots: [LEAD, DEV, V2ONLY] }],
    bots: [
      { id: LEAD, name: 'Atlas', role: 'lead', agent: 'claude', main: true, folder: project },
      { id: DEV, name: 'Dev', role: 'dev', agent: 'claude', folder: project },
      { id: V2ONLY, name: 'Only In Registry', role: 'dev', agent: 'claude', folder: project },
      { id: GLOBAL, name: 'Everywhere', role: 'helper', agent: 'claude' },
    ],
  }
  const writeRegistry = value => writeFileSync(join(automagikHome, HOME_PATH), JSON.stringify(value))
  writeRegistry(registry)
  writeFileSync(join(appHome, 'automagik-herdr', 'attach.jsonl'), `${JSON.stringify({
    v: 1, event: 'attach', bot: LEAD, project, terminal: 't7', core: CORE, created_ms: 700, machine: null, at: '2026-11-21T00:00:00.000Z', by: 'start',
  })}\n`)
  const terminals = join(root, 'terminals.json')
  writeFileSync(terminals, JSON.stringify([{ address: 't7', created_ms: 700, state: 'live', cols: 120, rows: 40, status: 'idle' }]))
  const probeEnv = coreProbeFixture(t, root)
  const log = join(root, 'start.jsonl')
  const state = join(root, 'start.json')
  const env = {
    ...process.env,
    ...probeEnv,
    PATH: [process.env.PATH, '', 'bin', '.'].join(delimiter),
    HOME: root, AUTOMAGIK_HOME: automagikHome, HERDR_APP_HOME: appHome, AM_HOME: amHome,
    HERDR_HC: FAKE_HC, FAKE_CORE_TERMINALS: terminals, FAKE_CORE_LOG: join(root, 'core.jsonl'),
    FAKE_START_LOG: log, FAKE_START_STATE: state,
    HC_SESSION: 'pane-session', HC_TERMINAL_ID: 't99', HC_TERMINAL_SOCKET: '/nowhere/terminal.sock', HC_SCOPE: 'scope', AUTOMAGIK_HERDR_DEADLINE: '1',
  }
  const addCli = (path, version) => {
    mkdirSync(path, { recursive: true })
    cpSync(STAND_IN, path, { recursive: true })
    writeFileSync(join(path, 'VERSION'), `${version}\n`)
  }
  const pack = join(appHome, 'mods', 'am-sidebar')
  const am = join(amHome, 'parts', 'automagik.am', 'current')
  if (cli) addCli(pack, cli)
  const respond = value => writeFileSync(state, JSON.stringify(value))
  respond({ stdout: JSON.stringify({ id: DEV, terminal: 't12', argv: [SENTINEL], labels: {} }), stderr: `${SENTINEL}\n` })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { root, project, automagikHome, appHome, amHome, pack, am, env, probeEnv, registry, writeRegistry, addCli, respond, calls }
}

function host(t, f, { readOnly, ...options } = {}) {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send')
  process.send = () => true
  t.after(() => previousSend ? Object.defineProperty(process, 'send', previousSend) : delete process.send)
  for (const [key, value] of Object.entries({ AUTOMAGIK_APP_BROWSER: '1', AUTOMAGIK_WINDOW_DIGEST: DIGEST })) {
    const original = process.env[key]
    process.env[key] = value
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original })
  }
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  ctx.connection.fetch.register = route => HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, route)
  const warnings = []
  const ownership = { readOnly, generation: 1 }
  const rt = {
    ctx, state: { bots: {} }, home: f.root, load: async () => {}, refresh: async () => {},
    readOnly: () => ownership.readOnly, warn: (...args) => warnings.push(args.join(' ')),
    teamGeneration: () => ownership.generation, sameTeam: gen => gen === ownership.generation,
  }
  installHooks(rt)
  const dispose = installStart(rt, { env: f.env, desktop: true, ...options })
  t.after(dispose)
  installChannel(rt)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const request = (payload, { peer = OWNER, marker = WINDOW, signal } = {}) => handler.fetch(new Request('http://127.0.0.1/api/omni-ui', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(marker ? { 'x-automagik-window': marker } : {}) },
    body: JSON.stringify({ endpoint: CODE_START_ENDPOINT, payload }), signal,
  }), peer)
  const call = async (payload, options) => (await request(payload, options)).json()
  const outcome = async (payload, options) => {
    const reply = await call(payload, options)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual(Object.keys(reply.value), ['outcome'])
    return reply.value.outcome
  }
  return { rt, request, call, outcome, ownership, warnings, dispose }
}

const wait = async (check, ms = 10_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

test('only the desktop window of the owner may start, and nothing is spawned for anyone else', async (t) => {
  const f = fixture(t)
  const h = host(t, f)
  for (const principal of [
    { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' },
    { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } },
  ]) assert.equal((await h.request({ botId: DEV }, { peer: { principal } })).status, 403)
  for (const marker of [null, DIGEST, 'cd'.repeat(32)]) assert.equal(await h.outcome({ botId: DEV }, { marker }), 'desktop-only')
  const entry = h.rt.extended.endpointOf(CODE_START_ENDPOINT)
  assert.equal(isWindowEndpoint(entry), true)
  assert.equal(entry.read, false, 'a start is a write: the read-only gate applies')
  const revoked = windowProof(new Request('http://localhost', { headers: { 'x-automagik-window': WINDOW } }))
  revokeWindowProof(revoked)
  for (const forged of [true, 'true', {}, revoked]) assert.deepEqual(await entry.fn({ botId: DEV }, undefined, forged), { outcome: 'desktop-only' })
  h.ownership.readOnly = `Read only at ${join(f.root, SENTINEL)}`
  for (const marker of [WINDOW, null]) {
    const raw = await (await h.request({ botId: DEV }, { marker })).text()
    assert.deepEqual(JSON.parse(raw), { ok: false, error: { code: 'bot/read-only', message: 'This host can only read the team.', details: {} } })
    assert.ok(!raw.includes(SENTINEL) && !raw.includes(f.root), 'the team\'s reason never reaches the page')
  }
  assert.deepEqual(f.calls(), [])
})

test('a host that loses the team while the tree is read starts nothing', async (t) => {
  const f = fixture(t)
  let lose
  const h = host(t, f, { readTree: async (options) => { lose(); return readCodeTree(options) } })
  lose = () => { h.ownership.readOnly = 'another window holds the team' }
  assert.equal(await h.outcome({ botId: DEV }), 'read-only')
  h.ownership.readOnly = undefined
  lose = () => { h.ownership.generation += 1 }
  assert.equal(await h.outcome({ botId: DEV }), 'read-only')
  lose = () => h.dispose()
  assert.equal(await h.outcome({ botId: DEV }), 'read-only')
  assert.deepEqual(f.calls(), [])
})

test('the body is exactly a Bot id', async (t) => {
  const f = fixture(t)
  const h = host(t, f)
  for (const body of [null, {}, { botId: 'Dev' }, { botId: DEV, project: f.project }, { bot: DEV }, [DEV], { botId: `${DEV}/x` }]) {
    assert.equal(await h.outcome(body), 'invalid', JSON.stringify(body))
  }
  assert.deepEqual(f.calls(), [])
})

test('the tree says why a row cannot start: global, v2 only, unverified, folder gone, clone', async (t) => {
  const f = fixture(t)
  const read = async () => (await readCodeTree({ env: f.env })).tree
  const rows = async () => Object.fromEntries((await read()).projects.flatMap(project => project.bots.map(bot => [bot.id, bot.blocked])))
  assert.deepEqual(await rows(), { [LEAD]: null, [DEV]: null, [V2ONLY]: 'not-in-roster', [GLOBAL]: 'global-bot' })
  assert.equal(folderKind(f.project, f.env), 'own')
  assert.equal(folderKind(f.project, { ...f.env, GIT_DIR: '/elsewhere' }), 'unknown')
  // A folder inside a repository: the CLI starts in the repository's main checkout.
  mkdirSync(join(f.project, 'sub'))
  assert.equal(folderKind(join(f.project, 'sub'), f.env), 'unknown')
  // An empty .git inside a repository is not one git would take: git answers, finding the outer one.
  mkdirSync(join(f.project, 'sub', '.git'))
  assert.equal(folderKind(join(f.project, 'sub'), f.env), 'unknown')
  assert.equal(await effectiveKey(join(f.project, 'sub'), f.env), f.project)
  // A .git with objects and refs but a HEAD git would not take is not one either.
  mkdirSync(join(f.project, 'sub', '.git', 'objects'), { recursive: true })
  mkdirSync(join(f.project, 'sub', '.git', 'refs'))
  writeFileSync(join(f.project, 'sub', '.git', 'HEAD'), 'not a head\n')
  assert.equal(folderKind(join(f.project, 'sub'), f.env), 'unknown')
  rmSync(join(f.project, 'sub', '.git'), { recursive: true })
  assert.equal(await effectiveKey(join(f.project, 'sub'), f.env), f.project)
  // An entry the CLI would leave out (no name, unknown kind) lists nothing.
  writeFileSync(join(f.project, '.herdr', 'bots.json'), JSON.stringify({ version: 1, bots: [{ id: DEV, kind: 'member' }, { id: LEAD, name: 'Atlas', kind: 'bot' }] }))
  assert.deepEqual(await rows(), { [LEAD]: 'not-in-roster', [DEV]: 'not-in-roster', [V2ONLY]: 'not-in-roster', [GLOBAL]: 'global-bot' })
  // A file that can't be checked is unverified: only a checked row starts.
  writeFileSync(join(f.project, '.herdr', 'bots.json'), JSON.stringify({ version: 2, bots: [{ id: DEV }] }))
  assert.equal((await rows())[DEV], 'unverified')
  writeFileSync(join(f.project, '.herdr', 'bots.json'), '{ not json')
  assert.equal((await rows())[DEV], 'unverified')
  rmSync(join(f.project, '.herdr', 'bots.json'))
  spawnSync('mkfifo', [join(f.project, '.herdr', 'bots.json')])
  if (existsSync(join(f.project, '.herdr', 'bots.json'))) assert.equal(readRosterAt(f.project), null, 'a FIFO is never read')
  rmSync(join(f.project, '.herdr', 'bots.json'), { force: true })
  // No file at all: the CLI's no-roster.
  assert.equal((await rows())[DEV], 'not-in-roster')
  writeFileSync(join(f.project, '.herdr', 'bots.json'), JSON.stringify({ version: 1, bots: [{ id: DEV, name: 'Dev', kind: 'member' }] }))
  // A second, independent clone of the same repository lists the same id in its repo file.
  const clone = join(f.root, 'clone')
  repo(clone)
  mkdirSync(join(clone, '.automagik', 'bots'), { recursive: true })
  writeFileSync(join(clone, REPO_PATH), JSON.stringify({ version: 2, bots: [{ id: DEV, name: 'Dev', role: 'dev', agent: 'claude' }] }))
  const withClone = { ...f.registry, projects: [{ folder: f.project }, { folder: clone }], shown: [...f.registry.shown, { project: clone, bots: [DEV] }] }
  f.writeRegistry(withClone)
  assert.equal((await rows())[DEV], 'ambiguous-clone')
  // A linked worktree of the project is the same project to the CLI: no clone, its roster is the
  // main checkout's (the worktree's own file is not read), and the menu says where it starts.
  const worktree = join(f.root, 'worktree')
  git(f.project, 'worktree', 'add', '-q', '-b', 'side', worktree)
  mkdirSync(join(worktree, '.herdr'), { recursive: true })
  writeFileSync(join(worktree, '.herdr', 'bots.json'), JSON.stringify({ version: 1, bots: [{ id: V2ONLY, name: 'Only In Registry', kind: 'member' }] }))
  mkdirSync(join(worktree, '.automagik', 'bots'), { recursive: true })
  writeFileSync(join(worktree, REPO_PATH), JSON.stringify({ version: 2, bots: [{ id: DEV, name: 'Dev', role: 'dev', agent: 'claude' }, { id: 'b-ffffffffff', name: 'Side', role: 'dev', agent: 'claude' }] }))
  f.writeRegistry({ ...f.registry, projects: [{ folder: f.project }, { folder: worktree }], shown: [...f.registry.shown, { project: worktree, bots: [DEV, 'b-ffffffffff'] }] })
  assert.equal(await effectiveKey(worktree, f.env), f.project)
  const tree = await read()
  const side = tree.projects.find(project => project.folder === worktree)
  assert.equal(side.launch, f.project)
  assert.deepEqual(side.bots.map(bot => [bot.id, bot.blocked]), [['b-ffffffffff', 'not-in-roster']])
  assert.equal(tree.projects.find(project => project.folder === f.project).bots.find(bot => bot.id === DEV).blocked, null)
  // A git dir with a commondir of its own is git's to resolve, never taken as the folder's own.
  writeFileSync(join(clone, '.git', 'commondir'), join(f.project, '.git'))
  assert.equal(folderKind(clone, f.env), 'unknown')
  // A shown folder reached through a link is git's to answer, as the CLI asks it.
  symlinkSync(join(f.project, 'sub'), join(f.root, 'linked-sub'))
  assert.equal(folderKind(join(f.root, 'linked-sub'), f.env), 'unknown')
  assert.equal(await effectiveKey(join(f.root, 'linked-sub'), f.env), f.project)
  // A project's registry that can't be read could list the same id: unverified.
  f.writeRegistry(withClone)
  writeFileSync(join(clone, REPO_PATH), '{ not json')
  assert.equal((await rows())[DEV], 'unverified')
  // The project folder is gone.
  f.writeRegistry(f.registry)
  rmSync(f.project, { recursive: true, force: true })
  assert.equal((await rows())[DEV], 'folder-missing')
})

test('a row that cannot start, or is not this computer\'s, spawns nothing', async (t) => {
  const f = fixture(t)
  const h = host(t, f)
  assert.equal(await h.outcome({ botId: LEAD }), 'already-running')
  assert.equal(await h.outcome({ botId: V2ONLY }), 'not-in-roster')
  assert.equal(await h.outcome({ botId: GLOBAL }), 'global-bot')
  assert.equal(await h.outcome({ botId: 'b-eeeeeeeeee' }), 'not-this-computer')
  rmSync(join(f.automagikHome, HOME_PATH))
  assert.equal(await h.outcome({ botId: DEV }), 'not-this-computer')
  assert.deepEqual(f.calls(), [])
})

test('decided again just before the start: a grant withdrawn while the core answered starts nothing', async (t) => {
  const f = fixture(t)
  const h = host(t, f, { readTree: async (options) => {
    const answer = await readCodeTree(options)
    f.writeRegistry({ ...f.registry, shown: [] })
    return answer
  } })
  assert.equal(await h.outcome({ botId: DEV }), 'not-this-computer')
  f.writeRegistry(f.registry)
  const runtimeless = host(t, f, { runtime: () => null })
  assert.equal(await runtimeless.outcome({ botId: DEV }), 'start-failed', 'a host that cannot run a module')
  assert.deepEqual(f.calls(), [])
})

test('a program the CLI runs by name that leads into the checkout refuses the start', async (t) => {
  const f = fixture(t)
  const links = join(f.root, 'links')
  mkdirSync(links)
  // Any name: the Antigravity CLI's `agy models` runs inside the CLI too.
  symlinkSync(join(f.project, 'bin', 'hc'), join(links, 'agy'))
  const h = host(t, f, {})
  f.env.PATH = [links, process.env.PATH].join(delimiter)
  assert.equal(await h.outcome({ botId: DEV }), 'start-failed')
  f.env.PATH = process.env.PATH
  // The CLI's own settings (herdr-app's home, its program table) inside the checkout.
  const external = fixture(t)
  external.env.HERDR_APP_HOME = join(external.project, 'app-home')
  external.addCli(join(external.amHome, 'parts', 'automagik.am', 'current'), '3.167.0')
  const inside = host(t, external)
  assert.equal(await inside.outcome({ botId: DEV }), 'start-failed')
  // The default app home (no HERDR_APP_HOME) led into the checkout by a link.
  const linked = fixture(t)
  linked.addCli(join(linked.amHome, 'parts', 'automagik.am', 'current'), '3.167.0')
  delete linked.env.HERDR_APP_HOME
  mkdirSync(join(linked.root, '.config'), { recursive: true })
  symlinkSync(join(linked.project, 'bin'), join(linked.root, '.config', 'herdr-app'))
  assert.equal(await host(t, linked).outcome({ botId: DEV }), 'start-failed')
  // ~/.local/bin, which the CLI searches whatever PATH says, as a link into the checkout.
  const local = fixture(t)
  mkdirSync(join(local.root, '.local'), { recursive: true })
  symlinkSync(join(local.project, 'bin'), join(local.root, '.local', 'bin'))
  assert.equal(await host(t, local).outcome({ botId: DEV }), 'start-failed')
  assert.deepEqual(f.calls(), [])
  assert.deepEqual(external.calls(), [])
  assert.deepEqual(linked.calls(), [])
  assert.deepEqual(local.calls(), [])
})

test('nothing the checkout holds runs: its own CLI, its hc for the tree read, Node loader settings', async (t) => {
  const f = fixture(t, { cli: null })
  // A pack installed inside the project is the project's code: no CLI.
  f.env.HERDR_APP_HOME = join(f.project, 'app-home')
  f.addCli(join(f.project, 'app-home', 'mods', 'am-sidebar'), '3.170.0')
  const h = host(t, f)
  assert.equal(await h.outcome({ botId: DEV }), 'no-cli')
  // The tree's hc inside a project is never run.
  const connects = () => existsSync(join(f.root, 'core.jsonl')) ? readFileSync(join(f.root, 'core.jsonl'), 'utf8').split('\n').filter(line => line.includes('"hello"')).length : 0
  const before = connects()
  f.env.HERDR_HC = join(f.project, 'bin', 'hc')
  assert.equal(await h.outcome({ botId: DEV }), 'no-core')
  assert.deepEqual(f.calls(), [])
  assert.equal(connects(), before, 'no hc connect ran')
  const loaders = startEnv({ PATH: '/bin', NODE_OPTIONS: '--require ./evil.js', NODE_PATH: 'lib' }, '/s.sock', f.project)
  assert.equal(Object.hasOwn(loaders, 'NODE_OPTIONS'), false)
  assert.equal(Object.hasOwn(loaders, 'NODE_PATH'), false)
  const native = startEnv({ PATH: '/bin', LD_PRELOAD: './x.so', LD_LIBRARY_PATH: `lib${delimiter}/usr/lib${delimiter}${join(f.project, 'lib')}` }, '/s.sock', f.project)
  assert.equal(Object.hasOwn(native, 'LD_PRELOAD'), false)
  assert.equal(native.LD_LIBRARY_PATH, '/usr/lib')
})

test('the tree is read on the socket that answered: a gone socket is no core, never another one', async (t) => {
  const f = fixture(t)
  const gone = join(f.root, 'gone.sock')
  const h = host(t, f, { probe: async () => gone })
  assert.equal(await h.outcome({ botId: DEV }), 'no-core')
  const none = host(t, f, { probe: async () => null })
  assert.equal(await none.outcome({ botId: DEV }), 'no-core')
  assert.deepEqual(f.calls(), [])
})

test('one start: the exact argv, the folder, the pinned socket and an absolute PATH', async (t) => {
  const f = fixture(t)
  const h = host(t, f)
  assert.equal(await h.outcome({ botId: DEV }), 'started')
  const [run] = f.calls()
  assert.deepEqual(run.argv, ['start', DEV, '--project', f.project, '--local-only', '--json'])
  assert.equal(run.cwd, f.project)
  assert.equal(run.env.HC_SOCKET, f.probeEnv.AUTOMAGIK_HERDR_CORE_SOCKET)
  assert.equal(run.env.AUTOMAGIK_HERDR_CORE_SOCKET, f.probeEnv.AUTOMAGIK_HERDR_CORE_SOCKET)
  for (const name of ['HC_SESSION', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'AUTOMAGIK_HERDR_DEADLINE']) assert.equal(run.env[name], null, name)
  const path = run.env.PATH.split(delimiter)
  assert.ok(path.length > 0 && path.every(entry => entry !== '' && isAbsolute(entry)), run.env.PATH)
  assert.equal(new Set(path).size, path.length)
  assert.ok(!path.includes(join(f.project, 'bin')))
  assert.match(run.cli, /\/herdr-app\/mods\/am-sidebar\/bin\/automagik-herdr\.mjs$/)
  assert.equal(f.calls().length, 1, 'spawned once')
  assert.deepEqual(startEnv({ PATH: `/a${delimiter}${delimiter}rel${delimiter}/a${delimiter}/b`, HC_SESSION: 'x' }, '/s.sock'),
    { PATH: `/a${delimiter}/b`, HC_SOCKET: '/s.sock', AUTOMAGIK_HERDR_CORE_SOCKET: '/s.sock' })
  // The project's own folders never lead the search, even written absolute or through a link.
  mkdirSync(join(f.project, 'node_modules', '.bin'), { recursive: true })
  symlinkSync(join(f.project, 'bin'), join(f.root, 'alias'))
  const projectPath = [join(f.project, 'bin'), join(f.project, 'node_modules', '.bin'), join(f.root, 'alias'), '/usr/local/bin'].join(delimiter)
  assert.equal(startEnv({ PATH: projectPath }, '/s.sock', f.project).PATH, '/usr/local/bin')
  assert.equal(startEnv({ PATH: ['', 'bin', join(f.project, 'bin')].join(delimiter) }, '/s.sock', f.project).PATH, FALLBACK_PATH)
  const relative = startEnv({ PATH: '/bin', HOME: 'home', HERDR_APP_HOME: 'app', NVM_DIR: 'nvm', AUTOMAGIK_HERDR_RUNTIME_DIRS: '/x' }, '/s.sock', f.project)
  assert.equal(relative.HOME, join(process.cwd(), 'home'))
  assert.equal(relative.HERDR_APP_HOME, join(process.cwd(), 'app'))
  assert.equal(Object.hasOwn(relative, 'NVM_DIR'), false)
  assert.equal(Object.hasOwn(relative, 'AUTOMAGIK_HERDR_RUNTIME_DIRS'), false)
})

test('the CLI comes from the installers\' own folders: am first at an equal version, never PATH', async (t) => {
  const f = fixture(t, { cli: null })
  const env = { HOME: f.root, HERDR_APP_HOME: f.appHome, AM_HOME: f.amHome, PATH: process.env.PATH }
  // A foreign am on ~/.local/bin and PATH is never a candidate.
  f.addCli(join(f.root, '.local', 'bin', 'foreign'), '9.0.0')
  symlinkSync(join(f.root, '.local', 'bin', 'foreign', 'bin', 'automagik-herdr.mjs'), join(f.root, '.local', 'bin', 'am'))
  assert.deepEqual(resolveStartCli(env), { outcome: 'no-cli' })
  f.addCli(f.pack, '3.166.0')
  assert.deepEqual(resolveStartCli(env), { outcome: 'update-am' })
  f.addCli(f.pack, '3.167.0')
  assert.equal(resolveStartCli(env).cli.kind, 'pack')
  f.addCli(f.am, '3.167.0')
  assert.equal(resolveStartCli(env).cli.kind, 'am')
  f.addCli(f.pack, '3.168.0')
  assert.equal(resolveStartCli(env).cli.kind, 'pack')
  writeFileSync(join(f.pack, 'VERSION'), 'not a version\n')
  assert.equal(resolveStartCli(env).cli.kind, 'am')
  // am's current is a link to a release inside its own store: that is how am installs.
  const release = join(f.amHome, 'parts', 'automagik.am', '3.167.0')
  rmSync(f.am, { recursive: true })
  f.addCli(release, '3.167.0')
  symlinkSync(release, f.am)
  assert.equal(resolveStartCli(env).cli.dir, release)
  // A current that leads out of the store, or a launcher that does, is no CLI at all.
  unlinkSync(f.am)
  const outside = join(f.root, 'outside')
  f.addCli(outside, '9.9.9')
  symlinkSync(outside, f.am)
  assert.deepEqual(resolveStartCli(env), { outcome: 'update-am' }, 'the old-version pack is all that is left')
  unlinkSync(f.am)
  symlinkSync(release, f.am)
  rmSync(join(release, 'bin', 'automagik-herdr.mjs'))
  symlinkSync(join(outside, 'bin', 'automagik-herdr.mjs'), join(release, 'bin', 'automagik-herdr.mjs'))
  assert.deepEqual(resolveStartCli(env), { outcome: 'update-am' })
  // A release folder whose name hides it, or a pack mod that is a link, is no CLI either.
  unlinkSync(f.am)
  const hidden = join(f.amHome, 'parts', 'automagik.am', '.staging-1')
  f.addCli(hidden, '3.167.0')
  symlinkSync(hidden, f.am)
  assert.deepEqual(resolveStartCli(env), { outcome: 'update-am' })
  unlinkSync(f.am)
  const linkedMod = join(f.root, 'mod-elsewhere')
  f.addCli(linkedMod, '3.170.0')
  rmSync(f.pack, { recursive: true })
  symlinkSync(linkedMod, f.pack)
  assert.deepEqual(resolveStartCli(env), { outcome: 'no-cli' })
  unlinkSync(f.pack)
  f.addCli(f.pack, '3.166.0')
  rmSync(f.pack, { recursive: true })
  assert.deepEqual(resolveStartCli(env), { outcome: 'no-cli' })
})

test('an old CLI asks for an update: before any spawn by its version, after one by its own refusal', async (t) => {
  const f = fixture(t, { cli: '3.166.0' })
  const h = host(t, f)
  assert.equal(await h.outcome({ botId: DEV }), 'update-am')
  assert.deepEqual(f.calls(), [])
  rmSync(f.pack, { recursive: true })
  assert.equal(await h.outcome({ botId: DEV }), 'no-cli')
  f.addCli(f.pack, '3.167.0')
  f.respond({ code: 2, stderr: `am: Unknown option '--local-only'. ${SENTINEL}\n` })
  assert.equal(await h.outcome({ botId: DEV }), 'update-am')
  f.respond({ code: 2, stderr: `am: --local-only needs a nonempty --project folder.\n`, stdout: JSON.stringify({ error: SENTINEL, refused: 'usage' }) })
  assert.equal(await h.outcome({ botId: DEV }), 'start-failed')
  assert.equal(f.calls().length, 2)
})

test('every CLI answer maps to a fixed outcome, and nothing of its text reaches the page', async (t) => {
  const out = (stdout, code = 1, stderr = '') => ({ code, signal: null, stdout: Buffer.from(typeof stdout === 'string' ? stdout : JSON.stringify(stdout)), stderr: Buffer.from(stderr) })
  const refused = (refused, code) => startOutcome(DEV, out({ error: SENTINEL, refused }, code))
  assert.equal(refused('no-roster', 1), 'not-in-roster')
  assert.equal(refused('not-in-roster', 1), 'not-in-roster')
  assert.equal(refused('not-startable', 1), 'not-startable')
  assert.equal(refused('held-elsewhere', 1), 'held-elsewhere')
  assert.equal(refused('no-core', 1), 'no-core')
  assert.equal(refused('no-folder', 2), 'folder-missing')
  assert.equal(refused('no-name', 1), 'start-failed', 'refused before any launch')
  assert.equal(refused('incomplete-identity', 1), 'unknown', 'it can come after the launch')
  for (const other of ['transport', 'usage', 'bot-id', 'whatever']) assert.equal(refused(other, 2), 'start-failed', other)
  // A refusal with another exit code than its own is not that refusal.
  assert.equal(refused('no-folder', 1), 'unknown')
  assert.equal(refused('held-elsewhere', 2), 'start-failed')
  // Exit 1 with no refusal made before the launch: a pane may be up, so the result is unknown.
  assert.equal(refused('not-local', 1), 'unknown')
  assert.equal(startOutcome(DEV, out('', 1, 'am: the attach row could not be written')), 'unknown')
  assert.equal(startOutcome(DEV, out({ id: DEV, terminal: 't3' }, 0)), 'started')
  assert.equal(startOutcome(DEV, out({ id: DEV, running: 't3' }, 0)), 'already-running')
  assert.equal(startOutcome(DEV, out({ id: LEAD, terminal: 't3' }, 0)), 'unknown', 'another Bot')
  assert.equal(startOutcome(DEV, out({ id: DEV, terminal: 'lab/t3' }, 0)), 'unknown', 'a linked machine\'s terminal')
  assert.equal(startOutcome(DEV, out({ id: DEV, terminal: 'dev-pane' }, 0)), 'unknown', 'a pane name is not a terminal id')
  assert.equal(startOutcome(DEV, out({ id: DEV, running: 'lab/t3' }, 0)), 'unknown')
  assert.equal(startOutcome(DEV, out({ id: DEV }, 0)), 'unknown')
  assert.equal(startOutcome(DEV, out('not json', 0)), 'unknown')
  assert.equal(startOutcome(DEV, { ...out({ id: DEV, terminal: 't3' }, 0), truncated: true }), 'unknown')
  assert.equal(startOutcome(DEV, { ...out({ id: DEV, terminal: 't3' }, null), signal: 'SIGTERM' }), 'unknown', 'killed after the spawn')
  assert.equal(startOutcome(DEV, { ...out('', null), signal: 'spawn' }), 'start-failed', 'never started')
  assert.equal(startOutcome(DEV, { ...out({ id: DEV, terminal: 't3' }, 0), closed: false }), 'unknown', 'output still coming')

  const f = fixture(t)
  const h = host(t, f)
  f.respond({ code: 1, stdout: JSON.stringify({ error: `${SENTINEL} ${f.project}`, refused: 'held-elsewhere' }), stderr: `am: ${SENTINEL}\n` })
  const reply = await h.call({ botId: DEV })
  assert.deepEqual(reply, { ok: true, value: { outcome: 'held-elsewhere' } })
  f.respond({ stdout: JSON.stringify({ id: DEV, terminal: 't12', argv: [SENTINEL] }), stderr: SENTINEL })
  const started = JSON.stringify(await h.call({ botId: DEV }))
  assert.equal(started, JSON.stringify({ ok: true, value: { outcome: 'started' } }))
  assert.ok(h.warnings.every(line => !line.includes(SENTINEL) && !line.includes(f.project)), h.warnings.join('\n'))
})

test('a slow start answers pending, is never killed, and holds the one start slot until it ends', async (t) => {
  const f = fixture(t)
  const h = host(t, f, { waitMs: 300 })
  const marker = join(f.root, 'finished')
  f.respond({ delayMs: 1500, marker, stdout: JSON.stringify({ id: DEV, terminal: 't12' }) })
  const controller = new AbortController()
  const first = h.request({ botId: DEV }, { signal: controller.signal })
  assert.equal(await h.outcome({ botId: DEV }), 'busy', 'a second request while the first is reading or running')
  assert.ok(await wait(() => f.calls().length === 1), 'the child is running')
  controller.abort()
  // The aborted request may answer or not; the start goes on either way.
  await first.then(r => r.text()).catch(() => null)
  assert.equal(await h.outcome({ botId: DEV }), 'busy', 'the slot is held until the child exits')
  const again = host(t, f, { waitMs: 300 })
  assert.equal(await again.outcome({ botId: DEV }), 'busy', 'a reinstalled plugin shares the one start slot')
  assert.ok(await wait(() => existsSync(marker)), 'the child ran to its end')
  assert.ok(await wait(() => h.warnings.some(line => line.includes('a Code start ended: started'))))
  assert.ok(await wait(() => h.outcome({ botId: LEAD }).then(outcome => outcome !== 'busy')), 'the slot is free once the child exited')
  f.respond({ delayMs: 900, stdout: JSON.stringify({ id: DEV, terminal: 't12' }) })
  assert.equal(await h.outcome({ botId: DEV }), 'pending', 'a start past the wait answers pending')
  assert.ok(await wait(() => h.warnings.filter(line => line.includes('a Code start ended: started')).length === 2))
  f.respond({ stdout: JSON.stringify({ id: DEV, running: 't12' }) })
  assert.equal(await h.outcome({ botId: DEV }), 'already-running')
  assert.equal(f.calls().length, 3)
})

test('output past the cap is drained, kills nothing, and is never read as an answer', async (t) => {
  const f = fixture(t)
  const h = host(t, f)
  const marker = join(f.root, 'finished')
  f.respond({ bulk: 3 * 1024 * 1024, marker, stdout: JSON.stringify({ id: DEV, terminal: 't12' }) })
  assert.equal(await h.outcome({ botId: DEV }), 'unknown', 'the reply past the cap cannot be read')
  assert.ok(existsSync(marker), 'the child ran to its end')
  // A valid answer padded past the cap would parse from its first MiB: it is cut, so unknown.
  f.respond({ pad: 2 * 1024 * 1024, stdout: JSON.stringify({ id: DEV, terminal: 't12' }) })
  assert.equal(await h.outcome({ botId: DEV }), 'unknown')
})
