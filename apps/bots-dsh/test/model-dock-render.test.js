// The no-model dock rendered by the React DSH ships (issue #153), not a createElement stub:
// a stub hands `ref` to the component like any prop, while React keeps it for itself, so a
// model route passed as `ref` only fails here (React error 290, a string ref with no owner).
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

// An error boundary stands in for the host's slot: it records what the dock threw.
class Slot extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { this.props.onError(error) }
  render() { return this.state.error ? null : this.props.children }
}

async function renderDock(t, { models, defaultModel = models[0]?.ref }) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire,
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    console, setTimeout, clearTimeout, Promise, Map, Set,
  })
  const errors = []
  const consoleError = console.error
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  const picked = []
  const patches = []
  const bot = { id: 'chief', name: 'Omni' }
  const roster = { ready: true, byId: { chief: bot }, models, defaultModel }
  const actions = { updateBot: (id, patch) => { picked.push([id, patch.model]); patches.push(patch); return Promise.resolve() }, refreshModels: () => {} }
  const caught = []
  const root = createRoot(dom.window.document.getElementById('root'))
  flushSync(() => root.render(React.createElement(Slot, { onError: error => caught.push(error) },
    React.createElement(module.exports.ModelChoiceDock, { sessionId: bot.id, useRoster: select => select(roster), actions }))))
  await tick()
  t.after(() => {
    flushSync(() => root.unmount())
    console.error = consoleError
    dom.window.close()
    globals.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  return { document: dom.window.document, caught, errors, picked, patches }
}

const models = [
  { ref: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
]

test('a Bot with no model renders its dock in React: the offered model, Start and change', async (t) => {
  const { document, caught, errors, picked } = await renderDock(t, { models })
  assert.deepEqual(caught.map(error => error.message), [], 'the dock renders without crashing its slot')
  assert.deepEqual(errors.filter(line => /#290|string ref/i.test(line)), [], 'React reports no string ref')
  const dock = document.querySelector('.bt-model-dock')
  assert.ok(dock, 'the no-model dock is on screen')
  assert.match(dock.querySelector('.bt-bubble').textContent, /Say when, and I'll start/)
  // The line names the model the Bot would start on: DSH's default.
  assert.equal(dock.querySelector('.bt-model-line-text').textContent, 'Using DeepSeek Flash · Native · DeepSeek')
  const change = dock.querySelector('.bt-model-line .bt-model-change')
  assert.ok(change, 'the line has its "change" link')
  // "change" opens the model menu on the routes, the offered one marked; Native's models are
  // the next step, and picking another gives the Bot that one.
  flushSync(() => change.click())
  await tick()
  const routes = [...document.body.querySelectorAll('.bt-model-menu [role="menuitem"][data-route]')]
  assert.deepEqual(routes.map(row => row.querySelector('.bt-menu-label').textContent), ['Native', 'ACP', 'Herdr', 'Remote Hermes'])
  assert.deepEqual(routes.filter(row => row.hasAttribute('data-current')).map(row => row.querySelector('.bt-menu-hint').textContent), ['DeepSeek'])
  flushSync(() => routes[0].click())
  await tick()
  const own = [...document.body.querySelectorAll('.bt-model-menu [role="menuitemradio"]')]
  assert.deepEqual(own.filter(row => row.getAttribute('aria-checked') === 'true').map(row => row.title), ['deepseek-official/deepseek-flash'])
  // Since v0.3.6 only the provider of the current model is open; the others fold behind their name.
  const fold = [...document.body.querySelectorAll('.bt-model-menu .bt-model-group-toggle')].find(row => row.textContent === 'Ollama')
  assert.equal(fold.getAttribute('aria-expanded'), 'false')
  flushSync(() => fold.click())
  await tick()
  flushSync(() => document.body.querySelector('.bt-model-menu [role="menuitemradio"][title="local/flash"]').click())
  await tick()
  // A closed menu lingers only for its exit (useLinger), marked as leaving.
  const gone = () => document.body.querySelector('.bt-model-menu:not([data-leaving])') === null
  assert.ok(gone(), 'a model with no levels applies and closes the menu')
  // Start picks the offered model for the Bot.
  const start = [...dock.querySelectorAll('button')].find(button => button.textContent === 'Start')
  flushSync(() => start.click())
  await tick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'deepseek-official/deepseek-flash']])
})

test('the dock offers the first model that can run when DSH\'s default cannot', async (t) => {
  const { document, caught } = await renderDock(t, { models: [{ ...models[0], needsKey: true }, models[1]] })
  assert.deepEqual(caught.map(error => error.message), [])
  assert.equal(document.querySelector('.bt-model-line-text').textContent, 'Using DeepSeek Flash · Native · Ollama')
})

test('the model menu works from the keyboard: arrows move, Right opens a step, Escape goes back one', async (t) => {
  const levels = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
  const { document, picked } = await renderDock(t, { models: [{ ...models[0], reasoning: levels }, models[1]] })
  const window = document.defaultView
  const change = document.querySelector('.bt-model-line .bt-model-change')
  const key = (target, name) => flushSync(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })))
  // A click with no pointer (Enter on the link) puts the focus on the current route.
  flushSync(() => change.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })))
  await tick()
  const menu = document.querySelector('.bt-model-menu')
  assert.equal(menu.getAttribute('role'), 'menu')
  assert.equal(document.activeElement.querySelector('.bt-menu-label').textContent, 'Native')
  key(document.activeElement, 'ArrowDown')
  assert.equal(document.activeElement.querySelector('.bt-menu-label').textContent, 'ACP')
  key(document.activeElement, 'ArrowUp')
  key(document.activeElement, 'ArrowRight')
  await tick()
  // Step 2: the focus is on the model the Bot would run on, which has levels.
  assert.equal(document.activeElement.title, 'deepseek-official/deepseek-flash')
  assert.equal(document.activeElement.getAttribute('aria-haspopup'), 'menu')
  key(document.activeElement, 'ArrowRight')
  await tick()
  const levelRows = [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')]
  assert.deepEqual(levelRows.map(row => row.textContent), ['Default', 'Low', 'High'])
  // Escape goes back one step at a time, then closes.
  key(document.activeElement, 'Escape')
  await tick()
  // The other provider's models stay folded behind its name.
  assert.ok([...document.querySelectorAll('.bt-model-menu .bt-model-group-toggle')].some(row => row.textContent === 'Ollama') && document.querySelector('.bt-model-menu [title="deepseek-official/deepseek-flash"]'), 'back on Native\'s models')
  key(document.activeElement, 'Escape')
  await tick()
  assert.ok(document.querySelector('.bt-model-menu [data-current]'), 'back on the routes')
  key(document.activeElement, 'Escape')
  await tick()
  assert.equal(document.querySelector('.bt-model-menu:not([data-leaving])'), null)
  assert.equal(document.activeElement, change)
  assert.deepEqual(picked, [])
})

// The offered model stands in for one the Bot does not have yet: a level picked on it saves
// the model first, then the level, and "Default" saves the model alone.
for (const [label, effort] of [['High', 'high'], ['Default', undefined]]) {
  test(`picking the offered model's ${label} level in the dock saves the model too`, async (t) => {
    const levels = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
    const { document, patches } = await renderDock(t, { models: [{ ...models[0], reasoning: levels }, models[1]] })
    flushSync(() => document.querySelector('.bt-model-line .bt-model-change').click())
    await tick()
    flushSync(() => [...document.querySelectorAll('.bt-model-menu [role="menuitem"]')].find(row => row.textContent.startsWith('Native')).click())
    await tick()
    flushSync(() => document.querySelector('.bt-model-menu [title="deepseek-official/deepseek-flash"]').click())
    await tick()
    flushSync(() => [...document.querySelectorAll('.bt-model-menu [role="menuitemradio"]')].find(row => row.textContent === label).click())
    await tick()
    await tick()
    assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ model: 'deepseek-official/deepseek-flash' }, ...(effort ? [{ effort }] : [])])
  })
}
