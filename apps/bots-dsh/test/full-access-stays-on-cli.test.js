// A Bot at Full access on a coding CLI (Claude Code, Codex) is never moved to another
// provider on its own: there the CLI itself runs without asking, and another model would run
// DSH's own tools unasked at that level. Each automatic move is refused for such a Session and
// goes on as before for every other level and every other route. A model the person picks is
// not part of this.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installFallback, STAYS_ON_CLI, stayNotice } from '../src/host/fallback.js'
import { DICTIONARY } from '../src/client/i18n.js'
import { readFileSync } from 'node:fs'
import { install as installModels } from '../src/host/models.js'
import { install as installPermissions } from '../src/host/permissions.js'
import { cliRoute, leavesCli } from '../src/shared/routes.js'

const CODEX = { provider: 'acp-codex', model: 'default' }
const CODEX_FALLBACK = { provider: 'acp-codex', model: 'gpt-5' }
const CLAUDE = { provider: 'acp-claude', model: 'opus' }
const OPENAI = { provider: 'openai', model: 'gpt-5.4-mini' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('a coding CLI\'s route is Claude Code\'s or Codex\'s over ACP, no other agent\'s, and only another provider leaves it', () => {
  for (const provider of ['acp-claude', 'acp-codex']) assert.equal(cliRoute(provider), true, provider)
  for (const provider of ['acp-fake', 'acp-gemini', 'acp-', 'acp-codex-2', 'openai', 'openai-codex', 'anthropic', 'claude-code', 'deepseek-official', '', undefined, null, 7]) assert.equal(cliRoute(provider), false, String(provider))
  assert.equal(leavesCli({ provider: 'acp-fake', model: 'm' }, DEEPSEEK), false, 'another agent over ACP keeps the plain rule')
  assert.equal(leavesCli(CODEX, DEEPSEEK), true)
  assert.equal(leavesCli(CODEX, CLAUDE), true, 'the other CLI is another harness the person did not choose')
  assert.equal(leavesCli(CODEX, { provider: 'acp-codex', model: 'gpt-5' }), false, 'another model of the same CLI')
  assert.equal(leavesCli(CODEX, undefined), true)
  assert.equal(leavesCli(OPENAI, DEEPSEEK), false)
  assert.equal(leavesCli(undefined, DEEPSEEK), false)
})

// fallback.js as DSH runs it (the harness of fallback.test.js), on a Session whose route and
// level the case names.
// `saved`: the model its Bot has saved, the failed route's own unless the case names another.
function fallbackHarness({ route = CODEX, wide, fallbackModel = 'deepseek-official/deepseek-flash', saved = `${route.provider}/${route.model}`, owned = true } = {}) {
  const hooks = new Map()
  const warnings = []
  const asked = []
  const ctx = { on: (name, listener, options) => hooks.set(name, { listener, options }) }
  installFallback({
    ctx, config: {}, isBotSession: () => true, defaultModel: async () => fallbackModel, selfOf: sessionId => (owned && sessionId === 'bot-1' ? 'b1' : undefined), botOf: id => (id === 'b1' ? { name: 'Ops', ...(saved ? { model: saved } : {}) } : undefined), warn: (...args) => warnings.push(args),
    ...(wide === undefined ? {} : { sessionWide: (...args) => { asked.push(args); return typeof wide === 'function' ? wide() : wide } }),
  })
  const selected = []
  const followed = []
  const appended = []
  const agent = {
    id: 'bot-1',
    model: { current: () => selected.at(-1) ?? { ...route }, select: selection => selected.push(selection) },
    followup: message => followed.push(message),
    session: { id: 'bot-1', requestHeader: () => ({ config: route }), append: (...row) => { appended.push(row) } },
  }
  const failed = (failure, turn = 3) => hooks.get('agent/request-error').listener({ agent, turn, step: 1, failure, signal: { aborted: false } }, async () => undefined)
  return { failed, selected, followed, appended, warnings, asked, agent, armed: () => hooks }
}

test('a failed turn at Full access on a coding CLI is not moved: the turn fails and the chat says why it stays', async () => {
  for (const route of [CODEX, CLAUDE]) {
    const h = fallbackHarness({ route, wide: true })
    assert.equal(await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped\nmore' }), undefined, 'the failed step is not retried')
    assert.deepEqual(h.selected, [], `${route.provider}: no other model is selected`)
    assert.deepEqual(h.followed, [], 'no fallback turn is woken')
    assert.equal(h.appended.length, 1, 'one line in the chat')
    const [type, message, options] = h.appended[0]
    assert.equal(type, 'user/message')
    assert.deepEqual(options, { surfaceOp: 'append' })
    assert.equal(message.source.kind, 'model-selection')
    assert.equal(message.source.form, 'notice')
    assert.equal(message.content[0].text, STAYS_ON_CLI)
    assert.equal(message.source.summary, `${route.provider}/${route.model} failed; the Bot stays on it`)
    assert.deepEqual(h.asked, [['bot-1', h.agent.session]], 'the Session\'s own level is what is read')
    assert.ok(h.warnings.some(args => /stays there/.test(args[0])))
  }
})

test('the line is one fixed sentence, worded in Chinese and pt-BR too, as the start refusal is', () => {
  assert.equal(STAYS_ON_CLI, 'The model failed and no other model answered in its place: this Bot has Full access on its coding CLI and stays there. Fix the CLI or sign in to it, or pick another model for the Bot yourself.')
  assert.equal(stayNotice(CODEX).content[0].text, STAYS_ON_CLI)
  const ptBR = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const refusal = 'This Bot has Full access on its coding CLI, which is not available now, so nothing was started on another model. Fix the CLI or sign in to it, or pick another model for the Bot yourself.'
  for (const sentence of [STAYS_ON_CLI, refusal]) {
    for (const [language, table] of [['Chinese', DICTIONARY.zh], ['pt-BR', ptBR]]) {
      assert.equal(typeof table[sentence], 'string', `${language}: ${sentence}`)
      assert.notEqual(table[sentence], sentence, language)
    }
  }
})

test('every other level on a coding CLI still falls back as before', async () => {
  // Read only, Workspace, Auto review: the Session does not read Full access.
  const h = fallbackHarness({ route: CODEX, wide: false, fallbackModel: 'acp-codex/gpt-5' })
  await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped' })
  assert.deepEqual(h.selected, [CODEX_FALLBACK])
  assert.equal(h.followed.length, 1)
  assert.match(h.followed[0].content[0].text, /^\[model fallback: acp-codex\/default failed/)
  assert.deepEqual(h.appended, [], 'no stay line')
})

test('Full access on a route that is not a coding CLI still falls back as before', async () => {
  const h = fallbackHarness({ route: OPENAI, wide: true })
  await h.failed({ code: 'SERVER' })
  assert.deepEqual(h.selected, [DEEPSEEK])
  assert.equal(h.followed.length, 1)
  assert.deepEqual(h.appended, [])
  assert.deepEqual(h.asked, [], 'the level is not even read off a CLI')
})

test('Full access on another agent over ACP still falls back as before', async () => {
  for (const provider of ['acp-fake', 'acp-gemini']) {
    const h = fallbackHarness({ route: { provider, model: 'm' }, wide: true, fallbackModel: `${provider}/other` })
    await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped' })
    assert.deepEqual(h.selected, [{ provider, model: 'other' }], provider)
    assert.deepEqual(h.appended, [])
  }
})

test('a Session left on a CLI its Bot was moved off still falls back at Full access', async () => {
  // The person moved the Bot from Codex to a native model; one group seat did not take the
  // switch and still runs on Codex. Its Bot's saved model is native: the seat falls back.
  const cases = [
    { saved: 'deepseek-official/deepseek-pro' },
    { saved: 'acp-claude/opus' },
    { saved: null },
    { owned: false },
  ]
  for (const options of cases) {
    const h = fallbackHarness({ route: CODEX, wide: true, fallbackModel: 'acp-codex/gpt-5', ...options })
    await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped' })
    assert.deepEqual(h.selected, [CODEX_FALLBACK], JSON.stringify(options))
    assert.equal(h.followed.length, 1)
    assert.match(h.followed[0].content[0].text, /^\[model fallback: acp-codex\/default failed/)
    assert.deepEqual(h.appended, [], 'no stay line')
  }
})

test('the same seat whose Bot is saved on that CLI, on any model of it, is still not moved', async () => {
  for (const saved of ['acp-codex/default', 'acp-codex/gpt-5']) {
    const h = fallbackHarness({ route: CODEX, wide: true, saved })
    await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped' })
    assert.deepEqual([h.selected, h.followed], [[], []], saved)
    assert.equal(h.appended.length, 1)
    assert.equal(h.appended[0][1].content[0].text, STAYS_ON_CLI)
  }
})

test('a fallback that is another model of the same CLI is still taken at Full access', async () => {
  const h = fallbackHarness({ route: CODEX, wide: true, fallbackModel: 'acp-codex/gpt-5' })
  await h.failed({ code: 'SERVER' })
  assert.deepEqual(h.selected, [{ provider: 'acp-codex', model: 'gpt-5' }])
  assert.deepEqual(h.appended, [])
})

test('a level that cannot be read is not taken for Full access, and a failure kept as it is stays kept', async () => {
  const unknown = fallbackHarness({ route: CODEX, fallbackModel: 'acp-codex/gpt-5' })
  await unknown.failed({ code: 'SERVER' })
  assert.deepEqual(unknown.selected, [CODEX_FALLBACK], 'without the level reader the fallback goes on as before')
  const odd = fallbackHarness({ route: CODEX, wide: () => undefined, fallbackModel: 'acp-codex/gpt-5' })
  await odd.failed({ code: 'SERVER' })
  assert.deepEqual(odd.selected, [CODEX_FALLBACK])
  const kept = fallbackHarness({ route: CODEX, wide: true })
  await kept.failed({ code: 'MODEL_ACCESS_REQUIRED' })
  assert.deepEqual([kept.selected, kept.followed, kept.appended], [[], [], []], 'a signed-out CLI was never moved, and gets no stay line either')
})

test('a different harness prevents fallback even when Full access leaves the decision to fallback', async t => {
  const cases = [
    ['below Full access', { route: CODEX, wide: false }],
    ['Full access on another ACP agent', { route: { provider: 'acp-fake', model: 'm' }, wide: true }],
    ['Full access on Gemini', { route: { provider: 'acp-gemini', model: 'm' }, wide: true }],
    ['the Bot now uses a native model', { route: CODEX, wide: true, saved: 'deepseek-official/deepseek-pro' }],
    ['the Bot now uses another CLI', { route: CODEX, wide: true, saved: 'acp-claude/opus' }],
    ['the Bot has no saved model', { route: CODEX, wide: true, saved: null }],
    ['there is no Bot', { route: CODEX, wide: true, owned: false }],
    ['there is no level reader', { route: CODEX }],
    ['the level reader returns no level', { route: CODEX, wide: () => undefined }],
  ]
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const h = fallbackHarness(options)
      await h.failed({ code: 'ACP_AGENT', message: 'the agent stopped' })
      const { provider, model } = options.route
      assert.deepEqual([h.selected, h.followed.length, h.appended.map(([, message]) => message.source.summary)],
        [[], 0, [`${provider}/${model} failed; the fallback runs on another harness`]])
    })
  }
})

test('a notice that cannot be written does not move the Bot either', async () => {
  const h = fallbackHarness({ route: CODEX, wide: true })
  h.agent.session.append = () => { throw new Error('log closed') }
  assert.equal(await h.failed({ code: 'SERVER' }), undefined)
  assert.deepEqual(h.selected, [])
  assert.ok(h.warnings.some(args => /was not written/.test(args[0])))
})

// permissions.js with a stand-in for DSH's presets: what each Session reads, by its id.
const SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  'my-open': { sandbox: 'danger-full-access', approval: 'never' },
}
function levels({ bots = {}, rooms = {}, reads = {}, tasks = {}, defaultPreset = 'workspace-write', service = true, open = [] } = {}) {
  const presets = {
    catalog: () => ({ options: Object.keys(SPECS).map(value => ({ value })), defaultPreset }),
    resolve: (name) => { if (!Object.hasOwn(SPECS, name)) throw new Error(`unknown preset "${name}"`); return SPECS[name] },
    current: (session) => { if (!Object.hasOwn(reads, session.id)) throw new Error('not readable'); return reads[session.id] },
    set: () => {},
  }
  const ctx = { get: name => (name === 'permissionPresets' && service ? presets : undefined), on: () => () => {}, sessions: { list: () => open.map(id => ({ id })) } }
  const groupOwners = new Map()
  const chatOwners = new Map()
  for (const bot of Object.values(bots)) chatOwners.set(`chat-${bot.id}`, bot.id)
  for (const room of Object.values(rooms)) for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
  const rt = {
    ctx, state: { bots, rooms, tasks }, groupOwners, chatOwners, warn: () => {}, load: async () => {}, readOnly: () => undefined,
    botOf: id => bots[id], roomOf: id => rooms[id], chatOf: id => `chat-${id}`,
    groupSessionsOf: id => Object.values(rooms).map(room => room.sessions?.[id]).filter(Boolean),
  }
  installPermissions(rt)
  return rt
}

