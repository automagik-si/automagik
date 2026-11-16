// Consented sharing of a CLI sign-in (#869), on the Bot team's side: a CLI already signed in on
// this computer (the person's terminal) is used by Bots only after the person said so. The
// team over a fake DSH, with a stand-in for acp-dsh's `acpAgents` that keeps the consent as
// acp-dsh does (given, carried, needed). No CLI runs, and every identity is invented.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { cliAccountView } from '../src/host/cli-login.js'
import { createImageGen } from '../src/host/imagegen.js'
import { fallbackFor } from '../src/host/fallback.js'
import { install as installHook } from '../src/host/model-access-hooks.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/model-state.js'
import { ACCESS_MESSAGES, ACCOUNT_CONFIRM_REQUIRED, configured } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const bot = (id, model, extra = {}) => ({ id, sessionId: id, name: id, role: 'Work', instructions: '', createdAt: 1, model, ...extra })
const seed = bots => ({
  version: 1,
  mainBotIds: ['chief'],
  revision: 2,
  whaleStored: true,
  octopusStored: true,
  genieClayStored: true,
  claudeCodeMoved: true,
  bots: Object.fromEntries(bots.map(entry => [entry.id, entry])),
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
})
const TEAM = () => seed([
  bot('chief', 'deepseek/deepseek-v4-flash', { appliedModel: 'deepseek/deepseek-v4-flash' }),
  // A Bot that already runs on Claude Code, as a team made before this version has.
  bot('coder', 'acp-claude/default', { appliedModel: 'acp-claude/default' }),
])
const WORK = { kind: 'account', email: 'ana@work.example', org: 'Acme', plan: 'team' }
const SECRETS = ['ana@work.example', 'Acme', 'never-shown']
const NAMES = { 'acp-claude': 'Claude Code', 'acp-codex': 'Codex' }

// acp-dsh's service as the Bot team reads it. `state` is each agent's sign-in, consent and
// account, and can change while a test runs. `account`, `accountConfirm` and `accountNoticed`
// are absent from an older acp-dsh (`consented: false`).
function fakeAcp(rows = {}, { consented = true, bridge = false } = {}) {
  const state = { 'acp-claude': { signedIn: true }, 'acp-codex': { signedIn: true }, ...rows }
  const calls = []
  const box = { ctx: undefined }
  const rowOf = (id) => {
    const row = state[id]
    return {
      id,
      name: NAMES[id],
      on: true,
      cli: { found: true, state: 'ready' },
      connector: { state: 'ready' },
      model: { id: 'default', listed: true },
      ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn }),
      ...(row.signedIn === true && row.consent !== undefined ? { consent: row.consent } : {}),
    }
  }
  const service = {
    status: async () => { calls.push(['status']); return { agents: Object.keys(state).map(rowOf) } },
    inspect: async (id) => { calls.push(['inspect', id]); return rowOf(id) },
    loginStart: async (id, options) => { calls.push(['loginStart', id, options]); return { id, attemptId: 'attempt_000000000000000000000001', status: state[id].signedIn === true ? 'ready' : 'waiting', ...(state[id].signedIn === true ? {} : { expiresAt: Date.now() + 600_000, expiresBy: 'app', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }) } },
    loginCurrent: async () => undefined,
    loginTextMatches: () => false,
    // The per-session bridge answers (the one-time Claude move's own gate, acp-adoption.js).
    ...(bridge ? { bridge: () => ({ on: true, probesPass: true }), refresh: async () => undefined } : {}),
    ...(consented ? {
      account: async (id) => {
        calls.push(['account', id])
        const row = state[id]
        if (row.signedIn !== true) return { id, ...(typeof row.signedIn === 'boolean' ? { signedIn: row.signedIn } : {}) }
        return { id, signedIn: true, ...(row.consent ? { consent: row.consent } : {}), ref: row.ref ?? 'unknown', ...(row.account ? { account: { ...row.account, id: 'never-shown', token: 'never-shown' } } : {}), ...(row.notice ? { notice: true } : {}), token: 'never-shown' }
      },
      accountConfirm: async (id, { ref } = {}) => {
        calls.push(['accountConfirm', id, ref])
        const row = state[id]
        if (row.signedIn !== true) throw Object.assign(new Error('private: ana@work.example'), { code: 'acp-account/signed-out' })
        if (ref !== undefined && ref !== (row.ref ?? 'unknown')) throw Object.assign(new Error('private: ana@work.example'), { code: 'acp-account/changed' })
        row.consent = 'given'
        box.ctx.emit('acp-dsh/login-ready', { id })
        return { id, signedIn: true, consent: 'given' }
      },
      accountNoticed: (id) => { calls.push(['accountNoticed', id]); state[id].notice = false },
    } : {}),
  }
  return { state, calls, service, box, called: name => calls.filter(([what]) => what === name) }
}

