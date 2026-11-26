import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configured, install } from '../src/host/models.js'
import { CLAUDE_PINS } from '../../acp-dsh/src/host/model-identity.js'
import { chosenIdentity, chosenIdentityOf } from '../src/shared/solver-model.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }, { id: 'deepseek-v4-pro' }],
}

function runtime(defaultSelection, on) {
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
    },
    get: name => (name === 'agentDefaultModel' && defaultSelection ? { currentSelection: () => defaultSelection } : undefined),
    on,
  }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  return rt
}

test('the default model is the DSH default when served, else the first served model', async () => {
  assert.equal(await runtime({ provider: 'ollama', model: 'kimi-k3' }).defaultModel(), 'ollama/kimi-k3')
  assert.equal(await runtime({ provider: 'gone', model: 'x' }).defaultModel(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(await runtime(undefined).defaultModel(), 'deepseek/deepseek-v4.1-flash')
})

test('the default model can run: a provider without its key is passed over, and an alias comes last', async () => {
  const rt = (selection, missing, providers) => {
    const ctx = {
      llm: { listProviders: () => Object.keys(providers).map(id => ({ id })), listModels: async id => providers[id] },
      get: name => (name === 'agentDefaultModel' && selection ? { currentSelection: () => selection } : undefined),
    }
    const runtime = { ctx, state: { bots: {} }, missingKeys: async () => new Set(missing) }
    install(runtime)
    return runtime
  }
  const lineup = { deepseek: [{ id: 'deepseek-v4-pro' }], gateway: [{ id: 'default', name: 'Default (recommended)' }, { id: 'opus', name: 'Claude Opus 5.5' }] }
  // DSH's default needs a key nobody set: the first model that can run, not the alias.
  assert.equal(await rt({ provider: 'deepseek', model: 'deepseek-v4-pro' }, ['deepseek'], lineup).defaultModel(), 'gateway/opus')
  // DSH's default can run: it is the one, even an alias the user chose there.
  assert.equal(await rt({ provider: 'deepseek', model: 'deepseek-v4-pro' }, [], lineup).defaultModel(), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt({ provider: 'gateway', model: 'default' }, ['deepseek'], lineup).defaultModel(), 'gateway/default')
  // Only the alias can run: it is used.
  assert.equal(await rt(undefined, ['deepseek'], { deepseek: [{ id: 'v4' }], gateway: [{ id: 'default' }] }).defaultModel(), 'gateway/default')
  // Nothing can run: no default, so a Bot made now waits for one.
  const none = rt({ provider: 'deepseek', model: 'deepseek-v4-pro' }, ['deepseek'], { deepseek: [{ id: 'deepseek-v4-pro' }] })
  assert.equal(await none.defaultModel(), undefined)
  assert.equal(none.cachedDefault(), undefined)
  // A Bot whose model went away falls back to one that can run.
  assert.equal(await rt(undefined, ['deepseek'], lineup).desiredModel({ model: 'gone/model' }), 'gateway/opus')
})

// DSH serves the models of a provider whose key is not set; every turn on them fails.
function withoutKeys(defaultSelection, providers) {
  const rt = runtime(defaultSelection)
  rt.missingKeys = async () => new Set(providers)
  return rt
}

test('a model that needs a key is never a default or a fallback, though a Bot keeps its own', async () => {
  const rt = withoutKeys({ provider: 'deepseek', model: 'deepseek-v4-pro' }, ['deepseek'])
  assert.equal(await rt.defaultModel(), 'ollama/kimi-k3')
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
  assert.equal(rt.isUsable('ollama/kimi-k3'), true)
  assert.equal(rt.isUsable('deepseek/deepseek-v4-pro'), false)
  assert.equal(rt.isUsable(undefined), false)
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'ollama/kimi-k3')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'ollama/deepseek-v4-pro' }), 'ollama/deepseek-v4-pro')
})

test('with every model needing a key, nothing is picked', async () => {
  const rt = withoutKeys({ provider: 'ollama', model: 'kimi-k3' }, ['deepseek', 'ollama'])
  assert.equal(await rt.defaultModel(), undefined)
  assert.equal(rt.cachedDefault(), undefined)
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'ollama/kimi-k3' }), undefined)
})

test('a model is named by its ref, or by an id or name only one provider serves', async () => {
  const rt = runtime(undefined)
  assert.equal(await rt.resolveModel('ollama/kimi-k3'), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel(' Kimi-K3 '), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel('DeepSeek V4.1 Flash'), 'deepseek/deepseek-v4.1-flash')
  await assert.rejects(rt.resolveModel('deepseek-v4-pro'), /more than one provider.*deepseek\/deepseek-v4-pro, ollama\/deepseek-v4-pro/)
  await assert.rejects(rt.resolveModel('kimi'), /not available\. Available models: deepseek\/deepseek-v4\.1-flash/)
})

test('a Bot runs on its own model, else the one it last ran on, else the default', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', appliedModel: 'ollama/kimi-k3' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model' }), 'ollama/kimi-k3')
})

test('choosing a Bot model leaves the user\'s DSH default model as it was', async () => {
  const writes = []
  let current = { provider: 'ollama', model: 'kimi-k3' }
  const defaults = {
    currentSelection: () => ({ ...current }),
    saveSelection: async (next) => { writes.push(`${next.provider}/${next.model}`); current = { ...next } },
  }
  const ctx = {
    llm: { listProviders: () => [], listModels: async () => [] },
    get: name => (name === 'agentDefaultModel' ? defaults : undefined),
    // Like DSH: the selection is also saved as the default, in the background.
    sessionController: { selectModel: async ({ provider, model }) => { void defaults.saveSelection({ provider, model }) } },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  await Promise.all([
    rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' }),
    rt.selectSessionModel('s2', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    rt.selectSessionModel('s3', { provider: 'ollama', model: 'kimi-k3' }),
  ])
  assert.deepEqual(current, { provider: 'ollama', model: 'kimi-k3' })
  assert.deepEqual(writes, ['deepseek/deepseek-v4-pro', 'ollama/kimi-k3', 'deepseek/deepseek-v4.1-flash', 'ollama/kimi-k3', 'ollama/kimi-k3'])
})

test('a selection during DSH\'s plugin reload, where every profile write is refused, warns only when the default moved', async () => {
  // Inside the reload, DSH's own save of the selection is refused as the write-back is.
  const nested = () => Promise.reject(new Error('HMR transactions cannot be nested'))
  const setup = (save) => {
    const warnings = []
    let current = { provider: 'ollama', model: 'kimi-k3' }
    const defaults = { currentSelection: () => ({ ...current }), saveSelection: next => save(next, value => { current = value }) }
    const ctx = {
      llm: { listProviders: () => [], listModels: async () => [] },
      get: name => (name === 'agentDefaultModel' ? defaults : undefined),
      sessionController: { selectModel: async ({ provider, model }) => { void defaults.saveSelection({ provider, model }).catch(() => {}) } },
    }
    const rt = { ctx, state: { bots: {} }, warn: (...args) => warnings.push(args) }
    install(rt)
    return { rt, warnings, current: () => current }
  }

  const refused = setup(nested)
  await refused.rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.deepEqual(refused.current(), { provider: 'ollama', model: 'kimi-k3' })
  assert.deepEqual(refused.warnings, [])

  // DSH's save landed and only the write-back was refused: the user's default is lost.
  let first = true
  const moved = setup((next, set) => {
    if (!first) return nested()
    first = false
    set(next)
    return Promise.resolve()
  })
  await moved.rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.deepEqual(moved.current(), { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.equal(moved.warnings.length, 1)
  assert.match(moved.warnings[0][0], /default model was not restored/)
})

test('a Bot with no model yet changes nothing until the user picks one', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ appliedModel: 'deepseek/deepseek-v4-pro' }), undefined)
  assert.equal(await rt.desiredModel({}), undefined)
  await rt.catalog()
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
})

