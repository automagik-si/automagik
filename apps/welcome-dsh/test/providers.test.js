import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../src/host/endpoint.js'
import { resolveConfig } from '@deepseek-ai/cordis'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SIGNIN_ROUTES, isSigninPolicy, keyRefOf, saveRoute } from '../src/host/providers.js'
import { fakeContext } from './fake-ctx.js'

const withPiAi = (providers = {}) => ({ 'omni-ai': {}, 'llm-pi-ai': { providers } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// DSH's authorization service, holding each attempt open until the test settles it.
function fakeAuthorization(flows = ['llm-pi-ai/kimi-coding', 'llm-pi-ai/openai-codex']) {
  const begun = []
  const cancelled = []
  return {
    begun,
    cancelled,
    describe: key => (flows.includes(key) ? { key, label: key, methods: [{ id: 'oauth' }], inFlight: false } : undefined),
    cancel(key) {
      cancelled.push(key)
      begun.find(attempt => attempt.key === key)?.settle({ status: 'cancelled' })
    },
    begin(request) {
      return new Promise((resolve, reject) => begun.push({ ...request, settle: resolve, fail: reject }))
    },
  }
}

// Nothing answers on this computer's network unless a test says so.
const offline = async () => { throw new Error('offline') }
function host({ entries = withPiAi(), authorization = fakeAuthorization(), services = {}, fetch = offline, ...rest } = {}) {
  const fake = fakeContext({ entries, services: { ...(authorization ? { authorization } : {}), ...services }, ...rest })
  const { handle } = install(fake.ctx, { fetch })
  return { ...fake, handle, authorization }
}

test('a key is stored under the reference the Models page uses, and the route points at it', async () => {
  const fake = host({ entries: withPiAi({ zai: { reasoning: 'high' } }) })
  const reply = await fake.handle('provider-key', { provider: 'zai', apiKey: '  sk-zai-0123  ' })
  assert.deepEqual(reply, { ok: true, value: { provider: 'zai', connected: true } })
  assert.equal(keyRefOf('openai-codex'), 'OPENAI_CODEX_API_KEY')
  assert.equal(fake.secrets.get('ZAI_API_KEY'), 'sk-zai-0123')
  // What the route held stays; the key itself never enters settings.
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.zai, { reasoning: 'high', apiKeyEnv: 'ZAI_API_KEY' })
  assert.ok(!JSON.stringify(fake.updates).includes('sk-zai'))
})

test("DeepSeek's key is DSH's own DeepSeek key, with no pi-ai route", async () => {
  const fake = host()
  assert.equal((await fake.handle('provider-key', { provider: 'deepseek', apiKey: 'sk-ds' })).ok, true)
  assert.equal(fake.secrets.get('DEEPSEEK_API_KEY'), 'sk-ds')
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, {})
})

test('a key for a provider no tile offers, or no key at all, is refused', async () => {
  const fake = host()
  assert.equal((await fake.handle('provider-key', { provider: 'evil', apiKey: 'x' })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('provider-key', { provider: 'zai', apiKey: 'two words' })).error.code, 'omni-ai/invalid')
  assert.equal(fake.secrets.size, 0)
})

test('payloads are parsed before use: wrong types read as missing fields, never as values', async () => {
  const fake = host()
  assert.equal((await fake.handle('provider-key', { provider: 42, apiKey: 'sk' })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('provider-key', { provider: 'zai', apiKey: ['sk'] })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('provider-key', 'zai')).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('signin-answer', { provider: 'kimi-coding', promptId: { id: 1 }, value: 'x' })).error.code, 'omni-ai/refused')
  assert.equal(fake.secrets.size, 0)
})

