import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeClock, fakeVault } from './fixtures/harness.mjs'
import { fakeOnePassword, useFakeVaultExecutables } from './fixtures/onepassword.mjs'
import { apply } from '../index.js'
import { createWindowsCredential } from '../src/windows-credential/adapter.js'
import { connection, maxBlob, maxResponse, parseResponse, provider, requestOf } from '../src/windows-credential/parse.js'
import { availability, createRunner, powershell, root, taskkill } from '../src/windows-credential/run.js'
import { readerArgs } from '../src/windows-credential/script.js'
import { checkTranscripts, compilerScratchEvidence } from './native/wincred-evidence.mjs'
import { cleanupTargets, invokeFixture, writerArgs } from './native/wincred-writer.ps1.mjs'

const host = { platform: 'win32', arch: 'x64', machine: 'x86_64', parent: { SystemRoot: root, windir: root }, exists: () => true }
const frame = (prefix, bytes) => Buffer.from(prefix + ' ' + Buffer.from(bytes).toString('base64') + '\n')
const streams = (stdout = Buffer.alloc(0), code = 0, stderr = Buffer.alloc(0)) => ({ code, stdout, stderr })
const ref = item => ({ provider, connection, item, field: 'password' })
const blocked = { ok: false, code: 'blocked' }
const refused = { ok: false, code: 'refused' }
const locked = { ok: false, code: 'locked' }
const field = { ok: false, code: 'field' }
const allowed = { ok: true }
const marker = () => randomUUID()
const reserved = () => 'aUtOmAgIk-VaUlT:v1:' + marker()

function fakeReader() {
  let reader = 'primary', probe = () => streams()
  const records = new Map()
  const operations = []
  const native = []
  return {
    operations, native,
    reader(value) { reader = value },
    probe(fn) { probe = fn },
    put(target, user, bytes, set = reader) { records.set(JSON.stringify([set, target.toLowerCase()]), { user, bytes }) },
    delete(target) { records.delete(JSON.stringify([reader, target.toLowerCase()])) },
    availability: () => undefined,
    prepareQuit: async () => ({ ok: true, unconfirmed: 0 }),
    async run(op, target, { signal }) {
      operations.push(op)
      if (op === 'probe') return probe(signal)
      native.push(op)
      const entry = records.get(JSON.stringify([reader, target.toLowerCase()]))
      if (!entry) return streams(undefined, 10)
      if (op === 'meta') return streams(frame('M', entry.user ?? ''))
      return streams(entry.bytes.length ? frame('V', entry.bytes) : Buffer.from('Z\n'))
    },
  }
}

async function open(adapter) {
  assert.deepEqual(await adapter.preflight({}, () => true), allowed)
  assert.deepEqual(adapter.unlock(), allowed)
}

test('target validation and byte-exact input preserve Unicode, case and spaces', () => {
  const target = ' ' + marker() + ' 🌍ç  '
  assert.equal(requestOf('meta', target).equals(frame('meta', target)), true)
  assert.equal(requestOf('probe').equals(Buffer.from('probe \n')), true)
  const maximum = '\u0800'.repeat(256)
  assert.equal(requestOf('read', maximum).equals(frame('read', maximum)), true)
  for (const invalid of ['abc', 'x'.repeat(257), '\uD800' + target, target + '\r', target + '\n', target + '\u0085',
    target + '\u2067', target + '\u200b', target + '*', reserved()]) {
    assert.equal(requestOf('meta', invalid), undefined)
  }
  assert.equal(requestOf('probe', target), undefined)
})