// A runtime with two providers, a DSH default, and a session controller that, like
// DSH, saves every Session selection as the default.
function bench({ providers = { deepseek: ['v4-flash'], stepfun: ['step-5'] }, fallback = { provider: 'stepfun', model: 'step-5' }, reasoning = {}, services = {} } = {}) {
  let current = { ...fallback }
  const selected = []
  const saved = []
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ ...current }), saveSelection: async (next) => { saved.push(next); current = { ...next } } }
      : services[name]),
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id.toUpperCase() })),
      listModels: async id => providers[id].map(model => ({ id: model, name: model, inputModalities: ['text'] })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
    },
    sessionController: {
      selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
        selected.push(`${sessionId}:${provider}/${model}${reasoningEffort === undefined ? '' : `:${reasoningEffort}`}`)
        current = { provider, model }
      },
    },
  }
  const rt = { ctx, state: { bots: {} }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
  install(rt)
  return { rt, selected, saved, providers, listeners, current: () => current }
}

test('the catalog is every model DSH serves, with no lab', async () => {
  const { rt } = bench()
  assert.deepEqual((await rt.catalog()).map(entry => [entry.ref, entry.providerName, 'lab' in entry]), [
    ['deepseek/v4-flash', 'DEEPSEEK', false],
    ['stepfun/step-5', 'STEPFUN', false],
  ])
})

test('a fresh catalog sees a model list changed in DSH settings at once', async () => {
  const { rt, providers } = bench()
  await rt.catalog()
  providers.deepseek = ['deepseek-flash', 'deepseek-v4-pro']
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  assert.deepEqual((await rt.catalog({ fresh: true })).filter(entry => entry.provider === 'deepseek').map(entry => entry.id), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('applying a Bot model leaves the DSH default as the user set it', async () => {
  const { rt, selected, current } = bench()
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  assert.equal(await rt.applyModel(bot), 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
  assert.deepEqual(current(), { provider: 'stepfun', model: 'step-5' })
  assert.equal(bot.appliedModel, 'deepseek/v4-flash')
})

// A chat carried over from an older Remote Hermes ref keeps its own Session route when the
// Bot moves to the attached serve's one row. Selecting attach on that Session would make
// DSH price a model switch on the attach row and fail MODEL_SWITCH_COMPACTION_FAILED before
// the turn; the attach transport serves the row whatever ref the request names, so leaving
// the route alone is what lets the carried-over turn dispatch.
test('a carried-over chat on a Hermes route keeps its route when the Bot moves to attach', async () => {
  for (const history of [1, 400]) {
    const { rt, selected } = bench({ providers: { 'hermes-remote': ['attach'] } })
    rt.ctx.llm.listModels = async provider => provider === 'hermes-remote'
      ? [{ id: 'attach', name: 'gpt-6-astra (openai-codex)', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 }]
      : []
    const routes = new Map([
      ['b1', { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }],
      ['g1', { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }],
      ['b2', { provider: 'acp-claude', model: 'opus' }],
    ])
    const messages = Array.from({ length: history }, (_, index) => ({ role: 'user', content: `message ${index}` }))
    rt.ctx.sessions = { get: id => ({ deriveMessages: () => messages, requestHeader: () => ({ config: routes.get(id) }) }) }
    rt.groupSessionsOf = id => (id === 'b1' ? ['g1'] : [])
    const bot = { id: 'b1', model: 'hermes-remote/attach', appliedModel: 'hermes-remote/attach' }
    assert.equal(await rt.applyModel(bot, { force: true }), 'hermes-remote/attach')
    assert.deepEqual(selected, [], `no in-place switch on the carried-over chat (${history} messages)`)
    assert.equal(bot.appliedModel, 'hermes-remote/attach')
    // A Session on another provider still takes the switch: only the attached route is kept.
    const other = { id: 'b2', model: 'hermes-remote/attach' }
    assert.equal(await rt.applyModel(other, { force: true }), 'hermes-remote/attach')
    assert.deepEqual(selected, ['b2:hermes-remote/attach'])
  }
})

test('a carried-over chat that is not loaded still keeps its Hermes route', async () => {
  const { rt, selected } = bench({ providers: { 'hermes-remote': ['attach'] } })
  rt.ctx.llm.listModels = async provider => provider === 'hermes-remote'
    ? [{ id: 'attach', name: 'gpt-6-astra (openai-codex)', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 }]
    : []
  rt.ctx.sessions = { get: () => undefined }
  // The stored Session's last request is what decides, not a pick's history.
  const persistence = {
    open: async id => id === 'b1'
      ? {
        read: async () => ({ events: [{ type: 'request/header', data: { header: { config: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } } } }] }),
        release: async () => {},
      }
      : { read: async () => ({ events: [{ type: 'model/selection', data: { provider: 'deepseek', model: 'v4-flash' } }] }) },
  }
  const get = rt.ctx.get
  rt.ctx.get = name => name === 'sessionPersistence' ? persistence : get(name)
  const carried = { id: 'b1', model: 'hermes-remote/attach', appliedModel: 'hermes-remote/attach', previousModel: 'hermes-remote/attach' }
  assert.equal(await rt.applyModel(carried, { force: true }), 'hermes-remote/attach')
  assert.deepEqual(selected, [], 'no in-place switch while the carried chat is not loaded')
  // A fresh chat with a known selection and no request history takes attach.
  const fresh = { id: 'b2', model: 'hermes-remote/attach' }
  assert.equal(await rt.applyModel(fresh, { force: true }), 'hermes-remote/attach')
  assert.deepEqual(selected, ['b2:hermes-remote/attach'])
})

// A connection by address and token is not the attached serve: a change between two of its
// Hermes models must still select the new model on the chat. Only the attach row keeps the
// carried route.
test('a change between two Hermes models on an address connection still moves the chat', async () => {
  const { rt, selected } = bench({ providers: { 'hermes-remote': ['sample:model-a', 'sample:model-b'] } })
  rt.ctx.sessions = { get: () => ({ requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model-a' } }) }) }
  const bot = { id: 'b1', model: 'hermes-remote/sample:model-b', appliedModel: 'hermes-remote/sample:model-a' }
  assert.equal(await rt.applyModel(bot, { force: true }), 'hermes-remote/sample:model-b')
  assert.deepEqual(selected, ['b1:hermes-remote/sample:model-b'])
})

// One conversation's model is its Bot's alone: a pick moves that Bot's own Sessions (its chat
// and its seats in groups) and nothing of another Bot, nor the default a new Bot starts on.
test('a model picked for one Bot never moves another Bot\'s model or level', async () => {
  const levels = { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }
  const { rt, selected, current } = bench({ reasoning: { 'deepseek/v4-flash': levels } })
  rt.groupSessionsOf = id => (id === 'b1' ? ['b1-in-room'] : [])
  const first = { id: 'b1', model: 'stepfun/step-5' }
  const second = { id: 'b2', model: 'stepfun/step-5' }
  Object.assign(rt.state.bots, { b1: first, b2: second })
  await rt.applyModel(first)
  await rt.applyModel(second)
  selected.length = 0
  Object.assign(first, { model: 'deepseek/v4-flash', effort: 'low' })
  await rt.applyModel(first)
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low', 'b1-in-room:deepseek/v4-flash:low'])
  assert.deepEqual(second, { id: 'b2', model: 'stepfun/step-5', appliedModel: 'stepfun/step-5' })
  assert.deepEqual(current(), { provider: 'stepfun', model: 'step-5' })
  // A later sync of the whole team re-selects nothing for the Bot that was not touched.
  selected.length = 0
  await rt.applyModel(second)
  assert.deepEqual(selected, [])
})

test('a Bot model applies its thinking level, and only re-selects on a change', async () => {
  const { rt, selected } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'low' }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low'])
  assert.equal(bot.appliedEffort, 'low')
  await rt.applyModel(bot)
  assert.equal(selected.length, 1)

  // A level the model does not serve is never sent: the model's default applies.
  bot.effort = 'max'
  await rt.applyModel(bot)
  assert.deepEqual(selected.at(-1), 'b1:deepseek/v4-flash')
  assert.equal(bot.appliedEffort, undefined)
})

test('a Bot whose own part is in a route switch is not selected on the old part', async () => {
  const { rt, selected } = bench()
  rt.switchingChat = id => id === 'b1'
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  assert.equal(await rt.applyModel(bot, { force: true }), undefined)
  assert.deepEqual(selected, [])
  assert.equal(await rt.desiredModel(bot), undefined)
  // The fresh part asks with its own Session id and still gets the target.
  assert.equal(await rt.desiredModel(bot, { sessionId: 'fresh' }), 'deepseek/v4-flash')
  await rt.syncModels()
  assert.deepEqual(selected, [])
})

test('a target level that only shares the name is carried as its own id', async () => {
  const efforts = [{ id: 'max', name: 'High' }]
  const { rt } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'high' }
  assert.equal(await rt.desiredEffort(bot, bot.model), 'max')
  await rt.applyModel(bot)
  assert.equal(bot.appliedEffort, 'max')
})

// The ACP agents' own `thought_level` options, as their live catalogs report them: Claude Code
// offers low, medium, high, xhigh and max, and Codex offers low, medium, high, xhigh, max and
// ultra (all per model; ultra has no pi-ai counterpart). The ids match pi-ai's, so the move
// keeps the level by id; off/minimal stay on the Bot and the target runs on its own.
test('an agent effort maps by its own id; a level it does not list stays on the Bot', async () => {
  const levels = ids => ({ reasoning: { efforts: ids.map(id => ({ id, name: id })) } })
  const { rt } = bench({
    providers: { 'acp-claude': ['opus'], 'acp-codex': ['default'] },
    reasoning: {
      'acp-claude/opus': levels(['low', 'medium', 'high', 'xhigh', 'max']),
      'acp-codex/default': levels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    },
  })
  const desired = (ref, effort) => rt.desiredEffort({ effort }, ref)
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(await desired('acp-claude/opus', effort), effort)
  }
  for (const effort of ['off', 'minimal']) {
    assert.equal(await desired('acp-claude/opus', effort), undefined)
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(await desired('acp-codex/default', effort), effort)
  }
  for (const effort of ['off', 'minimal']) {
    assert.equal(await desired('acp-codex/default', effort), undefined)
  }
})

test('group selections sync per Session even when the Bot-level fields already match', async () => {
  const { rt, selected } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'low', appliedModel: 'deepseek/v4-flash', appliedEffort: 'low' }
  const groups = ['g1', 'g2']
  rt.groupSessionsOf = () => groups
  const select = rt.ctx.sessionController.selectModel
  rt.ctx.sessionController.selectModel = async (request) => {
    await select(request)
    return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort ?? 'high' } }
  }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['g1:deepseek/v4-flash:low', 'g2:deepseek/v4-flash:low'])
  await rt.applyModel(bot)
  assert.equal(selected.length, 2)
  groups.push('g3')
  await rt.applyModel(bot)
  assert.deepEqual(selected.slice(2), ['g3:deepseek/v4-flash:low'])

  delete bot.effort
  await rt.applyModel(bot)
  assert.deepEqual(selected.slice(3), ['b1:deepseek/v4-flash', 'g1:deepseek/v4-flash', 'g2:deepseek/v4-flash', 'g3:deepseek/v4-flash'])
  // The provider's resolved default is not an explicit Bot choice to reapply.
  await rt.applyModel(bot)
  assert.equal(selected.length, 7)
  await rt.applyModel(bot, { force: true })
  assert.equal(selected.length, 11)
})

