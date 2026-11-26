import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readSkillFolder } from '../src/host/skill-folder.js'
import { rootMd } from './fixtures/skill-archives.js'

function folder(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'skill-folder-control-'))
  t.after(() => fs.rmSync(home, { recursive: true }))
  const root = join(home, 'notes')
  fs.mkdirSync(root)
  fs.writeFileSync(join(root, 'SKILL.md'), rootMd)
  return { root, home }
}

test('#2078 folder reads a verified tree and refuses symlink ancestors, leaves and hard links', { skip: process.platform !== 'linux' }, t => {
  const { root, home } = folder(t)
  const refs = join(root, 'references')
  fs.mkdirSync(refs)
  fs.writeFileSync(join(refs, 'empty.md'), '')
  const outside = join(home, 'outside.md')
  fs.writeFileSync(outside, 'Harmless outside fixture marker.')
  assert.deepEqual(readSkillFolder(root).entries.map(({ path, bytes }) => [path, bytes.length]), [
    ['SKILL.md', Buffer.byteLength(rootMd)], ['references/empty.md', 0],
  ])
  const link = join(home, 'alias')
  fs.symlinkSync(home, link, 'dir')
  fs.symlinkSync(outside, join(refs, 'alias.md'))
  const reads = t.mock.method(fs, 'readSync')
  assert.throws(() => readSkillFolder(join(link, 'notes')), /folder is unavailable/)
  assert.throws(() => readSkillFolder(root), /single-link.*references\/alias\.md/)
  fs.unlinkSync(join(refs, 'alias.md'))
  fs.linkSync(outside, join(refs, 'hard.md'))
  assert.throws(() => readSkillFolder(root), /single-link.*references\/hard\.md/)
  assert.equal(reads.mock.callCount(), 0)
})

test('#2078 folder checks the opened identity before any file reads during a substitution', { skip: process.platform !== 'linux' }, t => {
  const { root, home } = folder(t)
  const skill = join(root, 'SKILL.md')
  const original = fs.openSync
  const originalPath = join(home, 'original.md')
  let swapped = false
  t.mock.method(fs, 'openSync', function (path, flags, ...args) {
    if (!swapped && path.endsWith('/SKILL.md')) {
      swapped = true
      fs.renameSync(skill, originalPath)
      const fd = original(skill, 'w')
      try { fs.writeSync(fd, 'Harmless replacement fixture marker.') } finally { fs.closeSync(fd) }
    }
    return original(path, flags, ...args)
  })
  const reads = t.mock.method(fs, 'readSync')
  assert.throws(() => readSkillFolder(root), /changed while it was read/)
  assert.equal(swapped, true)
  assert.equal(reads.mock.callCount(), 0)
})

test('#2078 folder stops incremental enumeration at the raw ceiling and reads no file before limits pass', { skip: process.platform !== 'linux' }, t => {
  const { home } = folder(t)
  const bytes = join(home, 'bytes')
  const raw = join(home, 'raw')
  const count = join(home, 'count')
  for (const path of [bytes, raw, count]) {
    fs.mkdirSync(path)
    fs.writeFileSync(join(path, 'SKILL.md'), rootMd)
  }
  for (let i = 0; i < 5; i++) {
    const path = join(bytes, 'large-' + i)
    fs.writeFileSync(path, '')
    fs.truncateSync(path, 1_048_576)
  }
  for (let i = 0; i < 256; i++) fs.writeFileSync(join(count, 'file-' + i), '')
  for (let i = 0; i < 1100; i++) fs.writeFileSync(join(raw, '._file-' + i), '')
  const opened = t.mock.method(fs, 'openSync')
  const openDir = fs.opendirSync
  let enumerated = 0
  t.mock.method(fs, 'opendirSync', (path, options) => {
    assert.equal(options.bufferSize, 1)
    const handle = openDir(path, options)
    const read = handle.readSync.bind(handle)
    handle.readSync = () => { enumerated++; return read() }
    return handle
  })
  assert.throws(() => readSkillFolder(bytes), /over 5 MiB/)
  assert.throws(() => readSkillFolder(count), /256 files/)
  enumerated = 0
  assert.throws(() => readSkillFolder(raw), /1,024 entries/)
  assert.equal(enumerated, 1025)
  assert.ok(opened.mock.calls.every(call => call.arguments[1] & fs.constants.O_DIRECTORY))
})
