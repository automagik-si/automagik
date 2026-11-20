import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createMachineRecord, reservationsDir } from '../src/host/machine-reservations.js'

const exact = 'x'.repeat(43)
const loose = 'l'.repeat(43)
const claim = { vendor: 'claude', exact, loose, instance: 'instance A', label: 'Project A' }
const at = '2026-11-20T12:00:00.000Z'
const fault = code => Object.assign(new Error(code), { code })

function fixture(t, { absent = false, override = {}, wait = () => {} } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'automagik-machine-record-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'reservations')
  const key = join(dir, 'key')
  const final = join(dir, `claude-${exact}.json`)
  function setUp() {
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o3770)
    fs.writeFileSync(key, Buffer.alloc(32, 42))
    fs.chmodSync(key, 0o640)
  }
  if (!absent) setUp()
  const record = createMachineRecord({
    fs: { ...fs, ...override }, dir: () => dir, platform: process.platform,
    uid: () => process.getuid(), pid: process.pid,
    random: (size, format) => randomBytes(size).toString(format), now: () => Date.parse(at),
    wait, userName: id => `uid ${id}`,
  })
  const expect = () => fs.statSync(final)
  const read = () => record.readExact(record.open(), 'claude', exact)
  const scan = () => record.scanLoose(record.open(), 'claude', loose)
  const reserve = (input = claim) => record.reserve(record.open(), input)
  const write = (changes = {}) => fs.writeFileSync(final, JSON.stringify({
    version: 1, ...claim, at, ...changes,
  }))
  return { root, dir, key, final, record, setUp, expect, read, scan, reserve, write }
}

test('A1 chooses platform defaults, an absolute override, or no path', () => {
  const path = (platform, value) => reservationsDir({
    platform, env: { AUTOMAGIK_RESERVATIONS_DIR: value },
  })
  assert.equal(path('linux'), '/var/lib/automagik/reservations')
  assert.equal(path('darwin'), '/Users/Shared/Automagik/reservations')
  assert.equal(path('linux', '/temporary/value///'), '/temporary/value')
  for (const bad of ['', '/', '///', 'relative', '/tmp/\0a']) {
    assert.equal(path('linux', bad), undefined)
  }
  assert.equal(path('win32', '/temporary/value'), undefined)
  const machine = createMachineRecord({
    platform: 'win32', fs: { constants: fs.constants },
    dir: () => assert.fail('Windows must not look up a path'),
  })
  assert.deepEqual(machine.open(), { state: 'unsupported' })
})

test('A2 validates directory access, owner, modes and the key by descriptor', t => {
  let foreign = false, wrongGroup = false, readOnly = false
  const h = fixture(t, { absent: true, override: {
    lstatSync(path) {
      const st = fs.lstatSync(path)
      if (foreign) st.uid = process.getuid() + 1
      return st
    },
    fstatSync(fd) {
      const st = fs.fstatSync(fd)
      if (wrongGroup) st.gid++
      return st
    },
    accessSync(path, flags) {
      if (readOnly && flags === fs.constants.W_OK) throw fault('EACCES')
      fs.accessSync(path, flags)
    },
  } })
  const state = () => h.record.open().state
  assert.equal(state(), 'absent')
  h.setUp()
  for (const mode of [0o2770, 0o1770, 0o3777]) {
    fs.chmodSync(h.dir, mode)
    if (mode === 0o1770 && process.platform !== 'linux') continue
    assert.equal(state(), 'not-set-up', mode.toString(8))
  }
  fs.chmodSync(h.dir, 0o3770)
  foreign = true
  assert.equal(state(), 'not-set-up')
  foreign = false
  const moved = join(h.root, 'moved')
  fs.renameSync(h.dir, moved)
  fs.symlinkSync(moved, h.dir)
  assert.equal(state(), 'not-set-up')
  fs.unlinkSync(h.dir)
  fs.renameSync(moved, h.dir)
  fs.unlinkSync(h.key)
  assert.equal(state(), 'no-key')
  fs.symlinkSync('/dev/null', h.key)
  assert.equal(state(), 'bad-key')
  fs.unlinkSync(h.key)
  execFileSync('mkfifo', [h.key], { stdio: 'inherit' })
  assert.equal(state(), 'bad-key')
  fs.unlinkSync(h.key)
  for (const size of [31, 33, 32]) {
    fs.writeFileSync(h.key, Buffer.alloc(size))
    fs.chmodSync(h.key, 0o662)
    assert.equal(state(), 'bad-key')
    fs.chmodSync(h.key, 0o640)
    assert.equal(state(), size === 32 ? 'ready' : 'bad-key')
  }
  wrongGroup = true
  assert.equal(state(), 'bad-key')
  wrongGroup = false
  assert.equal(h.record.open().writable, true)
  readOnly = true
  assert.equal(h.record.open().writable, false)
})