test('a Session is at Full access by what DSH reports for it, by what the level allows', () => {
  const rt = levels({ bots: { b1: { id: 'b1', permission: 'read-only' } }, reads: { s1: 'danger-full-access', s2: 'workspace-write', s3: 'auto', s4: 'read-only', s5: 'my-open', s6: 'custom' } })
  assert.equal(rt.sessionWide('s1', { id: 's1' }), true)
  assert.equal(rt.sessionWide('s5', { id: 's5' }), true, 'a preset of the person\'s own that allows the same')
  for (const id of ['s2', 's3', 's4', 's6']) assert.equal(rt.sessionWide(id, { id }), false, id)
  // What the Session reads wins over what is saved for its Bot.
  assert.equal(rt.sessionWide('chat-b1', { id: 'chat-b1' }), false)
})

test('a Session DSH cannot read goes by its owner\'s saved level: the Bot\'s, the group\'s, else the default', () => {
  const bots = { full: { id: 'full', permission: 'danger-full-access' }, ro: { id: 'ro', permission: 'read-only' }, none: { id: 'none' } }
  const rooms = { r1: { id: 'r1', permission: 'read-only', sessions: { full: 'g-full' } }, r2: { id: 'r2', permission: 'danger-full-access', sessions: { ro: 'g-ro' } }, r3: { id: 'r3', sessions: { full: 'g3-full' } } }
  const rt = levels({ bots, rooms })
  assert.equal(rt.sessionWide('chat-full'), true)
  assert.equal(rt.sessionWide('chat-ro'), false)
  assert.equal(rt.sessionWide('chat-none'), false, 'the default here is Workspace')
  assert.equal(rt.sessionWide('g-full'), false, 'the group\'s level stands in place of the Bot\'s')
  assert.equal(rt.sessionWide('g-ro'), true)
  assert.equal(rt.sessionWide('g3-full'), true, 'a group without a level leaves the Bot\'s own')
  assert.equal(rt.sessionWide('nobody'), false)
  assert.equal(levels({ bots, defaultPreset: 'danger-full-access' }).sessionWide('chat-none'), true, 'a Bot without a level runs at the default')
  assert.equal(levels({ bots, service: false }).sessionWide('chat-full'), false, 'no presets service: no level is set anywhere')
})