test('a key DSH would not route is taken back: the earlier key returns, or none stays', async () => {
  const keyed = host({ entries: { 'omni-ai': {} }, credentials: { ZAI_API_KEY: 'sk-old' } })
  assert.equal((await keyed.handle('provider-key', { provider: 'zai', apiKey: 'sk-new' })).error.code, 'omni-ai/refused')
  assert.equal(keyed.secrets.get('ZAI_API_KEY'), 'sk-old')
  const fresh = host({ entries: { 'omni-ai': {} } })
  assert.equal((await fresh.handle('provider-key', { provider: 'zai', apiKey: 'sk-new' })).ok, false)
  assert.equal(fresh.secrets.has('ZAI_API_KEY'), false)
})

test('two starts at once begin one sign-in; a cancelled one leaves no route behind', async () => {
  const fake = host()
  const [first, second] = await Promise.all([
    fake.handle('signin-start', { provider: 'kimi-coding' }),
    fake.handle('signin-start', { provider: 'kimi-coding' }),
  ])
  assert.equal(first.ok && second.ok, true, JSON.stringify([first, second]))
  assert.equal(fake.authorization.begun.length, 1)
  // Nothing is written while the sign-in runs.
  assert.equal(fake.updates.length, 0)
  fake.authorization.begun[0].settle({ status: 'cancelled' })
  await tick()
  assert.equal(fake.updates.length, 0)
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, {})
})

test('a sign-in adds the route, relays its notice and question, takes the answer and ends authorized', async () => {
  const fake = host()
  const started = await fake.handle('signin-start', { provider: 'kimi-coding' })
  assert.equal(started.value.status, 'running')
  assert.equal(fake.valueOf('llm-pi-ai').providers['kimi-coding'], undefined)
  const [attempt] = fake.authorization.begun
  assert.equal(attempt.key, 'llm-pi-ai/kimi-coding')
  assert.equal(attempt.method, 'oauth')

  attempt.interaction.notify({ message: 'Enter this code', url: 'https://auth.example/device', code: 'AB12-CD34' })
  const answer = attempt.interaction.prompt({ kind: 'select', message: 'How?', options: [{ id: 'device', label: 'Device code' }, { id: 'browser', label: 'Browser' }] })
  const status = (await fake.handle('signin-status', { provider: 'kimi-coding' })).value
  assert.deepEqual(status.notice, { message: 'Enter this code', url: 'https://auth.example/device', code: 'AB12-CD34' })
  assert.equal(status.prompt.kind, 'select')
  assert.equal((await fake.handle('signin-answer', { provider: 'kimi-coding', promptId: status.prompt.id, value: 'nope' })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('signin-answer', { provider: 'kimi-coding', promptId: status.prompt.id, value: 'device' })).ok, true)
  assert.equal(await answer, 'device')
  // An answered question is closed.
  assert.equal((await fake.handle('signin-answer', { provider: 'kimi-coding', promptId: status.prompt.id, value: 'device' })).error.code, 'omni-ai/refused')

  attempt.settle({ status: 'authorized' })
  await tick()
  await tick()
  assert.equal((await fake.handle('signin-status', { provider: 'kimi-coding' })).value.status, 'authorized')
  // The route arrives with the finished sign-in.
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers['kimi-coding'], {})
})

test('Claude and ChatGPT plans are not signed in here: they sign in through their CLIs', async () => {
  const fake = host({ authorization: fakeAuthorization(['llm-pi-ai/anthropic', 'llm-pi-ai/openai-codex']) })
  for (const provider of ['anthropic', 'openai-codex']) {
    for (const endpoint of ['signin-start', 'signin-status', 'signin-answer', 'signin-cancel']) {
      assert.equal((await fake.handle(endpoint, { provider })).error.code, 'omni-ai/invalid', `${endpoint} ${provider}`)
    }
  }
  assert.equal(fake.authorization.begun.length, 0)
  assert.equal(fake.updates.length, 0)
  const value = (await fake.handle('providers')).value
  assert.equal(value['openai-codex'], undefined)
  assert.equal(value.anthropic.signIn, undefined)
})

