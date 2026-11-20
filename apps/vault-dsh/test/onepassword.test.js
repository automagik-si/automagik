import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'
import { runOp } from '../src/bw/run.js'
import { createLifecycle } from '../src/lifecycle.js'
import { createOnePassword } from '../src/onepassword/adapter.js'
import { digest, equalPrivate, fakeClock, fakeVault } from './fixtures/harness.mjs'
import { fakeOnePassword as fixture, useFakeVaultExecutables } from './fixtures/onepassword.mjs'

const ok = { ok: true }

test('the supported CLI range gates authentication and an invalid token is dropped', async t => {
  const h = fixture(t)
  for (const version of ['2.38.9', '3.0.0', '2.39.0-beta.1']) {
    h.configure({ version })
    equalPrivate(await h.unlock(), { ok: false, code: 'version' })
  }
  assert.ok(h.commands().every(row => row.operation === 'version'))
  h.configure({ version: '2.40.1', mode: 'invalid-token' })
  equalPrivate(await h.unlock(), { ok: false, code: 'auth' })
  equalPrivate(await h.service.status(), { state: 'locked' })
  h.configure({ mode: 'ok' })
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.service.status(), { state: 'unlocked' })
})

test('fresh reads preserve every byte and handle both value and token rotation', async t => {
  const h = fixture(t)
  const unlocked = await h.unlock()
  assert.equal(unlocked.ok, true, JSON.stringify({ code: unlocked.code, commands: h.commands() }))
  equalPrivate(await h.service.read(h.ref), { ok: true, value: h.value('first') })
  h.configure({ valueKey: 'next' })
  equalPrivate(await h.service.read(h.ref), { ok: true, value: h.value('next') })
  h.configure({ tokenHash: digest(h.replacement) })
  equalPrivate(await h.unlock(h.replacement), ok)
  equalPrivate(await h.service.read(h.ref), { ok: true, value: h.value('next') })
  equalPrivate(await h.service.read({ ...h.ref, item: h.ref.item + '/extra' }), { ok: false, code: 'refused' })
  equalPrivate(await h.service.read({ ...h.ref, field: '../password' }), { ok: false, code: 'field' })
  equalPrivate(await h.service.read({ ...h.ref, connection: 'other' }), { ok: false, code: 'refused' })
})

test('revoked access, offline, throttling, partial output and unknown diagnostics fail closed', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  for (const [mode, code] of [
    ['revoked', 'revoked'], ['vault', 'revoked'], ['field', 'field'],
    ['offline', 'unavailable'], ['throttled', 'unavailable'], ['unknown', 'unavailable'],
    ['warn', 'unavailable'], ['invalid-text', 'unavailable'], ['overflow', 'unavailable'], ['auth', 'auth'],
  ]) {
    h.configure({ mode })
    const result = await h.service.read(h.ref)
    h.clean(JSON.stringify(result))
    equalPrivate(result, { ok: false, code })
  }
  equalPrivate(await h.service.status(), { state: 'locked' })
  const before = h.commands().length
  equalPrivate(await h.service.read(h.ref), { ok: false, code: 'locked' })
  assert.equal(h.commands().length, before)
})

test('1Password version failures stay unavailable and wrapped authenticated failures lock the token', async t => {
  const h = fixture(t)
  for (const mode of ['version-auth', 'version-revoked']) {
    h.configure({ mode })
    equalPrivate(await h.unlock(), { ok: false, code: 'unavailable' })
  }
  assert.ok(h.commands().every(row => row.operation === 'version'))
  for (const mode of ['wrapped-401', 'wrapped-invalid-token', 'wrapped-auth-required']) {
    h.configure({ mode: 'ok' })
    equalPrivate(await h.unlock(), ok)
    h.configure({ mode })
    equalPrivate(await h.service.read(h.ref), { ok: false, code: 'auth' })
    equalPrivate(await h.service.status(), { state: 'locked' })
  }
})

test('wrapped 429 and 503 diagnostics leave the token installed and return unavailable', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  for (const mode of ['wrapped-429', 'wrapped-503']) {
    h.configure({ mode })
    equalPrivate(await h.service.read(h.ref), { ok: false, code: 'unavailable' })
    equalPrivate(await h.service.status(), { state: 'unlocked' })
  }
})

test('quoted vault names and references do not determine the diagnostic category', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  h.configure({ mode: 'quoted-vault' })
  equalPrivate(await h.service.read(h.ref), { ok: false, code: 'revoked' })
  equalPrivate(await h.service.status(), { state: 'unlocked' })
  h.configure({ mode: 'quoted-reference' })
  equalPrivate(await h.service.read(h.ref), { ok: false, code: 'auth' })
  equalPrivate(await h.service.status(), { state: 'locked' })
})

test('an unquoted outage code takes precedence over auth text in the cause', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  h.configure({ mode: 'outage-with-auth-text' })
  equalPrivate(await h.service.read(h.ref), { ok: false, code: 'unavailable' })
  equalPrivate(await h.service.status(), { state: 'unlocked' })
})