async function start(team, { acp = fakeAcp(), providers = ['deepseek', 'acp-claude', 'acp-codex'], records = {}, defaultModel } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-consent-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({
    services: {
      settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 0, value: { providers: {} }, user: { providers: {} }, base: {} }] },
      credentials: {
        describeRecord: async key => (Object.hasOwn(records, key) ? { configured: true, kind: records[key], writable: true } : { configured: false, writable: true }),
        describe: async () => ({ configured: false, writable: true }),
      },
      acpAgents: acp.service,
      ...(defaultModel ? { agentDefaultModel: { currentSelection: () => defaultModel, saveSelection: async () => {} } } : {}),
    },
  })
  acp.box.ctx = ctx
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const models = Object.assign(Object.create(null), {
    deepseek: [{ id: 'deepseek-v4-flash' }],
    anthropic: [{ id: 'claude-opus-5-5' }],
    'openai-codex': [{ id: 'gpt-6.1-sol' }],
    'acp-codex': [{ id: 'default' }, { id: 'gpt-6.1-sol' }],
    'acp-claude': [{ id: 'default' }, { id: 'opus' }],
  })
  const selected = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => providers.map(id => ({ id, name: id })),
      listModels: async provider => models[provider] ?? [],
      resolveModelInfo: async () => ({}),
      listConfigurableProviders: () => ['openai-codex', 'anthropic', 'openai'].map(id => ({ provider: id, displayName: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {}, cancel() {} } }),
      selectModel: async (request) => { selected.push(request) },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [] },
  })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const disk = () => readFileSync(join(home, 'state.json'), 'utf8')
  const saved = () => JSON.parse(disk())
  // A turn about to open in a Bot's chat, through the team's own check (model-access-hooks.js)
  // over this runtime's modelAccess: what it yields, and whether the model was reached.
  const turn = async (botId) => {
    let stream
    installHook({ ctx: { on(name, listener) { if (name === 'llm/stream') stream = listener } }, isBotSession: id => rt.isBotSession(id), modelAccess: ref => rt.modelAccess(ref) })
    const [provider, ...rest] = rt.botOf(botId).model.split('/')
    let reached = false
    const next = () => { reached = true; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() }
    const events = await Array.fromAsync(stream({ provider, model: rest.join('/'), sessionId: rt.chatOf(botId), messages: [{ role: 'user', content: 'hello' }] }, next))
    return { events, reached, failure: events.at(-1)?.reason?.failure }
  }
  return { ctx, rt, call, selected, stop, disk, saved, turn, acp }
}

const unconfirmed = extra => ({ signedIn: true, consent: 'needed', ref: 'ref-work', account: WORK, ...extra })

test('T1, a terminal signed in to an account nobody confirmed: no Bot is put on it and nothing is written', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed() })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  const diskBefore = h.disk()
  const response = await h.call('update-bot', { id: 'chief', model: 'acp-claude/opus', name: 'Changed' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, ACCOUNT_CONFIRM_REQUIRED)
  assert.equal(response.error.message, ACCESS_MESSAGES.account.replace('{connection}', 'Claude Code (acp-claude)'))
  assert.equal(h.disk(), diskBefore, 'nothing written')
  assert.deepEqual(h.selected, [], 'no selection')
  await assert.rejects(h.rt.createBot({ name: 'No orphan', model: 'acp-claude/opus' }), { code: ACCOUNT_CONFIRM_REQUIRED })
  // Who it is never rides on a refusal, the team file or the state answer.
  const everything = JSON.stringify([response, h.saved(), (await h.call('state', {})).value, (await h.call('models', {})).value])
  for (const secret of SECRETS) assert.equal(everything.includes(secret), false, secret)
})

