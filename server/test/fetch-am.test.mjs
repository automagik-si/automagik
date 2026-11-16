import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fetchAm, sumOf } from '../fetch-am.mjs'

const temps = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-fetch-am-'))
  temps.push(dir)
  return dir
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function tarball({ version = '3.149.2', extra = [] } = {}) {
  const dir = temp()
  const root = join(dir, 'am')
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'VERSION'), `${version}\n`)
  writeFileSync(join(root, 'bin', 'am.mjs'), '#!/usr/bin/env node\nconsole.log("am")\n')
  for (const file of extra) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), 'x\n')
  }
  const archive = join(dir, 'am.tgz')
  execFileSync('tar', ['-czf', archive, '-C', root, '.'])
  return readFileSync(archive)
}

function fakeRelease(bytes, { hash = sha256(bytes), file = 'automagik-am-3.149.2.tgz' } = {}) {
  const answered = []
  const fetch = async (url) => {
    answered.push(url)
    if (url.endsWith(`${file}.sha256`)) return new Response(`${hash}  ${file}\n`, { status: 200 })
    if (url.endsWith(file)) return new Response(bytes, { status: 200 })
    return new Response('not found', { status: 404 })
  }
  return { fetch, answered }
}

test('am comes from the pinned release tarball, verified and unpacked', async () => {
  const bytes = tarball()
  const release = fakeRelease(bytes)
  const out = join(temp(), 'out')
  const result = await fetchAm({
    version: '3.149.2', out, repository: 'https://example.test/automagik',
    fetch: release.fetch, log: () => {}, delay: async () => {},
  })
  assert.equal(result.version, '3.149.2')
  assert.equal(result.sha256, sha256(bytes))
  assert.equal(result.size, bytes.byteLength)
  assert.equal(readFileSync(join(out, 'VERSION'), 'utf8').trim(), '3.149.2')
  assert.ok(existsSync(join(out, 'bin', 'am.mjs')))
  assert.ok(release.answered.every((url) => url.startsWith('https://example.test/automagik/releases/download/v3.149.2/')))
})

test('a tarball whose bytes differ from the release .sha256 is refused', async () => {
  const bytes = tarball()
  const release = fakeRelease(bytes, { hash: 'a'.repeat(64) })
  await assert.rejects(fetchAm({
    version: '3.149.2', out: join(temp(), 'out'), repository: 'https://example.test/automagik',
    fetch: release.fetch, log: () => {}, delay: async () => {},
  }), /sha256 .* not the release's/)
})

test("am's tests never reach the image", async () => {
  const bytes = tarball({ extra: ['test/am.test.mjs'] })
  const release = fakeRelease(bytes)
  await assert.rejects(fetchAm({
    version: '3.149.2', out: join(temp(), 'out'), repository: 'https://example.test/automagik',
    fetch: release.fetch, log: () => {}, delay: async () => {},
  }), /carries am's tests/)
})

test('the tarball VERSION must name the release', async () => {
  const bytes = tarball({ version: '9.9.9' })
  const release = fakeRelease(bytes)
  await assert.rejects(fetchAm({
    version: '3.149.2', out: join(temp(), 'out'), repository: 'https://example.test/automagik',
    fetch: release.fetch, log: () => {}, delay: async () => {},
  }), /VERSION is 9\.9\.9, not 3\.149\.2/)
})

test('the sum file parser names only its own file', () => {
  const sums = `${'b'.repeat(64)}  automagik-am-3.149.2.tgz\n${'c'.repeat(64)}  other.tgz\n`
  assert.equal(sumOf(sums, 'automagik-am-3.149.2.tgz'), 'b'.repeat(64))
  assert.equal(sumOf(sums, 'missing.tgz'), undefined)
})
