import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appHome } from '../src/dsh.js'
import { OWNER_FILE, ensureOwnerRecord, ownerFileOf, readOwnerRecord } from '../src/owner-record.js'

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file modes and types' : false }
const record = { version: 1, local_id: 'local', instance_id: 'instance' }
const fault = code => Object.assign(new Error(code), { code })
const noLink = () => { throw fault('ENOTSUP') }

function scratch(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'owner-record-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('first run creates the record in a home with spaces and later runs keep its bytes and mtime', (t) => {
  const home = join(scratch(t), 'home with spaces')
  const file = ownerFileOf(home)
  assert.equal(OWNER_FILE, 'owner.json')
  assert.equal(file, join(home, 'owner.json'))
  assert.equal(readOwnerRecord(home), null)
  const ids = ['first', 'second']
  assert.deepEqual(ensureOwnerRecord(home, { random: () => ids.shift() }), { instanceId: 'second' })
  assert.deepEqual(ids, [])
  const bytes = fs.readFileSync(file, 'utf8')
  assert.equal(bytes, '{"version":1,"local_id":"first","instance_id":"second"}\n')
  const { mode, mtimeMs } = fs.statSync(file)
  if (process.platform !== 'win32') assert.equal(mode & 0o777, 0o600)
  assert.deepEqual(ensureOwnerRecord(home, { random: () => assert.fail('the ids already exist') }), { instanceId: 'second' })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.equal(fs.statSync(file).mtimeMs, mtimeMs)
  assert.deepEqual(fs.readdirSync(home), [OWNER_FILE])
})

