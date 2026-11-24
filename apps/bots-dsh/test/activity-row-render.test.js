// #2061 (PLAN-S6R S1, C11): the activity row rendered by the React DSH ships reads this window's
// crossing pick (`actions.picking`, `actions.subscribePicks`): no row while the part is marked,
// the row again once the mark ends and its listener fires.
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
// DSH ships React as module-loader seeds, not an npm peer. Evaluate only the published seed
// prefix, never its application bootstrap or network operations.
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
  stdin: { contents: "export { ActivityIndicator } from './activity-row.js'", resolveDir: join(plugin, 'src/client') },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('C11 the activity row stays away while this window marks the part, and shows once the mark ends', async (t) => {
  const dom = new JSDOM('<div id="root"></div><div data-conversation-scroll><div data-chat-flow></div></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire,
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    console, setTimeout, clearTimeout, Promise, Map, Set, Date, Math, JSON,
  })
  // Bot b1, its current part p1, running a turn.
  const bot = { id: 'b1', name: 'Ops', sessionId: 'p1' }
  const roster = { byId: { b1: bot, p1: bot }, roomsById: {} }
  const status = new Map([['p1', { running: true }]])
  let marked = { p1: true }
  const listeners = new Set()
  const actions = {
    picking: part => marked[part] === true,
    subscribePicks: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    clearLive: () => {},
  }
  const props = {
    sessionId: 'p1', actions,
    useRoster: select => select(roster),
    useSessionStatus: select => select(status),
    useLive: select => select({}),
    useSession: select => select(undefined),
    useWork: select => select({}),
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    flushSync(() => root.unmount())
    dom.window.close()
    globals.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  flushSync(() => root.render(React.createElement(module.exports.ActivityIndicator, props)))
  for (let n = 0; n < 5; n += 1) await tick()
  const row = () => dom.window.document.querySelector('[data-chat-flow] .bt-typing')
  // Booleans only: a failing assert must not inspect a DOM node (the whole window).
  assert.equal(row() === null, true, 'no row while the part is marked')
  assert.equal(listeners.size, 1)
  marked = {}
  flushSync(() => { for (const listener of listeners) listener() })
  for (let n = 0; n < 5; n += 1) await tick()
  assert.equal(row() !== null, true, 'the row shows once the mark ends')
})
