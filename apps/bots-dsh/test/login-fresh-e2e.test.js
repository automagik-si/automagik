// Real chat command, row state, team endpoints and ACP service. Both vendor sign-in
// protocols and the connector's turns use only the fake account in a scratch home.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { apply } from '../index.js'
import { createCliLogin } from '../src/client/cli-login-state.js'
import { createSource, indexRoster } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'
import { install as installLoginRoutes } from '../src/host/cli-login.js'
import { fakeContext } from './fake-ctx.js'

const { outputFiles } = await build({
  stdin: {
    contents: [
      readFileSync(new URL('../src/client/cli-login.js', import.meta.url), 'utf8'),
      'export { CliLoginRow }',
      "export * from './login-command.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require(name) {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }), useLayoutEffect() {} }
    if (name === 'react-dom') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { CliLoginRow, loginCommand } = module.exports
const elementsOf = node => node && typeof node === 'object'
  ? [node, ...node.children.flatMap(elementsOf)]
  : []

const BOT = 'fake-bot'
const A = 'account-a@example.test'
const B = 'account-b@example.test'
const STATE = 'fixture_state_0123456789'
const deviceUrl = 'https://auth.openai.com/codex/device'
const claudeUrl = `https://claude.ai/oauth/authorize?code=true&state=${STATE}`
const contents = email => ({ kind: 'account', id: email, email, facets: { kind: 'account', email } })

async function until(read, label) {
  for (let i = 0; i < 250; i++) {
    const value = read()
    if (value) return value
    await delay(10)
  }
  assert.fail(label)
}

const connector = String.raw`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const email = readFileSync(join(process.env.AUTOMAGIK_BOT_CLI_HOME, 'account'), 'utf8')
const send = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result = {}
  if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} }
  if (method === 'session/new') {
    const mode = process.env.CLAUDE_CODE_PATH ? 'default' : 'workspace-write'
    result = { sessionId: randomUUID(), modes: { currentModeId: mode, availableModes: [
      { id: 'default', name: 'Default' }, { id: 'workspace-write', name: 'Workspace write' },
    ] } }
  }
  if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: email } } } })
    result = { stopReason: 'end_turn' }
  }
  send({ id, result })
}
`

function fakeLogin({ vendor, home, next, onSpawn }) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = child.signalCode = null
  const write = message => child.stdout.write(JSON.stringify(message) + '\n')
  const exit = code => {
    if (child.exitCode !== null) return
    child.exitCode = code
    child.emit('close', code)
  }
  child.kill = () => { queueMicrotask(() => exit(0)); return true }
  const complete = () => writeFileSync(join(home, 'account'), next)
  if (vendor === 'claude') {
    setImmediate(() => child.stdout.write(`Visit: ${claudeUrl}\nPaste code here if prompted > `))
    child.stdin.once('data', bytes => {
      assert.equal(String(bytes).trim(), `fake-code#${STATE}`)
      complete()
      queueMicrotask(() => exit(0))
    })
    onSpawn({ home, exit })
  } else {
    child.stdin.on('data', bytes => {
      const { method, id } = JSON.parse(String(bytes))
      if (method === 'initialize') write({ id, result: {} })
      if (method === 'account/login/start') {
        write({ id, result: { type: 'chatgptDeviceCode', loginId: 'fake-login', verificationUrl: deviceUrl, userCode: 'FAKE-1234' } })
      }
    })
    onSpawn({ home, exit, complete() {
      complete()
      write({ method: 'account/login/completed', params: { loginId: 'fake-login', success: true } })
    } })
  }
  return child
}

async function fixture(t, vendor) {
  const root = mkdtempSync(join(tmpdir(), 'chat-fresh-'))
  const agent = join(root, 'connector.mjs')
  const provider = `acp-${vendor}`
  const model = `${provider}/default`
  const bot = { id: BOT, name: 'Fake Bot', model, createdAt: 1, nativeTools: true, nativeToolsAgent: provider }
  writeFileSync(agent, connector)
  writeFileSync(join(root, 'state.json'), JSON.stringify({ version: 1, bots: { [BOT]: bot }, mainBotIds: [BOT], revision: 1 }))

  const sandboxPolicy = { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) }
  const ctx = fakeContext({ services: { sandboxPolicy } })
  ctx.registry = new Map()
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  ctx.agents = { get: id => ctx.scopeAgent(id), list: () => [] }
  const launches = []
  let next = B
  let route
  const ready = []
  ctx.on('acp-dsh/login-ready', ({ id }) => ready.push(id))
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return register(options)
  }
  const accountPath = env => join(env.AUTOMAGIK_BOT_CLI_HOME, 'account')
  applyAcp(ctx, { dshTools: false, nativeTools: true }, {
    store: { home: join(root, 'adapters'), binOf: () => ({ path: agent, version: '1' }), update: async () => {} },
    find: name => name === vendor ? join(root, name) : undefined,
    signedIn: async (spec, cli, { env }) => existsSync(accountPath(env)),
    account: async (spec, cli, { env }) => existsSync(accountPath(env)) ? contents(readFileSync(accountPath(env), 'utf8')) : undefined,
    loginSpawn: (cli, args, { env }) => {
      assert.equal(cli, join(root, vendor))
      assert.deepEqual(args, vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['app-server', '--listen', 'stdio://'])
      return fakeLogin({ vendor, next, home: env.AUTOMAGIK_BOT_CLI_HOME, onSpawn: attempt => launches.push(attempt) })
    },
    logoutRun: () => assert.fail('chat must never log out the fake vendor'),
  })
  const acp = ctx.provided.get('acpAgents')
  const adapter = ctx.adapters[0].adapter
  const home = adapter.agents.get(provider).spawn().env.AUTOMAGIK_BOT_CLI_HOME
  writeFileSync(join(home, 'account'), A)
  await acp.accountConfirm(provider)
  ready.length = 0
  const turns = []
  ctx.sessionController = { async prompt({ sessionId, content }) {
    assert.equal(sessionId, BOT)
    const ref = rt.botOf(BOT).model
    const [provider, model] = ref.split('/')
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model, sessionId,
      messages: [{ role: 'user', content }] }))) chunks.push(chunk)
    turns.push(chunks)
  } }
  apply(ctx, { home: root })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    const result = await response.json()
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const roster = createSource(indexRoster({ bots: [bot], rooms: [], agents: [], models: [], prefs: {} }))
  const actions = teamActions({ call, after: promise => promise, roster, loginState: () => login })
  actions.refreshModels = async () => {}
  const login = createCliLogin({ actions, pollMs: 10 })
  const command = loginCommand({ roster, actions, t: key => key })
  t.after(() => login.dispose())
  return { acp, adapter, call, command, home, launches, login, profile: email => { next = email }, provider, ready, turns,
    row: () => login.getSnapshot().rows[BOT], session: () => adapter.live.get(BOT)?.run }
}

