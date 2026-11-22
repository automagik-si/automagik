// The sign-in endpoints on the team's /api/omni-ui route (cli-login.js, channel.js): owner only,
// never cached, read-only hosts may read, a native failure never echoes, and a message that
// carries a shown sign-in state is refused on every send endpoint. acp-dsh is a fake here.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { apply } from '../index.js'
import { RESERVATION_FILE } from '../src/host/account-reservations.js'
import { fakeContext } from './fake-ctx.js'
import { CLAUDE, CODEX, reservationAcp } from './fixtures/account-reservations.js'

const ENDPOINTS = [
  'cli-login-start', 'cli-login-current', 'cli-login-status', 'cli-login-answer',
  'cli-login-cancel', 'cli-login-connections', 'cli-login-switch', 'cli-login-signout',
  'cli-login-reset',
]
const STATE = 'expected_state_0123456789'

async function fixture(t, { home = mkdtempSync(join(tmpdir(), 'automagik-cli-login-route-')), seed = true } = {}) {
  if (seed) writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, bots: { first: { id: 'first', name: 'First Bot', createdAt: 1 } }, mainBotIds: ['first'], revision: 1 }))
  const calls = []
  const attemptId = randomUUID()
  const status = { id: 'acp-codex', attemptId, status: 'waiting', expiresAt: Date.now() + 60000, expiresBy: 'app', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }
  const acp = {
    ...Object.fromEntries(['loginStart', 'loginCurrent', 'loginStatus', 'loginAnswer', 'loginCancel'].map(method => [method, async (...args) => { calls.push([method, ...args]); return status }])),
    loginTextMatches: text => text.slice(0, 1_000_000).includes(`#${STATE}`),
    inspect: async id => ({ id, signedIn: true, on: false, cli: { found: true }, connector: { state: 'off' } }),
  }
  const ctx = fakeContext({ services: { acpAgents: acp } })
  // Everything the plugin logs, to prove a code never reaches the host log.
  const logged = []
  ctx.logger = { warn: (...args) => logged.push(args), info: (...args) => logged.push(args), error: (...args) => logged.push(args), debug: (...args) => logged.push(args) }
  const prompts = []
  ctx.sessionController = { prompt: async request => { prompts.push(request) } }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return register(options)
  }
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return { response, result: await response.json() }
  }
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, acp, rt, ctx, calls, call, route, prompts, logged, attemptId, payload: { botId: 'first', provider: 'acp-codex' } }
}

test('a first Bot can start a sign-in before it has a model, with no login tool and no state write', async (t) => {
  const h = await fixture(t)
  const before = JSON.stringify(h.rt.state)
  const { response, result } = await h.call('cli-login-start', h.payload)
  assert.equal(result.ok, true)
  assert.equal(result.value.attemptId, h.attemptId)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(JSON.stringify(h.rt.state), before)
  assert.deepEqual([...h.ctx.registeredTools.keys()].filter(name => /login|sign.?in/.test(name)), [])
  assert.deepEqual(h.calls[0], ['loginStart', 'acp-codex', { label: 'first' }])
  const current = await h.call('cli-login-current', h.payload)
  assert.equal(current.result.value.attempt.attemptId, h.attemptId)
  assert.equal(current.response.headers.get('cache-control'), 'no-store')
})

