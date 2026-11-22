import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { LANE_KEYS } from '../../desktop/src/lane-keys.js'
import { GENIE_PLUGIN, GENIE_RELEASE, OMNI_PLUGINS, OMNI_RELEASE, teamVersion } from '../src/host/bot-types.js'
import { chooseGenie, chooseOmni, compareVersions, createReleases, dshCheck, registryOf, satisfies } from '../src/host/release-resolve.js'
import { PKG } from './lane-fixture.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const key = { keyId: 'test-key', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
const keys = { omni: [key], genie: [key] }
const [team, channels, canvas] = OMNI_PLUGINS
const npm = 'https://registry.npmjs.org/-/package/@automagik%2fomni/dist-tags'
const lanes = {
  omni: 'https://github.com/automagik-si/omni/releases/download/plugin-lane/lane.json',
  genie: 'https://raw.githubusercontent.com/automagik-si/genie/lane/lane.json',
}
const manifestURL = (repo, commit, path) => `https://raw.githubusercontent.com/automagik-si/${repo}/${commit}/${path}/package.json`
const server = '2.261109.2'
const omniLane = { version: '2.261121.1', commit: 'a'.repeat(40) }
const genieLane = { version: '0.1.5', commit: 'b'.repeat(40) }
const dshEngine = '>=0.2.2-rc.1 <0.2.3-0'

const manifest = (plugin, version, engines = {}, peers = {}) => ({
  name: plugin.name, version, engines: { dsh: dshEngine, ...engines }, peerDependencies: { [team.name]: '>=3.87.0 <3.261000.0', ...peers },
})
const candidate = (from, { version: release, commit }, minimum, channelVersion = release, canvasVersion = release) => ({
  from, release, commit, sequence: 4,
  manifests: {
    channels: manifest(channels, channelVersion, { omni: minimum }),
    canvas: manifest(canvas, canvasVersion, {}, { [channels.name]: `>=${channelVersion}` }),
  },
})
const pinCandidate = candidate('pin', OMNI_RELEASE, '>=2.261102.41 <3', '2.261112.5', '2.261112.3')
const laneCandidate = candidate('lane', omniLane, '>=2.261116.3', '2.261120.1')
const candidates = [pinCandidate, laneCandidate]

function signLane(files, publisher, overrides = {}) {
  const bytes = JSON.stringify({
    schemaVersion: 1, publisher, keyId: key.keyId, sequence: 4,
    ...(publisher === 'omni' ? omniLane : { ...genieLane, plugins: [{ name: GENIE_PLUGIN.name, version: genieLane.version }] }),
    ...overrides,
  })
  files.set(lanes[publisher], bytes)
  files.set(`${lanes[publisher]}.sig`, sign(null, Buffer.from(bytes), privateKey).toString('base64'))
}

function fixture(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'welcome-lanes-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const files = new Map([[npm, JSON.stringify({ latest: '2.261116.3' })]])
  signLane(files, 'omni')
  signLane(files, 'genie')
  for (const { commit, manifests } of candidates) {
    files.set(manifestURL('omni', commit, `apps/${channels.dir}`), JSON.stringify(manifests.channels))
    files.set(manifestURL('omni', commit, `apps/${canvas.dir}`), JSON.stringify(manifests.canvas))
  }
  files.set(manifestURL('genie', genieLane.commit, GENIE_RELEASE.path), JSON.stringify(manifest(GENIE_PLUGIN, genieLane.version)))
  const asked = []
  const fetch = async (url, init) => {
    asked.push(url)
    const body = files.get(url)
    if (typeof body === 'function') return body(init)
    return new Response(body, { status: body === undefined ? 404 : 200 })
  }
  const releases = createReleases({ fetch, keys, env: { AUTOMAGIK_HOME: home }, ...options })
  return { files, asked, releases, home, omni: () => releases.omni([], PKG.version), genie: () => releases.genie([], PKG.version) }
}

test('publisher lane keys are separate and Genie uses the desktop key', () => {
  const carried = JSON.parse(readFileSync(new URL('../src/host/publisher-keys.json', import.meta.url), 'utf8'))
  assert.deepEqual(carried.genie, LANE_KEYS.genie)
  assert.notEqual(carried.omni[0].publicKey, carried.genie[0].publicKey)
})

