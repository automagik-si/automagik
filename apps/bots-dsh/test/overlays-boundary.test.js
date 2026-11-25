import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const harness = process.env.DSH_HARNESS
assert.ok(harness, 'DSH_HARNESS must supply DSH’s real React and JSDOM')
const require = createRequire(join(harness, 'package.json'))
const { JSDOM } = require('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the harness supplies its React seed factory')
// Evaluate only the React seed prefix, as in activity-row-render.test.js.
const seeds = await build({
  stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})
const seedDom = new JSDOM('<!doctype html>')
const seedContext = {
  window: seedDom.window, document: seedDom.window.document, navigator: seedDom.window.navigator,
  MutationObserver: seedDom.window.MutationObserver, console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder,
  fetch: async () => { throw new Error('seed bootstrap must not fetch') },
}
runInNewContext(seeds.outputFiles[0].text, seedContext)
const nativeRequire = name => seedContext.nativeSeeds[name] ?? require(name)
const React = nativeRequire('react')
const { createRoot } = nativeRequire('react-dom/client')
const { flushSync } = nativeRequire('react-dom')
const h = React.createElement

const children = {
  'browser-pane': 'BotPanel', 'new-chat': 'NewChat', palette: 'CommandPalette', exchange: 'ExchangeDialog',
  voice: 'VoiceMode', 'context-menu': 'ContextMenu', settings: 'SettingsDialog', 'memory-panel': 'MemoryDialog',
}
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { Overlays } from './src/client/overlays.js'",
      "export { ExchangeDialog } from './src/client/exchange.js'",
      "export { apply, omni } from './src/client/index.js'",
      "export { createSource } from './src/client/sources.js'",
      "export { teamActions } from './src/client/team-actions.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{ name: 'overlay-children', setup(builder) {
    builder.onResolve({ filter: /^\.\/[^/]+\.js$/ }, args => {
      const name = args.path.slice(2, -3)
      if (args.importer.endsWith('/overlays.js') && Object.hasOwn(children, name)) return { path: name, namespace: 'overlay-child' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'overlay-child' }, ({ path }) => ({
      contents: `export const ${children[path]} = overlayChildren.${children[path]}; export const PANEL_LINGER_MS = 160;`,
    }))
  } }],
})

function mount(t, { realExchange = false, desktop = false } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: false })
  if (desktop) window.dshDesktop = { protocolVersion: 1, browser: {} }
  const module = { exports: {} }
  const warnings = []
  const closes = []
  const failures = new Map()
  const exitTimers = new Map()
  const overlayChildren = Object.fromEntries(Object.values(children).map(name => [name, function Child(props) {
    const [identity] = React.useState(() => ({}))
    if (failures.has(name)) throw failures.get(name)
    if (realExchange && name === 'ExchangeDialog') return h(module.exports.ExchangeDialog, props)
    return h('div', { 'data-overlay': name, 'data-leaving': props.leaving || undefined, ref: node => {
      if (node) {
        node.childIdentity = identity
        node.pane = props.pane
      }
    } }, props.mode ?? props.page ?? name)
  }]))
  let duringWarning
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire, window, document: window.document, overlayChildren,
    localStorage: window.localStorage, navigator: window.navigator, AbortController, URL,
    console: { ...console, warn: (...args) => { warnings.push(args); duringWarning?.() } },
    fetch: () => assert.fail('overlay controls must not use transport'),
    setTimeout(callback, delay) {
      if (!realExchange || delay !== 220) return setTimeout(callback, delay)
      const timer = {}
      exitTimers.set(timer, callback)
      return timer
    },
    clearTimeout(timer) {
      if (!exitTimers.delete(timer)) clearTimeout(timer)
    },
  })
  const { Overlays, createSource, teamActions, apply, omni } = module.exports
  const sessions = createSource({ byId: {} })
  let roster = { byId: {}, roomsById: {} }
  let ui, actions, offFace
  if (desktop) {
    const effects = new Map()
    apply({
      effect: (fn, label) => { effects.set(label, fn) },
      inject: () => ({ dispose() {} }), get: () => undefined,
      sessions: { list: sessions }, layout: { panelInfo: createSource({}) },
      uiWorkspace: {}, uiConversation: {}, slots: { inject: () => () => {} },
    })
    offFace = effects.get('ds-bot: face for other Omni plugins')()
    const face = omni.face()
    face.hooks.roster.set(state => ({ ...state, byId: { b: { id: 'b' } } }))
    roster = face.hooks.roster.getSnapshot()
    ui = face.hooks.ui
    actions = face.actions
  } else {
    ui = createSource({})
    actions = teamActions({ ui })
  }
  if (realExchange) actions.exchange = async () => []
  for (const name of ['closeMenu', 'closeSettings', 'closeNewChat', 'closeExchange', 'closeOverlay']) {
    if (!actions[name]) continue
    const close = actions[name]
    actions[name] = (...args) => { closes.push(name); close(...args) }
  }
  const hook = value => select => select(value)
  const root = createRoot(window.document.querySelector('#root'), { onCaughtError() {} })
  const props = {
    useRoster: hook(roster), useRegistry: hook({}), useFrame: hook({ viewport: 1200 }),
    useSessions: hook(sessions.getSnapshot()), actions,
    useUi: select => select(React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)),
  }
  t.after(() => {
    flushSync(() => root.unmount())
    offFace?.()
    dom.window.close()
  })
  return {
    actions, ui, warnings, closes, failures, exitTimers,
    render: () => flushSync(() => root.render(h(Overlays, props))),
    warnWith: fn => { duringWarning = fn },
    child: name => window.document.querySelector(`[data-overlay="${name}"]`),
    exchange: () => window.document.querySelector('.bt-exchange'),
    expireExchangeExit: () => flushSync(() => {
      for (const [timer, callback] of exitTimers) {
        exitTimers.delete(timer)
        callback()
      }
    }),
  }
}