for (const vendor of ['claude', 'codex']) {
  test(`${vendor}: /login signs in as B and the same Bot answers as B`, { timeout: 20_000 }, async t => {
    const h = await fixture(t, vendor)
    await h.call('send', { sessionId: BOT, text: 'Who am I?' })
    assert.match(JSON.stringify(h.turns[0]), /account-a@example\.test/)
    const original = h.session()
    assert.ok(original)
    h.command.ui.run({ sessionId: BOT })
    const offer = await until(() => h.row()?.busy === false && h.row(), 'the chat row opened')
    assert.equal(offer.stage, 'offer')
    assert.equal(offer.confirm, true, 'the signed-in Bot asks before starting a fresh sign-in')
    assert.equal(h.launches.length, 0)
    const rendered = CliLoginRow({ bot: { id: BOT }, row: offer, manager: h.login })
    const proceed = elementsOf(rendered).find(node => node.type === 'button' && node.children[0] === 'Continue')
    assert.ok(proceed)
    proceed.props.onClick()
    const waiting = await until(() => h.row()?.attempt?.status === 'waiting' && h.row(), 'the fresh sign-in link appeared')
    assert.equal(waiting.attempt.url, vendor === 'claude' ? claudeUrl : deviceUrl)
    assert.equal(h.launches.length, 1)
    assert.equal(h.launches[0].home, h.home)
    assert.equal(h.session(), original, 'the original session survives while sign-in is pending')
    if (vendor === 'claude') await h.login.answer(BOT, `fake-code#${STATE}`)
    else {
      assert.equal(waiting.attempt.userCode, 'FAKE-1234')
      h.launches[0].complete()
    }
    const done = await until(() => h.row()?.stage === 'done' && h.row(), 'the fresh sign-in completed')
    assert.equal(done.signedInAs.email, B)
    assert.equal(done.sameAccount, undefined)
    assert.deepEqual(h.ready, [h.provider])
    const status = await h.acp.account(h.provider, { fresh: true })
    assert.equal(status.account.email, B)
    assert.equal(status.consent, 'given')
    await h.call('send', { sessionId: BOT, text: 'Who am I after sign-in?' })
    assert.match(JSON.stringify(h.turns[1]), /account-b@example\.test/)
    assert.notEqual(h.session(), original, 'a confirmed account change replaces the original session')
  })
}

