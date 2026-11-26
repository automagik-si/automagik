import { test } from 'node:test'
import { resolveConfig } from '@deepseek-ai/cordis'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import assert from 'node:assert/strict'
import { COVERED, OLLAMA_KEY_REF, SUBSCRIPTION_ONLY, VENDORS } from '../src/host/ais.js'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'

const SECRET = 'sk-never-leaves-0123456789'
const offline = async () => { throw new Error('offline') }

// DSH's authorization service, offering the sign-ins pi-ai registers here.
const flows = (keys = ['llm-pi-ai/anthropic', 'llm-pi-ai/openai-codex']) => ({ describe: key => (keys.includes(key) ? { key, label: key, methods: [{ id: 'oauth' }] } : undefined) })

function host({ providers = {}, entries = {}, fetch = offline, services = {}, ...rest } = {}) {
  const fake = fakeContext({ entries: { 'omni-ai': {}, 'llm-pi-ai': { providers }, ...entries }, services: { authorization: flows(), ...services }, ...rest })
  const { handle } = install(fake.ctx, { fetch })
  const rows = async () => (await handle('ais')).value
  const row = async id => (await rows()).rows.find(item => item.id === id)
  return { ...fake, handle, rows, row }
}

// acp-dsh's acpAgents service: each agent's switch is acp-dsh's own setting in the fake's
// settings, so turning a row on or off shows in the next status. `over` sets an agent's fields.
const ACP_KEY = { 'acp-claude': 'claude', 'acp-codex': 'codex', 'acp-antigravity': 'antigravity' }
const ACP_NAME = { 'acp-claude': 'Claude Code', 'acp-codex': 'Codex', 'acp-antigravity': 'Antigravity' }
function cliHost({ agents = {}, acpEntry = {}, entries = {}, services = {}, ...rest } = {}) {
  const calls = []
  let fake
  const list = () => Object.entries(agents).map(([id, over]) => ({
    id, key: ACP_KEY[id], name: ACP_NAME[id],
    cli: { found: true, state: 'ready', version: '1.0.0' },
    connector: { state: 'ready', version: '1.2.3' },
    signedIn: true, model: { listed: true }, restartNeeded: false,
    ...over,
    on: fake.valueOf('acp-dsh')?.[ACP_KEY[id]] === true,
  }))
  const acpAgents = {
    status: async () => { calls.push('status'); return { agents: list() } },
    refresh: async () => { calls.push('refresh'); return { agents: list() } },
  }
  fake = host({ entries: { 'acp-dsh': { claude: false, codex: false, ...acpEntry }, ...entries }, services: { acpAgents, ...services }, ...rest })
  return { ...fake, calls }
}

test('one row per AI, and no row reaches a vendor another row already covers', () => {
  const ids = VENDORS.map(vendor => vendor.id)
  // Antigravity third, with the other CLI rows (#2048, Connect AI choice D).
  assert.deepEqual(ids, ['claude', 'chatgpt', 'antigravity', 'deepseek', 'kimi', 'copilot', 'grok', 'openai', 'openrouter', 'zai', 'moonshot', 'opencode', 'cliproxy', 'ollama'])
  // Claude is Claude Code's sign-in, or an Anthropic API key on pi-ai's anthropic route: one row,
  // no Anthropic API row beside it. ChatGPT is Codex's sign-in only.
  assert.deepEqual(VENDORS.find(vendor => vendor.id === 'claude'), { id: 'claude', name: 'Claude', via: 'Your Claude Pro or Max plan through Claude Code, or an Anthropic API key', kind: 'signin', cli: 'acp-claude', provider: 'anthropic', envRefs: ['ANTHROPIC_API_KEY'], keyUrl: 'https://console.anthropic.com/settings/keys' })
  assert.deepEqual(VENDORS.find(vendor => vendor.id === 'chatgpt'), { id: 'chatgpt', name: 'ChatGPT', via: 'Your ChatGPT Plus or Pro plan, through Codex', kind: 'signin', cli: 'acp-codex', provider: 'openai-codex' })
  assert.equal(VENDORS.filter(vendor => vendor.provider === 'anthropic').length, 1)
  // pi-ai's own DeepSeek route is not offered: DeepSeek is DSH's key and account.
  assert.ok(!VENDORS.some(vendor => vendor.provider === 'deepseek' && vendor.route !== false))
  // The dsh-subscriptions vendors Omni offers are only the ones nothing else covers; it ships no
  // claude or codex any more, so nothing stands for them.
  for (const vendor of Object.keys(COVERED)) assert.ok(!SUBSCRIPTION_ONLY.includes(vendor), vendor)
  assert.deepEqual(Object.keys(COVERED), ['kimi', 'copilot', 'grok', 'ollama'])
})