test('a failed group selection is retried without reselecting the own chat or successful groups', async () => {
  const { rt, selected } = bench()
  const bot = { id: 'b1', model: 'deepseek/v4-flash', appliedModel: 'deepseek/v4-flash' }
  rt.groupSessionsOf = () => ['g1', 'g2']
  const select = rt.ctx.sessionController.selectModel
  let failed = false
  rt.ctx.sessionController.selectModel = async (request) => {
    if (request.sessionId === 'g2' && !failed) {
      failed = true
      throw new Error('Session unavailable')
    }
    return select(request)
  }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['g1:deepseek/v4-flash'])
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['g1:deepseek/v4-flash', 'g2:deepseek/v4-flash'])
})

test('resolveEffort takes an id or a name, and refuses what the model has not', async () => {
  const { rt } = bench({ reasoning: {
    'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } },
    'stepfun/step-5': {},
  } })
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', 'high'), 'high')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ' Off '), 'off')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ''), undefined)
  await assert.rejects(rt.resolveEffort('stepfun/step-5', 'high'), /no thinking levels/)
  await assert.rejects(rt.resolveEffort('deepseek/v4-flash', 'max'), /not available for deepseek\/v4-flash\. Available: Off, High/)
})

test('the catalog attaches thinking levels to models a Bot uses', async () => {
  const { rt } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.state.bots.b1 = { id: 'b1', model: 'deepseek/v4-flash' }
  const entries = await rt.catalog()
  assert.deepEqual(entries.find(entry => entry.ref === 'deepseek/v4-flash')?.reasoning, { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' })
  assert.equal(entries.find(entry => entry.ref === 'stepfun/step-5')?.reasoning, undefined)
})

// #637: a hosted loop engine publishes a route that resolves models but refuses every
// generation with HOSTED_ENGINE_ROUTE; once it refuses, nothing chooses it again.
test('a route refused for not being a model endpoint is chosen nowhere again', async () => {
  const { rt, selected } = bench({ providers: { external: ['default'], deepseek: ['v4-flash'] }, fallback: { provider: 'external', model: 'default' } })
  const pinned = { id: 'b1', model: 'external/default', appliedModel: 'external/default' }
  const clean = { id: 'b2', model: 'deepseek/v4-flash' }
  rt.state.bots = { b1: pinned, b2: clean }
  await rt.routeRefused('external/default', pinned)
  // The pinned Bot moves to what it would be given today and re-selects its Session.
  assert.equal(pinned.model, 'deepseek/v4-flash')
  assert.equal(pinned.appliedModel, 'deepseek/v4-flash')
  assert.equal(clean.model, 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
  // Pickers, the deployment default and explicit naming keep it out too.
  assert.deepEqual((await rt.catalog({ fresh: true })).map(entry => entry.ref), ['deepseek/v4-flash'])
  assert.deepEqual(rt.cachedCatalog().map(entry => entry.ref), ['deepseek/v4-flash'])
  assert.equal(await rt.defaultModel(), 'deepseek/v4-flash')
  await assert.rejects(rt.resolveModel('external/default'), /Model external\/default is not available/)
})

test('a Bot on a clean record but a poisoned Session re-selects its own model', async () => {
  const { rt, selected } = bench({ providers: { external: ['default'], deepseek: ['v4-flash'] }, fallback: { provider: 'external', model: 'default' } })
  // Its group Session ran on another Bot's route; its own record never named it.
  const bot = { id: 'b1', model: 'deepseek/v4-flash', appliedModel: 'deepseek/v4-flash' }
  rt.state.bots = { b1: bot }
  await rt.routeRefused('external/default', bot)
  assert.equal(bot.model, 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
})

// Every Bot the route was pinned to may have its Session still on it, even one whose
// record already names the replacement; re-pinning the record alone leaves that
// Session failing on every turn.
test('every Bot re-pinned off a refused route re-selects its Session', async () => {
  const { rt, selected } = bench({ providers: { external: ['default'], deepseek: ['v4-flash'] }, fallback: { provider: 'external', model: 'default' } })
  const failed = { id: 'b1', model: 'external/default', appliedModel: 'external/default' }
  const alsoPinned = { id: 'b2', model: 'external/default', appliedModel: 'deepseek/v4-flash' }
  rt.state.bots = { b1: failed, b2: alsoPinned }
  await rt.routeRefused('external/default', failed)
  assert.equal(alsoPinned.model, 'deepseek/v4-flash')
  assert.equal(alsoPinned.appliedModel, 'deepseek/v4-flash')
  assert.deepEqual([...selected].sort(), ['b1:deepseek/v4-flash', 'b2:deepseek/v4-flash'])
})

// The sync key must see the filtered catalog: the catalog itself does not change
// on a refusal, so an unfiltered key would never run the sync again.
test('a refusal changes the sync key, so the next sync applies what the records say', async () => {
  const { rt, selected } = bench({ providers: { external: ['default'], deepseek: ['v4-flash'] } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', appliedModel: 'deepseek/v4-flash' }
  rt.state.bots = { b1: bot }
  await rt.catalog()
  await rt.syncModels()
  await rt.routeRefused('external/default')
  // The Session drifted meanwhile — its own picker can move it without telling us.
  delete bot.appliedModel
  await rt.syncModels()
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
})

// A refused route is chosen again only once its provider serves other models: the same
// placeholder registered again, even after it was unregistered, is still not an endpoint.
test('an adapter update ends a refusal only when its provider serves other models', async () => {
  const { rt, providers, listeners } = bench({ providers: { external: ['default'], deepseek: ['v4-flash'] }, fallback: { provider: 'external', model: 'default' } })
  const adaptersUpdated = () => listeners.get('llm/adapters-updated')()
  await rt.routeRefused('external/default')
  await adaptersUpdated()
  assert.equal(rt.defaultRef(), undefined)
  delete providers.external
  await adaptersUpdated()
  providers.external = ['default']
  await adaptersUpdated()
  assert.equal(rt.defaultRef(), undefined)
  providers.external = ['default', 'real']
  await adaptersUpdated()
  assert.equal(rt.defaultRef(), 'external/default')
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'external/default'))
})

test('a greeting waits for the provider of its Bot model to register', async () => {
  const { rt, providers, listeners } = bench({ providers: {} })
  const waiting = rt.waitForModel({ model: 'stepfun/step-5' }, 5000)
  setTimeout(() => {
    providers.stepfun = ['step-5']
    listeners.get('llm/adapters-updated')?.()
  }, 20)
  assert.equal(await waiting, 'stepfun/step-5')
  assert.equal(await rt.waitForModel({}, 5000), undefined)
})

test('a key set or a sign-in lifts what blocked a Bot; a key removed, a sign-out, a provider or a settings change only re-reads', async () => {
  const keys = new Set(['DEEPSEEK_API_KEY'])
  const records = new Set(['deepseek-account-platform/default'])
  const credentials = {
    describe: async ref => ({ configured: keys.has(ref), writable: true }),
    describeRecord: async key => ({ configured: records.has(key), writable: true }),
  }
  const { rt, listeners, providers } = bench({ services: { credentials } })
  const lifted = []
  // Each listing also passes the providers listed with their key (the next test).
  rt.unblockBots = fix => { if (fix.keyed === undefined) lifted.push(fix) }
  await rt.catalog()
  providers.deepseek = ['v4-pro']
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY')
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-pro'))
  await listeners.get('credentials/reference-updated')('STEPFUN_API_KEY')
  // Another plugin's record, such as an OAuth token refresh, is no sign-in.
  await listeners.get('credentials/record-updated')('llm-pi-ai/github-copilot')
  providers.deepseek = ['v4-flash']
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  // The provider refused the token and its record went.
  records.clear()
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  listeners.get('llm/adapters-updated')()
  listeners.get('settings/document-updated')()
  assert.deepEqual(lifted, [{ ref: 'DEEPSEEK_API_KEY' }, { signedIn: true }])
})

test('every listing passes the providers listed with their key, so a key that came without an event still lifts', async () => {
  const { rt, providers } = bench()
  providers.stepfun = ['step-5']
  rt.missingKeys = async () => new Set(['stepfun'])
  const passed = []
  rt.unblockBots = fix => passed.push([...fix.keyed].sort())
  await rt.catalog({ fresh: true })
  rt.missingKeys = async () => new Set()
  await rt.catalog({ fresh: true })
  assert.equal(passed.length, 2)
  assert.equal(passed[0].includes('stepfun'), false)
  assert.equal(passed[1].includes('stepfun'), true)
})

test('a credential DSH cannot describe counts as there, so its fix still lifts', async () => {
  const { rt, listeners } = bench({ services: { credentials: { describe: async () => { throw new Error('locked') } } } })
  const lifted = []
  rt.unblockBots = fix => { if (fix.keyed === undefined) lifted.push(fix) }
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY')
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  assert.deepEqual(lifted, [{ ref: 'DEEPSEEK_API_KEY' }, { signedIn: true }])
})

test('a Bot on the default model with its own thinking level leaves the default level as it was', async () => {
  const fallback = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }
  const { rt, current } = bench({ fallback, reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.ctx.sessionController.selectModel = async ({ provider, model, reasoningEffort }) => {
    const selected = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    await rt.ctx.get('agentDefaultModel').saveSelection(selected)
    return { selected }
  }
  await rt.applyModel({ id: 'b1', model: 'deepseek/v4-flash', effort: 'low' })
  assert.deepEqual(current(), fallback)
})

// Claude is an ordinary provider now (pi-ai's anthropic route): every model it serves is
// listed, none set aside as Claude Code's lineup was.
test('the catalog lists every Claude model pi-ai serves', async () => {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }],
      listModels: async () => ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6'].map(id => ({ provider: 'anthropic', id, name: id })),
    },
    get: () => undefined,
  }
  const rt = { ctx, state: { bots: { a: { model: 'anthropic/claude-sonnet-4-6' } } } }
  install(rt)
  const catalog = await rt.catalog({ fresh: true })
  assert.deepEqual(catalog.map(entry => entry.ref), ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-4-6'])
  // All stay served (the Bot on Sonnet 4.6 keeps it); the older ones are marked, so the menu
  // offers each family's newest.
  assert.deepEqual(catalog.filter(entry => entry.superseded).map(entry => entry.ref), ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-4-6'])
  assert.equal(await rt.desiredModel({ model: 'anthropic/claude-sonnet-4-6' }), 'anthropic/claude-sonnet-4-6')
})

test('a first model from Claude is the newest, not the first pi-ai lists', async () => {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }],
      listModels: async () => ['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-5-5'].map(id => ({ provider: 'anthropic', id, name: id })),
    },
    get: () => undefined,
  }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  assert.equal(await rt.defaultModel(), 'anthropic/claude-fable-5-1')
})