test('signed Omni and Genie lanes use their own commit manifests and record both sequences', async (t) => {
  const f = fixture(t)
  const [omni, genie] = await Promise.all([f.omni(), f.genie()])
  assert.equal(omni.from, 'lane')
  assert.equal(omni.commit, omniLane.commit)
  assert.equal(omni.pair, true)
  assert.equal(genie.from, 'lane')
  assert.equal(genie.commit, genieLane.commit)
  assert.deepEqual(genie.plugins, [{ name: GENIE_PLUGIN.name, version: genieLane.version }])

  f.releases.recordTaken('omni', omni.sequence)
  f.releases.recordTaken('genie', genie.sequence)
  f.releases.recordTaken('omni', omni.sequence - 1)
  const record = join(f.home, 'welcome', 'lanes.json')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { omni: 4, genie: 4 })
  assert.equal((await f.omni()).from, 'lane')
  f.releases.recordTaken('omni', 5)
  f.releases.recordTaken('genie', 5)
  assert.equal((await f.omni()).from, 'pin')
  assert.equal((await f.genie()).from, 'pin')
})

test('Omni skips invalid lanes before asking for their manifests', async (t) => {
  const rejected = {
    'bad signature': files => files.set(`${lanes.omni}.sig`, 'invalid'),
    'unknown key': files => signLane(files, 'omni', { keyId: 'unknown' }),
    'wrong publisher': files => signLane(files, 'omni', { publisher: 'genie' }),
    'schema 2': files => signLane(files, 'omni', { schemaVersion: 2 }),
    'not a release': files => signLane(files, 'omni', { version: '2.261120.2-rc.1' }),
    'not a commit': files => signLane(files, 'omni', { commit: 'main' }),
    'non-integer sequence': files => signLane(files, 'omni', { sequence: 4.5 }),
    'oversize signature': files => files.set(`${lanes.omni}.sig`, ' '.repeat(64 * 1024 + 1)),
    'oversize lane': files => files.set(lanes.omni, ' '.repeat(64 * 1024 + 1)),
  }
  for (const [name, change] of Object.entries(rejected)) {
    const f = fixture(t)
    change(f.files)
    assert.equal((await f.omni()).from, 'pin', name)
    assert.ok(!f.asked.some(url => url.includes(omniLane.commit)), name)
  }
})

test('candidates with missing, mismatched or oversized manifests are skipped', async (t) => {
  const url = manifestURL('omni', omniLane.commit, `apps/${channels.dir}`)
  for (const body of [undefined, JSON.stringify(manifest(canvas, omniLane.version)), 'x'.repeat(64 * 1024 + 1)]) {
    const f = fixture(t)
    f.files.set(url, body)
    assert.equal((await f.omni()).from, 'pin')
  }
  const f = fixture(t)
  signLane(f.files, 'genie', { plugins: [{ name: GENIE_PLUGIN.name }, { name: channels.name }] })
  assert.equal((await f.genie()).from, 'pin')
})

test('the registry uses the first credential-free HTTPS URL and only takes a release dist-tag', async (t) => {
  assert.equal(registryOf({ BUN_CONFIG_REGISTRY: 'https://bun.example/proxy', NPM_CONFIG_REGISTRY: 'https://npm.example' }), 'https://bun.example/proxy/')
  assert.equal(registryOf({ BUN_CONFIG_REGISTRY: 'https://u:p@bun.example', NPM_CONFIG_REGISTRY: 'http://npm.example', npm_config_registry: 'https://npm.example' }), 'https://npm.example/')
  assert.equal(registryOf({ BUN_CONFIG_REGISTRY: 'invalid' }), 'https://registry.npmjs.org/')
  for (const [body, expected] of [
    [JSON.stringify({ latest: server }), server],
    [JSON.stringify({ latest: '2.261109.2-rc.1', next: server }), undefined],
    [JSON.stringify({ latest: server, padding: 'x'.repeat(64 * 1024) }), undefined],
    [() => { throw new Error('offline') }, undefined],
  ]) {
    const f = fixture(t)
    f.files.set(npm, body)
    const choice = await f.omni()
    assert.equal(choice.server, expected)
    // The lane's channels need 2.261116.3: npm's 2.261109.2 does not have it, but the pinned
    // release the welcome builds from GitHub (#1915) does, so the newer lane pairs either way.
    assert.equal(choice.from, 'lane')
    assert.equal(choice.pair, expected ? true : undefined)
  }
})

