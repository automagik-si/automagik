// #1564 Antigravity: the one-time keep of existing Antigravity Bots' own tools (store adopt, the
// Codex block's rule), and the Details facts the view carries from acp-dsh (`nativeOffNotes`).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const AGY = 'acp-antigravity'
const record = (id, model, extra = {}) => ({ id, sessionId: 'chat-' + id, name: 'Bot ' + id, model, createdAt: 1, capabilities: [], ...extra })
const settled = {
  version: 2, revision: 0, mainBotIds: ['main'],
  whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true,
  nativeToolsOmpKept: true, nativeToolsCodexKept: true, nativeToolsLocksRetired: true,
}
const unmarked = {
  ...settled,
  bots: {
    main: record('main', 'acp-claude/default'),
    agy: record('agy', AGY + '/default'),
    applied: record('applied', undefined, { appliedModel: AGY + '/default' }),
    claude: record('claude', 'acp-claude/default'),
    api: record('api', 'deepseek/chat'),
    shell: record('shell', AGY + '/default', { shell: false }),
    denied: record('denied', AGY + '/default', { denyTools: ['acp_tool'] }),
    savedOff: record('savedOff', AGY + '/default', { nativeTools: false }),
    claudeOn: record('claudeOn', AGY + '/default', { nativeTools: true }),
    ompKept: record('ompKept', AGY + '/default', { nativeTools: true, nativeToolsKept: 'acp-omp' }),
    codexOn: record('codexOn', AGY + '/default', { nativeTools: true, nativeToolsAgent: 'acp-codex' }),
  },
}
const noAgy = { ...settled, revision: 3, capabilities: { items: {} }, bots: { main: record('main', 'acp-claude/default') } }
const write = (home, state) => writeFileSync(join(home, 'state.json'), JSON.stringify(state))
const read = home => readFileSync(join(home, 'state.json'), 'utf8')
const fields = bot => [bot?.nativeTools, bot?.nativeToolsAgent, bot?.nativeToolsKept]
const ON = [true, AGY, undefined]
const NONE = [undefined, undefined, undefined]
const WARNING = 'omni-ui: 2 Antigravity Bot(s) kept off native tools: shell access off or denied tools'
const agyWarnings = h => h.warnings.filter(line => line.includes('Antigravity Bot(s) kept off native tools'))

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
// The row's lines come from the bundle's own realm: compared as plain arrays.
const notesOf = shown => (shown.props.notes === undefined ? undefined : [...shown.props.notes])
const row = bot => bundle.exports.NativeToolsRow({ bot, roster: {}, actions: { updateBot() {} }, run: () => {} })

function workspace(t, state = unmarked) {
  const home = mkdtempSync(join(tmpdir(), 'agy-migration-'))
  write(home, state)
  const hosts = []
  t.after(async () => {
    for (const current of hosts) await current.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, open(options) {
    const current = host(home, options)
    hosts.push(current)
    return current
  } }
}

// A whole runtime on a stored team. `acp` is what acp-dsh answers: by default an acp-dsh that
// offers Antigravity's switch and has nothing to say in Details.
function host(home, { acp = { nativeArgsAgents: [AGY, 'acp-omp'], nativeOffNotes: () => ({}) } } = {}) {
  let identity
  const warnings = []
  const services = {
    acpAgents: {
      botIdentity: reader => { identity = reader; return () => {} },
      endClaudeSession() {},
      inspect: async () => ({ signedIn: true }),
      ...acp,
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessionPersistence: {
      open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [{ id: AGY, name: 'Antigravity' }, { id: 'acp-claude', name: 'Claude' }]
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
    rt, warnings, call, services,
    dispose: () => ctx.dispose(),
    identity: id => identity(id),
    stored: () => JSON.parse(read(home)),
    view: async id => (await call('state', { requestId: randomUUID() })).value.bots.find(bot => bot.id === id),
  }
}

function assertMigrated(state) {
  assert.equal(state.nativeToolsAntigravityKept, true)
  for (const id of ['agy', 'applied', 'claudeOn', 'ompKept', 'codexOn']) assert.deepEqual(fields(state.bots[id]), ON, id)
  assert.deepEqual(fields(state.bots.main), NONE)
  for (const id of ['claude', 'api', 'savedOff']) assert.deepEqual(state.bots[id], unmarked.bots[id], id)
  for (const id of ['shell', 'denied']) assert.deepEqual(fields(state.bots[id]), NONE, id)
}

test('A1 one pass keeps existing Antigravity Bots ON (an ON saved for another agent too), skips restricted ones and an explicit OFF, and warns once', async t => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  assertMigrated(h.rt.state)
  assertMigrated(h.stored())
  assert.deepEqual(agyWarnings(h), [WARNING])
  for (const id of ['agy', 'applied', 'claudeOn', 'ompKept', 'codexOn']) {
    assert.equal(h.rt.nativeToolsFor('chat-' + id), true, id)
    assert.equal(h.identity('chat-' + id).nativeToolsAgent, AGY, id)
    assert.equal(row(await h.view(id)).props.on, true, id)
  }
  const denied = row(await h.view('denied'))
  assert.equal(denied.props.on, false)
  assert.equal(denied.props.hint, 'Not available while this Bot has shell access off or denied tools. Here Antigravity has no tools, so this Bot can only chat.')
  assert.equal(row(await h.view('savedOff')).props.on, false)
})

test('A2 a second load changes nothing: same bytes and no second warning', async t => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  await h.dispose()
  const bytes = read(home)
  const second = open()
  await second.rt.load()
  assert.equal(read(home), bytes)
  assertMigrated(second.rt.state)
  assert.deepEqual(agyWarnings(second), [])
})

test('A3 an Antigravity Bot created after the marker, or re-created, starts OFF', async t => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  const created = await h.rt.createBot({ name: 'New Antigravity', model: AGY + '/default' })
  assert.deepEqual(fields(h.stored().bots[created.id]), NONE)
  // The migrated Bot deleted, then a Bot of the same name made again.
  await h.rt.deleteBot('agy')
  const again = await h.rt.createBot({ name: 'Bot agy', model: AGY + '/default' })
  assert.deepEqual(fields(h.stored().bots[again.id]), NONE)
  await h.dispose()
  const second = open()
  await second.rt.load()
  assert.deepEqual(fields(second.rt.botOf(created.id)), NONE)
  assert.deepEqual(fields(second.rt.botOf(again.id)), NONE)
  assert.equal(second.rt.nativeToolsFor('chat-' + created.id), false)
})

