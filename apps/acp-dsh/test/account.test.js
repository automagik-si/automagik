// Which account a CLI is signed in to (#869, account.js): read from the CLI's own status, never
// a token. Fakes only: no CLI runs here, and every identity is invented.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { accountEvidenceOf, accountOf, accountView, claudeAccount, codexAccount } from '../src/host/account.js'
import { AGENTS } from '../src/host/agents.js'
import { CODEX_PLAN_CLASSES, reservationDigests, reservationOutcome } from '../src/host/reservation-evidence.js'

const CLAUDE = AGENTS['acp-claude']
const CODEX = AGENTS['acp-codex']
const signedIn = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'Ana@Work.example', orgId: 'org-1', orgName: 'Acme', subscriptionType: 'team' }

test('Claude Code: the account of a signed-in status, and nothing for one that does not say', () => {
  assert.deepEqual(claudeAccount(JSON.stringify(signedIn)), { kind: 'account', id: 'claude\norg-1\nana@work.example', facets: { kind: 'account', email: 'ana@work.example', org: 'org-1' }, email: 'Ana@Work.example', org: 'Acme', plan: 'team' })
  // The same person in another organisation is another account.
  assert.notEqual(claudeAccount(JSON.stringify({ ...signedIn, orgId: 'org-2' })).id, claudeAccount(JSON.stringify(signedIn)).id)
  assert.equal(claudeAccount(JSON.stringify({ loggedIn: false, email: 'ana@work.example' })), undefined)
  assert.equal(claudeAccount('not json'), undefined)
  assert.equal(claudeAccount('[]'), undefined)
  // An older CLI that says only loggedIn: unknown, never a throw.
  assert.equal(claudeAccount(JSON.stringify({ loggedIn: true })), undefined)
  assert.equal(claudeAccount(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })), undefined)
  // A CLI that prints only one of the two still names the account by what it prints.
  assert.deepEqual(claudeAccount(JSON.stringify({ loggedIn: true, orgId: 'org-1' })).facets, { kind: 'account', org: 'org-1' })
  assert.deepEqual(claudeAccount(JSON.stringify({ loggedIn: true, email: 'ana@work.example' })).facets, { kind: 'account', email: 'ana@work.example' })
})

