// RFC 0030, Handoff note (2026-11-23): while an agent switch runs in a Bot's own chat, the
// composer of a pane that shows any part of that chat takes no input (inert, aria-busy, the
// "Switching to <agent>…" placeholder on that pane alone). The lock ends when the host's
// `switching` goes, or a little after its deadline with no word; a failed switch is said once.
// Rendered with the React DSH ships, on a JSDOM page with two panes.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS
const require = createRequire(join(harness, 'package.json'))
const { JSDOM } = require('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the declared native harness supplies its React seed factory')
const seedsBuild = await build({ stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const seedDom = new JSDOM('<!doctype html><html><body></body></html>')
const seedContext = { window: seedDom.window, document: seedDom.window.document, navigator: seedDom.window.navigator, MutationObserver: seedDom.window.MutationObserver, fetch: async () => { throw new Error('seed bootstrap must not fetch') }, console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder }
runInNewContext(seedsBuild.outputFiles[0].text, seedContext)
const nativeRequire = name => seedContext.nativeSeeds[name] ?? require(name)
const React = nativeRequire('react')
const { createRoot } = nativeRequire('react-dom/client')
const { flushSync } = nativeRequire('react-dom')

const { outputFiles } = await build({
  stdin: { contents: "export { lockComposer, paneOf, useSwitchLock, LOCK_GRACE_MS } from './header.js'\nexport { CROSSING_DEADLINE_MS } from '../shared/routes.js'", resolveDir: join(plugin, 'src/client') },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const PAGE = `
  <div id="pane-a"><div id="root"></div>
    <div data-conversation-content="" data-conversation-session="s2"><div data-composer-card=""><div data-composer-placeholder=""></div></div></div>
  </div>
  <div id="pane-b">
    <div data-conversation-content="" data-conversation-session="other"><div data-composer-card=""></div></div>
  </div>`

function page(t) {
  const dom = new JSDOM(PAGE, { url: 'http://localhost' })
  const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire,
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    console, setTimeout, clearTimeout, Promise, Map, Set, Date,
  })
  t.after(() => {
    dom.window.close()
    globals.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  const document = dom.window.document
  const own = document.querySelector('[data-conversation-session="s2"]')
  const other = document.querySelector('[data-conversation-session="other"]')
  return { dom, document, lib: module.exports, own, other, card: () => own.querySelector('[data-composer-card]') }
}

// The header's hook in a probe component, with a live `work` store and a roster.
function mount(t, view, { bot, sessionId = 's2', updateHold = false } = {}) {
  let work = { models: {} }
  const listeners = new Set()
  const store = {
    set: (next) => { work = next; for (const listener of listeners) listener() },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const reported = []
  const actions = { modelStateOf: id => work.models?.[id], reportError: (error, where) => reported.push([error.message, where]) }
  const roster = { models: [{ ref: 'acp-claude/default', provider: 'acp-claude', providerName: 'Claude Code', name: 'Default' }] }
  const useWork = selector => React.useSyncExternalStore(store.subscribe, () => selector(work))
  const state = { locked: undefined, hold: updateHold }
  function Probe() {
    const anchor = React.useRef(null)
    state.locked = view.lib.useSwitchLock({ bot, roster, sessionId, useWork, actions, updateHold: state.hold, anchor })
    return React.createElement('span', { ref: anchor })
  }
  const root = createRoot(view.document.getElementById('root'))
  const render = () => flushSync(() => root.render(React.createElement(Probe)))
  render()
  t.after(() => flushSync(() => root.unmount()))
  return {
    state, reported, render,
    setWork: (next) => { flushSync(() => store.set(next)) },
    setHold: (hold) => { state.hold = hold; render() },
  }
}

const bot = { id: 'b1', name: 'Ops', sessionId: 's2', parts: ['s1'] }
const switching = since => ({ models: { b1: { selected: 'deepseek/v4', switching: { to: 'acp-claude/default', since } } } })

test('the lock puts inert and aria-busy on this pane\'s composer only, and the placeholder on the pane, never the body', (t) => {
  const view = page(t)
  const release = view.lib.lockComposer(view.lib.paneOf(view.document.getElementById('root').firstChild ?? view.document.getElementById('root'), 's2'), 'Switching to Claude Code…')
  assert.equal(view.card().getAttribute('inert'), '')
  assert.equal(view.card().getAttribute('aria-busy'), 'true')
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '"Switching to Claude Code…"')
  assert.equal(view.document.body.style.getPropertyValue('--bt-placeholder'), '')
  // The split pane on another chat stays usable.
  assert.equal(view.other.querySelector('[data-composer-card]').hasAttribute('inert'), false)
  release()
  assert.equal(view.card().hasAttribute('inert'), false)
  assert.equal(view.card().hasAttribute('aria-busy'), false)
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '')
})

test('a composer card DSH draws anew while the lock holds gets inert again', async (t) => {
  const view = page(t)
  const release = view.lib.lockComposer(view.own, 'Switching to Claude Code…')
  const seat = view.card().parentElement
  view.card().remove()
  const fresh = view.document.createElement('div')
  fresh.setAttribute('data-composer-card', '')
  seat.append(fresh)
  await tick()
  assert.equal(fresh.getAttribute('inert'), '')
  assert.equal(fresh.getAttribute('aria-busy'), 'true')
  release()
  assert.equal(fresh.hasAttribute('inert'), false)
})

test('the header locks while the host says an agent switch runs, and unlocks when it goes', async (t) => {
  const view = page(t)
  const probe = mount(t, view, { bot })
  assert.equal(probe.state.locked, false)
  assert.equal(view.card().hasAttribute('inert'), false)
  probe.setWork(switching(Date.now()))
  assert.equal(probe.state.locked, true)
  assert.equal(view.card().getAttribute('inert'), '')
  assert.equal(view.card().getAttribute('aria-busy'), 'true')
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '"Switching to Claude Code…"')
  assert.equal(view.document.body.style.getPropertyValue('--bt-placeholder'), '')
  probe.setWork({ models: { b1: { selected: 'acp-claude/default' } } })
  assert.equal(probe.state.locked, false)
  assert.equal(view.card().hasAttribute('inert'), false)
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '')
  assert.deepEqual(probe.reported, [])
})

test('a pane that still shows an earlier part of the same Bot is locked too; another Bot\'s switch locks nothing here', (t) => {
  const view = page(t)
  const earlier = mount(t, view, { bot: { ...bot, sessionId: 's3', parts: ['s1', 's2'] } })
  earlier.setWork(switching(Date.now()))
  assert.equal(earlier.state.locked, true)
  assert.equal(view.card().getAttribute('inert'), '')
  earlier.setWork({ models: { b1: {}, b9: { switching: { to: 'acp-claude/default', since: Date.now() } } } })
  assert.equal(earlier.state.locked, false)
  assert.equal(view.card().hasAttribute('inert'), false)
})

test('while an update holds new work, its words stay: the switch locks without its own placeholder', (t) => {
  const view = page(t)
  const probe = mount(t, view, { bot, updateHold: true })
  probe.setWork(switching(Date.now()))
  assert.equal(view.card().getAttribute('inert'), '')
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '')
  probe.setHold(false)
  assert.equal(view.own.style.getPropertyValue('--bt-placeholder'), '"Switching to Claude Code…"')
})