test('without DeepSeek, the default is the first account connected here, and it stays so', async () => {
  const providers = { anthropic: [{ id: 'claude-opus-5-5' }], kimi: [{ id: 'k3' }], openai: [{ id: 'gpt-5.5' }] }
  let missing = new Set(['deepseek', 'anthropic', 'kimi', 'openai'])
  const state = { bots: {} }
  let saves = 0
  const runtime = {
    ctx: {
      llm: { listProviders: () => [{ id: 'deepseek' }, ...Object.keys(providers).map(id => ({ id }))], listModels: async id => (id === 'deepseek' ? [{ id: 'deepseek-flash' }] : providers[id]) },
      get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) } : undefined),
      on: () => {},
    },
    state,
    save: async () => { saves += 1 },
    missingKeys: async () => missing,
  }
  install(runtime)
  const fresh = async () => { await runtime.catalog({ fresh: true }); return runtime.defaultModel() }
  // Nothing can run yet: no default.
  assert.equal(await fresh(), undefined)
  // The person connects OpenAI, then Kimi, then Claude: OpenAI, the first, is the default.
  missing = new Set(['deepseek', 'anthropic', 'kimi'])
  assert.equal(await fresh(), 'openai/gpt-5.5')
  missing = new Set(['deepseek', 'anthropic'])
  assert.equal(await fresh(), 'openai/gpt-5.5')
  missing = new Set(['deepseek'])
  assert.equal(await fresh(), 'openai/gpt-5.5')
  assert.deepEqual([...state.providersSeen], ['openai', 'kimi', 'anthropic'])
  assert.ok(saves >= 3)
  // DeepSeek signed in: DSH's default, DeepSeek, wins.
  missing = new Set()
  assert.equal(await fresh(), 'deepseek/deepseek-flash')
})

