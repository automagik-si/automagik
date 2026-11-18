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
// DSH ships React as module-loader seeds, not an npm peer. Evaluate only the
// published seed prefix, never its application bootstrap or network operations.
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
const act = async fn => { let result; flushSync(() => { result = fn() }); await result; await tick() }
const { outputFiles } = await build({
  stdin: { contents: "export { apply, omni } from './src/client/index.js'; export { TeamSidebar } from './src/client/sidebar.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: process.env.ISSUE155_BASELINE ? [{ name: 'baseline', setup(build) {
    build.onLoad({ filter: /src\/client\/(index|sidebar)\.js$/ }, args => ({ contents: readFileSync(join(process.env.ISSUE155_BASELINE, `${args.path.endsWith('index.js') ? 'index' : 'sidebar'}.js`), 'utf8'), resolveDir: dirname(args.path), loader: 'js' }))
  } }] : [],
})
const source = value => {
  let current = value
  const listeners = new Set()
  return { getSnapshot: () => current, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, set: value => { current = value; for (const fn of listeners) fn() } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
// Expose only the existing native class for the test. Its real openWorkspace ->
// connectBlank -> createInWorkspace chain runs; only transport and retention are fake.
let nativeWorkspace, nativeConversation
runInNewContext(readFileSync(join(harness, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load: record => { nativeConversation = record.factory(name => name === '@deepseek-ai/cordis' ? { ...nativeRequire(name), Service: class { constructor(ctx, name) { this.ctx = ctx; ctx[name] = this } } } : nativeRequire(name)) } } },
  AbortController, AbortSignal, console, setTimeout, clearTimeout,
})
const workspaceBundle = readFileSync(join(harness, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8')
const workspaceTail = /return module\.exports;?(?=\s*\}\s*\}\);)/
assert.match(workspaceBundle, workspaceTail, 'the published workspace bundle must expose its factory return')
runInNewContext(workspaceBundle.replace(workspaceTail, 'exports.NavigationForTest = UiWorkspaceService; return module.exports;'), {
  window: { __ModuleLoader__: { load: record => { nativeWorkspace = record.factory(nativeRequire).NavigationForTest } } },
  AbortController, AbortSignal, console, setTimeout, clearTimeout,
})

