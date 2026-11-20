// Real Bot runtime, team files and owner socket. DSH-facing services are fixture functions.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { socketPathOf } from '../src/host/pocket-socket.js'
import { fakeContext } from './fake-ctx.js'

const A = 'b-aaaaaaaaaa'
const B = 'b-bbbbbbbbbb'
const GLOBAL = 'b-cccccccccc'
const TERMINAL = `dsh:${A}`
const GRANT = 'fixture-grant'
const PHONE = 'fixture-phone'
const PROJECT = '/repo/pocket-settings-fixture'
const HELLO = { write: 1, manage: 1 }
const METHODS = ['settings-read', 'settings-name', 'settings-model']
const OLD_READ = { protocol: 1, readOnly: true, methods: ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill'] }
const OLD_WRITE = { protocol: 1, readOnly: false, write: 1, methods: [...OLD_READ.methods, 'send', 'interrupt', 'answer'], dedupe: 'log' }
const READ_ONLY = { kind: 'read-only', message: 'This socket only reads; answer on the computer.' }
const REFUSED = reason => ({ ok: false, state: 'refused', reason })
const PENDING = { ok: false, state: 'unknown', reason: 'pending' }
const NATIVE = 'deepseek/v4'
const NEXT = 'deepseek/v5'
const CODEX = 'acp-codex/gpt-a'
const CODEX_NEXT = 'acp-codex/gpt-b'
const CLAUDE = 'acp-claude/sonnet'
const FABLE = 'acp-claude/claude-fable-5-1[1m]'
const AUTO = { permission: 'workspace-write', permissionAuto: `api:${NATIVE}`, permissionRev: 4 }
const BLOCK = { code: 'MISSING_CREDENTIAL', provider: 'deepseek' }
const PRESET = 'FixtureCustomPresetSecret'
const NOT_APPLIED = 'The computer could not switch the Bot to that model, so it stays on its current one.'

function client(path) {
  const socket = createConnection(path)
  const waiting = new Map()
  let next = 1
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const response of waiting.values()) response.reject(new Error('Fixture socket closed'))
  })
  socket.on('data', chunk => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at + 1)
      buffer = buffer.slice(at + 1)
      const wire = JSON.parse(line)
      waiting.get(wire.id)?.resolve({ wire, line })
    }
  })
  async function exchange(method, params, id = next++) {
    const response = Promise.withResolvers()
    waiting.set(id, response)
    const timer = setTimeout(() => response.reject(new Error(`No fixture reply for ${method}`)), 5000)
    try {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
      return await response.promise
    } finally {
      clearTimeout(timer)
      waiting.delete(id)
    }
  }
  const ask = async (...args) => (await exchange(...args)).wire
  const send = (method, fields) => exchange(method, { grant: GRANT, terminal: TERMINAL, ...fields })
  const call = async (method, fields) => {
    const { wire } = await send(method, fields)
    assert.equal(wire.error, undefined, method)
    return wire.result
  }
  return { socket, ask, exchange, send, call,
    read: fields => call('settings-read', fields),
    name: (rev, name, fields) => call('settings-name', { rev, name, ...fields }),
    model: (rev, model, fields) => call('settings-model', { rev, model, ...fields }),
    closeGrant: () => ask('manage-close', { grant: GRANT }),
  }
}

function presets() {
  const current = new Map()
  const specs = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    [PRESET]: { sandbox: 'read-only', approval: 'ask' },
  }
  return {
    names: () => Object.keys(specs),
    catalog: () => ({ options: Object.keys(specs).map(value => ({ value, name: value })), defaultPreset: 'workspace-write' }),
    resolve: name => specs[name],
    current: session => current.get(session.id),
    set: (session, name) => { current.set(session.id, name) },
  }
}