test('Claude Code: a key, a token or another provider is told apart by its source, with no person', () => {
  assert.deepEqual(claudeAccount(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })), { kind: 'key', id: 'claude\nkey\nANTHROPIC_API_KEY', facets: { kind: 'key', source: 'key:ANTHROPIC_API_KEY' } })
  assert.deepEqual(claudeAccount(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' })), { kind: 'token', id: 'claude\nkey\noauth_token', facets: { kind: 'key', source: 'key:oauth_token' } })
  assert.deepEqual(claudeAccount(JSON.stringify({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' })), { kind: 'key', id: 'claude\nprovider\nbedrock', facets: { kind: 'key', source: 'provider:bedrock' } })
})

test('what is shown is one bounded line each, and never the id', () => {
  const seen = claudeAccount(JSON.stringify({ ...signedIn, orgName: `Ac\u0007me\n${'x'.repeat(400)}` }))
  assert.equal(seen.org.length, 120)
  assert.ok(seen.org.startsWith('Acmex'))
  assert.deepEqual(accountView(claudeAccount(JSON.stringify(signedIn))), { kind: 'account', email: 'Ana@Work.example', org: 'Acme', plan: 'team' })
  assert.deepEqual(accountView({ kind: 'key', id: 'claude\nkey\nX', facets: { kind: 'key', source: 'key:X' } }), { kind: 'key' })
  // A subscription token is a sign-in whose account the CLI does not say, never "an API key".
  assert.deepEqual(accountView(claudeAccount(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }))), { kind: 'account' })
  assert.equal(accountView(undefined), undefined)
})

test('Codex: the account of account/read, and nothing for one that does not say', () => {
  assert.deepEqual(codexAccount({ account: { type: 'chatgpt', email: 'Ana@Home.example', planType: 'plus' }, requiresOpenaiAuth: true }), { kind: 'account', id: 'codex\nchatgpt\nana@home.example', facets: { kind: 'account', email: 'ana@home.example' }, email: 'Ana@Home.example', plan: 'plus' })
  assert.deepEqual(codexAccount({ account: { type: 'apiKey' } }), { kind: 'key', id: 'codex\nkey', facets: { kind: 'key' } })
  assert.equal(codexAccount({ account: null, requiresOpenaiAuth: true }), undefined)
  assert.equal(codexAccount({ account: { type: 'chatgpt' } }), undefined)
  assert.equal(codexAccount({ account: { type: 'something-new', email: 'a@b.example' } }), undefined)
  assert.equal(codexAccount(undefined), undefined)
})

test('accountOf asks Claude Code its status with the environment it was given, and survives a failure', async () => {
  const calls = []
  const run = (file, args, options, done) => { calls.push({ file, args, options }); done(null, JSON.stringify(signedIn)) }
  const seen = await accountOf(CLAUDE, '/opt/tools/claude', { env: { PATH: '/usr/bin', MARK: 'same-env' }, run })
  assert.equal(seen.email, 'Ana@Work.example')
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
  assert.equal(calls[0].options.env.MARK, 'same-env')
  assert.equal(calls[0].options.env.DISABLE_UPDATES, '1')
  assert.ok(calls[0].options.env.PATH.startsWith('/opt/tools'))
  // A signed-out CLI exits 1 and still prints its JSON.
  assert.equal(await accountOf(CLAUDE, '/opt/tools/claude', { run: (file, args, options, done) => done(Object.assign(new Error('exit'), { code: 1 }), JSON.stringify({ loggedIn: false })) }), undefined)
  assert.equal(await accountOf(CLAUDE, '/opt/tools/claude', { run: () => { throw new Error('spawn failed') } }), undefined)
  assert.equal(await accountOf(CLAUDE, undefined, { run }), undefined)
  assert.equal(await accountOf({ key: 'other' }, '/bin/other', { run }), undefined)
})

function fakeServer(answer) {
  const children = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.killed = false
    child.kill = () => { child.killed = true; return true }
    child.sent = []
    let buffer = ''
    child.stdin.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const message = JSON.parse(line)
        child.sent.push(message)
        const reply = answer(message, child)
        if (reply !== undefined) child.stdout.write(`${JSON.stringify(reply)}\n`)
      }
    })
    children.push({ file, args, options, child })
    return child
  }
  return { spawn, children }
}

test('accountOf asks Codex over a short-lived app-server: one account/read, then the process ends', async () => {
  const server = fakeServer((message) => {
    if (message.method === 'initialize') return { id: message.id, result: {} }
    if (message.method === 'account/read') return { id: message.id, result: { account: { type: 'chatgpt', email: 'ana@home.example', planType: 'pro' } } }
    return undefined
  })
  const seen = await accountOf(CODEX, '/opt/tools/codex', { env: { PATH: '/usr/bin', MARK: 'same-env' }, spawn: server.spawn })
  assert.deepEqual(seen, { kind: 'account', id: 'codex\nchatgpt\nana@home.example', facets: { kind: 'account', email: 'ana@home.example' }, email: 'ana@home.example', plan: 'pro' })
  const [{ args, options, child }] = server.children
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://'])
  assert.equal(options.env.MARK, 'same-env')
  // Its stderr is never read: it may hold paths or diagnostics.
  assert.equal(options.stdio[2], 'ignore')
  assert.deepEqual(child.sent.map(message => message.method), ['initialize', 'initialized', 'account/read'])
  assert.deepEqual(child.sent[2].params, { refreshToken: false })
  assert.equal(child.killed, true)
})