test('A2 inaccessible ancestor makes the directory unreadable', t => {
  if (process.getuid() === 0) return t.skip('requires an unprivileged uid')
  const h = fixture(t)
  fs.chmodSync(h.root, 0o000)
  try { assert.deepEqual(h.record.open(), { state: 'unreadable' }) } finally {
    fs.chmodSync(h.root, 0o700)
  }
})

test('A3 writes the parsed v1 shape and 0640 even under umask 077', t => {
  const h = fixture(t)
  const previous = process.umask(0o077)
  const codex = { ...claim, vendor: 'codex', class: 'workspace' }
  try {
    assert.equal(h.reserve().created, true)
    assert.equal(h.reserve(codex).created, true)
  } finally { process.umask(previous) }
  const names = fs.readdirSync(h.dir)
  assert.deepEqual(names, [`claude-${exact}.json`, `codex-${exact}.json`, 'key'])
  for (const input of [claim, codex]) {
    const path = join(h.dir, `${input.vendor}-${exact}.json`)
    assert.equal(fs.statSync(path).mode & 0o777, 0o640)
    assert.deepEqual(JSON.parse(fs.readFileSync(path)), { ...input, version: 1, at })
  }
})

test('A4/A6 a reader sees absent during the private write, and a concurrent winner stays', t => {
  let snapshot
  const h = fixture(t, { override: {
    writeFileSync(fd, content) {
      assert.equal(h.read().state, 'absent')
      fs.writeFileSync(fd, content)
    },
    linkSync(temp, final) {
      h.write({ instance: 'B', label: 'Winner' })
      const { ino, mtimeMs } = h.expect()
      snapshot = { bytes: fs.readFileSync(final), ino, mtimeMs }
      fs.linkSync(temp, final)
    },
  } })
  assert.deepEqual(h.reserve(), { conflict: { label: 'Winner', owner: `uid ${process.getuid()}` } })
  assert.deepEqual(fs.readFileSync(h.final), snapshot.bytes)
  assert.equal(h.expect().ino, snapshot.ino)
  assert.equal(h.expect().mtimeMs, snapshot.mtimeMs)
  assert.deepEqual(fs.readdirSync(h.dir), [`claude-${exact}.json`, 'key'])
})

test('A4 two processes released together publish exactly one reservation', async t => {
  const h = fixture(t)
  const barrier = join(h.root, 'go')
  const file = new URL('../src/host/machine-reservations.js', import.meta.url).href
  const code = `
    import { createMachineRecord } from ${JSON.stringify(file)}
    import fs from 'node:fs'
    import { randomBytes } from 'node:crypto'
    import { setTimeout } from 'node:timers/promises'
    const [dir, barrier, instance, json] = process.argv.slice(1)
    const data = { ...JSON.parse(json), instance, label: instance }
    const machine = createMachineRecord({
      fs, dir: () => dir, platform: process.platform, uid: () => process.getuid(),
      pid: process.pid, now: Date.now, wait() {}, userName: String,
      random: (size, format) => randomBytes(size).toString(format),
    })
    fs.writeFileSync(barrier + instance, '')
    for (let i = 0; i < 500 && !fs.existsSync(barrier); i++) await setTimeout(10)
    if (!fs.existsSync(barrier)) process.exit(2)
    console.log(JSON.stringify(machine.reserve(machine.open(), data)))
  `
  const names = ['First', 'Second']
  const pending = names.map(name => new Promise((resolve, reject) => {
    const file = join(h.root, name)
    const fd = fs.openSync(file, 'wx')
    try {
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', code, h.dir, barrier, name, JSON.stringify(claim),
      ], { stdio: ['ignore', fd, 'inherit'] })
      child.once('error', reject)
      child.once('close', status => resolve({ status, file }))
    } finally { fs.closeSync(fd) }
  }))
  try {
    for (let i = 0; i < 500 && !names.every(name => fs.existsSync(barrier + name)); i++) {
      await delay(10)
    }
  } finally { fs.writeFileSync(barrier, '') }
  const results = (await Promise.all(pending)).map(({ status, file }) => {
    assert.equal(status, 0)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  })
  const winner = results.findIndex(result => result.created)
  assert.notEqual(winner, -1)
  assert.equal(results.filter(result => result.created).length, 1)
  assert.equal(results[1 - winner].conflict.label, names[winner])
  assert.equal(h.read().record.label, names[winner])
  assert.deepEqual(fs.readdirSync(h.dir), [`claude-${exact}.json`, 'key'])
})

