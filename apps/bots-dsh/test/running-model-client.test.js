// Running selections affect only the current composer trigger; picks stay on the saved model.
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
  entryPoints: [join(plugin, 'src/client/model-menu.js')],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

const savedRef = 'deepseek/saved'
const runningRef = 'acp-codex/other'
const models = [
  { ref: savedRef, provider: 'deepseek', providerName: 'DeepSeek', name: 'Saved Model', reasoning: { efforts: [{ id: 'low', name: 'Saved Low' }], defaultEffort: 'low' } },
  { ref: runningRef, provider: 'acp-codex', providerName: 'Codex', name: 'Running Model', reasoning: { efforts: [{ id: 'high', name: 'Running High' }] } },
]

async function renderMenu(t, { bot: overrides = {}, catalog = models, running = true, bar = true } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const savedGlobals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire,
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    console, setTimeout, clearTimeout, Promise, Map, Set,
  })
  const asked = []
  const patches = []
  const bot = { id: 'chief', sessionId: 'current-part', name: 'Test Bot', model: savedRef, appliedModel: savedRef, effort: 'low', runningModel: runningRef, runningEffort: 'high', ...overrides }
  const roster = { ready: true, byId: { chief: bot }, models: catalog, defaultModel: savedRef }
  const actions = {
    updateBot: (id, patch) => { patches.push([id, patch]); return Promise.resolve() },
    refreshModels: () => {},
    efforts: ref => { asked.push(ref); return Promise.resolve(null) },
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    flushSync(() => root.unmount())
    dom.window.close()
    globals.forEach((key, index) => savedGlobals[index] ? Object.defineProperty(globalThis, key, savedGlobals[index]) : delete globalThis[key])
  })
  flushSync(() => root.render(React.createElement(module.exports.ModelMenu, { bot, roster, actions, run: promise => promise, running, bar, chat: true })))
  await tick()
  return { document: dom.window.document, trigger: dom.window.document.querySelector('.bt-model-trigger'), asked, patches }
}

const effort = trigger => trigger.querySelector('.bt-model-bar-effort:not([data-running-instead])')?.textContent
const assertSaved = trigger => {
  assert.equal(trigger.querySelector('.bt-model-bar-name').textContent, 'Saved Model')
  assert.equal(trigger.querySelector('[data-running-instead]'), null)
  assert.equal(trigger.hasAttribute('title'), false)
  assert.equal(trigger.getAttribute('aria-label'), 'Model: Saved Model')
  assert.equal(trigger.getAttribute('data-route'), 'native')
  assert.equal(effort(trigger), 'Saved Low')
}

test('the composer names the running model, route and catalog effort, with the saved model in its marker', async t => {
  const { trigger, asked } = await renderMenu(t)
  assert.equal(trigger.querySelector('.bt-model-bar-name').textContent, 'Running Model')
  const marker = trigger.querySelector('span.bt-model-bar-effort[data-running-instead]')
  assert.equal(marker.textContent, 'instead of Saved Model')
  assert.equal(marker.previousElementSibling.textContent, 'Running High')
  assert.equal(trigger.title, 'Running instead of Saved Model')
  assert.equal(trigger.getAttribute('aria-label'), 'Model: Running Model. Running instead of Saved Model')
  assert.equal(trigger.getAttribute('data-route'), 'acp')
  assert.equal(effort(trigger), 'Running High')
  assert.deepEqual(asked, [])
})

for (const [name, options] of [
  ['the same full ref (including an effort-only difference)', { bot: { runningModel: savedRef, runningEffort: 'high' } }],
  ['no running model', { bot: { runningModel: undefined } }],
  ['an earlier part with running=false', { running: false }],
  ['a non-string running model', { bot: { runningModel: 42 } }],
]) {
  test(`${name} keeps today's composer rendering`, async t => {
    assertSaved((await renderMenu(t, options)).trigger)
  })
}

test('a non-bar menu keeps its saved display without a marker or title', async t => {
  const { trigger } = await renderMenu(t, { bar: false })
  assert.equal(trigger.querySelector('.bt-model-name').textContent, 'Saved Model')
  assert.equal(trigger.querySelector('[data-running-instead]'), null)
  assert.equal(trigger.hasAttribute('title'), false)
  assert.equal(trigger.getAttribute('aria-label'), 'Model: Saved Model')
  assert.equal(trigger.getAttribute('data-route'), 'native')
})

test('equal labels from different providers still show the marker', async t => {
  const { trigger } = await renderMenu(t, { catalog: [models[0], { ...models[1], name: 'Saved Model' }] })
  assert.equal(trigger.querySelector('.bt-model-bar-name').textContent, 'Saved Model')
  assert.equal(trigger.querySelector('[data-running-instead]').textContent, 'instead of Saved Model')
  assert.equal(trigger.title, 'Running instead of Saved Model')
})

for (const [name, options] of [
  ['unknown effort', { bot: { runningEffort: 'unknown' } }],
  ['missing effort', { bot: { runningEffort: undefined } }],
  ['missing catalog reasoning', { catalog: [models[0], { ...models[1], reasoning: undefined }] }],
  ['uncatalogued running model', { bot: { runningModel: 'local/uncatalogued' } }],
]) {
  test(`${name} shows no saved effort and fetches no running efforts`, async t => {
    const { trigger, asked } = await renderMenu(t, options)
    assert.equal(effort(trigger), undefined)
    assert.ok(trigger.querySelector('[data-running-instead]'))
    assert.deepEqual(asked, [])
  })
}

test('the open menu still marks and saves the saved model and its effort', async t => {
  const { document, trigger, patches } = await renderMenu(t)
  flushSync(() => trigger.click())
  await tick()
  const native = document.querySelector('.bt-model-menu [data-route="native"]')
  assert.ok(native.hasAttribute('data-current'))
  assert.equal(document.querySelector('.bt-model-menu [data-route="acp"]').hasAttribute('data-current'), false)
  flushSync(() => native.click())
  await tick()
  const saved = document.querySelector(`.bt-model-menu [title="${savedRef}"]`)
  assert.equal(saved.getAttribute('aria-checked'), 'true')
  flushSync(() => saved.click())
  await tick()
  const level = [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')].find(row => row.textContent === 'Saved Low')
  assert.equal(level.getAttribute('aria-checked'), 'true')
  const defaultLevel = [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')].find(row => row.textContent === 'Default')
  flushSync(() => defaultLevel.click())
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [['chief', { effort: null }]])
})