test('the id follows AUTOMAGIK_HOME, including a copy, independently of AUTOMAGIK_USER_DATA', (t) => {
  const root = scratch(t)
  const first = appHome({ AUTOMAGIK_HOME: join(root, 'first'), AUTOMAGIK_USER_DATA: join(root, 'profile-1') })
  const same = appHome({ AUTOMAGIK_HOME: join(root, 'first'), AUTOMAGIK_USER_DATA: join(root, 'profile-2') })
  const second = appHome({ AUTOMAGIK_HOME: join(root, 'second'), AUTOMAGIK_USER_DATA: join(root, 'profile-1') })
  const copy = appHome({ AUTOMAGIK_HOME: join(root, 'copy') })
  const id = ensureOwnerRecord(first)
  assert.match(id.instanceId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(ensureOwnerRecord(same), id)
  const other = ensureOwnerRecord(second)
  assert.match(other.instanceId, /^[0-9a-f-]{36}$/)
  assert.notEqual(other.instanceId, id.instanceId)
  fs.cpSync(first, copy, { recursive: true })
  assert.deepEqual(ensureOwnerRecord(copy), id)
  assert.deepEqual(fs.readFileSync(ownerFileOf(copy)), fs.readFileSync(ownerFileOf(first)))
})

test('linked and unknown fields are kept byte for byte and only the instance id is returned', (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  const sentinel = 'owner-only sentinel'
  for (const owner of [
    { ...record, linked: { issuer: sentinel, subject: sentinel }, unknown: sentinel },
    { version: 2, instance_id: record.instance_id },
  ]) {
    const bytes = JSON.stringify(owner, null, 2) + '\n'
    fs.writeFileSync(file, bytes)
    const result = ensureOwnerRecord(home)
    assert.deepEqual(result, { instanceId: record.instance_id })
    assert.equal(JSON.stringify(result).includes(sentinel), false)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
})

test('existing ids accept well-formed environment strings up to 4096 UTF-16 units', (t) => {
  const home = scratch(t)
  for (const instanceId of ['x', 'tabs\t and\ncontrols\x1f\x7f 🪄', 'x'.repeat(257), '🪄'.repeat(2048)]) {
    const bytes = JSON.stringify({ ...record, instance_id: instanceId })
    fs.writeFileSync(ownerFileOf(home), bytes)
    assert.deepEqual(ensureOwnerRecord(home), { instanceId })
    assert.equal(fs.readFileSync(ownerFileOf(home), 'utf8'), bytes)
  }
})

test('invalid records and old partial files stay byte for byte', (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  const now = Date.now()
  const old = new Date(now - 5_001)
  const invalid = [
    '', '{', 'null', '[]', '1',
    ...[
      { ...record, local_id: undefined }, { ...record, local_id: '' }, { ...record, local_id: 0 },
      { ...record, version: 0 }, { ...record, version: '1' }, { ...record, version: 1.5 },
      ...[undefined, '', 0, 'x\0y', '\ud800', 'x'.repeat(4097)].map(instance_id => ({ ...record, instance_id })),
      { version: 2, instance_id: '\udfff' },
    ].map(value => JSON.stringify(value)),
  ]
  for (const bytes of invalid) {
    fs.writeFileSync(file, bytes)
    fs.utimesSync(file, old, old)
    const waits = []
    assert.deepEqual(ensureOwnerRecord(home, { now: () => now, wait: ms => waits.push(ms) }), { error: 'invalid' })
    assert.deepEqual(waits, [])
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
})

test('a parsed but invalid record is not reread even when young', (t) => {
  const home = scratch(t)
  fs.writeFileSync(ownerFileOf(home), '{}')
  const waits = []
  assert.deepEqual(ensureOwnerRecord(home, { wait: ms => waits.push(ms) }), { error: 'invalid' })
  assert.deepEqual(waits, [])
})

test('a directory at owner.json is never read', (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  fs.mkdirSync(file)
  const reads = []
  assert.deepEqual(ensureOwnerRecord(home, { fs: { ...fs, readFileSync: fd => reads.push(fd) } }), { error: 'not-a-file' })
  assert.deepEqual(reads, [])
  assert.ok(fs.statSync(file).isDirectory())
})

test('a FIFO is opened without blocking and never read, and a symlink is refused', posixOnly, (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  const reads = []
  const deps = { fs: { ...fs, readFileSync: fd => reads.push(fd) } }
  execFileSync('mkfifo', [file], { stdio: 'ignore' })
  assert.deepEqual(ensureOwnerRecord(home, deps), { error: 'not-a-file' })
  assert.ok(fs.lstatSync(file).isFIFO())
  fs.unlinkSync(file)
  const target = join(home, 'target')
  fs.writeFileSync(target, JSON.stringify(record))
  fs.symlinkSync(target, file)
  assert.deepEqual(ensureOwnerRecord(home, deps), { error: 'not-a-file' })
  assert.ok(fs.lstatSync(file).isSymbolicLink())
  assert.deepEqual(reads, [])
})

test('a failed read keeps the record and a failed create removes its temporary file', (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  const bytes = JSON.stringify(record)
  fs.writeFileSync(file, bytes)
  const denied = { ...fs, readFileSync: () => { throw fault('EACCES') } }
  assert.deepEqual(ensureOwnerRecord(home, { fs: denied }), { error: 'unreadable' })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  fs.unlinkSync(file)
  const failed = { ...fs, fsyncSync: () => { throw fault('EIO') } }
  assert.deepEqual(ensureOwnerRecord(home, { fs: failed }), { error: 'create-failed' })
  assert.deepEqual(fs.readdirSync(home), [])
})

test('if another process publishes before link, its finished record wins', (t) => {
  const home = scratch(t)
  const bytes = JSON.stringify(record)
  const linkSync = (temporary, file) => {
    assert.match(temporary, new RegExp(`owner\\.json\\.${process.pid}\\.[0-9a-f]{16}\\.tmp$`))
    fs.writeFileSync(file, bytes, { flag: 'wx' })
    throw fault('EEXIST')
  }
  assert.deepEqual(ensureOwnerRecord(home, { fs: { ...fs, linkSync } }), { instanceId: record.instance_id })
  assert.equal(fs.readFileSync(ownerFileOf(home), 'utf8'), bytes)
  assert.deepEqual(fs.readdirSync(home), [OWNER_FILE])
})

test('when hard links are unavailable the record is still created exclusively', (t) => {
  const home = scratch(t)
  const calls = []
  const openSync = (...args) => { calls.push(args); return fs.openSync(...args) }
  const id = ensureOwnerRecord(home, { fs: { ...fs, linkSync: noLink, openSync } })
  assert.deepEqual(calls.at(-1), [ownerFileOf(home), 'wx', 0o600])
  assert.match(id.instanceId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(readOwnerRecord(home), id)
  assert.deepEqual(fs.readdirSync(home), [OWNER_FILE])
})

test('both creation paths set mode 0600 even with a restrictive umask', posixOnly, (t) => {
  const homes = [scratch(t), scratch(t)]
  const previous = process.umask(0o777)
  let results
  try {
    results = [ensureOwnerRecord(homes[0]), ensureOwnerRecord(homes[1], { fs: { ...fs, linkSync: noLink } })]
  } finally {
    process.umask(previous)
  }
  for (const [index, home] of homes.entries()) {
    assert.ok(results[index].instanceId)
    assert.equal(fs.statSync(ownerFileOf(home)).mode & 0o777, 0o600)
  }
})

// File signals let the test's synchronous fs hooks wait for the other process.
function waitForFile(file) {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    Atomics.wait(signal, 0, 0, 5)
  }
}

const moduleUrl = new URL('../src/owner-record.js', import.meta.url).href
const messageFrom = async child => (await once(child, 'message'))[0]

function forkOwner(t, script, home) {
  const child = fork(script, [home], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => child.kill())
  const done = once(child, 'exit')
  const ready = messageFrom(child)
  return { child, ready, done }
}

test('a fallback open that loses to a paused writer rereads the winner after two waits', { timeout: 15_000 }, async (t) => {
  const root = scratch(t)
  const home = join(root, 'home')
  fs.mkdirSync(home)
  const script = join(root, 'writer.mjs')
  fs.writeFileSync(script, `
import * as fs from 'node:fs'
import { join } from 'node:path'
import { ensureOwnerRecord, ownerFileOf } from ${JSON.stringify(moduleUrl)}
${waitForFile.toString()}
const home = process.argv[2]
const file = ownerFileOf(home)
let ownerFd
const openSync = (path, ...args) => {
  const fd = fs.openSync(path, ...args)
  if (path === file && args[0] === 'wx') ownerFd = fd
  return fd
}
const writeFileSync = (fd, text) => {
  if (fd === ownerFd) {
    fs.writeFileSync(join(home, 'paused'), '')
    waitForFile(join(home, 'release'))
  }
  fs.writeFileSync(fd, text)
}
process.once('message', () => {
  const result = ensureOwnerRecord(home, { fs: { ...fs, openSync, writeFileSync, linkSync: () => {
    throw Object.assign(new Error('no links'), { code: 'ENOTSUP' })
  } } })
  fs.writeFileSync(join(home, 'done'), '')
  process.send(result)
})
process.send('ready')
`)
  const writer = forkOwner(t, script, home)
  assert.equal(await writer.ready, 'ready')
  const finished = messageFrom(writer.child)
  const linkSync = () => {
    writer.child.send('start')
    waitForFile(join(home, 'paused'))
    noLink()
  }
  const waits = []
  const wait = (ms) => {
    waits.push(ms)
    if (waits.length === 2) {
      fs.writeFileSync(join(home, 'release'), '')
      waitForFile(join(home, 'done'))
    }
  }
  const winner = ensureOwnerRecord(home, { fs: { ...fs, linkSync }, wait })
  assert.deepEqual(waits, [50, 50])
  assert.deepEqual(winner, { instanceId: JSON.parse(fs.readFileSync(ownerFileOf(home), 'utf8')).instance_id })
  assert.deepEqual(await finished, winner)
  assert.deepEqual(await writer.done, [0, null])
  assert.equal(fs.readdirSync(home).some(file => file.endsWith('.tmp')), false)
})

test('a fallback writer that stops at an empty file leaves it invalid after ten waits', (t) => {
  const home = scratch(t)
  const file = ownerFileOf(home)
  let ownerFd
  const openSync = (path, ...args) => {
    const fd = fs.openSync(path, ...args)
    if (path === file && args[0] === 'wx') ownerFd = fd
    return fd
  }
  const writeFileSync = (fd, text) => {
    if (fd === ownerFd) throw fault('EIO')
    fs.writeFileSync(fd, text)
  }
  const linkSync = () => {
    const stalled = ensureOwnerRecord(home, { fs: { ...fs, openSync, writeFileSync, linkSync: noLink } })
    assert.deepEqual(stalled, { error: 'create-failed' })
    noLink()
  }
  const waits = []
  assert.deepEqual(ensureOwnerRecord(home, { fs: { ...fs, linkSync }, wait: ms => waits.push(ms) }), { error: 'invalid' })
  assert.deepEqual(waits, Array(10).fill(50))
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  assert.deepEqual(fs.readdirSync(home), [OWNER_FILE])
})

test('two processes starting together agree on one id in each of twenty fresh homes', { timeout: 30_000 }, async (t) => {
  const root = scratch(t)
  const script = join(root, 'start.mjs')
  fs.writeFileSync(script, `
import { ensureOwnerRecord } from ${JSON.stringify(moduleUrl)}
process.once('message', () => process.send(ensureOwnerRecord(process.argv[2])))
process.send('ready')
`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const home = join(root, String(attempt))
    const pair = [forkOwner(t, script, home), forkOwner(t, script, home)]
    assert.deepEqual(await Promise.all(pair.map(process => process.ready)), ['ready', 'ready'])
    const results = pair.map(({ child }) => messageFrom(child))
    for (const { child } of pair) child.send('start')
    const [first, second] = await Promise.all(results)
    assert.match(first.instanceId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(second, first)
    assert.deepEqual(await Promise.all(pair.map(process => process.done)), [[0, null], [0, null]])
    assert.deepEqual(readOwnerRecord(home), first)
    assert.deepEqual(fs.readdirSync(home), [OWNER_FILE])
  }
})
