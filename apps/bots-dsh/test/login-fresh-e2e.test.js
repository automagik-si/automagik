// Real chat command, row state, team endpoints and ACP service. Both vendor sign-in
// protocols and the connector's turns use only the fake account in a scratch home.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { AgentRun } from '../../acp-dsh/src/host/acp.js'
import { CliHomes } from '../../acp-dsh/src/host/cli-homes.js'
import { launchWindowsLogin } from '../../acp-dsh/src/host/windows-login.js'
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
const PEER = 'same-vendor-bot'
const OTHER = 'other-vendor-bot'
const A = 'account-a@example.test'
const B = 'account-b@example.test'
const OTHER_ACCOUNT = 'other-vendor@example.test'
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

function fakeLogin({ vendor, home, next, onSpawn, redeem, holdStop }) {
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
  child.kill = () => { if (!holdStop) queueMicrotask(() => exit(0)); return true }
  const complete = () => writeFileSync(join(home, 'account'), next)
  if (vendor === 'claude') {
    setImmediate(() => child.stdout.write(`Visit: ${claudeUrl}\nPaste code here if prompted > `))
    child.stdin.once('data', bytes => {
      assert.equal(String(bytes).trim(), `fake-code#${STATE}`)
      if (redeem()) complete()
      queueMicrotask(() => exit(0))
    })
    onSpawn({ home, exit, writeAccount: complete })
  } else {
    child.stdin.on('data', bytes => {
      const { method, id } = JSON.parse(String(bytes))
      if (method === 'initialize') write({ id, result: {} })
      if (method === 'account/login/start') {
        write({ id, result: { type: 'chatgptDeviceCode', loginId: 'fake-login', verificationUrl: deviceUrl, userCode: 'FAKE-1234' } })
      }
    })
    onSpawn({ home, exit, writeAccount: complete, complete() {
      complete()
      write({ method: 'account/login/completed', params: { loginId: 'fake-login', success: true } })
    } })
  }
  return child
}

