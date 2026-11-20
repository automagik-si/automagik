// The /api channel answers a deliberate refusal by its own sentence (refusal(), code bot/refused):
// connector, mail and Computer use validation, the connector and Google mailbox sign-in answers,
// and the mail sign-in sentences mailError() fixes.
// A mail failure that names its server stays a plain error and answers by kind.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start(t, connect) {
  const root = mkdtempSync(join(tmpdir(), 'bots-coded-refusals-'))
  const home = join(root, 'team')
  const savedHome = process.env.HOME
  const ctx = fakeContext({ services: { settings: { describe: () => [] }, credentials: { describe: async () => ({}) } } })
  t.after(async () => {
    await ctx.dispose()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  process.env.HOME = root
  mkdirSync(home)
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: { m1: { id: 'm1', name: 'Main', role: 'Main Bot', instructions: '', createdAt: 1 } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  ctx.llm.listConfigurableProviders = () => []
  const routes = new Map()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => {
    routes.set(route.path, route)
    return register(route)
  }
  apply(ctx, { home, github: false, mail: { connect } })
  return async (endpoint, payload) => {
    const route = routes.get('/api/omni-ui')
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
}

test('connector, mail and computer validation answer with their own sentences', async (t) => {
  let mailConnections = 0
  const call = start(t, async () => {
    mailConnections += 1
    throw new Error('Unexpected mail connection')
  })
  for (const [endpoint, payload, message] of [
    ['connector-add', { name: '' }, 'Name the connector'],
    ['connector-remove', { id: 'notion' }, 'Only added connectors can be removed'],
    ['mail-account-add', { address: 'a@b', password: 'x' }, 'Enter an email address'],
    ['computer-takeover', { botId: 'nope' }, 'Unknown Bot'],
    ['connector-connect', { id: 'github' }, 'No such connector'],
    ['connector-sign-in-code', { id: 'notion', input: 'x' }, 'No sign-in is waiting'],
    ['mail-sign-in-code', { input: 'x' }, 'No Google sign-in is waiting'],
  ]) {
    await t.test(endpoint, async () => {
      assert.deepEqual(await call(endpoint, payload), { ok: false, error: { code: 'bot/refused', message, details: {} } })
    })
  }
  assert.equal(mailConnections, 0)
})

for (const [transportError, message] of [
  ['Unsafe Login', 'The mail service refused the login (Unsafe Login). Enable IMAP/SMTP in the mailbox settings and use its authorization code, not the account password.'],
  ['SMTP connection timeout', 'SMTP connection timeout'],
  ['The SMTP connection closed', 'The SMTP connection closed'],
  ['The mail connection is closed', 'The mail connection is closed'],
  ['connect ECONNREFUSED 127.0.0.1:993', 'Something went wrong (Error).'],
]) {
  test(`mail-account-add answers ${transportError}`, async (t) => {
    let mailConnections = 0
    const call = start(t, async () => {
      mailConnections += 1
      throw new Error(transportError)
    })
    const reply = await call('mail-account-add', { address: 'someone@qq.com', password: 'x', provider: 'qq' })
    assert.deepEqual(reply, { ok: false, error: { code: 'bot/refused', message, details: {} } })
    assert.equal(mailConnections, 1)
  })
}