test('a Session with no owner on record yet goes by the owner the caller names, not by the default', () => {
  const bots = { full: { id: 'full', permission: 'danger-full-access' }, ro: { id: 'ro', permission: 'read-only' }, none: { id: 'none' } }
  const narrowRoom = { id: 'r1', permission: 'read-only' }
  const wideRoom = { id: 'r2', permission: 'danger-full-access' }
  // A fresh part: `fresh` is in no index. The profile default is Full access.
  const wideDefault = levels({ bots, defaultPreset: 'danger-full-access' })
  assert.equal(wideDefault.sessionWide('fresh'), true, 'unowned, it reads the default')
  assert.equal(wideDefault.sessionWide('fresh', undefined, { bot: bots.ro }), false, 'a Read only Bot\'s fresh part is not at Full access')
  assert.equal(wideDefault.sessionWide('fresh', undefined, { bot: bots.full, room: narrowRoom }), false, 'nor one in a narrower group')
  assert.equal(wideDefault.sessionWide('fresh', undefined, { bot: bots.none }), true, 'a Bot without a level runs at the default')
  // The reverse: the default is Workspace.
  const narrowDefault = levels({ bots })
  assert.equal(narrowDefault.sessionWide('fresh'), false)
  assert.equal(narrowDefault.sessionWide('fresh', undefined, { bot: bots.full }), true)
  assert.equal(narrowDefault.sessionWide('fresh', undefined, { bot: bots.ro, room: wideRoom }), true)
  assert.equal(narrowDefault.sessionWide('fresh', undefined, { bot: bots.full, room: { id: 'r3' } }), true, 'a group without a level leaves the Bot\'s own')
  assert.equal(narrowDefault.sessionWide('fresh', undefined, { bot: bots.none }), false)
  // What DSH reports for a Session the caller holds still wins.
  assert.equal(levels({ bots, reads: { fresh: 'read-only' } }).sessionWide('fresh', { id: 'fresh' }, { bot: bots.full }), false)
})