// Memory review and the other jobs beside the chats run on one model that answers on its own:
// never an agent over ACP, which answers only in its own chat (a fresh team's main Bot is on one).
test('the background model is the team\'s pick, else DSH\'s default, never an ACP agent', async () => {
  const providers = { 'acp-codex': [{ id: 'default' }], 'acp-claude': [{ id: 'default' }], deepseek: [{ id: 'deepseek-flash' }], anthropic: [{ id: 'claude-opus-5-5' }] }
  let selection = { provider: 'deepseek', model: 'deepseek-flash' }
  let missing = new Set()
  const state = { bots: { main: { id: 'main', model: 'acp-codex/default' } }, providersSeen: ['acp-codex', 'acp-claude', 'anthropic'], prefs: {} }
  const rt = {
    ctx: {
      llm: { listProviders: () => Object.keys(providers).map(id => ({ id })), listModels: async id => providers[id] },
      get: name => (name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined),
      on: () => {},
    },
    state,
    save: async () => {},
    missingKeys: async () => missing,
  }
  install(rt)
  const background = async () => { await rt.catalog({ fresh: true }); return rt.backgroundModel() }
  // DSH's default (DeepSeek) though the Bot team's own default is the ACP agent connected first.
  assert.equal(await rt.defaultModel(), 'deepseek/deepseek-flash')
  assert.equal(await background(), 'deepseek/deepseek-flash')
  // DeepSeek without its key: the first other account connected that answers on its own.
  missing = new Set(['deepseek'])
  assert.equal(await background(), 'anthropic/claude-opus-5-5')
  // DSH's default set to an agent: skipped.
  missing = new Set()
  selection = { provider: 'acp-claude', model: 'default' }
  assert.equal(await background(), 'anthropic/claude-opus-5-5')
  // The team's pick wins while it is served and can run; an ACP pick is never taken.
  state.prefs.backgroundModel = 'deepseek/deepseek-flash'
  assert.equal(await background(), 'deepseek/deepseek-flash')
  state.prefs.backgroundModel = 'acp-codex/default'
  assert.equal(await background(), 'anthropic/claude-opus-5-5')
  state.prefs.backgroundModel = 'deepseek/gone'
  assert.equal(await background(), 'anthropic/claude-opus-5-5')
  // Only agents: no background model at all.
  for (const id of ['deepseek', 'anthropic']) delete providers[id]
  assert.equal(await background(), undefined)
  assert.equal(rt.answersAside('acp-claude/default'), false)
  assert.equal(rt.answersAside('deepseek/deepseek-flash'), true)
  assert.equal(rt.answersAside(undefined), false)
})