test('a reading host cannot start, answer or cancel, but can read the attempt and the connections', async (t) => {
  const h = await fixture(t)
  h.rt.readOnly = () => 'The team is open in another host.'
  for (const endpoint of ['cli-login-start', 'cli-login-answer', 'cli-login-cancel',
    'cli-login-switch', 'cli-login-signout', 'cli-login-reset']) {
    const { response, result } = await h.call(endpoint, { ...h.payload, attemptId: h.attemptId, value: 'code#state' })
    assert.equal(result.error.code, 'bot/read-only')
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(h.calls.length, 0)
  assert.equal((await h.call('cli-login-status', { ...h.payload, attemptId: h.attemptId })).result.ok, true)
  assert.equal((await h.call('cli-login-current', h.payload)).result.ok, true)
  const connections = await h.call('cli-login-connections', null)
  assert.equal(connections.result.value.connections['acp-codex'].signedIn, true)
  assert.equal(connections.result.value.connections['acp-codex'].enabled, false)
})

test('a native failure cannot echo the authorization answer or enter the diagnostic log', async (t) => {
  const h = await fixture(t)
  const secret = `private-authorization-code#${STATE}`
  const notes = []
  h.rt.noteFailure = entry => notes.push(entry)
  h.acp.loginAnswer = async () => { throw new Error(`native output contains ${secret}`) }
  const { result } = await h.call('cli-login-answer', { botId: 'first', provider: 'acp-claude', attemptId: h.attemptId, value: secret })
  assert.equal(result.error.code, 'bot/refused')
  assert.equal(result.error.message, 'Could not continue this sign-in. Try again.')
  assert.deepEqual(notes, [])
  assert.doesNotMatch(JSON.stringify({ result, state: h.rt.state, logged: h.logged }), /private-authorization-code|expected_state/)
})

test('a failure with no sentence of its own says which kind it was, never what the CLI printed', async (t) => {
  const h = await fixture(t)
  h.acp.loginStart = async () => { throw Object.assign(new Error('private-cli-output token-secret'), { code: 'acp-net/unreachable' }) }
  const { result } = await h.call('cli-login-start', h.payload)
  assert.equal(result.error.code, 'bot/refused')
  assert.equal(result.error.message, 'Could not continue this sign-in (acp-net/unreachable). Try again.')
  assert.doesNotMatch(JSON.stringify(result), /private-cli-output|token-secret/)
  // A code that is not a class (a shell error, a pasted shape) is not put in the row.
  for (const code of ['EACCES', 'weird code with spaces', 'x'.repeat(80), '']) {
    h.acp.loginStart = async () => { throw Object.assign(new Error('private-cli-output'), { code }) }
    const { result: failed } = await h.call('cli-login-start', h.payload)
    assert.equal(failed.error.message, 'Could not continue this sign-in. Try again.', code)
  }
})

test('an agent that signs in from its terminal says so', async (t) => {
  const h = await fixture(t)
  h.acp.loginStart = async () => { throw Object.assign(new Error('run the CLI'), { code: 'acp-login/terminal' }) }
  const { result } = await h.call('cli-login-start', h.payload)
  assert.equal(result.error.message, 'This coding agent signs in from its own terminal. Run its sign-in command there, then try again.')
})

test('an account confirmation failure says which kind it was, never the CLI text', async (t) => {
  const h = await fixture(t)
  h.acp.accountConfirm = async () => { throw Object.assign(new Error('private-cli-output'), { code: 'acp-account/mismatch' }) }
  const { result } = await h.call('cli-login-confirm', { botId: 'first', provider: 'acp-claude', ref: 'account-ref' })
  assert.equal(result.error.message, 'The account could not be confirmed (acp-account/mismatch). Try again.')
  assert.doesNotMatch(JSON.stringify(result), /private-cli-output/)
})

// Every code acp-dsh can refuse a sign-in with says something the person can act on, and the
// one this box hit (two Automagik instances, an account change the other one holds) names the
// other session instead of one dead end.
test('every refusal a sign-in can meet has its own sentence', async (t) => {
  const h = await fixture(t)
  h.acp.loginStart = async () => { throw Object.assign(new Error('native text'), { code: 'acp-account/busy', message: 'Close other Automagik sessions before changing the Bot account.' }) }
  const { result } = await h.call('cli-login-start', h.payload)
  assert.equal(result.error.code, 'bot/refused')
  assert.equal(result.error.message, 'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.')
  const byCode = new Map([
    ['acp-account/unavailable', 'The Bot account cannot be changed from this session. Use the app on this computer.'],
    ['acp-account/invalid', 'This sign-in is not available for this Bot.'],
    ['acp-account/logout', 'Signing out of the Bot account did not finish. Try again.'],
    ['acp-account/disposed', 'Automagik is restarting. Try again in a moment.'],
    ['acp-account/changed', 'The account changed. Check it and confirm again.'],
    ['acp-account/signed-out', 'This coding agent is not signed in any more. Press Sign in again.'],
    ['acp-login/invalid', 'This sign-in request is no longer valid. Start again.'],
    ['acp-login/invalid-code', 'Paste the complete code shown by Claude, including the part after #.'],
    ['acp-login/not-found', 'This sign-in has ended. Start again.'],
    ['acp-login/unavailable', 'This CLI cannot sign in yet. Check its installation and try again.'],
    ['acp-login/disposed', 'The connection restarted. Start sign-in again.'],
    ['acp-login/terminal', 'This coding agent signs in from its own terminal. Run its sign-in command there, then try again.'],
  ])
  for (const [code, message] of byCode) {
    // A code with no sentence of its own still gets its sentence from the code, whatever the
    // native text says.
    h.acp.loginStart = async () => { throw Object.assign(new Error('native text private-cli-output'), { code }) }
    const { result: failed } = await h.call('cli-login-start', h.payload)
    assert.equal(failed.error.message, message, code)
    assert.doesNotMatch(JSON.stringify(failed), /native text|private-cli-output/, code)
  }
  // The same code with a sentence this side does not know: still actionable, never the text.
  for (const [native, message] of [
    ['The Bot account is already changing. Try again when it finishes.', 'The Bot account is already changing. Try again when it finishes.'],
    ['Sign-out could not be verified. Try again.', 'Signing out of the Bot account could not be verified. Try again.'],
    ['Bot sign-in was reset. Retry sign-in in the app.', 'The Bot account was reset. Press Sign in again.'],
  ]) {
    h.acp.loginStart = async () => { throw Object.assign(new Error(native), { code: 'acp-account/busy' }) }
    assert.equal((await h.call('cli-login-start', h.payload)).result.error.message, message, native)
  }
})

// The reviewer's two medium findings, pinned: a code read straight out of the object can be a
// name of Object.prototype, and any two-segment string is not a failure class.
test('a prototype name as a code is refused like any other, not turned into an internal error', async (t) => {
  const h = await fixture(t)
  for (const code of ['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty']) {
    h.acp.accountConfirm = async () => { throw Object.assign(new Error('private-cli-output'), { code }) }
    const { result } = await h.call('cli-login-confirm', { botId: 'first', provider: 'acp-claude', ref: 'account-ref' })
    assert.equal(result.error.code, 'bot/refused', code)
    assert.equal(result.error.message, 'The account could not be confirmed. Try again.', code)
    assert.doesNotMatch(JSON.stringify(result), /private-cli-output/, code)
  }
})

// The sign-in action path reads both of its code tables as own properties, not just the one for
// codes it knows: a code such as '__proto__' handed the row an inherited value instead.
test('a prototype name as a sign-in failure code gets the one line, not an inherited value', async (t) => {
  const h = await fixture(t)
  for (const code of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    h.acp.loginStart = async () => { throw Object.assign(new Error('private-cli-output'), { code }) }
    const { result } = await h.call('cli-login-start', h.payload)
    assert.equal(result.error.code, 'bot/refused', code)
    assert.equal(result.error.message, 'Could not continue this sign-in. Try again.', code)
    assert.doesNotMatch(JSON.stringify(result), /\[object Object\]|native code|private-cli-output/, code)
  }
})

test('only an acp failure namespace is said as a class', async (t) => {
  const h = await fixture(t)
  for (const code of ['Users/example-user', 'home/example-user', 'Bearer/fake-tok-000000', 'ACP-net/unreachable', 'filesystem/enoent']) {
    h.acp.loginStart = async () => { throw Object.assign(new Error('private-cli-output'), { code }) }
    const { result } = await h.call('cli-login-start', h.payload)
    assert.equal(result.error.message, 'Could not continue this sign-in. Try again.', code)
    assert.doesNotMatch(JSON.stringify(result), /example-user|fake-tok|private-cli-output/, code)
  }
})

test('owner sign-in and account controls preserve a safe recovery action without native details',
  async t => {
    const h = await fixture(t)
    h.acp.authScope = 'isolated'
    for (const method of ['loginStart', 'accountSwitch', 'accountSignOut', 'accountReset']) {
      h.acp[method] = async () => { throw Object.assign(new Error('private-path token-secret'), {
        code: 'acp-account/unverified-login',
      }) }
    }
    for (const action of ['start', 'switch', 'signout', 'reset']) {
      const { result } = await h.call(`cli-login-${action}`, h.payload)
      assert.equal(result.error.code, 'bot/account-recovery')
      assert.match(result.error.message, /Reset Bot sign-in to start fresh/)
      assert.doesNotMatch(JSON.stringify({ result, logged: h.logged }),
        /private-path|token-secret/)
    }
  })

for (const evidence of ['pending', 'damaged', 'legacy']) {
  test(`cold settings preserve the healthy vendor beside ${evidence} recovery`, async t => {
    const h = await fixture(t)
    h.acp.authScope = 'isolated'
    h.acp.status = async () => ({ agents: [] })
    const inspected = []
    const unverified = () => Object.assign(new Error(`private-${evidence} token-secret`), {
      code: 'acp-account/unverified-login',
    })
    h.acp.accountRecovery = async id => {
      if (id !== 'acp-claude') return { required: false }
      if (evidence === 'legacy') throw unverified()
      return { required: evidence === 'pending' }
    }
    h.acp.account = async id => {
      inspected.push(id)
      if (id === 'acp-claude') throw unverified()
      return { signedIn: true, account: { email: 'healthy@example.test' } }
    }
    h.acp.terminalAccount = async () => ({
      account: { email: 'terminal@example.test', token: 'never-forward' },
    })
    const { response, result } = await h.call('cli-login-accounts', {})
    assert.equal(result.ok, true)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const rows = result.value.accounts
    assert.equal(rows['acp-claude'].recoveryRequired, true)
    assert.equal(rows['acp-claude'].signedIn, false)
    assert.equal(rows['acp-codex'].recoveryRequired, undefined)
    assert.equal(rows['acp-codex'].account.email, 'healthy@example.test')
    assert.equal(rows['acp-claude'].terminal.email, 'terminal@example.test')
    if (evidence === 'pending') assert.deepEqual(inspected, ['acp-codex'])
    assert.doesNotMatch(JSON.stringify({ result, logged: h.logged }),
      /private-|token-secret|never-forward/)
  })
}

test('the isolated account card asks both vendors’ recovery at once', async t => {
  const h = await fixture(t)
  const claude = Promise.withResolvers()
  const calls = []
  let recoveriesAtCodexRead
  h.acp.authScope = 'isolated'
  h.acp.accountRecovery = id => {
    calls.push(id)
    if (id === CLAUDE) return claude.promise
    return { required: false }
  }
  h.acp.account = async id => {
    if (id !== CODEX) return { signedIn: false }
    recoveriesAtCodexRead = [...calls]
    return { signedIn: true, account: { email: 'healthy@example.test' } }
  }
  h.acp.accountReset = t.mock.fn()
  const pending = h.call('cli-login-accounts', {})
  try {
    // A turn is enough for the in-process route to call both recovery readers.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual([...calls].sort(), [CLAUDE, CODEX])
  } finally { claude.resolve({ required: false }) }
  const { result } = await pending
  assert.equal(result.ok, true)
  assert.deepEqual(recoveriesAtCodexRead?.sort(), [CLAUDE, CODEX])
  assert.equal(Object.hasOwn(result.value.accounts[CLAUDE], 'recoveryRequired'), false)
  assert.equal(result.value.accounts[CODEX].signedIn, true)
  assert.equal(result.value.accounts[CODEX].account.email, 'healthy@example.test')
  assert.equal(h.acp.accountReset.mock.callCount(), 0)
})

test('reset stays owner-only, uses only the isolated ACP action and preserves Bot history',
  async t => {
    const h = await fixture(t)
    const reset = []
    h.acp.authScope = 'isolated'
    h.acp.accountReset = async (...args) => { reset.push(args) }
    const before = JSON.stringify(h.rt.state)
    const { result, response } = await h.call('cli-login-reset', h.payload)
    assert.equal(result.ok, true)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(reset, [['acp-codex', { label: 'first' }]])
    assert.equal(JSON.stringify(h.rt.state), before)
    h.acp.authScope = 'shared'
    assert.equal((await h.call('cli-login-reset', h.payload)).result.ok, false)
    assert.equal(reset.length, 1, 'an older shared host is never used to reset a terminal login')
  })

test('every send endpoint refuses a text carrying a shown sign-in state before anything is queued', async (t) => {
  const h = await fixture(t)
  const notes = []
  const relays = []
  const room = { id: 'room', name: 'Project', members: ['first'], admin: 'first', mode: 'admin', createdAt: 2 }
  h.rt.state.rooms[room.id] = room
  await h.rt.save()
  const path = join(h.home, 'state.json')
  const before = fs.readFileSync(path, 'utf8')
  h.rt.resolveAgent = async () => ({ session: {}, followup: message => relays.push(message) })
  h.ctx.sessions = { ...h.ctx.sessions, flush: async () => {} }
  h.rt.noteFailure = entry => notes.push(entry)
  for (const [endpoint, payload] of [
    ['send', { sessionId: 'first', text: `here: abc#${STATE}` }],
    ['side-ask', { sessionId: 'first', text: `abc#${STATE}` }],
    ['answer-question', { sessionId: 'first', questionId: 'q', answer: { text: `abc#${STATE}` } }],
    ['view-reply', { sessionId: 'first', viewId: 'v', values: { field: `abc#${STATE}` } }],
    ['memory-ask', { botId: 'first', question: `abc#${STATE}` }],
    ['goal-draft', { roomId: room.id, text: `Review this plan: abc#${STATE}` }],
    ['goal-draft', { roomId: room.id, text: `${' '.repeat(1_000_000)}Review this plan: abc#${STATE}` }],
  ]) {
    const { result } = await h.call(endpoint, payload)
    assert.equal(result.ok, false, endpoint)
    assert.equal(result.error.code, 'bot/refused', endpoint)
    assert.match(result.error.message, /sign-in code/)
    assert.doesNotMatch(JSON.stringify(result), /expected_state/)
  }
  assert.deepEqual(h.prompts, [])
  assert.equal(room.goal, undefined)
  assert.equal(fs.readFileSync(path, 'utf8'), before)
  assert.deepEqual(relays, [])
  assert.deepEqual(notes, [])
  assert.doesNotMatch(JSON.stringify(h.logged), /expected_state/)
  assert.equal((await h.call('goal-draft', { roomId: room.id, text: '  Review the project plan.  ' })).result.ok, true)
  assert.equal(room.goal.brief, 'Review the project plan.')
  assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).rooms[room.id].goal.brief, room.goal.brief)
  assert.equal(relays.length, 1)
})

