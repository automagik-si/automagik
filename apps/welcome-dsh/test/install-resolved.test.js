import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { apply } from '../index.js'
import { GENIE_PLUGIN, GENIE_RELEASE, OMNI_PLUGINS, OMNI_RELEASE, genieSpec, installTargetOf } from '../src/host/bot-types.js'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'
import { KEYS, PKG, entryOf, filesOf, release as fakeRelease } from './lane-fixture.js'

const [botTeam, channels, canvas] = OMNI_PLUGINS
const ownLink = 'link:/home/someone/automagik/apps/welcome-dsh'
const botLink = ownLink.replace('welcome-dsh', 'bots-dsh')
const row = (plugin, fields = {}) => ({ name: plugin.name, availability: 'profile', enabled: true, version: PKG.version, ...fields })
const omniChoice = {
  from: 'lane', release: '2.261120.2', commit: 'a'.repeat(40), sequence: 123, server: '2.261120.1', pair: true,
  plugins: [{ name: channels.name, version: '2.261120.1' }, { name: canvas.name, version: '2.261118.4' }],
}
const genieChoice = {
  from: 'lane', release: '0.1.5', commit: 'b'.repeat(40), sequence: 12,
  plugins: [{ name: GENIE_PLUGIN.name, version: '0.1.5' }],
}

// The same inventory and mutation calls DSH's manager gives the welcome (bot-types.test.js).
function fakeManager({ bundles = [row(PKG, { source: ownLink })], answer = () => ({ application: 'applied' }) } = {}) {
  const calls = []
  return {
    calls, bundles,
    async listBundles() { return structuredClone(bundles) },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      const plugin = spec.includes(GENIE_RELEASE.path) ? GENIE_PLUGIN : OMNI_PLUGINS.find(plugin => spec.includes(plugin.dir) || spec.includes(plugin.name))
      assert.ok(plugin, spec)
      const result = answer(plugin, spec, options)
      if (['applied', 'restart-required'].includes(result.application)) {
        bundles.push(row(plugin, { version: options.expected?.version ?? (plugin === GENIE_PLUGIN ? GENIE_RELEASE.version : plugin === botTeam ? PKG.version : OMNI_RELEASE.version) }))
      }
      return result
    },
    async setBundleEnabled(name, enabled) {
      calls.push(['enable', name, enabled])
      bundles.find(row => row.name === name).enabled = enabled
      return { application: 'applied' }
    },
  }
}

function fakeResolver({ omni = () => omniChoice, genie = () => genieChoice } = {}) {
  const calls = []
  const taken = []
  return {
    calls, taken,
    omni: (rows, team) => { calls.push(['omni', team]); return omni(rows, team) },
    genie: (rows, team) => { calls.push(['genie', team]); return genie(rows, team) },
    cachedOmni: () => null, cachedGenie: () => null,
    recordTaken: (...args) => taken.push(args),
  }
}

function routeOf(fake) {
  const route = fake.routes.find(route => route.path === '/api/omni-ai')
  return async (endpoint, payload = null) => {
    const request = new Request('http://localhost/api/omni-ai', { method: 'POST', body: JSON.stringify({ endpoint, payload }) })
    const reply = await (await route.fetch(request)).json()
    assert.equal(reply.ok, true, JSON.stringify(reply.error))
    return reply.value
  }
}

function host({ manager = fakeManager(), releases = fakeResolver(), ...deps } = {}) {
  const fake = fakeContext({ entries: { 'omni-ai': {} }, services: { pluginManager: manager } })
  install(fake.ctx, { releases, env: {}, checkGit: async () => null, genieCli: async () => null, ...deps })
  return { ...fake, call: routeOf(fake), manager, releases }
}

async function settle(fake, product = 'omni-plugins') {
  for (let i = 0; i < 100; i++) {
    const status = await fake.call(product)
    if (status.install?.phase !== 'installing') return status
    await setTimeout(1)
  }
  assert.fail('the install never finished')
}