test('response frames are bounded, canonical, and use strict UTF-16LE', () => {
  const value = '\uFEFF ' + marker() + ' 🌍  '
  const read = bytes => parseResponse('read', streams(frame('V', bytes)))
  assert.equal(read(Buffer.from(value, 'utf16le')).value === value, true)
  const maxText = marker().padEnd(maxBlob / 2, ' ')
  assert.equal(read(Buffer.from(maxText, 'utf16le')).value === maxText, true)
  assert.deepEqual(read(Buffer.alloc(maxBlob + 1)), refused)
  assert.deepEqual(read(Buffer.from([0xff])), field)
  assert.deepEqual(read(Buffer.from([0x00, 0xd8])), field)
  assert.deepEqual(read(Buffer.from([0x00, 0x00])), field)
  assert.deepEqual(parseResponse('read', streams(Buffer.from('Z\n'))), field)
  const ambiguous = Buffer.from(marker())
  assert.equal(read(ambiguous).value === ambiguous.toString('utf16le'), true)
  assert.deepEqual(parseResponse('meta', streams(frame('M', ''))), { ok: true, userName: null })
  for (const raw of ['V AA==\r\n', 'V AB==\n', 'V AA\n', 'V \n', 'V AA==\n\n', 'M AA==\n', 'V AA==', '']) {
    assert.deepEqual(parseResponse('read', streams(Buffer.from(raw))), refused)
  }
  assert.deepEqual(parseResponse('read', streams(Buffer.from([0xd6, 32, 65, 65, 61, 61, 10]))), refused)
  assert.deepEqual(parseResponse('meta', streams()), refused)
  assert.deepEqual(parseResponse('probe', streams(Buffer.from('\n'))), refused)
  assert.deepEqual(parseResponse('probe', streams(undefined, 14)), blocked)
  assert.deepEqual(parseResponse('meta', streams(undefined, 14, Buffer.from(' '))), refused)
  assert.deepEqual(parseResponse('read', streams(undefined, 10)), { ok: false, code: 'revoked', audit: 'refused' })
  assert.deepEqual(parseResponse('read', streams(Buffer.from('Z\n'), 10)), refused)
  for (const code of [5, 11, 12, 13]) assert.deepEqual(parseResponse('read', streams(undefined, code)), refused)
  assert.deepEqual(parseResponse('read', { ...streams(), signal: 'SIGTERM' }), refused)
})

test('probe copies no value, Find returns metadata only, and a target resolves in the reader’s set', async () => {
  const runner = fakeReader()
  const adapter = createWindowsCredential({}, { runner })
  const target = ' ' + marker() + ' 🌍  '
  const value = marker()
  const replacement = marker()
  const other = marker()
  const user = marker()
  runner.put(target, null, Buffer.from(value, 'utf16le'))
  runner.put(target, '', Buffer.from(other, 'utf16le'), 'other')
  assert.equal(adapter.status().state, 'locked')
  await open(adapter)
  assert.equal(adapter.status().state, 'unlocked')
  assert.deepEqual(runner.native, [])
  const picker = target => adapter.listItems({ connection, target })
  const variant = target.toUpperCase()
  const row = (await picker(variant)).items?.[0]
  assert.equal(row?.target === variant && row.id === variant && row.userName === null, true)
  assert.deepEqual(Object.keys(row), ['id', 'target', 'userName', 'fields'])
  assert.deepEqual(runner.native, ['meta'])
  assert.equal((await adapter.read(ref(variant))).value === value, true)
  assert.deepEqual(await picker(target + 'x'), { ok: true, items: [] })
  runner.delete(target)
  assert.deepEqual(await adapter.read(ref(target)), { ok: false, code: 'revoked', audit: 'refused' })
  runner.put(target, user, Buffer.from(replacement, 'utf16le'))
  assert.equal((await picker(target)).items[0].userName === user, true)
  assert.equal((await adapter.read(ref(target))).value === replacement, true)
  runner.put(target, user + '\u2067', Buffer.alloc(0))
  assert.equal((await picker(target)).items[0].userName, null)
  assert.deepEqual(await adapter.read(ref(target)), field)
  runner.reader('other')
  assert.equal((await picker(target)).items[0].userName, null)
  assert.equal((await adapter.read(ref(target))).value === other, true)
  const count = runner.operations.length
  assert.deepEqual(await picker(reserved()), refused)
  assert.deepEqual(await adapter.read(ref(reserved())), refused)
  assert.equal(runner.operations.length, count)
  assert.equal((await adapter.prepareQuit()).ok, true)
})

function mount(t, runner, options = {}) {
  let service
  apply({ provide(_key, value) { service = value }, effect() {} }, {}, { windows: { runner, ...options } })
  t.after(() => service.prepareQuit())
  return service
}
const unlock = service => service.unlock({ provider })

