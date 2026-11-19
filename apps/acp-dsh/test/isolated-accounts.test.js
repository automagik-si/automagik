// Fake vendor auth stores and CLI processes only. No real credential is read or copied.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { apply, SERVICE } from '../index.js'
import { GENERATION_ENV, POINTER_ENV } from '../src/host/cli-generations.js'
import { CliHomes, HOME_ENV, trackRun } from '../src/host/cli-homes.js'
import { CONSENT_FILE, ConsentStore } from '../src/host/consent.js'
import { recordLogin } from '../src/host/login-ownership.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/names.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const who = email => ({ kind: 'account', id: email, facets: { kind: 'account', email }, email })

function fixture(t, { cold, root: sharedRoot, installation, deps } = {}) {
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), 'isolated-accounts-'))
  const terminalHomes = { claude: join(root, 'terminal', '.claude'),
    codex: join(root, 'terminal', '.codex') }
  const auth = {
    has: dir => existsSync(join(dir, 'account')),
    get: dir => readFileSync(join(dir, 'account'), 'utf8'),
    set(dir, email) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'account'), email)
    },
    delete: dir => rmSync(join(dir, 'account'), { force: true }),
  }
  for (const [vendor, name] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME']]) {
    auth.set(terminalHomes[vendor], 'terminal-work@example.test')
    if (sharedRoot) continue
    const previous = process.env[name]
    process.env[name] = terminalHomes[vendor]
    t.after(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  const terminal = join(terminalHomes.claude, 'account')
  const selected = (vendor, env) => (
    env[vendor === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] ?? terminalHomes[vendor]
  )
  const calls = []
  const events = []
  const logs = []
  const cleanups = []
  let service, adapter
  const ctx = {
    logger: { info: line => logs.push(line), warn() {} },
    agents: { list: () => [], get: () => ({ status: 'idle',
      ctx: { tools: { register: () => () => {} } }, session: { header: {} } }) },
    llm: { registerAdapter(ids, value) { adapter = value; return () => {} },
      listProviders: () => [], listModels: () => new Promise(() => {}) },
    on() {}, get() {}, provide(name, value) { if (name === SERVICE) service = value },
    effect(setup) { cleanups.push(setup()) }, emit(name) { events.push(name) },
  }
  const signedIn = async (spec, cli, { env }) => {
    calls.push({ kind: 'status', vendor: spec.key, env })
    return auth.has(selected(spec.key, env))
  }
  let nextAccount = 'personal@example.test'
  let failLogout = false
  let imageCheck = async () => ({ ok: true })
  let stuckLogin = false
  const loginChildren = []
  const spawn = (cli, args, options) => {
    calls.push({ kind: 'login', cli, args, ...options })
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = child.signalCode = null
    child.stuck = stuckLogin
    loginChildren.push(child)
    child.kill = () => {
      if (child.stuck) return false
      if (child.exitCode === null) {
        child.exitCode = 0
        queueMicrotask(() => child.emit('close', 0))
      }
    }
    const complete = () => auth.set(selected(cli.endsWith('claude') ? 'claude' : 'codex',
      options.env), nextAccount)
    if (cli.endsWith('claude')) {
      setImmediate(() => { complete(); child.exitCode = 0; child.emit('close', 0) })
    } else {
      child.stdin.on('data', line => {
        const request = JSON.parse(String(line))
        if (request.method === 'initialize') child.stdout.write(
          `${JSON.stringify({ id: request.id, result: {} })}\n`)
        if (request.method === 'account/login/start') {
          complete()
          child.stdout.write(`${JSON.stringify({ id: request.id, result: {
            type: 'chatgptDeviceCode', loginId: 'fake-login', userCode: 'ABCD-1234',
            verificationUrl: 'https://auth.openai.com/codex/device',
          } })}\n`)
          child.stdout.write(`${JSON.stringify({ method: 'account/login/completed',
            params: { loginId: 'fake-login', success: true } })}\n`)
        }
      })
    }
    return child
  }
  if (cold) {
    const privateRoot = join(root, 'cli-homes')
    const home = join(privateRoot, 'codex')
    mkdirSync(home, { recursive: true })
    if (cold === 'pending' || cold === 'damaged') {
      mkdirSync(join(home, 'login-trees'))
      writeFileSync(join(home, 'login-trees', 'interrupted'), cold === 'damaged' ? '{'
        : JSON.stringify({ kind: 'starting', app: 2, owner: 'previous-app' }))
    } else if (cold === 'legacy') {
      const pid = Number(spawnSync(process.execPath, ['-p', 'process.pid'], {
        encoding: 'utf8',
      }).stdout.trim())
      mkdirSync(join(home, 'instances'))
      writeFileSync(join(home, 'instances', `${pid}-legacy`), '')
    } else if (cold === 'missing-pointer') {
      const previous = new CliHomes(privateRoot)
      previous.environment('codex')
      previous.reset('codex')
      previous.dispose()
      rmSync(join(privateRoot, 'current', 'codex'))
    }
  }
  apply(ctx, {}, {
    store: { home: join(root, 'adapters'),
      binOf: () => ({ path: '/fake/adapter', version: '1' }), update: async () => {} },
    cliStore: undefined, find: name => `/fake/${name}`,
    signedIn, account: async (spec, cli, { env }) => {
      calls.push({ kind: 'account', vendor: spec.key, env })
      const home = selected(spec.key, env)
      return auth.has(home) ? who(auth.get(home)) : undefined
    },
    loginSpawn: spawn,
    logoutRun(cli, args, options, done) {
      calls.push({ kind: 'logout', cli, args, ...options })
      if (!failLogout) auth.delete(selected(cli.endsWith('claude') ? 'claude' : 'codex',
        options.env))
      done(failLogout ? new Error('invented-private-output') : null)
    },
    imageSetup: (...args) => imageCheck(...args),
    installation,
    ...deps,
  })
  let stopped
  const stopService = async () => {
    for (const child of loginChildren) { child.stuck = false; child.kill() }
    for (const cleanup of cleanups) cleanup()
    await tick()
    if (!sharedRoot) rmSync(root, { recursive: true, force: true })
  }
  const stop = () => (stopped ??= stopService())
  t.after(stop)
  const waitForLogin = async (id, attempt) => {
    for (let i = 0; i < 30; i++) {
      await tick()
      if (service.loginStatus(id, attempt.attemptId).status === 'ready') return
    }
    assert.fail('fake sign-in did not finish')
  }
  const login = async id => waitForLogin(id, await service.loginStart(id))
  return { service, adapter, auth, calls, events, root, terminal, login, logs, stop, waitForLogin,
    next: email => { nextAccount = email }, fail: value => { failLogout = value },
    stallLogin: value => { stuckLogin = value },
    imageCheck: check => { imageCheck = check } }
}

for (const id of ['acp-claude', 'acp-codex']) {
  test(`${id}: isolated login/logout/switch preserve the signed-in terminal`, async t => {
    const h = fixture(t)
    assert.equal((await h.service.inspect(id)).signedIn, false)
    assert.equal(h.service.authScope, 'isolated')
    const blocked = []
    for await (const event of h.adapter.stream({ provider: id, model: 'default',
      sessionId: 'bot', messages: [{ role: 'user', content: 'hello' }] })) blocked.push(event)
    assert.ok(JSON.stringify(blocked).includes(MODEL_ACCESS_REQUIRED))
    assert.match(JSON.stringify(blocked), /Sign in.*in the app/)
    await h.login(id)
    const account = await h.service.account(id, { fresh: true })
    assert.equal(account.account.email, 'personal@example.test')
    assert.equal(account.consent, 'given', 'old connector does not carry terminal consent')
    assert.equal((await h.service.terminalAccount(id)).account.email,
      'terminal-work@example.test')
    const launch = h.adapter.agents.get(id).spawn()
    const login = h.calls.find(call => call.kind === 'login')
    assert.equal(launch.env[HOME_ENV], login.env[HOME_ENV])
    assert.equal(h.adapter.agents.get(id).catalog.spec.spawn().env[HOME_ENV],
      login.env[HOME_ENV])
    for (const call of h.calls.filter(call => ['status', 'account'].includes(call.kind)
      && call.env[HOME_ENV])) assert.equal(call.env[HOME_ENV], launch.env[HOME_ENV])
    await h.service.accountSignOut(id)
    assert.equal((await h.service.inspect(id)).signedIn, false)
    assert.equal((await h.service.account(id)).account, undefined)
    h.next('second@example.test')
    await h.service.accountSwitch(id, { label: 'bot' })
    for (let i = 0; i < 20; i++) await tick()
    assert.equal((await h.service.account(id, { fresh: true })).account.email,
      'second@example.test')
    assert.equal(readFileSync(h.terminal, 'utf8'), 'terminal-work@example.test')
    assert.equal(readFileSync(join(h.root, 'terminal', '.codex', 'account'), 'utf8'),
      'terminal-work@example.test')
    assert.ok(h.calls.filter(call => call.kind === 'logout').every(call =>
      call.cwd === launch.env[HOME_ENV]))
  })
}

for (const cold of ['pending', 'damaged', 'legacy', 'missing-pointer']) {
  test(`cold ACP keeps owner recovery available for ${cold} while the other vendor works`,
    async t => {
      const h = fixture(t, { cold })
      assert.equal(h.service.accountRecovery('acp-codex').required, true)
      assert.equal(h.service.accountRecovery('acp-claude').required, false)
      assert.equal((await h.service.inspect('acp-claude')).signedIn, false)
      await h.service.accountReset('acp-codex')
      assert.equal(h.service.accountRecovery('acp-codex').required, false)
      await h.login('acp-codex')
      assert.equal((await h.service.account('acp-codex', { fresh: true })).account.email,
        'personal@example.test')
      assert.equal(readFileSync(h.terminal, 'utf8'), 'terminal-work@example.test')
    })
}

test('sign-out blocks new work and waits for running work before invoking logout', async t => {
  const h = fixture(t)
  await h.login('acp-codex')
  const env = h.adapter.agents.get('acp-codex').spawn().env
  const before = h.calls.filter(call => call.kind === 'logout').length
  let release
  trackRun({ spec: { env }, stop: () => new Promise(resolve => { release = resolve }) })
  const changing = h.service.accountSignOut('acp-codex')
  while (!release) await tick()
  assert.equal(h.calls.filter(call => call.kind === 'logout').length, before)
  assert.equal((await h.service.imageAccess()).ready, false)
  await assert.rejects(h.service.accountSignOut('acp-codex'), { code: 'acp-account/busy' })
  release()
  await changing
  assert.equal(h.calls.filter(call => call.kind === 'logout').length, before + 1)
})

test('logout errors pause work, hide CLI output, and allow explicit retry', async t => {
  const h = fixture(t)
  await h.login('acp-codex')
  h.fail(true)
  await assert.rejects(h.service.accountSignOut('acp-codex'), error => {
    assert.equal(error.code, 'acp-account/logout')
    assert.doesNotMatch(error.message, /private/)
    return true
  })
  assert.equal((await h.service.inspect('acp-codex')).signedIn, false)
  assert.equal((await h.service.imageAccess()).ready, false)
  h.fail(false)
  await h.service.accountSignOut('acp-codex')
  assert.equal((await h.service.inspect('acp-codex')).signedIn, false)
})

test('image readiness delayed across sign-out never authorizes work on the next account',
  async t => {
    const h = fixture(t)
    await h.login('acp-codex')
    let release, began
    const waiting = new Promise(resolve => { began = resolve })
    h.imageCheck(() => new Promise(resolve => { release = resolve; began() }))
    const access = h.service.imageAccess()
    await waiting
    await h.service.accountSignOut('acp-codex')
    release({ ok: true })
    assert.equal((await access).ready, false)
  })

test('a generation-zero image ticket is refused after switching to another Bot account',
  async t => {
    const h = fixture(t)
    const env = h.adapter.agents.get('acp-codex').spawn().env
    h.auth.set(env.CODEX_HOME, 'first@example.test')
    await h.service.accountConfirm('acp-codex')
    const before = await h.service.imageAccess()
    assert.equal(before.accountGeneration, 0)
    h.next('second@example.test')
    await h.service.accountSwitch('acp-codex')
    for (let i = 0; i < 20; i++) await tick()
    assert.equal((await h.service.account('acp-codex')).account.email, 'second@example.test')
    await assert.rejects(h.service.generateImage({ prompt: 'a fox',
      accountGeneration: before.accountGeneration }), { code: 'acp/image-signed-out' })
  })

test('owner reset clears a blocked account with fresh home and account consent', async t => {
  const h = fixture(t)
  await h.login('acp-codex')
  const previous = h.adapter.agents.get('acp-codex').spawn().env
  const ticket = (await h.service.imageAccess()).accountGeneration
  const crashed = new CliHomes(join(h.root, 'cli-homes'))
  const env = crashed.environment('codex')
  recordLogin(env)
  crashed.dispose()
  assert.equal(h.service.accountRecovery('acp-codex').required, true)
  const before = h.calls.filter(call => call.kind === 'logout').length
  await h.service.accountReset('acp-codex')
  assert.equal(h.calls.filter(call => call.kind === 'logout').length, before,
    'reset never logs out or changes the old credential store')
  assert.equal(h.service.accountRecovery('acp-codex').required, false)
  assert.equal((await h.service.inspect('acp-codex')).signedIn, false)
  assert.equal((await h.service.imageAccess()).ready, false)
  const fresh = h.adapter.agents.get('acp-codex').spawn().env
  assert.notEqual(fresh[HOME_ENV], previous[HOME_ENV])
  assert.equal(h.auth.has(fresh.CODEX_HOME), false, 'credentials were not copied')
  assert.equal(h.auth.get(previous.CODEX_HOME), 'personal@example.test')
  await assert.rejects(h.service.generateImage({ prompt: 'a fox',
    accountGeneration: ticket }), { code: 'acp/image-signed-out' })
  h.next('fresh@example.test')
  await h.login('acp-codex')
  assert.equal((await h.service.account('acp-codex', { fresh: true })).account.email,
    'fresh@example.test')
  assert.equal(h.adapter.agents.get('acp-codex').catalog.spec.spawn().env[HOME_ENV],
    fresh[HOME_ENV])
  assert.equal(readFileSync(h.terminal, 'utf8'), 'terminal-work@example.test')
  assert.throws(() => trackRun({ spec: { env: previous } }), /account changed/)
})

test('reset waits for running work and invalidates image readiness across the home change',
  async t => {
    const h = fixture(t)
    await h.login('acp-codex')
    const env = h.adapter.agents.get('acp-codex').spawn().env
    let release, started
    const stopping = new Promise(resolve => { started = resolve })
    trackRun({ spec: { env }, stop: () => new Promise(resolve => {
      release = resolve; started()
    }) })
    const reset = h.service.accountReset('acp-codex')
    await stopping
    assert.equal(h.adapter.agents.get('acp-codex').spawn().env[HOME_ENV], env[HOME_ENV])
    await assert.rejects(h.service.accountReset('acp-codex'), { code: 'acp-account/busy' })
    assert.equal((await h.service.imageAccess()).ready, false)
    release()
    await reset
    assert.notEqual(h.adapter.agents.get('acp-codex').spawn().env[HOME_ENV], env[HOME_ENV])
  })

test('image setup delayed across reset cannot authorize an old or new account', async t => {
  const h = fixture(t)
  await h.login('acp-codex')
  let release, began
  const started = new Promise(resolve => { began = resolve })
  h.imageCheck(() => new Promise(resolve => { release = resolve; began() }))
  const access = h.service.imageAccess()
  await started
  await h.service.accountReset('acp-codex')
  release({ ok: true })
  assert.equal((await access).ready, false)
})

test('reset can sign in fresh after its old in-memory login cannot prove a stopped tree',
  { timeout: 15_000 }, async t => {
    const h = fixture(t)
    h.stallLogin(true)
    await h.login('acp-codex')
    const old = h.adapter.agents.get('acp-codex').spawn().env
    const interrupted = new CliHomes(join(h.root, 'cli-homes'))
    recordLogin(interrupted.environment('codex'))
    interrupted.dispose()
    h.stallLogin(false)
    await h.service.accountReset('acp-codex')
    const fresh = h.adapter.agents.get('acp-codex').spawn().env
    assert.notEqual(fresh[HOME_ENV], old[HOME_ENV])
    assert.equal(existsSync(old[HOME_ENV]), true, 'unproved old home is still retained')
    h.next('fresh-after-failed-drain@example.test')
    await h.login('acp-codex')
    h.auth.set(old.CODEX_HOME, 'late-old-login@example.test')
    assert.equal((await h.service.account('acp-codex', { fresh: true })).account.email,
      'fresh-after-failed-drain@example.test')
    assert.equal(h.auth.get(old.CODEX_HOME), 'late-old-login@example.test')
  })

for (const id of ['acp-codex', 'acp-claude']) {
  test(`${id}: Bot sign-in refreshes immediately, including after switch and reset`, async t => {
    const { Catalog } = await import('../src/host/catalog.js')
    const original = Catalog.prototype.refresh
    const refreshed = []
    t.mock.method(Catalog.prototype, 'refresh', function () {
      refreshed.push(this)
      this.spec.spawn = () => ({ command: process.execPath,
        args: [join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')] })
      return original.call(this)
    })
    const h = fixture(t)
    const first = h.adapter.agents.get(id).catalog
    first.spec.spawn = () => { throw new Error('signed out') }
    await original.call(first)
    refreshed.length = 0
    await h.login(id)
    const signedIn = h.adapter.agents.get(id).catalog
    assert.deepEqual(refreshed, [signedIn])
    await signedIn.probing
    assert.ok(signedIn.current().some(row => row.id === 'fake-large'))
    assert.ok(h.events.includes('acp-dsh/login-ready'))
    await h.service.accountSwitch(id)
    for (let i = 0; i < 30 && refreshed.length < 2; i++) await tick()
    const switched = h.adapter.agents.get(id).catalog
    assert.notEqual(switched, signedIn)
    assert.equal(refreshed.at(-1), switched)
    await switched.probing
    await h.service.accountReset(id)
    const reset = h.adapter.agents.get(id).catalog
    assert.notEqual(reset, switched)
    await h.login(id)
    const current = h.adapter.agents.get(id).catalog
    assert.equal(refreshed.at(-1), current)
    await current.probing
    assert.ok(current.current().some(row => row.id === 'fake-large'))
  })

  test(`${id}: confirming an existing account refreshes and a read failure keeps consent`,
    async t => {
      const h = fixture(t)
      const agent = h.adapter.agents.get(id)
      const env = agent.spawn().env
      h.auth.set(env[id === 'acp-codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'],
        'ada@example.test')
      let probes = 0
      agent.catalog.spec.spawn = () => { probes++; throw new Error('model read failed') }
      await agent.catalog.refresh()
      const account = await h.service.account(id, { fresh: true })
      assert.equal(account.consent, 'needed')
      const confirmed = await h.service.accountConfirm(id, { ref: account.ref })
      assert.equal(probes, 2)
      await agent.catalog.probing
      assert.equal(confirmed.signedIn, true)
      assert.equal(confirmed.consent, 'given')
      assert.ok(h.events.includes('acp-dsh/login-ready'))
    })

  test(`${id}: a failing catalog refresh leaves Bot sign-in successful`, async t => {
    const { Catalog } = await import('../src/host/catalog.js')
    const original = Catalog.prototype.refresh
    let probes = 0
    t.mock.method(Catalog.prototype, 'refresh', function () {
      this.spec.spawn = () => { probes++; throw new Error('model read failed') }
      return original.call(this)
    })
    const h = fixture(t)
    await h.adapter.agents.get(id).catalog.refresh()
    await h.login(id)
    await h.adapter.agents.get(id).catalog.probing
    assert.equal(probes, 2)
    assert.equal((await h.service.inspect(id)).signedIn, true)
    assert.ok(h.events.includes('acp-dsh/login-ready'))
  })
}

test('a stale sign-in completion cannot refresh the catalog after an account reset', async t => {
  const { CliLogins } = await import('../src/host/login.js')
  const active = CliLogins.prototype.activeAttempts
  let logins
  t.mock.method(CliLogins.prototype, 'activeAttempts', function () {
    logins = this
    return active.call(this)
  })
  const h = fixture(t)
  h.service.loginActive()
  const id = 'acp-codex'
  const selected = { cli: '/fake/codex', env: h.adapter.agents.get(id).spawn().env }
  await h.service.accountReset(id)
  const catalog = h.adapter.agents.get(id).catalog
  let probes = 0
  catalog.spec.spawn = () => { probes++; throw new Error('unexpected probe') }
  const before = h.events.length
  await logins.onReady(id, selected)
  assert.equal(probes, 0)
  assert.equal(h.events.length, before)
  assert.notEqual((await h.service.inspect(id)).signedIn, true)
})

const botIds = ['acp-claude', 'acp-codex']
const cliRoot = (host, id) => dirname(dirname(host.adapter.agents.get(id).spawn().env[POINTER_ENV]))
const freshAccount = (host, id) => host.service.account(id, { fresh: true })
const otherSession = {
  code: 'acp-account/busy', message: /Close other Automagik sessions/,
}

function sharedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shared-acp-'))
  const legacy = join(root, 'cli-homes')
  const hosts = []
  t.after(async () => {
    await Promise.all(hosts.map(host => host.stop()))
    rmSync(root, { recursive: true, force: true })
  })
  const start = (installation, deps) => {
    const host = fixture(t, { root, installation, deps })
    hosts.push(host)
    return host
  }
  return { root, legacy, start }
}

async function expectAccount(host, id, email) {
  const state = await freshAccount(host, id)
  assert.equal(state.signedIn, email !== undefined)
  assert.equal(state.account?.email, email)
  assert.equal(state.consent, email === undefined ? undefined : 'given')
}

test('two live installations can change both Bot sign-ins independently', async t => {
  const { root, legacy, start } = sharedFixture(t)
  const a = start(join(root, 'dsh-a'))
  const b = start(join(root, 'dsh-b'))
  for (const id of botIds) {
    assert.equal(cliRoot(a, id), legacy)
    assert.notEqual(cliRoot(b, id), legacy)
    const expected = new Map()
    for (const action of ['login', 'switch', 'sign-out']) {
      for (const [side, host, peer] of [['a', a, b], ['b', b, a]]) {
        const email = action === 'sign-out' ? undefined : `${side}-${id}-${action}@example.test`
        host.next(email)
        if (action === 'login') await host.login(id)
        if (action === 'switch') await host.waitForLogin(id, await host.service.accountSwitch(id))
        if (action === 'sign-out') await host.service.accountSignOut(id)
        await expectAccount(peer, id, expected.get(peer))
        await expectAccount(host, id, email)
        expected.set(host, email)
      }
    }
  }
})

for (const [kind, dshPath] of [
  ['desktop', ['desktop', 'dsh']], ['standalone', ['home', '.dsh']], ['server', ['data', 'dsh']],
]) {
  for (const layout of ['pre-generation', 'selected generation']) {
    test(`${kind} upgrade keeps both ${layout} sign-ins and consent across two restarts`, async t => {
      const { root, legacy, start } = sharedFixture(t)
      const installation = join(root, ...dshPath)
      mkdirSync(installation, { recursive: true })
      const previous = new Map()
      const file = join(legacy, CONSENT_FILE)
      const email = id => `${layout === 'pre-generation' ? 'legacy' : 'selected'}-${id}@example.test`
      if (layout === 'pre-generation') {
        const consent = new ConsentStore({ file, ids: botIds })
        for (const id of botIds) {
          const vendor = id.slice(4)
          const home = join(legacy, vendor)
          const config = join(home, `.${vendor}`)
          mkdirSync(config, { recursive: true })
          writeFileSync(join(config, 'account'), email(id))
          consent.confirm(id, who(email(id)))
          previous.set(id, { [HOME_ENV]: home, [GENERATION_ENV]: 'legacy' })
        }
        assert.equal(existsSync(join(legacy, 'current')), false)
      } else {
        // An explicit root reproduces dev's layout without claiming it.
        const old = start(installation, { cliHome: legacy })
        for (const id of botIds) {
          await old.service.accountReset(id)
          old.next(email(id))
          await old.login(id)
          await expectAccount(old, id, email(id))
          const env = old.adapter.agents.get(id).spawn().env
          assert.notEqual(env[GENERATION_ENV], 'legacy')
          previous.set(id, env)
        }
        assert.deepEqual(old.logs.filter(line => line.includes('Bot sign-ins:')), [])
        await old.stop()
      }
      const consent = readFileSync(file, 'utf8')
      assert.equal(existsSync(join(legacy, 'installation.json')), false)
      for (let restart = 0; restart <= 2; restart++) {
        const upgraded = start(installation)
        for (const id of botIds) {
          await expectAccount(upgraded, id, email(id))
          const env = upgraded.adapter.agents.get(id).spawn().env
          assert.equal(env[HOME_ENV], previous.get(id)[HOME_ENV])
          assert.equal(env[GENERATION_ENV], previous.get(id)[GENERATION_ENV])
        }
        assert.equal(readFileSync(file, 'utf8'), consent)
        await upgraded.stop()
      }
    })
  }
}

test('when B upgrades first, A starts separately without touching B’s legacy sign-ins', async t => {
  const { root, legacy, start } = sharedFixture(t)
  const b = start(join(root, 'dsh-b'))
  for (const id of botIds) await b.login(id)
  const claim = join(legacy, 'installation.json')
  const owner = readFileSync(claim, 'utf8')
  const consent = readFileSync(join(legacy, CONSENT_FILE), 'utf8')
  const a = start(join(root, 'dsh-a'))
  for (const id of botIds) {
    assert.equal(cliRoot(b, id), legacy)
    assert.notEqual(cliRoot(a, id), legacy)
    await expectAccount(a, id, undefined)
    await expectAccount(b, id, 'personal@example.test')
  }
  assert.equal(readFileSync(claim, 'utf8'), owner)
  assert.equal(readFileSync(join(legacy, CONSENT_FILE), 'utf8'), consent)
  assert.deepEqual(b.logs.filter(line => line.includes('Bot sign-ins:')), [
    'acp-dsh: Bot sign-ins: this installation keeps the existing Bot sign-in home',
  ])
  assert.deepEqual(a.logs.filter(line => line.includes('Bot sign-ins:')), [
    'acp-dsh: Bot sign-ins: this installation has its own Bot sign-in home',
  ])
})

test('an older plugin and a new non-owner are independent, while the new owner still shares', async t => {
  const { root, legacy, start } = sharedFixture(t)
  const installation = join(root, 'dsh-owner')
  await start(installation).stop()
  const older = start(join(root, 'dsh-older'), { cliHome: legacy })
  const peer = start(join(root, 'dsh-peer'))
  for (const id of botIds) {
    await older.login(id)
    await expectAccount(peer, id, undefined)
    peer.next('peer@example.test')
    await peer.login(id)
    await expectAccount(older, id, 'personal@example.test')
  }
  const owner = start(installation)
  for (const id of botIds) {
    assert.equal(cliRoot(owner, id), cliRoot(older, id))
    await assert.rejects(owner.service.accountSignOut(id), otherSession)
    await assert.rejects(older.service.accountSwitch(id), otherSession)
    await expectAccount(owner, id, 'personal@example.test')
    await expectAccount(peer, id, 'peer@example.test')
  }
})

test('profiles "orchard" and "meadow" of one DSH home still refuse account changes', async t => {
  const { root, start } = sharedFixture(t)
  const installation = join(root, 'one-dsh-home')
  const orchard = start(installation)
  const meadow = start(installation)
  for (const id of botIds) {
    assert.equal(cliRoot(orchard, id), cliRoot(meadow, id))
    await assert.rejects(meadow.service.loginStart(id), otherSession)
  }
})