test('the reads queue retains no value after a successful read and lock or a rejected job', async () => {
  const value = randomBytes(24).toString('hex')
  const lifetime = createLifecycle({ run: async () => ({ ok: true, value }), timeouts: {} })
  const { child, reads, lock } = lifetime
  equalPrivate(await reads(() => child(['read'], 'read', lifetime.signal)), { ok: true, value })
  await lock()
  assert.equal((await reads.settled()) === undefined, true)
  await assert.rejects(reads(() => { throw new Error('fixture') }), /fixture/)
  assert.equal((await reads.settled()) === undefined, true)
})

test('a read uses its admitted reference when the caller edits it during the version probe', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const h = fixture(t)
  let pauseVersion = false
  const adapter = createOnePassword({}, { run: async (args, limits) => {
    if (pauseVersion && args[0] === '--version') {
      entered.resolve()
      await release.promise
    }
    return runOp(args, limits, { parent: h.parent })
  } })
  t.after(() => adapter.prepareQuit())
  equalPrivate(await adapter.unlock({ connection: h.ref.connection, token: h.credential }), ok)
  pauseVersion = true
  const ref = { ...h.ref }
  const read = adapter.read(ref)
  await entered.promise
  Object.assign(ref, { item: 'a'.repeat(26) + '/' + 'b'.repeat(26), field: 'password', connection: 'other' })
  release.resolve()
  equalPrivate(await read, { ok: true, value: h.value('first') })
})

test('the picker projects only IDs and labels, including the canonical section selector', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  const result = await h.service.listItems({ connection: h.ref.connection, search: 'ITEM' })
  assert.equal(JSON.stringify(result).includes(h.value('first').trim()), false)
  equalPrivate(result, { ok: true, items: [{ id: h.ref.item, name: 'Fixture item', vault: 'Fixture vault',
    fields: [{ id: 'password', label: 'Password' }, { id: h.ref.field, label: 'Password', section: 'Fixture section' }] }] })
  assert.deepEqual(h.commands().map(row => row.operation).slice(-4), ['version', 'vault-list', 'item-list', 'item-get'])
  equalPrivate(await h.service.listItems({ connection: h.ref.connection, search: 'missing' }), { ok: true, items: [] })
})

for (const stop of ['lock', 'idle', 'prepareQuit', 'replace', 'caller', 'deadline']) {
  test(stop + ' cancels an in-flight read', async t => {
    const timers = fakeClock()
    const h = fixture(t, { timers, readTimeout: stop === 'deadline' ? 100 : undefined })
    equalPrivate(await h.unlock(), ok)
    h.configure({ mode: 'hang' })
    const caller = new AbortController()
    const pending = h.service.read(h.ref, { signal: caller.signal })
    await h.waitForRead()
    if (stop === 'idle') timers.tick(300_000)
    else if (stop === 'caller') caller.abort()
    else if (stop === 'replace') {
      h.configure({ mode: 'ok', tokenHash: digest(h.replacement) })
      equalPrivate(await h.unlock(h.replacement), ok)
    } else if (stop !== 'deadline') await h.service[stop]()
    const after = stop === 'replace' ? { ok: true, value: h.value('first') } : { ok: false, code: 'locked' }
    equalPrivate(await pending, { ok: false, code: stop === 'caller' ? 'refused' : stop === 'deadline' ? 'unavailable' : 'locked' })
    if (stop !== 'caller' && stop !== 'deadline') equalPrivate(await h.service.read(h.ref), after)
  })
}