test('a refused turn: the Bot does not use the account, and no other model answers for it', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed() })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  const refused = await h.turn('coder')
  assert.equal(refused.reached, false, 'the agent is never reached: nothing is sent or billed')
  assert.equal(refused.events.length, 1)
  assert.equal(refused.failure.code, MODEL_ACCESS_REQUIRED)
  assert.equal(refused.failure.message, 'Confirm the account of Claude Code (acp-claude) before using this model.')
  for (const secret of SECRETS) assert.equal(refused.failure.message.includes(secret), false, secret)
  // The fallback model never takes this failure: only the person's word answers it.
  const failed = { provider: 'acp-claude', model: 'default' }
  assert.equal(fallbackFor({ failure: refused.failure, failed, fallback: { provider: 'deepseek', model: 'deepseek-v4-flash' } }), undefined)
  // Nor does DSH's retry policy, in a Bot's own Session (model-state.js stops the waterfall).
  let retried = 0
  const moved = []
  const sessionId = h.rt.chatOf('coder')
  const agent = { id: sessionId, session: { id: sessionId, requestHeader: () => ({ config: failed }) }, model: { current: () => ({ ...failed }), select: route => moved.push(route) } }
  const chain = h.ctx.listeners.get('agent/request-error') ?? []
  const run = index => (index >= chain.length ? (retried += 1, 'retry') : chain[index]({ failure: refused.failure, agent, signal: { aborted: false }, turn: 1, step: 1 }, () => run(index + 1)))
  assert.equal(await run(0), undefined)
  assert.equal(retried, 0)
  assert.deepEqual(moved, [], 'the Session is never moved to another model')
  // The Bot keeps its model: the pick is the person's, and it runs again once they confirm.
  assert.equal(h.saved().bots.coder.model, 'acp-claude/default')
  acp.state['acp-claude'].consent = 'given'
  const after = await h.turn('coder')
  assert.equal(after.reached, true)
  assert.deepEqual(after.events, [{ type: 'finish', reason: { kind: 'stop' } }])
})

test('upgrade: a carried vendor keeps answering, and so does one whose state acp-dsh cannot say', async (t) => {
  for (const [label, row] of [
    ['carried', { signedIn: true, consent: 'carried' }],
    ['carried, account not readable', { signedIn: true, consent: 'carried', ref: 'unknown' }],
    ['given', { signedIn: true, consent: 'given' }],
    ['an acp-dsh that says nothing of consent', { signedIn: true }],
    ['a sign-in that could not be read', { signedIn: undefined }],
  ]) {
    const h = await start(TEAM(), { acp: fakeAcp({ 'acp-claude': row }) })
    t.after(h.stop)
    await h.call('state', {})
    const turn = await h.turn('coder')
    assert.equal(turn.reached, true, label)
    assert.deepEqual(turn.events, [{ type: 'finish', reason: { kind: 'stop' } }], label)
    assert.equal((await h.call('update-bot', { id: 'chief', model: 'acp-claude/opus' })).ok, true, label)
    assert.equal(h.saved().bots.chief.model, 'acp-claude/opus', label)
  }
  // An acp-dsh from before this version (no account call at all) changes nothing either.
  const old = await start(TEAM(), { acp: fakeAcp({}, { consented: false }) })
  t.after(old.stop)
  await old.call('state', {})
  assert.equal((await old.turn('coder')).reached, true)
  const started = (await old.call('cli-login-start', { botId: 'chief', provider: 'acp-codex', model: 'acp-codex/default' })).value
  assert.equal(started.status, 'ready')
  assert.deepEqual((await old.call('cli-login-accounts', {})).value, { accounts: {} })
})

