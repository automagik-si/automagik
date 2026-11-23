// #1564 PR B: the native-tools switch on Codex, bound to the agent a Bot runs on.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { install } from '../src/host/native-tools.js'
import { fakeContext } from './fake-ctx.js'

const CODEX = 'acp-codex'
const CLAUDE = 'acp-claude'
const OMP = 'acp-omp'
const OFF_TEXT = 'Native tools were turned off for this Bot, so this answer stopped. Send your message again.'
const CHANGED_TEXT = 'The tools setting changed; send again.'
const KEPT_TEXT = "This model can't turn its native tools off."
const NOT_OFFERED = "Native tools are not offered for this Bot's agent."
const CHANGED = 'The Bot team changed. Try again.'
const CODEX_ON = "In its own chat with you, Codex uses its own tools (commands, file edits…). They run in Codex's own sandbox, outside Automagik's. What asks you first depends on the permission level. Turning this off stops its running session at once."
const CODEX_OFF = "Codex uses Automagik's tools, approved in Automagik. Groups, tasks and scheduled runs always do. Applies from your next message in this Bot's direct chat. Turning it off ends the running session."
const record = (id, model, extra = {}) => ({ id, sessionId: 'chat-' + id, name: 'Bot ' + id, model, createdAt: 1, capabilities: [], ...extra })
const team = (bots, mainBotIds = ['main']) => ({
  version: 2, revision: 0, mainBotIds,
  whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true,
  nativeToolsOmpKept: true, nativeToolsCodexKept: true,
  bots: { main: record('main', CLAUDE + '/default'), ...bots },
})
const fields = bot => [bot?.nativeTools, bot?.nativeToolsAgent, bot?.nativeToolsKept]
const NONE = [undefined, undefined, undefined]

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NativeToolsRow } from './src/client/details-drawer.js'",
    "export { installLocale } from './src/client/i18n.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})
const bundle = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: bundle, exports: bundle.exports,
  require: () => ({ createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }) }),
})
const row = bot => bundle.exports.NativeToolsRow({ bot: { id: 'a', ...bot }, roster: {}, actions: { updateBot() {} }, run: () => {} })

