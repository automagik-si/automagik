// #2026, the owner's option A: a Bot that denies acp_tool is kept off a model that runs its own
// tools (a Codex model acp-dsh knows keeps them, Antigravity), and acp_tool is not added to the
// Denied tools of a Bot that runs on one. Only a save that MAKES that pair is refused; a Bot
// already in it keeps running, may edit everything else, and its view carries `ownTools`.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { modelChoiceOf } from '../src/host/pocket-settings.js'
import {
  OWN_TOOLS_CREATE_TEXT, OWN_TOOLS_DENY_TEXT, OWN_TOOLS_MODEL_TEXT,
} from '../src/shared/own-tools.js'
import { fakeContext } from './fake-ctx.js'

const CODEX = 'acp-codex'
const KEPT = `${CODEX}/gpt-5.5`
const SOL = `${CODEX}/gpt-6.1-sol`
const LUNA = `${CODEX}/gpt-5.6-luna`
const DEFAULT = `${CODEX}/default`
const AGY = 'acp-antigravity/default'
const HERMES = 'acp-hermes/default'
const CLAUDE = 'acp-claude/default'
const busyText = name => `${name} is already changing models.`

const record = (id, model, extra = {}) => ({
  id, sessionId: `chat-${id}`, name: `Bot ${id}`, model, createdAt: 1, capabilities: [], ...extra,
})
const team = (bots, mainBotIds = ['main']) => ({
  version: 2, revision: 0, mainBotIds,
  whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true,
  nativeToolsOmpKept: true, nativeToolsCodexKept: true, nativeToolsLocksRetired: true,
  bots: { main: record('main', CLAUDE), ...bots },
})