// models.js over a catalog the case names: which models are served now. `wide` names the
// Sessions that read Full access; the Bot's chat is `chat-<id>`, its group Sessions `groups`.
function models({ providers, selection, wide, groups = [], open = [] } = {}) {
  const warnings = []
  const selected = []
  const ctx = {
    llm: { listProviders: () => Object.keys(providers).map(id => ({ id })), listModels: async id => providers[id] },
    get: name => (name === 'agentDefaultModel' && selection ? { currentSelection: () => selection } : undefined),
    sessions: { list: () => open.map(id => ({ id })) },
    sessionController: { selectModel: async (request) => { selected.push([request.sessionId, `${request.provider}/${request.model}`]) } },
  }
  const rt = {
    ctx, state: { bots: {} }, warn: (...args) => warnings.push(args), save: async () => {},
    chatOf: id => `chat-${id}`, groupSessionsOf: () => groups,
    ...(wide === undefined ? {} : { sessionWide: (sessionId, ...rest) => { asked.push([sessionId, ...rest]); return wide.includes(sessionId) } }),
  }
  const asked = []
  installModels(rt)
  return Object.assign(rt, { warnings, selected, asked })
}
const NATIVE_ONLY = { deepseek: [{ id: 'deepseek-v4-pro' }] }
const WITH_CODEX = { deepseek: [{ id: 'deepseek-v4-pro' }], 'acp-codex': [{ id: 'default' }, { id: 'gpt-5' }] }
const BOT = { id: 'b1', name: 'Ada', model: 'acp-codex/default' }
const STAYS = 'This Bot has Full access on its coding CLI, which is not available now, so nothing was started on another model. Fix the CLI or sign in to it, or pick another model for the Bot yourself.'