test('a Codex account read that fails, exits or never answers is unknown', async (t) => {
  const refusing = fakeServer(message => (message.method === 'initialize' ? { id: message.id, result: {} } : message.method === 'account/read' ? { id: message.id, error: { message: 'no' } } : undefined))
  assert.equal(await accountOf(CODEX, '/opt/tools/codex', { spawn: refusing.spawn }), undefined)
  const exiting = fakeServer((message, child) => { if (message.method === 'initialize') setImmediate(() => child.emit('close', 1)); return undefined })
  assert.equal(await accountOf(CODEX, '/opt/tools/codex', { spawn: exiting.spawn }), undefined)
  // The fake has no OS process handle to keep the loop alive for the unref'ed deadline.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const silent = fakeServer(() => undefined)
  const waiting = accountOf(CODEX, '/opt/tools/codex', {
    spawn: silent.spawn, timeoutMs: 20,
  })
  t.mock.timers.tick(19)
  assert.equal(silent.children[0].child.killed, false)
  t.mock.timers.tick(1)
  assert.equal(await waiting, undefined)
  assert.equal(silent.children[0].child.killed, true)
  assert.equal(await accountOf(CODEX, '/opt/tools/codex', { spawn: () => { throw new Error('spawn failed') } }), undefined)
})

const reservationKey = Buffer.alloc(32, 7)

test('Claude accountEvidenceOf classifies the same status that supplies consent', async () => {
  const cases = [
    [{}, 'complete', ['exact', 'loose']],
    [{ apiProvider: undefined }, 'complete', ['exact', 'loose']],
    [{ orgId: null }, 'ambiguous', ['loose']],
    [{ orgId: undefined }, 'ambiguous', ['loose']],
    [{ email: undefined }, 'none', []],
    [{ email: 'ana@example.test\n' }, 'none', []],
    [{ email: ' ana@example.test' }, 'none', []],
    [{ email: 'ana\u0007@example.test' }, 'none', []],
    [{ email: `${'a'.repeat(252)}@b` }, 'complete', ['exact', 'loose']],
    [{ email: `${'a'.repeat(253)}@b` }, 'none', []],
    [{ orgId: 'org-\uD800' }, 'ambiguous', ['loose']],
    [{ orgId: 'org-\uD801' }, 'ambiguous', ['loose']],
    [{ orgId: 'a'.repeat(200) }, 'complete', ['exact', 'loose']],
    [{ orgId: 'a'.repeat(201) }, 'ambiguous', ['loose']],
    [{ authMethod: 'api_key' }, 'none', []],
    [{ authMethod: 'gateway', orgId: undefined }, 'none', []],
    [{ authMethod: 'oauth_token' }, 'none', []],
    [{ authMethod: 'future' }, 'none', []],
    [{ apiProvider: 'bedrock' }, 'none', []],
    [{ apiProvider: 'vertex' }, 'none', []],
    [{ apiKeySource: 'ANTHROPIC_API_KEY' }, 'none', []],
    [{ loggedIn: false }, 'none', []],
  ]
  const cli = '/opt/tools/claude'
  const env = { PATH: '/usr/bin', AUTOMAGIK_BOT_CLI_HOME: '/fake/bot', CLAUDE_CONFIG_DIR: '/fake/bot/.claude' }
  for (const [overrides, outcome, keys] of cases) {
    const stdout = JSON.stringify({ ...signedIn, ...overrides })
    const calls = []
    const run = (file, args, options, done) => {
      calls.push({ file, args, options })
      done(overrides.loggedIn === false ? Object.assign(new Error('exit'), { code: 1 }) : null, stdout)
    }
    const answer = await accountEvidenceOf(CLAUDE, cli, { env, run, timeoutMs: 20 })
    assert.deepEqual(answer.account, claudeAccount(stdout), stdout)
    assert.equal(reservationOutcome(answer.evidence).outcome, outcome, stdout)
    assert.deepEqual(Object.keys(reservationDigests(answer.evidence, reservationKey)), keys, stdout)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, cli)
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
    assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR)
    assert.equal(calls[0].options.cwd, env.AUTOMAGIK_BOT_CLI_HOME)
    assert.equal(calls[0].options.timeout, 20)
  }
  const unread = { account: undefined, evidence: undefined }
  for (const stdout of ['', 'not json', '{}', '[]']) {
    const run = (file, args, options, done) => done(null, stdout)
    assert.deepEqual(await accountEvidenceOf(CLAUDE, cli, { env, run }), unread)
  }
  const timeout = (file, args, options, done) => done(Object.assign(new Error('timeout'), { killed: true }))
  assert.deepEqual(await accountEvidenceOf(CLAUDE, cli, { env, run: timeout }), unread)
})