const source = (repo, commit, path) => `git+https://github.com/automagik-si/${repo}.git#${commit}&path:/${path}`
const expected = (plugin, version) => ({ expected: { name: plugin.name, version } })
const omniCall = (plugin, choice = omniChoice) => ['install', source('omni', choice.commit, `apps/${plugin.dir}`), {
  enabled: true, ...expected(plugin, choice.plugins.find(pkg => pkg.name === plugin.name).version),
}]
const pinCall = plugin => ['install', installTargetOf(plugin, ownLink).spec, { enabled: true }]
const refusal = code => ({ error: { code, diagnostic: 'DSH refused this package' } })

test('Omni installs the lane-checked Bot team tarball before both chosen commit specs', async (t) => {
  const AUTOMAGIK_HOME = mkdtempSync(join(tmpdir(), 'welcome-install-'))
  t.after(() => rmSync(AUTOMAGIK_HOME, { recursive: true, force: true }))
  const manager = fakeManager({ bundles: [row(PKG)] })
  const release = fakeRelease(filesOf())
  const fake = host({ manager, release: { keys: KEYS, fetch: release.fetch }, env: { AUTOMAGIK_HOME } })
  await fake.call('omni-plugins-install')
  const { install } = await settle(fake)
  const filename = `${botTeam.name.replace('/', '+')}-${PKG.version}-${entryOf(botTeam).sha256}.tgz`
  assert.deepEqual(manager.calls, [
    ['install', join(AUTOMAGIK_HOME, 'welcome', 'tarballs', filename), { enabled: true }],
    omniCall(channels), omniCall(canvas),
  ])
  assert.equal(release.asked.length, 3)
  assert.equal(install.phase, 'done')
  const { sequence, ...display } = omniChoice
  assert.deepEqual(install.release, display)
  assert.deepEqual(fake.releases.taken, [['omni', sequence]])
})

test('production apply resolves the shared Omni pin as an npm pair through the registered POST route', async (t) => {
  const asked = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(url)
    if (url.endsWith('/dist-tags')) return Response.json({ latest: '2.261109.2' })
    if (!url.includes(OMNI_RELEASE.commit)) return new Response(null, { status: 404 })
    const isChannels = url.endsWith(`/${channels.dir}/package.json`)
    return Response.json({
      name: isChannels ? channels.name : canvas.name, version: isChannels ? '2.261112.5' : '2.261112.3',
      engines: { dsh: '*', omni: '>=2.261102.41' },
    })
  })
  const manager = fakeManager()
  const fake = fakeContext({ entries: { 'omni-ai': {} }, services: { pluginManager: manager } })
  apply(fake.ctx)
  const call = routeOf(fake)
  await call('omni-plugins-install')
  const { install } = await settle({ call })
  assert.equal(install.release.from, 'pin')
  assert.equal(install.release.pair, true)
  assert.deepEqual(install.release.plugins, [
    { name: channels.name, version: '2.261112.5' }, { name: canvas.name, version: '2.261112.3' },
  ])
  assert.deepEqual(manager.calls, [['install', botLink, { enabled: true }], pinCall(channels), pinCall(canvas)])
  const count = asked.length
  await call('omni-plugins')
  await call('genie-plugin')
  await call('bot-type', { type: 'omni' })
  assert.equal(asked.length, count)
})

test('Omni takes both pin targets after the first resolved plugin is refused', async () => {
  const manager = fakeManager({ answer: (_plugin, _spec, options) => options.expected ? refusal('incompatible-version') : { application: 'applied' } })
  const fake = host({ manager })
  await fake.call('omni-plugins-install')
  const { install } = await settle(fake)
  assert.equal(install.phase, 'done')
  assert.equal(install.release.from, 'pin')
  assert.deepEqual(manager.calls, [['install', botLink, { enabled: true }], omniCall(channels), pinCall(channels), pinCall(canvas)])
  assert.deepEqual(fake.releases.taken, [])
})

