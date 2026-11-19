// A Bot's model change is checked, applied, then saved (plan v3, 2.2 and A-3): a model that
// cannot run now (an agent whose CLI is signed out) or a selection DSH turns down refuses the
// whole update with nothing written; an accepted one keeps the model it leaves as
// `previousModel`. The state answer says what the model really did. No CLI runs here: acp-dsh's
// `inspect` is a stand-in that records what it was asked.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install as installModels, ACCESS_MESSAGES } from '../src/host/models.js'
import { Session } from '@deepseek-ai/dsh-session'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  rooms: {},
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Omni', role: 'Before', instructions: 'Keep these', model: 'deepseek/v4', appliedModel: 'deepseek/v4', createdAt: 1 },
  },
}

// The roster over a fake DSH with DeepSeek and the Codex agent, and acp-dsh's service.
function start({ team = TEAM, agent = { name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' }, signedIn: false }, selectModel, services = {}, historySession } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-access-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const inspected = []
  const acpAgents = { inspect: async (id) => { inspected.push(id); return typeof agent === 'function' ? agent(id) : agent } }
  const ctx = fakeContext({ services: { acpAgents, ...services } })
  const selected = []
  let creates = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'api', name: 'API' }, { id: 'acp-codex', name: 'Codex' }],
      listModels: async provider => [{ id: provider === 'deepseek' ? 'v4' : 'default' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      create: async () => { creates++; return { sessionId: `s${creates}` } },
      resolveAgent: async sessionId => ({ agent: { session: historySession?.id === sessionId ? historySession : { id: sessionId, seq: 1 }, followup: () => {} } }),
      selectModel: async (request) => { if (selectModel) await selectModel(request); selected.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {}, get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const disk = () => readFileSync(join(home, 'state.json'), 'utf8')
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, disk, selected, inspected, creates: () => creates, rt: () => ctx.provided.get('omniTeam'), stop, home }
}

test('a signed-out agent refuses the whole Bot update before anything is written or selected', async (t) => {
  const h = start()
  t.after(h.stop)
  await h.call('state', {})
  const rt = h.rt()
  const before = structuredClone(rt.state)
  const diskBefore = h.disk()
  const response = await h.call('update-bot', { id: 'chief', model: 'acp-codex/default', name: 'Changed', role: 'Changed', instructions: 'Changed' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'bot/sign-in-required', 'the one case a sign-in answers has its own code')
  assert.equal(response.error.message, 'Sign in to Codex (acp-codex) before using this model.')
  assert.deepEqual(rt.state, before, 'nothing changed in memory, providersSeen included')
  assert.equal(h.disk(), diskBefore, 'nothing written')
  assert.deepEqual(h.selected, [], 'no selection')
  assert.deepEqual(h.inspected, ['acp-codex'])
})

test('a new Bot on a signed-out agent is refused before its Session exists', async (t) => {
  const h = start()
  t.after(h.stop)
  await h.call('state', {})
  const rt = h.rt()
  const before = structuredClone(rt.state)
  const made = h.creates()
  await assert.rejects(rt.createBot({ name: 'No orphan', model: 'acp-codex/default' }), { code: 'bot/sign-in-required' })
  assert.equal(h.creates(), made, 'no Session made')
  assert.deepEqual(rt.state, before)
})

test('the other refusals: off, installing; an unknown sign-in and a failed check do not refuse', async () => {
  const cases = [
    [{ name: 'Codex', on: false, cli: { found: true }, connector: { state: 'off' } }, false, ACCESS_MESSAGES.off],
    [{ name: 'Codex', on: true, cli: { found: true }, connector: { state: 'installing' } }, false, ACCESS_MESSAGES.installing],
    [{ name: 'Codex', on: true, cli: { found: false }, connector: { state: 'no-cli' } }, false, ACCESS_MESSAGES.installing],
    [{ name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' } }, true],
    [{ name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' }, signedIn: true }, true],
  ]
  for (const [agent, ready, template] of cases) {
    const rt = { state: { bots: {} }, warn() {}, ctx: { on() {}, get: name => (name === 'acpAgents' ? { inspect: async () => agent } : undefined), llm: { listProviders: () => [], listModels: async () => [] } } }
    installModels(rt)
    const access = await rt.modelAccess('acp-codex/default')
    assert.equal(access.ready, ready, JSON.stringify(agent))
    if (!ready) {
      assert.equal(access.code, 'bot/refused')
      assert.equal(access.message, template.replace('{connection}', 'Codex (acp-codex)'))
    }
  }
  const warnings = []
  const failing = { state: { bots: {} }, warn: (...args) => warnings.push(args), ctx: { on() {}, get: () => ({ inspect: async () => { throw new Error('private diagnostic') } }), llm: { listProviders: () => [], listModels: async () => [] } } }
  installModels(failing)
  assert.equal((await failing.modelAccess('acp-codex/default')).ready, true, 'a check that fails does not refuse; the agent\'s own answer decides')
  assert.equal(warnings.length, 1)
  // An API model is not asked about here, and no acp-dsh at all refuses nothing.
  const asked = []
  const plain = { state: { bots: {} }, warn() {}, ctx: { on() {}, get: () => ({ inspect: async (id) => { asked.push(id) } }), llm: { listProviders: () => [], listModels: async () => [] } } }
  installModels(plain)
  assert.deepEqual(await plain.modelAccess('deepseek/v4'), { ready: true, provider: 'deepseek' })
  assert.deepEqual(asked, [])
  const none = { state: { bots: {} }, warn() {}, ctx: { on() {}, get: () => undefined, llm: { listProviders: () => [], listModels: async () => [] } } }
  installModels(none)
  assert.equal((await none.modelAccess('acp-codex/default')).ready, true)
})

test('an accepted change is applied before it is saved, and keeps the model that answered as previousModel', async (t) => {
  // Same-harness selection is synchronous even with a real, answered history.
  const historySession = new Session('chief')
  const order = []
  const h = start({ historySession, agent: { name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' }, signedIn: true }, selectModel: async () => { order.push(['select', JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.chief.model]) } })
  t.after(h.stop)
  await h.call('state', {})
  // The model it leaves answered in the Bot's chat: the one to go back to (a model that never
  // answered is never recorded).
  const answer = historySession.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider: 'deepseek', model: 'v4' }, content: [{ type: 'text', text: 'Observed answer' }] } }, { surfaceOp: 'append' })
  for (const listener of h.ctx.listeners.get('session/event') ?? []) listener(historySession, answer)
  assert.equal(historySession.deriveMessages().length, 1)
  const response = await h.call('update-bot', { id: 'chief', model: 'api/default' })
  assert.equal(response.ok, true)
  // When DSH selected the model, the saved record still named the old one.
  assert.deepEqual(order[0], ['select', 'deepseek/v4'])
  const saved = JSON.parse(h.disk()).bots.chief
  assert.equal(saved.model, 'api/default')
  assert.equal(saved.appliedModel, 'api/default')
  assert.equal(saved.previousModel, 'deepseek/v4', 'the model it leaves, to go back to if the switch fails')
  // A second change before the first answered keeps the first model to go back to.
  assert.equal((await h.call('update-bot', { id: 'chief', model: 'deepseek/v4' })).ok, true)
  assert.equal(JSON.parse(h.disk()).bots.chief.previousModel, 'deepseek/v4')
  const state = (await h.call('model-state', { id: 'chief' })).value
  assert.equal(state.selected, 'deepseek/v4')
  assert.equal(state.previousModel, 'deepseek/v4')
  assert.equal(state.pending, false)
  assert.equal(state.answered, true, 'its answer was seen: "answered" again once back on it')
  assert.deepEqual(state.access, { ready: true, provider: 'deepseek' })
  assert.deepEqual(historySession.deriveMessages(), [answer.data.message], 'the observed answer stays in history')
})

test('a selection DSH turns down refuses the update with a readable message and writes nothing', async (t) => {
  // A choice within Codex is an in-place transaction; it keeps the Auto route mark.
  const team = structuredClone(TEAM)
  team.bots.chief.model = team.bots.chief.appliedModel = 'acp-codex/old'
  const h = start({
    team,
    agent: { name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' }, signedIn: true },
    selectModel: async (request) => { if (request.provider === 'acp-codex') throw Object.assign(new Error('internal: /home/x/secret path'), { code: 'session/model-unavailable' }) },
  })
  t.after(h.stop)
  await h.call('state', {})
  const rt = h.rt()
  const before = structuredClone(rt.state.bots.chief)
  const diskBefore = h.disk()
  const response = await h.call('update-bot', { id: 'chief', model: 'acp-codex/default', role: 'Changed' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'bot/refused')
  assert.equal(response.error.message, 'Omni could not switch to acp-codex/default. It stays on acp-codex/old.')
  assert.doesNotMatch(response.error.message, /secret path/)
  assert.deepEqual(rt.state.bots.chief, before, 'model, previousModel and the rest of the patch as they were')
  assert.equal(h.disk(), diskBefore)
})

// Mixed harness crossings are deliberately a separate transaction: neither selection nor
// any companion field may run, even when DSH could accept that model and permission.
test('mixed route crossings refuse atomically before selection or permission application', async (t) => {
  for (const patch of [{ role: 'Changed' }, { permission: 'danger-full-access' }]) {
    let applied = 0
    const h = start({ agent: READY, services: { permissionPresets: { ...permissionPresets, set: () => { applied++ } } } })
    t.after(h.stop)
    await h.call('state', {})
    const before = structuredClone(h.rt().state.bots.chief)
    const diskBefore = h.disk()
    const selectedBefore = [...h.selected]
    const appliedBefore = applied
    const response = await h.call('update-bot', { id: 'chief', model: 'acp-codex/default', ...patch })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'bot/refused')
    assert.equal(response.error.message, 'Omni needs a new conversation for that route, so change only its model in this step.')
    assert.deepEqual(h.rt().state.bots.chief, before)
    assert.equal(h.disk(), diskBefore)
    assert.deepEqual(h.selected, selectedBefore)
    assert.equal(applied, appliedBefore)
  }
})

// A permission catalog of two levels; `danger-full-access` resolves but DSH will not set it.
const PRESETS = ['workspace-write', 'danger-full-access']
const permissionPresets = {
  catalog: () => ({ options: PRESETS.map(value => ({ value, name: value })), defaultOptions: [], defaultPreset: 'workspace-write' }),
  resolve: (name) => { if (!PRESETS.includes(name)) throw new Error(`permission: unknown preset "${name}"`); return {} },
  current: () => undefined,
  set: (_session, name) => { if (name === 'danger-full-access') throw new Error('permission: rejected') },
}
const READY = { name: 'Codex', on: true, cli: { found: true }, connector: { state: 'ready' }, signedIn: true }

test('a model change with a refused name or level writes nothing and selects nothing', async (t) => {
  const team = structuredClone(TEAM)
  team.bots.other = { id: 'other', sessionId: 'other', name: 'Taken', model: 'deepseek/v4', appliedModel: 'deepseek/v4', createdAt: 2 }
  const h = start({ team, agent: READY, services: { permissionPresets } })
  t.after(h.stop)
  await h.call('state', {})
  const rt = h.rt()
  const before = structuredClone(rt.state.bots.chief)
  const diskBefore = h.disk()
  const selectedBefore = h.selected.length
  for (const patch of [{ name: 'Taken' }, { name: '' }, { permission: 'no-such-level' }]) {
    const response = await h.call('update-bot', { id: 'chief', model: 'acp-codex/default', ...patch })
    assert.equal(response.ok, false, JSON.stringify(patch))
    assert.deepEqual(rt.state.bots.chief, before, `model as it was: ${JSON.stringify(patch)}`)
    assert.equal(h.disk(), diskBefore, `nothing written: ${JSON.stringify(patch)}`)
    assert.equal(h.selected.length, selectedBefore, `no selection: ${JSON.stringify(patch)}`)
  }
})

test('a model change whose level DSH then refuses goes back to the old model, selected again', async (t) => {
  const h = start({ agent: READY, services: { permissionPresets } })
  t.after(h.stop)
  await h.call('state', {})
  const rt = h.rt()
  const before = structuredClone(rt.state.bots.chief)
  const selectedBefore = h.selected.length
  const response = await h.call('update-bot', { id: 'chief', model: 'api/default', permission: 'danger-full-access' })
  assert.equal(response.ok, false)
  // Invalidating an old Auto confirmation is monotonic, even on a refused level.
  assert.equal(rt.state.bots.chief.permissionRev, (before.permissionRev ?? 0) + 2)
  assert.deepEqual(rt.state.bots.chief, { ...before, permissionRev: rt.state.bots.chief.permissionRev }, 'all patch fields are rolled back; Auto consent stays invalidated')
  const chief = rt.state.bots.chief
  assert.equal(chief.model, 'deepseek/v4')
  assert.equal(chief.appliedModel, 'deepseek/v4')
  assert.equal(Object.hasOwn(chief, 'previousModel'), false)
  assert.equal(Object.hasOwn(chief, 'permission'), false)
  const saved = JSON.parse(h.disk()).bots.chief
  assert.deepEqual(saved, { ...before, permissionRev: chief.permissionRev }, 'the saved patch fields are rolled back too')
  assert.equal(saved.model, 'deepseek/v4')
  assert.equal(saved.appliedModel, 'deepseek/v4')
  assert.equal(Object.hasOwn(saved, 'previousModel'), false)
  // The switch was selected, then the old model selected again.
  assert.deepEqual(h.selected.slice(selectedBefore).map(request => request.provider), ['api', 'deepseek'])
  assert.deepEqual(h.selected.slice(selectedBefore).map(({ sessionId, provider, model }) => [sessionId, provider, model]), [['chief', 'api', 'default'], ['chief', 'deepseek', 'v4']])
})

test('the state answer carries each Bot\'s model state, without a sign-in check', async (t) => {
  const h = start()
  t.after(h.stop)
  const answer = (await h.call('state', {})).value
  assert.deepEqual(answer.work.models.chief, { selected: 'deepseek/v4', previousModel: null, answered: false, pending: false })
  assert.deepEqual(h.inspected, [], 'reading the state spawns no CLI')
  assert.equal((await h.call('model-state', { id: 'nobody' })).ok, false)
})

// Plan 4.4 step 8: what this work adds to the saved team is read safely by the reader that
// ships today. store.js (the reader) is unchanged by it, so loading here is that reader: a
// Bot's `previousModel` and a part's `fallback`, `target` and `archivePending` (parts.js, A-2)
// load without error, stay as written, and change nothing else.
test('data compatibility: the new saved fields load, round-trip, and leave the Bot as it was', async (t) => {
  const team = structuredClone(TEAM)
  Object.assign(team.bots.chief, {
    previousModel: 'acp-codex/default',
    segments: [{ sessionId: 'old-part', endedAt: 5, fallback: 'recent', target: 'deepseek/v4', archivePending: { at: 4 } }],
  })
  const h = start({ team })
  t.after(h.stop)
  const answer = await h.call('state', {})
  assert.equal(answer.ok, true)
  const rt = h.rt()
  const chief = rt.state.bots.chief
  assert.equal(chief.previousModel, 'acp-codex/default')
  assert.equal(chief.model, 'deepseek/v4')
  assert.equal(chief.name, 'Omni')
  assert.deepEqual(chief.segments.at(-1), team.bots.chief.segments[0])
  await rt.save()
  const saved = JSON.parse(h.disk()).bots.chief
  assert.equal(saved.previousModel, 'acp-codex/default')
  assert.deepEqual(saved.segments.at(-1), team.bots.chief.segments[0])
  // A Bot with neither field reads as it always did.
  assert.equal(Object.hasOwn(TEAM.bots.chief, 'previousModel'), false)
})