async function fixture(t, vendor, { peers = false, holdLoginStop = false, extraModel } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chat-fresh-'))
  const agent = join(root, 'connector.mjs')
  const provider = `acp-${vendor}`
  const model = `${provider}/default`
  const otherVendor = vendor === 'claude' ? 'codex' : 'claude'
  const otherProvider = `acp-${otherVendor}`
  const bot = { id: BOT, name: 'Fake Bot', model, createdAt: 1, nativeTools: true, nativeToolsAgent: provider }
  const bots = { [BOT]: bot }
  if (peers) {
    bots[PEER] = { ...bot, id: PEER, name: 'Same vendor Bot' }
    bots[OTHER] = { ...bot, id: OTHER, name: 'Other vendor Bot', model: `${otherProvider}/default`, nativeToolsAgent: otherProvider }
  }
  writeFileSync(agent, connector)
  writeFileSync(join(root, 'state.json'), JSON.stringify({ version: 1, bots, mainBotIds: Object.keys(bots), revision: 1 }))

  const sandboxPolicy = { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) }
  const ctx = fakeContext({ services: { sandboxPolicy } })
  ctx.registry = new Map()
  if (extraModel) {
    ctx.llm.listProviders = () => [{ id: provider }]
    ctx.llm.listModels = async () => [{ id: 'default' }, { id: extraModel }]
  }
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  // DSH keeps the same live Agent and Session handles across ACP startup checks.
  const agents = new Map(Object.keys(bots).map(id => [id, ctx.scopeAgent(id)]))
  ctx.agents = { get: id => agents.get(id), list: () => [...agents.values()] }
  const launches = []
  let pendingLoginStops = 0
  let next = B
  let redeem = true
  let org
  let skipIdentity = false
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
    find: name => name === vendor || (peers && name === otherVendor) ? join(root, name) : undefined,
    signedIn: async (spec, cli, { env }) => existsSync(accountPath(env)),
    account: async (spec, cli, { env }) => {
      if (skipIdentity && spec.key === vendor) { skipIdentity = false; return undefined }
      if (!existsSync(accountPath(env))) return undefined
      const who = contents(readFileSync(accountPath(env), 'utf8'))
      return org ? { ...who, id: `${who.id}\n${org}`, facets: { ...who.facets, org } } : who
    },
    loginSpawn: (cli, args, { env }) => {
      assert.equal(cli, join(root, vendor))
      assert.deepEqual(args, vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['app-server', '--listen', 'stdio://'])
      return fakeLogin({ vendor, next, home: env.AUTOMAGIK_BOT_CLI_HOME, redeem: () => redeem, holdStop: holdLoginStop,
        onSpawn: attempt => launches.push(attempt) })
    },
    ...(holdLoginStop ? { loginTimers: {
      now: Date.now, clearTimeout,
      setTimeout(fn, ms) {
        if (ms !== 5000) return setTimeout(fn, ms)
        pendingLoginStops += 1
        return setTimeout(() => { pendingLoginStops -= 1; fn() }, 25)
      },
    } } : {}),
    logoutRun: () => assert.fail('chat must never log out the fake vendor'),
  })
  const acp = ctx.provided.get('acpAgents')
  const adapter = ctx.adapters[0].adapter
  const selectedHome = id => adapter.agents.get(id).spawn().env.AUTOMAGIK_BOT_CLI_HOME
  const home = selectedHome(provider)
  writeFileSync(join(home, 'account'), A)
  await acp.accountConfirm(provider)
  const otherHome = peers ? selectedHome(otherProvider) : undefined
  if (otherHome) {
    writeFileSync(join(otherHome, 'account'), OTHER_ACCOUNT)
    await acp.accountConfirm(otherProvider)
  }
  ready.length = 0
  const turns = []
  const selections = []
  ctx.sessionController = { async prompt({ sessionId, content }) {
    assert.ok(Object.hasOwn(bots, sessionId))
    const ref = rt.botOf(sessionId).model
    const [provider, model] = ref.split('/')
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model, sessionId,
      messages: [{ role: 'user', content }] }))) chunks.push(chunk)
    turns.push(chunks)
  } }
  if (extraModel) ctx.sessionController.selectModel = async selection => { selections.push(selection) }
  apply(ctx, { home: root })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    const result = await response.json()
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const roster = createSource(indexRoster({ bots: Object.values(bots), rooms: [], agents: [], models: [], prefs: {} }))
  const actions = teamActions({ call, after: promise => promise, roster, loginState: () => login })
  actions.refreshModels = async () => {}
  const login = createCliLogin({ actions, pollMs: 10 })
  const command = loginCommand({ roster, actions, t: key => key })
  t.after(() => login.dispose())
  const createView = () => {
    const view = createCliLogin({ actions, pollMs: 10 })
    t.after(() => view.dispose())
    return view
  }
  const cliRoot = dirname(home)
  const vendorHomes = () => {
    const generations = join(cliRoot, 'homes', vendor)
    const candidates = [home, ...(existsSync(generations) ? readdirSync(generations).map(dir => join(generations, dir)) : [])]
    return candidates.filter(dir => existsSync(dir))
  }
  const credentialHomes = () => vendorHomes().filter(dir => existsSync(join(dir, 'account')))
  const reply = async (sessionId, email) => {
    await call('send', { sessionId, text: 'Who am I?' })
    assert.ok(JSON.stringify(turns.at(-1)).includes(email), `${sessionId} answered as ${email}`)
  }
  return { acp, adapter, call, command, createView, credentialHomes, vendorHomes, home, launches, login, otherHome, otherProvider,
    profile: email => { next = email }, provider, ready, reply, selectedHome, selections, turns, modelOf: sessionId => rt.botOf(sessionId).model,
    choiceOf: botId => rt.cliLoginChoice(botId, provider), pendingLoginStops: () => pendingLoginStops,
    ignoreCallback: () => { redeem = false }, changeOrg: value => { org = value }, missNextIdentity: () => { skipIdentity = true },
    row: () => login.getSnapshot().rows[BOT], session: (sessionId = BOT) => adapter.live.get(sessionId)?.run }
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
    assert.notEqual(h.launches[0].home, h.home)
    assert.deepEqual(h.credentialHomes(), [h.home])
    assert.equal(readFileSync(join(h.home, 'account'), 'utf8'), A)
    assert.equal(h.session(), original, 'the original session survives while sign-in is pending')
    if (vendor === 'claude') await h.login.answer(BOT, `fake-code#${STATE}`)
    else {
      assert.equal(waiting.attempt.userCode, 'FAKE-1234')
      h.launches[0].complete()
    }
    const done = await until(() => h.row()?.stage === 'done' && h.row(), 'the fresh sign-in completed')
    assert.equal(h.adapter.agents.get(h.provider).spawn().env.AUTOMAGIK_BOT_CLI_HOME, h.launches[0].home)
    assert.equal(existsSync(h.home), false, 'A’s previous filesystem home was deleted before completion')
    assert.deepEqual(h.credentialHomes(), [h.launches[0].home])
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

