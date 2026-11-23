// #1564 PR B: the one-time Codex native-tools migration (store adopt, Q1/Q5).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const CODEX = 'acp-codex'
const WARNING = 'omni-ui: 2 Codex Bot(s) kept off native tools: shell access off or denied tools'
const record = (id, model, extra = {}) => ({ id, sessionId: 'chat-' + id, name: 'Bot ' + id, model, createdAt: 1, capabilities: [], ...extra })
const unmarked = {
  version: 2, revision: 0, mainBotIds: ['main'], nativeToolsOmpKept: true,
  bots: {
    main: record('main', 'acp-claude/default'),
    codex: record('codex', CODEX + '/default'),
    applied: record('applied', undefined, { appliedModel: CODEX + '/default' }),
    claude: record('claude', 'acp-claude/default'),
    api: record('api', 'deepseek/chat'),
    bash: record('bash', CODEX + '/default', { denyTools: ['bash'] }),
    fetch: record('fetch', CODEX + '/default', { denyTools: ['web_fetch'] }),
  },
}
const noCodex = {
  version: 2, revision: 3, mainBotIds: ['claude'],
  whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true, nativeToolsOmpKept: true,
  capabilities: { items: {} },
  bots: {
    claude: record('claude', 'acp-claude/default'),
    api: record('api', 'deepseek/chat'),
  },
}
const write = (home, state) => writeFileSync(join(home, 'state.json'), JSON.stringify(state))
const read = home => readFileSync(join(home, 'state.json'), 'utf8')
const fields = bot => [bot?.nativeTools, bot?.nativeToolsAgent, bot?.nativeToolsKept]
const ON = [true, CODEX, undefined]
const NONE = [undefined, undefined, undefined]
const codexWarnings = h => h.warnings.filter(line => line.includes('Codex Bot(s) kept off native tools'))

const { outputFiles } = await build({
  stdin: { contents: "export { NativeToolsRow } from './src/client/details-drawer.js'", resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})
const bundle = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: bundle, exports: bundle.exports,
  require: () => ({ createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }) }),
})
const row = bot => bundle.exports.NativeToolsRow({ bot, roster: {}, actions: { updateBot() {} }, run: () => {} })