test('what this computer has is found: names and states only, never a key', async () => {
  const fake = cliHost({
    agents: { 'acp-claude': {} },
    acpEntry: { claude: true },
    providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    credentials: { OPENAI_API_KEY: SECRET },
    env: { DEEPSEEK_API_KEY: SECRET, XAI_API_KEY: SECRET },
    records: ['llm-pi-ai/kimi-coding', 'llm-pi-ai/anthropic'],
    fetch: async url => (String(url).endsWith('/api/tags') ? new Response('{"models":[]}') : new Response('', { status: 404 })),
  })
  const reply = await fake.rows()
  assert.ok(!JSON.stringify(reply).includes(SECRET))
  const by = Object.fromEntries(reply.rows.map(row => [row.id, row]))
  assert.deepEqual([by.claude.found, by.claude.on, by.claude.signIn, by.claude.cli.id], ['Signed in to Claude Code', true, true, 'acp-claude'])
  // No Codex agent here: ChatGPT is not set up, whatever DSH's own ChatGPT sign-in left.
  assert.deepEqual([by.chatgpt.ready, by.chatgpt.on, by.chatgpt.signIn], [false, false, false])
  assert.deepEqual([by.deepseek.found, by.deepseek.on], ['DEEPSEEK_API_KEY found', true])
  assert.deepEqual([by.openai.found, by.openai.on], ['Key saved', true])
  // Signed in but no route: ready, not on until switched.
  assert.deepEqual([by.kimi.found, by.kimi.ready, by.kimi.on], ['Signed in to Kimi', true, false])
  assert.deepEqual([by.grok.found, by.grok.ready, by.grok.on], ['XAI_API_KEY found', true, false])
  assert.deepEqual([by.ollama.found, by.ollama.ready, by.ollama.on], ['Running on this computer', true, false])
  assert.deepEqual([by.openrouter.found, by.openrouter.ready], [null, false])
})

test('Claude and ChatGPT sign in through their CLIs: on is the agent\'s own switch, never a pi-ai route', async () => {
  // No acp-dsh, no key: not set up, nothing offers a sign-in, and on is refused.
  const fresh = host()
  const before = await fresh.row('claude')
  assert.deepEqual([before.ready, before.on, before.signIn, before.keyUrl], [false, false, false, 'https://console.anthropic.com/settings/keys'])
  assert.equal((await fresh.handle('ai-switch', { id: 'claude', on: true })).error.code, 'omni-ai/refused')
  assert.equal((await fresh.handle('ai-switch', { id: 'chatgpt', on: true })).error.code, 'omni-ai/refused')
  assert.equal(fresh.valueOf('llm-pi-ai').providers.anthropic, undefined)
  // DSH's own Claude or ChatGPT sign-in alone sets up neither row any more.
  const old = host({ records: ['llm-pi-ai/anthropic', 'llm-pi-ai/openai-codex'] })
  assert.deepEqual([(await old.row('claude')).ready, (await old.row('chatgpt')).ready], [false, false])

  // The CLIs there but signed out: the rows offer their sign-in, and are not set up.
  const out = cliHost({ agents: { 'acp-claude': { signedIn: false }, 'acp-codex': { signedIn: false } } })
  for (const id of ['claude', 'chatgpt']) {
    const row = await out.row(id)
    assert.deepEqual([row.ready, row.on, row.signIn, row.found], [false, false, true, null], id)
    assert.equal((await out.handle('ai-switch', { id, on: true })).error.code, 'omni-ai/refused')
  }
  assert.deepEqual(out.valueOf('acp-dsh'), { claude: false, codex: false })

  // Signed in, switched off in acp-dsh: ready; on turns acp-dsh's switch on and looks again.
  const fake = cliHost({ agents: { 'acp-claude': {}, 'acp-codex': {} } })
  assert.deepEqual([(await fake.row('chatgpt')).ready, (await fake.row('chatgpt')).on, (await fake.row('chatgpt')).found], [true, false, 'Signed in to Codex'])
  const on = (await fake.handle('ai-switch', { id: 'chatgpt', on: true })).value
  assert.deepEqual([on.on, on.cli.on], [true, true])
  assert.deepEqual(fake.valueOf('acp-dsh'), { claude: false, codex: true })
  assert.ok(fake.calls.includes('refresh'))
  assert.equal((await fake.handle('ai-switch', { id: 'claude', on: true })).value.on, true)
  // No pi-ai route is written for a CLI.
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, {})
  // Off is the CLI's switch, for every Bot on it; the row stays set up.
  assert.equal((await fake.handle('ai-switch', { id: 'chatgpt', on: false })).value.on, false)
  assert.deepEqual(fake.valueOf('acp-dsh'), { claude: true, codex: false })
  assert.equal((await fake.row('chatgpt')).ready, true)
})

test('a CLI that cannot answer yet is not on, and an AI on through a CLI alone connects the step', async () => {
  for (const [why, over] of [['installing', { cli: { found: true, state: 'installing' } }], ['connector', { connector: { state: 'installing' } }], ['restart', { restartNeeded: true }], ['unchecked', { signedIn: undefined }], ['updating', { cli: { found: true, state: 'ready', updating: true } }]]) {
    const fake = cliHost({ agents: { 'acp-codex': over }, acpEntry: { codex: true } })
    assert.equal((await fake.row('chatgpt')).on, false, why)
    assert.equal((await fake.handle('state')).value.aiConnected, false, why)
  }
  const ready = cliHost({ agents: { 'acp-codex': {} }, acpEntry: { codex: true } })
  assert.equal((await ready.row('chatgpt')).on, true)
  assert.equal((await ready.handle('state')).value.aiConnected, true)
  // acp-dsh that throws reads as no agent.
  const broken = host({ services: { acpAgents: { status: async () => { throw new Error('down') } } } })
  assert.deepEqual([(await broken.row('claude')).on, (await broken.row('claude')).signIn], [false, false])
})