async function setup(t, { bot = {}, warm = true, writable = true, config = {}, schedules = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-settings-'))
  const path = socketPathOf(home)
  const statePath = join(home, 'state.json')
  const registry = join(home, 'bots.json')
  const state = {
    version: 2, mainBotIds: [GLOBAL], whaleStored: true, revision: 1, autoStamp: 1,
    subscriptionCliMoved: { 'openai-codex': true, anthropic: true },
    bots: Object.fromEntries([A, B, GLOBAL].map((id, index) => [id, {
      id, name: `PrivateFixtureName${index}`, sessionId: `s-${index}`, createdAt: index + 1, model: NATIVE, appliedModel: NATIVE,
      ...(id === A ? { ...(bot.private ? { workDir: join(home, 'private-fixture') } : {}), ...bot } : {}),
    }])),
  }
  writeFileSync(statePath, JSON.stringify(state))
  const row = { id: A, name: state.bots[A].name, folder: PROJECT }
  const pick = { project: PROJECT, bots: [A] }
  const show = (bots = [row], shown = [pick]) => writeFileSync(registry, JSON.stringify({ version: 2, projects: [], bots, shown }))
  show()

  const calls = []
  const warnings = []
  const agents = new Map()
  const providers = {
    deepseek: [{ id: 'v4', name: 'V4' }, { id: 'v5', name: 'V5' }],
    'acp-codex': [{ id: 'gpt-a' }, { id: 'gpt-b' }],
    'acp-claude': [{ id: 'sonnet' }, { id: 'claude-fable-5-1[1m]' }],
    'openai-codex': [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna' }],
  }
  const acp = { inspect: async () => ({ on: true, signedIn: true }) }
  const controller = {
    async* follow({ address }, signal) {
      yield { type: 'snapshot', header: { version: 1, id: address.sessionId, createdAt: 0 }, records: [], cursor: -1, hasMore: false, projections: { asOfSeq: -1, values: {} } }
      if (!signal.aborted) await once(signal, 'abort')
    },
    async events() { return { records: [], hasMore: false, cursor: -1 } },
    async state() { return { cursor: -1, active: true, running: false, queue: [], pendingInput: [] } },
    async* observeState() {},
    async create() { calls.push(['create']); return { sessionId: 'fixture-new-session' } },
    async resolveAgent(id) {
      if (!agents.has(id)) agents.set(id, { ...ctx.scopeAgent(id), session: { id, deriveMessages: () => [] }, followup() {} })
      return { agent: agents.get(id) }
    },
    async selectModel({ sessionId, provider, model }) {
      calls.push(['select', sessionId, `${provider}/${model}`])
      await behavior.select?.({ sessionId, provider, model })
    },
    ...(writable ? {
      prompt: async () => { calls.push(['prompt']); return { accepted: true } },
      cancel: () => ({ accepted: true }),
    } : {}),
  }
  const behavior = {}
  const ctx = fakeContext({ services: { sessionController: controller, acpAgents: acp, agents, permissionPresets: presets(),
    ...(schedules ? { schedule: { catalog: async () => [], runtime: { requestDrive() {} }, edit: async (_request, _actor, signal) => signal.throwIfAborted() } } : {}),
  } })
  ctx.sessionController = controller
  ctx.sessions = { flush: async () => {} }
  Object.assign(ctx.llm, {
    listProviders: () => Object.keys(providers).map(id => ({ id, ...(id === 'deepseek' ? { name: 'DeepSeek' } : {}) })),
    listModels: async id => { calls.push(['list', id]); return providers[id] ?? [] },
    resolveModelInfo: async () => ({}),
  })
  ctx.sessionTitle = { rename: async (session, name) => { calls.push(['rename', session.id, name]); await behavior.rename?.() } }
  ctx.workspaceRegistry = { archiveSession: async id => { calls.push(['archive', id]) } }
  ctx.logger.warn = (...args) => warnings.push(format(...args))

  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, memoryReview: false, browser: false, updateCheck: false, ...config })
  rt.registryPath = registry
  const clients = []
  const cleanup = []
  t.after(async () => {
    for (const release of cleanup) release()
    for (const c of clients) c.socket.destroy()
    await ctx.dispose()
    rt.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  const prime = async () => {
    await rt.catalog({ fresh: true, remember: false })
    calls.length = 0
  }
  if (warm) await prime()
  for (let tries = 0; !existsSync(path); tries += 1) {
    const failure = warnings.find(line => line.includes('Pocket chat is off'))
    if (failure || tries === 200) throw new Error(failure ?? 'Fixture socket did not start')
    await delay(10)
  }
  const connect = async ({ hello = true, phone = PHONE } = {}) => {
    const c = client(path)
    clients.push(c)
    await once(c.socket, 'connect')
    if (hello) {
      const { result } = await c.ask('hello', HELLO)
      assert.equal(result.manage, 1)
      c.offered = result.manageMethods
      assert.deepEqual((await c.ask('manage-open', { grant: GRANT, phone })).result, { grant: GRANT })
    }
    return c
  }
  const desktop = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const pause = () => {
    const entered = Promise.withResolvers()
    const held = Promise.withResolvers()
    const timer = setTimeout(() => entered.reject(new Error('Fixture did not reach the gated boundary')), 3000)
    cleanup.push(() => { clearTimeout(timer); held.resolve() })
    return {
      entered: entered.promise, release: held.resolve,
      async wait() { clearTimeout(timer); entered.resolve(); await held.promise },
    }
  }
  const bytes = () => readFileSync(statePath, 'utf8')
  return { rt, ctx, home, statePath, bytes, disk: () => JSON.parse(bytes()), row, pick, show, registry, connect,
    warnings, calls, behavior, acp, agents, providers, prime, desktop, pause }
}

const revision = async c => {
  const result = await c.read()
  assert.equal(result.state, 'read')
  assert.ok(METHODS.every(method => c.offered.includes(method)))
  return result.settings.rev
}
const operations = h => h.calls.filter(([kind]) => kind !== 'list')
const withReason = (result, reason) => {
  assert.deepEqual({ ok: result.ok, state: result.state, reason: result.reason }, REFUSED(reason))
  assert.ok(result.settings)
  assert.ok(result.models)
  return result
}
const otherBlocked = h => {
  h.rt.botOf(B).kickoff = { text: 'Fixture held greeting' }
  h.rt.botOf(B).blocked = { ...BLOCK }
}
function nextWarningFree(h, ...markers) {
  const warning = h.warnings.filter(line => line.includes('pocket settings:'))
  assert.ok(warning.includes('pocket settings: unavailable'))
  for (const marker of markers) assert.ok(!warning.join('\n').includes(marker))
}

test('T1 hello adds Settings after schedules and preserves legacy bytes', async t => {
  const h = await setup(t, { schedules: true })
  const c = await h.connect({ hello: false })
  for (const [params, result] of [[{}, OLD_READ], [{ manage: 1 }, OLD_READ], [{ write: 1 }, OLD_WRITE]]) {
    assert.equal((await c.exchange('hello', params, 42)).line, `${JSON.stringify({ id: 42, result })}\n`)
    for (const method of METHODS) assert.deepEqual((await c.ask(method, {})).error, READ_ONLY)
  }
  const { result } = await c.ask('hello', HELLO)
  assert.deepEqual(result.manageMethods, [
    'manage-open', 'manage-close', 'memory-read', 'memory-edit', 'memory-add',
    'schedule-list', 'schedule-pause', 'schedule-resume', 'schedule-rename', ...METHODS,
  ])
  const readOnly = await (await setup(t, { writable: false })).connect({ hello: false })
  assert.deepEqual((await readOnly.ask('hello', HELLO)).result, OLD_READ)
  for (const method of METHODS) assert.deepEqual((await readOnly.ask(method, {})).error, READ_ONLY)
  const settingsOnly = await (await setup(t, { config: { memory: false } })).connect({ hello: false })
  assert.deepEqual((await settingsOnly.ask('hello', HELLO)).result.manageMethods, ['manage-open', 'manage-close', ...METHODS])
})

test('T2 addendum #2 returns an allowlisted passive read and a cold picker stays empty', async t => {
  const h = await setup(t, { bot: {
    permission: PRESET, instructions: 'InstructionsFixtureMarker', role: 'RoleFixtureMarker', private: true,
    workDir: '/fixture/SecretWorkDirMarker', denyTools: ['SecretDenyToolMarker'], browserGrants: ['SecretBrowserMarker'],
  } })
  otherBlocked(h)
  await h.rt.save()
  h.rt.dropCatalog()
  const before = h.bytes()
  const unblock = t.mock.method(h.rt, 'unblockBots')
  const c = await h.connect()
  const { wire, line } = await c.send('settings-read')
  const { result } = wire
  assert.equal(result?.state, 'read')
  assert.deepEqual(Object.keys(result), ['ok', 'state', 'settings', 'models'])
  assert.deepEqual(Object.keys(result.settings), ['terminal', 'rev', 'name', 'model', 'level', 'editable'])
  assert.deepEqual(Object.keys(result.settings.model), ['saved', 'label', 'applied', 'running', 'effort', 'runningEffort'])
  assert.deepEqual(result.settings.level, { saved: 'custom', inherited: false, auto: false })
  assert.deepEqual(result.settings.editable, { name: true, model: true })
  assert.deepEqual(result.models, { entries: [], truncated: false })
  for (const field of ['instructions', 'role', 'workDir', 'denyTools', 'shell', 'private', 'browserGrants',
    'InstructionsFixtureMarker', 'RoleFixtureMarker', 'SecretWorkDirMarker', PRESET, h.rt.botOf(B).name]) {
    assert.ok(!line.includes(field), field)
  }
  assert.deepEqual(await c.model(result.settings.rev, NEXT), REFUSED('unavailable'))
  assert.equal(h.bytes(), before)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.rt.botOf(B).blocked, BLOCK)
  assert.ok(h.rt.botOf(B).kickoff)
  assert.equal(unblock.mock.callCount(), 0)
  await h.rt.catalog({ fresh: true })
  assert.equal(unblock.mock.callCount(), 1)
  const warm = await c.read()
  assert.deepEqual(warm.models, { entries: [
    { id: NATIVE, label: 'V4', provider: 'DeepSeek' },
    { id: NEXT, label: 'V5', provider: 'DeepSeek' },
    { id: 'openai-codex/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'ChatGPT' },
    { id: 'openai-codex/gpt-5.6-luna', label: 'gpt-5.6-luna', provider: 'ChatGPT' },
  ], truncated: false })
})

test('T3 a name saves, updates the existing title and returns live settings', async t => {
  const h = await setup(t)
  const update = t.mock.method(h.rt, 'updateBot')
  const note = t.mock.method(h.rt, 'noteFailure')
  const c = await h.connect()
  const rev = await revision(c)
  const name = 'PrivateFixtureName3'
  const result = await c.name(rev, ` ${name} `, { ignored: 'marker' })
  assert.equal(result.state, 'saved')
  assert.equal(result.settings.name, name)
  assert.equal(h.disk().bots[A].name, name)
  assert.deepEqual(operations(h), [['rename', 's-0', name]])
  assert.notEqual(result.settings.rev, rev)
  assert.deepEqual(result.settings, (await c.read()).settings)
  assert.equal(update.mock.callCount(), 1)
  const [id, patch, actor, from, options] = update.mock.calls[0].arguments
  assert.deepEqual([id, patch, actor, from], [A, { id: A, name: ` ${name} ` }, undefined, undefined])
  assert.deepEqual(Object.keys(options), ['admit'])
  assert.equal(typeof options.admit, 'function')
  assert.deepEqual(note.mock.calls.map(call => call.arguments[0]).filter(entry => entry.where === 'pocket-settings'), [
    { level: 'info', source: 'host', bot: A, where: 'pocket-settings', text: "Pocket changed the Bot's name" },
  ])
})

test('T4 equal and invalid names are inert and a desktop rename makes the revision stale', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const before = h.bytes()
  const update = t.mock.method(h.rt, 'updateBot')
  assert.equal((await c.name(rev, ` ${h.rt.botOf(A).name} `)).state, 'unchanged')
  for (const name of ['@x', h.rt.botOf(B).name, '   ']) {
    const result = withReason(await c.name(rev, name), 'invalid')
    assert.equal(result.message, h.rt.botNameRefusal(A, name))
  }
  assert.equal(update.mock.callCount(), 0)
  assert.equal(h.bytes(), before)
  assert.equal((await h.desktop('update-bot', { id: A, name: 'PrivateFixtureName4' })).ok, true)
  const result = withReason(await c.name(rev, 'PrivateFixtureName5'), 'stale')
  assert.equal(update.mock.callCount(), 1)
  assert.equal(result.settings.name, 'PrivateFixtureName4')
  assert.equal(h.disk().bots[A].name, 'PrivateFixtureName4')
})

test('T5 a same-harness model saves on the own chat and matches the next read', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const result = await c.model(await revision(c), NEXT)
  assert.equal(result.state, 'saved')
  assert.equal(result.settings.model.saved, NEXT)
  assert.equal(result.settings.model.applied, NEXT)
  assert.equal(h.disk().bots[A].model, NEXT)
  assert.deepEqual(operations(h), [['select', 's-0', NEXT]])
  assert.deepEqual(result.settings, (await c.read()).settings)
})