test('failed probe and status polls preserve the open provider, then a retry switches', async t => {
  const bw = fakeVault(t)
  const restore = useFakeVaultExecutables(fakeOnePassword(t), bw)
  t.after(restore)
  const runner = fakeReader()
  const service = mount(t, runner)
  assert.deepEqual(await service.unlock({ connection: bw.connection, password: bw.password }), allowed)
  const before = service.providerSelection
  runner.probe(() => streams(undefined, 14))
  assert.deepEqual(await unlock(service), blocked)
  assert.equal(service.providerSelection, before)
  assert.equal((await service.read(bw.ref)).ok, true, 'the original gate still reads')
  for (let i = 0; i < 3; i++) assert.throws(() => service.status({ provider }), { code: 'blocked' })
  assert.deepEqual(runner.operations, ['probe'])
  runner.probe(() => streams())
  assert.deepEqual(await unlock(service), allowed)
  assert.equal(service.providerSelection.provider, provider)
  assert.deepEqual(runner.native, [])
  const count = runner.operations.length
  assert.deepEqual(await service.read(ref(reserved())), refused)
  assert.deepEqual(await service.listItems({ provider, connection, target: reserved() }), refused)
  assert.equal(runner.operations.length, count)
})

test('late probe outcomes after lock or replacement cannot publish state', async t => {
  const runner = fakeReader()
  const service = mount(t, runner)
  const seen = Promise.withResolvers(), release = Promise.withResolvers()
  runner.probe(signal => { seen.resolve(signal); return release.promise })
  const waiting = unlock(service)
  const signal = await seen.promise
  const locking = service.lock({ provider })
  assert.equal(signal.aborted, true)
  release.resolve(streams())
  assert.equal(await locking, true)
  assert.deepEqual(await waiting, locked)
  assert.equal(service.providerSelection.provider, 'bitwarden')
  const late = Promise.withResolvers()
  runner.probe(() => late.promise)
  const stale = unlock(service)
  runner.probe(() => streams())
  assert.deepEqual(await unlock(service), allowed)
  late.resolve(streams(undefined, 14))
  assert.deepEqual(await stale, locked)
  assert.equal(service.status({ provider }).state, 'unlocked')
})

function childFixture(t, overrides = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'wincred-runner-'))
  const spawns = []
  const timers = fakeClock()
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const spawnChild = (file, argv, options) => {
    const child = Object.assign(new EventEmitter(), {
      pid: spawns.length + 200, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { child.killed = true },
      unref() {},
      exit(code) { child.exitCode = code; child.emit('exit', code, null) },
      close(code = child.exitCode) { child.emit('close', code, null) },
    })
    spawns.push({ child, file, argv, options })
    return child
  }
  const runner = createRunner({ ...host, ...overrides, profileDir: () => profile, timers, spawnChild })
  return { runner, timers, spawns, spawnChild, profile }
}

test('resolver accepts only trusted root, binaries and x64, and captures no parent environment', async t => {
  const markerValue = marker()
  for (const overrides of [
    { platform: 'linux' }, { isCloud: () => true }, { arch: 'ia32' }, { machine: 'ARM64' },
    { parent: { SystemRoot: 'D:\\Windows', windir: 'D:\\Windows' } },
    { parent: { SystemRoot: 'C:\\redirected', windir: root } }, { parent: { windir: root } },
    { parent: { SystemRoot: root, windir: root, WINDIR: 'D:\\Windows' } },
    { systemDirectory: 'D:\\Windows' }, { exists: file => file !== taskkill },
  ]) {
    const fake = childFixture(t, overrides)
    assert.ok(fake.runner.availability())
    assert.deepEqual(await fake.runner.run('probe', '', { timeout: 10 }), { failure: 'refused' })
    assert.equal(fake.spawns.length, 0)
  }
  const fake = childFixture(t, { parent: { SYSTEMROOT: root.toLowerCase(), WINDIR: root, TEMP: markerValue, COR_ENABLE_PROFILING: markerValue } })
  assert.equal(availability(host), undefined)
  assert.ok(['"' + powershell + '"', ...readerArgs.map(arg => '"' + arg + '"')].join(' ').length + 1 < 32767)
  const target = marker()
  const control = new AbortController()
  const pending = fake.runner.run('read', target, { timeout: 10, signal: control.signal })
  const { child, file, argv, options } = fake.spawns[0]
  assert.equal(file, powershell)
  assert.deepEqual(argv, readerArgs)
  assert.equal(JSON.stringify({ argv, options }).includes(target) || JSON.stringify({ argv, options }).includes(markerValue), false)
  assert.equal(JSON.stringify({ argv, options }).includes(Buffer.from(target).toString('base64')), false)
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'windir'])
  assert.equal(options.cwd, options.env.TEMP)
  assert.equal(options.cwd, options.env.TMP)
  assert.equal(readdirSync(options.cwd).length, 0)
  assert.equal(child.stdin.read().equals(frame('read', target)), true)
  control.abort()
  const stopped = await pending
  assert.equal(stopped.failure, 'canceled')
  assert.equal(fake.spawns[1].file, taskkill)
  assert.deepEqual(fake.spawns[1].argv, ['/T', '/F', '/PID', String(child.pid)])
  fake.spawns[1].child.exit(0)
  assert.equal(await stopped.cleanup, 'confirmed')
  assert.equal((await fake.runner.prepareQuit()).ok, true)
})