test('owner only: DSH answers 403 to a share viewer on every sign-in endpoint, and the owner reaches them', async (t) => {
  const h = await fixture(t)
  // DSH's own shared /api Fetch handler (client-connection), as the web server mounts it, with
  // the team's exact route registered on it.
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, h.route)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const viewer = { principal: { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } } }
  const owner = { principal: { kind: 'owner' } }
  const request = (endpoint, payload) => new Request('http://localhost/api/omni-ui', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  for (const endpoint of ENDPOINTS) {
    const payload = { ...h.payload, ...(['cli-login-status', 'cli-login-answer', 'cli-login-cancel'].includes(endpoint) ? { attemptId: h.attemptId } : {}), ...(endpoint === 'cli-login-answer' ? { value: 'code' } : {}) }
    const refused = await handler.fetch(request(endpoint, endpoint === 'cli-login-connections' ? {} : payload), viewer)
    assert.equal(refused.status, 403, endpoint)
  }
  assert.equal(h.calls.length, 0, 'a share viewer never reached acp-dsh')
  const allowed = await handler.fetch(request('cli-login-start', h.payload), owner)
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json()).value.attemptId, h.attemptId)
})

test('a share viewer receives 403 on the CLI account list', async (t) => {
  const h = await fixture(t)
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, h.route)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const viewer = { principal: { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } } }
  const response = await handler.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'cli-login-accounts', payload: {} }),
  }), viewer)
  assert.equal(response.status, 403)
  assert.equal(h.calls.length, 0)
})