test('T6 an unchanged model calls no update and does not move Auto or its revision', async t => {
  const h = await setup(t, { bot: AUTO })
  const update = t.mock.method(h.rt, 'updateBot')
  const c = await h.connect()
  const rev = await revision(c)
  assert.equal((await c.model(rev, NATIVE)).state, 'unchanged')
  assert.equal(update.mock.callCount(), 0)
  assert.equal(h.rt.botOf(A).permissionAuto, AUTO.permissionAuto)
  assert.equal(h.rt.botOf(A).permissionRev, AUTO.permissionRev)
  assert.deepEqual(h.calls, [])
})

test('T7 permission, effort and other extra fields never reach Bot update', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const update = t.mock.method(h.rt, 'updateBot')
  let rev = await revision(c)
  const extras = { id: B, permission: 'danger-full-access', permissionAuto: 'fake', autoStamp: 9, level: 'auto', effort: 'high', role: 'Fixture' }
  const renamed = await c.name(rev, 'PrivateFixtureName6', extras)
  assert.equal(renamed.state, 'saved')
  rev = renamed.settings.rev
  assert.equal((await c.model(rev, NEXT, extras)).state, 'saved')
  assert.deepEqual(update.mock.calls.map(call => call.arguments[1]), [{ id: A, name: 'PrivateFixtureName6' }, { id: A, model: NEXT }])
  assert.equal(h.rt.botOf(A).effort, undefined)
  for (const method of ['settings-level', 'set-bot-auto', 'update-bot']) assert.deepEqual((await c.ask(method, {})).error, READ_ONLY)
})

