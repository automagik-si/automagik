// The sign-in endpoints on the team's /api/omni-ui route (cli-login.js, channel.js): owner only,
// never cached, read-only hosts may read, a native failure never echoes, and a message that
// carries a shown sign-in state is refused on every send endpoint. acp-dsh is a fake here.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const ENDPOINTS = [
  'cli-login-start', 'cli-login-current', 'cli-login-status', 'cli-login-answer',
  'cli-login-cancel', 'cli-login-connections', 'cli-login-switch', 'cli-login-signout',
  'cli-login-reset',
]
const STATE = 'expected_state_0123456789'

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'automagik-cli-login-route-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, bots: { first: { id: 'first', name: 'First Bot', createdAt: 1 } }, mainBotIds: ['first'], revision: 1 }))
  const calls = []
  const attemptId = randomUUID()
  const status = { id: 'acp-codex', attemptId, status: 'waiting', expiresAt: Date.now() + 60000, expiresBy: 'app', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }
  const acp = {
    ...Object.fromEntries(['loginStart', 'loginCurrent', 'loginStatus', 'loginAnswer', 'loginCancel'].map(method => [method, async (...args) => { calls.push([method, ...args]); return status }])),
    loginTextMatches: text => text.includes(`#${STATE}`),
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
  return { acp, rt, ctx, calls, call, route, prompts, logged, attemptId, payload: { botId: 'first', provider: 'acp-codex' } }
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
  h.rt.noteFailure = entry => notes.push(entry)
  for (const [endpoint, payload] of [
    ['send', { sessionId: 'first', text: `here: abc#${STATE}` }],
    ['side-ask', { sessionId: 'first', text: `abc#${STATE}` }],
    ['answer-question', { sessionId: 'first', questionId: 'q', answer: { text: `abc#${STATE}` } }],
    ['view-reply', { sessionId: 'first', viewId: 'v', values: { field: `abc#${STATE}` } }],
    ['memory-ask', { botId: 'first', question: `abc#${STATE}` }],
  ]) {
    const { result } = await h.call(endpoint, payload)
    assert.equal(result.ok, false, endpoint)
    assert.equal(result.error.code, 'bot/refused', endpoint)
    assert.match(result.error.message, /sign-in code/)
    assert.doesNotMatch(JSON.stringify(result), /expected_state/)
  }
  assert.deepEqual(h.prompts, [])
  assert.deepEqual(notes, [])
  assert.doesNotMatch(JSON.stringify(h.logged), /expected_state/)
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