const choose = (options = {}) => chooseOmni({ candidates, server, team: PKG.version, dsh: () => true, ...options })

test('Omni prefers the newest pair from the signed lane and the shared pin', () => {
  const above = choose({ server: '2.261121.1' })
  assert.equal(above.from, 'lane')
  assert.equal(above.pair, true)
  const exact = choose({ server: '2.261116.3' })
  assert.equal(exact.from, 'lane')
  assert.equal(exact.pair, true)
  const paired = choose()
  assert.equal(paired.from, 'pin')
  assert.equal(paired.commit, OMNI_RELEASE.commit)
  assert.equal(paired.pair, true)
  assert.deepEqual(paired.plugins, [{ name: channels.name, version: '2.261112.5' }, { name: canvas.name, version: '2.261112.3' }])
  const noPair = choose({ server: '2.261101.1' })
  assert.equal(noPair.from, 'lane')
  assert.equal(noPair.pair, false)
  const unknown = choose({ server: null })
  assert.equal(unknown.from, 'lane')
  assert.equal(unknown.pair, undefined)

  const duplicate = { ...laneCandidate, from: 'pin' }
  assert.equal(choose({ candidates: [laneCandidate, duplicate], server: null }).from, 'lane')
  const noMinimum = candidate('lane', omniLane, undefined)
  assert.equal(choose({ candidates: [noMinimum], server: '2.261120.1' }).pair, false)
})

test('DSH checks both manifests, with no exemptions, and lets the installer decide if the exports fail', async () => {
  const calls = []
  const getCheck = evaluatePluginCompatibility => dshCheck({
    get: () => ({
      import: async name => {
        assert.equal(name, '@deepseek-ai/dsh-app-boot')
        return { exported: { getDshRuntimeVersion: () => '0.2.2-rc.2', evaluatePluginCompatibility } }
      },
      unwrapExports: loaded => loaded.exported,
    }),
  })
  const fail = await getCheck((pkg, exemptions, runtime) => {
    calls.push([pkg.name, exemptions, runtime])
    return pkg.name === canvas.name ? { exempted: true } : undefined
  })
  assert.equal(choose({ dsh: fail }).from, 'pin')
  assert.deepEqual(calls.slice(0, 2), [[channels.name, {}, '0.2.2-rc.2'], [canvas.name, {}, '0.2.2-rc.2']])
  assert.equal(choose({ dsh: await getCheck(() => ({ exempted: false })) }).from, 'pin')
  for (const check of [await dshCheck({}), await getCheck(undefined), await getCheck(() => { throw new Error('unavailable') })]) {
    assert.equal(choose({ dsh: check }).pair, true)
    assert.equal(check({ engines: { dsh: ' ' } }), false)
    assert.equal(check({}), false)
  }
})

test('Bot team and canvas peers gate choices, including a disabled team and a legacy-only team', () => {
  assert.equal(teamVersion([]), PKG.version)
  assert.equal(teamVersion([{ name: team.name, enabled: false, version: '3.1.2' }]), '3.1.2')
  assert.equal(choose({ team: '3.1.2' }).from, 'pin')
  const legacyOnly = teamVersion([{ name: team.formerly, enabled: true, version: '3.160.7' }])
  assert.equal(legacyOnly, null)
  assert.equal(choose({ team: legacyOnly }).from, 'pin')
  const incompatible = structuredClone(candidates)
  incompatible[0].manifests.canvas.peerDependencies[channels.name] = '>=2.261113.1'
  const result = choose({ candidates: incompatible })
  assert.equal(result.from, 'lane')
  assert.equal(result.pair, false)
  assert.equal(satisfies('3.2.0-rc.10', '>3.2.0-rc.2 <3.2.0'), true)
  assert.equal(satisfies('3.2.0+build.7', '>=3.2.0 <=3.2.0 =3.2.0'), true)
  assert.equal(satisfies('3.2.0', '^3.2.0'), false)
  assert.equal(satisfies('3.2.0', '>=3.0.0 || <4.0.0'), false)
  assert.equal(satisfies('3.2.0', '3.2.0'), false)
  assert.equal(compareVersions('3.2.0-rc.10', '3.2.0-rc.2'), 1)
})

