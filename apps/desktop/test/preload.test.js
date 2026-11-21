import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { openHerdr, openRequest } from '../src/herdr-space.js'

// preload.cjs runs sandboxed in the page, where `require` gives only Electron's own modules: it
// is run here in a context of its own, with a fake Electron that records what it is asked.
function loadPreload({ activation }) {
  const exposed = {}
  const invoked = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
    ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve('answered') }, on: () => {}, off: () => {} },
  }
  const context = vm.createContext({
    require: name => { if (name === 'electron') return electron; throw new Error(`no ${name} in a sandboxed preload`) },
    process: { platform: 'darwin' },
    document: { documentElement: { dataset: {} }, addEventListener: () => {} },
    navigator: activation === undefined ? {} : { userActivation: { isActive: activation } },
    console,
  })
  vm.runInContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), context)
  return { herdr: exposed.omniDesktop.herdr, account: exposed.omniDesktop.account, invoked }
}

test('the preload refuses open() without a click, and sends nothing to main', async () => {
  for (const activation of [undefined, false]) {
    const { herdr, invoked } = loadPreload({ activation })
    await assert.rejects(herdr.open({ botId: 'b1' }), /only on a click/)
    assert.deepEqual(invoked, [])
  }
})

test('during a click, open() sends the Bot id and nothing else; status() asks with nothing', async () => {
  const { herdr, invoked } = loadPreload({ activation: true })
  assert.equal(await herdr.open({ botId: 'b1', folder: '/etc', machine: 'vps' }), 'answered')
  await herdr.open({ botId: 42 })
  await herdr.open()
  await herdr.status()
  // The objects come from the preload's own realm: compare their JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-herdr-open', { botId: 'b1' }],
    ['automagik-herdr-open', { botId: null }],
    ['automagik-herdr-open', { botId: null }],
    ['automagik-herdr-status'],
  ])
  assert.ok(Object.isFrozen(herdr))
})

test('an answer to the update offer: only a boolean update reaches main, still only on a click', async () => {
  const { herdr, invoked } = loadPreload({ activation: true })
  await herdr.open({ botId: 'b1', update: true })
  await herdr.open({ botId: 'b1', update: false })
  await herdr.open({ botId: 'b1', update: 'yes', url: 'https://evil.example/herdr.tar.gz' })
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-herdr-open', { botId: 'b1', update: true }],
    ['automagik-herdr-open', { botId: 'b1', update: false }],
    ['automagik-herdr-open', { botId: 'b1' }],
  ])
  const idle = loadPreload({ activation: false })
  await assert.rejects(idle.herdr.open({ botId: 'b1', update: true }), /only on a click/)
  assert.deepEqual(idle.invoked, [])
})

const ROW = 'b-abcdefghij'
const SESSION = 'session-0b6f2c1e-5d4a-4c3b-9a2f-1e0d9c8b7a65'

test('openCodeRow requires activation and sends only its Bot id, Code source and optional boolean answer', async () => {
  for (const activation of [undefined, false]) {
    const { herdr, invoked } = loadPreload({ activation })
    await assert.rejects(herdr.openCodeRow(ROW, { update: true }), /only on a click/)
    assert.deepEqual(invoked, [])
  }
  const { herdr, invoked } = loadPreload({ activation: true })
  assert.equal(await herdr.openCodeRow(ROW, { source: 'team', folder: '/etc', update: 'yes' }), 'answered')
  await herdr.openCodeRow(ROW, { botId: SESSION, update: true })
  await herdr.openCodeRow(ROW, { update: false })
  await herdr.openCodeRow({ botId: ROW })
  await herdr.open({ botId: SESSION, source: 'code' })
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-herdr-open', { botId: ROW, source: 'code' }],
    ['automagik-herdr-open', { botId: ROW, source: 'code', update: true }],
    ['automagik-herdr-open', { botId: ROW, source: 'code', update: false }],
    ['automagik-herdr-open', { botId: null, source: 'code' }],
    ['automagik-herdr-open', { botId: SESSION }],
  ])
})

function openFixture(t) {
  const registryRoot = mkdtempSync(join(tmpdir(), 'desktop-code-row-'))
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }))
  const appHome = join(registryRoot, 'desktop')
  const project = join(registryRoot, 'project')
  const team = join(registryRoot, 'team')
  const files = [
    [join(registryRoot, 'bots', 'bots.json'), { version: 2, bots: [], projects: [{ folder: project }], shown: [{ project, bots: [] }] }],
    [join(project, '.automagik', 'bots', 'bots.json'), { version: 2, bots: [{ id: ROW, name: 'Registry only' }, { id: SESSION, name: 'Registry session' }] }],
    [join(appHome, 'bots', 'state.json'), { bots: { [SESSION]: { workDir: team } } }],
  ]
  for (const [file, contents] of files) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(contents))
  }
  mkdirSync(team)
  const { herdr, invoked } = loadPreload({ activation: true })
  const calls = []
  const deps = {
    host: { platform: process.platform, env: {} }, appHome, registryRoot,
    offer: { offered: null, declined: null },
    findHerdr: () => ({ bin: 'fake-herdr' }),
    openLatest: async () => ({ ok: true, raised: true }),
    execFile: (file, argv, options, done) => {
      assert.equal(file, 'fake-herdr')
      calls.push(argv)
      queueMicrotask(() => done(null, argv[0] === 'ls' ? '{"spaces":[]}' : '{"space":"new"}', ''))
    },
  }
  const handle = () => {
    const [channel, request] = invoked.shift()
    assert.equal(channel, 'automagik-herdr-open')
    return openHerdr(openRequest(request), deps)
  }
  return { herdr, handle, calls, deps, project, team }
}