// The model menu's connections (D-d): a brand and how it is connected, what cannot run marked,
// and DSH's own ChatGPT or Claude sign-in covered by its CLI. Nothing here is a real sign-in:
// the stored records, keys and the agents' status are fakes.
function connections({ routes, agents, records = {}, keyless = [], selection, via = {} } = {}) {
  const providers = {
    deepseek: [{ id: 'deepseek-flash' }],
    'openai-codex': [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna' }],
    anthropic: [{ id: 'claude-opus-5-5' }],
    openai: [{ id: 'gpt-5.6' }],
    'acp-codex': [{ id: 'default', name: 'Codex' }, { id: 'gpt-5.6-sol' }],
    'acp-claude': [{ id: 'default', name: 'Claude Code' }, { id: 'opus' }],
    ...routes,
  }
  const names = { 'acp-codex': 'Codex (ACP)', 'acp-claude': 'Claude Code (ACP)', deepseek: 'DeepSeek' }
  let statusReads = 0
  const inspected = []
  const acp = {
    status: async () => { statusReads += 1; return { agents } },
    inspect: async (id) => { inspected.push(id); return { id, signedIn: true } },
  }
  const auth = {
    'openai-codex': records['openai-codex'] === true ? { via: 'signin' } : { via: 'signin', needsSignIn: true },
    anthropic: { via: 'key' },
    openai: { via: 'key' },
    ...via,
  }
  const rt = {
    ctx: {
      llm: { listProviders: () => Object.keys(providers).map(id => ({ id, ...(names[id] ? { name: names[id] } : {}) })), listModels: async id => providers[id] },
      get: name => (name === 'acpAgents' ? acp : name === 'agentDefaultModel' && selection ? { currentSelection: () => selection } : undefined),
      on: () => {},
    },
    state: { bots: {} },
    save: async () => {},
    missingKeys: async () => new Set(keyless),
    routeAuth: async ids => new Map(ids.filter(id => auth[id]).map(id => [id, auth[id]])),
  }
  install(rt)
  return { rt, statusReads: () => statusReads, inspected }
}

const marks = entries => entries.map(entry => [entry.ref, entry.providerName, entry.via ?? null, entry.needsSignIn === true, entry.covered === true])

test('the catalog names each connection by its brand and how it is connected', async () => {
  const { rt } = connections({ agents: [{ id: 'acp-codex', signedIn: true }, { id: 'acp-claude', signedIn: false }], records: { 'openai-codex': true } })
  assert.deepEqual(marks(await rt.catalog({ fresh: true })), [
    ['deepseek/deepseek-flash', 'DeepSeek', null, false, false],
    ['openai-codex/gpt-5.6-sol', 'ChatGPT', 'signin', false, true],
    ['openai-codex/gpt-5.6-luna', 'ChatGPT', 'signin', false, true],
    ['anthropic/claude-opus-5-5', 'Anthropic', 'key', false, false],
    ['openai/gpt-5.6', 'OpenAI', 'key', false, false],
    ['acp-codex/default', 'Codex', 'cli', false, false],
    ['acp-codex/gpt-5.6-sol', 'Codex', 'cli', false, false],
    ['acp-claude/default', 'Claude Code', 'cli', true, false],
    ['acp-claude/opus', 'Claude Code', 'cli', true, false],
  ])
})

test('an agent\'s own default names the model it runs on, when its catalog says', async () => {
  const { rt } = connections({
    agents: [{ id: 'acp-codex', signedIn: true }, { id: 'acp-claude', signedIn: true }],
    routes: {
      'acp-codex': [{ id: 'default', name: 'Codex', description: 'Its own setting: 6.1 Sol' }, { id: 'gpt-6.1-sol', name: '6.1 Sol' }],
      // A stand-in list (no probe yet) says nothing about the default; another route's
      // `default` is no agent's own setting.
      'acp-claude': [{ id: 'default', name: 'Claude Code', description: 'Its own setting' }],
      deepseek: [{ id: 'default', name: 'Default', description: 'Its own setting: DeepSeek Flash' }],
    },
  })
  const entries = await rt.catalog({ fresh: true })
  const of = ref => entries.find(entry => entry.ref === ref)
  assert.equal(of('acp-codex/default').resolvesTo, '6.1 Sol')
  assert.equal(of('acp-codex/gpt-6.1-sol').resolvesTo, undefined)
  assert.equal(of('acp-claude/default').resolvesTo, undefined)
  assert.equal(of('deepseek/default').resolvesTo, undefined)
})

test('DSH\'s ChatGPT sign-in is covered by Codex, signed in or not, and a missing one still needs a sign-in', async () => {
  const { rt } = connections({ agents: [{ id: 'acp-codex', signedIn: false }, { id: 'acp-claude', signedIn: true }] })
  const entries = await rt.catalog({ fresh: true })
  const of = ref => entries.find(entry => entry.ref === ref)
  assert.equal(of('openai-codex/gpt-5.6-sol').needsSignIn, true)
  assert.equal(of('openai-codex/gpt-5.6-sol').covered, true)
  assert.equal(of('anthropic/claude-opus-5-5').covered, undefined, 'a key-based Claude is a connection of its own')
  assert.equal(of('acp-codex/gpt-5.6-sol').needsSignIn, true)
  assert.equal(of('acp-claude/opus').needsSignIn, undefined)
})

test('the agents\' sign-in is read on a fresh catalog only, and an unknown one is checked once in the background', async () => {
  const { rt, statusReads, inspected } = connections({ agents: [{ id: 'acp-codex', on: true, connector: { state: 'ready' } }, { id: 'acp-claude', signedIn: false }] })
  await rt.catalog()
  assert.equal(statusReads(), 0)
  const first = await rt.catalog({ fresh: true })
  assert.equal(statusReads(), 1)
  // Unknown: shown, never marked, until the check answers.
  assert.equal(first.find(entry => entry.ref === 'acp-codex/default').needsSignIn, undefined)
  assert.equal(first.find(entry => entry.ref === 'acp-claude/default').needsSignIn, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  await rt.catalog({ fresh: true })
  await rt.catalog({ fresh: true })
  assert.deepEqual(inspected, ['acp-codex'])
})

test('a status that never answers keeps the catalog moving', async () => {
  const { rt } = connections({ agents: [] })
  rt.ctx.get = name => (name === 'acpAgents' ? { status: () => new Promise(() => {}) } : undefined)
  const started = Date.now()
  const entries = await rt.catalog({ fresh: true })
  assert.ok(Date.now() - started < 3000)
  assert.equal(entries.find(entry => entry.ref === 'acp-codex/default').needsSignIn, undefined)
})

test('a new Bot\'s model skips a sign-in route its CLI covers and takes the CLI\'s copy; the background model keeps its own rule', async () => {
  // DSH's default is a ChatGPT sign-in that is not stored: passed over for a Bot.
  const { rt } = connections({
    routes: { deepseek: [] },
    agents: [{ id: 'acp-codex', signedIn: false }, { id: 'acp-claude', signedIn: false }],
    selection: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  })
  await rt.catalog({ fresh: true })
  assert.equal(await rt.defaultModel(), 'anthropic/claude-opus-5-5')
  // The jobs beside the chats still read only the key (D-g: unchanged).
  assert.equal(await rt.backgroundModel(), 'openai-codex/gpt-5.6-sol')
  // DSH's default is a stored ChatGPT sign-in and Codex is signed in: the same model, on Codex.
  const covered = connections({
    routes: { deepseek: [], anthropic: [], openai: [] },
    agents: [{ id: 'acp-codex', signedIn: true }, { id: 'acp-claude', signedIn: false }],
    records: { 'openai-codex': true },
    selection: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  })
  await covered.rt.catalog({ fresh: true })
  assert.equal(await covered.rt.defaultModel(), 'acp-codex/gpt-5.6-sol')
  assert.equal(await covered.rt.backgroundModel(), 'openai-codex/gpt-5.6-sol', 'the jobs beside the chats keep the sign-in (D-g)')
  // An id Codex does not list: Codex's own default.
  const other = connections({
    routes: { deepseek: [], anthropic: [], openai: [] },
    agents: [{ id: 'acp-codex', signedIn: true }, { id: 'acp-claude', signedIn: false }],
    records: { 'openai-codex': true },
    selection: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
  })
  await other.rt.catalog({ fresh: true })
  assert.equal(await other.rt.defaultModel(), 'acp-codex/default')
})

// Claude Code names its models by alias (its cached catalog: default, opus,
// claude-fable-5-1[1m], sonnet, haiku), never pi-ai's versioned ids.
test('DSH\'s Claude Pro/Max sign-in is covered by Claude Code, and its model maps to the same family', async () => {
  const claude = selection => connections({
    routes: {
      deepseek: [], openai: [], 'openai-codex': [],
      anthropic: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'claude-fable-5' }, { id: 'claude-unknown-1' }],
      'acp-claude': [{ id: 'default', name: 'Default (recommended)' }, { id: 'opus' }, { id: 'claude-fable-5-1[1m]' }, { id: 'sonnet' }, { id: 'haiku' }],
    },
    agents: [{ id: 'acp-codex', signedIn: false }, { id: 'acp-claude', signedIn: true }],
    via: { anthropic: { via: 'signin' } },
    selection,
  })
  const { rt } = claude({ provider: 'anthropic', model: 'claude-opus-5-5' })
  const entries = await rt.catalog({ fresh: true })
  assert.deepEqual(entries.filter(entry => entry.provider === 'anthropic').map(entry => entry.covered), [true, true, true, true, true])
  assert.deepEqual(entries.filter(configured).map(entry => entry.ref), ['acp-claude/default', 'acp-claude/opus', 'acp-claude/claude-fable-5-1[1m]', 'acp-claude/sonnet', 'acp-claude/haiku'])
  assert.equal(await rt.defaultModel(), 'acp-claude/opus')
  for (const [model, ref] of [['claude-sonnet-5-5', 'acp-claude/sonnet'], ['claude-haiku-5-5', 'acp-claude/haiku'], ['claude-fable-5', 'acp-claude/claude-fable-5-1[1m]'], ['claude-unknown-1', 'acp-claude/default']]) {
    const other = claude({ provider: 'anthropic', model })
    await other.rt.catalog({ fresh: true })
    assert.equal(await other.rt.defaultModel(), ref, model)
  }
})