test('round 2 finding 1: restored attempts and ordinary joins keep preserving retries', { timeout: 20_000 }, async t => {
  for (const entry of ['reload', 'ordinary entry']) {
    const h = await fixture(t, 'codex')
    await h.call('send', { sessionId: BOT, text: 'Before retry' })
    const original = h.session()
    h.command.ui.run({ sessionId: BOT })
    await until(() => h.row()?.confirm && !h.row().busy, 'the warning appeared')
    await h.login.switchFresh(BOT)
    await until(() => h.row()?.attempt?.status === 'waiting', 'the first link appeared')
    let view = h.login
    if (entry === 'reload') {
      view.dispose()
      view = h.createView()
      await view.restore(BOT)
    } else {
      await view.open({ botId: BOT, provider: h.provider })
    }
    const row = () => view.getSnapshot().rows[BOT]
    assert.equal(row()?.attempt?.status, 'waiting', entry)
    h.launches[0].exit(1)
    await until(() => row()?.stage === 'failed' && row().stillSignedIn, 'the failed attempt settled')
    view.askSwitch(BOT)
    assert.equal(await view.switchAgain(BOT), true, entry)
    await until(() => row()?.attempt?.status === 'waiting', 'the preserving retry appeared')
    assert.equal(await view.cancel(BOT), true)
    await until(() => h.acp.loginActive() === 0, 'the retry settled')
    await h.call('send', { sessionId: BOT, text: 'After retry cancellation' })
    assert.equal(h.session(), original, entry)
    assert.match(JSON.stringify(h.turns[1]), /account-a@example\.test/)
    assert.equal((await h.acp.account(h.provider)).consent, 'given')
  }
})

async function verifyOtherVendor(h, session) {
  assert.equal(h.selectedHome(h.otherProvider), h.otherHome)
  assert.equal(readFileSync(join(h.otherHome, 'account'), 'utf8'), OTHER_ACCOUNT)
  assert.equal(h.session(OTHER), session)
  await h.reply(OTHER, OTHER_ACCOUNT)
  assert.equal(h.session(OTHER), session)
}

test('round 2 finding 2 one-home amendment: both same-vendor Bots resolve B after confirmed adoption', { timeout: 25_000 }, async t => {
  for (const vendor of ['claude', 'codex']) {
    await t.test(vendor, async t => {
      const h = await fixture(t, vendor, { peers: true })
      await h.reply(BOT, A)
      await h.reply(PEER, A)
      await h.reply(OTHER, OTHER_ACCOUNT)
      const sessions = [BOT, PEER, OTHER].map(id => h.session(id))
      assert.ok(sessions.every(Boolean))
      const models = [BOT, PEER, OTHER].map(h.modelOf)
      const endings = []
      const endProvider = h.adapter.endProvider.bind(h.adapter)
      h.adapter.endProvider = (id, notice) => {
        endings.push({ id, notice, oldHomeExists: existsSync(h.home) })
        endProvider(id, notice)
      }
      h.command.ui.run({ sessionId: BOT })
      await until(() => h.row()?.confirm && !h.row().busy, 'the warning appeared')
      assert.equal(await h.login.switchFresh(BOT), true)
      await until(() => h.row()?.attempt?.status === 'waiting', 'the isolated sign-in link appeared')
      const [attempt] = h.launches
      assert.deepEqual(h.credentialHomes(), [h.home])
      assert.equal(readFileSync(join(h.home, 'account'), 'utf8'), A)
      assert.deepEqual([BOT, PEER, OTHER].map(id => h.session(id)), sessions)
      if (vendor === 'claude') await h.login.answer(BOT, `fake-code#${STATE}`)
      else attempt.complete()
      await until(() => h.row()?.stage === 'done', 'the confirmed sign-in finished')
      assert.equal(existsSync(h.home), false, 'the exact prior home is gone')
      assert.deepEqual(h.vendorHomes(), [attempt.home])
      assert.equal(h.selectedHome(h.provider), attempt.home)
      assert.deepEqual(endings, [{
        id: h.provider, notice: 'The Bot account changed. Sign in again in the app.', oldHomeExists: true,
      }])
      assert.equal(h.session(), undefined)
      assert.equal(h.session(PEER), undefined)
      await h.reply(BOT, B)
      await h.reply(PEER, B)
      assert.notEqual(h.session(), sessions[0])
      assert.notEqual(h.session(PEER), sessions[1])
      assert.deepEqual([BOT, PEER, OTHER].map(h.modelOf), models)
      await verifyOtherVendor(h, sessions[2])
    })
  }
})