test('the launcher refuses under tracing before opening pipes or compiler scratch', async t => {
  const fake = childFixture(t)
  const tracer = t.mock.method(inspector, 'url', () => 'ws://localhost/fixture')
  syncBuiltinESMExports()
  try {
    assert.deepEqual(await fake.runner.run('probe', '', { timeout: 10 }), { failure: 'refused' })
    assert.equal(fake.spawns.length, 0)
    assert.deepEqual(readdirSync(fake.profile), [])
  } finally {
    tracer.mock.restore()
    syncBuiltinESMExports()
  }
})

test('Node stream debugging refuses before spawning and survives deletion of startup debug settings', async t => {
  const module = new URL('../src/windows-credential/run.js', import.meta.url).href
  for (const trace of [{ NODE_DEBUG: 'fs,STREAM' }, { NODE_DEBUG: 'st*' }, { NODE_DEBUG_NATIVE: 'STREAM' }]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { createRunner, root } from ${JSON.stringify(module)}
      delete process.env.NODE_DEBUG
      delete process.env.NODE_DEBUG_NATIVE
      let attempts = 0
      const runner = createRunner({
        platform: 'win32', arch: 'x64', machine: 'x86_64', parent: { SystemRoot: root, windir: root },
        exists: () => true, profileDir: () => { attempts++ }, spawnChild: () => { attempts++ },
      })
      assert.deepEqual(await runner.run('read', 'fixture-' + process.pid, { timeout: 10 }), { failure: 'refused' })
      assert.equal(attempts, 0)
    `], { env: { ...process.env, ...trace }, stdio: 'ignore', timeout: 5000 })
    t.after(() => child.kill())
    const [code] = await once(child, 'close')
    assert.equal(code, 0)
  }
})

test('quit includes compiler directory removal on close and after successful taskkill', async t => {
  for (const stopped of [false, true]) {
    const entered = Promise.withResolvers(), remove = Promise.withResolvers()
    const { runner, spawns } = childFixture(t, { removeScratch: cwd => { entered.resolve(cwd); return remove.promise } })
    const abort = new AbortController()
    const running = runner.run('probe', '', { timeout: 100, signal: abort.signal })
    if (stopped) {
      abort.abort()
      spawns[1].child.exit(0)
    } else {
      spawns[0].child.exit(0)
      spawns[0].child.close()
    }
    const result = await running
    assert.equal(await entered.promise, spawns[0].options.cwd)
    let finished = false
    const quit = runner.prepareQuit().then(answer => { finished = true; return answer })
    await Promise.resolve()
    assert.equal(finished, false)
    remove.reject(new Error('fixture denied scratch removal'))
    assert.equal(await result.cleanup, 'unconfirmed')
    assert.deepEqual(await quit, { ok: false, unconfirmed: 1 })
  }
})

test('compiler directory removal shares the bounded cleanup deadline', async t => {
  const entered = Promise.withResolvers()
  const { runner, timers, spawns } = childFixture(t, {
    removeScratch() { entered.resolve(); return new Promise(() => {}) },
  })
  const running = runner.run('probe', '', { timeout: 10 })
  timers.tick(10)
  const result = await running
  timers.tick(4000)
  spawns[1].child.exit(0)
  await entered.promise
  const quit = runner.prepareQuit()
  timers.tick(1000)
  assert.equal(await result.cleanup, 'unconfirmed')
  assert.deepEqual(await quit, { ok: false, unconfirmed: 1 })
})

test('native evidence finds each process in dated transcript directories and checks its bytes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wincred-transcripts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const day = join(dir, '20261120')
  mkdirSync(day)
  const reader = join(day, 'reader.txt')
  const writer = join(day, 'writer.txt')
  writeFileSync(reader, 'Windows PowerShell transcript\r\nProcess ID: 4661\r\n')
  writeFileSync(writer, '\uFEFFWindows PowerShell transcript\r\nProcess ID: 4662\r\n', 'utf16le')
  const needles = [Buffer.from(marker())]
  await checkTranscripts(dir, [4661, 4662], needles)
  await assert.rejects(checkTranscripts(dir, [4661, 4662, 4663], needles), /transcript for each reader and writer/)
  writeFileSync(reader, Buffer.concat([Buffer.from('Process ID: 4661\n'), ...needles]))
  await assert.rejects(checkTranscripts(dir, [4661, 4662], needles), /private bytes in transcript/)
})

test('native evidence scans transcripts with missing or unrecognized process IDs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wincred-transcripts-extra-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'reader.txt'), 'Process ID: 4661\n')
  writeFileSync(join(dir, 'writer.txt'), 'Process ID: 4662\n')
  const needle = marker()
  const extra = join(dir, 'extra.txt')
  for (const header of ['', 'Process ID: 4663\n']) {
    writeFileSync(extra, header + needle)
    await assert.rejects(checkTranscripts(dir, [4661, 4662], [Buffer.from(needle)]), /private bytes in transcript/)
  }
  writeFileSync(extra, 'Process ID: 4663\n')
  await checkTranscripts(dir, [4661, 4662], [Buffer.from(needle)])
})

test('native compiler observations belong to each invocation and track unresolved files', () => {
  const seen = []
  const scan = bytes => seen.push(bytes.toString())
  const file = Buffer.from(marker())
  const options = {
    stat: () => ({ isFile: () => true }),
    read: () => file,
  }
  const probe = compilerScratchEvidence(scan, options)
  probe.inspect('compiler.tmp')
  assert.equal(probe.inspected, 1)
  for (const code of ['ENOENT', 'EPERM', 'EACCES', 'EBUSY']) {
    let failure = true
    const invocation = compilerScratchEvidence(scan, {
      ...options,
      read(path) {
        if (path === 'unresolved.tmp' && failure) throw Object.assign(new Error('fixture read failed'), { code })
        return options.read()
      },
    })
    invocation.inspect('unresolved.tmp', 'rename')
    assert.equal(invocation.inspected, 0, 'probe evidence cannot satisfy another invocation')
    assert.equal(invocation.incomplete, true)
    invocation.inspect('compiler.tmp')
    assert.equal(invocation.inspected, 1)
    assert.equal(invocation.incomplete, true, 'one readable file cannot mask another missing file')
    failure = false
    invocation.inspect('unresolved.tmp', 'change')
    assert.equal(invocation.inspected, 2)
    assert.equal(invocation.incomplete, false)
    if (code === 'ENOENT') {
      failure = true
      invocation.inspect('unresolved.tmp', 'rename')
      assert.equal(invocation.incomplete, false, 'a file already inspected can be deleted')
    }
  }
  assert.equal(seen.length, 9)
})

test('native compiler evidence accepts empty compiler logs but not content it could not read', () => {
  const files = new Map([['log.err', Buffer.alloc(0)], ['source.cs', Buffer.from('compiler source')]])
  const evidence = compilerScratchEvidence(() => {}, {
    stat: () => ({ isFile: () => true }),
    read(path) {
      if (files.has(path)) return files.get(path)
      throw Object.assign(new Error('fixture removed'), { code: 'ENOENT' })
    },
  })
  evidence.inspect('log.err', 'rename')
  evidence.inspect('source.cs', 'change')
  files.delete('log.err')
  evidence.inspect('log.err', 'rename')
  assert.equal(evidence.inspected, 1)
  assert.equal(evidence.incomplete, false, 'an empty log the compiler deletes is no gap')
  evidence.inspect('late.tmp', 'change')
  assert.equal(evidence.incomplete, true, 'a change whose file is already gone is a gap')
  assert.equal(evidence.gaps, '.tmp:change:ENOENT:never read')
  files.set('late.tmp', Buffer.from('compiler source'))
  evidence.inspect('late.tmp', 'change')
  assert.equal(evidence.incomplete, false)
  assert.equal(evidence.inspected, 2)
})

test('native compiler evidence tells a pending deletion from a lock or an unread file', () => {
  const errors = new Map()
  const files = new Map([['done.tmp', Buffer.from('compiler source')], ['locked.tmp', Buffer.from('compiler source')]])
  const evidence = compilerScratchEvidence(() => {}, {
    stat: () => ({ isFile: () => true }),
    read(path) {
      if (errors.has(path)) throw Object.assign(new Error('fixture refusal'), { code: errors.get(path) })
      if (files.has(path)) return files.get(path)
      throw Object.assign(new Error('fixture removed'), { code: 'ENOENT' })
    },
  })
  for (const path of files.keys()) evidence.inspect(path, 'rename')
  errors.set('done.tmp', 'EPERM')
  evidence.inspect('done.tmp', 'change')
  errors.set('locked.tmp', 'EBUSY')
  evidence.inspect('locked.tmp', 'change')
  errors.set('never', 'EPERM')
  evidence.inspect('never', 'rename')
  for (const path of ['done.tmp', 'locked.tmp', 'never']) {
    errors.delete(path)
    files.delete(path)
    evidence.inspect(path, 'rename')
  }
  assert.equal(evidence.incomplete, true)
  assert.equal(evidence.gaps, '(none):rename:EPERM:never read .tmp:change:EBUSY:read',
    'only a read file whose deletion was pending is complete')
})

test('deadline invalidates its captured gate while quit independently bounds cleanup', async t => {
  const { runner, timers, spawns } = childFixture(t, { removeScratch: () => {} })
  const adapter = createWindowsCredential({}, { runner, timers, timeouts: { read: 10, probe: 30, meta: 15 } })
  const finish = i => { spawns[i].child.exit(0); spawns[i].child.close() }
  const first = open(adapter)
  finish(0)
  await first
  const gate = adapter.binding
  const read = adapter.read(ref(marker()))
  await Promise.resolve()
  timers.tick(10)
  assert.deepEqual(await read, refused)
  assert.notEqual(adapter.binding, gate)
  assert.equal(adapter.status().state, 'locked')
  assert.equal(spawns[2].file, taskkill)
  const second = open(adapter)
  finish(3)
  await second
  const fresh = adapter.binding
  spawns[1].child.stdout.emit('data', Buffer.alloc(maxResponse + 1))
  assert.equal(adapter.binding, fresh)
  let finished = false
  const quit = adapter.prepareQuit().then(answer => { finished = true; return answer })
  await Promise.resolve()
  timers.tick(4999)
  assert.equal(finished, false)
  timers.tick(1)
  assert.deepEqual(await quit, { ok: false, unconfirmed: 1 })
  assert.equal(spawns[2].child.killed, true)
})

test('failed taskkill and a descendant holding a pipe are bounded without a stale PID', async t => {
  const failed = childFixture(t)
  const read = failed.runner.run('read', marker(), { timeout: 10 })
  failed.timers.tick(10)
  const result = await read
  assert.equal(result.failure, 'timeout')
  failed.spawns[1].child.exit(1)
  assert.equal(await result.cleanup, 'unconfirmed')
  assert.deepEqual(await failed.runner.prepareQuit(), { ok: false, unconfirmed: 1 })

  const held = childFixture(t)
  const lookup = held.runner.run('meta', marker(), { timeout: 10 })
  held.spawns[0].child.exit(0)
  held.timers.tick(10)
  const deadline = await lookup
  assert.equal(deadline.failure, 'timeout')
  assert.equal(await deadline.cleanup, 'unconfirmed')
  assert.equal(held.spawns.length, 1)
})

test('wire contamination and a partial response never release a value', async t => {
  const { runner, spawns } = childFixture(t)
  const target = marker()
  const read = runner.run('read', target, { timeout: 10 })
  const { child } = spawns[0]
  child.stdout.write(frame('V', Buffer.from(marker(), 'utf16le')))
  child.stderr.write(Buffer.from([0]))
  assert.deepEqual(parseResponse('read', await read), refused)
  spawns[1].child.exit(0)
  const partial = runner.run('read', target, { timeout: 10 })
  spawns[2].child.stdout.write(Buffer.from('V YQ'))
  spawns[2].child.exit(0)
  spawns[2].child.close()
  assert.deepEqual(parseResponse('read', await partial), refused)
  const partialWrite = runner.run('read', target, { timeout: 10 })
  spawns[3].child.stdin.emit('error', Object.assign(new Error('fixture closed its pipe'), { code: 'EPIPE' }))
  const rejected = await partialWrite
  assert.deepEqual(parseResponse('read', rejected), refused)
  spawns[4].child.exit(0)
  await runner.prepareQuit()
})

test('a later helper initialization failure closes the active gate and offers a clean retry', async () => {
  const runner = fakeReader()
  const run = runner.run
  const adapter = createWindowsCredential({}, {
    runner, run: async (op, target, limits) => op === 'meta' ? streams(undefined, 14) : run(op, target, limits),
  })
  await open(adapter)
  const gate = adapter.binding
  assert.deepEqual(await adapter.listItems({ connection, target: marker() }), blocked)
  assert.notEqual(adapter.binding, gate)
  assert.throws(() => adapter.status(), { code: 'blocked' })
  await open(adapter)
  assert.equal(adapter.status().state, 'unlocked')
  await adapter.prepareQuit()
})

test('a timed-out fixture writer cannot turn an early absence into cleanup success', async t => {
  const { timers, spawns, spawnChild } = childFixture(t)
  const target = marker()
  const other = marker()
  const pending = invokeFixture(powershell, writerArgs, {
    timers, spawnChild, stdin: Buffer.from(marker()),
  })
  timers.tick(30_000)
  assert.equal(spawns[1].file, taskkill)
  timers.tick(5000)
  const result = await pending
  assert.equal(result.exited, false)
  let confirmedRead = 0
  assert.equal(await cleanupTargets(new Map([[target, result.exited], [other, true]]), {
    async remove() { return true },
    async absent(item) { assert.equal(item === other, true); confirmedRead++; return true },
  }), false)
  assert.equal(confirmedRead, 1)
  spawns[0].child.exit(0)
  spawns[0].child.close()
})

test('raw and base64 markers stay out of captured TAP', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/wincred-tap.mjs', import.meta.url))
  const driver = String.raw`
import { randomUUID } from 'node:crypto'
import { run } from 'node:test'
import { tap } from 'node:test/reporters'

const markers = { target: randomUUID(), user: randomUUID(), value: randomUUID() }
globalThis.__wincredTestCanaries = markers
let transcript = ''
for await (const chunk of run({ files: [process.argv[2]], isolation: 'none' }).compose(tap)) transcript += chunk
for (const canary of Object.values(markers)) {
  for (const value of [canary, Buffer.from(canary).toString('base64'), Buffer.from(canary, 'utf16le').toString('base64')]) {
    if (transcript.includes(value)) throw new Error('private bytes appeared in TAP')
  }
}
if (!/# pass 1\b/.test(transcript)) throw new Error('expected one passing TAP result')
process.stdout.write(transcript)
`
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const dir = mkdtempSync(join(tmpdir(), 'wincred-tap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const driverFile = join(dir, 'driver.mjs')
  writeFileSync(driverFile, driver, { mode: 0o600 })
  const log = join(dir, 'tap')
  const out = openSync(log, 'w', 0o600)
  let child
  try {
    child = spawn(process.execPath, [driverFile, fixture],
      { env, timeout: 5000, stdio: ['ignore', out, out] })
  } finally { closeSync(out) }
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  assert.equal(/# pass 1\b/.test(readFileSync(log, 'utf8')), true)
})
