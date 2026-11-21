import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { bundleClient } from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const OFFICIAL_INSTALL_EFFECT = 'omni-ai: Omni and Genie install on the Apps page'

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
})

test('Welcome uses the mounted Bot viewer for gated writes and preserves its desktop request', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/api.js', import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'browser',
  })
  const requests = []
  let retired = false
  let reply = { ok: true, value: 'saved' }
  const check = () => {
    if (retired) throw Object.assign(new Error('Viewer unavailable'), { code: 'bot/retired' })
  }
  const context = {
    module: { exports: {} },
    fetch: async (route, init) => {
      requests.push([route, { ...init, headers: { ...init.headers }, body: JSON.parse(init.body) }])
      return { ok: true, json: async () => reply }
    },
  }
  runInNewContext(outputFiles[0].text, context)
  const { call, callOmniUi } = context.module.exports
  assert.equal(await callOmniUi('omni-pair-cancel'), 'saved')
  context.__AUTOMAGIK_VIEW__ = { version: 1, role: 'owner' }
  await assert.rejects(callOmniUi('omni-pair-cancel'), { code: 'bot/retired' })
  assert.equal(requests.length, 1)
  await assert.rejects(call('done'), { code: 'bot/retired' })
  assert.equal(requests.length, 1)
  context.__AUTOMAGIK_MOUNTED_VIEWER__ = {
    get id() { check(); return 'owner-viewer' },
    check,
    refused(code) {
      assert.equal(code, 'bot/viewer-changed')
      retired = true
    },
  }
  assert.equal(await callOmniUi('omni-pair-cancel', { account: 'test' }), 'saved')
  reply = { ok: false, error: { code: 'bot/viewer-changed' } }
  await assert.rejects(callOmniUi('omni-pair-cancel'), { code: 'bot/viewer-changed' })
  await assert.rejects(callOmniUi('omni-pair-cancel'), { code: 'bot/retired' })
  delete context.__AUTOMAGIK_VIEW__
  reply = { ok: true, value: 'saved' }
  assert.equal(await call('done', { stepId: 'omni-team' }), 'saved')
  const init = { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } }
  assert.deepEqual(requests, [
    ['api/omni-ui', { ...init, body: { endpoint: 'omni-pair-cancel', payload: null } }],
    ['api/omni-ui', { ...init, body: { endpoint: 'omni-pair-cancel', payload: { account: 'test' }, viewer: 'owner-viewer' } }],
    ['api/omni-ui', { ...init, body: { endpoint: 'omni-pair-cancel', payload: null, viewer: 'owner-viewer' } }],
    ['api/omni-ai', { ...init, body: { endpoint: 'done', payload: { stepId: 'omni-team' } } }],
  ])
})

// DSH runs client.js as a classic script that hands a factory to the module loader; the
// factory's `require` answers only the shell's platform modules.
test('client.js registers its three onboarding steps on settings.onboarding, in order', () => {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  assert.equal(registrations.length, 1)
  const [{ id, factory }] = registrations
  assert.equal(id, '@automagik/welcome-dsh')

  const platform = { react: { createElement: () => null }, 'react-dom': { createPortal: node => node } }
  const requested = new Set()
  const exports = factory((specifier) => {
    requested.add(specifier)
    if (!(specifier in platform)) throw new Error(`no platform module ${specifier}`)
    return platform[specifier]
  })
  assert.deepEqual([...requested].sort(), ['react', 'react-dom'])
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject'])
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])

  const injected = []
  const registered = []
  const effects = []
  const runs = new Map()
  const registers = []
  const locale = { register: (ns, dicts) => { registers.push([ns, Object.keys(dicts)]); return () => {} }, bind: () => key => key }
  exports.apply({
    effect: (run, label) => { effects.push(label); runs.set(label, run) },
    get: name => (name === 'locale' ? locale : undefined),
    slots: {
      inject: (name, register) => { injected.push(name); register() },
      register: (options, component) => { registered.push({ ...options, component: typeof component }); return () => {} },
    },
  })
  assert.deepEqual(effects, [
    'omni-ai: stage styles',
    'omni-ai: team step copy',
    "omni-ai: the table over DSH's first frame",
    'omni-ai: omni-companion on the rail',
    'omni-ai: omni-team on the rail',
    'omni-ai: omni-migrate on the rail',
    'omni-ai: omni-connect-ai on the rail',
    'omni-ai: Claude Code and Codex in Settings',
    "omni-ai: power in each Bot's settings",
    OFFICIAL_INSTALL_EFFECT,
  ])
  // The team step's copy goes to DSH's locale service as welcome.team.
  runs.get('omni-ai: team step copy')()
  assert.deepEqual(registers, [['welcome.team', ['en', 'pt', 'pt-BR']]])
  assert.deepEqual(injected, ['settings.onboarding', 'settings.onboarding', 'settings.onboarding', 'settings.onboarding'])
  assert.deepEqual(registered, [
    { name: 'settings.onboarding', id: 'omni-companion', order: -300, component: 'function' },
    { name: 'settings.onboarding', id: 'omni-team', order: -270, component: 'function' },
    { name: 'settings.onboarding', id: 'omni-migrate', order: -230, component: 'function' },
    { name: 'settings.onboarding', id: 'omni-connect-ai', order: -200, component: 'function' },
  ])
})

