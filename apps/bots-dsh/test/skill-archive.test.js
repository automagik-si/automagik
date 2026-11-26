import assert from 'node:assert/strict'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { readSkillArchive } from '../src/host/skill-archive.js'
import { LIMITS } from '../src/host/skill-library-rules.js'
import { rootMember, tar, zip } from './fixtures/skill-archives.js'

const readers = [['zip', zip], ['tar.gz', tar]]
const wrapped = path => ({ ...path, path: 'notes/' + path.path })

test('#2078 archive admission canonicalizes both formats and charges skipped members', async () => {
  const kept = { path: 'references/example.md', data: 'Fixture text.' }
  const ignored = { path: '__MACOSX/metadata', data: 'Fixture metadata.' }
  for (const [kind, make] of readers) {
    const plain = await readSkillArchive(make([rootMember, kept, ignored]), { kind })
    const inside = await readSkillArchive(make([rootMember, kept, ignored].map(wrapped)), { kind })
    assert.deepEqual(inside, plain)
    assert.equal(plain.skipped, 1)
    assert.deepEqual(plain.entries.map(({ path }) => path), ['SKILL.md', kept.path])
    await assert.rejects(readSkillArchive(make([rootMember, { ...ignored, data: Buffer.from([0]) }]), { kind }),
      { code: 'bot/invalid', message: /UTF-8 text: __MACOSX\/metadata/ })
    await assert.rejects(readSkillArchive(make([rootMember, { path: 'references/../outside.md' }]), { kind }),
      { code: 'bot/invalid', message: /Unsafe skill path.*\.\.\/outside\.md/ })
    await assert.rejects(readSkillArchive(make([rootMember, { path: 'references/alias', type: '2', attr: 0xa0000000 }]), { kind }),
      { code: 'bot/invalid', message: /Only regular skill files.*references\/alias/ })
    await assert.rejects(readSkillArchive(make([rootMember, { path: 'references/notes.md', data: '!<arch>\n' }]), { kind }),
      { code: 'bot/invalid', message: /Nested archives.*references\/notes\.md/ })
    await assert.rejects(readSkillArchive(make([rootMember, { path: 'Refs/a' }, { path: 'refs/A' }]), { kind }),
      { code: 'bot/invalid', message: /duplicate or conflicting path.*refs\/A/ })
  }
})

test('#2078 archive size and count are enforced before allocating the member payloads', async t => {
  const inflate = t.mock.method(zlib, 'inflateRawSync')
  const compressed = { ...rootMember, method: 8 }
  const excessFiles = Array.from({ length: 256 }, (_, i) => ({ path: 'references/' + i, data: '', method: 8 }))
  await assert.rejects(readSkillArchive(zip([compressed, ...excessFiles]), { kind: 'zip' }), /256 files/)
  const excessBytes = Array.from({ length: 5 }, (_, i) => ({ path: 'references/' + i, declared: 1_048_576, method: 8 }))
  await assert.rejects(readSkillArchive(zip([compressed, ...excessBytes]), { kind: 'zip' }), /over 5 MiB/)
  assert.equal(inflate.mock.callCount(), 0)
  const alloc = t.mock.method(Buffer, 'allocUnsafe')
  await assert.rejects(readSkillArchive(tar([rootMember, { path: 'references/big.md', declared: 1_048_577 }]),
    { kind: 'tar.gz' }), /size limit: references\/big\.md/)
  assert.equal(alloc.mock.calls.some(call => call.arguments[0] >= 1_048_577), false)
  await assert.rejects(readSkillArchive(tar([rootMember, ...excessFiles]), { kind: 'tar.gz' }), /256 files/)
})

for (const [kind, make] of readers) {
  test(`#2078 correction ${kind} applies depth and UTF-8 byte limits to the canonical path`, async () => {
    const leaf = `${'é'.repeat(45)}.md`
    const suffix = `/b/c/d/e/f/${leaf}`
    const prefix = 'references/'
    const fill = LIMITS.pathBytes - Buffer.byteLength(prefix + suffix)
    const boundary = prefix + 'a'.repeat(fill) + suffix
    const withPath = path => {
      if (kind === 'zip') return { path, data: 'Boundary text.' }
      const split = path.lastIndexOf('/')
      return { prefix: path.slice(0, split), path: path.slice(split + 1), data: 'Boundary text.' }
    }
    const read = (path, folder = '') => readSkillArchive(make([
      { ...rootMember, path: folder + rootMember.path }, withPath(folder + path),
    ]), { kind })
    assert.equal(boundary.split('/').length, LIMITS.depth)
    assert.equal(Buffer.byteLength(boundary), LIMITS.pathBytes)
    const plain = await read(boundary)
    assert.deepEqual(plain.entries.map(({ path }) => path), ['SKILL.md', boundary])
    assert.deepEqual(await read(boundary, 'notes/'), plain)
    for (const folder of ['', 'notes/']) {
      await assert.rejects(read(boundary + 'x', folder), /Unsafe skill path/)
      await assert.rejects(read('references/a/b/c/d/e/f/g/note.md', folder), /Unsafe skill path/)
    }
  })
}

test('#2078 correction tar refuses an oversized canonical root before reading its member data', async t => {
  const marker = 'Oversized root fixture.\n'
  const data = (marker + ' '.repeat(LIMITS.skillMd)).slice(0, LIMITS.skillMd + 1)
  const plain = tar([{ path: 'SKILL.md', data }])
  const wrappedRoot = tar([{ path: 'notes/SKILL.md', data }])
  const alloc = t.mock.method(Buffer, 'allocUnsafe')
  const copy = t.mock.method(Buffer.prototype, 'copy')
  for (const [bytes, message] of [[plain, /size limit: SKILL\.md/], [wrappedRoot, /size limit: notes\/SKILL\.md/]]) {
    await assert.rejects(readSkillArchive(bytes, { kind: 'tar.gz' }), message)
    assert.ok(!alloc.mock.calls.some(call => call.arguments[0] >= data.length))
    assert.ok(!copy.mock.calls.some(call => call.this.subarray(call.arguments[2], call.arguments[3]).includes(marker)))
  }
})

test('#2078 correction tar keeps a larger supplemental SKILL.md before the direct root', async () => {
  const data = ' '.repeat(LIMITS.skillMd + 1)
  const { entries } = await readSkillArchive(tar([{ path: 'references/SKILL.md', data }, rootMember]), { kind: 'tar.gz' })
  assert.equal(entries[0].path, 'SKILL.md')
  assert.equal(entries[1].path, 'references/SKILL.md')
  assert.equal(entries[1].bytes.toString(), data)
})