test('Codex accountEvidenceOf classifies each account/read alongside the existing consent answer', async () => {
  const cli = '/opt/tools/codex'
  const env = { PATH: '/usr/bin', AUTOMAGIK_BOT_CLI_HOME: '/fake/bot', CODEX_HOME: '/fake/bot/.codex' }
  const chatgpt = planType => ({ type: 'chatgpt', email: 'Ana@Home.example', planType })
  const options = (result) => {
    const server = fakeServer(message => {
      if (message.method === 'initialize') return { id: message.id, result: {} }
      if (message.method === 'account/read') return { id: message.id, result }
      return undefined
    })
    return { env, ...server }
  }
  const read = async (account, outcome, keys) => {
    const result = { account, requiresOpenaiAuth: true }
    const fake = options(result)
    const answer = await accountEvidenceOf(CODEX, cli, fake)
    assert.deepEqual(answer.account, codexAccount(result))
    assert.equal(reservationOutcome(answer.evidence).outcome, outcome)
    const digests = reservationDigests(answer.evidence, reservationKey)
    assert.deepEqual(Object.keys(digests), keys)
    assert.equal(fake.children.length, 1)
    const [{ file, args, options: childOptions, child }] = fake.children
    assert.equal(file, cli)
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://'])
    assert.equal(childOptions.env.CODEX_HOME, env.CODEX_HOME)
    assert.equal(childOptions.cwd, env.AUTOMAGIK_BOT_CLI_HOME)
    assert.deepEqual(child.sent.map(message => message.method), ['initialize', 'initialized', 'account/read'])
    assert.deepEqual(child.sent[2].params, { refreshToken: false })
    assert.equal(child.killed, true)
    return { answer, digests }
  }
  const personal = await read(chatgpt('plus'), 'complete', ['exact', 'loose'])
  const workspace = await read(chatgpt('team'), 'complete', ['exact', 'loose'])
  const byClass = { personal, workspace }
  for (const [group, plans] of Object.entries(CODEX_PLAN_CLASSES)) for (const plan of plans) {
    const { answer, digests } = await read(chatgpt(plan), 'complete', ['exact', 'loose'])
    assert.equal(answer.evidence.class, group, plan)
    assert.deepEqual(digests, byClass[group].digests, plan)
  }
  for (const plan of [undefined, null, 'Plus', ' plus', 'sci', 'sci_plus', 'unknown', 'future-plan', 1]) {
    const { answer, digests } = await read(chatgpt(plan), 'ambiguous', ['loose'])
    assert.equal(answer.evidence.class, 'unknown')
    assert.equal(digests.loose, personal.digests.loose)
    assert.equal(digests.loose, workspace.digests.loose)
  }
  const { answer } = await read({ ...chatgpt('plus'), email: null }, 'none', [])
  assert.deepEqual(answer, { account: undefined, evidence: { person: true, vendor: 'codex', class: 'personal' } })
  for (const account of [{ type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'gcp' }, null, undefined]) {
    const { answer } = await read(account, 'none', [])
    assert.deepEqual(answer.evidence, { person: false })
  }
  const { plan: personalPlan, ...personalIdentity } = await accountOf(CODEX, cli, options({ account: chatgpt('plus') }))
  const { plan: workspacePlan, ...workspaceIdentity } = await accountOf(CODEX, cli, options({ account: chatgpt('team') }))
  // The owner still sees the plan. The facets and id that consent and ref use are the same.
  assert.equal(personalPlan, 'plus')
  assert.equal(workspacePlan, 'team')
  assert.deepEqual(personalIdentity, workspaceIdentity)
  assert.notEqual(personal.digests.exact, workspace.digests.exact)
  assert.deepEqual(await accountEvidenceOf(CODEX, cli, options({ unexpected: true })),
    { account: undefined, evidence: undefined })
})
