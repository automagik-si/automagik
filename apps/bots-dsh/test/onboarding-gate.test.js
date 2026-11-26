import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const harness = createRequire(join(plugin, 'dev/harness/package.json'))
const { JSDOM } = harness('jsdom')
const assets = join(harness.resolve('@deepseek-ai/dsh-web-frontend/package.json'), '../dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the pinned web frontend supplies React, Cordis and Slots')
const { outputFiles: [browser] } = await build({
  stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})

export function source(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of listeners) fn() },
  }
}

export function browserFixture(t, fetch = () => assert.fail('unexpected network')) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const frame = window.requestAnimationFrame.bind(window)
  const context = createContext({
    window, document: window.document, navigator: window.navigator, location: window.location,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    MutationObserver: window.MutationObserver, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event,
    InputEvent: window.InputEvent, KeyboardEvent: window.KeyboardEvent, Range: window.Range,
    getSelection: window.getSelection.bind(window), matchMedia: (...args) => window.matchMedia(...args),
    console, setTimeout, clearTimeout, queueMicrotask, performance, TextEncoder, TextDecoder, URL, AbortController,
    requestAnimationFrame: frame, cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), fetch,
  })
  runInContext(browser.text, context)
  const seeds = context.nativeSeeds
  const modules = new Map()
  const require = name => {
    if (Object.hasOwn(seeds, name)) return seeds[name]
    if (modules.has(name)) return modules.get(name)
    if (name.startsWith('@deepseek-ai/')) return load(name)
    throw new Error(`missing pinned browser module ${name}`)
  }
  require.asset = path => new URL(path, 'http://localhost/fixture-assets/').href
  function load(name, internal = []) {
    if (modules.has(name)) return modules.get(name)
    let factory
    window.__ModuleLoader__ = { load: row => { factory = row.factory } }
    const installed = readFileSync(harness.resolve(`${name}/client`), 'utf8')
    const source = internal.length === 0 ? installed : installed.replace(/return module\.exports(?=\}\}\);)/,
      `Object.assign(module.exports, { ${internal.join(', ')} }); return module.exports`)
    runInContext(source, context)
    assert.equal(typeof factory, 'function', name)
    const value = factory(require)
    for (const key of internal) assert.ok(value[key], `${name} fixture could not reach ${key}`)
    modules.set(name, value)
    return value
  }
  const evaluate = text => {
    const module = { exports: {} }
    Object.assign(context, { module, exports: module.exports, require })
    runInContext(text, context)
    return module.exports
  }
  const h = seeds.react.createElement
  const root = window.document.querySelector('#root')
  root.inert = false
  const cleanups = []
  t.after(async () => {
    for (const dispose of cleanups.reverse()) await dispose()
    window.close()
  })
  return { context, window, root, load, evaluate, h, seeds, cleanups, tick: () => new Promise(done => frame(() => frame(done))) }
}

const gateFile = join(plugin, 'src/client/onboarding-gate.js')
const gate = existsSync(gateFile) ? (await build({
  entryPoints: [gateFile], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react'],
})).outputFiles[0].text : undefined

const WELCOME = [['omni-companion', -300], ['omni-team', -270], ['omni-migrate', -230], ['omni-connect-ai', -200]]
const allDone = { companionDone: true, teamDone: true, migrateDone: true, connectAiDone: true }
const empty = { ready: false, rooms: [], roomsById: {}, tasks: {}, byId: {}, agentOf: {} }
const room = { id: 'room', parts: ['member-session'] }
const ready = {
  ...empty, ready: true, rooms: [room], roomsById: { room },
  tasks: { task: {} }, byId: { bot: {} }, agentOf: { adopted: 'agent' },
}

const listFor = (id, blank = true) => ({
  phase: 'ready', byId: id === undefined ? {} : { [id]: { id, blank, retainedBy: { mainView: 1 } } },
})

