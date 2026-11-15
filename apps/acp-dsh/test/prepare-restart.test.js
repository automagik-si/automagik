import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { apply, SERVICE } from '../index.js'
import { recordLogin } from '../src/host/login-ownership.js'
import { trackRun } from '../src/host/cli-homes.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
class Clock {
  jobs = new Map()
  time = 0
  now = () => this.time
  setTimeout = (run, ms) => { const id = { unref() {} }; this.jobs.set(id, { run, at: this.time + ms }); return id }
  clearTimeout = id => this.jobs.delete(id)
  advance(ms) {
    this.time += ms
    for (const [id, job] of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(id); job.run() }
  }
}
function fixture(t, { stuck = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acp-prepare-'))
  const cleanups = [], children = [], clock = new Clock()
  let service, adapter
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { list: () => [], get: () => ({ status: 'idle', ctx: { tools: { register: () => () => {} } }, session: { header: {} } }) },
    llm: { registerAdapter(ids, value) { adapter = value; return () => {} }, listProviders: () => [], listModels: () => new Promise(() => {}) },
    on() {}, get() {}, emit() {},
    provide(name, value) { if (name === SERVICE) service = value },
    effect(setup) { cleanups.push(setup()) },
  }
  apply(ctx, {}, {
    store: { home: join(root, 'adapters'), binOf: () => ({ path: '/fake/adapter', version: '1' }), update: async () => {} },
    find: name => `/fake/${name}`, signedIn: async () => false, account: async () => undefined,
    loginTimers: clock, loginRecord: recordLogin,
    loginSpawn(cli, args, options) {
      const child = new EventEmitter()
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kills: [], options })
      child.close = () => { child.exitCode = 0; child.emit('close', 0) }
      child.kill = signal => { child.kills.push(signal); if (!stuck) queueMicrotask(child.close); return !stuck }
      children.push(child)
      if (cli.endsWith('codex')) child.stdin.on('data', line => {
        const request = JSON.parse(String(line))
        const result = request.method === 'initialize' ? {}
          : request.method === 'account/login/start' ? { type: 'chatgptDeviceCode', loginId: 'fake', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' } : undefined
        if (result) child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
      })
      else queueMicrotask(() => child.stdout.write('https://claude.com/cai/oauth/authorize?code=true&state=expected_state_0123456789\n'))
      return child
    },
    logoutRun(cli, args, options, done) { done(null) },
  })
  t.after(async () => {
    for (const child of children) child.close()
    for (const cleanup of cleanups) cleanup()
    await tick()
    rmSync(root, { recursive: true, force: true })
  })
  const start = async id => {
    const pending = service.loginStart(id)
    for (let i = 0; i < 20; i++) await tick()
    await pending
    const home = children.at(-1).options.env.AUTOMAGIK_BOT_CLI_HOME
    return { home, child: children.at(-1) }
  }
  return { service, adapter, root, clock, children, start }
}
const records = home => readdirSync(join(home, 'login-trees'))

test('open attempts stop through proof, changing ends, paused stays, and the instance unregisters', async t => {
  const h = fixture(t)
  const attempts = []
  for (const id of ['acp-claude', 'acp-codex']) attempts.push(await h.start(id))
  for (const { home } of attempts) {
    assert.equal(records(home).length, 1)
    assert.ok(existsSync(join(home, 'changing')))
    assert.ok(existsSync(join(home, 'paused')))
    assert.ok(readdirSync(join(home, 'instances')).length > 0)
  }
  const work = h.service.prepareRestart()
  assert.equal(h.service.prepareRestart(), work)
  assert.throws(() => h.service.loginStart('acp-codex'), { code: 'acp-account/busy', message: 'Automagik is restarting.' })
  for (const method of ['accountSignOut', 'accountSwitch', 'accountReset']) {
    await assert.rejects(h.service[method]('acp-codex'), { code: 'acp-account/busy' })
  }
  assert.deepEqual(await work, { ok: true })
  for (const { home, child } of attempts) {
    assert.ok(child.kills.length > 0)
    assert.equal(records(home).length, 0)
    assert.equal(existsSync(join(home, 'changing')), false)
    assert.ok(existsSync(join(home, 'paused')))
    assert.deepEqual(readdirSync(join(home, 'instances')), [])
  }
  assert.equal(h.service.prepareRestart(), work)
})

test('a stop without proof times out with records, locks and registration intact', async t => {
  const h = fixture(t, { stuck: true })
  const { home, child } = await h.start('acp-codex')
  const work = h.service.prepareRestart()
  await tick()
  assert.ok(child.kills.length > 0)
  assert.equal(records(home).length, 1)
  assert.ok(existsSync(join(home, 'changing')))
  h.clock.advance(4500)
  assert.deepEqual(await work, { ok: false, step: 'logins' })
  assert.equal(records(home).length, 1)
  assert.ok(existsSync(join(home, 'changing')))
  assert.ok(existsSync(join(home, 'paused')))
  assert.ok(readdirSync(join(home, 'instances')).length > 0)
  // A late proof may clear its record, but cannot release a timed-out preparation's locks.
  child.close()
  await tick()
  assert.equal(records(home).length, 0)
  assert.ok(existsSync(join(home, 'changing')))
  assert.ok(readdirSync(join(home, 'instances')).length > 0)
})

test('tracked CLI runs drain before this instance unregisters', async t => {
  const h = fixture(t)
  const env = h.adapter.agents.get('acp-codex').spawn().env
  const home = env.AUTOMAGIK_BOT_CLI_HOME
  let release, stopping = false
  trackRun({ spec: { env }, stop: () => { stopping = true; return new Promise(resolve => { release = resolve }) } })
  const work = h.service.prepareRestart()
  await tick()
  assert.equal(stopping, true)
  assert.ok(readdirSync(join(home, 'instances')).length > 0)
  release()
  assert.deepEqual(await work, { ok: true })
  assert.deepEqual(readdirSync(join(home, 'instances')), [])
})
