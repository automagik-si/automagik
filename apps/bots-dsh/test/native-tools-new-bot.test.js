// The read-only `nativeToolsNew` view field (RFC 0048, #2056 choice (1)): per served model, the
// native-tools block a Bot the person makes now reads right after it is made. Proven against
// the Bot the person's own create-bot then makes, with the same presets and level.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const WRITE = 'workspace-write'
// DSH's stock presets plus a profile's own one whose sandbox is read-only.
const PRESETS = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  inspect: { sandbox: 'read-only', approval: 'ask' },
}
const CLAUDE = 'acp-claude/default'
const CODEX = 'acp-codex/gpt-5.6'
const KEPT = 'acp-codex/gpt-5.6-kept'
const OMP = 'acp-omp/default'
const FLASH = 'deepseek/deepseek-v4-flash'
const TEAM = {
  version: 1, mainBotIds: ['m1'], revision: 1,
  bots: { m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1, model: FLASH } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  // The one-time native-tools upgrade has run (RFC 0003 amendment), as on any team today.
  nativeToolsLocksRetired: true,
}

// The whole team over fake DSH services. A Session's level is the preset applyPermission set on
// that Session, else the profile default's: `sandboxPolicy.resolve({ session })` follows it.
function team(t, { defaultPreset = WRITE, offered = Object.keys(PRESETS), kept = new Set([KEPT]), services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-native-new-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const presetOf = new Map()
  const open = new Set()
  const presets = {
    catalog: () => ({ options: offered.map(value => ({ value, name: value })), defaultOptions: [], defaultPreset }),
    resolve: (name) => {
      if (!offered.includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return PRESETS[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => { presets.resolve(name); presetOf.set(session.id, name) },
  }
  const sandboxPolicy = {
    defaultMode: PRESETS[defaultPreset].sandbox,
    resolve: ({ session }) => ({ mode: PRESETS[presetOf.get(session.id) ?? defaultPreset].sandbox }),
  }
  const acpAgents = { nativeModelKept: ref => kept.has(ref) }
  const ctx = fakeContext({ services: { permissionPresets: presets, sandboxPolicy, acpAgents, ...services } })
  // No sharing plugin runs (native-tools.js liveShareActive).
  ctx.registry = new Map()
  let sessions = 0
  const announce = (session) => {
    if (open.has(session.id)) return
    open.add(session.id)
    for (const listener of ctx.listeners.get('session/created') ?? []) void listener(session)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => ['deepseek', 'acp-claude', 'acp-codex', 'acp-omp'].map(id => ({ id, name: id })),
      listModels: async provider => ({
        deepseek: [{ id: 'deepseek-v4-flash' }],
        'acp-claude': [{ id: 'default' }],
        'acp-codex': [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-kept' }],
        'acp-omp': [{ id: 'default' }],
      })[provider] ?? [],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home }),
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      async create() {
        const sessionId = `s${++sessions}`
        announce({ id: sessionId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = { id: sessionId }
        announce(session)
        await new Promise(resolve => setTimeout(resolve, 1))
        return { agent: { id: sessionId, session, followup() {} } }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: id => (open.has(id) ? { id } : undefined), flush: async () => {}, list: () => [...open].map(id => ({ id })) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  t.mock.method(rt, 'warn', () => {})
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))
  return { rt, call, settle, kept, presetOf }
}

// For each model: the block the field predicts, then the Bot create-bot really makes there.
async function predictAndMake(h, refs) {
  const out = []
  for (const [index, ref] of refs.entries()) {
    const predicted = h.rt.nativeToolsNewBotBlock(ref)
    const stored = h.rt.newBotStoredPermission()
    const made = await h.call('create-bot', { name: `New ${index}`, model: ref })
    assert.equal(made.ok, true, JSON.stringify(made.error))
    await h.settle()
    const bot = h.rt.botOf(made.value.id)
    out.push({ ref, predicted, actual: h.rt.nativeToolsBlock(bot), stored, permission: bot.permission })
  }
  return out
}

test('the predicted block is the block of the Bot create-bot then makes, model by model', async (t) => {
  await t.test('the profile default (Workspace)', async (t) => {
    const h = team(t)
    await h.call('state', {})
    const rows = await predictAndMake(h, [CLAUDE, CODEX, KEPT, OMP])
    for (const row of rows) assert.equal(row.predicted, row.actual, row.ref)
    assert.deepEqual(rows.map(row => row.actual), [undefined, undefined, 'model-kept', undefined])
    // The stored level is buildBot's own, verbatim: unset at the profile default, not the
    // display value rt.newBotPermission() gives.
    for (const row of rows) assert.equal(row.stored, row.permission, row.ref)
    assert.equal(rows[0].stored, undefined)
    assert.equal(h.rt.newBotPermission(), WRITE)
  })
  await t.test('a profile whose default preset is Read only', async (t) => {
    // Its catalog offers Workspace too: a new Bot then starts at Workspace (permissions.js).
    const wide = team(t, { defaultPreset: 'inspect' })
    await wide.call('state', {})
    for (const row of await predictAndMake(wide, [CLAUDE, KEPT])) assert.equal(row.predicted, row.actual, row.ref)
    // Its catalog offers only the Read only preset: a new Bot starts there, unset.
    const h = team(t, { defaultPreset: 'inspect', offered: ['inspect'] })
    await h.call('state', {})
    const rows = await predictAndMake(h, [CLAUDE, OMP, KEPT])
    for (const row of rows) assert.equal(row.predicted, row.actual, row.ref)
    assert.deepEqual(rows.map(row => row.actual), ['read-only', 'read-only', 'model-kept'])
    assert.equal(rows[0].stored, undefined)
  })
  await t.test('a person\'s own default that is a custom Read only preset', async (t) => {
    const h = team(t)
    await h.call('state', {})
    assert.equal((await h.call('set-prefs', { permission: 'inspect' })).ok, true)
    const rows = await predictAndMake(h, [CLAUDE, CODEX])
    for (const row of rows) assert.equal(row.predicted, row.actual, row.ref)
    assert.deepEqual(rows.map(row => row.actual), ['read-only', 'read-only'])
    for (const row of rows) assert.equal(row.stored, 'inspect')
    for (const row of rows) assert.equal(row.permission, 'inspect')
    assert.equal(h.presetOf.get(h.rt.chatOf(h.rt.state.bots[Object.keys(h.rt.state.bots).at(-1)].id)), 'inspect')
  })
  await t.test('a person\'s own wider default', async (t) => {
    const h = team(t)
    await h.call('state', {})
    assert.equal((await h.call('set-prefs', { permission: 'danger-full-access' })).ok, true)
    const rows = await predictAndMake(h, [CLAUDE])
    assert.equal(rows[0].predicted, rows[0].actual)
    assert.equal(rows[0].actual, undefined)
    assert.equal(rows[0].stored, 'danger-full-access')
  })
  await t.test('a multi-user workspace', async (t) => {
    const h = team(t, { services: { automagikCaller: { version: 2, multiuser: true } } })
    assert.equal(h.rt.nativeToolsNewBotBlock(CLAUDE), 'multiuser')
    assert.equal(h.rt.nativeToolsNewBotBlock(FLASH), 'multiuser')
  })
})

test('the view carries the field for every served model, and the models key moves with a block', async (t) => {
  const h = team(t)
  const first = (await h.call('state', {})).value
  assert.deepEqual(Object.keys(first.nativeToolsNew).sort(), first.models.map(model => model.ref).sort())
  assert.deepEqual(first.nativeToolsNew, { [FLASH]: null, [CLAUDE]: null, [CODEX]: null, [KEPT]: 'model-kept', [OMP]: null })
  // The models key carries only the blocked refs.
  assert.match(first.modelsKey, new RegExp(`\\|${KEPT}=model-kept$`))
  assert.doesNotMatch(first.modelsKey, new RegExp(`${CLAUDE}=`))
  // A model that becomes kept changes the key, so a window that has it pulls the full view again.
  h.kept.add(CODEX)
  const again = (await h.call('state', { since: first.revision, models: first.modelsKey })).value
  assert.equal(again.unchanged, undefined)
  assert.equal(again.nativeToolsNew[CODEX], 'model-kept')
  assert.notEqual(again.modelsKey, first.modelsKey)
  // Nothing changed: the short answer, and the key is the same.
  const same = (await h.call('state', { since: again.revision, models: again.modelsKey })).value
  assert.equal(same.unchanged, true)
  // Never stored.
  assert.equal(Object.hasOwn(h.rt.state, 'nativeToolsNew'), false)
})
