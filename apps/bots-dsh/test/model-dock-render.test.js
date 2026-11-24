// The no-model dock rendered by the React DSH ships (issue #153), not a createElement stub:
// a stub hands `ref` to the component like any prop, while React keeps it for itself, so a
// model route passed as `ref` only fails here (React error 290, a string ref with no owner).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

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
  stdin: { contents: `
    export * from './model-menu.js'
    export { call } from './api.js'
    export { teamActions } from './team-actions.js'
  `, resolveDir: join(plugin, 'src/client') },
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

async function renderDock(t, { models, defaultModel = models[0]?.ref, recovery }) {
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
    console, setTimeout, clearTimeout, Promise, Map, Set, fetch: recovery?.fetch,
  })
  const errors = []
  const consoleError = console.error
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  const picked = []
  const patches = []
  const bot = recovery?.bot ?? { id: 'chief', name: 'Omni' }
  const roster = { ready: true, byId: { [bot.sessionId ?? bot.id]: bot }, models, defaultModel }
  const actions = { updateBot: (id, patch) => { picked.push([id, patch.model]); patches.push(patch); return Promise.resolve() }, refreshModels: () => {} }
  if (recovery) Object.assign(actions, module.exports.teamActions({ call: module.exports.call, after: promise => promise }),
    recovery.refresh === undefined ? {} : { refreshModels: recovery.refresh })
  const caught = []
  const root = createRoot(dom.window.document.getElementById('root'))
  flushSync(() => root.render(React.createElement(Slot, { onError: error => caught.push(error) },
    React.createElement(module.exports.ModelChoiceDock, { sessionId: bot.sessionId ?? bot.id, useRoster: select => select(roster), actions }))))
  await tick()
  t.after(() => {
    flushSync(() => root.unmount())
    console.error = consoleError
    dom.window.close()
    globals.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  return { document: dom.window.document, caught, errors, picked, patches, call: module.exports.call }
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

// A Hermes route keeps RFC 0030 Q7a's refusal (every other crossing carries the conversation
// since 2026-11-23), so the recovery card still meets a refusal from the real host here.
const oldRoute = 'acp-hermes/retired'
const historyReason = 'needs-new-conversation'

async function checkHttpCrossingRefusal(t, { rollover = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crossing-recovery-'))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const provider = oldRoute.split('/')[0]
  const blocked = { kind: 'model', code: rollover ? 'MISSING_CREDENTIAL' : 'MODEL_ACCESS_REQUIRED', provider, at: 1 }
  const bot = { id: 'b1', name: 'Test Bot', role: 'Orchestrator', sessionId: 's1', createdAt: 1,
    model: oldRoute, appliedModel: oldRoute, blocked, ...(rollover ? { segments: [{ sessionId: 's0', endedAt: 1 }] } : {}) }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: [bot.id], bots: { [bot.id]: bot }, rooms: {}, exchanges: [], questions: {},
  }))
  let route
  ctx.connection.fetch.register = options => {
    if (options.path.endsWith('/omni-ui')) route = options
    return () => {}
  }
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  const messages = rollover ? [
    { role: 'user', source: { kind: 'bot', role: 'handoff', handoff: true }, content: [{ type: 'text', text: '[Handoff · part 2]\n## Latest messages\nContinue the report.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
  ] : [{ role: 'user', source: { kind: 'user' } }]
  rt.resolveAgent = async () => ({
    id: 's1', session: { id: 's1', deriveMessages: () => messages },
    ...(!rollover && {
      whenIdle: () => new Promise(() => {}),
      runMaintenance: async fn => fn(),
    }),
  })
  rt.resolveModel = async ref => ref
  rt.assertModelAccess = async () => {}
  const before = structuredClone(rt.botOf(bot.id))
  assert.ok(before.blocked)
  const wire = []
  let refreshed = 0
  let credentialAvailable = false
  if (rollover) {
    // A refresh on mount sees the old catalog. A refresh after the click would clear
    // this MISSING_CREDENTIAL block through the real host model endpoint.
    rt.catalog = async ({ fresh } = {}) => {
      if (fresh && credentialAvailable) rt.unblockBots({ keyed: new Set([provider]) })
      return models
    }
  }
  const { document, call } = await renderDock(t, { models, recovery: {
    bot,
    ...(rollover ? {} : { refresh: () => { refreshed++ } }),
    fetch: async (url, options) => {
      const response = await route.fetch(new Request(new URL(url, 'http://localhost/'), options))
      wire.push(await response.clone().json())
      return response
    },
  } })
  if (rollover) {
    assert.equal(wire.length, 1, 'the initial model refresh settled')
    assert.equal(wire.shift().ok, true)
    assert.deepEqual(rt.botOf(bot.id).blocked, before.blocked)
    credentialAvailable = true
  }
  const initialRefreshes = refreshed
  const choice = document.querySelector('.bt-model-choice-chips button')
  assert.ok(choice)
  flushSync(() => choice.click())
  await tick()
  await tick()
  assert.deepEqual(rt.botOf(bot.id).blocked, before.blocked)
  assert.equal(wire.length, 1)
  assert.equal(wire[0].ok, false)
  assert.deepEqual(wire[0].error, {
    code: 'bot/refused', reason: historyReason, details: {},
    message: `${bot.name}'s conversation has history, so changing to Native needs a new conversation. Use New conversation, then pick Native.`,
  })
  assert.equal(document.querySelector('.bt-model-error[role="alert"]')?.textContent, wire[0].error.message)
  assert.equal(choice.disabled, false)
  assert.equal(refreshed, initialRefreshes)
  assert.deepEqual(rt.botOf(bot.id).blocked, before.blocked)
  assert.equal(rt.botOf(bot.id).model, before.model)
  assert.equal(rt.switchingChat(bot.id), false)
  await assert.rejects(call('switch-route', { id: bot.id, model: models[0].ref }), {
    code: 'bot/refused', reason: historyReason,
  })
  assert.deepEqual(rt.botOf(bot.id).blocked, before.blocked)

  for (const [code, reason] of [['bot/refused', 'unrelated'], ['bot/invalid', historyReason]]) {
    rt.assertModelAccess = async () => { throw Object.assign(new Error('Unavailable.'), { code, reason }) }
    await assert.rejects(call('switch-route', { id: bot.id, model: models[0].ref }), { code })
    assert.deepEqual(wire.at(-1).error, { code, message: 'Unavailable.', details: {} })
  }
}

test('the real HTTP crossing refusal leaves the recovery card terminal and the turn block intact', t => checkHttpCrossingRefusal(t))

test('the HTTP recovery card is terminal for a hookless rollover and preserves the credential block', t =>
  checkHttpCrossingRefusal(t, { rollover: true }))

test('only the history refusal reason is rebuilt and stops a recovery refresh', async t => {
  const bot = { id: 'b1', model: oldRoute }
  const message = 'Use New conversation before picking again.'
  let refreshed = 0
  let error = { code: 'bot/refused', reason: historyReason, message }
  const { document, call } = await renderDock(t, { models, recovery: {
    bot, refresh: () => { refreshed++ },
    fetch: async () => Response.json({ ok: false, error }),
  } })
  await assert.rejects(call('switch-route', {}), { code: 'bot/refused', reason: historyReason })
  const choice = document.querySelector('.bt-model-choice-chips button')
  const initialRefreshes = refreshed
  flushSync(() => choice.click())
  await tick()
  assert.equal(document.querySelector('.bt-model-error[role="alert"]')?.textContent, message)
  assert.equal(refreshed, initialRefreshes)

  for (error of [{ code: 'bot/refused', reason: 'other', message }, { code: 'bot/invalid', reason: historyReason, message }]) {
    await assert.rejects(call('switch-route', {}), failure => failure.code === error.code && !Object.hasOwn(failure, 'reason'))
  }
  flushSync(() => choice.click())
  await tick()
  assert.equal(refreshed, initialRefreshes + 1)
})