// D-a, D-c: whoever picks the model (a tool, the API, Pocket), a Bot never goes back onto DSH's
// own ChatGPT or Claude sign-in; only the model it is already on stays.
test('a pick of a sign-in route a CLI covers lands on that CLI, or is refused with the CLI off', async () => {
  const { rt } = connections({ agents: [{ id: 'acp-codex', signedIn: true }, { id: 'acp-claude', signedIn: true }], records: { 'openai-codex': true } })
  assert.equal(await rt.resolveModel('openai-codex/gpt-5.6-sol', { checkAccess: true }), 'acp-codex/gpt-5.6-sol')
  assert.equal(await rt.resolveModel('openai-codex/gpt-5.6-luna'), 'acp-codex/default')
  assert.equal(await rt.resolveModel('openai-codex/gpt-5.6-sol', { keep: 'openai-codex/gpt-5.6-sol' }), 'openai-codex/gpt-5.6-sol', 'the Bot\'s own model is kept')
  assert.equal(await rt.resolveModel('anthropic/claude-opus-5-5'), 'anthropic/claude-opus-5-5', 'a key-based Claude is never moved')
  const off = connections({ routes: { 'acp-codex': [] }, agents: [], records: { 'openai-codex': true } })
  await assert.rejects(off.rt.resolveModel('openai-codex/gpt-5.6-sol'), /ChatGPT plan runs Bots only through Codex/)
})

function invalidationRuntime() {
  const listeners = new Map()
  let signedIn = false
  let reads = 0
  const rt = {
    state: { bots: {} },
    ctx: {
      on: (name, fn) => listeners.set(name, fn),
      get: name => name === 'acpAgents' ? { status: async () => {
        reads++
        return { agents: [{ id: 'acp-codex', signedIn }] }
      } } : undefined,
      llm: {
        listProviders: () => [{ id: 'acp-codex' }],
        listModels: async () => [{ id: 'default', name: 'Codex' }],
      },
    },
  }
  install(rt)
  return { rt, listeners, reads: () => reads, signIn: () => { signedIn = true } }
}

test('an adapter event makes an ordinary catalog read sign-in status again', async () => {
  const h = invalidationRuntime()
  assert.equal((await h.rt.catalog({ fresh: true }))[0].needsSignIn, true)
  h.signIn()
  h.listeners.get('llm/adapters-updated')()
  assert.equal((await h.rt.catalog())[0].needsSignIn, undefined)
  assert.equal(h.reads(), 2)
  await h.rt.catalog()
  assert.equal(h.reads(), 2)
})

test('a catalog build crossing an invalidation cannot overwrite the new cache', async () => {
  const h = invalidationRuntime()
  let release
  let started
  const waiting = new Promise(resolve => { started = resolve })
  h.rt.ctx.llm.listModels = () => {
    started()
    return new Promise(resolve => { release = resolve })
  }
  const stale = h.rt.catalog({ fresh: true })
  await waiting
  h.listeners.get('llm/adapters-updated')()
  h.signIn()
  h.rt.ctx.llm.listModels = async () => [{ id: 'default', name: 'New name' }]
  const current = await h.rt.catalog()
  release([{ id: 'default', name: 'Old name' }])
  await stale
  assert.deepEqual(await h.rt.catalog(), current)
  assert.equal(h.rt.cachedCatalog()[0].name, 'New name')
})

test('a build crossing invalidation keeps the previous list until the next build', async () => {
  const h = invalidationRuntime()
  h.signIn()
  const previous = await h.rt.catalog({ fresh: true })
  assert.ok(previous.length > 0)
  const defaultModel = h.rt.cachedDefault()
  assert.equal(defaultModel, 'acp-codex/default')
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  h.rt.ctx.llm.listModels = () => {
    started()
    return new Promise(resolve => { release = resolve })
  }
  const stale = h.rt.catalog({ fresh: true })
  await waiting
  h.listeners.get('llm/adapters-updated')()
  assert.deepEqual(h.rt.cachedCatalog(), previous)
  assert.equal(h.rt.cachedDefault(), defaultModel)
  release([{ id: 'default', name: 'Stale name' }])
  await stale
  assert.deepEqual(h.rt.cachedCatalog(), previous)
  assert.equal(h.rt.cachedDefault(), defaultModel)
  h.rt.ctx.llm.listModels = async () => [{ id: 'default', name: 'New name' }]
  const current = await h.rt.catalog()
  assert.equal(current[0].name, 'New name')
  assert.deepEqual(h.rt.cachedCatalog(), current)
})

test('a status read crossing an adapter event cannot restore the old sign-in mark', async () => {
  const h = invalidationRuntime()
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const get = h.rt.ctx.get
  h.rt.ctx.get = name => name === 'acpAgents' ? { status: () => {
    started()
    return new Promise(resolve => { release = resolve })
  } } : get(name)
  const stale = h.rt.catalog({ fresh: true })
  await waiting
  h.listeners.get('llm/adapters-updated')()
  h.signIn()
  h.rt.ctx.get = get
  await h.rt.catalog()
  release({ agents: [{ id: 'acp-codex', signedIn: false }] })
  await stale
  assert.equal((await h.rt.catalog({ fresh: true }))[0].needsSignIn, undefined)
})

test('an adapter event during the first status read leaves the next catalog dirty', async () => {
  const h = invalidationRuntime()
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const get = h.rt.ctx.get
  h.rt.ctx.get = name => name === 'acpAgents' ? { status: () => {
    started()
    return new Promise(resolve => { release = resolve })
  } } : get(name)
  const stale = h.rt.catalog({ fresh: true })
  await waiting
  h.listeners.get('llm/adapters-updated')()
  release({ agents: [{ id: 'acp-codex', signedIn: true }] })
  await stale
  h.rt.ctx.get = get
  assert.equal((await h.rt.catalog())[0].needsSignIn, true)
  assert.equal(h.reads(), 1)
})


test('validating a model pick leaves blocked Bots alone; a remembered catalog still lifts them', async () => {
  const { rt } = bench()
  const lifted = []
  rt.unblockBots = fix => lifted.push([...fix.keyed])
  assert.equal(await rt.resolveModel('deepseek/v4-flash', { remember: false }), 'deepseek/v4-flash')
  assert.deepEqual(lifted, [])
  await rt.catalog({ fresh: true })
  assert.equal(lifted.length, 1)
  assert.ok(lifted[0].includes('deepseek'))
})

test('a passive catalog miss leaves enumeration, saves and unblocking to the desktop', async t => {
  const rt = runtime(undefined)
  const list = t.mock.method(rt.ctx.llm, 'listModels')
  rt.save = t.mock.fn(async () => {})
  rt.unblockBots = t.mock.fn()
  assert.deepEqual(await rt.quietCatalog(() => rt.catalog({ fresh: true })), [])
  assert.deepEqual(rt.cachedCatalog(), [])
  assert.equal(list.mock.callCount(), 0)
  assert.equal(rt.save.mock.callCount(), 0)
  assert.equal(rt.unblockBots.mock.callCount(), 0)
  assert.ok((await rt.catalog()).length > 0)
  assert.equal(list.mock.callCount(), Object.keys(PROVIDERS).length)
  assert.equal(rt.save.mock.callCount(), 1)
  assert.equal(rt.unblockBots.mock.callCount(), 1)
})