// A store-backed Bot team host, as test/native-tools-omp-migration.test.js builds it.
function workspace(t, state) {
  const home = mkdtempSync(join(tmpdir(), 'native-codex-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const hosts = []
  t.after(async () => {
    for (const current of hosts) await current.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, async open(options) {
    const current = host(home, options)
    hosts.push(current)
    await current.rt.load()
    return current
  } }
}

function host(home, { acp = {}, sessionPersistence } = {}) {
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
    sessionPersistence: sessionPersistence ?? {
      open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [{ id: CODEX, name: 'Codex' }, { id: CLAUDE, name: 'Claude' }, { id: OMP, name: 'omp' }]
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
    stored: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')),
    view: async id => (await call('state', { requestId: randomUUID() })).value.bots.find(bot => bot.id === id),
  }
}

// The plain runtime of test/native-tools.test.js, for the parts with no store.
function runtime({ bots = {}, services = {} } = {}) {
  const records = new Map(Object.entries(bots))
  const rt = {
    ctx: {
      registry: new Map(),
      get: name => ({ sandboxPolicy: { defaultMode: 'workspace-write' }, ...services })[name],
      sessions: { get: () => undefined },
    },
    chatOwners: new Map([...records.keys()].map(id => ['direct-' + id, id])),
    groupOwners: new Map([['group-a', { botId: 'a' }]]),
    pastOwners: new Map([['old-a', { botId: 'a' }]]),
    taskOwners: new Map([['task-a', { botId: 'a' }]]),
    botOf: id => records.get(id),
    chatOf: id => 'direct-' + id,
    isMain: () => false,
  }
  install(rt)
  return rt
}

test('S1 a delayed ON on Codex racing other saves is written for Codex, live and after a reload', async t => {
  const { open } = workspace(t, team({ a: record('a', CODEX + '/default') }))
  const h = await open()
  const normalSave = h.rt.save
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const racing = []
  h.rt.save = async options => {
    if (options?.enableNativeTools === undefined) return normalSave(options)
    entered.resolve()
    await gate.promise
    const write = normalSave(options)
    // An unrelated save queued right behind the ON write encodes the live record.
    racing.push(normalSave({ required: true }))
    return write
  }
  const response = h.call('update-bot', { id: 'a', nativeTools: true })
  await entered.promise
  // An unrelated save while ON waits writes no ON: ON belongs to its own write.
  await normalSave({ required: true })
  assert.deepEqual(fields(h.stored().bots.a), NONE)
  assert.deepEqual(fields(h.rt.botOf('a')), NONE)
  gate.resolve()
  const result = await response
  assert.equal(result.ok, true, JSON.stringify(result))
  await Promise.all(racing)
  assert.deepEqual(fields(h.rt.botOf('a')), [true, CODEX, undefined])
  assert.deepEqual(fields(h.stored().bots.a), [true, CODEX, undefined])
  assert.equal(h.rt.nativeToolsFor('chat-a'), true)
  await h.dispose()

  const second = await open()
  assert.deepEqual(fields(second.rt.botOf('a')), [true, CODEX, undefined])
  assert.deepEqual(fields(second.stored().bots.a), [true, CODEX, undefined])
  assert.equal(second.rt.nativeToolsFor('chat-a'), true)
})

test('S2 a model change while ON reads the permission level refuses ON and writes nothing', async t => {
  const opened = Promise.withResolvers()
  const release = Promise.withResolvers()
  const sessionPersistence = {
    open: async () => {
      opened.resolve()
      await release.promise
      throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' })
    },
  }
  const { open } = workspace(t, team({ a: record('a', CODEX + '/default') }))
  const h = await open({ sessionPersistence })
  const revision = h.stored().revision
  const response = h.call('update-bot', { id: 'a', nativeTools: true })
  await opened.promise
  h.rt.botOf('a').model = CLAUDE + '/default'
  release.resolve()
  const result = await response
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.message, CHANGED)
  assert.deepEqual(fields(h.rt.botOf('a')), NONE)
  assert.deepEqual(fields(h.stored().bots.a), NONE)
  assert.equal(h.stored().revision, revision)
})

test('S3 a failed ON leaves no key; a failed OFF restores every field it cleared', async t => {
  const omp = record('omp', OMP + '/default', { nativeTools: true, nativeToolsAgent: OMP, nativeToolsKept: OMP })
  const { home, open } = workspace(t, team({
    a: record('a', CODEX + '/default'),
    b: record('b', CODEX + '/default', { nativeTools: true, nativeToolsAgent: CODEX }),
    omp,
  }))
  const h = await open()
  const blocker = join(home, 'state.json.' + process.pid + '.tmp')
  mkdirSync(blocker)
  const failedOn = await h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(failedOn.ok, false, JSON.stringify(failedOn))
  assert.deepEqual(fields(h.rt.botOf('a')), NONE)
  assert.deepEqual(fields(h.stored().bots.a), NONE)
  for (const [id, before] of [['b', [true, CODEX, undefined]], ['omp', [true, OMP, OMP]]]) {
    const failedOff = await h.call('update-bot', { id, nativeTools: false })
    assert.equal(failedOff.ok, false, JSON.stringify(failedOff))
    assert.deepEqual(fields(h.rt.botOf(id)), before, id)
    assert.deepEqual(fields(h.stored().bots[id]), before, id)
  }
  rmSync(blocker, { recursive: true })
  // OFF clears all three before its save, so a refused save cannot leave a half-cleared Bot.
  const normalSave = h.rt.save
  const seen = []
  h.rt.save = async () => {
    seen.push(fields(h.rt.botOf('b')))
    throw new Error('test: OFF save refused')
  }
  assert.equal((await h.call('update-bot', { id: 'b', nativeTools: false })).ok, false)
  assert.deepEqual(seen, [NONE])
  assert.deepEqual(fields(h.rt.botOf('b')), [true, CODEX, undefined])
  h.rt.save = normalSave
  const on = await h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.deepEqual(fields(h.stored().bots.a), [true, CODEX, undefined])
  const off = await h.call('update-bot', { id: 'omp', nativeTools: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.deepEqual(fields(h.stored().bots.omp), NONE)
})

test('S4 a Codex ON reads OFF after a move to Claude and ON again back on Codex', async t => {
  const { open } = workspace(t, team({ a: record('a', CODEX + '/default', { nativeTools: true, nativeToolsAgent: CODEX }) }))
  const h = await open()
  const bot = h.rt.botOf('a')
  assert.equal(h.rt.nativeToolsFor('chat-a'), true)
  const shown = row(await h.view('a'))
  assert.notEqual(shown, null, 'a Codex Bot has the row')
  assert.equal(shown.props.on, true)
  bot.model = CLAUDE + '/default'
  assert.equal(h.rt.nativeToolsFor('chat-a'), false)
  assert.equal(h.identity('chat-a').nativeTools, false)
  const moved = row(await h.view('a'))
  assert.equal(moved.props.on, false)
  assert.equal(moved.props.disabled, false)
  bot.model = CODEX + '/default'
  assert.equal(h.rt.nativeToolsFor('chat-a'), true)
  assert.equal(h.identity('chat-a').nativeTools, true)
})

test('S4b an ON saved for one agent turns on for the agent the Bot runs on now', async t => {
  const { open } = workspace(t, team({
    claudeOn: record('claudeOn', CODEX + '/default', { nativeTools: true }),
    codexOn: record('codexOn', CLAUDE + '/default', { nativeTools: true, nativeToolsAgent: CODEX }),
    kept: record('kept', OMP + '/default', { nativeTools: true, nativeToolsKept: OMP }),
    toOmp: record('toOmp', OMP + '/default', { nativeTools: true }),
  }))
  const h = await open()
  // A Claude ON (no tag) on a Bot now on Codex reads OFF until the owner turns it on here.
  assert.equal(h.rt.nativeToolsFor('chat-claudeOn'), false)
  for (const [id, agent] of [['claudeOn', CODEX], ['codexOn', CLAUDE], ['toOmp', OMP]]) {
    assert.equal(h.rt.nativeToolsFor('chat-' + id), false, id)
    const result = await h.call('update-bot', { id, nativeTools: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(fields(h.stored().bots[id]), [true, agent, undefined], id)
    assert.deepEqual(fields(h.rt.botOf(id)), [true, agent, undefined], id)
  }
  // The omp migration's tag reads ON on omp and OFF once the Bot moves to Codex.
  assert.equal(h.rt.nativeToolsFor('chat-kept'), true)
  assert.equal(h.identity('chat-kept').nativeToolsAgent, OMP)
  h.rt.botOf('kept').model = CODEX + '/default'
  assert.equal(h.rt.nativeToolsFor('chat-kept'), false)
  assert.equal(row(await h.view('kept')).props.on, false)
  await h.dispose()

  const second = await open()
  for (const [id, agent] of [['claudeOn', CODEX], ['codexOn', CLAUDE], ['toOmp', OMP]]) {
    assert.deepEqual(fields(second.rt.botOf(id)), [true, agent, undefined], id)
    assert.equal(second.rt.nativeToolsFor('chat-' + id), true, id)
    assert.equal(second.identity('chat-' + id).nativeToolsAgent, agent, id)
  }
})

test('S5 the identity names the agent of an eligible ON, and a DeepSeek Bot cannot turn ON', async t => {
  const { open } = workspace(t, team({
    a: record('a', CODEX + '/default', { nativeTools: true, nativeToolsAgent: CODEX }),
    api: record('api', 'deepseek-official/chat'),
  }))
  const h = await open()
  const identity = h.identity('chat-a')
  assert.equal(identity.nativeTools, true)
  assert.equal(identity.nativeToolsBlocked, false)
  assert.equal(identity.nativeToolsAgent, CODEX)
  h.rt.botOf('a').denyTools = ['bash']
  assert.equal(h.identity('chat-a').nativeTools, false)
  assert.equal(h.identity('chat-a').nativeToolsBlocked, true)
  assert.equal(h.identity('chat-a').nativeToolsAgent, undefined)
  delete h.rt.botOf('a').denyTools

  const revision = h.stored().revision
  const result = await h.call('update-bot', { id: 'api', nativeTools: true })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.message, NOT_OFFERED)
  assert.deepEqual(fields(h.rt.botOf('api')), NONE)
  assert.deepEqual(fields(h.stored().bots.api), NONE)
  assert.equal(h.stored().revision, revision)
  assert.equal(row(await h.view('api')), null)
})

test('S6 turning tools off ends every Session of the Bot through endNative when acp-dsh has it, else endClaudeSession', () => {
  const sessions = ['direct-a', 'group-a', 'old-a', 'task-a']
  const calls = []
  const spy = name => function (...args) { calls.push([name, this, ...args]) }
  const acp = { endNative: spy('endNative'), endClaudeSession: spy('endClaudeSession'), endOmpSession: spy('endOmpSession') }
  const bot = { id: 'a', model: CODEX + '/default', nativeTools: true, nativeToolsAgent: CODEX }
  runtime({ bots: { a: bot }, services: { acpAgents: acp } }).endNativeTools(bot)
  assert.deepEqual(calls.filter(([name]) => name === 'endClaudeSession'), [])
  assert.deepEqual(calls.filter(([name]) => name === 'endNative').map(([, self, ...args]) => [self === acp, ...args]),
    sessions.map(id => [true, id, OFF_TEXT, CHANGED_TEXT]))
  assert.deepEqual(calls.filter(([name]) => name === 'endOmpSession').map(([, , ...args]) => args),
    sessions.map(id => [id, OFF_TEXT, CHANGED_TEXT]))

  calls.length = 0
  const older = { endClaudeSession: spy('endClaudeSession'), endOmpSession: spy('endOmpSession') }
  runtime({ bots: { a: bot }, services: { acpAgents: older } }).endNativeTools(bot)
  assert.deepEqual(calls.filter(([name]) => name === 'endClaudeSession').map(([, , ...args]) => args),
    sessions.map(id => [id, OFF_TEXT, CHANGED_TEXT]))
  assert.equal(calls.filter(([name]) => name === 'endOmpSession').length, sessions.length)
})

test('S7 a Codex model that keeps its own tools is blocked as model-kept, and ON is refused without a write', async t => {
  const asked = []
  const nativeModelKept = route => { asked.push(route); return route === CODEX + '/gpt-5.5' }
  const { open } = workspace(t, team({
    kept: record('kept', CODEX + '/gpt-5.5'),
    luna: record('luna', CODEX + '/gpt-5.6-luna'),
  }))
  const h = await open({ acp: { nativeModelKept } })
  assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('kept')), 'model-kept')
  assert.ok(asked.includes(CODEX + '/gpt-5.5'))
  assert.equal(h.rt.nativeToolsFor('chat-kept'), false)
  const revision = h.stored().revision
  const refused = await h.call('update-bot', { id: 'kept', nativeTools: true })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.equal(refused.error.message, KEPT_TEXT)
  assert.deepEqual(fields(h.rt.botOf('kept')), NONE)
  assert.deepEqual(fields(h.stored().bots.kept), NONE)
  assert.equal(h.stored().revision, revision)
  assert.equal((await h.view('kept')).nativeToolsBlock, 'model-kept')

  // Control: a Codex model the switch applies to has no such block and turns ON.
  assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('luna')), undefined)
  const view = await h.view('luna')
  assert.equal(view.nativeToolsBlock, undefined)
  assert.equal(row(view).props.disabled, false)
  const on = await h.call('update-bot', { id: 'luna', nativeTools: true })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.deepEqual(fields(h.stored().bots.luna), [true, CODEX, undefined])
  assert.equal(h.rt.nativeToolsFor('chat-luna'), true)

  // A Claude Bot is never asked: model-kept is a Codex answer.
  asked.length = 0
  assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('main')), undefined)
  assert.deepEqual(asked, [])
})

