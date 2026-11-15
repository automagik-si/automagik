// The actual ACP onReady callback, with deferred fake account reads and fake CLI controllers.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { apply, SERVICE } from '../index.js'
import { Catalog } from '../src/host/catalog.js'
import { ConsentStore } from '../src/host/consent.js'
import { CliHomes } from '../src/host/cli-homes.js'
import { ANSWER_TIMEOUT_MS } from '../src/host/login.js'
import { watchBusy } from '../../welcome-dsh/src/host/busy.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function clock() {
  let time = 1000000, serial = 0
  const jobs = new Map()
  return { now: () => time,
    setTimeout(fn, ms) { jobs.set(++serial, { fn, at: time + ms }); return serial },
    clearTimeout(key) { jobs.delete(key) },
    advance(ms) {
      time += ms
      for (const [key, job] of [...jobs]) if (job.at <= time) { jobs.delete(key); job.fn() }
    } }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'login-authority-'))
  const timers = clock(), account = deferred()
  const bus = new EventEmitter()
  const events = [], cleanups = [], children = [], commits = []
  let service, authenticated = false, reads = 0
  t.mock.method(Catalog.prototype, 'refresh', () => Promise.resolve())
  for (const [prototype, name] of [[ConsentStore.prototype, 'confirm'], [CliHomes.prototype, 'resume']]) {
    const original = prototype[name]
    t.mock.method(prototype, name, function (...args) { commits.push(name); return original.apply(this, args) })
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { list: () => [], get: () => ({ status: 'idle', ctx: { tools: { register: () => () => {} } }, session: { header: {} } }) },
    llm: { registerAdapter: () => () => {}, listProviders: () => [], listModels: () => new Promise(() => {}) },
    on() {}, get() {}, provide(name, value) { if (name === SERVICE) service = value },
    effect(setup) { cleanups.push(setup()) }, emit(name, value) { events.push(name); bus.emit(name, value) },
  }
  apply(ctx, {}, {
    store: { home: join(root, 'adapters'), binOf: () => ({ path: '/fake/adapter', version: '1' }), update: async () => {} },
    find: name => `/fake/${name}`, signedIn: async () => authenticated,
    account: async () => { reads++; return account.promise },
    loginTimers: timers,
    loginRecord: () => undefined,
    loginSpawn(_cli, _args, options) {
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.exitCode = child.signalCode = null
      child.close = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('close', 0) } }
      child.kill = () => { child.close(); return true }
      children.push({ child, home: options.env.HOME })
      return child
    },
    logoutRun(_cli, _args, _options, done) { authenticated = false; done(null) },
  })
  t.after(async () => {
    for (const { child } of children) child.close()
    for (const cleanup of cleanups) cleanup()
    account.resolve(undefined)
    await tick()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, timers, account, events, commits, children, service, bus,
    watch({ flag = '2', getter = true, prepare = true } = {}) {
      const writes = []
      const exposed = { ...service,
        ...(!getter ? { loginActivity: undefined } : {}),
        ...(!prepare ? { prepareRestart: undefined } : {}) }
      watchBusy({ on: (name, fn) => bus.on(name, fn),
        get: name => name === 'acpAgents' ? exposed : { list: () => [] } }, {
        env: { AUTOMAGIK_BUSY_FILE: '/fake/busy', AUTOMAGIK_BUSY_PROTOCOL: flag },
        now: timers.now, write: (_file, text) => writes.push(JSON.parse(text)),
      })
      return writes
    },
    reads: () => reads,
    complete() { authenticated = true; children.at(-1).child.close() },
    signedOut() { authenticated = false } }
}