// G6-18 (#2048): with only Antigravity's models running and DSH's default needing a key nobody
// set, the first model that can run is Antigravity's named one, never its `default` alias, as
// a Claude-only or Codex-only setup gives theirs (parity).
test('with only Antigravity on, the default model is its first named model', async () => {
  const providers = { deepseek: [{ id: 'deepseek-v4-pro' }], 'acp-antigravity': [{ id: 'default', name: 'Default' }, { id: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }
  const acp = { status: async () => ({ agents: [{ id: 'acp-antigravity', signedIn: true, on: true, cli: { found: true }, connector: { state: 'ready' } }] }) }
  const ctx = {
    llm: { listProviders: () => Object.keys(providers).map(id => ({ id })), listModels: async id => providers[id] },
    get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) } : name === 'acpAgents' ? acp : undefined),
  }
  const rt = { ctx, state: { bots: {} }, missingKeys: async () => new Set(['deepseek']) }
  install(rt)
  assert.equal(await rt.defaultModel(), 'acp-antigravity/gemini-3-pro')
})

// T12 (#2061, MW-3): a group conversation whose history ran on another harness keeps its route
// when the Bot's model moves: no in-place selection, and the fallback's way back refuses it too.
test('a group Session with history on another harness is not moved across in place', async () => {
  const { rt, selected } = bench()
  const bot = { id: 'b1', name: 'Ops', model: 'deepseek/v4-flash' }
  rt.state.bots.b1 = bot
  rt.groupSessionsOf = () => ['g-history', 'g-empty']
  rt.crossingHistory = async (sessionId, ref) => sessionId === 'g-history' && ref === 'deepseek/v4-flash'
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(selected, ['b1:deepseek/v4-flash', 'g-empty:deepseek/v4-flash'])
  Object.assign(rt, {
    load: async () => {}, isBotSession: () => true, selfOf: () => 'b1', botOf: () => bot,
    groupOwners: new Map([['g-history', { botId: 'b1', roomId: 'r1' }], ['g-empty', { botId: 'b1', roomId: 'r1' }]]),
  })
  const picks = []
  const agent = id => ({ session: { id, requestHeader: () => undefined }, model: { select: route => picks.push([id, route]) } })
  assert.equal(await rt.reselectOwnRoute(agent('g-history'), () => true), false)
  assert.equal(await rt.reselectOwnRoute(agent('g-empty'), () => true), true)
  assert.deepEqual(picks.map(([id]) => id), ['g-empty'])
})

test('Claude Code pin proofs populate Solver rows and a saved pin survives a catalog outage', async () => {
  const pins = [['opus', 'Opus 5.5', 'claude-opus-5-5'], ['fable', 'Fable 5.2', 'claude-fable-5-2'], ['haiku', 'Haiku 5.5', 'claude-haiku-5-5']]
  const identities = new Map(pins.map(([alias, , id]) => [alias, id]))
  const acpAgents = {
    modelIdentityOf(_provider, model) { return { status: 'offered', model: identities.get(model) } },
  }
  const rt = runtime(undefined)
  rt.ctx.get = key => key === 'acpAgents' ? acpAgents : undefined
  const previous = rt.ctx.llm.listModels
  let online = true
  rt.ctx.llm.listProviders = () => [{ id: 'acp-claude' }, { id: 'deepseek' }]
  rt.ctx.llm.listModels = async provider => provider !== 'acp-claude' ? previous(provider)
    : online ? pins.map(([id, name]) => ({ id, name })) : []
  const rows = await rt.catalog({ fresh: true })
  for (const [alias, , id] of pins) {
    const row = rows.find(row => row.ref === `acp-claude/${alias}`)
    assert.equal(row?.solverIdentity, `acp-claude/${id}`)
    assert.equal(row?.solverRef, `acp-claude/${id}`)
  }
  online = false
  await rt.catalog({ fresh: true })
  assert.equal(await rt.desiredModel({ model: 'acp-claude/claude-opus-5-5' }), 'acp-claude/claude-opus-5-5')
})

test('Solver chosen identity matches the four ACP pins and keeps provider, full ID and default', () => {
  assert.equal(CLAUDE_PINS.length, 4)
  for (const { alias, id } of CLAUDE_PINS) {
    assert.equal(chosenIdentity(' ACP-CLAUDE ', alias.toUpperCase() + '[1m] '), `acp-claude/${id}`)
    assert.equal(chosenIdentity('acp-hermes', alias), `acp-hermes/${alias}`)
  }
  assert.equal(chosenIdentityOf(' ACP-HERMES / VENDOR/Model[1m] '), 'acp-hermes/vendor/model')
  assert.equal(chosenIdentityOf('acp-claude/default'), 'acp-claude/default')
  assert.equal(chosenIdentityOf('anthropic/v-20261001'), 'anthropic/v-20261001')
  assert.equal(chosenIdentityOf('model'), undefined)
})

test('Solver host accepts distinct choices without ACP proofs and refuses only equal choices', async () => {
  const rt = runtime(undefined)
  const reviewer = { id: 'reviewer', model: 'acp-claude/sonnet' }
  rt.botOf = id => id === reviewer.id ? reviewer : undefined
  rt.ctx.get = () => ({ resolveModelIdentity: () => assert.fail('creation must use the chosen identity') })
  for (const ref of ['acp-claude/opus', 'acp-antigravity/default', 'acp-omp/default',
    'acp-hermes/route/vendor/model', 'anthropic/claude-sonnet-5-5']) await rt.checkSolverModel(ref, reviewer)
  for (const ref of ['acp-claude/sonnet', 'acp-claude/claude-sonnet-5-5', 'acp-claude/sonnet[1m]']) {
    await assert.rejects(rt.checkSolverModel(ref, reviewer), /Choose a different model/)
  }
  await assert.rejects(rt.checkSolverModel('acp-claude/opus', { ...reviewer }), /Choose a specific model/)
  assert.equal(rt.upgradeReviewerModels, undefined)
})

test('T1 background quota holds skip a provider, expire, and lift on a saved key', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const listeners = new Map()
  const rt = runtime({ provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    (name, listener) => listeners.set(name, listener))
  rt.state.prefs = { backgroundModel: 'deepseek/deepseek-v4.1-flash' }
  assert.equal(await rt.backgroundModel(), 'deepseek/deepseek-v4.1-flash')
  rt.noteAsideQuota('deepseek')
  assert.equal(rt.cachedBackground(), 'ollama/kimi-k3')
  rt.noteAsideQuota('ollama')
  assert.equal(rt.cachedBackground(), undefined)
  t.mock.timers.tick(60 * 60_000)
  assert.equal(rt.cachedBackground(), 'deepseek/deepseek-v4.1-flash')
  rt.noteAsideQuota('deepseek')
  assert.equal(rt.cachedBackground(), 'ollama/kimi-k3')
  await listeners.get('credentials/reference-updated')('fixture-ref')
  assert.equal(rt.cachedBackground(), 'deepseek/deepseek-v4.1-flash')
})
