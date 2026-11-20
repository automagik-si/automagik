import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { BOT_ID, createPrincipalRecord } from '../src/record.js'

const instance = 'record-fixture'
const bot = 'b-aaaaaaaaaa'
const entry = `bot:${bot}`
const data = sessions => ({ version: 2, instance, sessions })

function home(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'principal-record-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function setup(t, dshHome = home(t)) {
  const warnings = []
  const record = createPrincipalRecord({ dshHome, instance, warn: message => warnings.push(message) })
  t.after(record.dispose)
  const { file } = record
  return {
    ...record, warnings, folder: dirname(file),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    seed: (contents, mode = 0o600) => fs.writeFileSync(file, contents, { mode }),
  }
}

test('the first Bot creates a private v2 record and confirming it keeps the inode', t => {
  const dshHome = home(t)
  const sync = fs.fsyncSync
  const folder = join(dshHome, 'multiuser-dsh')
  const fsync = t.mock.fn(sync)
  const syncNewFolder = t.mock.fn(sync)
  let initializing = true
  t.mock.method(fs, 'fsyncSync', fd => {
    if (initializing && fs.fstatSync(fd).ino === fs.statSync(folder).ino) return syncNewFolder(fd)
    return fsync(fd)
  })
  const f = setup(t, dshHome)
  initializing = false
  assert.equal(syncNewFolder.mock.callCount(), 1, 'the new folder itself is synced at initialization')
  assert.equal(fsync.mock.callCount(), 1, 'the new folder is synced into DSH home')
  assert.equal(f.file, join(dshHome, 'multiuser-dsh', 'principals.json'))
  assert.equal(fs.existsSync(f.file), false)
  f.recordBot('s', bot)
  const stat = fs.statSync(f.file)
  assert.equal(fsync.mock.callCount(), 3, 'syncs the new file and its directory')
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(fs.statSync(f.folder).mode & 0o777, 0o700)
  assert.deepEqual(f.read(), data({ s: entry }))
  f.recordBot('s', bot)
  assert.equal(fs.statSync(f.file).ino, stat.ino)
  assert.equal(fsync.mock.callCount(), 3)
  assert.deepEqual(f.warnings, [])
})

test('publishes a readable 0600 record under an owner-read-masking umask', t => {
  const dshHome = home(t)
  fs.mkdirSync(join(dshHome, 'multiuser-dsh'), { mode: 0o700 })
  const f = setup(t, dshHome)
  const previous = process.umask(0o477)
  try {
    f.recordBot('s', bot)
    const info = fs.statSync(f.file)
    assert.equal(info.mode & 0o777, 0o600)
    f.recordBot('s', bot)
    assert.equal(fs.statSync(f.file).ino, info.ino)
    assert.deepEqual(f.read(), data({ s: entry }))
  } finally {
    process.umask(previous)
  }
})

test('replacing a Bot session row warns once and preserves other sessions', t => {
  const f = setup(t)
  f.seed(JSON.stringify(data({ s: 'owner', other: 'member:ana' })))
  f.recordBot('s', bot)
  assert.deepEqual(f.read(), data({ s: entry, other: 'member:ana' }))
  fs.writeFileSync(f.file, JSON.stringify(data({ s: 'member:ana', other: 'member:ana' })))
  f.recordBot('s', bot)
  assert.deepEqual(f.read(), data({ s: entry, other: 'member:ana' }))
  assert.deepEqual(f.warnings, ['replacing owner for Bot session s'])

  f.recordBot('__proto__', bot)
  assert.deepEqual(f.read(), data({ s: entry, other: 'member:ana', ['__proto__']: entry }))
})

for (const [label, bytes, reason] of [
  ['v1', JSON.stringify({ version: 1, sessions: { s: 'owner' } }), /version 2/],
  ['another instance', JSON.stringify({ ...data({ s: 'owner' }), instance: 'other' }), /different instance/],
  ['array sessions', JSON.stringify(data(['owner'])), /sessions must be an object/],
  ['numeric row', JSON.stringify(data({ s: 'owner', other: 42 })), /string values/],
  ['malformed JSON', '{"version":', /invalid JSON/],
  ['a leading BOM', '\uFEFF' + JSON.stringify(data({ s: 'owner' })), /invalid JSON/],
]) {
  test(`refuses ${label} and preserves the existing file`, t => {
    const f = setup(t)
    f.seed(bytes)
    const { ino } = fs.statSync(f.file)
    assert.throws(() => f.recordBot('s', bot), reason)
    assert.throws(() => f.recordBot('s', bot), reason)
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes)
    assert.equal(fs.statSync(f.file).ino, ino)
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0], reason)
    assert.deepEqual(fs.readdirSync(f.folder), ['principals.json'])
  })
}

test('refuses invalid UTF-8 in a session key and preserves an unrelated owner row byte for byte', t => {
  const f = setup(t)
  const bytes = Buffer.from(JSON.stringify(data({ 'broken!': 'member:ana', other: 'owner' })))
  bytes[bytes.indexOf('!')] = 0xff
  f.seed(bytes)
  const { ino } = fs.statSync(f.file)
  assert.throws(() => f.recordBot('s', bot), /invalid UTF-8/)
  assert.deepEqual(fs.readFileSync(f.file), bytes)
  assert.equal(fs.statSync(f.file).ino, ino)
  assert.deepEqual(fs.readdirSync(f.folder), ['principals.json'])
})