test('a second start while one runs joins it; cancel withdraws the attempt and its question', async () => {
  const fake = host()
  await fake.handle('signin-start', { provider: 'kimi-coding' })
  await fake.handle('signin-start', { provider: 'kimi-coding' })
  assert.equal(fake.authorization.begun.length, 1)
  const question = fake.authorization.begun[0].interaction.prompt({ kind: 'text', message: 'Paste the code' })
  const cancelled = await fake.handle('signin-cancel', { provider: 'kimi-coding' })
  await assert.rejects(question)
  await tick()
  assert.deepEqual(fake.authorization.cancelled, ['llm-pi-ai/kimi-coding'])
  assert.equal(cancelled.value.prompt, null)
  assert.equal((await fake.handle('signin-status', { provider: 'kimi-coding' })).value.status, 'cancelled')
})

test('a failed sign-in reports why; one this DSH cannot run is refused before any route is written', async () => {
  const fake = host()
  await fake.handle('signin-start', { provider: 'kimi-coding' })
  fake.authorization.begun[0].fail(new Error('device code expired'))
  await tick()
  const status = (await fake.handle('signin-status', { provider: 'kimi-coding' })).value
  assert.equal(status.status, 'failed')
  assert.match(status.error, /expired/)

  const noFlow = host()
  assert.equal((await noFlow.handle('signin-start', { provider: 'github-copilot' })).error.code, 'omni-ai/refused')
  const noService = host({ authorization: null })
  assert.equal((await noService.handle('signin-start', { provider: 'kimi-coding' })).error.code, 'omni-ai/refused')
  assert.deepEqual(noService.valueOf('llm-pi-ai').providers, {})
})

test('providers reports, per tile, a stored key, a sign-in and whether this DSH can run it', async () => {
  const fake = host({ credentials: { OPENAI_API_KEY: 'k' }, records: ['llm-pi-ai/kimi-coding'] })
  const value = (await fake.handle('providers')).value
  assert.equal(value.openai.key, true)
  assert.equal(value['kimi-coding'].signedIn, true)
  assert.equal(value['kimi-coding'].signIn, true)
  assert.equal(value['github-copilot'].signIn, false)
})

// The review of #196: a sign-in's route that then takes a key is a key's route, and a key's
// 429 is DSH's to retry. DSH's settings describe a route as pi-ai's Config resolved it through
// Cordis (maxRetries, backoff and the rest filled in), so the fixtures start from that shape.
const SIGNIN_POLICY = { mode: 'normal', retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'] }
const described = route => resolveConfig(piAi, { providers: { anthropic: route } }).providers.get().anthropic

test('the route DSH describes for a sign-in carries its policy with DSH\'s defaults filled in', () => {
  const route = described({ retryPolicy: SIGNIN_POLICY })
  assert.deepEqual(route.retryPolicy, { ...SIGNIN_POLICY, maxRetries: 5, backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } })
  assert.equal(isSigninPolicy(route.retryPolicy, SIGNIN_ROUTES.anthropic.retryPolicy), true)
  assert.equal(isSigninPolicy(SIGNIN_POLICY, SIGNIN_ROUTES.anthropic.retryPolicy), true)
  assert.equal(isSigninPolicy({ ...SIGNIN_POLICY, retryableCodes: ['TRANSPORT', 'TIMEOUT', 'SERVER', 'EMPTY_RESPONSE'] }, SIGNIN_ROUTES.anthropic.retryPolicy), true)
  // Anything someone set by hand is not the sign-in's.
  for (const policy of [
    described({ retryPolicy: { mode: 'normal', maxRetries: 2 } }).retryPolicy,
    { ...SIGNIN_POLICY, retryableCodes: [...SIGNIN_POLICY.retryableCodes, 'RATE_LIMIT'] },
    { ...SIGNIN_POLICY, maxRetries: 3 },
    { ...SIGNIN_POLICY, backoff: { initialDelayMs: 1000 } },
    { mode: 'always' },
  ]) assert.equal(isSigninPolicy(policy, SIGNIN_ROUTES.anthropic.retryPolicy), false, JSON.stringify(policy))
})