test('A4 a shared Antigravity Bot before the removed-lock upgrade is kept ON at load, then turned off at the first native read', async t => {
  const shared = record('shared', AGY + '/default', { people: { mode: 'allowlist', allow: ['visitor'] } })
  const { nativeToolsLocksRetired, ...pending } = settled
  void nativeToolsLocksRetired
  const { open } = workspace(t, { ...pending, bots: { main: record('main', 'acp-claude/default'), shared } })
  const h = open()
  await h.rt.load()
  assert.deepEqual(fields(h.rt.botOf('shared')), ON)
  h.rt.nativeToolsBlock(h.rt.botOf('shared'))
  assert.deepEqual(fields(h.rt.botOf('shared')), [false, undefined, undefined])
  assert.equal(h.rt.state.nativeToolsLocksRetired, true)
  assert.equal(h.rt.nativeToolsFor('chat-shared'), false)
})

test('A5 a team with no Antigravity Bot loads without a write; the marker rides the next save', async t => {
  const { home, open } = workspace(t, noAgy)
  const bytes = read(home)
  const h = open()
  await h.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(h.stored().nativeToolsAntigravityKept, undefined)
  assert.equal(h.rt.state.nativeToolsAntigravityKept, true)
  await h.rt.save()
  assert.equal(h.stored().nativeToolsAntigravityKept, true)
})

test('V1 the view carries acp-dsh\'s Details facts for an Antigravity Bot only, and the row shows them', async t => {
  let notes = { unchecked: '1.5.15', hooks: true, plugins: true, fresh: true }
  let reads = 0
  const { open } = workspace(t)
  const h = open({ acp: { nativeArgsAgents: [AGY, 'acp-omp'], nativeOffNotes: provider => { reads += 1; return provider === AGY ? notes : undefined } } })
  await h.rt.load()
  const off = await h.view('denied')
  assert.equal(off.nativeToolsUnchecked, '1.5.15')
  assert.equal(off.nativeToolsHooks, true)
  assert.equal(off.nativeToolsPlugins, true)
  assert.equal(off.nativeToolsFresh, true)
  assert.deepEqual(notesOf(row(off)), [
    'Native tools off is checked on agy 1.5.15; this version was not checked.',
    'The check that Antigravity loaded its native-tools-off settings does not cover the first message after Antigravity starts, only the messages after it.',
    "Antigravity can't start with native tools off while its settings hold a hooks.json file. Remove hooks.json to use it with native tools off.",
    "Antigravity can't start with native tools off while its settings hold plugins.",
    'Switch account on Antigravity in Settings starts it with empty settings; it also signs it out.',
  ])
  // ON: only the version line (no first-message line either).
  assert.deepEqual(notesOf(row(await h.view('agy'))), ['Native tools off is checked on agy 1.5.15; this version was not checked.'])
  const claude = await h.view('claude')
  for (const key of ['nativeToolsUnchecked', 'nativeToolsHooks', 'nativeToolsPlugins', 'nativeToolsFresh']) assert.equal(Object.hasOwn(claude, key), false, key)
  // One read per view build, whatever the number of Antigravity Bots.
  reads = 0
  await h.view('agy')
  assert.ok(reads <= 2, `reads: ${reads}`)
  notes = undefined
  const none = await h.view('agy')
  assert.equal(Object.hasOwn(none, 'nativeToolsUnchecked'), false)
  assert.equal(row(none).props.notes, undefined)
})

test('V2 an acp-dsh that does not offer Antigravity\'s switch: no row, no facts, and ON is refused', async t => {
  const { open } = workspace(t)
  const h = open({ acp: { nativeOffNotes: () => ({ hooks: true }) } })
  await h.rt.load()
  const view = await h.view('savedOff')
  assert.equal(view.nativeToolsBlock, 'unoffered')
  assert.equal(Object.hasOwn(view, 'nativeToolsHooks'), false)
  assert.equal(row(view), null)
  const refused = await h.call('update-bot', { id: 'savedOff', nativeTools: true })
  assert.equal(refused.ok, false)
  assert.match(JSON.stringify(refused), /Native tools are not offered for this Bot's agent\./)
  // The kept ON does not reach acp-dsh either.
  assert.equal(h.rt.nativeToolsFor('chat-agy'), false)
})