test('actual ACP activity drives modern Welcome at unchanged active count while legacy receives only count changes', async t => {
  const h = fixture(t)
  const modern = h.watch()
  const legacy = [h.watch({ flag: '' }), h.watch({ getter: false }), h.watch({ prepare: false })]
  const counts = [], activity = []
  h.bus.on('acp-dsh/login-active', value => counts.push(value))
  h.bus.on('acp-dsh/login-activity', value => activity.push(value))
  assert.deepEqual(modern, [{ running: 0, logins: 0, confirming: 0, at: h.timers.now() }])
  const attempt = await h.service.loginStart('acp-claude')
  await tick()
  assert.deepEqual(counts, [{ active: 1 }])
  assert.deepEqual(modern.at(-1), { running: 0, logins: 1, confirming: 0, at: h.timers.now() })
  const state = 'fix1_expected_state_0123456789'
  h.children[0].child.stdout.write(`https://claude.com/cai/oauth/authorize?code=true&state=${state}\nPaste code here if prompted > `)
  h.service.loginAnswer('acp-claude', attempt.attemptId, `code#${state}`)
  const until = h.timers.now() + ANSWER_TIMEOUT_MS
  assert.deepEqual(activity.at(-1), { active: 1, confirming: 1, confirmingUntil: until })
  assert.deepEqual(modern.at(-1), { running: 0, logins: 1, confirming: 1, confirmingUntil: until, at: h.timers.now() })
  assert.deepEqual(counts, [{ active: 1 }], 'confirmation must not add a legacy count event')
  for (const writes of legacy) assert.deepEqual(writes, [{ running: 0, at: 1000000 }, { running: 1, at: 1000000 }])
  const reload = h.watch()
  assert.deepEqual(reload[0], modern.at(-1), 'a modern reload reads structured confirmation state')
  h.timers.advance(20000)
  h.complete()
  await tick()
  assert.ok(h.reads() > 0, 'actual onReady is held at the fake account read')
  assert.equal(h.service.loginActivity().confirmingUntil, until, 'completion cannot renew the answer deadline')
  assert.equal(modern.length, 3, 'unchanged confirmation does not write again')
  h.timers.advance(ANSWER_TIMEOUT_MS - 20000)
  await tick()
  assert.equal(h.service.loginStatus('acp-claude', attempt.attemptId).status, 'failed')
  assert.deepEqual(counts, [{ active: 1 }, { active: 0 }])
  assert.deepEqual(activity, [{ active: 1, confirming: 0 },
    { active: 1, confirming: 1, confirmingUntil: until }, { active: 0, confirming: 0 }])
  const idle = { running: 0, logins: 0, confirming: 0, at: until }
  assert.deepEqual(modern.at(-1), idle)
  assert.deepEqual(reload.at(-1), idle)
  for (const writes of legacy) assert.deepEqual(writes.at(-1), { running: 0, at: until })
  assert.equal(existsSync(join(h.children[0].home, 'paused')), true)
})

for (const interruption of ['expiry', 'replacement', 'reset', 'restart']) {
  test(`deferred ACP account read cannot commit consent/resume/ready/model signal after ${interruption}`, async t => {
    const h = fixture(t)
    const id = 'acp-claude'
    const attempt = await h.service.loginStart(id)
    await tick()
    const home = h.children[0].home
    // Ordinary start first verifies sign-out and briefly resumes that completed operation.
    // From here only this login completion may grant authority.
    h.commits.length = 0
    h.complete()
    await tick()
    assert.ok(h.reads() > 0, 'onReady is suspended in the actual account read')
    assert.equal(h.service.loginActivity().confirming, 1)
    assert.equal(h.commits.length, 0, 'authority is not committed before the awaited read')
    if (interruption === 'restart') await h.service.prepareRestart()
    else h.timers.advance(ANSWER_TIMEOUT_MS)
    await tick()
    if (interruption !== 'restart') assert.equal(h.service.loginStatus(id, attempt.attemptId).status, 'failed')
    assert.equal(existsSync(join(home, 'paused')), true)
    let next
    if (interruption === 'replacement') {
      h.signedOut()
      next = await h.service.loginStart(id)
      await tick()
      assert.notEqual(next.attemptId, attempt.attemptId)
      h.commits.length = 0
    }
    let generation
    if (interruption === 'reset') {
      await h.service.accountReset(id)
      generation = readFileSync(join(h.root, 'cli-homes', 'current', 'claude'), 'utf8')
      assert.equal(existsSync(join(h.root, 'cli-homes', 'homes', 'claude', generation, 'paused')), true)
    }
    const before = h.events.length
    h.account.resolve({ kind: 'account', id: 'fake@example.test', facets: { kind: 'account', email: 'fake@example.test' }, email: 'fake@example.test' })
    await tick()
    assert.deepEqual(h.commits, [])
    assert.equal(h.events.slice(before).includes('acp-dsh/login-ready'), false)
    assert.equal(existsSync(join(home, 'paused')), true)
    if (next) assert.equal(h.service.loginCurrent(id).attemptId, next.attemptId)
    if (generation) {
      assert.equal(readFileSync(join(h.root, 'cli-homes', 'current', 'claude'), 'utf8'), generation)
      assert.equal(existsSync(join(h.root, 'cli-homes', 'homes', 'claude', generation, 'paused')), true)
    }
  })
}