test('A5/A14 exclusive fallback handles conflicts and preserves concurrent replacements', t => {
  let faultAt = ''
  let failed = false
  const h = fixture(t, { override: {
    linkSync(from, to) {
      if (from.endsWith('.tmp')) throw fault('EPERM')
      return fs.linkSync(from, to)
    },
    openSync(path, flags, mode) {
      const fd = fs.openSync(path, flags, mode)
      if (path === h.final && flags & fs.constants.O_WRONLY) failed = true
      return fd
    },
    writeFileSync(fd, body) {
      if (failed && faultAt) {
        failed = false
        throw fault('EIO')
      }
      fs.writeFileSync(fd, body)
    },
    renameSync(from, to) {
      if (faultAt === 'replacement' && from === h.final && to.endsWith('.del')) {
        const replacement = join(h.dir, '.replacement')
        fs.writeFileSync(replacement, JSON.stringify({
          version: 1, ...claim, label: 'Replacement', at,
        }))
        fs.renameSync(replacement, h.final)
      }
      fs.renameSync(from, to)
    },
  } })
  faultAt = 'write'
  assert.deepEqual(h.reserve(), { refused: 'failed' })
  assert.equal(h.read().state, 'absent')
  faultAt = 'replacement'
  assert.deepEqual(h.reserve(), { refused: 'failed' })
  assert.equal(h.read().record.label, 'Replacement')
  faultAt = ''
  assert.equal(h.reserve().mine.label, 'Replacement')
  assert.equal(h.reserve({ ...claim, instance: 'B' }).conflict.label, 'Replacement')
  fs.unlinkSync(h.final)
  assert.equal(h.reserve().created, true)
  assert.deepEqual(fs.readdirSync(h.dir), [`claude-${exact}.json`, 'key'])
})

test('A7 relabel replaces the inode with 0640 and preserves every other field', t => {
  let failWrite = false, moved = false
  const h = fixture(t, { override: {
    writeFileSync(fd, body) {
      if (failWrite) throw fault('EIO')
      fs.writeFileSync(fd, body)
    },
    lstatSync(path) {
      const stat = fs.lstatSync(path)
      if (moved && path === h.final) stat.ino++
      return stat
    },
  } })
  h.reserve()
  const original = h.read().record
  const expect = h.expect()
  const relabel = () => h.record.relabel(h.record.open(), { ...claim, label: 'New', expect })
  failWrite = true
  assert.deepEqual(relabel(), { refused: 'failed' })
  failWrite = false
  moved = true
  assert.deepEqual(relabel(), { refused: 'changed' })
  assert.deepEqual(h.read().record, original)
  moved = false
  assert.equal(relabel().ok, true)
  assert.deepEqual(h.read().record, { ...original, label: 'New' })
  assert.equal(h.expect().mode & 0o777, 0o640)
  assert.notEqual(h.expect().ino, expect.ino)
  assert.deepEqual(fs.readdirSync(h.dir), [`claude-${exact}.json`, 'key'])
})

test('A8/A9 own-file and instance checks precede any removal or replacement', t => {
  let foreign = false
  const h = fixture(t, { override: {
    fstatSync(fd) {
      const st = fs.fstatSync(fd)
      if (foreign && st.size > 32) st.uid++
      return st
    },
  } })
  h.reserve()
  const snapshot = fs.readFileSync(h.final)
  const expect = h.expect()
  const share = (changes = {}) => h.record.makeShared(h.record.open(), {
    ...claim, expect, ...changes,
  })
  assert.equal(h.reserve({ ...claim, instance: 'B' }).conflict.label, claim.label)
  foreign = true
  assert.deepEqual(h.reserve(), { refused: 'not-own-file' })
  assert.deepEqual(share(), { refused: 'not-own-file' })
  foreign = false
  assert.deepEqual(share({ instance: 'B' }), { refused: 'other-instance' })
  assert.deepEqual(share({ expect: { dev: expect.dev, ino: 0 } }), { refused: 'changed' })
  assert.deepEqual(fs.readFileSync(h.final), snapshot)
  assert.deepEqual(share(), { ok: true })
  assert.equal(h.read().state, 'absent')
})