function workspace(t, state) {
  const home = mkdtempSync(join(tmpdir(), 'own-tools-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const hosts = []
  t.after(async () => {
    for (const current of hosts) await current.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { home, async open(options) {
    const current = host(home, options)
    hosts.push(current)
    await current.rt.load()
    return current
  } }
}

// A whole runtime on a stored team. `kept` is the set acp-dsh answers `nativeModelKept` for;
// tests change it in place. The deny-list check against the Session's tool surface is not
// what these rows test, so it passes (a test may replace it).
function host(home, { kept = new Set([KEPT]), acp = {}, services: extra = {} } = {}) {
  const warnings = []
  const selects = []
  const services = {
    acpAgents: {
      botIdentity: () => () => {},
      endClaudeSession() {},
      inspect: async () => ({ signedIn: true }),
      nativeModelKept: ref => kept.has(ref),
      ...acp,
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    ...extra,
    sessionPersistence: {
      open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [
    { id: CODEX, name: 'Codex' }, { id: 'acp-antigravity', name: 'Antigravity' },
    { id: 'acp-hermes', name: 'Hermes' }, { id: 'acp-claude', name: 'Claude' },
  ]
  ctx.llm.listModels = async id => id === CODEX
    ? [{ id: 'default' }, { id: 'gpt-5.5' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-luna' }]
    : [{ id: 'default' }]
  ctx.llm.resolveModelInfo = async () => ({})
  ctx.workspaceRegistry = {
    get: () => undefined, resolveByPath: async () => undefined,
    create: async path => ({ id: 'team', path }), archiveSession: async () => {},
  }
  let made = 0
  ctx.sessionController = {
    create: async () => ({ sessionId: `new-${++made}` }),
    resolveAgent: async id => ({ agent: { id, session: { id, deriveMessages: () => [] }, followup: () => {} } }),
    selectModel: async (selection) => { selects.push(selection) },
  }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { get: () => undefined, flush: async () => true }
  let route
  ctx.connection.fetch.register = (options) => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  rt.assertDenyTools = async () => {}
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const state = async () => (await call('state', { requestId: randomUUID() })).value
  return {
    ctx, rt, warnings, selects, call, kept,
    dispose: () => ctx.dispose(),
    stored: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')),
    state,
    view: async id => (await state()).bots.find(bot => bot.id === id),
  }
}

// The fields this rule reads and writes, as a comparable list.
const pair = bot => [bot?.model, bot?.denyTools === undefined ? undefined : [...bot.denyTools]]

const deniesAcp = list => Array.isArray(list) && list.includes('acp_tool')
const refusedWith = (result, text) => {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.message, text)
}
const saved = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result))
}

test('a Bot that denies acp_tool cannot move to a kept Codex model or to Antigravity', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  for (const model of [KEPT, AGY]) {
    refusedWith(await h.call('update-bot', { id: 'a', model }), OWN_TOOLS_MODEL_TEXT)
    assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
    assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
  }
  // The direct route switch refuses the same move, before anything is written.
  await assert.rejects(() => h.rt.switchRoute('a', AGY), error => error.message === OWN_TOOLS_MODEL_TEXT)
  refusedWith(await h.call('switch-route', { id: 'a', model: AGY }), OWN_TOOLS_MODEL_TEXT)
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
  assert.deepEqual(h.selects, [])

  // Controls: a Codex model that is not kept, and Hermes (left out by the owner), are saved.
  saved(await h.call('update-bot', { id: 'a', model: LUNA }))
  assert.deepEqual(pair(h.rt.botOf('a')), [LUNA, ['acp_tool']])
})

test('acp_tool cannot be added while the Bot runs on a model that runs its own tools', async (t) => {
  const { open } = workspace(t, team({
    k: record('k', KEPT),
    g: record('g', AGY),
    s: record('s', SOL),
  }))
  const h = await open()
  for (const id of ['k', 'g']) {
    const before = pair(h.rt.botOf(id))
    refusedWith(await h.call('update-bot', { id, denyTools: ['acp_tool'] }), OWN_TOOLS_DENY_TEXT)
    refusedWith(await h.call('update-bot', { id, denyTools: ['bash', 'acp_tool'] }), OWN_TOOLS_DENY_TEXT)
    assert.deepEqual(pair(h.rt.botOf(id)), before)
    assert.deepEqual(pair(h.stored().bots[id]), before)
    // Any other list saves.
    saved(await h.call('update-bot', { id, denyTools: ['bash'] }))
    assert.deepEqual(pair(h.stored().bots[id])[1], ['bash'])
  }
  // Control: a Codex model that is not kept takes acp_tool.
  saved(await h.call('update-bot', { id: 's', denyTools: ['acp_tool'] }))
  assert.deepEqual(pair(h.stored().bots.s), [SOL, ['acp_tool']])
})

test('Hermes is left out: a Hermes Bot may deny acp_tool, and Hermes is not marked', async (t) => {
  const { open } = workspace(t, team({
    h: record('h', HERMES),
  }))
  const h = await open()
  saved(await h.call('update-bot', { id: 'h', denyTools: ['acp_tool'] }))
  assert.deepEqual(pair(h.stored().bots.h), [HERMES, ['acp_tool']])
  assert.equal(h.rt.ownToolsRoute(HERMES), false)
  assert.equal((await h.view('h')).ownTools, undefined)
})

test('no acpAgents answer, or one that throws, is not a model that runs its own tools', async (t) => {
  for (const acp of [{ nativeModelKept: undefined }, { nativeModelKept() { throw new Error('unavailable') } }]) {
    const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
    const h = await open({ acp })
    assert.equal(h.rt.ownToolsRoute(KEPT), false)
    assert.equal(h.rt.ownToolsRoute(AGY), true, 'Antigravity is known by its agent alone')
    saved(await h.call('update-bot', { id: 'a', model: KEPT }))
    assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['acp_tool']])
  }
})

// ---- A Bot already in the combination (A-2) ----

test('a stored Bot in the combination loads, runs, shows ownTools and may still edit the rest', async (t) => {
  const { open } = workspace(t, team({
    a: record('a', KEPT, { denyTools: ['acp_tool', 'bash'] }),
    p: record('p', undefined, { appliedModel: KEPT, denyTools: ['acp_tool'] }),
    s: record('s', SOL, { denyTools: ['acp_tool'] }),
  }))
  const h = await open()
  // Nothing is held or migrated at load: the record is as stored.
  assert.equal(h.rt.botOf('a').shellHeld, undefined)
  assert.deepEqual(pair(h.rt.botOf('a')), [KEPT, ['acp_tool', 'bash']])
  const view = await h.view('a')
  assert.equal(view.ownTools, true)
  assert.equal((await h.view('s')).ownTools, undefined, 'a Bot outside the rule has no ownTools key')
  assert.equal(Object.hasOwn(await h.view('main'), 'ownTools'), false)
  const models = (await h.state()).models
  assert.equal(models.find(entry => entry.ref === KEPT)?.ownTools, true)
  assert.equal(models.find(entry => entry.ref === AGY)?.ownTools, true)
  assert.equal(Object.hasOwn(models.find(entry => entry.ref === SOL), 'ownTools'), false)
  assert.equal(Object.hasOwn(models.find(entry => entry.ref === HERMES), 'ownTools'), false)

  // Remove bash keeping acp_tool; add write keeping acp_tool: both saved.
  saved(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }))
  saved(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool', 'write'] }))
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['acp_tool', 'write']])
  // A rename saves.
  saved(await h.call('update-bot', { id: 'a', name: 'Renamed' }))
  assert.equal(h.stored().bots.a.name, 'Renamed')
  // A re-pick of its current model saves, also from the picker when only appliedModel is set.
  saved(await h.call('update-bot', { id: 'a', model: KEPT }))
  saved(await h.call('update-bot', { id: 'p', model: KEPT }))
  assert.deepEqual(pair(h.stored().bots.p), [KEPT, ['acp_tool']])
  // A move to a different model that runs its own tools is refused.
  refusedWith(await h.call('update-bot', { id: 'a', model: AGY }), OWN_TOOLS_MODEL_TEXT)
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['acp_tool', 'write']])
  // A move to a model that is not one saves; so does clearing the list.
  saved(await h.call('update-bot', { id: 'a', model: SOL }))
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool', 'write']])
  assert.equal((await h.view('a')).ownTools, undefined)
  saved(await h.call('update-bot', { id: 'p', denyTools: null }))
  assert.deepEqual(pair(h.stored().bots.p), [KEPT, undefined])
})

