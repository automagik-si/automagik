// The Bot team's side of a CLI sign-in (cli-login.js, plan v3 2.3): the route to acp-dsh's
// attempt, the model chosen with the entry (rule 5) and the code guard. acp-dsh is a fake here.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { CODE_HINT, cliLoginUrl, cliLoginView, install } from '../src/host/cli-login.js'

const ATTEMPT = randomUUID()
const CODEX_URL = 'https://auth.openai.com/codex/device'
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=expected_state_0123456789'
const settle = () => new Promise(resolve => setImmediate(resolve))
const nativeError = code => Object.assign(new Error('private-cli-output code#state and token-secret'), { code })

function fixture() {
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
  install(rt)
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