test('a delivery carrying a shown state is never noted for a resend; one dropped at its step is forgotten', async (t) => {
  const h = await fixture(t)
  const sessionId = h.rt.chatOf('first')
  await assert.rejects(h.rt.deliver({ toId: 'first', role: 'room', text: `relayed abc#${STATE}` }), { code: 'bot/refused' })
  assert.deepEqual(h.rt.unreadOf(sessionId), [], 'resume.js never noted it, so a restart has nothing to resend')
  assert.doesNotMatch(JSON.stringify(h.logged), /expected_state/)
  // A delivery noted before (here: the note itself), then dropped at the step.
  const exchangeId = randomUUID()
  h.rt.deliver({ toId: 'first', role: 'request', text: 'plain request', exchangeId }).catch(() => {})
  assert.equal(h.rt.unreadOf(sessionId).length, 1)
  h.rt.dropLoginCodes({ agent: { id: sessionId }, messages: [{ role: 'user', content: [{ type: 'text', text: `abc#${STATE}` }], source: { kind: 'bot', exchangeId } }] })
  assert.deepEqual(h.rt.unreadOf(sessionId), [])
})

// #871 (L3): the guard reads the whole payload. No depth, width or key hides a text from it.
test('the send guard finds a shown sign-in state at any depth, width or key of the payload', async (t) => {
  const h = await fixture(t)
  const code = `abc#${STATE}`
  const deep = (value, levels) => { let out = value; for (let level = 0; level < levels; level++) out = { next: out }; return out }
  const wide = Array.from({ length: 600 }, (_, index) => `line ${index}`)
  for (const [name, endpoint, payload] of [
    ['six levels down', 'view-reply', { sessionId: 'first', viewId: 'v', values: deep(code, 6) }],
    ['forty levels down', 'answer-question', { sessionId: 'first', questionId: 'q', answer: deep({ text: code }, 40) }],
    ['past the 200th item of a list', 'view-reply', { sessionId: 'first', viewId: 'v', values: { rows: [...wide, code] } }],
    ['past the 200th field of an object', 'view-reply', { sessionId: 'first', viewId: 'v', values: { ...Object.fromEntries(wide.map((line, index) => [`f${index}`, line])), last: code } }],
    ['deep and wide at once', 'send', { sessionId: 'first', text: 'hello', extra: deep([...wide, [wide, { a: [code] }]], 12) }],
    ['as a field name', 'view-reply', { sessionId: 'first', viewId: 'v', values: { [code]: 'yes' } }],
  ]) {
    const { result } = await h.call(endpoint, payload)
    assert.equal(result.ok, false, name)
    assert.equal(result.error.code, 'bot/refused', name)
    assert.match(result.error.message, /sign-in code/, name)
    assert.doesNotMatch(JSON.stringify(result), /expected_state/, name)
  }
  assert.deepEqual(h.prompts, [], 'nothing was queued')
  // The same shapes without a shown state are not refused by the guard: the send goes on.
  const { result } = await h.call('send', { sessionId: 'first', text: 'hello #not_a_shown_state_0123456789', extra: deep([...wide, [wide, { a: ['#tag'] }]], 12) })
  assert.equal(result.ok, true)
  assert.equal(h.prompts.length, 1)
  assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'hello #not_a_shown_state_0123456789' }])
  assert.doesNotMatch(JSON.stringify(h.logged), /expected_state/)
})

