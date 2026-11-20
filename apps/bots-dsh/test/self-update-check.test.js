import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { selfUpdateCheck } from '../src/host/self-update-check.js'
import { REASON_CODES, storeDirOf, writeJsonAtomic } from '../src/host/self-update.js'

const LANE_URL = 'https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json'
const PING = 'https://registry.npmjs.org/-/ping'
const BOTS = '@automagik/bots-dsh'
const WELCOME = '@automagik/welcome-dsh'
const LOCALE = '@automagik/locale-pt-br-dsh'
const TARGET = '3.160.3'
const CURRENT = '3.160.2'
const SEQUENCE = 1600003
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keys = [{ keyId: 'fixture', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]
const requiresStore = { skip: constants.O_NOFOLLOW === undefined && 'O_NOFOLLOW is unavailable' }
const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding)
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))

function fixture(t, { installed = { [BOTS]: CURRENT }, changeLane, changeSignature, replies = new Map() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bots-update-check-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'web')
  const store = storeDirOf(profileDir)
  const checkPath = join(store, 'check.json')
  mkdirSync(profileDir, { recursive: true })
  const dependencies = { 'unrelated-plugin': '^5.0.0' }
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'package.json'), { name, version })
    dependencies[name] = `file:vendor/${name.split('/')[1]}.tgz`
  }
  writeJson(join(profileDir, 'package.json'), { dependencies })
  const tarballs = new Map()
  const lane = {
    keyId: keys[0].keyId, schemaVersion: 1, version: TARGET, sequence: SEQUENCE,
    plugins: [BOTS, WELCOME, LOCALE].map(name => {
      const bytes = Buffer.from(`fixture tarball for ${name}`)
      const url = `https://github.com/automagik-si/automagik/releases/download/v${TARGET}/${name.split('/')[1]}.tgz`
      tarballs.set(url, bytes)
      return { name, version: TARGET, url, size: bytes.length, sha256: digest('sha256', bytes, 'hex'),
        integrity: `sha512-${digest('sha512', bytes, 'base64')}`, engines: { dsh: '>=0.2.1-rc.3 <0.2.2-0' } }
    }),
  }
  changeLane?.(lane)
  const bytes = Buffer.from(JSON.stringify(lane, null, 2) + '\n')
  const signature = sign(null, bytes, privateKey).toString('base64')
  const calls = []
  const fetch = async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'manual')
    assert.ok(options.signal instanceof AbortSignal)
    if (replies.has(url)) return replies.get(url)()
    if (url === LANE_URL) return new Response(bytes)
    if (url === `${LANE_URL}.sig`) return new Response(` ${changeSignature?.(signature) ?? signature}\n`)
    if (tarballs.has(url)) return new Response(tarballs.get(url))
    if (url === PING) return new Response('{}')
    assert.fail(`Unexpected fetch to ${url}`)
  }
  const options = { profileDir, env: {}, inDesktop: false, fetch, keys, getDshVersion: () => '0.2.1-rc.10' }
  return { profileDir, store, checkPath, calls, lane, tarballs, replies, options }
}

function assertCheck(f, result, state, reason) {
  assert.equal(result.version, 1)
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt)
  assert.equal(result.state, state)
  assert.equal(result.reason, reason)
  if (reason !== null) assert.ok(REASON_CODES.includes(reason))
  assert.deepEqual(JSON.parse(readFileSync(f.checkPath, 'utf8')), result)
  assert.equal(readdirSync(f.store).some(entry => entry.startsWith('check-')), false)
}

test('checks every installed lane plugin without a supervisor and records only public fields', requiresStore, async t => {
  const f = fixture(t, { installed: { [BOTS]: CURRENT, [WELCOME]: TARGET } })
  const [bot, welcome] = f.lane.plugins
  const cdn = 'https://release-assets.githubusercontent.com/fixtures/bots.tgz'
  f.replies.set(bot.url, () => Response.redirect(cdn))
  f.replies.set(cdn, () => new Response(f.tarballs.get(bot.url)))
  f.replies.set(welcome.url, () => {
    const [temp] = readdirSync(f.store).filter(name => name.startsWith('check-'))
    assert.ok(temp)
    assert.deepEqual(readFileSync(join(f.store, temp, 'bots-dsh.tgz')), f.tarballs.get(bot.url))
    return new Response(f.tarballs.get(welcome.url))
  })
  const before = readFileSync(join(f.profileDir, 'package.json'))
  const result = await selfUpdateCheck(f.options)
  assertCheck(f, result, 'available', null)
  assert.deepEqual(result, {
    version: 1, checkedAt: result.checkedAt, state: 'available', reason: null, laneVersion: TARGET, sequence: SEQUENCE,
    plugins: [{ name: BOTS, from: CURRENT, to: TARGET }, { name: WELCOME, from: TARGET, to: TARGET }], supervisor: false,
  })
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`, bot.url, cdn, welcome.url, PING])
  assert.deepEqual(readFileSync(join(f.profileDir, 'package.json')), before)
  assert.deepEqual(readdirSync(f.store), ['check.json'])
})

for (const [label, modifications] of [
  ['bad signature', { changeSignature: () => Buffer.alloc(64).toString('base64') }],
  ['unknown keyId', { changeLane: lane => { lane.keyId = 'unknown' } }],
  ['unsupported schema', { changeLane: lane => { lane.schemaVersion = 2 } }],
]) {
  test(`refuses ${label} before using the lane metadata`, requiresStore, async t => {
    const f = fixture(t, modifications)
    const result = await selfUpdateCheck(f.options)
    assertCheck(f, result, 'refused', 'signature-invalid')
    assert.deepEqual([result.laneVersion, result.sequence, result.plugins], [null, null, []])
    assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
  })
}

test('is current when none of the installed plugins would be updated', requiresStore, async t => {
  const f = fixture(t, { installed: { [BOTS]: TARGET } })
  assertCheck(f, await selfUpdateCheck(f.options), 'current', 'not-newer')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('refuses the whole set if updating one installed plugin would downgrade another', requiresStore, async t => {
  const f = fixture(t, { installed: { [BOTS]: CURRENT, [WELCOME]: '3.160.4' } })
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'not-newer')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('refuses a sequence below the trusted current record even without a supervisor', requiresStore, async t => {
  const f = fixture(t)
  writeJsonAtomic(join(f.store, 'current.json'), { version: 1, live: null, kept: null, lastSequence: SEQUENCE + 1 }, f.options)
  const result = await selfUpdateCheck(f.options)
  assertCheck(f, result, 'refused', 'sequence-lower')
  assert.equal(result.sequence, SEQUENCE)
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('a corrupt current record cannot disable the sequence guard', requiresStore, async t => {
  const f = fixture(t)
  writeJsonAtomic(join(f.store, 'current.json'), { version: 1, lastSequence: 'invalid' }, f.options)
  assertCheck(f, await selfUpdateCheck(f.options), 'unavailable', 'store-invalid')
  assert.deepEqual(f.calls, [])
})

test('refuses if any plugin requires another running DSH version', requiresStore, async t => {
  const f = fixture(t, { installed: { [BOTS]: CURRENT, [WELCOME]: CURRENT }, changeLane: lane => {
    lane.plugins[1].engines.dsh = '>=0.2.2'
  } })
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'engines-dsh')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('refuses an installed dependency missing from the signed release', requiresStore, async t => {
  const f = fixture(t, { installed: { [BOTS]: CURRENT, [WELCOME]: CURRENT }, changeLane: lane => { lane.plugins.splice(1, 1) } })
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'lane-invalid')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

for (const field of ['sha256', 'integrity']) {
  test(`refuses a ${field} mismatch and removes the temporary folder`, requiresStore, async t => {
    const f = fixture(t, { changeLane: lane => { lane.plugins[0][field] = 'bad' } })
    assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'hash-mismatch')
    assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`, f.lane.plugins[0].url])
  })
}

