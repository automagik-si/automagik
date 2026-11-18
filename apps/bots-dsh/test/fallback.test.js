import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { fallbackFor, fallbackNotice, install, KEEP_CODES } from '../src/host/fallback.js'

const OPENAI = { provider: 'openai', model: 'gpt-5.4-mini', reasoningEffort: 'high' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('a failed model moves to the fallback, except what another model cannot answer better', () => {
  assert.deepEqual(fallbackFor({ failure: { code: 'INVALID_REQUEST' }, failed: OPENAI, fallback: DEEPSEEK }), DEEPSEEK)
  for (const code of ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROVIDER_ERROR', 'PI_AI_ERROR', 'MISSING_CREDENTIAL']) {
    assert.deepEqual(fallbackFor({ failure: { code }, failed: OPENAI, fallback: DEEPSEEK }), DEEPSEEK, code)
  }
  for (const code of KEEP_CODES) assert.equal(fallbackFor({ failure: { code }, failed: OPENAI, fallback: DEEPSEEK }), undefined, code)
  // Already on the fallback: a fallback that fails too ends the turn, it does not loop.
  assert.equal(fallbackFor({ failure: { code: 'SERVER' }, failed: DEEPSEEK, fallback: DEEPSEEK }), undefined)
  assert.equal(fallbackFor({ failure: { code: 'SERVER' }, failed: OPENAI, fallback: undefined }), undefined)
  assert.equal(fallbackFor({ failure: { code: 'SERVER' }, failed: undefined, fallback: DEEPSEEK }), undefined)
})

test('the notice names the model that failed, why, and the one the next turn continues with', () => {
  const notice = fallbackNotice(OPENAI, DEEPSEEK, { code: 'INVALID_REQUEST', message: 'OpenAI API error (400): Missing namespace\nmore' })
  assert.match(notice.content[0].text, /^\[model fallback: openai\/gpt-5\.4-mini failed \(INVALID_REQUEST: OpenAI API error \(400\): Missing namespace\); the next turn continues with deepseek-official\/deepseek-flash\]$/)
  assert.equal(notice.source.kind, 'model-selection')
  assert.equal(notice.source.form, 'notice')
})

// The hooks as DSH runs them: a waterfall where each listener gets `next`, and the Agent's
// model choice (agent.model.select/current) plus its followup wake, dsh 0.2.2's contract.
function harness({ isBot = true, config = {}, defaultModel = 'deepseek-official/deepseek-flash' } = {}) {
  const hooks = new Map()
  const warnings = []
  const ctx = { on: (name, listener, options) => hooks.set(name, { listener, options }) }
  install({ ctx, config, isBotSession: () => isBot, defaultModel: async () => defaultModel, botOf: () => ({ name: 'Ops' }), warn: (...args) => warnings.push(args) })
  const selected = []
  const followed = []
  const agent = {
    id: 'bot-1',
    model: {
      current: () => selected.at(-1) ?? { ...OPENAI },
      select: (selection) => selected.push(selection),
    },
    followup: (message) => followed.push(message),
    session: { id: 'bot-1', requestHeader: () => ({ config: OPENAI }), append: () => {} },
  }
  const failed = (failure, turn = 3, inner = undefined) => hooks.get('agent/request-error').listener({ agent, turn, step: 1, failure, signal: { aborted: false } }, async () => inner)
  const turnEnd = turn => hooks.get('session/event').listener(agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'error' } } })
  return { hooks, failed, turnEnd, selected, followed, warnings, agent }
}

test('a failed turn records the fallback, wakes the next turn on it, and the turn after is back on the Bot\'s model', async () => {
  const h = harness()
  assert.equal(h.hooks.has('agent/request'), false, 'it no longer rewrites agent/request, which dsh 0.2.2 rejects')
  assert.equal(await h.failed({ code: 'INVALID_REQUEST', message: 'Missing namespace' }), undefined, 'the failed step is not retried on the same route')
  assert.deepEqual(h.selected, [DEEPSEEK], 'the fallback is recorded on the Agent, without the failed effort or output limit')
  assert.equal(h.followed.length, 1, 'one turn is woken to continue the conversation')
  assert.match(h.followed[0].content[0].text, /model fallback: openai\/gpt-5\.4-mini failed/)
  // The failed turn's own end does not restore; the fallback turn's does.
  h.turnEnd(3)
  assert.deepEqual(h.selected, [DEEPSEEK])
  h.turnEnd(4)
  const own = { provider: 'openai', model: 'gpt-5.4-mini', reasoningEffort: 'high' }
  assert.deepEqual(h.selected, [DEEPSEEK, own], "the Bot's own route comes back whole, its explicit effort included")
  h.turnEnd(5)
  assert.equal(h.selected.length, 2, 'once')
})

