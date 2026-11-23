// The Bot team's side of a CLI sign-in (cli-login.js, plan v3 2.3): the route to acp-dsh's
// attempt, the model chosen with the entry (rule 5) and the code guard. acp-dsh is a fake here.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RESERVATION_FILE } from '../src/host/account-reservations.js'
import { CALLBACK_REFUSED, CODE_HINT, cliLoginUrl, cliLoginView, install } from '../src/host/cli-login.js'
import { isSignInUrl as welcomeSignInUrl } from '../../welcome-dsh/src/host/sign-in-url.js'
import { CLAUDE, CODEX, reservationAcp } from './fixtures/account-reservations.js'

const ATTEMPT = randomUUID()
const CODEX_URL = 'https://auth.openai.com/codex/device'
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=expected_state_0123456789'
const settle = () => new Promise(resolve => setImmediate(resolve))
const nativeError = code => Object.assign(new Error('private-cli-output code#state and token-secret'), { code })

function fixture(reservationDeps) {
  const listeners = new Map()
  const warnings = []
  const updates = []
  const calls = []
  const bots = {
    a: { id: 'a', name: 'A', model: 'deepseek/v4' },
    b: { id: 'b', name: 'B', model: 'deepseek/v4' },
  }
  const attempts = new Map()
  const matches = new Set()
  const acp = {
    loginStart: async (id, options) => {
      calls.push(['start', id, options])
      if (!attempts.has(id)) attempts.set(id, { id, attemptId: ATTEMPT, status: 'waiting', expiresAt: 123456, expiresBy: 'app', openedBy: options.label, url: id === 'acp-codex' ? CODEX_URL : CLAUDE_URL, ...(id === 'acp-codex' ? { userCode: 'ABCD-1234' } : { prompt: { id: 'claude-code', secret: true } }) })
      return { ...attempts.get(id) }
    },
    loginCurrent: async (id) => { calls.push(['current', id]); return attempts.has(id) ? { ...attempts.get(id) } : undefined },
    loginStatus: async (id, attemptId) => {
      calls.push(['status', id, attemptId])
      if (attempts.get(id)?.attemptId !== attemptId) throw nativeError('acp-login/not-found')
      return { ...attempts.get(id) }
    },
    loginAnswer: async (id, attemptId, value) => {
      calls.push(['answer', id, attemptId, value])
      return { ...attempts.get(id), prompt: undefined, checking: true, value, stdout: value, token: 'token-secret', message: value }
    },
    loginCancel: async (id, attemptId) => { calls.push(['cancel', id, attemptId]); return { ...attempts.get(id), status: 'cancelled', url: undefined } },
    loginTextMatches: text => [...matches].some(state => text.includes(`#${state}`)),
    inspect: async id => ({ id, signedIn: id === 'acp-claude', on: true, cli: { found: true }, connector: { state: 'ready' } }),
  }
  const rt = {
    ctx: {
      get: name => (name === 'acpAgents' ? acp : undefined),
      on: (name, listener, options) => { listeners.set(name, [...(listeners.get(name) ?? []), { listener, options }]) },
    },
    botOf: id => bots[id],
    chatOwners: new Map([['chat-a', 'a'], ['chat-b', 'b']]),
    isBotSession: id => id === 'chat-a' || id === 'chat-b',
    roomOf: id => (id === 'room-1' ? { id: 'room-1' } : undefined),
    forgotten: [],
    forgetDelivery: exchangeId => rt.forgotten.push(exchangeId),
    delivered: [],
    deliver: async (args) => { rt.delivered.push(args); return 'exchange' },
    warn: (...args) => warnings.push(args),
    updateBot: async (id, patch) => {
      updates.push([id, patch])
      if (rt.refuse) throw Object.assign(new Error(rt.refuse), { code: 'bot/refused' })
      bots[id].model = patch.model
      return bots[id]
    },
  }
  install(rt, reservationDeps)
  const emit = (name, ...args) => (listeners.get(name) ?? []).map(({ listener }) => listener(...args))
  const actions = rt.cliLoginActions
  return { rt, acp, bots, calls, updates, warnings, listeners, emit, actions, matches, ready: async (id) => { emit('acp-dsh/login-ready', { id }); await settle() } }
}

test('isolated account controls use owner actions, sanitize identities and validate mutations',
  async () => {
    const h = fixture()
    h.acp.authScope = 'isolated'
    h.acp.status = async () => ({ agents: [] })
    h.acp.account = async () => ({ signedIn: true,
      account: { email: 'bot@example.test', token: 'never-forward' } })
    h.acp.terminalAccount = async () => ({
      account: { email: 'terminal@example.test', token: 'never-forward' } })
    const changed = []
    h.acp.accountSignOut = async (...args) => changed.push(['signout', ...args])
    h.acp.accountSwitch = async (...args) => changed.push(['switch', ...args])
    h.acp.accountReset = async (...args) => changed.push(['reset', ...args])
    const accounts = await h.actions['cli-login-accounts']({})
    assert.equal(accounts.accounts['acp-codex'].account.email, 'bot@example.test')
    assert.equal(accounts.accounts['acp-codex'].terminal.email, 'terminal@example.test')
    assert.doesNotMatch(JSON.stringify(accounts), /never-forward|token/)
    for (const action of ['signout', 'switch', 'reset']) {
      await h.actions[`cli-login-${action}`]({ botId: 'a', provider: 'acp-codex' })
      await assert.rejects(h.actions[`cli-login-${action}`]({
        botId: 'a', provider: 'acp-codex', home: '/untrusted',
      }), { code: 'bot/invalid' })
      await assert.rejects(h.actions[`cli-login-${action}`]({
        botId: 'a', provider: 'acp-hermes',
      }), { code: 'bot/invalid' })
    }
    assert.deepEqual(changed, [
      ['signout', 'acp-codex', { label: 'a' }], ['switch', 'acp-codex', { label: 'a' }],
      ['reset', 'acp-codex', { label: 'a' }],
    ])
    assert.deepEqual(h.updates, [])
  })