test('T8 a saved native model change clears Auto and projects the resulting level', async t => {
  const h = await setup(t, { bot: AUTO })
  const c = await h.connect()
  assert.equal((await c.read()).settings?.level.auto, true)
  const result = await c.model(await revision(c), NEXT)
  assert.equal(result.state, 'saved')
  assert.equal(result.settings.level.auto, false)
  assert.equal(Object.hasOwn(h.disk().bots[A], 'permissionAuto'), false)
})

test('T9 addendum #6 a DSH selection rejection is not-applied with no host text', async t => {
  const h = await setup(t, { bot: AUTO })
  const c = await h.connect()
  const rev = await revision(c)
  h.behavior.select = () => { throw new Error('SecretSelectMarker') }
  const { line, wire } = await c.send('settings-model', { rev, model: NEXT })
  const result = withReason(wire.result, 'not-applied')
  assert.equal(result.message, NOT_APPLIED)
  assert.equal(result.settings.model.saved, NATIVE)
  assert.equal(result.settings.level.auto, false)
  assert.notEqual(result.settings.rev, rev)
  assert.equal(h.disk().bots[A].model, NATIVE)
  assert.equal(Object.hasOwn(h.disk().bots[A], 'permissionAuto'), false)
  assert.ok(!line.includes('SecretSelectMarker'))
  assert.ok(!h.warnings.filter(line => line.includes('pocket settings:')).join('\n').includes('SecretSelectMarker'))
})

test('T10 another model of the same coding agent keeps Auto', async t => {
  const h = await setup(t, { bot: { ...AUTO, model: CODEX, appliedModel: CODEX, permissionAuto: 'acp-codex' } })
  const c = await h.connect()
  const result = await c.model(await revision(c), CODEX_NEXT)
  assert.equal(result.state, 'saved')
  assert.equal(result.settings.level.auto, true)
  assert.equal(h.disk().bots[A].permissionAuto, 'acp-codex')
})

test('T11 addendum #8 validates bare names and accepts exact bracket refs', async t => {
  const h = await setup(t, { bot: { model: CLAUDE, appliedModel: CLAUDE } })
  const displayName = 'acp-claude/fixture-display-name'
  h.providers['acp-claude'][1].name = displayName
  await h.prime()
  const c = await h.connect()
  const rev = await revision(c)
  withReason(await c.model(rev, 'deepseek/none'), 'unknown-model')
  withReason(await c.model(rev, displayName), 'unknown-model')
  for (const model of ['V5', 'deepseek', '/x', 'x/', '', 'x/y\u0001', `deepseek/${'é'.repeat(253)}`]) {
    assert.deepEqual(await c.model(rev, model), REFUSED('invalid'))
  }
  assert.deepEqual(h.calls, [])
  assert.equal((await c.model(rev, FABLE)).state, 'saved')
  assert.deepEqual(operations(h), [['select', 's-0', FABLE]])
})