test('A10 strict v1 exact reads fail closed while a scan skips invalid records', t => {
  const h = fixture(t)
  const invalid = () => {
    assert.equal(h.read().state, 'unreadable')
    assert.deepEqual(h.scan(), { state: 'ok', matches: [] })
    fs.unlinkSync(h.final)
  }
  for (const change of [{ version: 2 }, { extra: true }, { exact: loose }, { class: 'personal' }]) {
    h.write(change)
    invalid()
  }
  for (const bytes of ['{', Buffer.alloc(70 * 1024), Buffer.from([0xc0, 0xaf])]) {
    fs.writeFileSync(h.final, bytes)
    invalid()
  }
  fs.symlinkSync(h.key, h.final)
  invalid()
  execFileSync('mkfifo', [h.final], { stdio: 'inherit' })
  invalid()
  fs.writeFileSync(join(h.dir, `.claude-${exact}.json`), '')
  assert.deepEqual(h.scan(), { state: 'ok', matches: [] })
  const instance = '\u0001'.repeat(4096)
  assert.equal(h.reserve({ ...claim, instance }).created, true)
  assert.equal(h.read().record.instance, instance)
})

test('A11 retries a young partial file until its publication is complete', t => {
  let count = 0
  const h = fixture(t, { wait: ms => {
    assert.equal(ms, 50)
    count++
    h.write()
  } })
  fs.writeFileSync(h.final, '{')
  fs.utimesSync(h.final, new Date(at), new Date(at))
  assert.equal(h.read().state, 'ok')
  assert.equal(count, 1)
})

test('A12 stored records contain only parsed fields and reject raw identity as a digest', t => {
  const h = fixture(t)
  for (const sentinel of ['private@example.test', 'private-org', 'private-plan', 'private-token']) {
    assert.deepEqual(h.reserve({ ...claim, exact: sentinel }), { refused: 'invalid' })
  }
  assert.equal(h.reserve({ ...claim, email: 'private@example.test', token: 'private-token',
    org: 'private-org', plan: 'private-plan' }).created, true)
  assert.doesNotMatch(fs.readFileSync(h.final, 'utf8'), /private-|email|token|plan|org/)
})

test('A13 moving aside a racing replacement restores it at the exact path', t => {
  let replacementInode
  const h = fixture(t, { override: {
    renameSync(from, to) {
      if (from === h.final && to.endsWith('.del')) {
        const replacement = join(h.dir, '.replacement')
        fs.writeFileSync(replacement, JSON.stringify({ version: 1, ...claim, label: 'B', at }))
        fs.renameSync(replacement, from)
        replacementInode = fs.statSync(from).ino
      }
      fs.renameSync(from, to)
    },
  } })
  h.reserve()
  const result = h.record.makeShared(h.record.open(), { ...claim, expect: h.expect() })
  assert.deepEqual(result, { refused: 'changed' })
  assert.equal(h.read().record.label, 'B')
  assert.equal(h.expect().ino, replacementInode)
  assert.deepEqual(fs.readdirSync(h.dir), [`claude-${exact}.json`, 'key'])
})

test('a failed unlink restores the machine claim and release can be retried', t => {
  let fail = false
  const h = fixture(t, { override: {
    unlinkSync(path) {
      if (fail && path.endsWith('.del')) {
        fail = false
        throw fault('EIO')
      }
      fs.unlinkSync(path)
    },
  } })
  h.reserve()
  const readBefore = h.read()
  const release = () => h.record.makeShared(h.record.open(), { ...claim, expect: readBefore })
  fail = true
  assert.deepEqual(release(), { refused: 'failed' })
  assert.equal(h.read().ino, readBefore.ino)
  assert.deepEqual(h.read().record, readBefore.record)
  assert.deepEqual(release(), { ok: true })
  assert.equal(h.read().state, 'absent')
})