function reservationFetch(route) {
  const connection = { fetchRoutes: new Map(), interceptors: new Map() }
  HostConnectionService.prototype.registerFetchRoute.call(connection, { effect: setup => setup() }, route)
  const handler = HostConnectionService.prototype.createSharedFetchHandler.call(connection, '/api')
  const owner = { kind: 'owner' }
  return (endpoint, payload, principal = owner) => handler.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }),
  }), { principal })
}

function instanceFor(t, id) {
  const previous = process.env.AUTOMAGIK_INSTANCE_ID
  if (id === undefined) delete process.env.AUTOMAGIK_INSTANCE_ID
  else process.env.AUTOMAGIK_INSTANCE_ID = id
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOMAGIK_INSTANCE_ID
    else process.env.AUTOMAGIK_INSTANCE_ID = previous
  })
}

test('the owner Fetch route persists a private reservation, shows it after restart, and releases it signed out', async t => {
  instanceFor(t, 'route-instance')
  const h = await fixture(t, { seed: false })
  const fake = reservationAcp()
  Object.assign(h.acp, fake.service)
  const path = join(h.home, RESERVATION_FILE)
  const responses = []
  const notes = []
  h.rt.noteFailure = entry => notes.push(entry)
  const before = JSON.stringify(h.rt.state)
  function caller(route) {
    const fetch = reservationFetch(route)
    return async (endpoint, payload = {}) => {
      const response = await fetch(endpoint, payload)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const result = await response.json()
      responses.push(result)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
  }
  const privacy = value => assert.doesNotMatch(JSON.stringify(value), /private-|@example\.test|"(email|org|plan|token|key|exact|loose|ref)"/)
  const call = caller(h.route)
  const initial = (await call('cli-login-accounts', { reservations: true })).accounts
  assert.equal(fs.existsSync(path), false)
  assert.equal(initial[CLAUDE].account.email, 'private-claude@example.test')
  assert.deepEqual(initial[CLAUDE].reservation, { state: 'complete', claims: [],
    offer: { offerId: initial[CLAUDE].reservation.offer.offerId } })
  privacy(initial[CLAUDE].reservation)
  privacy(initial[CODEX].reservation)
  const saved = await call('cli-login-reserve', { ...initial[CLAUDE].reservation.offer, label: 'Release project' })
  const claimView = saved.claims[0]
  assert.deepEqual(saved, { state: 'complete',
    claims: [{ claimId: claimView.claimId, rev: claimView.rev, current: true, mine: true, label: 'Release project' }],
    offer: { offerId: saved.offer.offerId },
  })
  privacy(saved)
  const bytes = fs.readFileSync(path, 'utf8')
  assert.doesNotMatch(bytes, /private-|@example\.test|"(email|org|plan|token|ref)"/)
  const record = JSON.parse(bytes)
  assert.equal(Buffer.from(record.key, 'base64url').length, 32)
  const [claim] = Object.values(record.claims)
  assert.match(claim.exact, /^[\w-]{43}$/)
  assert.match(claim.loose, /^[\w-]{43}$/)
  assert.equal(claim.label, 'Release project')
  assert.equal(claim.instance, 'route-instance')
  assert.equal(claim.rev, claimView.rev)
  assert.equal(JSON.stringify(h.rt.state), before)
  assert.deepEqual(notes, [])
  assert.deepEqual([...h.ctx.registeredTools.keys()].filter(name => /reservation/.test(name)), [])
  await h.ctx.dispose()

  const restarted = await fixture(t, { home: h.home, seed: false })
  Object.assign(restarted.acp, fake.service)
  const after = caller(restarted.route)
  const claimAfter = (await after('cli-login-accounts', { reservations: true })).accounts[CLAUDE].reservation.claims[0]
  assert.deepEqual(claimAfter, { ...claimView, claimId: claimAfter.claimId })
  assert.notEqual(claimAfter.claimId, claimView.claimId)
  fake.accounts[CLAUDE] = null
  const reads = fake.calls.length
  const released = await after('cli-login-release', { claimId: claimAfter.claimId, rev: claimAfter.rev })
  assert.deepEqual(released, { state: 'unknown', claims: [] })
  assert.equal(fake.calls.length, reads)
  privacy(released)
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { version: 1, key: record.key, claims: {} })
  fake.accounts[CLAUDE] = { email: 'private-claude@example.test', org: 'private-organisation', ref: 'claude-ref' }
  const shared = (await after('cli-login-accounts', { reservations: true })).accounts[CLAUDE].reservation
  assert.deepEqual(shared.claims, [])
  assert.ok(shared.offer)
  const diagnostics = { responses, notes, logged: [...h.logged, ...restarted.logged], state: restarted.rt.state }
  for (const secret of [record.key, claim.exact, claim.loose]) assert.equal(JSON.stringify(diagnostics).includes(secret), false)
  assert.deepEqual(fake.calls.filter(([method]) => ['switch', 'signout', 'reset'].includes(method)), [])
})

