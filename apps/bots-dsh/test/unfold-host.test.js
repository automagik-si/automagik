// AUTOMAGIK_HOST=unfold: the Bot team inside Unfold's own Automagik instance. Unfold ships the
// instance whole, so nothing here checks for or offers an update, no Bot drives a browser, and
// Unfold's own Privacy settings decide what is shared. Each case runs once without the host
// kind first, so it shows the same setup would have reached the network, the browser or a
// switch.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import * as constants from '../src/host/constants.js'
import { install as installDshUpdate } from '../src/host/dsh-update.js'
import { createPrivacy } from '../src/host/privacy.js'
import { install as installUpdate } from '../src/host/update.js'
import { fakeContext } from './fake-ctx.js'
import { unfoldLeads } from './fake-unfold-bot.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const realFetch = globalThis.fetch
const HOST = 'AUTOMAGIK_HOST'
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env[HOST]
  delete process.env.AUTOMAGIK_PRELOAD
  mock.timers.reset()
})
const flush = async () => { for (let index = 0; index < 14; index += 1) await Promise.resolve() }

// Both update modules on one runtime: the plugin manager says the team came from the
// registry, the registry and GitHub answer a newer release, and every effect runs as DSH
// would run it, so the first check's timer is real (on the mocked clock).
function updaters() {
  const fetched = []
  const spawns = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    const latest = { version: '99.0.0', dsBot: { verifiedDsh: '9.9.9' } }
    const body = String(url).includes('api.github.com') ? { tag_name: 'v99.0.0', stargazers_count: 7, html_url: 'https://github.com/automagik-si/automagik/releases/v99.0.0' } : latest
    return { ok: true, status: 200, json: async () => body }
  }
  const pluginManager = {
    listBundles: async () => [{ name: PKG.name, source: `${PKG.name}@^${PKG.version}` }],
    registries: async () => ({ registry: null, fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' }),
    installBundle: async () => ({ application: 'restart-required' }),
  }
  const loader = { import: async () => ({ getDshRuntimeVersion: () => '0.1.0' }), unwrapExports: exports => exports }
  const rt = {
    ctx: { get: name => ({ pluginManager, loader, profileContext: {} })[name], effect: execute => execute() },
    config: {},
    warn() {},
    dshSpawn: (command, argv) => {
      spawns.push([command, ...argv])
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  }
  installUpdate(rt)
  installDshUpdate(rt)
  return { rt, fetched, spawns }
}

async function tenMinutesLater(rt) {
  mock.timers.tick(11 * 60_000)
  await flush()
  const update = await rt.updateCheck()
  const dsh = await rt.dshUpdateCheck()
  const stars = await rt.repoStars()
  return { update, dsh, stars }
}

test('Unfold\'s instance is named by AUTOMAGIK_HOST or AUTOMAGIK_PRELOAD, and only unfold names it', () => {
  assert.equal(typeof constants.inUnfoldInstance, 'function')
  assert.equal(constants.inUnfoldInstance({ AUTOMAGIK_HOST: 'unfold' }), true)
  assert.equal(constants.inUnfoldInstance({ AUTOMAGIK_HOST: ' Unfold ' }), true)
  assert.equal(constants.inUnfoldInstance({ AUTOMAGIK_PRELOAD: 'unfold' }), true)
  assert.equal(constants.inUnfoldInstance({ AUTOMAGIK_HOST: 'desktop' }), false)
  assert.equal(constants.inUnfoldInstance({ AUTOMAGIK_PRELOAD: 'genie' }), false)
  assert.equal(constants.inUnfoldInstance({}), false)
})

// The Unfold Bot (in Unfold's own repository, here its stand-in) and the welcome's hostOf tell
// Unfold's instance by the same rule, held to one written case table (RFC 0020).
test('the host rule answers every case of its table, here and in the Unfold Bot stand-in', () => {
  const table = JSON.parse(readFileSync(new URL('./fixtures/unfold-host-rule.json', import.meta.url), 'utf8'))
  assert.ok(table.cases.some(row => row.unfold) && table.cases.some(row => !row.unfold))
  for (const { name, env, unfold } of table.cases) {
    assert.deepEqual([constants.inUnfoldInstance(env), unfoldLeads(env)], [unfold, unfold], name)
  }
})

test('elsewhere the same setup asks the registry and GitHub, and offers the update', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 28) })
  const { rt, fetched } = updaters()
  const { update, stars } = await tenMinutesLater(rt)
  assert.ok(fetched.some(url => url.startsWith('https://registry.npmjs.org/')))
  assert.ok(fetched.some(url => url.startsWith('https://api.github.com/')))
  assert.equal(update.available, true)
  assert.equal(stars, 7)
})