test('the account view names this installation, so a person can tell whose Bot sign-in it is', async () => {
  const h = fixture()
  h.acp.authScope = 'isolated'
  h.acp.account = async () => ({ signedIn: true, account: { email: 'bot@example.test' } })
  h.acp.terminalAccount = async () => undefined
  const read = () => h.actions['cli-login-accounts']({})
  // A host that does not say which installation it is keeps the old answer.
  assert.equal(Object.hasOwn(await read(), 'installation'), false)
  const get = h.rt.ctx.get
  h.rt.ctx.get = name => (name === 'profileContext' ? { name: ' desktop ' } : get(name))
  assert.equal((await read()).installation, 'desktop')
  // A name is a name: control characters go, an empty one is not shown at all.
  h.rt.ctx.get = name => (name === 'profileContext' ? { name: '\u0000 private\n' } : get(name))
  assert.equal((await read()).installation, 'private')
  h.rt.ctx.get = name => (name === 'profileContext' ? { name: ' \u0000 ' } : get(name))
  assert.equal((await read()).installation, undefined)
  // Asking the host for its profile must never fail the account read or echo why.
  h.rt.ctx.get = name => {
    if (name === 'profileContext') throw new Error('private-profile-path')
    return get(name)
  }
  const unnamed = await read()
  assert.equal(unnamed.installation, undefined)
  assert.doesNotMatch(JSON.stringify(unnamed), /private-profile-path/)
})

test('a refused account change says which refusal it was, never the CLI text', async () => {
  const h = fixture()
  h.acp.authScope = 'isolated'
  // acp-dsh's own fixed sentence is the more precise one: another live session holds it.
  h.acp.accountSignOut = async () => {
    throw Object.assign(new Error('Close other Automagik sessions before changing the Bot account.'), { code: 'acp-account/busy' })
  }
  await assert.rejects(h.actions['cli-login-signout']({ botId: 'a', provider: 'acp-codex' }), {
    code: 'bot/refused',
    message: 'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.',
  })
  // A host that carries only the code still names the reason, and the CLI's text never fits.
  h.acp.accountSignOut = async () => {
    throw Object.assign(new Error('private-cli-output token-secret'), { code: 'acp-account/busy' })
  }
  const error = await h.actions['cli-login-signout']({ botId: 'a', provider: 'acp-codex' }).catch(failure => failure)
  assert.equal(error.message, 'The Bot account is busy in another Automagik session on this computer. Close it, then press Sign in again.')
  assert.doesNotMatch(JSON.stringify({ message: error.message, code: error.code }), /private-cli-output|token-secret/)
  // A refusal this side has no sentence for keeps the card's own line.
  h.acp.accountSignOut = async () => {
    throw Object.assign(new Error('private-cli-output'), { code: 'acp-account/not-a-known-refusal' })
  }
  await assert.rejects(h.actions['cli-login-signout']({ botId: 'a', provider: 'acp-codex' }), {
    code: 'bot/refused',
    message: 'Account change failed. Close other app windows and try again.',
  })
})