for (const [label, link, reason] of [
  ['symlink', fs.symlinkSync, /ELOOP/],
  ['hard link', fs.linkSync, /one link/],
]) {
  test(`refuses a principal record that is a ${label}`, t => {
    const f = setup(t)
    const other = join(dirname(f.folder), 'original')
    const bytes = JSON.stringify(data({ s: 'owner' }))
    fs.writeFileSync(other, bytes, { mode: 0o600 })
    link(other, f.file)
    const { ino } = fs.lstatSync(f.file)
    assert.throws(() => f.recordBot('s', bot), reason)
    assert.equal(fs.readFileSync(other, 'utf8'), bytes)
    assert.equal(fs.lstatSync(f.file).ino, ino)
    assert.deepEqual(fs.readdirSync(f.folder), ['principals.json'])
  })
}

test('refuses a FIFO without reading from it', async t => {
  const f = setup(t)
  await promisify(execFile)('mkfifo', ['-m', '600', f.file])
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (path, flags, ...args) => {
    if (path === f.file) assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK)
    return open(path, flags, ...args)
  })
  assert.throws(() => f.recordBot('s', bot), /regular file/)
  assert.ok(fs.lstatSync(f.file).isFIFO())
})

test('refuses an open or foreign-owned record without changing its bytes', t => {
  const f = setup(t)
  const bytes = JSON.stringify(data({ s: 'owner' }))
  f.seed(bytes)
  fs.chmodSync(f.file, 0o644)
  assert.throws(() => f.recordBot('s', bot), /private regular file/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes)
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644)
  fs.chmodSync(f.file, 0o600)
  const fstat = fs.fstatSync
  let leafInspected = false
  t.mock.method(fs, 'fstatSync', (...args) => {
    const info = fstat(...args)
    if (info.isFile()) {
      leafInspected = true
      info.uid = process.getuid() + 1
    }
    return info
  })
  assert.throws(() => f.recordBot('s', bot), /private regular file owned by DSH/)
  assert.equal(leafInspected, true)
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes)
})

test('refuses a linked, group-writable or replaced record directory', t => {
  const dshHome = home(t)
  const folder = join(dshHome, 'multiuser-dsh')
  const other = join(dshHome, 'other')
  fs.mkdirSync(other, { mode: 0o700 })
  fs.symlinkSync(other, folder)
  assert.throws(() => setup(t, dshHome), /private directory/)
  assert.deepEqual(fs.readdirSync(other), [])
  fs.unlinkSync(folder)
  fs.mkdirSync(folder, { mode: 0o700 })
  fs.chmodSync(folder, 0o720)
  assert.throws(() => setup(t, dshHome), /private directory/)
  assert.deepEqual(fs.readdirSync(folder), [])
  fs.chmodSync(folder, 0o700)
  const f = setup(t, dshHome)
  fs.renameSync(folder, join(dshHome, 'previous'))
  fs.mkdirSync(folder, { mode: 0o700 })
  assert.throws(() => f.recordBot('s', bot), /must remain a private directory/)
  assert.equal(fs.existsSync(f.file), false)
})

test('requires the existing absolute DSH home and well-formed session and Bot ids', t => {
  const dshHome = home(t)
  assert.throws(() => setup(t, 'relative'), /must be absolute/)
  assert.throws(() => setup(t, join(dshHome, 'missing')), { code: 'ENOENT' })
  const f = setup(t, dshHome)
  for (const id of ['other', null, [bot]]) assert.throws(() => f.recordBot('s', id), /invalid Bot id/)
  assert.throws(() => f.recordBot('', bot), /non-empty session id/)
  assert.equal(fs.existsSync(f.file), false)
})

test('exclusive creation leaves a colliding temp file intact', t => {
  const f = setup(t)
  const open = fs.openSync
  let collided
  t.mock.method(fs, 'openSync', (path, flags, ...args) => {
    if (flags === 'wx') {
      collided = path
      fs.writeFileSync(path, 'already here', { mode: 0o600 })
    }
    return open(path, flags, ...args)
  })
  assert.throws(() => f.recordBot('s', bot), { code: 'EEXIST' })
  assert.match(collided, /principals\.json\.\d+\.[a-f0-9]+\.tmp$/)
  assert.equal(fs.readFileSync(collided, 'utf8'), 'already here')
  assert.equal(fs.existsSync(f.file), false)
})

test('handles short writes and removes its temp file if rename fails', t => {
  const f = setup(t)
  f.seed(JSON.stringify(data({ another: 'member:ana' })))
  const write = fs.writeSync
  const short = t.mock.method(fs, 'writeSync', (fd, bytes, offset, length) =>
    write(fd, bytes, offset, Math.min(length, 5)))
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('rename refused') })
  assert.throws(() => f.recordBot('s', bot), /rename refused/)
  assert.ok(short.mock.callCount() > 1)
  assert.deepEqual(f.read(), data({ another: 'member:ana' }))
  assert.deepEqual(fs.readdirSync(f.folder), ['principals.json'])
  rename.mock.restore()
  f.recordBot('s', bot)
  assert.deepEqual(f.read(), data({ another: 'member:ana', s: entry }))
})