test('the menu still offers an unconfirmed agent, marked, and no Bot starts on it by default', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed(), 'acp-codex': { signedIn: true, consent: 'given' } })
  const h = await start(TEAM(), { acp, defaultModel: { provider: 'acp-claude', model: 'opus' } })
  t.after(h.stop)
  await h.call('state', {})
  const listed = await h.rt.catalog({ fresh: true })
  const claude = listed.filter(entry => entry.provider === 'acp-claude')
  assert.ok(claude.length > 0)
  assert.ok(claude.every(entry => entry.needsAccount === true && entry.needsSignIn !== true), 'offered, and marked as waiting for the account')
  assert.ok(listed.filter(entry => entry.provider === 'acp-codex').every(entry => entry.needsAccount === undefined))
  assert.ok(claude.every(entry => !configured(entry)))
  // DSH's own default is on the unconfirmed agent: a Bot's default goes elsewhere.
  assert.notEqual((await h.rt.defaultModel()).split('/')[0], 'acp-claude')
  // The client learns the mark changed (the state answer's models key).
  const before = (await h.call('state', {})).value.modelsKey
  acp.state['acp-claude'].consent = 'given'
  await h.rt.catalog({ fresh: true })
  assert.notEqual((await h.call('state', {})).value.modelsKey, before)
  assert.ok((await h.rt.catalog()).every(entry => entry.needsAccount === undefined))
})

test('the confirm step comes before any sign-in starts, shows the account, and applies the staged model', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed() })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  // The explicit entry with the model the person chose (company, then model, then level).
  const step = (await h.call('cli-login-start', { botId: 'chief', provider: 'acp-claude', model: 'acp-claude/opus' })).value
  assert.deepEqual(step, { id: 'acp-claude', status: 'confirm', account: { ref: 'ref-work', kind: 'account', email: 'ana@work.example', org: 'Acme', plan: 'team' }, choice: { ref: 'acp-claude/opus', state: 'pending' } })
  assert.deepEqual(acp.called('loginStart'), [], 'no sign-in is started, so the terminal\'s login is not replaced')
  assert.equal(h.saved().bots.chief.model, 'deepseek/deepseek-v4-flash', 'the model stays staged')
  // A view that only attaches reads the same step and stages nothing.
  const current = (await h.call('cli-login-current', { botId: 'coder', provider: 'acp-claude' })).value
  assert.deepEqual(current, { id: 'acp-claude', attempt: null, account: step.account })
  // "Use this account".
  const done = (await h.call('cli-login-confirm', { botId: 'chief', provider: 'acp-claude', ref: step.account.ref, model: 'acp-claude/opus' })).value
  assert.equal(done.status, 'ready')
  assert.deepEqual(acp.called('accountConfirm'), [['accountConfirm', 'acp-claude', 'ref-work']])
  await until(() => h.saved().bots.chief.model === 'acp-claude/opus', { label: 'the staged model was applied' })
  // The record is written before the update returns (roster.js saves, then goes on): the
  // outcome is known only once it has, so the view is read after that.
  await until(() => h.rt.cliLoginChoice('chief', 'acp-claude')?.state === 'applied', { label: 'the choice\'s outcome is known' })
  assert.deepEqual(h.selected.at(-1), { sessionId: h.rt.chatOf('chief'), provider: 'acp-claude', model: 'opus' })
  assert.deepEqual((await h.call('cli-login-current', { botId: 'chief', provider: 'acp-claude' })).value, { id: 'acp-claude', attempt: null, choice: { ref: 'acp-claude/opus', state: 'applied' } })
  // Only that Bot moved; the account never reached the team file.
  assert.equal(h.saved().bots.coder.model, 'acp-claude/default')
  for (const secret of SECRETS) assert.equal(h.disk().includes(secret), false, secret)
  assert.equal((await h.turn('chief')).reached, true)
})