test('any Bot view gets the live attempt back; the opener is only its label, and no owner capability exists', async () => {
  const h = fixture()
  const first = await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex' })
  assert.equal(first.attemptId, ATTEMPT)
  assert.equal(first.openedBy, 'a')
  assert.deepEqual(h.calls[0], ['start', 'acp-codex', { label: 'a' }])
  // A second window or another Bot: the same attempt, never busy.
  const second = await h.actions['cli-login-start']({ botId: 'b', provider: 'acp-codex' })
  assert.equal(second.attemptId, ATTEMPT)
  assert.equal(second.openedBy, 'a')
  assert.equal((await h.actions['cli-login-current']({ botId: 'b', provider: 'acp-codex' })).attempt.attemptId, ATTEMPT)
  assert.equal((await h.actions['cli-login-status']({ botId: 'b', provider: 'acp-codex', attemptId: ATTEMPT })).status, 'waiting')
  assert.deepEqual(await h.actions['cli-login-current']({ botId: 'a', provider: 'acp-claude' }), { id: 'acp-claude', attempt: null })
  // The experiment's per-tab owner capability is gone: the key is refused, not honoured.
  await assert.rejects(h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', owner: randomUUID() }), { code: 'bot/invalid' })
  assert.equal(h.calls.some(call => call[0] === 'cancel'), false, 'reading never cancels')
})

test('ready start and status name the account from one extra read without changing current', async () => {
  const h = fixture()
  const provider = 'acp-codex'
  const body = { botId: 'a', provider }
  const ready = { id: provider, attemptId: ATTEMPT, status: 'ready' }
  h.acp.loginStart = async () => ready
  h.acp.loginStatus = async () => ready
  h.acp.loginCurrent = async () => ready
  const reads = []
  h.acp.account = async id => {
    reads.push(id)
    return {
      id, signedIn: true, consent: 'given', authScope: 'isolated', ref: 'ref-work', token: 'private',
      account: { email: ' dev@example.test\n', org: 'Example', plan: 'team', token: 'private' },
    }
  }
  const result = {
    ...ready,
    signedInAs: { ref: 'ref-work', kind: 'account', email: 'dev@example.test', org: 'Example', plan: 'team' },
  }
  assert.deepEqual(await h.actions['cli-login-start'](body), result)
  assert.deepEqual(reads.splice(0), [provider, provider], 'the pre-start consent check and the ready read')
  assert.deepEqual(await h.actions['cli-login-status']({ ...body, attemptId: ATTEMPT }), result)
  assert.deepEqual(reads.splice(0), [provider])
  assert.deepEqual(await h.actions['cli-login-current'](body), { id: provider, attempt: ready })
  assert.deepEqual(reads, [])
})

test('the extra ready read uses the confirm shape when the account has pending consent', async () => {
  const h = fixture()
  const provider = 'acp-claude'
  const body = { botId: 'a', provider }
  const ready = { id: provider, attemptId: ATTEMPT, status: 'ready' }
  h.acp.loginStart = async () => ready
  h.acp.loginStatus = async () => ready
  h.acp.loginCurrent = async () => ready
  const confirm = {
    id: provider, status: 'confirm',
    account: { authScope: 'isolated', ref: 'ref-work', kind: 'account', email: 'dev@example.test' },
  }
  let consent = 'given'
  h.acp.account = async id => {
    const seen = { id, signedIn: true, authScope: 'isolated', consent, ref: 'ref-work', account: { email: 'dev@example.test' } }
    consent = 'needed'
    return seen
  }
  assert.deepEqual(await h.actions['cli-login-start'](body), confirm)
  assert.deepEqual(await h.actions['cli-login-status']({ ...body, attemptId: ATTEMPT }), confirm)
  h.acp.status = async () => ({ agents: [{ id: provider, signedIn: true, consent }] })
  assert.deepEqual(await h.actions['cli-login-current'](body), { id: provider, attempt: null, account: confirm.account })
})

test('a failed, mismatched or signed-out account read keeps the original ready view', async () => {
  const h = fixture()
  const provider = 'acp-codex'
  const body = { botId: 'a', provider }
  const ready = { id: provider, attemptId: ATTEMPT, status: 'ready' }
  h.acp.loginStart = async () => ready
  h.acp.loginStatus = async () => ready
  for (const read of [
    async () => { throw new Error('private account error') },
    async () => ({ id: 'acp-claude', signedIn: true, consent: 'needed' }),
    async () => ({ id: 'acp-claude', signedIn: true, consent: 'given' }),
    async () => ({ id: provider, signedIn: false }),
  ]) {
    h.acp.account = read
    assert.deepEqual(await h.actions['cli-login-start'](body), ready)
    assert.deepEqual(await h.actions['cli-login-status']({ ...body, attemptId: ATTEMPT }), ready)
  }
  assert.deepEqual(h.warnings, [])
})

test('starting, waiting and failed status polls never read the account', async () => {
  const h = fixture()
  const provider = 'acp-codex'
  const body = { botId: 'a', provider, attemptId: ATTEMPT }
  let reads = 0
  h.acp.account = async () => { reads++ }
  for (const status of ['starting', 'waiting', 'waiting', 'failed']) {
    h.acp.loginStatus = async () => ({ id: provider, attemptId: ATTEMPT, status })
    const view = await h.actions['cli-login-status'](body)
    assert.equal(view.status, status)
    assert.equal(Object.hasOwn(view, 'signedInAs'), false)
  }
  assert.equal(reads, 0)
})

test('the model chosen in Bot A is applied to A alone when the sign-in completes, even from B’s view', async () => {
  const h = fixture()
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  await h.actions['cli-login-start']({ botId: 'b', provider: 'acp-codex' })
  assert.deepEqual((await h.actions['cli-login-current']({ botId: 'a', provider: 'acp-codex' })).attempt.choice, { ref: 'acp-codex/default', state: 'pending' })
  assert.equal((await h.actions['cli-login-current']({ botId: 'b', provider: 'acp-codex' })).attempt.choice, undefined)
  await h.ready('acp-codex')
  assert.deepEqual(h.updates, [['a', { model: 'acp-codex/default' }]])
  assert.equal(h.bots.a.model, 'acp-codex/default')
  assert.equal(h.bots.b.model, 'deepseek/v4')
  assert.deepEqual((await h.actions['cli-login-current']({ botId: 'a', provider: 'acp-codex' })).attempt.choice, { ref: 'acp-codex/default', state: 'applied' })
  // Another ready (a later sign-in) changes nothing: the choice was used once.
  await h.ready('acp-codex')
  assert.equal(h.updates.length, 1)
})

test('a reloaded entry for the same Bot is applied once; Claude and Codex choices are kept apart', async () => {
  const h = fixture()
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  await h.ready('acp-claude')
  assert.equal(h.updates.length, 0, 'a Claude sign-in applies no Codex choice')
  await h.ready('acp-codex')
  assert.deepEqual(h.updates, [['a', { model: 'acp-codex/default' }]])
})

test('a choice is dropped when the Bot’s model changes, a turn runs on another model, or a newer choice is made', async () => {
  const changed = fixture()
  await changed.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  changed.bots.a.model = 'openai/gpt-x'
  await changed.ready('acp-codex')
  assert.deepEqual(changed.updates, [])
  assert.equal(changed.bots.a.model, 'openai/gpt-x')

  const turned = fixture()
  await turned.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  // A turn on the model the Bot was on does not drop it; one on another model does.
  turned.emit('session/event', { id: 'chat-a' }, { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'v4' } } } })
  turned.emit('session/event', { id: 'chat-b' }, { type: 'request/header', data: { header: { config: { provider: 'openai', model: 'gpt-x' } } } })
  assert.equal(turned.rt.cliLoginChoice('a', 'acp-codex').state, 'pending')
  turned.emit('session/event', { id: 'chat-a' }, { type: 'request/header', data: { header: { config: { provider: 'openai', model: 'gpt-x' } } } })
  await turned.ready('acp-codex')
  assert.deepEqual(turned.updates, [])

  const newer = fixture()
  await newer.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  await newer.actions['cli-login-start']({ botId: 'a', provider: 'acp-claude', model: 'acp-claude/default' })
  await newer.ready('acp-codex')
  assert.deepEqual(newer.updates, [], 'the Codex choice is no longer the latest for A')
  await newer.ready('acp-claude')
  assert.deepEqual(newer.updates, [['a', { model: 'acp-claude/default' }]])
})