test('a menu render error closes its instance once and the other overlays stay available', t => {
  const f = mount(t)
  const error = new Error('menu fixture')
  f.actions.openSettings()
  f.actions.openMenu({ kind: 'bot', id: 'b' })
  f.failures.set('ContextMenu', error)
  f.render()
  assert.ok(f.child('SettingsDialog'))
  assert.equal(f.child('ContextMenu'), null)
  assert.equal(f.ui.getSnapshot().menu, null)
  assert.deepEqual(f.warnings, [['[ds-bot] overlay', 'ContextMenu', error]])
  assert.deepEqual(f.closes, ['closeMenu'])
  flushSync(() => f.actions.openNewChat('new'))
  assert.ok(f.child('NewChat'))
})

for (const [failed, healthy, action, field] of [
  ['NewChat', 'ExchangeDialog', 'closeNewChat', 'newChat'],
  ['ExchangeDialog', 'NewChat', 'closeExchange', 'exchange'],
]) {
  test(`a failed ${failed} closes once while ${healthy} and Details stay open`, t => {
    const f = mount(t)
    f.actions.showDetails('b')
    f.actions.openNewChat('new', 'section')
    f.actions.openExchange('a', 'b')
    f.failures.set(failed, new Error('dialog fixture'))
    f.render()
    assert.equal(f.child(failed), null)
    assert.ok(f.child(healthy))
    assert.ok(f.child('BotPanel'))
    assert.equal(f.ui.getSnapshot()[field], null)
    assert.equal(f.ui.getSnapshot().details, 'b')
    assert.equal(f.ui.getSnapshot().newChatSection, failed === 'NewChat' ? null : 'section')
    assert.deepEqual(f.closes, [action])
    assert.equal(f.warnings.length, 1)
  })
}

for (const section of ['before', 'after']) {
  test(`a replacement opened during failure keeps its NewChat instance in section ${section}`, t => {
    const f = mount(t)
    f.actions.openNewChat('new', 'before')
    f.failures.set('NewChat', new Error('new chat fixture'))
    f.warnWith(() => {
      f.failures.delete('NewChat')
      f.actions.openNewChat('new', section)
    })
    f.render()
    assert.ok(f.child('NewChat'))
    assert.equal(f.ui.getSnapshot().newChatSection, section)
    assert.deepEqual(f.closes, ['closeNewChat'])
    assert.equal(f.warnings.length, 1)
  })
}

test('a failed close does not escape the overlay boundary or cause another close attempt', t => {
  const f = mount(t)
  f.actions.openSettings()
  f.actions.openMenu({ kind: 'bot', id: 'b' })
  f.actions.closeMenu = () => { f.closes.push('closeMenu'); throw new Error('close fixture') }
  f.failures.set('ContextMenu', new Error('menu fixture'))
  f.render()
  f.render()
  assert.ok(f.child('SettingsDialog'))
  assert.equal(f.child('ContextMenu'), null)
  assert.deepEqual(f.closes, ['closeMenu'])
  assert.equal(f.warnings.length, 1)
})