test('T12 filters route policy, harness changes, covered plans and signed-out agents', async t => {
  const h = await setup(t, { bot: AUTO })
  const c = await h.connect()
  const switching = t.mock.method(h.rt, 'switchRoute')
  const bot = h.rt.botOf(A)
  for (const [fields, target] of [
    [{ kind: 'dsh', model: CODEX, appliedModel: CODEX }, CODEX_NEXT],
    [{ kind: 'dsh', model: NATIVE, appliedModel: NATIVE }, CODEX],
    [{ kind: 'automagik', model: NATIVE, appliedModel: NATIVE }, CODEX],
    [{ model: 'openai-codex/gpt-5.6-luna', appliedModel: 'openai-codex/gpt-5.6-luna' }, 'openai-codex/gpt-5.6-sol'],
    [{ model: CODEX, appliedModel: CODEX, shell: false }, CODEX_NEXT],
    [{ model: CODEX, appliedModel: CODEX, shell: true }, CODEX_NEXT],
  ]) {
    Object.assign(bot, fields)
    if (target.startsWith('openai-codex/')) {
      h.rt.routeAuth = async () => new Map([['openai-codex', { via: 'signin' }]])
      await h.prime()
    }
    if (fields.shell === true) h.acp.inspect = async () => ({ on: true, signedIn: false })
    const rev = await revision(c)
    const result = withReason(await c.model(rev, target), 'model-not-allowed')
    if (fields.shell !== true) assert.ok(!result.models.entries.some(entry => entry.id === target))
    assert.equal(bot.permissionRev, AUTO.permissionRev)
    assert.equal(bot.permissionAuto, AUTO.permissionAuto)
  }
  assert.equal(switching.mock.callCount(), 0)
  assert.deepEqual(operations(h), [])
})

test('T13 held greetings, host-owned models, shell holds and picks stay on the computer', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const bot = h.rt.botOf(A)
  let rev = await revision(c)
  bot.kickoff = { text: 'Fixture held greeting' }
  assert.deepEqual(withReason(await c.name(rev, 'PrivateFixtureName9'), 'computer').settings.editable, { name: false, model: false, reason: 'greeting' })
  withReason(await c.model(rev, NEXT), 'computer')
  assert.deepEqual(operations(h), [])
  delete bot.kickoff
  const hostOwned = h.rt.hostOwned
  h.rt.hostOwned = current => current === bot || hostOwned(current)
  const pick = t.mock.method(h.rt, 'pickHostModel')
  assert.equal(withReason(await c.model(rev, NEXT), 'computer').settings.editable.reason, 'host-model')
  assert.equal(pick.mock.callCount(), 0)
  const renamed = await c.name(rev, 'PrivateFixtureName9')
  assert.equal(renamed.state, 'saved')
  rev = renamed.settings.rev
  h.rt.hostOwned = hostOwned
  bot.shellHeld = {}
  assert.equal(withReason(await c.model(rev, NEXT), 'computer').settings.editable.reason, 'shell')
  delete bot.shellHeld
  t.mock.method(h.rt, 'pickingModel', () => true)
  assert.equal(withReason(await c.model(rev, NEXT), 'changing').settings.editable.reason, 'changing')
})

test('T13 a greeting that appears during an admitted rename stays held', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const kickoff = { text: 'Fixture held greeting' }
  const wait = h.rt.waitForModel
  const waiting = t.mock.method(h.rt, 'waitForModel', bot => wait(bot, 0))
  h.behavior.rename = () => { h.rt.botOf(A).kickoff = kickoff }
  const result = await c.name(rev, 'PrivateFixtureName16')
  assert.equal(result.state, 'saved')
  assert.deepEqual(result.settings.editable, { name: false, model: false, reason: 'greeting' })
  assert.deepEqual(h.disk().bots[A].kickoff, kickoff)
  assert.equal(waiting.mock.callCount(), 0)
})

test('T14 requires the current shown project binding and isolates the selected private Bot', async t => {
  const h = await setup(t, { bot: { private: true } })
  const c = await h.connect()
  assert.deepEqual(await c.read({ terminal: `dsh:${GLOBAL}` }), REFUSED('global'))
  assert.deepEqual(await c.read({ terminal: 'dsh:b-dddddddddd' }), REFUSED('not-found'))
  const rev = await revision(c)
  const other = JSON.stringify(h.rt.botOf(B))
  h.show([h.row], [])
  assert.deepEqual(await c.name(rev, 'PrivateFixtureName10'), REFUSED('not-shown'))
  rmSync(h.registry)
  assert.deepEqual(await c.read(), REFUSED('not-shown'))
  h.show()
  assert.equal((await c.name(rev, 'PrivateFixtureName10')).state, 'saved')
  assert.equal(JSON.stringify(h.rt.botOf(B)), other)
})

test('T15 rechecks revocation inside the real name and model updates', async t => {
  for (const method of ['name', 'model']) {
    await t.test(method, async t => {
      const h = await setup(t, { bot: { model: CODEX, appliedModel: CODEX } })
      const c = await h.connect()
      const rev = await revision(c)
      const before = h.bytes()
      const gate = h.pause()
      if (method === 'name') {
        const check = h.rt.checkPrivacyChange
        h.rt.checkPrivacyChange = async (...args) => { await gate.wait(); return check(...args) }
      } else {
        const inspect = h.acp.inspect
        h.acp.inspect = async (...args) => { await gate.wait(); return inspect(...args) }
      }
      const pending = c[method](rev, method === 'name' ? 'PrivateFixtureName11' : CODEX_NEXT)
      await gate.entered
      await c.closeGrant()
      gate.release()
      assert.deepEqual(await pending, REFUSED('revoked'))
      assert.deepEqual(h.calls, [])
      assert.equal(h.bytes(), before)
      assert.equal(h.rt.botOf(A).model, CODEX)
      assert.equal(h.rt.botOf(A).name, h.row.name)
    })
  }
})

test('T16 the admission hook catches a desktop rename during the model access check', async t => {
  const h = await setup(t, { bot: { model: CODEX, appliedModel: CODEX } })
  const c = await h.connect()
  const rev = await revision(c)
  const gate = h.pause()
  const inspect = h.acp.inspect
  h.acp.inspect = async (...args) => { await gate.wait(); return inspect(...args) }
  const pending = c.model(rev, CODEX_NEXT)
  await gate.entered
  const name = 'PrivateFixtureName12'
  assert.equal((await h.desktop('update-bot', { id: A, name })).ok, true)
  gate.release()
  const result = withReason(await pending, 'stale')
  assert.equal(result.settings.name, name)
  assert.equal(result.settings.model.saved, CODEX)
  assert.deepEqual(operations(h), [['rename', 's-0', name]])
})