test('a partial Omni profile requires the exact version of whichever sibling is present', () => {
  const pinned = choose({ present: { name: canvas.name, version: '2.261112.3' } })
  assert.equal(pinned.from, 'pin')
  assert.equal(pinned.pair, true)
  assert.equal(choose({ present: { name: channels.name, version: '2.261120.1' } }).from, 'lane')
  const unmatched = choose({ present: { name: channels.name, version: '2.261120.2' } })
  assert.equal(unmatched.from, 'pin')
  assert.equal(unmatched.pair, undefined)
})

test('Genie takes a compatible lane at or above the pin, including semver prereleases', () => {
  const pick = ({ version = '0.1.5-rc.1', dsh = () => true, team = PKG.version } = {}) => chooseGenie({
    candidate: { from: 'lane', release: genieLane.version, commit: genieLane.commit, manifest: manifest(GENIE_PLUGIN, version) },
    team, dsh,
  }).from
  assert.equal(pick(), 'lane')
  assert.equal(pick({ version: GENIE_RELEASE.version }), 'lane')
  assert.equal(pick({ version: `${GENIE_RELEASE.version}-rc.1` }), 'pin')
  assert.equal(pick({ version: '0.1.3' }), 'pin')
  assert.equal(pick({ team: '3.0.0' }), 'pin')
  assert.equal(pick({ dsh: () => false }), 'pin')
})

test('requests coalesce, with ten minutes for a success and sixty seconds for a failure', async (t) => {
  let now = 0
  const f = fixture(t, { now: () => now })
  const missing = manifestURL('omni', OMNI_RELEASE.commit, `apps/${channels.dir}`)
  f.files.delete(missing)
  const count = url => f.asked.filter(asked => asked === url).length
  await Promise.all([f.omni(), f.omni(), f.omni()])
  assert.equal(count(npm), 1)
  assert.equal(count(missing), 1)
  now = 59_999
  await f.omni()
  assert.equal(count(missing), 1)
  now = 60_000
  await f.omni()
  assert.equal(count(missing), 2)
  assert.equal(count(npm), 1)
  now = 599_999
  await f.omni()
  assert.equal(count(npm), 1)
  now = 600_000
  await f.omni()
  assert.equal(count(npm), 2)
})

test('the request deadline aborts slow body reads and the resolution deadline bounds a stuck loader', async (t) => {
  const f = fixture(t, { requestMs: 10 })
  let signal
  let cancelled = false
  f.files.set(npm, init => {
    signal = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  })
  const [omni] = await Promise.all([f.omni(), setTimeout(25)])
  assert.equal(omni.server, undefined)
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)

  const stuck = fixture(t, { resolutionMs: 10, ctx: { get: () => ({ import: () => new Promise(() => {}) }) } })
  const [genie] = await Promise.all([stuck.genie(), setTimeout(25)])
  assert.equal(genie.from, 'pin')
})

test('a pair counts the pinned release the welcome builds from GitHub as an installable server (#1915)', () => {
  // npm's server is too old for the lane's channels; the pin built from GitHub is new enough.
  const built = choose({ buildable: '2.261120.2' })
  assert.equal(built.from, 'lane')
  assert.equal(built.pair, true)
  assert.equal(built.server, server)
  // A pin older than the lane's minimum leaves the npm pair as before.
  const old = choose({ buildable: '2.261112.6' })
  assert.equal(old.from, 'pin')
  assert.equal(old.pair, true)
  // With npm unknown, the buildable pin alone decides the pair, and no server is reported.
  const unknown = choose({ server: null, buildable: '2.261112.6' })
  assert.equal(unknown.from, 'pin')
  assert.equal(unknown.server, undefined)
})