test('a choice that cannot be applied says why and which model the Bot stays on', async () => {
  const h = fixture()
  h.rt.refuse = 'Turn on Codex CLI (acp-codex) in Settings → Claude Code and Codex before using this model.'
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex', model: 'acp-codex/default' })
  await h.ready('acp-codex')
  const choice = (await h.actions['cli-login-current']({ botId: 'a', provider: 'acp-codex' })).attempt.choice
  assert.deepEqual(choice, { ref: 'acp-codex/default', state: 'failed', message: h.rt.refuse, kept: 'deepseek/v4' })
  assert.equal(h.bots.a.model, 'deepseek/v4')
})

test('only a Bot signs in; malformed requests and models of another agent never reach acp-dsh', async () => {
  const h = fixture()
  await assert.rejects(h.actions['cli-login-start']({ botId: 'gone', provider: 'acp-codex' }), { code: 'bot/not-found' })
  for (const payload of [null, [], {}, { botId: 'a', provider: 'openai-codex' }, { botId: 'a', provider: 'acp-codex', command: 'bash' }, { botId: '../a', provider: 'acp-codex' }, { botId: 'a', provider: 'acp-codex', model: 'acp-claude/default' }, { botId: 'a', provider: 'acp-codex', model: 'no-slash' }, { botId: 'a', provider: 'acp-codex', attemptId: ATTEMPT }]) {
    await assert.rejects(h.actions['cli-login-start'](payload), { code: 'bot/invalid' })
  }
  for (const attemptId of ['', 'short', 'x'.repeat(129), undefined]) {
    await assert.rejects(h.actions['cli-login-status']({ botId: 'a', provider: 'acp-codex', attemptId }), { code: 'bot/invalid' })
  }
  assert.equal(h.calls.length, 0)
  // A removed Bot's view can still cancel: the attempt is the CLI's.
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex' })
  delete h.bots.a
  assert.equal((await h.actions['cli-login-cancel']({ botId: 'a', provider: 'acp-codex', attemptId: ATTEMPT })).status, 'cancelled')
})