test('the Cloud workspace marker refuses setup, status, listing and reading before spawning', async t => {
  const h = fixture(t)
  const name = 'AUTOMAGIK_GATE_CLOUD_WORKSPACE'
  const previous = process.env[name]
  process.env[name] = 'fixture-workspace'
  try {
    await assert.rejects(() => h.service.status(), { code: 'cloud', message: '1Password is unavailable in Automagik Cloud.' })
    equalPrivate(await h.unlock(), { ok: false, code: 'cloud' })
    equalPrivate(await h.service.listItems({ connection: h.ref.connection }), { ok: false, code: 'cloud' })
    equalPrivate(await h.service.read(h.ref), { ok: false, code: 'cloud' })
    assert.equal(h.commands().length, 0)
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('the shared runner refuses tracing with a token and resolves op.exe without a shell', async t => {
  const token = randomBytes(24).toString('hex')
  const debug = t.mock.method(inspector, 'url', () => 'ws://localhost/fixture')
  syncBuiltinESMExports()
  try {
    equalPrivate(await runOp(['vault', 'list'], { token, timeout: 100 }, {
      spawnChild() { assert.fail('an authenticated child started under tracing') },
    }), { failure: 'refused' })
  } finally { debug.mock.restore(); syncBuiltinESMExports() }
  let executable, args, shell, env
  const windows = 'C:\\Fixture Tools\\op.exe'
  equalPrivate(await runOp(['--version'], { token, timeout: 100 }, {
    platform: 'win32', parent: { Path: '"C:\\Fixture Tools";relative', op_connect_host: 'fixture' },
    exists: path => path === windows,
    spawnChild(file, childArgs, options) {
      executable = file
      args = childArgs
      shell = options.shell
      env = options.env
      throw new Error('fixture')
    },
  }), { failure: 'unavailable' })
  assert.equal(executable, windows)
  assert.deepEqual(args, ['--version'])
  assert.equal(shell, false)
  assert.ok(Object.keys(env).every(key => !key.toUpperCase().startsWith('OP_')))
})

test('Windows cancellation of authenticated op strips every OP variable from taskkill', async () => {
  const token = randomBytes(24).toString('hex')
  const ambient = randomBytes(24).toString('hex')
  const control = new AbortController()
  const cli = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
  const killer = new EventEmitter()
  const spawns = []
  const result = runOp(['vault', 'list'], { token, signal: control.signal, timeout: 1000 }, {
    platform: 'win32', parent: { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows',
      OP_SERVICE_ACCOUNT_TOKEN: ambient, op_connect_token: ambient, OP_DEBUG: '1' },
    exists: () => true,
    spawnChild(file, args, { env, shell }) {
      spawns.push({ file, args, shell, opKeys: Object.keys(env).filter(key => /^OP_/i.test(key)),
        hasToken: Object.values(env).includes(token), hasAmbient: Object.values(env).includes(ambient),
        tokenInArgs: args.some(arg => arg.includes(token) || arg.includes(ambient)) })
      return spawns.length === 1 ? cli : killer
    },
  })
  control.abort()
  killer.emit('close', 0)
  cli.emit('close', null, 'SIGKILL')
  equalPrivate(await result, { failure: 'cancelled' })
  assert.deepEqual(spawns, [
    { file: 'C:\\Tools\\op.exe', args: ['vault', 'list', '--cache=false'], shell: false,
      opKeys: ['OP_SERVICE_ACCOUNT_TOKEN'], hasToken: true, hasAmbient: false, tokenInArgs: false },
    { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '42', '/T', '/F'], shell: false,
      opKeys: [], hasToken: false, hasAmbient: false, tokenInArgs: false },
  ])
})

test('the mounted v1 service dispatches explicitly, locks the previous provider and drops the token on disable', async t => {
  const op = fixture(t)
  const bw = fakeVault(t)
  const ctx = new Context()
  const restore = useFakeVaultExecutables(op, bw)
  try {
    const enabled = await ctx.plugin(plugin)
    const service = ctx.get('secretSources')
    const onepassword = { provider: 'onepassword', connection: op.ref.connection, token: op.credential }
    const bitwarden = { connection: bw.connection, password: bw.password }
    assert.deepEqual(service.providers, ['bitwarden', 'onepassword', 'hashicorp-vault'])
    equalPrivate(await service.unlock(bitwarden), ok)
    assert.equal((await service.status()).state, 'unlocked')
    equalPrivate(await service.unlock(onepassword), ok)
    assert.equal(Object.values(process.env).includes(op.credential), false)
    assert.equal(bw.commands().at(-1), 'lock')
    assert.equal((await service.status()).state, 'locked')
    equalPrivate(await service.status({ provider: 'onepassword' }), { state: 'unlocked' })
    equalPrivate(await service.read(op.ref), { ok: true, value: op.value('first') })
    equalPrivate(await service.unlock(bitwarden), ok)
    equalPrivate(await service.read(op.ref), { ok: false, code: 'locked' })
    equalPrivate(await service.unlock(onepassword), ok)
    await enabled.dispose()
    equalPrivate(await service.read(op.ref), { ok: false, code: 'locked' })
    const enabledAgain = await ctx.plugin(plugin)
    equalPrivate(await ctx.get('secretSources').status({ provider: 'onepassword' }), { state: 'locked' })
    await enabledAgain.dispose()
  } finally {
    await ctx.fiber.dispose()
    restore()
  }
})

test('failed bw retirement refuses the provider switch before any authenticated op child starts', async t => {
  const op = fixture(t)
  const bw = fakeVault(t)
  const ctx = new Context()
  const restore = useFakeVaultExecutables(op, bw)
  try {
    await ctx.plugin(plugin)
    const service = ctx.get('secretSources')
    equalPrivate(await service.unlock({ connection: bw.connection, password: bw.password }), ok)
    bw.configure({ lock: 'error' })
    const tokenEntry = { provider: 'onepassword', connection: op.ref.connection, token: op.credential }
    equalPrivate(await service.unlock(tokenEntry), { ok: false, code: 'unavailable' })
    assert.equal(bw.commands().at(-1), 'lock')
    assert.equal(op.commands().length, 0)
    assert.equal(await service.lock(), false)
    bw.configure({ lock: 'ok' })
    equalPrivate(await service.unlock(tokenEntry), ok)
  } finally {
    await ctx.fiber.dispose()
    restore()
  }
})
