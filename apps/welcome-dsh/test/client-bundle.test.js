import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { bundleClient } from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
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
  assert.deepEqual(effects, ['omni-ai: stage styles', 'omni-ai: team step copy', "omni-ai: the table over DSH's first frame", 'omni-ai: omni-companion on the rail', 'omni-ai: omni-team on the rail', 'omni-ai: omni-migrate on the rail', 'omni-ai: omni-connect-ai on the rail', 'omni-ai: Claude Code and Codex in Settings', 'omni-ai: power shortcut in the Bot team sidebar'])
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

// The power shortcut goes into the Bot team's sidebar through its client, which DSH loads first
// when it is installed (`dsh.client.external`). It is looked up only when the effect runs, and a
// DSH without the Bot team, or one whose client has no sidebarTools, gets no button and no error.
function shortcutEffect(botTeam) {
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
  return { run: runs.get('omni-ai: power shortcut in the Bot team sidebar'), requested }
}

test('the power shortcut registers on the Bot team\'s sidebarTools, and leaves with its disposer', () => {
  const entries = []
  const sidebarTools = { register: (entry) => { entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1) } }
  const { run, requested } = shortcutEffect(() => ({ omni: { sidebarTools } }))
  const dispose = run()
  assert.ok(requested.includes('@automagik/bots-dsh/client'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'welcome-power')
  assert.equal(typeof entries[0].Component, 'function')
  dispose()
  assert.equal(entries.length, 0)
})

test('without the Bot team, or with a client that has no sidebarTools, there is no button and nothing throws', () => {
  for (const botTeam of [
    () => { throw new Error('Module @automagik/bots-dsh/client is not registered') },
    () => undefined,
    () => ({}),
    () => ({ omni: null }),
    () => ({ omni: {} }),
  ]) {
    const { run } = shortcutEffect(botTeam)
    const dispose = run()
    assert.equal(typeof dispose, 'function')
    dispose()
  }
})

test('client.js keeps the Bot team\'s client external: no copy of it is bundled', () => {
  const text = committed()
  assert.match(text, /require\("@automagik\/bots-dsh\/client"\)/)
  for (const own of ['bt-side-top', 'sidebarTools = registry', 'export const omni']) assert.ok(!text.includes(own), `client.js bundles the Bot team's ${own}`)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dsh.client.external, ['@automagik/bots-dsh/client'])
})