test('only a bounded single code is accepted, and no reply or failure ever echoes it or the CLI output', async () => {
  const h = fixture()
  await h.actions['cli-login-start']({ botId: 'a', provider: 'acp-claude' })
  for (const value of ['', 'code\ncommand', 'code state', 'code\0state', '\u001b[31mcode', 'x'.repeat(8193), { code: 'private' }]) {
    await assert.rejects(h.actions['cli-login-answer']({ botId: 'a', provider: 'acp-claude', attemptId: ATTEMPT, value }), error => error.code === 'bot/invalid' && error.message === CODE_HINT)
  }
  const reply = await h.actions['cli-login-answer']({ botId: 'a', provider: 'acp-claude', attemptId: ATTEMPT, value: 'authorization-code#expected_state_0123456789' })
  assert.equal(reply.checking, true)
  assert.doesNotMatch(JSON.stringify(reply), /authorization-code|token-secret|stdout/)
  const codes = { 'acp-login/not-found': 'bot/login-ended', 'acp-login/disposed': 'bot/login-restarted' }
  for (const code of ['acp-login/invalid', 'acp-login/not-found', 'acp-login/disposed', 'EACCES', '__proto__', undefined]) {
    h.acp.loginStart = async () => { throw nativeError(code) }
    await assert.rejects(h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex' }), error => error.code === (Object.hasOwn(codes, code ?? '') ? codes[code] : 'bot/refused') && !/private-cli-output|token-secret|code#state/.test(error.stack))
  }
  delete h.acp.loginStart
  await assert.rejects(h.actions['cli-login-start']({ botId: 'a', provider: 'acp-codex' }), error => error.code === 'bot/refused' && /installation/.test(error.message))
})

test('public views keep the official links only, a fixed code label, and an optional expiry', () => {
  const value = cliLoginView({ id: 'acp-claude', attemptId: ATTEMPT, status: 'waiting', expiresAt: 5, expiresBy: 'provider', openedBy: 'a', url: CLAUDE_URL, prompt: { id: 'oauth-code', secret: true, label: 'private-cli-output' }, userCode: 'ABCD-EFGH', raw: 'private-cli-output', token: 'token-secret', message: 'private-cli-output' }, 'acp-claude')
  assert.deepEqual(value, { id: 'acp-claude', attemptId: ATTEMPT, status: 'waiting', expiresAt: 5, expiresBy: 'provider', openedBy: 'a', url: CLAUDE_URL, prompt: { id: 'oauth-code', label: 'Authorization code', secret: true } })
  assert.equal(cliLoginView({ id: 'acp-codex', attemptId: ATTEMPT, status: 'starting' }, 'acp-codex').expiresAt, undefined)
  assert.throws(() => cliLoginView({ id: 'acp-claude', attemptId: ATTEMPT, status: 'waiting', url: 'https://claude.com/cai/oauth/authorize?state=expected_state_0123456789' }, 'acp-claude'), { code: 'bot/refused' })
  assert.equal(cliLoginUrl('https://claude.com/cai/oauth/authorize?state=x', 'acp-claude'), undefined, 'no manual code, no link')
  assert.equal(cliLoginUrl(CODEX_URL, 'acp-codex'), CODEX_URL)
  assert.equal(cliLoginView({ id: 'acp-codex', attemptId: ATTEMPT, status: 'failed', message: 'Install the CLI before signing in. private-token' }, 'acp-codex').message, 'Sign-in did not finish. Try again.')
})

test('a failed attempt says why, from acp-dsh’s fixed cause, and never from CLI text', () => {
  const failed = (extra, provider = 'acp-claude') => ({ id: provider, attemptId: ATTEMPT, status: 'failed', message: 'private-cli-output', ...extra })
  const message = (value, provider = 'acp-claude') => cliLoginView(value, provider).message
  // Every cause acp-dsh’s closed set can carry, one case each.
  const CODEX_ONLY = 'Codex device sign-in is unavailable. Enable device-code login in ChatGPT security settings or workspace permissions, then try again.'
  const CODEX_START = 'Codex could not start device sign-in. Check your connection and device-code login permissions in ChatGPT, then try again.'
  const byCause = new Map([
    ['no CLI found', 'The coding agent is not ready yet. Check its installation in Settings → Claude Code and Codex, then try again.'],
    ['no sign-in link in time', 'The CLI did not offer a sign-in link in time. Try again.'],
    ['the CLI could not be started', 'The CLI could not be started. Run it once in a terminal, then try again.'],
    ['unsupported sign-in link', 'The CLI returned an old sign-in link. Update it, then try again.'],
    ['short sign-in link unsupported', 'The CLI returned a short sign-in link Automagik cannot use yet. Update Automagik, then try again.'],
    ['the CLI did not confirm the sign-in', 'The CLI did not confirm the sign-in. Try again.'],
    ['the CLI exited', 'The CLI exited before the sign-in finished. Try again.'],
    ['unknown', 'Sign-in did not finish. Try again.'],
  ])
  for (const [cause, sentence] of byCause) {
    assert.equal(message(failed({ cause })), sentence, cause)
    // The same sentence on the other agent: the closed set is not the provider's.
    assert.equal(message(failed({ cause }, 'acp-codex'), 'acp-codex'), sentence, cause)
  }
  // The two device causes belong to Codex, and only Codex gets their sentences.
  assert.equal(message(failed({ cause: 'device-code login is not enabled' }, 'acp-codex'), 'acp-codex'), CODEX_ONLY)
  assert.equal(message(failed({ cause: 'device sign-in did not start' }, 'acp-codex'), 'acp-codex'), CODEX_START)
  for (const device of ['device-code login is not enabled', 'device sign-in did not start']) {
    assert.equal(message(failed({ cause: device })), 'Sign-in did not finish. Try again.', device)
  }
  // A host from before the cause existed still gets the two it already knew; anything else keeps
  // the one line, and an unknown cause never becomes a message.
  assert.equal(message(failed({ message: 'Install the CLI before signing in.' })), 'The coding agent is not ready yet. Check its installation in Settings → Claude Code and Codex, then try again.')
  assert.equal(message(failed({ message: CODEX_ONLY }, 'acp-codex'), 'acp-codex'), CODEX_ONLY)
  assert.equal(message(failed({ cause: 'private-cli-output says no' })), 'Sign-in did not finish. Try again.')
  assert.doesNotMatch(message(failed({ cause: 'private-cli-output says no' })), /private-cli-output/)
})

test('connections read each CLI’s sign-in through inspect only', async () => {
  const h = fixture()
  const value = await h.actions['cli-login-connections']({})
  assert.equal(value.available, true)
  assert.equal(value.connections['acp-claude'].signedIn, true)
  assert.equal(value.connections['acp-codex'].signedIn, false)
  await assert.rejects(h.actions['cli-login-connections']({ extra: 1 }), { code: 'bot/invalid' })
})

test('a Bot step drops a message carrying a shown sign-in state before any model call, and keeps the rest', () => {
  const h = fixture()
  h.matches.add('expected_state_0123456789')
  assert.equal(h.listeners.get('agent/pre-step'), undefined, 'parts.js calls it from its own pre-step, first')
  const message = text => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }] })
  const kept = message('hello there')
  const secret = message('code-abc#expected_state_0123456789')
  const payload = { agent: { id: 'chat-a' }, messages: [kept, secret] }
  const claimed = payload.messages
  h.rt.dropLoginCodes(payload)
  assert.deepEqual(claimed, [kept], 'the claimed batch itself loses the message, so no later listener carries it')
  assert.equal(h.warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(h.warnings), /expected_state|code-abc/)
  // Not a Bot's Session: DSH's own handling.
  const other = { agent: { id: 'plain' }, messages: [message('code-abc#expected_state_0123456789')] }
  h.rt.dropLoginCodes(other)
  assert.equal(other.messages.length, 1)
  assert.equal(h.rt.loginTextMatches('x#expected_state_0123456789'), true)
  assert.equal(h.rt.loginTextMatches('nothing'), false)
})

test('a group’s own Session drops a pasted code too, and a dropped delivery forgets its resend note', () => {
  const h = fixture()
  h.matches.add('expected_state_0123456789')
  const secret = (source) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'code-abc#expected_state_0123456789' }], ...(source ? { source } : {}) })
  const room = { agent: { id: 'room-1' }, messages: [secret({ kind: 'user' })] }
  h.rt.dropLoginCodes(room)
  assert.deepEqual(room.messages, [], 'what the person typed in a group never reaches group_relay or its members')
  assert.deepEqual(h.rt.forgotten, [])
  const relayed = { agent: { id: 'chat-b' }, messages: [secret({ kind: 'bot', exchangeId: 'exchange-1' })] }
  h.rt.dropLoginCodes(relayed)
  assert.deepEqual(relayed.messages, [])
  assert.deepEqual(h.rt.forgotten, ['exchange-1'], 'nothing is left to resend after a restart')
  assert.doesNotMatch(JSON.stringify(h.warnings), /expected_state|code-abc/)
})

test('a delivery that carries a shown code is refused before it is noted or sent', async () => {
  const h = fixture()
  h.matches.add('expected_state_0123456789')
  await assert.rejects(h.rt.deliver({ toId: 'b', role: 'room', text: 'pasted code-abc#expected_state_0123456789' }), { code: 'bot/refused' })
  assert.deepEqual(h.rt.delivered, [])
  assert.equal(await h.rt.deliver({ toId: 'b', role: 'room', text: 'hello' }), 'exchange')
  assert.equal(h.rt.delivered.length, 1)
  assert.doesNotMatch(JSON.stringify(h.warnings), /expected_state|code-abc/)
})