// ---- Fail-open (A-4) and the view key ----

test('an unknown Codex model passes, and the view follows once acp-dsh knows it is kept', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  saved(await h.call('update-bot', { id: 'a', model: DEFAULT }))
  assert.deepEqual(pair(h.stored().bots.a), [DEFAULT, ['acp_tool']])
  const before = await h.state()
  assert.equal(before.bots.find(bot => bot.id === 'a').ownTools, undefined)
  // Codex measures its start model as kept later: no revision, but the view key moves.
  h.kept.add(DEFAULT)
  const after = await h.state()
  assert.equal(after.bots.find(bot => bot.id === 'a').ownTools, true)
  assert.equal(after.models.find(entry => entry.ref === DEFAULT).ownTools, true)
  assert.notEqual(after.modelsKey, before.modelsKey)
  assert.equal(after.revision, before.revision)
})

// ---- The pending way back (A-3) ----

test('acp_tool cannot be added while the way back of an unconfirmed switch runs its own tools', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { previousModel: KEPT }) }))
  const h = await open()
  refusedWith(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }), OWN_TOOLS_DENY_TEXT)
  assert.deepEqual(pair(h.stored().bots.a), [SOL, undefined])
  // The new model answers: no way back is pending any more, and the list saves.
  for (const listener of h.ctx.listeners.get('session/event') ?? []) {
    listener({ id: 'chat-a' }, { type: 'assistant/message', data: { message: { source: { provider: CODEX, model: 'gpt-6.1-sol' } } } })
  }
  assert.equal(h.rt.botOf('a').previousModel, SOL)
  saved(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }))
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
})