test('reservation mutations are owner-only before any ACP or reservation file access and read-only hosts can list', async t => {
  instanceFor(t, 'route-instance')
  const h = await fixture(t)
  const fake = reservationAcp()
  Object.assign(h.acp, fake.service)
  const fetch = reservationFetch(h.route)
  const path = join(h.home, RESERVATION_FILE)
  const lstat = fs.lstatSync
  const disk = t.mock.method(fs, 'lstatSync', (file, ...args) => lstat(file, ...args))
  const viewer = { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } }
  const token = randomUUID().replaceAll('-', '').slice(0, 21) + 'A'
  const mutations = [
    ['cli-login-reserve', { offerId: token, label: 'A project' }],
    ['cli-login-release', { claimId: token, rev: token }],
  ]
  for (const [endpoint, payload] of [['cli-login-accounts', { reservations: true }], ...mutations]) {
    assert.equal((await fetch(endpoint, payload, viewer)).status, 403, endpoint)
  }
  assert.deepEqual(fake.calls, [])
  assert.equal(disk.mock.calls.length, 0, 'no lstat or subsequent reservation file access')

  const list = await fetch('cli-login-accounts', { reservations: true })
  const { value } = await list.json()
  assert.equal(list.status, 200)
  assert.equal(list.headers.get('cache-control'), 'no-store')
  assert.ok(value.accounts[CODEX].reservation.offer)
  assert.ok(disk.mock.calls.some(call => call.arguments[0] === path))
  fake.calls.splice(0)
  disk.mock.resetCalls()
  h.rt.readOnly = () => 'The team is open in another host.'
  for (const [endpoint, payload] of mutations) {
    const response = await fetch(endpoint, payload)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).error.code, 'bot/read-only')
  }
  assert.deepEqual(fake.calls, [])
  assert.equal(disk.mock.calls.some(call => call.arguments[0] === path), false)
  const readOnly = await fetch('cli-login-accounts', { reservations: true })
  assert.equal((await readOnly.json()).ok, true)
  assert.ok(fake.calls.some(([method]) => method === 'evidence'))
})