test('refusal of the second resolved Omni plugin fails without trying the pinned sibling', async () => {
  for (const code of ['incompatible-version', 'unexpected-package']) {
    const manager = fakeManager({ answer: (plugin, _, options) => plugin === canvas && options.expected ? refusal(code) : { application: 'applied' } })
    const fake = host({ manager })
    await fake.call('omni-plugins-install')
    const { install } = await settle(fake)
    assert.equal(install.phase, 'failed')
    assert.equal(install.error, `Omni's plugins stopped half way: Omni canvases was refused (${code}). Power Omni on again to finish.`)
    assert.equal(install.release.from, 'lane')
    assert.deepEqual(manager.calls, [['install', botLink, { enabled: true }], omniCall(channels), omniCall(canvas)])
    assert.deepEqual(fake.releases.taken, [])
    const { groups } = await fake.call('bot-type', { type: 'omni' })
    assert.equal(groups.find(group => group.id === 'plugins').rows.find(row => row.id === canvas.name).version, omniChoice.plugins[1].version)
  }
})

test('Genie keeps the request ID, installs the chosen manifest, and names it in the terminal', async () => {
  const fake = host()
  await fake.call('genie-plugin-install')
  const { install } = await settle(fake, 'genie-plugin')
  const { requestId } = install
  assert.equal(install.phase, 'done')
  assert.match(requestId, /^genie-/)
  assert.deepEqual(fake.manager.calls, [
    ['install', botLink, { enabled: true, requestId }],
    ['install', source('genie', genieChoice.commit, GENIE_RELEASE.path), { enabled: true, requestId, ...expected(GENIE_PLUGIN, '0.1.5') }],
  ])
  assert.match(install.log, /Installing Genie \(@automagik\/genie-dsh 0\.1\.5, automagik-si\/genie@bbbbbbb\)/)
  const { sequence, ...display } = genieChoice
  assert.deepEqual(install.release, display)
  assert.deepEqual(fake.releases.taken, [['genie', sequence]])
})

test('a refused Genie install falls back to the pin without expected metadata', async () => {
  const manager = fakeManager({ answer: (_plugin, _spec, options) => options.expected ? refusal('incompatible-version') : { application: 'applied' } })
  const fake = host({ manager })
  await fake.call('genie-plugin-install')
  const { install } = await settle(fake, 'genie-plugin')
  assert.equal(install.phase, 'done')
  assert.equal(install.release.from, 'pin')
  assert.deepEqual(manager.calls.at(-1), ['install', genieSpec(), { enabled: true, requestId: install.requestId }])
  assert.ok(install.log.includes(`Installing Genie (${GENIE_PLUGIN.name} ${GENIE_RELEASE.version}, automagik-si/genie@${GENIE_RELEASE.commit.slice(0, 7)})`))
  assert.deepEqual(fake.releases.taken, [])
})

test('an ordinary resolved install failure keeps DSH’s diagnostic', async () => {
  const manager = fakeManager({ answer: (_plugin, _spec, options) => options.expected ? refusal('install-failed') : { application: 'applied' } })
  const fake = host({ manager })
  await fake.call('omni-plugins-install')
  const { install } = await settle(fake)
  assert.equal(install.error, 'Omni channels: DSH refused this package')
  assert.deepEqual(manager.calls, [['install', botLink, { enabled: true }], omniCall(channels)])
})

test('present plugins keep their versions and switched-off plugins are only enabled', async () => {
  const manager = fakeManager({ bundles: [row(botTeam), row(channels), row(canvas, { enabled: false }), row(GENIE_PLUGIN, { enabled: false })] })
  const fake = host({ manager })
  await fake.call('omni-plugins-install')
  await settle(fake)
  await fake.call('genie-plugin-install')
  await settle(fake, 'genie-plugin')
  assert.deepEqual(fake.releases.calls, [])
  assert.deepEqual(manager.calls, [['enable', canvas.name, true], ['enable', GENIE_PLUGIN.name, true]])
})

