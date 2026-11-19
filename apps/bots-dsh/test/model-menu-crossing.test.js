// The crossing must go through the host's switchRoute, not updateBot: a saved Bot's settings
// picker passes onPick, so the decision cannot rely on "no onPick". This drives the real menu
// through its steps with a tiny stateful hook runtime (React is stubbed).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export * from './src/client/model-menu.js'; export { SettingsDialog } from './src/client/settings.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let SLOTS = []
let at = 0
let rootProps
let rootTree
const PLACE = { left: 0, top: 0, width: 300, maxHeight: 400 }
const draw = () => {
  at = 0
  const picked = module.exports.ModelMenu(rootProps)
  rootTree = picked.type(picked.props)
  return rootTree
}
const module = { exports: {} }
const react = {
  Component: class {},
  useCallback: fn => fn, useMemo: fn => fn(), useId: () => 'id',
  createContext: value => ({ value }), useContext: ctx => ctx.value,
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const index = at++
    if (!(index in SLOTS)) SLOTS[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    const owner = SLOTS
    const slot = SLOTS[index]
    if (slot.kind !== 'state') throw new Error('hook order changed')
    // The anchored menu starts with two null states; the stub keeps it open for the test.
    if (slot.value === null && initial === null) slot.value = { ...PLACE }
    const set = (value) => {
      slot.value = typeof value === 'function' ? value(slot.value) : value
      if (SLOTS === owner) draw()
    }
    return [slot.value, set]
  },
  useRef: (initial) => {
    const index = at++
    if (!(index in SLOTS)) SLOTS[index] = { kind: 'ref', value: { current: initial } }
    if (SLOTS[index].kind !== 'ref') throw new Error('hook order changed')
    return SLOTS[index].value
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  document: { body: {}, activeElement: null },
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: fn => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  setTimeout, clearTimeout,
  require: name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`no platform module ${name}`)
  },
})

const nodes = (tree, match) => (!tree || typeof tree !== 'object' ? []
  : [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))])
const find = (tree, match) => nodes(tree, match)[0]
const rosterOf = (bot = { id: 'b1', name: 'Ops', model: 'deepseek/flash', appliedModel: 'deepseek/flash' }) => ({
  ready: true,
  byId: { b1: bot },
  defaultModel: 'deepseek/flash',
  models: [
    { ref: 'deepseek/flash', provider: 'deepseek', providerName: 'DeepSeek', name: 'Flash' },
    // Reasoning known empty: the pick applies at once instead of asking the host.
    { ref: 'acp-claude/default', provider: 'acp-claude', providerName: 'Claude Code', name: 'Default', reasoning: { efforts: [] } },
    { ref: 'acp-claude/haiku', provider: 'acp-claude', providerName: 'Claude Code', name: 'Haiku', reasoning: { efforts: [] } },
  ],
})
const openModels = (roster, extra = {}) => {
  rootProps = { bot: roster.byId.b1, roster, actions: globalThis.ACTIONS, run: promise => promise, saved: true, ...extra }
  rootTree = draw()
  const steps = () => find(rootTree, node => node.type?.name === 'ModelSteps')
  steps().props.go({ step: 'agents', route: 'acp' })
  steps().props.go({ step: 'models', route: 'acp', provider: 'acp-claude' })
  return steps().type(steps().props)
}
const click = (tree, match) => {
  const row = find(tree, match)
  assert.ok(row, 'row must be on screen')
  row.props.onClick()
}
const confirmNow = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  const confirm = find(rootTree, node => node.type?.name === 'RouteConfirm')
  assert.ok(confirm, 'the crossing asks first')
  return confirm
}

test('the default crossing confirms and calls switchRoute, never updateBot', async () => {
  const switched = []
  const updated = []
  globalThis.ACTIONS = {
    updateBot: (id, patch) => { updated.push([id, patch]); return Promise.resolve() },
    switchRoute: (id, ref, patch) => { switched.push([id, ref, patch]); return Promise.resolve() },
    refreshModels: () => {},
  }
  const steps = openModels(rosterOf())
  click(steps, node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
  const confirm = await confirmNow()
  confirm.props.onConfirm()
  assert.deepEqual(JSON.parse(JSON.stringify(switched)), [['b1', 'acp-claude/haiku', {}]])
  assert.deepEqual(updated, [])
})

test('a saved Bot\'s settings picker keeps its onPick but still switches the route', async () => {
  const switched = []
  const picked = []
  const updated = []
  globalThis.ACTIONS = {
    updateBot: (id, patch) => { updated.push([id, patch]); return Promise.resolve() },
    switchRoute: (id, ref, patch) => { switched.push([id, ref, patch]); return Promise.resolve() },
    refreshModels: () => {},
  }
  const steps = openModels(rosterOf(), { onPick: (ref, options) => { picked.push([ref, options]); return Promise.resolve() } })
  click(steps, node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
  const confirm = await confirmNow()
  confirm.props.onConfirm()
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), [['acp-claude/haiku', { routeChange: true }]])
  assert.deepEqual(switched, [])
  assert.deepEqual(updated, [])
})


test('a rejected Settings crossing shows its final error and the same menu can reopen and retry', async () => {
  const dialogSlots = [], formSlots = [], menuSlots = []
  const render = (slots, work) => {
    SLOTS = slots
    at = 0
    return work()
  }
  const roster = { ...rosterOf(), mainBotIds: [], rooms: [], roomsById: {}, prefs: {} }
  roster.byId.b1.sessionPinned = true
  const before = JSON.stringify(roster.byId.b1)
  const message = 'Ops speaks in the conversation its host runs, so it cannot start a new one here.'
  const calls = []
  const actions = {
    closeSettings() {}, refreshModels() {},
    updateBot() { assert.fail('a crossing must use switchRoute') },
    switchRoute: async (...args) => { calls.push(args); throw Object.assign(new Error(message), { code: 'bot/refused' }) },
  }
  const settings = () => render(dialogSlots, () => module.exports.SettingsDialog({ page: 'bots', id: 'b1', roster, actions }))
  const form = find(settings(), node => node.type?.name === 'BotSettingsForm')
  const menu = find(render(formSlots, () => form.type(form.props)), node => node.type?.name === 'ModelMenu')
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Reuse the same menu's state, just as a reopen during its exit animation does.
    SLOTS = menuSlots
    const steps = openModels(roster, menu.props)
    click(steps, node => node.props.role === 'menuitemradio' && node.props.title === 'acp-claude/haiku')
    const confirm = await confirmNow()
    confirm.props.onConfirm()
    await new Promise(resolve => setTimeout(resolve, 0))
    const alert = find(settings(), node => node.props.role === 'alert')
    assert.ok(alert)
    assert.deepEqual(Array.from(alert.children), [message])
    assert.equal(calls.length, attempt)
    assert.equal(JSON.stringify(roster.byId.b1), before)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['b1', 'acp-claude/haiku', {}], ['b1', 'acp-claude/haiku', {}],
  ])
  SLOTS = []
})