test('a combined move away plus acp_tool is refused before anything is written; two steps work', async (t) => {
  for (const extra of [{ previousModel: KEPT }, {}]) {
    const { open } = workspace(t, team({ a: record('a', KEPT, { permissionRev: 3, ...extra }) }))
    const h = await open()
    const renames = []
    h.ctx.sessionTitle.rename = async (...args) => { renames.push(args) }
    let cleared = 0
    const clearAuto = h.rt.clearAuto
    h.rt.clearAuto = (...args) => { cleared += 1; return clearAuto(...args) }
    const before = { ...h.rt.botOf('a') }
    refusedWith(await h.call('update-bot', { id: 'a', name: 'X', model: SOL, denyTools: ['acp_tool'] }), OWN_TOOLS_DENY_TEXT)
    const now = h.rt.botOf('a')
    assert.deepEqual([now.model, now.previousModel, now.denyTools, now.name, now.permissionRev],
      [before.model, before.previousModel, before.denyTools, before.name, before.permissionRev])
    assert.deepEqual(pair(h.stored().bots.a), [KEPT, undefined])
    assert.deepEqual(renames, [])
    assert.equal(cleared, 0)
    assert.deepEqual(h.selects, [])
    // Two steps: move, the new model answers, then add acp_tool.
    saved(await h.call('update-bot', { id: 'a', model: SOL }))
    for (const listener of h.ctx.listeners.get('session/event') ?? []) {
      listener({ id: 'chat-a' }, { type: 'assistant/message', data: { message: { source: { provider: CODEX, model: 'gpt-6.1-sol' } } } })
    }
    saved(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }))
    assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
  }
  // CD-2: removing acp_tool and moving to such a model in one patch is refused before anything
  // is written (the switch's own check reads the live list); two steps work.
  {
    const { open } = workspace(t, team({ b: record('b', SOL, { permissionRev: 3, denyTools: ['acp_tool'] }) }))
    // The patch also sets a level, so a save that got past the early check would clear Auto.
    const h = await open({ services: { permissionPresets: { resolve: () => ({ sandbox: 'workspace-write' }) } } })
    let cleared = 0
    const clearAuto = h.rt.clearAuto
    h.rt.clearAuto = (...args) => { cleared += 1; return clearAuto(...args) }
    refusedWith(await h.call('update-bot', { id: 'b', model: KEPT, denyTools: [], permission: 'workspace' }), OWN_TOOLS_MODEL_TEXT)
    const now = h.rt.botOf('b')
    assert.deepEqual([...pair(now), now.permissionRev], [SOL, ['acp_tool'], 3])
    assert.deepEqual(pair(h.stored().bots.b), [SOL, ['acp_tool']])
    assert.equal(cleared, 0)
    assert.deepEqual(h.selects, [])
    saved(await h.call('update-bot', { id: 'b', denyTools: [] }))
    saved(await h.call('update-bot', { id: 'b', model: KEPT }))
    assert.deepEqual(pair(h.rt.botOf('b')), [KEPT, undefined])
    assert.deepEqual(pair(h.stored().bots.b), [KEPT, undefined])
  }
})

// ---- Races (A-1, B-1, B-2, C-1, C-2) ----

test('a model save and an acp_tool save racing: exactly one wins, in either order', async (t) => {
  for (const first of ['model', 'deny']) {
    const { open } = workspace(t, team({ a: record('a', SOL) }))
    const h = await open()
    const access = Promise.withResolvers()
    const deny = Promise.withResolvers()
    const accessReached = Promise.withResolvers()
    const denyReached = Promise.withResolvers()
    h.rt.assertModelAccess = async () => { accessReached.resolve(); await access.promise }
    h.rt.assertDenyTools = async () => { denyReached.resolve(); await deny.promise }
    const model = h.call('update-bot', { id: 'a', model: KEPT })
    const list = h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] })
    await Promise.all([accessReached.promise, denyReached.promise])
    if (first === 'model') { access.resolve(); await model; deny.resolve() } else { deny.resolve(); await list; access.resolve() }
    const results = [await model, await list]
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results))
    const loser = results.find(result => !result.ok)
    assert.ok([OWN_TOOLS_MODEL_TEXT, OWN_TOOLS_DENY_TEXT].includes(loser.error.message), loser.error.message)
    for (const bot of [h.rt.botOf('a'), h.stored().bots.a]) {
      const [ref, list] = pair(bot)
      assert.equal(ref === KEPT && deniesAcp(list), false, `${first}: never both (${ref}, ${list})`)
    }
  }
})

test('a route switch racing an acp_tool save refuses at its last check', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.rt.clearAuto = async () => { reached.resolve(); await gate.promise }
  const switching = h.rt.switchRoute('a', AGY)
  await reached.promise
  saved(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }))
  gate.resolve()
  await assert.rejects(switching, error => error.message === OWN_TOOLS_MODEL_TEXT)
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
  // Control: without the deny the same switch goes through.
  const { open: openOther } = workspace(t, team({ b: record('b', SOL) }))
  const other = await openOther()
  const switched = await other.rt.switchRoute('b', AGY)
  assert.equal(switched.status, 'switched')
  assert.equal(other.rt.botOf('b').model, AGY)
})