test('a pi-ai route on DSH\'s own Claude or ChatGPT sign-in is a duplicate of the CLI: its route goes, its record stays', async () => {
  const fake = cliHost({
    agents: { 'acp-claude': {}, 'acp-codex': {} },
    acpEntry: { claude: true, codex: true },
    providers: { anthropic: { retryPolicy: { mode: 'normal', retryableCodes: ['SERVER'] } }, 'openai-codex': {} },
    records: ['llm-pi-ai/anthropic', 'llm-pi-ai/openai-codex'],
  })
  for (const [id, provider] of [['claude', 'anthropic'], ['chatgpt', 'openai-codex']]) {
    const row = await fake.row(id)
    assert.equal(row.on, true)
    assert.deepEqual(row.duplicates, [{ via: 'DSH sign-in', provider, hidden: false }], id)
  }
  assert.deepEqual((await fake.handle('ai-dedupe', { id: 'chatgpt' })).value.hidden, ['openai-codex'])
  assert.deepEqual(Object.keys(fake.valueOf('llm-pi-ai').providers), ['anthropic'])
  // Turning Claude on again stops its duplicate too.
  await fake.handle('ai-switch', { id: 'claude', on: true })
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, {})
  // The sign-in records stay (image generation reads openai-codex's).
  for (const key of ['llm-pi-ai/anthropic', 'llm-pi-ai/openai-codex']) assert.equal((await fake.ctx.credentials.describeRecord(key)).configured, true)
  assert.equal((await fake.row('claude')).duplicates, undefined)

  // Turning a signed-in CLI on stops the old route at once.
  const switching = cliHost({ agents: { 'acp-codex': {} }, providers: { 'openai-codex': {} }, records: ['llm-pi-ai/openai-codex'] })
  assert.equal((await switching.handle('ai-switch', { id: 'chatgpt', on: true })).value.on, true)
  assert.deepEqual(switching.valueOf('llm-pi-ai').providers, {})
  assert.equal((await switching.ctx.credentials.describeRecord('llm-pi-ai/openai-codex')).configured, true)

  // While the CLI cannot answer, the old route is listed but stays: nothing else would run.
  const waiting = cliHost({ agents: { 'acp-codex': { signedIn: false } }, providers: { 'openai-codex': {} } })
  assert.equal((await waiting.row('chatgpt')).duplicates.length, 1)
  assert.deepEqual((await waiting.handle('ai-dedupe', { id: 'chatgpt' })).value.hidden, [])
  assert.deepEqual(waiting.valueOf('llm-pi-ai').providers, { 'openai-codex': {} })
})

// bots-dsh's runtime as `omniTeam`: its saved team, and the once-per-route move of the Bots on
// DSH's own Claude or ChatGPT sign-in to the CLI's route (bots-dsh subscription-move.js), here
// to the closest model the fake agent lists.
function fakeTeam(bots, { move = true, prefs = {} } = {}) {
  const calls = []
  const state = { bots: structuredClone(bots), prefs }
  const LISTED = { 'acp-codex': ['gpt-5.5', 'default'], 'acp-claude': ['opus', 'sonnet', 'default'] }
  const closest = (to, id) => (LISTED[to].includes(id) ? id : to === 'acp-claude' ? (['opus', 'sonnet'].find(family => id.includes(family)) ?? 'default') : 'default')
  const team = {
    state,
    load: async () => { calls.push('load') },
    calls,
  }
  if (move) {
    team.moveSubscriptionBots = async () => {
      calls.push('move')
      for (const bot of Object.values(state.bots)) {
        for (const [from, to] of [['openai-codex', 'acp-codex'], ['anthropic', 'acp-claude']]) {
          if (bot.hostOwned) continue
          if (bot.model?.startsWith(`${from}/`)) bot.model = `${to}/${closest(to, bot.model.slice(from.length + 1))}`
        }
      }
    }
  }
  return team
}