test('a key added on a sign-in\'s route leaves the sign-in\'s retry policy, at both places a key is saved', async () => {
  const viaKey = host({ entries: withPiAi({ anthropic: described({ retryPolicy: SIGNIN_POLICY }) }) })
  assert.equal((await viaKey.handle('provider-key', { provider: 'anthropic', apiKey: 'sk-ant-0123' })).ok, true)
  const keyed = viaKey.valueOf('llm-pi-ai').providers.anthropic
  assert.deepEqual([keyed.apiKeyEnv, keyed.retryPolicy], ['ANTHROPIC_API_KEY', undefined])
  // The route DSH resolves from it again has DSH's default retries, RATE_LIMIT among them.
  assert.equal(described(keyed).retryPolicy, undefined)
  // A policy set by hand stays.
  const handSet = host({ entries: withPiAi({ anthropic: described({ retryPolicy: { mode: 'normal', maxRetries: 2 } }) }) })
  assert.equal((await handSet.handle('provider-key', { provider: 'anthropic', apiKey: 'sk-ant-0123' })).ok, true)
  assert.deepEqual(handSet.valueOf('llm-pi-ai').providers.anthropic.retryPolicy, described({ retryPolicy: { mode: 'normal', maxRetries: 2 } }).retryPolicy)
  // Connect AI's own key save (ais.js) goes through the same saveRoute.
  const ctx = { settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { anthropic: described({ retryPolicy: SIGNIN_POLICY }) } } }], mutate: async (_ns, ops) => { ctx.ops = ops } } }
  await saveRoute(ctx, 'anthropic', { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  assert.deepEqual([ctx.ops[0].value.apiKeyEnv, ctx.ops[0].value.retryPolicy], ['ANTHROPIC_API_KEY', undefined])
})

test('an Anthropic API key is saved the Models page\'s way, on the same anthropic route', async () => {
  const fake = host()
  assert.equal((await fake.handle('provider-key', { provider: 'anthropic', apiKey: 'sk-ant-0123' })).ok, true)
  assert.equal(fake.secrets.get('ANTHROPIC_API_KEY'), 'sk-ant-0123')
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
})

test('the gated sign-in status route serves the notice only to its mounted owner', async () => {
  const provider = 'kimi-coding'
  const authorization = fakeAuthorization()
  const { ctx, routes } = fakeContext({ services: {
    authorization,
    omniTeam: { ownerViewer: request => ({ id: request.headers.get('x-automagik-principal') }) },
  } })
  const { handle } = install(ctx, { env: { AUTOMAGIK_MULTIUSER: '1' }, fetch: offline })
  const route = routes[0]
  await handle('signin-start', { provider })
  const [attempt] = authorization.begun
  const poll = async (person, viewer) => {
    const response = await route.fetch(new Request('https://workspace.invalid' + route.path, {
      method: 'POST',
      headers: { 'x-automagik-principal': person },
      body: JSON.stringify({ endpoint: 'signin-status', payload: { provider }, viewer }),
    }))
    return response.json()
  }
  try {
    attempt.interaction.notify({ code: 'A-FIRST' })
    assert.equal((await poll('owner-a', 'owner-a')).value.notice.code, 'A-FIRST')
    attempt.interaction.notify({ code: 'B-NEXT' })
    assert.equal((await poll('owner-b', 'owner-a')).error?.code, 'bot/viewer-changed')
    assert.equal((await poll('owner-b')).error?.code, 'bot/viewer-changed')
    assert.equal((await poll('owner-b', 'owner-b')).value.notice.code, 'B-NEXT')
  } finally {
    attempt.settle({ status: 'cancelled' })
  }
})