test('under AUTOMAGIK_HOST=unfold, ten minutes on: no registry or GitHub request, no npm, no offer', async () => {
  process.env[HOST] = 'unfold'
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 28) })
  const { rt, fetched, spawns } = updaters()
  const { update, dsh, stars } = await tenMinutesLater(rt)
  assert.deepEqual(fetched, [])
  assert.equal(update.available, false)
  assert.equal(update.enabled, false)
  assert.equal(dsh.available, false)
  assert.equal(stars, null)
  assert.throws(() => rt.updateStart(), /No Omni update/)
  assert.throws(() => rt.dshUpdateStart(), /No DSH update/)
  await rt.updateCheck({ fresh: true })
  await rt.dshUpdateCheck({ fresh: true })
  assert.deepEqual(fetched, [])
  assert.deepEqual(spawns, [])
})

// A team runtime with the default config, in a scratch home.
function team(t) {
  const home = mkdtempSync(join(tmpdir(), 'bots-unfold-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  // The browser tools are a Bot Session's own since v0.3.6: the names the browser part mounted, with
  // whatever a global registration still holds.
  const browserTools = [...new Set([...(rt.browserToolNames ?? []), ...ctx.registeredTools.keys()])].filter(name => name.startsWith('browser_') || name === 'read_browser')
  return { rt, browserTools }
}

test('elsewhere every Bot drives a browser of its own by default', (t) => {
  const { rt, browserTools } = team(t)
  assert.ok(browserTools.includes('browser_open'))
  assert.equal(rt.browserChannel !== undefined, true)
})

test('under AUTOMAGIK_HOST=unfold the Bot browser is off: no browser tool, no channel', (t) => {
  process.env[HOST] = 'unfold'
  const { rt, browserTools } = team(t)
  assert.deepEqual(browserTools, [])
  assert.equal(rt.browserEnabled, false)
  assert.equal(rt.browserChannel, undefined)
})

test('under AUTOMAGIK_HOST=unfold the Privacy page is Unfold\'s, even beside a privacy file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-unfold-privacy-'))
  try {
    const file = join(dir, 'privacy.json')
    const privacy = createPrivacy({ env: { AUTOMAGIK_HOST: 'unfold', AUTOMAGIK_PRIVACY_FILE: file } })
    const view = privacy.view()
    assert.equal(view.managed, false)
    assert.equal(view.host, 'unfold')
    assert.throws(() => privacy.set('deepseek-session-log', true), /Unfold/)
    assert.equal(createPrivacy({ env: { AUTOMAGIK_PRIVACY_FILE: file } }).view().host, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The Privacy page as the browser gets it, with a React that records elements.
const bundle = await build({
  stdin: { contents: "export { PrivacyPage } from './src/client/privacy.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
const page = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: () => {}, useState: initial => [initial, () => {}],
}
runInNewContext(bundle.outputFiles[0].text, { module: page, exports: page.exports, require: name => (name === 'react' ? react : { createPortal: x => x }) })

function render(view) {
  const Section = 'Section'
  const Row = 'Row'
  const switchName = 'Switch'
  // The page reads its view through useState: hand it the view as the first state.
  react.useState = initial => [initial === null ? view : initial, () => {}]
  const tree = page.exports.PrivacyPage({ actions: { privacy: async () => view }, run: () => {}, Section, Row })
  react.useState = initial => [initial, () => {}]
  const nodes = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    nodes.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  const switches = nodes.filter(node => typeof node.type === 'function' && node.type.name === switchName)
  const labels = nodes.filter(node => node.type === Row).map(node => String(node.props.label))
  return { switches, labels }
}

test('the Privacy page shows the Unfold-managed state, with no switch', () => {
  const share = { 'deepseek-session-log': false, 'deepseek-feedback': false, 'claude-errors': true, spellcheck: true, 'stable-id': true }
  const app = render({ managed: true, share })
  assert.equal(app.switches.length, 5)
  const unfold = render({ managed: false, host: 'unfold', share })
  assert.equal(unfold.switches.length, 0)
  assert.deepEqual(unfold.labels, ['Unfold\'s Privacy controls this'])
})