test('the old sign-in route goes only once the Bot team has moved its Bots on it to the CLI', async () => {
  // A Bot on openai-codex ends up on acp-codex's closest model, and only then does the route go.
  const team = fakeTeam({ a: { model: 'openai-codex/gpt-5.5' }, b: { model: 'openai-codex/gpt-5.1-codex' }, c: { model: 'deepseek/deepseek-chat' } })
  const order = []
  team.moveSubscriptionBots = (inner => async () => { order.push('move'); await inner() })(team.moveSubscriptionBots)
  const fake = cliHost({ agents: { 'acp-codex': {} }, providers: { 'openai-codex': {} }, records: ['llm-pi-ai/openai-codex'], services: { omniTeam: team } })
  assert.equal((await fake.handle('ai-switch', { id: 'chatgpt', on: true })).value.on, true)
  assert.deepEqual(Object.fromEntries(Object.entries(team.state.bots).map(([id, bot]) => [id, bot.model])), { a: 'acp-codex/gpt-5.5', b: 'acp-codex/default', c: 'deepseek/deepseek-chat' })
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, {})
  assert.deepEqual(order, ['move'])
  assert.equal((await fake.ctx.credentials.describeRecord('llm-pi-ai/openai-codex')).configured, true)

  // Claude: a Bot on DSH's Pro or Max sign-in moves to acp-claude first, then the route goes.
  const claudeTeam = fakeTeam({ a: { model: 'anthropic/claude-opus-4-5' } })
  const claude = cliHost({ agents: { 'acp-claude': {} }, providers: { anthropic: {} }, records: ['llm-pi-ai/anthropic'], services: { omniTeam: claudeTeam } })
  await claude.handle('ai-switch', { id: 'claude', on: true })
  assert.equal(claudeTeam.state.bots.a.model, 'acp-claude/opus')
  assert.deepEqual(claude.valueOf('llm-pi-ai').providers, {})

  // A Bot the move leaves on the route (one the host owns, a pending switch back to it, the
  // background jobs, or a team without the move) keeps the route: listed, never unset.
  const kept = [
    fakeTeam({ a: { model: 'openai-codex/gpt-5.5', hostOwned: true } }),
    fakeTeam({ a: { model: 'acp-codex/gpt-5.5', previousModel: 'openai-codex/gpt-5.5' } }),
    fakeTeam({}, { prefs: { backgroundModel: 'openai-codex/gpt-5.5' } }),
    fakeTeam({ a: { model: 'openai-codex/gpt-5.5' } }, { move: false }),
    { get state() { throw new Error('unreadable') }, load: async () => {} },
  ]
  for (const [index, omniTeam] of kept.entries()) {
    const stays = cliHost({ agents: { 'acp-codex': {} }, providers: { 'openai-codex': {} }, records: ['llm-pi-ai/openai-codex'], services: { omniTeam } })
    const row = (await stays.handle('ai-switch', { id: 'chatgpt', on: true })).value
    assert.equal(row.on, true, `case ${index}`)
    assert.deepEqual(row.duplicates, [{ via: 'DSH sign-in', provider: 'openai-codex', hidden: false }], `case ${index}`)
    assert.deepEqual((await stays.handle('ai-dedupe', { id: 'chatgpt' })).value.hidden, [], `case ${index}`)
    assert.deepEqual(stays.valueOf('llm-pi-ai').providers, { 'openai-codex': {} }, `case ${index}`)
  }
  // Once nothing runs on it any more, Use only this stops it.
  const later = fakeTeam({ a: { model: 'openai-codex/gpt-5.5' } }, { move: false })
  const after = cliHost({ agents: { 'acp-codex': {} }, acpEntry: { codex: true }, providers: { 'openai-codex': {} }, services: { omniTeam: later } })
  assert.deepEqual((await after.handle('ai-dedupe', { id: 'chatgpt' })).value.hidden, [])
  later.state.bots.a.model = 'acp-codex/gpt-5.5'
  assert.deepEqual((await after.handle('ai-dedupe', { id: 'chatgpt' })).value.hidden, ['openai-codex'])
  assert.deepEqual(after.valueOf('llm-pi-ai').providers, {})
})

test('an Anthropic key\'s route is never a duplicate: dedupe and the CLI leave it as it is', async () => {
  const fake = cliHost({
    agents: { 'acp-claude': {} },
    acpEntry: { claude: true },
    providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
    credentials: { ANTHROPIC_API_KEY: SECRET },
    records: ['llm-pi-ai/anthropic'],
  })
  const row = await fake.row('claude')
  assert.deepEqual([row.on, row.duplicates], [true, undefined])
  await fake.handle('ai-dedupe', { id: 'claude' })
  await fake.handle('ai-switch', { id: 'claude', on: true })
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  // An environment key pi-ai reads on a route that names none (no DSH sign-in under it) is a
  // key's route too.
  const env = cliHost({ agents: { 'acp-claude': {} }, acpEntry: { claude: true }, providers: { anthropic: {} }, env: { ANTHROPIC_API_KEY: SECRET } })
  assert.equal((await env.row('claude')).duplicates, undefined)
  assert.ok(!JSON.stringify(fake.updates).includes(SECRET))
})

