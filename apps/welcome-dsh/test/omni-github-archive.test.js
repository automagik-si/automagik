import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { verifyOmniArchive } from '../src/host/omni-github.js'

// The production codeload archive has 4005 entries including its top folder, and
// tree b6f388a9db63dc6c14bf8cdb246a8b122c8449d3. This fixture has two blobs and a link.
// Its expected tree was recorded with git hash-object -t tree --stdin.
const pin = { commit: 'e'.repeat(40), tree: '1f7c59fa95b3cd59828d16754cb3a37cd296e203' }

function entry(name, type, body = '', { mode = 0o644, target = '', prefix = '', size } = {}) {
  const header = Buffer.alloc(512)
  const bytes = Buffer.from(body)
  header.write(name)
  header.write(mode.toString(8).padStart(7, '0'), 100)
  header.write((size ?? bytes.length).toString(8).padStart(11, '0'), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write(target, 157)
  header.write('ustar', 257)
  header.write(prefix, 345)
  const sum = header.reduce((value, byte) => value + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

function pax(key, value) {
  const record = key + '=' + value + '\n'
  let length = Buffer.byteLength(record) + 2
  while (length !== Buffer.byteLength(record) + String(length).length + 1) length++
  return length + ' ' + record
}

const global = (commit = pin.commit) => entry('pax_global_header', 'g', pax('comment', commit))
const dir = entry('omni-fixture/', '5')
const file = (bytes = 'hello\n') => entry('file.txt', '0', bytes, { prefix: 'omni-fixture/bin' })
const run = entry('omni-fixture/bin/run', '0', '#!/bin/sh\n', { mode: 0o755 })
const link = entry('omni-fixture/link', '2', '', { target: 'bin/run' })
const archive = (...parts) => gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
const good = archive(global(), dir, file(), run, link)
const verify = (bytes, limits) => verifyOmniArchive(new Response(bytes).body, pin, AbortSignal.timeout(2500), limits)

test('streams a git archive, verifies its tree and returns exactly the files and modes to extract', async () => {
  const path = entry('pax', 'x', pax('path', 'omni-fixture/bin/file.txt'))
  const target = entry('pax', 'x', pax('linkpath', 'bin/run'))
  const entries = await verify(archive(global(), dir, path, entry('ignored', '0', 'hello\n'),
    run, target, entry('omni-fixture/link', '2', '', { target: '../ignored' })))
  assert.deepEqual(entries.map(item => [item.type, item.path, item.exec, item.target, item.body && Buffer.from(item.body).toString()]), [
    ['0', 'bin/file.txt', false, undefined, 'hello\n'],
    ['0', 'bin/run', true, undefined, '#!/bin/sh\n'],
    ['2', 'link', undefined, 'bin/run', undefined],
  ])
})

test('refuses changed content with a correct comment, or the correct tree with a mismatched comment', async () => {
  await assert.rejects(verify(archive(global(), dir, file('hello?'), run, link)), /pinned Git tree/)
  await assert.rejects(verify(archive(global('0'.repeat(40)), dir, file(), run, link)), /pinned commit/)
})

test('refuses bad header checksums, unsupported types, truncated bodies and trailing data', async () => {
  const badChecksum = file()
  badChecksum[0] = 65
  const short = gzipSync(Buffer.concat([global(), dir, entry('omni-fixture/x', '0', 'ends early', { size: 700 }).subarray(0, 522)]))
  await assert.rejects(verify(archive(global(), dir, badChecksum, run, link)), /header checksum/)
  await assert.rejects(verify(archive(global(), dir, entry('omni-fixture/x', '1'))), /unsupported entry/)
  await assert.rejects(verify(short), /truncated/)
  await assert.rejects(verify(archive(global(), dir, Buffer.alloc(1024), file())), /data after its end/)
})

test('checks PAX lengths, record terminators and effective duplicate paths', async () => {
  for (const malformed of ['0 path=x\n', '+9 path=x\n', '99 path=x\n', '9 path=x!', '5 abc']) {
    await assert.rejects(verify(archive(global(), dir, entry('pax', 'x', malformed), file())), /malformed PAX/)
  }
  const same = entry('pax', 'x', pax('path', 'omni-fixture/bin/file.txt'))
  await assert.rejects(verify(archive(global(), dir, file(), same, entry('different', '0', 'hello\n'))), /duplicate path/)
})

test('refuses archive paths that escape, exceed limits, or mix roots', async () => {
  for (const name of ['omni-fixture/../file', '/omni-fixture/file', 'omni-fixture/back\\slash']) {
    await assert.rejects(verify(archive(global(), dir, entry(name, '0'))), /unsafe path/)
  }
  for (const name of ['omni-fixture/' + 'x'.repeat(4096), 'omni-fixture/' + 'x/'.repeat(64) + 'x']) {
    await assert.rejects(verify(archive(global(), dir, entry('pax', 'x', pax('path', name)), file())), /unsafe path/)
  }
  await assert.rejects(verify(archive(global(), dir, entry('second/file', '0'))), /more than one root/)
})

test('refuses symlink escapes, chains that leave the root, and entries beneath symlinks in either order', async () => {
  const symlink = (path, target) => entry('omni-fixture/' + path, '2', '', { target })
  for (const target of ['../outside', '/outside']) {
    await assert.rejects(verify(archive(global(), dir, symlink('link', target))), /symlink/)
  }
  await assert.rejects(verify(archive(global(), dir, symlink('a', 'bin/b'), symlink('bin/b', '..'), symlink('link', 'a/../escape'))), /leaves its source tree/)
  const under = entry('omni-fixture/link/file', '0')
  for (const entries of [[link, under], [under, link]]) {
    await assert.rejects(verify(archive(global(), dir, ...entries)), /under a file or symlink/)
  }
})

test('bounds compressed bytes, expanded bytes and header count', async () => {
  await assert.rejects(verify(good, { compressed: good.length - 1 }), /compressed size limit/)
  await assert.rejects(verify(good, { expanded: 2048 }), /expanded size limit/)
  await assert.rejects(verify(good, { count: 4 }), /too many entries/)
})

test('cancellation stops a worker waiting for the rest of its input', async () => {
  const controller = new AbortController()
  const stream = new ReadableStream({ start(input) { input.enqueue(good.subarray(0, 12)) } })
  const result = verifyOmniArchive(stream, pin, controller.signal)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
})