test('while the staged model is being applied, the view still shows it as pending (#1039)', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed() })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  // The update lands on the record, then holds before it returns, as a slow selection or a
  // slow write does: the window between the model written and its outcome known.
  const updateBot = h.rt.updateBot
  let release
  const held = new Promise(resolve => { release = resolve })
  let written = false
  h.rt.updateBot = async (...args) => {
    const result = await updateBot(...args)
    written = true
    await held
    return result
  }
  await h.call('cli-login-start', { botId: 'chief', provider: 'acp-claude', model: 'acp-claude/opus' })
  const done = (await h.call('cli-login-confirm', { botId: 'chief', provider: 'acp-claude', ref: 'ref-work', model: 'acp-claude/opus' })).value
  assert.equal(done.status, 'ready')
  await until(() => written, { label: 'the staged model was written' })
  assert.equal(h.saved().bots.chief.model, 'acp-claude/opus')
  assert.deepEqual((await h.call('cli-login-current', { botId: 'chief', provider: 'acp-claude' })).value, { id: 'acp-claude', attempt: null, choice: { ref: 'acp-claude/opus', state: 'pending' } }, 'the choice never disappears from the view')
  release()
  await until(() => h.rt.cliLoginChoice('chief', 'acp-claude')?.state === 'applied', { label: 'the choice was applied' })
  assert.deepEqual((await h.call('cli-login-current', { botId: 'chief', provider: 'acp-claude' })).value, { id: 'acp-claude', attempt: null, choice: { ref: 'acp-claude/opus', state: 'applied' } })
})

test('confirm: another account signed in meanwhile, or none, takes nothing and says so by code', async (t) => {
  const acp = fakeAcp({ 'acp-claude': unconfirmed(), 'acp-codex': { signedIn: false } })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  acp.state['acp-claude'].ref = 'ref-other'
  const changed = await h.call('cli-login-confirm', { botId: 'chief', provider: 'acp-claude', ref: 'ref-work', model: 'acp-claude/opus' })
  assert.deepEqual([changed.error.code, changed.error.message], ['bot/account-changed', 'The account changed. Check it and confirm again.'])
  const out = await h.call('cli-login-confirm', { botId: 'chief', provider: 'acp-codex', ref: 'unknown' })
  assert.deepEqual([out.error.code, out.error.message], ['bot/account-signed-out', 'This coding agent is not signed in any more. Sign in to use it.'])
  // The CLI's own words (they may name the account) never reach the page.
  assert.equal(JSON.stringify([changed, out]).includes('ana@work.example'), false)
  assert.equal(acp.state['acp-claude'].consent, 'needed')
  assert.equal(h.saved().bots.chief.model, 'deepseek/deepseek-v4-flash')
  // A signed-out agent still gets the ordinary sign-in, with no confirm step.
  const started = (await h.call('cli-login-start', { botId: 'chief', provider: 'acp-codex', model: 'acp-codex/default' })).value
  assert.equal(started.status, 'waiting')
  assert.equal(acp.called('loginStart').length, 1)
  // Malformed requests are refused before acp-dsh is asked anything.
  const asked = acp.called('accountConfirm').length
  for (const payload of [
    { botId: 'chief', provider: 'acp-claude', ref: 'has space' },
    { botId: 'chief', provider: 'acp-claude', ref: 'ref-work', model: 'acp-codex/default' },
    { botId: 'chief', provider: 'other', ref: 'ref-work' },
    { botId: 'chief', provider: 'acp-claude', ref: 'ref-work', extra: true },
    { botId: 'gone', provider: 'acp-claude', ref: 'ref-work' },
  ]) assert.equal((await h.call('cli-login-confirm', payload)).ok, false, JSON.stringify(payload))
  assert.equal(acp.called('accountConfirm').length, asked)
})

test('an attempt that ends ready on a CLI already signed in is the confirm step, never "done"', async (t) => {
  // The account became unconfirmed between the check and the attempt (the check raced it).
  const acp = fakeAcp({ 'acp-codex': { signedIn: true, consent: 'given', ref: 'ref-work', account: WORK } })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  const account = acp.service.account
  let first = true
  acp.service.account = async (id) => {
    const seen = await account(id)
    if (first) { first = false; acp.state[id].consent = 'needed' }
    return seen
  }
  const step = (await h.call('cli-login-start', { botId: 'chief', provider: 'acp-codex', model: 'acp-codex/default' })).value
  assert.equal(acp.called('loginStart').length, 1)
  assert.equal(step.status, 'confirm')
  assert.equal(step.account.email, 'ana@work.example')
  assert.equal(h.saved().bots.chief.model, 'deepseek/deepseek-v4-flash')
})