test('with no word from the host, the lock ends at the deadline plus 15 s', async (t) => {
  const view = page(t)
  assert.equal(view.lib.CROSSING_DEADLINE_MS + view.lib.LOCK_GRACE_MS, 135_000)
  const probe = mount(t, view, { bot })
  // A switch that began just over 135 s ago is not locked at all.
  probe.setWork(switching(Date.now() - 135_001))
  await tick()
  assert.equal(probe.state.locked, false)
  assert.equal(view.card().hasAttribute('inert'), false)
  // One that reaches it a moment from now unlocks then, while `switching` still shows.
  probe.setWork(switching(Date.now() - 134_950))
  assert.equal(probe.state.locked, true)
  await tick(120)
  assert.equal(probe.state.locked, false)
  assert.equal(view.card().hasAttribute('inert'), false)
})

test('a switch that failed is said once, in the model line\'s words, when the lock ends', (t) => {
  const view = page(t)
  const probe = mount(t, view, { bot })
  const since = Date.now()
  probe.setWork(switching(since))
  const failed = { models: { b1: { selected: 'deepseek/v4', lastFailure: { code: 'MODEL_SWITCH_COMPACTION_FAILED', ref: 'acp-claude/default', kept: 'deepseek/v4', at: since + 5 } } } }
  probe.setWork(failed)
  assert.deepEqual(probe.reported, [['Default could not take over this conversation. This Bot stays on v4.', 'switch-route']])
  probe.setWork({ ...failed })
  probe.render()
  assert.equal(probe.reported.length, 1)
  // A failure from before the switch began is not this one.
  probe.setWork(switching(since + 100))
  probe.setWork(failed)
  assert.equal(probe.reported.length, 1)
  // The own-tools rule that stopped a switch says its own words.
  probe.setWork(switching(since + 200))
  probe.setWork({ models: { b1: { selected: 'acp-claude/default', lastFailure: { code: 'MODEL_OWN_TOOLS_DENIED', ref: 'acp-antigravity/default', kept: 'acp-claude/default', at: since + 300 } } } })
  assert.equal(probe.reported.length, 2)
  assert.match(probe.reported[1][0], /acp_tool/)
})