for (const key of ['AUTOMAGIK_HOST', 'AUTOMAGIK_PRELOAD']) {
  test(`${key}=unfold never resolves or installs missing plugins`, async () => {
    const manager = fakeManager({ bundles: [row(botTeam)] })
    const fake = host({ manager, env: { [key]: 'unfold' } })
    await fake.call('omni-plugins-install')
    assert.equal((await settle(fake)).install.phase, 'failed')
    await fake.call('genie-plugin-install')
    assert.equal((await settle(fake, 'genie-plugin')).install.phase, 'failed')
    assert.deepEqual(manager.calls, [])
    assert.deepEqual(fake.releases.calls, [])
  })
}

test('a failed initial listing uses the old pin path without calling a resolver', async () => {
  const manager = fakeManager()
  manager.listBundles = async () => { throw new Error('cannot list') }
  const release = fakeRelease(filesOf())
  const home = mkdtempSync(join(tmpdir(), 'welcome-list-failed-'))
  try {
    const fake = host({ manager, release: { keys: KEYS, fetch: release.fetch }, env: { AUTOMAGIK_HOME: home } })
    await fake.call('omni-plugins-install')
    assert.equal((await settle(fake)).install.phase, 'done')
    await fake.call('genie-plugin-install')
    assert.equal((await settle(fake, 'genie-plugin')).install.phase, 'done')
    assert.deepEqual(fake.releases.calls, [])
    assert.deepEqual(manager.calls.slice(1, 3), [pinCall(channels), pinCall(canvas)])
    assert.equal(manager.calls.at(-1)[1], genieSpec())
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('after lookup the current team and newly installed sibling determine the choice', async () => {
  const manager = fakeManager()
  const releases = fakeResolver({
    omni() {
      manager.bundles.push(row(botTeam, { version: '3.2.0', enabled: false }), row(channels, { version: omniChoice.plugins[0].version }))
      return {
        ...omniChoice,
        rechoose(rows, team) {
          assert.equal(team, '3.2.0')
          assert.ok(rows.some(row => row.name === channels.name))
          return null
        },
      }
    },
  })
  const fake = host({ manager, releases })
  await fake.call('omni-plugins-install')
  assert.equal((await settle(fake)).install.release.from, 'pin')
  assert.deepEqual(manager.calls, [['enable', botTeam.name, true], pinCall(canvas)])
  assert.deepEqual(releases.calls, [['omni', PKG.version]])
})

test('a failed second listing falls back to the pins with the initial inventory', async () => {
  const manager = fakeManager()
  const list = manager.listBundles
  const releases = fakeResolver({
    async omni() {
      await setTimeout(1)
      manager.listBundles = () => {
        manager.listBundles = list
        return null
      }
      return omniChoice
    },
  })
  const fake = host({ manager, releases })
  await fake.call('omni-plugins-install')
  assert.equal((await settle(fake)).install.release.from, 'pin')
  assert.deepEqual(manager.calls, [['install', botLink, { enabled: true }], pinCall(channels), pinCall(canvas)])
})

test('status shows the most recent cached package versions without resolving', async () => {
  const releases = fakeResolver()
  releases.cachedGenie = () => genieChoice
  releases.cachedOmni = () => omniChoice
  const fake = host({ releases })
  assert.equal((await fake.call('genie-plugin')).plugin.version, '0.1.5')
  const { groups } = await fake.call('bot-type', { type: 'omni' })
  assert.deepEqual(groups.find(group => group.id === 'plugins').rows.slice(1).map(pkg => pkg.version), omniChoice.plugins.map(pkg => pkg.version))
  await fake.call('omni-plugins')
  assert.deepEqual(releases.calls, [])
})