test('round 2 finding 2 one-home amendment: failed and cancelled writes leave only A and its Session', { timeout: 30_000 }, async t => {
  for (const vendor of ['claude', 'codex']) {
    for (const end of ['cancel', 'fail']) {
      await t.test(`${vendor}: ${end}`, async t => {
        const h = await fixture(t, vendor, { peers: true })
        await h.call('send', { sessionId: BOT, text: 'Before login' })
        const original = h.session()
        await h.reply(OTHER, OTHER_ACCOUNT)
        const other = h.session(OTHER)
        h.command.ui.run({ sessionId: BOT })
        await until(() => h.row()?.confirm && !h.row().busy, 'the warning appeared')
        h.missNextIdentity()
        await h.login.switchFresh(BOT)
        await until(() => h.row()?.attempt?.status === 'waiting', 'the link appeared')
        const [attempt] = h.launches
        const initial = readdirSync(attempt.home)
        attempt.writeAccount()
        if (end === 'cancel') assert.equal(await h.login.cancel(BOT), true)
        else attempt.exit(1)
        await until(() => h.acp.loginActive() === 0, 'the isolated attempt settled')
        assert.equal(readFileSync(join(h.home, 'account'), 'utf8'), A)
        assert.equal(initial.includes('account'), false)
        assert.equal(existsSync(attempt.home), false)
        assert.deepEqual(h.vendorHomes(), [h.home])
        await h.reply(BOT, A)
        assert.equal(h.session(), original)
        assert.equal((await h.acp.account(h.provider)).consent, 'given')
        assert.deepEqual(h.ready, [])
        await verifyOtherVendor(h, other)
      })
    }
  }
})

test('round 2 finding 3: an unredeemed Claude callback or optional identity field cannot confirm A', { timeout: 20_000 }, async t => {
  for (const callback of [true, false]) {
    await t.test(callback ? 'unredeemed callback' : 'optional organization only', async t => {
      const h = await fixture(t, 'claude')
      const pending = 'pending@example.test'
      writeFileSync(join(h.home, 'account'), pending)
      assert.equal((await h.acp.account(h.provider, { fresh: true })).consent, 'needed')
      h.ignoreCallback()
      h.command.ui.run({ sessionId: BOT })
      await until(() => h.row()?.confirm && !h.row().busy, 'the warning appeared')
      await h.login.switchFresh(BOT)
      await until(() => h.row()?.attempt?.prompt, 'the prompt appeared')
      if (callback) await h.login.answer(BOT, `fake-code#${STATE}`)
      else {
        h.changeOrg('fake-org')
        h.launches[0].exit(0)
      }
      const result = await until(() => ['failed', 'done'].includes(h.row()?.stage) && h.row(), 'the attempt settled')
      assert.equal(result.stage, 'failed')
      assert.deepEqual(h.ready, [])
      assert.equal((await h.acp.account(h.provider, { fresh: true })).consent, 'needed')
    })
  }
})

test('round 2 finding 5: the rendered row requires Continue when cached signed-out status is stale', { timeout: 20_000 }, async t => {
  const h = await fixture(t, 'codex')
  const accountPath = join(h.home, 'account')
  const render = () => elementsOf(CliLoginRow({ bot: { id: BOT }, row: h.row(), manager: h.login }))
  const button = label => render().find(node => node.type === 'button' && node.children[0] === label)
  const warning = () => render().some(node => node.type === 'p' && node.children[0] === 'This stops running Bot work for this account. Continue?')
  rmSync(accountPath)
  assert.equal((await h.acp.account(h.provider, { fresh: true })).signedIn, false)
  writeFileSync(accountPath, A)
  h.command.ui.run({ sessionId: BOT })
  await until(() => h.row() && !h.row().busy, 'the first offer appeared')
  assert.equal(warning(), true)
  assert.equal(h.launches.length, 0)
  h.login.dismiss(BOT)

  rmSync(accountPath)
  h.command.ui.run({ sessionId: BOT })
  await until(() => h.row() && !h.row().busy, 'the signed-out offer appeared')
  assert.equal(warning(), false)
  assert.ok(button('Sign in'))
  writeFileSync(accountPath, A)
  button('Sign in').props.onClick()
  await until(() => h.row() && !h.row().busy, 'the host checked sign-in again')
  assert.equal(warning(), true)
  assert.equal(h.launches.length, 0)
  assert.equal(existsSync(join(h.home, 'paused')), false)
  button('Continue').props.onClick()
  await until(() => h.row()?.attempt?.status === 'waiting', 'Continue started sign-in')
  assert.equal(h.launches.length, 1)
  assert.equal(await h.login.cancel(BOT), true)
})