test('#923: ChatGPT-plan Bots move to Codex only once its account is confirmed', async (t) => {
  const SOL = 'openai-codex/gpt-6.1-sol'
  const acp = fakeAcp({ 'acp-codex': unconfirmed() })
  const h = await start(seed([bot('chief', 'deepseek/deepseek-v4-flash'), bot('c1', SOL, { appliedModel: SOL })]), {
    acp, providers: ['deepseek', 'openai-codex', 'acp-codex'], records: { 'llm-pi-ai/openai-codex': 'grant' },
  })
  t.after(h.stop)
  await h.rt.moveSubscriptionBots()
  // Signed in, but nobody confirmed the account: the Bot stays where it answers today.
  assert.equal(h.saved().bots.c1.model, SOL)
  assert.equal(h.saved().subscriptionCliMoved, undefined)
  assert.deepEqual(h.selected, [])
  assert.deepEqual(h.rt.subscriptionWaitingView(), { subscriptionWaiting: { 'openai-codex': { to: 'acp-codex', cli: 'Codex', reason: 'account' } } })
  await h.rt.moveSubscriptionBots()
  assert.equal(h.saved().bots.c1.model, SOL)
  // The person's word: acp-dsh announces the agent ready, and the waiting Bots move.
  await h.call('cli-login-confirm', { botId: 'chief', provider: 'acp-codex', ref: 'ref-work' })
  await until(() => h.saved().bots.c1.model === 'acp-codex/gpt-6.1-sol', { label: 'the move ran once the account was confirmed' })
  assert.equal(h.saved().subscriptionCliMoved['openai-codex'], true)
  assert.deepEqual(h.rt.subscriptionWaitingView(), {})
})

test('#923: a carried Codex takes the waiting Bots as before', async (t) => {
  const SOL = 'openai-codex/gpt-6.1-sol'
  const acp = fakeAcp({ 'acp-codex': { signedIn: true, consent: 'carried' } })
  const h = await start(seed([bot('chief', 'deepseek/deepseek-v4-flash'), bot('c1', SOL, { appliedModel: SOL })]), {
    acp, providers: ['deepseek', 'openai-codex', 'acp-codex'], records: { 'llm-pi-ai/openai-codex': 'grant' },
  })
  t.after(h.stop)
  await h.rt.moveSubscriptionBots()
  assert.equal(h.saved().bots.c1.model, 'acp-codex/gpt-6.1-sol')
})

test('the one-time move of Claude Bots onto Claude Code waits for the account too', async (t) => {
  const OPUS = 'anthropic/claude-opus-5-5'
  const acp = fakeAcp({ 'acp-claude': unconfirmed() }, { bridge: true })
  const h = await start(seed([bot('chief', OPUS, { claudeCodeModel: 'claude-code/opus', appliedModel: OPUS })]), { acp, providers: ['anthropic', 'deepseek', 'acp-claude'] })
  t.after(h.stop)
  await h.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(h.saved().bots.chief.model, OPUS, 'the Bot stays where it answers today')
  assert.equal(h.saved().claudeAcpMoved, undefined)
  // The person's word, then acp-dsh publishes its routes again: the move runs.
  acp.state['acp-claude'].consent = 'given'
  h.ctx.emit('llm/adapters-updated')
  await until(() => h.saved().bots.chief.model === 'acp-claude/opus', { label: 'the move ran once the account was confirmed' })
  assert.equal(h.saved().claudeAcpMoved, true)
})