function reservationHost(t, { authScope = 'isolated' } = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), 'automagik-reservation-host-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const path = join(home, RESERVATION_FILE)
  let instance = 'test-instance'
  const h = fixture({
    path, fs, pid: process.pid,
    random: (size, encoding) => randomBytes(size).toString(encoding),
    decodeKey: key => Buffer.from(key, 'base64url'),
    instanceId: () => instance,
  })
  h.rt.holdsLock = () => true
  h.rt.readOnly = () => undefined
  const fake = reservationAcp({ authScope })
  Object.assign(h.acp, fake.service)
  return { ...h, ...fake, path,
    setInstance: value => { instance = value },
    list: () => h.actions['cli-login-accounts']({ reservations: true }),
    reserve: (offer, label) => h.actions['cli-login-reserve']({ ...offer, label }),
  }
}

test('the start-up notice list asks for no reservation evidence; only the card does', async t => {
  for (const authScope of ['isolated', 'consent']) {
    const h = reservationHost(t, { authScope })
    const plain = await h.actions['cli-login-accounts']({})
    assert.equal(h.calls.filter(([kind]) => kind === 'evidence').length, 0, authScope)
    for (const entry of Object.values(plain.accounts)) assert.equal(entry.reservation, undefined, authScope)
    await assert.rejects(h.actions['cli-login-accounts']({ reservations: false }), { code: 'bot/invalid' })
    await assert.rejects(h.actions['cli-login-accounts']({ reservations: true, other: 1 }), { code: 'bot/invalid' })
  }
})

test('only complete, coherent vendor observations produce opaque offers', async t => {
  const h = reservationHost(t)
  const read = h.acp.accountEvidence
  const keyAndDigests = []
  h.acp.accountEvidence = async (id, options) => {
    const seen = await read(id, options)
    keyAndDigests.push(options.key.toString('base64url'), seen.exact, seen.loose)
    return seen
  }
  const complete = await h.list()
  assert.deepEqual(h.calls, [
    ['account', CODEX, { fresh: true }], ['evidence', CODEX],
    ['account', CLAUDE, { fresh: true }], ['evidence', CLAUDE],
  ])
  const codex = complete.accounts[CODEX]
  assert.equal(codex.account.email, 'private-codex@example.test')
  assert.deepEqual(codex.reservation, { state: 'complete', claims: [], scope: 'personal',
    offer: { offerId: codex.reservation.offer.offerId } })
  assert.match(codex.reservation.offer.offerId, /^[\w-]{22}$/)
  assert.doesNotMatch(JSON.stringify(codex.reservation), /email|org|plan|digest|key|private|ref/)
  for (const value of keyAndDigests) assert.equal(JSON.stringify(complete).includes(value), false)

  for (const override of [
    { id: CLAUDE }, { vendor: 'claude' }, { ref: 'other-ref' }, { ref: 'unknown' },
    { exact: 'short' }, { loose: '*'.repeat(43) }, { reservable: false }, { class: 'workspace' },
  ]) {
    h.acp.accountEvidence = async (id, options) => ({
      ...await read(id, options), ...(id === CODEX ? override : {}),
    })
    const { accounts } = await h.list()
    assert.deepEqual(accounts[CODEX].reservation, { state: 'changed', claims: [] })
    assert.ok(accounts[CLAUDE].reservation.offer, 'a failed Codex read leaves Claude available')
  }
  assert.equal(fs.existsSync(h.path), false)
})

test('reservation card states bound R2 outcomes and show consent-mode sign-ins', async t => {
  const h = reservationHost(t, { authScope: 'consent' })
  h.accounts[CLAUDE].consent = 'carried'
  h.accounts[CLAUDE].notice = true
  const read = h.acp.accountEvidence
  const first = (await h.list()).accounts
  assert.equal(first[CLAUDE].notice, true)
  assert.equal(first[CLAUDE].consent, 'carried')
  assert.equal(first[CODEX].consent, 'given')
  assert.ok(first[CLAUDE].reservation.offer)
  assert.ok(first[CODEX].reservation.offer)
  await h.reserve(first[CLAUDE].reservation.offer, 'Account project')

  for (const [answer, state, why] of [
    [{ supported: false }, 'unsupported'],
    [{ signedIn: false }, 'signed-out'],
    [{}, 'unknown'],
    [{ recoveryRequired: true }, 'recovery'],
    [{ signedIn: true, outcome: 'changed' }, 'changed'],
    [{ signedIn: true, outcome: 'unread' }, 'unread'],
    [{ signedIn: true, outcome: 'ambiguous', why: 'no-organisation' }, 'not-reservable', 'no-organisation'],
    [{ signedIn: true, outcome: 'ambiguous', why: 'unknown-plan' }, 'not-reservable', 'unknown-plan'],
    [{ signedIn: true, outcome: 'none', why: 'not-a-subscription' }, 'not-reservable', 'not-a-subscription'],
    [{ signedIn: true, outcome: 'none', why: 'no-email' }, 'not-reservable', 'no-email'],
    [{ signedIn: true, outcome: 'none', why: 'private-token' }, 'not-reservable'],
    [new Error('private CLI output'), 'unread'],
  ]) {
    h.acp.accountEvidence = async (id, options) => {
      if (id !== CLAUDE) return read(id, options)
      if (answer instanceof Error) throw answer
      return { id, ...answer }
    }
    const { accounts } = await h.list()
    const { reservation } = accounts[CLAUDE]
    assert.deepEqual(reservation, { state,
      claims: [{ ...firstClaim(reservation), label: 'Account project', current: false, mine: true }],
      ...(why ? { why } : {}),
    })
    assert.doesNotMatch(JSON.stringify(reservation), /private-token|private CLI output/)
    assert.equal(accounts[CLAUDE].notice, true)
    assert.ok(accounts[CODEX].reservation.offer)
  }
  delete h.acp.accountEvidence
  assert.equal((await h.list()).accounts[CLAUDE].reservation.state, 'unsupported')
})