test('reservation route payloads accept only the bounded action fields', async t => {
  instanceFor(t, 'route-instance')
  const h = await fixture(t)
  const fake = reservationAcp()
  Object.assign(h.acp, fake.service)
  const { offer } = (await h.call('cli-login-accounts', { reservations: true })).result.value.accounts[CLAUDE].reservation
  const token = offer.offerId
  fake.calls.splice(0)
  for (const [endpoint, payload] of [
    ['cli-login-reserve', { offerId: token, label: 'Project', provider: CLAUDE }],
    ['cli-login-reserve', { offerId: token, label: 'Project', rev: token }],
    ['cli-login-reserve', { offerId: token, label: 'Project', claimId: token, rev: 1 }],
    ['cli-login-reserve', { offerId: 'x'.repeat(100), label: 'Project' }],
    ['cli-login-reserve', { offerId: token, label: 'x'.repeat(4097) }],
    ['cli-login-release', { claimId: token, rev: token, label: 'Project' }],
    ['cli-login-release', { claimId: token, rev: 1 }],
    ['cli-login-release', [token, token]],
  ]) {
    const { response, result } = await h.call(endpoint, payload)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bot/invalid')
  }
  assert.deepEqual(fake.calls, [])
  assert.equal(fs.existsSync(join(h.home, RESERVATION_FILE)), false)
})