test('B-1(2) an acp_tool save whose model moved meanwhile is refused before its name is written', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL) }))
  const h = await open()
  const renames = []
  h.ctx.sessionTitle.rename = async (...args) => { renames.push(args) }
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.rt.assertDenyTools = async () => { reached.resolve(); await gate.promise }
  const list = h.call('update-bot', { id: 'a', name: 'X', denyTools: ['acp_tool'] })
  await reached.promise
  saved(await h.call('update-bot', { id: 'a', model: KEPT }))
  gate.resolve()
  refusedWith(await list, OWN_TOOLS_DENY_TEXT)
  assert.equal(h.rt.botOf('a').name, 'Bot a')
  assert.deepEqual(renames, [])
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, undefined])
})

test('C-3 a failed step after the switch puts the model and the list back', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['read'] }) }))
  const h = await open({ services: { permissionPresets: { resolve: () => ({ sandbox: 'workspace-write' }) } } })
  // The level's apply fails after the switch and the list were written (not levelNotApplied).
  let tried = 0
  h.rt.setPermission = async () => { tried += 1; throw Object.assign(new Error('level refused'), { permission: 'x' }) }
  const result = await h.call('update-bot', { id: 'a', permission: 'workspace', model: LUNA, denyTools: ['bash'] })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(tried, 1, 'the failing step ran after the writes')
  for (const bot of [h.rt.botOf('a'), h.stored().bots.a]) {
    assert.equal(bot.name, 'Bot a')
    assert.deepEqual(pair(bot), [SOL, ['read']])
  }
})

test('B-2 acp_tool cannot be added while a model change may still roll back', async (t) => {
  const { open } = workspace(t, team({ a: record('a', KEPT) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  const applyModel = h.rt.applyModel
  let held = true
  h.rt.applyModel = async (...args) => {
    if (held) { held = false; reached.resolve(); await gate.promise; throw new Error('selection refused') }
    return applyModel(...args)
  }
  const moving = h.call('update-bot', { id: 'a', model: SOL })
  await reached.promise
  refusedWith(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }), busyText('Bot a'))
  // Control: a list that does not add acp_tool saves in the same window.
  saved(await h.call('update-bot', { id: 'a', denyTools: ['bash'] }))
  gate.resolve()
  assert.equal((await moving).ok, false)
  assert.deepEqual(pair(h.rt.botOf('a')), [KEPT, ['bash']])
  // The list saved in the window is on disk; acp_tool never is.
  assert.deepEqual(pair(h.stored().bots.a)[1], ['bash'])
})

test('B-2 a route switch that rolls back refuses an acp_tool save made meanwhile', async (t) => {
  const { open } = workspace(t, team({ a: record('a', AGY) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.rt.applyModel = async () => { reached.resolve(); await gate.promise; throw new Error('selection refused') }
  const switching = h.rt.switchRoute('a', SOL)
  await reached.promise
  refusedWith(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }), busyText('Bot a'))
  gate.resolve()
  await assert.rejects(switching)
  assert.deepEqual(pair(h.rt.botOf('a')), [AGY, undefined])
})

test('C-1 an update that may still restore a model that runs its own tools refuses acp_tool', async (t) => {
  const { open } = workspace(t, team({ a: record('a', KEPT) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.ctx.sessionTitle.rename = async () => { reached.resolve(); await gate.promise; throw new Error('title refused') }
  const moving = h.call('update-bot', { id: 'a', name: 'X', model: SOL })
  await reached.promise
  assert.equal(h.rt.botOf('a').model, SOL, 'the switch is applied, the update not done')
  assert.equal(h.rt.pickingModel('a'), false)
  assert.equal(h.rt.settlingModel('a'), 1)
  // The name is already written by the update in flight.
  refusedWith(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }), busyText('X'))
  saved(await h.call('update-bot', { id: 'a', denyTools: ['bash'] }))
  gate.resolve()
  assert.equal((await moving).ok, false)
  assert.equal(h.rt.settlingModel('a'), 0)
  assert.deepEqual(pair(h.rt.botOf('a')), [KEPT, ['bash']])
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['bash']])
})

test('C-2 a refused update keeps acp_tool removed when putting it back would make the pair', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.ctx.sessionTitle.rename = async () => { reached.resolve(); await gate.promise; throw new Error('title refused') }
  const clearing = h.call('update-bot', { id: 'a', name: 'X', denyTools: [] })
  await reached.promise
  saved(await h.call('update-bot', { id: 'a', model: KEPT }))
  gate.resolve()
  assert.equal((await clearing).ok, false)
  for (const bot of [h.rt.botOf('a'), h.stored().bots.a]) {
    assert.equal(bot.model, KEPT)
    assert.equal(bot.denyTools?.includes('acp_tool') ?? false, false)
  }
  assert.ok(h.warnings.some(line => line.includes('acp_tool stays allowed')), h.warnings.join('\n'))
})