test('what answers a failure first keeps its answer, and other Sessions, kept codes and config off stay failed', async () => {
  assert.deepEqual(await harness().failed({ code: 'RATE_LIMIT' }, 3, { kind: 'retry', reason: 'same model' }), { kind: 'retry', reason: 'same model' })
  const other = harness({ isBot: false })
  assert.equal(await other.failed({ code: 'SERVER' }), undefined)
  assert.equal(other.followed.length, 0)
  assert.equal(await harness().failed({ code: 'CONTEXT_WINDOW_EXCEEDED' }), undefined)
  assert.equal(await harness({ defaultModel: 'openai/gpt-5.4-mini' }).failed({ code: 'SERVER' }), undefined, 'the default is the model that failed')
  const configured = harness({ config: { fallbackModel: 'xai/grok-4.7' } })
  assert.equal(await configured.failed({ code: 'SERVER' }), undefined)
  assert.deepEqual(configured.selected, [{ provider: 'xai', model: 'grok-4.7' }], 'config.fallbackModel is the route')
  const off = harness({ config: { fallback: false } })
  assert.equal(off.hooks.size, 0)
})

// An agent whose CLI is signed out (acp-dsh's MODEL_ACCESS_REQUIRED) is answered by a sign-in,
// never by another model (plan D5). Any other agent failure (ACP_AGENT) falls back like any
// model's, and only with its notice in the chat.
test('a signed-out agent never moves to the fallback; any other agent failure moves with a notice', async () => {
  assert.ok(KEEP_CODES.has('MODEL_ACCESS_REQUIRED'))
  const signedOut = harness()
  assert.equal(await signedOut.failed({ code: 'MODEL_ACCESS_REQUIRED', message: 'Codex is not signed in' }), undefined)
  assert.deepEqual(signedOut.selected, [])
  assert.deepEqual(signedOut.followed, [])
  assert.deepEqual(signedOut.warnings, [])
  const agentError = harness()
  assert.equal(await agentError.failed({ code: 'ACP_AGENT', message: 'Codex: the agent exited' }), undefined)
  assert.deepEqual(agentError.selected, [DEEPSEEK])
  assert.equal(agentError.followed.length, 1, 'the move is said in the chat')
  assert.equal(agentError.followed[0].source.form, 'notice')
  assert.match(agentError.followed[0].content[0].text, /failed \(ACP_AGENT: Codex: the agent exited\)/)
})

// F1: DSH latches no wake for a followup sent while the failed turn still runs, so the notice
// would only wait in the inbox. It is sent once the Agent is idle, and opens the fallback turn.
function idleHarness() {
  const h = harness()
  let idle
  h.agent.whenIdle = () => new Promise(resolve => { idle = resolve })
  const event = (type, turn) => h.hooks.get('session/event').listener(h.agent.session, { type, data: { turn, ...(type === 'turn/end' ? { reason: { kind: 'stop' } } : {}) } })
  return { ...h, idle: () => idle(), event }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('the fallback notice is sent once the failed turn has ended, so it opens the fallback turn', async () => {
  const h = idleHarness()
  await h.failed({ code: 'PI_AI_ERROR', message: 'Provider is not configured: openai-codex' })
  await settle()
  assert.deepEqual(h.followed, [], 'not while the failed turn still runs: DSH would leave it queued')
  assert.deepEqual(h.selected, [DEEPSEEK], 'the fallback route is recorded at once')
  h.turnEnd(3)
  h.idle()
  await settle()
  assert.equal(h.followed.length, 1, 'idle: the notice wakes the fallback turn')
  assert.match(h.followed[0].content[0].text, /model fallback: openai\/gpt-5\.4-mini failed \(PI_AI_ERROR/)
})

test('a turn that starts before the Agent is idle takes the notice\'s place', async () => {
  const h = idleHarness()
  await h.failed({ code: 'SERVER' })
  h.turnEnd(3)
  h.event('turn/start', 4)
  h.idle()
  await settle()
  assert.deepEqual(h.followed, [], 'the person\'s turn already ran on the fallback')
})

test('rt.fallbackArmed holds until the fallback turn ends, and a selection made meanwhile is left alone', async () => {
  const hooks = new Map()
  const rt = { ctx: { on: (name, listener) => hooks.set(name, listener) }, config: {}, isBotSession: () => true, defaultModel: async () => 'deepseek-official/deepseek-flash', warn: () => {} }
  install(rt)
  let current = { ...OPENAI }
  const selected = []
  const agent = { id: 'bot-1', model: { current: () => current, select: (route) => { selected.push(route); current = route } }, followup: () => {}, session: { id: 'bot-1', requestHeader: () => ({ config: OPENAI }) } }
  await hooks.get('agent/request-error')({ agent, turn: 3, failure: { code: 'SERVER' }, signal: { aborted: false } }, async () => undefined)
  assert.equal(rt.fallbackArmed('bot-1'), true)
  assert.equal(rt.fallbackArmed('other'), false)
  hooks.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 3 } })
  assert.equal(rt.fallbackArmed('bot-1'), true, 'the failed turn\'s own end keeps it')
  // The Bot went back to the model before a switch meanwhile (model-state.js): kept.
  current = { provider: 'deepseek-official', model: 'deepseek-v4' }
  hooks.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 4 } })
  assert.equal(rt.fallbackArmed('bot-1'), false)
  assert.deepEqual(selected, [DEEPSEEK], 'only the fallback route is undone')
})