test('retries a failed post-rename directory sync without rewriting the record', t => {
  const f = setup(t)
  const fsync = fs.fsyncSync
  let folderSyncs = 0
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory() && ++folderSyncs === 1) throw new Error('directory fsync failed')
    return fsync(fd)
  })
  assert.throws(() => f.recordBot('s', bot), /directory fsync failed/)
  assert.deepEqual(f.read(), data({ s: entry }))
  assert.deepEqual(fs.readdirSync(f.folder), ['principals.json'])
  const { ino } = fs.statSync(f.file)
  f.recordBot('s', bot)
  assert.equal(folderSyncs, 2)
  assert.equal(fs.statSync(f.file).ino, ino)
  f.recordBot('s', bot)
  assert.equal(folderSyncs, 2)
})

test('a new writer retries the parent sync after the previous writer created the folder', t => {
  const dshHome = home(t)
  const parent = fs.statSync(dshHome).ino
  const sync = fs.fsyncSync
  const attempts = []
  let failParent = true
  t.mock.method(fs, 'fsyncSync', fd => {
    const { ino } = fs.fstatSync(fd)
    attempts.push(ino)
    if (ino === parent && failParent) throw new Error('parent fsync failed')
    return sync(fd)
  })
  const close = t.mock.method(fs, 'closeSync')
  assert.throws(() => setup(t, dshHome), /parent fsync failed/)
  const folder = join(dshHome, 'multiuser-dsh')
  const { ino } = fs.statSync(folder)
  assert.deepEqual(attempts, [ino, parent])
  assert.equal(close.mock.callCount(), 2, 'both the parent and the record folder descriptors close')
  assert.deepEqual(fs.readdirSync(folder), [])

  failParent = false
  const f = setup(t, dshHome)
  assert.deepEqual(attempts, [ino, parent, ino, parent])
  f.recordBot('s', bot)
  assert.deepEqual(f.read(), data({ s: entry }))
})

test('a new writer syncs the folder before confirming a row left by a failed post-rename sync', t => {
  const dshHome = home(t)
  const f = setup(t, dshHome)
  const folder = fs.statSync(f.folder).ino
  const parent = fs.statSync(dshHome).ino
  const sync = fs.fsyncSync
  const dirs = []
  let failFolder = true
  t.mock.method(fs, 'fsyncSync', fd => {
    const info = fs.fstatSync(fd)
    if (info.isDirectory()) dirs.push(info.ino)
    if (info.ino === folder && failFolder) throw new Error('directory fsync failed')
    return sync(fd)
  })
  assert.throws(() => f.recordBot('s', bot), /directory fsync failed/)
  assert.deepEqual(f.read(), data({ s: entry }))
  const { ino } = fs.statSync(f.file)
  assert.deepEqual(dirs, [folder])
  f.dispose()
  assert.throws(() => setup(t, dshHome), /directory fsync failed/)

  failFolder = false
  const next = setup(t, dshHome)
  assert.deepEqual(dirs, [folder, folder, folder, parent])
  next.recordBot('s', bot)
  assert.equal(fs.statSync(next.file).ino, ino)
  assert.deepEqual(dirs, [folder, folder, folder, parent])
})

test('the writer refuses a matching row opened through a folder replaced during the read', t => {
  const f = setup(t)
  const replacement = join(dirname(f.folder), 'replacement')
  fs.mkdirSync(replacement, { mode: 0o700 })
  fs.writeFileSync(join(replacement, 'principals.json'), JSON.stringify(data({ s: entry })), { mode: 0o600 })
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (path, ...args) => {
    if (path === f.file) {
      fs.renameSync(f.folder, join(dirname(f.folder), 'original'))
      fs.renameSync(replacement, f.folder)
    }
    return open(path, ...args)
  })
  assert.throws(() => f.recordBot('s', bot), /must remain a private directory/)
})

test('cleanup skips a temp pathname in a replacement record directory', t => {
  const f = setup(t)
  const rename = fs.renameSync
  let temp
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(to, f.file)
    temp = from
    rename(f.folder, join(dirname(f.folder), 'original'))
    fs.mkdirSync(f.folder, { mode: 0o700 })
    fs.writeFileSync(from, 'replacement temp')
    throw new Error('rename failed after folder swap')
  })
  assert.throws(() => f.recordBot('s', bot), /rename failed after folder swap/)
  assert.equal(fs.readFileSync(temp, 'utf8'), 'replacement temp')
  assert.equal(fs.existsSync(f.file), false)
})

test('Bot id pattern is the registry pattern', () => {
  const src = fs.readFileSync(new URL('../../bots-dsh/src/shared/registry.js', import.meta.url), 'utf8')
  assert.equal(src.match(/^export const BOT_ID = (.*)$/m)?.[1], BOT_ID.toString())
})