test('S7 no nativeModelKept answer, or one that throws, is not kept', () => {
  const kept = { id: 'a', model: CODEX + '/gpt-5.5' }
  for (const services of [{}, { acpAgents: {} }, { acpAgents: { nativeModelKept() { throw new Error('unavailable') } } }]) {
    const rt = runtime({ bots: { a: kept }, services })
    assert.equal(rt.nativeToolsBlock(kept), undefined)
    assert.equal(rt.nativeToolsEligible('direct-a'), true)
  }
  const rt = runtime({ bots: { a: kept }, services: { acpAgents: { nativeModelKept: route => route === CODEX + '/gpt-5.5' } } })
  assert.equal(rt.nativeToolsBlock(kept), 'model-kept')
  assert.equal(rt.nativeToolsEligible('direct-a'), false)
})

test('D1 D2 Details shows the switch on Codex with its own hints, and on an appliedModel-only Claude Bot', () => {
  const off = row({ model: CODEX + '/default' })
  assert.notEqual(off, null, 'a Codex Bot has the row')
  assert.equal(off.props.label, 'Native tools')
  assert.equal(off.props.details, true)
  assert.equal(off.props.on, false)
  assert.equal(off.props.disabled, false)
  assert.equal(off.props.hint, CODEX_OFF)
  const on = row({ model: CODEX + '/default', nativeTools: true, nativeToolsAgent: CODEX })
  assert.equal(on.props.on, true)
  assert.equal(on.props.hint, CODEX_ON)
  // An ON saved for Claude reads OFF on Codex, with the OFF hint.
  const claudeOn = row({ model: CODEX + '/default', nativeTools: true })
  assert.equal(claudeOn.props.on, false)
  assert.equal(claudeOn.props.hint, CODEX_OFF)

  const applied = row({ model: undefined, appliedModel: CLAUDE + '/default' })
  assert.notEqual(applied, null)
  assert.equal(applied.props.label, 'Native tools')
  assert.equal(applied.props.on, false)
  assert.equal(row({ model: undefined, appliedModel: CLAUDE + '/default', nativeTools: true }).props.on, true)
  // A Codex ON reads OFF once the Bot runs on Claude.
  assert.equal(row({ model: undefined, appliedModel: CLAUDE + '/default', nativeTools: true, nativeToolsAgent: CODEX }).props.on, false)
})