test('the one-time notice of a carried vendor: which sign-in the Bots use, acknowledged once', async (t) => {
  const acp = fakeAcp({
    'acp-claude': { signedIn: true, consent: 'carried', ref: 'ref-work', account: WORK, notice: true },
    'acp-codex': { signedIn: true, consent: 'given', ref: 'ref-home', account: { kind: 'account', email: 'ana@home.example' } },
  })
  const h = await start(TEAM(), { acp })
  t.after(h.stop)
  await h.call('state', {})
  const first = (await h.call('cli-login-accounts', {})).value
  assert.deepEqual(first, { accounts: {
    'acp-codex': { consent: 'given' },
    'acp-claude': { consent: 'carried', notice: true, account: { ref: 'ref-work', kind: 'account', email: 'ana@work.example', org: 'Acme', plan: 'team' } },
  } })
  // A consented vendor is not asked who it is: only the vendor that may be due its notice.
  assert.deepEqual(acp.called('account'), [['account', 'acp-claude']])
  assert.deepEqual((await h.call('cli-login-noticed', { provider: 'acp-claude' })).value, { id: 'acp-claude' })
  assert.deepEqual(acp.called('accountNoticed'), [['accountNoticed', 'acp-claude']])
  assert.deepEqual((await h.call('cli-login-accounts', {})).value.accounts['acp-claude'], { consent: 'carried' })
  assert.equal((await h.call('cli-login-noticed', { provider: 'other' })).ok, false)
  assert.equal((await h.call('cli-login-accounts', { extra: 1 })).ok, false)
  // The connections view says the state of the person's word, never who.
  const connections = (await h.call('cli-login-connections', {})).value.connections
  assert.equal(connections['acp-claude'].consent, 'carried')
  assert.equal(JSON.stringify(connections).includes('ana@'), false)
})

test('only the fields a confirm step shows leave acp-dsh\'s answer, each one bounded line', () => {
  assert.deepEqual(cliAccountView({ ref: 'ref-1', account: { kind: 'key', token: 'never-shown' }, token: 'never-shown' }), { ref: 'ref-1', kind: 'key' })
  assert.deepEqual(cliAccountView({ ref: 'bad ref', account: { kind: 'odd', email: `a@b.example\n${'x'.repeat(400)}`, org: 7, plan: '' } }), { ref: 'unknown', kind: 'account', email: `a@b.example${'x'.repeat(243)}` })
  assert.deepEqual(cliAccountView({ signedIn: true }), { ref: 'unknown' })
})

test('generate_image on a Codex account that waits for the person says so, and never starts Codex', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-account-images-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const codex = {
    imageAccess: async () => ({ ready: false, signedIn: true, reason: 'account' }),
    generateImage: async (request) => { calls.push(request); return { base64: '', mimeType: 'image/png' } },
  }
  const credentials = () => ({ readRecord: async () => undefined, modifyRecord: async () => undefined, resolve: async () => undefined })
  const images = createImageGen({ credentials, codex: () => codex, folder: () => dir })
  assert.equal(await images.access(), null)
  await assert.rejects(images.generate({ prompt: 'a fox', callId: 'acct' }), /has not confirmed its account for Bots.*confirm it in a Bot's chat/)
  assert.deepEqual(calls, [])
})

test('the carried notice is acknowledged from a window that only reads the team', async () => {
  const source = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const reads = source.match(/const READS = new Set\(\[([^\]]+)\]\)/)[1]
  // Machine state, not team state: the notice must not come back on every load there.
  assert.ok(reads.includes("'cli-login-noticed'"))
  assert.ok(reads.includes("'cli-login-accounts'"))
  // The person's word is given where the Bot's model can be applied.
  assert.equal(reads.includes("'cli-login-confirm'"), false)
})

test('an adapter event changes modelsKey even when every model id stays the same', async t => {
  const h = await start(TEAM())
  t.after(h.stop)
  const before = (await h.call('state', {})).value
  const ids = (await h.rt.catalog()).map(entry => entry.ref)
  h.ctx.emit('llm/adapters-updated')
  const after = (await h.call('state', {
    since: before.revision, models: before.modelsKey,
  })).value
  assert.notEqual(after.modelsKey, before.modelsKey)
  assert.notEqual(after.unchanged, true)
  assert.deepEqual((await h.rt.catalog()).map(entry => entry.ref), ids)
})
