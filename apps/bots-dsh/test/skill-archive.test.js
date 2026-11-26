import assert from 'node:assert/strict'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { readSkillArchive } from '../src/host/skill-archive.js'
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