test('Claude on an Anthropic API key: the same row, on the key the route names', async () => {
  const saved = host({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } }, credentials: { ANTHROPIC_API_KEY: SECRET } })
  assert.deepEqual([(await saved.row('claude')).found, (await saved.row('claude')).on], ['Key saved', true])
  const fromEnv = host({ env: { ANTHROPIC_API_KEY: SECRET } })
  assert.deepEqual([(await fromEnv.row('claude')).found, (await fromEnv.row('claude')).on], ['ANTHROPIC_API_KEY found', false])
  assert.equal((await fromEnv.handle('ai-switch', { id: 'claude', on: true })).value.on, true)
  assert.deepEqual(fromEnv.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  // A route left on a key that is gone is off, and not set up: DSH's old sign-in does not count.
  const stale = host({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', reasoning: 'high' } }, records: ['llm-pi-ai/anthropic'] })
  assert.deepEqual([(await stale.row('claude')).on, (await stale.row('claude')).ready], [false, false])
  assert.equal((await stale.handle('ai-switch', { id: 'claude', on: true })).error.code, 'omni-ai/refused')
  assert.deepEqual(stale.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY', reasoning: 'high' })
  // A route a sign-in made, turned on with a key instead: the key's route, with DSH's retries.
  // The route as DSH describes it: pi-ai's Config resolved through Cordis, defaults filled in.
  const signinRoute = resolveConfig(piAi, { providers: { anthropic: { retryPolicy: { mode: 'normal', retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'] } } } }).providers.get().anthropic
  const signedOut = host({ providers: { anthropic: signinRoute }, env: { ANTHROPIC_API_KEY: SECRET } })
  assert.equal((await signedOut.handle('ai-switch', { id: 'claude', on: true })).value.on, true)
  const keyed = signedOut.valueOf('llm-pi-ai').providers.anthropic
  assert.deepEqual([keyed.apiKeyEnv, keyed.retryPolicy], ['ANTHROPIC_API_KEY', undefined])
  // Off removes the key's route and keeps the key.
  assert.equal((await saved.handle('ai-switch', { id: 'claude', on: false })).value.on, false)
  assert.equal(saved.valueOf('llm-pi-ai').providers.anthropic, undefined)
  assert.equal(saved.secrets.get('ANTHROPIC_API_KEY'), SECRET)
  assert.ok(!JSON.stringify([saved.updates, fromEnv.updates, stale.updates, signedOut.updates]).includes(SECRET))
})

test('off stops using an AI and keeps its key or sign-in; on brings it back', async () => {
  const fake = host({ credentials: { OPENROUTER_API_KEY: SECRET }, records: ['llm-pi-ai/kimi-coding'] })
  // A key: on writes the route that names it, off removes the route only.
  assert.equal((await fake.handle('ai-switch', { id: 'openrouter', on: true })).value.on, true)
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.openrouter, { apiKeyEnv: 'OPENROUTER_API_KEY' })
  assert.equal((await fake.handle('ai-switch', { id: 'openrouter', on: false })).value.on, false)
  assert.equal(fake.valueOf('llm-pi-ai').providers.openrouter, undefined)
  assert.equal(fake.secrets.get('OPENROUTER_API_KEY'), SECRET)
  // A sign-in: the route names no key, so it runs on the sign-in.
  assert.equal((await fake.handle('ai-switch', { id: 'kimi', on: true })).value.on, true)
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers['kimi-coding'], {})
  assert.equal((await fake.handle('ai-switch', { id: 'kimi', on: false })).value.on, false)
  assert.equal((await fake.row('kimi')).ready, true)
  // What is not set up is refused, and nothing is written for it.
  assert.equal((await fake.handle('ai-switch', { id: 'openai', on: true })).error.code, 'omni-ai/refused')
  assert.equal(fake.valueOf('llm-pi-ai').providers.openai, undefined)
  assert.equal((await fake.handle('ai-switch', { id: 'nope', on: true })).error.code, 'omni-ai/invalid')
  assert.equal((await fake.handle('ai-switch', { id: 'openrouter' })).error.code, 'omni-ai/invalid')
})

test('an environment key turns on by naming its variable; DeepSeek, DSH\'s own route, cannot be switched off here', async () => {
  const fake = host({ env: { OPENAI_API_KEY: SECRET, DEEPSEEK_API_KEY: SECRET } })
  await fake.handle('ai-switch', { id: 'openai', on: true })
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.openai, { apiKeyEnv: 'OPENAI_API_KEY' })
  assert.equal((await fake.handle('ai-switch', { id: 'deepseek', on: false })).error.code, 'omni-ai/refused')
  assert.ok(!JSON.stringify(fake.updates).includes(SECRET))
})

test('Ollama on lists its models into a local route; off removes the route', async () => {
  const fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) return new Response('{"models":[]}')
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama3.2' }] }))
    return new Response('', { status: 404 })
  }
  const fake = host({ fetch })
  assert.equal((await fake.handle('ai-switch', { id: 'ollama', on: true })).value.on, true)
  const route = fake.valueOf('llm-pi-ai').providers.ollama
  assert.deepEqual([route.baseURL, route.apiKeyEnv, route.models.map(model => model.id)], ['http://127.0.0.1:11434/v1', OLLAMA_KEY_REF, ['qwen2.5-coder', 'llama3.2']])
  await fake.handle('ai-switch', { id: 'ollama', on: false })
  assert.equal(fake.valueOf('llm-pi-ai').providers.ollama, undefined)
  // Not running: not set up, and turning it on is refused.
  assert.equal((await host().handle('ai-switch', { id: 'ollama', on: true })).error.code, 'omni-ai/refused')
})

const subsEntry = (slots, hiddenModels = []) => ({ 'dsh-subscriptions': { slots, hiddenModels } })
const llmWith = models => ({ listProviders: () => [], listModels: async provider => models[provider] ?? [] })

test('turning Kimi on hides dsh-subscriptions\' Kimi, deletes none of its accounts, and keeps Kimi\'s route', async () => {
  const fake = host({
    records: ['llm-pi-ai/kimi-coding'],
    entries: subsEntry([{ provider: 'kimi', index: 1 }, { provider: 'cursor', index: 1 }, { provider: 'claude', index: 1 }]),
    credentials: { KIMI_OAUTH_1: SECRET, CURSOR_OAUTH_1: SECRET, CLAUDE_OAUTH_1: SECRET },
    services: { llm: llmWith({ kimi: [{ id: 'k2' }, { id: 'k2-turbo' }], cursor: [{ id: 'auto' }], claude: [{ id: 'claude-opus-5-5' }] }) },
  })
  const before = await fake.row('kimi')
  assert.deepEqual(before.duplicates.map(duplicate => [duplicate.via, duplicate.provider, duplicate.hidden]), [['dsh-subscriptions', 'kimi', false]])
  // dsh-subscriptions ships no claude any more: an old slot of it is no row's duplicate.
  assert.equal((await fake.row('claude')).duplicates, undefined)
  await fake.handle('ai-switch', { id: 'kimi', on: true })
  const subs = fake.valueOf('dsh-subscriptions')
  assert.deepEqual(subs.hiddenModels, [{ provider: 'kimi', id: 'k2' }, { provider: 'kimi', id: 'k2-turbo' }])
  // The accounts stay: their slots and credentials are untouched, cursor's models too.
  assert.deepEqual(subs.slots, [{ provider: 'kimi', index: 1 }, { provider: 'cursor', index: 1 }, { provider: 'claude', index: 1 }])
  assert.equal(fake.secrets.get('KIMI_OAUTH_1'), SECRET)
  // Kimi's own route is the row's, never a duplicate of it.
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers['kimi-coding'], {})
  const after = await fake.row('kimi')
  assert.equal(after.on, true)
  assert.deepEqual(after.duplicates.map(duplicate => duplicate.hidden), [true])
  assert.ok(!JSON.stringify(fake.updates).includes(SECRET))
})

test('a subscription only dsh-subscriptions has: off hides its models, on shows them again', async () => {
  const fake = host({
    entries: subsEntry([{ provider: 'cursor', index: 1 }, { provider: 'kiro', index: 1 }], [{ provider: 'kiro', id: 'x' }]),
    credentials: { CURSOR_OAUTH_1: SECRET },
    services: { llm: llmWith({ cursor: [{ id: 'auto' }, { id: 'gpt-5' }] }) },
  })
  // kiro has a slot but no credential: not an account.
  assert.deepEqual((await fake.rows()).subscriptions, { accounts: [{ provider: 'cursor', index: 1 }], hidden: [] })
  const off = (await fake.handle('ai-subscription', { provider: 'cursor', on: false })).value
  assert.deepEqual(off.subscriptions.hidden, ['cursor'])
  assert.deepEqual(fake.valueOf('dsh-subscriptions').hiddenModels, [{ provider: 'kiro', id: 'x' }, { provider: 'cursor', id: 'auto' }, { provider: 'cursor', id: 'gpt-5' }])
  await fake.handle('ai-subscription', { provider: 'cursor', on: true })
  assert.deepEqual(fake.valueOf('dsh-subscriptions').hiddenModels, [{ provider: 'kiro', id: 'x' }])
  assert.equal((await fake.handle('ai-subscription', { provider: 'kiro', on: true })).error.code, 'omni-ai/refused')
  // A covered vendor is not a subscription row.
  assert.equal((await fake.handle('ai-subscription', { provider: 'claude', on: false })).error.code, 'omni-ai/invalid')
  assert.equal((await host().handle('ai-subscription', { provider: 'cursor', on: false })).error.code, 'omni-ai/refused')
})

// One rule with the Bot team (bots-dsh subscription-move.js runsOnSignIn): anthropic's route
// with no key named is DSH's Claude sign-in only for a stored grant and no key found.
test('an Anthropic route on a pasted key\'s record, or on a key that wins over a grant, is never a duplicate', async () => {
  for (const [why, over] of [
    ['api-key record', { recordKinds: { 'llm-pi-ai/anthropic': 'api-key' } }],
    ['grant and an environment key', { env: { ANTHROPIC_API_KEY: SECRET } }],
    ['grant and a stored key', { credentials: { ANTHROPIC_API_KEY: SECRET } }],
    ['the Bot team says it is not the plan', { services: { omniTeam: { ...fakeTeam({}), anthropicSubscription: async () => false } } }],
  ]) {
    const fake = cliHost({ agents: { 'acp-claude': {} }, providers: { anthropic: {} }, records: ['llm-pi-ai/anthropic'], ...over })
    assert.equal((await fake.row('claude')).duplicates, undefined, why)
    await fake.handle('ai-switch', { id: 'claude', on: true })
    await fake.handle('ai-dedupe', { id: 'claude' })
    assert.deepEqual(fake.valueOf('llm-pi-ai').providers, { anthropic: {} }, why)
  }
  // The Bot team's own answer wins over the local reading.
  const told = cliHost({ agents: { 'acp-claude': {} }, providers: { anthropic: {} }, records: ['llm-pi-ai/anthropic'], recordKinds: { 'llm-pi-ai/anthropic': 'api-key' }, services: { omniTeam: { ...fakeTeam({}), anthropicSubscription: async () => true } } })
  assert.deepEqual((await told.row('claude')).duplicates, [{ via: 'DSH sign-in', provider: 'anthropic', hidden: false }])
})

// D-g: the jobs beside the chats and DSH's own default keep the route they run on.
test('the old sign-in route stays while DSH\'s default or the background jobs\' model is on it', async () => {
  const cases = [
    ['DSH default', { agentDefaultModel: { currentSelection: () => ({ provider: 'openai-codex', model: 'gpt-5.5' }) }, omniTeam: fakeTeam({}) }],
    ['DSH default, no team', { agentDefaultModel: { currentSelection: () => ({ provider: 'openai-codex', model: 'gpt-5.5' }) } }],
    ['background model resolved by the team', { omniTeam: { ...fakeTeam({}), backgroundModel: async () => 'openai-codex/gpt-5.5' } }],
  ]
  for (const [why, services] of cases) {
    const fake = cliHost({ agents: { 'acp-codex': {} }, providers: { 'openai-codex': {} }, records: ['llm-pi-ai/openai-codex'], services })
    const row = (await fake.handle('ai-switch', { id: 'chatgpt', on: true })).value
    assert.deepEqual(row.duplicates, [{ via: 'DSH sign-in', provider: 'openai-codex', hidden: false }], why)
    assert.deepEqual(fake.valueOf('llm-pi-ai').providers, { 'openai-codex': {} }, why)
  }
  // Elsewhere, the route goes as before.
  const elsewhere = cliHost({ agents: { 'acp-codex': {} }, providers: { 'openai-codex': {} }, records: ['llm-pi-ai/openai-codex'], services: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }, omniTeam: { ...fakeTeam({}), backgroundModel: async () => 'deepseek/deepseek-chat' } } })
  await elsewhere.handle('ai-switch', { id: 'chatgpt', on: true })
  assert.deepEqual(elsewhere.valueOf('llm-pi-ai').providers, {})
})