test('T17 waits for real setBotAuto and rechecks admission before clearAuto mutates', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const saving = h.pause()
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = async (...args) => { await saving.wait(); return saveCopy(...args) }
  const auto = h.rt.setBotAuto(A, h.rt.botOf(A).permissionRev ?? 0)
  await saving.entered
  const clearing = Promise.withResolvers()
  const clear = h.rt.clearAuto
  h.rt.clearAuto = (...args) => { clearing.resolve(); return clear(...args) }
  const pending = c.model(rev, NEXT)
  await clearing.promise
  saving.release()
  await auto
  const result = withReason(await pending, 'stale')
  assert.equal(result.settings.level.auto, true)
  assert.equal(h.disk().bots[A].permissionAuto, AUTO.permissionAuto)
  assert.equal(h.disk().bots[A].model, NATIVE)
  assert.ok(!h.calls.some(([kind]) => kind === 'select'))
})

test('T18 addendum #3 rejects the same revision on a replacement adopted during the admin queue wait', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const original = h.rt.botOf(A)
  const previous = structuredClone(original)
  // Load a fixture token after resume has finished. fetch() exercises the real admin
  // transaction directly, using no HTTP listener.
  assert.equal((await h.rt.agentAccess.owner('view')).url, null)
  const token = 'fixture-admin-token'
  writeFileSync(join(h.home, 'agent-tokens.json'), JSON.stringify([{
    id: 'fixture-admin-id', name: 'Fixture admin', hash: createHash('sha256').update(token).digest('hex'),
  }]))
  assert.equal((await h.rt.agentAccess.owner('view')).url, null)
  const gate = h.pause()
  const check = h.rt.checkPrivacyChange
  h.rt.checkPrivacyChange = async (bot, ...args) => {
    if (bot.id === B) await gate.wait()
    return check(bot, ...args)
  }
  const admin = h.rt.agentAccess.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'update_bot', arguments: { id: B, name: '@x' } } }),
  }))
  await gate.entered
  const queued = Promise.withResolvers()
  const update = h.rt.updateBot
  h.rt.updateBot = (...args) => { queued.resolve(); return update(...args) }
  const pending = c.model(rev, NEXT)
  await queued.promise
  const external = h.bytes() + '\n'
  writeFileSync(h.statePath, external)
  rmSync(join(h.home, 'state.lock'))
  await h.rt.refresh()
  assert.notEqual(h.rt.botOf(A), original)
  assert.deepEqual(h.rt.botOf(A), previous)
  gate.release()
  assert.equal((await (await admin).json()).result.isError, true)
  const result = withReason(await pending, 'stale')
  assert.equal(result.settings.rev, rev)
  assert.deepEqual(original, previous)
  assert.deepEqual(h.rt.botOf(A), previous)
  assert.equal(h.bytes(), external)
  assert.deepEqual(h.calls, [])
})

test('T19 a pinned write does not enumerate or lift another Bot after cache invalidation', async t => {
  const h = await setup(t, { bot: { model: CODEX, appliedModel: CODEX, effort: 'fixture-effort' } })
  otherBlocked(h)
  await h.rt.save()
  const unblock = t.mock.method(h.rt, 'unblockBots')
  const apply = h.rt.applyModel
  h.rt.applyModel = async (bot, options) => {
    h.rt.dropCatalog()
    // Exercise a real, incidental catalog lookup after admission as well as pinned apply.
    await h.rt.catalog()
    return apply(bot, options)
  }
  const c = await h.connect()
  assert.equal((await c.model(await revision(c), CODEX_NEXT)).state, 'saved')
  assert.deepEqual(h.calls, [['select', 's-0', CODEX_NEXT]])
  assert.equal(unblock.mock.callCount(), 0)
  assert.deepEqual(h.rt.botOf(B).blocked, BLOCK)
  assert.ok(h.rt.botOf(B).kickoff)
})

test('T20 a revoked admitted selection reports applied without betraying live settings', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const gate = h.pause()
  h.behavior.select = gate.wait
  const pending = c.model(rev, NEXT)
  await gate.entered
  await c.closeGrant()
  gate.release()
  assert.deepEqual(await pending, { ...REFUSED('revoked'), applied: true })
  assert.equal(h.disk().bots[A].model, NEXT)
})

