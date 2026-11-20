import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { launchUrlOf, MEASUREMENT_MARKER, pinStore, prepareDshHome, privateMode, profileDirOf, redactTokens, seedProfile, writeMeasurementMarker } from '../lib.mjs'
import { sumOf, verifyTarball } from '../fetch-plugins.mjs'

const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-server-test-'))
  temps.push(dir)
  return dir
}

test('the launch token never reaches a log line', () => {
  assert.equal(
    redactTokens('dsh web: http://127.0.0.1:3081/?token=abc123&x=1'),
    'dsh web: http://127.0.0.1:3081/?token=<redacted>&x=1',
  )
  assert.equal(redactTokens('url?token=abc'), 'url?token=<redacted>')
  assert.equal(redactTokens('token=abc'), 'token=<redacted>')
  assert.equal(redactTokens('tokenizer=keep access_token=keep'), 'tokenizer=keep access_token=keep')
})

test('the startup URL is read from dsh output, and only there', () => {
  assert.equal(
    launchUrlOf('dsh web: http://127.0.0.1:3081/?token=deadbeef'),
    'http://127.0.0.1:3081/?token=deadbeef',
  )
  assert.equal(launchUrlOf('dsh web: http://127.0.0.1:3081/?token=deadbeef more'), 'http://127.0.0.1:3081/?token=deadbeef')
  assert.equal(launchUrlOf('listening on 3081'), null)
})

test('only a private key file is accepted', () => {
  assert.equal(privateMode(0o400), true)
  assert.equal(privateMode(0o600), true)
  assert.equal(privateMode(0o640), false)
  assert.equal(privateMode(0o444), false)
  assert.equal(privateMode(0o660), false)
  assert.equal(privateMode(0o700), false)
  assert.equal(privateMode(0o500), false)
  assert.equal(privateMode(0o200), false)
})

test('the first start seeds the profile; a second start never replaces it', async () => {
  const dir = temp()
  const source = join(dir, 'seed')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'automagik-web-profile', version: '3.90.1' }))
  writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
  const dshHome = join(dir, 'home')

  const first = await seedProfile({ dshHome, source })
  assert.equal(first.seeded, true)
  assert.equal(first.target, profileDirOf(dshHome))
  assert.equal(readFileSync(join(first.target, 'cordis.patch.yml'), 'utf8'), '[]\n')
  const marker = JSON.parse(readFileSync(join(first.target, 'automagik-server-profile'), 'utf8'))
  assert.equal(marker.version, 1)
  assert.equal(marker.release, '3.90.1')
  assert.equal(marker.packageSha256, createHash('sha256').update(readFileSync(join(first.target, 'package.json'))).digest('hex'))
  prepareDshHome(dshHome)
  writeMeasurementMarker(dir, first.target)
  const measurement = join(dir, MEASUREMENT_MARKER)
  assert.deepEqual(JSON.parse(readFileSync(measurement, 'utf8')), {
    version: marker.version, release: marker.release, packageSha256: marker.packageSha256,
  })
  assert.equal(statSync(measurement).mode & 0o7777, 0o644)
  assert.equal(statSync(dshHome).mode & 0o7777, 0o700)

  writeFileSync(join(first.target, 'cordis.patch.yml'), 'user edit\n')
  const second = await seedProfile({ dshHome, source })
  assert.equal(second.seeded, false)
  assert.equal(readFileSync(join(first.target, 'cordis.patch.yml'), 'utf8'), 'user edit\n')
  writeMeasurementMarker(dir, second.target)
  assert.equal(statSync(measurement).mode & 0o7777, 0o644, 'measurement stays readable after restart')
})

test('the profile names the runtime pnpm store, not the builder’s', () => {
  const dir = temp()
  const profile = join(dir, 'profile')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({ storeDir: '/build/store/v10', hoistPattern: ['*'] }))
  writeFileSync(join(profile, 'node_modules', '.pnpm-workspace-state-v1.json'), '{}')

  const store = pinStore(profile, '/data/dsh')
  assert.equal(store, '/data/dsh/pnpm-store')
  assert.match(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), /^storeDir: "\/data\/dsh\/pnpm-store"$/m)
  const state = JSON.parse(readFileSync(join(profile, 'node_modules', '.modules.yaml'), 'utf8'))
  assert.equal(state.storeDir, '/data/dsh/pnpm-store/v10')
  assert.deepEqual(state.hoistPattern, ['*'])
  assert.equal(existsSync(join(profile, 'node_modules', '.pnpm-workspace-state-v1.json')), false)
})

test('a release tarball is refused unless size, integrity and sum all match', () => {
  const bytes = Buffer.from('not really a tarball')
  const sums = `${'a'.repeat(64)}  other.tgz\n${createHash('sha256').update(bytes).digest('hex')}  pkg.tgz\n`
  const sum = sumOf(sums, 'pkg.tgz')
  assert.equal(sum, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(sumOf(sums, 'missing.tgz'), undefined)
  const entry = {
    file: 'pkg.tgz',
    size: bytes.byteLength,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
  assert.equal(verifyTarball(bytes, entry, sum), sum)
  assert.throws(() => verifyTarball(Buffer.concat([bytes, Buffer.from('x')]), entry, sum), /bytes, not the release's/)
  assert.throws(() => verifyTarball(bytes, { ...entry, integrity: 'sha512-AAAA' }, sum), /sha512/)
  assert.throws(() => verifyTarball(bytes, entry, 'b'.repeat(64)), /sha256/)
  assert.throws(() => verifyTarball(bytes, entry, undefined), /PLUGINS.SHA256SUMS/)
})
