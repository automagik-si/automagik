import assert from 'node:assert/strict'
import * as filesystem from 'node:fs'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createKeySource } from '../src/keys.js'
import { signingKey, wire } from './runtime.mjs'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'caller keys-'))
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'caller-keys.json')
  const first = signingKey().published
  const next = signingKey().published
  const data = (keys = [first]) => JSON.stringify({ version: 1, instance: wire.payload.aud, keys })
  writeFileSync(file, data())
  const escaped = dir.replaceAll(' ', '\\040')
  const mountinfo = () => `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / ${escaped} ro - tmpfs tmpfs rw`
  const fs = { ...filesystem, readFileSync: (path, encoding) =>
    path.startsWith('/proc/self/fdinfo/') ? 'mnt_id:\t2\n' : readFileSync(path, encoding) }
  return { dir, file, first, next, data, fs, mountinfo }
}

test('requires a real path on a read-only mount and the provisioned instance', t => {
  const f = setup(t)
  chmodSync(f.file, 0o444)
  chmodSync(f.dir, 0o555)
  assert.equal(createKeySource({ file: f.file }).get(f.first.kid), undefined)
  assert.ok(createKeySource(f).get(f.first.kid))
  assert.equal(createKeySource({ ...f, expectedInstance: 'wrong' }).get(f.first.kid), undefined)
  assert.equal(createKeySource({ ...f, fs: { ...f.fs, readFileSync: () => 'mnt_id:\t3\n' }, mountinfo: () =>
    f.mountinfo() + `\n3 2 0:3 / ${f.file.replaceAll(' ', '\\040')} rw - tmpfs tmpfs ro`,
  }).get(f.first.kid), undefined)
  chmodSync(f.dir, 0o700)
  const parent = join(f.dir, 'real')
  mkdirSync(parent)
  const link = join(f.dir, 'linked')
  symlinkSync(parent, link)
  writeFileSync(join(parent, 'keys.json'), f.data())
  assert.equal(createKeySource({ ...f, file: join(link, 'keys.json') }).get(f.first.kid), undefined)
  const leaf = join(f.dir, 'symlink.json')
  symlinkSync(f.file, leaf)
  assert.equal(createKeySource({ ...f, file: leaf }).get(f.first.kid), undefined)
})

test('refreshes visible removals immediately and invisible removals by sixty seconds', t => {
  const f = setup(t)
  let now = 0
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const source = createKeySource({ ...f, monotonicNow: () => now })
  assert.ok(source.get(f.first.kid))
  writeFileSync(f.file, f.data([f.first, f.next]))
  assert.ok(source.get(f.first.kid))
  assert.ok(source.get(f.next.kid))
  const stat = lstatSync(f.file)
  const invisible = createKeySource({ ...f, monotonicNow: () => now, fs: { ...f.fs, fstatSync: () => stat } })
  assert.ok(invisible.get(f.first.kid))
  writeFileSync(f.file, f.data([f.next]))
  assert.equal(source.get(f.first.kid), undefined)
  assert.ok(invisible.get(f.first.kid))
  wall -= 120_000
  now = 59_999
  assert.ok(invisible.get(f.first.kid))
  now = 60_000
  assert.equal(invisible.get(f.first.kid), undefined)
  assert.ok(invisible.get(f.next.kid))
})

test('unknown kid refreshes once per second and a failed refresh empties the cache', t => {
  const f = setup(t)
  let now = 0, reads = 0
  let wall = Date.now()
  t.mock.method(Date, 'now', () => wall)
  const stat = lstatSync(f.file)
  const source = createKeySource({ ...f, monotonicNow: () => now, fs: {
    ...f.fs, fstatSync: () => stat,
    readSync: (...args) => {
      const count = f.fs.readSync(...args)
      if (count) reads++
      return count
    },
  } })
  assert.ok(source.get(f.first.kid))
  for (let i = 0; i < 10; i++) assert.equal(source.get(f.next.kid), undefined)
  assert.equal(reads, 1)
  now = 1000
  writeFileSync(f.file, '{bad')
  assert.equal(source.get(f.next.kid), undefined)
  assert.equal(source.get(f.first.kid), undefined)
  assert.equal(reads, 2)
  writeFileSync(f.file, f.data())
  wall -= 120_000
  now = 1999
  assert.equal(source.get(f.first.kid), undefined)
  now = 2000
  assert.ok(source.get(f.first.kid))
})

test('mount validation and bounded reads stay on the opened file', t => {
  const f = setup(t)
  const replaced = join(f.dir, 'replacement')
  writeFileSync(replaced, f.data([f.next]))
  let opens = 0
  const source = createKeySource({ ...f, fs: { ...f.fs, openSync: (...args) => {
    opens++
    return f.fs.openSync(...args)
  } }, mountinfo: () => {
    renameSync(replaced, f.file)
    return f.mountinfo()
  } })
  assert.ok(source.get(f.first.kid))
  assert.equal(opens, 1)
  assert.ok(createKeySource(f).get(f.next.kid))

  assert.equal(createKeySource({ ...f, file: f.dir }).get(f.next.kid), undefined)
  const limit = 16 * 1024
  const bytes = f.data([f.next]).padEnd(limit + 2)
  let read = 0
  const fs = { ...f.fs, readSync: (...args) => {
    const count = f.fs.readSync(...args)
    read += count
    return count
  } }
  writeFileSync(f.file, bytes)
  assert.equal(createKeySource({ ...f, fs }).get(f.next.kid), undefined)
  assert.equal(read, 0)
  writeFileSync(f.file, bytes.slice(0, limit))
  assert.ok(createKeySource({ ...f, fs }).get(f.next.kid))
  read = 0
  const growing = createKeySource({ ...f, fs, mountinfo: () => {
    writeFileSync(f.file, bytes)
    return f.mountinfo()
  } })
  assert.equal(growing.get(f.next.kid), undefined)
  assert.equal(read, limit + 1)
})