test('T21 addendum #6 a title or team save failure is unknown and shows the live state', async t => {
  await t.test('title failure', async t => {
    const h = await setup(t)
    const c = await h.connect()
    const rev = await revision(c)
    const name = 'PrivateFixtureName13'
    h.behavior.rename = () => { throw new Error('SecretTitleMarker') }
    const { line, wire: { result } } = await c.send('settings-name', { rev, name })
    assert.equal(result.state, 'unknown')
    assert.equal(result.reason, 'pending')
    assert.equal(result.settings.name, name)
    assert.equal(h.disk().bots[A].name, h.row.name)
    assert.ok(!line.includes('SecretTitleMarker'))
    nextWarningFree(h, 'SecretTitleMarker', name, NEXT)
  })
  await t.test('save failure after selection', async t => {
    const h = await setup(t)
    const c = await h.connect()
    const rev = await revision(c)
    const write = fsPromises.writeFile
    const mock = t.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
      if (path === `${h.statePath}.${process.pid}.tmp`) throw new Error('SecretSaveMarker')
      return write(path, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
    const { line, wire: { result } } = await c.send('settings-model', { rev, model: NEXT })
    assert.equal(result.state, 'unknown')
    assert.equal(result.reason, 'pending')
    assert.equal(result.settings.model.saved, NEXT)
    assert.equal(result.settings.model.applied, NEXT)
    assert.equal(h.disk().bots[A].model, NATIVE)
    assert.deepEqual(h.calls, [['select', 's-0', NEXT]])
    assert.ok(!line.includes('SecretSaveMarker'))
    nextWarningFree(h, 'SecretSaveMarker', h.row.name, NEXT)
  })
  await t.test('unknown survives a revoked grant', async t => {
    const h = await setup(t)
    const c = await h.connect()
    const rev = await revision(c)
    const gate = h.pause()
    h.behavior.rename = async () => { await gate.wait(); throw new Error('SecretTitleMarker') }
    const pending = c.name(rev, 'PrivateFixtureName13')
    await gate.entered
    await c.closeGrant()
    gate.release()
    assert.deepEqual(await pending, PENDING)
  })
})

test('T22 the own agent supplies running and read-only levels never expose their preset name', async t => {
  const h = await setup(t)
  const c = await h.connect()
  h.agents.set('s-0', { model: { current: () => ({ provider: 'deepseek', model: 'v5', reasoningEffort: 'high' }) } })
  const result = await c.read()
  assert.deepEqual(result.settings?.model, { saved: NATIVE, label: 'V4', applied: NATIVE, running: NEXT, effort: null, runningEffort: 'high' })
  assert.deepEqual(result.settings.level, { saved: 'workspace-write', inherited: true, auto: false })
  const bot = h.rt.botOf(A)
  bot.permission = PRESET
  assert.equal((await c.read()).settings.level.saved, 'custom')
  bot.permission = 'auto'
  assert.deepEqual((await c.read()).settings.level, { saved: 'auto', inherited: false, auto: false, fallback: 'workspace-write' })
})

test('T23 settings share the busy key and read and write budgets across connections', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const other = await h.connect()
  const gate = h.pause()
  const refresh = h.rt.refreshShellChoice
  let hold = true
  h.rt.refreshShellChoice = async () => { if (hold) await gate.wait(); return refresh() }
  const memory = c.call('memory-read')
  await gate.entered
  const result = await other.read()
  hold = false
  gate.release()
  assert.equal((await memory).ok, true)
  assert.deepEqual(result, REFUSED('busy'))
  const rev = await revision(c)
  for (let i = 0; i < 29; i += 1) {
    assert.equal((await other.read()).state, 'read')
    assert.equal((await c.call('memory-read')).ok, true)
  }
  assert.deepEqual(await other.read(), REFUSED('rate'))
  assert.deepEqual(await c.call('memory-read'), REFUSED('rate'))

  assert.deepEqual((await c.ask('subscribe', { terminal: TERMINAL, channel: 1 })).result, { channel: 1 })
  assert.equal((await c.ask('send', { channel: 1, phone: PHONE, id: 'phone-chat-1', text: 'Fixture text' })).result.ok, true)
  for (let i = 0; i < 19; i += 1) assert.equal((await other.name(rev, h.row.name)).state, 'unchanged')
  assert.deepEqual(await other.name(rev, h.row.name), REFUSED('rate'))
  assert.equal(h.calls.filter(([kind]) => kind === 'prompt').length, 1)
})

test('T24 reply cap counts escaped UTF-8, the envelope and whole entries, up to 200', async () => {
  const { fitReply } = await import('../src/host/pocket-settings.js')
  const base = { ok: true, state: 'read', settings: {} }
  const entries = [
    { id: NATIVE, label: '"\u0001é', provider: 'Fixture' },
    { id: NEXT, label: 'Fixture', provider: 'Fixture' },
  ]
  const overhead = Buffer.byteLength(JSON.stringify({ id: '"\u0001é', result: null })) - 4 + 1
  const one = { ...base, models: { entries: entries.slice(0, 1), truncated: true } }
  const limit = overhead + Buffer.byteLength(JSON.stringify(one))
  assert.deepEqual(fitReply(base, entries, overhead, limit), one)
  assert.deepEqual(fitReply(base, entries, overhead, limit - 1).models, { entries: [], truncated: true })
  assert.deepEqual(fitReply(base, entries, overhead, 1), REFUSED('too-large'))
  const many = Array.from({ length: 201 }, (_, i) => ({ ...entries[0], id: `fixture/${i}` }))
  assert.deepEqual(fitReply(base, many, overhead).models, { entries: many.slice(0, 200), truncated: true })
})

test('addendum #1 refuses recovery with no lock claim, backup, or shell refresh', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const refresh = t.mock.method(h.rt, 'refreshShellChoice')
  const original = h.rt.botOf(A)
  const external = JSON.stringify({ ...h.disk(), fixture: 'another writer changed the team' })
  writeFileSync(h.statePath, external)
  assert.deepEqual(await c.read(), REFUSED('unavailable'))
  assert.deepEqual(await c.name(rev, 'PrivateFixtureName14'), REFUSED('unavailable'))
  rmSync(join(h.home, 'state.lock'))
  assert.deepEqual(await c.read(), REFUSED('unavailable'))
  assert.equal(refresh.mock.callCount(), 0)
  assert.equal(existsSync(join(h.home, 'state.lock')), false)
  assert.ok(!readdirSync(h.home).some(file => file.startsWith('state.json.replaced-')))
  assert.equal(h.rt.botOf(A), original)
  assert.equal(h.bytes(), external)
})