export function mountSettings(browser, { roster, sessions, mainView, flagState = () => ({}) }) {
  const { h, seeds, load, evaluate, root, window, cleanups } = browser
  const ctx = new seeds['@deepseek-ai/cordis'].Context()
  cleanups.push(() => ctx.fiber.dispose())
  const locale = { ...source({ revision: 0 }), bind: () => key => key, register: () => () => {} }
  ctx.reflect.provide('connection', { state: source('connected'), reconnect() {} })
  ctx.reflect.provide('locale', locale)
  ctx.reflect.provide('shortcuts', { catalog: source([]), register: () => () => {} })
  ctx.reflect.provide('remote', { $host: { isLoopback: false } })
  ctx.reflect.provide('remoteAccess', { whenAccess: (_id, fn) => fn() })
  load('@deepseek-ai/dsh-client-ui-renderer').apply(ctx)
  ctx.slots.installLocale(locale)
  ctx.slots.installScope('session', { current: source({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }) })
  ctx.slots.provideRoot({ hooks: { sessions } })
  ctx.slots.register({
    name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
  }, ({ renderSlot }) => h('main', {}, renderSlot('sidebar.settings', { wide: true })))
  load('@deepseek-ai/dsh-client-ui-settings-general').apply(ctx)
  if (gate !== undefined) cleanups.push(evaluate(gate).installOnboardingGate(ctx, { roster, mainView, sessions }))

  const rendered = []
  for (const [id, order] of [...WELCOME, ['deepseek-official', 0]]) {
    ctx.slots.register({ name: 'settings.onboarding', id, order }, function Step({ explicit, complete }) {
      seeds.react.useEffect(() => {
        if (explicit || !flagState()[id]) return
        complete()
      }, [explicit, complete])
      seeds.react.useEffect(() => {
        rendered.push(id)
        root.inert = true
        return () => { root.inert = false }
      }, [])
      return seeds['react-dom'].createPortal(
        h('div', { role: 'dialog', className: 'oai-overlay', 'data-step': id },
          h('button', { type: 'button', onClick: complete }, 'Continue')), window.document.body,
      )
    })
  }
  const openExplicit = () => window.document.querySelector('[data-explicit]').click()
  ctx.slots.register({ name: 'settings.launcher' }, ({ openOnboarding }) =>
    h('button', { type: 'button', 'data-explicit': '', onClick: () => openOnboarding('deepseek-official') }, 'Sign in'))
  cleanups.push(ctx.get('uiRenderer').mount(root))
  return {
    ctx, rendered, openExplicit,
    step: () => window.document.querySelector('[role=dialog]')?.dataset.step,
    next: () => window.document.querySelector('[role=dialog] button').click(),
    gateIds: () => ctx.slots.entries('settings.onboarding')
      .filter(entry => entry.options.id.startsWith('bot-team-gate-'))
      .map(entry => ({ id: entry.options.id, order: entry.options.order })),
  }
}

function fixture(t, { id, initial = ready, flags = {}, failure = false } = {}) {
  let value = flags
  const reads = []
  const roster = source(initial)
  const sessions = source(listFor(id))
  const browser = browserFixture(t, async (url, request) => {
    assert.equal(url, 'api/omni-ai')
    assert.equal(request.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(request.body), { endpoint: 'state', payload: null })
    reads.push(id)
    if (failure) throw new Error('fixture state unavailable')
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  const settings = mountSettings(browser, { roster, sessions, mainView: () => id })
  return {
    ...browser, ...settings, roster, reads, finishFlags: () => { value = allDone },
    show(next) { id = next; sessions.set(listFor(id)) },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('T8 retained blank room never mounts a step while the roster settles', async t => {
    const ui = fixture(t, { id: 'room', initial: empty })
    await ui.tick()
    ui.roster.set(ready)
    await ui.tick()
    assert.deepEqual(ui.rendered, [], 'welcome rendered on the retained blank room')
    assert.equal(ui.root.inert, false)
  })

  test('T8 blank navigation re-keys the gate and restores the same unfinished step', async t => {
    const ui = fixture(t, { id: 'mine' })
    await ui.tick()
    assert.equal(ui.step(), 'omni-companion')
    ui.next()
    await ui.tick()
    assert.equal(ui.step(), 'omni-team')
    const first = ui.gateIds()
    ui.show('task')
    await ui.tick()
    assert.equal(ui.step(), undefined, 'a welcome step survived a blank-to-task switch')
    assert.equal(ui.root.inert, false)
    const second = ui.gateIds()
    ui.show('mine')
    await ui.tick()
    assert.equal(ui.step(), 'omni-team')
    const third = ui.gateIds()
    for (const entry of [first, second, third]) {
      assert.equal(entry.length, 1)
      assert.equal(entry[0].order, -1000)
    }
    assert.equal(new Set([first[0].id, second[0].id, third[0].id]).size, 3)
  })

  for (const id of ['member-session', 'room', 'bot', 'adopted']) {
    test(`T8 all applicable flags suppress the blank ${id} view`, async t => {
      const ui = fixture(t, { id, flags: allDone })
      await ui.tick()
      assert.equal(ui.step(), undefined, `onboarding appeared in ${id}`)
      assert.equal(ui.root.inert, false)
      assert.equal(ui.reads.length, ['bot', 'adopted'].includes(id) ? 1 : 0)
    })
  }

  for (const [label, options] of [
    ['first run without a main view', {}],
    ['the person’s blank Session', { id: 'mine' }],
    ['a welcome state read failure in a Bot chat', { id: 'bot', failure: true }],
  ]) {
    test(`T9 control shows onboarding for ${label}`, async t => {
      const ui = fixture(t, options)
      await ui.tick()
      assert.equal(ui.step(), 'omni-companion')
    })
  }

  test('T9 control keeps partial flags frozen on a Bot view through the DSH step', async t => {
    const ui = fixture(t, { id: 'bot', flags: { companionDone: true } })
    await ui.tick()
    ui.finishFlags()
    for (const [id] of WELCOME) {
      assert.equal(ui.step(), id)
      ui.next()
      await ui.tick()
    }
    assert.equal(ui.step(), 'deepseek-official')
    assert.ok(ui.reads.length <= 1)
  })

  test('T9 control permits explicit DSH sign-in in a room', async t => {
    const ui = fixture(t, { id: 'room' })
    ui.openExplicit()
    await ui.tick()
    assert.equal(ui.step(), 'deepseek-official')
  })

  test('T9b bundle registers the first onboarding step', () => {
    const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(bundle, /bot-team-gate-/)
    assert.match(bundle, /gate Settings onboarding/)
  })
}