test('exception: the Windows supervisor admits isolated Claude Code and Codex homes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'win-staged-login-'))
  const homes = new CliHomes(root, { identity: null })
  t.after(() => {
    homes.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  for (const vendor of ['claude', 'codex']) {
    await t.test(vendor, async () => {
      const old = homes.home(vendor)
      homes.begin(vendor, { preserveVersion: true })
      const staged = homes.stageLogin(vendor)
      try {
        const home = staged.env.AUTOMAGIK_BOT_CLI_HOME
        assert.notEqual(home, old)
        assert.equal(homes.home(vendor), old)
        const launch = randomUUID()
        const child = new EventEmitter()
        const started = launchWindowsLogin(join(root, vendor + '.exe'), [], { env: staged.env, cwd: home, launch }, {
          spawn: (_command, _args, options) => {
            assert.equal(options.env.HOME, home)
            assert.equal(options.cwd, home)
            const request = JSON.parse(options.env.AUTOMAGIK_LOGIN_JOB)
            assert.equal(request.stop, join(root, 'login-jobs', launch, 'stop'))
            assert.equal(request.done, join(root, 'login-jobs', launch, 'done'))
            writeFileSync(request.done, request.nonce)
            queueMicrotask(() => child.emit('close', 0))
            return child
          },
        })
        await started.done
        started.dispose()
      } finally {
        staged.discard()
        homes.resume(vendor)
        homes.end(vendor)
      }
    })
  }
})

for (const outcome of ['cancelled', 'adopted']) {
  test(`exception: ${outcome} sign-in preserves the answering Session through teardown`, { timeout: 20_000 }, async t => {
    const cancel = outcome === 'cancelled'
    const h = await fixture(t, 'codex', { peers: true, holdLoginStop: cancel })
    await h.reply(BOT, A)
    await h.reply(OTHER, OTHER_ACCOUNT)
    const original = h.session()
    const other = h.session(OTHER)
    let finishStop
    const canStop = new Promise(resolve => { finishStop = resolve })
    let timedOut = false
    if (!cancel) {
      const stop = original.stop.bind(original)
      t.mock.method(original, 'stop', async () => {
        if (!timedOut) {
          timedOut = true
          throw new Error('Fixture: the old Session did not stop in time')
        }
        await canStop
        await stop()
      })
    }

    await h.login.open({ botId: BOT, provider: h.provider, fresh: true })
    assert.equal(await h.login.switchFresh(BOT), true)
    const waiting = await until(() => h.row()?.attempt?.status === 'waiting' && h.row().attempt, 'the isolated sign-in link appeared')
    const [attempt] = h.launches
    const winningHome = cancel ? h.home : attempt.home
    const losingHome = cancel ? attempt.home : h.home
    try {
      if (cancel) {
        attempt.writeAccount()
        assert.equal(await h.login.cancel(BOT), true)
      } else attempt.complete()
      if (cancel) await until(() => h.acp.loginActive() === 0, 'the login settled after teardown timed out')
      else await until(() => timedOut && !existsSync(join(winningHome, 'paused')), 'B resumed after A’s teardown timed out')
      assert.equal(h.selectedHome(h.provider), winningHome)
      assert.equal(existsSync(join(losingHome, 'account')), true, 'the unproved home was not removed early')
      if (!cancel) {
        assert.equal(timedOut, true)
        assert.notEqual(h.acp.loginStatus(h.provider, waiting.attemptId).status, 'ready', 'A must be gone before ready')
        assert.notEqual(h.row().stage, 'done')
        assert.deepEqual(h.ready, [])
      }
      await h.reply(BOT, cancel ? A : B)
      const winningSession = h.session()
      if (cancel) assert.equal(winningSession, original)
      else assert.notEqual(winningSession, original)

      if (cancel) await until(() => h.pendingLoginStops() === 0, 'all bounded stop calls timed out')
      attempt.exit(0)
      finishStop()
      await until(() => !existsSync(losingHome), 'the stopped process let the exact losing home be removed')
      assert.deepEqual(h.vendorHomes(), [winningHome])
      if (!cancel) {
        await until(() => h.row()?.stage === 'done', 'Done followed the removal of A')
        assert.deepEqual(h.ready, [h.provider])
      }
      await h.reply(BOT, cancel ? A : B)
      assert.equal(h.session(), winningSession)
      await verifyOtherVendor(h, other)
    } finally {
      attempt.exit(0)
      finishStop()
    }
  })
}

test('second exception: startup retries the adopted account’s exact old-home removal', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'restart-chat-cleanup-'))
  const homes = new CliHomes(root, { identity: null })
  t.after(() => {
    homes.closeRecovery()
    homes.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const module = new URL('../../acp-dsh/src/host/cli-homes.js', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import { writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { CliHomes } from ${JSON.stringify(module)}
    const homes = new CliHomes(process.argv[1], { identity: null })
    const old = homes.environment('codex').HOME
    const unrelated = homes.environment('claude').HOME
    writeFileSync(join(old, 'account'), ${JSON.stringify(A)})
    writeFileSync(join(unrelated, 'account'), ${JSON.stringify(OTHER_ACCOUNT)})
    homes.begin('codex', { preserveVersion: true })
    const attempt = homes.stageLogin('codex')
    const adopted = attempt.env.HOME
    writeFileSync(join(adopted, 'account'), ${JSON.stringify(B)})
    attempt.adopt()
    // Simulate a process exit between publication of B and the first removal of A.
    console.log(JSON.stringify({ old, adopted, unrelated }))
  `, root])
  const { old, adopted, unrelated } = JSON.parse(stdout)
  assert.equal(homes.home('codex'), adopted)
  assert.equal(readFileSync(join(old, 'account'), 'utf8'), A)
  assert.equal(readFileSync(join(adopted, 'account'), 'utf8'), B)
  homes.startup('codex')
  await until(() => !existsSync(old), 'startup removed the adopted account’s exact old home')
  assert.equal(homes.paused('codex'), false)
  assert.equal(homes.environment('codex').HOME, adopted)
  assert.equal(readFileSync(join(adopted, 'account'), 'utf8'), B)
  assert.equal(readFileSync(join(unrelated, 'account'), 'utf8'), OTHER_ACCOUNT)
})

test('second exception: rejected cancellation cleanup leaves Settings Reset available', { timeout: 15_000 }, async t => {
  const stageLogin = CliHomes.prototype.stageLogin
  let rejected = 0
  t.mock.method(CliHomes.prototype, 'stageLogin', function (vendor) {
    const staged = stageLogin.call(this, vendor)
    return { ...staged, discard() {
      rejected += 1
      throw new Error('Fixture: the staged home could not be removed')
    } }
  })
  const h = await fixture(t, 'codex', { peers: true })
  await h.reply(BOT, A)
  await h.reply(OTHER, OTHER_ACCOUNT)
  const original = h.session()
  const unrelated = h.session(OTHER)
  await h.login.open({ botId: BOT, provider: h.provider, fresh: true })
  assert.equal(await h.login.switchFresh(BOT), true)
  const waiting = await until(() => h.row()?.attempt?.status === 'waiting' && h.row().attempt, 'the isolated sign-in link appeared')
  const [attempt] = h.launches
  attempt.writeAccount()
  assert.equal(await h.login.cancel(BOT), true)
  await until(() => rejected >= 2 && h.acp.loginActive() === 0, 'the deferred discard also rejected')
  assert.equal(h.acp.loginStatus(h.provider, waiting.attemptId).status, 'cancelled')
  assert.equal(h.row(), undefined)
  assert.equal(h.selectedHome(h.provider), h.home)
  assert.equal(readFileSync(join(attempt.home, 'account'), 'utf8'), B)
  await h.reply(BOT, A)
  assert.equal(h.session(), original)
  assert.equal((await h.acp.accountReset(h.provider)).signedIn, false)
  await verifyOtherVendor(h, unrelated)
})

async function interruptedChatHome(t, interruption, options) {
  const root = mkdtempSync(join(tmpdir(), 'final-chat-home-'))
  const homes = new CliHomes(root, { identity: null, ...options })
  t.after(() => {
    homes.closeRecovery()
    homes.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const module = new URL('../../acp-dsh/src/host/cli-homes.js', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import { readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { CliHomes } from ${JSON.stringify(module)}
    const [root, interruption] = process.argv.slice(1)
    const homes = new CliHomes(root, { identity: null })
    const prepare = (vendor, name) => {
      const home = homes.environment(vendor).HOME
      writeFileSync(join(home, 'account'), name)
      homes.begin(vendor, { preserveVersion: true })
      const attempt = homes.stageLogin(vendor)
      writeFileSync(join(attempt.env.HOME, 'account'), 'attempt')
      return { home, attempt }
    }
    const { home: unrelated, attempt: other } = prepare('claude', 'other')
    const { home: old, attempt } = prepare('codex', 'selected before interruption')
    const staged = attempt.env.HOME
    const journal = join(root, 'current', 'codex.chat-cleanup.json')
    if (interruption.startsWith('before-')) {
      homes.generations.select = (vendor, replacement) => {
        if (interruption === 'before-pointer-rename') {
          const pointer = homes.generations.pointer(vendor)
          writeFileSync(pointer + '.42e40cdc-879d-40fb-9fee-3b80399be419', replacement)
          writeFileSync(pointer + '.activated', '')
        }
        process.exit(0)
      }
      console.log(JSON.stringify({ old, staged, unrelated, other: other.env.HOME }))
      attempt.adopt()
    } else {
      if (interruption === 'windows-old-run') {
        attempt.adopt()
        const entry = JSON.parse(readFileSync(journal, 'utf8'))
        writeFileSync(journal, JSON.stringify({ ...entry, runs: null, stopped: false }))
      }
      console.log(JSON.stringify({ old, staged, unrelated, other: other.env.HOME }))
    }
  `, root, interruption])
  return { root, homes, journal: join(root, 'current', 'codex.chat-cleanup.json'), ...JSON.parse(stdout) }
}

for (const interruption of ['before-selection', 'before-pointer-rename', 'no-journal']) {
  test(`final exception: startup reclaims the unadopted home (${interruption})`, { timeout: 10_000 }, async t => {
    const { root, homes, journal, old, staged, unrelated, other } = await interruptedChatHome(t, interruption)
    assert.equal(existsSync(staged), true)
    assert.equal(existsSync(journal), interruption !== 'no-journal')
    if (interruption === 'no-journal') {
      // A staged marker written by the parent version contains no directory identity.
      writeFileSync(join(root, 'login-staging', 'codex', basename(staged)), '')
    }
    homes.startup('codex')
    assert.equal(existsSync(staged), false, 'startup must reclaim the exact staged path')
    assert.equal(existsSync(journal), false)
    assert.equal(homes.environment('codex').HOME, old)
    assert.equal(homes.paused('codex'), false, 'the pre-existing account can still run')
    assert.equal(readFileSync(join(old, 'account'), 'utf8'), 'selected before interruption')
    assert.equal(existsSync(dirname(staged)), true)
    assert.equal(readFileSync(join(unrelated, 'account'), 'utf8'), 'other')
    assert.equal(readFileSync(join(other, 'account'), 'utf8'), 'attempt')
    assert.equal(existsSync(join(root, 'login-staging', 'codex')), true)
  })
}

for (const staysInUse of [false, true]) {
  test(`final exception: Windows recovery ${staysInUse ? 'keeps a home still in use' : 'reclaims an unused home'}`,
    { timeout: 10_000 }, async t => {
      const seen = []
      const notices = []
      const options = {
        platform: 'win32',
        probeChatHome: async (path, remaining) => {
          seen.push({ path, remaining })
          return staysInUse || seen.length === 1 ? 'in-use' : 'unused'
        },
        onChatCleanupPending: message => notices.push(message),
      }
      const { root, homes, old, staged: selected, unrelated } = await interruptedChatHome(t, 'windows-old-run', options)
      assert.equal(homes.home('codex'), selected)
      const unmarked = join(dirname(selected), randomUUID())
      mkdirSync(unmarked)
      const activeId = randomUUID()
      const active = join(dirname(selected), activeId)
      mkdirSync(join(active, 'login-trees'), { recursive: true })
      writeFileSync(join(root, 'login-staging', 'codex', activeId), '')
      writeFileSync(join(active, 'login-trees', randomUUID()), JSON.stringify({ kind: 'starting', app: process.pid }))
      homes.startup('codex')
      await until(() => staysInUse ? notices.length : !existsSync(old), 'startup must finish bounded Windows recovery')
      assert.equal(seen.length, staysInUse ? 3 : 2)
      assert.ok(seen.every(({ path, remaining }) => path === old && remaining > 0 && remaining <= 15_000))
      assert.equal(homes.environment('codex').HOME, selected)
      assert.equal(homes.paused('codex'), false)
      assert.equal(readFileSync(join(selected, 'account'), 'utf8'), 'attempt')
      assert.equal(readFileSync(join(unrelated, 'account'), 'utf8'), 'other')
      assert.equal(existsSync(old), staysInUse)
      assert.equal(existsSync(active), true, 'startup preserves a staged home still owned by a login')
      assert.equal(existsSync(unmarked), true, 'startup preserves unrelated paths in the vendor parent')
      const current = join(root, 'current')
      const journal = join(current, 'codex.chat-cleanup.json')
      const pending = join(current, `codex.chat-cleanup.${homes.generations.current('codex')}.json`)
      assert.equal(existsSync(journal), false)
      assert.equal(existsSync(pending), staysInUse)
      if (staysInUse) assert.match(notices[0], /still in use.*current account and Reset are available/)
      homes.begin('codex', { preserveVersion: true })
      const later = homes.stageLogin('codex')
      later.discard()
      homes.resume('codex')
      homes.end('codex')
      const reset = homes.reset('codex')
      assert.notEqual(reset, selected)
      assert.equal(existsSync(selected), true, 'Reset preserves its ordinary retirement behavior')
      if (!staysInUse) return
      assert.equal(existsSync(pending), true)
      assert.equal(readFileSync(join(old, 'account'), 'utf8'), 'selected before interruption')
      homes.closeRecovery()
      homes.dispose()
      const restart = new CliHomes(root, { ...options, identity: null, probeChatHome: async path => {
        assert.equal(path, old)
        return 'unused'
      } })
      t.after(() => { restart.closeRecovery(); restart.dispose() })
      restart.startup('codex')
      await until(() => !existsSync(old), 'the next startup reclaims the deferred home after Reset')
      assert.equal(existsSync(pending), false)
      assert.equal(restart.home('codex'), reset)
      assert.equal(readFileSync(join(selected, 'account'), 'utf8'), 'attempt')
    })
}

test('exception: Antigravity Try again must show the warning before signing out an active account', { timeout: 15_000 }, async t => {
  const provider = 'acp-antigravity'
  const bot = { id: BOT, model: `${provider}/default` }
  const root = mkdtempSync(join(tmpdir(), 'agy-chat-retry-'))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  let logouts = 0
  let attempts = 0
  t.mock.method(AgentRun.prototype, 'start', async function () {
    if (this.spec.logout) { logouts += 1; return }
    if (this.spec.authenticate) {
      attempts += 1
      await delay(20)
    }
    throw new Error('Fixture: the fake sign-in did not finish')
  })
  const cliHome = join(root, 'cli-homes')
  applyAcp(ctx, { antigravity: true, claude: false, codex: false }, {
    platform: 'darwin', cliHome,
    store: { home: join(root, 'adapters'), binOf: () => undefined, update: async () => {} },
    find: name => name === 'agy' ? join(root, 'fake-agy') : undefined,
  })
  const acp = ctx.provided.get('acpAgents')
  const rt = { ctx, botOf: id => id === BOT ? bot : undefined, warn: () => {} }
  installLoginRoutes(rt)
  const roster = createSource(indexRoster({ bots: [bot], rooms: [], agents: [], models: [], prefs: {} }))
  const actions = teamActions({ call: (endpoint, payload) => rt.cliLoginActions[endpoint](payload), roster, loginState: () => login })
  actions.refreshModels = async () => {}
  const login = createCliLogin({ actions, pollMs: 10 })
  t.after(() => login.dispose())
  const pointer = join(cliHome, 'current', 'antigravity')
  const row = () => login.getSnapshot().rows[BOT]
  const render = () => elementsOf(CliLoginRow({ bot, row: row(), manager: login }))
  const button = label => render().find(node => node.type === 'button' && node.children[0] === label)
  await login.open({ botId: BOT, provider, fresh: true })
  button('Continue').props.onClick()
  await until(() => row()?.stage === 'failed' && acp.loginActive() === 0, 'the first fake attempt failed')
  assert.equal(attempts, 1)
  const previous = readFileSync(pointer, 'utf8')
  const account = join(cliHome, 'homes', 'antigravity', previous, 'account')
  writeFileSync(account, A) // A synthetic account signed in through Settings while the failed row was open.
  const beforeRetry = logouts
  button('Try again').props.onClick()
  await until(() => !row()?.busy, 'the retry button was handled')
  assert.equal(logouts, beforeRetry, 'no logout before Continue')
  assert.equal(readFileSync(pointer, 'utf8'), previous)
  assert.equal(readFileSync(account, 'utf8'), A)
  assert.ok(render().some(node => node.type === 'p' && node.children[0] === 'This stops running Bot work for this account. Continue?'))
  button('Continue').props.onClick()
  await until(() => attempts === 2 && acp.loginActive() === 0, 'Continue launched the retry')
  assert.equal(logouts, beforeRetry + 1)
  assert.notEqual(readFileSync(pointer, 'utf8'), previous)
})

test('exception: the initiating Bot keeps its model through a reload, failure and successful retry', { timeout: 15_000 }, async t => {
  const model = 'fake-selected'
  const h = await fixture(t, 'codex', { peers: true, extraModel: model })
  const ref = `${h.provider}/${model}`
  const baseline = h.modelOf(BOT)
  const other = h.modelOf(OTHER)
  await h.login.open({ botId: BOT, provider: h.provider, ref })
  h.command.ui.run({ sessionId: BOT })
  await until(() => h.row()?.confirm && !h.row().busy, 'the warning appeared')
  assert.equal(await h.login.switchFresh(BOT), true)
  await until(() => h.row()?.attempt?.status === 'waiting', 'the initial link appeared')
  h.login.dispose()
  const restored = h.createView()
  await restored.restore(BOT)
  await restored.restore(PEER)
  assert.equal(restored.getSnapshot().rows[PEER], undefined)
  h.launches[0].exit(1)
  const row = () => restored.getSnapshot().rows[BOT]
  await until(() => row()?.stage === 'failed' && row().stillSignedIn, 'the restored attempt failed')
  assert.equal(h.modelOf(BOT), baseline)
  restored.askSwitch(BOT)
  assert.equal(await restored.switchAgain(BOT), true)
  await until(() => row()?.attempt?.status === 'waiting', 'the retry link appeared')
  h.launches[1].complete()
  await until(() => row()?.stage === 'done' && h.acp.loginActive() === 0, 'the retry signed in')
  await until(() => h.choiceOf(BOT)?.state !== 'pending', 'the model choice settled')
  const applied = await h.call('cli-login-current', { botId: BOT, provider: h.provider })
  assert.deepEqual(applied.choice, { ref, state: 'applied' })
  assert.deepEqual(h.selections.filter(selection => selection.model === model), [{ sessionId: BOT, provider: h.provider, model }])
  assert.equal(h.modelOf(BOT), ref)
  assert.equal(h.modelOf(PEER), baseline)
  assert.equal(h.modelOf(OTHER), other)
})