// The power card goes into each Bot's settings through the Bot team's client, which DSH loads
// first when it is installed (`dsh.client.external`). It is looked up only when the effect runs,
// and a DSH without the Bot team, or one whose client has no botSettings, gets no card and no error.
function botTeamEffect(botTeam, label = "omni-ai: power in each Bot's settings") {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  const requested = []
  const platform = { react: { createElement: () => null }, 'react-dom': { createPortal: node => node } }
  const exports = registrations[0].factory((specifier) => {
    requested.push(specifier)
    if (specifier in platform) return platform[specifier]
    if (specifier === '@automagik/bots-dsh/client') return botTeam()
    throw new Error(`no platform module ${specifier}`)
  })
  const runs = new Map()
  exports.apply({
    effect: (run, label) => runs.set(label, run),
    get: () => undefined,
    slots: { inject: () => {}, register: () => () => {} },
  })
  assert.ok(!requested.includes('@automagik/bots-dsh/client'), 'the Bot team is looked up only when the effect runs')
  return { run: runs.get(label), requested }
}

test('the power card registers on the Bot team\'s botSettings, and leaves with its disposer', () => {
  const entries = []
  const botSettings = { register: (entry) => { entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1) } }
  const { run, requested } = botTeamEffect(() => ({ omni: { botSettings } }))
  const dispose = run()
  assert.ok(requested.includes('@automagik/bots-dsh/client'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'welcome-power')
  assert.equal(typeof entries[0].Component, 'function')
  dispose()
  assert.equal(entries.length, 0)
})

test('without the Bot team, or with a client that has no botSettings, there is no card and nothing throws', () => {
  for (const botTeam of [
    () => { throw new Error('Module @automagik/bots-dsh/client is not registered') },
    () => undefined,
    () => ({}),
    () => ({ omni: null }),
    () => ({ omni: {} }),
  ]) {
    const { run } = botTeamEffect(botTeam)
    const dispose = run()
    assert.equal(typeof dispose, 'function')
    dispose()
  }
})

test('the Apps installer registers with the Bot team and is optional on older clients', () => {
  const entries = new Set()
  const officialInstall = {
    register(entry) {
      entries.add(entry)
      return () => entries.delete(entry)
    },
  }
  const botTeam = () => ({ omni: { officialInstall } })
  const { run, requested } = botTeamEffect(botTeam, OFFICIAL_INSTALL_EFFECT)
  const dispose = run()
  assert.ok(requested.includes('@automagik/bots-dsh/client'))
  assert.deepEqual([...entries].map(entry => entry.id), ['welcome-install'])
  dispose()
  assert.equal(entries.size, 0)

  const older = botTeamEffect(() => ({ omni: {} }), OFFICIAL_INSTALL_EFFECT)
  const noop = older.run()
  assert.equal(typeof noop, 'function')
  noop()
})

test('client.js keeps the Bot team\'s client external: no copy of it is bundled', () => {
  const text = committed()
  assert.match(text, /require\("@automagik\/bots-dsh\/client"\)/)
  for (const own of ['bt-side-top', 'sidebarTools = registry', 'export const omni']) assert.ok(!text.includes(own), `client.js bundles the Bot team's ${own}`)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dsh.client.external, ['@automagik/bots-dsh/client'])
})