for (const vendor of ['claude', 'codex']) {
  test(`${vendor}: a failed attempt and a cancelled retry preserve the original account and session`, { timeout: 20_000 }, async t => {
    const h = await fixture(t, vendor)
    await h.call('send', { sessionId: BOT, text: 'Before sign-in' })
    const original = h.session()
    assert.ok(original)
    h.command.ui.run({ sessionId: BOT })
    await until(() => h.row()?.confirm && !h.row().busy, 'the sign-in question appeared')
    assert.equal(await h.login.switchFresh(BOT), true)
    const first = await until(() => h.row()?.attempt?.status === 'waiting' && h.row().attempt, 'the sign-in link appeared')

    await assert.rejects(h.acp.accountSwitch(h.provider, { fresh: true, label: 'another-bot' }), { code: 'acp-account/busy' })
    await assert.rejects(h.acp.accountSwitch(h.provider), { code: 'acp-account/busy' })
    await assert.rejects(h.acp.signInNative('acp-antigravity'), { code: 'acp-account/busy' })
    assert.equal(h.acp.loginCurrent(h.provider).attemptId, first.attemptId)
    assert.equal((await h.acp.loginStart(h.provider, { label: 'ordinary model choice' })).attemptId, first.attemptId)
    assert.equal(h.launches.length, 1)
    assert.equal(h.session(), original)
    // Claude's zero exit with no answer is deliberately indistinguishable from the old
    // login until the host checks that the existing account was never confirmed here.
    h.launches[0].exit(vendor === 'claude' ? 0 : 1)
    await until(() => h.row()?.stage === 'failed' && h.row().stillSignedIn, 'the failed switch settled')
    assert.equal(h.acp.loginActive(), 0)
    assert.equal(h.row().message, 'The account did not change. Try again.')
    assert.deepEqual(h.ready, [])
    assert.equal((await h.acp.account(h.provider)).consent, 'given')
    await h.call('send', { sessionId: BOT, text: 'After failure' })
    assert.equal(h.session(), original)
    assert.match(JSON.stringify(h.turns[1]), /account-a@example\.test/)

    h.login.askSwitch(BOT)
    assert.equal(h.row().confirm, true)
    await h.login.switchAgain(BOT)
    const retry = await until(() => h.row()?.attempt?.status === 'waiting' && h.row().attempt, 'the retry link appeared')
    assert.notEqual(retry.attemptId, first.attemptId)
    assert.equal(h.launches.length, 2)
    h.login.askCancel(BOT)
    await h.login.cancel(BOT)
    await until(() => h.acp.loginActive() === 0, 'the host settled the cancelled retry')
    assert.equal(h.acp.loginStatus(h.provider, retry.attemptId).status, 'cancelled')
    assert.equal((await h.acp.account(h.provider)).account.email, A)
    assert.equal((await h.acp.account(h.provider)).consent, 'given')
    assert.deepEqual(h.ready, [])
    await h.call('send', { sessionId: BOT, text: 'After cancellation' })
    assert.equal(h.session(), original)
    assert.match(JSON.stringify(h.turns[2]), /account-a@example\.test/)
  })
}