const firstClaim = ({ claims: [{ claimId, rev }] }) => ({ claimId, rev })

test('fresh refusals leave the record untouched and Plus to Pro still reserves the same account', async t => {
  const h = reservationHost(t)
  const read = h.acp.accountEvidence
  const initial = (await h.list()).accounts
  await h.reserve(initial[CLAUDE].reservation.offer, 'Claude project')
  const original = fs.readFileSync(h.path, 'utf8')
  const { offer } = (await h.list()).accounts[CODEX].reservation

  for (const instance of [undefined, '', 'x'.repeat(4097), '\u0000', '\ud800']) {
    h.setInstance(instance)
    assert.equal((await h.list()).accounts[CODEX].reservation.state, 'no-instance')
    await assert.rejects(h.reserve(offer, 'Codex project'), { code: 'bot/reservation-no-instance' })
    assert.equal(fs.readFileSync(h.path, 'utf8'), original)
  }
  h.setInstance('test-instance')
  for (const [answer, state] of [
    [{ signedIn: false }, 'signed-out'],
    [{ signedIn: true, outcome: 'ambiguous', why: 'unknown-plan' }, 'not-reservable'],
    [{ signedIn: true, outcome: 'unread' }, 'unread'],
    [{ signedIn: true, outcome: 'changed' }, 'changed'],
  ]) {
    h.acp.accountEvidence = async id => ({ id, ...answer })
    await assert.rejects(h.reserve(offer, 'Codex project'), { code: `bot/reservation-${state}` })
    assert.equal(fs.readFileSync(h.path, 'utf8'), original)
  }
  h.acp.accountEvidence = read
  h.accounts[CODEX].plan = 'team'
  h.accounts[CODEX].class = 'workspace'
  await assert.rejects(h.reserve(offer, 'Codex project'), { code: 'bot/reservation-changed' })
  assert.equal(fs.readFileSync(h.path, 'utf8'), original)

  h.accounts[CODEX].plan = 'pro'
  h.accounts[CODEX].class = 'personal'
  const result = await h.reserve(offer, 'Codex project')
  assert.equal(result.claims[0].label, 'Codex project')
  assert.equal(result.scope, 'personal')
  assert.deepEqual(h.calls.filter(([method]) => ['switch', 'signout', 'reset'].includes(method)), [])
})

// ---- Antigravity in a Bot's chat (#2048, r6 parity) ------------------------------------------

const AGY = 'acp-antigravity'
const AGY_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=s1-state-0001'
const PASTED = 'http://localhost:41234/auth/callback?code=4%2F0Abc-secret&state=s1-state-0001'
function agyFixture() {
  const h = fixture()
  const attempt = { id: AGY, attemptId: ATTEMPT, status: 'waiting', expiresAt: 123456, expiresBy: 'app', url: AGY_URL, prompt: { id: 'agy-callback', secret: true } }
  h.acp.loginStart = async (id, options) => { h.calls.push(['start', id, options]); return { ...attempt, openedBy: options.label } }
  h.acp.loginCurrent = async (id) => { h.calls.push(['current', id]); return id === AGY ? { ...attempt } : undefined }
  h.acp.loginStatus = async (id, attemptId) => { h.calls.push(['status', id, attemptId]); return { ...attempt } }
  h.acp.loginAnswer = async (id, attemptId, value) => { h.calls.push(['answer', id, attemptId, value]); return { ...attempt, prompt: undefined, checking: true } }
  h.acp.loginCancel = async (id, attemptId) => { h.calls.push(['cancel', id, attemptId]); return { id, attemptId, status: 'cancelled' } }
  h.acp.account = async () => assert.fail('Antigravity has no account read')
  return h
}

test('Antigravity\'s link: Google\'s own, with agy\'s loopback return and its state, the same rule as the welcome\'s', () => {
  const back = (value) => {
    const url = new URL(AGY_URL)
    url.searchParams.set('redirect_uri', value)
    return url.href
  }
  const cases = [
    AGY_URL, AGY_URL.replace('/v2/auth', '/auth'), back('http://127.0.0.1:4242/cb'), back('http://[::1]:5000/cb'),
    AGY_URL.replace('https:', 'http:'), AGY_URL.replace('accounts.google.com', 'evil.example'), AGY_URL.replace('response_type=code', 'response_type=token'),
    AGY_URL.replace('state=s1-state-0001', 'state=short'), AGY_URL.replace('&state=s1-state-0001', ''), `${AGY_URL}&state=again-0001`,
    back('http://localhost:1023/cb'), back('http://localhost/cb'), back('https://localhost:41234/cb'), back('http://evil.example:41234/cb'),
    `${AGY_URL}#x`, `${AGY_URL} x`, CLAUDE_URL, CODEX_URL,
  ]
  for (const value of cases) {
    assert.equal(cliLoginUrl(value, AGY) === value, welcomeSignInUrl(value), value)
  }
  assert.equal(cliLoginUrl(AGY_URL, AGY), AGY_URL)
  // Each agent keeps its own rule: Google's link is no Claude or Codex link, and back.
  assert.equal(cliLoginUrl(AGY_URL, 'acp-claude'), undefined)
  assert.equal(cliLoginUrl(CLAUDE_URL, AGY), undefined)
})