test('C-2 control: with no model change meanwhile the list goes back, also on disk', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.ctx.sessionTitle.rename = async () => { reached.resolve(); await gate.promise; throw new Error('title refused') }
  const clearing = h.call('update-bot', { id: 'a', name: 'X', denyTools: [] })
  await reached.promise
  // Another save persists the shorter list while the update waits.
  await h.rt.save()
  gate.resolve()
  assert.equal((await clearing).ok, false)
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
})

test('CD-1 a refused update leaves a Denied tools list saved meanwhile in place', async (t) => {
  // U's own list is still on the record when it fails, unless a newer save D replaced it: then
  // D's list stays (newer changes win), in memory and on disk, whichever way U's restore goes.
  for (const [start, mine, theirs] of [
    [['bash'], ['bash', 'write'], ['bash', 'acp_tool']],
    [['acp_tool'], [], ['write']],
  ]) {
    const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: start }) }))
    const h = await open()
    const gate = Promise.withResolvers()
    const reached = Promise.withResolvers()
    h.ctx.sessionTitle.rename = async () => { reached.resolve(); await gate.promise; throw new Error('title refused') }
    const widening = h.call('update-bot', { id: 'a', name: 'X', denyTools: mine })
    await reached.promise
    saved(await h.call('update-bot', { id: 'a', denyTools: theirs }))
    gate.resolve()
    assert.equal((await widening).ok, false)
    assert.deepEqual(pair(h.rt.botOf('a')), [SOL, theirs])
    assert.deepEqual(pair(h.stored().bots.a), [SOL, theirs])
  }
})

// ---- Create (A-6, B-3) ----

test('create refuses a Bot that would deny acp_tool on a model that runs its own tools', async (t) => {
  const { open } = workspace(t, team({ c: record('c', SOL, { denyTools: ['acp_tool'] }) }, ['main', 'c']))
  const h = await open()
  const count = () => Object.keys(h.rt.state.bots).length
  const bots = count()
  for (const model of [KEPT, AGY]) {
    await assert.rejects(h.rt.createBot({ name: `Made ${model.length}`, instructions: 'Work.', model, createdBy: 'c' }),
      error => error.message === OWN_TOOLS_CREATE_TEXT)
    await assert.rejects(h.rt.createBot({ name: `Own ${model.length}`, instructions: 'Work.', model, denyTools: ['acp_tool'] }),
      error => error.message === OWN_TOOLS_MODEL_TEXT)
  }
  // No model named and the team default one that runs its own tools: refused too.
  h.rt.state.prefs.defaultBotModel = KEPT
  await assert.rejects(h.rt.createBot({ name: 'Defaulted', instructions: 'Work.', createdBy: 'c' }),
    error => error.message === OWN_TOOLS_CREATE_TEXT)
  assert.equal(count(), bots, 'no Bot was made')
  // Controls: a model that is not one, and a creator that does not deny acp_tool.
  const made = await h.rt.createBot({ name: 'Fine', instructions: 'Work.', model: LUNA, createdBy: 'c' })
  assert.deepEqual(pair(made), [LUNA, ['acp_tool']])
  const open2 = await h.rt.createBot({ name: 'Open', instructions: 'Work.', model: KEPT })
  assert.deepEqual(pair(open2), [KEPT, undefined])
})

