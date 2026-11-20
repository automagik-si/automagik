import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { MAX_ROLE_BYTES, MAX_ROLE_FILES, MAX_ROLE_FILE_SIZE, readRoleTar } from '../src/host/role-tar.js'
import { archive, tarMember } from './role-fixture.js'

test('reads a system tar POSIX ustar archive with directory entries, prefix and padded termination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'role-ustar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = `package/${'a'.repeat(55)}/${'b'.repeat(55)}`
  await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, dir, 'test.txt'), 'fixture')
  const file = join(root, 'role.tgz')
  const result = spawnSync('tar', ['--format=ustar', '-czf', file, 'package'], { cwd: root })
  if (result.error?.code === 'ENOENT') return t.skip('system tar is absent')
  assert.equal(result.status, 0, result.stderr?.toString())
  const files = readRoleTar(await readFile(file))
  assert.equal(files.size, 1)
  assert.equal(files.get(`${dir.slice(8)}/test.txt`).toString(), 'fixture')
})

test('rejects unsupported ustar kinds and unsafe paths', () => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K', 'S', 'z']) {
    assert.throws(() => readRoleTar(archive([tarMember('package/a', '', { type })])), /entry type/)
  }
  for (const path of ['package/../out', '/package/a', 'package/a\\b', 'package//a', 'package/./a',
    'package/a:stream', 'package/aux.js', 'package/COM9.json', 'package/a.', 'package/a ', 'package/café',
    'package/a\0hidden', 'package/a\n', `package/${'a'.repeat(65)}`, 'package/a/']) {
    assert.throws(() => readRoleTar(archive([tarMember(path)])), /path|NUL/, JSON.stringify(path))
  }
  const longPath = tarMember('d'.repeat(60), 'x', { prefix: `package/${'a'.repeat(64)}/${'b'.repeat(64)}/cdefghij` })
  assert.throws(() => readRoleTar(archive([longPath])), /path/)
  assert.throws(() => readRoleTar(archive([tarMember('package/a/', 'x', { type: '5' })])), /entry size/)
})

test('checks duplicate paths and implied directory collisions in both orders', () => {
  const member = path => tarMember(`package/${path}`)
  const dir = path => tarMember(`package/${path}/`, '', { type: '5' })
  const root = tarMember('package/', '', { type: '5' })
  for (const entries of [[member('a'), member('a')], [member('A'), member('a')],
    [member('a/b'), member('A/c')], [member('a'), member('a/b')], [dir('a'), member('a')], [dir('a'), dir('a')], [root, root]]) {
    for (const ordered of [entries, [...entries].reverse()]) {
      assert.throws(() => readRoleTar(archive(ordered)), /collision|duplicate/)
    }
  }
  assert.equal(readRoleTar(archive([member('a/b'), dir('a')])).size, 1)
  assert.equal(readRoleTar(archive([dir('a'), member('a/b'), tarMember('package/nul-type', 'x', { type: '\0' })])).size, 2)
})

test('checks the checksum, octal format, padding, truncation and resource limits', () => {
  assert.throws(() => readRoleTar(archive([tarMember('package/a', '', { badChecksum: true })])), /checksum/)
  assert.throws(() => readRoleTar(archive([tarMember('package/a', '', { octal: '0\0' + '1'.repeat(10) })])), /octal/)
  assert.throws(() => readRoleTar(archive([tarMember('package/a', '', { size: MAX_ROLE_FILE_SIZE + 1 })])), /entry size/)
  assert.throws(() => readRoleTar(archive([tarMember('package/a', '', { size: 1024 })], Buffer.alloc(511))), /truncated/)
  assert.throws(() => readRoleTar(archive([], Buffer.alloc(512))), /termination/)
  assert.throws(() => readRoleTar(archive([], Buffer.alloc(1025))), /termination/)
  assert.throws(() => readRoleTar(archive([], Buffer.concat([Buffer.alloc(1024), tarMember('package/a')]))), /termination/)
  assert.throws(() => readRoleTar(archive([], Buffer.alloc(511))), /truncated/)
  const badPadding = tarMember('package/a', 'a')
  badPadding[513] = 1
  assert.throws(() => readRoleTar(archive([badPadding])), /padding/)
  assert.throws(() => readRoleTar(archive(Array.from({ length: MAX_ROLE_FILES + 1 }, (_, i) => tarMember(`package/f${i}`)))), /entry count/)
  assert.throws(() => readRoleTar(gzipSync(Buffer.alloc(MAX_ROLE_BYTES + 1))), /expanded size/)
})