test('Antigravity\'s view: the link, its expiry and the field for the address, labelled Sign-in address', () => {
  const view = cliLoginView({ id: AGY, attemptId: ATTEMPT, status: 'waiting', expiresAt: 5, expiresBy: 'app', url: AGY_URL, prompt: { id: 'agy-callback', secret: true, label: 'private' }, raw: 'private' }, AGY)
  assert.deepEqual(view, { id: AGY, attemptId: ATTEMPT, status: 'waiting', expiresAt: 5, expiresBy: 'app', url: AGY_URL, prompt: { id: 'agy-callback', label: 'Sign-in address', secret: true } })
  assert.equal(cliLoginView({ id: AGY, attemptId: ATTEMPT, status: 'waiting', url: AGY_URL, prompt: { id: 'claude-code', secret: true } }, AGY).prompt, undefined)
  assert.equal(cliLoginView({ id: AGY, attemptId: ATTEMPT, status: 'waiting', checking: true }, AGY).checking, true)
  assert.throws(() => cliLoginView({ id: AGY, attemptId: ATTEMPT, status: 'waiting', url: CLAUDE_URL }, AGY), { code: 'bot/refused' })
  // Claude's field keeps its own label.
  assert.equal(cliLoginView({ id: 'acp-claude', attemptId: ATTEMPT, status: 'waiting', url: CLAUDE_URL, prompt: { id: 'claude-code', secret: true } }, 'acp-claude').prompt.label, 'Authorization code')
})

test('Antigravity reaches acp-dsh through the five sign-in calls; the address is trimmed and never echoed', async () => {
  const h = agyFixture()
  const started = await h.actions['cli-login-start']({ botId: 'a', provider: AGY, model: `${AGY}/default` })
  assert.deepEqual(started.prompt, { id: 'agy-callback', label: 'Sign-in address', secret: true })
  assert.equal((await h.actions['cli-login-current']({ botId: 'a', provider: AGY })).attempt.url, AGY_URL)
  assert.equal((await h.actions['cli-login-status']({ botId: 'a', provider: AGY, attemptId: ATTEMPT })).status, 'waiting')
  const answered = await h.actions['cli-login-answer']({ botId: 'a', provider: AGY, attemptId: ATTEMPT, value: `  ${PASTED}\n` })
  assert.equal(answered.checking, true)
  assert.doesNotMatch(JSON.stringify(answered), /secret/)
  assert.equal((await h.actions['cli-login-cancel']({ botId: 'a', provider: AGY, attemptId: ATTEMPT })).status, 'cancelled')
  assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [['start', AGY], ['current', AGY], ['status', AGY], ['answer', AGY], ['cancel', AGY]])
  assert.equal(h.calls.find(call => call[0] === 'answer')[3], PASTED)
  // Not printable inside: the owner's sentence, and acp-dsh is not asked.
  for (const value of ['', '   ', 'http://localhost:1/a b', 'http://x\u0007', 'x'.repeat(8193), { url: PASTED }]) {
    await assert.rejects(h.actions['cli-login-answer']({ botId: 'a', provider: AGY, attemptId: ATTEMPT, value }), error => error.code === 'bot/invalid' && error.message === CALLBACK_REFUSED && !/secret/.test(error.stack))
  }
  assert.equal(h.calls.filter(call => call[0] === 'answer').length, 1)
  // acp-dsh's refusals read as fixed sentences.
  for (const [code, message] of [
    ['acp-sign-in/not-this-sign-in', 'This link is not from this sign-in.'],
    ['acp-sign-in/expired', 'This sign-in expired. Start again.'],
    ['acp-sign-in/off', 'Turn this coding agent on in Settings, under Coding agents, then try again.'],
    ['acp-sign-in/missing', 'Install this coding agent in Settings, under Coding agents, then try again.'],
  ]) {
    h.acp.loginAnswer = async () => { throw nativeError(code) }
    h.acp.loginStart = async () => { throw nativeError(code) }
    await assert.rejects(h.actions['cli-login-answer']({ botId: 'a', provider: AGY, attemptId: ATTEMPT, value: PASTED }), error => error.message === message && !/private-cli-output/.test(error.stack))
    await assert.rejects(h.actions['cli-login-start']({ botId: 'a', provider: AGY }), { message })
  }
})

test('an expired Antigravity attempt reads the chat\'s own sentence through cli-login-status; Claude\'s is unchanged', async () => {
  for (const provider of [AGY, 'acp-claude']) {
    const h = provider === AGY ? agyFixture() : fixture()
    h.acp.loginStatus = async (id, attemptId) => ({ id, attemptId, status: 'expired' })
    const view = await h.actions['cli-login-status']({ botId: 'a', provider, attemptId: ATTEMPT })
    assert.equal(view.status, 'expired', provider)
    assert.equal(view.message, 'This sign-in expired. Start again.', provider)
  }
})

test('the account controls stay Claude Code\'s and Codex\'s: Antigravity is refused before acp-dsh', async () => {
  const h = agyFixture()
  for (const [action, payload] of [
    ['cli-login-switch', { botId: 'a', provider: AGY }], ['cli-login-signout', { botId: 'a', provider: AGY }],
    ['cli-login-reset', { botId: 'a', provider: AGY }], ['cli-login-confirm', { botId: 'a', provider: AGY, ref: 'unknown' }],
    ['cli-login-noticed', { provider: AGY }],
  ]) await assert.rejects(h.actions[action](payload), { code: 'bot/invalid' }, action)
  assert.deepEqual(h.calls, [])
})

test('Antigravity signed in: the model chosen with the entry is applied, as for Claude Code and Codex', async () => {
  const h = agyFixture()
  await h.actions['cli-login-start']({ botId: 'a', provider: AGY, model: `${AGY}/gemini` })
  await h.ready(AGY)
  assert.deepEqual(h.updates, [['a', { model: `${AGY}/gemini` }]])
})