test('D3 a model-kept Codex Bot shows the switch OFF and locked, in every language, ahead of restricted', () => {
  for (const extra of [{}, { nativeTools: true, nativeToolsAgent: CODEX }]) {
    const locked = row({ model: CODEX + '/gpt-5.5', nativeToolsBlock: 'model-kept', ...extra })
    assert.notEqual(locked, null)
    assert.equal(locked.props.label, 'Native tools')
    assert.equal(locked.props.on, false)
    assert.equal(locked.props.disabled, true)
    assert.equal(locked.props.hint, KEPT_TEXT)
  }

  let zh
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  let active = 'zh'
  const off = bundle.exports.installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => key => (active === 'zh' ? zh : pt)[key] ?? key,
  })
  try {
    assert.equal(zh[KEPT_TEXT], '此模型无法关闭其原生工具。')
    assert.equal(pt[KEPT_TEXT], 'Este modelo não permite desligar as tools nativas.')
    assert.equal(row({ model: CODEX + '/gpt-5.5', nativeToolsBlock: 'model-kept' }).props.hint, '此模型无法关闭其原生工具。')
    active = 'pt'
    assert.equal(row({ model: CODEX + '/gpt-5.5', nativeToolsBlock: 'model-kept' }).props.hint, 'Este modelo não permite desligar as tools nativas.')
    for (const key of [CODEX_ON, CODEX_OFF]) {
      assert.ok(zh[key] && zh[key] !== key, key)
      assert.ok(pt[key] && pt[key] !== key, key)
    }
  } finally { off() }

  // The host gives model-kept even to a restricted Bot: no switch to offer on this model.
  const services = { acpAgents: { nativeModelKept: route => route === CODEX + '/gpt-5.5' } }
  for (const restriction of [{ shell: false }, { denyTools: ['bash'] }]) {
    const bot = { id: 'a', model: CODEX + '/gpt-5.5', ...restriction }
    assert.equal(runtime({ bots: { a: bot }, services }).nativeToolsBlock(bot), 'model-kept')
    const other = { id: 'a', model: CODEX + '/gpt-5.6-luna', ...restriction }
    assert.equal(runtime({ bots: { a: other }, services }).nativeToolsBlock(other), 'restricted')
  }
})