test('create_bot skips a fallback that runs its own tools, and refuses when none is left', async (t) => {
  const { open } = workspace(t, team({
    main: record('main', LUNA, { denyTools: ['acp_tool'] }),
  }))
  const h = await open()
  h.rt.state.prefs.defaultBotModel = KEPT
  const tool = h.rt.teamTools.find(entry => entry.name === 'create_bot')
  const exec = { agent: { id: 'chat-main', session: { id: 'chat-main' } } }
  const args = name => ({ name, role: 'r', instructions: 'Work.' })
  const made = await tool.execute(args('Fallback'), exec)
  const bot = Object.values(h.rt.state.bots).find(entry => entry.name === 'Fallback')
  assert.ok(bot, String(made))
  assert.deepEqual(pair(bot), [LUNA, ['acp_tool']])
  // An explicit model is not swapped: refused.
  const named = await tool.execute({ ...args('Named'), model: KEPT }, exec)
  assert.match(String(named), /cannot run on a model that runs its own tools/)
  assert.equal(Object.values(h.rt.state.bots).some(entry => entry.name === 'Named'), false)
  // A deny list given as a string is refused as such, not with a TypeError.
  await assert.rejects(Promise.resolve().then(() => tool.execute({ ...args('Text'), deny_tools: 'acp_tool' }, exec)),
    error => !(error instanceof TypeError) && /deny_tools/.test(error.message))
  assert.equal(Object.values(h.rt.state.bots).some(entry => entry.name === 'Text'), false)
  // The creator itself on a model that runs its own tools: nothing allowed is left.
  h.rt.botOf('main').model = KEPT
  const none = await tool.execute(args('None'), exec)
  assert.match(String(none), new RegExp(OWN_TOOLS_CREATE_TEXT.replace(/[.]/g, '\\.')))
  assert.equal(Object.values(h.rt.state.bots).some(entry => entry.name === 'None'), false)
})

test('create_bot by a creator that allows acp_tool, asked to deny it on a kept model, gets the model text', async (t) => {
  const { open } = workspace(t, team({}))
  const h = await open()
  const tool = h.rt.teamTools.find(entry => entry.name === 'create_bot')
  const exec = { agent: { id: 'chat-main', session: { id: 'chat-main' } } }
  const args = name => ({ name, role: 'r', instructions: 'Work.', deny_tools: ['acp_tool'] })
  const bots = Object.keys(h.rt.state.bots).length
  assert.equal(await tool.execute({ ...args('Kept'), model: KEPT }, exec), `Could not create the Bot: ${OWN_TOOLS_MODEL_TEXT}`)
  assert.equal(Object.keys(h.rt.state.bots).length, bots, 'no Bot was made')
  assert.equal(Object.values(h.stored().bots).some(entry => entry.name === 'Kept'), false)
  // Control: the same call on a model that is not one makes the Bot.
  await tool.execute({ ...args('Luna'), model: LUNA }, exec)
  const made = Object.values(h.rt.state.bots).find(entry => entry.name === 'Luna')
  assert.deepEqual(pair(made), [LUNA, ['acp_tool']])
})

// ---- The update_bot tool (A-5) ----

test('update_bot by a Bot on itself or by a Main Bot on a peer gets the same refusal', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  const tool = h.rt.teamTools.find(entry => entry.name === 'update_bot')
  const own = await tool.execute({ model: KEPT }, { agent: { id: 'chat-a', session: { id: 'chat-a' } } })
  assert.match(String(own), /runs its own tools anyway/)
  const peer = await tool.execute({ bot: 'Bot a', model: KEPT }, { agent: { id: 'chat-main', session: { id: 'chat-main' } } })
  assert.match(String(peer), /runs its own tools anyway/)
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
})

// ---- Pocket (A-7, B-2, B-5) ----

test('Pocket leaves a model that runs its own tools out for a Bot that denies acp_tool', async (t) => {
  const { open } = workspace(t, team({
    d: record('d', SOL, { denyTools: ['acp_tool'] }),
    k: record('k', KEPT, { denyTools: ['acp_tool'] }),
    o: record('o', SOL),
  }))
  const h = await open()
  const entry = ref => ({ ref, provider: ref.split('/')[0] })
  assert.equal(modelChoiceOf(h.rt, h.rt.botOf('d'), entry(KEPT)), false)
  assert.equal(modelChoiceOf(h.rt, h.rt.botOf('d'), entry(LUNA)), true)
  assert.equal(modelChoiceOf(h.rt, h.rt.botOf('o'), entry(KEPT)), true)
  // The Bot's own current model stays listed.
  assert.equal(modelChoiceOf(h.rt, h.rt.botOf('k'), entry(KEPT)), true)
})