// D-b, D-c: off and on again brings the key's route back, with Claude Code signed in too.
test('Claude off then on, with a key and a signed-in Claude Code, puts the key\'s route back', async () => {
  const fake = cliHost({ agents: { 'acp-claude': {} }, acpEntry: { claude: true }, providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } }, credentials: { ANTHROPIC_API_KEY: SECRET } })
  await fake.handle('ai-switch', { id: 'claude', on: false })
  assert.equal(Object.hasOwn(fake.valueOf('llm-pi-ai').providers, 'anthropic'), false)
  assert.equal(fake.valueOf('acp-dsh').claude, false)
  const row = (await fake.handle('ai-switch', { id: 'claude', on: true })).value
  assert.equal(row.on, true)
  assert.equal(fake.valueOf('acp-dsh').claude, true)
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  // An environment key does the same.
  const env = cliHost({ agents: { 'acp-claude': {} }, providers: {}, env: { ANTHROPIC_API_KEY: SECRET } })
  await env.handle('ai-switch', { id: 'claude', on: true })
  assert.deepEqual(env.valueOf('llm-pi-ai').providers.anthropic, { apiKeyEnv: 'ANTHROPIC_API_KEY' })
  // No key: only the CLI.
  const bare = cliHost({ agents: { 'acp-claude': {} }, providers: {} })
  await bare.handle('ai-switch', { id: 'claude', on: true })
  assert.equal(Object.hasOwn(bare.valueOf('llm-pi-ai').providers, 'anthropic'), false)
})