test('addendum #4 rechecks invalidated or newly ineligible entries during admission', async t => {
  for (const invalidate of ['cache', 'mark']) {
    await t.test(invalidate, async t => {
      const h = await setup(t, { bot: { model: CODEX, appliedModel: CODEX } })
      const c = await h.connect()
      const rev = await revision(c)
      const before = h.bytes()
      const gate = h.pause()
      const inspect = h.acp.inspect
      h.acp.inspect = async (...args) => { await gate.wait(); return inspect(...args) }
      const pending = c.model(rev, CODEX_NEXT)
      await gate.entered
      if (invalidate === 'cache') h.rt.dropCatalog()
      else h.rt.cachedCatalog().find(entry => entry.ref === CODEX_NEXT).needsKey = true
      gate.release()
      withReason(await pending, 'model-not-allowed')
      assert.deepEqual(h.calls, [])
      assert.equal(h.bytes(), before)
    })
  }
})

test('addendum #4 applies the pinned ref and never substitutes a model that still exists', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const apply = h.rt.applyModel
  h.rt.applyModel = (bot, options) => {
    h.rt.dropCatalog()
    h.providers.deepseek.pop()
    return apply(bot, options)
  }
  // The pinned DSH API enumerates internally at selection, and rejects a vanished ref.
  h.behavior.select = async ({ provider, model }) => {
    if (!(await h.ctx.llm.listModels(provider)).some(entry => entry.id === model)) throw new Error('Fixture ref disappeared')
  }
  const before = h.bytes()
  assert.equal(withReason(await c.model(rev, NEXT), 'not-applied').settings.rev, rev)
  assert.deepEqual(h.calls, [['select', 's-0', NEXT], ['list', 'deepseek']])
  assert.equal(h.rt.botOf(A).model, NATIVE)
  assert.equal(h.bytes(), before)
})

test('addendum #5 holds the slot through Auto clearing, selection and rollback before a desktop model edit', async t => {
  const h = await setup(t, { bot: AUTO })
  h.providers.deepseek.push({ id: 'v6' })
  await h.prime()
  const c = await h.connect()
  const rev = await revision(c)
  const clearing = h.pause()
  const selecting = h.pause()
  const clear = h.rt.clearAuto
  h.rt.clearAuto = async (bot, admit, ...args) => {
    if (admit !== undefined) await clearing.wait()
    return clear(bot, admit, ...args)
  }
  h.behavior.select = async ({ model }) => {
    if (model === 'v5') { await selecting.wait(); throw new Error('Fixture rejects the phone choice') }
  }
  const phone = c.model(rev, NEXT)
  await clearing.entered
  const desktop = h.desktop('update-bot', { id: A, model: 'deepseek/v6' })
  await delay(20)
  assert.equal(h.rt.botOf(A).model, NATIVE)
  assert.deepEqual(h.calls, [])
  clearing.release()
  await selecting.entered
  assert.equal(h.rt.botOf(A).model, NEXT)
  assert.deepEqual(h.calls, [['select', 's-0', NEXT]])
  selecting.release()
  withReason(await phone, 'not-applied')
  assert.equal((await desktop).ok, true)
  assert.deepEqual(operations(h), [['select', 's-0', NEXT], ['select', 's-0', 'deepseek/v6']])
  assert.equal(h.disk().bots[A].model, 'deepseek/v6')
})

test('addendum #5 admits again after the slot and refuses against the desktop revision', async t => {
  const h = await setup(t)
  h.providers.deepseek.push({ id: 'v6' })
  await h.prime()
  const c = await h.connect()
  const rev = await revision(c)
  const gate = h.pause()
  const check = h.rt.checkPrivacyChange
  let first = true
  h.rt.checkPrivacyChange = async (...args) => {
    if (first) { first = false; await gate.wait() }
    return check(...args)
  }
  const desktop = h.desktop('update-bot', { id: A, model: 'deepseek/v6' })
  await gate.entered
  const queued = Promise.withResolvers()
  const update = h.rt.updateBot
  h.rt.updateBot = (...args) => { queued.resolve(); return update(...args) }
  const phone = c.model(rev, NEXT)
  await queued.promise
  gate.release()
  assert.equal((await desktop).ok, true)
  assert.equal(withReason(await phone, 'stale').settings.model.saved, 'deepseek/v6')
  assert.deepEqual(operations(h), [['select', 's-0', 'deepseek/v6']])
})

test('addendum #5 rollback preserves a changed live record and settles as unknown', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  const gate = h.pause()
  h.behavior.select = async () => { await gate.wait(); throw new Error('Fixture selection rejected') }
  const pending = c.model(rev, NEXT)
  await gate.entered
  // Simulate a record change outside the picker, such as the turn-driven model recovery.
  const bot = h.rt.botOf(A)
  bot.model = 'deepseek/v6'
  bot.appliedModel = 'deepseek/v6'
  gate.release()
  const result = await pending
  assert.equal(result.state, 'unknown')
  assert.equal(result.reason, 'pending')
  assert.equal(result.settings.model.saved, 'deepseek/v6')
  assert.equal(bot.appliedModel, 'deepseek/v6')
})

test('addendum #7 a desktop model round trip remains stale when permissionRev moved', async t => {
  const h = await setup(t)
  const c = await h.connect()
  const rev = await revision(c)
  for (const model of [NEXT, NATIVE]) assert.equal((await h.desktop('update-bot', { id: A, model })).ok, true)
  const result = withReason(await c.name(rev, 'PrivateFixtureName15'), 'stale')
  assert.equal(result.settings.model.saved, NATIVE)
  assert.notEqual(result.settings.rev, rev)
  assert.equal(h.disk().bots[A].name, h.row.name)
})