test('caps the stream at the signed size, including responses without a content-length', requiresStore, async t => {
  const f = fixture(t)
  const [{ url, size }] = f.lane.plugins
  f.replies.set(url, () => new Response(Buffer.alloc(size + 1)))
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'download-failed')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`, url])
})

test('refuses a signed size larger than the hard cap before requesting the tarball', requiresStore, async t => {
  const f = fixture(t, { changeLane: lane => { lane.plugins[0].size = 64 * 1024 * 1024 + 1 } })
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'download-failed')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('refuses a non-GitHub tarball URL before sending a request', requiresStore, async t => {
  const f = fixture(t, { changeLane: lane => { lane.plugins[0].url = 'https://github.com.example.invalid/bots.tgz' } })
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'download-failed')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`])
})

test('refuses a redirect outside the GitHub release asset CDN', requiresStore, async t => {
  const f = fixture(t)
  const [{ url }] = f.lane.plugins
  f.replies.set(url, () => Response.redirect('https://elsewhere.invalid/package.tgz'))
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'download-failed')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`, url])
})

test('pings the profile registry and refuses if it cannot be reached', requiresStore, async t => {
  const f = fixture(t)
  const ping = 'https://registry.example.invalid/npm/-/ping'
  writeFileSync(join(f.profileDir, '.npmrc'), '# Different registry\nregistry = "https://registry.example.invalid/npm/"\n')
  f.replies.set(ping, () => new Response('{}', { status: 503 }))
  assertCheck(f, await selfUpdateCheck(f.options), 'refused', 'registry-unreachable')
  assert.deepEqual(f.calls, [LANE_URL, `${LANE_URL}.sig`, f.lane.plugins[0].url, ping])
})

test('a successful empty registry ping is reachable and supervisor presence is a boolean', requiresStore, async t => {
  const f = fixture(t)
  const registry = 'https://registry.example.invalid/'
  const ping = `${registry}-/ping`
  f.replies.set(ping, () => new Response(null, { status: 204 }))
  const env = { AUTOMAGIK_SUPERVISOR_BOOT: 'fixture-boot', AUTOMAGIK_SUPERVISOR_VERSION: CURRENT }
  const result = await selfUpdateCheck({ ...f.options, env, registry: () => registry })
  assertCheck(f, result, 'available', null)
  assert.equal(result.supervisor, true)
  assert.equal(f.calls.at(-1), ping)
})

test('desktop or no store is unavailable without fetching or creating a store', requiresStore, async t => {
  const f = fixture(t)
  const desktop = await selfUpdateCheck({ ...f.options, inDesktop: true })
  assert.equal(desktop.state, 'unavailable')
  assert.equal(desktop.reason, 'desktop-app')
  const noStore = await selfUpdateCheck({ ...f.options, profileDir: join(f.profileDir, 'missing') })
  assert.equal(noStore.state, 'unavailable')
  assert.equal(noStore.reason, 'no-store')
  assert.deepEqual(f.calls, [])
  assert.equal(existsSync(f.store), false)
})

test('concurrent calls share the same promise and a later call checks again', requiresStore, async t => {
  const f = fixture(t)
  const first = selfUpdateCheck(f.options)
  const again = selfUpdateCheck(f.options)
  assert.equal(first, again)
  const result = await first
  assertCheck(f, result, 'available', null)
  assert.equal(await again, result)
  assert.equal(f.calls.length, 4)
  const next = selfUpdateCheck(f.options)
  assert.notEqual(next, first)
  assertCheck(f, await next, 'available', null)
  assert.equal(f.calls.length, 8)
})