const newSpace = (name, folder) => ['do', 'space.new', JSON.stringify({ name, folder })]

test('the preload through openHerdr opens a registry-only Bot and routes a colliding session id by capability', async t => {
  const { herdr, handle, calls, project, team } = openFixture(t)
  await herdr.openCodeRow(ROW)
  assert.deepEqual((await handle()).space, { action: 'new', id: 'new' })
  await herdr.openCodeRow(SESSION)
  assert.deepEqual((await handle()).space, { action: 'new', id: 'new' })
  await herdr.open({ botId: SESSION, source: 'code' })
  assert.deepEqual((await handle()).space, { action: 'new', id: 'new' })
  assert.deepEqual(calls, [
    ['ls'], newSpace('project', project),
    ['ls'], newSpace('project', project),
    ['ls'], newSpace('team', team),
  ])
})

test('the preload through openHerdr keeps the original Code row for either answer to an update offer', async t => {
  for (const update of [true, false]) {
    await t.test(update ? 'accept' : 'decline', async t => {
      const { herdr, handle, calls, deps, project } = openFixture(t)
      const seen = []
      const offer = { ok: false, reason: 'update', latest: '0.2.0' }
      deps.openLatest = async ({ update, offered, skip }) => {
        seen.push({ update, offered, skip })
        return update === undefined ? offer : { ok: true, raised: true }
      }
      await herdr.openCodeRow(ROW)
      assert.deepEqual(await handle(), offer)
      assert.deepEqual(calls, [])
      await herdr.openCodeRow(ROW, { update })
      assert.deepEqual((await handle()).space, { action: 'new', id: 'new' })
      assert.deepEqual(seen, [
        { update: undefined, offered: null, skip: null },
        { update, offered: offer.latest, skip: update ? null : offer.latest },
      ])
      assert.deepEqual(calls, [['ls'], newSpace('project', project)])
    })
  }
})

test('main sends the shared root to the Herdr handler and keeps its page guard and single flight', async () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(main, /const root = automagikHome\(\)/, 'the shared root is Automagik home')
  assert.match(main, /return dshEnv\(\{\s*home,\s*root,/, 'DSH receives the same root')
  const start = main.indexOf("ipcMain.handle('automagik-herdr-open'")
  const end = main.indexOf('\n})', start)
  assert.ok(start >= 0 && end > start, 'the Herdr IPC handler exists')

  let handler
  let release
  const pending = new Promise(resolve => { release = resolve })
  const calls = []
  const appHome = '/scratch/automagik/desktop'
  const registryRoot = '/scratch/automagik'
  vm.runInNewContext(`let herdrOpening = null;\n${main.slice(start, end + 3)}`, {
    ipcMain: { handle: (channel, callback) => {
      assert.equal(channel, 'automagik-herdr-open')
      handler = callback
    } },
    fromPage: event => event.trusted === true,
    openRequest,
    openHerdr: (request, deps) => { calls.push({ request, deps }); return pending },
    herdrHost: () => ({ platform: 'linux', env: {} }),
    home: appHome, root: registryRoot, herdrOffer: { offered: null, declined: null },
    switchLog: () => {},
  })
  const request = { botId: ROW, source: 'code', folder: '/etc' }
  assert.equal(handler({ trusted: false }, request), null)
  assert.deepEqual(calls, [])
  const first = handler({ trusted: true }, request)
  const second = handler({ trusted: true }, { botId: SESSION })
  assert.strictEqual(second, first)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request, { botId: ROW, source: 'code', update: undefined })
  assert.equal(calls[0].deps.appHome, appHome)
  assert.equal(calls[0].deps.registryRoot, registryRoot)
  release({ ok: true })
  assert.deepEqual(await first, { ok: true })
  assert.notStrictEqual(handler({ trusted: true }, request), first, 'a completed open frees the next click')
  assert.equal(calls.length, 2)
})

test('the account bridge: a sign-in needs a click, and status/sign-out send nothing of the page', async () => {
  for (const activation of [undefined, false]) {
    const { account, invoked } = loadPreload({ activation })
    await assert.rejects(account.signIn(), /starts from a click/)
    assert.deepEqual(invoked, [])
  }
  const { account, invoked } = loadPreload({ activation: true })
  assert.equal(await account.signIn(), 'answered')
  assert.equal(await account.status(), 'answered')
  assert.equal(await account.signOut(), 'answered')
  assert.equal(typeof account.subscribe(() => {}), 'function')
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
    ['automagik-account-signin'],
    ['automagik-account-status'],
    ['automagik-account-signout'],
  ])
  // Nothing the page can hand the bridge reaches main: the calls take no arguments.
  assert.equal(account.signIn.length, 0)
  assert.equal(account.status.length, 0)
  assert.equal(account.signOut.length, 0)
})