// A switch that cannot run goes back (model-state.js, parts.js) and nothing runs again on its
// own: no fallback route, no notice. A Bot whose model is confirmed still falls back.
test('a switch failure on a pending switch or a fresh part waiting for its answer wakes no fallback turn', async () => {
  const run = async ({ bot, awaiting = false, failure = { code: 'PI_AI_ERROR', message: 'Provider is not configured: openai-codex' } }) => {
    const hooks = new Map()
    const followed = []
    const selected = []
    install({
      ctx: { on: (name, listener) => hooks.set(name, listener) }, config: {}, isBotSession: () => true,
      defaultModel: async () => 'deepseek-official/deepseek-flash', warn: () => {},
      chatOwners: new Map([['bot-1', 'b1']]), botOf: () => bot, awaitingFirstAnswer: () => awaiting,
    })
    const agent = { id: 'bot-1', model: { current: () => ({ ...OPENAI }), select: route => selected.push(route) }, followup: message => followed.push(message), session: { id: 'bot-1', requestHeader: () => ({ config: OPENAI }) } }
    await hooks.get('agent/request-error')({ agent, turn: 3, failure, signal: { aborted: false } }, async () => undefined)
    return { followed, selected }
  }
  const pending = { name: 'Ops', model: 'openai-codex/gpt-5.4-mini', previousModel: 'deepseek-official/deepseek-flash' }
  const confirmed = { name: 'Ops', model: 'openai-codex/gpt-5.4-mini', previousModel: 'openai-codex/gpt-5.4-mini' }
  assert.deepEqual(await run({ bot: pending }), { followed: [], selected: [] }, 'the pending switch goes back instead')
  assert.deepEqual(await run({ bot: confirmed, awaiting: true }), { followed: [], selected: [] }, 'the fresh part goes back instead')
  const fellBack = await run({ bot: confirmed })
  assert.deepEqual(fellBack.selected, [DEEPSEEK])
  assert.equal(fellBack.followed.length, 1)
  const other = await run({ bot: pending, failure: { code: 'SERVER' } })
  assert.deepEqual(other.selected, [DEEPSEEK], 'a failure the fallback answers still falls back on a pending switch')
})


// Exercise rc.2's own HTTP-status-first mapping; the installed package remains unchanged.
test('native gateway failure codes retain fallback wake and route restoration', async () => {
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'fallback-test:pi-ai') {
        const result = next('@deepseek-ai/dsh-llm-pi-ai', context)
        return { ...result, url: `${result.url}?fallback-native-status` }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      const result = next(url, context)
      return url.endsWith('?fallback-native-status') ? { ...result, source: `${result.source}\nexport { mapStopReason as nativeStopReason }` } : result
    },
  })
  let nativeStopReason
  try { ({ nativeStopReason } = await import('fallback-test:pi-ai')) } finally { hook.deregister() }
  for (const [text, code] of [['500 gateway says upstream 401', 'SERVER'], ['429 gateway says upstream 401', 'RATE_LIMIT'], ['401 upstream 500', 'AUTH'], ['upstream returned 401', 'AUTH']]) {
    const reason = nativeStopReason({ role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'probe-model', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: text, timestamp: 0 })
    assert.deepEqual(reason, { kind: 'error', failure: { code, message: text } })
    const h = harness()
    assert.equal(await h.failed(reason.failure), undefined)
    assert.deepEqual(h.selected, [DEEPSEEK])
    assert.equal(h.followed.length, 1)
    assert.ok(h.followed[0].content[0].text.includes(`failed (${code}: ${text});`))
    h.turnEnd(3)
    assert.deepEqual(h.selected, [DEEPSEEK])
    h.turnEnd(4)
    assert.deepEqual(h.selected, [DEEPSEEK, OPENAI])
    h.turnEnd(5)
    assert.equal(h.selected.length, 2)
  }
})


test('terminal-only refusals never select a fallback model or wake a native turn', () => {
  assert.equal(fallbackFor({ failure: { code: 'bot/terminal-only' }, failed: OPENAI, fallback: DEEPSEEK }), undefined)
})