const pocket = async (h, botId, model) => {
  const { pocketSettingsOf, settingsRevOf } = await import('../src/host/pocket-settings.js')
  await h.rt.catalog()
  return pocketSettingsOf(h.rt).run('model', {
    botId, terminal: 'phone', rev: settingsRevOf(botId, h.rt.botOf(botId)), model, allowed: () => undefined,
  })
}

test('B-5 a model found to run its own tools after admission answers model-not-allowed', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const h = await open({ kept: new Set() })
  const applyModel = h.rt.applyModel
  h.rt.applyModel = (...args) => { h.kept.add(KEPT); return applyModel(...args) }
  const result = await pocket(h, 'a', KEPT)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.reason, 'model-not-allowed')
  assert.deepEqual(h.selects, [])
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
})

test('B-2 acp_tool cannot be added while Pocket selects a model', async (t) => {
  const { open } = workspace(t, team({ a: record('a', KEPT) }))
  const h = await open()
  const gate = Promise.withResolvers()
  const reached = Promise.withResolvers()
  h.ctx.sessionController.selectModel = async (selection) => { h.selects.push(selection); reached.resolve(); await gate.promise }
  const picking = pocket(h, 'a', SOL)
  await reached.promise
  refusedWith(await h.call('update-bot', { id: 'a', denyTools: ['acp_tool'] }), busyText('Bot a'))
  gate.resolve()
  const result = await picking
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, undefined])
})

// ---- Automatic moves stay allowed (A-3) ----

test('a refused route may put a Bot that denies acp_tool on a kept default; the view says so', async (t) => {
  const { open } = workspace(t, team({ a: record('a', HERMES, { denyTools: ['acp_tool'] }) }))
  const h = await open()
  h.rt.state.providersSeen = [CODEX]
  await h.rt.routeRefused(HERMES)
  assert.equal(h.rt.botOf('a').model, KEPT)
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['acp_tool']])
  assert.equal((await h.view('a')).ownTools, true)
})

test('a subscription move may put a Bot that denies acp_tool on a kept Codex model; the view says so', async (t) => {
  const { open } = workspace(t, team({ a: record('a', 'openai-codex/gpt-5.5', { denyTools: ['acp_tool'] }) }))
  const h = await open({ acp: {
    inspect: async id => ({ id, on: true, signedIn: true, cli: { found: true }, connector: { state: 'ready' } }),
  } })
  await h.rt.moveSubscriptionBots()
  assert.deepEqual(pair(h.rt.botOf('a')), [KEPT, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [KEPT, ['acp_tool']])
  assert.equal(h.warnings.some(line => /were not moved|not applied/.test(line)), false, h.warnings.join('\n'))
  assert.equal((await h.view('a')).ownTools, true)
})

// ---- The model remembered with a sign-in (A-5, cli-login.js applyChoices) ----

test('a model chosen with a sign-in is refused like any save, and the choice says why', async (t) => {
  const { open } = workspace(t, team({ a: record('a', SOL, { denyTools: ['acp_tool'] }) }))
  const attempt = {
    id: CODEX, attemptId: randomUUID(), status: 'waiting', expiresAt: Date.now() + 600_000, openedBy: 'a',
    url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234',
  }
  const h = await open({ acp: { loginStart: async () => ({ ...attempt }), loginCurrent: async () => ({ ...attempt }) } })
  const actions = h.rt.cliLoginActions
  await actions['cli-login-start']({ botId: 'a', provider: CODEX, model: KEPT })
  const choice = async () => (await actions['cli-login-current']({ botId: 'a', provider: CODEX })).attempt.choice
  assert.deepEqual(await choice(), { ref: KEPT, state: 'pending' })
  h.ctx.emit('acp-dsh/login-ready', { id: CODEX })
  for (let i = 0; i < 50 && (await choice())?.state === 'pending'; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await choice(), { ref: KEPT, state: 'failed', message: OWN_TOOLS_MODEL_TEXT, kept: SOL })
  assert.deepEqual(pair(h.rt.botOf('a')), [SOL, ['acp_tool']])
  assert.deepEqual(pair(h.stored().bots.a), [SOL, ['acp_tool']])
  assert.deepEqual(h.selects, [])
})
