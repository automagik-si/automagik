import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createMacosKeychain } from '../src/macos-keychain/adapter.js'
import { connection, provider } from '../src/macos-keychain/parse.js'
import { runSecurity } from '../src/macos-keychain/run.js'
import { digest, fakeChild, fakeSecurity } from './fixtures/fake-security.mjs'
import { equalPrivate, fakeClock, fakeVault } from './fixtures/harness.mjs'
import { fakeOnePassword, useFakeVaultExecutables } from './fixtures/onepassword.mjs'

const refusal = { ok: false, code: 'refused' }
const locked = { ok: false, code: 'locked' }
const ok = { ok: true }
const service = ' fixture \u00e7 '
const account = '-g  fixture '

function fixture(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'test-keychain-'))
  const path = join(home, 'Library/Keychains/login.keychain-db')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', { mode: 0o600 })
  const fake = fakeSecurity(path)
  const adapter = createMacosKeychain({ idleLockMinutes: 1 }, {
    platform: 'darwin', passwd: () => ({ homedir: home }), run: fake.run, isCloud: () => false, ...options,
  })
  t.after(async () => {
    try { await adapter.prepareQuit() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const item = JSON.stringify([path, service, account])
  const ref = { provider, connection, item, field: 'password' }
  const lookup = { connection, service, account }
  return { adapter, path, home, fake, ref, lookup, pick: () => adapter.listItems(lookup), read: () => adapter.read(ref) }
}

test('the gate, exact picker, reads and rotation bind to the passwd login file', async t => {
  const timers = fakeClock()
  const h = fixture(t, { timers })
  const initial = h.adapter.binding
  equalPrivate(h.adapter.status(), { state: 'locked' })
  equalPrivate(await h.read(), locked)
  equalPrivate(await h.pick(), locked)
  assert.equal(h.fake.calls.length, 0)
  equalPrivate(await h.adapter.unlock({ connection: 'other' }), refusal)
  assert.equal(h.adapter.binding === initial, true)
  equalPrivate(await h.adapter.unlock(), ok)
  const opened = h.adapter.binding
  assert.notEqual(opened, initial)
  timers.tick(59000)
  equalPrivate(await h.pick(), { ok: true, items: [{ id: h.ref.item, service, account, fields: ['password'] }] })
  timers.tick(1000)
  assert.notEqual(h.adapter.binding, opened, 'metadata did not renew idle time')
  equalPrivate(await h.read(), locked)

  equalPrivate(await h.adapter.unlock(), ok)
  timers.tick(59000)
  equalPrivate(await h.read(), { ok: true, value: h.fake.value() })
  assert.deepEqual(h.fake.calls, [
    { operation: 'metadata', shape: ['find-generic-password', '-s', '-a', 7, true],
      bound: true, service: digest(service), account: digest(account), timeout: 10_000 },
    { operation: 'read', shape: ['find-generic-password', '-s', '-a', 8, true],
      bound: true, service: digest(service), account: digest(account), timeout: 30_000 },
  ])
  h.fake.rotate()
  timers.tick(59000)
  equalPrivate(await h.read(), { ok: true, value: h.fake.value() })
  h.fake.setMode('denial')
  timers.tick(59000)
  equalPrivate(await h.read(), refusal)
  timers.tick(1000)
  equalPrivate(await h.read(), locked)
  const closed = h.adapter.binding
  const done = h.adapter.prepareQuit()
  assert.notEqual(h.adapter.binding, closed)
  await done
})

test('malformed references, missing paths, symlinks and non-login stores spawn nothing', async t => {
  const h = fixture(t)
  await h.adapter.unlock()
  for (const invalid of ['', 'a'.repeat(129), '\uD800', '\u0085', 'left\u200fright', 'left\u061cright', 'a\0b']) {
    equalPrivate(await h.adapter.listItems({ ...h.lookup, service: invalid }), refusal)
    equalPrivate(await h.adapter.read({ ...h.ref, item: JSON.stringify([h.path, service, invalid]) }), refusal)
  }
  const tooLong = '\\'.repeat(128)
  equalPrivate(await h.adapter.listItems({ connection, service: tooLong, account: tooLong }), refusal)
  for (const path of [h.path.replace('login.keychain-db', 'other.keychain-db'), '/Library/Keychains/System.keychain']) {
    equalPrivate(await h.adapter.read({ ...h.ref, item: JSON.stringify([path, service, account]) }), refusal)
  }
  equalPrivate(await h.adapter.read({ ...h.ref, field: 'notes' }), refusal)
  rmSync(h.path)
  equalPrivate(await h.read(), refusal)
  equalPrivate(await h.pick(), refusal)
  const other = join(dirname(h.path), 'other.keychain-db')
  writeFileSync(other, '')
  symlinkSync(other, h.path)
  equalPrivate(await h.read(), refusal)
  rmSync(h.path)
  mkdirSync(h.path)
  equalPrivate(await h.pick(), refusal)
  assert.equal(h.fake.calls.length, 0)
})

test('a regular Keychain file owned by another uid is refused before spawn', async t => {
  const h = fixture(t)
  await h.adapter.unlock()
  const lstat = fs.lstatSync
  const mocked = t.mock.method(fs, 'lstatSync', path => {
    const stat = lstat(path)
    return { isFile: () => stat.isFile(), uid: process.getuid() + 1 }
  })
  syncBuiltinESMExports()
  try {
    equalPrivate(await h.pick(), refusal)
    equalPrivate(await h.read(), refusal)
    assert.equal(h.fake.calls.length, 0)
  } finally {
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
})

test('header, denial, not-found, and a stale child reply never deliver a value', async t => {
  const h = fixture(t)
  await h.adapter.unlock()
  h.fake.setMode('wrong-header')
  equalPrivate(await h.read(), refusal)
  equalPrivate(await h.pick(), refusal)
  h.fake.setMode('missing')
  equalPrivate(await h.pick(), { ok: true, items: [] })
  equalPrivate(await h.read(), { ok: false, code: 'revoked', audit: 'refused' })
  h.fake.setMode('denial')
  equalPrivate(await h.read(), refusal)
  h.fake.setMode('ok')
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.fake.intercept(async (_limits, reply) => { entered.resolve(); await release.promise; return reply() })
  const pending = h.read()
  await entered.promise
  const open = h.adapter.binding
  const closing = h.adapter.retire()
  assert.notEqual(h.adapter.binding, open)
  equalPrivate(await pending, refusal)
  release.resolve()
  await closing
  equalPrivate(await h.adapter.unlock(), ok)
})

test('runner limits argv and inherited environment and refuses tracing before every spawn', async t => {
  const { path, home } = fixture(t)
  const good = ['find-generic-password', '-s', service, '-a', account, '-g', path, path]
  const calls = []
  const options = { platform: 'darwin', home, spawnChild(file, args, opts) {
    const child = fakeChild()
    calls.push({ fixedBinary: file === '/usr/bin/security', argv: digest(JSON.stringify(args)),
      shape: [args[0], args[1], args[3], args[5], args.length], clean: JSON.stringify(opts.env) === JSON.stringify({ HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' }),
      shell: opts.shell, stdio: opts.stdio })
    queueMicrotask(() => child.emit('close', 0))
    return child
  } }
  const limits = { timeout: 200 }
  for (const bad of [
    ['find', ...good.slice(1)], good.slice(0, -1), [...good.slice(0, -1), '/tmp/other'],
    [...good.slice(0, 5), '-w', path, path], ['-i', ...good],
  ]) equalPrivate(await runSecurity(bad, limits, options), { failure: 'refused' })
  equalPrivate(await runSecurity(good, limits, { ...options, platform: 'linux' }), { failure: 'refused' })
  equalPrivate(await runSecurity(good, limits, options), { code: 0, stdout: '', stderr: '' })
  const traced = t.mock.method(inspector, 'url', () => 'ws://localhost/fixture')
  syncBuiltinESMExports()
  try {
    equalPrivate(await runSecurity(good, limits, options), { failure: 'refused' })
    equalPrivate(await runSecurity(good.filter(arg => arg !== '-g'), limits, options), { failure: 'refused' })
  } finally {
    traced.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(calls, [{
    fixedBinary: true, argv: digest(JSON.stringify(good)), shape: ['find-generic-password', '-s', '-a', '-g', 8],
    clean: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  }])
})

test('the real runner enforces child deadline, caller cancellation, signal and output limit', async t => {
  const { path, home } = fixture(t)
  const adapter = (spawnChild, timeout = 1000) => createMacosKeychain({}, {
    platform: 'darwin', passwd: () => ({ homedir: home }), isCloud: () => false, timeouts: { read: timeout },
    run: (args, limits, options) => runSecurity(args, limits, { ...options, spawnChild }),
  })
  const ref = { provider, connection, item: JSON.stringify([path, service, account]), field: 'password' }
  for (const [end, timeout] of [
    [() => {}, 5],
    [child => child.emit('close', null, 'SIGTERM'), 1000],
    [child => child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1)), 1000],
  ]) {
    const source = adapter(() => {
      const child = fakeChild()
      queueMicrotask(() => end(child))
      return child
    }, timeout)
    try { await source.unlock(); equalPrivate(await source.read(ref), refusal) }
    finally { await source.prepareQuit() }
  }
  const spawned = Promise.withResolvers()
  const source = adapter(() => { spawned.resolve(); return fakeChild() })
  const caller = new AbortController()
  try {
    await source.unlock()
    const pending = source.read(ref, { signal: caller.signal })
    await spawned.promise
    caller.abort()
    equalPrivate(await pending, refusal)
  } finally { await source.prepareQuit() }
})

test('Cloud preflight and a lock queued before unlock both fail without spawning', async t => {
  const cloud = fixture(t, { isCloud: () => true })
  assert.throws(() => cloud.adapter.status(), { code: 'cloud' })
  equalPrivate(await cloud.adapter.unlock(), { ok: false, code: 'cloud' })
  equalPrivate(await cloud.read(), { ok: false, code: 'cloud' })
  assert.equal(cloud.fake.calls.length, 0)
  const h = fixture(t)
  const unlocking = h.adapter.unlock()
  const closing = h.adapter.retire()
  equalPrivate(await unlocking, locked)
  await closing
  assert.equal(h.fake.calls.length, 0)
})

test('mounted Linux preflight leaves an open provider, selection and child counts intact', { skip: process.platform === 'darwin' }, async t => {
  const bw = fakeVault(t)
  const op = fakeOnePassword(t)
  const restore = useFakeVaultExecutables(op, bw)
  let mounted
  apply({ provide(_name, service) { mounted = service }, effect() {} })
  try {
    equalPrivate(await mounted.unlock({ connection: bw.connection, password: bw.password }), ok)
    const selection = mounted.providerSelection
    const before = bw.commands().length
    assert.equal(Object.keys(mounted).includes('providerBinding'), false)
    assert.equal(typeof mounted.providerBinding(provider), 'symbol')
    assert.equal(mounted.providerBinding('bitwarden'), undefined)
    const spawn = childProcess.spawn
    let starts = 0
    childProcess.spawn = (...args) => { starts++; return spawn(...args) }
    syncBuiltinESMExports()
    try {
      assert.throws(() => mounted.status({ provider }), { code: 'platform' })
      equalPrivate(await mounted.unlock({ provider }), { ok: false, code: 'platform' })
      assert.equal(starts, 0)
    } finally {
      childProcess.spawn = spawn
      syncBuiltinESMExports()
    }
    assert.equal(mounted.providerSelection, selection)
    assert.equal(bw.commands().length, before)
    assert.equal((await mounted.read(bw.ref)).ok, true)
  } finally {
    await mounted.prepareQuit()
    restore()
  }
})

test('an invalid Keychain connection cannot retire an open provider', async t => {
  const bw = fakeVault(t)
  const op = fakeOnePassword(t)
  const restore = useFakeVaultExecutables(op, bw)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  let mounted
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  try {
    apply({ provide(_name, service) { mounted = service }, effect() {} })
    equalPrivate(await mounted.unlock({ connection: bw.connection, password: bw.password }), ok)
    const selection = mounted.providerSelection
    const binding = mounted.providerBinding(provider)
    const commands = bw.commands().length
    equalPrivate(await mounted.unlock({ provider, connection: 'other' }), refusal)
    assert.equal(mounted.providerSelection, selection, 'selection and generation stayed unchanged')
    assert.equal(mounted.providerBinding(provider), binding, 'the Keychain gate stayed unchanged')
    assert.equal(bw.commands().length, commands, 'preflight started no child')
    assert.equal((await mounted.read(bw.ref)).ok, true, 'the open provider remains readable')
  } finally {
    await mounted?.prepareQuit()
    restore()
    Object.defineProperty(process, 'platform', platform)
  }
})