async function start(t, { advanced = false, model, delay = false, reject = false, refuse = undefined, standalone = false, herdr = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT']
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const main = { id: 'main', sessionId: 'main', name: 'Main', createdAt: 1 }
  const brain = { id: 'brain', sessionId: 'brain', name: 'Brain', kind: 'dsh', dshAgentId: 'native', profile: 'cordis', workDir: '/original', advanced, ...(model ? { model } : {}), ...(herdr ? { type: 'herdr', sessionId: undefined } : {}), createdAt: 2 }
  const bots = standalone ? [main] : [main, brain]
  const agents = standalone ? [{ id: 'native', kind: 'dsh', name: 'Standalone', sessions: ['brain'], createdAt: 2 }] : []
  const list = source({ ids: ['main', 'brain'], byId: { main: { id: 'main', blank: false }, brain: { id: 'brain', blank: true, retainedBy: { mainView: 1 } } } })
  const workspaceList = source({ items: [{ workspaceId: 'original', sessionIds: ['brain'] }] })
  const calls = [], opened = [], panels = [], registrations = [], effects = [], disposers = []
  let revision = 1, pauseNextState = false
  const stateRegistrations = []
  const retain = id => {
    const rows = Object.fromEntries(Object.entries(list.getSnapshot().byId).map(([key, row]) => [key, { ...row, retainedBy: { mainView: key === id ? 1 : 0 } }]))
    list.set({ ids: Object.keys(rows), byId: rows })
  }
  const fetch = async (_url, options) => {
    const { endpoint, payload } = JSON.parse(options.body)
    calls.push({ endpoint, payload })
    if (endpoint === 'state' && pauseNextState) {
      pauseNextState = false
      await new Promise(resolve => stateRegistrations.push(resolve))
    }
    if (endpoint === 'bot-session-adopt') {
      if (delay) await new Promise((resolve, fail) => registrations.push({ resolve, fail }))
      if (reject) throw new Error('registration rejected')
      if (refuse !== undefined) return { ok: true, json: async () => ({ ok: false, error: refuse }) }
      brain.segments = [...(brain.segments ?? []), { sessionId: brain.sessionId, endedAt: 3 }]
      brain.sessionId = payload.sessionId
      revision++
    }
    if (endpoint === 'agent-adopt') { agents[0].sessions.push(payload.sessionId); revision++ }
    const value = endpoint === 'state' ? { revision, bots, rooms: [], agents, mainBotId: 'main', mainBotIds: ['main'], models: [], questions: {}, exchangeTurns: {} } : { sessionId: payload.sessionId }
    return { ok: true, json: async () => ({ ok: true, value }) }
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nativeRequire(name),
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator,
    Element: dom.window.Element, MutationObserver: dom.window.MutationObserver, fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, AbortController, performance,
  })
  const slots = { entries: () => [], inject: () => () => {}, register: () => () => {} }
  const ctx = {
    effect: (fn, label) => { effects.push({ fn, label }); return () => {} },
    get: name => name === 'workspaces' ? { list: workspaceList } : undefined,
    sessions: { list, refresh: async () => {}, refreshProjections: async () => {} },
    uiWorkspace: { openSession: id => { opened.push(id); retain(id) } },
    inject: () => () => {}, uiConversation: {}, slots, layout: { panelInfo: source({}), selectPanel: name => panels.push(name) },
  }
  module.exports.apply(ctx)
  for (const label of ['ds-bot: roster poll', 'ds-bot: agent surface', 'ds-bot: face for other Omni plugins']) disposers.push(effects.find(effect => effect.label === label).fn())
  await act(tick)
  const face = module.exports.omni.face()
  const hook = store => pick => React.useSyncExternalStore(store.subscribe, () => pick(store.getSnapshot()))
  const empty = source({})
  const root = createRoot(dom.window.document.getElementById('root'))
  const sidebar = React.createElement(module.exports.TeamSidebar, {
    wide: false, actions: face.actions, useRoster: hook(face.hooks.roster), useUi: hook(face.hooks.ui), useSessions: hook(list),
    useRegistry: hook(empty), useUpdate: hook(source({ available: false })), useActivity: hook(empty), useWork: hook(source({ approvals: [] })),
    useSessionStatus: hook(source(new Map())), useSessionRetainInfo: (_id, pick) => pick(undefined),
  })
  function Shell() {
    const mode = hook(face.hooks.surface)(value => value.mode)
    return mode === 'bot' ? sidebar : null
  }
  await act(async () => root.render(React.createElement(Shell)))
  t.after(async () => {
    await act(async () => root.unmount())
    for (const dispose of disposers.reverse()) dispose?.()
    dom.window.close()
    globals.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  const surfaceTransitions = []
  disposers.push(face.hooks.surface.subscribe(() => surfaceTransitions.push(face.hooks.surface.getSnapshot().plain)))
  const nativeCreates = []
  let destination
  const navigation = Object.create(nativeWorkspace.prototype)
  Object.assign(navigation, {
    ctx: { layout: { beginNavigation: () => new AbortController().signal } }, connecting: new Map(), lifetime: new AbortController(),
    workspaces: { list: workspaceList }, notify: value => { throw new Error(value.message) },
    sessions: { list, create: async request => {
      nativeCreates.push(request)
      const rows = list.getSnapshot().byId
      const { id, blank, parentId, workspaceId } = destination
      list.set({ ids: [...new Set([...Object.keys(rows), id])], byId: { ...rows, [id]: { id, blank, parentId, cwd: `/${workspaceId}` } } })
      return request.sessionId ?? id
    }, fork: async request => {
      const rows = list.getSnapshot().byId
      const id = destination.id
      list.set({ ids: [...Object.keys(rows), id], byId: { ...rows, [id]: { id, blank: false, parentId: request.sessionId, cwd: '/original' } } })
      request.onCreated?.(id)
      return id
    } },
    // Retention is the I/O boundary. Draft transfer is unrelated to ownership.
    replaceMain: id => retain(id),
  })
  const nativeSlots = []
  const nativeCtx = {
    sessions: { binding: () => ({}), list }, get: name => name === 'uiWorkspace' ? navigation : undefined,
    slots: { registerFactory: options => { nativeSlots.push(options); return () => {} }, register: () => () => {},
      inject: (_name, fn) => { const result = fn(); if (result?.next) while (!result.next().done) { /* run native slot declarations */ } return () => {} },
      entries: () => [], entriesOfSlot: () => [], subscribe: () => () => {} },
    effect: () => () => {}, inject: () => ({ dispose() {} }), plugin() {},
    locale: { bind: () => key => key, register: () => () => {}, subscribe: () => () => {} },
    configForms: { get: () => undefined, developerTools: { enabled: source(false) } }, uiSession: { provide() {} },
  }
  nativeConversation.apply(nativeCtx, { maxConcurrentFileUploads: 3 })
  const picker = nativeSlots.find(slot => slot.name === 'conversation.content')
  const pick = async (id, { blank = true, parentId, workspaceId = 'selected', reuse = false } = {}) => {
    await act(async () => {
      destination = { id, blank, parentId, workspaceId }
      workspaceList.set({ items: [...workspaceList.getSnapshot().items, { workspaceId, path: `/${workspaceId}`, sessionIds: [id] }], archivedSessionIds: [] })
      if (reuse) {
        const rows = list.getSnapshot().byId
        list.set({ ids: [...Object.keys(rows), id], byId: { ...rows, [id]: { id, blank, cwd: `/${workspaceId}`, projectionValues: { agentPreset: 'standard' } } } })
      }
      const from = Object.values(list.getSnapshot().byId).find(row => row.retainedBy?.mainView)?.id
      await picker.inject(from).selectWorkspace(workspaceId)
      await tick()
    })
  }
  const fork = async (id, source) => {
    await act(async () => {
      destination = { id }
      const child = await navigation.forkSession(source)
      navigation.openSession(child)
      await tick()
    })
  }
  return { pick, fork, calls, opened, panels, brain, list, nativeCreates, surfaceTransitions, registrations, retain, stateRegistrations, pauseState: () => { pauseNextState = true }, actions: face.actions, hooks: face.hooks, current: () => Object.values(list.getSnapshot().byId).find(row => row.retainedBy?.mainView)?.id }
}

test('standalone Agent navigation keeps the separate agent-adopt path and native rendering', async t => {
  const bench = await start(t, { standalone: true })
  await bench.pick('agent-project')
  assert.equal(bench.current(), 'agent-project')
  assert.equal(bench.hooks.roster.getSnapshot().agentOf['agent-project'], 'native')
  assert.equal(bench.hooks.roster.getSnapshot().byId['agent-project'], undefined)
  assert.equal(bench.hooks.surface.getSnapshot().plain, true)
  assert.equal(bench.calls.some(call => call.endpoint === 'bot-session-adopt'), false)
})

test('Agent mode leaves native project ownership alone', async t => {
  const bench = await start(t)
  await act(async () => bench.actions.setSurface('agent'))
  await bench.pick('agent-mode-project')
  assert.equal(bench.current(), 'agent-mode-project')
  assert.equal(bench.calls.some(call => call.endpoint === 'bot-session-adopt' || call.endpoint === 'agent-adopt'), false)
})

test('an unrelated blank from an ordinary Main still lands on Main, and an explicitly opened blank stays', async t => {
  const bench = await start(t)
  await act(async () => bench.retain('main'))
  await bench.pick('unowned')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
  assert.equal(bench.current(), 'main')
  assert.equal(bench.calls.some(call => call.endpoint === 'bot-session-adopt'), false)
  await act(async () => bench.actions.openSession('unowned'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
  assert.equal(bench.current(), 'unowned')
})

test('an empty-view fallback captured before a native destination cannot retarget that destination', async t => {
  const bench = await start(t, { delay: true })
  // Native clearing and attachment are one navigation, before the old empty
  // view's zero-delay fallback gets a chance to run.
  flushSync(() => bench.retain(undefined))
  await bench.pick('after-empty')
  await act(async () => { await bench.actions.landOn('main', null, null); await tick() })
  assert.equal(bench.current(), 'after-empty')
  assert.equal(bench.actions.ownershipPending('after-empty'), true)
  await act(async () => { bench.registrations[0].resolve(); await tick() })
  assert.equal(bench.current(), 'after-empty')
})

test('native picker reuses its chosen default-preset blank without resetting its id', async t => {
  const bench = await start(t)
  await bench.pick('reused-blank', { reuse: true })
  assert.equal(bench.nativeCreates[0].sessionId, 'reused-blank')
  assert.equal(bench.nativeCreates[0].agentPreset, undefined)
  assert.equal(bench.current(), 'reused-blank')
  assert.equal(bench.hooks.roster.getSnapshot().byId['reused-blank'].id, 'brain')
})

test('a fork of the native current part joins Brain but unrelated existing sessions do not', async t => {
  const bench = await start(t)
  await bench.fork('fork', 'brain')
  assert.equal(bench.current(), 'fork')
  assert.equal(bench.hooks.roster.getSnapshot().byId.fork.id, 'brain')
  await bench.pick('existing', { blank: false, workspaceId: 'other' })
  assert.equal(bench.current(), 'existing')
  assert.equal(bench.hooks.roster.getSnapshot().byId.existing, undefined)
  assert.equal(bench.calls.filter(call => call.endpoint === 'bot-session-adopt').length, 1)
})

test('rejected registration retains the actual selected native session and reports failure', async t => {
  const bench = await start(t, { reject: true })
  await bench.pick('rejected')
  assert.equal(bench.current(), 'rejected')
  assert.equal(bench.actions.ownershipPending('rejected'), false)
  assert.equal(bench.hooks.surface.getSnapshot().plain, true)
  assert.equal(bench.hooks.roster.getSnapshot().byId.rejected, undefined)
  assert.equal(bench.brain.sessionId, 'brain')
  assert.ok(bench.hooks.ui.getSnapshot().toast)
  assert.equal(bench.calls.some(call => call.endpoint === 'agent-archive'), false)
})

test('a refused native adoption names the reason and both sides in the toast', async t => {
  const message = 'Session rejected is neither blank nor a fork of the current part of Bot "Brain" (Session brain), so it cannot join it.'
  const bench = await start(t, { refuse: { code: 'bot/adopt-not-blank', message } })
  await bench.pick('rejected')
  assert.equal(bench.current(), 'rejected')
  assert.equal(bench.brain.sessionId, 'brain')
  const toast = bench.hooks.ui.getSnapshot().toast
  assert.ok(toast)
  assert.equal(toast.text, message)
  assert.match(toast.text, /neither blank nor a fork/)
  assert.match(toast.text, /Bot "Brain"/)
  assert.match(toast.text, /Session rejected/)
  assert.equal(bench.calls.filter(call => call.endpoint === 'bot-session-adopt').length, 1)
})

test('rapid native picks serialize their source ownership and stale completion never navigates', async t => {
  const bench = await start(t, { delay: true })
  await bench.pick('first')
  await bench.pick('second', { workspaceId: 'second-project' })
  assert.equal(bench.current(), 'second')
  assert.equal(bench.registrations.length, 1)
  await act(async () => { bench.registrations[0].resolve(); await tick() })
  assert.equal(bench.current(), 'second')
  assert.equal(bench.registrations.length, 2)
  const requests = bench.calls.filter(call => call.endpoint === 'bot-session-adopt')
  assert.equal(requests[1].payload.sourceSessionId, 'first')
  await act(async () => { bench.retain('main'); bench.registrations[1].resolve(); await tick() })
  assert.equal(bench.current(), 'main')
  assert.deepEqual(bench.opened, [])
})

test('three rapid native picks carry the last registered source past a superseded queued destination', async t => {
  const bench = await start(t, { delay: true })
  await bench.pick('first')
  await bench.pick('second', { workspaceId: 'second-project' })
  await bench.pick('third', { workspaceId: 'third-project' })
  assert.equal(bench.registrations.length, 1)
  await act(async () => {
    bench.registrations[0].resolve()
    await tick()
    bench.registrations[1]?.resolve()
    await tick()
  })
  assert.equal(bench.current(), 'third')
  assert.equal(bench.hooks.roster.getSnapshot().byId.third?.id, 'brain', 'latest native destination must become Brain-owned after skipping the queued middle pick')
  const requests = bench.calls.filter(call => call.endpoint === 'bot-session-adopt')
  assert.deepEqual(requests.map(call => call.payload.sessionId), ['first', 'third'])
  assert.equal(requests[1].payload.sourceSessionId, 'first')
  assert.equal(bench.list.getSnapshot().byId.third.cwd, '/third-project')
  assert.equal(bench.brain.profile, 'cordis')
  assert.equal(bench.brain.dshAgentId, 'native')
  assert.deepEqual(bench.opened, [])
})

test('rapid native fork descendants associate their required queued ancestry in order', async t => {
  const bench = await start(t, { delay: true })
  await bench.pick('first')
  await bench.fork('fork-b', 'first')
  await bench.fork('fork-c', 'fork-b')
  // Native attachment can clear the retained view without changing its source.
  flushSync(() => bench.retain(undefined))
  flushSync(() => bench.retain('fork-c'))
  assert.equal(bench.registrations.length, 1)
  await act(async () => {
    bench.registrations[0].resolve()
    await tick()
    bench.registrations[1]?.resolve()
    await tick()
    bench.registrations[2]?.resolve()
    await tick()
  })
  const requests = bench.calls.filter(call => call.endpoint === 'bot-session-adopt')
  assert.deepEqual(requests.map(call => [call.payload.sourceSessionId, call.payload.sessionId]), [
    ['brain', 'first'], ['first', 'fork-b'], ['fork-b', 'fork-c'],
  ], 'selected native fork must retain the actual parent association, not bypass its queued ancestor')
  assert.equal(bench.current(), 'fork-c')
  assert.equal(bench.hooks.roster.getSnapshot().byId['fork-c']?.id, 'brain')
  assert.equal(bench.brain.profile, 'cordis')
  assert.equal(bench.brain.dshAgentId, 'native')
  assert.deepEqual(bench.opened, [])
})

test('an awaited fallback is canceled by an away/back navigation to the same source id', async t => {
  const bench = await start(t)
  bench.pauseState()
  const landing = bench.actions.landOn('main', { botId: 'brain', sessionId: 'brain' }, 'brain')
  assert.equal(bench.stateRegistrations.length, 1)
  await act(async () => { bench.retain('main'); bench.retain('brain'); bench.stateRegistrations[0](); await landing })
  assert.equal(bench.current(), 'brain')
  assert.deepEqual(bench.opened, [])
})

test('awaited fallback cannot hijack a newer native destination', async t => {
  const bench = await start(t, { delay: true })
  bench.pauseState()
  const landing = bench.actions.landOn('main', { botId: 'brain', sessionId: 'brain' }, 'brain')
  assert.equal(bench.stateRegistrations.length, 1, 'fallback is awaiting its state refresh')
  await bench.pick('chosen')
  await act(async () => { bench.stateRegistrations[0](); await landing })
  assert.equal(bench.current(), 'chosen')
  await act(async () => { bench.retain('main'); bench.registrations[0].resolve(); await tick() })
  assert.equal(bench.current(), 'main')
  assert.deepEqual(bench.opened, [])
})

for (const advanced of [false, true]) for (const model of [undefined, 'native/chosen']) {
  test(`Brain picker retains chosen identity (Advanced=${advanced}, model=${model ?? 'unset'})`, async t => {
    const bench = await start(t, { advanced, model, delay: true })
    await bench.pick('picked-project')
    assert.equal(bench.nativeCreates[0].agentPreset, undefined, 'native picker does not pass Brain preset')
    assert.equal(bench.nativeCreates[0].workspaceId, 'selected')
    assert.equal(bench.current(), 'picked-project', 'registration must guard the selected project before Main fallback')
    assert.equal(bench.actions.ownershipPending?.('picked-project'), true, 'Bot registration is pending, not a standalone Agent')
    assert.equal(bench.actions.openedOnPurpose('picked-project'), false, 'pending ownership, not the intentional-open escape hatch, prevents fallback')
    assert.equal(bench.hooks.roster.getSnapshot().agentOf['picked-project'], undefined, 'Bot ownership must not enter the standalone Agent index')
    assert.equal(bench.hooks.surface.getSnapshot().plain, true, 'pending Bot destination keeps native rendering')
    assert.equal(bench.surfaceTransitions.includes(false), false, 'native selection never flashes Bot conversation replacements')
    assert.deepEqual(bench.calls.find(call => call.endpoint === 'bot-session-adopt')?.payload.sessionId, 'picked-project')
    await act(async () => { bench.registrations[0].resolve(); await tick() })
    assert.equal(bench.current(), 'picked-project')
    assert.equal(bench.hooks.roster.getSnapshot().byId['picked-project'].id, 'brain')
    assert.equal(bench.brain.profile, 'cordis')
    assert.equal(bench.brain.workDir, '/original')
    assert.equal(bench.brain.dshAgentId, 'native')
    assert.equal(bench.list.getSnapshot().byId['picked-project'].cwd, '/selected')
    assert.deepEqual(bench.opened, [])
  })
}


test('opening a Herdr definition selects its terminal panel without opening a native Session', async t => {
  const bench = await start(t, { herdr: true })
  await act(async () => bench.actions.openSession('brain'))
  assert.deepEqual(bench.panels, ['seat-chat'])
  assert.deepEqual(bench.opened, [])
  assert.equal(bench.nativeCreates.length, 0)
})