// ---- Antigravity's Connect AI row (#2048, r6) -------------------------------------------------

const AGY_LINK = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=s1-state-0001'
const agyAgent = (over = {}) => ({
  cli: { found: true, state: 'ready', version: '1.5.15', install: 'manual', managed: true },
  connector: { state: 'ready', native: true }, appSignIn: true, signedIn: false, ...over,
})

test('X1: the Antigravity row: a CLI row with no route and no key, listed only with acp-dsh\'s app sign-in', () => {
  assert.deepEqual(VENDORS.find(vendor => vendor.id === 'antigravity'), { id: 'antigravity', name: 'Antigravity', via: 'Your Google account, through Antigravity', kind: 'signin', cli: 'acp-antigravity', appOnly: true })
})

test('X2: no acp-dsh, an agent without the app sign-in, or no such agent: no Antigravity row', async () => {
  for (const fake of [host(), cliHost({ agents: { 'acp-claude': {} } }), cliHost({ agents: { 'acp-antigravity': agyAgent({ appSignIn: undefined }) } })]) {
    assert.equal(await fake.row('antigravity'), undefined)
  }
  const fake = cliHost({ agents: { 'acp-antigravity': agyAgent() } })
  const row = await fake.row('antigravity')
  assert.deepEqual([row.ready, row.on, row.found, row.signIn, row.cli.appSignIn], [false, false, null, true, true])
  assert.equal(row.keyUrl, undefined)
  // Third, with the other CLI rows.
  assert.deepEqual((await fake.rows()).rows.slice(0, 3).map(item => item.id), ['claude', 'chatgpt', 'antigravity'])
})