test('Settings recovers on a same-page reopen during exit and healthy child state survives linger', t => {
  const f = mount(t)
  f.actions.openSettings('general')
  f.failures.set('SettingsDialog', new Error('settings fixture'))
  f.render()
  assert.equal(f.ui.getSnapshot().settings, null)
  assert.equal(f.child('SettingsDialog'), null)
  f.failures.delete('SettingsDialog')
  flushSync(() => f.actions.openSettings('general'))
  const identity = f.child('SettingsDialog')?.childIdentity
  assert.ok(identity, 'the same page mounts again before the exit timer')
  assert.deepEqual(f.closes, ['closeSettings'])
  assert.equal(f.warnings.length, 1)
  flushSync(() => f.actions.closeSettings())
  assert.equal(f.child('SettingsDialog')?.dataset.leaving, 'true')
  assert.equal(f.child('SettingsDialog')?.childIdentity, identity)
  flushSync(() => f.actions.openSettings('general'))
  assert.equal(f.child('SettingsDialog')?.childIdentity, identity)
})

test('real Exchange Close Chat cannot outlive a failed exiting pair', t => {
  const f = mount(t, { realExchange: true })
  f.actions.showDetails('b')
  f.actions.openExchange('a', 'b')
  f.render()
  const close = () => flushSync(() => f.exchange().querySelector('button').click())
  close()
  assert.equal(f.exchange().dataset.leaving, 'true')
  assert.equal(f.exitTimers.size, 1)
  f.expireExchangeExit()
  assert.equal(f.ui.getSnapshot().exchange, null, 'a healthy Close Chat completes its exit')
  assert.ok(f.child('BotPanel'))

  flushSync(() => f.actions.openExchange('a', 'b'))
  close()
  assert.equal(f.exchange().dataset.leaving, 'true')
  assert.equal(f.exitTimers.size, 1)
  f.failures.set('ExchangeDialog', new Error('Exchange failed during exit'))
  f.render()
  assert.equal(f.exchange(), null)
  assert.equal(f.ui.getSnapshot().exchange, null)
  assert.equal(f.warnings.length, 1)
  const pendingAfterUnmount = f.exitTimers.size
  f.failures.delete('ExchangeDialog')
  flushSync(() => {
    f.actions.openNewChat('new')
    f.actions.openExchange('a', 'b')
  })
  const replacement = f.ui.getSnapshot().exchange
  f.expireExchangeExit()
  assert.ok(f.child('NewChat'), 'NewChat survives the failed Exchange exit deadline')
  assert.equal(f.ui.getSnapshot().exchange, replacement, 'a replacement for the same Bots stays open')
  assert.ok(f.exchange())
  assert.ok(f.child('BotPanel'))
  assert.equal(pendingAfterUnmount, 0, 'unmount cancels the pending close')
  close()
  f.expireExchangeExit()
  assert.equal(f.ui.getSnapshot().exchange, null)
  assert.ok(f.child('NewChat'), 'a healthy Close Chat closes only its own pair')
  assert.ok(f.child('BotPanel'))
})

test('real desktop browser open actions reject each previous panel scope', async t => {
  for (const name of ['openBrowser', 'browserNewTab', 'browserPick']) {
    await t.test(name, t => {
      const f = mount(t, { desktop: true })
      const tab = f.actions.browserNewTab('b')
      assert.ok(tab)
      f.render()
      const open = () => flushSync(() => f.actions[name]('b', tab))
      open()
      const child = f.child('BotPanel')
      assert.ok(child)
      const identity = child.childIdentity
      const oldPane = child.pane
      assert.equal(oldPane.view, 'browser')
      open()
      assert.equal(f.child('BotPanel')?.childIdentity, identity, 'a healthy panel keeps its child state')
      flushSync(() => f.actions.closePanel(oldPane))
      assert.equal(f.ui.getSnapshot().details, null, 'the original scoped close is valid')
      assert.equal(f.child('BotPanel')?.dataset.leaving, 'true')
      open()
      const replacement = f.child('BotPanel')
      assert.equal(replacement?.childIdentity, identity, 'a healthy child survives reopening during linger')
      assert.equal(replacement.pane.view, 'browser')
      flushSync(() => f.actions.closePanel(oldPane))
      assert.equal(f.ui.getSnapshot().details, 'b', 'the previous scope cannot close the reopened panel')
      assert.notEqual(replacement.pane.instance, oldPane.instance)
    })
  }
})