test('a Session at Full access whose Bot\'s coding CLI model is not served is not given another model', async () => {
  const rt = models({ providers: NATIVE_ONLY, wide: ['s1', 'chat-b1'] })
  assert.equal(await rt.desiredModel(BOT, { sessionId: 's1' }), undefined, 'it waits on its CLI, as a Bot with no model waits')
  assert.equal(await rt.desiredModel({ ...BOT, appliedModel: 'deepseek/deepseek-v4-pro' }, { sessionId: 's1' }), undefined, 'nor the last model it ran on, on another provider')
  assert.equal(await rt.desiredModel({ ...BOT, model: 'acp-claude/opus' }, { sessionId: 's1' }), undefined)
  assert.equal(await rt.desiredModel(BOT), undefined, 'with no Session named, any Session of its own at Full access holds it')
  assert.ok(rt.warnings.some(args => /stays on it/.test(args[0])))
  const said = rt.warnings.length
  await rt.desiredModel(BOT, { sessionId: 's1' })
  assert.equal(rt.warnings.length, said, 'said once for the same move')
})

test('the level is read per Session: a narrow Session of the same Bot still gets the default model', async () => {
  // The Bot is at Full access in a group (g1); its own chat is Read only.
  const rt = models({ providers: NATIVE_ONLY, wide: ['g1'], groups: ['g1'] })
  assert.equal(await rt.desiredModel(BOT, { sessionId: 'chat-b1' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel(BOT, { sessionId: 'g1' }), undefined)
  // applyModel moves the chat and leaves the group Session on the CLI's route.
  assert.equal(await rt.applyModel({ ...BOT }), undefined, 'not recorded as applied while one Session stays')
  assert.deepEqual(rt.selected, [['chat-b1', 'deepseek/deepseek-v4-pro']])
  // The other way round: the chat stays, the narrow group Session moves.
  const other = models({ providers: NATIVE_ONLY, wide: ['chat-b1'], groups: ['g1'] })
  const bot = { ...BOT }
  await other.applyModel(bot)
  assert.deepEqual(other.selected, [['g1', 'deepseek/deepseek-v4-pro']])
  assert.equal(bot.appliedModel, undefined)
  // Every Session at Full access: nothing is selected.
  const all = models({ providers: NATIVE_ONLY, wide: ['chat-b1', 'g1'], groups: ['g1'] })
  assert.equal(await all.applyModel({ ...BOT }), undefined)
  assert.deepEqual(all.selected, [])
})

test('the same Bot at any other level still gets the default model, as before', async () => {
  for (const rt of [models({ providers: NATIVE_ONLY, wide: [] }), models({ providers: NATIVE_ONLY })]) {
    assert.equal(await rt.desiredModel(BOT, { sessionId: 's1' }), 'deepseek/deepseek-v4-pro')
    assert.equal(await rt.desiredModel(BOT), 'deepseek/deepseek-v4-pro')
    assert.equal(await rt.desiredModel({ ...BOT, appliedModel: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
    const bot = { ...BOT }
    assert.equal(await rt.applyModel(bot), 'deepseek/deepseek-v4-pro')
    assert.deepEqual(rt.selected, [['chat-b1', 'deepseek/deepseek-v4-pro']])
    assert.equal(bot.appliedModel, 'deepseek/deepseek-v4-pro')
  }
})

test('Full access changes nothing while the CLI model is served, on another model of it, or off a CLI', async () => {
  const wide = ['s1', 'chat-b1', 'chat-b2']
  assert.equal(await models({ providers: WITH_CODEX, wide }).desiredModel(BOT, { sessionId: 's1' }), 'acp-codex/default')
  // The model went away, the CLI is there: the last model it ran on there is taken.
  assert.equal(await models({ providers: WITH_CODEX, wide }).desiredModel({ ...BOT, model: 'acp-codex/old', appliedModel: 'acp-codex/gpt-5' }, { sessionId: 's1' }), 'acp-codex/gpt-5')
  // A Bot on an API model at Full access keeps the plain rule: this is about CLIs only.
  assert.equal(await models({ providers: NATIVE_ONLY, wide }).desiredModel({ id: 'b2', name: 'Bo', model: 'gone/model' }, { sessionId: 's1' }), 'deepseek/deepseek-v4-pro')
  // A side call that runs no tool (memory) keeps the plain rule too.
  assert.equal(await models({ providers: NATIVE_ONLY, wide }).desiredModel(BOT, { aside: true }), 'deepseek/deepseek-v4-pro')
})

test('the exact saved model decides, not whether the CLI lists some other model', async () => {
  // Saved acp-codex/old, never applied; Codex lists other models; the default is native.
  const rt = models({ providers: WITH_CODEX, selection: { provider: 'deepseek', model: 'deepseek-v4-pro' }, wide: ['s1'] })
  const bot = { ...BOT, model: 'acp-codex/old' }
  assert.equal(await rt.desiredModel(bot, { sessionId: 's1' }), undefined)
  await assert.rejects(rt.assertNotOffCli(bot, 's1'), { code: 'bot/refused', message: STAYS })
  // The same Session at another level takes the default, as before.
  await rt.assertNotOffCli(bot, 's2')
  assert.equal(await rt.desiredModel(bot, { sessionId: 's2' }), 'deepseek/deepseek-v4-pro')
})

test('a Session that would start on another provider\'s model at Full access is refused', async () => {
  const gone = models({ providers: NATIVE_ONLY, wide: ['s1'] })
  await assert.rejects(gone.assertNotOffCli(BOT, 's1'), { code: 'bot/refused', message: STAYS })
  // Any other level, a model that is served, another model of the CLI, a Bot off a CLI, no Bot.
  await gone.assertNotOffCli(BOT, 's2')
  await models({ providers: NATIVE_ONLY }).assertNotOffCli(BOT, 's1')
  await models({ providers: WITH_CODEX, wide: ['s1'] }).assertNotOffCli(BOT, 's1')
  await models({ providers: WITH_CODEX, wide: ['s1'] }).assertNotOffCli({ ...BOT, model: 'acp-codex/old', appliedModel: 'acp-codex/gpt-5' }, 's1')
  await gone.assertNotOffCli({ id: 'b2', name: 'Bo', model: 'gone/model' }, 's1')
  await gone.assertNotOffCli({ id: 'b3', name: 'No model' }, 's1')
  await gone.assertNotOffCli(undefined, 's1')
})

test('a selection that failed leaves the Session off its CLI: refused at Full access, whatever is served', async () => {
  const rt = models({ providers: WITH_CODEX, wide: ['s1'] })
  await rt.assertNotOffCli(BOT, 's1')
  await assert.rejects(rt.assertNotOffCli(BOT, 's1', undefined, { unselected: true }), { code: 'bot/refused', message: STAYS })
  // Any other level, a Bot off a coding CLI (another agent over ACP too), no model, no Bot.
  await rt.assertNotOffCli(BOT, 's2', undefined, { unselected: true })
  await rt.assertNotOffCli({ id: 'b2', name: 'Bo', model: 'deepseek/deepseek-v4-pro' }, 's1', undefined, { unselected: true })
  await rt.assertNotOffCli({ id: 'b4', name: 'Fay', model: 'acp-fake/m' }, 's1', undefined, { unselected: true })
  await rt.assertNotOffCli({ id: 'b3', name: 'No model' }, 's1', undefined, { unselected: true })
  await rt.assertNotOffCli(undefined, 's1', undefined, { unselected: true })
  await models({ providers: WITH_CODEX }).assertNotOffCli(BOT, 's1', undefined, { unselected: true })
})

test('the owner and the live Session the caller names are what the level is read from', async () => {
  const rt = models({ providers: NATIVE_ONLY, wide: ['s1'] })
  const session = { id: 's1' }
  const owner = { bot: BOT, room: { id: 'r1' } }
  await assert.rejects(rt.assertNotOffCli(BOT, 's1', session, { owner }), { code: 'bot/refused' })
  assert.deepEqual(rt.asked, [['s1', session, owner]])
})

test('another agent over ACP at Full access keeps the plain rule', async () => {
  const fake = { id: 'b4', name: 'Fay', model: 'acp-fake/m' }
  const rt = models({ providers: NATIVE_ONLY, wide: ['s1', 'chat-b4'] })
  assert.equal(await rt.desiredModel(fake, { sessionId: 's1' }), 'deepseek/deepseek-v4-pro')
  await rt.assertNotOffCli(fake, 's1')
  const bot = { ...fake }
  assert.equal(await rt.applyModel(bot), 'deepseek/deepseek-v4-pro')
  assert.equal(bot.appliedModel, 'deepseek/deepseek-v4-pro')
})

// The applied record is one per Bot; with Sessions on both sides it follows the Bot's own chat.
const codexBack = (rt, providers) => { providers['acp-codex'] = [{ id: 'default' }, { id: 'gpt-5' }]; rt.dropCatalog() }

test('a seat moved while the chat stayed is put back on the CLI when it is served again', async () => {
  // Saved and applied on Codex. Codex goes: the narrow seat moves, the wide chat stays.
  const providers = { ...NATIVE_ONLY }
  const rt = models({ providers, wide: ['chat-b1'], groups: ['g1'] })
  const bot = { ...BOT, appliedModel: 'acp-codex/default', appliedEffort: 'high' }
  assert.equal(await rt.applyModel(bot), undefined)
  assert.deepEqual(rt.selected, [['g1', 'deepseek/deepseek-v4-pro']])
  assert.equal(bot.model, 'acp-codex/default', 'the saved model, which its chat is still on, is what the Bot shows')
  assert.equal(bot.appliedModel, undefined, 'the record no longer says every Session runs on Codex')
  assert.equal(bot.appliedEffort, undefined)
  // Codex is back: nothing is skipped, the seat returns to it.
  codexBack(rt, providers)
  assert.equal(await rt.applyModel(bot), 'acp-codex/default')
  assert.deepEqual(rt.selected.slice(1), [['chat-b1', 'acp-codex/default'], ['g1', 'acp-codex/default']])
  assert.equal(bot.appliedModel, 'acp-codex/default')
})

test('a chat moved while a seat stayed records the model the chat runs on, and both return to the CLI', async () => {
  const providers = { ...NATIVE_ONLY }
  const rt = models({ providers, wide: ['g1'], groups: ['g1'] })
  const bot = { ...BOT, appliedModel: 'acp-codex/default' }
  assert.equal(await rt.applyModel(bot), undefined, 'not applied to every Session')
  assert.deepEqual(rt.selected, [['chat-b1', 'deepseek/deepseek-v4-pro']])
  assert.equal(bot.appliedModel, 'deepseek/deepseek-v4-pro', 'what its own chat runs on now')
  assert.equal(bot.model, 'acp-codex/default')
  codexBack(rt, providers)
  assert.equal(await rt.applyModel(bot), 'acp-codex/default')
  assert.deepEqual(rt.selected.slice(1), [['chat-b1', 'acp-codex/default'], ['g1', 'acp-codex/default']])
  assert.equal(bot.appliedModel, 'acp-codex/default')
})

test('when every Session stays the record stands, and a record that already names the other model is kept', async () => {
  const all = models({ providers: NATIVE_ONLY, wide: ['chat-b1', 'g1'], groups: ['g1'] })
  const bot = { ...BOT, appliedModel: 'acp-codex/default' }
  assert.equal(await all.applyModel(bot), undefined)
  assert.deepEqual(all.selected, [])
  assert.equal(bot.appliedModel, 'acp-codex/default', 'nothing moved: its Sessions are all where the record says')
  // The chat stayed and the record already names the model the seat took.
  const mixed = models({ providers: NATIVE_ONLY, wide: ['chat-b1'], groups: ['g1'] })
  const moved = { ...BOT, appliedModel: 'deepseek/deepseek-v4-pro' }
  await mixed.applyModel(moved)
  assert.equal(moved.appliedModel, 'deepseek/deepseek-v4-pro')
})