test('X3: signed in and running is on; the ais row never carries the sign-in link or the paste-back values', async () => {
  const running = cliHost({ agents: { 'acp-antigravity': agyAgent({ signedIn: true }) }, acpEntry: { antigravity: true } })
  const on = await running.row('antigravity')
  assert.deepEqual([on.ready, on.on, on.found], [true, true, 'Signed in to Antigravity'])
  const restart = cliHost({ agents: { 'acp-antigravity': agyAgent({ signedIn: true, restartNeeded: true }) }, acpEntry: { antigravity: true } })
  assert.equal((await restart.row('antigravity')).on, false)
  // `ais` needs no viewer (G6-15): the link and the attempt stay in `acp`.
  const signing = cliHost({ agents: { 'acp-antigravity': agyAgent({ signingIn: true, signInUrl: AGY_LINK, signInAttempt: '0a1b2c3d-1111-2222-3333-444455556666',
    signInPaste: true, signInChecking: true, signInExpiresAt: 1_800_000_000_000, signInEnd: 'window', signInError: 'expired' }) }, acpEntry: { antigravity: true } })
  const row = await signing.row('antigravity')
  for (const field of ['signInUrl', 'signInAttempt', 'signInPaste', 'signInChecking', 'signInExpiresAt', 'signInEnd']) assert.equal(Object.hasOwn(row.cli, field), false, field)
  assert.equal(row.cli.appSignIn, true)
  assert.equal(row.cli.signingIn, true)
  assert.equal(row.cli.signInError, 'expired')
  assert.doesNotMatch(JSON.stringify(await signing.rows()), /accounts\.google\.com|s1-state-0001|0a1b2c3d/)
})

test('X4: on is refused until it is signed in; then only acp-dsh\'s switch moves, never a pi-ai route', async () => {
  const out = cliHost({ agents: { 'acp-antigravity': agyAgent() }, acpEntry: { antigravity: false } })
  assert.deepEqual((await out.handle('ai-switch', { id: 'antigravity', on: true })).error, { code: 'omni-ai/refused', message: 'Antigravity is not set up yet.' })
  assert.deepEqual(out.updates, [])
  // A pi-ai route literally named `undefined` is never touched.
  const fake = cliHost({ agents: { 'acp-antigravity': agyAgent({ signedIn: true }) }, acpEntry: { antigravity: false }, providers: { undefined: { apiKeyEnv: 'X' } } })
  assert.equal((await fake.handle('ai-switch', { id: 'antigravity', on: true })).value.on, true)
  assert.deepEqual(fake.updates.filter(update => update.ns === 'acp-dsh').map(update => update.patch), [{ antigravity: true }])
  assert.equal((await fake.handle('ai-switch', { id: 'antigravity', on: false })).value.on, false)
  assert.deepEqual(fake.updates.filter(update => update.ns === 'acp-dsh').map(update => update.patch), [{ antigravity: true }, { antigravity: false }])
  assert.deepEqual(fake.updates.filter(update => update.ns === 'llm-pi-ai'), [])
  assert.deepEqual(fake.valueOf('llm-pi-ai').providers, { undefined: { apiKeyEnv: 'X' } })
})

test('X5: dedupe for Antigravity hides nothing, and a dsh-subscriptions Antigravity keeps its models', async () => {
  const fake = cliHost({
    agents: { 'acp-antigravity': agyAgent({ signedIn: true }) }, acpEntry: { antigravity: true },
    entries: subsEntry([{ provider: 'antigravity', index: 1 }]),
    credentials: { ANTIGRAVITY_OAUTH_1: SECRET },
    services: { llm: llmWith({ antigravity: [{ id: 'gemini-3-pro' }] }) },
  })
  assert.deepEqual((await fake.handle('ai-dedupe', { id: 'antigravity' })).value, { hidden: [] })
  await fake.handle('ai-switch', { id: 'antigravity', on: true })
  assert.deepEqual(fake.updates.filter(update => update.ns === 'dsh-subscriptions'), [])
  assert.deepEqual(fake.valueOf('dsh-subscriptions').hiddenModels, [])
})

test('X6: a running Antigravity alone connects the step', async () => {
  const fake = cliHost({ agents: { 'acp-antigravity': agyAgent({ signedIn: true }) }, acpEntry: { antigravity: true } })
  assert.equal((await fake.handle('state')).value.aiConnected, true)
  const off = cliHost({ agents: { 'acp-antigravity': agyAgent({ signedIn: true }) }, acpEntry: { antigravity: false } })
  assert.equal((await off.handle('state')).value.aiConnected, false)
})