test('Claude requires completion from this attempt even if A is signed in without consent', { timeout: 20_000 }, async t => {
  const h = await fixture(t, 'claude')
  const unconfirmed = 'pending@example.test'
  writeFileSync(join(h.home, 'account'), unconfirmed)
  assert.equal((await h.acp.account(h.provider, { fresh: true })).consent, 'needed')
  h.command.ui.run({ sessionId: BOT })
  await until(() => h.row()?.confirm && !h.row().busy, 'the account step was replaced by the question')
  assert.equal(await h.login.switchFresh(BOT), true)
  await until(() => h.row()?.attempt?.status === 'waiting', 'the fake CLI printed a link')
  h.launches[0].exit(0)
  await until(() => h.row()?.stage === 'failed', 'the unproven consent attempt settled')
  const after = await h.acp.account(h.provider, { fresh: true })
  assert.equal(after.account.email, unconfirmed)
  assert.equal(after.consent, 'needed')
  assert.deepEqual(h.ready, [])

  h.profile(unconfirmed)
  h.login.askSwitch(BOT)
  await h.login.switchAgain(BOT)
  await until(() => h.row()?.attempt?.prompt, 'the genuine attempt asked for its code')
  await h.login.answer(BOT, `fake-code#${STATE}`)
  const done = await until(() => h.row()?.stage === 'done' && h.row(), 'the same-account sign-in completed')
  assert.equal(done.sameAccount, true)
  assert.equal(done.signedInAs.email, unconfirmed)
  assert.deepEqual(h.ready, [h.provider])
  assert.equal((await h.acp.account(h.provider)).consent, 'given')
})

test('Windows Antigravity shows the same Settings refusal even when sign-in status is unknown', async t => {
  const provider = 'acp-antigravity'
  const bot = { id: BOT, model: `${provider}/default` }
  const sentence = 'Sign out is not available on Windows. Sign out in Antigravity itself.'
  const ctx = fakeContext()
  const root = mkdtempSync(join(tmpdir(), 'win-chat-fresh-'))
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  applyAcp(ctx, { antigravity: true, claude: false, codex: false }, {
    platform: 'win32',
    cliHome: join(root, 'cli-homes'),
    store: { binOf: () => undefined, update: async () => {} },
    find: () => undefined,
    signedIn: async () => undefined,
    loginSpawn: () => assert.fail('Windows must not spawn a login'),
    logoutRun: () => assert.fail('Windows must not log out'),
  })
  const acp = ctx.provided.get('acpAgents')
  const rt = { ctx, botOf: id => id === BOT ? bot : undefined, warn: () => {} }
  installLoginRoutes(rt)
  const roster = createSource(indexRoster({ bots: [bot], rooms: [], models: [], prefs: {} }))
  const actions = teamActions({ call: (endpoint, payload) => rt.cliLoginActions[endpoint](payload),
    roster, loginState: () => login })
  const login = createCliLogin({ actions })
  t.after(() => login.dispose())
  assert.equal((await acp.status()).agents.find(row => row.id === provider).signedIn, undefined)
  loginCommand({ roster, actions, t: key => key }).ui.run({ sessionId: BOT })
  const row = () => login.getSnapshot().rows[BOT]
  const offer = await until(() => row()?.confirm && !row().busy && row(), 'the warning appeared')
  const render = view => elementsOf(CliLoginRow({ bot, row: view, manager: login }))
  render(offer).find(node => node.type === 'button' && node.children[0] === 'Continue').props.onClick()
  const refused = await until(() => row()?.error && row(), 'the refusal appeared')
  assert.equal(refused.error, sentence)
  assert.ok(render(refused).some(node => node.type === 'p' && node.children[0] === sentence))
  assert.equal(acp.loginActive(), 0)
  assert.equal(existsSync(join(root, 'cli-homes', 'current', 'antigravity')), false)
})

test('a chat request cannot replace an ordinary terminal sign-in already at work', { timeout: 20_000 }, async t => {
  const h = await fixture(t, 'codex')
  rmSync(join(h.home, 'account'))
  await h.acp.account(h.provider, { fresh: true })
  const ordinary = await h.acp.loginStart(h.provider, { label: 'settings' })
  const waiting = await until(() => {
    const view = h.acp.loginStatus(h.provider, ordinary.attemptId)
    return view.status === 'waiting' && view
  }, 'the ordinary Settings link appeared')
  for (const id of [h.provider, 'acp-claude']) {
    await assert.rejects(h.acp.accountSwitch(id, { fresh: true, label: BOT }), { code: 'acp-account/busy' })
  }
  assert.equal(h.acp.loginCurrent(h.provider).attemptId, waiting.attemptId)
  assert.equal(h.launches.length, 1)
  assert.equal(h.launches[0].home, h.home)
  h.acp.loginCancel(h.provider, waiting.attemptId)
})