function workspace(t, state = unmarked) {
  const home = mkdtempSync(join(tmpdir(), 'codex-migration-'))
  write(home, state)
  const hosts = []
  t.after(async () => {
    for (const current of hosts) await current.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, open() {
    const current = host(home)
    hosts.push(current)
    return current
  } }
}

function host(home) {
  let identity
  const warnings = []
  const services = {
    acpAgents: {
      botIdentity: reader => { identity = reader; return () => {} },
      endClaudeSession() {},
      inspect: async () => ({ signedIn: true }),
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessionPersistence: {
      open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [{ id: CODEX, name: 'Codex' }, { id: 'acp-claude', name: 'Claude' }]
  ctx.llm.listModels = async () => [{ id: 'default' }]
  ctx.llm.resolveModelInfo = async () => ({})
  ctx.workspaceRegistry = {
    get: () => undefined, resolveByPath: async () => undefined,
    create: async path => ({ id: 'team', path }), archiveSession: async () => {},
  }
  ctx.sessionController = {
    create: async () => ({ sessionId: 'new' }),
    resolveAgent: async id => ({ agent: { session: { id, deriveMessages: () => [] }, followup: () => {} } }),
    selectModel: async () => {},
  }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { get: () => undefined, flush: async () => true }
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  return {
    rt, warnings, call,
    dispose: () => ctx.dispose(),
    identity: id => identity(id),
    stored: () => JSON.parse(read(home)),
    view: async id => (await call('state', { requestId: randomUUID() })).value.bots.find(bot => bot.id === id),
  }
}

function assertMigrated(state) {
  assert.equal(state.nativeToolsCodexKept, true)
  for (const id of ['codex', 'applied']) assert.deepEqual(fields(state.bots[id]), ON, id)
  // The Main Bot takes the older avatar migrations, so only its native fields are compared.
  assert.deepEqual(fields(state.bots.main), NONE)
  for (const id of ['claude', 'api']) assert.deepEqual(state.bots[id], unmarked.bots[id], id)
  for (const id of ['bash', 'fetch']) assert.deepEqual(fields(state.bots[id]), NONE, id)
}

test('M1 one pass keeps model and appliedModel Codex Bots ON, skips restricted Bots and other agents, and warns once', async t => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  assertMigrated(h.rt.state)
  assertMigrated(h.stored())
  assert.deepEqual(codexWarnings(h), [WARNING])
  // The appliedModel-only Codex Bot reads ON through the identity and through the row.
  assert.equal(h.rt.nativeToolsFor('chat-applied'), true)
  const identity = h.identity('chat-applied')
  assert.equal(identity.nativeTools, true)
  assert.equal(identity.nativeToolsAgent, CODEX)
  const view = await h.view('applied')
  assert.equal(view.nativeToolsBlock, undefined)
  const shown = row(view)
  assert.equal(shown.props.label, 'Native tools')
  assert.equal(shown.props.on, true)
  assert.equal(shown.props.disabled, false)
  // A restricted Codex Bot stays OFF and its row says why.
  const restricted = row(await h.view('bash'))
  assert.equal(restricted.props.on, false)
  assert.equal(restricted.props.hint, 'Not available while this Bot has shell access off or denied tools.')
})

test('M2 a second load changes nothing: same bytes and no second warning', async t => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  assertMigrated(h.stored())
  await h.dispose()
  const bytes = read(home)
  const second = open()
  await second.rt.load()
  assert.equal(read(home), bytes)
  assertMigrated(second.rt.state)
  assert.deepEqual(codexWarnings(second), [])
})

test('M3 an explicit OFF after the migration survives a reopen', async t => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  assert.deepEqual(fields(h.rt.botOf('codex')), ON)
  const off = await h.call('update-bot', { id: 'codex', nativeTools: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.deepEqual(fields(h.rt.botOf('codex')), NONE)
  const saved = h.stored()
  assert.equal(saved.nativeToolsCodexKept, true)
  assert.deepEqual(fields(saved.bots.codex), NONE)
  await h.dispose()

  const second = open()
  await second.rt.load()
  assert.deepEqual(fields(second.rt.botOf('codex')), NONE)
  assert.deepEqual(fields(second.stored().bots.codex), NONE)
  assert.equal(second.rt.nativeToolsFor('chat-codex'), false)
})

test('M4 a Codex Bot created after the marker is saved OFF and stays OFF on reload', async t => {
  const { home, open } = workspace(t, noCodex)
  const bytes = read(home)
  const h = open()
  await h.rt.load()
  assert.equal(read(home), bytes)
  const created = await h.rt.createBot({ name: 'New Codex', model: CODEX + '/default' })
  assert.equal(created.model, CODEX + '/default')
  const saved = h.stored()
  assert.equal(saved.nativeToolsCodexKept, true)
  assert.deepEqual(fields(saved.bots[created.id]), NONE)
  await h.dispose()

  const second = open()
  await second.rt.load()
  assert.deepEqual(fields(second.rt.botOf(created.id)), NONE)
  assert.deepEqual(fields(second.stored().bots[created.id]), NONE)
  assert.deepEqual(codexWarnings(second), [])
})

test('M5 an outside write of an unmarked team adopted at reclaim migrates in memory, and the next save writes the marker', async t => {
  const { home, open } = workspace(t, { ...noCodex, nativeToolsCodexKept: true })
  const h = open()
  await h.rt.load()
  assert.equal(h.rt.readOnly(), undefined)
  const outside = { ...unmarked, revision: 17, prefs: { marker: 'outside edit' } }
  write(home, outside)
  rmSync(join(home, 'state.lock'))
  await h.rt.refresh()
  assert.equal(h.rt.state.prefs.marker, 'outside edit')
  assertMigrated(h.rt.state)
  await h.rt.save()
  assertMigrated(h.stored())
  assert.equal(h.stored().prefs.marker, 'outside edit')
})

test('M6 a reading host migrates in memory, then takes over after the holder closes and the next save writes the marker', async t => {
  const { home, open } = workspace(t)
  const lock = join(home, 'state.lock')
  const bytes = read(home)
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'fixture-owner' }))
  const reader = open()
  await reader.rt.load()
  assert.ok(reader.rt.readOnly())
  assert.equal(read(home), bytes)
  assertMigrated(reader.rt.state)

  rmSync(lock)
  await reader.rt.refresh()
  assert.equal(reader.rt.readOnly(), undefined)
  assertMigrated(reader.rt.state)
  await reader.rt.save()
  assertMigrated(reader.stored())
})

test('M7 a Claude ON saved before the switch had a tag stays untouched and reads as Claude', async t => {
  const claudeOn = record('claudeOn', 'acp-claude/default', { nativeTools: true })
  const { open } = workspace(t, { ...unmarked, bots: { ...unmarked.bots, claudeOn } })
  const h = open()
  await h.rt.load()
  assert.deepEqual(h.stored().bots.claudeOn, claudeOn)
  assert.deepEqual(h.rt.botOf('claudeOn'), claudeOn)
  assert.equal(h.rt.nativeToolsFor('chat-claudeOn'), true)
  assert.equal(h.identity('chat-claudeOn').nativeTools, true)
  assert.equal(h.identity('chat-claudeOn').nativeToolsAgent, 'acp-claude')
  assert.equal(row(await h.view('claudeOn')).props.on, true)
})

test('a team with no Codex Bot loads without a write: same revision and bytes, marker in memory only', async t => {
  const { home, open } = workspace(t, noCodex)
  const bytes = read(home)
  const h = open()
  await h.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(h.stored().revision, 3)
  assert.equal(h.stored().nativeToolsCodexKept, undefined)
  assert.equal(h.rt.state.nativeToolsCodexKept, true)
  await h.rt.save()
  assert.equal(h.stored().nativeToolsCodexKept, true)
})
